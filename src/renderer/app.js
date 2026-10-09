'use strict';
/* global api */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GiB = 1024 ** 3;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
}
function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ' h ' : '') + (h || m ? m + ' min ' : '') + s + ' s';
}
function setStatus(el, text, cls = '') { el.textContent = text; el.className = 'status ' + cls; }

const state = { analysis: null, conn: null, backupBase: '', lastBackup: '', restoreDir: '', restoreManifest: null, target: null, targetConn: null, isoBackup: '', isoBase: '' };

// ------------------------------------------------------------------ tabs
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
}));
const gotoTab = (n) => $(`#tabs button[data-tab="${n}"]`).click();

// ------------------------------------------------------------------ helpers
function log(el, line, level = '') {
  el.hidden = false;
  const d = document.createElement('div');
  if (level) d.className = level;
  d.textContent = line;
  el.appendChild(d);
  while (el.childNodes.length > 2500) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function setBar(bar, percent) {
  const wrap = bar.parentElement;
  if (percent == null) { wrap.classList.add('indeterminate'); bar.style.width = ''; }
  else { wrap.classList.remove('indeterminate'); bar.style.width = Math.max(0, Math.min(100, percent)) + '%'; }
}

const hk = $('#hostkey');
function askHostKey(err, conn) {
  return new Promise((resolve) => {
    const changed = err.code === 'HOSTKEY_CHANGED';
    $('#hk-title').textContent = changed ? '⚠ Host-Schlüssel hat sich geändert' : 'Unbekannter Server';
    $('#hk-text').textContent = changed
      ? `Der Server ${conn.host} präsentiert einen anderen Schlüssel als beim letzten Mal. Das ist normal, wenn du gerade ein neues Rescue-System gestartet oder den Server neu installiert hast — sonst könnte jemand die Verbindung abfangen. Alter Fingerabdruck: ${err.previous}. Neuer Fingerabdruck:`
      : `Du verbindest dich zum ersten Mal mit ${conn.host}. Vergleiche den Fingerabdruck wenn möglich mit dem, den dein Anbieter anzeigt:`;
    $('#hk-fp').textContent = err.fingerprint;
    const done = (v) => { hk.close(); $('#hk-yes').onclick = $('#hk-no').onclick = null; resolve(v); };
    $('#hk-yes').onclick = () => done(true);
    $('#hk-no').onclick = () => done(false);
    hk.showModal();
  });
}
/** Calls call(conn); on an unknown/changed host key asks the user, stores trust and retries. */
async function withTrust(call, conn) {
  let r = await call(conn);
  while (!r.ok && (r.error.code === 'HOSTKEY_UNKNOWN' || r.error.code === 'HOSTKEY_CHANGED')) {
    if (!(await askHostKey(r.error, conn))) return { ok: false, error: { message: 'Host-Schlüssel nicht akzeptiert.' } };
    await api.trustHost(conn, r.error.fingerprint);
    r = await call(conn);
  }
  return r;
}

function keyPicker(pickBtn, clearBtn, input) {
  $(pickBtn).onclick = async () => { const f = await api.pickFile('SSH-Schlüssel wählen', []); if (f) $(input).value = f; };
  $(clearBtn).onclick = () => { $(input).value = ''; };
}

// ------------------------------------------------------------------ init
(async () => {
  const d = await api.defaults();
  $('#analyze-script').textContent = d.analyzeScript;
  state.backupBase = d.home.replace(/\/?$/, '/') + 'linback-backups';
  $('#b-dir').value = state.backupBase;
  const saved = (() => { try { return JSON.parse(localStorage.getItem('linback.conn') || '{}'); } catch { return {}; } })();
  if (saved.host) { $('#c-host').value = saved.host; $('#c-port').value = saved.port || 22; $('#c-user').value = saved.username || 'root'; $('#c-key').value = saved.keyPath || ''; }
  refreshIsoStatus();
})();

// ------------------------------------------------------------------ 1: connect & analyze
keyPicker('#c-key-pick', '#c-key-clear', '#c-key');
function readConn() {
  return {
    host: $('#c-host').value.trim(), port: Number($('#c-port').value) || 22, username: $('#c-user').value.trim() || 'root',
    password: $('#c-pass').value || undefined, keyPath: $('#c-key').value || undefined, passphrase: $('#c-pass2').value || undefined,
    sudo: $('#c-sudo').checked,
  };
}
$('#conn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const conn = readConn();
  if (!conn.host) return;
  const st = $('#c-status'); const btn = $('#c-go');
  btn.disabled = true; setStatus(st, 'Verbinde und analysiere … (kann einige Sekunden dauern)');
  const r = await withTrust((c) => api.analyze(c), conn);
  btn.disabled = false;
  if (!r.ok) { setStatus(st, '✗ ' + r.error.message, 'err'); return; }
  try { localStorage.setItem('linback.conn', JSON.stringify({ host: conn.host, port: conn.port, username: conn.username, keyPath: conn.keyPath })); } catch { /* */ }
  state.analysis = r.analysis; state.conn = conn;
  setStatus(st, '✓ Analyse abgeschlossen', 'ok');
  renderAnalysis(r.analysis);
  updateEncUi();
  updateBackupPreview();
});

function flattenDisks(devs, depth = 0, out = []) {
  for (const d of devs || []) { out.push({ ...d, depth }); flattenDisks(d.children, depth + 1, out); }
  return out;
}
function renderAnalysis(a) {
  const used = a.usedBytes;
  const rows = flattenDisks(a.lsblk).filter((d) => d.type !== 'loop' && d.type !== 'rom')
    .map((d) => `<tr><td style="padding-left:${8 + d.depth * 16}px">${esc(d.name)}</td><td>${esc(d.type)}</td><td class="num">${fmtBytes(+d.size)}</td><td>${esc(d.fstype || '')}</td><td>${esc(d.mountpoint || '')}</td></tr>`).join('');
  const mrows = a.backupMounts.map((m) => `<tr><td>${esc(m.target)}</td><td>${esc(m.type)}</td><td class="num">${fmtBytes(m.used)}</td><td class="num">${fmtBytes(m.size)}</td></tr>`).join('');
  const notes = a.warnings.length
    ? `<ul class="notes">${a.warnings.map((w) => `<li class="${w.level}">${esc(w.text)}</li>`).join('')}</ul>`
    : '<p class="muted">Keine Auffälligkeiten.</p>';
  $('#analysis').innerHTML = `
  <div class="cards">
    <div class="card"><h3>System</h3><dl class="kv">
      <dt>Hostname</dt><dd>${esc(a.hostname)}</dd><dt>Betriebssystem</dt><dd>${esc(a.os.prettyName)}</dd>
      <dt>Kernel</dt><dd>${esc(a.kernel)}</dd><dt>Architektur</dt><dd>${esc(a.arch)}</dd>
      <dt>Boot-Modus</dt><dd>${a.bootMode === 'uefi' ? 'UEFI' : 'BIOS (Legacy)'}</dd>
      <dt>CPU</dt><dd>${esc(a.cpu.model)} (${a.cpu.cores} Kerne)</dd><dt>RAM / Swap</dt><dd>${fmtBytes(a.memTotal)} / ${fmtBytes(a.swapTotal)}</dd>
      <dt>Pakete</dt><dd>${a.packages}</dd><dt>Angemeldet als root</dt><dd>${a.isRoot ? 'ja' : 'nein'}</dd>
      <dt>Host-Schlüssel</dt><dd><code>${esc(a.fingerprint || '')}</code></dd></dl></div>
    <div class="card"><h3>Was gesichert wird</h3>
      <p>Belegter Platz: <b>${fmtBytes(used)}</b> (Backup später typisch 30–60 % davon, je nach Daten).</p>
      <table><tr><th>Mountpoint</th><th>FS</th><th>belegt</th><th>Größe</th></tr>${mrows}</table>
      <p class="muted">Nicht gesichert: tmpfs, /proc, /sys, /dev, /run, Netzlaufwerke, EFI-Partition (wird bei der Wiederherstellung neu erzeugt).</p></div>
    <div class="card full"><h3>Hinweise</h3>${notes}</div>
    <div class="card full"><h3>Datenträger</h3><table><tr><th>Gerät</th><th>Typ</th><th>Größe</th><th>Dateisystem</th><th>Mountpoint</th></tr>${rows}</table>
      ${a.hasRaid ? `<pre class="code">${esc(a.mdstat)}</pre>` : ''}</div>
    <div class="card full"><h3>Netzwerk</h3><pre class="code">${esc(a.net || '–')}</pre>${a.netplan ? `<pre class="code">${esc(a.netplan)}</pre>` : ''}</div>
  </div>
  <p><button id="to-backup" class="primary">Weiter zu 2 · Backup →</button></p>`;
  $('#to-backup').onclick = () => gotoTab(2);
}

// ------------------------------------------------------------------ 2: backup
$('#b-dir-pick').onclick = async () => { const d = await api.pickDir('Zielordner für Backups'); if (d) { $('#b-dir').value = d; } };
function backupOptions() {
  return {
    compression: $('#b-comp').value, level: $('#b-level').value ? Number($('#b-level').value) : undefined, nice: $('#b-nice').checked,
    extraExcludes: $('#b-excl').value.split('\n').map((s) => s.trim()).filter(Boolean), preCommand: $('#b-pre').value,
    passphrase: $('#b-enc').checked ? $('#b-pass').value : undefined,
  };
}
let previewTimer;
function updateBackupPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    if (!state.analysis) return;
    const r = await api.backupPreview(state.analysis, { ...backupOptions(), passphrase: undefined });
    if (!r.ok) return;
    $('#b-preview').textContent = (backupOptions().preCommand.trim() ? `# 1) vorbereitender Befehl:\n${backupOptions().preCommand.trim()}\n\n# 2) Backup-Strom:\n` : '') + r.script;
    $('#b-preview-note').textContent = `Dateiendung: .${r.ext} · gesicherte Mountpoints: ${r.mounts.join(', ')} · ${r.excludes.length} Ausschlussmuster`;
  }, 150);
}
function updateEncUi() {
  const on = $('#b-enc').checked;
  $('#b-pass').disabled = $('#b-pass2').disabled = !on;
  const bad = on && ($('#b-pass').value.length < 12 || $('#b-pass').value !== $('#b-pass2').value);
  $('#b-go').disabled = !state.analysis || state.analysis.warnings.some((w) => w.level === 'error') || bad;
  if (on && $('#b-pass').value) {
    setStatus($('#b-status'), $('#b-pass').value.length < 12 ? 'Passphrase zu kurz (mind. 12 Zeichen).' : ($('#b-pass').value !== $('#b-pass2').value ? 'Passphrasen stimmen nicht überein.' : ''), 'err');
  } else if (!on) setStatus($('#b-status'), '⚠ Backup wird unverschlüsselt gespeichert.', 'err');
  else setStatus($('#b-status'), '');
}
['#b-enc', '#b-pass', '#b-pass2'].forEach((s) => $(s).addEventListener('input', updateEncUi));
['#b-comp', '#b-level', '#b-nice', '#b-excl', '#b-pre'].forEach((s) => $(s).addEventListener('input', updateBackupPreview));

let offBackup = null;
$('#b-go').onclick = async () => {
  if (!state.analysis) return;
  const bar = $('#b-bar'); const stats = $('#b-stats'); const lg = $('#b-log');
  lg.textContent = ''; lg.hidden = true; $('#b-result').innerHTML = '';
  $('#b-progress').hidden = false; setBar(bar, null); stats.textContent = 'Starte …';
  $('#b-go').disabled = true; $('#b-cancel').hidden = false;
  setStatus($('#b-status'), 'Backup läuft …');
  offBackup?.();
  offBackup = api.on('backup:event', (e) => {
    if (e.type === 'log') log(lg, e.line, e.level === 'warn' ? 'warn' : '');
    else if (e.type === 'step') log(lg, '▶ ' + e.text, 'step');
    else if (e.type === 'progress') {
      setBar(bar, e.percent);
      stats.textContent = `${fmtBytes(e.bytes)} heruntergeladen` + (e.percent != null ? ` · ca. ${e.percent.toFixed(0)} % (${fmtBytes(e.srcBytes)} von ${fmtBytes(e.total)} gelesen)` : '')
        + ` · ${fmtBytes(e.speed)}/s · ${fmtDur(e.elapsed)}` + (e.eta ? ` · noch ca. ${fmtDur(e.eta)}` : '');
    }
  });
  const r = await withTrust((c) => api.backupStart(c, state.analysis, backupOptions(), $('#b-dir').value), state.conn);
  updateEncUi(); $('#b-cancel').hidden = true;
  if (!r.ok) {
    setStatus($('#b-status'), '✗ ' + r.error.message, 'err');
    $('#b-result').innerHTML = `<div class="result err"><b>Backup fehlgeschlagen.</b><br>${esc(r.error.message)}</div>`;
    return;
  }
  setBar(bar, 100); setStatus($('#b-status'), '✓ Fertig', 'ok'); $('#b-pass').value = $('#b-pass2').value = '';
  state.lastBackup = r.outDir; $('#v-dir').value = r.outDir; $('#v-go').disabled = false;
  const m = r.manifest;
  $('#b-result').innerHTML = `<div class="result ok"><b>✓ Backup abgeschlossen</b><dl class="kv" style="margin-top:8px">
    <dt>Ordner</dt><dd>${esc(r.outDir)}</dd><dt>Archiv</dt><dd>${esc(m.archive.file)} · ${fmtBytes(m.archive.size)}</dd>
    <dt>Verschlüsselung</dt><dd>${m.archive.encryption ? 'AES-256 (Passphrase nötig — gut aufbewahren!)' : '<span class="warn-text">keine</span>'}</dd>
    <dt>SHA-256</dt><dd><code>${esc(m.archive.sha256)}</code></dd><dt>Dauer</dt><dd>${fmtDur(m.durationSec)}</dd></dl>
    ${m.exitCode === 1 ? '<p class="warn-text">Einige Dateien haben sich während des Backups verändert (normal bei laufenden Servern).</p>' : ''}
    <p><button id="b-reveal">Im Finder/Explorer zeigen</button> <button id="b-next" class="primary">Weiter zu 3 · Prüfen →</button></p></div>`;
  $('#b-reveal').onclick = () => api.reveal(r.outDir);
  $('#b-next').onclick = () => gotoTab(3);
};
$('#b-cancel').onclick = () => api.backupCancel();

// ------------------------------------------------------------------ 3: verify
$('#v-pick').onclick = async () => { const d = await api.pickDir('Backup-Ordner wählen'); if (d) { $('#v-dir').value = d; $('#v-go').disabled = false; } };
$('#v-go').onclick = async () => {
  const dir = $('#v-dir').value; if (!dir) return;
  $('#v-go').disabled = true; $('#v-result').innerHTML = ''; $('#v-progress').hidden = false; setBar($('#v-bar'), 0);
  setStatus($('#v-status'), 'Prüfe …');
  const t0 = Date.now();
  const off = api.on('verify:event', (e) => {
    if (e.type === 'progress') {
      const sp = e.bytes / Math.max((Date.now() - t0) / 1000, 0.5);
      setBar($('#v-bar'), e.percent); $('#v-stats').textContent = `${e.percent.toFixed(0)} % · ${fmtBytes(e.bytes)} von ${fmtBytes(e.total)} · ${fmtBytes(sp)}/s`;
    }
  });
  const r = await api.verify(dir, $('#v-pass').value || undefined);
  off(); $('#v-go').disabled = false;
  if (!r.ok) { setStatus($('#v-status'), '✗ ' + r.error.message, 'err'); return; }
  const v = r.result, m = v.manifest;
  setStatus($('#v-status'), v.ok ? '✓ Backup ist intakt' : '✗ Backup ist beschädigt oder Passphrase falsch', v.ok ? 'ok' : 'err');
  const hmacLine = !v.encrypted ? '' : v.hmacChecked
    ? `<dt>HMAC (Passphrase)</dt><dd>${v.hmacOk ? '✓ stimmt — Passphrase korrekt, Archiv nicht manipuliert' : '✗ stimmt NICHT — falsche Passphrase oder Archiv verändert'}</dd>`
    : '<dt>HMAC (Passphrase)</dt><dd class="warn-text">nicht geprüft (keine Passphrase eingegeben)</dd>';
  $('#v-result').innerHTML = `<div class="result ${v.ok ? 'ok' : 'err'}"><b>${v.ok ? '✓ Prüfsumme stimmt überein — das Archiv ist vollständig und unverändert.' : '✗ Das Archiv stimmt nicht mit dem Manifest überein bzw. die Passphrase ist falsch.'}</b>
    <dl class="kv" style="margin-top:8px"><dt>Quelle</dt><dd>${esc(m.source.hostname || m.source.host)} · ${esc(m.source.os?.prettyName || '')} · ${esc(m.source.arch)}</dd>
    <dt>Erstellt</dt><dd>${esc(m.created)}</dd><dt>Größe</dt><dd>${fmtBytes(v.size)} ${v.sizeOk ? '' : '(erwartet ' + fmtBytes(m.archive.size) + ')'}</dd>
    <dt>SHA-256 erwartet</dt><dd><code>${esc(m.archive.sha256)}</code></dd><dt>SHA-256 berechnet</dt><dd><code>${esc(v.hash)}</code></dd>${hmacLine}
    <dt>Gesichert</dt><dd>${esc((m.tar.mounts || []).join(', '))}</dd></dl></div>`;
};

// ------------------------------------------------------------------ 4: restore
$('#r-pick').onclick = async () => {
  const d = await api.pickDir('Backup-Ordner wählen'); if (!d) return;
  const r = await api.readManifest(d);
  if (!r.ok) { $('#r-manifest').innerHTML = `<div class="result err">${esc(r.error.message)}</div>`; return; }
  state.restoreDir = d; state.restoreManifest = r.manifest; $('#r-dir').value = d;
  $('#r-pass-wrap').hidden = !r.manifest.archive.encryption; $('#r-pass').value = '';
  const m = r.manifest;
  $('#r-manifest').innerHTML = `<div class="result"><dl class="kv"><dt>Quelle</dt><dd>${esc(m.source.hostname || m.source.host)} · ${esc(m.source.os?.prettyName || '')}</dd>
    <dt>Architektur</dt><dd>${esc(m.source.arch)}</dd><dt>Archiv</dt><dd>${esc(m.archive.file)} · ${fmtBytes(m.archive.size)}${m.archive.encryption ? ' · 🔒 verschlüsselt' : ''}</dd>
    <dt>Daten (unkomprimiert)</dt><dd>ca. ${fmtBytes(m.source.usedBytes)}</dd><dt>Erstellt</dt><dd>${esc(m.created)}</dd></dl></div>`;
  updateRestoreGate(); updatePlan();
};
keyPicker('#t-key-pick', '#t-key-clear', '#t-key');
function readTarget() {
  return { host: $('#t-host').value.trim(), port: Number($('#t-port').value) || 22, username: $('#t-user').value.trim() || 'root', password: $('#t-pass').value || undefined, keyPath: $('#t-key').value || undefined };
}
$('#t-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const conn = readTarget(); if (!conn.host) return;
  $('#t-go').disabled = true; setStatus($('#t-status'), 'Verbinde und prüfe Zielsystem …');
  const r = await withTrust((c) => api.restoreInspect(c), conn);
  $('#t-go').disabled = false;
  if (!r.ok) { setStatus($('#t-status'), '✗ ' + r.error.message, 'err'); return; }
  state.target = r.info; state.targetConn = conn;
  setStatus($('#t-status'), '✓ Zielsystem erreichbar', 'ok');
  renderTarget(r.info);
});

function renderTarget(t) {
  const m = state.restoreManifest;
  const notes = [];
  if (t.arch !== 'x86_64') notes.push(['error', `Zielarchitektur ${t.arch} wird nicht unterstützt (nur x86_64).`]);
  if (m && m.source.arch && m.source.arch !== t.arch) notes.push(['error', `Backup-Architektur (${m.source.arch}) passt nicht zum Zielsystem (${t.arch}).`]);
  if (t.missing.length) notes.push(['info', `Fehlende Werkzeuge werden automatisch per apt nachinstalliert: ${t.missing.join(', ')}`]);
  if (m && m.source.bootMode && m.source.bootMode !== t.bootMode) notes.push(['info', `Quelle bootete per ${m.source.bootMode.toUpperCase()}, das Ziel per ${t.bootMode.toUpperCase()}. Kein Problem: Der Bootloader wird passend zum Ziel installiert.`]);
  const gib = (b) => (b / GiB).toFixed(0) + ' GB';
  const used = (name) => flattenDisks(t.tree).filter((d) => d.path && d.path.startsWith(name) && d.fstype).map((d) => `${d.fstype}${d.label ? ' „' + d.label + '"' : ''}`).join(', ') || 'leer / unbekannt';
  $('#t-info').innerHTML = `<div class="card"><dl class="kv"><dt>Architektur</dt><dd>${esc(t.arch)}</dd><dt>Boot-Modus</dt><dd>${t.bootMode === 'uefi' ? 'UEFI' : 'BIOS (Legacy)'}</dd>
    <dt>Netzwerk-Interface</dt><dd>${esc(t.nic.name)} (${esc(t.nic.mac)})</dd><dt>Host-Schlüssel</dt><dd><code>${esc(t.fingerprint || '')}</code></dd></dl>
    ${notes.length ? `<ul class="notes">${notes.map(([l, x]) => `<li class="${l}">${esc(x)}</li>`).join('')}</ul>` : ''}
    <h3 style="margin:14px 0 4px">Platten im Zielsystem — wähle die Ziel-Platte(n)</h3>
    ${t.disks.map((d) => `<label class="disk check"><input type="checkbox" class="disk-pick" value="${esc(d.path)}" data-size="${d.size}">
      <span><b>${esc(d.path)}</b> · ${gib(+d.size)} · ${esc(d.model || '')} ${d.tran ? '(' + esc(d.tran) + ')' : ''}<br><span class="muted">bisheriger Inhalt: ${esc(used(d.path))}</span></span></label>`).join('') || '<p class="muted">Keine Platten gefunden.</p>'}</div>`;
  $$('.disk-pick').forEach((c) => c.addEventListener('change', () => { updatePlan(); updateRestoreGate(); }));
  $('#r-plan-section').hidden = false;
  updatePlan();
}

function planParams() {
  const picks = $$('.disk-pick').filter((c) => c.checked);
  return {
    layout: $('input[name=layout]:checked').value,
    disks: picks.map((c) => ({ path: c.value, size: Number(c.dataset.size) })),
    bootMode: state.target ? state.target.bootMode : 'bios',
    swapGb: Number($('#r-swap').value) || 0, bootMb: Number($('#r-boot').value) || 1024,
    neededBytes: state.restoreManifest ? state.restoreManifest.source.usedBytes : 0,
    net: $('input[name=net]:checked').value,
  };
}
async function updatePlan() {
  if (!state.target) return;
  const p = planParams();
  const plan = await api.restorePlan(p);
  const total = plan.parts.reduce((s, x) => s + x.size, 0) || 1;
  const bar = `<div class="parts">${plan.parts.map((x) => `<span class="${x.label === 'root' ? 'root' : ''}" style="flex:${Math.max(x.size / total, 0.06)}">${esc(x.label)}</span>`).join('')}</div>`;
  const rows = plan.parts.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${fmtBytes(x.size)}</td><td>${esc(x.fs)}</td><td>${esc(x.mount)}</td><td>${esc(x.note)}</td></tr>`).join('');
  $('#r-preview').innerHTML = `<div class="card"><h3>So wird jede gewählte Platte aufgeteilt (GPT, ${p.bootMode === 'uefi' ? 'UEFI' : 'BIOS'})</h3>
    ${p.disks.length ? bar : '<p class="muted">Wähle oben mindestens eine Platte.</p>'}
    ${p.disks.length ? `<table><tr><th>Partition</th><th>Größe</th><th>Dateisystem</th><th>Mount</th><th>Hinweis</th></tr>${rows}</table>` : ''}
    ${plan.errors.length ? `<ul class="notes">${plan.errors.map((x) => `<li class="error">${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="muted">${p.layout === 'raid1' ? 'Die gleiche Aufteilung entsteht auf beiden Platten; die Partitionen werden zu RAID1-Arrays (md) gespiegelt. Die RAID-Synchronisation läuft nach dem Neustart im Hintergrund weiter.' : ''}
    Es entsteht immer ein getrenntes /boot und — bei UEFI — eine EFI-Partition. Das Dateisystem ist ext4.</p></div>`;
  state.planErrors = plan.errors;
  updateRestoreGate();
}
['input[name=layout]', 'input[name=net]', '#r-swap', '#r-boot'].forEach((s) => $$(s).forEach((e) => e.addEventListener('input', () => { updatePlan(); })));
$('#r-confirm').addEventListener('input', updateRestoreGate);
$('#r-pass').addEventListener('input', updateRestoreGate);
function updateRestoreGate() {
  const ok = state.restoreManifest && state.target && state.target.arch === 'x86_64' && state.restoreManifest.source.arch === state.target.arch
    && planParams().disks.length > 0 && !(state.planErrors && state.planErrors.length) && $('#r-confirm').value.trim() === 'LÖSCHEN'
    && (!state.restoreManifest.archive.encryption || $('#r-pass').value.length > 0);
  $('#r-go').disabled = !ok;
}

const PHASES = [
  ['verify', 'Archiv prüfen', 'SHA-256 gegen das Manifest — bei Fehler wird nichts gelöscht.'],
  ['connect', 'Verbinden & Skript hochladen', 'linback-restore.sh nach /tmp des Rescue-Systems kopieren.'],
  ['deps', 'Werkzeuge bereitstellen', 'Fehlende Programme per apt nachinstallieren.'],
  ['prepare', 'Platten vorbereiten (löscht Daten)', 'Alte RAIDs lösen, Platten leeren, GPT/RAID/ext4/Swap anlegen, nach /mnt/linback-target mounten.'],
  ['extract', 'Archiv entpacken', 'Datei wird durch SSH gestreamt und direkt entpackt (zstd -d | tar -x).'],
  ['finalize', 'System an Hardware anpassen', 'fstab, mdadm.conf, Netzwerk, initramfs (alle Treiber), GRUB per chroot.'],
];
let offRestore = null;
$('#r-go').onclick = async () => {
  const p = planParams();
  const ul = $('#r-phases'); ul.hidden = false;
  ul.innerHTML = PHASES.map(([id, t, d]) => `<li id="ph-${id}"><span class="ico">○</span><b>${esc(t)}</b><span class="sub">${esc(d)}</span></li>`).join('');
  const lg = $('#r-log'); lg.textContent = ''; lg.hidden = true; $('#r-result').innerHTML = '';
  $('#r-progress').hidden = false; setBar($('#r-bar'), 0); $('#r-stats').textContent = '';
  $('#r-go').disabled = true; $('#r-cancel').hidden = false;
  offRestore?.();
  offRestore = api.on('restore:event', (e) => {
    if (e.type === 'phase') {
      const li = $('#ph-' + e.id); if (!li) return;
      li.className = e.status; $('.ico', li).textContent = { running: '◔', done: '✓', error: '✗' }[e.status];
      if (e.status === 'running') { log(lg, '▶ ' + $('b', li).textContent, 'step'); setBar($('#r-bar'), e.id === 'extract' || e.id === 'verify' ? 0 : null); }
    } else if (e.type === 'substep') {
      const li = $('.phases li.running'); if (li) $('.sub', li).textContent = e.text;
      log(lg, '  · ' + e.text, 'step');
    } else if (e.type === 'log') log(lg, e.line, e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : '');
    else if (e.type === 'progress') {
      setBar($('#r-bar'), e.percent);
      $('#r-stats').textContent = e.phase === 'verify' ? `Prüfsumme: ${e.percent.toFixed(0)} %` : `${e.percent.toFixed(0)} % · ${fmtBytes(e.bytes)} von ${fmtBytes(e.total)}` + (e.speed ? ` · ${fmtBytes(e.speed)}/s` : '') + (e.eta ? ` · noch ca. ${fmtDur(e.eta)}` : '');
    }
  });
  const r = await withTrust((c) => api.restoreStart(c, state.restoreDir, { layout: p.layout, disks: p.disks.map((d) => d.path), swapGb: p.swapGb, bootMb: p.bootMb, net: p.net }, $('#r-pass').value || undefined), state.targetConn);
  $('#r-cancel').hidden = true; $('#r-go').disabled = false;
  if (!r.ok) {
    $('#r-result').innerHTML = `<div class="result err"><b>✗ Wiederherstellung fehlgeschlagen:</b> ${esc(r.error.message)}<br><span class="muted">Das Log oben zeigt Details. Läuft der Fehler erst im Schritt „System anpassen", sind die Daten bereits entpackt — du kannst die Wiederherstellung nach Behebung (z. B. Netzwerk des Rescue-Systems) einfach erneut starten.</span></div>`;
    return;
  }
  setBar($('#r-bar'), 100);
  $('#r-result').innerHTML = `<div class="result ok"><b>✓ Wiederherstellung abgeschlossen.</b>
    <ol><li>Im Rescue-System per SSH ausführen: <code>reboot</code> (Hetzner bootet danach von den Platten, das Rescue-System ist nach einem Neustart automatisch wieder deaktiviert).</li>
    <li>Nach 1–3 Minuten per SSH mit dem neuen System verbinden. Ändert sich der Host-Schlüssel nicht (er wird aus dem Backup übernommen), gibt es keine Warnung.</li>
    <li>Bei RAID1: <code>cat /proc/mdstat</code> — die erste Synchronisation kann je nach Plattengröße Stunden dauern, der Server ist währenddessen nutzbar.</li>
    <li>Prüfe Netzwerk (<code>ip a</code>), Dienste (<code>systemctl --failed</code>) und Datenbanken.</li></ol></div>`;
};
$('#r-cancel').onclick = () => api.restoreCancel();

// ------------------------------------------------------------------ 5: iso
async function refreshIsoStatus() {
  const s = await api.isoStatus();
  setStatus($('#i-xorriso'), s.available ? `✓ xorriso gefunden (${s.version})` : '✗ xorriso nicht gefunden — das Restore-Paket (A) geht trotzdem; für das ISO (B) macOS: brew install xorriso · Windows: WSL', s.available ? 'ok' : 'err');
}
$('#i-backup-pick').onclick = async () => { const d = await api.pickDir('Backup-Ordner wählen'); if (d) { $('#i-backup').value = d; state.isoBackup = d; } };
$('#i-backup-clear').onclick = () => { $('#i-backup').value = ''; state.isoBackup = ''; };
$('#i-base-pick').onclick = async () => { const f = await api.pickFile('Live-ISO wählen', [{ name: 'ISO', extensions: ['iso'] }]); if (f) { $('#i-base').value = f; } };
$('#i-stage').onclick = async () => {
  const dir = await api.pickDir('Zielordner für das Restore-Paket'); if (!dir) return;
  setStatus($('#i-stage-status'), 'Erzeuge …');
  const r = await api.isoStage(dir.replace(/\/?$/, '/') + 'linback-restore-paket', $('#i-backup').value || null);
  if (!r.ok) setStatus($('#i-stage-status'), '✗ ' + r.error.message, 'err');
  else { setStatus($('#i-stage-status'), `✓ ${r.staged.dir} (${['linback-restore.sh', 'README.txt', ...r.staged.copied].join(', ')})`, 'ok'); api.reveal(r.staged.dir); }
};
$('#i-build').onclick = async () => {
  const base = $('#i-base').value; if (!base) { setStatus($('#i-status'), 'Bitte zuerst ein Basis-ISO wählen.', 'err'); return; }
  const out = await api.pickSave('ISO speichern unter', 'linback-restore.iso'); if (!out) return;
  const embed = $('#i-embed').checked; if (embed && !$('#i-backup').value) { setStatus($('#i-status'), 'Zum Einbetten bitte einen Backup-Ordner wählen.', 'err'); return; }
  const lg = $('#i-log'); lg.textContent = ''; lg.hidden = true; $('#i-result').innerHTML = '';
  setStatus($('#i-status'), 'Erzeuge ISO … (bei eingebettetem Archiv kann das dauern)'); $('#i-build').disabled = true;
  const off = api.on('iso:event', (e) => { if (e.type === 'log') log(lg, e.line); });
  const r = await api.isoBuild({ baseIso: base, outIso: out, includeArchive: embed, backupDir: $('#i-backup').value });
  off(); $('#i-build').disabled = false;
  if (!r.ok) { setStatus($('#i-status'), '✗ ' + r.error.message, 'err'); return; }
  setStatus($('#i-status'), '✓ Fertig', 'ok');
  $('#i-result').innerHTML = `<div class="result ok"><b>✓ ISO erzeugt:</b> ${esc(r.result.outIso)} (${fmtBytes(r.result.size)})<br><span class="muted">Im Live-System: <code>sudo -i</code>, dann <code>bash /run/live/medium/linback/linback-restore.sh wizard</code></span><p><button id="i-reveal">Im Finder/Explorer zeigen</button></p></div>`;
  $('#i-reveal').onclick = () => api.reveal(r.result.outIso);
};
