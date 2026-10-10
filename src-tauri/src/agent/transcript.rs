//! What a session has printed: a bounded history that readers address by byte offset, a terminal
//! emulator that knows what is on the screen right now, and the cleaner that turns raw terminal
//! output into the text a person would read.

use std::collections::VecDeque;

/// Raw output kept per session. Older bytes fall off the front; offsets keep counting.
pub const HISTORY: usize = 2 * 1024 * 1024;
/// Lines the emulator keeps above the screen. Only the visible screen is ever read from it.
const SCROLLBACK: usize = 0;

pub struct Transcript {
    bytes: VecDeque<u8>,
    /// Offset of `bytes[0]` in everything the session ever printed.
    start: u64,
    screen: vt100::Parser,
}

impl Transcript {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { bytes: VecDeque::new(), start: 0, screen: vt100::Parser::new(rows.max(1), cols.max(1), SCROLLBACK) }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.bytes.extend(data);
        if self.bytes.len() > HISTORY {
            let drop = self.bytes.len() - HISTORY;
            self.bytes.drain(..drop);
            self.start += drop as u64;
        }
        self.screen.process(data);
    }

    /// Offset just past the last byte printed.
    pub fn end(&self) -> u64 {
        self.start + self.bytes.len() as u64
    }

    /// Everything from `from` on, and the offset it really starts at (later than `from` when the history has moved past it).
    pub fn since(&self, from: u64) -> (Vec<u8>, u64) {
        let from = from.clamp(self.start, self.end());
        let skip = (from - self.start) as usize;
        (self.bytes.iter().skip(skip).copied().collect(), from)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.screen.screen_mut().set_size(rows.max(1), cols.max(1));
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.screen.screen()
    }

    pub fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.screen().size();
        (cols, rows)
    }
}

// ---- escape sequences ------------------------------------------------------------

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
/// A string sequence that never ends is dropped after this many bytes instead of swallowing the rest of the output.
const MAX_STRING_SEQ: usize = 4096;

/// Length of the escape sequence at the start of `b` (which begins with ESC), or `None` when more bytes are needed to tell.
fn escape_len(b: &[u8]) -> Option<usize> {
    debug_assert_eq!(b.first(), Some(&ESC));
    let kind = *b.get(1)?;
    match kind {
        b'[' => b[2..].iter().position(|c| (0x40..=0x7e).contains(c)).map(|i| i + 3),
        // OSC, DCS, SOS, PM, APC: run to BEL or ST (ESC \).
        b']' | b'P' | b'X' | b'^' | b'_' => {
            let end = b[2..].iter().enumerate().find_map(|(i, &c)| match c {
                BEL if kind == b']' => Some(i + 3),
                ESC if b.get(i + 3) == Some(&b'\\') => Some(i + 4),
                _ => None,
            });
            end.or(if b.len() > MAX_STRING_SEQ { Some(b.len()) } else { None })
        }
        // Character-set selection and the like carry one more byte.
        b'(' | b')' | b'*' | b'+' | b'#' | b'%' => (b.len() >= 3).then_some(3),
        _ => Some(2),
    }
}

/// How many bytes at the end of `bytes` are the start of something unfinished (a UTF-8 character or an escape sequence).
/// A reader leaves those for the next read so it never returns half a character.
pub fn unfinished_tail(bytes: &[u8]) -> usize {
    let n = bytes.len();
    let window = n.saturating_sub(MAX_STRING_SEQ + 8);
    if let Some(i) = bytes[window..].iter().rposition(|&c| c == ESC).map(|i| i + window) {
        if escape_len(&bytes[i..]).is_none() {
            return n - i;
        }
    }
    for back in 1..=3.min(n) {
        let c = bytes[n - back];
        if c & 0xc0 == 0x80 {
            continue; // a continuation byte: keep looking for its lead
        }
        let need = match c {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

// ---- cleaning -----------------------------------------------------------------------

/// Plain text from raw terminal output: escape sequences are dropped, carriage returns and backspaces
/// are applied (so a progress bar leaves its last state), erase and cursor-move keys are honoured within a
/// line, and trailing blanks are trimmed. This is not an emulator; `Transcript::screen` is, for full-screen programs.
pub fn clean(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut line: Vec<char> = Vec::new();
    let mut col = 0usize;
    let flush = |out: &mut String, line: &mut Vec<char>| {
        let end = line.iter().rposition(|c| *c != ' ').map_or(0, |i| i + 1);
        out.extend(&line[..end]);
        line.clear();
    };

    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == ESC {
            let Some(len) = escape_len(&bytes[i..]) else { break };
            let seq = &bytes[i..i + len];
            if seq.get(1) == Some(&b'[') {
                csi(&seq[2..len - 1], seq[len - 1], &mut line, &mut col);
            }
            i += len;
            continue;
        }
        let run_end = bytes[i..].iter().position(|&c| c == ESC).map_or(bytes.len(), |p| i + p);
        for ch in String::from_utf8_lossy(&bytes[i..run_end]).chars() {
            match ch {
                '\n' => {
                    flush(&mut out, &mut line);
                    out.push('\n');
                    col = 0;
                }
                '\r' => col = 0,
                '\u{8}' => col = col.saturating_sub(1),
                '\t' => {
                    let to = (col / 8 + 1) * 8;
                    while col < to {
                        put(&mut line, &mut col, ' ');
                    }
                }
                c if c.is_control() => {}
                c => put(&mut line, &mut col, c),
            }
        }
        i = run_end;
    }
    flush(&mut out, &mut line);
    out
}

fn put(line: &mut Vec<char>, col: &mut usize, c: char) {
    while line.len() < *col {
        line.push(' ');
    }
    match line.get_mut(*col) {
        Some(slot) => *slot = c,
        None => line.push(c),
    }
    *col += 1;
}

/// The few CSI sequences that matter inside one line: erase (K), cursor left/right (D, C) and to a column (G).
fn csi(params: &[u8], fin: u8, line: &mut Vec<char>, col: &mut usize) {
    let n = std::str::from_utf8(params).ok().and_then(|p| p.split(';').next()?.parse::<usize>().ok());
    match fin {
        b'K' => match n.unwrap_or(0) {
            0 => line.truncate(*col),
            1 => line.iter_mut().take(*col + 1).for_each(|c| *c = ' '),
            _ => line.clear(),
        },
        b'D' => *col = col.saturating_sub(n.unwrap_or(1).max(1)),
        b'C' => *col += n.unwrap_or(1).max(1),
        b'G' => *col = n.unwrap_or(1).max(1) - 1,
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_bounded_and_offsets_keep_counting() {
        let mut t = Transcript::new(80, 24);
        t.push(&vec![b'a'; HISTORY]);
        t.push(b"bcd");
        assert_eq!(t.end(), HISTORY as u64 + 3);
        let (tail, from) = t.since(0);
        assert_eq!(from, 3, "the first three bytes fell off");
        assert_eq!(tail.len(), HISTORY);
        assert!(tail.ends_with(b"abcd"[1..].as_ref()));
        let (rest, from) = t.since(t.end() - 2);
        assert_eq!((rest.as_slice(), from), (b"cd".as_slice(), t.end() - 2));
        assert!(t.since(u64::MAX).0.is_empty());
    }

    #[test]
    fn the_screen_follows_the_output_and_the_size() {
        let mut t = Transcript::new(20, 5);
        t.push(b"hello\r\nworld\x1b[?2004h");
        assert!(t.screen().contents().starts_with("hello\nworld"));
        assert!(t.screen().bracketed_paste());
        t.resize(40, 10);
        assert_eq!(t.size(), (40, 10));
        t.push(b"\x1b[?1049h");
        assert!(t.screen().alternate_screen());
    }

    #[test]
    fn escape_sequences_are_dropped() {
        assert_eq!(clean(b"\x1b[1;32mgreen\x1b[0m plain"), "green plain");
        assert_eq!(clean(b"\x1b]0;window title\x07text"), "text");
        assert_eq!(clean(b"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link");
        assert_eq!(clean(b"\x1b(Bok\x1b=\x1b>"), "ok");
    }

    #[test]
    fn carriage_returns_and_backspaces_are_applied() {
        assert_eq!(clean(b"10%\r50%\r100%\r\ndone\r\n"), "100%\ndone\n");
        assert_eq!(clean(b"abc\x08\x08X"), "aXc");
        assert_eq!(clean(b"line one\r\nline two\r\n"), "line one\nline two\n");
        assert_eq!(clean(b"over\rwrit"), "writ");
    }

    #[test]
    fn line_editing_keys_leave_what_the_screen_would_show() {
        // A shell redrawing its prompt: write, move back, erase to the end, write again.
        assert_eq!(clean(b"$ ls -la\x1b[3D\x1b[K-l"), "$ ls -l");
        assert_eq!(clean(b"abcdef\x1b[1K"), "");
        assert_eq!(clean(b"abc\x1b[2Kx"), "   x");
    }

    #[test]
    fn tabs_become_columns_and_other_controls_vanish() {
        assert_eq!(clean(b"a\tb"), "a       b");
        assert_eq!(clean(b"x\x07y\x00z"), "xyz");
    }

    #[test]
    fn broken_utf8_does_not_panic() {
        assert_eq!(clean(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    }

    #[test]
    fn a_reader_does_not_take_half_a_character_or_half_an_escape() {
        let heart = "♥".as_bytes();
        assert_eq!(unfinished_tail(&[b'a', heart[0], heart[1]]), 2);
        assert_eq!(unfinished_tail(&[b'a', heart[0], heart[1], heart[2]]), 0);
        assert_eq!(unfinished_tail(b"abc"), 0);
        assert_eq!(unfinished_tail(b"abc\x1b"), 1);
        assert_eq!(unfinished_tail(b"abc\x1b[1;3"), 5);
        assert_eq!(unfinished_tail(b"abc\x1b[1;3m"), 0);
        assert_eq!(unfinished_tail(b"abc\x1b]0;title"), 9);
        assert_eq!(unfinished_tail(b"abc\x1b]0;title\x07"), 0);
        assert_eq!(unfinished_tail(b""), 0);
    }

    #[test]
    fn a_string_sequence_that_never_ends_is_eventually_dropped() {
        let mut b = b"\x1b]0;".to_vec();
        b.extend(vec![b'x'; MAX_STRING_SEQ + 10]);
        assert_eq!(unfinished_tail(&b), 0);
        assert_eq!(clean(&b), "");
    }
}
