"use strict";
// Just enough semver to resolve a package.json range against published versions. Anything it does not
// understand throws, so the caller fails closed instead of guessing.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text) {
  const m = VERSION.exec(String(text).trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i]);
    if (an && bn) { if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1; }
    else if (an !== bn) return an ? -1 : 1;
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function compare(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

const wild = (s) => s === undefined || s === "x" || s === "X" || s === "*";

// A partial version such as `1`, `1.2`, `1.x` or `1.2.3-rc.1` -> { n: [1, 2, 3] with undefined holes, pre }.
function parsePartial(text) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!m) throw new Error(`unsupported version range "${text}"`);
  const n = [m[1], m[2], m[3]].map((s) => (wild(s) ? undefined : Number(s)));
  for (let i = 1; i < 3; i++) if (n[i - 1] === undefined) n[i] = undefined;
  return { n, pre: m[4] ? m[4].split(".") : [] };
}

const mk = (nums, pre = []) => ({ nums, pre });
const MIN = (nums) => mk(nums.map((x) => x ?? 0));

// -> list of [op, version] that must all hold.
function desugar(token) {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!m) throw new Error(`unsupported version range "${token}"`);
  const [, op = "", rest] = m;
  const p = parsePartial(rest);
  const [a, b, c] = p.n;
  if (a === undefined) return op === "<" ? [["<", mk([0, 0, 0])]] : [[">=", mk([0, 0, 0])]];
  const upper = (nums) => ["<", mk(nums)];
  const exactish = () => {
    if (c !== undefined) return [["=", mk([a, b, c], p.pre)]];
    if (b !== undefined) return [[">=", MIN([a, b])], upper([a, b + 1, 0])];
    return [[">=", MIN([a])], upper([a + 1, 0, 0])];
  };
  switch (op) {
    case "":
    case "=":
      return exactish();
    case "~":
    case "~>":
      return b === undefined
        ? [[">=", MIN([a])], upper([a + 1, 0, 0])]
        : [[">=", mk([a, b, c ?? 0], p.pre)], upper([a, b + 1, 0])];
    case "^": {
      const low = [">=", mk([a, b ?? 0, c ?? 0], p.pre)];
      if (a > 0 || b === undefined) return [low, upper([a + 1, 0, 0])];
      if (b > 0 || c === undefined) return [low, upper([0, b + 1, 0])];
      return [low, upper([0, 0, c + 1])];
    }
    case ">=": return [[">=", mk([a, b ?? 0, c ?? 0], p.pre)]];
    case "<": return [["<", mk([a, b ?? 0, c ?? 0], p.pre)]];
    case ">":
      if (c !== undefined) return [[">", mk([a, b, c], p.pre)]];
      return [[">=", b === undefined ? mk([a + 1, 0, 0]) : mk([a, b + 1, 0])]];
    case "<=":
      if (c !== undefined) return [["<=", mk([a, b, c], p.pre)]];
      return [["<", b === undefined ? mk([a + 1, 0, 0]) : mk([a, b + 1, 0])]];
    default: throw new Error(`unsupported version range "${token}"`);
  }
}

const holds = (v, [op, w]) => {
  const c = compare(v, w);
  return op === "=" ? c === 0 : op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c < 0;
};

// Does `version` satisfy the npm range `range`? Prereleases only match a range that names a prerelease.
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const text = String(range).trim();
  if (text === "" || text === "*" || text === "latest") return v.pre.length === 0;
  return text.split("||").some((set) => {
    const joined = set.trim().replace(/\s+-\s+/g, " HYPHEN ");
    const tokens = joined.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
    const comparators = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i + 1] === "HYPHEN") {
        comparators.push(...desugar(`>=${tokens[i]}`), ...desugar(`<=${tokens[i + 2]}`));
        i += 2;
      } else comparators.push(...desugar(tokens[i]));
    }
    if (v.pre.length && !/-[0-9A-Za-z]/.test(set)) return false;
    return comparators.every((c) => holds(v, c));
  });
}

module.exports = { parseVersion, compare, satisfies };
