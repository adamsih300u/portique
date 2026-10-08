# API client

Portique can send HTTP requests and show what comes back, next to your terminals and file browsers.
Open one with **Ctrl+Shift+A**, from the command palette, by right-clicking empty space in the sidebar, or from the sidebar's ⋯ menu.

## A request

```
[ GET ▾ ] [ {{baseUrl}}/users/42                    ] [ Send ]  [ Staging ▾ ]
  Params · Headers · Auth · Body · After · Options
  ────────────────────────────────────────────────────────────
  200 OK · 143 ms · 1.2 KB · ✓ 3 passed          Body · Headers · Checks
  { "id": 42, "name": "Ada" }
```

| Part | What it does |
|---|---|
| **Address** | Type a URL, or paste a `curl` command to import it. A missing `https://` is added (`http://` for `localhost` and bare IP addresses). |
| **Params** | Query parameters as a table. It stays in step with the address in both directions; untick a row to leave it out. |
| **Headers** | Name/value rows. `Content-Type` is set for you when you pick a JSON or form body. |
| **Auth** | None, bearer token, username and password, an API key in a header, or OAuth 2.0 (below). |
| **Body** | None, JSON (with *Format* and a validity hint), plain text, or form fields (encoded for you). |
| **After** | Checks on the response and values to remember from it (below). |
| **Options** | Follow redirects, allow self-signed certificates, time-out, and *Send from* (below). |

Ctrl+Enter sends, Esc cancels while waiting, Ctrl+S saves, Ctrl+L goes to the address.
Right-click blank space for *Copy as cURL*, *Environments…* and a side-by-side layout. Right-click the response to copy the body or headers.

Requests are sent by the Rust side of the app, not the web view, so there is no CORS and the connection can use settings a browser can't.

## Saving, and the sidebar

**Ctrl+S** names the request. Write `Folder/Name` to file it in a folder. Saved requests are listed in the sidebar under **Requests** (folders appear as *Requests / Folder*); double-click to open, right-click for rename, move, duplicate and delete.

Right-click **empty space** in the sidebar for *New profile…*, *New API request*, *Import requests…* and *Export requests…*.
The same commands are in the ⋯ menu and the command palette.

Saved requests and environments are kept in `api.json` in the Portique data folder (`~/.config/portique` or `%APPDATA%\portique`).

## Environments and secrets

An **environment** is a named set of variables, such as a server address or a token. Use `{{name}}` in the address, a header, the body or a login. Pick the environment at the top right of the request; *Manage environments…* edits them. `{{$uuid}}` and `{{$timestamp}}` are always available.

Tick **Secret** on a variable to keep its value in the encrypted vault. The environment file only records that the variable exists. Secrets are filled in by the backend when the request is sent; the interface never reads them back, so they cannot end up in a saved request, an export or a copied cURL command.
A variable that isn't defined stops the request with a message naming it.

## OAuth 2.0

*Auth → OAuth 2.0 (client credentials)*: token URL, client ID, client secret, optional scope (all accept `{{variables}}`).
Portique signs in when you press Send, keeps the token in memory until it expires, and signs in again if the API answers 401.
A clear message explains a refused sign-in. The token is never written to disk.

## Send from an SSH host

*Options → Send from* lists your SSH profiles. The request then travels through that server: it opens the connection to the API and looks up the address itself, so private services only that server can reach (an internal host name, a database admin API, a service bound to `127.0.0.1` there) work with no VPN.

The first send logs in with the profile's usual prompts (host key, password, passphrase) and the login stays open for later sends. If it drops, the next send logs in again. Jump hosts configured on the profile are used.

## Checks and remembered values

*After → Check the response* adds rows such as *Status is 200*, *Field `user.name` is Ada*, *Header content-type contains json*, *Body contains ok*, *Field `items[0].id` exists*, *Field `total` is more than 0*. They run after every send. The response shows `✓ 3 passed` or `✗ 1 of 3 failed`, and the **Checks** view lists each one with what was found. A failure opens that view by itself.

*After → Remember from the response* takes a JSON field or header and saves it as a variable of the selected environment, so the next request can use it as `{{name}}`. Tick **Secret** to put it in the vault (a login token, say). A typical flow: *POST /login* remembers `access_token` as `token`; every other request uses `{{token}}`.

Field paths look like `user.name`, `items[0].id`, `data["odd key"]`, optionally starting with `$`. Whole numbers too large for JavaScript are kept exactly, so a 20-digit id is never rounded.

## Import and export

*Import requests…* reads:

- Portique's own export,
- collection files exported by other API tools (v2.x): folders become sidebar folders, variables become an environment, bearer/basic/API-key auth comes across,
- OpenAPI 3 and Swagger 2 descriptions **in JSON**: one request per operation, a `{{baseUrl}}` variable, example bodies built from the schema, required query parameters switched on,
- a text file of `curl` commands.

A summary says what was added and lists anything that could not be brought across (multipart bodies, some sign-in types). YAML descriptions are not read yet; convert them to JSON first.

*Export requests…* writes every request and environment to one JSON file. Secret values are never included.

## Not built yet

Roughly in the order they are likely to be wanted.

1. **Multipart and file bodies**, and saving a response to a file.
2. **Cookies** that persist between sends (per environment), and a way to clear them.
3. **History**: the last responses of each request, searchable from the palette.
4. **Run a folder**: send every request in a folder in order, stopping at the first failed check.
5. **Folder defaults**: headers and auth shared by every request in a folder.
6. **Restore API tabs** with workspaces (today unsaved requests are lost on exit, and saved ones are re-opened by hand).
7. **YAML OpenAPI** import, and *refresh from the source file* for an imported API.
8. **More sign-in types**: OAuth 2.0 authorization-code with PKCE, AWS-style request signing, client certificates.
9. **GraphQL** helpers (a query/variables editor and schema browser), **WebSocket** and **Server-Sent Events** tabs.
10. Sidebar niceties: collapsible folders, drag a request onto a folder, a different order.

Not planned: a scripting sandbox, mock servers and a cloud account. Everything stays on this computer.
