// Coverage parsers and the markdown renderer for the coverage-summary action.
// Every parser returns { files: { [path]: { lines: {covered, total}, branches: {covered, total} } } }.
// Go has no branch coverage: its statements are reported as lines.
"use strict";

const empty = () => ({ covered: 0, total: 0 });
const add = (a, b) => ({ covered: a.covered + b.covered, total: a.total + b.total });

function parseLcov(text) {
  const files = {};
  let cur = null;
  let da = null;
  let brda = null;
  let lf = null;
  let brf = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = line.slice(3);
      da = new Map();
      brda = new Map();
      lf = null;
      brf = null;
    } else if (!cur) {
      continue;
    } else if (line.startsWith("DA:")) {
      const [n, hits] = line.slice(3).split(",");
      da.set(n, Math.max(da.get(n) ?? 0, Number(hits) || 0));
    } else if (line.startsWith("BRDA:")) {
      const [n, block, branch, taken] = line.slice(5).split(",");
      const key = `${n}:${block}:${branch}`;
      brda.set(key, Math.max(brda.get(key) ?? 0, taken === "-" ? 0 : Number(taken) || 0));
    } else if (line.startsWith("LF:")) {
      lf = Number(line.slice(3));
    } else if (line.startsWith("BRF:")) {
      brf = Number(line.slice(4));
    } else if (line === "end_of_record") {
      // The DA/BRDA records are the ground truth; LF/BRF only fill in when they are absent.
      const lines = da.size ? { covered: [...da.values()].filter((h) => h > 0).length, total: da.size } : { covered: 0, total: lf ?? 0 };
      const branches = brda.size ? { covered: [...brda.values()].filter((h) => h > 0).length, total: brda.size } : { covered: 0, total: brf ?? 0 };
      const prev = files[cur];
      files[cur] = prev ? { lines: add(prev.lines, lines), branches: add(prev.branches, branches) } : { lines, branches };
      cur = null;
    }
  }
  return { files };
}

// A `go test -coverprofile` file: `name.go:10.2,12.3 numStmts count`.
function parseGoProfile(text) {
  const blocks = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("mode:")) continue;
    const m = /^(.+):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
    if (!m) throw new Error(`Not a Go cover profile line: ${line.slice(0, 80)}`);
    const key = `${m[1]}:${m[2]}`;
    const prev = blocks.get(key) ?? { file: m[1], stmts: Number(m[3]), hit: false };
    prev.hit ||= Number(m[4]) > 0;
    blocks.set(key, prev);
  }
  const files = {};
  for (const b of blocks.values()) {
    const f = (files[b.file] ??= { lines: empty(), branches: empty() });
    f.lines.total += b.stmts;
    if (b.hit) f.lines.covered += b.stmts;
  }
  return { files };
}

// vitest's `json-summary` coverage reporter (coverage-summary.json).
function parseVitestJson(text, root = "") {
  const data = JSON.parse(text);
  const files = {};
  for (const [path, v] of Object.entries(data)) {
    if (path === "total") continue;
    const rel = root && path.startsWith(root) ? path.slice(root.length) : path;
    files[rel] = {
      lines: { covered: v.lines?.covered ?? 0, total: v.lines?.total ?? 0 },
      branches: { covered: v.branches?.covered ?? 0, total: v.branches?.total ?? 0 },
    };
  }
  return { files };
}

function parse(format, text, root = "") {
  if (format === "lcov") return parseLcov(text);
  if (format === "go") return parseGoProfile(text);
  if (format === "vitest-json") return parseVitestJson(text, root);
  throw new Error(`Unknown format "${format}" (lcov, go, vitest-json)`);
}

function totals(parsed) {
  let lines = empty();
  let branches = empty();
  for (const f of Object.values(parsed.files)) {
    lines = add(lines, f.lines);
    branches = add(branches, f.branches);
  }
  return { lines, branches };
}

const pct = (c) => (c && c.total > 0 ? (c.covered / c.total) * 100 : null);
const fmt = (p) => (p === null || p === undefined ? "n/a" : `${p.toFixed(2)}%`);
const delta = (now, base) => {
  if (now === null || base === null || base === undefined) return "";
  const d = now - base;
  return `${d > 0 ? "+" : ""}${d.toFixed(2)} pp`;
};

// current/baseline: { totals, files }. baseline may be null.
function renderReport({ name, format, current, baseline, baselineNote, limit = 10 }) {
  const branchLabel = format === "go" ? "n/a (Go reports statements)" : "Branches";
  const lineLabel = format === "go" ? "Statements" : "Lines";
  const cl = pct(current.totals.lines);
  const cb = pct(current.totals.branches);
  const bl = baseline ? pct(baseline.totals.lines) : null;
  const bb = baseline ? pct(baseline.totals.branches) : null;
  let md = `### Coverage: ${name}\n\n`;
  md += baseline ? `Compared with the latest run on the default branch${baseline.commit ? ` (\`${String(baseline.commit).slice(0, 10)}\`)` : ""}.\n\n` : `${baselineNote || "No baseline from the default branch yet; no delta."}\n\n`;
  md += "| Metric | Now | Baseline | Delta |\n| --- | ---: | ---: | ---: |\n";
  md += `| ${lineLabel} | ${fmt(cl)} (${current.totals.lines.covered}/${current.totals.lines.total}) | ${baseline ? fmt(bl) : "n/a"} | ${delta(cl, bl)} |\n`;
  if (format !== "go") md += `| ${branchLabel} | ${fmt(cb)} (${current.totals.branches.covered}/${current.totals.branches.total}) | ${baseline ? fmt(bb) : "n/a"} | ${delta(cb, bb)} |\n`;
  md += "\nReport only: coverage never fails the check.\n\n";

  const rows = Object.entries(current.files)
    .map(([path, f]) => ({ path, f, p: pct(f.lines), base: baseline?.files?.[path] ? pct(baseline.files[path].lines) : null }))
    .filter((r) => r.f.lines.total > 0);
  const fileTable = (list) => {
    let t = `| File | ${lineLabel} | Covered | Delta |\n| --- | ---: | ---: | ---: |\n`;
    for (const r of list) t += `| \`${r.path}\` | ${fmt(r.p)} | ${r.f.lines.covered}/${r.f.lines.total} | ${delta(r.p, r.base)} |\n`;
    return t;
  };
  const lowest = [...rows].sort((a, b) => a.p - b.p || b.f.lines.total - a.f.lines.total).slice(0, limit);
  md += `#### ${lowest.length} lowest-covered files\n\n${lowest.length ? fileTable(lowest) : "No files with coverable lines.\n"}\n`;
  const all = [...rows].sort((a, b) => a.path.localeCompare(b.path));
  md += `<details><summary>All ${all.length} files</summary>\n\n${fileTable(all)}\n</details>\n`;
  return md;
}

module.exports = { parseLcov, parseGoProfile, parseVitestJson, parse, totals, pct, fmt, delta, renderReport };
