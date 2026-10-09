# Third-party notices

Portique itself is licensed under the MIT License (see `LICENSE`). It includes the third-party material below.

- **Libraries.** The full licence text and copyright notices for every Rust crate and npm package compiled into Portique are in `THIRD-PARTY-LICENSES.md`. That file is generated (`npm run licenses`); regenerate it whenever dependencies change.
- **Fonts and other bundled assets** are described in this file.

Binary releases and installers ship `LICENSE`, this file and `THIRD-PARTY-LICENSES.md`.

## Libraries needing a note

Where a library offers a choice of licences, Portique uses it under the permissive option: `unescaper` (MIT OR GPL-3.0-only) is used under MIT.

### Mozilla Public License 2.0 crates

These crates are used unmodified, straight from crates.io, and are linked into the executable. MPL-2.0 is a file-level licence: it covers those crates' own source files and places no terms on the rest of Portique. The licence text is in `THIRD-PARTY-LICENSES.md`, and the complete source of each is available from the links below and from crates.io at the stated version.

| Crate | Version | Source |
| --- | --- | --- |
| `cssparser`, `cssparser-macros` | 0.37.0, 0.7.1 | https://github.com/servo/rust-cssparser |
| `selectors` | 0.38.0 | https://github.com/servo/stylo |
| `dtoa-short` | 0.3.5 | https://github.com/upsuper/dtoa-short |
| `option-ext` | 0.2.0 | https://github.com/soc/option-ext |
| `serialport` | 4.10.1 | https://github.com/serialport/serialport-rs |

## Irix Screen Mono (bundled font)

`src/assets/fonts/irix-screen/` contains "Irix Screen Mono 15" and "Irix Screen Mono 13" (regular and bold),
a pixel-for-pixel vector clone of SGI IRIX's `screen` bitmap font, made with FontStruct by **DeepSpaceWhine**
and released under the **Creative Commons CC0 1.0 Public Domain Dedication**.
Source: https://store.kde.org/p/2360452 - the original license.txt and readme.txt are kept alongside the font files.

## Cormorant Garamond (bundled font)

`src/assets/fonts/cormorant/` contains the Latin subset of "Cormorant Garamond" (500, 500 italic, 600) by the **Cormorant Project Authors**,
used for the wordmark and headings. Licensed under the **SIL Open Font License 1.1**; the license text is kept alongside the font files.
Source: https://github.com/CatharsisFonts/Cormorant
