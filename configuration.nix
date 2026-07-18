# s2-server — top-level NixOS configuration.
# Host/system-level settings only (boot, networking, users, SSH, podman
# runtime, GC). Per-stack modules under stacks/<name>/ each contribute
# their own myStack.* entries, kernel modules, and firewall ports —
# NixOS merges across modules.

{
  config,
  pkgs,
  nixpkgs,
  nixpkgs-unstable,
  ...
}:

{
  imports =
    let
      # Recursively collect every *.nix under a dir. Convention: any
      # .nix file under platform/ or stacks/ IS a NixOS module (assets
      # stay non-nix). The flake only sees git-tracked files — a new
      # stack still needs `git add` before it evaluates.
      nixFilesIn =
        dir:
        let
          entries = builtins.readDir dir;
        in
        builtins.concatMap (
          name:
          let
            type = entries.${name};
          in
          if type == "directory" then
            nixFilesIn (dir + "/${name}")
          else if builtins.match ".*\\.nix" name != null then
            [ (dir + "/${name}") ]
          else
            [ ]
        ) (builtins.attrNames entries);
    in
    [ ./hardware-configuration.nix ] ++ nixFilesIn ./platform ++ nixFilesIn ./stacks;

  # ── Boot ────────────────────────────────────────────────────────────────────

  # configurationLimit caps boot-menu generations so /boot doesn't fill.
  boot.loader.systemd-boot = {
    enable = true;
    configurationLimit = 10;
  };
  boot.loader.efi.canTouchEfiVariables = true;

  # ── Networking ──────────────────────────────────────────────────────────────

  # Host identity consumed fleet-wide via myStack.* (platform/common.nix):
  # the LAN IP below also feeds the interface config, so this block is
  # the single place these values are written.
  myStack = {
    lanIp = "192.168.0.2";
    baseDomain = "toscanini.me";
    mail = {
      sender = "s2.toscanini.me@gmail.com";
      alertTo = "santiago@toscanini.me";
      smtpHost = "smtp.gmail.com";
    };
  };

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
        address = config.myStack.lanIp;
        prefixLength = 24;
      }
    ];

    # Every surviving host port is opened by its owning stack module —
    # grep `networking.firewall.allowed` under stacks/.
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

  # ── Nix registry pins ───────────────────────────────────────────────────────

  # Pin the system registry + NIX_PATH to the flake input, so ad-hoc
  # tooling (nix-shell -p, nix shell nixpkgs#foo, nix run) resolves to
  # the SAME nixpkgs the system was built from — no channel needed.
  # (The weekly upgrade itself lives in platform/autoupgrade/.)
  nix.registry.nixpkgs.flake = nixpkgs;
  nix.nixPath = [ "nixpkgs=flake:nixpkgs" ];

  # Pinned at initial-install version. Do NOT bump — controls compat defaults.
  # https://nixos.org/manual/nixos/stable/options#opt-system.stateVersion
  system.stateVersion = "25.11";
}
