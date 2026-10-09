// Predicts the version release-please will pick for the next release, so a build of `dev` can be
// called `X.Y.Z-dev.N` and the release cut from that same code comes out as plain `X.Y.Z`.
//
//   node scripts/release-version.mjs            print the next release version (e.g. 0.1.1)
//
// It mirrors release-please's rules for release-please-config.json (bump-minor-pre-major and
// bump-patch-for-minor-pre-major): a breaking change bumps minor before 1.0 (major after), a `feat`
// bumps patch before 1.0 (minor after), anything else releasable (`fix`, `perf`, `deps`, `revert`)
// bumps patch. The base is the highest stable `v*` tag anywhere in the repository; commits are those
// reachable from HEAD but not from that tag, which works because `dev` is merged into `main` with a
// merge commit (never squashed), so every released dev commit is an ancestor of the tag.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASABLE = new Set(["feat", "fix", "perf", "deps", "revert"]);
const HEADER = /^(\w+)(?:\([^)]*\))?(!)?:\s/;

/** Highest of a list of "X.Y.Z" strings. */
export function highest(versions) {
  const key = (v) => v.split(".").map(Number);
  return versions.reduce((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b;
    return a;
  });
}

/** What a commit message asks for: "major" | "minor" | "patch" | null (not releasable). */
export function bumpOf(message) {
  const m = HEADER.exec(message.split("\n")[0]);
  if (!m) return null;
  if (m[2] || /^BREAKING[ -]CHANGE:/m.test(message)) return "breaking";
  if (m[1] === "feat") return "feat";
  return RELEASABLE.has(m[1]) ? "patch" : null;
}

/** The next release version given the last one and the commit messages since. */
export function nextVersion(base, messages) {
  const [maj, min, pat] = base.split(".").map(Number);
  const kinds = new Set(messages.map(bumpOf));
  const pre1 = maj === 0;
  if (kinds.has("breaking")) return pre1 ? `${maj}.${min + 1}.0` : `${maj + 1}.0.0`;
  if (kinds.has("feat")) return pre1 ? `${maj}.${min}.${pat + 1}` : `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`; // a fix, or nothing releasable yet: still the next patch
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tags = git("tag", "--list", "v[0-9]*")
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1));
  // Before the first release there is no tag: the manifest version is the base and every commit counts.
  const base = tags.length ? highest(tags) : JSON.parse(readFileSync(join(root, ".release-please-manifest.json"), "utf8"))["."];
  const range = tags.length ? [`v${base}..HEAD`] : ["HEAD"];
  const log = git("log", "--format=%B%x1e", ...range);
  const messages = log.split("\x1e").map((s) => s.trim()).filter(Boolean);
  console.log(nextVersion(base, messages));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
