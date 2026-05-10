import os from "node:os";
import { describe, expect, it } from "vitest";
import { createPathMappings, shQuote, toGuestPath } from "../src/paths.ts";

// ---------------------------------------------------------------------------
// shQuote
// ---------------------------------------------------------------------------

describe("shQuote", () => {
  it("wraps a simple string in single quotes", () => {
    expect(shQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes inside the string", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it("handles an empty string", () => {
    expect(shQuote("")).toBe("''");
  });

  it("does not expand shell special chars — spaces are safe", () => {
    const q = shQuote("hello world");
    expect(q).toBe("'hello world'");
    // No word-splitting: the whole value is one token
    expect(q.startsWith("'")).toBe(true);
    expect(q.endsWith("'")).toBe(true);
  });

  it("does not expand dollar signs", () => {
    const q = shQuote("$HOME");
    expect(q).toBe("'$HOME'");
  });

  it("does not expand backticks", () => {
    const q = shQuote("`whoami`");
    expect(q).toBe("'`whoami`'");
  });

  it("handles multiple single quotes", () => {
    expect(shQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

// ---------------------------------------------------------------------------
// toGuestPath
// ---------------------------------------------------------------------------

describe("toGuestPath", () => {
  const mappings = [
    { hostDir: "/host/workspace", guestDir: "/guest/workspace" },
    { hostDir: "/host/agent", guestDir: "/root/.pi/agent" },
  ];

  it("exact match returns the guest dir", () => {
    expect(toGuestPath(mappings, "/host/workspace")).toBe("/guest/workspace");
  });

  it("maps a subpath correctly", () => {
    expect(toGuestPath(mappings, "/host/workspace/src/foo.ts")).toBe("/guest/workspace/src/foo.ts");
  });

  it("maps a different mount's subpath correctly", () => {
    expect(toGuestPath(mappings, "/host/agent/skills/bash.md")).toBe("/root/.pi/agent/skills/bash.md");
  });

  it("throws for a path outside all mappings", () => {
    expect(() => toGuestPath(mappings, "/etc/passwd")).toThrow("path not accessible in sandbox");
  });

  it("throws for a path that is a sibling of a mapped dir (not inside it)", () => {
    // /host/workspace-other starts with /host/workspace but is not inside it
    expect(() => toGuestPath(mappings, "/host/workspace-other/file")).toThrow("path not accessible in sandbox");
  });

  it("rejects path traversal that escapes a mapping", () => {
    // A relative traversal that goes up past the guest root
    expect(() => toGuestPath(mappings, "/host/workspace/../../../etc/passwd")).toThrow(
      "path not accessible in sandbox",
    );
  });
});

// ---------------------------------------------------------------------------
// createPathMappings
// ---------------------------------------------------------------------------

describe("createPathMappings", () => {
  it("returns three default mappings", () => {
    const mappings = createPathMappings("/host/workspace", "/guest/workspace");
    expect(mappings).toHaveLength(3);
  });

  it("first mapping is workspace host→guest", () => {
    const mappings = createPathMappings("/host/workspace", "/guest/workspace");
    expect(mappings[0]).toEqual({
      hostDir: "/host/workspace",
      guestDir: "/guest/workspace",
    });
  });

  it("second mapping is ~/.pi/agent → /root/.pi/agent", () => {
    const home = os.homedir();
    const mappings = createPathMappings("/host/workspace", "/guest/workspace");
    expect(mappings[1]).toEqual({
      hostDir: `${home}/.pi/agent`,
      guestDir: "/root/.pi/agent",
    });
  });

  it("third mapping is /tmp/pi-github-repos → /tmp/pi-github-repos", () => {
    const mappings = createPathMappings("/host/workspace", "/guest/workspace");
    expect(mappings[2]).toEqual({
      hostDir: "/tmp/pi-github-repos",
      guestDir: "/tmp/pi-github-repos",
    });
  });
});
