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
├─ LLM calls (Copilot)           ├─ /workspace (← project dir)
├─ extensions                     ├─ /home/agent/.pi/agent/skills (← host)
├─ credentials (keychain)         ├─ /home/agent/.pi/agent/agents (← host)
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

Tokens are stored in the macOS Keychain under service `pi-gondolin`:

```bash
# GitHub PAT (scoped for pi — separate from `gh auth`)
security add-generic-password -s "pi-gondolin" -a "github" -w "<token>" -U

# Atlassian API token
security add-generic-password -s "pi-gondolin" -a "atlassian" -w "<token>" -U
```

Stored as **raw tokens**. The extension handles formatting:

| Account | Stored | Injected as |
|---------|--------|-------------|
| `github` | Raw PAT (`ghp_...`) | As-is in `Authorization` header |
| `atlassian` | Raw API token | `Basic <base64(email:token)>` |

To rotate, re-run the `security add-generic-password` command with `-U` (update).

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

| Destination | Access |
|-------------|--------|
| `api.github.com`, `github.com`, `*.github.com` | HTTPS (GH_TOKEN injected) |
| `objects.githubusercontent.com`, `github-releases.githubusercontent.com` | HTTPS (release downloads) |
| `github.com:22` | SSH egress (host agent forwarded) |
| `registry.npmjs.org`, `*.npmjs.org` | HTTPS |
| `legogroup.atlassian.net` | HTTPS (ATLASSIAN_TOKEN injected as Basic auth) |
| `baseplate.legogroup.io` | HTTPS |

All other network access is denied. DNS is synthetic (no DNS tunneling).

## VFS mounts

| Guest path | Host path | Mode |
|------------|-----------|------|
| `/workspace` | `$CWD` | read-write |
| `/home/agent/.pi/agent/skills` | `~/.pi/agent/skills` | read-write |
| `/home/agent/.pi/agent/agents` | `~/.pi/agent/agents` | read-write |

## Rebuilding the image

Edit `build-config.json` to add packages, then:

```bash
npx gondolin build --config build-config.json --output ./image
```
