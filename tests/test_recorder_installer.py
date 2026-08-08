"""Guards on how the recorder is packaged, published and fetched.

These are text assertions rather than end-to-end runs: building the installer
needs NSIS and a populated game vault, and installing it would modify the machine
running the tests. What is worth pinning down is the safety contract, since every
rule here exists because breaking it hands a user a broken or unverified install.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = (ROOT / "scripts" / "recorder-installer.nsi").read_text(encoding="utf-8")
BUILD = (ROOT / "scripts" / "build-recorder.ps1").read_text(encoding="utf-8")
MANIFEST = (ROOT / "scripts" / "recorder-manifest.ps1").read_text(encoding="utf-8")
UPDATE = (ROOT / "src-tauri" / "src" / "recorder_update.rs").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")


def test_upgrade_clears_the_previous_payload() -> None:
    # PyInstaller renames payload files between builds, so overwriting in place
    # leaves modules behind that a later build may still import.
    assert 'RMDir /r "$INSTDIR\\payload"' in INSTALLER


def test_upgrade_skips_an_unchanged_game_vault() -> None:
    assert "${BUNDLED_VERSIONS_ID}" in INSTALLER
    assert "BUNDLED_VERSIONS_PROBE" in INSTALLER
    # The marker alone is not trusted; the build has to still be on disk.
    assert 'game\\game.exe" 0 extract_versions' in INSTALLER


def test_silent_install_reports_failure_through_exit_codes() -> None:
    assert "SetErrorLevel ${ERR_RECORDER_RUNNING}" in INSTALLER
    assert "SetErrorLevel ${ERR_INSTALL_INCOMPLETE}" in INSTALLER
    # A running recorder locks its own image, and NSIS cannot replace it.
    assert 'FileOpen $R0 "$INSTDIR\\more-of-dots-recorder.exe" a' in INSTALLER


def test_vault_identifier_hashes_file_contents() -> None:
    # Names and sizes would let a re-exported build of the same shape look
    # unchanged, and the installer would then skip a vault that did change.
    assert "Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256" in BUILD
    assert "/DBUNDLED_VERSIONS_ID=$BundledVersionsId" in BUILD


def test_manifest_requires_a_signature() -> None:
    assert "refuses to run an unsigned installer" in MANIFEST
    # The .sig file already holds base64. Encoding it again would produce a
    # manifest that every client rejects.
    assert "(Get-Content -LiteralPath $SignaturePath -Raw).Trim()" in MANIFEST
    assert "ToBase64String" not in MANIFEST
    # Version claims are read back out of the built recorder, not assumed.
    assert "--desktop-command recorder-capabilities" in MANIFEST


def test_release_signs_with_single_token_arguments() -> None:
    # `-p "$env:X"` collapses to nothing when the secret is empty, which shifts
    # the file argument into the password slot and hangs on a prompt.
    assert '--private-key="$env:TAURI_SIGNING_PRIVATE_KEY"' in WORKFLOW
    assert '--password="$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD"' in WORKFLOW


def test_release_publishes_a_manifest_on_every_release() -> None:
    assert "Sign recorder installer and write manifest" in WORKFLOW
    # A release that skips the recorder build still has to advertise one, or the
    # client's check would start reporting that no recorder exists.
    assert "Carry forward the previous recorder manifest" in WORKFLOW
    assert "recorder-dist/recorder.json#Recorder update manifest" in WORKFLOW


def test_manifest_signature_always_travels_with_the_manifest() -> None:
    # The client fetches both and refuses an unsigned manifest, so publishing one
    # without the other is indistinguishable from having no recorder at all.
    assert "recorder-dist/recorder.json.sig#Recorder update manifest signature" in WORKFLOW
    assert '-Uri "$latest/recorder.json.sig"' in WORKFLOW
    assert "Test-Path recorder-dist/recorder.json.sig" in WORKFLOW
    assert "MANIFEST_SIGNATURE_URL" in UPDATE


def test_client_verifies_before_it_executes() -> None:
    # Order matters: the checksum and signature are both checked before the
    # installer is ever handed to the shell.
    verify = UPDATE.index("fn verify_download")
    run = UPDATE.index("fn run_installer")
    assert verify < run
    assert "did not match its published checksum" in UPDATE
    assert "was not signed by More of Dots and will not be run" in UPDATE
    assert 'command.arg("/S")' in UPDATE


def test_client_rejects_a_downgrade() -> None:
    assert "Only ever move forward" in UPDATE
    assert "offered > current" in UPDATE


def test_client_only_accepts_release_assets() -> None:
    assert 'starts_with("https://github.com/")' in UPDATE


def test_failed_verification_removes_the_download() -> None:
    # Otherwise the next attempt would resume onto a poisoned partial file.
    section = UPDATE[UPDATE.index("fn install_inner") :]
    assert "let _ = fs::remove_file(&destination);" in section


def test_install_is_blocked_while_recording() -> None:
    lib = (ROOT / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")
    assert "Let the queue finish before updating the recorder." in lib


def test_frontend_patches_the_install_panel_in_place() -> None:
    frontend = (ROOT / "src" / "main.ts").read_text(encoding="utf-8")

    assert "function updateRecorderInstallUi" in frontend
    assert 'listen<RecorderInstallProgressEvent>("recorder-install-progress"' in frontend
    assert 'role="progressbar"' in frontend
    # Progress arrives several times a second; rebuilding the dialog would
    # restart its transitions and drop focus.
    assert "renderRecorderInstallPanel()}" in frontend
    assert "innerHTML = renderRecorderInstallPanel" not in frontend
