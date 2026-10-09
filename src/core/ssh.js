'use strict';
const { Client } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');
const { shq } = require('./util');

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/**
 * opts: { host, port, username, password?, keyPath?, passphrase?, knownFingerprint?, acceptFingerprint? }
 * Rejects with err.code = 'HOSTKEY_UNKNOWN' | 'HOSTKEY_CHANGED' (+ err.fingerprint) when the host key is not trusted.
 */
function connect(opts) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seenFp = null;
    const cfg = {
      host: opts.host,
      port: Number(opts.port) || 22,
      username: opts.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 6,
      hostVerifier: (key) => {
        seenFp = fingerprint(key);
        return seenFp === opts.acceptFingerprint || seenFp === opts.knownFingerprint;
      },
    };
    try {
      if (opts.keyPath) {
        cfg.privateKey = fs.readFileSync(opts.keyPath);
        if (opts.passphrase) cfg.passphrase = opts.passphrase;
      }
      if (opts.password) cfg.password = opts.password;
      if (!cfg.privateKey && !cfg.password && process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK;
    } catch (e) {
      return reject(new Error(`Schlüsseldatei nicht lesbar: ${e.message}`));
    }
    // Handlers stay attached for the life of the client: ssh2 emits "error" again after a failed handshake or a
    // dropped connection, and an "error" event without a listener would crash the whole (Electron main) process.
    let settled = false;
    client.on('ready', () => { settled = true; client.lbFingerprint = seenFp; resolve(client); });
    client.on('error', (err) => {
      if (settled) return; // later errors surface as closed channels in exec()
      settled = true;
      if (seenFp && seenFp !== opts.acceptFingerprint && seenFp !== opts.knownFingerprint) {
        const e = new Error(opts.knownFingerprint
          ? 'Der Host-Schlüssel des Servers hat sich geändert.'
          : 'Der Host-Schlüssel dieses Servers ist noch nicht bekannt.');
        e.code = opts.knownFingerprint ? 'HOSTKEY_CHANGED' : 'HOSTKEY_UNKNOWN';
        e.fingerprint = seenFp;
        e.previous = opts.knownFingerprint;
        return reject(e);
      }
      reject(err);
    });
    client.on('close', () => { if (!settled) { settled = true; reject(new Error('Verbindung wurde vom Server geschlossen.')); } });
    client.connect(cfg);
  });
}

/** Wrap a bash script so it runs under bash (optionally via passwordless sudo). */
function bashCommand(script, sudo) {
  return `${sudo ? 'sudo -n ' : ''}bash -c ${shq(script)}`;
}

/**
 * Run a command. Options:
 *  stdin: string | Buffer | Readable   data for the remote stdin (EOF is sent afterwards)
 *  onStdout/onStderr(chunk)            streaming handlers (if onStdout is missing stdout is captured, capped)
 *  rawStdout: true                     do not attach a data listener (caller pipes the stream itself)
 *  onStream(stream)                    gets the channel as soon as it exists (for piping / cancelling)
 */
function exec(client, command, o = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      const CAP = 8 * 1024 * 1024;
      let out = '', errOut = '';
      if (o.onStream) o.onStream(stream);
      if (!o.rawStdout) {
        stream.on('data', (d) => {
          if (o.onStdout) o.onStdout(d);
          else if (out.length < CAP) out += d.toString('utf8');
        });
      }
      stream.stderr.on('data', (d) => {
        if (o.onStderr) o.onStderr(d);
        else if (errOut.length < CAP) errOut += d.toString('utf8');
      });
      stream.on('close', (code, signal) => resolve({ code, signal, stdout: out, stderr: errOut }));
      stream.on('error', reject);
      if (o.stdin == null) stream.end();
      else if (typeof o.stdin === 'string' || Buffer.isBuffer(o.stdin)) stream.end(o.stdin);
      else o.stdin.pipe(stream);
    });
  });
}

module.exports = { connect, exec, bashCommand, fingerprint };
