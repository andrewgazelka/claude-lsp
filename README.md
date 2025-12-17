# claude-lsp

Fast Rust type checking for Claude Code via persistent rust-analyzer LSP daemon.

## Install

```bash
claude plugin marketplace add andrewgazelka/claude-lsp
claude plugin install claude-lsp
```

## How It Works

After writing/editing `.rs` files, this plugin queries a persistent rust-analyzer daemon for diagnostics. The daemon is shared across all Claude Code sessions working on the same project.

```mermaid
flowchart TB
    subgraph Claude["Claude Code Sessions"]
        CC1[Session 1]
        CC2[Session 2]
    end

    subgraph Plugin["claude-lsp Plugin"]
        HOOK[PostToolUse Hook]
        CLIENT[LSP Client]
    end

    subgraph Daemon["Persistent Daemon #40;per project#41;"]
        TCP[TCP Proxy<br/>localhost:19200+]
        RA[rust-analyzer<br/>LSP Server]
    end

    subgraph State["State Files"]
        JSON["/tmp/claude-lsp/<br/>ra-{hash}.json"]
    end

    CC1 -->|Write .rs| HOOK
    CC2 -->|Edit .rs| HOOK
    HOOK -->|check running?| JSON
    HOOK -->|spawn if needed| TCP
    CLIENT -->|LSP JSON-RPC| TCP
    TCP -->|stdio| RA
    RA -->|diagnostics| TCP
    TCP -->|errors/warnings| CLIENT
    CLIENT -->|exit 2 if errors| HOOK

    classDef claude fill:#e1f5fe,stroke:#01579b
    classDef plugin fill:#e8f5e9,stroke:#1b5e20
    classDef daemon fill:#f3e5f5,stroke:#4a148c
    classDef state fill:#fff3e0,stroke:#e65100

    class CC1,CC2 claude
    class HOOK,CLIENT plugin
    class TCP,RA daemon
    class JSON state
```

**Flow:**
1. Claude edits a `.rs` file → PostToolUse hook triggers
2. Hook checks `/tmp/claude-lsp/ra-{hash}.json` for running daemon
3. If no daemon, spawns rust-analyzer with TCP proxy (~5s startup)
4. LSP client queries daemon for diagnostics (~50ms when warm)
5. Errors returned to Claude (exit code 2) → Claude fixes them

- **First edit**: Spawns rust-analyzer daemon (~5s startup)
- **Subsequent edits**: Fast diagnostics (~50ms once warm)
- **Cross-session**: Daemon persists between Claude Code sessions

## Behavior

- **Errors**: Shown to Claude (exit code 2) - Claude will attempt to fix
- **Warnings**: Logged but non-blocking
- **Fallback**: Uses `rustfmt --check` if rust-analyzer unavailable

## Requirements

- `bun` (for running the hook)
- `rust-analyzer` (via PATH or nix)
