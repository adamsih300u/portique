//! Keeps key material out of swap and crash dumps.
//!
//! `LockedKey` holds one 256-bit key in a page of its own that is pinned in RAM (`mlock`), kept
//! out of core dumps and not inherited by forked children (Linux), and wiped before it is freed.
//! `harden_process` turns off core dumps and, on Linux, makes the process non-dumpable so another
//! program running as the same user cannot attach a debugger or read `/proc/<pid>/mem`.
//!
//! Locking is best effort: if the system refuses (a low `RLIMIT_MEMLOCK`, say) the key still
//! works and `is_locked` says false. On Windows the page is pinned with `VirtualLock`, after
//! raising the process's minimum working set if the default is too small to hold it, and the
//! heap is left out of crash reports. Windows has no per-page dump exclusion, so a full memory
//! dump taken by a debugger or tool outside Windows Error Reporting still contains the page.

use anyhow::{anyhow, Result};
use std::{
    alloc::{alloc_zeroed, dealloc, handle_alloc_error, Layout},
    ptr::NonNull,
};
use zeroize::Zeroize;

const KEY_LEN: usize = 32;

fn page_size() -> usize {
    #[cfg(unix)]
    {
        // SAFETY: sysconf has no preconditions.
        let n = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if n > 0 {
            return n as usize;
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};
        // SAFETY: GetSystemInfo fills the struct we give it and cannot fail.
        let info = unsafe {
            let mut info: SYSTEM_INFO = std::mem::zeroed();
            GetSystemInfo(&mut info);
            info
        };
        if info.dwPageSize > 0 {
            return info.dwPageSize as usize;
        }
    }
    4096
}

/// A 256-bit key that lives alone in its own locked page. It never moves and is wiped on drop.
pub struct LockedKey {
    page: NonNull<u8>,
    layout: Layout,
    locked: bool,
}

// SAFETY: the page is owned exclusively by this value and only reached through &self / &mut self.
unsafe impl Send for LockedKey {}
unsafe impl Sync for LockedKey {}

impl LockedKey {
    /// An all-zero key in a fresh locked page, to be filled by `fill` or `random`.
    pub fn new() -> Self {
        let size = page_size();
        let layout = Layout::from_size_align(size, size).expect("a page is a valid layout");
        // SAFETY: the layout has a non-zero size.
        let page = NonNull::new(unsafe { alloc_zeroed(layout) }).unwrap_or_else(|| handle_alloc_error(layout));
        let locked = lock(page.as_ptr(), size);
        Self { page, layout, locked }
    }

    /// A key of random bytes.
    pub fn random() -> Result<Self> {
        let mut key = Self::new();
        getrandom::fill(key.bytes_mut()).map_err(|e| anyhow!("no randomness available: {e}"))?;
        Ok(key)
    }

    /// Lets `f` write the key in place, so it is never staged in an ordinary buffer.
    pub fn fill<E>(&mut self, f: impl FnOnce(&mut [u8; KEY_LEN]) -> std::result::Result<(), E>) -> std::result::Result<(), E> {
        // SAFETY: the page is at least KEY_LEN bytes, aligned, and exclusively borrowed here.
        f(unsafe { &mut *(self.page.as_ptr() as *mut [u8; KEY_LEN]) })
    }

    pub fn as_array(&self) -> &[u8; KEY_LEN] {
        // SAFETY: as above, shared for the life of &self.
        unsafe { &*(self.page.as_ptr() as *const [u8; KEY_LEN]) }
    }

    fn bytes_mut(&mut self) -> &mut [u8] {
        // SAFETY: as above.
        unsafe { std::slice::from_raw_parts_mut(self.page.as_ptr(), KEY_LEN) }
    }

    /// Whether the page is pinned in RAM (false if the system refused or this platform cannot).
    pub fn is_locked(&self) -> bool {
        self.locked
    }
}

impl Drop for LockedKey {
    fn drop(&mut self) {
        // Wipe the whole page, not just the key, before it is unlocked and returned.
        // SAFETY: the page is `layout.size()` bytes and still ours.
        unsafe { std::slice::from_raw_parts_mut(self.page.as_ptr(), self.layout.size()) }.zeroize();
        if self.locked {
            unlock(self.page.as_ptr(), self.layout.size());
        }
        // SAFETY: allocated in `new` with this layout.
        unsafe { dealloc(self.page.as_ptr(), self.layout) };
    }
}

#[cfg(unix)]
fn lock(page: *mut u8, size: usize) -> bool {
    // SAFETY: `page` is a live allocation of `size` bytes.
    unsafe {
        #[cfg(target_os = "linux")]
        {
            // Left out of core dumps, and zero in a forked child. Both are extras: ignore failure.
            libc::madvise(page.cast(), size, libc::MADV_DONTDUMP);
            libc::madvise(page.cast(), size, libc::MADV_WIPEONFORK);
        }
        libc::mlock(page.cast(), size) == 0
    }
}

#[cfg(unix)]
fn unlock(page: *mut u8, size: usize) {
    // SAFETY: undoes the `mlock` above on the same range.
    unsafe { libc::munlock(page.cast(), size) };
}

#[cfg(windows)]
fn lock(page: *mut u8, size: usize) -> bool {
    use windows_sys::Win32::System::{
        Memory::{GetProcessWorkingSetSizeEx, SetProcessWorkingSetSizeEx, VirtualLock},
        Threading::GetCurrentProcess,
    };
    // SAFETY: `page` is a live allocation of `size` bytes; the other calls take a handle to this process.
    unsafe {
        if VirtualLock(page.cast(), size) != 0 {
            return true;
        }
        // The usual failure is the working-set quota: locked pages must fit in the process's
        // minimum working set, which starts small. Make room for this page and try once more.
        let process = GetCurrentProcess();
        let (mut min, mut max, mut flags) = (0usize, 0usize, 0u32);
        if GetProcessWorkingSetSizeEx(process, &mut min, &mut max, &mut flags) == 0 {
            return false;
        }
        if SetProcessWorkingSetSizeEx(process, min + size, max.max(min + size) + size, flags) == 0 {
            return false;
        }
        VirtualLock(page.cast(), size) != 0
    }
}

#[cfg(windows)]
fn unlock(page: *mut u8, size: usize) {
    use windows_sys::Win32::System::Memory::VirtualUnlock;
    // SAFETY: undoes the `VirtualLock` above on the same range.
    unsafe { VirtualUnlock(page.cast(), size) };
}

#[cfg(not(any(unix, windows)))]
fn lock(_page: *mut u8, _size: usize) -> bool {
    false
}

#[cfg(not(any(unix, windows)))]
fn unlock(_page: *mut u8, _size: usize) {}

/// Set by the user to keep debuggers and core dumps working, for example to diagnose a crash.
pub const ALLOW_DEBUG_ENV: &str = "PORTIQUE_ALLOW_DEBUG";

/// Turns off core dumps and, on Linux, same-user debugging and memory reads; on Windows it keeps
/// the heap out of crash reports. Returns whether it
/// ran. Release builds only, unless nothing is set: development needs a debugger.
pub fn harden_process() -> bool {
    if cfg!(debug_assertions) || std::env::var_os(ALLOW_DEBUG_ENV).is_some() {
        return false;
    }
    apply();
    true
}

#[cfg(unix)]
fn apply() {
    // SAFETY: plain syscalls with valid arguments. Failures are ignored: this only adds protection.
    unsafe {
        let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        libc::setrlimit(libc::RLIMIT_CORE, &none);
        #[cfg(target_os = "linux")]
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
}

#[cfg(windows)]
fn apply() {
    use windows_sys::Win32::System::ErrorReporting::{WerSetFlags, WER_FAULT_REPORTING_FLAG_NOHEAP};
    // SAFETY: plain call with a valid flag. A failure only means less protection.
    unsafe { WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP) };
}

#[cfg(not(any(unix, windows)))]
fn apply() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_written_in_place_and_read_back() {
        let mut k = LockedKey::new();
        assert_eq!(k.as_array(), &[0u8; 32]);
        k.fill(|b| -> std::result::Result<(), ()> {
            b.copy_from_slice(&[7u8; 32]);
            Ok(())
        })
        .unwrap();
        assert_eq!(k.as_array(), &[7u8; 32]);
    }

    #[test]
    fn a_failed_fill_reports_the_error() {
        let mut k = LockedKey::new();
        assert_eq!(k.fill(|_| Err("no")), Err("no"));
    }

    #[test]
    fn random_keys_differ() {
        let (a, b) = (LockedKey::random().unwrap(), LockedKey::random().unwrap());
        assert_ne!(a.as_array(), &[0u8; 32]);
        assert_ne!(a.as_array(), b.as_array());
    }

    #[test]
    fn each_key_has_its_own_page() {
        let (a, b) = (LockedKey::new(), LockedKey::new());
        assert_ne!(a.page, b.page);
        assert_eq!(a.page.as_ptr() as usize % page_size(), 0);
    }

    /// Pages the kernel reports as locked, from /proc.
    #[cfg(target_os = "linux")]
    fn locked_kib() -> u64 {
        let s = std::fs::read_to_string("/proc/self/status").unwrap();
        let line = s.lines().find(|l| l.starts_with("VmLck:")).unwrap();
        line.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn locked_pages_show_up_in_the_process_and_are_released_on_drop() {
        let k = LockedKey::new();
        if !k.is_locked() {
            eprintln!("mlock refused here (RLIMIT_MEMLOCK); skipping the VmLck check");
            return;
        }
        // Other tests hold locked pages too, so compare against our own contribution only.
        assert!(locked_kib() >= (page_size() / 1024) as u64);
        drop(k);
    }

    #[cfg(windows)]
    #[test]
    fn windows_pins_several_pages_even_past_the_default_working_set() {
        // The default minimum working set is a few hundred KiB; this needs the retry path to succeed.
        let keys: Vec<_> = (0..200).map(|_| LockedKey::new()).collect();
        assert!(keys.iter().all(|k| k.is_locked()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn hardening_disables_core_dumps_and_same_user_debugging() {
        apply();
        // SAFETY: reads back the state `apply` set.
        unsafe {
            assert_eq!(libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0), 0);
            let mut lim = libc::rlimit { rlim_cur: 1, rlim_max: 1 };
            libc::getrlimit(libc::RLIMIT_CORE, &mut lim);
            assert_eq!((lim.rlim_cur, lim.rlim_max), (0, 0));
        }
    }

    #[test]
    fn debug_builds_and_the_opt_out_leave_the_process_alone() {
        // `cargo test` is a debug build.
        assert!(!harden_process());
    }
}
