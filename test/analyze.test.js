'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseAnalysis } = require('../src/core/analyze');
const { buildBackupCommand } = require('../src/core/backup');
const { buildPlan, parseInspect } = require('../src/core/restore');

const RAW = `
@@SECTION os
PRETTY_NAME="Ubuntu 22.04.4 LTS"
ID=ubuntu
VERSION_ID="22.04"
@@SECTION kernel
Linux 5.15.0-100-generic x86_64
@@SECTION hostname
web01
@@SECTION arch
x86_64
@@SECTION uid
0
@@SECTION cpu
Intel(R) Xeon(R) E-2276G
12
@@SECTION mem
MemTotal:       32768000 kB
SwapTotal:       8388604 kB
@@SECTION boot
uefi
@@SECTION df
Filesystem Type 1-blocks Used Available Capacity Mounted on
/dev/md2 ext4 429496729600 107374182400 300000000000 27% /
/dev/md1 ext4 1000000000 200000000 700000000 22% /boot
/dev/nvme0n1p1 vfat 536870912 5000000 531870912 1% /boot/efi
tmpfs tmpfs 100 0 100 0% /run
server:/export nfs4 1000 500 500 50% /mnt/nas
/dev/md3 xfs 2000000000000 500000000000 1500000000000 25% /data
@@SECTION mdstat
Personalities : [raid1]
md2 : active raid1 nvme0n1p3[0] nvme1n1p3[1]
@@SECTION tools
tar=1
zstd=0
gzip=1
pigz=0
bash=1
ionice=1
tar (GNU tar) 1.34
@@SECTION services
mysql
docker
@@SECTION packages
812
`;

test('parseAnalysis erkennt Mounts, Größe und Warnungen', () => {
  const a = parseAnalysis(RAW);
  assert.equal(a.hostname, 'web01');
  assert.equal(a.os.prettyName, 'Ubuntu 22.04.4 LTS');
  assert.deepEqual(a.backupMounts.map((m) => m.target), ['/', '/boot', '/data']);
  assert.equal(a.usedBytes, 107374182400 + 200000000 + 500000000000);
  assert.equal(a.hasRaid, true);
  assert.equal(a.bootMode, 'uefi');
  assert.equal(a.tools.zstd, false);
  assert.ok(a.warnings.some((w) => /mysql/.test(w.text)));
  assert.ok(a.warnings.some((w) => /zstd/.test(w.text)));
  assert.ok(!a.warnings.some((w) => w.level === 'error'));
});

test('Backup-Befehl: gzip-Fallback, Mountpoints, Excludes, one-file-system', () => {
  const a = parseAnalysis(RAW);
  const c = buildBackupCommand(a, { extraExcludes: ['./home/*/Downloads'] });
  assert.equal(c.ext, 'tar.gz');
  assert.match(c.script, /set -o pipefail/);
  assert.match(c.script, /'--one-file-system'/);
  assert.match(c.script, /'\.\/boot' '\.\/data'/);
  assert.ok(!/'\.\/boot\/efi'/.test(c.mountArgs.join(' ')));
  assert.match(c.script, /'--exclude=\.\/home\/\*\/Downloads'/);
  assert.match(c.script, /\| \$LB_NICE gzip -6/);
  a.tools.zstd = true;
  const z = buildBackupCommand(a, { level: 5, nice: false });
  assert.equal(z.ext, 'tar.zst');
  assert.match(z.script, /\| zstd -T0 -5 -q/);
  assert.ok(!/LB_NICE/.test(z.script));
});

test('Shell-Quoting schützt vor Injection in Excludes', () => {
  const a = parseAnalysis(RAW);
  const c = buildBackupCommand(a, { extraExcludes: ["x'; rm -rf / #"] });
  assert.ok(c.script.includes("'--exclude=x'\\''; rm -rf / #'"));
});

test('buildPlan: UEFI single, RAID1 und Fehlerfälle', () => {
  const disk = (p, s) => ({ path: p, size: s });
  const p = buildPlan({ layout: 'single', disks: [disk('/dev/sda', 512 * 1024 ** 3)], bootMode: 'uefi', swapGb: 8, bootMb: 1024, neededBytes: 100 * 1024 ** 3 });
  assert.deepEqual(p.parts.map((x) => x.label), ['esp', 'swap', 'boot', 'root']);
  assert.equal(p.errors.length, 0);
  const r = buildPlan({ layout: 'raid1', disks: [disk('/dev/a', 1e12), disk('/dev/b', 2e12)], bootMode: 'bios', swapGb: 0, bootMb: 1024 });
  assert.deepEqual(r.parts.map((x) => x.label), ['bios_boot', 'boot', 'root']);
  assert.ok(r.rootSize < 1e12 && r.rootSize > 0.99e12);
  assert.equal(buildPlan({ layout: 'raid1', disks: [disk('/dev/a', 1e12)], bootMode: 'bios' }).errors.length >= 1, true);
  const small = buildPlan({ layout: 'single', disks: [disk('/dev/a', 50 * 1024 ** 3)], bootMode: 'bios', swapGb: 0, bootMb: 1024, neededBytes: 100 * 1024 ** 3 });
  assert.ok(small.errors.some((e) => /zu klein/.test(e)));
});

test('parseInspect liest Marker und filtert Mini-Platten', () => {
  const out = `##ARCH x86_64\n##BOOTMODE bios\n##MISSING sgdisk mdadm\n##NIC eth0 aa:bb:cc:dd:ee:ff\n##LSBLK_BEGIN\n{"blockdevices":[{"name":"sda","path":"/dev/sda","size":500107862016,"type":"disk"},{"name":"loop0","size":100,"type":"loop"}]}\n##LSBLK_END\n`;
  const r = parseInspect(out);
  assert.equal(r.arch, 'x86_64');
  assert.deepEqual(r.missing, ['sgdisk', 'mdadm']);
  assert.equal(r.nic.mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(r.disks.length, 1);
});
