import { describe, expect, it } from "vitest";
import { mergeConfigs, validateConfig } from "../src/config.ts";

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

  it("concatenates hiddenPaths from both configs", () => {
    const result = mergeConfigs({ hiddenPaths: ["/.env"] }, { hiddenPaths: ["/.env.local", "/.secrets"] });
    expect(result.hiddenPaths).toEqual(["/.env", "/.env.local", "/.secrets"]);
  });

  it("concatenates tmpfsPaths from both configs", () => {
    const result = mergeConfigs({ tmpfsPaths: ["/node_modules"] }, { tmpfsPaths: ["/.venv"] });
    expect(result.tmpfsPaths).toEqual(["/node_modules", "/.venv"]);
  });

  it("handles partial configs with only hiddenPaths on one side", () => {
    const result = mergeConfigs({ hiddenPaths: ["/.env"] }, {});
    expect(result.hiddenPaths).toEqual(["/.env"]);
    expect(result.tmpfsPaths).toEqual([]);
  });

  it("handles partial configs with only tmpfsPaths on one side", () => {
    const result = mergeConfigs({}, { tmpfsPaths: ["/node_modules"] });
    expect(result.hiddenPaths).toEqual([]);
    expect(result.tmpfsPaths).toEqual(["/node_modules"]);
  });

  it("merges env, project wins on conflict", () => {
    const result = mergeConfigs(
      { env: { FOO: "global", SHARED: "global-val" } },
      { env: { SHARED: "project-val", BAR: "project" } },
    );
    expect(result.env).toEqual({ FOO: "global", SHARED: "project-val", BAR: "project" });
  });

  it("merges env with only global side", () => {
    const result = mergeConfigs({ env: { FOO: "bar" } }, {});
    expect(result.env).toEqual({ FOO: "bar" });
  });

  it("merges env with only project side", () => {
    const result = mergeConfigs({}, { env: { FOO: "bar" } });
    expect(result.env).toEqual({ FOO: "bar" });
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  const fp = "/fake/dungeon.json";

  it("accepts a valid full config", () => {
    const cfg = validateConfig(
      {
        allowedHosts: ["example.com"],
        secrets: { TOKEN: { keychain: "my-keychain", hosts: ["example.com"] } },
        mounts: { "/guest/data": { path: "/host/data", mode: "ro" } },
        hiddenPaths: ["/.env"],
        tmpfsPaths: ["/tmp"],
      },
      fp,
    );
    expect(cfg.allowedHosts).toEqual(["example.com"]);
  });

  it("accepts an empty object", () => {
    expect(() => validateConfig({}, fp)).not.toThrow();
  });

  it("accepts a config with only $schema", () => {
    expect(() => validateConfig({ $schema: "https://example.com/schema.json" }, fp)).not.toThrow();
  });

  it("throws on non-object (array)", () => {
    expect(() => validateConfig([], fp)).toThrow(/Invalid dungeon config at \/fake\/dungeon\.json/);
  });

  it("throws on non-object (string)", () => {
    expect(() => validateConfig("oops", fp)).toThrow(/Invalid dungeon config at \/fake\/dungeon\.json/);
  });

  it("throws on unknown top-level key", () => {
    expect(() => validateConfig({ unknownField: true }, fp)).toThrow(/unknown field "unknownField"/);
  });

  it("throws on allowedHosts being non-array", () => {
    expect(() => validateConfig({ allowedHosts: "example.com" }, fp)).toThrow(/"allowedHosts" must be an array/);
  });

  it("throws on allowedHosts containing non-strings", () => {
    expect(() => validateConfig({ allowedHosts: [42] }, fp)).toThrow(/"allowedHosts\[0\]" must be a string/);
  });

  it("throws on secrets entry missing keychain", () => {
    expect(() => validateConfig({ secrets: { TOKEN: { hosts: ["example.com"] } } }, fp)).toThrow(
      /"secrets\.TOKEN\.keychain" must be a string/,
    );
  });

  it("throws on secrets entry missing hosts", () => {
    expect(() => validateConfig({ secrets: { TOKEN: { keychain: "k" } } }, fp)).toThrow(
      /"secrets\.TOKEN\.hosts" must be an array/,
    );
  });

  it("throws on mounts entry missing path", () => {
    expect(() => validateConfig({ mounts: { "/guest": { mode: "ro" } } }, fp)).toThrow(
      /"mounts\.\/guest\.path" must be a string/,
    );
  });

  it("throws on mounts entry with invalid mode", () => {
    expect(() => validateConfig({ mounts: { "/guest": { path: "/host", mode: "rx" } } }, fp)).toThrow(
      /"mounts\.\/guest\.mode" must be "ro" or "rw"/,
    );
  });

  it("throws on hiddenPaths being non-array", () => {
    expect(() => validateConfig({ hiddenPaths: "/secret" }, fp)).toThrow(/"hiddenPaths" must be an array/);
  });

  it("throws on tmpfsPaths containing non-strings", () => {
    expect(() => validateConfig({ tmpfsPaths: [false] }, fp)).toThrow(/"tmpfsPaths\[0\]" must be a string/);
  });

  it("accepts valid env object", () => {
    expect(() => validateConfig({ env: { FOO: "bar", HELLO: "world" } }, fp)).not.toThrow();
  });

  it("throws on env being non-object", () => {
    expect(() => validateConfig({ env: "FOO=bar" }, fp)).toThrow(/"env" must be an object/);
  });

  it("throws on env value being non-string", () => {
    expect(() => validateConfig({ env: { FOO: 42 } }, fp)).toThrow(/"env\.FOO" must be a string/);
  });
});
