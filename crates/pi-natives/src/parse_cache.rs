//! Idle reclamation for cached structural parses.

use std::time::Duration;

use napi_derive::napi;

use crate::task;

const MAX_IDLE: Duration = Duration::from_secs(60);

/// Release structural parse trees unused for at least one minute.
///
/// Runs deallocation off the JavaScript thread. On glibc, also return freed
/// allocator pages to the OS after eviction. Live tree clones remain valid.
#[napi]
pub fn reclaim_idle_parse_cache() -> task::Promise<u32> {
	task::blocking("reclaim_idle_parse_cache", (), |_| {
		let evicted = pi_ast::parse_cache::evict_idle_parse_cache(MAX_IDLE);
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		if evicted > 0 {
			// SAFETY: malloc_trim has no pointer arguments and synchronizes the
			// allocator internally; only already-free pages can be released.
			unsafe { libc::malloc_trim(0) };
		}
		Ok(u32::try_from(evicted).unwrap_or(u32::MAX))
	})
}
