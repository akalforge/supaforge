import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkgPath = path.join(__dirname, '..', 'packages', 'cli', 'package.json');
const versionType = process.argv[2] || 'patch';
const isForceTag = process.argv.includes('--force-tag');

function runCommand(command) {
  try {
    console.log(`Executing: ${command}`);
    return execSync(command, { encoding: 'utf8', stdio: 'inherit' });
  } catch (_error) {
    console.error(`Error executing command: ${command}`);
    process.exit(1);
  }
}

function updateVersion() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  let newVersion = '';

  const parts = pkg.version.split('.').map(Number);
  if (versionType === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (versionType === 'minor') { parts[1]++; parts[2] = 0; }
  else if (versionType === 'patch') { parts[2]++; }
  else { newVersion = versionType; } // Explicit version

  if (!newVersion) newVersion = parts.join('.');

  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Updated ${pkgPath} to v${newVersion}`);

  return newVersion;
}

const newVersion = updateVersion();
const tagName = `v${newVersion}`;

// Git workflow
runCommand('git add .');

// Check if there are changes to commit
try {
  execSync('git diff --staged --quiet', { encoding: 'utf8' });
  console.log('No version changes detected (already at this version)');
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
