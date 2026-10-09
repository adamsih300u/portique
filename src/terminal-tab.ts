import { type IMarker, Terminal } from "@xterm/xterm";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { api, Channel, type Profile } from "./api";
import { getTheme, xtermTheme } from "./themes";
import { askLoginSecret, confirmHostKey } from "./host-prompts";
import { toBytes } from "./ui";
import { ensureUnlocked } from "./vault-ui";

const DEFAULT_FONT_SIZE = 14;

export type TabState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface TunnelInfo {
  label: string;
  error: string | null;
}

/** Seconds to wait before each automatic reconnect attempt after a dropped connection. */
const RETRY_DELAYS = [1, 2, 4, 8, 15, 30, 30, 30, 30, 30];
/** Errors that retrying cannot fix; the user has to look at them. */
const PERMANENT = /authenticat|rejected|HOST KEY|not accepted|not found|no key|needs a saved/i;
const MAX_CLIPBOARD = 1_000_000;

/** One prompt/command/output triple recorded from OSC 133 shell-integration marks. */
interface Command {
  prompt: IMarker;
  start?: IMarker;
  end?: IMarker;
  exit?: number;
}

/** Only web and mail links are ever opened, and only from an explicit Ctrl/Cmd+click. */
const openLink = (e: MouseEvent, uri: string) => {
  if (e.ctrlKey || e.metaKey) void api.openUrl(uri).catch(() => {});
};

/** OSC 52: programs may put text on the clipboard (tmux, vim) but never read it back. */
const clipboardProvider: IClipboardProvider = {
  readText: () => "",
  writeText: async (_sel, text) => {
    if (text.length <= MAX_CLIPBOARD) await navigator.clipboard.writeText(text).catch(() => {});
  },
};

/** One terminal + one session. Reconnects on Enter after the session ends, or by itself if the link drops. */
/** Silence that means output has stopped, and the least run of activity worth flagging (ms). */
const QUIET_MS = 2000;
const QUIET_MIN_RUN = 3000;

export class TerminalTab {
  readonly el = document.createElement("div");
  readonly term: Terminal;
  private fit = new FitAddon();
  private searcher = new SearchAddon();
  private sessionId: string | null = null;
  private ro: ResizeObserver;
  private lastSecrets: [string?, string?] = [];
  state: TabState = "connecting";
  tunnels: TunnelInfo[] = [];
  disposed = false;
  /** Use the WebGL renderer (falls back to the DOM renderer if it is unavailable). */
  static gpu = true;
  private gl: WebglAddon | null = null;
  private ligatures: LigaturesAddon | null = null;
  private cmds: Command[] = [];
  /** An automatic reconnect sequence is under way. */
  private auto = false;
  private attempt = 0;
  private retryTimer: number | undefined;
  private retryNow: (() => void) | null = null;
  private quietTimer: number | undefined;
  /** When the current stretch of activity began (Enter pressed, or output after a quiet spell). */
  private runStart: number | null = null;
  private lastOutput = 0;
  private lastInput = 0;
  onState: (s: TabState) => void = () => {};
  /** Output has stopped after a command or a stretch of activity (shell-integration mark, else a quiet spell). */
  onSettled: () => void = () => {};
  onTunnels: () => void = () => {};
  /** Search results changed: the 0-based index of the active match (-1 if none or too many) and the total. */
  onFindResults: (index: number, count: number) => void = () => {};
  /** The terminal received keyboard focus (a click, or the app focusing it). */
  onFocus: () => void = () => {};
  /** Shift+right-click on the terminal: let the app show its pane menu. */
  onMenu: (e: MouseEvent) => void = () => {};
  /** Keys the app handles itself (tab/pane shortcuts); the terminal must not swallow them. */
  static reserved: (e: KeyboardEvent) => boolean = () => false;
  /** A terminal's font size was changed by zooming; the app saves it to the profile. */
  static onFontSize: (p: Profile, size: number) => void = () => {};

  constructor(public profile: Profile) {
    this.el.className = "term-host";
    this.term = new Terminal({
      allowProposedApi: true,
      macOptionIsMeta: true,
      linkHandler: { activate: openLink, allowNonHttpProtocols: false },
      ...this.options(profile),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.searcher);
    this.searcher.onDidChangeResults((r) => this.onFindResults(r.resultIndex, r.resultCount));
    this.term.loadAddon(new WebLinksAddon(openLink));
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(new ClipboardAddon(undefined, clipboardProvider));
    this.term.parser.registerOscHandler(133, (data) => {
      this.onMark(data);
      return true;
    });

    this.term.onData((d) => this.send(toBytes(d)));
    this.term.onBinary((d) => this.send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
    this.term.onKey(({ domEvent }) => {
      if (this.state === "disconnected" && domEvent.key === "Enter") void this.connect();
      else if (this.state === "reconnecting") {
        if (domEvent.key === "Enter") this.retryNow?.();
        else if (domEvent.key === "Escape") this.stopAuto("Stopped. Press Enter to reconnect");
      }
    });
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        void this.copy();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
        void this.paste();
        return false;
      }
      // Zoom: Ctrl+= / Ctrl+- step the text size, Ctrl+0 resets it.
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        this.zoom(e.key === "0" ? 0 : e.key === "-" ? -1 : 1);
        return false;
      }
      // Leave app-level shortcuts to the window handler.
      return !TerminalTab.reserved(e);
    });
    // PuTTY-style: right-click copies the selection, or pastes if there is none.
    this.el.addEventListener("focusin", () => this.onFocus());
    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (e.shiftKey) return this.onMenu(e);
      if (this.term.hasSelection()) {
        void this.copy();
        this.term.clearSelection();
      } else void this.paste();
    });

    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.el);
  }

  private options(p: Profile) {
    const a = p.appearance;
    const theme = getTheme(a.themeId);
    // A theme's spacing belongs to its font, so it only applies while that font is the one in use.
    const spaced = theme.fontFamily !== undefined && theme.fontFamily === a.fontFamily;
    return {
      fontFamily: a.fontFamily,
      letterSpacing: spaced ? theme.letterSpacing ?? 0 : 0,
      lineHeight: spaced ? theme.lineHeight ?? 1 : 1,
      fontSize: a.fontSize,
      cursorStyle: a.cursorStyle,
      cursorBlink: a.cursorBlink,
      scrollback: a.scrollback,
      theme: xtermTheme(theme),
    };
  }

  // ------------------------------------------------------------ search

  /** Highlight colours that stay readable on both dark and light terminal themes. */
  private findDecorations() {
    const bg = String(this.term.options.theme?.background ?? "#000000");
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
    const light = (r * 299 + g * 587 + b * 114) / 1000 > 140;
    return light
      ? { matchBackground: "#f3e3a1", activeMatchBackground: "#ffcf33", activeMatchBorder: "#8a6d2f", matchOverviewRuler: "#c9a45c", activeMatchColorOverviewRuler: "#8a6d2f" }
      : { matchBackground: "#4a3f1f", activeMatchBackground: "#8a6d2f", activeMatchBorder: "#e6c987", matchOverviewRuler: "#8a6d2f", activeMatchColorOverviewRuler: "#e6c987" };
  }

  /** Searches the scrollback and selects the match. `incremental` keeps the current match while the query grows. */
  find(query: string, opts: { regex: boolean; caseSensitive: boolean; wholeWord: boolean }, dir: "next" | "prev", incremental = false): boolean {
    if (!query) {
      this.clearFind();
      return false;
    }
    const o = { ...opts, incremental, decorations: this.findDecorations() };
    try {
      return dir === "next" ? this.searcher.findNext(query, o) : this.searcher.findPrevious(query, o);
    } catch {
      return false; // an invalid regular expression while typing
    }
  }

  /** Removes the highlights; the selected match stays selected so it can be copied. */
  clearFind() {
    this.searcher.clearDecorations();
  }

  /** Switch the WebGL renderer on or off at runtime. */
  setGpu(on: boolean) {
    if (!this.term.element) return; // not opened yet; mount() applies the setting
    if (!on) {
      this.gl?.dispose();
      this.gl = null;
    } else if (!this.gl) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => {
          gl.dispose();
          if (this.gl === gl) this.gl = null;
        });
        this.term.loadAddon(gl);
        this.gl = gl;
      } catch {
        this.gl = null; // no WebGL here: the DOM renderer carries on
      }
    }
  }

  private setLigatures(on: boolean) {
    if (!this.term.element) return;
    if (!on) {
      this.ligatures?.dispose();
      this.ligatures = null;
    } else if (!this.ligatures) {
      try {
        const l = new LigaturesAddon();
        this.term.loadAddon(l);
        this.ligatures = l;
      } catch {
        this.ligatures = null;
      }
    }
  }

  /** Re-apply font/colour settings after the profile was edited. */
  applyProfile(p: Profile) {
    this.profile = p;
    Object.assign(this.term.options, this.options(p));
    this.setLigatures(p.appearance.ligatures);
    this.refit();
  }

  /** Steps the font size by `dir` points (0 resets it); remembered in the profile. */
  zoom(dir: number) {
    const now = this.profile.appearance.fontSize || 14;
    const size = dir === 0 ? DEFAULT_FONT_SIZE : Math.min(40, Math.max(8, now + dir));
    if (size === now) return;
    this.profile = { ...this.profile, appearance: { ...this.profile.appearance, fontSize: size } };
    this.term.options.fontSize = size;
    this.refit();
    TerminalTab.onFontSize(this.profile, size);
  }

  mount(parent: HTMLElement) {
    parent.append(this.el);
    // Ctrl+wheel zooms (a trackpad pinch arrives the same way, in small steps, so add them up).
    let wheel = 0;
    this.el.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      wheel += e.deltaY;
      if (Math.abs(wheel) >= 40) {
        this.zoom(wheel < 0 ? 1 : -1);
        wheel = 0;
      }
    }, { passive: false, capture: true });
    this.term.open(this.el);
    this.setGpu(TerminalTab.gpu);
    this.setLigatures(this.profile.appearance.ligatures);
    try {
      this.term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true }));
    } catch {} // inline images are a bonus; never block the terminal on them
    this.refit();
  }

  refit() {
    if (!this.el.isConnected || this.el.offsetParent === null) return;
    try {
      this.fit.fit();
    } catch {}
    if (this.sessionId) void api.resize(this.sessionId, this.term.cols, this.term.rows);
  }

  /**
   * Once the link is up, put the cursor in the terminal, so a double-click on a profile
   * needs no extra click. Only when this pane is on screen and nothing else holds focus
   * (a dialog or another pane the user is typing in keeps it).
   */
  private takeFocusIfIdle() {
    const a = document.activeElement;
    const idle = !a || a === document.body || a === document.documentElement;
    if (idle && this.el.offsetParent !== null) this.term.focus();
  }

  focus() {
    this.term.focus();
  }

  private setTunnels(t: TunnelInfo[]) {
    this.tunnels = t;
    for (const f of t.filter((x) => x.error)) this.term.writeln(`\x1b[33m⇄ ${f.label}: ${f.error}\x1b[0m`);
    this.onTunnels();
  }

  // ------------------------------------------------------------ shell integration (OSC 133)

  get hasMarks() {
    return this.cmds.length > 0;
  }

  get hasOutput() {
    return this.lastFinished() !== undefined;
  }

  private onMark(data: string) {
    const [kind, arg] = data.split(";");
    const last = this.cmds[this.cmds.length - 1];
    if (kind === "A") {
      const prompt = this.term.registerMarker(0);
      if (!prompt) return;
      const c: Command = { prompt };
      this.cmds.push(c);
      prompt.onDispose(() => (this.cmds = this.cmds.filter((x) => x !== c)));
    } else if (kind === "C" && last && !last.start) {
      last.start = this.term.registerMarker(0) ?? undefined;
    } else if (kind === "D" && last?.start && !last.end) {
      last.end = this.term.registerMarker(0) ?? undefined;
      last.exit = arg === undefined || arg === "" ? undefined : Number(arg);
      this.runStart = null;
      clearTimeout(this.quietTimer);
      this.onSettled();
    }
  }

  /** Output that is not just the echo of typing counts as activity; the quiet-spell fallback covers hosts without shell integration. */
  private noteOutput() {
    const now = Date.now();
    if (now - this.lastInput < 150) return;
    this.runStart ??= now;
    this.lastOutput = now;
    if (this.hasMarks) return; // the prompt marks tell us exactly when a command ends
    clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => {
      const long = this.lastOutput - (this.runStart ?? this.lastOutput) >= QUIET_MIN_RUN;
      this.runStart = null;
      if (long) this.onSettled();
    }, QUIET_MS);
  }

  private lastFinished() {
    return [...this.cmds].reverse().find((c) => c.start && c.end && c.start.line >= 0 && c.end.line >= c.start.line);
  }

  /** Scrolls to the previous (-1) or next (1) prompt relative to the top of the view. */
  jumpPrompt(dir: -1 | 1) {
    const lines = this.cmds.map((c) => c.prompt.line).filter((l) => l >= 0).sort((a, b) => a - b);
    const top = this.term.buffer.active.viewportY;
    if (dir < 0) {
      const prev = lines.filter((l) => l < top).pop();
      if (prev !== undefined) this.term.scrollToLine(prev);
    } else {
      const next = lines.find((l) => l > top);
      if (next !== undefined) this.term.scrollToLine(next);
      else this.term.scrollToBottom();
    }
  }

  /** Copies the output of the last finished command (wrapped lines are joined). */
  async copyLastOutput() {
    const c = this.lastFinished();
    if (!c?.start || !c.end) return;
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = c.start.line; i < c.end.line; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length && !out[out.length - 1]) out.pop();
    if (out.length) await navigator.clipboard.writeText(out.join("\n") + "\n").catch(() => {});
  }

  // ------------------------------------------------------------ automatic reconnect

  private stopAuto(message?: string) {
    clearTimeout(this.retryTimer);
    this.retryNow = null;
    this.auto = false;
    this.attempt = 0;
    if (message) this.ended(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`);
  }

  /** The link dropped: count down, then connect again, backing off while the network is away. */
  private scheduleReconnect(why: string) {
    if (this.disposed) return;
    if (this.attempt >= RETRY_DELAYS.length) return this.stopAuto("Gave up reconnecting. Press Enter to try again");
    this.auto = true;
    this.sessionId = null;
    let left = RETRY_DELAYS[this.attempt++];
    this.setState("reconnecting");
    this.term.write("\r\n");
    const go = () => {
      clearTimeout(this.retryTimer);
      this.retryNow = null;
      this.term.write("\r\x1b[2K\x1b[2m[Reconnecting…]\x1b[0m\r\n");
      void this.connect(...this.lastSecrets);
    };
    const tick = () => {
      this.term.write(`\r\x1b[2K\x1b[2m[${why}. Reconnecting in ${left}s — Enter to retry now, Esc to stop]\x1b[0m`);
      if (left-- <= 0) go();
      else this.retryTimer = window.setTimeout(tick, 1000);
    };
    this.retryNow = go;
    tick();
  }

  private setState(s: TabState) {
    this.state = s;
    this.onState(s);
  }

  private send(b: Uint8Array) {
    this.lastInput = Date.now();
    if (b.includes(13)) this.runStart = this.lastInput;
    if (this.sessionId && this.state === "connected") void api.input(this.sessionId, b);
  }

  hasSelection() {
    return this.term.hasSelection();
  }

  async copy() {
    const s = this.term.getSelection();
    if (s) await navigator.clipboard.writeText(s).catch(() => {});
  }

  get connected() {
    return this.state === "connected";
  }

  /** Types a saved command into the session (as a paste, so a multi-line one is safe); `enter` also runs it. */
  typeCommand(text: string, enter: boolean) {
    if (!this.connected) return;
    this.term.paste(text.replace(/\r?\n/g, "\r"));
    if (enter) this.send(toBytes("\r"));
    this.term.focus();
  }

  async paste() {
    const s = await navigator.clipboard.readText().catch(() => "");
    if (s) this.term.paste(s);
  }

  async connect(password?: string, passphrase?: string) {
    this.setState("connecting");
    this.cmds = [];
    this.setTunnels([]);
    this.lastSecrets = [password, passphrase];
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => this.onFrame(buf);
    this.term.options.disableStdin = false;
    try {
      this.sessionId = await api.connect(this.profile.id, this.term.cols, this.term.rows, ch, password, passphrase);
    } catch (e) {
      this.fail(String(e));
    }
  }

  private onFrame(buf: ArrayBuffer) {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0) {
      this.term.write(bytes.subarray(1));
      this.noteOutput();
      return;
    }
    const { state, message } = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
    switch (state) {
      case "connecting":
        this.term.writeln(`\x1b[2m${message}\x1b[0m`);
        break;
      case "connected":
        if (this.auto) this.term.write("\x1b[2m[Reconnected]\x1b[0m\r\n");
        this.auto = false;
        this.attempt = 0;
        this.setState("connected");
        this.refit();
        this.takeFocusIfIdle();
        break;
      case "lost":
        if (this.profile.autoReconnect) this.scheduleReconnect("Connection lost");
        else this.ended("\r\n\x1b[2m[Connection lost. Press Enter to reconnect]\x1b[0m\r\n");
        break;
      case "vault-locked":
        void ensureUnlocked().then(() => {
          this.sessionId = null;
          return this.connect(...this.lastSecrets);
        });
        break;
      case "tunnels":
        this.setTunnels(JSON.parse(message));
        break;
      case "confirm-host":
        void confirmHostKey(JSON.parse(message));
        break;
      case "need-password":
      case "need-passphrase":
        // Nobody is there to type it during an automatic retry; wait for the user instead.
        if (this.auto) this.stopAuto("Login needs a password. Press Enter to reconnect");
        else void this.askSecret(state === "need-passphrase");
        break;
      case "closed":
        this.ended(`\r\n\x1b[2m[${message}. Press Enter to reconnect]\x1b[0m\r\n`);
        break;
      case "error":
        this.fail(message);
        break;
    }
  }

  private async askSecret(passphrase: boolean) {
    const secret = await askLoginSecret(this.profile, passphrase);
    if (secret === null) return this.ended("\r\n\x1b[2m[Cancelled. Press Enter to reconnect]\x1b[0m\r\n");
    this.sessionId = null;
    await this.connect(passphrase ? undefined : secret, passphrase ? secret : undefined);
  }

  private fail(msg: string) {
    // While reconnecting, a failed attempt (network still down) just waits longer.
    if (this.auto && !PERMANENT.test(msg)) {
      this.term.write(`\r\x1b[2K\x1b[2m[${msg.split("\n")[0]}]\x1b[0m`);
      return this.scheduleReconnect("Still unreachable");
    }
    this.stopAuto();
    this.ended(`\r\n\x1b[31m${msg.replace(/\n/g, "\r\n")}\x1b[0m\r\n\x1b[2m[Press Enter to reconnect]\x1b[0m\r\n`);
  }

  private ended(text: string) {
    this.sessionId = null;
    this.auto = false;
    this.attempt = 0;
    this.tunnels = [];
    this.onTunnels();
    this.term.write(text);
    this.setState("disconnected");
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.quietTimer);
    this.ro.disconnect();
    if (this.sessionId) void api.close(this.sessionId);
    this.term.dispose();
    this.el.remove();
  }
}
