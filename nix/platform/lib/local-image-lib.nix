# mkLocalImage — a locally built image and its build oneshot, as one helper
# (podman.nix hands it to every module as `_module.args.mkLocalImage`):
#   inherit (mkLocalImage { ... }) image service;
# The tag embeds the build context's store hash, so ANY change to
# the context (base-image digest bump, Containerfile edit, asset
# change) changes the consumer unit's ExecStart and restarts it.
# Without that, a rebuilt image sits unused behind an unchanged tag
# until something else happens to restart the container — a silent
# partial deploy. Layer cache keeps no-change rebuilds ~instant.
#
# `bases` names the images the build file starts FROM, as
# `{ BASE = "repo:tag@sha256:…"; }`: each one reaches the build as
# `--build-arg`, and the file reads it with `ARG BASE` + `FROM ${BASE}`.
# So a base pin lives in nix, once, beside the module — where the
# Updates page can list it — instead of inside a Containerfile. The refs
# are folded into the tag's hash too: they are part of what gets built
# even though they are no longer part of the context. `pins` returns
# them as `fleet.manualPins` entries (id `<name>` for BASE,
# `<name>-<arg>` for any other), each naming the containers its gates
# start and the image label that carries its digest; the caller
# contributes them inside its own switch:
#   fleet.manualPins = img.pins;
# A base pinned in the host's configuration is then moved by the Update
# button like a container's pin (stacks/daedalus/host/image-update.sh).
{
  lib,
  pkgs,
  mkRootlessOneshot,
  parsePin,
}:

{
  name, # localhost/<name>
  tagPrefix ? null, # human-readable tag part; default: the tag of bases.BASE
  contextDir, # store path with the Containerfile + context
  file ? "Containerfile", # the build file, relative to contextDir
  target ? null, # a stage to stop at (`podman build --target`), or the whole file
  gates, # consumer units; build runs before= / wantedBy= them
  bases ? { }, # build arg → digest-pinned base image
  # Further `podman build` flags, each one argument: where the build
  # fetches from (`--build-arg=NPM_REGISTRY=…`, `--add-host=…`), never
  # what it builds — they are not in the tag, so a flag that changed
  # the image would leave a stale tag behind it.
  buildFlags ? [ ],
  # Units the build fetches through (a mirror, the proxy serving it),
  # started before it: a cold build at boot otherwise races them.
  after ? [ ],
}:
let
  # Interpolation imports a literal path into its own
  # content-addressed store path (a derivation is already one) —
  # /nix/store/<hash32>-…, where the hash IS the fingerprint of
  # exactly this context, not of the whole repo.
  ctx = "${contextDir}";
  ctxHash =
    if bases == { } then
      builtins.substring 11 8 ctx
    else
      builtins.substring 0 8 (builtins.hashString "sha256" (ctx + builtins.toJSON bases));
  basePin = parsePin (bases.BASE or "");
  prefix =
    if tagPrefix != null then
      tagPrefix
    else if basePin != null then
      basePin.tag
    else
      throw "mkLocalImage ${name}: give `tagPrefix`, or a digest-pinned `bases.BASE` to take it from";
  image = "localhost/${name}:${prefix}-${ctxHash}";
  buildArgs =
    lib.concatStrings (
      lib.mapAttrsToList (arg: ref: "\n  --build-arg ${lib.escapeShellArg "${arg}=${ref}"} \\") bases
    )
    + lib.concatMapStrings (f: "\n  ${lib.escapeShellArg f} \\") buildFlags;
  # Each base is stamped on the image it built, so "does this container
  # run on the new base?" is a question the image answers — the
  # image-update agent's verify step asks exactly that after moving one
  # (the pin's `label`). The base the final stage starts FROM (BASE, or
  # the only one) takes the OCI keys; any other, a build stage's, the
  # same pair under `daedalus.base.<arg>`.
  finalArg = if bases ? BASE then "BASE" else lib.head (lib.attrNames bases ++ [ null ]);
  labelKey =
    arg:
    if arg == finalArg then "org.opencontainers.image.base" else "daedalus.base.${lib.toLower arg}";
  labels = lib.concatStrings (
    lib.concatLists (
      lib.mapAttrsToList (
        arg: ref:
        let
          p = parsePin ref;
        in
        lib.optionals (p != null) [
          "\n  --label ${lib.escapeShellArg "${labelKey arg}.name=${p.image}"} \\"
          "\n  --label ${lib.escapeShellArg "${labelKey arg}.digest=${p.digest}"} \\"
        ]
      ) bases
    )
  );
  # The containers this image runs as: the podman-<c>.service gates.
  # A gate that is not a container (multi-user.target) names none.
  containers = lib.concatMap (
    g:
    let
      m = builtins.match "podman-(.*)\\.service" g;
    in
    if m == null then [ ] else m
  ) gates;
in
{
  inherit image;
  pins = lib.mapAttrs' (
    arg: ref:
    lib.nameValuePair (if arg == "BASE" then name else "${name}-${lib.toLower arg}") {
      image = ref;
      label = "${labelKey arg}.digest";
      inherit containers;
    }
  ) bases;
  # A cold cache pulls the FROM base from its registry, so this
  # needs real DNS (needsDns), not just network-online. An existing
  # tag is the image this context builds, so a start with it present
  # (every boot, every restart) builds nothing. `LOCAL_IMAGE` names it
  # for the weekly prune (platform/podman-prune), which keeps it.
  service =
    mkRootlessOneshot {
      description = "Build ${image}";
      needsDns = true;
      before = gates;
      wantedBy = gates;
      inherit after;
      execStart = pkgs.writeShellScript "build-${name}-image" ''
        set -eu
        ${pkgs.podman}/bin/podman image exists ${image} && exit 0
        cd ${ctx}
        ${pkgs.podman}/bin/podman build \
          --tag ${image} \${buildArgs}${labels}
          --file ${file} \${lib.optionalString (target != null) "\n  --target ${target} \\"}
          .
      '';
    }
    // {
      environment.LOCAL_IMAGE = image;
    };
}
