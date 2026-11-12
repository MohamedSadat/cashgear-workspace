fn main() {
    // The test-only bridge (feature `e2e-bridge`, src/bridge.rs) never goes into a release: the
    // release workflows set CGW_RELEASE_BUILD, and a build with both stops here.
    println!("cargo:rerun-if-env-changed=CGW_RELEASE_BUILD");
    if std::env::var_os("CARGO_FEATURE_E2E_BRIDGE").is_some()
        && std::env::var_os("CGW_RELEASE_BUILD").is_some_and(|value| !value.is_empty())
    {
        panic!("The e2e-bridge feature is for test builds only, and CGW_RELEASE_BUILD is set.");
    }
    tauri_build::build()
}
