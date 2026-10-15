//! Idle reclamation for cached structural parses.

use std::time::{Duration, Instant};

use napi_derive::napi;
use parking_lot::{Mutex, MutexGuard};

use crate::{prof::profile_region, task};

const MAX_IDLE: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Maintenance {
	last_sweep: Mutex<Option<Instant>>,
}

impl Maintenance {
	fn try_start(&self, now: Instant) -> Result<MutexGuard<'_, Option<Instant>>, u32> {
		let Some(mut last_sweep) = self.last_sweep.try_lock() else {
			return Err(next_check_ms(now, now));
		};
		if let Some(last) = *last_sweep
			&& now.saturating_duration_since(last) < CHECK_INTERVAL
		{
			return Err(next_check_ms(last, now));
		}
		*last_sweep = Some(now);
		Ok(last_sweep)
	}
}

fn next_check_ms(last: Instant, now: Instant) -> u32 {
	let remaining = CHECK_INTERVAL.saturating_sub(now.saturating_duration_since(last));
	u32::try_from(remaining.as_nanos().div_ceil(1_000_000))
		.unwrap_or(30_000)
		.max(1)
}

static MAINTENANCE: Maintenance = Maintenance { last_sweep: Mutex::new(None) };

#[napi(object)]
pub struct ParseCacheMaintenance {
	pub evicted:       u32,
	pub next_check_ms: u32,
}

/// Release structural parse trees unused for at least one minute.
///
/// Runs deallocation off the JavaScript thread. On glibc, also return freed
/// allocator pages to the OS after eviction. Live tree clones remain valid.
/// Calls share a process-wide sweep deadline; retry after `nextCheckMs`.
#[napi]
pub fn reclaim_idle_parse_cache() -> task::Promise<ParseCacheMaintenance> {
	task::blocking("reclaim_idle_parse_cache", (), |_| {
		let now = Instant::now();
		// This guard serializes maintenance across JS realms, independently of
		// the parse-cache mutex. Unwinding releases it without orphaned
		// ownership.
		let _sweep = match MAINTENANCE.try_start(now) {
			Ok(sweep) => sweep,
			Err(next_check_ms) => return Ok(ParseCacheMaintenance { evicted: 0, next_check_ms }),
		};
		let _profile = profile_region("parse_cache.sweep");
		let evicted = pi_ast::parse_cache::evict_idle_parse_cache(MAX_IDLE);
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		if evicted > 0 {
			// SAFETY: malloc_trim has no pointer arguments and synchronizes the
			// allocator internally; only already-free pages can be released.
			unsafe { libc::malloc_trim(0) };
		}
		Ok(ParseCacheMaintenance {
			evicted:       u32::try_from(evicted).unwrap_or(u32::MAX),
			next_check_ms: next_check_ms(now, Instant::now()),
		})
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn realms_share_the_deadline_after_the_previous_caller_leaves() {
		let maintenance = Maintenance::default();
		let now = Instant::now();
		drop(maintenance.try_start(now).expect("first caller sweeps"));
		assert_eq!(
			maintenance
				.try_start(now + Duration::from_secs(10))
				.unwrap_err(),
			20_000
		);
		assert_eq!(
			maintenance
				.try_start(now + CHECK_INTERVAL - Duration::from_nanos(1))
				.unwrap_err(),
			1
		);
		drop(
			maintenance
				.try_start(now + CHECK_INTERVAL)
				.expect("replacement caller sweeps on time"),
		);
		assert_eq!(maintenance.try_start(now + CHECK_INTERVAL).unwrap_err(), 30_000);
	}

	#[test]
	fn a_slow_sweep_excludes_other_realms_and_releases_ownership_on_unwind() {
		let maintenance = Maintenance::default();
		let now = Instant::now();
		let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
			let _sweep = maintenance.try_start(now).expect("first caller sweeps");
			std::thread::scope(|scope| {
				scope
					.spawn(|| {
						assert_eq!(maintenance.try_start(now + CHECK_INTERVAL).unwrap_err(), 30_000);
					})
					.join()
					.unwrap();
			});
			panic!("maintenance failure");
		}));
		let failure = result.expect_err("the injected maintenance failure must unwind");
		assert_eq!(failure.downcast_ref::<&str>(), Some(&"maintenance failure"));
		drop(
			maintenance
				.try_start(now + CHECK_INTERVAL)
				.expect("failure must not orphan ownership"),
		);
	}
}
