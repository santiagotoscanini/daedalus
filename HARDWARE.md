# Hardware event log

An append-only record of physical-layer events, kept **because journald
on this box holds only ~11 days** (2 GB cap). Without this file the
history that decides "one-off vs trending" is simply gone by the time
anyone asks.

This is deliberately a log, not documentation: entries are dated,
nothing is rewritten, and a resolved event stays in place. Everything
else about the disks — pool layout, datasets, snapshot policy, scrub and
TRIM schedules — lives in `platform/zfs.nix` and CLAUDE.md.

---

## s2-pool mirror — transient SATA link resets

Both mirror drives (Seagate ST16000NE000, ~26.9k power-on hours as of
2026-07-31) have taken transient SATA link resets. The signature each
time: `WRITE FPDMA QUEUED` timeout → `SError { PHYRdyChg CommWake }` →
`hard resetting link` → link back at 6.0 Gbps → `EH complete`. Recovered
in under a second; **ZFS logged zero read/write/checksum errors** on
both occasions.

| Date | Drive | Notes |
|---|---|---|
| 2026-07-30 11:50 | sda (ata7, serial …J3V) | ~20 min after boot |
| 2026-07-31 07:01 | sdb (ata5, serial …KG6) | Tripped smartd's "not capable of SMART self-check" warning email; `Command_Timeout` 16 16 16 → 16 17 17 |

**That smartd wording is misleading.** It means the SMART RETURN STATUS
passthrough failed *during* the link reset, not that the drive lacks
SMART. Media SMART is clean on both: 0 reallocated, 0 pending, 0
uncorrectable, ~0 UDMA CRC.

**Reading the signal.** `PHYRdyChg` on two different ports points at the
link/power layer rather than the media. Near-zero `UDMA_CRC_Error_Count`
argues against bad data cables; a marginal SATA power connection or a
shared rail is the better suspect.

**When to act.** A few events per year is benign — log them here and move
on. Multiple per week, or `Command_Timeout` / CRC counts climbing, means
reseat SATA data *and* power on both drives, split them across PSU
rails, then re-evaluate.

**How to add an entry.** Append the date and drive to the table above.
The events are visible while they are still in journald:

```
journalctl -k --since -7d | grep -E 'hard resetting link|PHYRdyChg|EH complete'
```
