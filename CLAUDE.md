# oxc-node

Build, test, lint and format commands, as defined in `justfile`, `package.json` and `.github/workflows/CI.yml`. Run `package.json` scripts through Vite+ with `vp run <name>`, as `AGENTS.md` says:

- Build the native binding, the oxc runtime and the CLI: `just build` (the integration tests run `packages/cli/dist/index.js`)
- Run the integration tests: `vp run test`
- Build and then test in one step: `just ready`
- Run the Rust tests: `cargo test --all-features`
- Lint JavaScript and TypeScript: `vp run lint`
- Lint Rust with warnings denied: `cargo clippy --all-targets --all-features -- -D warnings`
- Format JavaScript, TypeScript and Rust: `vp run fmt`
