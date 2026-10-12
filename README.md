# linback

[Project page](https://fmatsch.ist/linback/) · [Releases](https://github.com/fmatsch/linback/releases)

Back up a Linux server over SSH into an **encrypted, hardware-independent archive** and restore it onto new
hardware. A desktop app for macOS and Windows with a step-by-step wizard that explains what happens at every
step. Built with Hetzner dedicated servers (Ubuntu + Rescue System) in mind.

```
 1 Connect & analyse  ->  2 Backup  ->  3 Verify  ->  4 Restore  ->  5 Boot ISO (optional)
```

## How it works

1. **Connect & analyse** - SSH (password or key; unknown host keys are shown for you to confirm). A read-only
   script collects OS, disks, mounts, boot mode (UEFI/BIOS), network and risks such as running databases.
2. **Backup** - GNU `tar` (`--one-file-system`, numeric owners, ACLs, xattrs, sparse files) is compressed on the
   server (zstd, or gzip as fallback) and streamed through SSH straight into a file on your computer. Nothing is
   staged on the server. The archive is encrypted locally with a passphrase (see below).
   The result folder also contains `manifest.json`, `SHA256SUMS` and a copy of `linback-restore.sh`.
3. **Verify** - re-computes SHA-256 (and the HMAC when you enter the passphrase).
4. **Restore** - on the target server booted into the Hetzner Rescue System: partitions the disk(s) (GPT; single
   disk or software RAID1), streams the archive through SSH and unpacks it on the fly, then adapts the system to
   the new hardware in a `chroot`: new `fstab` with new UUIDs, `mdadm.conf`, network (taken from the target's
   Rescue System, or the original config patched for the new interface/MAC), `initramfs` with all drivers
   (`MODULES=most`) and GRUB for BIOS or UEFI (including the `EFI/BOOT/BOOTX64.EFI` fallback path).
5. **Boot ISO** (optional) - embeds the restore script into a Debian/Ubuntu live ISO you provide (needs `xorriso`).

The backup deliberately contains no partition table, bootloader or UUIDs - that is what makes it
hardware-independent. The restore script also works without the app: `bash linback-restore.sh wizard`.

## Encryption

AES-256-CBC with a key derived from your passphrase (PBKDF2-HMAC-SHA256, 600 000 iterations), done on your computer;
the server never sees the passphrase. The format is `openssl` compatible, so you can always decrypt without this app:

    LB_PASS='passphrase' openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass env:LB_PASS \
      -in system.tar.zst.enc | zstd -d | tar -x -C /target

CBC does not authenticate, so the manifest also stores an HMAC-SHA256 over the ciphertext (keyed with a second
PBKDF2-derived key). The app checks it **before it wipes any disk**, which catches a wrong passphrase and tampering.
**The passphrase is not stored anywhere - if you lose it, the backup is gone.**

## Status and limits

Tested end to end (backup, restore onto empty disks, boot of only the restored disks) with Ubuntu 22.04 virtual
machines in QEMU: BIOS and UEFI, single disk and RAID1. **Not tested** on real hardware, with Secure Boot, LVM
sources, very large backups or the ISO builder. Target must be x86_64 (Debian/Ubuntu). A running database is not
consistent in a file-level backup - dump it first (the app has a field for a pre-backup command). An interrupted
backup cannot be resumed. The restore **wipes the selected target disks** after an explicit confirmation.

## Development

    npm install
    npm start          # run the app
    npm test           # unit + end-to-end tests (mock SSH server)
    npm run dist       # build .dmg (arm64, x64) and Windows installer into dist/

`vmtest/vmtest.js` runs the QEMU-based end-to-end test (see the header of that file; needs `qemu` and an Ubuntu
22.04 cloud image, keep its work directory out of cloud-synced folders).

The installers are not notarized. macOS builds are ad-hoc signed (needed on Apple Silicon, otherwise macOS reports the
app as "damaged"): on first launch go to System Settings -> Privacy & Security -> "Open Anyway", or run
`xattr -dr com.apple.quarantine /Applications/linback.app`. Windows SmartScreen shows "More info -> Run anyway".
Checksums are published as `SHA256SUMS` with every release.

## License

MIT
