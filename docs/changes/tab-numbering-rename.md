# Number and rename terminal tabs

Tabs on the same profile are now numbered (`prod 1`, `prod 2`, …), and any terminal tab can be renamed from its right-click menu. Names survive restarts and saved workspaces.

## What changed

- Terminal tabs that share a profile show `name 1`, `name 2`, … in tab order. A lone tab keeps its plain name. Closing a tab renumbers the rest.
- Right-click a tab → **Rename tab…**; **Reset tab name** appears once a tab has a custom name.
- The custom name is stored as `n` on the tab's root layout node, so both the restored window and named workspaces carry it. Older saved data has no `n` and loads unchanged.

## Decisions

### Numbers are derived, names are stored

- Status: accepted
- Context: numbering could be stored per tab, or computed from the open tabs.
- Decision: compute numbers from tab order each time; store only user-chosen names.
- Consequences: no stale numbers in saved data and nothing to migrate. Closing `prod 1` turns `prod 2` into `prod 1`. Rename a tab if you want a label that never shifts.
- Alternatives: persisting the number (labels stay stable, but gaps and collisions after a restore).

### Rename lives in the context menu only

- Status: accepted
- Context: the UI should stay uncluttered.
- Decision: no button or inline edit; one menu entry, plus a reset entry when relevant.
- Consequences: not discoverable without right-clicking, but consistent with the other tab actions.
