# Reorder the profile editor

- **Branch:** `refactor/profile-editor-order`
- **PR:** (see the PR for this branch)
- **Status:** draft
- **Author:** Claude

## Summary

The New/Edit profile dialog now reads top to bottom: Name and Protocol, then Connection, Login, Options and Appearance. Group is no longer a field beside Name; it lives in a folded "Sidebar group" section.

## Why

For SSH the old order was scattered: Jump host sat beside Private key, auto-reconnect and the host-key reset were mixed into the authentication fields, and Username/Password came after all of them. Group sat in the header row like a required field and looked bolted on.

## What changed

- Connection: Host, Port, Jump host (SSH only).
- Login: Username, Authentication (SSH only), Password, Private key, Remove saved password.
- Options (folded): Port forwards, File browser (SFTP), Reliability & security (auto-reconnect, host key), Sidebar group (opens itself when a group is set).
- Appearance is unchanged. No profile fields or saved data changed.

## How to review

`src/editors.ts`, from the `netSection` block through the `body` assembly and `sync()`. Visibility now toggles on the field elements instead of `closest("label")`.

## What was tested

Type-checked with `tsc`. Not run in the app, so the layout has not been seen on screen. Telnet, serial and API profiles were not exercised.

## Not done / follow-ups

Group is one click further away when creating a profile; if that proves annoying it can return to the header row.

## Decisions

### D1. Group is a folded optional section, not a header field

- **Status:** accepted
- **Context:** Group is optional and rarely changes, yet it shared the header row with Name and Protocol.
- **Decision:** Fold it under Options, open by default only when a group is already set.
- **Consequences:** The header is quieter; creating a grouped profile takes one extra click.
- **Alternatives considered:** Leave it beside Name (the complaint); put it at the bottom of Connection (mixes organisation with connection details).
