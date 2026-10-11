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

Right-click the connection in the sidebar for *Open*, *New request*, *Edit…*, *Duplicate…* and *Delete…*. Deleting a connection also deletes its saved requests, its environments, and their secrets from the vault.

## The connection tab

```
 Requests   [+ New] [⋯]  │ [ GET ▾ ] [ api.example.com/v1 /users/42 ] [ Send ]  [ Staging ▾ ]
 [ Filter… ]             │   Params · Headers · Auth · Body · After
  GET  List users        │  ────────────────────────────────────────────────────────────
 ▾ ORDERS                │   200 OK · 143 ms · 1.2 KB · ✓ 3 passed       Body · Headers · Checks
    GET  Open orders     │   { "id": 42, "name": "Ada" }
    DEL  Cancel order    │
```

**The rail (left)** lists the connection's saved requests, grouped into folders, sorted by name. Type in **Filter requests…** to narrow it by name, folder or method. Click a folder to fold or unfold it; Portique remembers which are folded. Click a request to open it; each one you open keeps its own unsaved edits and its own last response while you move between them. A dot marks unsaved changes, and a request you haven't saved yet shows at the top with *Save…* and *Discard*. Closing a tab with unsaved edits asks first.

**+ New** starts a request. Right-click a request for *Rename…*, *Move to folder…*, *Duplicate*, *Copy as cURL* and *Delete…*; right-click empty space or use **⋯** for *New request*, *Import requests…*, *Export requests…*, *Environments…* and *Connection settings…*. Drag the divider to resize it.

**The request (right)** is an address bar with the connection's base address dimmed in front of the path, then these tabs:

| Tab | What it does |
|---|---|
| **Params** | Query parameters as a table, kept in step with the address both ways. Untick a row to leave it out. |
| **Headers** | This request's own headers. The ones the connection adds are listed underneath. |
| **Auth** | *Use the connection's sign-in* (the default), or override it for this request, including *No authentication* to send none even when the connection has one. |
| **Body** | None, JSON (with *Format* and a validity hint), plain text, or form fields (encoded for you). |
| **After** | Checks on the response and values to remember from it (below). |

A request can also have a complete address of its own (`https://…`); the base address is then struck through and ignored. Paste a `curl` command into the address to import it.

Shortcuts: **Ctrl+Enter** send, **Esc** cancel while waiting, **Ctrl+S** save (write `Folder/Name` to file it in a folder), **Ctrl+L** go to the address, **Ctrl+Shift+A** new request from anywhere (it uses the open connection, or the last one you used). Right-click a blank part of the request for *Send*, *Save*, *Copy as cURL*, *Environments…*, *Connection settings…* and *Show response beside the request*. Portique remembers whether you chose stacked or side by side. Drag the splitter to resize, and double-click it to reset.

An address with no `http://` or `https://` gets one: `http` for `localhost` and IP addresses, `https` for everything else.

Requests are sent by the Rust side of the app, not the web view, so there is no CORS.

### The response

While a request is in flight, **Send** turns into **Cancel**. The response shows the status, the time, the size and the final address if it followed redirects (up to ten). Choose **Pretty** or **Raw** for the body. Right-click it for *Copy body*, *Copy headers* and *Wrap long lines*. Very large JSON (over 300 KB) isn't coloured, bodies stop at 20 MB with a note, and binary bodies aren't shown.

The tab, like the file browser, follows the **interface colours** (*Interface colours…* and the looks such as Ivoire or Bordeaux), never a terminal colour theme. Status colours (success, failure, method names, JSON) switch to deeper shades on a light look so they stay readable, and dialogs, menus and the palette follow the same look.

## Environments and secrets

Each connection has its own **environments**: named sets of variables such as a server address or a token. Use `{{name}}` in the address, a header, the body or a sign-in. Pick the environment at the top right of the request (or *No environment*); *Environments…* edits them. A name starts with a letter, `_` or `$` and then uses letters, digits and `. _ - $`, and each is unique within an environment. `{{$uuid}}` (a fresh random id) and `{{$timestamp}}` (the Unix time in seconds) are always available.

Tick **Secret** on a variable to keep its value in the encrypted vault. The environment file only records that the variable exists. Secrets are filled in by the backend when the request is sent; the interface never reads them back, so they cannot end up in a saved request, an export or a copied cURL command. A variable that isn't defined stops the request with a message naming it.

## OAuth 2.0

Set it as the connection's sign-in (or on one request). It uses the *client credentials* grant: Token URL, client ID, client secret and optional scope all accept `{{variables}}`. Portique signs in when you press Send and keeps the token in memory until shortly before it expires (or for five minutes if the server doesn't say). If the API answers 401, Portique forgets the token and shows you the 401; the request is not repeated, and your next Send signs in again. A refused sign-in is explained in words. The token is never written to disk.

An `Authorization` header you add by hand always wins: if the request has one, Portique doesn't sign in or add its own.

## Sending from an SSH host

With *Send from* set to an SSH profile, the first send logs in using the profile's usual prompts (host key, password, passphrase) and the login stays open for later sends and other tabs. If it drops, the next send logs in again. Jump hosts configured on the profile are used. The response shows `via <host>`.

## Checks and remembered values

*After → Check the response* adds rows such as *Status is 200*, *Field `user.name` is Ada*, *Header content-type contains json*, *Body contains ok*, *Field `items[0].id` exists*, *Field `total` is more than 0*. They run after every send. The response shows `✓ 3 passed` or `✗ 1 of 3 failed`, and the **Checks** view lists each one with what was found; a failure opens that view by itself.

*After → Remember from the response* takes a JSON field or header and saves it as a variable of the selected environment, so the next request can use it as `{{name}}`. Tick **Secret** to put it in the vault (a login token, say). A typical flow: *POST /login* remembers `access_token` as `token`, and the connection's sign-in is a bearer token of `{{token}}`.

Field paths look like `user.name`, `items[0].id`, `data["odd key"]`, optionally starting with `$`. Whole numbers too large for JavaScript are kept exactly, so a 20-digit id is never rounded.

## Import and export

*Import requests…* (in the rail's **⋯** menu) adds to the current connection from:

- Portique's own export,
- collection files exported by other API tools (v2.x): the collection's name becomes a folder, with its sub-folders written as `Collection / Folder`; variables become an environment; bearer, basic and API-key sign-in comes across,
- OpenAPI 3 and Swagger 2 descriptions **in JSON**: one request per operation, a `{{baseUrl}}` variable, example bodies built from the schema, required query parameters and headers switched on, and an environment named after the API with `{{token}}`, `{{username}}`, `{{password}}` or `{{apiKey}}` ready for its sign-in,
- a text file of `curl` commands, which can hold several. The file's name becomes the folder, and the flags that describe a request (`-X`, `-H`, `-d`, `-u`, `--json`, `-b`, `-A`, `-e` and their long forms) are read. You can also paste one `curl` command straight into a request's address.

The file picker shows `.json`, `.txt` and `.sh` files. Imported environments are merged by name, and a variable you already have is never overwritten.

A summary says what was added and lists anything that could not be brought across: multipart and GraphQL bodies, request bodies that aren't JSON in an OpenAPI file, OAuth and OpenID settings, and API keys sent in the query string. YAML descriptions are not read yet; convert them to JSON first.

*Export requests…* writes the connection's requests and environments to one JSON file (`portique-requests.json` unless you rename it). Secret values are never included.

## Where it is saved

The connection itself (name, base address, sign-in, headers, options) is an ordinary profile in `profiles.json`. Its requests and environments are in `api.json`, keyed by the connection. Both are in the Portique data folder (`~/.config/portique` or `%APPDATA%\portique`). Secrets are only in the vault.

Requests saved by an earlier version, before connections existed, are moved into a connection called **Saved requests** the first time the new version starts.

## From the command palette

Every saved request of every connection appears in the [command palette](command-palette.md) as *connection: request*, so you can jump to one without opening its connection first. The palette also has *New API request*, *New API connection…* and, while an API tab is focused, *Send the request*, *Save the request*, *Environments…*, *Import requests…*, *Export requests…* and *Connection settings…*.

## Not built yet

Roughly in the order they are likely to be wanted.

1. **Multipart and file bodies**, and saving a response to a file.
2. **Cookies** that persist between sends (per environment), and a way to clear them.
3. **History**: the last responses of each request. (Saved requests are already searchable from the palette; this would add what they returned.)
4. **Run a folder**: send every request in a folder in order, stopping at the first failed check.
5. **Folder defaults**: headers and sign-in shared by the requests in one folder, on top of the connection's.
6. **Restore API tabs** with workspaces and at launch (today they aren't saved with either; reopen the connection and your saved requests are all still there).
7. **YAML OpenAPI** import, and *refresh from the source file* for an imported API.
8. **More sign-in types**: OAuth 2.0 authorization-code with PKCE, AWS-style request signing, client certificates.
9. **GraphQL** helpers (a query/variables editor and schema browser), **WebSocket** and **Server-Sent Events** tabs.
10. Rail niceties: drag a request onto a folder, a manual order, folders inside folders.

Not planned: a scripting sandbox, mock servers and a cloud account. Everything stays on this computer.
