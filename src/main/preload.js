'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['backup:event', 'restore:event', 'verify:event', 'iso:event']);
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  defaults: inv('app:defaults'),
  pickDir: inv('dialog:dir'),
  pickFile: inv('dialog:file'),
  pickSave: inv('dialog:save'),
  reveal: inv('shell:reveal'),
  trustHost: inv('hostkey:trust'),
  analyze: inv('analyze'),
  backupPreview: inv('backup:preview'),
  backupStart: inv('backup:start'),
  backupCancel: inv('backup:cancel'),
  verify: inv('verify:run'),
  readManifest: inv('restore:readManifest'),
  restoreInspect: inv('restore:inspect'),
  restorePlan: inv('restore:plan'),
  restoreStart: inv('restore:start'),
  restoreCancel: inv('restore:cancel'),
  isoStatus: inv('iso:status'),
  isoStage: inv('iso:stage'),
  isoBuild: inv('iso:build'),
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error('unknown channel');
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
