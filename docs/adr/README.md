# Architecture decision records

A short, numbered record for each decision that keeps constraining later work. A decision made in passing stays in its change file under [`docs/changes/`](../changes/); it becomes a record here when someone writing new code would need to know it.

## How it works

1. While you work, write the decision as a `### D<n>.` block in your change file, as usual.
2. If it will outlive the branch, copy [TEMPLATE.md](TEMPLATE.md) to the next number (`NNNN-short-slug.md`), fill it in, add a row below, and link it from the change file.
3. Records are never deleted or rewritten. To reverse one, write a new record, set the old one's status to `superseded` and its *Superseded by* to the new number.
4. Numbers are taken in merge order. If two open PRs collide, the later one renumbers.

## Records

| No. | Decision | Status |
| --- | --- | --- |
| [0001](0001-api-endpoint-is-a-profile.md) | An API endpoint is a profile, and its tab holds its requests | accepted |
| [0002](0002-send-requests-from-rust.md) | API requests are sent from Rust, not the web view | accepted |
| [0003](0003-secrets-never-read-back.md) | Secret values are filled in by Rust and never read back | accepted |
| [0004](0004-ssh-socks5-proxy-for-requests.md) | Sending through an SSH host uses a local SOCKS5 proxy | accepted |
| [0005](0005-interface-follows-the-look.md) | Outside terminals the interface follows the interface look | accepted |
| [0006](0006-dev-merged-with-merge-commit.md) | `dev` is merged into `main` with a merge commit | accepted |
| [0007](0007-maintainer-approves-merges.md) | Nothing merges into `main` or `dev` without the maintainer's approval | accepted |
| [0008](0008-short-readme.md) | The README is short; detail goes in `docs/` | accepted |

The same decisions are summarised for agents under *Standing decisions* in [AGENTS.md](../../AGENTS.md).
