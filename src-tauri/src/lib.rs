mod http;
mod keys;
mod local;
mod serial;
mod sftp;
mod session;
mod ssh;
mod store;
mod telnet;
mod tunnel;
mod vault;
mod window;

use serde::Serialize;
use session::{Ctl, Emitter, Params, Sessions};
use store::{Profile, Theme};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};

type Res<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// ---- profiles -------------------------------------------------------------

#[tauri::command]
fn list_profiles() -> Res<Vec<Profile>> {
    store::load_profiles().map_err(err)
}

/// Insert or update. An empty id means "new"; the stored profile is returned.
#[tauri::command]
fn save_profile(mut profile: Profile) -> Res<Profile> {
    let mut all = store::load_profiles().map_err(err)?;
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    if profile.protocol == store::Protocol::Local || profile.id.starts_with(local::PREFIX) {
        return Err("local terminals are not saved as profiles".into());
    }
    if profile.protocol != store::Protocol::Ssh {
        profile.jump_host = None;
        profile.forwards.clear();
    }
    profile.jump_host = profile.jump_host.filter(|j| !j.is_empty() && *j != profile.id);
    profile.forwards.retain(|f| f.listen_port != 0);
    match all.iter_mut().find(|p| p.id == profile.id) {
        Some(slot) => *slot = profile.clone(),
        None => all.push(profile.clone()),
    }
    store::save_profiles(&all).map_err(err)?;
    Ok(profile)
}

/// Registers a host typed into quick connect and returns it with an id. It lives in memory only, so it
/// is never listed or saved unless the user saves it from the editor.
#[tauri::command]
fn quick_profile(profile: Profile) -> Res<Profile> {
    store::add_quick(profile).map_err(err)
}

#[tauri::command]
fn delete_profile(id: String) -> Res<()> {
    let mut all = store::load_profiles().map_err(err)?;
    all.retain(|p| p.id != id);
    // Profiles that jumped through the deleted one would otherwise fail to connect.
    for p in all.iter_mut().filter(|p| p.jump_host.as_deref() == Some(id.as_str())) {
        p.jump_host = None;
    }
    store::save_profiles(&all).map_err(err)?;
    // Best effort: a locked vault must not block deleting the profile entry.
    let _ = vault::global().delete(&vault::password_account(&id));
    Ok(())
}

// ---- workspaces (window layouts: which profiles, split how) ----------------

/// Opaque to the backend: the frontend owns the shape (it holds profile ids only, no secrets).
#[tauri::command]
fn load_workspaces() -> Res<serde_json::Value> {
    store::read_json("workspaces.json").map_err(err)
}

#[tauri::command]
fn save_workspaces(data: serde_json::Value) -> Res<()> {
    store::write_json("workspaces.json", &data).map_err(err)
}

// ---- API requests (the API tab) ---------------------------------------------

/// Saved requests and environments. Opaque to the backend: the frontend owns the shape
/// (secret variable values are not in it; they live in the vault).
#[tauri::command]
fn load_api_data() -> Res<serde_json::Value> {
    store::read_json("api.json").map_err(err)
}

#[tauri::command]
fn save_api_data(data: serde_json::Value) -> Res<()> {
    store::write_json("api.json", &data).map_err(err)
}

/// Stores (or, if empty, removes) a secret variable of an environment.
#[tauri::command]
fn set_api_secret(env_id: String, name: String, value: String) -> Res<()> {
    let mut v = vault::global();
    let acct = http::secret_account(&env_id, &name);
    if value.is_empty() { v.delete(&acct) } else { v.set(&acct, &value) }.map_err(err)
}

#[tauri::command]
fn has_api_secret(env_id: String, name: String) -> Res<bool> {
    vault::global().contains(&http::secret_account(&env_id, &name)).map_err(err)
}

/// Largest file the import reader will take.
const MAX_IMPORT: u64 = 20 * 1024 * 1024;

/// Reads a text file chosen in the import dialog.
#[tauri::command]
async fn read_text_file(path: String) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let len = std::fs::metadata(&path).map_err(|e| format!("cannot read {path}: {e}"))?.len();
        if len > MAX_IMPORT {
            return Err(format!("{path} is too large to import ({} MB)", len / 1024 / 1024));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
        String::from_utf8(bytes).map_err(|_| format!("{path} is not a text file"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes a text file chosen in the export dialog.
#[tauri::command]
async fn write_text_file(path: String, content: String) -> Res<()> {
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, content).map_err(|e| format!("cannot write {path}: {e}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn http_send(req: http::Request) -> Res<http::Response> {
    http::send(req).await.map_err(err)
}

#[tauri::command]
fn http_cancel(id: String) {
    http::cancel(&id);
}

// ---- themes (user-defined; built-ins live in the frontend) -----------------

#[tauri::command]
fn list_themes() -> Res<Vec<Theme>> {
    let all: Vec<Theme> = store::read_json("themes.json").map_err(err)?;
    Ok(all.into_iter().filter(Theme::valid).collect())
}

#[tauri::command]
fn save_theme(mut theme: Theme) -> Res<Theme> {
    if !theme.valid() {
        return Err("theme colours must be #rrggbb and include 16 ANSI colours".into());
    }
    let mut all: Vec<Theme> = store::read_json("themes.json").map_err(err)?;
    if theme.id.is_empty() {
        theme.id = uuid::Uuid::new_v4().to_string();
    }
    match all.iter_mut().find(|t| t.id == theme.id) {
        Some(slot) => *slot = theme.clone(),
        None => all.push(theme.clone()),
    }
    store::write_json("themes.json", &all).map_err(err)?;
    Ok(theme)
}

#[tauri::command]
fn delete_theme(id: String) -> Res<()> {
    let mut all: Vec<Theme> = store::read_json("themes.json").map_err(err)?;
    all.retain(|t| t.id != id);
    store::write_json("themes.json", &all).map_err(err)
}

// ---- vault ------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
    min_password_len: usize,
}

#[tauri::command]
fn vault_status() -> VaultStatus {
    let v = vault::global();
    VaultStatus { exists: v.exists(), unlocked: v.is_unlocked(), min_password_len: vault::MIN_PASSWORD_LEN }
}

/// Argon2 is deliberately slow and memory-hungry, so run it off the UI thread.
#[tauri::command]
async fn vault_create(password: String) -> Res<()> {
    tauri::async_runtime::spawn_blocking(move || vault::global().create(&password, vault::Kdf::DEFAULT))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
async fn vault_unlock(password: String) -> Res<()> {
    tauri::async_runtime::spawn_blocking(move || vault::global().unlock(&password))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
fn vault_lock() {
    vault::global().lock();
}

#[tauri::command]
fn vault_touch() {
    vault::global().touch();
}

#[tauri::command]
async fn vault_change_password(old: String, new: String) -> Res<()> {
    tauri::async_runtime::spawn_blocking(move || vault::global().change_password(&old, &new))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

// ---- saved passwords (write-only from the UI) -------------------------------

#[tauri::command]
fn set_password(profile_id: String, password: String) -> Res<()> {
    let mut v = vault::global();
    let acct = vault::password_account(&profile_id);
    if password.is_empty() { v.delete(&acct) } else { v.set(&acct, &password) }.map_err(err)
}

/// Copies a saved password to another profile inside Rust, so a duplicate keeps its login
/// without the interface ever reading the secret. Does nothing if the source has none.
#[tauri::command]
fn copy_password(from_id: String, to_id: String) -> Res<()> {
    let mut v = vault::global();
    if let Some(pw) = v.get(&vault::password_account(&from_id)).map_err(err)? {
        v.set(&vault::password_account(&to_id), &pw).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn has_password(profile_id: String) -> Res<bool> {
    vault::global().contains(&vault::password_account(&profile_id)).map_err(err)
}

// ---- keys -------------------------------------------------------------------

#[tauri::command]
fn list_keys() -> Res<Vec<keys::KeyInfo>> {
    keys::list().map_err(err)
}

#[tauri::command]
fn import_key(name: String, pem: String, passphrase: Option<String>) -> Res<keys::KeyInfo> {
    keys::import(&name, &pem, passphrase.as_deref().filter(|s| !s.is_empty())).map_err(err)
}

#[tauri::command]
fn delete_key(id: String) -> Res<()> {
    keys::delete(&id).map_err(err)
}

#[tauri::command]
fn forget_host(host: String, port: u16) -> Res<()> {
    ssh::forget_host(&host, port).map_err(err)
}

// ---- serial ports -----------------------------------------------------------

#[derive(Serialize)]
struct PortInfo {
    name: String,
    description: String,
}

#[tauri::command]
fn list_serial_ports() -> Res<Vec<PortInfo>> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| PortInfo {
            description: match p.port_type {
                serialport::SerialPortType::UsbPort(u) => u.product.unwrap_or_else(|| "USB serial".into()),
                serialport::SerialPortType::PciPort => "PCI".into(),
                serialport::SerialPortType::BluetoothPort => "Bluetooth".into(),
                serialport::SerialPortType::Unknown => String::new(),
            },
            name: p.port_name,
        })
        .collect())
}

// ---- app settings and window behaviour ---------------------------------------

#[tauri::command]
fn get_settings() -> window::Settings {
    window::load()
}

#[tauri::command]
fn set_gpu(enabled: bool) -> Res<()> {
    let mut s = window::load();
    s.gpu = enabled;
    window::save(&s).map_err(err)
}

/// General preferences from the settings pane (the hotkey, drop-down mode and GPU have their own commands).
#[tauri::command]
fn set_prefs(restore_tabs: bool, sftp_local_dir: String, ui_scale: String, vault_idle_minutes: u32) -> Res<()> {
    if sftp_local_dir.len() > 4096 || sftp_local_dir.contains('\0') {
        return Err("that folder path is not valid".into());
    }
    if !["normal", "large"].contains(&ui_scale.as_str()) {
        return Err("unknown interface size".into());
    }
    if !window::VAULT_IDLE_CHOICES.contains(&vault_idle_minutes) {
        return Err("unknown vault lock time".into());
    }
    let mut s = window::load();
    s.vault_idle_minutes = vault_idle_minutes;
    s.restore_tabs = restore_tabs;
    s.sftp_local_dir = sftp_local_dir.trim().to_string();
    s.ui_scale = ui_scale;
    window::save(&s).map_err(err)
}

/// The shells found on this computer, for the settings pane. Looks again each time.
#[tauri::command]
async fn list_local_shells() -> Res<Vec<local::Shell>> {
    tauri::async_runtime::spawn_blocking(local::detect).await.map_err(|e| e.to_string())
}

/// The local terminals the settings turn on, as profiles to list and open (empty when they are off).
#[tauri::command]
async fn list_local_terminals() -> Res<Vec<Profile>> {
    tauri::async_runtime::spawn_blocking(|| {
        let s = window::load();
        if !s.local_terminals {
            return Vec::new();
        }
        let shells = local::detect();
        s.local_shells.iter().filter_map(|id| shells.iter().find(|x| &x.id == id)).map(local::profile_of).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Turns local terminals on or off and chooses which shells to offer. Unknown shells are dropped.
#[tauri::command]
async fn set_local_terminals(enabled: bool, shells: Vec<String>) -> Res<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let known = local::detect();
        let mut s = window::load();
        s.local_terminals = enabled;
        s.local_shells = known.iter().filter(|k| shells.contains(&k.id)).map(|k| k.id.clone()).collect();
        window::save(&s).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_ui(ui: window::UiColours) -> Res<()> {
    if !ui.valid() {
        return Err("interface colours must be #rrggbb".into());
    }
    let mut s = window::load();
    s.ui = ui;
    window::save(&s).map_err(err)
}

/// Turns drop-down mode on or off. The setting is only kept if it could be applied.
#[tauri::command]
fn set_quake(app: tauri::AppHandle, enabled: bool) -> Res<()> {
    let mut s = window::load();
    s.quake = enabled;
    window::apply_quake(&app, &s).map_err(err)?;
    window::save(&s).map_err(err)
}

/// Changes the drop-down hotkey. If drop-down mode is on and the new key cannot be taken, the old one stays.
#[tauri::command]
fn set_quake_key(app: tauri::AppHandle, key: String) -> Res<()> {
    let key = key.trim().to_string();
    if !window::valid_hotkey(&key) {
        return Err(format!("\"{key}\" is not a hotkey. Try something like Ctrl+Alt+Space or Ctrl+Backquote."));
    }
    let old = window::load();
    let mut s = old.clone();
    s.quake_key = key;
    if s.quake {
        if let Err(e) = window::apply_quake(&app, &s) {
            let _ = window::apply_quake(&app, &old);
            return Err(err(e));
        }
    }
    window::save(&s).map_err(err)
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Res<()> {
    window::open_link(&app, &url).map_err(err)
}

// ---- sessions ---------------------------------------------------------------

/// Starts a session and returns its id. Output/status frames stream over `on_event`
/// (see `Emitter`); a `need-password`/`need-passphrase` status asks the UI to prompt and retry.
#[tauri::command]
fn connect_session(
    sessions: State<'_, Sessions>,
    profile_id: String,
    cols: u16,
    rows: u16,
    password: Option<String>,
    passphrase: Option<String>,
    on_event: Channel<InvokeResponseBody>,
) -> Res<String> {
    let profile = store::get_profile(&profile_id).map_err(err)?;
    let params = Params { cols, rows, password, passphrase, ..Default::default() };
    Ok(session::start(&sessions, profile, params, Emitter::new(on_event)))
}

/// Answer a `confirm-host` prompt for the session.
#[tauri::command]
fn confirm_host(sessions: State<'_, Sessions>, id: String, accept: bool) {
    sessions.answer_host(&id, accept);
}

#[tauri::command]
fn session_input(sessions: State<'_, Sessions>, id: String, data: Vec<u8>) {
    sessions.send(&id, Ctl::Input(data));
}

#[tauri::command]
fn session_resize(sessions: State<'_, Sessions>, id: String, cols: u16, rows: u16) {
    sessions.send(&id, Ctl::Resize(cols, rows));
}

#[tauri::command]
fn session_close(sessions: State<'_, Sessions>, id: String) {
    sessions.send(&id, Ctl::Close);
}

// ---- SFTP file browser --------------------------------------------------------

/// Opens an SFTP browser session for an SSH profile. Same event stream and prompts as `connect_session`.
#[tauri::command]
fn connect_sftp(
    sessions: State<'_, Sessions>,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    on_event: Channel<InvokeResponseBody>,
) -> Res<String> {
    let profile = store::get_profile(&profile_id).map_err(err)?;
    if profile.protocol != store::Protocol::Ssh {
        return Err("SFTP needs an SSH profile".into());
    }
    let params = Params { password, passphrase, sftp: true, ..Default::default() };
    Ok(session::start(&sessions, profile, params, Emitter::new(on_event)))
}

/// Logs in to an SSH profile and offers a local SOCKS5 proxy through it (a `proxy` status carries the
/// port), for sending API requests from the server's point of view. Same event stream and prompts as `connect_session`.
#[tauri::command]
fn connect_proxy(
    sessions: State<'_, Sessions>,
    profile_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    on_event: Channel<InvokeResponseBody>,
) -> Res<String> {
    let profile = store::get_profile(&profile_id).map_err(err)?;
    if profile.protocol != store::Protocol::Ssh {
        return Err("Only SSH profiles can carry API requests".into());
    }
    let params = Params { password, passphrase, proxy: true, ..Default::default() };
    Ok(session::start(&sessions, profile, params, Emitter::new(on_event)))
}

#[tauri::command]
async fn sftp_list(id: String, path: String) -> Res<sftp::Listing> {
    sftp::list(&id, &path).await.map_err(err)
}

#[tauri::command]
async fn sftp_mkdir(id: String, path: String) -> Res<()> {
    sftp::mkdir(&id, &path).await.map_err(err)
}

#[tauri::command]
async fn sftp_rename(id: String, from: String, to: String) -> Res<()> {
    sftp::rename(&id, &from, &to).await.map_err(err)
}

#[tauri::command]
async fn sftp_delete(id: String, path: String) -> Res<()> {
    sftp::remove(&id, &path).await.map_err(err)
}

/// Queues uploads (`upload` true) or downloads; progress comes back as `transfer` status frames.
#[tauri::command]
fn sftp_transfer(id: String, upload: bool, items: Vec<sftp::Item>, overwrite: bool) -> Res<Vec<sftp::Started>> {
    sftp::start_transfers(&id, upload, items, overwrite).map_err(err)
}

#[tauri::command]
fn sftp_cancel(id: String, tid: String) {
    sftp::cancel(&id, &tid);
}

#[tauri::command]
fn local_home() -> String {
    sftp::local_home()
}

#[tauri::command]
async fn local_list(path: String) -> Res<sftp::Listing> {
    tauri::async_runtime::spawn_blocking(move || sftp::local_list(&path)).await.map_err(|e| e.to_string())?.map_err(err)
}

#[tauri::command]
fn local_mkdir(path: String) -> Res<()> {
    sftp::local_mkdir(&path).map_err(err)
}

#[tauri::command]
fn local_rename(from: String, to: String) -> Res<()> {
    sftp::local_rename(&from, &to).map_err(err)
}

#[tauri::command]
async fn local_delete(path: String) -> Res<()> {
    tauri::async_runtime::spawn_blocking(move || sftp::local_delete(&path)).await.map_err(|e| e.to_string())?.map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Sessions::default())
        .setup(|app| {
            let settings = window::load();
            if settings.quake {
                if let Err(e) = window::apply_quake(app.handle(), &settings) {
                    eprintln!("drop-down mode disabled: {e:#}");
                    let _ = window::save(&window::Settings { quake: false, ..settings });
                }
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    let minutes = window::load().vault_idle_minutes;
                    if minutes == 0 {
                        continue;
                    }
                    if vault::global().lock_if_idle(std::time::Duration::from_secs(u64::from(minutes) * 60)) {
                        let _ = tauri::Emitter::emit(&handle, "vault-locked", ());
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            vault_touch,
            vault_change_password,
            list_profiles,
            save_profile,
            delete_profile,
            get_settings,
            list_local_shells,
            list_local_terminals,
            set_local_terminals,
            set_ui,
            set_prefs,
            set_quake_key,
            set_gpu,
            set_quake,
            open_url,
            load_workspaces,
            save_workspaces,
            list_themes,
            save_theme,
            delete_theme,
            quick_profile,
            set_password,
            copy_password,
            has_password,
            list_keys,
            import_key,
            delete_key,
            forget_host,
            list_serial_ports,
            connect_session,
            confirm_host,
            session_input,
            session_resize,
            session_close,
            connect_sftp,
            sftp_list,
            sftp_mkdir,
            sftp_rename,
            sftp_delete,
            sftp_transfer,
            sftp_cancel,
            local_home,
            local_list,
            local_mkdir,
            local_rename,
            local_delete,
            load_api_data,
            save_api_data,
            set_api_secret,
            has_api_secret,
            http_send,
            http_cancel,
            connect_proxy,
            read_text_file,
            write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
