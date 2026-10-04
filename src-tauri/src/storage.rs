//! Simulated replay caches are disposable: only the most recently opened one is
//! kept, plus any that an open player is still reading or writing. There is no
//! byte limit, so conversion and playback never stop for storage. Original
//! replays, drafts and browser settings are never removed.
use std::{
    collections::HashMap,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

// WebView2's disposable caches (HTTP, shader, code) are trimmed to this size.
const BROWSER_CACHE_LIMIT: u64 = 50_000_000;
pub const CACHE_DIRECTORY: &str = "repsim-v2";

pub struct ReplayCache {
    root: PathBuf,
    pinned: Mutex<HashMap<PathBuf, usize>>,
    _lock: Option<File>,
}
pub struct CacheLease {
    cache: Arc<ReplayCache>,
    path: PathBuf,
}
impl Drop for CacheLease {
    fn drop(&mut self) {
        if let Ok(mut pinned) = self.cache.pinned.lock() {
            if let Some(count) = pinned.get_mut(&self.path) {
                *count -= 1;
                if *count == 0 {
                    pinned.remove(&self.path);
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
fn is_temporary(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|x| x.to_string_lossy().starts_with(".tmp"))
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
impl ReplayCache {
    pub fn new(root: PathBuf) -> Result<Arc<Self>, String> {
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
        let cache = Arc::new(Self {
            root,
            pinned: Mutex::new(HashMap::new()),
            _lock: Some(lock),
        });
        // v1 contains regenerable, uncompressed simulations, including abandoned
        // temporary conversions. Do not touch .rep files or roaming backups.
        let legacy = cache.root.join("repsim-v1");
        let mut entries = Vec::new();
        files(&legacy, &mut entries);
        for (path, _, _) in entries {
            if path.extension().is_some_and(|x| x == "repsim") {
                let _ = fs::remove_file(path);
            }
        }
        // Nothing is pinned yet, so this also removes abandoned conversions.
        cache.maintain();
        Ok(cache)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn protect(self: &Arc<Self>, path: &Path) -> CacheLease {
        let mut pinned = self.pinned.lock().unwrap_or_else(|e| e.into_inner());
        *pinned.entry(path.to_owned()).or_default() += 1;
        CacheLease {
            cache: self.clone(),
            path: path.to_owned(),
        }
    }
    /// Deletes every simulation except those an open player holds and the most
    /// recently used one. Recency is the last open, or the conversion in progress.
    pub fn prune(&self) {
        let pinned = self.pinned.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = Vec::new();
        files(&self.root.join(CACHE_DIRECTORY), &mut entries);
        // Only the internal packed cache can be removed.
        entries.retain(|(path, _, _)| path.extension().is_some_and(|x| x == "rps2"));
        entries.sort_by_key(|(_, _, modified)| std::cmp::Reverse(*modified));
        let mut newest = true;
        for (path, _, _) in entries {
            if pinned.contains_key(&path) {
                newest = false;
                continue;
            }
            // An unpinned temporary file is an abandoned conversion, never a save.
            if newest && !is_temporary(&path) {
                newest = false;
                continue;
            }
            // Locked files are retried on the next sweep.
            let _ = fs::remove_file(path);
        }
    }
    pub fn maintain(&self) {
        trim_browser_caches(&self.root, BROWSER_CACHE_LIMIT);
        self.prune();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn cache(root: &Path) -> Arc<ReplayCache> {
        Arc::new(ReplayCache {
            root: root.into(),
            pinned: Mutex::new(HashMap::new()),
            _lock: None,
        })
    }
    fn simulation(path: &Path, age: u64) {
        let mut file = File::create(path).unwrap();
        file.write_all(&[0; 16]).unwrap();
        file.set_modified(SystemTime::now() - std::time::Duration::from_secs(age))
            .unwrap();
    }
    #[test]
    fn prune_keeps_only_the_newest_simulation() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join(CACHE_DIRECTORY);
        fs::create_dir(&folder).unwrap();
        for (name, age) in [("old.rps2", 300), ("middle.rps2", 200), ("new.rps2", 100)] {
            simulation(&folder.join(name), age);
        }
        fs::write(folder.join("notes.txt"), b"keep").unwrap();
        cache(dir.path()).prune();
        assert!(folder.join("new.rps2").exists());
        assert!(!folder.join("middle.rps2").exists());
        assert!(!folder.join("old.rps2").exists());
        assert!(folder.join("notes.txt").exists());
    }
    #[test]
    fn prune_never_removes_simulations_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join(CACHE_DIRECTORY);
        fs::create_dir(&folder).unwrap();
        let playing = folder.join("playing.rps2");
        let closed = folder.join("closed.rps2");
        let converting = folder.join(".tmpabc.rps2");
        simulation(&playing, 300);
        simulation(&closed, 200);
        simulation(&converting, 100);
        let cache = cache(dir.path());
        let _playing = cache.protect(&playing);
        let converting_lease = cache.protect(&converting);
        // The conversion in progress is the newest, so the closed replay goes.
        cache.prune();
        assert!(playing.exists());
        assert!(converting.exists());
        assert!(!closed.exists());
        drop(converting_lease);
        cache.prune();
        assert!(!converting.exists());
        assert!(playing.exists());
    }
    #[test]
    fn writes_are_never_refused() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join(CACHE_DIRECTORY);
        fs::create_dir(&folder).unwrap();
        let cache = cache(dir.path());
        let path = folder.join("large.rps2");
        let _lease = cache.protect(&path);
        let mut sink = File::create(&path).unwrap();
        for _ in 0..8 {
            sink.write_all(&[0; 1 << 20]).unwrap();
            cache.maintain();
        }
        assert_eq!(path.metadata().unwrap().len(), 8 << 20);
    }
    #[test]
    fn startup_removes_abandoned_conversions() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join(CACHE_DIRECTORY);
        fs::create_dir(&folder).unwrap();
        simulation(&folder.join("saved.rps2"), 200);
        simulation(&folder.join(".tmpxyz.rps2"), 100);
        let _cache = ReplayCache::new(dir.path().into()).unwrap();
        assert!(folder.join("saved.rps2").exists());
        assert!(!folder.join(".tmpxyz.rps2").exists());
    }
    #[test]
    fn migration_deletes_simulations_but_keeps_originals() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("repsim-v1");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("old.repsim"), [0; 32]).unwrap();
        fs::write(old.join("original.rep"), [0; 12]).unwrap();
        let _cache = ReplayCache::new(dir.path().into()).unwrap();
        assert!(!old.join("old.repsim").exists());
        assert!(old.join("original.rep").exists());
    }
    #[test]
    fn another_process_cannot_open_the_same_cache() {
        let dir = tempfile::tempdir().unwrap();
        let first = ReplayCache::new(dir.path().into()).unwrap();
        assert!(ReplayCache::new(dir.path().into()).is_err());
        drop(first);
        assert!(ReplayCache::new(dir.path().into()).is_ok());
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
