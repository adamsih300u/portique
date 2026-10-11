// Stamps a version into the three files that carry it, so a CI build reports it (window title
// bar, Windows file properties, `--version`). Used by the dev build only; nothing is committed.
//
//   node scripts/set-version.mjs 0.1.1-dev.17
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function edit(file, change) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after === before && !before.includes(`"${version}"`)) throw new Error(`no version found in ${file}`);
  writeFileSync(path, after);
}

const jsonVersion = (text) => text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
edit("package.json", jsonVersion);
edit("src-tauri/tauri.conf.json", jsonVersion);
// Only the first `version =` line, which is the [package] one.
edit("src-tauri/Cargo.toml", (text) => text.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`));
