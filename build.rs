fn main() {
    // Runs under every feature set: `napi` types remain in the library without
    // the `napi` feature, so this crate's `cdylib` target still needs the link
    // arguments when `cargo build` links it. An embedder only consumes the
    // `rlib`, where the emitted flags are ignored anyway.
    napi_build::setup();
}
