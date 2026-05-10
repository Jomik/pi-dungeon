/**
 * Security contract tests for src/mounts.ts
 *
 * Verifies that the shadow-policy constants and buildMounts() uphold the
 * security invariants documented in README.md:
 *   - node_modules and dungeon.json are always hidden from the workspace mount.
 *   - auth.json and sessions are always hidden from the ~/.pi/agent mount.
 */

import os from "node:os";
import { createShadowPathPredicate } from "@earendil-works/gondolin";
import { describe, expect, it } from "vitest";

import { buildMounts, PI_AGENT_ALWAYS_SHADOWED, WORKSPACE_ALWAYS_SHADOWED } from "../src/mounts.ts";
import { GUEST_GITHUB_REPOS, GUEST_PI_AGENT } from "../src/paths.ts";

// ---------------------------------------------------------------------------
// Shadow-policy constants
// ---------------------------------------------------------------------------

describe("WORKSPACE_ALWAYS_SHADOWED", () => {
  it("contains /node_modules", () => {
    expect(WORKSPACE_ALWAYS_SHADOWED).toContain("/node_modules");
  });

  it("contains /.pi/dungeon.json", () => {
    expect(WORKSPACE_ALWAYS_SHADOWED).toContain("/.pi/dungeon.json");
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

  it("blocks /node_modules exactly", () => {
    expect(pred({ op: "stat", path: "/node_modules" })).toBe(true);
  });

  it("blocks subpaths of /node_modules", () => {
    expect(pred({ op: "open", path: "/node_modules/foo" })).toBe(true);
  });

  it("blocks deeply nested paths under /node_modules", () => {
    expect(pred({ op: "open", path: "/node_modules/lodash/index.js" })).toBe(true);
  });

  it("blocks /.pi/dungeon.json", () => {
    expect(pred({ op: "stat", path: "/.pi/dungeon.json" })).toBe(true);
  });

  it("allows /src/foo.ts", () => {
    expect(pred({ op: "stat", path: "/src/foo.ts" })).toBe(false);
  });

  it("does not block a sibling directory that merely starts with /node_modules text", () => {
    // Directory boundary must be respected — /node_modules_extra is NOT shadowed.
    expect(pred({ op: "stat", path: "/node_modules_extra/index.js" })).toBe(false);
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

  it("returns a mounts entry for GUEST_PI_AGENT", () => {
    const { mounts } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(mounts[GUEST_PI_AGENT]).toBeDefined();
  });

  it("returns a mounts entry for GUEST_GITHUB_REPOS", () => {
    const { mounts } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(mounts[GUEST_GITHUB_REPOS]).toBeDefined();
  });

  it("returns a mounts entry for the jj config guest path", () => {
    const { mounts } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(mounts["/root/.config/jj"]).toBeDefined();
  });

  it("returns empty pendingMappings when no custom mounts are configured", () => {
    const { pendingMappings } = buildMounts({}, localCwd, guestWorkspace, home);
    expect(pendingMappings).toEqual([]);
  });

  it("adds a mount entry for each path in config.mounts", () => {
    const config = {
      mounts: {
        "/guest/extra": { path: "/tmp", mode: "ro" as const },
      },
    };
    const { mounts } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(mounts["/guest/extra"]).toBeDefined();
  });

  it("returns pendingMappings for each custom mount", () => {
    const config = {
      mounts: {
        "/guest/extra": { path: "/tmp", mode: "ro" as const },
      },
    };
    const { pendingMappings } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(pendingMappings).toHaveLength(1);
    expect(pendingMappings[0]).toMatchObject({
      hostDir: "/tmp",
      guestDir: "/guest/extra",
    });
  });

  it("expands ~ in custom mount host paths", () => {
    const config = {
      mounts: {
        "/guest/homedir": { path: "~/mydir", mode: "ro" as const },
      },
    };
    const { pendingMappings } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(pendingMappings[0]?.hostDir).toBe(`${home}/mydir`);
  });

  it("adds multiple custom mounts and returns all as pendingMappings", () => {
    const config = {
      mounts: {
        "/guest/a": { path: "/tmp", mode: "ro" as const },
        "/guest/b": { path: "/tmp", mode: "rw" as const },
      },
    };
    const { mounts, pendingMappings } = buildMounts(config, localCwd, guestWorkspace, home);
    expect(mounts["/guest/a"]).toBeDefined();
    expect(mounts["/guest/b"]).toBeDefined();
    expect(pendingMappings).toHaveLength(2);
  });
});
