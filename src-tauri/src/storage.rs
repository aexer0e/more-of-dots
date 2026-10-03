//! One disk budget for saved and in-progress replay caches, browser data and the
//! installed application. Original replays, drafts and browser settings are not
//! eviction candidates. All cache writes are serialized under the same budget.
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

pub const LOCAL_LIMIT: u64 = 500_000_000;
// WebView2 writes independently. Keep room for its logs/profile updates between
// scans; its network and media caches also have explicit browser limits.
const BROWSER_HEADROOM: u64 = 50_000_000;
const REPLAY_LIMIT: u64 = 256_000_000;
pub const CACHE_DIRECTORY: &str = "repsim-v2";

pub struct StorageBudget {
    root: PathBuf,
    installation: u64,
    limit: u64,
    replay_limit: u64,
    state: Mutex<State>,
    _lock: Option<File>,
}
struct State {
    total: u64,
    replay: u64,
    scanned: Instant,
    pinned: HashMap<PathBuf, usize>,
}
pub struct CacheLease {
    budget: Arc<StorageBudget>,
    path: PathBuf,
}
impl Drop for CacheLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.budget.state.lock() {
            if let Some(count) = state.pinned.get_mut(&self.path) {
                *count -= 1;
                if *count == 0 {
                    state.pinned.remove(&self.path);
                }
            }
        }
    }
}

// Never follow links out of the app-owned directory.
fn files(root: &Path, result: &mut Vec<(PathBuf, u64, SystemTime)>) {
    if fs::symlink_metadata(root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files(&entry.path(), result);
        } else if kind.is_file() {
            // Windows directory enumeration can report an old size while a
            // conversion's file handle is open. Query the file handle itself.
            if let Ok(metadata) = File::open(entry.path())
                .and_then(|f| f.metadata())
                .or_else(|_| entry.metadata())
            {
                result.push((
                    entry.path(),
                    metadata.len(),
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ));
            }
        }
    }
}
pub fn directory_bytes(root: &Path) -> u64 {
    let mut entries = Vec::new();
    files(root, &mut entries);
    entries.iter().map(|(_, size, _)| size).sum()
}
fn trim_browser_caches(root: &Path, limit: u64) {
    let browser = root.join("EBWebView");
    let mut entries = Vec::new();
    files(&browser, &mut entries);
    let mut bytes: u64 = entries.iter().map(|(_, size, _)| size).sum();
    if bytes <= limit {
        return;
    }
    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in entries {
        let disposable = path.strip_prefix(&browser).is_ok_and(|relative| {
            relative.components().any(|part| {
                matches!(
                    part.as_os_str().to_str(),
                    Some(
                        "Cache"
                            | "Code Cache"
                            | "GPUCache"
                            | "GPUPersistentCache"
                            | "ShaderCache"
                            | "GrShaderCache"
                            | "component_crx_cache"
                            | "extensions_crx_cache"
                    )
                )
            })
        });
        // Never remove preferences, Local Storage, cookies, IndexedDB or runtime
        // components. Locked browser cache files are retried on the next sweep.
        if disposable && fs::remove_file(&path).is_ok() {
            bytes = bytes.saturating_sub(size);
        }
        if bytes <= limit {
            break;
        }
    }
}
impl StorageBudget {
    pub fn new(root: PathBuf, installation: u64) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(".storage-budget.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock().map_err(|_| {
            "More of Dots is already running. Close its other instance first.".to_string()
        })?;
        let budget = Arc::new(Self {
            root,
            installation,
            limit: LOCAL_LIMIT - BROWSER_HEADROOM,
            replay_limit: REPLAY_LIMIT,
            state: Mutex::new(State {
                total: 0,
                replay: 0,
                scanned: Instant::now(),
                pinned: HashMap::new(),
            }),
            _lock: Some(lock),
        });
        // v1 contains regenerable, uncompressed simulations, including abandoned
        // temporary conversions. Do not touch .rep files or roaming backups.
        let legacy = budget.root.join("repsim-v1");
        let mut entries = Vec::new();
        files(&legacy, &mut entries);
        for (path, _, _) in entries {
            if path.extension().is_some_and(|x| x == "repsim") {
                let _ = fs::remove_file(path);
            }
        }
        let mut abandoned = Vec::new();
        files(&budget.root.join(CACHE_DIRECTORY), &mut abandoned);
        for (path, _, _) in abandoned {
            if path
                .file_name()
                .is_some_and(|x| x.to_string_lossy().starts_with(".tmp"))
                && path.extension().is_some_and(|x| x == "rps2")
            {
                let _ = fs::remove_file(path);
            }
        }
        budget.maintain();
        Ok(budget)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn protect(self: &Arc<Self>, path: &Path) -> CacheLease {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        *state.pinned.entry(path.to_owned()).or_default() += 1;
        CacheLease {
            budget: self.clone(),
            path: path.to_owned(),
        }
    }
    fn scan(&self, state: &mut State) {
        state.total = directory_bytes(&self.root).saturating_add(self.installation);
        state.replay = directory_bytes(&self.root.join(CACHE_DIRECTORY));
        state.scanned = Instant::now();
    }
    fn reclaim(&self, state: &mut State, additional: u64) -> Result<(), String> {
        if state.total.saturating_add(additional) <= self.limit
            && state.replay.saturating_add(additional) <= self.replay_limit
        {
            return Ok(());
        }
        let mut entries = Vec::new();
        files(&self.root.join(CACHE_DIRECTORY), &mut entries);
        entries.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in entries {
            if state.pinned.contains_key(&path) {
                continue;
            }
            // Only the internal packed cache can be evicted.
            if path.extension().is_none_or(|x| x != "rps2") {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                state.total = state.total.saturating_sub(size);
                state.replay = state.replay.saturating_sub(size);
            }
            if state.total.saturating_add(additional) <= self.limit
                && state.replay.saturating_add(additional) <= self.replay_limit
            {
                return Ok(());
            }
        }
        Err("The app's 500 MB storage budget is full. Close another replay player to free its cache, then reopen this replay.".into())
    }
    pub fn maintain(&self) {
        if let Ok(mut state) = self.state.lock() {
            trim_browser_caches(&self.root, BROWSER_HEADROOM);
            self.scan(&mut state);
            let _ = self.reclaim(&mut state, 0);
        }
    }
    pub fn write(&self, file: &mut File, bytes: &[u8]) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if state.scanned.elapsed() >= Duration::from_secs(2)
            || state.total.saturating_add(bytes.len() as u64) > self.limit
            || state.replay.saturating_add(bytes.len() as u64) > self.replay_limit
        {
            self.scan(&mut state);
        }
        self.reclaim(&mut state, bytes.len() as u64)?;
        if let Err(error) = file.write_all(bytes) {
            self.scan(&mut state);
            return Err(error.to_string());
        }
        state.total += bytes.len() as u64;
        state.replay += bytes.len() as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn budget(root: &Path, limit: u64) -> Arc<StorageBudget> {
        Arc::new(StorageBudget {
            root: root.into(),
            installation: 0,
            limit,
            replay_limit: limit,
            _lock: None,
            state: Mutex::new(State {
                total: directory_bytes(root),
                replay: directory_bytes(&root.join(CACHE_DIRECTORY)),
                scanned: Instant::now(),
                pinned: HashMap::new(),
            }),
        })
    }
    #[test]
    fn budget_counts_browser_files_and_protects_active_players() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join(CACHE_DIRECTORY);
        fs::create_dir(&cache).unwrap();
        fs::write(dir.path().join("browser-profile"), [0; 30]).unwrap();
        let old = cache.join("old.rps2");
        fs::write(&old, [0; 30]).unwrap();
        let active = cache.join("active.rps2");
        fs::write(&active, [0; 20]).unwrap();
        let budget = budget(dir.path(), 100);
        let _lease = budget.protect(&active);
        let path = cache.join("new.rps2");
        let _new_lease = budget.protect(&path);
        let mut sink = File::create(path).unwrap();
        budget.write(&mut sink, &[0; 40]).unwrap();
        assert!(!old.exists());
        assert!(active.exists());
        assert_eq!(directory_bytes(dir.path()), 90);
        assert!(budget.write(&mut sink, &[0; 20]).is_err());
        assert_eq!(sink.metadata().unwrap().len(), 40);
    }
    #[test]
    fn all_concurrent_writers_share_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(CACHE_DIRECTORY)).unwrap();
        let budget = budget(dir.path(), 100);
        let mut threads = Vec::new();
        for n in 0..4 {
            let budget = budget.clone();
            threads.push(std::thread::spawn(move || {
                let path = budget.root.join(CACHE_DIRECTORY).join(format!("{n}.rps2"));
                let _lease = budget.protect(&path);
                let mut sink = File::create(path).unwrap();
                budget.write(&mut sink, &[0; 40])
            }));
        }
        for thread in threads {
            let _ = thread.join().unwrap();
        }
        assert!(directory_bytes(dir.path()) <= 100);
    }
    #[test]
    fn migration_deletes_simulations_but_keeps_originals() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("repsim-v1");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("old.repsim"), [0; 32]).unwrap();
        fs::write(old.join("original.rep"), [0; 12]).unwrap();
        let _budget = StorageBudget::new(dir.path().into(), 0).unwrap();
        assert!(!old.join("old.repsim").exists());
        assert!(old.join("original.rep").exists());
    }
    #[test]
    fn another_process_cannot_create_an_independent_budget() {
        let dir = tempfile::tempdir().unwrap();
        let first = StorageBudget::new(dir.path().into(), 0).unwrap();
        assert!(StorageBudget::new(dir.path().into(), 0).is_err());
        drop(first);
        assert!(StorageBudget::new(dir.path().into(), 0).is_ok());
    }
    #[test]
    fn browser_cleanup_preserves_saved_settings_and_components() {
        let dir = tempfile::tempdir().unwrap();
        let browser = dir.path().join("EBWebView");
        for name in [
            "Default/Cache",
            "Default/Local Storage",
            "CertificateRevocation",
        ] {
            fs::create_dir_all(browser.join(name)).unwrap();
            fs::write(browser.join(name).join("data"), [0; 30]).unwrap();
        }
        trim_browser_caches(dir.path(), 60);
        assert!(!browser.join("Default/Cache/data").exists());
        assert!(browser.join("Default/Local Storage/data").exists());
        assert!(browser.join("CertificateRevocation/data").exists());
    }
}
