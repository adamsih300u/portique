# Architecture decision records

A numbered record for each decision that keeps shaping later work. A decision of local interest stays in its change file under [`docs/changes/`](../changes/). It becomes a record here when someone writing new code needs to know it.

## Using the records

Read this index before designing a change or a new capability, and open every record that touches the area. Sort what you find into three groups:

- **Supports:** records that back your approach. Cite them in the *Why* section of your change file.
- **Constrains:** records that set limits your approach has to respect. Mention them in the same place.
- **Conflicts:** records that your approach contradicts, fully or in part. Show these to the user, say what each one decided and why your approach departs from it, and wait for their ruling before writing code.

When the user rules for the new direction, write a new record. It names the earlier one under *Supersedes* (or under *Related*, with a short reason, when the earlier record stays in force alongside it). Then update the earlier record's *Status* and *Superseded by* fields. Those two fields are the only edits an accepted record receives.

## Writing a record

1. Draft the decision as a `### D<n>.` block in your change file while you work.
2. If it outlives the branch, copy [TEMPLATE.md](TEMPLATE.md) to the next number (`NNNN-short-slug.md`), add a row to the index below, and link it from the change file.
3. Take the next free number. If another PR merges first with the same number, renumber yours.

Style, so a record reads in under a minute:

- Title the record with the decision itself, in the positive: "Requests are sent from Rust".
- Keep it near 150 words. Each field takes one to three sentences.
- Write plain, active sentences in the present tense, one idea each. Name the thing that acts: "`http.rs` expands the placeholders".
- Say what the decision does and what follows from it. Describe the chosen path directly instead of contrasting it with the others; the alternatives field is the place for those.
- List consequences honestly, benefits and costs together.
- In *Alternatives considered*, give each option a clause that explains the choice against it.
- Use concrete names, files and numbers where they exist. Leave out hedges and filler.

## Records

| No. | Decision | Status |
| --- | --- | --- |
| [0001](0001-api-endpoint-is-a-profile.md) | An API endpoint is a profile whose tab holds its requests | accepted |
| [0002](0002-send-requests-from-rust.md) | API requests are sent from Rust | accepted |
| [0003](0003-secrets-never-read-back.md) | Secret values stay in Rust once written | accepted |
| [0004](0004-ssh-socks5-proxy-for-requests.md) | Requests through an SSH host use a local SOCKS5 proxy | accepted |
| [0005](0005-interface-follows-the-look.md) | The interface follows the interface look outside terminals | accepted |
| [0006](0006-dev-merged-with-merge-commit.md) | `dev` merges into `main` with a merge commit | accepted |
| [0007](0007-maintainer-approves-merges.md) | The maintainer approves every merge into `main` and `dev` | accepted |
| [0008](0008-short-readme.md) | The README stays short and links to `docs/` | accepted |
| [0009](0009-italic-is-the-apps-voice.md) | Italic is for the app's voice only | accepted |
| [0010](0010-local-shells-start-by-id.md) | A local terminal starts from a detected shell, by id | accepted |
| [0011](0011-server-commands-run-beside-the-shell.md) | Server commands run on a new channel of the open shell's connection | accepted |

The same decisions are summarised for agents under *Standing decisions* in [AGENTS.md](../../AGENTS.md).
