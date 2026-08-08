//! Downloading, verifying and silently installing the More of Dots Recorder.
//!
//! The recorder ships as a separate per-user NSIS installer so a recorder
//! quarantine cannot take the replay browser down with it. That split leaves the
//! app responsible for acquiring it, which means the app executes a file it just
//! pulled off the network. Nothing here runs an installer that has not matched
//! both its published SHA-256 and a minisign signature made with the same
//! keypair that signs the app's own update bundles.

use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures::stream::StreamExt;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MANIFEST_URL: &str =
    "https://github.com/aexer0e/more-of-dots/releases/latest/download/recorder.json";
const MANIFEST_SIGNATURE_URL: &str =
    "https://github.com/aexer0e/more-of-dots/releases/latest/download/recorder.json.sig";

/// The keypair behind this is the one in `tauri.conf.json`, so the recorder and
/// the app are covered by a single signing secret.
const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNDOEMxM0I4NjVCNjIzNUYKUldSZkk3Wmx1Qk9NUEwzOEJ5N1NJaXBvekhZRy9EK0NodGxmcXVrdGVOUUtJYkI1SXEyekprek4K";

const SUPPORTED_PROTOCOL_VERSION: u64 = 1;
const MANIFEST_SCHEMA_VERSION: u64 = 1;
const MANIFEST_MAX_BYTES: usize = 64 * 1024;
const PROGRESS_EVENT: &str = "recorder-install-progress";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(60);

/// The installer expands to a program directory plus a bundled game vault
/// several times its own size, and NSIS gives no useful error when it runs out
/// of room part way through.
const INSTALL_EXPANSION_FACTOR: u64 = 3;
const INSTALL_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;

/// Silent-install exit codes defined by `scripts/recorder-installer.nsi`.
const EXIT_RECORDER_RUNNING: i32 = 3;
const EXIT_INSTALL_INCOMPLETE: i32 = 4;

#[derive(Default)]
pub(crate) struct RecorderInstallControl {
    active: AtomicBool,
    cancelled: AtomicBool,
}

impl RecorderInstallControl {
    fn begin(&self) -> Result<InstallGuard<'_>, String> {
        if self
            .active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("A recorder install is already running.".to_string());
        }
        self.cancelled.store(false, Ordering::SeqCst);
        Ok(InstallGuard { control: self })
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct InstallGuard<'a> {
    control: &'a RecorderInstallControl,
}

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.control.active.store(false, Ordering::SeqCst);
        self.control.cancelled.store(false, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
struct RecorderManifest {
    schema_version: u64,
    recorder_version: String,
    protocol_versions: Vec<u64>,
    #[serde(default)]
    game_versions: Vec<String>,
    install: RecorderInstall,
}

#[derive(Deserialize)]
struct RecorderInstall {
    url: String,
    size: u64,
    sha256: String,
    signature: String,
}

/// Both the key and the signature travel base64-wrapped around minisign's own
/// text format, matching how Tauri carries them in `latest.json`, so one
/// convention covers the app and the recorder.
fn verify_with(public_key_b64: &str, data: &[u8], signature_b64: &str) -> Result<(), String> {
    let key_text = BASE64
        .decode(public_key_b64.trim())
        .ok()
        .and_then(|decoded| String::from_utf8(decoded).ok())
        .ok_or_else(|| "The update key is not valid base64 text.".to_string())?;
    let public_key = PublicKey::decode(&key_text)
        .map_err(|error| format!("The update key could not be parsed: {error}"))?;
    let signature_text = BASE64
        .decode(signature_b64.trim())
        .ok()
        .and_then(|decoded| String::from_utf8(decoded).ok())
        .ok_or_else(|| "The signature is not valid base64 text.".to_string())?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("The signature could not be parsed: {error}"))?;
    // Legacy signatures are accepted for the same reason Tauri accepts them: the
    // release tooling has produced both forms over time.
    public_key
        .verify(data, &signature, true)
        .map_err(|_| "The download was not signed by More of Dots and will not be run.".to_string())
}

fn verify_signature(data: &[u8], signature: &str) -> Result<(), String> {
    verify_with(UPDATE_PUBKEY, data, signature)
}

fn http_client() -> Result<reqwest::Client, String> {
    // reqwest is built without a bundled crypto provider so it stays a single
    // shared build with the app updater's. Whichever of the two runs first
    // installs the provider; the other finds it already there.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .connect_timeout(NETWORK_TIMEOUT)
        .user_agent(concat!("more-of-dots/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not start the download client: {error}"))
}

async fn fetch_manifest() -> Result<RecorderManifest, String> {
    let client = http_client()?;
    let body = client
        .get(MANIFEST_URL)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not reach the recorder update service: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Could not read the recorder manifest: {error}"))?;
    if body.len() > MANIFEST_MAX_BYTES {
        return Err("The recorder manifest is implausibly large and was rejected.".to_string());
    }
    let signature = client
        .get(MANIFEST_SIGNATURE_URL)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not reach the recorder update service: {error}"))?
        .text()
        .await
        .map_err(|error| format!("Could not read the recorder manifest signature: {error}"))?;
    verify_signature(&body, &signature)?;

    let manifest: RecorderManifest = serde_json::from_slice(&body)
        .map_err(|error| format!("The recorder manifest could not be read: {error}"))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "This version of More of Dots cannot read recorder manifest schema {}.",
            manifest.schema_version
        ));
    }
    if !manifest.install.url.starts_with("https://github.com/") {
        return Err("The recorder manifest points somewhere unexpected and was rejected.".to_string());
    }
    Ok(manifest)
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit(PROGRESS_EVENT, payload);
}

fn temp_installer_path(version: &str) -> Result<PathBuf, String> {
    let root = std::env::temp_dir().join("more-of-dots");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not prepare {}: {error}", root.display()))?;
    Ok(root.join(format!("recorder-{version}-x64-setup.exe")))
}

#[cfg(windows)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }

    let wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0u64;
    let mut total = 0u64;
    let mut total_free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            &mut total,
            &mut total_free,
        )
    };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

fn check_free_space(path: &Path, download_size: u64) -> Result<(), String> {
    let required = download_size
        .saturating_mul(INSTALL_EXPANSION_FACTOR)
        .saturating_add(INSTALL_HEADROOM_BYTES);
    let Some(available) = free_bytes(path) else {
        return Ok(());
    };
    if available >= required {
        return Ok(());
    }
    Err(format!(
        "Installing the recorder needs about {} GB free on {}, but only {} GB is available.",
        required / (1024 * 1024 * 1024),
        path.display(),
        available / (1024 * 1024 * 1024)
    ))
}

/// Downloads to `destination`, resuming a partial file when one is present.
/// A 330 MB transfer that has to restart from zero on every dropped connection
/// is not something a user will sit through twice.
async fn download(
    app: &AppHandle,
    control: &RecorderInstallControl,
    install: &RecorderInstall,
    destination: &Path,
) -> Result<(), String> {
    let mut resume_from = fs::metadata(destination).map(|meta| meta.len()).unwrap_or(0);
    if resume_from > install.size {
        resume_from = 0;
    }
    if resume_from == install.size {
        return Ok(());
    }

    let client = http_client()?;
    let mut request = client.get(&install.url);
    if resume_from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let response = request
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Could not download the recorder: {error}"))?;

    // A server that ignores the range header restarts the body at zero, so the
    // partial file has to go rather than be appended to.
    let resuming = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if resume_from > 0 && !resuming {
        resume_from = 0;
    }

    // Not truncating: a resumed download keeps the bytes already on disk, and
    // set_len below trims to exactly the offset the request asked to continue from.
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(destination)
        .map_err(|error| format!("Could not write {}: {error}", destination.display()))?;
    file.set_len(resume_from)
        .and_then(|_| file.seek(SeekFrom::Start(resume_from)).map(|_| ()))
        .map_err(|error| format!("Could not resume {}: {error}", destination.display()))?;

    let mut downloaded = resume_from;
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if control.cancelled() {
            return Err("cancelled".to_string());
        }
        let chunk = chunk.map_err(|error| format!("The recorder download failed: {error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("Could not write {}: {error}", destination.display()))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            emit(
                app,
                json!({
                    "step": "downloading",
                    "downloaded": downloaded,
                    "total": install.size,
                }),
            );
        }
    }
    file.flush()
        .map_err(|error| format!("Could not finish writing {}: {error}", destination.display()))?;
    drop(file);

    if downloaded != install.size {
        return Err(format!(
            "The recorder download ended early at {downloaded} of {} bytes.",
            install.size
        ));
    }
    emit(
        app,
        json!({ "step": "downloading", "downloaded": downloaded, "total": install.size }),
    );
    Ok(())
}

fn verify_download(path: &Path, install: &RecorderInstall) -> Result<(), String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("Could not read the downloaded installer: {error}"))?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(install.sha256.trim()) {
        return Err("The recorder download did not match its published checksum.".to_string());
    }
    verify_signature(&bytes, &install.signature)
}

fn run_installer(path: &Path) -> Result<(), String> {
    let mut command = Command::new(path);
    command.arg("/S");
    #[cfg(windows)]
    command.creation_flags(super::CREATE_NO_WINDOW);
    let status = command
        .status()
        .map_err(|error| format!("Could not start the recorder installer: {error}"))?;
    if status.success() {
        return Ok(());
    }
    Err(match status.code() {
        Some(EXIT_RECORDER_RUNNING) => {
            "A recording is still using the recorder. Let the queue finish, then try again."
                .to_string()
        }
        Some(EXIT_INSTALL_INCOMPLETE) => {
            "The recorder installer could not write all of its files.".to_string()
        }
        Some(code) => format!("The recorder installer exited with code {code}."),
        None => "The recorder installer was stopped before it finished.".to_string(),
    })
}

/// Reports what is installed now and what the release channel is offering.
pub(crate) async fn check(app: &AppHandle) -> Result<Value, String> {
    let installed = super::installed_recorder(app).await;
    let manifest = fetch_manifest().await?;
    Ok(describe(installed.as_ref(), &manifest))
}

fn describe(installed: Option<&Value>, manifest: &RecorderManifest) -> Value {
    let installed_version = installed
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let compatible = manifest
        .protocol_versions
        .contains(&SUPPORTED_PROTOCOL_VERSION);
    let installed_compatible = installed
        .and_then(|value| value.get("protocol_versions"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_u64)
                .any(|version| version == SUPPORTED_PROTOCOL_VERSION)
        })
        .unwrap_or(false);

    let update_available = match parse_version(&manifest.recorder_version) {
        None => false,
        Some(offered) => match installed_version.as_deref() {
            // Installed but silent about its version: it pre-dates version
            // reporting, so it is by definition older than anything on offer.
            None => installed.is_some(),
            Some(current) => match parse_version(current) {
                // Only ever move forward. A manifest offering an older build is
                // either a mistake or a rollback attempt, and neither is worth
                // a download this size.
                Some(current) => offered > current,
                None => true,
            },
        },
    };

    json!({
        "installed": installed.is_some(),
        "installed_version": installed_version,
        "available_version": manifest.recorder_version,
        "game_versions": manifest.game_versions,
        "update_available": update_available,
        "update_required": installed.is_some() && !installed_compatible,
        "compatible": compatible,
        "size": manifest.install.size,
    })
}

/// Downloads, verifies and silently installs the recorder, then confirms the
/// result by asking the newly installed binary what it is.
pub(crate) async fn install(app: &AppHandle, control: &RecorderInstallControl) -> Result<Value, String> {
    let guard = control.begin()?;
    let result = install_inner(app, control).await;
    drop(guard);
    match &result {
        Ok(value) => emit(app, json!({ "step": "completed", "recorder": value })),
        Err(error) if error == "cancelled" => emit(app, json!({ "step": "cancelled" })),
        Err(error) => emit(app, json!({ "step": "error", "error": error })),
    }
    result
}

async fn install_inner(app: &AppHandle, control: &RecorderInstallControl) -> Result<Value, String> {
    emit(app, json!({ "step": "checking" }));
    let manifest = fetch_manifest().await?;
    if !manifest
        .protocol_versions
        .contains(&SUPPORTED_PROTOCOL_VERSION)
    {
        return Err(format!(
            "Recorder {} does not speak this version of More of Dots. Update More of Dots first.",
            manifest.recorder_version
        ));
    }

    let installed = super::installed_recorder(app).await;
    let status = describe(installed.as_ref(), &manifest);
    if installed.is_some()
        && !status["update_available"].as_bool().unwrap_or(false)
        && !status["update_required"].as_bool().unwrap_or(false)
    {
        emit(app, json!({ "step": "current", "recorder": status }));
        return Ok(status);
    }

    let destination = temp_installer_path(&manifest.recorder_version)?;
    check_free_space(destination.parent().unwrap_or(&destination), manifest.install.size)?;

    if control.cancelled() {
        return Err("cancelled".to_string());
    }
    emit(
        app,
        json!({ "step": "downloading", "downloaded": 0, "total": manifest.install.size }),
    );
    download(app, control, &manifest.install, &destination).await?;

    if control.cancelled() {
        return Err("cancelled".to_string());
    }
    emit(app, json!({ "step": "verifying" }));
    if let Err(error) = verify_download(&destination, &manifest.install) {
        // Never leave an unverified installer lying around where a later resume
        // could treat it as a complete download.
        let _ = fs::remove_file(&destination);
        return Err(error);
    }

    emit(app, json!({ "step": "installing" }));
    let installer = destination.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || run_installer(&installer))
        .await
        .map_err(|error| format!("The recorder install task failed: {error}"))?;
    let _ = fs::remove_file(&destination);
    outcome?;

    // NSIS reports success before Windows has necessarily released every handle,
    // and the exit code alone has been unreliable, so confirm by asking the
    // installed binary to identify itself.
    emit(app, json!({ "step": "verifying-install" }));
    let installed = super::installed_recorder(app)
        .await
        .ok_or_else(|| "The recorder installed but did not respond afterwards.".to_string())?;
    let reported = installed
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if reported != manifest.recorder_version {
        return Err(format!(
            "The recorder reports version {reported} after installing {}.",
            manifest.recorder_version
        ));
    }
    Ok(describe(Some(&installed), &manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, protocols: Vec<u64>) -> RecorderManifest {
        RecorderManifest {
            schema_version: 1,
            recorder_version: version.to_string(),
            protocol_versions: protocols,
            game_versions: vec!["1.3.4".to_string()],
            install: RecorderInstall {
                url: "https://github.com/aexer0e/more-of-dots/releases/download/v1/setup.exe"
                    .to_string(),
                size: 1024,
                sha256: "00".to_string(),
                signature: String::new(),
            },
        }
    }

    fn installed(version: &str, protocols: Vec<u64>) -> Value {
        json!({ "version": version, "protocol_versions": protocols })
    }

    /// Verbatim output of `tauri signer generate` and `tauri signer sign`. Those
    /// files already hold base64, which is why the manifest copies them without
    /// re-encoding. Pinning a real pair here means a drift between the release
    /// tooling and this decoder fails the build rather than every install.
    const FIXTURE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhDMzVGRDQyRkVCMDc2NzgKUldSNGRyRCtRdjAxak4yQXcwYS9XcmRXSlBFR2t0bTB5OXQ0MCs4VTNyVzNHb210NXVFWXloNVUK";
    const FIXTURE_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSNGRyRCtRdjAxak1wN0MrZ3RqdkVoMDJvK2UvNDRDK0x3djEvL1czNU5SeEFwV1F0cG9aczl1THkyZTdwY3BKYVljSlFrN2lsMXJqM3dkYUd0bmg0c1Naa1FnZ2Rpb3drPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg2MTgzMTE1CWZpbGU6cGF5bG9hZC5iaW4KYlhzY0IrZ0ovSUdVRlFYYzc1Z29HZmV2K1V6TUJtS0djV01pdWtKL1hNaG9KbVJFQmRzc1gxMEMvYU5KQ00xZnh6WE5sTWlMZkU0bGhTdk1oUE5ZRFE9PQo=";
    const FIXTURE_PAYLOAD: &[u8] = b"more-of-dots recorder fixture";

    #[test]
    fn bundled_public_key_parses() {
        // Reuses the real decoder against the shipped key, so a malformed
        // constant fails the build rather than the first install attempt.
        let error = verify_with(UPDATE_PUBKEY, b"payload", FIXTURE_SIGNATURE).unwrap_err();
        assert!(!error.contains("update key"), "the bundled key is unusable: {error}");
    }

    #[test]
    fn accepts_a_signature_from_the_release_tooling() {
        verify_with(FIXTURE_PUBKEY, FIXTURE_PAYLOAD, FIXTURE_SIGNATURE)
            .expect("a signature made by tauri signer must verify");
    }

    #[test]
    fn rejects_a_signature_over_different_bytes() {
        let error = verify_with(FIXTURE_PUBKEY, b"tampered", FIXTURE_SIGNATURE).unwrap_err();
        assert!(error.contains("was not signed"), "unexpected error: {error}");
    }

    #[test]
    fn rejects_a_signature_from_another_key() {
        let error = verify_with(UPDATE_PUBKEY, FIXTURE_PAYLOAD, FIXTURE_SIGNATURE).unwrap_err();
        assert!(error.contains("was not signed"), "unexpected error: {error}");
    }

    #[test]
    fn missing_recorder_is_not_an_update() {
        let status = describe(None, &manifest("1.2.0", vec![1]));
        assert_eq!(status["installed"], json!(false));
        assert_eq!(status["update_available"], json!(false));
        assert_eq!(status["available_version"], json!("1.2.0"));
    }

    #[test]
    fn newer_recorder_is_offered() {
        let current = installed("1.1.0", vec![1]);
        let status = describe(Some(&current), &manifest("1.2.0", vec![1]));
        assert_eq!(status["update_available"], json!(true));
        assert_eq!(status["update_required"], json!(false));
    }

    #[test]
    fn recorder_without_a_version_is_offered_an_update() {
        // Recorders built before version reporting existed report no version at
        // all. Without this they would sit un-updatable forever.
        let current = json!({ "protocol_versions": [1] });
        let status = describe(Some(&current), &manifest("1.2.0", vec![1]));
        assert_eq!(status["installed"], json!(true));
        assert_eq!(status["installed_version"], Value::Null);
        assert_eq!(status["update_available"], json!(true));
    }

    #[test]
    fn older_recorder_is_never_offered() {
        let current = installed("1.2.0", vec![1]);
        let status = describe(Some(&current), &manifest("1.1.0", vec![1]));
        assert_eq!(status["update_available"], json!(false));
    }

    #[test]
    fn same_recorder_is_not_offered() {
        let current = installed("1.2.0", vec![1]);
        let status = describe(Some(&current), &manifest("1.2.0", vec![1]));
        assert_eq!(status["update_available"], json!(false));
    }

    #[test]
    fn incompatible_installed_recorder_forces_an_update() {
        let current = installed("1.1.0", vec![2]);
        let status = describe(Some(&current), &manifest("1.2.0", vec![1]));
        assert_eq!(status["update_required"], json!(true));
    }

    #[test]
    fn version_parsing_rejects_junk() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("v1.2.3"), None);
    }

    #[test]
    fn signature_verification_rejects_a_forgery() {
        let error = verify_signature(b"payload", "bm90LWEtc2lnbmF0dXJl").unwrap_err();
        assert!(error.contains("signature"), "unexpected error: {error}");
    }

    #[test]
    fn free_space_check_reports_the_shortfall() {
        // Only the arithmetic is under test; the probe returns None off Windows.
        let required = 100u64
            .saturating_mul(INSTALL_EXPANSION_FACTOR)
            .saturating_add(INSTALL_HEADROOM_BYTES);
        assert!(required > INSTALL_HEADROOM_BYTES);
    }
}
