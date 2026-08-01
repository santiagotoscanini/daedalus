# platform/bluetooth.nix — host Bluetooth radio (ASUS USB-BT500).
#
# Host-level for the same reason as gpu.nix: the adapter is one piece of
# hardware that any stack may want, so enablement lives here and the
# per-consumer wiring (the D-Bus bind mount) lives with the consumer —
# today only stacks/home-assistant.
#
# The dongle is a Realtek RTL8761BU (usb 0b05:190e). Its firmware is
# already in the kernel's search path (`rtl_bt/rtl8761bu_fw.bin`, from
# linux-firmware via hardware.enableRedistributableFirmware, which
# hardware-configuration.nix pulls in), so btusb binds it and registers
# hci0 with no extra configuration — only bluetoothd was missing.
#
# What this is FOR: BLE sensors (Xiaomi/ATC thermometers, BTHome
# devices) and BLE presence detection. It is NOT a route to the Tuya
# bulbs — Home Assistant's Tuya integration is cloud-only, the
# third-party Tuya-BLE component has been unmaintained since 2024, and
# a single adapter at the server cannot reach bulbs spread across the
# house anyway (BLE is ~10 m and walls hurt). Bulbs need to be back on
# Wi-Fi; this radio does not change that.
#
# Scope note: `bluetoothd` exposes org.bluez on the SYSTEM bus, so any
# process allowed to talk to it can scan for and connect to nearby BLE
# devices.
#
# ── KNOWN BLOCKER: Home Assistant cannot use this yet ───────────────────
# The radio works and the socket is reachable, but HA's D-Bus client is
# rejected:
#
#   bluetooth_adapters.dbus: DBus authentication error ...
#   authentication failed: REJECTED: ['EXTERNAL']
#
# Root cause, measured from inside the container: D-Bus EXTERNAL auth
# compares the uid the client CLAIMS against SO_PEERCRED. Home Assistant
# runs as container-root, so it claims uid 0, while the host's
# dbus-daemon sees uid 1000 (rootless podman maps container root to
# santiago). Claiming 1000 over the same socket returns OK; claiming 0
# returns REJECTED — so this is purely a userns uid mismatch, not a
# policy, permission or mount problem.
#
# Not fixable by configuration. dbus-fast CAN send a bare `AUTH
# EXTERNAL` and let the server use SO_PEERCRED (auth.py, UID_NOT_SPECIFIED),
# which would work — but that is a constructor argument HA never passes,
# and there is no env var. Making the uids match would mean running the
# container as real root, i.e. abandoning rootless podman for the one
# stack that most wants the host netns.
#
# The two real options, neither taken yet:
#   - an xdg-dbus-proxy running as santiago, re-exposing a filtered
#     socket (--talk=org.bluez only) that HA points at via
#     DBUS_SYSTEM_BUS_ADDRESS. Also narrows access to just BlueZ.
#   - ESPHome Bluetooth proxies — upstream's answer for containerised
#     HA, and the only one that fixes RANGE: one adapter at the server
#     cannot cover a house.
#
# A second, separate error (`Missing NET_ADMIN/NET_RAW ... Automatic
# adapter recovery is unavailable`) is cosmetic by comparison — it
# disables adapter auto-recovery, not scanning.
#
# bluetoothd is left enabled regardless: it costs nothing, the adapter
# is genuinely present, and both options above build on it.

{
  hardware.bluetooth = {
    enable = true;

    # Bring the adapter up at boot rather than leaving it soft-blocked
    # and waiting for something to run `bluetoothctl power on` — there
    # is no interactive session on this box to do that.
    powerOnBoot = true;

    settings.General = {
      # Home Assistant reads battery level and some device details
      # through BlueZ's experimental interfaces (org.bluez.Battery1);
      # without this they are simply absent.
      Experimental = true;

      # Passive scanning only makes sense with a controller that
      # supports it; the RTL8761B does. Leaving the rest of BlueZ's
      # defaults alone deliberately — this box pairs nothing by hand.
      JustWorksRepairing = "always";
    };
  };
}
