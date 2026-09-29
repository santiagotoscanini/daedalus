// The phase a rebuilding verb (apply, engine / image / version update) ends
// `done` with when its build moves the kernel, initrd, ZFS, systemd or D-Bus
// (nix/stacks/daedalus/host/lib.sh, the live-switch guard): nothing was
// activated, because only a reboot can take such a change. Not a failure. The
// status's `error` field — the one free-text field every verb status carries —
// holds the reasons, what happened to the change, and the command that
// installs it for the next boot.
export const REBOOT_REQUIRED = 'reboot-required'
