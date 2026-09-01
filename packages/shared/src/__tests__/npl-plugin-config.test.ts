import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  NplPluginConfigError,
  findProjectRoot,
  findUserConfigPath,
  loadNplPluginConfig,
  mergeConfigs,
  saveNplPluginConfig,
} from "../npl-plugin-config.ts";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "llm-toolkit-npl-config-"));
}

function writeProjectConfig(root: string, yaml: string): void {
  mkdirSync(join(root, ".npl"), { recursive: true });
  writeFileSync(join(root, ".npl", "npl-plugin.config.yaml"), yaml, "utf-8");
}

function writeUserConfig(home: string, yaml: string): string {
  const dir = join(home, ".config", "npl");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "npl-plugin.config.yaml");
  writeFileSync(path, yaml, "utf-8");
  return path;
}

describe("findUserConfigPath", () => {
  test("falls back to home/.config when no env set", () => {
    const prevNpl = process.env.NPL_CONFIG_HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.NPL_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(findUserConfigPath("/custom-home")).toBe(
        join("/custom-home", ".config", "npl", "npl-plugin.config.yaml"),
      );
    } finally {
      if (prevNpl !== undefined) process.env.NPL_CONFIG_HOME = prevNpl;
      if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });
});

describe("findProjectRoot", () => {
  test("walks up to the dir containing .npl/npl-plugin.config.yaml", () => {
    const root = makeTempRoot();
    writeProjectConfig(root, "version: 1\nservices: []\n");
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  test("returns null when nothing found", () => {
    const root = makeTempRoot();
    expect(findProjectRoot(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("loadNplPluginConfig", () => {
  test("returns defaults with no files present", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    const loaded = loadNplPluginConfig({ cwd: root, home });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.layers).toEqual({ userFound: false, projectFound: false });
    expect(loaded.projectRoot).toBeNull();
    expect(loaded.serviceSources).toEqual({});
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("loads user-only config", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(
      home,
      [
        "version: 1",
        "services:",
        "  - name: my-mcp",
        "    command: node",
        "    args: [server.js]",
        "    transport: stdio",
      ].join("\n"),
    );
    const loaded = loadNplPluginConfig({ cwd: root, home });
    expect(loaded.layers.userFound).toBe(true);
    expect(loaded.config.services).toHaveLength(1);
    expect(loaded.config.services[0]?.name).toBe("my-mcp");
    expect(loaded.serviceSources).toEqual({ "my-mcp": "user" });
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("project override wins per-field", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(
      home,
      [
        "version: 1",
        "services:",
        "  - name: shared-svc",
        "    command: node",
        "    args: [a.js]",
        "    port: 1111",
      ].join("\n"),
    );
    writeProjectConfig(
      root,
      [
        "version: 1",
        "services:",
        "  - name: shared-svc",
        "    port: 2222",
      ].join("\n"),
    );
    const loaded = loadNplPluginConfig({ cwd: root, home });
    const svc = loaded.config.services.find((s) => s.name === "shared-svc");
    expect(svc?.command).toBe("node");
    expect(svc?.args).toEqual(["a.js"]);
    expect(svc?.port).toBe(2222);
    expect(loaded.serviceSources["shared-svc"]).toBe("project");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("project disables user service via enabled: false", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(
      home,
      "version: 1\nservices:\n  - name: svc-a\n    command: node\n    enabled: true\n",
    );
    writeProjectConfig(
      root,
      "version: 1\nservices:\n  - name: svc-a\n    command: node\n    enabled: false\n",
    );
    const loaded = loadNplPluginConfig({ cwd: root, home });
    expect(loaded.config.services.find((s) => s.name === "svc-a")?.enabled).toBe(false);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("project-only service appended with source project", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(home, "version: 1\nservices:\n  - name: user-svc\n    command: node\n");
    writeProjectConfig(root, "version: 1\nservices:\n  - name: proj-svc\n    command: deno\n");
    const loaded = loadNplPluginConfig({ cwd: root, home });
    expect(loaded.config.services.map((s) => s.name).sort()).toEqual(["proj-svc", "user-svc"]);
    expect(loaded.serviceSources).toEqual({ "proj-svc": "project", "user-svc": "user" });
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("rejects duplicate names within one file", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(
      home,
      "version: 1\nservices:\n  - name: dup\n    command: node\n  - name: dup\n    command: node\n",
    );
    expect(() => loadNplPluginConfig({ cwd: root, home })).toThrow(NplPluginConfigError);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("rejects http transport without url", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(
      home,
      "version: 1\nservices:\n  - name: http-svc\n    command: node\n    transport: http\n",
    );
    expect(() => loadNplPluginConfig({ cwd: root, home })).toThrow(NplPluginConfigError);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("rejects bad name characters", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(home, "version: 1\nservices:\n  - name: Bad_Name!\n    command: node\n");
    expect(() => loadNplPluginConfig({ cwd: root, home })).toThrow(NplPluginConfigError);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("throws NplPluginConfigError on malformed YAML", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(home, "version: 1\nservices: [unclosed\n");
    try {
      loadNplPluginConfig({ cwd: root, home });
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NplPluginConfigError);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("expands ~ in cwd", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    writeUserConfig(
      home,
      "version: 1\nservices:\n  - name: tilde-svc\n    command: node\n    cwd: ~/some/path\n",
    );
    const loaded = loadNplPluginConfig({ cwd: root, home });
    expect(loaded.config.services[0]?.cwd).toBe(join(home, "some", "path"));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("mergeConfigs", () => {
  test("override env/args replaced wholesale, scalars replaced", () => {
    const base = {
      version: 1,
      services: [
        { name: "svc", command: "node", args: ["old.js"], env: { A: "1", B: "2" }, port: 1 },
      ],
      mcp_sync: { targets: [] },
    };
    const { config, serviceSources } = mergeConfigs(
      base,
      { services: [{ name: "svc", env: { C: "3" } }] },
    );
    const svc = config.services[0];
    expect(svc?.env).toEqual({ C: "3" });
    expect(svc?.args).toEqual(["old.js"]);
    expect(svc?.port).toBe(1);
    expect(serviceSources["svc"]).toBe("project");
  });
});

describe("saveNplPluginConfig", () => {
  test("round-trip preserves unknown top-level keys", () => {
    const root = makeTempRoot();
    const home = makeTempRoot();
    const userPath = writeUserConfig(
      home,
      "version: 1\nui:\n  theme: dark\nservices:\n  - name: svc-x\n    command: node\n",
    );
    const loaded = loadNplPluginConfig({ cwd: root, home });
    loaded.config.services.push({ name: "svc-y", command: "deno" });
    const written = saveNplPluginConfig("user", loaded.config, { home });
    expect(written).toBe(userPath);
    expect(existsSync(userPath)).toBe(true);
    const text = readFileSync(userPath, "utf-8");
    expect(text).toContain("theme: dark");
    const reloaded = loadNplPluginConfig({ cwd: root, home });
    expect(reloaded.config.services.map((s) => s.name).sort()).toEqual(["svc-x", "svc-y"]);

    // project scope writes under <projectRoot>/.npl
    saveNplPluginConfig(
      "project",
      { version: 1, services: [{ name: "proj-only", command: "bun" }] },
      { projectRoot: root },
    );
    expect(existsSync(join(root, ".npl", "npl-plugin.config.yaml"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
