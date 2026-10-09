import { deepStrictEqual, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { addedChangeFiles, problems } from "./check-change-file.mjs";

const GOOD = `# T
## Summary
x
## Why
x
## What changed
x
## How to review
x
## What was tested
x
## Not done / follow-ups
x
## Decisions
### D1. Pick a thing
- **Status:** accepted
- **Context:** c
- **Decision:** d
- **Consequences:** e
- **Alternatives considered:** f
`;

test("only added change files count, never the template", () => {
  const diff = "A\tdocs/changes/foo.md\nM\tdocs/changes/old.md\nA\tdocs/changes/TEMPLATE.md\nA\tsrc/a.ts\nA\tdocs/api-client.md";
  deepStrictEqual(addedChangeFiles(diff), ["docs/changes/foo.md"]);
});

test("a complete file has no problems", () => {
  deepStrictEqual(problems(GOOD), []);
});

test("the untouched template is rejected", () => {
  const t = readFileSync(new URL("../docs/changes/TEMPLATE.md", import.meta.url), "utf8");
  ok(problems(t).some((p) => p.includes("placeholders")));
});

test("missing sections and decision fields are named", () => {
  const p = problems(GOOD.replace("## Why\nx\n", "").replace("- **Consequences:** e\n", ""));
  ok(p.includes('missing section "## Why"'));
  ok(p.includes('D1 is missing "Consequences"'));
});

test("a change with no decisions may say so", () => {
  deepStrictEqual(problems(GOOD.replace(/### D1[\s\S]*/, "None.\n")), []);
});
