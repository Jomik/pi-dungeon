/**
 * Security contract tests for src/secrets.ts
 *
 * Verifies that:
 *   - KEYCHAIN_SERVICE is the expected string literal.
 *   - resolveHttpHooks produces a valid gondolin CreateHttpHooksResult.
 *   - Secrets are correctly structured when passed to createHttpHooks.
 *   - Missing keychain entries are silently skipped (never cause a throw).
 *
 * keychainGet() calls the macOS `security` CLI, so we mock node:child_process
 * to control its return value without touching the real Keychain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock execFileSync before any module under test is imported.
// vi.mock is hoisted by Vitest so this runs before imports below.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

import { KEYCHAIN_SERVICE, resolveHttpHooks } from "../src/secrets.ts";

const mockExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// KEYCHAIN_SERVICE constant
// ---------------------------------------------------------------------------

describe("KEYCHAIN_SERVICE", () => {
  it('is "pi-dungeon"', () => {
    expect(KEYCHAIN_SERVICE).toBe("pi-dungeon");
  });
});

// ---------------------------------------------------------------------------
// resolveHttpHooks – structure validation
// ---------------------------------------------------------------------------

describe("resolveHttpHooks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns a valid result with empty config (no secrets, no allowedHosts)", () => {
    const result = resolveHttpHooks({});
    expect(result).toHaveProperty("httpHooks");
    expect(result).toHaveProperty("env");
    expect(result).toHaveProperty("allowedHosts");
    expect(result).toHaveProperty("secretManager");
  });

  it("returns an empty env when config has no secrets", () => {
    const result = resolveHttpHooks({});
    expect(result.env).toEqual({});
  });

  it("returns an empty allowedHosts array when config has no allowedHosts", () => {
    const result = resolveHttpHooks({});
    expect(result.allowedHosts).toEqual([]);
  });

  it("passes allowedHosts from config to the result", () => {
    const result = resolveHttpHooks({ allowedHosts: ["api.example.com"] });
    expect(result.allowedHosts).toContain("api.example.com");
  });

  it("skips secrets whose keychain lookup returns nothing", () => {
    // execFileSync throws (simulating a missing keychain entry).
    mockExecFileSync.mockImplementation(() => {
      throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found");
    });

    const result = resolveHttpHooks({
      secrets: {
        MY_TOKEN: { keychain: "my-token", hosts: ["api.example.com"] },
      },
    });

    // Secret was not resolved → env should remain empty.
    expect(result.env).toEqual({});
  });

  it("includes a placeholder env var for each resolved secret", () => {
    // execFileSync succeeds and returns the secret value.
    mockExecFileSync.mockReturnValue("super-secret-value\n");

    const result = resolveHttpHooks({
      allowedHosts: ["api.example.com"],
      secrets: {
        MY_TOKEN: { keychain: "my-token", hosts: ["api.example.com"] },
      },
    });

    // gondolin replaces the real value with a placeholder in env;
    // the key is the secret name and the value is the guest-visible placeholder.
    expect(result.env).toHaveProperty("MY_TOKEN");
    // The placeholder must NOT be the raw secret value.
    expect(result.env.MY_TOKEN).not.toBe("super-secret-value");
  });

  it("handles multiple secrets, resolving all that are present", () => {
    mockExecFileSync.mockReturnValue("secret\n");

    const result = resolveHttpHooks({
      allowedHosts: ["a.com", "b.com"],
      secrets: {
        TOKEN_A: { keychain: "token-a", hosts: ["a.com"] },
        TOKEN_B: { keychain: "token-b", hosts: ["b.com"] },
      },
    });

    expect(result.env).toHaveProperty("TOKEN_A");
    expect(result.env).toHaveProperty("TOKEN_B");
  });

  it("handles partial secret resolution (some missing, some present)", () => {
    mockExecFileSync
      .mockImplementationOnce(() => "found-value\n") // TOKEN_A resolved
      .mockImplementationOnce(() => {
        throw new Error("not found");
      }); // TOKEN_B missing

    const result = resolveHttpHooks({
      allowedHosts: ["a.com", "b.com"],
      secrets: {
        TOKEN_A: { keychain: "token-a", hosts: ["a.com"] },
        TOKEN_B: { keychain: "token-b", hosts: ["b.com"] },
      },
    });

    expect(result.env).toHaveProperty("TOKEN_A");
    expect(result.env).not.toHaveProperty("TOKEN_B");
  });
});
