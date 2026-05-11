import { describe, expect, it } from "vitest";
import { createGlobShadowPathPredicate } from "../src/mounts.ts";

// Helper: call the predicate with a bare path string.
function matches(patterns: string[], filePath: string): boolean {
  return createGlobShadowPathPredicate(patterns)({ op: "stat", path: filePath });
}

// ---------------------------------------------------------------------------
// Exact prefix patterns
// ---------------------------------------------------------------------------

describe("exact prefix patterns", () => {
  it("1. /node_modules matches /node_modules", () => {
    expect(matches(["/node_modules"], "/node_modules")).toBe(true);
  });

  it("2. /node_modules matches /node_modules/lodash", () => {
    expect(matches(["/node_modules"], "/node_modules/lodash")).toBe(true);
  });

  it("3. /node_modules does NOT match /node_modules_extra", () => {
    expect(matches(["/node_modules"], "/node_modules_extra")).toBe(false);
  });

  it("4. /node_modules does NOT match /src/node_modules", () => {
    expect(matches(["/node_modules"], "/src/node_modules")).toBe(false);
  });

  it("5. /.env matches /.env", () => {
    expect(matches(["/.env"], "/.env")).toBe(true);
  });

  it("6. /.env matches /.env/foo (prefix)", () => {
    expect(matches(["/.env"], "/.env/foo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Double-star patterns
// ---------------------------------------------------------------------------

describe("double-star patterns", () => {
  it("7. **/bin matches /bin", () => {
    expect(matches(["**/bin"], "/bin")).toBe(true);
  });

  it("8. **/bin matches /bin/Debug", () => {
    expect(matches(["**/bin"], "/bin/Debug")).toBe(true);
  });

  it("9. **/bin matches /src/App/bin", () => {
    expect(matches(["**/bin"], "/src/App/bin")).toBe(true);
  });

  it("10. **/bin matches /src/App/bin/Debug/net8.0", () => {
    expect(matches(["**/bin"], "/src/App/bin/Debug/net8.0")).toBe(true);
  });

  it("11. **/obj matches /src/App/obj", () => {
    expect(matches(["**/obj"], "/src/App/obj")).toBe(true);
  });

  it("12. **/bin does NOT match /binaries (must be exact segment)", () => {
    expect(matches(["**/bin"], "/binaries")).toBe(false);
  });

  it("13. **/bin does NOT match /src/binary", () => {
    expect(matches(["**/bin"], "/src/binary")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wildcard patterns
// ---------------------------------------------------------------------------

describe("wildcard patterns", () => {
  it("14. /.env.* matches /.env.local", () => {
    expect(matches(["/.env.*"], "/.env.local")).toBe(true);
  });

  it("15. /.env.* matches /.env.production", () => {
    expect(matches(["/.env.*"], "/.env.production")).toBe(true);
  });

  it("16. /.env.* does NOT match /.env (star must match one or more chars)", () => {
    expect(matches(["/.env.*"], "/.env")).toBe(false);
  });

  it("17. /.env.* matches /.env.local/foo (children included)", () => {
    expect(matches(["/.env.*"], "/.env.local/foo")).toBe(true);
  });

  it("18. /.env.* does NOT match /src/.env.local (parent must match)", () => {
    expect(matches(["/.env.*"], "/src/.env.local")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed patterns (multiple patterns at once)
// ---------------------------------------------------------------------------

describe("mixed patterns", () => {
  const patterns = ["/node_modules", "**/bin", "/.env.*"];

  it("19a. /node_modules/foo → true", () => {
    expect(matches(patterns, "/node_modules/foo")).toBe(true);
  });

  it("19b. /src/App/bin → true", () => {
    expect(matches(patterns, "/src/App/bin")).toBe(true);
  });

  it("19c. /.env.local → true", () => {
    expect(matches(patterns, "/.env.local")).toBe(true);
  });

  it("19d. /src/foo.ts → false", () => {
    expect(matches(patterns, "/src/foo.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("20. empty patterns array always returns false", () => {
    expect(matches([], "/anything")).toBe(false);
    expect(matches([], "/")).toBe(false);
  });

  it("21a. ** alone is filtered out (does not shadow everything)", () => {
    expect(matches(["**"], "/anything")).toBe(false);
  });

  it("21b. **/ is filtered out (does not shadow everything)", () => {
    expect(matches(["**/"], "/anything")).toBe(false);
  });
});
