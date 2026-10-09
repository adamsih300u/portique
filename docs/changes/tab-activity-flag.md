# Flag background tabs when output settles or a transfer finishes

- **Branch:** `feat/tab-activity-flag`
- **PR:** not pushed yet
- **Status:** draft
- **Author:** Claude (agent)

## Summary

When something finishes in a tab you are not looking at, its title turns bold and accent-coloured and pulses a few times. It clears when you open the tab. This works for SSH, telnet and serial terminals, and for SFTP file browsers when a transfer ends. There is no setting for it.

## Why

Start a long command, switch away, and there was no way to tell when it stopped without going back to look.

## What changed

- `terminal-tab.ts`: a new `onSettled` callback. With shell integration, the OSC 133 "command finished" mark fires it exactly. Without it (all of telnet and serial, and SSH hosts without the shell snippet), a 2 s quiet spell after at least 3 s of activity fires it.
- `panes.ts`, `file-tab.ts`: set an `unread` class on the tab header unless the tab is in front of a focused window; showing the tab clears it. The file browser sets it when a transfer finishes or fails (not when cancelled).
- `main.ts`: regaining window focus clears the active tab's flag.
- `styles.css`: the `.tab.unread` look.

## How to review

Start at `noteOutput` in `terminal-tab.ts`; the timing rules live there.

## What was tested

`tsc --noEmit` passes. Not run in the app: I did not exercise it against a live host, a serial port, or a real transfer.

## Not done / follow-ups

- No OS notification or taskbar flash (a possible follow-up).
- The silence fallback is a heuristic: a command that is silent for more than 2 s mid-run can flag early.

## Decisions

### D1. Always on, no setting

- **Status:** accepted
- **Context:** The maintainer wanted this as plain behaviour, not an option.
- **Decision:** No toggle; the flag only appears on tabs you are not looking at.
- **Consequences:** Nothing to configure or document; the look must stay quiet.
- **Alternatives considered:** A per-tab "notify me" menu item, and a global setting.

### D2. Shell-integration marks first, silence as the fallback

- **Status:** accepted
- **Context:** Telnet and serial have no shell integration, and not every SSH host will.
- **Decision:** Use the OSC 133 end-of-command mark when the session has produced marks; otherwise treat 2 s of silence after 3 s or more of activity as "finished". Echo of typing is ignored.
- **Consequences:** Exact where marks exist, approximate elsewhere.
- **Alternatives considered:** Silence only (simpler, but false alarms on every host).
