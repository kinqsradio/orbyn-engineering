fn main() {
    println!("cargo:rerun-if-env-changed=ORBYN_UPDATE_PUBKEY");
    println!("cargo:rerun-if-env-changed=ORBYN_UPDATE_ENDPOINT");
    // Listing the commands makes the capability files decide who may call them, so
    // the product UI, which has no capability, cannot.
    let manifest = tauri_build::AppManifest::new().commands(&["restart_core"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("run tauri-build");
}
