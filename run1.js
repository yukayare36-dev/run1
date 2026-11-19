const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const repoPath = path.resolve(__dirname, '1');
const binaryName = '1';
const binaryPath = path.join(repoPath, binaryName);

// ---- in-memory log buffer (last 500 lines) ----
const MAX_LINES = 500;
const logBuffer = [];
const clients = new Set();

function broadcast(line) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LINES) logBuffer.shift();
  for (const res of clients) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }
}

// ---- prepare and launch the binary ----
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

  broadcast(`🚀 Starting ./${binaryName} ...`);
  const child = spawn(`./${binaryName}`, [], { cwd: repoPath });

  child.stdout.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach(broadcast);
  });
  child.stderr.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach((l) => broadcast(`[stderr] ${l}`));
  });
  child.on('close', (code) => {
    broadcast(`⚠️ Process exited with code ${code}`);
  });
  child.on('error', (err) => {
    broadcast(`❌ Spawn error: ${err.message}`);
  });
}

// ---- web UI ----
app.use(express.static(path.join(__dirname, 'public')));

// SSE stream of logs
app.get('/api/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // replay buffered logs
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
    lines: logBuffer.length,
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Web UI listening on port ${PORT}`);
  launchBinary();
});
