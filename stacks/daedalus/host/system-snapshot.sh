# Publish the facts about this machine that only the HOST can answer.
#
# Everything on the System page that prometheus already scrapes — cpu, memory,
# per-container cgroups, filesystem capacity, pg — is read straight from
# prometheus by the app. This exists for the rest, which is not a small
# category and had no way in at all:
#
#   - SMART. node_exporter ships no SMART collector; the usual answer is a
#     textfile-collector script, which is this script with extra steps and a
#     second scrape interval to reason about. `smartctl` needs root and a raw
#     device, so a container cannot run it however it is packaged.
#   - Self-test HISTORY. smartd runs a short test every Saturday and a long
#     one on the 1st, and the results live in a log ON THE DRIVE. Nothing
#     surfaced them, so "we run multiple disk tests" was true and unverifiable.
#   - Scrub and resilver state, per pool, with when and for how long.
#   - Snapshot usage per dataset — `usedbysnapshots` is a ZFS property, not a
#     filesystem statistic, so node_exporter cannot see it.
#   - The replication pairs, and the LAG between a source snapshot and its
#     copy on the mirror. syncoid exits 0 on a run that replicated nothing.
#   - The boot generations, which are the rollback path CLAUDE.md documents
#     and which nothing on the dashboard could show.
#
# ── why one script rather than five ───────────────────────────────────────
#
# They share a timer, an output file and a failure mode, and they are all
# "shell out to a root-only tool and shape the result". Five units would be
# five things to notice had stopped. The app reads one file and each tab picks
# the key it needs.
#
# ── on cost ───────────────────────────────────────────────────────────────
#
# `smartctl -a` wakes nothing: SMART data is served from the drive's own
# controller and the two HDDs stay spun up anyway. `zpool status` and `zfs
# list` are metadata reads. This is cheap enough to run every ten minutes and
# far too expensive to run per page render, which is the whole argument for a
# snapshot rather than an on-demand call.
#
# No secrets — serial numbers are the closest thing, and they are printed on
# the drives. /run because it is derived state that should not survive a
# reboot or ride the ZFS snapshots.

set -euo pipefail

install -d -m 0755 -o santiago -g users "$OUT_DIR"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# ── disks ─────────────────────────────────────────────────────────────────
#
# Both vocabularies, because the two kinds of drive here report different
# things: ATA exposes numbered attributes (5, 197, 198, 199), NVMe a named
# health log. Rather than flatten them into a lie, each disk carries what its
# own transport reports and the app renders the fields that are non-null.
#
# `-l selftest` is the point of the whole panel. The table is newest-first on
# the drive; the first row is the most recent test, and its "hours" column is
# the drive's power-on hour count when the test ran — which is why the app
# shows it against the current hours rather than as a date. The drive does not
# know what date it was.
disks_json() {
  local first=1
  printf '['
  for dev in $("$LSBLK" -dno NAME); do
    case "$dev" in
    zram* | loop* | sr*) continue ;;
    esac

    raw=$("$SMARTCTL" -j -a -l selftest "/dev/$dev" 2>/dev/null || true)
    # A device smartctl cannot speak to is reported with nulls rather than
    # dropped: "this disk has no SMART" and "we forgot this disk" must not
    # render the same.
    [ -n "$raw" ] || raw='{}'

    [ "$first" = 1 ] || printf ','
    first=0

    printf '%s' "$raw" | "$JQ" -c --arg dev "$dev" '
      # ATA attributes by id, since the NAMES vary between vendors and the
      # numbers do not.
      ( [ (.ata_smart_attributes.table // [])[] ] ) as $attrs
      | def attr($id): ($attrs[] | select(.id == $id) | .raw.value) // null;
      {
        device:        $dev,
        model:         (.model_name // null),
        family:        (.model_family // null),
        serial:        (.serial_number // null),
        firmware:      (.firmware_version // null),
        sizeBytes:     (.user_capacity.bytes // .nvme_total_capacity // null),
        rotationRate:  (.rotation_rate // null),
        # The one-word verdict the drive itself gives. Null when it could not
        # be asked, which is not the same as false.
        passed:        (.smart_status.passed // null),
        temperature:   (.temperature.current // null),
        powerOnHours:  (.power_on_time.hours // null),
        powerCycles:   (.power_cycle_count // null),

        # ATA. Reallocated and pending are the two that actually predict a
        # failing disk; CRC errors are a CABLE fault, not a disk one, which
        # is a distinction worth keeping because the remedy is different.
        reallocated:   attr(5),
        pending:       attr(197),
        uncorrectable: attr(198),
        crcErrors:     attr(199),

        # NVMe. `percentageUsed` is write endurance consumed, not disk usage —
        # the field is named confusingly by the spec, not by us.
        percentageUsed: (.nvme_smart_health_information_log.percentage_used // null),
        spareAvailable: (.nvme_smart_health_information_log.available_spare // null),
        mediaErrors:    (.nvme_smart_health_information_log.media_errors // null),
        unsafeShutdowns:(.nvme_smart_health_information_log.unsafe_shutdowns // null),
        criticalWarning:(.nvme_smart_health_information_log.critical_warning // null),

        selfTests: [
          ( (.ata_smart_self_test_log.standard.table // .nvme_self_test_log.table // [])[]
            | {
                type:   (.type.string // .self_test_type.string // null),
                status: (.status.string // .self_test_result.string // null),
                passed: (if (.status.passed // null) != null then .status.passed
                         else ((.status.string // .self_test_result.string // "")
                               | test("without error")) end),
                hours:  (.lifetime_hours // .power_on_hours // null)
              } )
        ][0:8]
      }'
  done
  printf ']'
}

# ── pools ─────────────────────────────────────────────────────────────────
#
# `zpool status -j` (ZFS 2.3+) carries scan_stats, which is the whole scrub
# story — when it started, when it ended, how much it examined and how many
# errors it found — in a shape that does not need parsing prose. The capacity
# numbers come from `zpool list -p` instead: status reports the raw vdev
# geometry, list reports what the pool will actually hold, and for a mirror
# those differ by half.
pools_json() {
  local status list
  status=$("$ZPOOL" status -j --json-int 2>/dev/null || echo '{"pools":{}}')
  list=$("$ZPOOL" list -Hp -o name,size,alloc,free,fragmentation,capacity,health 2>/dev/null || true)

  printf '%s' "$list" | "$JQ" -R -s --argjson status "$status" '
    [ split("\n")[] | select(length > 0) | split("\t") ]
    | map(
        .[0] as $name
        | ($status.pools[$name] // {}) as $p
        | ($p.scan_stats // {}) as $scan
        | {
            name:        $name,
            sizeBytes:   (.[1] | tonumber),
            allocBytes:  (.[2] | tonumber),
            freeBytes:   (.[3] | tonumber),
            fragPct:     (.[4] | tonumber? // null),
            capacityPct: (.[5] | tonumber),
            health:      .[6],
            state:       ($p.state // null),
            # Vdev names only, one level down from the root: the leaf devices
            # are on the Disks tab and repeating them here would be the same
            # inventory twice.
            vdevs: [ ( ($p.vdevs // {}) | to_entries[]
                       | (.value.vdevs // {}) | to_entries[]
                       | { name: .key, state: (.value.vdev_state // .value.state // null) } ) ],
            scrub: (if ($scan.function // "") == "SCRUB" then {
                      state:      ($scan.state // null),
                      startedAt:  ($scan.start_time // null),
                      endedAt:    ($scan.end_time // null),
                      examined:   ($scan.examined // null),
                      errors:     ($scan.errors // null)
                    } else null end)
          }
      )'
}

# ── datasets ──────────────────────────────────────────────────────────────
#
# `usedbysnapshots` is the number CLAUDE.md tells you to go and check by hand
# after a week of normal operation, because rpool/selfhost is 16K recordsize
# under heavy database churn and its snapshot deltas are bigger than intuition
# says. It is a ZFS property, so no filesystem exporter can reach it.
datasets_json() {
  local snapcounts
  # One pass for the per-dataset snapshot COUNT — the tier policy says the
  # steady state is 39 per fully-enrolled dataset, and a dataset drifting off
  # that number means a timer stopped or a tier was changed.
  snapcounts=$("$ZFS" list -H -t snapshot -o name 2>/dev/null | "$SED" 's/@.*//' | sort | uniq -c |
    "$AWK" '{printf "%s\t%s\n", $2, $1}' || true)

  "$ZFS" list -Hp -o name,used,usedbysnapshots,referenced,available,mountpoint 2>/dev/null |
    "$JQ" -R -s --arg counts "$snapcounts" '
      ( [ $counts | split("\n")[] | select(length > 0) | split("\t") ]
        | map({ key: .[0], value: (.[1] | tonumber) }) | from_entries ) as $n
      | [ split("\n")[] | select(length > 0) | split("\t")
          | { name:            .[0],
              usedBytes:       (.[1] | tonumber),
              snapshotBytes:   (.[2] | tonumber),
              referencedBytes: (.[3] | tonumber),
              availableBytes:  (.[4] | tonumber),
              mountpoint:      (if .[5] == "-" or .[5] == "none" then null else .[5] end),
              snapshots:       ($n[.[0]] // 0) } ]'
}

# ── replication ───────────────────────────────────────────────────────────
#
# The pairing is derived from the target's name, not declared here: syncoid
# replicates rpool/X to s2-pool/backup/X, so every child of the backup root
# names its own source. That keeps this from being a second copy of
# platform/backup.nix that can disagree with it.
#
# The lag is the point. syncoid exits 0 on a run that replicated nothing, and
# the replica is a MIRROR rather than an archive — it prunes whatever the
# source pruned — so "the target has snapshots" is not evidence of anything.
# Comparing the newest snapshot on each side is.
replication_json() {
  local root="$BACKUP_ROOT"
  "$ZFS" list -H -o name -r "$root" 2>/dev/null | "$GREP" -v "^$root\$" | while read -r target; do
    child=${target#"$root"/}
    source="rpool/$child"

    newest() {
      "$ZFS" list -Hp -t snapshot -o name,creation -s creation "$1" 2>/dev/null | tail -1 || true
    }
    src=$(newest "$source")
    dst=$(newest "$target")

    "$JQ" -n -c \
      --arg source "$source" --arg target "$target" \
      --arg src "$src" --arg dst "$dst" \
      --arg n "$("$ZFS" list -H -t snapshot -o name "$target" 2>/dev/null | wc -l)" '
      def parse($row): (if ($row | length) == 0 then null else
        ($row | split("\t")) as $f | { snapshot: ($f[0] | split("@")[1]), at: ($f[1] | tonumber) }
      end);
      parse($src) as $s | parse($dst) as $d
      | { source: $source, target: $target,
          sourceLatest: ($s.snapshot // null), sourceAt: ($s.at // null),
          targetLatest: ($d.snapshot // null), targetAt: ($d.at // null),
          targetSnapshots: ($n | tonumber),
          # Null when either side could not be read — "cannot tell" is not
          # "up to date", and a zero here would claim the second one.
          lagSeconds: (if $s == null or $d == null then null else ($s.at - $d.at) end) }'
  done | "$JQ" -s -c '.'
}

# ── generations ───────────────────────────────────────────────────────────
#
# The rollback path, and the one piece of this file that is about nix rather
# than about hardware. `configurationLimit = 10` keeps ten in the boot menu;
# this lists what is actually there, so a box that has quietly stopped
# collecting garbage — or one where the limit is not doing what it says — is
# visible rather than inferred.
generations_json() {
  "$NIX_ENV" --list-generations -p /nix/var/nix/profiles/system 2>/dev/null |
    "$JQ" -R -s '
      [ split("\n")[] | select(length > 0)
        | (capture("^\\s*(?<id>\\d+)\\s+(?<date>\\S+ \\S+)\\s*(?<cur>\\(current\\))?") // empty)
        | { id: (.id | tonumber), date: .date, current: (.cur != null and .cur != "") } ]'
}

# ── failed units ──────────────────────────────────────────────────────────
#
# The count was already on the Host tab (prometheus's systemd_failed_units);
# this is the NAMES, which the count always made you go and fetch by hand.
# From the host's systemctl rather than a scrape because the answer wants the
# description and sub-state too — "failed (Result: exit-code)" and "failed
# (Result: oom-kill)" are different mornings.
failed_units_json() {
  local raw
  # `--failed` prints `[]` and exits 0 when nothing is failed; the guard is
  # for systemctl itself being unable to answer, which must publish an empty
  # list rather than kill the whole snapshot.
  raw=$("$SYSTEMCTL" --failed --output=json --no-pager 2>/dev/null || true)
  [ -n "$raw" ] || raw='[]'
  printf '%s' "$raw" | "$JQ" -c '
    [ .[] | { unit:        (.unit // null),
              description: (.description // null),
              activeState: (.active // null),
              subState:    (.sub // null) } ]' || echo '[]'
}

# ── jobs ──────────────────────────────────────────────────────────────────
#
# Every timer on the box, with when it last fired, how that run ENDED, and
# when it fires next. fleet.monitoredJobs declares which jobs are worth
# alerting on — the intent — and nothing anywhere published the outcome; the
# Monitoring › Jobs tab joins the two by unit name.
#
# `list-timers` timestamps are CLOCK_REALTIME microseconds; they are shipped
# as epoch SECONDS because everything else in this file that names a moment
# already is. A `last` of 0 is a timer that has never fired since boot, which
# must land as null — "never" and "at the epoch" are different claims.
jobs_json() {
  local timers
  timers=$("$SYSTEMCTL" list-timers --all --output=json --no-pager 2>/dev/null || true)
  [ -n "$timers" ] || timers='[]'

  printf '%s' "$timers" |
    "$JQ" -r '.[] | [.unit, (.activates // ""), (.next // 0), (.last // 0)] | @tsv' |
    while IFS=$'\t' read -r timer svc next last; do
      # Result/ExecMainStatus describe the service's LAST completed run. Both
      # default to success/0 on a service that has never run, so lastAt is
      # the field that says whether they mean anything.
      show=$("$SYSTEMCTL" show "$svc" -p Result,ExecMainStatus 2>/dev/null || true)

      "$JQ" -n -c \
        --arg timer "$timer" --arg svc "$svc" \
        --arg next "$next" --arg last "$last" --arg show "$show" '
        def at: (tonumber? // 0) as $us | (if $us <= 0 then null else ($us / 1000000 | floor) end);
        def prop($k): ($show | split("\n")[] | select(startswith($k + "=")) | ltrimstr($k + "=")) // null;
        { timer:      $timer,
          service:    (if $svc == "" then null else $svc end),
          nextAt:     ($next | at),
          lastAt:     ($last | at),
          result:     prop("Result"),
          exitStatus: (prop("ExecMainStatus") | if . == null then null else (tonumber? // null) end) }'
    done | "$JQ" -s -c '.'
}

# ── hardware ──────────────────────────────────────────────────────────────
#
# What the machine IS, as opposed to what it is doing. None of it changes
# between reboots, and all of it was invisible: the dashboard could show the
# cpu at 40% without being able to say which cpu, or 64 GB in use without
# being able to say what is in the slots or how many are left.
#
# Two sources, chosen per fact rather than per convenience:
#
#   /sys/class/dmi/id/*  — board, BIOS and chassis identity. World-readable,
#                          no tool, no root. Everything here that CAN come
#                          from sysfs does.
#   dmidecode            — the memory modules (SMBIOS type 17) and the cpu's
#                          own record (type 4). These are structured tables
#                          rather than flat strings, sysfs does not decode
#                          them, and /sys/firmware/dmi/tables/DMI is 0400 —
#                          so this is the one part that genuinely needs both
#                          the tool and root.
#
# The BIOS version is read and not compared against anything. MSI publishes
# no machine-readable feed, so a "2 behind" verdict would mean scraping a
# vendor page that will change shape without warning — and a version panel
# that lies is worse than one that only states what is installed.
dmi() { [ -r "/sys/class/dmi/id/$1" ] && tr -d '\n' <"/sys/class/dmi/id/$1" || true; }

# One line per memory slot, fields tab-joined. Records are delimited by
# `Handle`, which is why the parser flushes on it AND at END — the last block
# in the table has no following handle to trigger it.
memory_table() {
  "$DMIDECODE" -t 17 2>/dev/null | "$AWK" '
    /^Handle/ { flush(); next }
    /^Memory Device$/ { inblk = 1; delete f; next }
    inblk && /^\t[A-Z]/ {
      line = $0; sub(/^\t/, "", line)
      k = line; sub(/:.*/, "", k)
      v = line; sub(/^[^:]*:[ \t]*/, "", v); gsub(/[ \t]+$/, "", v)
      f[k] = v
    }
    END { flush() }
    function flush() {
      if (!inblk) return
      inblk = 0
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", f["Locator"], f["Size"], f["Type"], \
        f["Speed"], f["Manufacturer"], f["Part Number"], f["Rank"]
    }'
}

# Memory: every populated slot, plus how many there are in total. "2 of 4
# filled, 128 GB maximum" is the fact an upgrade decision needs and no
# `free -h` anywhere can answer.
memory_json() {
  local array slots max
  # One dmidecode call; both fields come from the same table-16 output.
  array=$("$DMIDECODE" -t 16 2>/dev/null || true)
  slots=$("$GREP" -m1 'Number Of Devices' <<<"$array" | "$SED" 's/.*: *//')
  max=$("$GREP" -m1 'Maximum Capacity' <<<"$array" | "$SED" 's/.*: *//')

  memory_table |
    "$AWK" -F'\t' '$2 ~ /^[0-9]/' |
    "$JQ" -R -s --arg slots "''${slots:-}" --arg max "''${max:-}" '
      def n: (try (capture("(?<v>[0-9]+)").v | tonumber) catch null);
      [ split("\n")[] | select(length > 0) | split("\t")
        | { locator:     .[0],
            sizeGb:      (.[1] | n),
            type:        .[2],
            speedMts:    (.[3] | n),
            manufacturer: .[4],
            partNumber:  (.[5] | sub("\\s+$"; "")),
            rank:        (.[6] | n) } ]
      | { slots: ($slots | n), maxCapacityGb: ($max | n),
          populated: length, totalGb: (map(.sizeGb // 0) | add),
          modules: . }'
}

# The cpu's own SMBIOS record. `nproc` already tells the app how many threads
# there are; what it cannot tell it is that ten cores produce sixteen threads,
# which on Alder Lake is six of them having no hyperthread rather than an
# accident — the distinction the per-core temperature list on Host is showing.
cpu_json() {
  "$DMIDECODE" -t 4 2>/dev/null |
    "$AWK" '
      /^\t(Version|Socket Designation|Core Count|Thread Count|Max Speed):/ {
        line = $0; sub(/^\t/, "", line)
        k = line; sub(/:.*/, "", k)
        v = line; sub(/^[^:]*:[ \t]*/, "", v)
        printf "%s\t%s\n", k, v
      }' |
    "$JQ" -R -s '
      def n: (try (capture("(?<v>[0-9]+)").v | tonumber) catch null);
      [ split("\n")[] | select(length > 0) | split("\t")
        | { key: .[0], value: .[1] } ] | from_entries
      | { model:   .Version,
          socket:  ."Socket Designation",
          cores:   (.["Core Count"] | n),
          threads: (.["Thread Count"] | n),
          maxMhz:  (.["Max Speed"] | n) }'
}

# Fans, voltages and board temperatures are deliberately NOT here.
#
# They arrive through hwmon, which node-exporter already reads and labels —
# `node_hwmon_fan_rpm{sensor="fan1"}` with `node_hwmon_sensor_label` naming it
# "CPU Fan". Reading them here as well would be a second source for one fact,
# sampled on a different timer, that could disagree with the first. This file
# is for what prometheus CANNOT see; the moment the nct6687 driver bound, fan
# speed stopped being in that category.
hardware_json() {
  "$JQ" -n \
    --argjson memory "$(memory_json)" \
    --argjson cpu "$(cpu_json)" \
    --arg boardVendor "$(dmi board_vendor)" \
    --arg boardModel "$(dmi board_name)" \
    --arg boardVersion "$(dmi board_version)" \
    --arg biosVendor "$(dmi bios_vendor)" \
    --arg biosVersion "$(dmi bios_version)" \
    --arg biosDate "$(dmi bios_date)" \
    --arg chassisVendor "$(dmi chassis_vendor)" \
    '{ board: { vendor: $boardVendor, model: $boardModel, version: $boardVersion,
                bios: { vendor: $biosVendor, version: $biosVersion, date: $biosDate } },
       chassis: { vendor: $chassisVendor },
       cpu: $cpu, memory: $memory }
     | walk(if type == "string" and . == "" then null else . end)'
}

"$JQ" -n \
  --argjson disks "$(disks_json)" \
  --argjson pools "$(pools_json)" \
  --argjson datasets "$(datasets_json)" \
  --argjson replication "$(replication_json)" \
  --argjson generations "$(generations_json)" \
  --argjson hardware "$(hardware_json)" \
  --argjson failedUnits "$(failed_units_json)" \
  --argjson jobs "$(jobs_json)" \
  --arg kernel "$("$UNAME" -r)" \
  '{ disks: $disks, pools: $pools, datasets: $datasets,
     replication: $replication, generations: $generations,
     hardware: $hardware, kernel: $kernel,
     failedUnits: $failedUnits, jobs: $jobs }' >"$tmp"

# Validate before publishing, for the same reason image-snapshot does: a
# half-written file would blank three tabs at once, and the previous snapshot
# — stale by at most ten minutes, about facts that move in hours — is strictly
# better than that.
if ! "$JQ" -e . "$tmp" >/dev/null 2>&1; then
  echo "system snapshot was not valid JSON; keeping the previous one" >&2
  exit 1
fi

chmod 0644 "$tmp"
chown santiago:users "$tmp"
mv "$tmp" "$OUT_DIR/system.json"
trap - EXIT

# Say what happened on every run, not only on failure — a successful oneshot
# has NO lines under its own unit, because systemd's "Starting"/"Finished"
# come from PID 1 and journald files them under init.scope. Without this the
# unit is invisible in Loki, which makes it the one thing feeding the System
# page that could stop working with no way to see that it had.
echo "published $("$JQ" '.disks | length' "$OUT_DIR/system.json") disks," \
  "$("$JQ" '.pools | length' "$OUT_DIR/system.json") pools," \
  "$("$JQ" '.datasets | length' "$OUT_DIR/system.json") datasets," \
  "$("$JQ" '.replication | length' "$OUT_DIR/system.json") replication pairs," \
  "$("$JQ" '.generations | length' "$OUT_DIR/system.json") generations," \
  "$("$JQ" '.failedUnits | length' "$OUT_DIR/system.json") failed units," \
  "$("$JQ" '.jobs | length' "$OUT_DIR/system.json") jobs"
