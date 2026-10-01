# The systemd hardening the box's own units share: what none of them needs,
# taken away. Every unit that takes it is `ProtectSystem = "strict"` and
# merges it under its own keys — what it may write (ReadWritePaths), its
# address families, devices, namespaces and capabilities are each unit's own
# answer.
{
  hardening = {
    # No way up: no setuid, no file capabilities, no new privileges.
    NoNewPrivileges = true;
    RestrictSUIDSGID = true;
    # Its own /tmp.
    PrivateTmp = true;
    # Nothing of the kernel's: tunables, modules, the log ring, the cgroup
    # tree, the clock, the hostname.
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    RestrictRealtime = true;
    LockPersonality = true;
    # Said again, because strict alone does not hold it: beside
    # ProtectKernelTunables or ProtectControlGroups, systemd 260 leaves /run
    # (a mount of its own) writable under ProtectSystem=strict. A unit's
    # ReadWritePaths under /run still win, being more specific; connecting to
    # a socket there is not a write.
    ReadOnlyPaths = [ "/run" ];
  };
}
