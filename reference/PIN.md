# Reference pin

The files under `reference/codex-rs/` are verbatim, unmodified copies from:

- Repository: https://github.com/openai/codex
- Tag: `rust-v0.142.5`
- Commit: `26de83050b20f7e0ee211b9739e52ae00ce8032a`
- License: Apache-2.0 (see `reference/LICENSE`, `reference/NOTICE`)
- Vendored: 2026-07-06

They are the source of truth the TypeScript port in `core/` is diffed against.
Relative paths are preserved, so `reference/codex-rs/core/src/compact.rs`
corresponds to `codex-rs/core/src/compact.rs` at that commit.

The port targets the same behavior shipped in the `@openai/codex@0.142.5` npm
binary; the compaction prompts and endpoint strings in that binary were
verified byte-identical to this tag before vendoring.
