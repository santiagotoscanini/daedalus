#!/usr/bin/env bash
# bash-guard.sh — PreToolUse hard guardrail for every Bash tool call.
#
# This is the ENFORCEMENT half of CLAUDE.md's hard rules; the prose is the
# other half. Registered in .claude/settings.json (hooks.PreToolUse,
# matcher Bash). It receives the tool input as JSON on stdin and answers
# with a permission decision:
#
#   deny  — never legitimate on this box (rule 1/2/4 violations)
#   ask   — destructive-but-sometimes-right (rule 3); the reason string
#           carries the recovery cascade so a weaker model learns it at
#           the prompt
#   allow — every segment of a compound command is a known read-only
#           verb (prefix permission rules can't match compounds, so
#           without this the documented debug recipes prompt every time)
#   (silent exit 0) — no opinion; normal permission evaluation applies
#
# False-positive strategy: command-position checks run against STRIPPED
# (quoted spans removed), so a commit message mentioning "sudo git" can
# never trip them. SQL write-verbs are checked on the RAW string because
# SQL lives inside quotes. One level of recursion into `bash -c '…'`
# payloads closes the laundering hole.
#
# Test harness: .claude/hooks/test-bash-guard.sh (run after any edit).
set -u

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  # Fail-open with a loud warning: jq is declared in systemPackages, so
  # this only happens on a half-restored box, where blocking every bash
  # call would also block the restore.
  echo "bash-guard: jq not on PATH — guard INACTIVE" >&2
  exit 0
fi

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

emit() { # $1 decision, $2 reason
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}

strip_quotes() {
  # Newlines become \001 first so a quoted span CROSSING lines (a
  # multi-line `git commit -m "..."`) still strips — sed is line-based
  # and an unclosed-quote-per-line otherwise leaks the quoted text into
  # the command-position checks (found the hard way: a commit message
  # mentioning nix-env tripped the rule-1 deny).
  printf '%s' "$1" | tr '\n' '\001' | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g' | tr '\001' '\n'
}

# ---------------------------------------------------------------- guard
guard() {
  local RAW="$1"
  local S
  S=$(strip_quotes "$RAW")

  # ── rule 1: imperative OS mutation ────────────────────────────────
  if printf '%s' "$S" | grep -qE '(^|[;&|(]\s*|\$\(\s*)sudo\s+(-[^ ]+\s+)*git(\s|$)'; then
    emit deny "sudo git creates root-owned objects that break this repo (CLAUDE.md rule 1). Use plain git; sudo is only for nixos-rebuild."
  fi
  if printf '%s' "$S" | grep -qE '\bnix-(env|channel)\b'; then
    emit deny "This box is flake-pinned: nix-env/nix-channel changes are discarded on rebuild and leave no record. Edit /etc/nixos, git add, sudo nixos-rebuild test (CLAUDE.md rule 1)."
  fi
  if printf '%s' "$S" | grep -qE '\bip6?tables\b' && printf '%s' "$S" | grep -qE '[[:space:]]-(A|I|D|F|X|P|N)\b'; then
    emit deny "Firewall rules are declared in nix (networking.firewall in the owning stack module). Runtime iptables changes die at the next rebuild (CLAUDE.md rule 1)."
  fi
  if printf '%s' "$S" | grep -qE '\bnft\b.*\b(add|insert|delete|flush)\b'; then
    emit deny "Firewall rules are declared in nix. Runtime nft changes die at the next rebuild (CLAUDE.md rule 1)."
  fi
  if printf '%s' "$S" | grep -qE '\bip[[:space:]]+(-[0-9a-z]+[[:space:]]+)*(addr|address|link|route|rule|neigh)[[:space:]]+(add|del|change|replace|flush)\b' \
     || printf '%s' "$S" | grep -qE '\bip[[:space:]]+link[[:space:]]+set\b'; then
    emit deny "Network config is declared in nix (configuration.nix). Runtime ip changes die at the next rebuild (CLAUDE.md rule 1)."
  fi
  if printf '%s' "$S" | grep -qE '\bsysctl\b[[:space:]]+((-[^ ]+[[:space:]]+)*-w\b|.*--write)'; then
    emit deny "Sysctls are declared in nix (boot.kernel.sysctl). Runtime sysctl -w dies at the next rebuild (CLAUDE.md rule 1)."
  fi
  if printf '%s' "$S" | grep -qE '\b(useradd|usermod|userdel|groupadd|groupmod|chpasswd)\b'; then
    emit deny "Users and groups are declared in nix (users.users). Imperative changes die at the next rebuild (CLAUDE.md rule 1)."
  fi
  if printf '%s' "$S" | grep -qE '\b(chmod|chown)\b[^;&|]*[[:space:]]/nix(/|[[:space:]]|$)'; then
    emit deny "/nix store paths are immutable nix-managed state (CLAUDE.md rule 1)."
  fi

  # ── rule 2: CLI writes into app state ─────────────────────────────
  if printf '%s' "$S" | grep -qE '\b(sqlite3|psql)\b'; then
    if printf '%s' "$RAW" | grep -qiE '\b(insert|update|delete|drop|alter|create|replace|truncate|grant|revoke|attach)\b|\.import\b|\.restore\b|pragma[[:space:]]+[a-z_]+[[:space:]]*='; then
      emit deny "Writing app state via CLI is forbidden (CLAUDE.md rule 2): it leaves no rebuild trail and dies on fresh bootstrap. Make it declarative (env var / converge oneshot / ExecStartPost) or use the app's own API/UI. Reading (SELECT, .schema, .tables, .dump) is fine."
    fi
    if printf '%s' "$S" | grep -qE '\b(sqlite3|psql)\b[^;&|]*<' \
       || printf '%s' "$S" | grep -qE '\bpsql\b[^;&|]*[[:space:]]-f\b'; then
      emit ask "Can't verify this SQL file/stdin is read-only (CLAUDE.md rule 2 fences writes). Confirm it contains no INSERT/UPDATE/DDL."
    fi
  fi
  if printf '%s' "$S" | grep -qE '\bsed\b[^;&|]*[[:space:]](-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b' \
     && printf '%s' "$RAW" | grep -qE '(/home/santiago/selfhost/|/var/lib/|/s2/|\.db\b)'; then
    emit deny "sed -i against app state on disk is a rule-2 write: no rebuild trail, dies on fresh bootstrap. Use the app's API/UI or make it declarative."
  fi

  # ── rule 4: secret exposure ───────────────────────────────────────
  # Content-exposing readers on secret material. grep is deliberately
  # exempt — the sanctioned flow is `sudo grep '^ONE_VAR=' /run/secrets/x`.
  if printf '%s' "$S" | grep -qE '\b(cat|head|tail|less|more|dd|base64|xxd|od|strings|awk|perl|python3?)\b[^;|&]*(/run/secrets/|/secrets/|age/keys\.txt|acme\.json)'; then
    emit deny "Wholesale secret read. Sanctioned form: sudo grep '^THE_ONE_VAR=' /run/secrets/<name> (Debugging protocol). acme.json and the age key are never read."
  fi
  if printf '%s' "$S" | grep -qE '\b(cp|install|scp|rsync|tee)\b[^;|&]*(/run/secrets/|/secrets/|age/keys\.txt|acme\.json)'; then
    emit ask "Copying secret material (CLAUDE.md Secrets). Legitimate for a pre-poolwork acme.json backup or a fresh restore — confirm that's what this is."
  fi
  if printf '%s' "$S" | grep -qE '(>|>>)[[:space:]]*[^;|&[:space:]]*(/etc/nixos/[^ ]*/secrets/|acme\.json|/run/secrets/)'; then
    emit deny "These paths are machine-generated/cert state and are never hand-written (CLAUDE.md Secrets)."
  fi
  if printf '%s' "$S" | grep -qE '\b(curl|wget)\b[^;&]*\|[[:space:]]*(ba|z|da)?sh\b'; then
    emit deny "No pipe-to-shell. Download to the scratchpad, read it, then decide."
  fi

  # ── rule 3: destructive, deny tier ────────────────────────────────
  if printf '%s' "$S" | grep -qE '\bzpool[[:space:]]+(destroy|labelclear)\b'; then
    emit deny "Both pools are live and irreplaceable (no off-site backup). There is no sanctioned flow for zpool destroy/labelclear — operator-only, typed by hand."
  fi

  # ── rule 3: destructive, ask tier ─────────────────────────────────
  if printf '%s' "$S" | grep -qE '\bzfs[[:space:]]+(destroy|rollback)\b|\bzpool[[:space:]]+(upgrade|export|import)\b'; then
    emit ask "Destructive/one-way ZFS operation (CLAUDE.md rule 3). rollback discards everything newer than the snapshot — prefer cp from <mount>/.zfs/snapshot/<snap>/. zpool upgrade locks out older ZFS. Confirm."
  fi

  # rm -r/-rf: classify targets.
  if printf '%s' "$S" | grep -qE '(^|[;&|(]\s*|\$\(\s*)(sudo[[:space:]]+)?rm[[:space:]]' \
     && printf '%s' "$S" | grep -qE '[[:space:]]-[a-zA-Z]*r|--recursive'; then
    local seg args a bad_root=0 outside=0
    # Examine every rm segment's non-flag args.
    args=$(printf '%s' "$S" | tr ';|&' '\n' | grep -E '(^|\s)(sudo\s+)?rm\s' \
             | sed -E 's/.*\brm[[:space:]]+//' | tr ' ' '\n' | grep -v '^-' | grep -v '^$' || true)
    while IFS= read -r a; do
      [ -z "$a" ] && continue
      case "${a%/}" in
        /|/etc|/etc/nixos|/nix|/home|/home/santiago|/home/santiago/selfhost|/s2|/var|/var/lib)
          bad_root=1 ;;
        /tmp/*|/var/tmp/*) : ;;
        *) outside=1 ;;
      esac
    done <<<"$args"
    if [ "$bad_root" = 1 ]; then
      emit deny "rm -r of a system/state root. Never legitimate (CLAUDE.md rule 3)."
    fi
    if [ "$outside" = 1 ]; then
      emit ask "Recursive rm outside /tmp|scratch (CLAUDE.md rule 3). Check what depends on the target first; ZFS snapshots cover enrolled datasets for ~1 week."
    fi
  fi

  if printf '%s' "$S" | grep -qE '\b(chmod|chown)\b[^;&|]*(-R\b|--recursive)' \
     && printf '%s' "$S" | grep -qE '(/home/santiago/selfhost|/etc/nixos|/s2)'; then
    emit ask "Wide recursive ownership change (CLAUDE.md rule 3). fleet.statePaths (platform/podman.nix) is the declarative mechanism — state-paths.service re-enforces declared ownership at boot and will fight an imperative chown. Confirm."
  fi

  if printf '%s' "$S" | grep -qE '\bsystemctl\b[[:space:]]+(-[^ ]+[[:space:]]+)*(stop|restart|disable|mask)[[:space:]]+[^ ]*pihole'; then
    emit ask "Pi-hole is LAN DNS for the whole house — this causes a brief house-wide outage. It IS the documented fix for FTL rate-limiting and DNS-down (CLAUDE.md), so confirm and proceed deliberately."
  fi
  if printf '%s' "$S" | grep -qE '\bsystemctl\b[[:space:]]+(-[^ ]+[[:space:]]+)*(stop|restart)[[:space:]]+podman-pg(\.service)?([[:space:]]|$)'; then
    emit ask "A pg restart is a FLEET EVENT (CLAUDE.md): pocket-id dies silently (green unit, dead container) and everything SSO-gated 502s. After this: systemctl restart podman-pocket-id, then verify curl -sk --resolve id.toscanini.me:443:192.168.0.2 https://id.toscanini.me/.well-known/openid-configuration returns 200."
  fi
  if printf '%s' "$S" | grep -qE '\bsystemctl\b[[:space:]]+(-[^ ]+[[:space:]]+)*(enable|disable|mask)\b'; then
    emit ask "Unit enablement is declared in nix; an imperative enable/disable is discarded at the next rebuild (CLAUDE.md rule 1). If this is a temporary measure, confirm; otherwise edit the module."
  fi
  if printf '%s' "$S" | grep -qE '\bpodman[[:space:]]+(system[[:space:]]+prune|volume[[:space:]]+(rm|prune)|rmi)\b'; then
    emit ask "Podman storage removal. Eleven anonymous volumes exist OUTSIDE the backup tree (CLAUDE.md 'NOT in any backup tree') — check podman volume ls before pruning. Confirm."
  fi
  if printf '%s' "$S" | grep -qE '\bgit[[:space:]]+push\b.*([[:space:]]--force|[[:space:]]-f\b)'; then
    emit ask "Force-push rewrites the remote history that IS the system's recovery path (repo = the box). Confirm."
  fi

  return 0
}

guard "$CMD"

# One-level recursion into shell -c payloads (laundering hole).
if printf '%s' "$CMD" | grep -qE '\b(bash|sh|zsh|env|setpriv|su)\b[^;&|]*[[:space:]]-c[[:space:]]'; then
  PAYLOAD=$(printf '%s' "$CMD" | sed -nE "s/.*[[:space:]]-c[[:space:]]+'([^']*)'.*/\1/p")
  [ -z "$PAYLOAD" ] && PAYLOAD=$(printf '%s' "$CMD" | sed -nE 's/.*[[:space:]]-c[[:space:]]+"([^"]*)".*/\1/p')
  [ -n "$PAYLOAD" ] && guard "$PAYLOAD"
fi

# ── compound-command relief ──────────────────────────────────────────
# If every segment of a compound is a known read-only verb, allow it
# outright: prefix permission rules can't match compounds, and the
# documented debug recipes (Loki-via-Grafana etc.) are compounds.
STRIPPED=$(strip_quotes "$CMD")
if printf '%s' "$STRIPPED" | grep -qE '(&&|;|\|)'; then
  ALL_SAFE=1
  SAFE_RE='^((sudo[[:space:]]+)?(git[[:space:]]+(status|diff|log|show|branch|remote)|systemctl[[:space:]]+(status|is-active|is-enabled|is-failed|list|show|cat|--failed)|journalctl|podman[[:space:]]+(ps|logs|inspect|images|stats|volume[[:space:]]+ls|network[[:space:]]+ls)|grep|rg|curl|zfs[[:space:]]+(list|get)|zpool[[:space:]]+(status|list|get|iostat)|ss|getent|dig|host|ip[[:space:]]+(-[0-9a-z]+[[:space:]]+)*(a|addr|address|r|route|link)([[:space:]]+show)?\b|ls|wc|cut|awk|sort|uniq|head|tail|tr|sed|echo|printf|sleep|date|readlink|stat|df|du|free|uptime|md5sum|sha256sum|which|command|jq|xargs|test|true|cd|column|comm|diff|find|nixos-version|nix[[:space:]]+(eval|flake[[:space:]]+(show|metadata)))|\[)([[:space:]]|$)'
  while IFS= read -r seg; do
    seg=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    [ -z "$seg" ] && continue
    # Strip leading VAR=... assignments and the rootless-podman env prefix.
    seg=$(printf '%s' "$seg" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)+//')
    seg=$(printf '%s' "$seg" | sed -E 's/^sudo[[:space:]]+-u[[:space:]]+santiago[[:space:]]+env[[:space:]]+[^[:space:]]+[[:space:]]+//')
    seg=$(printf '%s' "$seg" | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)+//')
    if ! printf '%s' "$seg" | grep -qE "$SAFE_RE"; then
      ALL_SAFE=0
      break
    fi
  done < <(printf '%s' "$STRIPPED" | sed -E 's/\&\&|\|\|/\n/g; s/[;|]/\n/g')
  if [ "$ALL_SAFE" = 1 ]; then
    emit allow "all segments are read-only"
  fi
fi

exit 0
