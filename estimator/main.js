'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const ai = require('./ai');
const vdata = require('./vehicledata');

const KEY_FILE = () => path.join(app.getPath('userData'), 'ai-key.bin');

function loadKey() {
  try {
    const buf = fs.readFileSync(KEY_FILE());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch (e) { return null; }
}
function saveKey(key) {
  if (!key) { try { fs.unlinkSync(KEY_FILE()); } catch (e) { /* none */ } ai.setApiKey(null); return; }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
  fs.writeFileSync(KEY_FILE(), data);
  ai.setApiKey(key);
}

// Data-connection credentials (DVLA, DVSA MOT History), encrypted like the AI key
const DATA_FILE = () => path.join(app.getPath('userData'), 'data-keys.bin');
function loadDataKeys() {
  try {
    const buf = fs.readFileSync(DATA_FILE());
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
  } catch (e) { return {}; }
}
function saveDataKeys(obj) {
  const s = JSON.stringify(obj);
  fs.writeFileSync(DATA_FILE(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s, 'utf8'));
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 680,
    title: 'Engineer Report Studio',
    backgroundColor: '#f3f5f8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // Links that open a new window go to the system browser, and only when they are web links:
  // never hand file:, smb:, ms-msdt: or other protocol URLs (e.g. from AI web-search results) to the OS.
  const isWeb = (url) => /^https?:\/\//i.test(String(url || ''));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // The app itself is local files: block any navigation of the window away from them.
  win.webContents.on('will-navigate', (e, url) => {
    if (/^file:/i.test(String(url || ''))) return;
    e.preventDefault();
    if (isWeb(url)) shell.openExternal(url).catch(() => {});
  });
}

// Wrap AI calls so errors come back as friendly messages
const wrap = (fn) => async (_e, payload) => {
  try { return { ok: true, result: await fn(payload) }; } catch (err) { return { ok: false, error: ai.describeError(err) }; }
};

ipcMain.handle('ai:status', () => ({ hasKey: !!loadKey() || !!process.env.ANTHROPIC_API_KEY, encrypted: safeStorage.isEncryptionAvailable() }));
ipcMain.handle('ai:setKey', (_e, key) => { saveKey((key || '').trim()); return { ok: true }; });
ipcMain.handle('ai:test', wrap((p) => ai.testConnection(p || {})));
ipcMain.handle('ai:analysePhotos', wrap((p) => ai.analysePhotos(p)));
ipcMain.handle('ai:draftNarrative', wrap((p) => ai.draftNarrative(p)));

ipcMain.handle('ai:valuation', wrap((p) => ai.valuationAssistant(p)));

const plainWrap = (fn) => async (_e, payload) => {
  try { return { ok: true, result: await fn(payload) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
};
ipcMain.handle('data:status', () => {
  const k = loadDataKeys();
  return { dvla: !!k.dvla, mot: vdata.motConfigured(k), motTokenUrl: !!(k.motTokenUrl || k.motTenantId), encrypted: safeStorage.isEncryptionAvailable() };
});
const DATA_KEY_NAMES = ['dvla', 'motClientId', 'motClientSecret', 'motApiKey', 'motTokenUrl', 'motTenantId', 'motScope'];
ipcMain.handle('data:setKeys', (_e, patch) => {
  const k = loadDataKeys();
  for (const [name, val] of Object.entries(patch || {})) {
    if (!DATA_KEY_NAMES.includes(name)) continue; // only known credential fields are stored
    if (val === null || val === '') delete k[name]; else if (typeof val === 'string') k[name] = val.trim();
  }
  if (patch && patch.motTokenUrl) delete k.motTenantId; // a full token URL supersedes a bare tenant ID
  saveDataKeys(k);
  return { ok: true };
});
ipcMain.handle('data:dvla', plainWrap((p) => vdata.dvlaLookup(p && p.reg, loadDataKeys().dvla, p && p.env)));
ipcMain.handle('data:mot', plainWrap(async (p) => vdata.normaliseMot(await vdata.motLookup(p && p.id, loadDataKeys(), p && p.by))));

ipcMain.handle('pdf:export', async (_e, { html, header, footer, fileName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save report as PDF', defaultPath: (fileName || 'engineering-report') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const tmp = path.join(app.getPath('temp'), `report-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await pdfWin.loadFile(tmp);
    const pdf = await pdfWin.webContents.printToPDF({
      pageSize: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: header, footerTemplate: footer,
      margins: { marginType: 'custom', top: 0.98, bottom: 1.02, left: 0.63, right: 0.63 }, preferCSSPageSize: true
    });
    fs.writeFileSync(filePath, pdf);
    shell.openPath(filePath);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    pdfWin.destroy();
    fs.unlink(tmp, () => {});
  }
});

ipcMain.handle('file:save', async (_e, { content, fileName, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: fileName, filters });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath };
});

app.whenReady().then(() => {
  const k = loadKey();
  if (k) ai.setApiKey(k);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] }
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
