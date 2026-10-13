import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const digest = `sha256:${'a'.repeat(64)}`;
function fixture(fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'sip-test-'));
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, IMAGE: 'example.invalid/test', DIGEST: digest,
    GITHUB_OUTPUT: join(cwd, 'output'), REF_TYPE: 'branch', REF_NAME: 'main', PROMOTION_TAG: 'test-only' };
  const mock = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  const run = (file, extra = {}) => spawnSync('bash', [join(root, file)], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  try { fn({ cwd, env, mock, run }); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('missing, empty and malformed attached SBOMs fail closed; valid fixture succeeds', () => fixture(({ mock, run }) => {
  for (const body of ['null', '{}', '{"spdxVersion":"SPDX-2.3","packages":[]}', 'invalid-json']) {
    mock('docker', `printf '%s' '${body}'`);
    assert.notEqual(run('scripts/retrieve-attached-sbom.sh').status, 0);
  }
  mock('docker', 'exit 1');
  assert.notEqual(run('scripts/retrieve-attached-sbom.sh').status, 0);
  mock('docker', `printf '%s' '{"spdxVersion":"SPDX-2.3","packages":[{"name":"fixture"}]}'`);
  assert.equal(run('scripts/retrieve-attached-sbom.sh').status, 0);
}));

test('Critical scanner fixture fails workflow gate; clean fixture passes', () => fixture(({ cwd, mock, run }) => {
  for (const count of [1, 0]) {
    const report = JSON.stringify({ Results: [{ Vulnerabilities: Array.from({ length: count }, () => ({
      VulnerabilityID: 'TEST-CRITICAL', Severity: 'CRITICAL', FixedVersion: '2.0.0'
    })) }] });
    mock('trivy', `[[ "$*" == *"--ignore-unfixed"* ]]\n[[ "$*" == *"--severity CRITICAL"* ]]\n[[ "$*" == "sbom "* ]]\nprintf '%s' '${report}' > trivy.json`);
    assert.equal(run('scripts/scan-attached-sbom.sh').status, 0);
    const output = readFileSync(join(cwd, 'output'), 'utf8').trim().split('\n').at(-1);
    const observed = output.split('=')[1];
    const gate = spawnSync('bash', ['-c', 'test "$CRITICAL_COUNT" -eq 0'], { env: { ...process.env, CRITICAL_COUNT: observed } });
    assert.equal(gate.status, count ? 1 : 0);
  }
}));

test('release refs reject feature branches and non-release tags', () => fixture(({ run }) => {
  for (const [REF_TYPE, REF_NAME, expected] of [['branch', 'main', 0], ['tag', 'v1.0.0', 0],
    ['branch', 'feature', 1], ['tag', 'test', 1], ['branch', 'v1.0.0', 1]]) {
    assert.equal(run('scripts/validate-release-ref.sh', { REF_TYPE, REF_NAME }).status, expected);
  }
}));

test('promotion uses verified digest and checks resulting tag; unauthorized refs never invoke Docker', () => fixture(({ cwd, mock, run }) => {
  mock('docker', `echo "$*" >> calls\nif [[ "$*" == *" inspect "* ]]; then printf '"%s"' "\${ACTUAL_DIGEST:-$DIGEST}"; fi`);
  assert.equal(run('experiments/scripts/promote.sh').status, 0);
  assert.match(readFileSync(join(cwd, 'calls'), 'utf8'), new RegExp(`example.invalid/test@${digest}`));
  assert.notEqual(run('experiments/scripts/promote.sh', { ACTUAL_DIGEST: `sha256:${'b'.repeat(64)}` }).status, 0);
  rmSync(join(cwd, 'calls'));
  assert.notEqual(run('experiments/scripts/promote.sh', { REF_NAME: 'feature' }).status, 0);
  assert.equal(existsSync(join(cwd, 'calls')), false);
}));

test('npm ci --ignore-scripts prevents a harmless dependency lifecycle marker', () => fixture(({ cwd }) => {
  const pkg = join(cwd, 'package'); mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sip-lifecycle-fixture', version: '1.0.0',
    scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'marker\',\'executed\')"' } }));
  const npm = args => spawnSync('npm', args, { cwd, encoding: 'utf8', env: { ...process.env,
    npm_config_cache: join(cwd, 'cache'), npm_config_userconfig: '/dev/null' } });
  assert.equal(npm(['pack', pkg, '--ignore-scripts']).status, 0);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0',
    dependencies: { 'sip-lifecycle-fixture': 'file:./sip-lifecycle-fixture-1.0.0.tgz' } }));
  assert.equal(npm(['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit']).status, 0);
  assert.equal(npm(['ci', '--ignore-scripts', '--offline', '--no-audit']).status, 0);
  const marker = join(cwd, 'node_modules/sip-lifecycle-fixture/marker');
  assert.equal(existsSync(marker), false);
  assert.equal(npm(['ci', '--ignore-scripts=false', '--offline', '--no-audit']).status, 0);
  assert.equal(existsSync(marker), true, 'positive control proves the fixture hook can execute');
  const lock = JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/sip-lifecycle-fixture'].integrity = 'sha512-AAAA';
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lock));
  assert.notEqual(npm(['ci', '--ignore-scripts', '--offline', '--no-audit']).status, 0);
}));
