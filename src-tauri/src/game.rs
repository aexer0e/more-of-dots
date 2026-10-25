//! Where War of Dots is installed. Steam keeps the game in
//! `steamapps/common/War of Dots` in each of its libraries on every platform;
//! only Steam's own location differs. On Linux the game runs through Proton and
//! is still installed there.
//!
//! The game's files (`config.txt`, `replays`, `map_editor`, `assets`) normally
//! sit in that folder. A macOS build may keep them inside its app bundle, so the
//! bundle's `Contents/Resources` and `Contents/MacOS` folders are checked too.
use super::push_unique_path;
#[cfg(test)]
use super::path_key;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub(crate) const GAME_DIR_NAME: &str = "War of Dots";

/// `WOD_STEAM_GAME_DIR`, or the game folder in Steam's default library.
pub(crate) fn configured_game_dir() -> PathBuf {
    if let Some(path) = env::var_os("WOD_STEAM_GAME_DIR") {
        return PathBuf::from(path);
    }
    default_steam_root().join("steamapps").join("common").join(GAME_DIR_NAME)
}

fn default_steam_root() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Program Files (x86)\Steam")
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Steam")
    } else {
        home().join(".local/share/Steam")
    }
}

fn home() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// Every War of Dots folder found in a Steam library, the configured one last.
pub(crate) fn install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for steamapps in steamapps_dirs() {
        push_unique_path(&mut dirs, steamapps.join("common").join(GAME_DIR_NAME));
    }
    push_unique_path(&mut dirs, configured_game_dir());
    dirs
}

/// The folders that hold the game's own files, one per installation that exists.
pub(crate) fn content_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for install in install_dirs().into_iter().filter(|dir| dir.is_dir()) {
        push_unique_path(&mut dirs, content_dir(&install));
    }
    dirs
}

fn content_dir(install: &Path) -> PathBuf {
    let holds_game_files = |dir: &Path| ["assets", "replays", "map_editor", "config.txt"].iter().any(|name| dir.join(name).exists());
    if holds_game_files(install) {
        return install.to_path_buf();
    }
    let bundles = fs::read_dir(install).into_iter().flatten().flatten().map(|entry| entry.path());
    bundles
        .filter(|path| path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("app")))
        .flat_map(|bundle| [bundle.join("Contents/Resources"), bundle.join("Contents/MacOS")])
        .find(|dir| holds_game_files(dir))
        .unwrap_or_else(|| install.to_path_buf())
}

pub(crate) fn steamapps_dirs() -> Vec<PathBuf> {
    let mut steam_roots = steam_roots();
    let mut steamapps_dirs = Vec::new();

    for root in &steam_roots {
        push_steamapps_candidate(&mut steamapps_dirs, root);
    }

    for root in steam_roots.drain(..) {
        let library_config = root.join("steamapps").join("libraryfolders.vdf");
        let Ok(config) = fs::read_to_string(library_config) else {
            continue;
        };

        for library_root in parse_steam_library_paths(&config) {
            push_steamapps_candidate(&mut steamapps_dirs, &library_root);
        }
    }

    // Libraries on other drives that Steam's own list may not name.
    #[cfg(windows)]
    for drive in b'A'..=b'Z' {
        let drive_root = format!("{}:\\", drive as char);
        for candidate in [
            PathBuf::from(&drive_root).join("Steam"),
            PathBuf::from(&drive_root).join("SteamLibrary"),
        ] {
            push_steamapps_candidate(&mut steamapps_dirs, &candidate);
        }
    }

    steamapps_dirs
}

fn steam_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    #[cfg(windows)]
    for root in registry_steam_roots() {
        push_unique_path(&mut roots, root);
    }

    for var_name in ["STEAM_DIR", "STEAM_PATH", "SteamPath"] {
        if let Some(path) = env::var_os(var_name) {
            push_unique_path(&mut roots, PathBuf::from(path));
        }
    }

    #[cfg(windows)]
    {
        for var_name in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(path) = env::var_os(var_name) {
                push_unique_path(&mut roots, PathBuf::from(path).join("Steam"));
            }
        }
        if let Some(system_drive) = env::var_os("SystemDrive") {
            push_unique_path(&mut roots, PathBuf::from(system_drive).join("Steam"));
        }
        push_unique_path(&mut roots, PathBuf::from(r"C:\Steam"));
    }

    #[cfg(not(windows))]
    {
        let home = home();
        // Steam's own folder, then the Debian and Flatpak locations on Linux.
        for relative in [
            "Library/Application Support/Steam",
            ".steam/steam",
            ".local/share/Steam",
            ".var/app/com.valvesoftware.Steam/.local/share/Steam",
        ] {
            let root = home.join(relative);
            if root.is_dir() {
                push_unique_path(&mut roots, root);
            }
        }
    }
    roots
}

#[cfg(windows)]
fn registry_steam_roots() -> Vec<PathBuf> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
        RegKey,
    };

    let mut roots = Vec::new();
    let probes = [
        (HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Valve\Steam",
            "InstallPath",
        ),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
    ];

    for (hive, key_path, value_name) in probes {
        let key = RegKey::predef(hive);
        let Ok(steam_key) = key.open_subkey(key_path) else {
            continue;
        };
        let Ok(value) = steam_key.get_value::<String, _>(value_name) else {
            continue;
        };

        push_unique_path(&mut roots, native_path(&value));
    }

    roots
}

fn push_steamapps_candidate(steamapps_dirs: &mut Vec<PathBuf>, candidate: &Path) {
    if candidate
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
        && candidate.is_dir()
    {
        push_unique_path(steamapps_dirs, candidate.to_path_buf());
        return;
    }

    let steamapps = candidate.join("steamapps");
    if steamapps.is_dir() {
        push_unique_path(steamapps_dirs, steamapps);
    }
}

pub(crate) fn parse_steam_library_paths(config: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    for line in config.lines() {
        let quoted = quoted_vdf_values(line);
        if quoted.len() < 2 {
            continue;
        }

        let path = if quoted[0] == "path" {
            Some(&quoted[1])
        } else if quoted[0].parse::<usize>().is_ok() && looks_like_path(&quoted[1]) {
            Some(&quoted[1])
        } else {
            None
        };

        if let Some(path) = path {
            push_unique_path(&mut paths, native_path(path));
        }
    }

    paths
}

fn quoted_vdf_values(line: &str) -> Vec<String> {
    line.split('"')
        .enumerate()
        .filter_map(|(index, value)| {
            (index % 2 == 1).then(|| value.replace(r"\\", r"\").replace(r#"\""#, r#"""#))
        })
        .collect()
}

fn looks_like_path(value: &str) -> bool {
    value.contains(":\\") || value.contains(":/") || value.starts_with(r"\\") || value.starts_with('/')
}

/// Steam writes forward slashes in some Windows paths.
fn native_path(value: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(value.replace('/', r"\"))
    } else {
        PathBuf::from(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same_dir(left: &Path, right: &Path) -> bool {
        path_key(left) == path_key(right)
    }

    #[test]
    fn reads_library_paths_from_steam_config() {
        let config = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
	}
	"1"
	{
		"path"		"/home/player/.local/share/Steam"
	}
}
"#;
        let paths = parse_steam_library_paths(config);
        assert_eq!(paths.len(), 2);
        assert!(paths[1].to_string_lossy().ends_with("Steam"));
    }

    #[test]
    fn finds_game_files_inside_an_app_bundle() {
        let install = tempfile::tempdir().unwrap();
        let resources = install.path().join("War of Dots.app/Contents/Resources");
        fs::create_dir_all(resources.join("assets")).unwrap();
        assert!(same_dir(&content_dir(install.path()), &resources));
        fs::create_dir_all(install.path().join("replays")).unwrap();
        assert!(same_dir(&content_dir(install.path()), install.path()));
    }
}
