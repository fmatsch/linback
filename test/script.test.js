'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, '..', 'src', 'core', 'restore-scripts', 'linback-restore.sh');

/** Sources the script (functions only) and runs a snippet. */
function sh(snippet, env = {}) {
  const r = spawnSync('bash', ['-c', `LB_SOURCE_ONLY=1 . ${JSON.stringify(SCRIPT)}; ${snippet}`], { encoding: 'utf8', env: { ...process.env, ...env } });
  return r;
}

test('bash -n: Syntax des Restore-Skripts', () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('part(): SATA und NVMe Partitionsnamen', () => {
  assert.equal(sh('part /dev/sda 3').stdout, '/dev/sda3');
  assert.equal(sh('part /dev/nvme0n1 4').stdout, '/dev/nvme0n1p4');
});

test('gen_fstab: neue UUIDs, fremde Einträge deaktiviert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
  const old = path.join(dir, 'fstab');
  fs.writeFileSync(old, [
    '# alt', 'UUID=OLD-ROOT / ext4 defaults 0 1', 'UUID=OLD-BOOT /boot ext4 defaults 0 2',
    'UUID=OLD-SWAP none swap sw 0 0', 'UUID=DATA /data xfs defaults 0 2', 'nas:/export /mnt/nas nfs defaults 0 0',
    'tmpfs /dev/shm tmpfs defaults 0 0', '',
  ].join('\n'));
  const out = sh(`gen_fstab ROOT1 BOOT1 ESP1 SWAP1 ${old}`).stdout;
  assert.match(out, /^UUID=ROOT1 \/ ext4 /m);
  assert.match(out, /^UUID=BOOT1 \/boot ext4 /m);
  assert.match(out, /^UUID=ESP1 \/boot\/efi vfat /m);
  assert.match(out, /^UUID=SWAP1 none swap /m);
  assert.ok(!/^UUID=OLD/m.test(out));
  assert.match(out, /^# \[linback deaktiviert\] UUID=DATA/m);
  assert.match(out, /^# \[linback deaktiviert\] nas:/m);
  assert.match(out, /^tmpfs \/dev\/shm tmpfs/m);
  const noEsp = sh('gen_fstab R B "" ""').stdout;
  assert.ok(!/boot\/efi|swap/.test(noEsp));
});

test('gen_netplan: statisch (v4+v6, DNS) und DHCP-Fallback', () => {
  const stat = sh('gen_netplan', { N_MAC: 'aa:bb:cc:dd:ee:ff', N_V4: '10.0.0.5/32', N_GW4: '10.0.0.1', N_V6: '2a01::2/64', N_GW6: 'fe80::1', N_DNS: '1.1.1.1 9.9.9.9' }).stdout;
  assert.match(stat, /macaddress: "aa:bb:cc:dd:ee:ff"/);
  assert.match(stat, /- "10\.0\.0\.5\/32"/);
  assert.match(stat, /via: "10\.0\.0\.1"\n\s+on-link: true/);
  assert.match(stat, /to: "::\/0"/);
  assert.match(stat, /- "9\.9\.9\.9"/);
  const dhcp = sh('gen_netplan', { N_MAC: 'aa:bb:cc:dd:ee:ff' }).stdout;
  assert.match(dhcp, /dhcp4: true/);
});

test('patch_netplan_keep: MAC ersetzen, einzelnes Interface umbenennen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
  fs.writeFileSync(path.join(dir, 'a.yaml'), 'network:\n  version: 2\n  ethernets:\n    enp0s31f6:\n      addresses: [1.2.3.4/32]\n');
  fs.writeFileSync(path.join(dir, 'b.yaml'), 'network:\n  version: 2\n  ethernets:\n    lan:\n      match:\n        macaddress: 11:22:33:44:55:66\n      dhcp4: true\n');
  const r = sh(`patch_netplan_keep ${dir} eno1 "de:ad:be:ef:00:01"`);
  assert.equal(r.status, 0, r.stderr);
  const a = fs.readFileSync(path.join(dir, 'a.yaml'), 'utf8');
  const b = fs.readFileSync(path.join(dir, 'b.yaml'), 'utf8');
  assert.match(a, /^    eno1:/m);
  assert.ok(!/enp0s31f6/.test(a));
  assert.match(b, /macaddress: "de:ad:be:ef:00:01"/);
  assert.match(b, /^    lan:/m);
});

test('prepare verweigert ohne Bestätigung und mit falschem Layout', () => {
  let r = sh('cmd_prepare', { LB_DISKS: '/dev/sda', LB_LAYOUT: 'single' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /root|Sicherheitsabfrage/);
  r = sh('id() { echo 0; }; cmd_prepare', { LB_CONFIRM: 'WIPE', LB_DISKS: '/dev/sda', LB_LAYOUT: 'raid1' });
  assert.match(r.stderr, /genau 2 Platten/);
});

test('check_passphrase: erkennt richtige und falsche Passphrase vor dem Löschen', { skip: spawnSync('zstd', ['-V']).status !== 0 && 'zstd fehlt' }, async () => {
  const { Readable } = require('stream');
  const crypt = require('../src/core/crypt');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
  const zst = spawnSync('zstd', ['-q', '-c'], { input: Buffer.from('daten'.repeat(100)) }).stdout;
  const chunks = []; for await (const c of Readable.from([zst]).pipe(crypt.createEncryptor('korrekt'))) chunks.push(c);
  const file = path.join(dir, 'system.tar.zst.enc'); fs.writeFileSync(file, Buffer.concat(chunks));
  assert.equal(sh(`check_passphrase ${file} zst`, { LB_PASS: 'korrekt' }).status, 0);
  assert.notEqual(sh(`check_passphrase ${file} zst`, { LB_PASS: 'falsch' }).status, 0);
});
