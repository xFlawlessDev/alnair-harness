# Contributing

Alnair is a hard fork of [xai-org/grok-build](https://github.com/xai-org/grok-build)
(which does not accept external contributions). Alnair itself welcomes issues
and pull requests.

## Ground rules

- Toolchain is pinned by `rust-toolchain.toml` (Rust 1.97.0, edition 2024).
- Before opening a PR, make sure the CI gates pass locally:

```sh
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets
cargo fmt --all --check
cargo deny check advisories
```

- No telemetry, analytics, or new outbound endpoints. The closed set of
  first-party endpoints lives in `crates/codegen/alnair-env`.
- Upstream syncs are evaluated commit-by-commit and cherry-picked manually;
  see the PRD §8.1 policy (`git range-diff` records the adopted set).

## Opening a pull request

Open pull requests against the GitHub repository:

1. Fork the repository at https://github.com/xFlawlessDev/alnair-harness
2. Clone your fork, commit your changes on a branch, and push it:

   ```bash
   git clone https://github.com/xFlawlessDev/alnair-harness.git
   git push origin HEAD:refs/heads/<branch>
   ```

3. Open the pull request from that branch against `master`.
