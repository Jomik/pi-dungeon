/**
 * Security contract tests for src/network.ts
 *
 * Verifies that:
 *   - DNS always operates in "synthetic" mode — no tunneling path exists.
 *   - syntheticHostMapping is "per-host" (each resolved name gets its own IP).
 *   - buildTcpConfig() correctly maps the Obsidian bridge port.
 */

import { describe, expect, it } from "vitest";

import { buildTcpConfig, DNS_CONFIG } from "../src/network.ts";

// ---------------------------------------------------------------------------
// DNS_CONFIG – synthetic-only invariant
// ---------------------------------------------------------------------------

describe("DNS_CONFIG", () => {
  it('mode is "synthetic"', () => {
    expect(DNS_CONFIG.mode).toBe("synthetic");
  });

  it('syntheticHostMapping is "per-host"', () => {
    expect(DNS_CONFIG.syntheticHostMapping).toBe("per-host");
  });

  it('mode is never "passthrough" (no DNS tunneling)', () => {
    expect(DNS_CONFIG.mode).not.toBe("passthrough");
  });

  it('mode is never "open" (no unrestricted DNS)', () => {
    expect(DNS_CONFIG.mode).not.toBe("open");
  });

  it('mode is never "trusted" (synthetic, not forwarded)', () => {
    expect(DNS_CONFIG.mode).not.toBe("trusted");
  });
});

// ---------------------------------------------------------------------------
// buildTcpConfig – port forwarding configuration
// ---------------------------------------------------------------------------

describe("buildTcpConfig", () => {
  it("returns a hosts object with one entry per call", () => {
    const config = buildTcpConfig(12345);
    expect(Object.keys(config.hosts)).toHaveLength(1);
  });

  it("maps the bridge port to 127.0.0.1 on the same port", () => {
    const port = 12345;
    const config = buildTcpConfig(port);
    const upstream = config.hosts[`obsidian-bridge:${port}`];
    expect(upstream).toBe(`127.0.0.1:${port}`);
  });

  it("uses the supplied port in the guest-facing hostname key", () => {
    const port = 9876;
    const config = buildTcpConfig(port);
    expect(`obsidian-bridge:${port}` in config.hosts).toBe(true);
  });

  it("uses the supplied port in the upstream address value", () => {
    const port = 4242;
    const config = buildTcpConfig(port);
    expect(Object.values(config.hosts)[0]).toBe(`127.0.0.1:${port}`);
  });

  it("produces different configs for different ports", () => {
    const a = buildTcpConfig(1111);
    const b = buildTcpConfig(2222);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
