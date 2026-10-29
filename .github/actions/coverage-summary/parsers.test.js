"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parse, totals, pct, delta, renderReport } = require("./parsers");

const fixtures = path.join(__dirname, "..", "..", "..", "tests", "fixtures", "coverage");
const read = (f) => fs.readFileSync(path.join(fixtures, f), "utf8");

test("lcov: lines, branches and per-file counts", () => {
  const p = parse("lcov", read("sample.lcov"));
  assert.deepEqual(p.files["src/lib.rs"].lines, { covered: 3, total: 4 });
  assert.deepEqual(p.files["src/lib.rs"].branches, { covered: 1, total: 2 });
  assert.deepEqual(p.files["src/main.rs"].lines, { covered: 0, total: 2 });
  const t = totals(p);
  assert.deepEqual(t.lines, { covered: 3, total: 6 });
  assert.equal(pct(t.lines), 50);
  assert.equal(pct(t.branches), 50);
});

test("lcov: falls back to LF/BRF when DA/BRDA are missing and keeps the max hit count of repeats", () => {
  const p = parse("lcov", "SF:a.rs\nDA:1,0\nDA:1,3\nLF:1\nLH:1\nend_of_record\nSF:b.rs\nLF:5\nLH:2\nend_of_record\n");
  assert.deepEqual(p.files["a.rs"].lines, { covered: 1, total: 1 });
  assert.deepEqual(p.files["b.rs"].lines, { covered: 0, total: 5 });
});

test("lcov: empty input has no files and no percentage", () => {
  const p = parse("lcov", "");
  assert.deepEqual(p.files, {});
  assert.equal(pct(totals(p).lines), null);
});

test("go: statements weigh by block size", () => {
  const p = parse("go", read("cover.out"));
  assert.deepEqual(p.files["example.com/app/a.go"].lines, { covered: 2, total: 3 });
  assert.deepEqual(p.files["example.com/app/b.go"].lines, { covered: 5, total: 5 });
  assert.deepEqual(totals(p).lines, { covered: 7, total: 8 });
  assert.equal(totals(p).branches.total, 0);
});

test("go: a block covered in any merged profile counts as covered; garbage is rejected", () => {
  const p = parse("go", "mode: set\nx/a.go:1.1,2.2 4 0\nx/a.go:1.1,2.2 4 2\n");
  assert.deepEqual(p.files["x/a.go"].lines, { covered: 4, total: 4 });
  assert.throws(() => parse("go", "mode: set\nnot a profile line\n"), /Not a Go cover profile/);
});

test("vitest-json: skips the total entry and strips the workspace root", () => {
  const p = parse("vitest-json", read("coverage-summary.json"), "/work/repo/");
  assert.deepEqual(Object.keys(p.files).sort(), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(totals(p).lines, { covered: 24, total: 30 });
  assert.deepEqual(totals(p).branches, { covered: 5, total: 10 });
});

test("unknown format is rejected", () => {
  assert.throws(() => parse("cobertura", ""), /Unknown format/);
});

test("delta", () => {
  assert.equal(delta(75, 70), "+5.00 pp");
  assert.equal(delta(65.5, 70), "-4.50 pp");
  assert.equal(delta(70, null), "");
  assert.equal(delta(null, 70), "");
});

test("report: baseline delta, lowest files and the collapsed table", () => {
  const files = parse("lcov", read("sample.lcov")).files;
  const current = { totals: totals({ files }), files };
  const baseFiles = { ...files, "src/lib.rs": { lines: { covered: 2, total: 4 }, branches: { covered: 0, total: 2 } } };
  const baseline = { totals: totals({ files: baseFiles }), files: baseFiles, commit: "0123456789abcdef" };
  const md = renderReport({ name: "api", format: "lcov", current, baseline });
  assert.match(md, /### Coverage: api/);
  assert.match(md, /\| Lines \| 50\.00% \(3\/6\) \| 33\.33% \| \+16\.67 pp \|/);
  assert.match(md, /`src\/lib\.rs` \| 75\.00% \| 3\/4 \| \+25\.00 pp/);
  assert.match(md, /<details><summary>All 2 files<\/summary>/);
  assert.match(md, /0123456789/);
  // The lowest-covered file is listed first.
  assert.ok(md.indexOf("src/main.rs") < md.indexOf("src/lib.rs"));
});

test("report: lists at most 10 lowest files and says so when there is no baseline", () => {
  const files = {};
  for (let i = 0; i < 15; i++) files[`f${String(i).padStart(2, "0")}.rs`] = { lines: { covered: i, total: 20 }, branches: { covered: 0, total: 0 } };
  const md = renderReport({ name: "x", format: "lcov", current: { totals: totals({ files }), files }, baseline: null });
  assert.match(md, /No baseline from the default branch yet/);
  assert.match(md, /10 lowest-covered files/);
  const lowest = md.split("<details>")[0];
  assert.equal((lowest.match(/^\| `f/gm) ?? []).length, 10);
  assert.ok(!lowest.includes("f14.rs"));
});

test("report: Go is labelled as statements and has no branch row", () => {
  const files = parse("go", read("cover.out")).files;
  const md = renderReport({ name: "api", format: "go", current: { totals: totals({ files }), files }, baseline: null });
  assert.match(md, /\| Statements \| 87\.50% \(7\/8\)/);
  assert.ok(!md.includes("| Branches"));
});
