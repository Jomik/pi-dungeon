/**
 * Keychain access and secret injection for the Dungeon VM.
 *
 * Security invariant: secrets are resolved on the host and injected via the
 * gondolin HTTP proxy hooks. They never appear in VM exec args or environment
 * variables visible to agent code running inside the sandbox.
 */

import { execFileSync } from "node:child_process";

import { type CreateHttpHooksResult, createHttpHooks } from "@earendil-works/gondolin";

import type { DungeonConfig } from "./types.ts";

/** macOS Keychain service name used for all pi-dungeon secrets. */
export const KEYCHAIN_SERVICE = "pi-dungeon";

/**
 * Retrieve a secret from the macOS Keychain.
 *
 * @param account Keychain account name (matches the `-a` flag of `security`).
 * @returns The secret value, or `undefined` if not found or on error.
 */
export function keychainGet(account: string): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve secrets from the merged DungeonConfig and build gondolin HTTP hooks.
 *
 * Each secret entry is read from the macOS Keychain. Missing secrets are
 * silently skipped (the host is the authority on what is available).
 *
 * @returns `{ httpHooks, env }` ready to pass to `VM.create`.
 */
export function resolveHttpHooks(config: DungeonConfig): CreateHttpHooksResult {
  const resolvedSecrets: Record<string, { hosts: string[]; value: string }> = {};

  if (config.secrets) {
    for (const [name, cfg] of Object.entries(config.secrets)) {
      const value = keychainGet(cfg.keychain);
      if (!value) continue;
      resolvedSecrets[name] = { hosts: cfg.hosts, value };
    }
  }

  return createHttpHooks({
    allowedHosts: config.allowedHosts ?? [],
    secrets: resolvedSecrets,
  });
}
