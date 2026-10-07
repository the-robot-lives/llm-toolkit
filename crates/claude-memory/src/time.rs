//! Minimal UTC timestamp formatting: `YYYY-MM-DDTHH:MM:SS.sssZ`.
//! Days-from-civil / civil-from-days (Howard Hinnant's algorithm).

use std::time::{SystemTime, UNIX_EPOCH};

/// Format `t` as `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub fn format_utc(t: SystemTime) -> String {
    let dur = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Current UTC timestamp in contract format.
pub fn now_utc() -> String {
    format_utc(SystemTime::now())
}

/// Convert days since 1970-01-01 to (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn epoch() {
        assert_eq!(format_utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn known_instants() {
        let t = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        // 2023-11-14T22:13:20.123Z
        assert_eq!(format_utc(t), "2023-11-14T22:13:20.123Z");
        let t = UNIX_EPOCH + Duration::from_millis(951_827_612_345);
        // 2000-02-29T12:33:32.345Z (leap day)
        assert_eq!(format_utc(t), "2000-02-29T12:33:32.345Z");
    }
}
