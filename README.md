# pi-dungeon

Dungeon sandbox extension for [pi](https://github.com/badlogic/pi-mono). Runs agent tools (`bash`, `read`, `write`, `edit`) inside a Dungeon micro-VM while pi itself stays on the host.

## Why

- **Credentials never enter the VM** — tokens are injected by the network proxy at request time
- **Skills persist instantly** — `~/.pi/agent/skills` and `agents` are live-mounted via VFS
- **No extension conflicts** — pi packages (web-access, imps, errands) run on host normally
- **Network confined** — synthetic DNS, allowlisted hosts only, SSH egress proxied through host agent

## Architecture

```
Host (trusted)                    Dungeon VM (sandboxed)
─────────────────                 ──────────────────────
pi process                        bash/read/write/edit execution
├─ LLM calls (Copilot)           ├─ $CWD (← project dir, same path as host)
├─ extensions                     ├─ /root/.pi/agent (← host ~/.pi/agent)
├─ credentials (keychain)         ├─ ~/.config/jj (← host ~/.config/jj, read-only)
└─ skill/agent reads              └─ tools: rg, fd, jj, gh, git, node
```

## Prerequisites

```bash
brew install qemu
```

## Setup

```bash
cd ~/projects/private/pi-dungeon
npm install

# Build the VM image (requires Docker)
npx gondolin build --config build-config.json --output ./image
```

## Credentials

Tokens are stored in the macOS Keychain under service `pi-dungeon`. Which accounts to look up and how to format them is entirely driven by `~/.pi/agent/dungeon.json` — no code changes needed to add a new secret.

```bash
# GitHub PAT (scoped for pi — separate from `gh auth`)
security add-generic-password -s "pi-dungeon" -a "github" -w "<token>" -U

# Atlassian: store base64-encoded credentials (guest adds Basic/Bearer prefix)
echo -n 'user@example.com:api-token' | base64 | \
  xargs -I{} security add-generic-password -s "pi-dungeon" -a "atlassian" -w '{}' -U
```

To rotate, re-run the `security add-generic-password` command with `-U` (update).

Use `setup-secret.sh` for an interactive prompt:

```bash
./setup-secret.sh          # pick from list
./setup-secret.sh GH_TOKEN # configure a specific secret
```

## Configuration

Config is loaded from up to three tiers and merged at startup:

- **Global**: `~/.pi/agent/dungeon.json` — shared across all projects
- **Ancestors**: `.pi/dungeon.json` files in directories between `$HOME` and the workspace
- **Per-project**: `<workspace>/.pi/dungeon.json` — project-specific overrides

All tiers use the same schema:

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
  },
  "env": {
    "NODE_ENV": "development",
    "MY_VAR": "value"
  },
  "hiddenPaths": [".env", ".env.*"],
  "cachePaths": ["~/.cache/uv", "~/.cache/npm", "~/.cargo/registry"]
}
```

### Merge behavior

- `allowedHosts` — concatenated (both lists apply)
- `secrets` — merged; per-project wins on key conflict
- `mounts` — merged; per-project wins on key conflict
- `env` — merged; per-project wins on key conflict
- `hiddenPaths` — concatenated
- `cachePaths` — concatenated

### Configuration Resolution

Configs are loaded and merged in this order (later wins on key conflict for objects; arrays are concatenated):

1. **Global** — `~/.pi/agent/dungeon.json`
2. **Ancestors** — `.pi/dungeon.json` in each directory between `$HOME` and the workspace (outermost first)
3. **Per-project** — `<workspace>/.pi/dungeon.json`

For example, with workspace `~/projects/work/my-app`:

| Priority | Path |
|----------|------|
| 1 (lowest) | `~/.pi/agent/dungeon.json` |
| 2 | `~/projects/.pi/dungeon.json` |
| 3 | `~/projects/work/.pi/dungeon.json` |
| 4 (highest) | `~/projects/work/my-app/.pi/dungeon.json` |

Symlinked directories and symlinked config files are skipped for security.

Use `/dungeon` (no subcommand) to see which config files are loaded.

### Environment Variables

Set shell environment variables inside the dungeon VM:

```json
{
  "env": {
    "NODE_ENV": "development",
    "MY_VAR": "value"
  }
}
```

Global and per-project are merged; per-project wins on key conflict.

### Fields

- `allowedHosts` — full list of hosts the VM may reach over HTTPS. There is no built-in allowlist; every allowed host must appear here (in global or per-project config).
- `secrets.<NAME>.keychain` — keychain account name (looked up under service `pi-dungeon`).
- `secrets.<NAME>.hosts` — hosts that receive this secret in their `Authorization` header.
- `env` — key/value map of environment variables injected into every bash session inside the VM. Global and ancestor values are merged with per-project; per-project wins on key conflict.
- `mounts` — additional host directories to mount into the VM.
  - Keys are **absolute guest paths** where the directory appears inside the VM.
  - `path` — host path; supports `~` expansion.
  - `mode` — `"ro"` (read-only, default) or `"rw"` (read-write).
- `hiddenPaths` — workspace paths completely hidden from the guest (ENOENT). Useful for secret files like `.env`. Paths resolve the same way as `cachePaths`: `~` expands to home, relative paths (e.g. `.env`, `./dist`) resolve against the project directory, and absolute paths outside the workspace are silently ignored.
- `cachePaths` — paths backed by persistent host-side cache at `~/.cache/pi-dungeon/<hash>` that survives VM rebuilds.
  - Resolved to absolute: `~` expands to home, relative paths resolve against the project directory.
  - Hash is derived from the absolute path — same absolute path = same cache (naturally shared across all sandboxes), different absolute path = different cache (naturally per-project).
  - Paths inside the project directory are overlaid on the workspace backend; all other paths are mounted as separate read-write entries.
  - Supports glob patterns like `**/node_modules` for workspace-scoped matching (hash uses `localCwd:pattern` for per-project isolation).
  - Merged by concatenation from global + ancestor + project configs.

### Resources

Control how much memory and CPU the dungeon VM gets:

```json
{
  "resources": {
    "memory": "2G",
    "cpus": 4
  }
}
```

- `memory` — VM memory in qemu syntax (`"512M"`, `"1G"`, `"2G"`, …). Default: `"1G"`.
- `cpus` — number of virtual CPUs. Default: `2`.

Per-project `resources` overrides global field-by-field (e.g. a per-project `memory` overrides only memory, leaving global `cpus` in effect).

`hiddenPaths` and `cachePaths` use the same path resolution: `~` expands to home, relative paths resolve against the project directory, and glob patterns like `**/node_modules` are workspace-scoped. For `cachePaths`, a resolved path outside the workspace creates a separate external mount; for `hiddenPaths`, it is silently ignored.

`hiddenPaths` pattern forms:

| Pattern | Example | Matches |
|---------|---------|--------|
| `path` or `./path` | `.env`, `./dist` | Relative to workspace root |
| `~/.secret` | `~/.netrc` | Expands home; ignored if outside workspace |
| `/absolute` | `/tmp/debug` | Absolute host path; ignored if outside workspace |
| `**/name` | `**/bin` | Segment at any depth (`/bin`, `/src/App/bin`, …) |
| `./path.*` | `./.env.*` | Wildcard in last segment (`.env.local`, `.env.production`, …) |

The keychain value is injected as-is via placeholder replacement. Store raw tokens or raw base64 — the guest constructs the full header (e.g. `Authorization: Basic $ATLASSIAN_TOKEN`).

If the keychain lookup fails for a secret, that secret is silently skipped (safe default).

The `.pi` directory is **shadowed** in the sandbox — the VM cannot see or modify `.pi/dungeon.json` or anything else under `.pi/`.

**Example per-project uses:**

- Mount a shared-library monorepo read-only so the agent can browse and link against it.
- Mount a sibling repo read-write when the task requires coordinated changes across two projects.
- Add project-specific `allowedHosts` (e.g. an internal registry) without touching the global config.

## Usage

```bash
pi -e ~/projects/private/pi-dungeon
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
| `$CWD` | `$CWD` | read-write (ShadowProvider; `/.pi/dungeon.json` always shadowed; `hiddenPaths`/`cachePaths` configurable) |
| `/root/.pi/agent` | `~/.pi/agent` | read-write (ShadowProvider; `/auth.json` and `/sessions` shadowed) |
| `~/.config/jj` | `~/.config/jj` | read-only |
| `/tmp/pi-github-repos` | `/tmp/pi-github-repos` | read-only |

Additional mounts are configured via `mounts` in global or per-project config.

## Known limitations

- **Commit signing unavailable** — `ssh-keygen -Y sign` requires a local SSH agent socket, but gondolin does not forward the host's SSH agent into the VM. Commits created inside the dungeon will be unsigned. Push already-signed commits from the host if signatures are required.
- **SSH agent must have keys loaded** — The SSH proxy authenticates upstream connections using the host's SSH agent. If no keys are loaded (`ssh-add -l` returns empty), git push over SSH will fail with "All configured authentication methods failed". Fix with `ssh-add --apple-use-keychain <key>` on the host before starting pi.
- **`git safe.directory`** — The guest runs as root but VFS files report the host user's uid. The dungeon automatically sets `safe.directory = *` in the system-wide git config (`/etc/gitconfig`) at boot to suppress git's "dubious ownership" warnings.

## Rebuilding the image

Edit `build-config.json` to add packages, then:

```bash
npx gondolin build --config build-config.json --output ./image
```
