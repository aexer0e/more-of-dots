use std::ffi::{c_char, c_void, CString};
use std::fs;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::thread;
use std::time::Duration;

type HModule = *mut c_void;
type DWord = u32;
type Bool = i32;

const DLL_PROCESS_ATTACH: DWord = 1;

type PyGilStateEnsure = unsafe extern "C" fn() -> i32;
type PyGilStateRelease = unsafe extern "C" fn(i32);
type PyRunSimpleString = unsafe extern "C" fn(*const c_char) -> i32;

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: *mut c_void) -> Bool;
    fn CreateThread(
        attributes: *mut c_void,
        stack_size: usize,
        start_address: unsafe extern "system" fn(*mut c_void) -> DWord,
        parameter: *mut c_void,
        creation_flags: DWord,
        thread_id: *mut DWord,
    ) -> *mut c_void;
    fn DisableThreadLibraryCalls(module: HModule) -> Bool;
    fn GetModuleFileNameW(module: HModule, filename: *mut u16, size: DWord) -> DWord;
    fn GetModuleHandleA(module_name: *const c_char) -> HModule;
    fn GetProcAddress(module: HModule, proc_name: *const c_char) -> *mut c_void;
}

fn module_dir(module: HModule) -> Result<PathBuf, String> {
    let mut buffer = vec![0u16; 32768];
    let len = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as DWord) };
    if len == 0 {
        return Err("GetModuleFileNameW failed.".to_string());
    }
    buffer.truncate(len as usize);
    let path = PathBuf::from(String::from_utf16_lossy(&buffer));
    path.parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Probe DLL path has no parent directory.".to_string())
}

fn write_status(module: HModule, status: &str, detail: &str) {
    if let Ok(dir) = module_dir(module) {
        let escaped = detail.replace('\\', "\\\\").replace('"', "\\\"");
        let body = format!("{{\"status\":\"{}\",\"detail\":\"{}\"}}\n", status, escaped);
        let _ = fs::write(dir.join("wod_python_probe.status.json"), body);
    }
}

unsafe fn get_proc<T>(module: HModule, name: &[u8]) -> Result<T, String> {
    let ptr = GetProcAddress(module, name.as_ptr() as *const c_char);
    if ptr.is_null() {
        return Err(format!(
            "GetProcAddress failed for {}.",
            String::from_utf8_lossy(name).trim_end_matches('\0')
        ));
    }
    Ok(std::mem::transmute_copy::<*mut c_void, T>(&ptr))
}

unsafe extern "system" fn worker(parameter: *mut c_void) -> DWord {
    let module = parameter as HModule;
    let dir = match module_dir(module) {
        Ok(path) => path,
        Err(error) => {
            write_status(module, "failed", &error);
            return 1;
        }
    };

    let payload_path = dir.join("wod_python_probe_payload.py");
    let payload = match fs::read_to_string(&payload_path) {
        Ok(value) => value,
        Err(error) => {
            write_status(module, "failed", &format!("Could not read payload: {error}"));
            return 1;
        }
    };

    let python_name = CString::new("python312.dll").expect("static string has no nul");
    let python = (0..80)
        .find_map(|_| {
            let handle = GetModuleHandleA(python_name.as_ptr());
            if handle.is_null() {
                thread::sleep(Duration::from_millis(250));
                None
            } else {
                Some(handle)
            }
        });
    let Some(python) = python else {
        write_status(module, "failed", "python312.dll is not loaded in the target process.");
        return 1;
    };

    let ensure: PyGilStateEnsure = match get_proc(python, b"PyGILState_Ensure\0") {
        Ok(func) => func,
        Err(error) => {
            write_status(module, "failed", &error);
            return 1;
        }
    };
    let release: PyGilStateRelease = match get_proc(python, b"PyGILState_Release\0") {
        Ok(func) => func,
        Err(error) => {
            write_status(module, "failed", &error);
            return 1;
        }
    };
    let run: PyRunSimpleString = match get_proc(python, b"PyRun_SimpleString\0") {
        Ok(func) => func,
        Err(error) => {
            write_status(module, "failed", &error);
            return 1;
        }
    };

    let payload = match CString::new(payload) {
        Ok(value) => value,
        Err(_) => {
            write_status(module, "failed", "Payload contains an embedded nul byte.");
            return 1;
        }
    };

    let gil = ensure();
    let rc = run(payload.as_ptr());
    release(gil);

    if rc == 0 {
        write_status(module, "succeeded", "Payload completed.");
        0
    } else {
        write_status(module, "failed", &format!("PyRun_SimpleString returned {rc}."));
        1
    }
}

#[no_mangle]
pub extern "system" fn DllMain(module: HModule, reason: DWord, _reserved: *mut c_void) -> Bool {
    if reason == DLL_PROCESS_ATTACH {
        unsafe {
            DisableThreadLibraryCalls(module);
            let thread = CreateThread(null_mut(), 0, worker, module as *mut c_void, 0, null_mut());
            if !thread.is_null() {
                CloseHandle(thread);
            }
        }
    }
    1
}
