// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `portique mcp` is the stdio bridge for agent programs; it shows no window.
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        std::process::exit(portique_lib::run_mcp_bridge());
    }
    portique_lib::run()
}
