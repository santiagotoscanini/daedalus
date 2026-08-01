"""Syntax-check the nix-generated Home Assistant configuration.yaml.

Home Assistant's own schema validation needs a running instance with
every integration importable, so it can't run in a nix build. This is
the cheap half, and it catches the failure mode that actually bites a
GENERATED config: a templating mistake — a stray interpolation, a
mis-indented block appended by a later edit — that produces a file
which is no longer valid YAML.

Without this the breakage is silent at build time: `nixos-rebuild`
succeeds, the container restarts, and Home Assistant dies on startup.
The only signal is gatus going red a minute later. With it, the rebuild
fails and the running container is never touched.

Home Assistant's loader registers custom tags (`!env_var`, `!include`,
…) that a stock YAML parser rejects outright, so they're registered
here as opaque no-ops — we care about the document's shape, not what
those tags would resolve to at runtime.
"""

import sys

import yaml

# From annotatedyaml's loader — the tag set Home Assistant installs.
HA_TAGS = (
    "!env_var",
    "!secret",
    "!input",
    "!include",
    "!include_dir_list",
    "!include_dir_merge_list",
    "!include_dir_named",
    "!include_dir_merge_named",
)

# Blocks whose loss would be quiet but serious: no `http:` means the
# trusted-proxy config is gone and every proxied request 400s; no
# `recorder:` means it silently falls back to a SQLite file instead of
# the shared cluster.
REQUIRED_KEYS = ("homeassistant", "http", "recorder", "default_config")


class Loader(yaml.SafeLoader):
    """SafeLoader that tolerates Home Assistant's custom tags."""


def _opaque(loader, node):  # noqa: ARG001 - signature fixed by PyYAML
    return None


for tag in HA_TAGS:
    Loader.add_constructor(tag, _opaque)


def main(path: str) -> None:
    with open(path, encoding="utf-8") as handle:
        try:
            data = yaml.load(handle, Loader=Loader)
        except yaml.YAMLError as exc:
            sys.exit(f"configuration.yaml is not valid YAML:\n{exc}")

    if not isinstance(data, dict):
        sys.exit(
            "configuration.yaml must be a mapping at the top level, "
            f"got {type(data).__name__}"
        )

    missing = [key for key in REQUIRED_KEYS if key not in data]
    if missing:
        sys.exit(
            "configuration.yaml lost required block(s): "
            + ", ".join(f"`{key}:`" for key in missing)
        )

    print(f"configuration.yaml OK — {len(data)} top-level keys")


if __name__ == "__main__":
    main(sys.argv[1])
