'use strict';
const { connect, exec, bashCommand } = require('./ssh');

/** Read-only inspection script. Shown 1:1 to the user in the UI. */
const ANALYZE_SCRIPT = String.raw`sec() { printf '\n@@SECTION %s\n' "$1"; }
sec os;       cat /etc/os-release 2>/dev/null
sec kernel;   uname -srm
sec hostname; hostname -f 2>/dev/null || hostname
sec arch;     uname -m
sec uid;      id -u
sec cpu;      grep -m1 'model name' /proc/cpuinfo 2>/dev/null; nproc 2>/dev/null
sec mem;      grep -E 'MemTotal|SwapTotal' /proc/meminfo 2>/dev/null
sec boot;     if [ -d /sys/firmware/efi ]; then echo uefi; else echo bios; fi
sec lsblk;    lsblk -J -b -o NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL 2>/dev/null
sec df;       df -P -B1 -T 2>/dev/null
sec mdstat;   cat /proc/mdstat 2>/dev/null
sec lvm;      command -v lvs >/dev/null 2>&1 && lvs --noheadings -o lv_name,vg_name,lv_size --units b 2>/dev/null
sec fstab;    cat /etc/fstab 2>/dev/null
sec net;      ip -o -4 addr show scope global 2>/dev/null; ip -o -6 addr show scope global 2>/dev/null; ip route show default 2>/dev/null
sec netplan;  for f in /etc/netplan/*.yaml; do [ -f "$f" ] && { echo "### $f"; cat "$f"; }; done
sec tools;    for t in tar zstd gzip pigz bash ionice; do if command -v $t >/dev/null 2>&1; then echo "$t=1"; else echo "$t=0"; fi; done; tar --version 2>/dev/null | head -n 1
sec services; for s in docker mysql mariadb postgresql mongod redis-server; do systemctl is-active --quiet $s 2>/dev/null && echo $s; done
sec packages; dpkg-query -W -f='x\n' 2>/dev/null | wc -l
`;

/** Filesystems that are backed up (real, local, POSIX). Everything else (tmpfs, nfs, overlay, vfat ...) is skipped. */
const BACKUP_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'jfs', 'reiserfs']);

function sections(raw) {
  const out = {};
  const parts = raw.split(/\n@@SECTION (\S+)\n/);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = (parts[i + 1] || '').replace(/\s+$/, '');
  return out;
}

function parseOsRelease(txt) {
  const o = {};
  for (const l of txt.split('\n')) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return { prettyName: o.PRETTY_NAME || o.NAME || 'unbekannt', id: o.ID || '', version: o.VERSION_ID || '' };
}

function parseDf(txt) {
  const rows = [];
  for (const l of txt.split('\n').slice(1)) {
    const c = l.trim().split(/\s+/);
    if (c.length < 7) continue;
    rows.push({ device: c[0], type: c[1], size: +c[2], used: +c[3], avail: +c[4], target: c.slice(6).join(' ') });
  }
  return rows;
}

function parseAnalysis(raw) {
  const s = sections(raw);
  const kv = (txt) => Object.fromEntries((txt || '').split('\n').map((l) => l.split('=')).filter((a) => a.length === 2));
  const toolLines = (s.tools || '').split('\n');
  const tools = kv(toolLines.filter((l) => /^\w+=[01]$/.test(l)).join('\n'));
  const mem = {};
  for (const l of (s.mem || '').split('\n')) {
    const m = l.match(/^(\w+):\s+(\d+) kB/);
    if (m) mem[m[1]] = +m[2] * 1024;
  }
  let lsblk = [];
  try { lsblk = JSON.parse(s.lsblk || '{}').blockdevices || []; } catch { /* old lsblk without -J */ }
  const mounts = parseDf(s.df || '');
  const backupMounts = mounts
    .filter((m) => BACKUP_FS.has(m.type) && m.target !== '/boot/efi' && !m.target.startsWith('/var/lib/docker/') && !m.target.startsWith('/snap/'))
    .sort((a, b) => a.target.length - b.target.length);
  const hasRoot = backupMounts.some((m) => m.target === '/');
  const services = (s.services || '').split('\n').filter(Boolean);
  const cpuLines = (s.cpu || '').split('\n');
  const a = {
    os: parseOsRelease(s.os || ''),
    kernel: s.kernel || '',
    hostname: (s.hostname || '').split('\n')[0],
    arch: s.arch || '',
    isRoot: s.uid === '0',
    cpu: { model: (cpuLines[0] || '').replace(/^model name\s*:\s*/, ''), cores: +cpuLines[1] || 0 },
    memTotal: mem.MemTotal || 0,
    swapTotal: mem.SwapTotal || 0,
    bootMode: s.boot || 'bios',
    lsblk,
    mounts,
    backupMounts,
    usedBytes: backupMounts.reduce((n, m) => n + m.used, 0),
    mdstat: s.mdstat || '',
    hasRaid: /^md\d+ :/m.test(s.mdstat || ''),
    hasLvm: !!(s.lvm || '').trim(),
    fstab: s.fstab || '',
    net: s.net || '',
    netplan: s.netplan || '',
    tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v === '1'])),
    tarVersion: toolLines.find((l) => /tar/i.test(l) && !/=/.test(l)) || '',
    services,
    packages: +(s.packages || 0),
    warnings: [],
  };
  a.warnings = deriveWarnings(a, hasRoot);
  return a;
}

function deriveWarnings(a, hasRoot) {
  const w = [];
  const add = (level, text) => w.push({ level, text });
  if (!hasRoot) add('error', 'Das Root-Dateisystem (/) wurde nicht erkannt. Das Backup kann so nicht zuverlässig erstellt werden.');
  if (!a.tools.tar) add('error', 'Auf dem Server fehlt tar.');
  if (a.tarVersion && !/GNU/i.test(a.tarVersion)) add('error', 'Auf dem Server ist kein GNU tar installiert (ACL-/xattr-Optionen fehlen).');
  if (!a.tools.bash) add('error', 'Auf dem Server fehlt bash.');
  if (!a.isRoot) add('warn', 'Die Verbindung läuft nicht als root. Ohne root (oder passwortloses sudo) fehlen Dateien im Backup. Aktiviere "sudo verwenden" oder melde dich als root an.');
  if (!a.tools.zstd) add('info', 'zstd ist auf dem Server nicht installiert — es wird gzip (langsamer, größer) verwendet. Mit "apt install zstd" wird das Backup schneller und kleiner.');
  const db = a.services.filter((x) => x !== 'docker');
  if (db.length) add('warn', `Laufende Datenbank-Dienste (${db.join(', ')}): Dateien einer laufenden Datenbank sind im Backup nicht konsistent. Lege vorher einen Dump an (Feld "Vorbereitender Befehl" im Backup-Schritt) oder stoppe den Dienst.`);
  if (a.services.includes('docker')) add('info', 'Docker läuft. Container-Daten werden mitgesichert, sind aber ohne Stoppen der Container nur "crash-konsistent". Volumes mit Datenbanken separat dumpen.');
  if (a.hasLvm) add('info', 'LVM erkannt. Die Daten werden gesichert; bei der Wiederherstellung entstehen normale Partitionen statt LVM (die Systemfunktion bleibt gleich).');
  if (a.hasRaid) add('info', 'Software-RAID erkannt. Das RAID-Layout selbst ist nicht Teil des Backups — beim Restore wählst du es neu.');
  if (a.arch && a.arch !== 'x86_64') add('error', `Architektur ${a.arch}: Die Wiederherstellung unterstützt derzeit nur x86_64.`);
  if (a.backupMounts.length === 0) add('warn', 'Keine lokalen Dateisysteme erkannt.');
  return w;
}

async function analyze(connOpts, onLog = () => {}) {
  onLog('Verbinde mit ' + connOpts.host + ' …');
  const client = await connect(connOpts);
  try {
    onLog('Verbunden. Führe die (nur lesenden) Analysebefehle aus …');
    const res = await exec(client, bashCommand(ANALYZE_SCRIPT, !!connOpts.sudo));
    if (res.code !== 0 && !res.stdout) throw new Error('Analyse fehlgeschlagen: ' + (res.stderr || 'Exit ' + res.code));
    const analysis = parseAnalysis(res.stdout);
    analysis.fingerprint = client.lbFingerprint;
    return analysis;
  } finally {
    client.end();
  }
}

module.exports = { ANALYZE_SCRIPT, parseAnalysis, analyze, BACKUP_FS };
