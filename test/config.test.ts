import { describe, expect, it } from "vitest";
import { mergeConfigs } from "../src/config.ts";

// ---------------------------------------------------------------------------
// mergeConfigs
// ---------------------------------------------------------------------------

describe("mergeConfigs", () => {
  it("merges empty configs to empty", () => {
    const result = mergeConfigs({}, {});
    expect(result.allowedHosts).toEqual([]);
    expect(result.secrets).toEqual({});
    expect(result.mounts).toEqual({});
  });

  it("concatenates allowedHosts from both configs", () => {
    const result = mergeConfigs(
      { allowedHosts: ["example.com"] },
      { allowedHosts: ["api.example.com", "cdn.example.com"] },
    );
    expect(result.allowedHosts).toEqual(["example.com", "api.example.com", "cdn.example.com"]);
  });

  it("project allowedHosts appear after global ones", () => {
    const result = mergeConfigs({ allowedHosts: ["global.com"] }, { allowedHosts: ["project.com"] });
    expect(result.allowedHosts?.[0]).toBe("global.com");
    expect(result.allowedHosts?.[1]).toBe("project.com");
  });

  it("merges secrets, project wins on conflict", () => {
    const result = mergeConfigs(
      {
        secrets: {
          TOKEN: { keychain: "global-token", hosts: ["global.com"] },
          SHARED: { keychain: "global-shared", hosts: ["shared.com"] },
        },
      },
      {
        secrets: {
          SHARED: { keychain: "project-shared", hosts: ["project.com"] },
          NEW: { keychain: "project-new", hosts: ["new.com"] },
        },
      },
    );
    expect(result.secrets?.TOKEN).toEqual({
      keychain: "global-token",
      hosts: ["global.com"],
    });
    // project wins on conflict
    expect(result.secrets?.SHARED).toEqual({
      keychain: "project-shared",
      hosts: ["project.com"],
    });
    expect(result.secrets?.NEW).toEqual({
      keychain: "project-new",
      hosts: ["new.com"],
    });
  });

  it("merges mounts, project wins on conflict", () => {
    const result = mergeConfigs(
      {
        mounts: {
          "/guest/a": { path: "/host/a", mode: "ro" },
          "/guest/shared": { path: "/host/global-shared", mode: "ro" },
        },
      },
      {
        mounts: {
          "/guest/shared": { path: "/host/project-shared", mode: "rw" },
          "/guest/b": { path: "/host/b", mode: "rw" },
        },
      },
    );
    expect(result.mounts?.["/guest/a"]).toEqual({ path: "/host/a", mode: "ro" });
    expect(result.mounts?.["/guest/shared"]).toEqual({
      path: "/host/project-shared",
      mode: "rw",
    });
    expect(result.mounts?.["/guest/b"]).toEqual({ path: "/host/b", mode: "rw" });
  });

  it("handles partial configs (only one side has fields)", () => {
    const result = mergeConfigs(
      { allowedHosts: ["global.com"] },
      { secrets: { KEY: { keychain: "k", hosts: ["h.com"] } } },
    );
    expect(result.allowedHosts).toEqual(["global.com"]);
    expect(result.secrets?.KEY).toBeDefined();
    expect(result.mounts).toEqual({});
  });
});
