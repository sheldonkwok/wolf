//! A tiny deterministic PRNG so the crate stays dependency-free.
//!
//! SplitMix64 is a well-known, well-distributed 64-bit generator that needs only
//! a single `u64` of state — more than enough to shuffle a role deck.

pub(crate) struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub(crate) fn new(seed: u64) -> Self {
        SplitMix64 { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform integer in `0..bound` (bound must be non-zero). Uses rejection
    /// sampling to avoid modulo bias.
    fn below(&mut self, bound: u64) -> u64 {
        let zone = u64::MAX - (u64::MAX % bound);
        loop {
            let r = self.next_u64();
            if r < zone {
                return r % bound;
            }
        }
    }

    /// In-place Fisher–Yates shuffle.
    pub(crate) fn shuffle<T>(&mut self, slice: &mut [T]) {
        for i in (1..slice.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            slice.swap(i, j);
        }
    }
}

/// A seed derived from the wall clock, for the non-deterministic constructor.
pub(crate) fn time_seed() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x1234_5678_9ABC_DEF0)
        // Fold in the address of a stack local for a little extra entropy across
        // runs that start within the same nanosecond.
        ^ (&SystemTime::now() as *const _ as u64)
}
