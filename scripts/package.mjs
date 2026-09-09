import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createAppPack, runNpmBuild } from './pkgutil.mjs';

const rootDir = join(import.meta.dirname, '..');
const buildOutDir = join(rootDir, 'build');
const packageJsonPath = join(rootDir, 'package.json');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version) {
  const match = semverPattern.exec(version);
  if (!match) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function processArgs() {
  const args = parseArgs({
    options: {
      minor: { type: 'boolean' },
      major: { type: 'boolean' },
      version: { type: 'string' },
    },
  });
  let bump = 'patch';
  let explicitVersion;
  if (args.values.minor) {
    bump = 'minor';
  } else if (args.values.major) {
    bump = 'major';
  } else if (args.values.version) {
    explicitVersion = args.values.version;
  }
  return { bump, explicitVersion };
}

function nextVersion(currentVersion) {
  const { bump, explicitVersion } = processArgs();
  if (explicitVersion) {
    parseVersion(explicitVersion);
    return explicitVersion;
  }

  const version = parseVersion(currentVersion);
  if (bump === 'major') {
    return formatVersion({ major: version.major + 1, minor: 0, patch: 0 });
  }
  if (bump === 'minor') {
    return formatVersion({ major: version.major, minor: version.minor + 1, patch: 0 });
  }
  return formatVersion({ major: version.major, minor: version.minor, patch: version.patch + 1 });
}

const packageInfo = JSON.parse(await readFile(packageJsonPath, 'utf8'));
packageInfo.version = nextVersion(packageInfo.version || '0.0.0');
await writeFile(packageJsonPath, `${JSON.stringify(packageInfo, null, 2)}\n`);

// Build first: createAppPack copies dist/ and throws if it is missing, and the
// release workflow runs `npm run package` with no separate build step.
await runNpmBuild(rootDir);

const tgzName = `${packageInfo.name || 'app'}-${packageInfo.version}.tgz`;
const tgzPath = join(buildOutDir, tgzName);
await mkdir(buildOutDir, { recursive: true });
const { closePromise, stdout } = await createAppPack(false);
await Promise.all([pipeline(stdout, createWriteStream(tgzPath)), closePromise]);

// Keep build/ tidy: retain the newest N versioned bundles (rollback window),
// prune older ones, and refresh a stable "<name>-latest.tgz" alias that always
// points at the newest build. Only "-latest.tgz" is tracked in git (see
// .gitignore); the versioned window is a local convenience. Override N with
// KEEP_BUNDLES, e.g. `KEEP_BUNDLES=10 npm run package`.
const keepCount = Math.max(1, Number(process.env.KEEP_BUNDLES) || 5);
const appName = packageInfo.name || 'app';
const latestName = `${appName}-latest.tgz`;
const latestPath = join(buildOutDir, latestName);
const versionedBundle = new RegExp(`^${appName}-(\\d+)\\.(\\d+)\\.(\\d+)\\.tgz$`);

// Newest-first by semver, so the retention window survives out-of-order mtimes.
const bundles = (await readdir(buildOutDir))
  .map((file) => {
    const match = versionedBundle.exec(file);
    if (!match) return null;
    const rank = Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
    return { file, rank };
  })
  .filter(Boolean)
  .sort((a, b) => b.rank - a.rank);

const stale = bundles.slice(keepCount);
await Promise.all(stale.map(({ file }) => rm(join(buildOutDir, file), { force: true })));
await copyFile(tgzPath, latestPath);

console.log(`\nPackage created: ${tgzPath}`);
console.log(`Latest alias:    ${latestPath}`);
console.log(
  `Retained ${Math.min(bundles.length, keepCount)} of ${bundles.length} bundle(s)` +
    (stale.length > 0 ? `; pruned ${stale.length} older.` : '.'),
);
