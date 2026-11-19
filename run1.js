const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCommand(command, cwd = process.cwd()) {
  try {
    const output = execSync(command, { cwd, encoding: 'utf-8', stdio: 'pipe' });
    console.log(`✅ Command succeeded: ${command}`);
    if (output) console.log(output);
    return true;
  } catch (err) {
    console.error(`❌ Command failed: ${command}`);
    console.error(`Error: ${err.stderr || err.message}`);
    return false;
  }
}

function main() {
  const repoUrl = 'https://github.com/yukayare36-dev/1.git';
  console.log(`Cloning repository: ${repoUrl}`);

  // 1. Clone the repository
  if (!runCommand(`git clone ${repoUrl}`)) {
    process.exit(1);
  }

  // 2. Move into the directory
  const repoDir = '1';
  console.log(`Changing directory to: ${repoDir}`);

  if (!fs.existsSync(repoDir)) {
    console.error(`❌ Directory '${repoDir}' not found after cloning`);
    process.exit(1);
  }

  const repoPath = path.resolve(repoDir);

  // 3. Make the file executable
  console.log("Making file '1' executable...");
  if (!runCommand('chmod +x 1', repoPath)) {
    process.exit(1);
  }

  // 4. Run the executable
  console.log('Running ./1...');
  console.log('-'.repeat(50));
  if (!runCommand('./1', repoPath)) {
    process.exit(1);
  }
  console.log('-'.repeat(50));
}

main();
