"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { satisfies, compare } = require("./semver");
const { scanContainerPins, scanNpmConsumers } = require("./pins");
const { planContainer, planNpm, renderSummary } = require("./plan");

const fixtures = path.join(__dirname, "..", "..", "..", "tests", "fixtures", "package-prune");
const NOW = Date.parse("2026-11-24T12:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3600e3).toISOString();
const dg = (s) => `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`;

// A fake GHCR: manifests by digest or tag, plus the package versions the REST API would list.
// One build = tagged index + platform image + attestation (children), a cosign bundle referrer and the
// referrers fallback-tag index `sha256-<index digest>`.
function registry() {
  const manifests = new Map();
  const versions = [];
  let id = 1000;
  const put = (digest, json, tags, hoursAgo) => {
    manifests.set(digest, { digest, json });
    versions.push({ id: id++, name: digest, created_at: ago(hoursAgo), metadata: { container: { tags } } });
  };
  const build = (label, hoursAgo, tags = [`sha-${label}`], shared = null) => {
    const index = dg(`${label}-index`);
    const image = shared ?? dg(`${label}-image`);
    const att = dg(`${label}-att`);
    const bundle = dg(`${label}-bundle`);
    const fallback = dg(`${label}-fallback`);
    if (!shared) put(image, { layers: [] }, [], hoursAgo);
    put(att, { layers: [] }, [], hoursAgo);
    put(index, { manifests: [{ digest: image }, { digest: att }] }, tags, hoursAgo);
    put(bundle, { subject: { digest: index }, layers: [] }, [], hoursAgo);
    put(fallback, { manifests: [{ digest: bundle }] }, [`sha256-${index.slice(7)}`], hoursAgo);
    manifests.set(`sha256-${index.slice(7)}`, manifests.get(fallback));
    return { index, image, att, bundle, fallback };
  };
  const reg = {
    gets: [],
    async manifest(ref) {
      this.gets.push(ref);
      const m = manifests.get(ref);
      return m ? { status: 200, ...m } : { status: 404 };
    },
  };
  return { reg, versions, build, manifests };
}
const ids = (entries) => entries.map((e) => e.digest);
const noPins = { digests: new Map(), tags: new Map() };
const base = { now: NOW, keepLatest: 1, minAgeHours: 2, maxDeletions: 20 };

test("semver: caret, tilde, exact, ranges and wildcards", () => {
  assert.ok(satisfies("0.10.0", "^0.10.0"));
  assert.ok(!satisfies("0.11.0", "^0.10.0"));
  assert.ok(satisfies("0.10.5", "~0.10.1"));
  assert.ok(satisfies("1.4.0", "^1.2.3"));
  assert.ok(!satisfies("2.0.0", "^1.2.3"));
  assert.ok(satisfies("0.0.3", "^0.0.3") && !satisfies("0.0.4", "^0.0.3"));
  assert.ok(satisfies("1.2.9", "1.2.x") && !satisfies("1.3.0", "1.2.x"));
  assert.ok(satisfies("1.5.0", ">=1.2.0 <2.0.0") && satisfies("3.0.0", "^1.0.0 || >=3"));
  assert.ok(satisfies("1.5.0", "1.2.0 - 1.9.9"));
  assert.ok(!satisfies("1.0.0-rc.1", "^1.0.0") && satisfies("1.0.0-rc.2", "^1.0.0-rc.1"));
  assert.ok(compare("0.10.0", "0.9.9") > 0 && compare("1.0.0-rc.1", "1.0.0") < 0);
  assert.throws(() => satisfies("1.0.0", "workspace:*"));
});

test("pins: container refs from digests, tags and the default tag; placeholders and similar names are ignored", () => {
  const { files, refs } = scanContainerPins([
    { dir: path.join(fixtures, "containers"), label: "containers", prefix: "podman/stacks" },
    { dir: path.join(fixtures, "playbooks"), label: "playbooks" },
  ], "ecleangg");
  assert.equal(files, 4);
  assert.deepEqual([...refs.get("booky").digests.keys()], ["sha256:e05082c3b09359ee026fa38007aede84ab9fa3a85bc9ca63d1a4cf137d1fd4fd"]);
  assert.deepEqual([...refs.get("api-rs").digests.keys()], ["sha256:b3f146564aa2aa24c84ae2b69e7249274be7e7a23b8f4081309c6934c7160691"]);
  assert.deepEqual([...refs.get("discord-bot").tags.keys()], ["sha-d0a4820"]);
  assert.deepEqual([...refs.get("tool").tags.keys()], ["latest"]);
  assert.equal(refs.get("api-rs").tags.size, 0, "ghcr.io/ecleangg/api is a different image");
  assert.equal(refs.get("booky").tags.size, 0, "`sha-<commit>` placeholder is not a tag");
});

test("pins: an empty source or a missing directory throws", () => {
  assert.throws(() => scanContainerPins([{ dir: path.join(fixtures, "nope"), label: "x" }], "ecleangg"), /not checked out/);
  assert.throws(() => scanContainerPins([{ dir: path.join(fixtures, "containers"), label: "x", prefix: "podman/stacks/booky" }].map((r) => ({ ...r, prefix: "podman/stacks/missing" })), "ecleangg"));
});

test("npm consumers: lockfile versions per format, nearest lockfile and no-lockfile ranges", () => {
  const dirs = ["control-center", "desktop-app", "website", "nolock", "booky", "npmlock", "yarn"].map((d) => ({ dir: path.join(fixtures, "npm", d), label: d }));
  const deps = scanNpmConsumers(dirs, "@ecleangg/ui");
  const by = Object.fromEntries(deps.map((d) => [d.source.split(":")[0], d]));
  assert.deepEqual(by["control-center"].locked, ["0.10.0"]);
  assert.equal(by["control-center"].range, "^0.10.0");
  assert.deepEqual(by["desktop-app"].locked, ["0.10.0"]);
  assert.deepEqual(by.website.locked, ["0.11.0"]);
  assert.deepEqual(by.booky.locked, ["0.10.0"]);
  assert.equal(by.booky.source, "booky:web/console/package.json");
  assert.deepEqual(by.nolock.locked, []);
  assert.equal(by.nolock.lock, null);
  assert.deepEqual(by.npmlock.locked, ["0.8.2"]);
  assert.deepEqual(by.yarn.locked, ["0.7.4"]);
});

test("container plan: newest build and its parts are kept, a superseded build goes whole", async () => {
  const r = registry();
  const old = r.build("aaaaaaa", 100);
  const cur = r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest", "main"]);
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: false });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(new Set(ids(plan.keep)), new Set([cur.index, cur.image, cur.att, cur.bundle, cur.fallback]));
  assert.deepEqual(new Set(ids(plan.delete)), new Set([old.index, old.image, old.att, old.bundle, old.fallback]));
  assert.equal(plan.builds.length, 1);
  assert.equal(plan.builds[0].ids.length, 5);
  assert.equal(plan.delete[0].digest, old.index, "the tagged root is deleted first");
  assert.match(plan.delete[1].reason, /superseded build sha-aaaaaaa/);
  assert.match(plan.keep.find((e) => e.digest === cur.att).reason, /attestation|child of/);
});

test("container plan: a production pin keeps its whole build, including attestation and referrers", async () => {
  const r = registry();
  const pinned = r.build("1111111", 200);
  const mid = r.build("2222222", 100);
  const cur = r.build("3333333", 30, ["sha-3333333", "latest"]);
  const pins = { digests: new Map([[pinned.index, ["containers:booky.container"]]]), tags: new Map() };
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins });
  for (const part of Object.values(pinned)) assert.ok(ids(plan.keep).includes(part), "pinned build part kept");
  for (const part of Object.values(cur)) assert.ok(ids(plan.keep).includes(part));
  assert.deepEqual(new Set(ids(plan.delete)), new Set(Object.values(mid)));
  assert.match(plan.keep.find((e) => e.digest === pinned.index).reason, /pinned by containers:booky\.container/);
});

test("container plan: a child shared with a kept build is never deleted", async () => {
  const r = registry();
  const first = r.build("aaaaaaa", 100);
  const cur = r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest"], first.image);
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: false });
  assert.ok(ids(plan.keep).includes(first.image));
  assert.ok(!ids(plan.delete).includes(first.image));
  assert.ok(ids(plan.delete).includes(first.index));
  assert.ok(ids(plan.keep).includes(cur.index));
});

test("container plan: a pin that is gone from the registry aborts with nothing to delete (booky)", async () => {
  const r = registry();
  r.build("d55a871", 300, ["sha-d55a871", "latest", "main"]);
  r.build("fc31739", 400);
  const gone = `sha256:${"e0".repeat(32)}`;
  const pins = { digests: new Map([[gone, ["containers:podman/stacks/booky/booky.container"]]]), tags: new Map() };
  const plan = await planContainer({ ...base, name: "booky", versions: r.versions, reg: r.reg, pins });
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /pinned digest sha256:e0e0.* is not a version of this package: missing/);
  assert.deepEqual(plan.delete, []);
});

test("container plan: a pin that is a version but whose manifest 404s in the registry aborts", async () => {
  const r = registry();
  const b = r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest"]);
  const old = r.build("aaaaaaa", 100);
  r.manifests.delete(old.index);
  const pins = { digests: new Map([[old.index, ["p"]]]), tags: new Map() };
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins });
  assert.match(plan.errors.join("\n"), /manifest sha256:.* is missing from the registry/);
  assert.deepEqual(plan.delete, []);
  assert.ok(b);
});

test("container plan: a pin tag that does not exist aborts; an existing one keeps its build", async () => {
  const r = registry();
  const old = r.build("aaaaaaa", 100);
  r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest"]);
  const missing = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: { digests: new Map(), tags: new Map([["sha-zzzzzzz", ["p"]]]) } });
  assert.match(missing.errors[0], /pinned tag sha-zzzzzzz .* does not exist/);
  const ok = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: { digests: new Map(), tags: new Map([["sha-aaaaaaa", ["p"]]]) } });
  assert.deepEqual(ok.delete, []);
  assert.ok(ids(ok.keep).includes(old.att));
});

test("container plan: builds younger than the minimum age are kept and in-flight parts defer the build", async () => {
  const r = registry();
  const fresh = r.build("ccccccc", 0.5);
  const cur = r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest"]);
  const half = r.build("aaaaaaa", 100);
  // The referrer of an old build landed 1 h ago: the whole old build waits.
  r.versions.find((v) => v.name === half.bundle).created_at = ago(1);
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: false });
  assert.ok(ids(plan.keep).includes(fresh.index), "fresh build kept as in flight");
  assert.ok(ids(plan.keep).includes(cur.index));
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.deferred.length, 5);
  assert.match(plan.deferred[0].reason, /younger than 2 h/);
});

test("container plan: the deletion cap counts whole builds and never splits one", async () => {
  const r = registry();
  r.build("aaaaaaa", 300);
  r.build("bbbbbbb", 200);
  r.build("ccccccc", 100);
  r.build("ddddddd", 30, ["sha-ddddddd", "latest"]);
  const plan = await planContainer({ ...base, maxDeletions: 7, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: false });
  assert.equal(plan.delete.length, 5, "one whole build, the next would exceed 7");
  assert.equal(plan.builds[0].label, "sha-aaaaaaa", "oldest first");
  assert.equal(plan.deferred.length, 10);
});

test("container plan: refuses without a tagged build, without pins when required, and orphans are handled", async () => {
  const r = registry();
  r.versions.push({ id: 1, name: dg("lonely"), created_at: ago(100), metadata: { container: { tags: [] } } });
  const none = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins });
  assert.match(none.errors[0], /no tagged build/);
  r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest"]);
  const unpinned = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: true });
  assert.match(unpinned.errors[0], /no production pin/);
  const orphan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: false });
  assert.deepEqual(orphan.errors, []);
  assert.equal(orphan.delete.length, 1);
  assert.match(orphan.delete[0].reason, /orphan/);
});

test("container plan: latest on an older build is kept next to the newest build", async () => {
  const r = registry();
  const a = r.build("aaaaaaa", 100, ["sha-aaaaaaa", "latest"]);
  const b = r.build("bbbbbbb", 30, ["sha-bbbbbbb", "test-branch"]);
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: false });
  assert.deepEqual(plan.delete, []);
  assert.ok(ids(plan.keep).includes(a.index) && ids(plan.keep).includes(b.index));
});

test("container plan: an unreadable registry aborts", async () => {
  const r = registry();
  r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest"]);
  r.build("aaaaaaa", 100);
  const reg = { async manifest() { throw new Error("HTTP 503"); } };
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg, pins: noPins, requirePins: false });
  assert.match(plan.errors[0], /cannot read the registry/);
  assert.deepEqual(plan.delete, []);
});

const npmVersions = (...specs) => specs.map(([name, hours], i) => ({ id: i + 1, name, created_at: ago(hours) }));

test("npm plan: newest and consumer-locked versions stay (ui 0.11.0 and 0.10.0), the rest goes", () => {
  const dirs = ["control-center", "desktop-app", "website", "booky"].map((d) => ({ dir: path.join(fixtures, "npm", d), label: d }));
  const consumers = scanNpmConsumers(dirs, "@ecleangg/ui");
  const plan = planNpm({
    ...base, name: "ui", pkg: "@ecleangg/ui", consumers,
    versions: npmVersions(["0.11.1", 1000], ["0.11.0", 2000], ["0.10.0", 3000], ["0.9.0", 4000], ["0.8.0", 5000]),
  });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.keep.map((e) => e.digest).sort(), ["0.10.0", "0.11.0", "0.11.1"]);
  assert.deepEqual(plan.delete.map((e) => e.digest), ["0.8.0", "0.9.0"]);
  assert.match(plan.keep.find((e) => e.digest === "0.10.0").reason, /locked by/);
});

test("npm plan: without a lockfile the highest version matching the range is kept; a lockfile that covers it is enough", () => {
  const consumers = scanNpmConsumers([{ dir: path.join(fixtures, "npm", "nolock"), label: "nolock" }, { dir: path.join(fixtures, "npm", "npmlock"), label: "npmlock" }], "@ecleangg/ui");
  const plan = planNpm({
    ...base, name: "ui", pkg: "@ecleangg/ui", consumers,
    versions: npmVersions(["0.11.0", 100], ["0.9.4", 200], ["0.9.1", 300], ["0.9.0", 400], ["0.8.2", 500], ["0.8.9", 450], ["0.8.0", 600]),
  });
  assert.deepEqual(plan.keep.map((e) => e.digest).sort(), ["0.11.0", "0.8.2", "0.9.4"]);
  assert.match(plan.keep.find((e) => e.digest === "0.9.4").reason, /no lockfile/);
});

test("npm plan: an unparseable range aborts, a locked version that is gone only warns, and the cap and age apply", () => {
  const bad = planNpm({ ...base, name: "ui", pkg: "p", consumers: [{ source: "r:package.json", range: "catalog:", locked: [], lock: null }], versions: npmVersions(["1.0.0", 100], ["0.9.0", 200]) });
  assert.match(bad.errors[0], /unsupported version range/);
  const gone = planNpm({ ...base, name: "ui", pkg: "p", consumers: [{ source: "r:package.json", range: "^0.5.0", locked: ["0.5.1"], lock: "r:bun.lock" }], versions: npmVersions(["1.0.0", 100], ["0.9.0", 200]) });
  assert.match(gone.warnings.join(), /not published/);
  const capped = planNpm({ ...base, maxDeletions: 1, name: "ui", pkg: "p", consumers: [], versions: npmVersions(["1.0.0", 100], ["0.9.0", 200], ["0.8.0", 300], ["0.7.0", 400]) });
  assert.deepEqual(capped.delete.map((e) => e.digest), ["0.7.0"]);
  assert.equal(capped.deferred.length, 2);
  const young = planNpm({ ...base, name: "ui", pkg: "p", consumers: [], versions: npmVersions(["1.0.0", 100], ["0.9.9", 1], ["0.9.0", 200]) });
  assert.ok(young.keep.some((e) => e.digest === "0.9.9"));
  assert.deepEqual(young.delete.map((e) => e.digest), ["0.9.0"]);
});

test("summary lists KEEP and DELETE with reasons and the restore hint", async () => {
  const r = registry();
  r.build("aaaaaaa", 100);
  r.build("bbbbbbb", 30, ["sha-bbbbbbb", "latest"]);
  const plan = await planContainer({ ...base, name: "x", versions: r.versions, reg: r.reg, pins: noPins, requirePins: false });
  const md = renderSummary([plan], { org: "ecleangg", dryRun: true });
  assert.match(md, /dry run: nothing is deleted/);
  assert.match(md, /\| KEEP \|/);
  assert.match(md, /\| DELETE \(planned\) \|/);
  assert.match(md, /gh api -X POST \/orgs\/ecleangg\/packages\/container\/x\/versions\/\d+\/restore/);
  assert.match(md, /30 days/);
});

test("scanNpmConsumers ignores a scanned repo's own tests/fixtures", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-skip-"));
  fs.mkdirSync(path.join(root, "tests", "fixtures", "x"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "fixtures", "x", "package.json"), JSON.stringify({ dependencies: { "@ecleangg/ui": "0.8.2" } }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@ecleangg/ui": "^0.11.0" } }));
  const consumers = scanNpmConsumers([{ dir: root, label: "repo" }], "@ecleangg/ui");
  assert.deepEqual(consumers.map((d) => d.source), ["repo:package.json"]);
});

test("summary: an absent package is noted and not an error", () => {
  const out = renderSummary([{ type: "container", name: "gone", versions: 0, keep: [], delete: [], deferred: [], builds: [], warnings: [], errors: [], absent: true }], { org: "o", dryRun: false });
  assert.match(out, /package gone not found, nothing to prune/);
  assert.doesNotMatch(out, /ERROR|Aborted/);
});
