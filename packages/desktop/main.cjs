// Octet desktop shell: UNBUILT AND UNTESTED SCAFFOLD. See README.md in this folder.
//
// Starts the daemon on a random free port, keeps the API token in memory, loads the UI, and
// stops the daemon when the window closes or the app quits.
'use strict';
const { app, BrowserWindow, dialog, shell } = require('electron');
const { execFileSync, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const DAEMON_MAIN = path.resolve(__dirname, '..', 'daemon', 'src', 'main.ts');
// Generated per launch and never written to disk. The daemon takes it from OCTET_TOKEN (and removes
// it from its environment), then injects it into the page it serves.
const token = randomBytes(24).toString('hex');

let daemon = null;
let quitting = false;

/** A Finder-launched app has no shell PATH, so ask a login shell where Node is. Needs Node 24+. */
function findNode() {
  if (process.env.OCTET_NODE) return process.env.OCTET_NODE;
  try {
    return execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8' }).trim().split('\n').pop();
  } catch {
    return 'node';
  }
}

/** Resolves with the port once the daemon says it is listening; rejects with its own message if it refuses. */
function startDaemon() {
  return new Promise((resolve, reject) => {
    daemon = spawn(findNode(), [DAEMON_MAIN, '--port=0'], {
      env: { ...process.env, OCTET_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    const onData = (chunk) => {
      text += chunk.toString();
      const m = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    };
    daemon.stdout.on('data', onData);
    daemon.stderr.on('data', (c) => { text += c.toString(); });
    daemon.once('error', (e) => reject(new Error(`could not start node: ${e.message}`)));
    daemon.once('exit', (code) => {
      if (!quitting) reject(new Error(text.trim() || `daemon exited with code ${code}`));
    });
  });
}

function stopDaemon() {
  quitting = true;
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM'); // the daemon releases its lock file on SIGTERM
}

async function createWindow() {
  const port = await startDaemon();
  const origin = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    width: 1280, height: 860, backgroundColor: '#000000', title: 'Octet',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // The UI is the only thing that may load here; anything else opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  await win.loadURL(`${origin}/`);
}

app.whenReady().then(createWindow).catch((e) => {
  dialog.showErrorBox('Octet could not start', String(e.message || e));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopDaemon);
process.on('exit', stopDaemon);
