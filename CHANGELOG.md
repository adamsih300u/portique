# Changelog

## [0.5.0](https://github.com/adamsih300u/portique/compare/v0.1.0...v0.5.0) (2026-10-11)


### Features

* **agent:** an MCP server that lets AI agents run terminals ([#47](https://github.com/adamsih300u/portique/issues/47)) ([64ef6f6](https://github.com/adamsih300u/portique/commit/64ef6f6d9ad86a796541ff371f17b228e752e3ba))
* **api:** make an API a connection type with its own saved requests ([e45f570](https://github.com/adamsih300u/portique/commit/e45f5700dac4ce6beda8ac06e40a59f58d1f1b0a))
* **api:** send from an SSH host, OAuth 2.0, response checks, import and export ([0ea974a](https://github.com/adamsih300u/portique/commit/0ea974aa64273c75756a4564d9f783aae7d0a35a))
* flag background tabs when output settles or a transfer finishes ([#22](https://github.com/adamsih300u/portique/issues/22)) ([56feac6](https://github.com/adamsih300u/portique/commit/56feac653156bc7207d3f3c9e0d87f83aebb192d))
* **keys:** generate an Ed25519 key in the vault and hand out its public half ([#49](https://github.com/adamsih300u/portique/issues/49)) ([d925ae2](https://github.com/adamsih300u/portique/commit/d925ae2b2eb3d80dd8a3859cd8f658a2bd26555d))
* **local:** open shells on this computer as terminal tabs ([#34](https://github.com/adamsih300u/portique/issues/34)) ([a208a43](https://github.com/adamsih300u/portique/commit/a208a43c1a0f56d7e3892e0b810d417a7536709c))
* number, rename and reorder tabs ([#26](https://github.com/adamsih300u/portique/issues/26)) ([59df910](https://github.com/adamsih300u/portique/commit/59df910c59c2e05292ff213fba0c8769ccdabccf))
* **palette:** add a Toolbox of network checks, generators and converters ([#39](https://github.com/adamsih300u/portique/issues/39)) ([f0c0f11](https://github.com/adamsih300u/portique/commit/f0c0f1127759b199fdcaa69664e9848b668b5861))
* **palette:** connect to a host that isn't saved ([#32](https://github.com/adamsih300u/portique/issues/32)) ([57be22e](https://github.com/adamsih300u/portique/commit/57be22e2799f30be5f61247269eb1e976beee6eb))
* **profiles:** duplicate a profile and create several in a row ([#31](https://github.com/adamsih300u/portique/issues/31)) ([3e41548](https://github.com/adamsih300u/portique/commit/3e415489a47880308b7c10d22e1ea959f2a9e284))
* **profiles:** keep commands with a profile and run them from the palette ([#33](https://github.com/adamsih300u/portique/issues/33)) ([1c60cf8](https://github.com/adamsih300u/portique/commit/1c60cf82e453fec9b01bc91b3cd0d43e40d37113))
* **sidebar:** collapsible groups and drag a profile to regroup it ([#30](https://github.com/adamsih300u/portique/issues/30)) ([a7a0c45](https://github.com/adamsih300u/portique/commit/a7a0c45f4e0e3d503fe7ce0f33783a22fd97efa2))
* **ssh:** say why a connection failed and explain the first-connect key prompt ([#53](https://github.com/adamsih300u/portique/issues/53)) ([1406464](https://github.com/adamsih300u/portique/commit/1406464d1a825eb09ef58690535833b9f1deea82))
* **ssh:** server tools for services, containers and logs ([#41](https://github.com/adamsih300u/portique/issues/41)) ([28ccd5d](https://github.com/adamsih300u/portique/commit/28ccd5d2f3b78a21c8f6299030424e3676ce545b))
* **ssh:** set up key sign-in to a server in one step ([#51](https://github.com/adamsih300u/portique/issues/51)) ([000bbe2](https://github.com/adamsih300u/portique/commit/000bbe231b5411faf5ed4fa0f65eb12d8a716e2c))
* **terminal:** let a profile override the theme's font family ([#46](https://github.com/adamsih300u/portique/issues/46)) ([89ded75](https://github.com/adamsih300u/portique/commit/89ded7556bb0b90ed37cc7af085dd8603390e499))
* **ui:** hide and resize the sidebar ([#29](https://github.com/adamsih300u/portique/issues/29)) ([a50005e](https://github.com/adamsih300u/portique/commit/a50005e1f615abf55975448ce734cb10bae57872))
* **ui:** show a connection's kind with an icon ([#25](https://github.com/adamsih300u/portique/issues/25)) ([14015e9](https://github.com/adamsih300u/portique/commit/14015e9f7c2d9a29f55abacfdabb7fd5cae2344f))
* **vault:** choose when the vault locks itself ([#9](https://github.com/adamsih300u/portique/issues/9)) ([b5507ae](https://github.com/adamsih300u/portique/commit/b5507ae9097e33516890571abce1d883981d74bb))
* **vault:** create the vault when the first secret is saved ([#54](https://github.com/adamsih300u/portique/issues/54)) ([161c228](https://github.com/adamsih300u/portique/commit/161c228f269b253812fea48d044abd2fb1206ed8))
* **vault:** refuse weak passwords and old copies, and keep secrets out of memory dumps ([#45](https://github.com/adamsih300u/portique/issues/45)) ([9309d60](https://github.com/adamsih300u/portique/commit/9309d60428a36bd894591de8cb043553b1cd5888))


### Bug Fixes

* drop a dragged tab in the empty tab-bar space to move it last ([#37](https://github.com/adamsih300u/portique/issues/37)) ([456d328](https://github.com/adamsih300u/portique/commit/456d328fe2d57757336ec6826c35aa601ab20739))
* focus the terminal once a connection is up ([#24](https://github.com/adamsih300u/portique/issues/24)) ([8b18ef3](https://github.com/adamsih300u/portique/commit/8b18ef395b68cd832ba89e3a4dc83d3658a53789))
* **ui:** add letter spacing to the SGI IRIX theme ([#27](https://github.com/adamsih300u/portique/issues/27)) ([c5cb040](https://github.com/adamsih300u/portique/commit/c5cb040e133f56c4adfee729cfd59bf229f834a0))
* **ui:** empty pane follows the sidebar colour when Content is unset ([#15](https://github.com/adamsih300u/portique/issues/15)) ([824ca0f](https://github.com/adamsih300u/portique/commit/824ca0fe93dc05b9e8fb620037a9a3dea191a9e5))
* **ui:** make dialogs, menus and status colours follow the interface look ([13e74fe](https://github.com/adamsih300u/portique/commit/13e74fe891b7b79ac674da5aa830ed125ed22128))
* **ui:** make the F1 shortcuts panel follow the interface theme ([#44](https://github.com/adamsih300u/portique/issues/44)) ([215c452](https://github.com/adamsih300u/portique/commit/215c452dbcc0aa4cc9d5755eec3b5f440c009aa1))
* **ui:** make the welcome pane and sidebar emblem follow the interface theme ([004b463](https://github.com/adamsih300u/portique/commit/004b4637f3dcf1c3c62dd30849750b0a110936a0))
* **window:** keep bottom rows clear of the taskbar when maximised ([#28](https://github.com/adamsih300u/portique/issues/28)) ([974a268](https://github.com/adamsih300u/portique/commit/974a2688578bda5b4d9b86d389b6d96dd40c2184))
* **window:** run the terminal to the bottom edge when maximised ([#36](https://github.com/adamsih300u/portique/issues/36)) ([14d29b4](https://github.com/adamsih300u/portique/commit/14d29b43644a597d6d212303fa376a6eac3b215c))


### Miscellaneous Chores

* release 0.5.0 ([#48](https://github.com/adamsih300u/portique/issues/48)) ([8c289ed](https://github.com/adamsih300u/portique/commit/8c289ed433d5a10729b490f09e5c6a4317ca93f1))
