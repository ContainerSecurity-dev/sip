import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const folder of ['scripts', 'tests', 'experiments/scripts']) {
  for (const file of readdirSync(folder)) {
    const path = `${folder}/${file}`;
    const command = file.endsWith('.mjs') ? [process.execPath, ['--check', path]] :
      file.endsWith('.sh') ? ['bash', ['-n', path]] : null;
    if (!command) continue;
    const result = spawnSync(...command, { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('JavaScript and shell syntax checks passed (not a style linter).');
