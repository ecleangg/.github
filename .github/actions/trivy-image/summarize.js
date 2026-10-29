// Turns a Trivy JSON report into a job-summary table and the findings output; exits 1 when
// findings remain and FAIL is "true". The ignore file already removed accepted findings.
const fs = require("fs");

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 160);
const rank = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = [];
for (const r of report.Results ?? []) {
  for (const v of r.Vulnerabilities ?? []) {
    rows.push({ sev: v.Severity, kind: "vulnerability", id: v.VulnerabilityID, where: r.Target, what: `${v.PkgName} ${v.InstalledVersion}`, fix: v.FixedVersion ?? "", url: v.PrimaryURL });
  }
  for (const s of r.Secrets ?? []) {
    // The matched text is never printed.
    rows.push({ sev: s.Severity, kind: "secret", id: s.RuleID, where: `${r.Target}:${s.StartLine ?? ""}`, what: s.Title, fix: "", url: "" });
  }
}
rows.sort((a, b) => (rank[b.sev] ?? 0) - (rank[a.sev] ?? 0) || a.id.localeCompare(b.id));

const fail = process.env.FAIL === "true";
let md = `## Image scan: ${esc(process.env.TITLE)}\n\n`;
md += `Findings not in the ignore file${process.env.IGNORE ? ` (\`${process.env.IGNORE}\`)` : ""}: **${rows.length}**`;
md += fail ? " (blocking).\n\n" : " (report only on this run).\n\n";
if (rows.length) {
  md += "| Severity | Kind | ID | Where | What | Fixed in |\n| --- | --- | --- | --- | --- | --- |\n";
  for (const r of rows.slice(0, 200)) {
    md += `| ${r.sev} | ${r.kind} | ${r.url ? `[${esc(r.id)}](${r.url})` : esc(r.id)} | ${esc(r.where)} | ${esc(r.what)} | ${esc(r.fix)} |\n`;
  }
  if (rows.length > 200) md += `\n... and ${rows.length - 200} more.\n`;
  md += "\nAccept a finding by adding its ID to the ignore file with a comment that gives the reason.\n";
} else {
  md += "No findings.\n";
}
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${rows.length}\n`);
for (const r of rows.slice(0, 50)) console.log(`::${fail ? "error" : "warning"} title=Trivy ${r.id}::${r.sev} ${r.kind} ${r.what} in ${r.where}`);
if (rows.length > 0 && fail) process.exitCode = 1;
