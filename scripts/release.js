import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkgPath = path.join(__dirname, '..', 'packages', 'cli', 'package.json');

// Parse args: node scripts/release.js <type> [--preid=rc] [--apply] [--force-tag]
const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const versionType = positionalArgs[0] || 'patch';
const isDryRun = !process.argv.includes('--apply');
const isForceTag = process.argv.includes('--force-tag');
const preidFlag = process.argv.find(a => a.startsWith('--preid='));
const DEFAULT_PREID = 'rc';
const preid = preidFlag ? preidFlag.split('=')[1] : DEFAULT_PREID;

const BUMP_TYPES = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease', 'tag'];

function runCommand(command) {
  try {
    console.log(`Executing: ${command}`);
    return execSync(command, { encoding: 'utf8', stdio: 'inherit' });
  } catch (_error) {
    console.error(`Error executing command: ${command}`);
    process.exit(1);
  }
}

/**
 * Parse a semver string into { major, minor, patch, preTag, preNum }.
 * e.g. "1.0.0-rc.2" → { major:1, minor:0, patch:0, preTag:"rc", preNum:2 }
 */
function parseSemver(version) {
  const [core, pre] = version.split('-');
  const [major, minor, patch] = core.split('.').map(Number);
  let preTag = null;
  let preNum = null;
  if (pre) {
    const parts = pre.split('.');
    preTag = parts[0];
    preNum = parts.length > 1 ? Number(parts[1]) : 0;
  }
  return { major, minor, patch, preTag, preNum };
}

function formatSemver({ major, minor, patch, preTag, preNum }) {
  const core = `${major}.${minor}.${patch}`;
  return preTag != null ? `${core}-${preTag}.${preNum}` : core;
}

function computeVersion(currentVersion) {
  if (BUMP_TYPES.includes(versionType)) {
    const v = parseSemver(currentVersion);

    switch (versionType) {
      case 'major': return formatSemver({ major: v.major + 1, minor: 0, patch: 0, preTag: null, preNum: null });
      case 'minor': return formatSemver({ major: v.major, minor: v.minor + 1, patch: 0, preTag: null, preNum: null });
      case 'patch': {
        // If currently a pre-release, "patch" promotes to the stable version
        if (v.preTag) return formatSemver({ ...v, preTag: null, preNum: null });
        return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1, preTag: null, preNum: null });
      }
      case 'premajor': return formatSemver({ major: v.major + 1, minor: 0, patch: 0, preTag: preid, preNum: 1 });
      case 'preminor': return formatSemver({ major: v.major, minor: v.minor + 1, patch: 0, preTag: preid, preNum: 1 });
      case 'prepatch': return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1, preTag: preid, preNum: 1 });
      case 'prerelease': {
        if (v.preTag === preid) return formatSemver({ ...v, preNum: v.preNum + 1 });
        return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1, preTag: preid, preNum: 1 });
      }
      case 'tag': return currentVersion; // no bump, just tag
    }
  }
  // Explicit version string (e.g. "1.0.0-rc.1")
  return versionType;
}

function writeVersion(newVersion) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const newVersion = computeVersion(pkg.version);
const tagName = `v${newVersion}`;

if (isDryRun) {
  console.log('=== DRY RUN (pass --apply to execute) ===');
  console.log(`  Current version : ${pkg.version}`);
  console.log(`  New version     : ${newVersion}`);
  console.log(`  Tag             : ${tagName}`);
  console.log(`  Bump type       : ${versionType}`);
  if (versionType.startsWith('pre')) console.log(`  Pre-release id  : ${preid}`);
  if (isForceTag) console.log('  Force tag       : yes (will delete existing tag)');
  console.log('=========================================');
  process.exit(0);
}

// Apply
const isTagOnly = versionType === 'tag' || newVersion === pkg.version;
if (!isTagOnly) {
  writeVersion(newVersion);
  console.log(`Updated ${pkgPath} to v${newVersion}`);
}

// Git workflow
runCommand('git add .');

// Check if there are changes to commit
try {
  execSync('git diff --staged --quiet', { encoding: 'utf8' });
  if (isTagOnly) console.log(`Tagging current version ${newVersion} (no version bump)`);
  else console.log('No version changes detected (already at this version)');
} catch (_e) {
  runCommand(`git commit -m "chore: release ${tagName}"`);
  runCommand('git push origin main');
}

if (isForceTag) {
  try {
    runCommand(`git tag -d ${tagName}`);
    runCommand(`git push origin :refs/tags/${tagName}`);
  } catch (_e) {
    // Ignore if tag doesn't exist
  }
}

runCommand(`git tag ${tagName}`);
runCommand(`git push origin ${tagName}`);

console.log(`\nSuccessfully released ${tagName}! 🎉`);
