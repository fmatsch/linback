'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { lineSplitter } = require('./util');

const SCRIPT_PATH = path.join(__dirname, 'restore-scripts', 'linback-restore.sh');

function run(cmd, args, onLine) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args); } catch (e) { return resolve({ code: -1, error: e }); }
    const out = lineSplitter(onLine || (() => {}));
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    p.on('error', (error) => resolve({ code: -1, error }));
    p.on('close', (code) => { out.flush(); resolve({ code }); });
  });
}

async function xorrisoStatus() {
  let version = '';
  const r = await run('xorriso', ['-version'], (l) => { if (!version && /xorriso/i.test(l)) version = l; });
  return { available: r.code === 0, version };
}

const ISO_README = `linback Restore-Medium
======================

Dieses ISO ist ein Debian-Live-System, in das der Ordner /linback eingefügt wurde.

So startest du die Wiederherstellung:
  1. Vom ISO booten (Hetzner: KVM-Konsole / virtuelles Medium; alternativ das
     Rescue-System verwenden, dann brauchst du kein ISO).
  2. Im Live-System ein Terminal öffnen und root werden:   sudo -i
  3. Ordner finden:   ls /run/live/medium/linback   (oder: find / -name linback-restore.sh 2>/dev/null)
  4. bash /run/live/medium/linback/linback-restore.sh wizard
  Das Skript fragt Archiv, Zielplatten, Layout und Netzwerk ab, bestätigt vor dem Löschen,
  entpackt das Backup und installiert den Bootloader passend zur Hardware.

Liegt das Archiv nicht im ISO, gib den Pfad zu system.tar.zst an (z. B. USB-Platte,
vorher mit mount einhängen) — oder kopiere es per scp auf das Live-System.
`;

/** Creates a folder that contains the restore script + docs (+ optionally the archive files). */
function stageRestorePackage(dir, backupDir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SCRIPT_PATH, path.join(dir, 'linback-restore.sh'));
  fs.chmodSync(path.join(dir, 'linback-restore.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'README.txt'), ISO_README);
  const copied = [];
  if (backupDir) {
    for (const f of fs.readdirSync(backupDir)) {
      if (/^system\.tar\.(zst|gz)(\.enc)?$|^manifest\.json$|^SHA256SUMS$/.test(f)) {
        fs.copyFileSync(path.join(backupDir, f), path.join(dir, f));
        copied.push(f);
      }
    }
  }
  return { dir, copied };
}

/**
 * Remasters a Debian/Ubuntu live ISO: copies everything (incl. BIOS+UEFI boot setup) and adds /linback.
 * Requires xorriso.
 */
async function buildIso({ baseIso, outIso, stageDir, emit }) {
  if (path.resolve(baseIso) === path.resolve(outIso)) throw new Error('Ziel-ISO darf nicht die Basis-ISO sein.');
  if (!fs.existsSync(baseIso)) throw new Error('Basis-ISO nicht gefunden.');
  const st = await xorrisoStatus();
  if (!st.available) throw new Error('xorriso wurde nicht gefunden. macOS: "brew install xorriso". Windows: in WSL "sudo apt install xorriso" und das Tool dort aufrufen.');
  fs.rmSync(outIso, { force: true });
  const args = ['-indev', baseIso, '-outdev', outIso, '-boot_image', 'any', 'replay', '-file_size_limit', 'off', '-map', stageDir, '/linback', '-commit'];
  emit({ type: 'log', level: 'info', line: 'xorriso ' + args.join(' ') });
  const r = await run('xorriso', args, (l) => emit({ type: 'log', level: 'info', line: l }));
  if (r.code !== 0) throw new Error('xorriso endete mit Exit-Code ' + r.code);
  return { outIso, size: fs.statSync(outIso).size };
}

module.exports = { xorrisoStatus, stageRestorePackage, buildIso, ISO_README };
