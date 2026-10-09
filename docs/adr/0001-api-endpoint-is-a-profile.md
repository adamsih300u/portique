# ADR-0001: An API endpoint is a profile whose tab holds its requests

- **Status:** accepted
- **Date:** 2026-10-09
- **Source:** [`api-roadmap`](../changes/api-roadmap.md), decision D1
- **Supersedes:** none
- **Superseded by:** none
- **Related:** none

- **Context:** The first version kept one global request list in the sidebar. Requests for different services shared it, and environments, sign-in and base addresses had no natural home. Adam's model for this was a connection, like SSH.
- **Decision:** Add `protocol: "api"` to the existing profile. The profile carries the base address, default sign-in and headers, and the SSH host to send from. Requests and environments belong to the connection.
- **Consequences:** The connection is created from **+ New** and is grouped and searched like any profile. Each connection has its own environments, and requests inherit its sign-in and headers. On first start an older global file moves into a "Saved requests" connection.
- **Alternatives considered:** A global list with an optional connection field kept the concerns mixed. A separate "API" sidebar section added a second concept to learn. One tab per request left no home for saved endpoints.
