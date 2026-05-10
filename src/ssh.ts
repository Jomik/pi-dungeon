/**
 * SSH configuration and guest setup for the Dungeon VM.
 *
 * Security invariant: SSH egress is restricted to github.com only. The host
 * SSH agent is forwarded into the VM so credentials never need to be copied
 * into the sandbox. The SSH config written into the guest disables host-key
 * checking only because Dungeon's SSH proxy presents its own synthetic key
 * (not github.com's real key) — this is safe because the proxy itself
 * enforces the allowedHosts policy.
 */

import fs from "node:fs";
import path from "node:path";

import type { SshOptions, VM } from "@earendil-works/gondolin";

/**
 * The only SSH egress target permitted from the VM.
 * Must not be extended without a deliberate security review of the proxy
 * exec policy.
 */
export const SSH_ALLOWED_HOSTS: string[] = ["github.com"];

/**
 * Build the SSH proxy configuration for `VM.create`.
 * This configures the host-side proxy that gates outbound SSH from the guest.
 *
 * @param home Host home directory (os.homedir()).
 */
export function buildSshProxyConfig(home: string): SshOptions {
  return {
    allowedHosts: SSH_ALLOWED_HOSTS,
    agent: process.env.SSH_AUTH_SOCK,
    knownHostsFile: path.join(home, ".ssh/known_hosts"),
  };
}

/**
 * Run one-time SSH initialisation inside a freshly created VM guest.
 *
 * Performs:
 * 1. Creates /root/.ssh with safe permissions.
 * 2. Writes an SSH config that disables host-key checking for github.com
 *    (required because the Dungeon proxy presents a synthetic key).
 * 3. Injects the host's ed25519 signing pubkey so jj/git can sign commits
 *    via the forwarded agent.
 * 4. Exports JJ_CONFIG pointing at the mounted host jj config directory.
 *
 * @throws If the guest exec command fails.
 */
export async function setupSshInGuest(vm: VM, home: string): Promise<void> {
  let pubkeyLines: string[] = [];
  try {
    const pubkey = fs.readFileSync(path.join(home, ".ssh/id_ed25519_private.pub"), "utf8").trim();
    // Inject SSH signing pubkey so jj/git can sign commits via the forwarded agent.
    pubkeyLines = [`cat > /root/.ssh/id_ed25519_private.pub << 'SSHPUB'`, pubkey, "SSHPUB"];
  } catch {
    // pubkey file not found — skip injection, commit signing won't be available.
  }

  const result = await vm.exec([
    "/bin/sh",
    "-c",
    [
      "mkdir -p /root/.ssh",
      "chmod 700 /root/.ssh",
      "cat > /root/.ssh/config << 'SSHCFG'",
      "Host github.com",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile /dev/null",
      "SSHCFG",
      "chmod 600 /root/.ssh/config",
      ...pubkeyLines,
      // Point jj at the mounted host config directory.
      "echo 'export JJ_CONFIG=/root/.config/jj' > /etc/profile.d/jj.sh",
    ].join("\n"),
  ]);

  if (!result.ok) {
    throw new Error(`SSH setup failed (${result.exitCode}): ${result.stderr}`);
  }
}
