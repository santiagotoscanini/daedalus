# shellcheck shell=bash
# Proof a Factorio version update came up (fleet.versionPins.factorio's
# verifier, run as root by host/version-update.sh after the switch).
#
# Parameters (the wrapper's preamble): OPERATOR_USER, OPERATOR_GROUP,
# OPERATOR_HOME, OPERATOR_RUNTIME_DIR. From the agent: NEW_VERSION.
#
# The image downloads $FACTORIO_VERSION on every start before it starts the
# manager, so the proof is the headless binary itself reporting the new
# version, and the manager answering behind it. A failed download (a version
# Wube does not serve) leaves no binary or the image's own, so it fails here
# rather than passing on a container that merely runs. The game is not
# started: a save is converted only when someone starts it from the manager.

fsm() {
  setpriv --reuid="$OPERATOR_USER" --regid="$OPERATOR_GROUP" --init-groups --inh-caps=-all \
    env HOME="$OPERATOR_HOME" XDG_RUNTIME_DIR="$OPERATOR_RUNTIME_DIR" podman "$@"
}

down=0
for _ in $(seq 1 60); do
  if [ "$(fsm inspect -f '{{.State.Running}}' factorio 2>/dev/null)" = "true" ]; then
    down=0
    got="$(fsm exec factorio /opt/factorio/bin/x64/factorio --version 2>/dev/null | head -n 1 || true)"
    code="$(fsm exec factorio curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:80/ 2>/dev/null || true)"
    echo "verify: binary says '${got:-nothing yet}', manager answers ${code:-nothing}"
    case "$got" in
    "Version: $NEW_VERSION "*)
      case "$code" in
      "" | 000) ;;
      *) exit 0 ;;
      esac
      ;;
    esac
  else
    down=$((down + 1))
    echo "verify: container not running ($down)"
    [ "$down" -ge 30 ] && exit 1
  fi
  sleep 10
done
exit 1
