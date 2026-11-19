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
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;   // CSI sequences
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // OSC sequences
const ENCODING = process.env.BINARY_ENCODING || 'utf8'; // 'utf8' | 'gbk' | 'latin1' ...
const USE_PTY = process.env.USE_PTY === '1';

// ---- state ----
const logBuffer = [];
const clients = new Set();
let lastBroadcast = 0;

// ---- helpers ----
function stripAnsi(s) {
  return s.replace(ANSI_OSC_RE, '').replace(ANSI_RE, '');
}

function decodeChunk(buf) {
  if (ENCODING === 'utf8' || ENCODING === 'utf-8') return buf.toString('utf8');
  return iconv.decode(buf, ENCODING);
}

// split a decoded chunk into lines, carrying over partial lines between chunks
let stdoutCarry = '';
let stderrCarry = '';

function pushLines(chunk, carryRef, prefix = '') {
  const text = carryRef.value + chunk;
  const parts = text.split(/\r?\n/);
  carryRef.value = parts.pop(); // last piece may be incomplete
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

  broadcast(`🚀 Starting ./${binaryName} (encoding=${ENCODING}) ...`);

  let child;
  if (USE_PTY) {
    // optional: real TTY, better for programs that demand one
    let pty;
    try { pty = require('node-pty'); }
    catch { broadcast('⚠️ USE_PTY=1 but node-pty not installed'); return; }
    child = pty.spawn(`./${binaryName}`, [], {
      cwd: repoPath,
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      env: process.env,
    });
    child.onData((d) => {
      pushLines(d, outCarry);
    });
    child.onExit(({ exitCode, signal }) => {
      broadcast(`⚠️ Process exited with code ${exitCode}${signal ? `, signal: ${signal}` : ''}`);
    });
    return;
  }

  // normal spawn
  child = spawn(`./${binaryName}`, [], {
    cwd: repoPath,
    env: process.env,
  });

  child.stdout.on('data', (buf) => {
    pushLines(decodeChunk(buf), outCarry);
  });
  child.stderr.on('data', (buf) => {
    pushLines(decodeChunk(buf), errCarry, '[stderr] ');
  });

  child.on('close', (code, signal) => {
    // flush partial lines
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
    lines: logBuffer.length,
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Web UI listening on port ${PORT}`);
  launchBinary();
});
