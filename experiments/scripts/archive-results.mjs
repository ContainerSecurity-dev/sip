// Lossless compression of large raw evidence, retaining small JSON summaries.
import { readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const folder = process.argv[2];
if (!folder) throw new Error('Usage: node experiments/scripts/archive-results.mjs RESULTS_DIRECTORY');
function archive(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { archive(path); continue; }
    if (!/\.(json|log)$/.test(name) || statSync(path).size < 256 * 1024) continue;
    writeFileSync(`${path}.gz`, gzipSync(readFileSync(path), { level: 9 }));
    unlinkSync(path);
  }
}
archive(resolve(folder));
