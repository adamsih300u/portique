# The API client: connections, sending from an SSH host, checks, import

- **Branch:** `feature/api-roadmap` (written before the `<type>/<slug>` naming; later branches follow it)
- **PR:** not opened yet
- **Status:** ready for review
- **Author:** Claude (agent), with Adam

## Summary

Portique can now work with web APIs. An API is a connection you make with **+ New → API**, like an SSH or Telnet profile. Opening it gives a tab with that endpoint's saved requests on the left and the request and its response on the right. Requests can be sent through an SSH host, sign in with OAuth 2.0, be checked against the response, and be imported from or exported to files. The same branch also makes dialogs, menus and status colours follow the interface look, and fixes the welcome emblem so it follows it too.

## Why

Adam asked for an interface for talking to APIs "like a new SSH or Telnet connection to an endpoint", with saved endpoints and tests, in keeping with the rest of the app. A first version (a single request tab opened by a shortcut) went into the initial commit; it worked but nobody could find it, and requests lived in one global list rather than with the endpoint they belong to.

## What changed

- **Backend (`src-tauri/src/`):** `http.rs` is new (variable expansion, OAuth 2.0 with a token cache, SOCKS5 proxy support, cancellation). `ssh.rs`, `tunnel.rs` and `session.rs` gain a proxy session. `store.rs` gains the `api` protocol and an opaque `Profile.api`. `lib.rs` gains the commands, the file dialog plugin and file read/write.
- **Interface (`src/`):** `api-tab.ts` (the tab and its rail), `http-request.ts` (one request), `api-connection.ts` (the form in the profile editor), `http-model.ts`, `http-checks.ts`, `http-import.ts`, `http-transfer.ts`, `http-store.ts`, `http-env.ts`, `http-proxy.ts`. `editors.ts`, `main.ts`, `chrome.ts`, `styles.css` and `emblem.ts` are edited.
- **Docs:** `docs/api-client.md` is the user guide and the list of what is not built yet.

## How to review

Start with `docs/api-client.md` for the behaviour, then `http-model.ts` (the rules for addresses and headers), `http.rs`, and `api-tab.ts`. Look hardest at the secret handling in `http.rs` and `http-store.ts`, and at the migration in `http-store.ts` (`load`). Four commits tell the story in order: emblem, feature phase 3, connection redesign, theming.

## What was tested

- `cargo test --lib`: 26 pass, including a local OAuth server and a local SOCKS5 server for the proxy path.
- The pure logic (checks, imports, address joining, file migration) was bundled and run in Node.
- The interface ran end to end in headless Chromium against the built bundle, with the Tauri calls mocked, in four interface looks.
- A Windows executable was cross-compiled and packaged. **Not run:** on real Windows, against a real SSH server (the proxy was tested against a local SOCKS server), or against a real OAuth provider.

## Not done / follow-ups

The ordered list is in `docs/api-client.md` under *Not built yet*: multipart and file bodies, cookies, history, run-a-folder, folder defaults, restoring API tabs, YAML OpenAPI, GraphQL and WebSocket. The frontend has no automated tests in the repository; adding a runner is its own branch.

## Decisions

### D1. An API endpoint is a profile, and its tab holds its requests

- **Status:** accepted
- **Context:** The first version had one global list of requests in the sidebar. Requests for different services were mixed, and environments, sign-in and base addresses had no natural home. Adam's own model was "a connection, like SSH".
- **Decision:** `protocol: "api"` on the existing profile. The profile carries the base address, default sign-in and headers, and the SSH host to send from. Requests and environments belong to the connection.
- **Consequences:** Discoverable (it is in **+ New**), grouped and searchable like any profile, and each connection can have its own environments. Requests inherit sign-in and headers, which gives "folder defaults" at connection level for free. An earlier global file is moved into a "Saved requests" connection on first start.
- **Alternatives considered:** keep the global list with an optional "connection" field (still mixes concerns); a separate "API" sidebar section (a second kind of thing to learn); one tab per request (no place for saved endpoints).

### D2. Requests are sent from Rust, not the web view

- **Status:** accepted
- **Context:** A browser `fetch` is bound by CORS, can't accept self-signed certificates, can't go through an SSH proxy, and would need secrets in the page.
- **Decision:** All requests go through a `http_send` command using `reqwest`.
- **Consequences:** No CORS, full control of TLS and proxies, cancellable. It adds a dependency and a TLS library that needs `nasm` and `cmake` to cross-compile for Windows.
- **Alternatives considered:** `fetch` with a CORS proxy (fragile and unsafe); the Tauri HTTP plugin (less control over the pieces above).

### D3. Secret values are filled in by Rust and never read back

- **Status:** accepted (standing)
- **Context:** Tokens and client secrets must not end up in saved requests, exports, copied cURL commands, or the page's memory longer than needed.
- **Decision:** Secret environment values are stored in the vault as `apienv:<envId>:<name>`. The interface can write one but can't read one. `http.rs` expands `{{name}}` itself, looking up plain values the interface sends and secrets in the vault. Exports and cURL keep `{{name}}`.
- **Consequences:** Secrets are safe by construction, but the interface can't show a secret's value, and a request preview can't show the final secret.
- **Alternatives considered:** keeping secrets in `api.json` (plain text on disk); returning them to the page on demand (they would reach saved state and screenshots).

### D4. Sending through an SSH host uses a local SOCKS5 proxy

- **Status:** accepted
- **Context:** Adam wanted requests to reach services only an SSH server can see. The app already had a SOCKS5 forwarder for port forwards.
- **Decision:** A new session type logs in, opens the forwarder on an ephemeral local port, and reports the port. Requests use `socks5h://127.0.0.1:<port>`, so the **server** resolves the name. One login is kept per profile and reused.
- **Consequences:** Hostnames that only resolve on the server work, redirects to other hosts stay inside the tunnel, and jump hosts are honoured. The login stays open until the connection drops.
- **Alternatives considered:** a local forward per destination with a DNS override (breaks on redirects to new hosts); a custom connector in the HTTP client (more code for the same result).

### D5. Settings in the profile, requests in `api.json`

- **Status:** accepted
- **Context:** The profile editor saves a whole profile. Requests change on every Ctrl+S.
- **Decision:** A connection's settings are an opaque `Profile.api` blob (the backend does not interpret it); requests, environments and the active environment are in `api.json` keyed by profile id.
- **Consequences:** Editing a connection can't overwrite requests saved a moment before, and the backend needs no change when the settings grow. The cost is two files per connection and a clean-up when one is deleted (`httpStore.deleteConnection` also removes vault secrets).
- **Alternatives considered:** everything in the profile (the editor could overwrite newer requests); a typed Rust struct (every new field needs backend work).

### D6. Follow the interface look: paint the document root, and use meaning-carrying variables

- **Status:** accepted (standing)
- **Context:** Under a light look, dialogs and menus stayed dark (they sit outside the themed regions) and the pastel status colours were unreadable (about 1.4:1).
- **Decision:** `chrome.ts` also paints the document root with the content look, and sets `--ok`, `--warn`, `--danger`, `--info`, `--violet` and the JSON colours per region, choosing a dark or a deeper set by the region's lightness. Styles use the variables.
- **Consequences:** Everything follows the look and stays at least 4.5:1 on the bundled looks. New colours that mean something must be added to that set rather than written as hex.
- **Alternatives considered:** per-component overrides for each dialog (easy to miss one); using the terminal theme (wrong by Adam's brief).

### D7. Large whole numbers survive checks and captures

- **Status:** accepted
- **Context:** `JSON.parse` rounds integers above 2^53, so a 20-digit id would be silently changed. The engine feature that exposes the original text is not in every web view.
- **Decision:** Before parsing, a single pass over the text quotes unsafe integers, skipping strings and keeping decimals and exponents whole.
- **Consequences:** Ids are exact and the same code works in every web view; such values compare as text, which is what ids want.
- **Alternatives considered:** the `JSON.parse` reviver's source-text argument (missing in older WebKit); a JSON library (new dependency for one problem).

### D8. Import reads files and describes them in plain words

- **Status:** accepted
- **Context:** People will have existing request collections and API descriptions.
- **Decision:** Import accepts this app's export, collection files (v2.x), OpenAPI 3 and Swagger 2 in JSON, and lists of curl commands. The file dialog is called through the dialog plugin's own commands rather than an npm package. YAML is refused with a clear message.
- **Consequences:** No new JavaScript dependency; features that don't map (multipart bodies, some sign-in types) are listed after import rather than guessed at. YAML waits for its own branch.
- **Alternatives considered:** bundling a YAML parser now (more weight for a secondary format).
