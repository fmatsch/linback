'use strict';
// Erzeugt build/icon.png (1024x1024) mit Electron selbst: npx electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e40af"/></linearGradient></defs>
    <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#g)"/>
    <g fill="none" stroke="#fff" stroke-width="64" stroke-linecap="round" stroke-linejoin="round">
      <path d="M700 330a250 250 0 1 0 38 330"/><path d="M760 190v150H610"/></g>
    <rect x="400" y="440" width="224" height="150" rx="24" fill="#fff"/><circle cx="450" cy="515" r="18" fill="#1e40af"/><rect x="490" y="500" width="100" height="30" rx="15" fill="#1e40af"/></svg>`;
  await w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`));
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(path.join(__dirname, 'icon.png'), (await w.webContents.capturePage()).toPNG());
  app.quit();
});
