'use strict';
/**
 * Ende-zu-Ende-Test mit echten (emulierten) Ubuntu-Servern in QEMU — benutzt den App-Code selbst:
 *   1. "Quellserver" (Ubuntu 22.04 cloud image) booten, mit Testdaten ausstatten, per analyze()+runBackup() sichern
 *   2. "Rescue-System" (frische Kopie desselben Images + leere Zielplatten) booten, per inspectTarget()+runRestore() wiederherstellen
 *   3. NUR die wiederhergestellten Platten booten und prüfen (Daten, Rechte, Netzwerk, RAID, Bootmodus)
 *
 * Aufruf: node vmtest/vmtest.js <backup|bios-single|bios-raid1|uefi-single|uefi-raid1|all>
 * Umgebung: VMTEST_DIR (Arbeitsordner mit images/jammy-server-cloudimg-amd64.img, NICHT in Dropbox legen)
 * x86_64 wird auf Apple Silicon per TCG emuliert und ist entsprechend langsam (Minuten pro Boot).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { connect, exec } = require('../src/core/ssh');
const { analyze } = require('../src/core/analyze');
const { runBackup, verifyBackup } = require('../src/core/backup');
const { inspectTarget, runRestore } = require('../src/core/restore');

const DIR = process.env.VMTEST_DIR || path.join(os.tmpdir(), 'linback-vmtest');
const BASE = path.join(DIR, 'images', 'jammy-server-cloudimg-amd64.img');
const WORK = path.join(DIR, 'work'); const LOGS = path.join(DIR, 'logs'); const BACKUPS = path.join(DIR, 'backups');
for (const d of [WORK, LOGS, BACKUPS]) fs.mkdirSync(d, { recursive: true });
const QSHARE = '/opt/homebrew/share/qemu';
const PASS = 'linback-test';
const BACKUP_PASS = 'ein-sehr-langes-testpasswort';
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- cloud-init (NoCloud über HTTP)
let userData = '';
let metaData = '';
const seedServer = http.createServer((req, res) => {
  const body = req.url.includes('user-data') ? userData : req.url.includes('meta-data') ? metaData : '';
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body);
});

function userDataFor(hostname) {
  return `#cloud-config
hostname: ${hostname}
ssh_pwauth: true
disable_root: false
chpasswd:
  expire: false
  users:
    - {name: root, password: ${PASS}, type: text}
write_files:
  - path: /etc/ssh/sshd_config.d/01-linback.conf
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
runcmd:
  - [ touch, /var/lib/linback-cloudinit-done ]
`;
}

// ---------------------------------------------------------------- VM-Helfer
function qimg(...args) {
  const r = spawnSync('qemu-img', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('qemu-img ' + args.join(' ') + ': ' + r.stderr);
}
function overlay(name, size = '12G') {
  const f = path.join(WORK, name + '.qcow2'); fs.rmSync(f, { force: true });
  qimg('create', '-f', 'qcow2', '-F', 'qcow2', '-b', BASE, f, size); return f;
}
function blank(name, size = '8G') {
  const f = path.join(WORK, name + '.qcow2'); fs.rmSync(f, { force: true });
  qimg('create', '-f', 'qcow2', f, size); return f;
}

/** opts: { name, disks: [file...], port, uefi, seed } */
function startVm(o) {
  const serial = path.join(LOGS, o.name + '.serial.log'); fs.rmSync(serial, { force: true });
  const args = ['-machine', 'q35', '-cpu', 'max', '-accel', 'tcg,thread=multi,tb-size=768', '-smp', '4', '-m', '3072', '-display', 'none',
    '-serial', 'file:' + serial, '-netdev', `user,id=n0,hostfwd=tcp:127.0.0.1:${o.port}-:22`, '-device', 'virtio-net-pci,netdev=n0'];
  if (o.uefi) {
    const vars = path.join(WORK, o.name + '.vars.fd'); fs.copyFileSync(path.join(QSHARE, 'edk2-i386-vars.fd'), vars);
    args.push('-drive', `if=pflash,format=raw,readonly=on,file=${path.join(QSHARE, 'edk2-x86_64-code.fd')}`, '-drive', `if=pflash,format=raw,file=${vars}`);
  }
  o.disks.forEach((f, i) => args.push('-drive', `file=${f},if=none,id=d${i},format=qcow2`, '-device', `virtio-blk-pci,drive=d${i},bootindex=${i}`));
  if (o.seed) args.push('-smbios', 'type=1,serial=ds=nocloud-net;s=http://10.0.2.2:8000/');
  log(`VM ${o.name}: starte (${o.uefi ? 'UEFI' : 'BIOS'}, SSH-Port ${o.port})`);
  const p = spawn('qemu-system-x86_64', args, { stdio: 'ignore' });
  const vm = { name: o.name, proc: p, port: o.port, exited: false };
  p.on('exit', () => { vm.exited = true; });
  return vm;
}

async function trust(conn) {
  try { const c = await connect(conn); c.end(); return conn; } catch (e) {
    if (e.code === 'HOSTKEY_UNKNOWN' || e.code === 'HOSTKEY_CHANGED') return { ...conn, acceptFingerprint: e.fingerprint, knownFingerprint: undefined };
    throw e;
  }
}
const connFor = (port) => ({ host: '127.0.0.1', port, username: 'root', password: PASS });

async function waitSsh(vm, { marker, timeoutMin = 25 } = {}) {
  const end = Date.now() + timeoutMin * 60000;
  let conn = connFor(vm.port);
  while (Date.now() < end) {
    if (vm.exited) throw new Error(`VM ${vm.name} ist unerwartet beendet`);
    try {
      conn = await trust(conn);
      const c = await connect(conn);
      try {
        if (!marker) return conn;
        const r = await exec(c, `test -f ${marker}`);
        if (r.code === 0) return conn;
      } finally { c.end(); }
    } catch { /* noch nicht bereit */ }
    await sleep(5000);
  }
  throw new Error(`VM ${vm.name}: SSH${marker ? '/cloud-init' : ''} nicht rechtzeitig bereit (siehe ${path.join(LOGS, vm.name + '.serial.log')})`);
}

async function sshRun(conn, cmd) {
  const c = await connect(conn);
  try { return await exec(c, cmd); } finally { c.end(); }
}

async function stopVm(vm, conn) {
  if (vm.exited) return;
  try { if (conn) await sshRun(conn, 'sync; (sleep 1; poweroff) >/dev/null 2>&1 &'); } catch { /* */ }
  for (let i = 0; i < 60 && !vm.exited; i++) await sleep(1000);
  if (!vm.exited) { vm.proc.kill('SIGKILL'); await sleep(500); }
}


const SETUP_SOURCE = `set -e
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq acl attr zstd >/dev/null
mkdir -p /srv/testdata && cd /srv/testdata
echo 'linback-testdaten' > hello.txt && ln -sf hello.txt link.txt
chown 1234:1234 hello.txt && chmod 640 hello.txt
setfacl -m u:nobody:r hello.txt && setfattr -n user.linback -v wert hello.txt
dd if=/dev/urandom of=random.bin bs=1M count=24 2>/dev/null
sha256sum random.bin > /root/random.sha
echo source-vm > /etc/linback-source
sync`;

async function setupSource(conn) {
  log('Quellserver: Testdaten und Pakete einrichten (apt, kann dauern)');
  const r = await sshRun(conn, 'bash -c ' + require('../src/core/util').shq(SETUP_SOURCE));
  if (r.code !== 0) throw new Error('Setup des Quellservers fehlgeschlagen: ' + r.stderr);
}

// ---------------------------------------------------------------- Phase 1: Quellserver sichern
async function phaseBackup() {
  userData = userDataFor('lbsource'); metaData = `instance-id: iid-source-${Date.now()}\nlocal-hostname: lbsource\n`;
  const disk = overlay('source');
  const vm = startVm({ name: 'source', disks: [disk], port: 2222, seed: true });
  let conn;
  try {
    conn = await waitSsh(vm);
    await setupSource(conn);
    log('Quellserver bereit — analysiere');
    const analysis = await analyze(conn);
    log(`Analyse: ${analysis.os.prettyName}, ${analysis.bootMode}, belegt ${(analysis.usedBytes / 1e9).toFixed(2)} GB, Mounts ${analysis.backupMounts.map((m) => m.target)}`);
    for (const w of analysis.warnings) log(`  Hinweis [${w.level}] ${w.text}`);
    fs.rmSync(BACKUPS, { recursive: true, force: true }); fs.mkdirSync(BACKUPS, { recursive: true });
    let last = 0;
    const r = await runBackup({
      conn, analysis, options: { passphrase: BACKUP_PASS }, baseDir: BACKUPS, setCancel: () => {},
      emit: (e) => {
        if (e.type === 'progress' && Date.now() - last > 15000) { last = Date.now(); log(`  Backup ${e.percent ? e.percent.toFixed(0) + ' %' : ''} ${(e.bytes / 1e6).toFixed(0)} MB`); }
        else if (e.type === 'log' && e.level !== 'info') log('  [backup]', e.line);
      },
    });
    log(`Backup fertig: ${r.outDir} (${(r.manifest.archive.size / 1e6).toFixed(0)} MB, verschlüsselt: ${!!r.manifest.archive.encryption})`);
    const v = await verifyBackup(r.outDir, () => {}, BACKUP_PASS);
    if (!v.ok) throw new Error('Verifikation des Backups fehlgeschlagen');
    log('Backup verifiziert (SHA-256 + HMAC)');
  } finally { await stopVm(vm, conn); }
}

// ---------------------------------------------------------------- Phase 2+3: Restore und Boot
const SCEN = {
  'bios-single': { uefi: false, layout: 'single', ndisks: 1 },
  'bios-raid1': { uefi: false, layout: 'raid1', ndisks: 2 },
  'uefi-single': { uefi: true, layout: 'single', ndisks: 1 },
  'uefi-raid1': { uefi: true, layout: 'raid1', ndisks: 2 },
};
const backupDir = () => path.join(BACKUPS, fs.readdirSync(BACKUPS)[0]);

async function phaseScenario(name) {
  const sc = SCEN[name]; const results = [];
  const check = (label, ok, detail = '') => { results.push({ label, ok }); log(`  ${ok ? '✔' : '✘'} ${label}${detail ? ' — ' + detail : ''}`); };

  // --- Rescue booten und wiederherstellen
  userData = userDataFor('lbrescue'); metaData = `instance-id: iid-rescue-${name}-${Date.now()}\nlocal-hostname: lbrescue\n`;
  const targets = Array.from({ length: sc.ndisks }, (_, i) => blank(`${name}-target${i}`));
  const rescue = startVm({ name: `rescue-${name}`, disks: [overlay(`rescue-${name}`), ...targets], port: 2223, uefi: sc.uefi, seed: true });
  let rconn;
  try {
    rconn = await waitSsh(rescue);
    const info = await inspectTarget(rconn);
    log(`Rescue bereit: ${info.arch} ${info.bootMode} fehlend=[${info.missing}] NIC=${info.nic.name}/${info.nic.mac} Platten=${info.disks.map((d) => d.path + ':' + (d.size / 2 ** 30).toFixed(0) + 'G')}`);
    check('Rescue-Boot-Modus wie erwartet', info.bootMode === (sc.uefi ? 'uefi' : 'bios'), info.bootMode);
    const disks = ['/dev/vdb', '/dev/vdc'].slice(0, sc.ndisks);
    let last = 0;
    await runRestore({
      conn: rconn, backupDir: backupDir(), passphrase: BACKUP_PASS,
      plan: { layout: sc.layout, disks, swapGb: 1, bootMb: 512, net: 'rescue' },
      setCancel: () => {},
      emit: (e) => {
        if (e.type === 'phase') log(`  Phase ${e.id}: ${e.status}`);
        else if (e.type === 'substep') log(`    · ${e.text}`);
        else if (e.type === 'log' && (e.level !== 'info')) log(`    ! ${e.line}`);
        else if (e.type === 'log' && process.env.VERBOSE) log(`      ${e.line}`);
        else if (e.type === 'progress' && e.phase === 'extract' && Date.now() - last > 20000) { last = Date.now(); log(`    Entpacken ${e.percent.toFixed(0)} %`); }
      },
    });
    check('runRestore() ohne Fehler beendet', true);
  } catch (e) {
    check('runRestore() ohne Fehler beendet', false, e.message);
    try { await dumpRescue(rconn, name); } catch { /* */ }
    await stopVm(rescue, rconn);
    return results;
  }
  await stopVm(rescue, rconn);

  // --- Nur die wiederhergestellten Platten booten
  userData = ''; metaData = '';
  const vm = startVm({ name: `restored-${name}`, disks: targets, port: 2224, uefi: sc.uefi, seed: false });
  let conn;
  try {
    conn = await waitSsh(vm, { timeoutMin: 20 });
    check('Wiederhergestelltes System bootet und ist per SSH erreichbar (altes root-Passwort aus dem Backup)', true);
    const run = async (cmd) => (await sshRun(conn, cmd));
    const out = async (cmd) => (await run(cmd)).stdout.trim();
    check('Inhalt stammt vom Quellserver', (await out('cat /etc/linback-source')) === 'source-vm');
    check('Hostname aus dem Backup', (await out('hostname')) === 'lbsource', await out('hostname'));
    check('Zufallsdatei (24 MB) bit-identisch', (await run('cd /srv/testdata && sha256sum -c /root/random.sha')).code === 0);
    check('Besitzer/Rechte (1234:1234, 640)', (await out('stat -c %u:%g:%a /srv/testdata/hello.txt')) === '1234:1234:640');
    check('Symlink erhalten', (await out('readlink /srv/testdata/link.txt')) === 'hello.txt');
    check('ACL erhalten', /user:nobody:r--/.test(await out('getfacl -p /srv/testdata/hello.txt 2>&1')));
    check('xattr erhalten', /user.linback="wert"/.test(await out('getfattr -d /srv/testdata/hello.txt 2>&1')));
    check(`Boot-Modus ${sc.uefi ? 'UEFI' : 'BIOS'}`, (await out('[ -d /sys/firmware/efi ] && echo uefi || echo bios')) === (sc.uefi ? 'uefi' : 'bios'));
    check('Netzwerk (Adresse aus Rescue übernommen)', /10\.0\.2\.15/.test(await out('ip -4 -o addr show scope global')), await out('ip -4 -o addr show scope global'));
    check('Root ist per UUID gemountet (neue fstab)', /UUID=/.test(await out('grep -v "^#" /etc/fstab | head -n 1')));
    check('Original-fstab gesichert', (await run('test -f /etc/fstab.linback-orig')).code === 0);
    if (sc.layout === 'raid1') {
      const md = await out('cat /proc/mdstat');
      check('Software-RAID1 aktiv (2 Mitglieder)', /raid1 .*\[2\/2\]|raid1 \S+\[\d\] \S+\[\d\]/.test(md.replace(/\n/g, ' ')) && /\[2\/[12]\]/.test(md), md.split('\n').slice(0, 4).join(' | '));
    }
    const failed = await out('systemctl --failed --no-legend | head -n 5');
    check('Keine fehlgeschlagenen systemd-Units', failed === '', failed);
  } catch (e) {
    check('Wiederhergestelltes System bootet', false, e.message);
  } finally { await stopVm(vm, conn); }
  return results;
}

async function dumpRescue(conn, name) {
  if (!conn) return;
  const r = await sshRun(conn, 'tail -n 40 /var/log/apt/term.log 2>/dev/null; lsblk; cat /proc/mdstat; mount | grep linback');
  fs.writeFileSync(path.join(LOGS, `rescue-${name}.debug.txt`), r.stdout + r.stderr);
}

// ---------------------------------------------------------------- main
(async () => {
  const what = process.argv[2] || 'all';
  if (!fs.existsSync(BASE)) { console.error('Basis-Image fehlt: ' + BASE); process.exit(2); }
  await new Promise((r) => seedServer.listen(8000, '0.0.0.0', r));
  let all = [];
  try {
    if (what === 'backup' || what === 'all') await phaseBackup();
    const names = what === 'all' ? Object.keys(SCEN) : (SCEN[what] ? [what] : []);
    for (const n of names) {
      log(`===== Szenario ${n} =====`);
      const res = await phaseScenario(n); all.push([n, res]);
    }
  } catch (e) { log('FEHLER:', e.stack || e.message); process.exitCode = 1; }
  seedServer.close();
  log('===== Zusammenfassung =====');
  for (const [n, res] of all) { log(`${n}: ${res.filter((r) => r.ok).length}/${res.length} Checks`); for (const r of res.filter((x) => !x.ok)) log('   ✘ ' + r.label); }
  if (all.some(([, res]) => res.some((r) => !r.ok))) process.exitCode = 1;
  process.exit();
})();
