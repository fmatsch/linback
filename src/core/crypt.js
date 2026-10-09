'use strict';
/**
 * Archive encryption, compatible with the standard `openssl` tool so a backup can be restored
 * on any Linux without this app:
 *
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass env:LB_PASS -in system.tar.zst.enc
 *
 * Format: "Salted__" + 8 byte salt + AES-256-CBC ciphertext (key+IV from PBKDF2-HMAC-SHA256).
 * CBC alone does not authenticate, so the manifest additionally stores an HMAC-SHA256 over the whole
 * ciphertext, keyed with a second PBKDF2-derived key. The app checks it before it wipes any disk.
 */
const crypto = require('crypto');
const { Transform } = require('stream');

const ITER = 600000;
const MAGIC = Buffer.from('Salted__');
const SCHEME = 'openssl-aes-256-cbc-pbkdf2-sha256';

function keyIv(pass, salt) {
  const d = crypto.pbkdf2Sync(pass, salt, ITER, 48, 'sha256');
  return { key: d.subarray(0, 32), iv: d.subarray(32, 48) };
}

function newHmacSalt() { return crypto.randomBytes(16); }

/** Keyed HMAC context for the ciphertext. */
function createHmac(pass, hmacSalt) {
  const key = crypto.pbkdf2Sync(pass, hmacSalt, ITER, 32, 'sha256');
  return crypto.createHmac('sha256', key);
}

function createEncryptor(pass) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = keyIv(pass, salt);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const t = new Transform({
    transform(chunk, _e, cb) { cb(null, cipher.update(chunk)); },
    flush(cb) { try { cb(null, cipher.final()); } catch (e) { cb(e); } },
  });
  t.push(Buffer.concat([MAGIC, salt]));
  return t;
}

function createDecryptor(pass) {
  let head = Buffer.alloc(0);
  let decipher = null;
  return new Transform({
    transform(chunk, _e, cb) {
      try {
        if (!decipher) {
          head = Buffer.concat([head, chunk]);
          if (head.length < 16) return cb();
          if (!head.subarray(0, 8).equals(MAGIC)) return cb(new Error('Das ist kein verschlüsseltes linback-Archiv (Header fehlt).'));
          const { key, iv } = keyIv(pass, head.subarray(8, 16));
          decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
          const rest = head.subarray(16); head = null;
          return cb(null, rest.length ? decipher.update(rest) : null);
        }
        cb(null, decipher.update(chunk));
      } catch (e) { cb(e); }
    },
    flush(cb) {
      if (!decipher) return cb(new Error('Verschlüsseltes Archiv ist zu kurz oder leer.'));
      try { cb(null, decipher.final()); } catch { cb(new Error('Entschlüsselung fehlgeschlagen: falsche Passphrase oder beschädigtes Archiv.')); }
    },
  });
}

module.exports = { ITER, SCHEME, createEncryptor, createDecryptor, createHmac, newHmacSalt };
