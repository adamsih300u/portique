# ADR-0001: An API endpoint is a profile, and its tab holds its requests

- **Status:** accepted
- **Recorded:** 2026-10-09, from [`api-roadmap`](../changes/api-roadmap.md) (D1)
- **Superseded by:** none

- **Context:** The first version had one global list of requests in the sidebar. Requests for different services were mixed, and environments, sign-in and base addresses had no natural home. Adam's own model was "a connection, like SSH".
- **Decision:** `protocol: "api"` on the existing profile. The profile carries the base address, default sign-in and headers, and the SSH host to send from. Requests and environments belong to the connection.
- **Consequences:** Discoverable (it is in **+ New**), grouped and searchable like any profile, and each connection can have its own environments. Requests inherit sign-in and headers, which gives "folder defaults" at connection level for free. An earlier global file is moved into a "Saved requests" connection on first start.
- **Alternatives considered:** keep the global list with an optional "connection" field (still mixes concerns); a separate "API" sidebar section (a second kind of thing to learn); one tab per request (no place for saved endpoints).
