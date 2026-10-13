import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
const directory = process.argv[2];
if (!directory) throw new Error('Pass a completed results directory');
function read(path) {
  const data = existsSync(path) ? readFileSync(path) : gunzipSync(readFileSync(`${path}.gz`));
  return JSON.parse(data.toString());
}
const report = read(join(directory, 'results.json'));
assert.equal(report.status, 'complete');
for (const row of report.runs) {
  assert.equal(row.status, 'measured');
  assert.equal(row.functionalCheck, 'pass');
  const folder = join(directory, `${row.variant}-${row.iteration}`);
  const scan = read(join(folder, 'runtime-trivy.json'));
  const findings = (scan.Results ?? []).flatMap(result => result.Vulnerabilities ?? []);
  for (const [severity, count] of Object.entries(row.cves)) {
    assert.equal(findings.filter(finding => finding.Severity === severity).length, count);
  }
  if (row.variant === 'hardened') {
    const gate = read(join(folder, 'gate.json'));
    const blocked = (gate.Results ?? []).flatMap(result => result.Vulnerabilities ?? []);
    assert.equal(row.gateExitCode, blocked.length > 0 ? 1 : 0);
    for (const finding of blocked) {
      assert.equal(finding.Severity, 'CRITICAL');
      assert.ok(finding.FixedVersion);
    }
  }
}
const median = values => {
  values.sort((a, b) => a - b);
  const n = values.length;
  return n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
};
for (const [variant, metrics] of Object.entries(report.medians)) {
  for (const [metric, value] of Object.entries(metrics)) {
    const values = report.runs.filter(row => row.variant === variant && typeof row[metric] === 'number').map(row => row[metric]);
    assert.equal(value, values.length ? median(values) : null);
  }
}
console.log(`Verified ${report.runs.length} completed runs: raw vulnerability counts, functional probes, gates and reported medians agree.`);
