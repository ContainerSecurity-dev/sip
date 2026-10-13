#!/usr/bin/env node
// Run from repository root. Uses only a dedicated user-specified benchmark registry namespace.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const output = resolve(process.env.RESULTS_DIR ?? `experiments/results/run-${Date.now()}`);
mkdirSync(output, { recursive: true });
const report = { recordedAt: new Date().toISOString(), platform: 'linux/amd64', cache: 'no-cache; warm base downloads possible',
  source: null, tools: {}, runs: [], status: 'incomplete', limitations: [
    'Wall-clock build includes push and, for SIP, attestations.',
    'Repeated no-cache builds are not guaranteed bit-for-bit reproducible; compare recorded digests.',
    'Local harness duration is not complete GitHub Actions pipeline duration.',
    'Runtime image scans provide like-for-like CVE counts; attached SBOM gate has potentially broader scope.'
  ] };
function save() { writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n'); }
let sequence = 0;
function run(command, args, { required = true, cwd, env } = {}) {
  const start = performance.now();
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const seconds = (performance.now() - start) / 1000;
  const file = `${String(++sequence).padStart(3, '0')}-${command.replaceAll('/', '_')}.log`;
  writeFileSync(join(output, file), `$ ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`.trimEnd() + '\n');
  if (required && result.status !== 0) throw new Error(`${command} failed; see ${file}`);
  return { stdout: result.stdout?.trim(), status: result.status, seconds, log: file };
}
try {
  report.source = run('git', ['rev-parse', 'HEAD']).stdout;
  report.dirty = Boolean(run('git', ['status', '--porcelain']).stdout);
  for (const [name, command, args] of [['node', 'node', ['--version']], ['npm', 'npm', ['--version']],
    ['docker', 'docker', ['version']], ['buildx', 'docker', ['buildx', 'version']], ['trivy', 'trivy', ['--version']],
    ['kernel', 'uname', ['-a']]]) report.tools[name] = run(command, args, { required: false });
  if (report.tools.docker.status !== 0) throw new Error('Docker daemon unavailable; container measurements Not measured');
  if (report.tools.trivy.status !== 0) throw new Error('Trivy unavailable; vulnerability measurements Not measured');
  const image = process.env.BENCHMARK_IMAGE;
  if (!image || !/^[a-z0-9][a-z0-9._:/-]+$/.test(image)) throw new Error('Set BENCHMARK_IMAGE to a dedicated writable registry repository');
  const count = Number(process.env.REPETITIONS ?? '3');
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('REPETITIONS must be a positive integer');
  const bases = {};
  for (const [key, tag] of Object.entries({ baseline: 'node:26.3.0-trixie-slim', build: 'dhi.io/node:26.3.0-debian13-dev', runtime: 'dhi.io/node:26.3.0-debian13' })) {
    const digest = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest.Digest}}']).stdout);
    bases[key] = `${tag}@${digest}`;
  }
  report.bases = bases;
  const cache = join(output, 'trivy-cache');
  run('trivy', ['image', '--cache-dir', cache, '--download-db-only']);
  report.vulnerabilityDatabase = JSON.parse(readFileSync(join(cache, 'db/metadata.json'), 'utf8'));
  for (let iteration = 1; iteration <= count; iteration++) {
    // Alternate ordering to reduce consistent ordering bias.
    for (const variant of iteration % 2 ? ['baseline', 'hardened'] : ['hardened', 'baseline']) {
      const start = performance.now();
      const row = { iteration, variant, completeCiSeconds: null, status: 'started' };
      report.runs.push(row); save();
      const dir = join(output, `${variant}-${iteration}`); mkdirSync(dir);
      if (variant === 'hardened') row.dependencyVerificationSeconds = run('node', ['scripts/validate-lockfile-age.mjs']).seconds;
      const args = ['buildx', 'build', '--platform', report.platform, '--no-cache', '--pull', '-f', `experiments/${variant}/Dockerfile`,
        '--metadata-file', join(dir, 'build.json'), '--tag', `${image}:${variant}-${Date.now()}`];
      if (variant === 'baseline') args.push('--build-arg', `BASE_IMAGE=${bases.baseline}`, '--sbom=false', '--provenance=false');
      else args.push('--build-arg', `BUILD_IMAGE=${bases.build}`, '--build-arg', `RUNTIME_IMAGE=${bases.runtime}`, '--sbom=true', '--provenance=mode=max');
      args.push('--output', 'type=image,push=true,oci-mediatypes=true,oci-artifact=true', '.');
      row.buildSeconds = run('docker', args).seconds;
      row.digest = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))['containerimage.digest'];
      if (!/^sha256:[a-f0-9]{64}$/.test(row.digest)) throw new Error('Build did not return immutable digest');
      const ref = `${image}@${row.digest}`;
      for (const [key, format] of [['sbom', '{{json .SBOM}}'], ['provenance', '{{json .Provenance}}']]) {
        const result = run('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', format], { required: false });
        writeFileSync(join(dir, `${key}.json`), result.stdout || 'null');
        row[`${key}Available`] = result.status === 0 && !['null', '{}', ''].includes(result.stdout);
      }
      const index = JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', ref, '--raw']).stdout);
      const platformDigest = index.manifests?.find(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64')?.digest;
      const manifest = platformDigest ? JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', `${image}@${platformDigest}`, '--raw']).stdout) : index;
      row.compressedLayerBytes = manifest.layers.reduce((n, layer) => n + layer.size, 0);
      run('docker', ['pull', '--platform', report.platform, ref]);
      row.localImageBytes = Number(run('docker', ['image', 'inspect', ref, '--format', '{{.Size}}']).stdout);
      row.runtimeNode = run('docker', ['run', '--rm', '--entrypoint', 'node', ref, '--version']).stdout;
      const cid = run('docker', ['run', '-d', '--platform', report.platform, ref]).stdout;
      try {
        run('docker', ['exec', cid, 'node', '-e', `async function check(){for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:3000');if(r.status===200&&(await r.json()).message==='Hello from toy Express TypeScript app!')return;}catch{}await new Promise(r=>setTimeout(r,100));}process.exit(1)}check()`]);
        row.functionalCheck = 'pass';
      } finally { run('docker', ['rm', '-f', cid]); }
      run('trivy', ['image', '--cache-dir', cache, '--skip-db-update', '--scanners', 'vuln', '--format', 'json', '--output', join(dir, 'runtime-trivy.json'), ref]);
      const scan = JSON.parse(readFileSync(join(dir, 'runtime-trivy.json'), 'utf8'));
      row.cves = Object.fromEntries(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].map(severity => [severity,
        (scan.Results ?? []).flatMap(r => r.Vulnerabilities ?? []).filter(v => v.Severity === severity).length]));
      if (variant === 'hardened') {
        const verification = performance.now();
        run('bash', [resolve('scripts/retrieve-attached-sbom.sh')], { cwd: dir, env: { IMAGE: image, DIGEST: row.digest } });
        const gate = run('trivy', ['sbom', '--cache-dir', cache, '--skip-db-update', '--scanners', 'vuln', '--severity', 'CRITICAL', '--ignore-unfixed', '--exit-code', '1', '--format', 'json', '--output', join(dir, 'gate.json'), join(dir, 'sbom.spdx.json')], { required: false });
        row.gateExitCode = gate.status;
        row.securityVerificationSeconds = (performance.now() - verification) / 1000;
      }
      row.harnessSeconds = (performance.now() - start) / 1000;
      row.status = 'measured'; save();
    }
  }
  const median = values => { values.sort((a, b) => a - b); const n = values.length; return n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2; };
  report.medians = Object.fromEntries(['baseline', 'hardened'].map(variant => [variant, Object.fromEntries(
    ['buildSeconds', 'securityVerificationSeconds', 'harnessSeconds'].map(metric => {
      const values = report.runs.filter(r => r.variant === variant && typeof r[metric] === 'number').map(r => r[metric]);
      return [metric, values.length ? median(values) : null];
    }))]));
  report.status = 'complete';
} catch (error) { report.blocker = error.message; process.exitCode = 1; }
finally { save(); console.log(`Results: ${output}`); }
