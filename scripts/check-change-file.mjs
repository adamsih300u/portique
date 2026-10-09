// Every pull request adds one change file under docs/changes/ (see AGENTS.md), with its decisions
// written ADR-style. This fails a PR that has none, or whose file is still the template.
//
//   node scripts/check-change-file.mjs <base-ref>     check HEAD against e.g. origin/dev
//
// Skip it for a PR with the `no-change-file` label (CI sets SKIP=1) and for bots that open
// dependency and release PRs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SECTIONS = ["Summary", "Why", "What changed", "How to review", "What was tested", "Not done / follow-ups", "Decisions"];
const DECISION_FIELDS = ["Status", "Context", "Decision", "Consequences", "Alternatives considered"];
const CHANGE_FILE = /^docs\/changes\/(?!TEMPLATE\.md$)[^/]+\.md$/;

/** Added change files from `git diff --name-status` output. */
export function addedChangeFiles(nameStatus) {
  return nameStatus
    .split("\n")
    .map((l) => l.split("\t"))
    .filter(([s, p]) => s?.startsWith("A") && p && CHANGE_FILE.test(p))
    .map(([, p]) => p);
}

/** Problems with one change file's text; an empty list means it is fine. */
export function problems(text) {
  const out = [];
  if (/<Title:|<type>\/<slug>|<The decision, as a short statement>/.test(text)) {
    out.push("still contains template placeholders");
  }
  for (const s of SECTIONS) {
    if (!new RegExp(`^## ${s.replace("/", "\\/")}\\s*$`, "m").test(text)) out.push(`missing section "## ${s}"`);
  }
  const blocks = text.split(/^### D\d+\./m).slice(1);
  if (blocks.length === 0 && !/^## Decisions\s*\n+\s*(None|No decisions)/im.test(text)) {
    out.push('"## Decisions" has no "### D1." block (write "None." if there really are none)');
  }
  blocks.forEach((b, i) => {
    for (const f of DECISION_FIELDS) {
      if (!new RegExp(`^- \\*\\*${f}:\\*\\*\\s*\\S`, "m").test(b)) out.push(`D${i + 1} is missing "${f}"`);
    }
  });
  return out;
}

function main(base) {
  if (process.env.SKIP === "1") return console.log("Skipped: labelled no-change-file or opened by a bot.");
  const diff = execFileSync("git", ["diff", "--name-status", `${base}...HEAD`], { encoding: "utf8" });
  const files = addedChangeFiles(diff);
  if (files.length === 0) {
    console.error("No new file under docs/changes/. Copy docs/changes/TEMPLATE.md to docs/changes/<slug>.md,");
    console.error("or add the `no-change-file` label if this PR truly needs none.");
    process.exit(1);
  }
  let bad = false;
  for (const f of files) {
    const p = problems(readFileSync(f, "utf8"));
    for (const m of p) console.error(`${f}: ${m}`);
    bad ||= p.length > 0;
  }
  if (bad) process.exit(1);
  console.log(`OK: ${files.join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2] ?? "origin/dev");
