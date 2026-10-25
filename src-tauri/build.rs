fn main() {
    check_nasm();
    tauri_build::build()
}

/// OpenH264 quietly builds without its x86 assembly when NASM is missing, and
/// video export then runs at a third of its speed. Release builds stop instead.
fn check_nasm() {
    println!("cargo:rerun-if-env-changed=NASM");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("x86_64") {
        return;
    }
    let nasm = std::env::var("NASM").unwrap_or_else(|_| "nasm".into());
    if std::process::Command::new(&nasm).arg("-v").output().is_ok_and(|output| output.status.success()) {
        return;
    }
    let message = "NASM was not found, so OpenH264 builds without its assembly and video export is slow. Install NASM or set NASM to its path.";
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        panic!("{message}");
    }
    println!("cargo:warning={message}");
}
