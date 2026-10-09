//! App-level settings plus the window behaviours that need the OS: drop-down ("quake") mode
//! with a global hotkey, and opening links in the default browser.

use crate::store;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const FILE: &str = "settings.json";
/// Ctrl+` (as in many drop-down terminals). Not F12: Windows reserves it system-wide for debuggers, so it cannot be a global hotkey there.
const DEFAULT_KEY: &str = "Ctrl+Backquote";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Window drops down from the top of the screen and a global hotkey shows/hides it.
    pub quake: bool,
    /// Hotkey for drop-down mode, e.g. "Ctrl+Backquote" or "Ctrl+Alt+Space" (⋯ → Drop-down hotkey…).
    pub quake_key: String,
    /// Use the WebGL renderer for terminals.
    pub gpu: bool,
    /// Interface colours; empty fields mean the built-in look.
    pub ui: UiColours,
    /// Reopen the tabs that were open when the app was last closed.
    pub restore_tabs: bool,
    /// Where the file browser's local pane starts; empty means the folder it was last in.
    pub sftp_local_dir: String,
    /// Size of the interface text: "normal" or "large".
    pub ui_scale: String,
    /// Minutes without activity before the vault locks itself; 0 means never.
    pub vault_idle_minutes: u32,
    /// Offer shells on this computer as terminals (off until the user asks for them).
    pub local_terminals: bool,
    /// Ids of the shells to offer (see `local::Shell::id`).
    pub local_shells: Vec<String>,
}

/// The idle times the settings pane offers (minutes; 0 = never).
pub const VAULT_IDLE_CHOICES: [u32; 6] = [0, 1, 5, 15, 30, 60];

/// Colours of the app chrome (not the terminal). Each is "#rrggbb" or empty for the default.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UiColours {
    pub side: String,
    pub top: String,
    /// Main area behind the terminals: the file browser and the empty screen.
    pub content: String,
    pub accent: String,
    /// Tabs keep the interface colours instead of taking their terminal theme's background.
    pub plain_tabs: bool,
}

impl UiColours {
    pub fn valid(&self) -> bool {
        [&self.side, &self.top, &self.content, &self.accent].iter().all(|c| {
            c.is_empty() || (c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|d| d.is_ascii_hexdigit()))
        })
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self { quake: false, quake_key: DEFAULT_KEY.into(), gpu: true, ui: UiColours::default(), restore_tabs: true, sftp_local_dir: String::new(), ui_scale: "normal".into(), vault_idle_minutes: 15, local_terminals: false, local_shells: Vec::new() }
    }
}

pub fn load() -> Settings {
    let mut s: Settings = store::read_json(FILE).unwrap_or_default();
    // F12 was the default in early builds; on Windows it can never be registered, so move such settings along.
    if s.quake_key.trim().is_empty() || (cfg!(windows) && s.quake_key.trim().eq_ignore_ascii_case("F12")) {
        s.quake_key = DEFAULT_KEY.into();
    }
    s
}

/// Checks that a hotkey string such as "Ctrl+Alt+Space" or "Ctrl+Backquote" is understood.
pub fn valid_hotkey(key: &str) -> bool {
    key.parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok()
}

pub fn save(s: &Settings) -> Result<()> {
    store::write_json(FILE, s)
}

/// The hotkey currently registered, so it can be released when the setting changes.
static REGISTERED: Mutex<Option<String>> = Mutex::new(None);

fn main_window(app: &AppHandle) -> Result<WebviewWindow> {
    app.get_webview_window("main").context("main window not found")
}

/// Show/hide on the hotkey: hide if it is the focused window, otherwise bring it to the front.
fn toggle(app: &AppHandle) {
    let Ok(w) = main_window(app) else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.unminimize();
        let _ = w.show();
        dock(&w);
        let _ = w.set_focus();
    }
}

/// Full monitor width, top 45% of the screen, above other windows. (The window is always undecorated: the app draws its own controls.)
fn dock(w: &WebviewWindow) {
    let Ok(Some(m)) = w.current_monitor().or_else(|_| w.primary_monitor()) else { return };
    let (pos, size) = (m.position(), m.size());
    let _ = w.set_always_on_top(true);
    let _ = w.set_skip_taskbar(true);
    let _ = w.set_size(PhysicalSize::new(size.width, size.height * 45 / 100));
    let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
}

fn undock(w: &WebviewWindow) {
    let _ = w.set_always_on_top(false);
    let _ = w.set_skip_taskbar(false);
    let _ = w.set_size(tauri::LogicalSize::new(1200.0, 760.0));
    let _ = w.center();
}

/// Applies the quake setting: registers/releases the hotkey and docks/undocks the window.
pub fn apply_quake(app: &AppHandle, s: &Settings) -> Result<()> {
    let gs = app.global_shortcut();
    if let Some(old) = REGISTERED.lock().unwrap().take() {
        let _ = gs.unregister(old.as_str());
    }
    let w = main_window(app)?;
    if !s.quake {
        undock(&w);
        return Ok(());
    }
    let handle = app.clone();
    gs.on_shortcut(s.quake_key.as_str(), move |_, _, ev| {
        if ev.state == ShortcutState::Pressed {
            toggle(&handle);
        }
    })
    .map_err(|e| anyhow!("cannot register {} as a global hotkey ({e}). Another program may own it, or the desktop (e.g. Wayland) does not allow global hotkeys.", s.quake_key))?;
    *REGISTERED.lock().unwrap() = Some(s.quake_key.clone());
    dock(&w);
    Ok(())
}

/// Opens a link in the default browser. Only web and mail links: terminal output is untrusted.
pub fn open_link(app: &AppHandle, url: &str) -> Result<()> {
    let lower = url.to_ascii_lowercase();
    if !["http://", "https://", "mailto:"].iter().any(|p| lower.starts_with(p)) || url.len() > 4096 {
        return Err(anyhow!("refusing to open this kind of link"));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| anyhow!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_saved_before_the_lock_time_existed_get_fifteen_minutes() {
        let s: Settings = serde_json::from_str(r#"{"quake":true}"#).unwrap();
        assert_eq!(s.vault_idle_minutes, 15);
        assert!(VAULT_IDLE_CHOICES.contains(&s.vault_idle_minutes));
    }

    #[test]
    fn default_hotkey_is_understood() {
        assert!(valid_hotkey(DEFAULT_KEY));
        assert!(valid_hotkey("Ctrl+Alt+Space"));
        assert!(!valid_hotkey("Ctrl+"));
        assert!(!valid_hotkey("nonsense key"));
    }
}
