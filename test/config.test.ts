import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectAncestorConfigs, loadConfig, mergeConfigs, validateConfig } from "../src/config.ts";

// ---------------------------------------------------------------------------
// mergeConfigs
// ---------------------------------------------------------------------------

describe("mergeConfigs", () => {
  it("merges empty configs to empty", () => {
    const result = mergeConfigs({}, {});
    expect(result.allowedHosts).toEqual([]);
    expect(result.secrets).toEqual({});
    expect(result.mounts).toEqual([]);
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
        mounts: ["~/host/a", "~/host/shared"],
      },
      {
        mounts: ["~/host/shared:rw", "~/host/b:rw"],
      },
    );
    // global-only entry preserved
    expect(result.mounts).toContain("~/host/a");
    // project entry for shared path overrides global
    expect(result.mounts).toContain("~/host/shared:rw");
    expect(result.mounts).not.toContain("~/host/shared");
    // project-only entry present
    expect(result.mounts).toContain("~/host/b:rw");
    // order: global non-overridden first, then project entries
    expect(result.mounts).toEqual(["~/host/a", "~/host/shared:rw", "~/host/b:rw"]);
  });

  it("handles partial configs (only one side has fields)", () => {
    const result = mergeConfigs(
      { allowedHosts: ["global.com"] },
      { secrets: { KEY: { keychain: "k", hosts: ["h.com"] } } },
    );
    expect(result.allowedHosts).toEqual(["global.com"]);
    expect(result.secrets?.KEY).toBeDefined();
    expect(result.mounts).toEqual([]);
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

  it("project resources.memory overrides global resources.memory", () => {
    const result = mergeConfigs({ resources: { memory: "1G", cpus: 2 } }, { resources: { memory: "4G", cpus: 2 } });
    expect(result.resources?.memory).toBe("4G");
  });

  it("project resources.cpus overrides global resources.cpus", () => {
    const result = mergeConfigs({ resources: { memory: "2G", cpus: 2 } }, { resources: { memory: "2G", cpus: 8 } });
    expect(result.resources?.cpus).toBe(8);
  });

  it("partial override: project sets only memory, global cpus is preserved", () => {
    const result = mergeConfigs({ resources: { memory: "1G", cpus: 4 } }, { resources: { memory: "2G" } });
    expect(result.resources?.memory).toBe("2G");
    expect(result.resources?.cpus).toBe(4);
  });

  it("partial override: project sets only cpus, global memory is preserved", () => {
    const result = mergeConfigs({ resources: { memory: "1G", cpus: 2 } }, { resources: { cpus: 8 } });
    expect(result.resources?.memory).toBe("1G");
    expect(result.resources?.cpus).toBe(8);
  });

  it("project resources overrides global when global has no resources", () => {
    const result = mergeConfigs({}, { resources: { memory: "2G", cpus: 4 } });
    expect(result.resources?.memory).toBe("2G");
    expect(result.resources?.cpus).toBe(4);
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
        mounts: ["~/data", "~/writable:rw"],
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

  it("throws on mounts being non-array", () => {
    expect(() => validateConfig({ mounts: { "/guest": "~/host" } }, fp)).toThrow(/"mounts" must be an array/);
  });

  it("throws on mounts entry being non-string", () => {
    expect(() => validateConfig({ mounts: [42] }, fp)).toThrow(/"mounts\[0\]" must be a string/);
  });

  it("throws on mounts entry with empty path", () => {
    expect(() => validateConfig({ mounts: [":ro"] }, fp)).toThrow(/"mounts\[0\]" path must not be empty/);
  });

  it("throws on mounts entry with invalid mode suffix", () => {
    expect(() => validateConfig({ mounts: ["~/foo:rx"] }, fp)).toThrow(
      /"mounts\[0\]" mode suffix must be ":ro" or ":rw"/,
    );
  });

  it("accepts mounts entry without mode suffix (defaults ro)", () => {
    expect(() => validateConfig({ mounts: ["~/data"] }, fp)).not.toThrow();
  });

  it("accepts mounts entry with :ro suffix", () => {
    expect(() => validateConfig({ mounts: ["~/data:ro"] }, fp)).not.toThrow();
  });

  it("accepts mounts entry with :rw suffix", () => {
    expect(() => validateConfig({ mounts: ["~/data:rw"] }, fp)).not.toThrow();
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

  it("throws on resources being a string", () => {
    expect(() => validateConfig({ resources: "2G" }, fp)).toThrow(/"resources" must be an object/);
  });

  it("throws on resources being an array", () => {
    expect(() => validateConfig({ resources: ["2G"] }, fp)).toThrow(/"resources" must be an object/);
  });

  it("throws on resources being a number", () => {
    expect(() => validateConfig({ resources: 2 }, fp)).toThrow(/"resources" must be an object/);
  });

  it("throws on resources.memory being a number", () => {
    expect(() => validateConfig({ resources: { memory: 2048 } }, fp)).toThrow(/"resources\.memory" must be a string/);
  });

  it("throws on resources.cpus being 0", () => {
    expect(() => validateConfig({ resources: { cpus: 0 } }, fp)).toThrow(
      /"resources\.cpus" must be a positive integer/,
    );
  });

  it("throws on resources.cpus being negative", () => {
    expect(() => validateConfig({ resources: { cpus: -1 } }, fp)).toThrow(
      /"resources\.cpus" must be a positive integer/,
    );
  });

  it("throws on resources.cpus being a float", () => {
    expect(() => validateConfig({ resources: { cpus: 1.5 } }, fp)).toThrow(
      /"resources\.cpus" must be a positive integer/,
    );
  });

  it("throws on resources.cpus being a string", () => {
    expect(() => validateConfig({ resources: { cpus: "4" } }, fp)).toThrow(
      /"resources\.cpus" must be a positive integer/,
    );
  });

  it("accepts valid resources with memory and cpus", () => {
    expect(() => validateConfig({ resources: { memory: "2G", cpus: 4 } }, fp)).not.toThrow();
  });

  it("accepts empty resources object", () => {
    expect(() => validateConfig({ resources: {} }, fp)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// collectAncestorConfigs
// ---------------------------------------------------------------------------

describe("collectAncestorConfigs", () => {
  let tmpHome: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  function setup() {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    return tmpHome;
  }

  function writeJson(filePath: string, data: object) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  it("finds ancestor .pi/dungeon.json files in outermost-first order", () => {
    const home = setup();
    // Structure:
    //   home/projects/.pi/dungeon.json
    //   home/projects/work/.pi/dungeon.json
    //   home/projects/work/my-app/  <- workspace
    const projectsConfig = path.join(home, "projects", ".pi", "dungeon.json");
    const workConfig = path.join(home, "projects", "work", ".pi", "dungeon.json");
    writeJson(projectsConfig, { allowedHosts: ["projects.example.com"] });
    writeJson(workConfig, { allowedHosts: ["work.example.com"] });
    const workspace = path.join(home, "projects", "work", "my-app");
    fs.mkdirSync(workspace, { recursive: true });

    const results = collectAncestorConfigs(workspace);

    expect(results).toEqual([projectsConfig, workConfig]);
  });

  it("stops at $HOME — does not check $HOME/.pi/dungeon.json", () => {
    const home = setup();
    const homeConfig = path.join(home, ".pi", "dungeon.json");
    writeJson(homeConfig, { allowedHosts: ["home.example.com"] });
    const workspace = path.join(home, "projects", "my-app");
    fs.mkdirSync(workspace, { recursive: true });
    // Also add a config at the projects level to confirm the walk works at all
    const projectsConfig = path.join(home, "projects", ".pi", "dungeon.json");
    writeJson(projectsConfig, { allowedHosts: ["projects.example.com"] });

    const results = collectAncestorConfigs(workspace);

    expect(results).toContain(projectsConfig);
    expect(results).not.toContain(homeConfig);
  });

  it("skips symlinked directories", () => {
    const home = setup();
    // Create a real dir with a config, then symlink it into the ancestor chain
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-real-"));
    try {
      writeJson(path.join(realDir, ".pi", "dungeon.json"), { allowedHosts: ["real.example.com"] });
      // Ancestor chain: home/projects -> symlink -> realDir
      const projectsParent = path.join(home, "projects");
      fs.mkdirSync(projectsParent, { recursive: true });
      const symlinkDir = path.join(projectsParent, "linked");
      fs.symlinkSync(realDir, symlinkDir);
      const workspace = path.join(symlinkDir, "my-app");
      fs.mkdirSync(workspace, { recursive: true });

      const results = collectAncestorConfigs(workspace);

      // symlinkDir is a symlink, so its config should be skipped
      expect(results).not.toContain(path.join(symlinkDir, ".pi", "dungeon.json"));
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("skips symlinked .pi/dungeon.json files", () => {
    const home = setup();
    const workspace = path.join(home, "projects", "my-app");
    fs.mkdirSync(workspace, { recursive: true });
    const projectsDir = path.join(home, "projects");
    const piDir = path.join(projectsDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    // Create real config elsewhere and symlink it in
    const realConfig = path.join(home, "real-dungeon.json");
    fs.writeFileSync(realConfig, JSON.stringify({ allowedHosts: ["real.example.com"] }));
    const configLink = path.join(piDir, "dungeon.json");
    fs.symlinkSync(realConfig, configLink);

    const results = collectAncestorConfigs(workspace);

    // The config file is a symlink, so it should be excluded
    expect(results).not.toContain(configLink);
  });

  it("returns empty array when workspace is direct child of $HOME", () => {
    const home = setup();
    const workspace = path.join(home, "my-project");
    fs.mkdirSync(workspace, { recursive: true });
    // No ancestors between workspace and home (parent of workspace IS home)

    const results = collectAncestorConfigs(workspace);

    expect(results).toEqual([]);
  });

  it("returns empty array when no ancestor has .pi/dungeon.json", () => {
    const home = setup();
    const workspace = path.join(home, "projects", "work", "my-app");
    fs.mkdirSync(workspace, { recursive: true });
    // No .pi/dungeon.json files anywhere

    const results = collectAncestorConfigs(workspace);

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadConfig sources
// ---------------------------------------------------------------------------

describe("loadConfig sources", () => {
  let tmpHome: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  function setup() {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-lc-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    return tmpHome;
  }

  function writeJson(filePath: string, data: object) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  it("sources contains global, ancestor, and project config paths in merge order", () => {
    const home = setup();
    const globalConfigPath = path.join(home, ".pi", "agent", "dungeon.json");
    const ancestorConfigPath = path.join(home, "projects", ".pi", "dungeon.json");
    const workspace = path.join(home, "projects", "my-app");
    const projectConfigPath = path.join(workspace, ".pi", "dungeon.json");

    writeJson(globalConfigPath, { allowedHosts: ["global.example.com"] });
    writeJson(ancestorConfigPath, { allowedHosts: ["ancestor.example.com"] });
    writeJson(projectConfigPath, { allowedHosts: ["project.example.com"] });

    const { sources } = loadConfig(workspace);

    expect(sources).toEqual([globalConfigPath, ancestorConfigPath, projectConfigPath]);
  });

  it("merges config values: project overrides ancestor overrides global", () => {
    const home = setup();
    const globalConfigPath = path.join(home, ".pi", "agent", "dungeon.json");
    const ancestorConfigPath = path.join(home, "projects", ".pi", "dungeon.json");
    const workspace = path.join(home, "projects", "my-app");
    const projectConfigPath = path.join(workspace, ".pi", "dungeon.json");

    // Each level contributes an env var; later layers override
    writeJson(globalConfigPath, { env: { LEVEL: "global", GLOBAL_ONLY: "yes" } });
    writeJson(ancestorConfigPath, { env: { LEVEL: "ancestor", ANCESTOR_ONLY: "yes" } });
    writeJson(projectConfigPath, { env: { LEVEL: "project", PROJECT_ONLY: "yes" } });

    const { config } = loadConfig(workspace);

    expect(config.env?.LEVEL).toBe("project");
    expect(config.env?.GLOBAL_ONLY).toBe("yes");
    expect(config.env?.ANCESTOR_ONLY).toBe("yes");
    expect(config.env?.PROJECT_ONLY).toBe("yes");
  });

  it("omits missing configs from sources", () => {
    const home = setup();
    // No global or ancestor configs; only project
    const workspace = path.join(home, "projects", "my-app");
    const projectConfigPath = path.join(workspace, ".pi", "dungeon.json");
    writeJson(projectConfigPath, { allowedHosts: ["project.example.com"] });

    const { sources } = loadConfig(workspace);

    expect(sources).toEqual([projectConfigPath]);
  });

  it("allowedHosts are concatenated in outermost-first order", () => {
    const home = setup();
    const globalConfigPath = path.join(home, ".pi", "agent", "dungeon.json");
    const ancestorConfigPath = path.join(home, "projects", ".pi", "dungeon.json");
    const workspace = path.join(home, "projects", "my-app");
    const projectConfigPath = path.join(workspace, ".pi", "dungeon.json");

    writeJson(globalConfigPath, { allowedHosts: ["global.example.com"] });
    writeJson(ancestorConfigPath, { allowedHosts: ["ancestor.example.com"] });
    writeJson(projectConfigPath, { allowedHosts: ["project.example.com"] });

    const { config } = loadConfig(workspace);

    expect(config.allowedHosts).toEqual(["global.example.com", "ancestor.example.com", "project.example.com"]);
  });
});
