// autoinfluencer desktop: the hosted app in a window, with the CLI and local MCP server
// bundled. `autoinfluencer-desktop --cli <command>` runs the CLI with Electron's own Node,
// so one install gives the app, the CLI and an MCP server for Claude/Cursor/Codex.
const { app, BrowserWindow, Menu, shell, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const APP_URL = process.env.AUTOINFLUENCER_URL || 'https://influencer.marketing.pit.world';
const ALLOWED = new Set([new URL(APP_URL).origin, 'https://coinpayportal.com']);

const cliIndex = process.argv.indexOf('--cli');
if (cliIndex !== -1) {
  // Re-exec as plain Node so the CLI sees normal argv/stdio.
  const { spawnSync } = require('node:child_process');
  const bin = require.resolve('@profullstack/autoinfluencer/bin/autoinfluencer.js');
  const r = spawnSync(process.execPath, [bin, ...process.argv.slice(cliIndex + 1)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(r.status ?? 0);
}

function mcpConfig() {
  const bin = require.resolve('@profullstack/autoinfluencer/bin/autoinfluencer.js');
  return JSON.stringify(
    { mcpServers: { autoinfluencer: { command: process.execPath, args: [bin, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } } } },
    null,
    2,
  );
}

// ---- desktop environment: this computer does the app's browser work (posting, app capture)
// through the W3BS desktop layer, over the two-way channel the bundled connector opens.
let connector = null;
const tokenFile = () => path.join(app.getPath('userData'), 'desktop-token');
const savedToken = () => {
  try {
    return fs.readFileSync(tokenFile(), 'utf8').trim();
  } catch {
    return null;
  }
};

function startConnector(token) {
  stopConnector();
  const bin = require.resolve('@profullstack/autoinfluencer/bin/autoinfluencer.js');
  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'connector.log'), { flags: 'a' });
  connector = spawn(process.execPath, [bin, 'desktop', 'connect', '--url', APP_URL], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AUTOINFLUENCER_DESKTOP_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  connector.stdout.pipe(log);
  connector.stderr.pipe(log);
  connector.on('exit', (code) => {
    connector = null;
    // A crash or a network outage: try again in 30 s while a token is saved.
    if (code && savedToken()) setTimeout(() => savedToken() && !connector && startConnector(savedToken()), 30_000);
    menu();
  });
  menu();
}
function stopConnector() {
  const c = connector;
  connector = null;
  if (c) c.kill();
}

async function connectThisComputer() {
  const clip = clipboard.readText().trim();
  if (!clip.startsWith('dk_')) {
    await dialog.showMessageBox({
      message: 'Copy a desktop token first',
      detail: 'In the app open Desktops, add this computer, and press "Copy token". Then choose this menu item again.\n\nThis computer also needs the W3BS desktop layer once:\n  curl -fsSL https://w3bs.org/desktop/install.sh | sh\n  w3bs desktop agents add autoinfluencer --preset broad\n  w3bs desktop browser launch',
    });
    return;
  }
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(tokenFile(), clip, { mode: 0o600 });
  startConnector(clip);
  dialog.showMessageBox({ message: 'This computer is connected', detail: 'It stays connected while the app runs and reconnects when you open it. Jobs (posting, app capture) run through the W3BS desktop layer, which asks you once before an agent may drive.' });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: 'autoinfluencer',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Stay on our origin and CoinPay sign-in; everything else opens in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!ALLOWED.has(new URL(url).origin)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadURL(APP_URL);
  return win;
}

function menu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Agents',
      submenu: [
        {
          label: 'Copy MCP server config (local, bundled)',
          click: () => {
            clipboard.writeText(mcpConfig());
            dialog.showMessageBox({ message: 'Copied. Paste it into Claude Desktop, Cursor or any MCP client config.' });
          },
        },
        { label: 'Copy hosted MCP URL', click: () => clipboard.writeText(`${APP_URL}/mcp`) },
        { type: 'separator' },
        connector
          ? { label: 'Disconnect this computer (desktop environment)', click: () => { fs.rmSync(tokenFile(), { force: true }); stopConnector(); } }
          : { label: 'Connect this computer as a desktop environment…', click: connectThisComputer },
        { label: 'Open connector log', click: () => shell.openPath(path.join(app.getPath('userData'), 'connector.log')) },
        { type: 'separator' },
        {
          label: 'Show CLI command',
          click: () => {
            const bin = require.resolve('@profullstack/autoinfluencer/bin/autoinfluencer.js');
            const cmd = process.platform === 'win32'
              ? `set ELECTRON_RUN_AS_NODE=1 && "${process.execPath}" "${bin}" --help`
              : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${bin}" --help`;
            clipboard.writeText(cmd);
            dialog.showMessageBox({
              message: 'Bundled CLI command copied',
              detail: `${cmd}\n\nOr anywhere with Node: npx -y @profullstack/autoinfluencer --help`,
            });
          },
        },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'GitHub', click: () => shell.openExternal('https://github.com/profullstack/autoinfluencer') },
        { label: 'Open in browser', click: () => shell.openExternal(APP_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(() => {
  menu();
  createWindow();
  if (savedToken()) startConnector(savedToken());
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('before-quit', stopConnector);
void pathToFileURL;
