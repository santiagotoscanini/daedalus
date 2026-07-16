# s2-server — top-level NixOS configuration.
# Host/system-level settings only (boot, networking, users, SSH, podman
# runtime, GC). Per-stack modules under stacks/<name>/ each contribute
# their own myStack.* entries, kernel modules, and firewall ports —
# NixOS merges across modules.

{
  pkgs,
  nixpkgs,
  nixpkgs-unstable,
  ...
}:

{
  imports = [
    ./hardware-configuration.nix
    ./platform/common.nix
    ./platform/sops.nix
    ./platform/git.nix
    ./platform/ddclient/ddclient.nix
    ./platform/zfs.nix
    ./platform/backup.nix
    ./platform/mail/mail.nix
    ./stacks/calibre-web/calibre-web.nix
    ./stacks/cloudflared/cloudflared.nix
    ./stacks/factorio/factorio.nix
    ./stacks/grocy/grocy.nix
    ./stacks/gatus/gatus.nix
    ./stacks/homepage/homepage.nix
    ./stacks/immich/immich.nix
    ./stacks/intel-gpu-exporter/intel-gpu-exporter.nix
    ./stacks/jellyseerr/jellyseerr.nix
    ./stacks/litellm/litellm.nix
    ./stacks/logging/logging.nix
    ./stacks/metube/metube.nix
    ./stacks/monitoring/monitoring.nix
    ./stacks/myspeed/myspeed.nix
    ./stacks/n8n/n8n.nix
    ./stacks/nextcloud/nextcloud.nix
    ./stacks/pihole/pihole.nix
    ./stacks/stirling-pdf/stirling-pdf.nix
    ./stacks/apps/apps.nix
    ./stacks/apps/declarations.nix
    ./stacks/ipcrawl-vpn/ipcrawl-vpn.nix
    ./stacks/app-db/app-db.nix
    ./stacks/app-db/exporter.nix
    ./stacks/traefik/traefik.nix
    ./stacks/tv/tv.nix
    ./stacks/verdaccio/verdaccio.nix
    ./stacks/wealthfolio/wealthfolio.nix
    ./stacks/wireguard/wireguard.nix
  ];

  # ── Boot ────────────────────────────────────────────────────────────────────

  # configurationLimit caps boot-menu generations so /boot doesn't fill.
  boot.loader.systemd-boot = {
    enable = true;
    configurationLimit = 10;
  };
  boot.loader.efi.canTouchEfiVariables = true;

  # Force i915 on Alder Lake iGPU (UHD 770, PCI ID 4680) for Jellyfin's
  # QSV/VAAPI hardware-accelerated transcoding. Drop this if hardware
  # transcoding ever stops being used.
  boot.kernelParams = [ "i915.force_probe=4680" ];

  # ── Disk health monitoring ──────────────────────────────────────────────────

  # smartd polls every drive's SMART counters and logs failures to
  # journald. `autodetect` picks up every disk without per-drive config.
  services.smartd = {
    enable = true;
    autodetect = true;
    # Short test Sat 02:00, long test 1st-of-month 03:00.
    defaults.autodetected = "-a -s (S/../../6/02|L/../01/./03)";
  };

  # ── Networking ──────────────────────────────────────────────────────────────

  networking = {
    # ZFS records the host ID of the machine that imported a pool last,
    # then refuses to import on a host with a different ID. Must be
    # stable across reboots; do NOT regenerate.
    hostId = "493bc992";

    hostName = "s2-server";

    # Resolve via local pi-hole. openresolv writes only the loopback ns
    # to /etc/resolv.conf (additional public DNS entries here would be
    # ignored); pi-hole forwards upstream itself. Failure mode: pi-hole
    # down → no DNS on the box. SSH by IP, `systemctl restart pihole-ftl`.
    nameservers = [ "127.0.0.1" ];

    defaultGateway = "192.168.0.1";

    # No DHCP — pi-hole IS the LAN's DHCP server, on this same host, so
    # there's no server to lease from at early boot. Static IP below.
    # (s2's MAC is listed in pi-hole's dhcp.hosts for LAN-DNS only —
    # dnsmasq populates the `s2-server.lan` A record from it.)
    useDHCP = false;
    interfaces.enp3s0.useDHCP = false;

    interfaces.enp3s0.ipv4.addresses = [
      {
        address = "192.168.0.2";
        prefixLength = 24;
      }
    ];

    # Every surviving host port is opened by its owning stack module.
    # See CLAUDE.md's "Must-keep host ports" table.
    firewall.enable = true;
  };

  time.timeZone = "America/Argentina/Buenos_Aires";

  # ── Users ───────────────────────────────────────────────────────────────────

  # SSH is key-only and locked to santiago — sudo password adds no security.
  security.sudo.wheelNeedsPassword = false;

  # Authoritative declarations: out-of-band useradd/passwd are reverted on
  # next activation. santiago has no password → account is locked for
  # password login (SSH key only).
  users.mutableUsers = false;

  users.users.santiago = {
    uid = 1000;
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    # linger=true so /run/user/1000 exists at boot before any rootless
    # podman unit fires. Without it, podman-network-*-net oneshots fail
    # with `lstat /run/user/1000: no such file or directory` and every
    # dependent container stays dead until manual start. Must be set
    # explicitly — the option's null default chokes the oci-containers
    # bool reader.
    linger = true;
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDMB4iShrbJ9RsgVh6roT0iJlOge4wHqYmZuRz+uftDX santi@s2"
    ];
    packages = with pkgs; [
      tree
      claude-code
    ];
  };

  # claude-code from the pinned nixos-unstable flake input (stable
  # nixpkgs lags ~6 months). Locked in flake.lock; updated via
  # `nix flake update`.
  nixpkgs.overlays = [
    (
      final: prev:
      let
        unstable = import nixpkgs-unstable {
          inherit (prev.stdenv.hostPlatform) system;
          config.allowUnfree = true;
        };
      in
      {
        inherit (unstable) claude-code;
      }
    )
  ];

  # ── SSH ─────────────────────────────────────────────────────────────────────

  # Key-only SSH. Defaults preserved: port 22, openFirewall=true.
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
      AllowUsers = [ "santiago" ];
    };
  };

  # ignoreIP keeps the laptop from banning itself after a fat-fingered SSH.
  services.fail2ban = {
    enable = true;
    ignoreIP = [
      "127.0.0.1/8"
      "192.168.0.0/24"
    ];
    maxretry = 5;
    bantime = "1h";
    bantime-increment = {
      enable = true;
      maxtime = "168h";
    };
  };

  # ── Podman ──────────────────────────────────────────────────────────────────

  # All containers via virtualisation.oci-containers run rootless as santiago
  # (subuid 100000:65536). dockerCompat installs a `docker` shim → podman.
  virtualisation.podman = {
    enable = true;
    dockerCompat = true;
  };
  virtualisation.oci-containers.backend = "podman";

  # Let rootless pasta bind 80/443 for traefik (no CAP_NET_BIND_SERVICE).
  # Trade-off: any unprivileged process can now bind ≥80. Single-user box.
  boot.kernel.sysctl."net.ipv4.ip_unprivileged_port_start" = 80;

  # nextcloud-redis BGSAVE under memory pressure (1 = always allow).
  boot.kernel.sysctl."vm.overcommit_memory" = 1;

  # ── Intel iGPU userspace (Jellyfin transcoding) ─────────────────────────────

  # OpenGL/Vulkan/VAAPI userspace stack + intel-media-driver — runtime
  # libs Jellyfin's QSV transcoding needs (paired with the i915
  # force_probe kernel param above).
  hardware.graphics = {
    enable = true;
    extraPackages = with pkgs; [ intel-media-driver ];
  };

  # ── System packages ─────────────────────────────────────────────────────────

  environment.systemPackages = with pkgs; [
    vim
    git
    delta
    gh
    htop
    ddclient # CLI for poking at DDNS state when debugging
    intel-gpu-tools # `intel_gpu_top` for watching transcoding load
    fdupes # find duplicate files
  ];

  # ── Memory / swap ───────────────────────────────────────────────────────────

  # Compressed RAM-swap — avoids ZFS CoW-thrash if spikes ever hit 64 GiB.
  zramSwap.enable = true;

  # ── Logging ─────────────────────────────────────────────────────────────────

  # Cap journal size + retention so a chatty service can't fill /.
  services.journald.extraConfig = ''
    SystemMaxUse=2G
    MaxRetentionSec=1month
  '';

  # ── Nix store hygiene ───────────────────────────────────────────────────────

  # Flakes: the repo IS the system definition (see flake.nix). nix-command
  # is the CLI half of the feature pair.
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  # Hardlink identical files inside /nix/store on every insert.
  nix.settings.auto-optimise-store = true;

  # Without this, /nix grows monotonically and /boot fills with old kernels.
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  # Weekly catch-up for store paths inserted before auto-optimise was on.
  nix.optimise = {
    automatic = true;
    dates = [ "weekly" ];
  };

  # ── Auto-upgrade ────────────────────────────────────────────────────────────

  # Pin the system registry + NIX_PATH to the flake input, so ad-hoc
  # tooling (nix-shell -p, nix shell nixpkgs#foo, nix run) resolves to
  # the SAME nixpkgs the system was built from — no channel needed.
  nix.registry.nixpkgs.flake = nixpkgs;
  nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

  # Weekly flake-native upgrade (replaces channel-based system.autoUpgrade):
  # advance flake.lock within the pinned branches, commit the lock, stage
  # the new generation for next boot. Never auto-reboots (you reboot
  # manually) and never touches the running system. Every upgrade is a
  # git commit — inspectable, revertible. Push runs as santiago (offline-tolerant).
  systemd.services.flake-autoupgrade = {
    description = "Update flake.lock, commit, stage next-boot generation, push";
    serviceConfig.Type = "oneshot";
    # System nix (not pkgs.nix): the running nix honors /etc/gitconfig
    # safe.directory for the santiago-owned repo; a mismatched pkgs.nix
    # trips the libgit2 ownership check and the unit fails.
    path = [ pkgs.git ];
    script = ''
      cd /etc/nixos
      /run/current-system/sw/bin/nix flake update --commit-lock-file
      /run/current-system/sw/bin/nixos-rebuild boot --flake /etc/nixos

      # Push the lock-bump commit to origin. Only santiago has the GitHub
      # SSH key (root has none — see platform/git.nix), so drop to santiago
      # with setpriv (no PAM session, matching stacks/apps). The commit
      # above ran as root and wrote root-owned objects into .git; chown it
      # back to santiago first so santiago can push now AND hand-commit
      # later without hitting "insufficient permission" on root-owned
      # objects. Offline must not fail the upgrade: the lock is already
      # committed locally, so a failed push is swallowed and the next run
      # carries it forward.
      ${pkgs.coreutils}/bin/chown -R santiago:users /etc/nixos/.git
      ${pkgs.util-linux}/bin/setpriv --reuid santiago --regid users --init-groups \
        ${pkgs.coreutils}/bin/env HOME=/home/santiago \
          GIT_SSH_COMMAND="${pkgs.openssh}/bin/ssh -i /home/santiago/.ssh/id_ed25519_github -o BatchMode=yes -o IdentitiesOnly=yes" \
        ${pkgs.git}/bin/git push origin main \
        || echo "flake-autoupgrade: git push failed (offline?); lock committed locally, retrying next run"
    '';
  };
  systemd.timers.flake-autoupgrade = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "weekly";
      Persistent = true; # catch up if the box was off
      RandomizedDelaySec = "45min";
    };
  };

  # Pinned at initial-install version. Do NOT bump — controls compat defaults.
  # https://nixos.org/manual/nixos/stable/options#opt-system.stateVersion
  system.stateVersion = "25.11";
}
