"use strict";
// Pure planning for the package prune: which versions of a package stay and which go. Nothing here
// writes anything; `reg` (a registry reader) and the version lists are injected so it can be tested.
const { compare, parseVersion, satisfies } = require("./semver");

const SIG_TAG = /^sha256-[0-9a-f]{64}(\.(sig|att|sbom))?$/;
const HOUR = 60 * 60 * 1000;
const MAX_GRAPH = 200;

const tagsOf = (v) => v.metadata?.container?.tags ?? [];
const buildTags = (v) => tagsOf(v).filter((t) => !SIG_TAG.test(t));
const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
const shortLabel = (v) => buildTags(v).find((t) => /^sha-[0-9a-f]{7}$/.test(t)) ?? buildTags(v)[0] ?? v.name.slice(0, 19);
const hex = (digest) => digest.replace("sha256:", "");

// Every manifest digest of one build: the index (or image), its children (platform images and the
// buildx attestation manifest), and its referrers (cosign bundle) found through the fallback tag
// `sha256-<digest>` and the legacy `.sig/.att/.sbom` tags. `reg.manifest(ref)` ->
// { status, digest, json } with status 404 for "absent".
async function buildGraph(reg, rootDigest) {
  const seen = new Map(); // digest -> why
  const queue = [{ digest: rootDigest, why: "root" }];
  while (queue.length) {
    const { digest, why } = queue.shift();
    if (seen.has(digest)) continue;
    if (seen.size >= MAX_GRAPH) throw new Error(`build graph of ${rootDigest} exceeds ${MAX_GRAPH} manifests`);
    const res = await reg.manifest(digest);
    if (res.status === 404) {
      if (why === "root") throw Object.assign(new Error(`manifest ${digest} is missing from the registry`), { missing: true });
      throw new Error(`manifest ${digest} (${why}) is missing from the registry`);
    }
    seen.set(digest, why);
    for (const child of res.json?.manifests ?? []) queue.push({ digest: child.digest, why: `child of ${digest.slice(0, 19)}` });
    for (const suffix of ["", ".sig", ".att", ".sbom"]) {
      const ref = await reg.manifest(`sha256-${hex(digest)}${suffix}`);
      if (ref.status === 404) continue;
      queue.push({ digest: ref.digest, why: `referrers of ${digest.slice(0, 19)}` });
    }
  }
  return seen;
}

// pins: { digests: Map<digest, source[]>, tags: Map<tag, source[]> } for this package.
async function planContainer({ name, versions, pins, reg, now, keepLatest = 1, minAgeHours = 2, maxDeletions = 20, requirePins = true }) {
  const errors = [];
  const warnings = [];
  const minAge = minAgeHours * HOUR;
  const byDigest = new Map(versions.map((v) => [v.name, v]));
  const tagged = versions.filter((v) => buildTags(v).length).sort(byNewest);
  const result = { type: "container", name, versions: versions.length, keep: [], delete: [], deferred: [], errors, warnings, builds: [] };
  if (!tagged.length) { errors.push("no tagged build: refusing to prune an image without one"); return result; }
  if (requirePins && !pins.digests.size && !pins.tags.size) errors.push("no production pin found for this image in the pin sources (set require-pins: false if it is not deployed yet)");

  // Roots to keep, each with the reasons.
  const roots = new Map(); // digest -> reasons[]
  const addRoot = (digest, reason) => roots.set(digest, [...(roots.get(digest) ?? []), reason]);
  tagged.slice(0, keepLatest).forEach((v) => addRoot(v.name, `newest build (${shortLabel(v)})`));
  tagged.filter((v) => tagsOf(v).includes("latest")).forEach((v) => addRoot(v.name, `carries latest (${shortLabel(v)})`));
  tagged.filter((v) => now - new Date(v.created_at) < minAge).forEach((v) => addRoot(v.name, `younger than ${minAgeHours} h (publish may be in flight)`));
  for (const [digest, sources] of pins.digests) {
    if (!byDigest.has(digest)) { errors.push(`pinned digest ${digest} (${sources.join(", ")}) is not a version of this package: missing (MANIFEST_UNKNOWN; re-pin to a build that exists)`); continue; }
    addRoot(digest, `pinned by ${sources.join(", ")}`);
  }
  for (const [tag, sources] of pins.tags) {
    const v = versions.find((x) => tagsOf(x).includes(tag));
    if (!v) errors.push(`pinned tag ${tag} (${sources.join(", ")}) does not exist`);
    else addRoot(v.name, `tag ${tag} referenced by ${sources.join(", ")}`);
  }

  // Graphs of everything kept. A missing or unreadable kept manifest aborts: a pin must resolve.
  const keepWhy = new Map(); // digest -> reason
  for (const [digest, reasons] of roots) {
    let graph;
    try { graph = await buildGraph(reg, digest); } catch (e) {
      errors.push(`${e.missing ? "pinned/kept manifest missing from the registry" : "cannot read the registry"}: ${e.message}`);
      continue;
    }
    const label = byDigest.get(digest) ? shortLabel(byDigest.get(digest)) : digest.slice(0, 19);
    for (const [d, why] of graph) if (!keepWhy.has(d) || d === digest) keepWhy.set(d, d === digest ? reasons.join("; ") : `${why} of kept build ${label}`);
  }
  if (errors.length) return result;

  for (const d of keepWhy.keys()) if (!byDigest.has(d)) warnings.push(`kept manifest ${d} has no package version (registry-only)`);
  const doomed = versions.filter((v) => !keepWhy.has(v.name));
  for (const v of versions) if (keepWhy.has(v.name)) result.keep.push({ id: v.id, digest: v.name, tags: tagsOf(v), reason: keepWhy.get(v.name), created_at: v.created_at });

  // Group the doomed versions into whole builds (best effort), the rest are orphans.
  const claimed = new Set();
  const builds = [];
  for (const root of doomed.filter((v) => buildTags(v).length).sort(byNewest)) {
    if (claimed.has(root.name)) continue;
    let members = [root.name];
    try { members = [...(await buildGraph(reg, root.name)).keys()]; } catch { warnings.push(`could not read the graph of superseded build ${shortLabel(root)}; its parts are handled as orphans`); }
    const vs = members.filter((d) => byDigest.has(d) && !keepWhy.has(d) && !claimed.has(d)).map((d) => byDigest.get(d));
    vs.forEach((v) => claimed.add(v.name));
    builds.push({ label: shortLabel(root), root, versions: [root, ...vs.filter((v) => v !== root)] });
  }
  const orphans = doomed.filter((v) => !claimed.has(v.name));
  const young = (v) => now - new Date(v.created_at) < minAge;
  const eligible = [];
  for (const b of builds.sort((x, y) => new Date(x.root.created_at) - new Date(y.root.created_at))) {
    if (b.versions.some(young)) { b.versions.forEach((v) => result.deferred.push(entry(v, `part of build ${b.label}: a member is younger than ${minAgeHours} h`))); continue; }
    eligible.push({ label: b.label, versions: b.versions, reason: () => `part of superseded build ${b.label} (${b.root.created_at.slice(0, 10)}); not reachable from any kept build` });
  }
  for (const v of orphans) {
    if (young(v)) result.deferred.push(entry(v, `orphan younger than ${minAgeHours} h`));
    else eligible.push({ label: `orphan ${v.name.slice(0, 19)}`, versions: [v], reason: () => "orphan: not reachable from any kept build" });
  }
  let count = 0;
  for (const unit of eligible) {
    if (count + unit.versions.length > maxDeletions) { unit.versions.forEach((v) => result.deferred.push(entry(v, `over the cap of ${maxDeletions} deletions per run; the next run continues`))); continue; }
    count += unit.versions.length;
    result.builds.push({ label: unit.label, ids: unit.versions.map((v) => v.id) });
    unit.versions.forEach((v) => result.delete.push(entry(v, unit.reason(v))));
  }
  if (!result.keep.length) { errors.push("plan keeps nothing; refusing"); result.delete = []; }
  return result;
}

const entry = (v, reason) => ({ id: v.id, digest: v.name, tags: tagsOf(v), reason, created_at: v.created_at });

// npm: versions are `name` (the version string). consumers: scanNpmConsumers() output.
function planNpm({ name, pkg, versions, consumers, now, keepLatest = 1, minAgeHours = 2, maxDeletions = 20, requirePins = false }) {
  const errors = [];
  const warnings = [];
  const result = { type: "npm", name, versions: versions.length, keep: [], delete: [], deferred: [], errors, warnings, builds: [] };
  const valid = versions.filter((v) => parseVersion(v.name));
  if (valid.length !== versions.length) warnings.push("versions that are not semver are kept untouched");
  if (!valid.length) { errors.push("no semver versions: refusing"); return result; }
  const sorted = [...valid].sort((a, b) => compare(b.name, a.name));
  const stable = sorted.filter((v) => !parseVersion(v.name).pre.length);
  const keepWhy = new Map();
  const addKeep = (v, why) => keepWhy.set(v.name, [...(keepWhy.get(v.name) ?? []), why]);
  (stable.length ? stable : sorted).slice(0, keepLatest).forEach((v) => addKeep(v, "newest version"));
  valid.filter((v) => now - new Date(v.created_at) < minAgeHours * HOUR).forEach((v) => addKeep(v, `younger than ${minAgeHours} h`));
  if (requirePins && !consumers.length) errors.push(`no consumer of ${pkg} found`);
  for (const c of consumers) {
    for (const lv of c.locked) {
      const v = valid.find((x) => x.name === lv);
      if (v) addKeep(v, `locked by ${c.lock}`);
      else warnings.push(`${c.lock} locks ${pkg}@${lv}, which is not published (already gone)`);
    }
    let matches;
    try { matches = valid.filter((x) => satisfies(x.name, c.range)); } catch (e) { errors.push(`${c.source}: ${e.message}`); continue; }
    if (!matches.length) { warnings.push(`${c.source}: range ${c.range} matches no published version`); continue; }
    if (!c.locked.length || !c.locked.some((l) => satisfies(l, c.range))) {
      const top = matches.sort((a, b) => compare(b.name, a.name))[0];
      addKeep(top, `highest match of range ${c.range} in ${c.source}${c.lock ? " (lockfile does not cover it)" : " (no lockfile)"}`);
    }
  }
  if (errors.length) return result;
  for (const v of versions) {
    if (keepWhy.has(v.name) || !parseVersion(v.name)) result.keep.push({ id: v.id, digest: v.name, tags: [v.name], reason: (keepWhy.get(v.name) ?? ["not semver"]).join("; "), created_at: v.created_at });
  }
  const doomed = sorted.filter((v) => !keepWhy.has(v.name)).reverse();
  for (const v of doomed) {
    if (now - new Date(v.created_at) < minAgeHours * HOUR) { result.deferred.push(entry2(v, "too young")); continue; }
    if (result.delete.length >= maxDeletions) { result.deferred.push(entry2(v, `over the cap of ${maxDeletions} deletions per run`)); continue; }
    result.delete.push(entry2(v, `superseded: not the newest and not used by any consumer lockfile or range`));
    result.builds.push({ label: v.name, ids: [v.id] });
  }
  return result;
}
const entry2 = (v, reason) => ({ id: v.id, digest: v.name, tags: [v.name], reason, created_at: v.created_at });

function renderSummary(results, { org, dryRun }) {
  const out = [];
  out.push(`## Package prune${dryRun ? " (dry run: nothing is deleted)" : ""}`, "");
  for (const r of results) {
    out.push(`### ${r.type} \`${r.name}\``, "");
    out.push(`${r.versions} versions: keep ${r.keep.length}, delete ${r.delete.length}, deferred ${r.deferred.length}.`, "");
    for (const e of r.errors) out.push(`- ERROR: ${e}`);
    for (const w of r.warnings) out.push(`- warning: ${w}`);
    if (r.errors.length) { out.push("", "Aborted for this run: nothing is deleted anywhere.", ""); continue; }
    out.push("", "| | Version | Tags | Reason |", "| --- | --- | --- | --- |");
    const cell = (s) => String(s).replace(/\|/g, "\\|");
    const row = (kind, e) => `| ${kind} | \`${cell(e.digest.slice(0, 19))}\` (${e.id}) | ${cell(e.tags.filter((t) => !SIG_TAG.test(t)).join(", ") || "-")} | ${cell(e.reason)} |`;
    for (const e of r.keep) out.push(row("KEEP", e));
    for (const e of r.delete) out.push(row(dryRun ? "DELETE (planned)" : "DELETE", e));
    for (const e of r.deferred) out.push(row("DEFER", e));
    out.push("");
    if (r.delete.length) {
      out.push("<details><summary>Restore (GitHub restores a deleted version for 30 days)</summary>", "", "```sh");
      for (const e of r.delete) out.push(`gh api -X POST /orgs/${org}/packages/${r.type}/${r.name}/versions/${e.id}/restore`);
      out.push("```", "", "Restore every version of a build, not just the tagged one.", "", "</details>", "");
    }
  }
  return out.join("\n");
}

module.exports = { buildGraph, planContainer, planNpm, renderSummary, tagsOf, SIG_TAG };
