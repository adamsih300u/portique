# API client

An **API connection** is a profile like any other: you make it with **+ New**, choose **API** as the protocol, and it appears in the sidebar next to your SSH, Telnet and Serial profiles. Double-click it and it opens as a tab for working with that endpoint: the saved requests down the left, the request being edited and its response on the right.

## Making a connection

**+ New → Protocol: API** (or right-click empty sidebar space → *New API connection…*).

| Setting | What it does |
|---|---|
| **Base address** | Where the endpoint lives, such as `https://api.example.com/v1`. Requests are then written as just `/users/42`. May contain `{{variables}}`. |
| **Send from** | *This computer*, or one of your SSH profiles. Every request then travels through that server, which also looks up the address, so private services only the server can reach work with no VPN. |
| **Sign in** | None, bearer token, username and password, an API key in a header, or OAuth 2.0 (client credentials). Every request uses it unless it says otherwise. |
| **Headers** | Sent with every request on the connection. A request can replace one by adding a header of the same name. |
| **Options** | Follow redirects, allow self-signed certificates, time-out. |

Right-click the connection in the sidebar for *Open*, *New request*, *Edit…* and *Delete…*. Deleting a connection also deletes its saved requests, its environments, and their secrets from the vault.

## The connection tab

```
 Requests   [+ New] [⋯]  │ [ GET ▾ ] [ api.example.com/v1 /users/42 ] [ Send ]  [ Staging ▾ ]
 [ Filter… ]             │   Params · Headers · Auth · Body · After
  GET  List users        │  ────────────────────────────────────────────────────────────
 ▾ ORDERS                │   200 OK · 143 ms · 1.2 KB · ✓ 3 passed       Body · Headers · Checks
    GET  Open orders     │   { "id": 42, "name": "Ada" }
    DEL  Cancel order    │
```

**The rail (left)** lists the connection's saved requests, grouped into folders. Click one to open it; each request you open keeps its own unsaved edits and its own last response while you move between them (a dot marks unsaved changes). **+ New** starts a request. Right-click a request for *Rename…*, *Move to folder…*, *Duplicate*, *Copy as cURL* and *Delete…*; right-click empty space or use **⋯** for *Import requests…*, *Export requests…*, *Environments…* and *Connection settings…*. Drag the divider to resize it.

**The request (right)** is an address bar with the connection's base address dimmed in front of the path, then these tabs:

| Tab | What it does |
|---|---|
| **Params** | Query parameters as a table, kept in step with the address both ways. Untick a row to leave it out. |
| **Headers** | This request's own headers. The ones the connection adds are listed underneath. |
| **Auth** | *Use the connection's sign-in* (the default), or override it for this request. |
| **Body** | None, JSON (with *Format* and a validity hint), plain text, or form fields (encoded for you). |
| **After** | Checks on the response and values to remember from it (below). |

A request can also have a complete address of its own (`https://…`); the base address is then struck through and ignored. Paste a `curl` command into the address to import it.

Shortcuts: **Ctrl+Enter** send, **Esc** cancel while waiting, **Ctrl+S** save (write `Folder/Name` to file it in a folder), **Ctrl+L** go to the address, **Ctrl+Shift+A** new request. Right-click a blank part of the request for *Copy as cURL*, *Environments…*, *Connection settings…* and a side-by-side layout; right-click the response to copy the body or headers.

Requests are sent by the Rust side of the app, not the web view, so there is no CORS.

The tab, like the file browser, follows the **interface colours** (*Interface colours…* and the looks such as Ivoire or Bordeaux), never a terminal colour theme. Status colours (success, failure, method names, JSON) switch to deeper shades on a light look so they stay readable, and dialogs, menus and the palette follow the same look.

## Environments and secrets

Each connection has its own **environments**: named sets of variables such as a server address or a token. Use `{{name}}` in the address, a header, the body or a sign-in. Pick the environment at the top right of the request; *Environments…* edits them. `{{$uuid}}` and `{{$timestamp}}` are always available.

Tick **Secret** on a variable to keep its value in the encrypted vault. The environment file only records that the variable exists. Secrets are filled in by the backend when the request is sent; the interface never reads them back, so they cannot end up in a saved request, an export or a copied cURL command. A variable that isn't defined stops the request with a message naming it.

## OAuth 2.0

Set it as the connection's sign-in (or on one request). Token URL, client ID, client secret and optional scope all accept `{{variables}}`. Portique signs in when you press Send, keeps the token in memory until it expires, and signs in again if the API answers 401. A refused sign-in is explained in words. The token is never written to disk.

## Sending from an SSH host

With *Send from* set to an SSH profile, the first send logs in using the profile's usual prompts (host key, password, passphrase) and the login stays open for later sends and other tabs. If it drops, the next send logs in again. Jump hosts configured on the profile are used. The response shows `via <host>`.

## Checks and remembered values

*After → Check the response* adds rows such as *Status is 200*, *Field `user.name` is Ada*, *Header content-type contains json*, *Body contains ok*, *Field `items[0].id` exists*, *Field `total` is more than 0*. They run after every send. The response shows `✓ 3 passed` or `✗ 1 of 3 failed`, and the **Checks** view lists each one with what was found; a failure opens that view by itself.

*After → Remember from the response* takes a JSON field or header and saves it as a variable of the selected environment, so the next request can use it as `{{name}}`. Tick **Secret** to put it in the vault (a login token, say). A typical flow: *POST /login* remembers `access_token` as `token`, and the connection's sign-in is a bearer token of `{{token}}`.

Field paths look like `user.name`, `items[0].id`, `data["odd key"]`, optionally starting with `$`. Whole numbers too large for JavaScript are kept exactly, so a 20-digit id is never rounded.

## Import and export

*Import requests…* (in the rail's **⋯** menu) adds to the current connection from:

- Portique's own export,
- collection files exported by other API tools (v2.x): folders become folders, variables become an environment, bearer/basic/API-key sign-in comes across,
- OpenAPI 3 and Swagger 2 descriptions **in JSON**: one request per operation, a `{{baseUrl}}` variable, example bodies built from the schema, required query parameters switched on,
- a text file of `curl` commands.

A summary says what was added and lists anything that could not be brought across (multipart bodies, some sign-in types). YAML descriptions are not read yet; convert them to JSON first.

*Export requests…* writes the connection's requests and environments to one JSON file. Secret values are never included.

## Where it is saved

The connection itself (name, base address, sign-in, headers, options) is an ordinary profile in `profiles.json`. Its requests and environments are in `api.json`, keyed by the connection. Both are in the Portique data folder (`~/.config/portique` or `%APPDATA%\portique`). Secrets are only in the vault.

Requests saved by an earlier version, before connections existed, are moved into a connection called **Saved requests** the first time the new version starts.

## Not built yet

Roughly in the order they are likely to be wanted.

1. **Multipart and file bodies**, and saving a response to a file.
2. **Cookies** that persist between sends (per environment), and a way to clear them.
3. **History**: the last responses of each request, searchable from the palette.
4. **Run a folder**: send every request in a folder in order, stopping at the first failed check.
5. **Folder defaults**: headers and sign-in shared by the requests in one folder, on top of the connection's.
6. **Restore API tabs** with workspaces (today a tab opens fresh each launch; saved requests are all still there).
7. **YAML OpenAPI** import, and *refresh from the source file* for an imported API.
8. **More sign-in types**: OAuth 2.0 authorization-code with PKCE, AWS-style request signing, client certificates.
9. **GraphQL** helpers (a query/variables editor and schema browser), **WebSocket** and **Server-Sent Events** tabs.
10. Rail niceties: drag a request onto a folder, a manual order, folders inside folders.

Not planned: a scripting sandbox, mock servers and a cloud account. Everything stays on this computer.
