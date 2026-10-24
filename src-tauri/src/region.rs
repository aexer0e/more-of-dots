//! Region selection for a running War of Dots. A small probe DLL is loaded into
//! the game and runs `region_payload.py` in its Python interpreter, which makes
//! the game prefer the chosen region's server when it queues.
use super::{app_runtime_dir, steam_game_dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

const REGION_NAMES: [&str; 3] = ["NA", "EU", "ASIA"];
const PROBE_DLL: &str = "wod_python_probe.dll";
const RESULT_WAIT: Duration = Duration::from_secs(8);
const PAYLOAD: &str = include_str!("region_payload.py");

/// The last region applied, kept with the game process it was applied to so a
/// restarted game is not shown as steered. `servers` is what the probe found
/// out about the game's servers: region, whether each answers, and its ping.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegionSelection {
    region: String,
    selected_at: u64,
    #[serde(default)]
    process_id: u32,
    #[serde(default)]
    servers: Value,
}

fn selection_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_runtime_dir(app)?.join("region-selection.json"))
}

/// The game's server addresses from the last time the probe learned them. A
/// game that picked its server before the probe arrived may not list them again.
fn saved_servers_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_runtime_dir(app)?.join("region-servers.json"))
}

fn saved_servers(app: &AppHandle) -> Vec<String> {
    saved_servers_path(app)
        .ok()
        .and_then(|path| read_json(&path))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn save_servers(app: &AppHandle, result: &Value) {
    let urls: Vec<String> = result["serverInfo"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|server| server["url"].as_str().map(str::to_string))
        .collect();
    if let (false, Ok(path), Ok(text)) = (urls.is_empty(), saved_servers_path(app), serde_json::to_string(&urls)) {
        let _ = fs::write(path, text);
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn normalize_region(region: &str) -> Result<&'static str, String> {
    REGION_NAMES
        .iter()
        .find(|name| name.eq_ignore_ascii_case(region.trim()))
        .copied()
        .ok_or_else(|| "Choose NA, EU or Asia.".to_string())
}

/// A War of Dots executable is `game.exe` inside the game's install folder.
fn is_game_executable(path: &Path) -> bool {
    let named_game = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("game.exe"));
    let in_game_dir = path.parent().is_some_and(|dir| {
        dir.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(super::GAME_DIR_NAME))
            || dir
                .to_string_lossy()
                .eq_ignore_ascii_case(&steam_game_dir().to_string_lossy())
    });
    named_game && in_game_dir
}

#[cfg(windows)]
fn running_game_process() -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = None;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let length = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
            let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
            if name.eq_ignore_ascii_case("game.exe") {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !process.is_null() {
                    let mut buffer = [0u16; 1024];
                    let mut size = buffer.len() as u32;
                    let named = QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        buffer.as_mut_ptr(),
                        &mut size,
                    ) != 0;
                    CloseHandle(process);
                    let path = PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize]));
                    if named && is_game_executable(&path) {
                        found = Some(entry.th32ProcessID);
                        break;
                    }
                }
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(not(windows))]
fn running_game_process() -> Option<u32> {
    None
}

/// Loads `dll` into the process with a remote `LoadLibraryW` call.
#[cfg(windows)]
fn load_library_in(process_id: u32, dll: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Diagnostics::Debug::WriteProcessMemory;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Memory::{
        VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateRemoteThread, GetExitCodeThread, OpenProcess, WaitForSingleObject,
        LPTHREAD_START_ROUTINE, PROCESS_CREATE_THREAD, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_VM_OPERATION, PROCESS_VM_WRITE,
    };

    let path: Vec<u16> = dll.as_os_str().encode_wide().chain(Some(0)).collect();
    let bytes = path.len() * 2;
    let kernel32: Vec<u16> = "kernel32.dll".encode_utf16().chain(Some(0)).collect();
    unsafe {
        let load_library = GetProcAddress(GetModuleHandleW(kernel32.as_ptr()), c"LoadLibraryW".as_ptr().cast())
            .ok_or("Windows did not provide LoadLibraryW.")?;
        let start: LPTHREAD_START_ROUTINE = Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            unsafe extern "system" fn(*mut std::ffi::c_void) -> u32,
        >(load_library));
        let access = PROCESS_CREATE_THREAD
            | PROCESS_QUERY_LIMITED_INFORMATION
            | PROCESS_VM_OPERATION
            | PROCESS_VM_WRITE;
        let process = OpenProcess(access, 0, process_id);
        if process.is_null() {
            return Err("Could not open War of Dots. If it runs as administrator, run More of Dots as administrator too.".into());
        }
        let result = (|| {
            let remote = VirtualAllocEx(process, std::ptr::null(), bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if remote.is_null() {
                return Err("Could not reserve memory in War of Dots.".to_string());
            }
            let mut written = 0usize;
            let outcome = if WriteProcessMemory(process, remote, path.as_ptr().cast(), bytes, &mut written) == 0
                || written != bytes
            {
                Err("Could not write to War of Dots.".to_string())
            } else {
                let thread = CreateRemoteThread(process, std::ptr::null(), 0, start, remote, 0, std::ptr::null_mut());
                if thread.is_null() {
                    Err("Could not start the region probe in War of Dots.".to_string())
                } else {
                    let waited = WaitForSingleObject(thread, 10_000);
                    let mut module = 0u32;
                    GetExitCodeThread(thread, &mut module);
                    CloseHandle(thread);
                    if waited != WAIT_OBJECT_0 {
                        Err("War of Dots did not respond in time.".to_string())
                    } else if module == 0 {
                        Err("War of Dots could not load the region probe.".to_string())
                    } else {
                        Ok(())
                    }
                }
            };
            // The string is only read during LoadLibraryW; a timed out thread may still need it.
            if outcome.is_ok() {
                VirtualFreeEx(process, remote, 0, MEM_RELEASE);
            }
            outcome
        })();
        CloseHandle(process);
        result
    }
}

#[cfg(not(windows))]
fn load_library_in(_process_id: u32, _dll: &Path) -> Result<(), String> {
    Err("Region selection needs Windows.".into())
}

fn probe_dll(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = super::player::resource(app, PROBE_DLL) {
        return Ok(path);
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tools/python-probe-dll/target/release")
            .join(PROBE_DLL);
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err("Region selection is missing a file. Repair More of Dots.".into())
}

fn apply_region(app: &AppHandle, process_id: u32, region: &str) -> Result<Value, String> {
    let source = probe_dll(app)?;
    let root = app_runtime_dir(app)?.join("probes").join("region-selection");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    // Windows keeps a loaded DLL locked and loads a path only once per process, so
    // each selection loads its own copy. Copies no longer in use are removed.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("wod_python_probe_") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dll = root.join(format!("wod_python_probe_{unique}.dll"));
    let payload_path = root.join("wod_python_probe_payload.py");
    let output_path = root.join("region-selection-result.json");
    let error_path = root.join("region-selection-result.json.error.txt");
    let status_path = root.join("wod_python_probe.status.json");
    for stale in [&output_path, &error_path, &status_path] {
        let _ = fs::remove_file(stale);
    }
    fs::copy(&source, &dll).map_err(|error| format!("Could not prepare the region probe: {error}"))?;
    let escape = |value: &str| value.replace('\\', "\\\\").replace('\'', "\\'");
    let payload = PAYLOAD
        .replace("__OUTPUT_PATH__", &escape(&output_path.to_string_lossy()))
        .replace("__REGION__", &escape(region))
        .replace("__SAVED_SERVERS__", &escape(&serde_json::to_string(&saved_servers(app)).unwrap_or_default()));
    fs::write(&payload_path, payload).map_err(|error| format!("Could not prepare the region probe: {error}"))?;

    load_library_in(process_id, &dll)?;

    let deadline = Instant::now() + RESULT_WAIT;
    while Instant::now() < deadline && !output_path.is_file() && !error_path.is_file() {
        std::thread::sleep(Duration::from_millis(100));
    }
    let Some(value) = read_json(&output_path) else {
        let detail = fs::read_to_string(&error_path)
            .ok()
            .or_else(|| read_json(&status_path).and_then(|status| status["detail"].as_str().map(str::to_string)))
            .unwrap_or_else(|| "no response".into());
        let first_line = detail.lines().next().unwrap_or_default().to_string();
        return Err(format!("The region could not be applied ({first_line})."));
    };
    match value["status"].as_str() {
        Some("armed" | "no_server") => Ok(value),
        Some("invalid_region") => Err("Choose NA, EU or Asia.".into()),
        _ => Err(value["message"]
            .as_str()
            .unwrap_or("The region could not be applied.")
            .to_string()),
    }
}

fn current_selection(app: &AppHandle, process_id: u32) -> Option<RegionSelection> {
    read_json(&selection_path(app).ok()?)
        .and_then(|value| serde_json::from_value::<RegionSelection>(value).ok())
        .filter(|selection| selection.process_id == process_id)
}

fn status_value(app: &AppHandle, process_id: Option<u32>) -> Result<Value, String> {
    let selection = process_id.and_then(|process_id| current_selection(app, process_id));
    let selected = selection.as_ref().filter(|selection| !selection.region.is_empty());
    Ok(json!({
        "gameRunning": process_id.is_some(),
        "selectedRegion": selected.map(|selection| selection.region.clone()),
        "selectedAt": selected.map(|selection| selection.selected_at),
        "servers": selection.map(|selection| selection.servers).filter(Value::is_array),
    }))
}

#[tauri::command]
pub(crate) async fn region_status(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || status_value(&app, running_game_process()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn select_region(app: AppHandle, region: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let region = normalize_region(&region)?;
        let process_id = running_game_process().ok_or("War of Dots is not running.")?;
        let previous = current_selection(&app, process_id);
        if previous.is_none() {
            // The probe's event log covers one game session.
            let log = app_runtime_dir(&app)?.join("probes").join("region-selection").join("region-events.log");
            let _ = fs::remove_file(log);
        }
        let result = apply_region(&app, process_id, region)?;
        save_servers(&app, &result);
        let previous = previous.unwrap_or_default();
        let servers = Some(result["serverInfo"].clone())
            .filter(|servers| servers.as_array().is_some_and(|servers| !servers.is_empty()))
            .unwrap_or(previous.servers.clone());
        // A region without a reachable server leaves the current choice in place.
        let unavailable = (result["status"] == "no_server").then(|| result["message"].clone());
        let selection = if unavailable.is_some() {
            RegionSelection { servers, process_id, ..previous }
        } else {
            RegionSelection {
                region: region.to_string(),
                selected_at: now_secs(),
                process_id,
                servers,
            }
        };
        let text = serde_json::to_string_pretty(&selection).map_err(|error| error.to_string())?;
        fs::write(selection_path(&app)?, text).map_err(|error| error.to_string())?;
        let mut status = status_value(&app, Some(process_id))?;
        status["unavailable"] = unavailable.unwrap_or(Value::Null);
        status["pending"] = result["pending"].clone();
        Ok(status)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_are_matched_without_case() {
        assert_eq!(normalize_region(" asia "), Ok("ASIA"));
        assert_eq!(normalize_region("eu"), Ok("EU"));
        assert!(normalize_region("OCE").is_err());
    }

    #[test]
    fn only_the_war_of_dots_executable_counts() {
        assert!(is_game_executable(Path::new(
            r"D:\SteamLibrary\steamapps\common\War of Dots\game.exe"
        )));
        assert!(!is_game_executable(Path::new(r"C:\Games\Other\game.exe")));
        assert!(!is_game_executable(Path::new(
            r"D:\SteamLibrary\steamapps\common\War of Dots\launcher.exe"
        )));
    }

    #[test]
    fn payload_has_placeholders() {
        assert!(["__OUTPUT_PATH__", "__REGION__", "__SAVED_SERVERS__"]
            .iter()
            .all(|placeholder| PAYLOAD.contains(placeholder)));
    }
}
