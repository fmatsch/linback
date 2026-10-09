#!/usr/bin/env bash
# linback-restore.sh — stellt ein mit linback erzeugtes Backup (tar.zst / tar.gz) auf einem
# leeren Zielsystem wieder her. Läuft im Hetzner-Rescue-System oder von einem Live-ISO.
#
# Unterbefehle:
#   inspect    zeigt Architektur, Boot-Modus, Platten und fehlende Werkzeuge (nur lesend)
#   deps       installiert fehlende Werkzeuge per apt
#   prepare    LÖSCHT die Zielplatten, partitioniert, legt (RAID-)Dateisysteme an, mountet nach $LB_MNT
#   extract    entpackt das Archiv von stdin nach $LB_MNT
#   finalize   passt das System per chroot an die neue Hardware an (fstab, Netzwerk, initramfs, GRUB)
#   wizard     interaktiver Ablauf aus prepare + extract + finalize (für Live-ISO / ohne App)
#
# Umgebungsvariablen (Details siehe cmd_prepare / cmd_finalize):
#   LB_DISKS="/dev/sda /dev/sdb"  LB_LAYOUT=single|raid1  LB_SWAP_GB=8  LB_BOOT_MB=1024
#   LB_NET=rescue|keep|none       LB_COMP=zst|gz          LB_CONFIRM=WIPE

set -Eeuo pipefail

MNT="${LB_MNT:-/mnt/linback-target}"
STATE="${LB_STATE:-/tmp/linback-restore.state}"

step() { printf '##STEP %s\n' "$*"; }
log()  { printf '[linback] %s\n' "$*"; }
warn() { printf '[linback] WARNUNG: %s\n' "$*" >&2; }
die()  { printf '##ERROR %s\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "Dieses Skript muss als root laufen."; }

# /dev/sda + 3 -> /dev/sda3, /dev/nvme0n1 + 3 -> /dev/nvme0n1p3
part() {
  case "$1" in
    *[0-9]) printf '%sp%s' "$1" "$2" ;;
    *)      printf '%s%s' "$1" "$2" ;;
  esac
}

boot_mode() {
  if [ -n "${LB_BOOT_MODE:-}" ]; then printf '%s' "$LB_BOOT_MODE"; return; fi
  if [ -d /sys/firmware/efi ]; then printf 'uefi'; else printf 'bios'; fi
}

primary_if() {
  ip -o route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}'
}

# sed -i, das auch mit BSD-sed (macOS, nur für Tests) funktioniert
sedi() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

pkg_for() {
  case "$1" in
    sgdisk) echo gdisk ;;
    mkfs.vfat) echo dosfstools ;;
    mkfs.ext4) echo e2fsprogs ;;
    partprobe) echo parted ;;
    wipefs|blkid|mkswap) echo util-linux ;;
    *) echo "$1" ;;
  esac
}

missing_tools() {
  local c
  for c in sgdisk zstd mkfs.vfat mkfs.ext4 wipefs partprobe blkid mkswap tar mdadm; do
    command -v "$c" >/dev/null 2>&1 || printf '%s ' "$c"
  done
}

# ---------------------------------------------------------------- inspect
cmd_inspect() {
  printf '##ARCH %s\n' "$(uname -m)"
  printf '##BOOTMODE %s\n' "$(boot_mode)"
  printf '##MISSING %s\n' "$(missing_tools)"
  printf '##NIC %s %s\n' "$(primary_if)" "$(cat "/sys/class/net/$(primary_if)/address" 2>/dev/null || true)"
  echo '##LSBLK_BEGIN'
  lsblk -J -b -d -o NAME,PATH,SIZE,MODEL,SERIAL,TYPE,ROTA,TRAN 2>/dev/null || true
  echo '##LSBLK_END'
  echo '##LSBLK_FULL_BEGIN'
  lsblk -J -b -o NAME,PATH,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT 2>/dev/null || true
  echo '##LSBLK_FULL_END'
}

# ---------------------------------------------------------------- deps
cmd_deps() {
  need_root
  local miss pkgs="" c
  miss="$(missing_tools)"
  [ -z "$miss" ] && { log "Alle benötigten Werkzeuge sind vorhanden."; return 0; }
  for c in $miss; do pkgs="$pkgs $(pkg_for "$c")"; done
  log "Installiere fehlende Pakete:$pkgs"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || die "apt-get update fehlgeschlagen (Netzwerk im Rescue-System prüfen)."
  # shellcheck disable=SC2086
  apt-get install -y -qq $pkgs || die "Installation der Pakete$pkgs fehlgeschlagen."
}

# ---------------------------------------------------------------- state
save_state() {
  {
    printf 'S_LAYOUT=%q\n' "$1"
    printf 'S_BOOTMODE=%q\n' "$2"
    printf 'S_DISKS=%q\n' "$3"
    printf 'S_ROOT_DEV=%q\n' "$4"
    printf 'S_BOOT_DEV=%q\n' "$5"
    printf 'S_SWAP_DEV=%q\n' "$6"
  } > "$STATE"
}

load_state() {
  [ -f "$STATE" ] || die "Kein Zustand gefunden ($STATE). Zuerst 'prepare' ausführen."
  # shellcheck disable=SC1090
  . "$STATE"
}

# ---------------------------------------------------------------- prepare
cmd_prepare() {
  need_root
  [ "${LB_CONFIRM:-}" = "WIPE" ] || die "Sicherheitsabfrage fehlt (LB_CONFIRM=WIPE)."
  local layout="${LB_LAYOUT:-single}" swap_gb="${LB_SWAP_GB:-0}" boot_mb="${LB_BOOT_MB:-1024}"
  local -a disks
  read -r -a disks <<<"${LB_DISKS:-}"
  [ "${#disks[@]}" -gt 0 ] || die "LB_DISKS ist leer."
  case "$layout" in
    single) [ "${#disks[@]}" -eq 1 ] || die "Layout 'single' braucht genau 1 Platte." ;;
    raid1)  [ "${#disks[@]}" -eq 2 ] || die "Layout 'raid1' braucht genau 2 Platten." ;;
    *) die "Unbekanntes Layout: $layout" ;;
  esac
  local d p
  for d in "${disks[@]}"; do [ -b "$d" ] || die "$d ist kein Blockgerät."; done
  if [ "$layout" = raid1 ] && ! command -v mdadm >/dev/null 2>&1; then die "mdadm fehlt (cmd 'deps' ausführen)."; fi
  local bm; bm="$(boot_mode)"

  step "Alte Mounts, RAIDs und Swap auf den Zielplatten lösen"
  umount -R "$MNT" 2>/dev/null || true
  swapoff -a 2>/dev/null || true
  for d in "${disks[@]}"; do
    while read -r mp; do
      if [ -n "$mp" ]; then umount -R "$mp" 2>/dev/null || die "Konnte $mp nicht aushängen."; fi
    done < <(lsblk -ln -o MOUNTPOINT "$d" 2>/dev/null | grep -v '^$' || true)
  done
  if command -v mdadm >/dev/null 2>&1; then mdadm --stop --scan >/dev/null 2>&1 || true; fi

  step "Zielplatten löschen: ${disks[*]}"
  for d in "${disks[@]}"; do
    for p in $(lsblk -ln -o PATH "$d" 2>/dev/null | tail -n +2); do
      mdadm --zero-superblock --force "$p" >/dev/null 2>&1 || true
      wipefs -a -f "$p" >/dev/null 2>&1 || true
    done
    wipefs -a -f "$d" >/dev/null
    sgdisk --zap-all "$d" >/dev/null 2>&1 || true
  done

  step "GPT-Partitionstabelle anlegen (Boot-Modus: $bm)"
  local P_SWAP="" P_BOOT P_ROOT n=2
  if [ "$swap_gb" -gt 0 ]; then P_SWAP=$n; n=$((n+1)); fi
  P_BOOT=$n; P_ROOT=$((n+1))
  local rtype=8300 stype=8200
  if [ "$layout" = raid1 ]; then rtype=FD00; stype=FD00; fi
  for d in "${disks[@]}"; do
    if [ "$bm" = uefi ]; then
      sgdisk -n "1:0:+512M" -t 1:EF00 -c 1:esp "$d" >/dev/null
    else
      sgdisk -n "1:0:+2M" -t 1:EF02 -c 1:bios_boot "$d" >/dev/null
    fi
    if [ -n "$P_SWAP" ]; then
      sgdisk -n "$P_SWAP:0:+${swap_gb}G" -t "$P_SWAP:$stype" -c "$P_SWAP:swap" "$d" >/dev/null
    fi
    sgdisk -n "$P_BOOT:0:+${boot_mb}M" -t "$P_BOOT:$rtype" -c "$P_BOOT:boot" "$d" >/dev/null
    sgdisk -n "$P_ROOT:0:0" -t "$P_ROOT:$rtype" -c "$P_ROOT:root" "$d" >/dev/null
  done
  partprobe "${disks[@]}" >/dev/null 2>&1 || true
  udevadm settle >/dev/null 2>&1 || true
  sleep 2

  local ROOT_DEV BOOT_DEV SWAP_DEV=""
  if [ "$layout" = raid1 ]; then
    step "Software-RAID1 anlegen"
    local D1="${disks[0]}" D2="${disks[1]}"
    mkraid() { # <mdN> <partnr>
      mdadm --create "/dev/$1" --run --level=1 --raid-devices=2 --metadata=1.2 \
        "$(part "$D1" "$2")" "$(part "$D2" "$2")" >/dev/null 2>&1 || die "RAID /dev/$1 konnte nicht angelegt werden."
    }
    local mdn=0
    if [ -n "$P_SWAP" ]; then mkraid "md$mdn" "$P_SWAP"; SWAP_DEV="/dev/md$mdn"; mdn=$((mdn+1)); fi
    mkraid "md$mdn" "$P_BOOT"; BOOT_DEV="/dev/md$mdn"; mdn=$((mdn+1))
    mkraid "md$mdn" "$P_ROOT"; ROOT_DEV="/dev/md$mdn"
  else
    BOOT_DEV="$(part "${disks[0]}" "$P_BOOT")"
    ROOT_DEV="$(part "${disks[0]}" "$P_ROOT")"
    if [ -n "$P_SWAP" ]; then SWAP_DEV="$(part "${disks[0]}" "$P_SWAP")"; fi
  fi

  step "Dateisysteme anlegen (ext4, Swap, ggf. EFI-Partition)"
  mkfs.ext4 -F -q "$ROOT_DEV"
  mkfs.ext4 -F -q "$BOOT_DEV"
  if [ -n "$SWAP_DEV" ]; then mkswap "$SWAP_DEV" >/dev/null; fi
  if [ "$bm" = uefi ]; then
    for d in "${disks[@]}"; do mkfs.vfat -F32 "$(part "$d" 1)" >/dev/null; done
  fi

  step "Ziel nach $MNT mounten"
  mkdir -p "$MNT"
  mount "$ROOT_DEV" "$MNT"
  mkdir -p "$MNT/boot"
  mount "$BOOT_DEV" "$MNT/boot"
  if [ "$bm" = uefi ]; then
    mkdir -p "$MNT/boot/efi"
    mount -o quiet,umask=0077 "$(part "${disks[0]}" 1)" "$MNT/boot/efi"
  fi
  save_state "$layout" "$bm" "${disks[*]}" "$ROOT_DEV" "$BOOT_DEV" "$SWAP_DEV"
  log "Ziel vorbereitet: root=$ROOT_DEV boot=$BOOT_DEV swap=${SWAP_DEV:-keine}"
}

# ---------------------------------------------------------------- extract
cmd_extract() {
  need_root
  load_state
  mountpoint -q "$MNT" || die "$MNT ist nicht gemountet (zuerst 'prepare')."
  local comp="${LB_COMP:-zst}"
  step "Archiv nach $MNT entpacken ($comp)"
  case "$comp" in
    zst) command -v zstd >/dev/null 2>&1 || die "zstd fehlt."; zstd -d -q -c -T0 ;;
    gz)  gzip -d -c ;;
    *)   die "Unbekannte Kompression: $comp" ;;
  esac | tar --extract --file=- --directory="$MNT" --preserve-permissions --same-owner \
       --numeric-owner --acls --xattrs --xattrs-include='*' --warning=no-timestamp
  sync
  [ -f "$MNT/etc/os-release" ] || die "Nach dem Entpacken fehlt $MNT/etc/os-release — Archiv unvollständig?"
  log "Entpacken abgeschlossen."
}

# ---------------------------------------------------------------- finalize helpers
# <root_uuid> <boot_uuid> <esp_uuid|""> <swap_uuid|""> <old_fstab|"">
gen_fstab() {
  printf '# /etc/fstab — von linback neu erzeugt\n'
  printf '# <file system> <mount point> <type> <options> <dump> <pass>\n'
  printf 'UUID=%s / ext4 errors=remount-ro 0 1\n' "$1"
  printf 'UUID=%s /boot ext4 defaults 0 2\n' "$2"
  if [ -n "$3" ]; then printf 'UUID=%s /boot/efi vfat umask=0077 0 1\n' "$3"; fi
  if [ -n "$4" ]; then printf 'UUID=%s none swap sw 0 0\n' "$4"; fi
  if [ -n "${5:-}" ] && [ -f "$5" ]; then
    printf '\n# --- Einträge aus dem Original-Backup (Einträge für andere Geräte sind deaktiviert) ---\n'
    awk '
      /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
      $2 == "/" || $2 == "/boot" || $2 == "/boot/efi" || $3 == "swap" { next }
      $3 ~ /^(tmpfs|proc|sysfs|devpts|ramfs|devtmpfs)$/ { print; next }
      { print "# [linback deaktiviert] " $0 }
    ' "$5"
  fi
}

# Netplan aus den Netzwerkdaten des Zielsystems; Variablen: N_MAC N_V4 N_GW4 N_V6 N_GW6 N_DNS
# (N_V4/N_V6/N_DNS sind durch Leerzeichen getrennte Listen)
gen_netplan() {
  local a d
  echo "# von linback erzeugt: Netzwerkeinstellungen des Zielsystems (Rescue) übernommen."
  echo "# Das Interface wird über die MAC-Adresse gefunden, nicht über den Namen -> hardwareunabhängig."
  echo "network:"
  echo "  version: 2"
  echo "  renderer: networkd"
  echo "  ethernets:"
  echo "    uplink:"
  echo "      match:"
  echo "        macaddress: \"${N_MAC}\""
  if [ -z "${N_V4:-}" ] && [ -z "${N_V6:-}" ]; then
    echo "      dhcp4: true"
    echo "      dhcp6: true"
    return 0
  fi
  echo "      dhcp4: false"
  echo "      dhcp6: false"
  echo "      addresses:"
  for a in ${N_V4:-} ${N_V6:-}; do echo "        - \"$a\""; done
  echo "      routes:"
  if [ -n "${N_GW4:-}" ]; then
    echo "        - to: default"
    echo "          via: \"${N_GW4}\""
    echo "          on-link: true"
  fi
  if [ -n "${N_GW6:-}" ]; then
    echo "        - to: \"::/0\""
    echo "          via: \"${N_GW6}\""
    echo "          on-link: true"
  fi
  if [ -n "${N_DNS:-}" ]; then
    echo "      nameservers:"
    echo "        addresses:"
    for d in $N_DNS; do echo "          - \"$d\""; done
  fi
}

# Netzwerkdaten des laufenden (Rescue-)Systems einsammeln -> N_* Variablen
collect_net() {
  local ifc; ifc="${LB_NET_IF:-$(primary_if)}"
  [ -n "$ifc" ] || die "Kein Standard-Interface im Zielsystem gefunden."
  N_IF="$ifc"
  N_MAC="${LB_NET_MAC:-$(cat "/sys/class/net/$ifc/address" 2>/dev/null || true)}"
  [ -n "$N_MAC" ] || die "MAC-Adresse von $ifc nicht ermittelbar."
  N_V4="${LB_NET_V4:-$(ip -4 -o addr show dev "$ifc" scope global 2>/dev/null | awk '{print $4}' | tr '\n' ' ')}"
  N_V6="${LB_NET_V6:-$(ip -6 -o addr show dev "$ifc" scope global 2>/dev/null | awk '{print $4}' | tr '\n' ' ')}"
  N_GW4="${LB_NET_GW4:-$(ip -4 route show default 2>/dev/null | awk '/default/ {print $3; exit}')}"
  N_GW6="${LB_NET_GW6:-$(ip -6 route show default 2>/dev/null | awk '/default/ {print $3; exit}')}"
  N_DNS="${LB_NET_DNS:-$(awk '/^nameserver/ && $2 !~ /^127\./ && $2 != "::1" {print $2}' /etc/resolv.conf 2>/dev/null | tr '\n' ' ')}"
  if [ -z "$N_DNS" ]; then N_DNS="185.12.64.1 185.12.64.2"; fi
}

# Best-Effort: bestehende Netplan-Dateien auf neue MAC/Interface-Namen umschreiben
# <netplan-dir> <neuer-interface-name> <neue-mac>
patch_netplan_keep() {
  local f keys count key
  for f in "$1"/*.yaml; do
    [ -e "$f" ] || continue
    sedi -E "s/(macaddress:[[:space:]]*)[\"']?([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}[\"']?/\\1\"$3\"/" "$f"
    keys="$(awk '
      /^[[:space:]]*ethernets:[[:space:]]*$/ { inE = 1; match($0, /^[[:space:]]*/); base = RLENGTH; next }
      inE {
        if ($0 ~ /^[[:space:]]*$/) next
        match($0, /^[[:space:]]*/); ind = RLENGTH
        if (ind <= base) { inE = 0; next }
        if (kind == 0) kind = ind
        if (ind == kind && $0 ~ /:[[:space:]]*$/) { s = $0; gsub(/[[:space:]:]/, "", s); print s }
      }' "$f")"
    count="$(printf '%s\n' "$keys" | grep -c . || true)"
    if [ "$count" = 1 ] && ! grep -q 'match:' "$f"; then
      key="$keys"
      if [ "$key" != "$2" ]; then
        sedi -E "s/^([[:space:]]*)$key:/\\1$2:/" "$f"
        log "Netplan: Interface $key -> $2 umbenannt in $(basename "$f")"
      fi
    fi
  done
}

mount_chroot() {
  mkdir -p "$MNT/dev" "$MNT/proc" "$MNT/sys" "$MNT/run"
  mountpoint -q "$MNT/dev"  || { mount --rbind /dev "$MNT/dev"; mount --make-rslave "$MNT/dev" 2>/dev/null || true; }
  mountpoint -q "$MNT/proc" || mount -t proc proc "$MNT/proc"
  mountpoint -q "$MNT/sys"  || { mount --rbind /sys "$MNT/sys"; mount --make-rslave "$MNT/sys" 2>/dev/null || true; }
  mountpoint -q "$MNT/run"  || { mount -t tmpfs tmpfs "$MNT/run"; mkdir -p "$MNT/run/lock"; }
  if [ ! -e "$MNT/etc/resolv.conf.lb-orig" ] && { [ -e "$MNT/etc/resolv.conf" ] || [ -L "$MNT/etc/resolv.conf" ]; }; then
    mv "$MNT/etc/resolv.conf" "$MNT/etc/resolv.conf.lb-orig"
  fi
  cp /etc/resolv.conf "$MNT/etc/resolv.conf" 2>/dev/null || true
  printf '#!/bin/sh\nexit 101\n' > "$MNT/usr/sbin/policy-rc.d"
  chmod +x "$MNT/usr/sbin/policy-rc.d"
}

umount_chroot() {
  rm -f "$MNT/usr/sbin/policy-rc.d" 2>/dev/null || true
  if [ -e "$MNT/etc/resolv.conf.lb-orig" ] || [ -L "$MNT/etc/resolv.conf.lb-orig" ]; then
    rm -f "$MNT/etc/resolv.conf"
    mv "$MNT/etc/resolv.conf.lb-orig" "$MNT/etc/resolv.conf"
  fi
  local m
  for m in run sys proc dev; do
    umount -R "$MNT/$m" 2>/dev/null || umount -Rl "$MNT/$m" 2>/dev/null || true
  done
}

chroot_run() {
  chroot "$MNT" /usr/bin/env DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$@"
}

# ---------------------------------------------------------------- finalize
cmd_finalize() {
  need_root
  load_state
  mountpoint -q "$MNT" || die "$MNT ist nicht gemountet."
  [ -f "$MNT/etc/os-release" ] || die "Im Ziel liegt kein entpacktes System."
  [ "$(uname -m)" = x86_64 ] || die "Nur x86_64-Ziele werden unterstützt (gefunden: $(uname -m))."
  local -a disks; read -r -a disks <<<"$S_DISKS"
  local bm="$S_BOOTMODE" layout="$S_LAYOUT" d

  trap 'umount_chroot' EXIT
  step "chroot vorbereiten (/dev, /proc, /sys, DNS)"
  mount_chroot

  step "/etc/fstab mit den neuen UUIDs schreiben"
  local u_root u_boot u_esp="" u_swap=""
  u_root="$(blkid -s UUID -o value "$S_ROOT_DEV")"
  u_boot="$(blkid -s UUID -o value "$S_BOOT_DEV")"
  if [ "$bm" = uefi ]; then u_esp="$(blkid -s UUID -o value "$(part "${disks[0]}" 1)")"; fi
  if [ -n "$S_SWAP_DEV" ]; then u_swap="$(blkid -s UUID -o value "$S_SWAP_DEV")"; fi
  if [ ! -e "$MNT/etc/fstab.linback-orig" ]; then cp -a "$MNT/etc/fstab" "$MNT/etc/fstab.linback-orig" 2>/dev/null || true; fi
  gen_fstab "$u_root" "$u_boot" "$u_esp" "$u_swap" "$MNT/etc/fstab.linback-orig" > "$MNT/etc/fstab.new"
  mv "$MNT/etc/fstab.new" "$MNT/etc/fstab"

  step "RAID-Konfiguration (mdadm.conf)"
  mkdir -p "$MNT/etc/mdadm"
  if [ "$layout" = raid1 ]; then
    {
      echo "# von linback erzeugt"
      echo "HOMEHOST <ignore>"
      echo "MAILADDR root"
      mdadm --detail --scan
    } > "$MNT/etc/mdadm/mdadm.conf"
  elif [ -f "$MNT/etc/mdadm/mdadm.conf" ]; then
    printf '# von linback bereinigt: Das Zielsystem nutzt kein Software-RAID\nMAILADDR root\n' > "$MNT/etc/mdadm/mdadm.conf"
  fi

  step "Hardware-spezifische Reste entfernen"
  rm -f "$MNT/etc/udev/rules.d/70-persistent-net.rules" "$MNT/etc/udev/rules.d/75-persistent-net-generator.rules"
  if [ -d "$MNT/etc/systemd/network" ]; then
    for f in "$MNT"/etc/systemd/network/*.link; do
      [ -e "$f" ] || continue
      if grep -qi '^MACAddress=' "$f"; then mv "$f" "$f.linback-orig"; log "MAC-gebundene Link-Datei deaktiviert: $(basename "$f")"; fi
    done
  fi
  mkdir -p "$MNT/etc/initramfs-tools/conf.d"
  echo 'MODULES=most' > "$MNT/etc/initramfs-tools/conf.d/linback-modules"
  echo 'RESUME=none'  > "$MNT/etc/initramfs-tools/conf.d/resume"

  local net="${LB_NET:-rescue}" N_IF N_MAC N_V4 N_V6 N_GW4 N_GW6 N_DNS
  step "Netzwerk anpassen (Modus: $net)"
  case "$net" in
    rescue)
      collect_net
      mkdir -p "$MNT/root/linback-netplan-orig"
      mv "$MNT"/etc/netplan/*.yaml "$MNT/root/linback-netplan-orig/" 2>/dev/null || true
      mkdir -p "$MNT/etc/netplan"
      gen_netplan > "$MNT/etc/netplan/01-linback.yaml"
      chmod 600 "$MNT/etc/netplan/01-linback.yaml"
      log "Netplan erzeugt für $N_IF ($N_MAC): ${N_V4}${N_V6}"
      ;;
    keep)
      collect_net
      patch_netplan_keep "$MNT/etc/netplan" "$N_IF" "$N_MAC"
      ;;
    none) log "Netzwerk-Konfiguration bleibt unverändert." ;;
    *) die "Unbekannter Netzwerk-Modus: $net" ;;
  esac
  if [ -d "$MNT/etc/cloud" ]; then
    mkdir -p "$MNT/etc/cloud/cloud.cfg.d"
    echo 'network: {config: disabled}' > "$MNT/etc/cloud/cloud.cfg.d/99-linback-disable-network-config.cfg"
  fi

  step "Benötigte Pakete im System sicherstellen"
  local pkgs miss="" p
  if [ "$bm" = uefi ]; then
    pkgs="grub-efi-amd64-bin grub-efi-amd64-signed shim-signed efibootmgr dosfstools"
  else
    pkgs="grub-pc-bin"
  fi
  if [ "$layout" = raid1 ]; then pkgs="$pkgs mdadm"; fi
  for p in $pkgs; do chroot_run dpkg -s "$p" >/dev/null 2>&1 || miss="$miss $p"; done
  if [ -n "$miss" ]; then
    log "Installiere im Zielsystem:$miss"
    chroot_run apt-get update -qq || die "apt-get update im Zielsystem fehlgeschlagen."
    # shellcheck disable=SC2086
    chroot_run apt-get install -y -qq --no-install-recommends $miss || die "Installation von$miss fehlgeschlagen."
  fi
  ls "$MNT"/boot/vmlinuz-* >/dev/null 2>&1 || die "Im Zielsystem ist kein Kernel installiert (/boot/vmlinuz-*)."

  step "initramfs für beliebige Hardware neu bauen (MODULES=most)"
  chroot_run update-initramfs -u -k all

  step "GRUB installieren und Konfiguration erzeugen"
  if [ "$bm" = uefi ]; then
    chroot_run grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck || warn "grub-install (NVRAM-Eintrag) fehlgeschlagen — Fallback-Pfad wird trotzdem angelegt."
    chroot_run grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --recheck
    if [ "${#disks[@]}" -gt 1 ]; then
      mkdir -p /mnt/lb-esp2
      mount -o quiet "$(part "${disks[1]}" 1)" /mnt/lb-esp2
      cp -rT --no-preserve=all "$MNT/boot/efi" /mnt/lb-esp2
      umount /mnt/lb-esp2
      log "EFI-Partition auf zweite Platte gespiegelt."
    fi
  else
    for d in "${disks[@]}"; do chroot_run grub-install --target=i386-pc --recheck "$d"; done
  fi
  chroot_run update-grub

  step "Ergebnis prüfen und aufräumen"
  grep -q '^[[:space:]]*linux' "$MNT/boot/grub/grub.cfg" || die "grub.cfg enthält keinen Kernel-Eintrag."
  sync
  trap - EXIT
  umount_chroot
  umount -R "$MNT" 2>/dev/null || umount -Rl "$MNT"
  if [ "$layout" = raid1 ]; then log "RAID-Synchronisation läuft im Hintergrund weiter: cat /proc/mdstat"; fi
  printf '##DONE\n'
}

# ---------------------------------------------------------------- Verschlüsselung (openssl-kompatibel, siehe src/core/crypt.js)
OPENSSL_DEC=(openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass env:LB_PASS)

# Prüft vor dem Löschen der Platten, ob die Passphrase stimmt: der entschlüsselte Anfang muss ein zstd-/gzip-Header sein.
# <archiv> <zst|gz>
check_passphrase() {
  local magic want
  magic="$("${OPENSSL_DEC[@]}" -in "$1" 2>/dev/null | head -c 4 | od -An -tx1 | tr -d ' \n' || true)"
  case "$2" in zst) want=28b52ffd ;; gz) want=1f8b ;; *) return 1 ;; esac
  case "$magic" in "$want"*) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- wizard (ohne App)
cmd_wizard() {
  need_root
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "=== linback Wiederherstellung (interaktiv) ==="
  cmd_deps
  echo; echo "Verfügbare Platten:"
  lsblk -d -e 7,11,1,2 -o NAME,SIZE,MODEL,TYPE
  local def_archive archive layout disks swap net confirm
  def_archive="$(ls "$here"/system.tar.* "$here"/../system.tar.* 2>/dev/null | grep -v '\.partial$' | head -n 1 || true)"
  read -r -p "Pfad zum Archiv [${def_archive}]: " archive; archive="${archive:-$def_archive}"
  [ -f "$archive" ] || die "Archiv nicht gefunden: $archive"
  local enc=0
  case "$archive" in
    *.zst.enc) export LB_COMP=zst; enc=1 ;;
    *.gz.enc)  export LB_COMP=gz;  enc=1 ;;
    *.zst)     export LB_COMP=zst ;;
    *.gz)      export LB_COMP=gz ;;
    *) die "Archivendung muss .zst, .gz, .zst.enc oder .gz.enc sein." ;;
  esac
  local adir; adir="$(dirname "$archive")"
  if [ -f "$adir/SHA256SUMS" ] && command -v sha256sum >/dev/null 2>&1; then
    log "Prüfe SHA-256 des Archivs …"
    (cd "$adir" && sha256sum -c --ignore-missing SHA256SUMS) || die "Prüfsumme stimmt nicht — Archiv beschädigt."
  fi
  if [ "$enc" = 1 ]; then
    command -v openssl >/dev/null 2>&1 || die "openssl fehlt (apt-get install openssl)."
    read -r -s -p "Passphrase des Archivs: " LB_PASS; echo; export LB_PASS
    check_passphrase "$archive" "$LB_COMP" || die "Passphrase falsch (oder Archiv beschädigt). Es wurde nichts gelöscht."
  fi
  read -r -p "Layout: 1 = eine Platte, 2 = RAID1 aus zwei Platten [1]: " layout
  if [ "${layout:-1}" = 2 ]; then export LB_LAYOUT=raid1; read -r -p "Beide Platten (z. B. /dev/sda /dev/sdb): " disks
  else export LB_LAYOUT=single; read -r -p "Zielplatte (z. B. /dev/sda): " disks; fi
  export LB_DISKS="$disks"
  read -r -p "Swap in GB [0]: " swap; export LB_SWAP_GB="${swap:-0}"
  read -r -p "Netzwerk: 1 = Daten dieses Systems übernehmen (neue Hardware/IP), 2 = Original anpassen, 3 = nicht ändern [1]: " net
  case "${net:-1}" in 2) export LB_NET=keep ;; 3) export LB_NET=none ;; *) export LB_NET=rescue ;; esac
  echo; echo "ACHTUNG: Alle Daten auf: $disks werden GELÖSCHT."
  read -r -p "Zur Bestätigung WIPE eingeben: " confirm
  [ "$confirm" = WIPE ] || die "Abgebrochen."
  export LB_CONFIRM=WIPE
  cmd_prepare
  if [ "$enc" = 1 ]; then "${OPENSSL_DEC[@]}" -in "$archive" | cmd_extract; else cmd_extract < "$archive"; fi
  cmd_finalize
  echo; echo "Fertig. Mit 'reboot' das wiederhergestellte System starten (Installationsmedium vorher entfernen)."
}

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
  trap 'rc=$?; printf "##ERROR Zeile %s: Befehl fehlgeschlagen (Exit %s)\n" "$LINENO" "$rc" >&2' ERR
  case "${1:-}" in
    inspect|deps|prepare|extract|finalize|wizard) "cmd_$1" ;;
    *) usage; exit 2 ;;
  esac
}

if [ "${LB_SOURCE_ONLY:-0}" != 1 ]; then main "$@"; fi
