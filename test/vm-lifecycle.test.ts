import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { markerPath, readSessionMarker, removeSessionMarker, writeSessionMarker } from "../src/vm.ts";

describe("session markers", () => {
  const testCwd = `/tmp/test-dungeon-${crypto.randomUUID()}`;

  afterEach(() => {
    removeSessionMarker(testCwd);
  });

  it("writes and reads a session marker", () => {
    writeSessionMarker(testCwd, "test-session-123");
    expect(readSessionMarker(testCwd)).toBe("test-session-123");
  });

  it("returns null when no marker exists", () => {
    expect(readSessionMarker(testCwd)).toBeNull();
  });

  it("removes a marker", () => {
    writeSessionMarker(testCwd, "test-session-123");
    removeSessionMarker(testCwd);
    expect(readSessionMarker(testCwd)).toBeNull();
  });

  it("removeSessionMarker is safe when no marker exists", () => {
    expect(() => removeSessionMarker(testCwd)).not.toThrow();
  });

  it("overwrites existing marker", () => {
    writeSessionMarker(testCwd, "old-session");
    writeSessionMarker(testCwd, "new-session");
    expect(readSessionMarker(testCwd)).toBe("new-session");
  });

  it("markerPath is deterministic for same input", () => {
    expect(markerPath(testCwd)).toBe(markerPath(testCwd));
  });

  it("markerPath differs for different inputs", () => {
    expect(markerPath("/path/a")).not.toBe(markerPath("/path/b"));
  });
});
