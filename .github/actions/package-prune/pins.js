"use strict";
// What production and consumers still use: container image references in infrastructure repositories
// and npm versions resolved by consumer lockfiles or package.json ranges. Every function reads a
// checked-out directory and throws when it cannot be sure, so the caller fails closed.
const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE = 1024 * 1024;
const LOCKFILES = ["bun.lock", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const SKIP_DIRS = new Set([".git", "node_modules"]);
// Test fixtures of a scanned repo are sample manifests, not consumers: a fixture lockfile must not
// protect a version or add warnings (the shared workflows repo carries fixtures that mention packages).
const SKIP_PATHS = new Set(["tests/fixtures"]);

function* walk(dir, rel = "") {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (SKIP_PATHS.has(r)) continue;
    if (entry.isDirectory()) yield* walk(dir, r);
    else if (entry.isFile()) yield r;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `ghcr.io/<org>/<name>` followed by `@sha256:<hex>`, `:<tag>` or nothing (= latest). Placeholders in
// docs (`:sha-<commit>`) never match.
function containerRefRegex(org) {
  return new RegExp(
    `ghcr\\.io/${escapeRe(org)}/([a-z0-9][a-z0-9._/-]*?)(?:@(sha256:[0-9a-f]{64})|:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})(?![\\w.<>{}$-])(?:@(sha256:[0-9a-f]{64}))?|(?![\\w:./<>{}$@-]))`,
    "g",
  );
}

// -> { files, refs: Map<name, { digests: Map<digest, source>, tags: Map<tag, source> }> }
function scanContainerPins(roots, org) {
  const refs = new Map();
  let files = 0;
  const re = containerRefRegex(org);
  for (const { dir, label, prefix = "" } of roots) {
    if (!fs.existsSync(dir)) throw new Error(`pin source ${label}: not checked out`);
    for (const rel of walk(dir, prefix)) {
      const full = path.join(dir, rel);
      if (fs.statSync(full).size > MAX_FILE) continue;
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue;
      files += 1;
      const text = buf.toString("utf8");
      for (const m of text.matchAll(re)) {
        const [, name, digest1, rawTag, digest2] = m;
        const tag = rawTag?.replace(/[.-]+$/, "");
        const entry = refs.get(name) ?? { digests: new Map(), tags: new Map() };
        const source = `${label}:${rel}`;
        const digest = digest1 ?? digest2;
        if (digest) entry.digests.set(digest, [...(entry.digests.get(digest) ?? []), source].slice(0, 3));
        else entry.tags.set(tag ?? "latest", [...(entry.tags.get(tag ?? "latest") ?? []), source].slice(0, 3));
        refs.set(name, entry);
      }
    }
  }
  if (files === 0) throw new Error("container pin sources are empty");
  return { files, refs };
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"];

function findSpecs(node, pkg, out) {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === pkg && typeof v === "string") out.push(v);
      else findSpecs(v, pkg, out);
    }
  }
}

// Exact versions of `pkg` found in a lockfile (any format; text matches over-protect rather than miss).
function lockVersions(file, text, pkg) {
  const name = escapeRe(pkg);
  const base = path.basename(file);
  const found = new Set();
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") {
    const lock = JSON.parse(text);
    for (const [k, v] of Object.entries(lock.packages ?? {})) {
      if (k === `node_modules/${pkg}` || k.endsWith(`/node_modules/${pkg}`)) if (v.version) found.add(v.version);
    }
    const walkDeps = (deps) => {
      for (const [k, v] of Object.entries(deps ?? {})) {
        if (k === pkg && v.version) found.add(v.version);
        walkDeps(v.dependencies);
      }
    };
    walkDeps(lock.dependencies);
    return found;
  }
  if (base === "yarn.lock") {
    const headers = new RegExp(`^"?${name}@`);
    let inBlock = false;
    for (const line of text.split("\n")) {
      if (line && !/^\s/.test(line)) inBlock = headers.test(line) || new RegExp(`[ ,"]${name}@`).test(line);
      else if (inBlock) {
        const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
        if (m) found.add(m[1]);
      }
    }
    return found;
  }
  for (const m of text.matchAll(new RegExp(`${name}@(\\d+\\.\\d+\\.\\d+[0-9A-Za-z.+-]*)`, "g"))) found.add(m[1]);
  return found;
}

// -> { deps: [{ source, range, lock: string|null, locked: [version] }], repos }
// Throws on a manifest or lockfile it cannot read when it mentions the package.
function scanNpmConsumers(repoDirs, pkg) {
  const deps = [];
  for (const { dir, label } of repoDirs) {
    const files = [...walk(dir)];
    const set = new Set(files);
    for (const rel of files.filter((f) => path.basename(f) === "package.json")) {
      const text = fs.readFileSync(path.join(dir, rel), "utf8");
      if (!text.includes(pkg)) continue;
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error(`${label}:${rel}: unparseable (${e.message})`); }
      const specs = [];
      for (const f of DEP_FIELDS) findSpecs(json[f], pkg, specs);
      if (!specs.length) continue;
      // The nearest lockfile in this directory or above (workspaces keep it at the root).
      let lock = null;
      for (let d = path.posix.dirname(rel); ; d = path.posix.dirname(d)) {
        const found = LOCKFILES.map((l) => (d === "." ? l : `${d}/${l}`)).find((l) => set.has(l));
        if (found) { lock = found; break; }
        if (d === ".") break;
      }
      if (!lock && files.some((f) => path.basename(f) === "bun.lockb")) {
        throw new Error(`${label}:${rel}: binary bun.lockb cannot be read; commit bun.lock`);
      }
      let locked = [];
      if (lock) {
        try { locked = [...lockVersions(lock, fs.readFileSync(path.join(dir, lock), "utf8"), pkg)]; }
        catch (e) { throw new Error(`${label}:${lock}: unparseable (${e.message})`); }
      }
      for (const range of specs) deps.push({ source: `${label}:${rel}`, range, lock: lock ? `${label}:${lock}` : null, locked });
    }
  }
  return deps;
}

module.exports = { scanContainerPins, scanNpmConsumers, lockVersions, containerRefRegex };
