//! The PDH query behind GPU usage: the "GPU Engine" 3D utilisation and the
//! "GPU Adapter Memory" dedicated usage, opened once and collected every
//! sample.

use windows::core::{w, PCWSTR};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};

use super::wide;

/// The GPU counter query, opened once and collected every sample.
pub(super) struct Pdh {
    query: PDH_HQUERY,
    pub(super) usage: PDH_HCOUNTER,
    pub(super) vram: PDH_HCOUNTER,
    /// Collections so far; rate counters carry a value from the second on.
    pub(super) collections: u32,
}

impl Pdh {
    pub(super) fn open() -> Result<Self, String> {
        let mut query = PDH_HQUERY::default();
        // SAFETY: a fresh query handle is written on success.
        let rc = unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) };
        if rc != 0 {
            return Err(format!("PdhOpenQuery failed: {rc:#010x}"));
        }
        let mut usage = PDH_HCOUNTER::default();
        let mut vram = PDH_HCOUNTER::default();
        // The 3D engine is what "GPU %" means in Task Manager; the memory
        // counter is the dedicated (on-board) usage per adapter. English
        // names, so a localised Windows resolves them too.
        // SAFETY: the query is open; each counter handle is written on success.
        let rc_usage = unsafe {
            PdhAddEnglishCounterW(
                query,
                w!(r"\GPU Engine(*engtype_3D)\Utilization Percentage"),
                0,
                &mut usage,
            )
        };
        // SAFETY: as above.
        let rc_vram = unsafe {
            PdhAddEnglishCounterW(
                query,
                w!(r"\GPU Adapter Memory(*)\Dedicated Usage"),
                0,
                &mut vram,
            )
        };
        if rc_usage != 0 || rc_vram != 0 {
            // SAFETY: closing the query this function opened.
            unsafe {
                PdhCloseQuery(query);
            }
            return Err(format!(
                "GPU performance counters not added: usage {rc_usage:#010x}, memory {rc_vram:#010x}"
            ));
        }
        Ok(Self {
            query,
            usage,
            vram,
            collections: 0,
        })
    }

    pub(super) fn collect(&mut self) -> Result<(), String> {
        // SAFETY: the query is open for the life of `self`.
        let rc = unsafe { PdhCollectQueryData(self.query) };
        if rc != 0 {
            return Err(format!("PdhCollectQueryData failed: {rc:#010x}"));
        }
        self.collections += 1;
        Ok(())
    }

    /// The sum of a wildcard counter's instances, `_Total` excluded.
    pub(super) fn sum(counter: PDH_HCOUNTER) -> Result<f64, u32> {
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        // SAFETY: a size query with no buffer.
        let rc = unsafe {
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None)
        };
        if rc != PDH_MORE_DATA {
            return Err(rc);
        }
        // u64-backed so the items (pointer + f64) are aligned; the
        // instance names follow the items inside the same buffer.
        let mut buf = vec![0u64; (size as usize).div_ceil(8).max(1)];
        // SAFETY: the buffer is the size PDH asked for; the item slice is
        // `count` entries within it, and each name pointer points into it.
        unsafe {
            let rc = PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(buf.as_mut_ptr().cast()),
            );
            if rc != 0 {
                return Err(rc);
            }
            let items = std::slice::from_raw_parts(
                buf.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                count as usize,
            );
            let mut total = 0.0;
            for it in items {
                let status = it.FmtValue.CStatus;
                if status != PDH_CSTATUS_VALID_DATA && status != PDH_CSTATUS_NEW_DATA {
                    continue;
                }
                if !it.szName.is_null() && it.szName.as_wide().starts_with(&wide("_Total")[..6]) {
                    continue;
                }
                // Formatted as PDH_FMT_DOUBLE, so this member is the live one.
                total += it.FmtValue.Anonymous.doubleValue;
            }
            Ok(total)
        }
    }
}

impl Drop for Pdh {
    fn drop(&mut self) {
        // SAFETY: the query was opened by `open` and is closed once.
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}
