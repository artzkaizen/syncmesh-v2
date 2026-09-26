//! A hybrid logical clock stamp: a wall-clock instant in epoch milliseconds, then a counter (RFC-0003).

/// How far ahead of a device's own clock a stamp may run before it is not believed (D34).
pub const DEFAULT_MAX_DRIFT_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hlc {
    pub ms: i64,
    pub logical: u32,
}

impl Hlc {
    pub const fn new(ms: i64, logical: u32) -> Hlc {
        Hlc { ms, logical }
    }
}

/// A clock whose stamps never go backwards, even when the wall clock does.
#[derive(Debug, Clone)]
pub struct HlcClock {
    last: Hlc,
    max_drift_ms: Option<i64>,
}

impl HlcClock {
    pub fn new(max_drift_ms: Option<i64>) -> HlcClock {
        HlcClock {
            last: Hlc::new(0, 0),
            max_drift_ms,
        }
    }

    /// A stamp greater than every stamp this clock has issued or received.
    pub fn tick(&mut self, now_ms: i64) -> Hlc {
        self.last = if now_ms > self.last.ms {
            Hlc::new(now_ms, 0)
        } else {
            Hlc::new(self.last.ms, self.last.logical + 1)
        };
        self.last
    }

    /// Adopts a remote stamp if it is ahead, clamped to `now + max_drift` when a bound is set.
    pub fn receive(&mut self, remote: Hlc, now_ms: i64) {
        let bounded = match self.max_drift_ms {
            Some(drift) if remote.ms > now_ms + drift => Hlc::new(now_ms + drift, remote.logical),
            _ => remote,
        };
        if bounded > self.last {
            self.last = bounded;
        }
    }

    pub fn last(&self) -> Hlc {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_are_strictly_increasing_even_backwards() {
        let mut c = HlcClock::new(None);
        assert_eq!(c.tick(100), Hlc::new(100, 0));
        assert_eq!(c.tick(100), Hlc::new(100, 1));
        assert_eq!(c.tick(50), Hlc::new(100, 2));
        assert_eq!(c.tick(101), Hlc::new(101, 0));
    }

    #[test]
    fn receive_ratchets_forward_and_clamps_to_the_drift_bound() {
        let mut c = HlcClock::new(Some(1_000));
        c.receive(Hlc::new(999_999, 0), 100);
        assert_eq!(c.last(), Hlc::new(1_100, 0));
        c.receive(Hlc::new(50, 9), 100);
        assert_eq!(c.last(), Hlc::new(1_100, 0));
        assert_eq!(c.tick(100), Hlc::new(1_100, 1));
    }
}
