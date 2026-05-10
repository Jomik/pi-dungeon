/**
 * Security contract tests for src/ssh.ts
 *
 * Verifies that:
 *   - SSH egress is restricted to exactly ["github.com"] — no additional hosts.
 *   - buildSshProxyConfig() produces a config that reflects this allowlist.
 *   - The SSH agent socket path and known_hosts file are wired correctly.
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildSshProxyConfig, SSH_ALLOWED_HOSTS } from "../src/ssh.ts";

// ---------------------------------------------------------------------------
// SSH_ALLOWED_HOSTS constant
// ---------------------------------------------------------------------------

describe("SSH_ALLOWED_HOSTS", () => {
  it("contains github.com", () => {
    expect(SSH_ALLOWED_HOSTS).toContain("github.com");
  });

  it("contains exactly one entry (no additional hosts)", () => {
    expect(SSH_ALLOWED_HOSTS).toHaveLength(1);
  });

  it("does not contain any wildcard patterns", () => {
    for (const host of SSH_ALLOWED_HOSTS) {
      expect(host).not.toMatch(/[*?]/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSshProxyConfig – structural tests
// ---------------------------------------------------------------------------

describe("buildSshProxyConfig", () => {
  const home = os.homedir();

  it("returns allowedHosts matching SSH_ALLOWED_HOSTS", () => {
    const config = buildSshProxyConfig(home);
    expect(config.allowedHosts).toEqual(SSH_ALLOWED_HOSTS);
  });

  it("allowedHosts contains github.com", () => {
    const config = buildSshProxyConfig(home);
    expect(config.allowedHosts).toContain("github.com");
  });

  it("allowedHosts has exactly one entry", () => {
    const config = buildSshProxyConfig(home);
    expect(config.allowedHosts).toHaveLength(1);
  });

  it("includes the SSH agent socket path", () => {
    const config = buildSshProxyConfig(home);
    // agent is set from process.env.SSH_AUTH_SOCK — may be undefined in CI,
    // but the field itself must be present in the returned object.
    expect("agent" in config).toBe(true);
  });

  it("includes a knownHostsFile path", () => {
    const config = buildSshProxyConfig(home);
    expect(config.knownHostsFile).toBeDefined();
  });

  it("knownHostsFile is inside the supplied home directory", () => {
    const config = buildSshProxyConfig(home);
    expect((config.knownHostsFile as string).startsWith(home)).toBe(true);
  });

  it("knownHostsFile resolves to the .ssh/known_hosts file", () => {
    const config = buildSshProxyConfig(home);
    expect(config.knownHostsFile).toBe(path.join(home, ".ssh/known_hosts"));
  });

  it("produces the same result for the same home path (pure function)", () => {
    const a = buildSshProxyConfig(home);
    const b = buildSshProxyConfig(home);
    expect(a.allowedHosts).toEqual(b.allowedHosts);
    expect(a.knownHostsFile).toBe(b.knownHostsFile);
  });
});
