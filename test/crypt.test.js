'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const crypt = require('../src/core/crypt');

async function collect(readable) { const out = []; for await (const c of readable) out.push(c); return Buffer.concat(out); }
const encrypt = (buf, pass) => collect(Readable.from([buf]).pipe(crypt.createEncryptor(pass)));
const decrypt = (buf, pass, chunk = 7) => {
  const parts = []; for (let i = 0; i < buf.length; i += chunk) parts.push(buf.subarray(i, i + chunk)); // tiny chunks: header split across writes
  return collect(Readable.from(parts).pipe(crypt.createDecryptor(pass)));
};

test('Roundtrip mit beliebigen Chunk-Grenzen', async () => {
  const plain = crypto.randomBytes(100000);
  const enc = await encrypt(plain, 'geheim');
  assert.equal(enc.subarray(0, 8).toString(), 'Salted__');
  assert.ok(!enc.includes(plain.subarray(0, 32)));
  assert.ok((await decrypt(enc, 'geheim')).equals(plain));
  assert.ok((await decrypt(await encrypt(Buffer.alloc(0), 'x'), 'x')).equals(Buffer.alloc(0)));
});

test('falsche Passphrase und fremde Dateien werden abgelehnt', async () => {
  const enc = await encrypt(Buffer.from('hallo '.repeat(1000)), 'richtig');
  // Mit falschem Schlüssel schlägt (bis auf ~1/256) das Padding fehl; deshalb gibt es zusätzlich den HMAC.
  let failures = 0;
  for (let i = 0; i < 20; i++) { try { await decrypt(await encrypt(Buffer.from('x'.repeat(100)), 'richtig'), 'falsch' + i); } catch { failures++; } }
  assert.ok(failures >= 17);
  await assert.rejects(decrypt(Buffer.from('kein verschlüsseltes Archiv, nur Text'), 'x'), /kein verschlüsseltes/);
  await assert.rejects(decrypt(Buffer.from('Salted__abc'), 'x'), /zu kurz|beschädigt/);
  assert.ok(enc.length > 0);
});

test('HMAC hängt von Passphrase und Inhalt ab', () => {
  const salt = crypt.newHmacSalt();
  const mac = (pass, data) => crypt.createHmac(pass, salt).update(data).digest('hex');
  assert.equal(mac('a', 'daten'), mac('a', 'daten'));
  assert.notEqual(mac('a', 'daten'), mac('b', 'daten'));
  assert.notEqual(mac('a', 'daten'), mac('a', 'daten2'));
});

test('openssl-Kompatibilität (so wie im Restore-Skript)', async (t) => {
  const probe = spawnSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-pass', 'pass:x'], { input: 'x' });
  if (probe.status !== 0) return t.skip('openssl ohne -pbkdf2-Unterstützung');
  const plain = crypto.randomBytes(5000);
  const enc = await encrypt(plain, 'pässword mit Ümlaut');
  const dec = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', String(crypt.ITER), '-md', 'sha256', '-pass', 'env:LB_PASS'],
    { input: enc, env: { ...process.env, LB_PASS: 'pässword mit Ümlaut' } });
  assert.equal(dec.status, 0, String(dec.stderr));
  assert.ok(dec.stdout.equals(plain));
  // und umgekehrt: openssl verschlüsselt, wir entschlüsseln
  const enc2 = spawnSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', String(crypt.ITER), '-md', 'sha256', '-pass', 'env:LB_PASS'], { input: plain, env: { ...process.env, LB_PASS: 'pw2' } });
  assert.ok((await decrypt(enc2.stdout, 'pw2', 4096)).equals(plain));
});
