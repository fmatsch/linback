'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { analyze, ANALYZE_SCRIPT } = require('../core/analyze');
const { buildBackupCommand, runBackup, verifyBackup } = require('../core/backup');
const { inspectTarget, buildPlan, runRestore } = require('../core/restore');
const iso = require('../core/iso');

let win;
const jobs = {}; // name -> cancel function

function knownHostsFile() { return path.join(app.getPath('userData'), 'known_hosts.json'); }
function loadKnown() { try { return JSON.parse(fs.readFileSync(knownHostsFile(), 'utf8')); } catch { return {}; } }
function saveKnown(k) { fs.mkdirSync(path.dirname(knownHostsFile()), { recursive: true }); fs.writeFileSync(knownHostsFile(), JSON.stringify(k, null, 2)); }
const hostId = (c) => `${c.host}:${c.port || 22}`;
const withKnown = (c) => ({ ...c, knownFingerprint: loadKnown()[hostId(c)] });

const send = (channel) => (payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const errObj = (e) => ({ ok: false, error: { message: e.message || String(e), code: e.code, fingerprint: e.fingerprint, previous: e.previous } });
const safe = (fn) => async (_ev, ...args) => { try { return { ok: true, ...(await fn(...args)) }; } catch (e) { return errObj(e); } };

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 840, minWidth: 900, minHeight: 640, title: 'linback',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.LINBACK_SMOKE) { // developer smoke test: print renderer console, screenshot, quit
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message ?? e));
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 800));
      if (process.env.LINBACK_SMOKE_JS) await win.webContents.executeJavaScript(process.env.LINBACK_SMOKE_JS);
      await new Promise((r) => setTimeout(r, 500));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.LINBACK_SMOKE, img.toPNG());
      app.quit();
    });
  }
}

ipcMain.handle('dialog:dir', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:file', async (_e, title, filters) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:save', async (_e, title, defaultPath) => {
  const r = await dialog.showSaveDialog(win, { title, defaultPath });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app:defaults', () => ({ analyzeScript: ANALYZE_SCRIPT, home: app.getPath('documents') }));

ipcMain.handle('hostkey:trust', (_e, conn, fingerprint) => { const k = loadKnown(); k[hostId(conn)] = fingerprint; saveKnown(k); return true; });

ipcMain.handle('analyze', safe(async (conn) => ({ analysis: await analyze(withKnown(conn)) })));

ipcMain.handle('backup:preview', safe(async (analysis, options) => {
  const c = buildBackupCommand(analysis, options);
  return { script: c.script, ext: c.ext, excludes: c.excludes, mounts: ['/', ...c.mountArgs.map((m) => m.slice(1))] };
}));

ipcMain.handle('backup:start', safe(async (conn, analysis, options, baseDir) => {
  const emit = send('backup:event');
  try {
    const r = await runBackup({ conn: withKnown(conn), analysis, options, baseDir, emit, setCancel: (fn) => { jobs.backup = fn; } });
    return { outDir: r.outDir, manifest: r.manifest };
  } catch (e) { emit({ type: 'error', message: e.message }); throw e; } finally { delete jobs.backup; }
}));
ipcMain.handle('backup:cancel', () => { if (jobs.backup) jobs.backup(); return true; });

ipcMain.handle('verify:run', safe(async (dir, passphrase) => ({ result: await verifyBackup(dir, send('verify:event'), passphrase) })));

ipcMain.handle('restore:readManifest', safe(async (dir) => {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) throw new Error('Keine manifest.json im Ordner — das ist kein linback-Backup.');
  return { manifest: JSON.parse(fs.readFileSync(p, 'utf8')) };
}));
ipcMain.handle('restore:inspect', safe(async (conn) => ({ info: await inspectTarget(withKnown(conn)) })));
ipcMain.handle('restore:plan', (_e, plan) => buildPlan(plan));
ipcMain.handle('restore:start', safe(async (conn, backupDir, plan, passphrase) => {
  const emit = send('restore:event');
  try {
    await runRestore({ conn: withKnown(conn), backupDir, plan, passphrase, emit, setCancel: (fn) => { jobs.restore = fn; } });
    return {};
  } catch (e) { emit({ type: 'error', message: e.message }); throw e; } finally { delete jobs.restore; }
}));
ipcMain.handle('restore:cancel', () => { if (jobs.restore) jobs.restore(); return true; });

ipcMain.handle('iso:status', async () => iso.xorrisoStatus());
ipcMain.handle('iso:stage', safe(async (dir, backupDir) => ({ staged: iso.stageRestorePackage(dir, backupDir || null) })));
ipcMain.handle('iso:build', safe(async (opts) => {
  const emit = send('iso:event');
  const stage = path.join(app.getPath('temp'), 'linback-iso-stage-' + Date.now());
  iso.stageRestorePackage(stage, opts.includeArchive ? opts.backupDir : null);
  try { return { result: await iso.buildIso({ baseIso: opts.baseIso, outIso: opts.outIso, stageDir: stage, emit }) }; }
  finally { fs.rmSync(stage, { recursive: true, force: true }); }
}));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
