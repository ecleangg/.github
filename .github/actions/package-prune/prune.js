"use strict";
// Package prune: keeps the newest build of each image (the newest npm version) plus everything still in
// use, and deletes the rest. Reads production pins from the pin repositories and npm consumers from
// the org's repositories. Dry run by default; any unreadable source, missing pin or registry error
// aborts before anything is deleted. Configuration comes from PRUNE_* environment variables.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { scanContainerPins, scanNpmConsumers } = require("./pins");
const { planContainer, planNpm, renderSummary } = require("./plan");

const READ_ONLY = process.env.PRUNE_READ_ONLY === "true"; // test harness: refuse every non-GET request
const API = "https://api.github.com";

async function http(url, { method = "GET", headers = {}, retries = 3 } = {}) {
  if (READ_ONLY && method !== "GET") throw new Error(`read-only harness refused ${method} ${url}`);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers });
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    return res;
  }
}

const ghHeaders = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "eclean-package-prune" });

async function ghJson(token, url) {
  const res = await http(url.startsWith("http") ? url : `${API}${url}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

async function ghPaginate(token, url) {
  const all = [];
  for (let page = 1; ; page++) {
    const data = await ghJson(token, `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    all.push(...data);
    if (data.length < 100) return all;
  }
}

function ghcr(token, org, name) {
  let bearer;
  const auth = async () => {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const res = await http(`https://ghcr.io/token?service=ghcr.io&scope=repository:${org}/${name}:pull`, { headers: { Authorization: `Basic ${basic}` } });
    if (!res.ok) throw new Error(`ghcr.io token for ${name}: HTTP ${res.status}`);
    bearer = (await res.json()).token;
  };
  const accept = [
    "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  return {
    async manifest(ref) {
      if (!bearer) await auth();
      const res = await http(`https://ghcr.io/v2/${org}/${name}/manifests/${ref}`, { headers: { Authorization: `Bearer ${bearer}`, Accept: accept } });
      if (res.status === 404) { await res.arrayBuffer(); return { status: 404 }; }
      if (!res.ok) throw new Error(`GET manifest ${name}@${ref}: HTTP ${res.status}`);
      const body = await res.text();
      const digest = res.headers.get("docker-content-digest") ?? (ref.startsWith("sha256:") ? ref : null);
      if (!digest) throw new Error(`manifest ${name}:${ref} came without a digest`);
      return { status: 200, digest, json: JSON.parse(body) };
    },
  };
}

// Shallow, blob-less clone; `checkout(want)` then fetches only the paths `want(path)` accepts (one batched blob fetch).
function clone(repo, dir, token) {
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64}`,
  };
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--no-checkout", "--filter=blob:none", `https://github.com/${repo}.git`, dir], { env, stdio: ["ignore", "pipe", "pipe"] });
  const git = (args, input) => execFileSync("git", args, { cwd: dir, env, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 28 }).toString();
  return {
    checkout(want) {
      const files = git(["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean).filter(want);
      if (files.length) {
        // Sparse checkout fetches the missing blobs in one batch (a pathspec checkout fetches them one by one).
        git(["sparse-checkout", "set", "--no-cone", "--stdin"], `${files.map((f) => `/${f.replace(/[\\*?[\]]/g, "\\$&")}`).join("\n")}\n`);
        git(["checkout", "--quiet", "HEAD"]);
      }
      return files.length;
    },
  };
}

const lines = (s) => (s ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const flag = (s, dflt) => (s === undefined || s === "" ? dflt : s === "true");
const num = (s, dflt) => (s === undefined || s === "" ? dflt : Number(s));

const aborted = (type, name, versions, error) => ({ type, name, versions, keep: [], delete: [], deferred: [], builds: [], warnings: [], errors: [error] });

async function main(env = process.env) {
  const org = env.PRUNE_ORG || env.GITHUB_REPOSITORY_OWNER || "ecleangg";
  const dryRun = flag(env.PRUNE_DRY_RUN, true);
  const keepLatest = num(env.PRUNE_KEEP_LATEST, 1);
  const maxDeletions = num(env.PRUNE_MAX_DELETIONS, 20);
  const minAgeHours = num(env.PRUNE_MIN_AGE_HOURS, 2);
  const requirePins = flag(env.PRUNE_REQUIRE_PINS, true);
  const token = env.GH_TOKEN;
  const pinToken = env.PIN_TOKEN;
  if (!token || !pinToken) throw new Error("GH_TOKEN (packages) and PIN_TOKEN (read access to the pin repositories) are required");
  if (!(keepLatest >= 1) || !(maxDeletions >= 0) || !(minAgeHours >= 0)) throw new Error("invalid keep-latest, max-deletions or min-age-hours");

  const packages = lines(env.PRUNE_PACKAGES).map((l) => {
    const m = /^(container|npm):([A-Za-z0-9._-]+)$/.exec(l);
    if (!m) throw new Error(`invalid package "${l}", expected container:<name> or npm:<name>`);
    return { type: m[1], name: m[2] };
  });
  if (!packages.length) throw new Error("no packages given");
  const pinRepos = lines(env.PRUNE_PIN_REPOS || `${org}/containers:podman/stacks\n${org}/playbooks`).map((l) => {
    const [repo, ...p] = l.split(":");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid pin repository "${l}"`);
    return { repo, prefix: p.join(":").replace(/\/$/, "") };
  });

  const work = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "package-prune-"));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  const checkoutRepo = (repo, want) => {
    const dir = path.join(work, repo.replace("/", "__"));
    fs.mkdirSync(dir);
    try {
      return { dir, label: repo, n: clone(repo, dir, pinToken).checkout(want) };
    } catch (e) {
      throw new Error(`cannot read ${repo} with the pin token: ${String(e.stderr || e.message).trim().split("\n")[0]}`);
    }
  };

  try {
    // Container pins.
    let pinScan = null;
    if (packages.some((p) => p.type === "container")) {
      const roots = pinRepos.map(({ repo, prefix }) => {
        const s = checkoutRepo(repo, (p) => (!prefix || p === prefix || p.startsWith(`${prefix}/`)));
        if (!s.n) throw new Error(`pin source ${repo}${prefix ? `:${prefix}` : ""} has no files`);
        return { ...s, prefix };
      });
      pinScan = scanContainerPins(roots, org);
      console.log(`Pin sources: ${pinScan.files} files in ${roots.map((r) => r.label).join(", ")}.`);
    }

    // npm consumers: every repository of the org (or the listed ones), manifests and lockfiles only.
    const consumerDirs = [];
    if (packages.some((p) => p.type === "npm")) {
      let repos = lines(env.PRUNE_CONSUMER_REPOS || "*");
      if (repos.length === 1 && repos[0] === "*") {
        repos = (await ghPaginate(pinToken, `/orgs/${org}/repos?type=all`)).filter((r) => !r.archived).map((r) => r.full_name);
        if (!repos.length) throw new Error(`no repositories of ${org} visible to the pin token`);
      }
      const isManifest = (p) => !/(^|\/)node_modules\//.test(p)
        && /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p);
      for (const repo of repos) consumerDirs.push(checkoutRepo(repo, isManifest));
      console.log(`npm consumers: ${repos.length} repositories scanned.`);
    }

    // Plans for every package first; deletions only when none of them failed.
    const now = Date.now();
    const results = [];
    for (const { type, name } of packages) {
      let versions;
      try { versions = await ghPaginate(token, `/orgs/${org}/packages/${type}/${name}/versions`); } catch (e) {
        results.push(aborted(type, name, 0, `cannot list versions: ${e.message}`));
        continue;
      }
      if (!versions.length) { results.push(aborted(type, name, 0, "no versions listed: refusing to prune on empty data")); continue; }
      const common = { name, versions, now, keepLatest, minAgeHours, maxDeletions };
      try {
        if (type === "container") {
          const pins = pinScan.refs.get(name) ?? { digests: new Map(), tags: new Map() };
          results.push(await planContainer({ ...common, pins, reg: ghcr(token, org, name), requirePins }));
        } else {
          const pkg = `@${org}/${name}`;
          results.push(planNpm({ ...common, pkg, consumers: scanNpmConsumers(consumerDirs, pkg) }));
        }
      } catch (e) {
        results.push(aborted(type, name, versions.length, e.message));
      }
    }

    const summary = renderSummary(results, { org, dryRun });
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    const failed = results.filter((r) => r.errors.length);
    for (const r of failed) for (const e of r.errors) console.log(`::error title=Package prune aborted (${r.name})::${e}`);
    if (failed.length) return 1;

    const total = results.reduce((n, r) => n + r.delete.length, 0);
    if (dryRun || READ_ONLY || total === 0) {
      console.log(dryRun || READ_ONLY ? `Dry run: ${total} versions would be deleted.` : "Nothing to delete.");
      return 0;
    }

    // Whole builds, root first. A failed delete stops the run; the next one finishes the build because
    // its remaining parts are then unreachable orphans.
    let deleted = 0;
    let failedDelete = false;
    for (const r of results) {
      for (const b of r.builds) {
        for (const id of b.ids) {
          const res = await http(`${API}/orgs/${org}/packages/${r.type}/${r.name}/versions/${id}`, { method: "DELETE", headers: ghHeaders(token) });
          if (res.status !== 204) { console.log(`::error title=Delete failed::${r.type} ${r.name} version ${id}: HTTP ${res.status}`); failedDelete = true; break; }
          deleted += 1;
        }
        if (failedDelete) break;
      }
      if (failedDelete) break;
    }
    const missing = [];
    for (const r of results.filter((x) => x.type === "container")) {
      const reg = ghcr(token, org, r.name);
      for (const k of r.keep.filter((e) => /^(pinned|newest|carries)/.test(e.reason))) {
        if ((await reg.manifest(k.digest)).status !== 200) missing.push(`${r.name} ${k.digest}`);
      }
    }
    const tail = `Deleted ${deleted} of ${total} planned versions.${missing.length ? ` KEPT MANIFESTS NOW MISSING: ${missing.join(", ")}` : ""}`;
    console.log(tail);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${tail}\n`);
    return failedDelete || missing.length ? 1 : 0;
  } finally {
    cleanup();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.log(`::error title=Package prune aborted::${e.message}`); process.exit(1); });
}

module.exports = { main };
