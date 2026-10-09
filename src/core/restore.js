'use strict';
const fs = require('fs');
const { Transform } = require('stream');
const path = require('path');
const { connect, exec } = require('./ssh');
const { shq, lineSplitter } = require('./util');
const { verifyBackup } = require('./backup');
const crypt = require('./crypt');

const REMOTE_SCRIPT = '/tmp/linback-restore.sh';
const SCRIPT_PATH = path.join(__dirname, 'restore-scripts', 'linback-restore.sh');
const MiB = 1024 * 1024, GiB = 1024 * MiB;

function parseInspect(out) {
  const r = { arch: '', bootMode: '', missing: [], nic: { name: '', mac: '' }, disks: [], tree: [] };
  const block = (name) => {
    const m = out.match(new RegExp(`##${name}_BEGIN\\n([\\s\\S]*?)\\n##${name}_END`));
    if (!m) return [];
    try { return JSON.parse(m[1]).blockdevices || []; } catch { return []; }
  };
  for (const l of out.split('\n')) {
    let m;
    if ((m = l.match(/^##ARCH (.*)$/))) r.arch = m[1].trim();
    else if ((m = l.match(/^##BOOTMODE (.*)$/))) r.bootMode = m[1].trim();
    else if ((m = l.match(/^##MISSING (.*)$/))) r.missing = m[1].trim().split(/\s+/).filter(Boolean);
    else if ((m = l.match(/^##NIC (\S*)\s*(\S*)$/))) r.nic = { name: m[1], mac: m[2] };
  }
  r.disks = block('LSBLK').filter((d) => d.type === 'disk' && Number(d.size) > 4 * GiB);
  r.tree = block('LSBLK_FULL');
  return r;
}

/**
 * Pure preview of the partition layout that linback-restore.sh will create. Keep in sync with cmd_prepare.
 * plan: { layout: 'single'|'raid1', disks: [{path,size}], bootMode, swapGb, bootMb, neededBytes }
 */
function buildPlan(plan) {
  const errors = [];
  const n = plan.disks.length;
  if (plan.layout === 'single' && n !== 1) errors.push('Für "Einzelne Platte" muss genau eine Platte gewählt sein.');
  if (plan.layout === 'raid1' && n !== 2) errors.push('Für RAID1 müssen genau zwei Platten gewählt sein.');
  const swapGb = Number(plan.swapGb) || 0;
  const bootMb = Number(plan.bootMb) || 1024;
  const first = plan.bootMode === 'uefi'
    ? { label: 'esp', size: 512 * MiB, fs: 'FAT32', mount: '/boot/efi', note: 'EFI-System-Partition' }
    : { label: 'bios_boot', size: 2 * MiB, fs: '–', mount: '', note: 'GRUB-Kern für BIOS-Boot auf GPT' };
  const raid = plan.layout === 'raid1';
  const parts = [first];
  if (swapGb > 0) parts.push({ label: 'swap', size: swapGb * GiB, fs: 'swap', mount: 'swap', note: raid ? 'RAID1 /dev/md0' : '' });
  let mdn = swapGb > 0 ? 1 : 0;
  parts.push({ label: 'boot', size: bootMb * MiB, fs: 'ext4', mount: '/boot', note: raid ? `RAID1 /dev/md${mdn}` : '' });
  mdn++;
  const sizes = plan.disks.map((d) => Number(d.size) || 0);
  const smallest = sizes.length ? Math.min(...sizes) : 0;
  const used = parts.reduce((s, p) => s + p.size, 0) + 2 * MiB; // alignment + backup GPT
  const rootSize = Math.max(0, smallest - used);
  parts.push({ label: 'root', size: rootSize, fs: 'ext4', mount: '/', note: raid ? `RAID1 /dev/md${mdn}` : 'Rest der Platte' });
  if (plan.neededBytes && rootSize && rootSize < plan.neededBytes * 1.1) {
    errors.push(`Die Root-Partition (${(rootSize / GiB).toFixed(0)} GB) ist für die gesicherten Daten (${(plan.neededBytes / GiB).toFixed(0)} GB) zu klein.`);
  }
  if (!rootSize) errors.push('Platte(n) zu klein für die gewählte Aufteilung.');
  return { tables: plan.disks.map((d) => ({ disk: d.path, parts })), parts, errors, rootSize };
}

function envPrefix(env) {
  return 'env ' + Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
}

async function uploadScript(client) {
  const script = fs.readFileSync(SCRIPT_PATH);
  const r = await exec(client, `cat > ${REMOTE_SCRIPT} && chmod 755 ${REMOTE_SCRIPT}`, { stdin: script });
  if (r.code !== 0) throw new Error('Skript-Upload fehlgeschlagen: ' + r.stderr);
}

async function inspectTarget(conn) {
  const client = await connect(conn);
  try {
    await uploadScript(client);
    const r = await exec(client, `bash ${REMOTE_SCRIPT} inspect`);
    if (r.code !== 0) throw new Error('Inspektion fehlgeschlagen: ' + (r.stderr || r.code));
    const info = parseInspect(r.stdout);
    info.fingerprint = client.lbFingerprint;
    return info;
  } finally {
    client.end();
  }
}

/** Runs one subcommand of the remote script and forwards ##STEP / ##ERROR lines. */
async function runRemote(client, sub, env, emit, extra = {}) {
  let lastError = '';
  const out = lineSplitter((l) => {
    const m = l.match(/^##STEP (.*)$/);
    if (m) emit({ type: 'substep', text: m[1] });
    else if (!l.startsWith('##')) emit({ type: 'log', level: 'info', line: l });
  });
  const err = lineSplitter((l) => {
    const m = l.match(/^##ERROR (.*)$/);
    if (m) { lastError = m[1]; emit({ type: 'log', level: 'error', line: m[1] }); }
    else if (l.trim()) emit({ type: 'log', level: 'warn', line: l });
  });
  const r = await exec(client, `${envPrefix(env)} bash ${REMOTE_SCRIPT} ${sub}`, { onStdout: out, onStderr: err, ...extra });
  out.flush(); err.flush();
  if (r.code !== 0) throw new Error(lastError || `Schritt "${sub}" endete mit Exit-Code ${r.code}.`);
}

/**
 * Full restore. plan: { layout, disks: [paths], swapGb, bootMb, net: rescue|keep|none }
 * Phases (UI): verify, connect, deps, prepare, extract, finalize
 */
async function runRestore({ conn, backupDir, plan, passphrase, emit, setCancel }) {
  const phase = (id, status) => emit({ type: 'phase', id, status });
  let current = 'verify';
  let client = null;
  let cancelled = false;
  let rs = null;
  setCancel(() => { cancelled = true; try { if (rs) rs.destroy(); } catch { /* */ } if (client) client.end(); });
  try {
    phase('verify', 'running');
    const v = await verifyBackup(backupDir, (e) => { if (e.type === 'progress') emit({ type: 'progress', phase: 'verify', percent: e.percent }); }, passphrase);
    if (v.encrypted && !passphrase) throw new Error('Das Archiv ist verschlüsselt — bitte die Passphrase eingeben.');
    if (!v.hashOk || !v.sizeOk) throw new Error('Die Prüfsumme des Archivs stimmt nicht mit dem Manifest überein — das Backup ist beschädigt. Restore abgebrochen.');
    if (v.hmacOk === false) throw new Error('Die Passphrase ist falsch oder das verschlüsselte Archiv wurde verändert (HMAC-Prüfung fehlgeschlagen). Es wurde nichts gelöscht.');
    const manifest = v.manifest;
    const archive = path.join(backupDir, manifest.archive.file);
    phase('verify', 'done');

    current = 'connect'; phase('connect', 'running');
    client = await connect(conn);
    await uploadScript(client);
    phase('connect', 'done');

    const base = { LB_LAYOUT: plan.layout, LB_DISKS: plan.disks.join(' '), LB_SWAP_GB: String(plan.swapGb || 0), LB_BOOT_MB: String(plan.bootMb || 1024), LB_NET: plan.net || 'rescue', LB_COMP: manifest.archive.compression };  // the archive is decrypted locally; only the compressed tar travels through SSH

    current = 'deps'; phase('deps', 'running');
    await runRemote(client, 'deps', base, emit);
    phase('deps', 'done');

    current = 'prepare'; phase('prepare', 'running');
    await runRemote(client, 'prepare', { ...base, LB_CONFIRM: 'WIPE' }, emit);
    phase('prepare', 'done');

    current = 'extract'; phase('extract', 'running');
    const size = fs.statSync(archive).size;
    let sent = 0, last = 0;
    const started = Date.now();
    rs = fs.createReadStream(archive, { highWaterMark: 1 << 20 });
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        sent += chunk.length;
        const now = Date.now();
        if (now - last > 400) {
          last = now;
          const el = (now - started) / 1000;
          emit({ type: 'progress', phase: 'extract', percent: (sent / size) * 100, bytes: sent, total: size, speed: sent / Math.max(el, 0.5), eta: (el / Math.max(sent, 1)) * (size - sent) });
        }
        cb(null, chunk);
      },
    });
    rs.pipe(counter);
    let source = counter, decErr = null;
    if (v.encrypted) {
      const dec = crypt.createDecryptor(passphrase);
      dec.on('error', (e) => { decErr = e; try { client.end(); } catch { /* */ } });
      source = counter.pipe(dec);
    }
    try {
      await runRemote(client, 'extract', base, emit, { stdin: source });
    } catch (e) { throw decErr || e; }
    if (decErr) throw decErr;
    if (cancelled) throw new Error('Abgebrochen.');
    emit({ type: 'progress', phase: 'extract', percent: 100, bytes: size, total: size });
    phase('extract', 'done');

    current = 'finalize'; phase('finalize', 'running');
    await runRemote(client, 'finalize', base, emit);
    phase('finalize', 'done');

    emit({ type: 'done' });
  } catch (e) {
    phase(current, 'error');
    throw cancelled ? new Error('Abgebrochen.') : e;
  } finally {
    if (client) client.end();
  }
}

module.exports = { parseInspect, buildPlan, inspectTarget, runRestore, SCRIPT_PATH };
