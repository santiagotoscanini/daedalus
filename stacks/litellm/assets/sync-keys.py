# Converge the LiteLLM virtual keys declared in `fleet.litellmKeys`.
#
# Piped into `podman exec -i litellm python3 -` by the wrapper in
# ../keys.nix, which passes three value-less `-e` env passthroughs so
# nothing secret reaches podman's argv (/proc/<pid>/cmdline):
#
#   LITELLM_MASTER    the admin credential, from /run/secrets/litellm-env
#   LITELLM_KEYS      the machine-generated state file, verbatim
#   LITELLM_MANIFEST  non-secret desired state, from the nix store
#
# Runs INSIDE the container against 127.0.0.1:4000. The gateway
# publishes no host port, and reaching it through traefik would make key
# convergence depend on ingress and on the wildcard cert being valid —
# same reasoning as the Pocket ID client sync, which goes in through
# `podman exec` for exactly that reason.
#
# Python rather than curl because this image ships no curl, and the one
# thing this script has to be careful about is arithmetic curl cannot do
# anyway: LiteLLM stores a key as `sha256(key)` under `token`, so the
# question "is the key we hold the key the gateway knows" is answerable
# locally, without sending the secret anywhere to find out.

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:4000"
MASTER = os.environ["LITELLM_MASTER"]
MANIFEST = json.loads(os.environ["LITELLM_MANIFEST"])

# The state file is a dotenv. Blank lines and comments are not expected
# in a machine-written file, but a hand-edited one during a rotation is
# exactly when this runs, so they are tolerated.
SECRETS = dict(
    line.split("=", 1)
    for line in os.environ["LITELLM_KEYS"].splitlines()
    if "=" in line and not line.lstrip().startswith("#")
)


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={
            "Authorization": f"Bearer {MASTER}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read() or b"null")


# `size` is capped at 100 by the endpoint — anything larger is a 422, not
# a clamp — so this pages rather than asking for one big response. A
# short read here would be worse than an error: a key whose hash was on
# page two would look absent and get deleted and recreated on every boot.
live = set()
page, pages = 1, 1
while page <= pages:
    got = api("GET", f"/key/list?return_full_object=true&size=100&page={page}")
    live |= {k["token"] for k in (got.get("keys") or []) if isinstance(k, dict) and k.get("token")}
    pages = got.get("total_pages") or 1
    page += 1

failed = []
for entry in MANIFEST:
    alias = entry["alias"]
    key = SECRETS.get(entry["secretKey"])
    if not key:
        failed.append(f"{alias}: {entry['secretKey']} missing from the state file")
        continue

    # The VALUE is ensure-exists — rewriting a live credential would
    # break its consumer at an unpredictable moment. What the key may DO
    # is converged on every run: it is ordinary declared state, and the
    # nix file has to be able to take a permission away as well as grant
    # one. Sending it as an update also means a permission edit does not
    # rotate the key.
    permissions = {
        "models": entry["models"],
        "object_permission": entry["objectPermission"],
    }

    if hashlib.sha256(key.encode()).hexdigest() in live:
        api("POST", "/key/update", {"key": key, **permissions})
        print(f"{alias}: current")
        continue

    # Either the gateway has never seen this key, or its database was
    # rebuilt, or the state file was rotated. All three converge the same
    # way — and the delete matters in the third case, where an OLD key is
    # still holding the alias and would otherwise keep working.
    try:
        api("POST", "/key/delete", {"key_aliases": [alias]})
        print(f"{alias}: dropped the previous key")
    except urllib.error.HTTPError as err:
        # 404 is the ordinary first-run case: no key holds this alias.
        if err.code != 404:
            raise

    api("POST", "/key/generate", {"key": key, "key_alias": alias, **permissions})
    print(f"{alias}: created")

for line in failed:
    print(line, file=sys.stderr)
sys.exit(1 if failed else 0)
