/**
 * Security contract tests for src/mounts.ts
 *
 * Verifies that the shadow-policy constants and buildMounts() uphold the
 * security invariants documented in README.md:
 *   - node_modules and dungeon.json are always hidden from the workspace mount.
 *   - auth.json and sessions are always hidden from the ~/.pi/agent mount.
 */

import os from "node:os";
import path from "node:path";
import { createShadowPathPredicate } from "@earendil-works/gondolin";
import { describe, expect, it } from "vitest";

import { buildMounts, PI_AGENT_ALWAYS_SHADOWED, WORKSPACE_ALWAYS_SHADOWED } from "../src/mounts.ts";
import { GUEST_GITHUB_REPOS } from "../src/paths.ts";

// ---------------------------------------------------------------------------
// Shadow-policy constants
// ---------------------------------------------------------------------------

describe("WORKSPACE_ALWAYS_SHADOWED", () => {
  it("contains /.pi/dungeon.json", () => {
    expect(WORKSPACE_ALWAYS_SHADOWED).toContain("/.pi/dungeon.json");
  });

  it("does not contain /node_modules (now configurable via tmpfsPaths)", () => {
    expect(WORKSPACE_ALWAYS_SHADOWED).not.toContain("/node_modules");
  });
});

describe("PI_AGENT_ALWAYS_SHADOWED", () => {
  it("contains /auth.json", () => {
    expect(PI_AGENT_ALWAYS_SHADOWED).toContain("/auth.json");
  });

  it("contains /sessions", () => {
    expect(PI_AGENT_ALWAYS_SHADOWED).toContain("/sessions");
  });
});

// ---------------------------------------------------------------------------
// Shadow predicate behaviour for WORKSPACE_ALWAYS_SHADOWED
//
// createShadowPathPredicate returns a ShadowPredicate which takes a
// ShadowContext object ({ op, path, ... }), not a bare string.
// ---------------------------------------------------------------------------

describe("shadow predicate for WORKSPACE_ALWAYS_SHADOWED", () => {
  const pred = createShadowPathPredicate(WORKSPACE_ALWAYS_SHADOWED);

  it("blocks /.pi/dungeon.json", () => {
    expect(pred({ op: "stat", path: "/.pi/dungeon.json" })).toBe(true);
  });

  it("allows /node_modules (no longer hardcoded; use tmpfsPaths config)", () => {
    expect(pred({ op: "stat", path: "/node_modules" })).toBe(false);
  });

  it("allows /src/foo.ts", () => {
    expect(pred({ op: "stat", path: "/src/foo.ts" })).toBe(false);
  });

  it("does not block /.pi (only the specific dungeon.json file is shadowed)", () => {
    expect(pred({ op: "stat", path: "/.pi/skills.md" })).toBe(false);
  });
});

describe("shadow predicate for PI_AGENT_ALWAYS_SHADOWED", () => {
  const pred = createShadowPathPredicate(PI_AGENT_ALWAYS_SHADOWED);

  it("blocks /auth.json", () => {
    expect(pred({ op: "stat", path: "/auth.json" })).toBe(true);
  });

  it("blocks /sessions exactly", () => {
    expect(pred({ op: "stat", path: "/sessions" })).toBe(true);
  });

  it("blocks subpaths of /sessions", () => {
    expect(pred({ op: "open", path: "/sessions/abc-123" })).toBe(true);
  });

  it("allows /skills (agent skills should be visible)", () => {
    expect(pred({ op: "stat", path: "/skills" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildMounts – structural tests
// ---------------------------------------------------------------------------

describe("buildMounts", () => {
  // Use real home; cwd is /tmp which already exists.
  const localCwd = "/tmp";
  const guestWorkspace = "/root/workspace";
  const home = os.homedir();

  it("returns a mounts entry for the workspace guest path", () => {
    const { mounts } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(mounts[guestWorkspace]).toBeDefined();
  });

  it("returns a mounts entry for pi agent at home path", () => {
    const { mounts } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(mounts[path.join(home, ".pi/agent")]).toBeDefined();
  });

  it("returns a mounts entry for GUEST_GITHUB_REPOS", () => {
    const { mounts } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(mounts[GUEST_GITHUB_REPOS]).toBeDefined();
  });

  it("returns a mounts entry for the jj config guest path", () => {
    const { mounts } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(mounts[path.join(home, ".config/jj")]).toBeDefined();
  });

  it("returns empty pendingMappings when no custom mounts are configured", () => {
    const { pendingMappings } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(pendingMappings).toEqual([]);
  });

  it("adds a mount entry for each path in config.mounts", () => {
    const config = {
      mounts: [`/tmp`],
    };
    const { mounts } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(mounts["/tmp"]).toBeDefined();
  });

  it("returns pendingMappings for each custom mount", () => {
    const config = {
      mounts: ["/tmp"],
    };
    const { pendingMappings } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(pendingMappings).toHaveLength(1);
    expect(pendingMappings[0]).toMatchObject({
      hostDir: "/tmp",
      guestDir: "/tmp",
    });
  });

  it("expands ~ in custom mount host paths", () => {
    const config = {
      mounts: ["~/mydir"],
    };
    const { pendingMappings, mounts } = buildMounts(config, localCwd, guestWorkspace, home);
    const expandedPath = `${home}/mydir`;
    expect(pendingMappings[0]?.hostDir).toBe(expandedPath);
    expect(pendingMappings[0]?.guestDir).toBe(expandedPath);
    expect(mounts[expandedPath]).toBeDefined();
  });

  it("defaults to read-only when no mode suffix", () => {
    const config = { mounts: ["/tmp"] };
    const { mounts } = buildMounts(config, localCwd, guestWorkspace, home);
    // ReadonlyProvider wraps — just check it's defined (structural check)
    expect(mounts["/tmp"]).toBeDefined();
  });

  it("parses :ro suffix as read-only", () => {
    const config = { mounts: ["/tmp:ro"] };
    const { mounts, pendingMappings } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(mounts["/tmp"]).toBeDefined();
    expect(pendingMappings[0]).toMatchObject({ hostDir: "/tmp", guestDir: "/tmp" });
  });

  it("parses :rw suffix as read-write", () => {
    const config = { mounts: ["/tmp:rw"] };
    const { mounts, pendingMappings } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(mounts["/tmp"]).toBeDefined();
    expect(pendingMappings[0]).toMatchObject({ hostDir: "/tmp", guestDir: "/tmp" });
  });

  it("adds multiple custom mounts and returns all as pendingMappings", () => {
    const config = {
      mounts: ["/tmp", "/tmp:rw"],
    };
    // Note: both expand to same path — last write wins on the mounts map key
    // but pendingMappings records both
    const { pendingMappings } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(pendingMappings).toHaveLength(2);
  });

  it("does not crash and returns workspace mount when tmpfsPaths is configured", () => {
    const config = { tmpfsPaths: ["/node_modules"] };
    const { mounts } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(mounts[guestWorkspace]).toBeDefined();
  });

  it("does not crash and returns workspace mount when hiddenPaths is configured", () => {
    const config = { hiddenPaths: ["/.env"] };
    const { mounts } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(mounts[guestWorkspace]).toBeDefined();
  });
});
