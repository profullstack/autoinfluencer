// autoinfluencer desktop: the hosted app in a window, with the CLI and local MCP server
// bundled. `autoinfluencer-desktop --cli <command>` runs the CLI with Electron's own Node,
// so one install gives the app, the CLI and an MCP server for Claude/Cursor/Codex.
const { app, BrowserWindow, Menu, shell, clipboard, dialog } = require('electron');
const path = require('node:path');
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
        {
          label: 'Show CLI command',
          click: () =>
            dialog.showMessageBox({
              message: 'Run the bundled CLI',
              detail: `"${process.execPath}" --cli --help\n\nor anywhere with Node: npx -y @profullstack/autoinfluencer --help`,
            }),
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
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
void pathToFileURL;
