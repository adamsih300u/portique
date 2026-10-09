# Collapsible groups and drag-to-regroup in the sidebar

- **Branch:** `feat/profile-group-dnd`
- **PR:** none yet (committed locally; push is queued)
- **Status:** draft
- **Author:** Claude, for Adam

## Summary

Click a group heading in the sidebar to fold or unfold it. Drag a profile onto another group to move it there; dropping on "Ungrouped" clears its group.

## Why

Moving a profile between groups meant opening the editor and retyping the group name, and long lists could not be folded. No record in `docs/adr/` touches the sidebar, so none supports or conflicts with this.

## What changed

- `src/main.ts`: each sidebar section gets a caret heading that toggles it. Folded keys are kept in `localStorage` and sections stay open while searching. Profile rows are draggable; group sections accept the drop and save the profile with its new group.
- `src/styles.css`: caret, pointer cursor on headings, and a highlight on the section under the drag.

## How to review

Read `renderProfiles` and the helpers under it in `src/main.ts`.

## What was tested

`tsc --noEmit` reports only a missing `vitest` module, from the borrowed `node_modules`; nothing in the changed files. ESLint could not run there for the same reason. I did not run the app, so the drag itself is untested by hand (`dragDropEnabled` is already off in `tauri.conf.json`, which the file manager's drags also rely on).

## Not done / follow-ups

- Dropping onto a group that does not exist yet is not possible; make new groups in the profile editor.
- Workspaces are not draggable.
- Folded state is per machine, not stored with the profiles.

## Decisions

### D1. Fold state lives in `localStorage`

- **Status:** accepted
- **Context:** Folding is a view preference, not profile data.
- **Decision:** Keep the folded group keys in `localStorage`.
- **Consequences:** No change to the profile format or the backend. State is not shared between machines.
- **Alternatives considered:** A field on the settings file: needs a Rust change for a cosmetic flag.

### D2. Drop on the whole section, not only the heading

- **Status:** accepted
- **Context:** A heading is a small target, and folded groups show only the heading.
- **Decision:** The entire section is the drop target; the highlight outlines it.
- **Consequences:** Easy to hit. Dropping a row on its own group does nothing.
- **Alternatives considered:** Heading-only targets, or a drop indicator between rows, which would also need manual ordering (rows are sorted by name).
