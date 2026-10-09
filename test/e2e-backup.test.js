'use strict';
// Ende-zu-Ende-Test der Backup-Pipeline gegen einen lokalen Mock-SSH-Server (ssh2.Server).
// Der Server führt die Befehle lokal aus; ein tar-Shim ersetzt GNU tar (macOS hat nur bsdtar).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Server } = require('ssh2');
const { runBackup, verifyBackup } = require('../src/core/backup');
const { parseAnalysis } = require('../src/core/analyze');
const { fingerprint } = require('../src/core/ssh');

const hasZstd = spawnSync('zstd', ['-V']).status === 0;

function makeShimDir(tmp) {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tar'), `#!/bin/bash
root=/; while [ $# -gt 0 ]; do [ "$1" = "-C" ] && { root="$2"; shift; }; shift; done
echo "LINBACK-CP 3" >&2
echo "tar: ./irgendwas: file changed as we read it" >&2
exec /usr/bin/tar -cf - -C "$root" .
`, { mode: 0o755 });
  return bin;
}

function startServer(hostKey, shimBin) {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {}); // clients that reject the host key abort the handshake
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'root' && ctx.password === 'pw' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _rej, info) => {
        const ch = acceptExec();
        const p = spawn('bash', ['-c', info.command], { env: { ...process.env, PATH: shimBin + ':' + process.env.PATH } });
        p.stdout.pipe(ch, { end: false });
        p.stderr.on('data', (d) => ch.stderr.write(d));
        ch.on('data', (d) => p.stdin.write(d));
        ch.on('end', () => p.stdin.end());
        p.on('close', (code) => { ch.exit(code ?? 1); ch.end(); });
      });
    }));
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}

test('Backup-Pipeline: streamen, Hash, Manifest, Verifikation, Beschädigung erkennen', { skip: !hasZstd && 'zstd nicht installiert' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-e2e-'));
  const src = path.join(tmp, 'srcroot'); fs.mkdirSync(path.join(src, 'etc'), { recursive: true });
  fs.writeFileSync(path.join(src, 'etc', 'hello.conf'), 'hallo welt\n');
  fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
  const keyFile = path.join(tmp, 'host_key');
  assert.equal(spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyFile]).status, 0);
  const server = await startServer(fs.readFileSync(keyFile), makeShimDir(tmp));
  const port = server.address().port;

  const analysis = parseAnalysis('\n@@SECTION hostname\ntestbox\n@@SECTION arch\nx86_64\n@@SECTION tools\ntar=1\nzstd=1\nbash=1\ntar (GNU tar) 1.34\n');
  analysis.backupMounts = [{ target: '/', type: 'ext4', used: 3 * 1024 * 1024 }];
  analysis.usedBytes = 3 * 1024 * 1024;

  // Fingerprint aus dem Public-Key berechnen und als "bekannt" übergeben
  const pub = fs.readFileSync(keyFile + '.pub', 'utf8').split(' ')[1];
  const known = fingerprint(Buffer.from(pub, 'base64'));
  const conn = { host: '127.0.0.1', port, username: 'root', password: 'pw', knownFingerprint: known };

  // Unbekannter Host-Schlüssel muss abgelehnt werden
  const { connect } = require('../src/core/ssh');
  await assert.rejects(connect({ ...conn, knownFingerprint: undefined }), (e) => e.code === 'HOSTKEY_UNKNOWN' && e.fingerprint === known);
  await assert.rejects(connect({ ...conn, knownFingerprint: 'SHA256:falsch' }), (e) => e.code === 'HOSTKEY_CHANGED');

  const events = [];
  const { outDir, manifest } = await runBackup({
    conn, analysis, options: { root: src, nice: false, compression: 'zstd', preCommand: 'echo vorher' },
    baseDir: path.join(tmp, 'out'), emit: (e) => events.push(e), setCancel: () => {},
  });
  server.close();

  assert.ok(fs.existsSync(path.join(outDir, 'system.tar.zst')));
  assert.ok(!fs.existsSync(path.join(outDir, 'system.tar.zst.partial')));
  for (const f of ['manifest.json', 'system-info.json', 'SHA256SUMS', 'linback-restore.sh', 'README-RESTORE.txt']) assert.ok(fs.existsSync(path.join(outDir, f)), f);
  assert.equal(manifest.archive.size, fs.statSync(path.join(outDir, 'system.tar.zst')).size);
  assert.ok(events.some((e) => e.type === 'progress' && e.srcBytes === 3 * 10240));
  assert.ok(events.some((e) => e.type === 'log' && /vorher/.test(e.line)), 'Pre-Befehl-Ausgabe im Log');
  assert.ok(events.some((e) => e.type === 'log' && /file changed/.test(e.line)), 'tar-Warnungen im Log');

  // Inhalt wiederherstellbar?
  const ex = path.join(tmp, 'extract'); fs.mkdirSync(ex);
  const r = spawnSync('bash', ['-c', `zstd -d -q -c "${path.join(outDir, 'system.tar.zst')}" | tar -x -C "${ex}"`]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(fs.readFileSync(path.join(ex, 'etc', 'hello.conf'), 'utf8'), 'hallo welt\n');

  // Verifikation
  const ok = await verifyBackup(outDir, () => {});
  assert.equal(ok.ok, true);
  const fd = fs.openSync(path.join(outDir, 'system.tar.zst'), 'r+'); fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 10); fs.closeSync(fd);
  const bad = await verifyBackup(outDir, () => {});
  assert.equal(bad.ok, false);
  assert.equal(bad.sizeOk, true);
});

test('fehlschlagender Vorbereitungsbefehl bricht das Backup ab und hinterlässt keine .partial-Datei', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-e2e-'));
  const keyFile = path.join(tmp, 'host_key');
  spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyFile]);
  const server = await startServer(fs.readFileSync(keyFile), makeShimDir(tmp));
  const known = fingerprint(Buffer.from(fs.readFileSync(keyFile + '.pub', 'utf8').split(' ')[1], 'base64'));
  const analysis = parseAnalysis('\n@@SECTION tools\ntar=1\nzstd=1\nbash=1\n');
  analysis.backupMounts = [];
  await assert.rejects(runBackup({
    conn: { host: '127.0.0.1', port: server.address().port, username: 'root', password: 'pw', knownFingerprint: known },
    analysis, options: { preCommand: 'exit 3', nice: false }, baseDir: path.join(tmp, 'out'), emit: () => {}, setCancel: () => {},
  }), /Exit-Code 3/);
  server.close();
  const dirs = fs.readdirSync(path.join(tmp, 'out'));
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'out', dirs[0])), []);
});

test('verschlüsseltes Backup: kein Klartext auf der Platte, HMAC-Prüfung, Entschlüsselung', { skip: !hasZstd && 'zstd nicht installiert' }, async () => {
  const crypt = require('../src/core/crypt');
  const { Readable } = require('stream');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-e2e-'));
  const src = path.join(tmp, 'srcroot'); fs.mkdirSync(path.join(src, 'etc'), { recursive: true });
  fs.writeFileSync(path.join(src, 'etc', 'shadow'), 'root:$6$GEHEIMER-HASH:19000:0:99999:7:::\n');
  const keyFile = path.join(tmp, 'host_key');
  spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyFile]);
  const server = await startServer(fs.readFileSync(keyFile), makeShimDir(tmp));
  const known = fingerprint(Buffer.from(fs.readFileSync(keyFile + '.pub', 'utf8').split(' ')[1], 'base64'));
  const analysis = parseAnalysis('\n@@SECTION hostname\nenc\n@@SECTION tools\ntar=1\nzstd=1\nbash=1\n');
  analysis.backupMounts = [{ target: '/', type: 'ext4', used: 1000 }]; analysis.usedBytes = 1000;
  const { outDir, manifest } = await runBackup({
    conn: { host: '127.0.0.1', port: server.address().port, username: 'root', password: 'pw', knownFingerprint: known },
    analysis, options: { root: src, nice: false, compression: 'zstd', passphrase: 'ein langes passwort' },
    baseDir: path.join(tmp, 'out'), emit: () => {}, setCancel: () => {},
  });
  server.close();

  assert.equal(manifest.archive.file, 'system.tar.zst.enc');
  assert.ok(manifest.archive.encryption && manifest.archive.encryption.hmac);
  const file = path.join(outDir, manifest.archive.file);
  assert.equal(fs.statSync(file).size, manifest.archive.size);
  assert.ok(!fs.readFileSync(file).includes('GEHEIMER-HASH'));
  assert.ok(!fs.readFileSync(path.join(outDir, 'README-RESTORE.txt'), 'utf8').includes('ein langes passwort'));

  const good = await verifyBackup(outDir, () => {}, 'ein langes passwort');
  assert.equal(good.ok, true); assert.equal(good.hmacOk, true);
  const wrong = await verifyBackup(outDir, () => {}, 'falsches passwort');
  assert.equal(wrong.hashOk, true); assert.equal(wrong.hmacOk, false); assert.equal(wrong.ok, false);
  const noPass = await verifyBackup(outDir, () => {});
  assert.equal(noPass.ok, true); assert.equal(noPass.hmacChecked, false);

  // gezielte Manipulation inkl. neuem SHA-256 im Manifest: der HMAC muss sie trotzdem entlarven
  const crypto = require('crypto');
  const tampered = fs.readFileSync(file); tampered[tampered.length - 20] ^= 1; fs.writeFileSync(file, tampered);
  manifest.archive.sha256 = crypto.createHash('sha256').update(tampered).digest('hex');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
  const forged = await verifyBackup(outDir, () => {}, 'ein langes passwort');
  assert.equal(forged.hashOk, true); assert.equal(forged.hmacOk, false); assert.equal(forged.ok, false);
  tampered[tampered.length - 20] ^= 1; fs.writeFileSync(file, tampered); // zurück

  // entschlüsseln wie die App beim Restore: Stream -> Decryptor -> zstd -d | tar -x
  const plain = await new Promise((res, rej) => {
    const chunks = [];
    fs.createReadStream(file).pipe(crypt.createDecryptor('ein langes passwort')).on('data', (c) => chunks.push(c)).on('end', () => res(Buffer.concat(chunks))).on('error', rej);
  });
  const ex = path.join(tmp, 'extract'); fs.mkdirSync(ex);
  const r = spawnSync('bash', ['-c', `zstd -d -q -c | tar -x -C "${ex}"`], { input: plain });
  assert.equal(r.status, 0, String(r.stderr));
  assert.match(fs.readFileSync(path.join(ex, 'etc', 'shadow'), 'utf8'), /GEHEIMER-HASH/);
});
