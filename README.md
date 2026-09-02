# Steward

Local working tree. Clone-later-at-office is future. This folder is the app.

Steward routes a prompt to ONE owner: Cursor (repo/files/PRs), Claude (hard reasoning / long coding), ChatGPT (drafts/summaries). Local heuristic. Fan-out off unless the UI toggle is on AND there is a finite cost estimate. Send is dead without a finite estimate. Claude/ChatGPT get a short brief, never a repo dump. Secrets in the OS keychain. SQLite run history.

Not Electron. Tauri 2 plus Rust.

## Tests (this is the bar)

cd /workspace/steward/steward-core && cargo test

From the workspace root (default member is steward-core):

cd /workspace/steward && cargo test

P0s that fail the build:
1. classify never increments mock call_count
2. send with blocked=true does not call a backend
3. missing / non-finite estCostUsd: send dead, 0 calls
4. fanOutEnabled=false => successful send is exactly one mock call
5. 429 then retry does not bump call_count a second time (degrade to local)
6. chatgpt/cursor/claude with estCostUsd==0 is blocked missing_estimate
7. fanOutEnabled=false but fanOut object: send dead (router lie)
8. claude/chatgpt payload containing a unix or windows absolute repo path fails (no call)
9. local + cacheHit is the only legal zero and does not tick the mock

If you cd /workspace/steward/src-tauri && cargo test, that compiles the Tauri 2 shell and needs WebKit/GTK. Use steward-core when GUI deps are missing.

## Run the desktop app

If tauri-cli is available, run cargo tauri dev from src-tauri. UI is vanilla HTML/CSS/JS in ui/. Open ui/index.html in a browser; classify still runs locally.

## Layout

/workspace/steward/
  README.md
  Cargo.toml                 workspace (default: steward-core)
  ui/                        vanilla composer
  steward-core/              classify, send gate, mocks, sqlite, history
  src-tauri/                 Tauri 2 shell wrapping steward-core

## Pricing used for estimates

- chatgpt: 0.15 USD / 1M in, 0.60 USD / 1M out
- claude: 3 USD / 1M in, 15 USD / 1M out
- cursor: 0.002 USD per estimated 1k tokens combined (placeholder, still greater than 0)
- local: 0 only on cache hit

Token estimate: prompt chars/4 plus a small out estimate.

Secrets live in the OS keychain via the keyring crate. No plaintext fallback file.

## Tests on this Linux box

Node here is v20, so type stripping is unavailable. run-tests.sh bundles TypeScript with bun, then runs node:test. Result: 19 passed, 0 failed (includes the eight required contracts).

A Rust crate at steward-core also has cargo tests (11 passed). Tauri 2 lives in src-tauri and talks to that crate. The TypeScript core in src/core is the portable node:test implementation.
