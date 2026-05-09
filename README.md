# pi-gondolin

Gondolin sandbox extension for [pi](https://github.com/badlogic/pi-mono). Runs agent tools (`bash`, `read`, `write`, `edit`) inside a Gondolin micro-VM while pi itself stays on the host.

## Why

- **Credentials never enter the VM** — tokens are injected by the network proxy at request time
- **Skills persist instantly** — `~/.pi/agent/skills` and `agents` are live-mounted via VFS
- **No extension conflicts** — pi packages (web-access, imps, errands) run on host normally
- **Network confined** — synthetic DNS, allowlisted hosts only, SSH egress proxied through host agent

## Architecture

```
Host (trusted)                    Gondolin VM (sandboxed)
─────────────────                 ──────────────────────
pi process                        bash/read/write/edit execution
├─ LLM calls (Copilot)           ├─ $CWD (← project dir, same path as host)
├─ extensions                     ├─ /root/.pi/agent (← host ~/.pi/agent)
├─ credentials (keychain)         ├─ /root/.config/jj (← host ~/.config/jj, read-only)
└─ skill/agent reads              └─ tools: rg, fd, jj, gh, git, node
```

## Prerequisites

```bash
brew install qemu
```

## Setup

```bash
cd ~/.pi/pi-gondolin
npm install

# Build the VM image (requires Docker)
npx gondolin build --config build-config.json --output ./image
```

## Credentials

Tokens are stored in the macOS Keychain under service `pi-gondolin`. Which accounts to look up and how to format them is entirely driven by `~/.pi/agent/gondolin.json` — no code changes needed to add a new secret.

```bash
# GitHub PAT (scoped for pi — separate from `gh auth`)
security add-generic-password -s "pi-gondolin" -a "github" -w "<token>" -U

# Atlassian: store base64-encoded credentials (guest adds Basic/Bearer prefix)
echo -n 'user@example.com:api-token' | base64 | \
  xargs -I{} security add-generic-password -s "pi-gondolin" -a "atlassian" -w '{}' -U
```

To rotate, re-run the `security add-generic-password` command with `-U` (update).

Use `setup-secret.sh` for an interactive prompt:

```bash
./setup-secret.sh          # pick from list
./setup-secret.sh GH_TOKEN # configure a specific secret
```

## Configuration

Config lives at two locations and is merged at startup:

- **Global**: `~/.pi/agent/gondolin.json` — shared across all projects
- **Per-project**: `<workspace>/.pi/gondolin.json` — project-specific overrides

Both files use the same schema:

```json
{
  "allowedHosts": [
    "example.atlassian.net",
    "internal.company.io"
  ],
  "secrets": {
    "GH_TOKEN": {
      "keychain": "github",
      "hosts": ["api.github.com", "github.com"]
    },
    "ATLASSIAN_TOKEN": {
      "keychain": "atlassian",
      "hosts": ["example.atlassian.net"]
    }
  },
  "mounts": {
    "/shared-libs": { "path": "~/code/shared-libs", "mode": "ro" },
    "/other-repo":  { "path": "~/code/other-repo",  "mode": "rw" }
  }
}
```

### Merge behavior

- `allowedHosts` — concatenated (both lists apply)
- `secrets` — merged; per-project wins on key conflict
- `mounts` — merged; per-project wins on key conflict

### Fields

- `allowedHosts` — full list of hosts the VM may reach over HTTPS. There is no built-in allowlist; every allowed host must appear here (in global or per-project config).
- `secrets.<NAME>.keychain` — keychain account name (looked up under service `pi-gondolin`).
- `secrets.<NAME>.hosts` — hosts that receive this secret in their `Authorization` header.
- `mounts` — additional host directories to mount into the VM.
  - Keys are **absolute guest paths** where the directory appears inside the VM.
  - `path` — host path; supports `~` expansion.
  - `mode` — `"ro"` (read-only, default) or `"rw"` (read-write).

The keychain value is injected as-is via placeholder replacement. Store raw tokens or raw base64 — the guest constructs the full header (e.g. `Authorization: Basic $ATLASSIAN_TOKEN`).

If the keychain lookup fails for a secret, that secret is silently skipped (safe default).

The `.pi` directory is **shadowed** in the sandbox — the VM cannot see or modify `.pi/gondolin.json` or anything else under `.pi/`.

**Example per-project uses:**

- Mount a shared-library monorepo read-only so the agent can browse and link against it.
- Mount a sibling repo read-write when the task requires coordinated changes across two projects.
- Add project-specific `allowedHosts` (e.g. an internal registry) without touching the global config.

## Usage

```bash
pi -e ~/.pi/pi-gondolin
```

## What's sandboxed

| Operation | Where it runs |
|-----------|---------------|
| `bash` commands | VM |
| `read` / `write` / `edit` (workspace) | VM (VFS → host filesystem) |
| `read` / `write` / `edit` (skills/agents) | VM (VFS → host filesystem) |
| LLM API calls | Host |
| Web search, imps, errands | Host |
| `!` user commands | VM |

## Network policy

All allowed HTTPS hosts are listed under `allowedHosts` in the global and/or per-project config. There is no built-in allowlist — the config is the single source of truth. SSH egress is separately controlled (`github.com:22`, proxied through the host agent).

All other network access is denied. DNS is synthetic (no DNS tunneling).

## VFS mounts

| Guest path | Host path | Mode |
|------------|-----------|------|
| `$CWD` | `$CWD` | read-write (ShadowProvider; `/node_modules` and `/.pi/gondolin.json` shadowed) |
| `/root/.pi/agent` | `~/.pi/agent` | read-write (ShadowProvider; `/auth.json` and `/sessions` shadowed) |
| `/root/.config/jj` | `~/.config/jj` | read-only |
| `/tmp/pi-github-repos` | `/tmp/pi-github-repos` | read-only |

Additional mounts are configured via `mounts` in global or per-project config.

## Rebuilding the image

Edit `build-config.json` to add packages, then:

```bash
npx gondolin build --config build-config.json --output ./image
```
