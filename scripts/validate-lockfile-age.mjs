import { readFile } from 'node:fs/promises';

const minimumAgeDays = 5;
const cutoff = Date.now() - minimumAgeDays * 24 * 60 * 60 * 1000;
const lockfile = JSON.parse(await readFile('package-lock.json', 'utf8'));
const npmrc = await readFile('.npmrc', 'utf8');
const dependencies = [];

if (!Number.isInteger(lockfile.lockfileVersion) || lockfile.lockfileVersion < 2) {
  throw new Error('package-lock.json must use lockfileVersion 2 or newer');
}
if (!lockfile.packages || typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
  throw new Error('package-lock.json must contain a packages object');
}

const exclusions = new Set(
  npmrc
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^min-release-age-exclude(?:\[\])?\s*=/.test(line))
    .flatMap((line) => line.slice(line.indexOf('=') + 1).split(','))
    .map((name) => name.trim())
    .filter(Boolean),
);

for (const [path, metadata] of Object.entries(lockfile.packages)) {
  if (!path || !metadata.version || metadata.link) continue;

  const marker = 'node_modules/';
  const markerIndex = path.lastIndexOf(marker);
  const name = metadata.name ?? path.slice(markerIndex + marker.length);
  dependencies.push({
    name,
    version: metadata.version,
    resolved: metadata.resolved,
    integrity: metadata.integrity,
  });
}

if (dependencies.length === 0) {
  throw new Error('package-lock.json does not contain any locked dependencies');
}

const packages = new Map();
for (const { name, version } of dependencies) {
  if (exclusions.has(name)) continue;
  const versions = packages.get(name) ?? new Set();
  versions.add(version);
  packages.set(name, versions);
}

const violations = [];
const packageEntries = [...packages.entries()];
const batchSize = 10;

for (let offset = 0; offset < packageEntries.length; offset += batchSize) {
  const batch = packageEntries.slice(offset, offset + batchSize);
  await Promise.all(batch.map(async ([name, versions]) => {
    const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    // The abbreviated install document omits the version publish timestamps.
    const response = await fetch(packageUrl, { headers: { accept: 'application/json' } });

    if (!response.ok) {
      throw new Error(`Unable to retrieve publish time for ${name}: HTTP ${response.status}`);
    }

    const metadata = await response.json();
    for (const version of versions) {
      const publishedAt = metadata.time?.[version];
      const publishedTime = Date.parse(publishedAt);
      const registryArtifact = metadata.versions?.[version]?.dist;
      if (!publishedAt || !Number.isFinite(publishedTime)) {
        violations.push(`${name}@${version}: publish time unavailable`);
      } else if (publishedTime > cutoff) {
        violations.push(`${name}@${version}: published ${publishedAt}`);
      }
      for (const locked of dependencies.filter(
        (dependency) => dependency.name === name && dependency.version === version,
      )) {
        if (!locked.resolved || locked.resolved !== registryArtifact?.tarball) {
          violations.push(`${name}@${version}: resolved tarball does not match npm registry metadata`);
        }
        if (!locked.integrity || locked.integrity !== registryArtifact?.integrity) {
          violations.push(`${name}@${version}: integrity does not match npm registry metadata`);
        }
      }
    }
  }));
}

if (violations.length > 0) {
  console.error(`Dependencies younger than ${minimumAgeDays} days or unverifiable:`);
  console.error(violations.map((violation) => `- ${violation}`).join('\n'));
  process.exit(1);
}

const excludedCount = dependencies.filter(({ name }) => exclusions.has(name)).length;
console.log(
  `Validated ${dependencies.length - excludedCount} locked packages against a ${minimumAgeDays}-day cooldown ` +
  `(${excludedCount} excluded locked packages).`,
);
