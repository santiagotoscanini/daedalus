# fleet-switch-guard — may this generation be ACTIVATED on the running system,
# or does it need a reboot? The one comparison every path that activates a
# generation asks (upgrade-guard.nix has the list), concatenated into a
# writeShellApplication (set -euo pipefail; coreutils, grep, sed, jq on PATH).
#
#   fleet-switch-guard NEW            NEW against the running system
#   fleet-switch-guard NEW REF        NEW against the generation REF (no live facts)
#
# Exit 0: live activation is fine. Exit 3: it needs a reboot — the reasons on
# stdout, one per line, under a first line that starts with NEEDS_REBOOT_MARK.
# Exit 2: a usage error or an unreadable generation, which callers treat as a
# refusal too (the in-generation pre-switch check does).
#
# What needs a reboot is what a live activation cannot replace underneath a
# running system: the kernel, the initrd, the kernel-module tree (out-of-tree
# modules such as ZFS's kmod live there), the ZFS userland's major.minor (it
# must match the loaded kmod), systemd's major version, and the D-Bus
# implementation. Each is read off the generation's own layout — the
# `kernel`, `initrd`, `kernel-modules` and `systemd` links every NixOS
# toplevel has, `sw/bin/zfs`, and the unit behind `dbus.service` — so it
# works against a generation built by any release, including one built before
# this guard existed.
#
# Against the running system the boot-time facts (kernel, initrd, modules,
# ZFS) are compared with /run/booted-system, which is what is actually loaded,
# and cross-checked with the live kernel and ZFS module versions; systemd and
# D-Bus with /run/current-system, which is what PID 1 and the bus run after
# earlier activations re-executed them. Any key present in both generations'
# `switch-inhibitors` files is compared as well, as nixpkgs' own check does.

NEEDS_REBOOT_MARK="fleet-switch-guard: needs a reboot"

die() {
  echo "fleet-switch-guard: $*" >&2
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "usage: fleet-switch-guard NEW-TOPLEVEL [REFERENCE-TOPLEVEL]"

new="$(readlink -f -- "$1")" || die "cannot resolve $1"
[ -e "$new/nixos-version" ] || die "$new is not a NixOS system (no nixos-version)"

live=""
if [ "$#" -eq 2 ]; then
  boot_ref="$(readlink -f -- "$2")" || die "cannot resolve $2"
  run_ref="$boot_ref"
  [ -e "$boot_ref/nixos-version" ] || die "$boot_ref is not a NixOS system"
else
  boot_ref="$(readlink -f /run/booted-system)" || die "no /run/booted-system"
  run_ref="$(readlink -f /run/current-system)" || die "no /run/current-system"
  live=yes
fi

# The target of link $2 inside generation $1, or "none".
target() {
  readlink -f -- "$1/$2" 2>/dev/null || echo none
}

# "zfs-user-2.3.7" → "2.3"; "none" without ZFS.
zfs_mm() {
  local p
  p="$(readlink -f -- "$1/sw/bin/zfs" 2>/dev/null)" || {
    echo none
    return
  }
  p="${p%/bin/zfs}"
  p="${p##*/}"
  p="${p#*-zfs-user-}"
  p="${p#*-zfs-}"
  echo "$p" | sed -nE 's/^([0-9]+\.[0-9]+).*/\1/p' | grep . || echo "unknown(${p})"
}

# "systemd-258.7" → "258".
systemd_major() {
  local p
  p="$(target "$1" systemd)"
  p="${p##*/}"
  p="${p#*-systemd-}"
  p="${p#systemd-}"
  echo "$p" | sed -nE 's/^([0-9]+).*/\1/p' | grep . || echo "unknown(${p})"
}

# "broker" or "dbus", from the unit that answers to dbus.service.
dbus_impl() {
  local u
  u="$(readlink -f -- "$1/etc/systemd/system/dbus.service" 2>/dev/null)" || {
    echo none
    return
  }
  if grep -q '^ExecStart=.*dbus-broker' "$u" 2>/dev/null; then echo broker; else echo dbus; fi
}

# The version directory under a generation's kernel-module tree ("6.12.93").
modules_version() {
  local d
  for d in "$1"/kernel-modules/lib/modules/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    echo "${d##*/}"
    return
  done
  echo none
}

reasons=()
differ() {
  # $1 name, $2 running, $3 new
  [ "$2" = "$3" ] || reasons+=("  $1: $2 -> $3")
}

differ kernel "$(target "$boot_ref" kernel)" "$(target "$new" kernel)"
differ initrd "$(target "$boot_ref" initrd)" "$(target "$new" initrd)"
differ kernel-modules "$(target "$boot_ref" kernel-modules)" "$(target "$new" kernel-modules)"
differ zfs "$(zfs_mm "$boot_ref")" "$(zfs_mm "$new")"
differ systemd-major "$(systemd_major "$run_ref")" "$(systemd_major "$new")"
differ dbus-implementation "$(dbus_impl "$run_ref")" "$(dbus_impl "$new")"

if [ -n "$live" ]; then
  # What is loaded right now, in case /run/booted-system is not the whole
  # story (a kernel kexec'd by hand, a module loaded from elsewhere).
  differ running-kernel "$(uname -r)" "$(modules_version "$new")"
  if [ -r /sys/module/zfs/version ]; then
    kmod="$(sed -nE 's/^([0-9]+\.[0-9]+).*/\1/p' /sys/module/zfs/version)"
    differ loaded-zfs-kmod "${kmod:-unknown}" "$(zfs_mm "$new")"
  fi
fi

# Every inhibitor both generations declare (nixpkgs' mechanism, 26.05+; this
# engine writes the file itself on releases without it).
if [ -f "$run_ref/switch-inhibitors" ] && [ -f "$new/switch-inhibitors" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && reasons+=("  inhibitor $line")
  done < <(jq -rn --slurpfile a "$run_ref/switch-inhibitors" --slurpfile b "$new/switch-inhibitors" '
    ($a[0] // {}) as $old | ($b[0] // {}) as $new
    | $old | to_entries[]
    | select(.key | in($new)) | select(.value != $new[.key])
    | "\(.key): \(.value) -> \($new[.key])"')
fi

if [ "${#reasons[@]}" -eq 0 ]; then
  echo "fleet-switch-guard: $new can be activated live"
  exit 0
fi

# Duplicates (a kernel change shows as kernel, modules and running-kernel) are
# kept: each names a different thing that would be wrong after a live switch.
echo "$NEEDS_REBOOT_MARK — use \`nixos-rebuild boot\` and reboot; live activation (switch/test) is refused:"
printf '%s\n' "${reasons[@]}"
exit 3
