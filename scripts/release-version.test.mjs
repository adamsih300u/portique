import { strictEqual } from "node:assert";
import { test } from "node:test";
import { bumpOf, highest, nextVersion } from "./release-version.mjs";

test("bumpOf reads Conventional Commits", () => {
  strictEqual(bumpOf("feat(vault): lock timer (#9)"), "feat");
  strictEqual(bumpOf("fix: crash"), "patch");
  strictEqual(bumpOf("perf: faster"), "patch");
  strictEqual(bumpOf("feat!: new format"), "breaking");
  strictEqual(bumpOf("fix(api)!: rename"), "breaking");
  strictEqual(bumpOf("refactor: x\n\nBREAKING CHANGE: gone"), "breaking");
  strictEqual(bumpOf("docs: words"), null);
  strictEqual(bumpOf("chore: deps"), null);
  strictEqual(bumpOf("not conventional"), null);
});

test("before 1.0, feat bumps patch and breaking bumps minor", () => {
  strictEqual(nextVersion("0.1.0", ["feat: a", "fix: b"]), "0.1.1");
  strictEqual(nextVersion("0.1.0", ["fix: b"]), "0.1.1");
  strictEqual(nextVersion("0.1.4", ["feat!: a", "feat: b"]), "0.2.0");
});

test("from 1.0, feat bumps minor and breaking bumps major", () => {
  strictEqual(nextVersion("1.2.3", ["feat: a"]), "1.3.0");
  strictEqual(nextVersion("1.2.3", ["fix: a"]), "1.2.4");
  strictEqual(nextVersion("1.2.3", ["fix!: a"]), "2.0.0");
});

test("nothing releasable still names the next patch", () => {
  strictEqual(nextVersion("0.1.0", ["docs: a", "chore: b"]), "0.1.1");
  strictEqual(nextVersion("0.1.0", []), "0.1.1");
});

test("highest compares numerically", () => {
  strictEqual(highest(["0.9.0", "0.10.0", "0.2.5"]), "0.10.0");
});
