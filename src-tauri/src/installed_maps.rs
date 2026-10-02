use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha2::{Digest, Sha256};

// These are the game's official asset folders, not a list of individual maps.
const MAP_FOLDERS: [&str; 3] = ["fahero_maps", "zolamare_maps", "eronion_maps"];

#[derive(Default)]
pub(crate) struct InstalledMaps {
    paths: HashMap<String, Vec<PathBuf>>,
    hashes: OnceLock<HashMap<String, String>>,
}

impl InstalledMaps {
    // Take a fresh snapshot for each replay listing so Steam updates are visible.
    pub(crate) fn read(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut catalog = Self::default();
        for root in roots {
            let Ok(root) = root.canonicalize() else { continue };
            for folder in MAP_FOLDERS {
                let Ok(entries) = fs::read_dir(root.join("assets").join(folder)) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("png")) {
                        continue;
                    }
                    let Ok(resolved) = path.canonicalize() else { continue };
                    if !resolved.starts_with(&root) || !resolved.is_file() { continue; }
                    let relative = format!("assets/{folder}/{}", entry.file_name().to_string_lossy());
                    catalog.paths.entry(relative).or_default().push(resolved);
                }
            }
        }
        catalog
    }

    fn vanilla_id(&self, map_id: Option<&str>, surface: Option<&str>) -> Option<String> {
        if let Some(surface) = surface {
            let payload = surface.strip_prefix("data:image/png;base64,").unwrap_or(surface);
            BASE64.decode(payload).ok().and_then(|bytes| {
                // Most replays only need a path lookup. Hash installed PNGs only
                // when an embedded image needs comparing, once per listing.
                self.hashes.get_or_init(|| {
                    let mut paths = self.paths.iter().collect::<Vec<_>>();
                    paths.sort_by_key(|(id, _)| *id);
                    let mut hashes = HashMap::new();
                    for (id, files) in paths {
                        for path in files {
                            if let Ok(bytes) = fs::read(path) {
                                hashes.entry(format!("{:x}", Sha256::digest(bytes))).or_insert_with(|| id.clone());
                            }
                        }
                    }
                    hashes
                }).get(&format!("{:x}", Sha256::digest(bytes))).cloned()
            })
        } else if let Some(id) = map_id {
            // Numeric IDs are the legacy built-in map format.
            if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
                return MAP_FOLDERS.iter().map(|folder| format!("assets/{folder}/map{id}.png"))
                    .find(|path| self.paths.contains_key(path)).or_else(|| Some(format!("legacy:{id}")));
            }
            let normalized = id.replace('\\', "/");
            self.paths.contains_key(&normalized).then_some(normalized)
        } else { None }
    }

    pub(crate) fn event_label(&self, map_id: Option<&str>, surface: Option<&str>, has_map: bool) -> Option<String> {
        let vanilla = self.vanilla_id(map_id, surface).is_some();
        (has_map && !vanilla).then(|| "Custom".to_string())
    }

    pub(crate) fn identity(&self, map_id: Option<&str>, surface: Option<&str>) -> Option<(String, String)> {
        if let Some(id) = self.vanilla_id(map_id, surface) {
            let label = if let Some(number) = id.strip_prefix("legacy:") {
                format!("Map {number}")
            } else {
                let parts = id.split('/').collect::<Vec<_>>();
                let family = parts.get(1)?.trim_end_matches("_maps");
                let family = format!("{}{}", family.get(..1)?.to_uppercase(), &family[1..]);
                let number = parts.last()?.trim_end_matches(".png").trim_start_matches("map");
                format!("{family} {number}")
            };
            return Some((format!("vanilla:{id}"), label));
        }
        // Hash decoded image bytes, not base64 formatting or the replay file.
        // Replays without embedded images fall back to their normalized map path.
        let bytes = if let Some(surface) = surface {
            let payload = surface.strip_prefix("data:image/png;base64,").unwrap_or(surface);
            BASE64.decode(payload).unwrap_or_else(|_| payload.as_bytes().to_vec())
        } else {
            map_id?.replace('\\', "/").into_bytes()
        };
        let hash = format!("{:x}", Sha256::digest(bytes));
        Some((format!("custom:{hash}"), format!("#{}", &hash[..10])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_identity_matches_paths_embedded_images_and_legacy_ids() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("assets/fahero_maps");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("map14.png"), b"official image").unwrap();
        let maps = InstalledMaps::read([root.path().to_path_buf()]);
        let expected = Some(("vanilla:assets/fahero_maps/map14.png".into(), "Fahero 14".into()));
        assert_eq!(maps.identity(Some("assets/fahero_maps/map14.png"), None), expected);
        assert_eq!(maps.identity(Some("14"), None), expected);
        assert_eq!(maps.identity(None, Some(&BASE64.encode(b"official image"))), expected);
        let custom = BASE64.encode(b"custom image");
        let first = maps.identity(Some("old.png"), Some(&custom)).unwrap();
        let renamed = maps.identity(Some("new.png"), Some(&format!("data:image/png;base64,{custom}"))).unwrap();
        assert_eq!(first, renamed);
        assert!(first.0.starts_with("custom:"));
        assert_eq!(first.0.len(), 71);
        assert_eq!(first.1.len(), 11);
        assert_ne!(maps.identity(None, Some(&BASE64.encode(b"different image"))), Some(first));
        assert_eq!(maps.identity(None, None), None);
    }

    #[test]
    fn installed_maps_refresh_and_exclude_user_maps() {
        let root = tempfile::tempdir().unwrap();
        let official = root.path().join("assets/zolamare_maps");
        let custom = root.path().join("assets/custom_maps");
        let editor = root.path().join("map_editor");
        for directory in [&official, &custom, &editor] { fs::create_dir_all(directory).unwrap(); }
        fs::write(custom.join("custom.png"), b"user map").unwrap();
        fs::write(editor.join("generated_map55.png"), b"editor map").unwrap();
        let map = "assets/zolamare_maps/map55.png";
        let before = InstalledMaps::read([root.path().to_path_buf()]);
        assert_eq!(before.event_label(Some(map), None, true).as_deref(), Some("Custom"));
        fs::write(official.join("map55.png"), b"official image").unwrap();
        let after = InstalledMaps::read([root.path().to_path_buf()]);
        assert_eq!(after.event_label(Some(map), None, true), None);
        assert_eq!(after.event_label(Some("assets\\zolamare_maps\\map55.png"), None, true), None);
        assert_eq!(after.event_label(None, Some(&BASE64.encode(b"official image")), true), None);
        for surface in [BASE64.encode(b"user map"), BASE64.encode(b"editor map"), "invalid!".into()] {
            assert_eq!(after.event_label(Some(map), Some(&surface), true).as_deref(), Some("Custom"));
        }
        for path in ["assets/custom_maps/custom.png", "map_editor/generated_map55.png", "assets/zolamare_maps/../custom_maps/custom.png"] {
            assert_eq!(after.event_label(Some(path), None, true).as_deref(), Some("Custom"));
        }
        assert_eq!(after.event_label(Some("35"), None, true), None);
        assert_eq!(after.event_label(None, None, false), None);
    }
}
