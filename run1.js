const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 3000;

const repoPath = path.resolve(__dirname, '1');
const binaryName = '1';
const binaryPath = path.join(repoPath, binaryName);

// ---- config ----
const MAX_LINES = 500;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ENCODING = process.env.BINARY_ENCODING || 'utf8';
const USE_PTY = process.env.USE_PTY === '1';

// resource limits (mirror the python script)
const CPU_PERCENT = parseInt(process.env.CPU_PERCENT || '15', 10);
const MEMORY_MAX = process.env.MEMORY_MAX || '2G';
const MEMORY_ULIMIT_KB = parseInt(process.env.MEMORY_ULIMIT_KB || '2000000', 10); // ~2 GB

// ---- state ----
const logBuffer = [];
const clients = new Set();

// ---- helpers ----
function stripAnsi(s) {
  return s.replace(ANSI_OSC_RE, '').replace(ANSI_RE, '');
}

function decodeChunk(buf) {
  if (ENCODING === 'utf8' || ENCODING === 'utf-8') return buf.toString('utf8');
  return iconv.decode(buf, ENCODING);
}

function pushLines(chunk, carryRef, prefix = '') {
  const text = carryRef.value + chunk;
  const parts = text.split(/\r?\n/);
  carryRef.value = parts.pop();
  for (const line of parts) {
    const clean = stripAnsi(line);
    if (clean.trim()) broadcast(prefix + clean);
  }
}

const outCarry = { value: '' };
const errCarry = { value: '' };

function broadcast(line) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LINES) logBuffer.shift();
  for (const res of clients) {
    try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {}
  }
}

// true if `which <cmd>` succeeds
function which(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

// pick the best limiter, mirroring build_run_command() in the python script
function buildRunCommand(binaryRelPath) {
  if (which('systemd-run')) {
    return {
      cmd: `systemd-run --scope --user -p CPUQuota=${CPU_PERCENT}% -p MemoryMax=${MEMORY_MAX} -- ${binaryRelPath}`,
      limiter: 'systemd-run',
    };
  }
  if (which('cpulimit')) {
    return {
      cmd: `cpulimit --limit=${CPU_PERCENT} -- ${binaryRelPath}`,
      limiter: 'cpulimit',
    };
  }
  if (which('taskset')) {
    return {
      cmd: `taskset -c 0 ${binaryRelPath}`,
      limiter: 'taskset',
    };
  }
  return { cmd: binaryRelPath, limiter: 'none' };
}

// ---- launch ----
function launchBinary() {
  if (!fs.existsSync(repoPath)) {
    broadcast(`❌ Directory not found: ${repoPath}`);
    return;
  }
  if (!fs.existsSync(binaryPath)) {
    broadcast(`❌ Executable not found: ${binaryPath}`);
    return;
  }

  try {
    execSync(`chmod +x ${binaryName}`, { cwd: repoPath });
    broadcast(`✅ Made '${binaryName}' executable`);
  } catch (err) {
    broadcast(`⚠️ chmod failed: ${err.message}`);
  }

  const { cmd: runCmd, limiter } = buildRunCommand(`./${binaryName}`);
  if (limiter === 'none') {
    broadcast('⚠️  No CPU limiter found (systemd-run / cpulimit / taskset).');
    broadcast('    Install one, e.g.: sudo apt install cpulimit');
  }
  broadcast(`🚀 Starting ${binaryName} (encoding=${ENCODING}, limiter=${limiter}, cpu=${CPU_PERCENT}%, mem=${MEMORY_MAX}) ...`);
  broadcast(`   cmd: ${runCmd}`);

  let child;
  if (USE_PTY) {
    let pty;
    try { pty = require('node-pty'); }
    catch { broadcast('⚠️ USE_PTY=1 but node-pty not installed'); return; }
    // note: node-pty does not go through sh, so ulimit can't wrap it here
    child = pty.spawn(runCmd.split(' ')[0], runCmd.split(' ').slice(1), {
      cwd: repoPath,
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      env: process.env,
    });
    child.onData((d) => pushLines(d, outCarry));
    child.onExit(({ exitCode, signal }) => {
      broadcast(`⚠️ Process exited with code ${exitCode}${signal ? `, signal: ${signal}` : ''}`);
    });
    return;
  }

  // run through /bin/sh so `ulimit -v` can be applied in the same shell,
  // exactly like the python version's  `ulimit -v 2000000; <cmd>`
  const shellCmd = `ulimit -v ${MEMORY_ULIMIT_KB}; exec ${runCmd}`;
  child = spawn('/bin/sh', ['-c', shellCmd], {
    cwd: repoPath,
    env: process.env,
  });

  child.stdout.on('data', (buf) => pushLines(decodeChunk(buf), outCarry));
  child.stderr.on('data', (buf) => pushLines(decodeChunk(buf), errCarry, '[stderr] '));

  child.on('close', (code, signal) => {
    if (outCarry.value) { broadcast(stripAnsi(outCarry.value)); outCarry.value = ''; }
    if (errCarry.value) { broadcast('[stderr] ' + stripAnsi(errCarry.value)); errCarry.value = ''; }

    if (code === null && signal) {
      broadcast(`⚠️ Process killed by signal: ${signal}`);
    } else {
      broadcast(`⚠️ Process exited with code ${code}`);
    }
  });

  child.on('error', (err) => {
    broadcast(`❌ Spawn error: ${err.message}`);
  });
}

// ---- web UI ----
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  for (const line of logBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/status', (req, res) => {
  res.json({
    repoPath,
    binaryExists: fs.existsSync(binaryPath),
    encoding: ENCODING,
    usePty: USE_PTY,
    cpuPercent: CPU_PERCENT,
    memoryMax: MEMORY_MAX,
    memoryUlimitKb: MEMORY_ULIMIT_KB,
    lines: logBuffer.length,
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Web UI listening on port ${PORT}`);
  launchBinary();
});
