//! RFC 3339 timestamps in UTC, both ways, without a chrono dependency: the
//! one civil-calendar conversion (Howard Hinnant's algorithms) behind the
//! clocks the agent writes and the transcript timestamps it reads.

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `days` after 1970-01-01: (year, month, day).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Now, as RFC 3339 in UTC.
pub fn now_rfc3339() -> String {
    rfc3339_ago(0)
}

/// `ago` seconds before now, as RFC 3339 in UTC.
pub fn rfc3339_ago(ago: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339_of(now.saturating_sub(ago))
}

/// A unix time, as RFC 3339 in UTC.
pub fn rfc3339_of(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` as milliseconds since the epoch, whole
/// seconds (the fraction is dropped).
pub fn epoch_ms(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let s = match s.find('.') {
        Some(dot) if s[dot + 1..].bytes().all(|b| b.is_ascii_digit()) && dot + 1 < s.len() => {
            &s[..dot]
        }
        Some(_) => return None,
        None => s,
    };
    let b = s.as_bytes();
    if b.len() != 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let n = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = &s[r];
        t.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| t.parse().ok())?
    };
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let secs = days_from_civil(y, m, d) * 86_400 + hh * 3600 + mm * 60 + ss;
    u64::try_from(secs).ok().map(|s| s * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_both_ways() {
        let t = now_rfc3339();
        assert_eq!(t.len(), 20, "{t}");
        assert!(t.ends_with('Z'));
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[10..11], "T");
        assert_eq!(epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            epoch_ms("2026-09-27T10:00:00.789Z"),
            Some(1_790_503_200_000)
        );
        assert_eq!(epoch_ms("2000-03-01T00:00:01Z"), Some(951_868_801_000));
        for bad in [
            "2026-09-27T10:00:00",
            "2026-09-27 10:00:00Z",
            "2026-13-01T00:00:00Z",
            "x",
            "2026-09-27T10:00:00.Z",
        ] {
            assert_eq!(epoch_ms(bad), None, "{bad}");
        }
        // The two directions agree, across leap days and centuries.
        for secs in [0, 951_868_801, 1_790_503_200, 4_107_542_399] {
            assert_eq!(epoch_ms(&rfc3339_of(secs)), Some(secs * 1000));
        }
    }
}
