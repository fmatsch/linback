'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { connect, exec, bashCommand } = require('./ssh');
const { shq, lineSplitter, timestamp } = require('./util');
const crypt = require('./crypt');

const RECORD_BYTES = 10240; // GNU tar default: 20 blocks x 512 bytes per record (= one checkpoint unit)
const DEFAULT_EXCLUDES = [
  './lost+found',
  './tmp/*',
  './swapfile',
  './swap.img',
  './var/swap',
  './var/cache/apt/archives/*.deb',
  './boot/efi/*',
];

function pickCompression(analysis, requested = 'auto') {
  const hasZstd = analysis.tools && analysis.tools.zstd;
  if (requested === 'zstd' || (requested === 'auto' && hasZstd)) return 'zst';
  return 'gz';
}

/**
 * Builds the exact command that runs on the server. Pure function (unit tested).
 * options: { compression: auto|zstd|gzip, level, nice, extraExcludes: string[], root }
 */
function buildBackupCommand(analysis, options = {}) {
  const root = options.root || '/';
  const comp = pickCompression(analysis, options.compression);
  const excludes = [...DEFAULT_EXCLUDES, ...(options.extraExcludes || []).map((e) => e.trim()).filter(Boolean)];
  const mountArgs = (analysis.backupMounts || [])
    .map((m) => m.target)
    .filter((t) => t !== '/')
    .map((t) => '.' + t);

  const tarArgs = [
    '--create', '--file=-', '--one-file-system', '--numeric-owner', '--preserve-permissions',
    '--acls', '--xattrs', '--xattrs-include=*', '--sparse',
    '--checkpoint=2000', '--checkpoint-action=echo=LINBACK-CP %u',
    ...excludes.map((e) => '--exclude=' + e),
    '-C', root, '.', ...mountArgs,
  ];
  const tarCmd = 'tar ' + tarArgs.map(shq).join(' ');
  const level = Number(options.level) || (comp === 'zst' ? 3 : 6);
  const compCmd = comp === 'zst' ? `zstd -T0 -${level} -q` : (analysis.tools && analysis.tools.pigz ? `pigz -${level}` : `gzip -${level}`);
  const nice = options.nice !== false;
  const prefix = nice ? '$LB_NICE ' : '';
  const script = [
    'set -o pipefail',
    nice ? 'LB_NICE="nice -n 10"; command -v ionice >/dev/null 2>&1 && LB_NICE="ionice -c3 nice -n 10"' : '',
    `${prefix}${tarCmd} | ${prefix}${compCmd}`,
  ].filter(Boolean).join('\n');
  return { script, tarCmd, compCmd, compression: comp, ext: comp === 'zst' ? 'tar.zst' : 'tar.gz', excludes, mountArgs };
}

/** Runs the whole backup. emit({type, ...}) receives progress/log/step events. Returns { outDir, manifest }. */
async function runBackup({ conn, analysis, options, baseDir, emit, setCancel }) {
  const started = Date.now();
  const cmd = buildBackupCommand(analysis, options);
  const outDir = path.join(baseDir, `${(analysis.hostname || conn.host).replace(/[^\w.-]/g, '_')}-${timestamp()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const encrypted = !!options.passphrase;
  const archiveName = `system.${cmd.ext}${encrypted ? '.enc' : ''}`;
  const partial = path.join(outDir, archiveName + '.partial');
  const log = (line, level = 'info') => emit({ type: 'log', level, line });

  emit({ type: 'step', id: 'connect', text: 'Verbinde mit dem Server' });
  const client = await connect(conn);
  let cancelled = false;
  let channel = null;
  setCancel(() => { cancelled = true; try { if (channel) channel.close(); } catch { /* */ } client.end(); });

  try {
    if (options.preCommand && options.preCommand.trim()) {
      emit({ type: 'step', id: 'pre', text: 'Vorbereitender Befehl wird ausgeführt' });
      log('$ ' + options.preCommand.trim());
      const pre = await exec(client, bashCommand(options.preCommand, conn.sudo), {
        onStdout: (d) => log(d.toString().trimEnd()),
        onStderr: (d) => log(d.toString().trimEnd(), 'warn'),
      });
      if (pre.code !== 0) throw new Error(`Der vorbereitende Befehl endete mit Exit-Code ${pre.code}. Backup abgebrochen.`);
    }

    emit({ type: 'step', id: 'stream', text: 'Dateisystem wird gepackt und heruntergeladen' });
    log('Server-Befehl:\n' + cmd.script);

    const hash = crypto.createHash('sha256');
    const hmacSalt = encrypted ? crypt.newHmacSalt() : null;
    const hmac = encrypted ? crypt.createHmac(options.passphrase, hmacSalt) : null;
    let bytes = 0, fileBytes = 0, srcBytes = 0, lastEmit = 0, warnCount = 0;
    const counter = new Transform({ // bytes received from the server (compressed tar stream)
      transform(chunk, _enc, cb) { bytes += chunk.length; cb(null, chunk); },
    });
    const tap = new Transform({ // bytes that actually land in the file (after optional encryption)
      transform(chunk, _enc, cb) { hash.update(chunk); if (hmac) hmac.update(chunk); fileBytes += chunk.length; cb(null, chunk); },
    });
    const ws = fs.createWriteStream(partial);
    const wsDone = new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); });
    const encStream = encrypted ? crypt.createEncryptor(options.passphrase) : null;
    if (encrypted) log('Archiv wird beim Empfang mit AES-256 verschlüsselt (Schlüssel aus deiner Passphrase, PBKDF2 ' + crypt.ITER + ' Runden).');

    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < 400) return;
      lastEmit = now;
      const elapsed = (now - started) / 1000;
      const total = analysis.usedBytes || 0;
      const percent = srcBytes && total ? Math.min(99, (srcBytes / total) * 100) : null;
      const eta = percent ? (elapsed / percent) * (100 - percent) : null;
      emit({ type: 'progress', bytes, srcBytes, total, percent, speed: bytes / Math.max(elapsed, 0.5), elapsed, eta });
    };

    const stderrLines = lineSplitter((l) => {
      const m = l.match(/LINBACK-CP (\d+)/);
      if (m) { srcBytes = Number(m[1]) * RECORD_BYTES; report(false); return; }
      if (!l.trim()) return;
      if (warnCount++ < 300) log(l, 'warn');
      else if (warnCount === 301) log('… weitere Warnungen werden nicht angezeigt.', 'warn');
    });

    const res = await exec(client, bashCommand(cmd.script, conn.sudo), {
      rawStdout: true,
      onStream: (s) => {
        channel = s;
        const src = s.pipe(counter);
        (encStream ? src.pipe(encStream) : src).pipe(tap).pipe(ws);
      },
      onStderr: stderrLines,
    });
    stderrLines.flush();
    if (cancelled) throw new Error('Backup abgebrochen.');
    await wsDone;
    report(true);

    if (res.code === 1) {
      log('tar meldete Exit-Code 1: Einige Dateien haben sich während des Backups verändert. Das ist bei laufenden Servern normal (Logs etc.).', 'warn');
    } else if (res.code !== 0) {
      throw new Error(`Der Server-Befehl endete mit Exit-Code ${res.code}${res.signal ? ' (' + res.signal + ')' : ''}. Siehe Log.`);
    }
    if (bytes === 0) throw new Error('Es wurden keine Daten empfangen.');

    emit({ type: 'step', id: 'finish', text: 'Backup wird abgeschlossen (Manifest, Restore-Skript)' });
    const finalPath = path.join(outDir, archiveName);
    fs.renameSync(partial, finalPath);
    const sha256 = hash.digest('hex');

    const manifest = {
      tool: 'linback', formatVersion: 1, created: new Date().toISOString(),
      source: {
        host: conn.host, hostname: analysis.hostname, os: analysis.os, kernel: analysis.kernel,
        arch: analysis.arch, bootMode: analysis.bootMode, packages: analysis.packages,
        usedBytes: analysis.usedBytes,
      },
      archive: {
        file: archiveName, compression: cmd.compression, size: fileBytes, sha256,
        encryption: encrypted ? { scheme: crypt.SCHEME, iterations: crypt.ITER, hmacSalt: hmacSalt.toString('hex'), hmac: hmac.digest('hex') } : null,
      },
      tar: { command: cmd.tarCmd, excludes: cmd.excludes, mounts: ['/', ...cmd.mountArgs.map((m) => m.slice(1))] },
      exitCode: res.code,
      durationSec: Math.round((Date.now() - started) / 1000),
    };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, 'system-info.json'), JSON.stringify(analysis, null, 2));
    fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sha256}  ${archiveName}\n`);
    const scriptSrc = path.join(__dirname, 'restore-scripts', 'linback-restore.sh');
    fs.copyFileSync(scriptSrc, path.join(outDir, 'linback-restore.sh'));
    fs.chmodSync(path.join(outDir, 'linback-restore.sh'), 0o755);
    fs.writeFileSync(path.join(outDir, 'README-RESTORE.txt'), restoreReadme(manifest));
    emit({ type: 'done', outDir, manifest });
    return { outDir, manifest };
  } catch (e) {
    fs.rmSync(partial, { force: true }); // an interrupted tar stream cannot be resumed, so don't leave a broken file
    throw e;
  } finally {
    client.end();
  }
}

function restoreReadme(m) {
  return `linback Backup von ${m.source.hostname || m.source.host} (${m.created})
==========================================================================

Inhalt dieses Ordners
  ${m.archive.file}        das Backup (tar, ${m.archive.compression === 'zst' ? 'zstd' : 'gzip'}-komprimiert, mit Rechten/ACLs/xattrs${m.archive.encryption ? ', AES-256-verschlüsselt' : ''})
  manifest.json            Prüfsumme, Quelle, Ausschlüsse
  system-info.json         Hardware-, Platten- und Netzwerk-Analyse des Quellservers (zur Info)
  linback-restore.sh       Wiederherstellungs-Skript (funktioniert ohne die linback-App)

Wiederherstellung ohne App (z. B. Hetzner Rescue-System oder Live-ISO), als root:
  1. Ordner auf das Zielsystem kopieren oder einhängen (z. B. USB-Platte / NFS / scp).
  2. bash linback-restore.sh wizard
  Das Skript fragt Zielplatte(n), Layout (einzeln/RAID1), Swap und Netzwerk-Modus ab,
  LÖSCHT die Zielplatten nach Bestätigung (WIPE), entpackt das Archiv und passt das
  System an die Hardware an (fstab, Netzwerk, initramfs, GRUB).

${m.archive.encryption ? `Das Archiv ist verschlüsselt (openssl-kompatibel, AES-256-CBC + PBKDF2). Ohne Passphrase ist es NICHT wiederherstellbar.
Manuell entschlüsseln:
  LB_PASS='deine passphrase' openssl enc -d -aes-256-cbc -pbkdf2 -iter ${m.archive.encryption.iterations} -md sha256 -pass env:LB_PASS -in ${m.archive.file} | zstd -d | tar -x -C /ziel
(bei gzip statt zstd: gzip -d). Das wizard-Skript fragt die Passphrase selbst ab.

` : ''}Das Backup ist hardwareunabhängig: Partitionen, Bootloader, UUIDs und Netzwerk werden
erst bei der Wiederherstellung passend zur Zielhardware neu erzeugt.

${m.archive.encryption ? 'Die Passphrase wird nirgends gespeichert — bewahre sie getrennt vom Backup auf.' : 'Achtung: Das Archiv enthält /etc/shadow, SSH-Schlüssel und alle Daten im Klartext.\nBewahre es entsprechend geschützt auf.'}
`;
}

/**
 * Re-computes SHA-256 of the archive. For encrypted archives with a passphrase the keyed HMAC is checked as well
 * (detects a wrong passphrase and deliberate manipulation, which the plain hash cannot).
 */
async function verifyBackup(dir, emit, passphrase) {
  const mpath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mpath)) throw new Error('Keine manifest.json im Ordner — das ist kein linback-Backup.');
  const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  const file = path.join(dir, manifest.archive.file);
  if (!fs.existsSync(file)) throw new Error(`Archiv fehlt: ${manifest.archive.file}`);
  const encInfo = manifest.archive.encryption;
  if (encInfo && passphrase === '') passphrase = undefined;
  const size = fs.statSync(file).size;
  const result = { manifest, sizeOk: size === manifest.archive.size, size, hashOk: false, hash: '', encrypted: !!encInfo, hmacChecked: false, hmacOk: null };
  emit({ type: 'step', text: 'SHA-256 wird berechnet' });
  const hash = crypto.createHash('sha256');
  const hmac = encInfo && passphrase ? crypt.createHmac(passphrase, Buffer.from(encInfo.hmacSalt, 'hex')) : null;
  let done = 0;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file);
    rs.on('data', (d) => { hash.update(d); if (hmac) hmac.update(d); done += d.length; emit({ type: 'progress', percent: (done / size) * 100, bytes: done, total: size }); });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  result.hash = hash.digest('hex');
  result.hashOk = result.hash === manifest.archive.sha256;
  if (hmac) {
    result.hmacChecked = true;
    result.hmacOk = crypto.timingSafeEqual(Buffer.from(hmac.digest('hex')), Buffer.from(encInfo.hmac));
  }
  result.ok = result.sizeOk && result.hashOk && result.hmacOk !== false;
  return result;
}

module.exports = { buildBackupCommand, runBackup, verifyBackup, DEFAULT_EXCLUDES, pickCompression };
