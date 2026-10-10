//! Running one command in a shell that stays open, and knowing when it finished.
//!
//! A terminal gives no signal at the end of a command, so the command is typed inside a wrapper that
//! prints a begin line and an end line carrying the exit status, both holding a random nonce. The
//! lines are printed by `printf` from pieces, so the typed text (which the terminal echoes) never
//! contains a marker whole and only the real output can match.

use crate::store::Protocol;

/// The most one command may hold.
pub const MAX_COMMAND: usize = 64 * 1024;
/// A line longer than this is refused where the terminal's own line editor (limit 4095) reads it.
const MAX_LINE: usize = 3800;

/// How a shell is told to print a marker and report a status. Only POSIX shells are supported so far.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Posix,
}

impl Dialect {
    /// The dialect of a session, or `None` where completion cannot be detected (telnet, serial, `cmd`, PowerShell, fish).
    pub fn of(protocol: Protocol, profile_id: &str) -> Option<Dialect> {
        match protocol {
            // The remote shell is unknown; a POSIX one is by far the usual case, and a wrong guess
            // shows as a missing marker, which the caller reports.
            Protocol::Ssh => Some(Dialect::Posix),
            Protocol::Local => {
                let shell = profile_id.strip_prefix(crate::local::PREFIX).unwrap_or(profile_id);
                let posix = matches!(shell, "sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "mksh" | "busybox")
                    || shell == "git-bash"
                    || shell.starts_with("wsl:");
                posix.then_some(Dialect::Posix)
            }
            Protocol::Telnet | Protocol::Serial | Protocol::Api => None,
        }
    }
}

/// Why a command cannot be typed as given.
pub fn check_command(command: &str, bracketed: bool) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("the command is empty".into());
    }
    if command.len() > MAX_COMMAND {
        return Err(format!("the command is longer than {} KiB; put the script in a file instead", MAX_COMMAND / 1024));
    }
    if let Some(c) = command.chars().find(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err(format!("the command contains a control character (U+{:04X}); use send_input to type keys", c as u32));
    }
    if !bracketed {
        if command.contains('\t') {
            return Err("this shell does not take pasted text, so a tab character would trigger completion; use spaces".into());
        }
        if command.lines().any(|l| l.len() > MAX_LINE) {
            return Err(format!("a line is longer than {MAX_LINE} bytes, which this shell cannot read in one go; split it"));
        }
    }
    Ok(())
}

/// The text of the begin and end markers for a nonce, as the shell prints them.
pub fn begin_marker(nonce: &str) -> String {
    format!("__pq_b_{nonce}__")
}
const END_PREFIX: &str = "__pq_e_";

/// What to type for `command`: a brace group that prints the begin marker, runs the command, then prints the end marker with `$?`.
pub fn wrap(dialect: Dialect, command: &str, nonce: &str) -> String {
    match dialect {
        Dialect::Posix => {
            let command = command.replace("\r\n", "\n").replace('\r', "\n");
            format!(
                "{{ printf '\\n%s_%s__\\n' '__pq_b' '{nonce}'\n{command}\nprintf '\\n%s_%s_%d__\\n' '__pq_e' '{nonce}' $?; }}"
            )
        }
    }
}

/// The bytes to send: the wrapped command as one paste when the shell has asked for bracketed paste, else line by line; then Enter.
pub fn keystrokes(wrapped: &str, bracketed: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(wrapped.len() + 16);
    if bracketed {
        out.extend_from_slice(b"\x1b[200~");
        out.extend_from_slice(wrapped.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
    } else {
        out.extend_from_slice(wrapped.replace('\n', "\r").as_bytes());
    }
    out.push(b'\r');
    out
}

/// Where the command's own output starts in `raw`: just after the begin line.
pub fn find_begin(raw: &[u8], nonce: &str) -> Option<usize> {
    let marker = begin_marker(nonce);
    let at = find(raw, marker.as_bytes())? + marker.len();
    Some(at + line_break(&raw[at..]))
}

/// The end marker, if it has been printed: where the output stops (before the line break that starts the marker line),
/// the exit status, and where the marker line ends.
pub fn find_end(raw: &[u8], from: usize, nonce: &str) -> Option<End> {
    let head = format!("{END_PREFIX}{nonce}_");
    let at = find(&raw[from..], head.as_bytes())? + from;
    let rest = &raw[at + head.len()..];
    let digits = rest.iter().take_while(|c| c.is_ascii_digit() || **c == b'-').count();
    if digits == 0 || !rest[digits..].starts_with(b"__") {
        return None; // a partial marker: the rest has not arrived
    }
    let code: i32 = std::str::from_utf8(&rest[..digits]).ok()?.parse().ok()?;
    let after = at + head.len() + digits + 2;
    // The marker line is preceded by the line break the wrapper prints; the output ends before it.
    let mut stop = at;
    if raw[..stop].ends_with(b"\r\n") {
        stop -= 2;
    } else if raw[..stop].ends_with(b"\n") {
        stop -= 1;
    }
    Some(End { output_end: stop.max(from), code, after: after + line_break(&raw[after..]) })
}

#[derive(Debug, PartialEq, Eq)]
pub struct End {
    pub output_end: usize,
    pub code: i32,
    pub after: usize,
}

fn line_break(b: &[u8]) -> usize {
    if b.starts_with(b"\r\n") { 2 } else { usize::from(b.starts_with(b"\n")) }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Removes the wrapper's own lines from text read back some other way (`read_output`, `wait_for`): the marker lines the
/// shell printed, and the echo of the wrapper as it was typed.
pub fn hide_markers(text: &str) -> String {
    const WRAPPER: [&str; 4] = ["__pq_b_", "__pq_e_", "'__pq_b'", "'__pq_e'"];
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        if !WRAPPER.iter().any(|w| line.contains(w)) {
            out.push_str(line);
        }
    }
    out
}

/// A character that hides or reorders what is shown: a control character, or an invisible or direction-changing format character.
pub fn hidden(c: char) -> bool {
    (c.is_control() && !matches!(c, '\n' | '\t'))
        || matches!(
            c as u32,
            0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
                | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F
                | 0xFEFF | 0xFFA0 | 0xFFF9..=0xFFFB | 0xE0000..=0xE0FFF
        )
}

/// Text as the person should read it in a question or the log: characters that could disguise it are shown as `⟨U+202E⟩`.
pub fn show_text(s: &str) -> String {
    s.chars().map(|c| if hidden(c) { format!("⟨U+{:04X}⟩", c as u32) } else { c.to_string() }).collect()
}

/// A random hex nonce.
pub fn nonce() -> String {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).expect("system randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The bytes a named key sends. `None` for a name we don't know.
pub fn key(name: &str) -> Option<Vec<u8>> {
    let lower = name.to_ascii_lowercase();
    let fixed: &[u8] = match lower.as_str() {
        "enter" | "return" => b"\r",
        "tab" => b"\t",
        "escape" | "esc" => b"\x1b",
        "backspace" => b"\x7f",
        "delete" | "del" => b"\x1b[3~",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "pageup" | "pgup" => b"\x1b[5~",
        "pagedown" | "pgdn" => b"\x1b[6~",
        "space" => b" ",
        _ => b"",
    };
    if !fixed.is_empty() {
        return Some(fixed.to_vec());
    }
    // C-x / ctrl-x / ^x: a control character.
    let letter = lower.strip_prefix("c-").or_else(|| lower.strip_prefix("ctrl-")).or_else(|| lower.strip_prefix("ctrl+")).or_else(|| lower.strip_prefix('^'))?;
    match letter.as_bytes() {
        [c @ b'a'..=b'z'] => Some(vec![c - b'a' + 1]),
        b"[" => Some(vec![0x1b]),
        b"\\" => Some(vec![0x1c]),
        b"]" => Some(vec![0x1d]),
        b"space" | b"@" => Some(vec![0]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a POSIX shell prints for the wrapper, simulated: the echo of what was typed, then the output.
    fn session(command_output: &str, code: i32, nonce: &str) -> Vec<u8> {
        let typed = wrap(Dialect::Posix, "echo hi", nonce).replace('\n', "\r\n");
        format!("$ {typed}\r\n\r\n__pq_b_{nonce}__\r\n{command_output}\r\n__pq_e_{nonce}_{code}__\r\n$ ").into_bytes()
    }

    #[test]
    fn the_typed_wrapper_never_holds_a_marker_whole() {
        let typed = wrap(Dialect::Posix, "uname -a", "abc123");
        assert!(!typed.contains(&begin_marker("abc123")));
        assert!(!typed.contains("__pq_e_abc123_"));
        assert!(typed.contains("uname -a"));
        assert!(typed.starts_with("{ ") && typed.ends_with("; }"));
    }

    #[test]
    fn the_echo_is_skipped_and_the_output_and_status_are_found() {
        let raw = session("line1\r\nline2", 3, "n0nce");
        let begin = find_begin(&raw, "n0nce").unwrap();
        let end = find_end(&raw, begin, "n0nce").unwrap();
        assert_eq!(&raw[begin..end.output_end], b"line1\r\nline2");
        assert_eq!(end.code, 3);
        assert_eq!(&raw[end.after..], b"$ ");
    }

    #[test]
    fn output_with_a_final_newline_keeps_it() {
        let raw = session("a\r\n", 0, "n");
        let begin = find_begin(&raw, "n").unwrap();
        let end = find_end(&raw, begin, "n").unwrap();
        assert_eq!(&raw[begin..end.output_end], b"a\r\n");
    }

    #[test]
    fn a_command_with_no_output_gives_nothing() {
        let raw = session("", 0, "n");
        let begin = find_begin(&raw, "n").unwrap();
        let end = find_end(&raw, begin, "n").unwrap();
        assert_eq!(&raw[begin..end.output_end], b"");
    }

    #[test]
    fn a_partial_end_marker_is_not_a_finish() {
        let raw = b"__pq_b_n__\r\nout\r\n__pq_e_n_1";
        let begin = find_begin(raw, "n").unwrap();
        assert!(find_end(raw, begin, "n").is_none());
        assert!(find_end(b"__pq_b_n__\r\nout\r\n__pq_e_n_", begin, "n").is_none());
        assert!(find_begin(b"__pq_b_other__\r\n", "n").is_none());
    }

    #[test]
    fn a_marker_for_another_command_is_ignored() {
        let raw = b"__pq_b_n__\r\nout\r\n__pq_e_other_0__\r\n";
        assert!(find_end(raw, find_begin(raw, "n").unwrap(), "n").is_none());
    }

    #[test]
    fn negative_and_large_statuses_parse() {
        let raw = b"__pq_b_n__\r\n\r\n__pq_e_n_130__\r\n";
        assert_eq!(find_end(raw, find_begin(raw, "n").unwrap(), "n").unwrap().code, 130);
    }

    #[test]
    fn commands_are_checked_before_they_are_typed() {
        assert!(check_command("ls -l", false).is_ok());
        assert!(check_command("  \n ", true).is_err());
        assert!(check_command("echo \x03", true).unwrap_err().contains("control character"));
        assert!(check_command("echo \x1b[201~", true).is_err(), "an escape could end the paste early");
        assert!(check_command("a\tb", true).is_ok());
        assert!(check_command("a\tb", false).unwrap_err().contains("tab"));
        assert!(check_command(&"x".repeat(MAX_LINE + 1), false).is_err());
        assert!(check_command(&"x".repeat(MAX_LINE + 1), true).is_ok());
        assert!(check_command(&"x\n".repeat(MAX_COMMAND), true).is_err());
    }

    #[test]
    fn keystrokes_paste_when_the_shell_asks_for_it() {
        let w = "{ a\nb; }";
        assert_eq!(keystrokes(w, true), b"\x1b[200~{ a\nb; }\x1b[201~\r");
        assert_eq!(keystrokes(w, false), b"{ a\rb; }\r");
    }

    #[test]
    fn carriage_returns_in_a_command_become_newlines() {
        let w = wrap(Dialect::Posix, "a\r\nb\rc", "n");
        assert!(w.contains("a\nb\nc") && !w.contains('\r'));
    }

    #[test]
    fn marker_lines_are_hidden_from_plain_reads() {
        let text = "$ x\n__pq_b_ab__\nout\n__pq_e_ab_0__\n$ ";
        assert_eq!(hide_markers(text), "$ x\nout\n$ ");
        let typed = wrap(Dialect::Posix, "echo hi", "ab");
        let echoed = format!("$ {typed}\nhi\n");
        assert_eq!(hide_markers(&echoed), "echo hi\nhi\n", "the typed wrapper goes too, the command in it stays");
    }

    #[test]
    fn named_keys() {
        assert_eq!(key("Enter"), Some(b"\r".to_vec()));
        assert_eq!(key("C-c"), Some(vec![3]));
        assert_eq!(key("ctrl-d"), Some(vec![4]));
        assert_eq!(key("^Z"), Some(vec![26]));
        assert_eq!(key("Up"), Some(b"\x1b[A".to_vec()));
        assert_eq!(key("C-1"), None);
        assert_eq!(key("hyper"), None);
    }

    #[test]
    fn dialects() {
        assert_eq!(Dialect::of(Protocol::Ssh, "abc"), Some(Dialect::Posix));
        assert_eq!(Dialect::of(Protocol::Local, "local:bash"), Some(Dialect::Posix));
        assert_eq!(Dialect::of(Protocol::Local, "local:wsl:Ubuntu"), Some(Dialect::Posix));
        assert_eq!(Dialect::of(Protocol::Local, "local:cmd"), None);
        assert_eq!(Dialect::of(Protocol::Local, "local:fish"), None);
        assert_eq!(Dialect::of(Protocol::Serial, "x"), None);
    }

    #[test]
    fn text_that_could_disguise_a_command_is_shown_plainly() {
        // A right-to-left override can make "rm -rf ~" read as something else.
        let sneaky = "echo safe \u{202e}fr- mr\u{202c}";
        let shown = show_text(sneaky);
        assert!(shown.contains("⟨U+202E⟩") && shown.contains("⟨U+202C⟩") && !shown.contains('\u{202e}'), "{shown}");
        assert_eq!(show_text("zero\u{200b}width"), "zero⟨U+200B⟩width");
        assert_eq!(show_text("line one\nline\ttwo"), "line one\nline\ttwo", "newlines and tabs are fine");
        assert_eq!(show_text("é ü 日本"), "é ü 日本");
        assert_eq!(show_text("bell\u{7}"), "bell⟨U+0007⟩");
        for c in ['\u{61c}', '\u{ad}', '\u{80}', '\u{9f}', '\u{e0041}', '\u{2065}', '\u{fe0f}', '\u{3164}'] {
            assert!(hidden(c), "U+{:04X} should be spelled out", c as u32);
        }
    }

    #[test]
    fn nonces_differ() {
        assert_ne!(nonce(), nonce());
        assert_eq!(nonce().len(), 12);
    }
}
