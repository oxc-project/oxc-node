# oxc-node

Build, test, lint and format commands, as defined in `justfile`, `package.json` and `.github/workflows/CI.yml`:

- Build the native binding: `pnpm --filter @oxc-node/core build`
- Run the integration tests: `pnpm test`
- Run the Rust tests: `cargo test --all-features`
- Lint JavaScript and TypeScript: `pnpm lint`
- Lint Rust with warnings denied: `cargo clippy --all-targets --all-features -- -D warnings`
- Format JavaScript, TypeScript and Rust: `pnpm fmt`
