// Entry point of the coverage-summary action. Configuration comes from the environment so that
// nothing from the workflow is interpolated into a shell command.
"use strict";
const fs = require("fs");
const path = require("path");
const { parse, totals, pct, fmt, renderReport } = require("./parsers");

const env = process.env;
const name = env.COVERAGE_NAME;
const outDir = path.join(env.COVERAGE_OUT_DIR, name); // one directory per report: a job may report several
const failOnError = env.COVERAGE_FAIL_ON_ERROR === "true";

function setOutput(key, value) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function main() {
  const root = `${env.GITHUB_WORKSPACE || process.cwd()}/`;
  const parsed = parse(env.COVERAGE_FORMAT, fs.readFileSync(env.COVERAGE_FILE, "utf8"), root);
  const current = { totals: totals(parsed), files: parsed.files, commit: env.GITHUB_SHA, name };

  let baseline = null;
  let baselineNote = "";
  const baseFile = path.join(env.COVERAGE_BASELINE_DIR || "", `coverage-${name}.json`);
  if (env.COVERAGE_BASELINE_DIR && fs.existsSync(baseFile)) {
    try {
      baseline = JSON.parse(fs.readFileSync(baseFile, "utf8"));
    } catch (e) {
      baselineNote = `The baseline artifact could not be read (${e.message}); no delta.`;
    }
  } else if (env.COVERAGE_BASELINE_NOTE) {
    baselineNote = env.COVERAGE_BASELINE_NOTE;
  }

  const md = renderReport({ name, format: env.COVERAGE_FORMAT, current, baseline, baselineNote });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.md"), md);
  fs.writeFileSync(path.join(outDir, `coverage-${name}.json`), JSON.stringify(current));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  const lp = pct(current.totals.lines);
  const bp = pct(current.totals.branches);
  setOutput("line-percent", lp === null ? "" : lp.toFixed(2));
  setOutput("branch-percent", bp === null ? "" : bp.toFixed(2));
  setOutput("report-file", path.join(outDir, "report.md"));
  console.log(`Coverage ${name}: lines ${fmt(lp)}, branches ${fmt(bp)}`);
}

try {
  main();
} catch (e) {
  const md = `### Coverage: ${name}\n\nThe coverage report could not be produced: ${e.message}\n`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.md"), md);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(`::${failOnError ? "error" : "warning"} title=coverage-summary::${e.message}`);
  setOutput("line-percent", "");
  setOutput("branch-percent", "");
  setOutput("report-file", path.join(outDir, "report.md"));
  if (failOnError) process.exitCode = 1;
}
