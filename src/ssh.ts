/**
 * SSH configuration and guest setup for the Dungeon VM.
 *
 * Security invariant: SSH egress is restricted to github.com only. The host
 * SSH proxy authenticates upstream connections using the host's SSH agent;
 * credentials never enter the VM. The SSH config written into the guest
 * disables host-key checking only because Dungeon's SSH proxy presents its
 * own synthetic key (not github.com's real key) — this is safe because the
 * proxy itself enforces the allowedHosts policy.
 *
 * Note: commit signing (ssh-keygen -Y sign) is not available inside the guest
 * because gondolin does not forward the SSH agent socket into the VM.
 */

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
 * 1. Creates $HOME/.ssh with safe permissions.
 * 2. Writes an SSH config that disables host-key checking for github.com
 *    (required because the Dungeon proxy presents a synthetic key).
 *
 * SSH config is written to /root/.ssh/ because OpenSSH resolves ~ from the
 * passwd entry (root), not $HOME.
 *
 * @throws If the guest exec command fails.
 */
export async function setupSshInGuest(vm: VM, _home: string): Promise<void> {
  const guestSshDir = "/root/.ssh";

  const result = await vm.exec([
    "/bin/sh",
    "-c",
    [
      `mkdir -p ${guestSshDir}`,
      `chmod 700 ${guestSshDir}`,
      `cat > ${guestSshDir}/config << 'SSHCFG'`,
      "Host github.com",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile /dev/null",
      "SSHCFG",
      `chmod 600 ${guestSshDir}/config`,
    ].join("\n"),
  ]);

  if (!result.ok) {
    throw new Error(`SSH setup failed (${result.exitCode}): ${result.stderr}`);
  }
}
