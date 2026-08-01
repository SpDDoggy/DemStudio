fn main() {
    // Cargo must re-embed the production frontend whenever Vite output changes;
    // otherwise a green Rust build can silently ship stale rendering code.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
