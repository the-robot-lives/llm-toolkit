import { describe, test, expect } from "vitest";
import { parseServicesArgs } from "../commands/services.tsx";

describe("parseServicesArgs", () => {
  test("--list selects list mode", () => {
    expect(parseServicesArgs(["--list"])).toEqual({ mode: "list" });
  });

  test("--all selects start-all mode", () => {
    expect(parseServicesArgs(["--all"])).toEqual({ mode: "all" });
  });

  test("--start/--stop/--restart capture the service name", () => {
    expect(parseServicesArgs(["--start", "echo"])).toEqual({ mode: "start", name: "echo" });
    expect(parseServicesArgs(["--stop", "web"])).toEqual({ mode: "stop", name: "web" });
    expect(parseServicesArgs(["--restart", "api-gateway"])).toEqual({ mode: "restart", name: "api-gateway" });
  });

  test("action flags without a NAME error and fall back to interactive", () => {
    for (const flag of ["--start", "--stop", "--restart"]) {
      const parsed = parseServicesArgs([flag]);
      expect(parsed.mode).toBe("interactive");
      expect(parsed.error).toContain("Missing service name");
      expect(parsed.error).toContain(flag);
    }
  });

  test("action flag followed by another flag is treated as missing NAME", () => {
    const parsed = parseServicesArgs(["--start", "--all"]);
    expect(parsed.mode).toBe("interactive");
    expect(parsed.error).toContain("Missing service name");
  });

  test("unknown flag errors and falls back to interactive", () => {
    const parsed = parseServicesArgs(["--wat"]);
    expect(parsed.mode).toBe("interactive");
    expect(parsed.error).toContain("Unknown flag");
    expect(parsed.error).toContain("--wat");
  });

  test("no flags selects interactive mode", () => {
    expect(parseServicesArgs([])).toEqual({ mode: "interactive" });
  });
});
