import { readFile } from 'node:fs/promises';

const minimumAgeDays = 5;
const cutoff = Date.now() - minimumAgeDays * 24 * 60 * 60 * 1000;
const lockfile = JSON.parse(await readFile('package-lock.json', 'utf8'));
const dependencies = new Map();

for (const [path, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!path || !metadata.version || metadata.link) continue;

  const marker = 'node_modules/';
  const markerIndex = path.lastIndexOf(marker);
  const name = metadata.name ?? path.slice(markerIndex + marker.length);
  dependencies.set(`${name}@${metadata.version}`, { name, version: metadata.version });
}

const violations = [];
for (const { name, version } of dependencies.values()) {
  const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  // The abbreviated install document omits the version publish timestamps.
  const response = await fetch(packageUrl, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`Unable to retrieve publish time for ${name}: HTTP ${response.status}`);
  }

  const metadata = await response.json();
  const publishedAt = metadata.time?.[version];
  if (!publishedAt) {
    violations.push(`${name}@${version}: publish time unavailable`);
  } else if (Date.parse(publishedAt) > cutoff) {
    violations.push(`${name}@${version}: published ${publishedAt}`);
  }
}

if (violations.length > 0) {
  console.error(`Dependencies younger than ${minimumAgeDays} days or unverifiable:`);
  console.error(violations.map((violation) => `- ${violation}`).join('\n'));
  process.exit(1);
}

console.log(`Validated ${dependencies.size} locked packages against a ${minimumAgeDays}-day cooldown.`);
