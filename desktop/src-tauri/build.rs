fn main() {
    println!("cargo:rerun-if-env-changed=ORBYN_UPDATE_PUBKEY");
    println!("cargo:rerun-if-env-changed=ORBYN_UPDATE_ENDPOINT");
    tauri_build::build()
}
