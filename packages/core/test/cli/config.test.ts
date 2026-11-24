import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, createConfig } from "../../src/cli/config.js";

describe("createConfig", () => {
  it("applies defaults for an empty input", () => {
    expect(createConfig({})).toEqual({
      target: ".",
      format: "text",
      output: undefined,
      plugins: [],
      quiet: false,
      failOn: "low",
    });
    expect(DEFAULT_CONFIG.format).toBe("text");
  });

  it("keeps valid values", () => {
    const c = createConfig({
      target: "./app",
      format: "sarif",
      output: "out/report.sarif",
      plugins: ["semgrep", "my-plugin_2"],
      quiet: true,
    });
    expect(c).toMatchObject({ target: "./app", format: "sarif", output: "out/report.sarif", quiet: true });
    expect(c.plugins).toEqual(["semgrep", "my-plugin_2"]);
  });

  it.each(["text", "json", "sarif"])("accepts format %s", (format) => {
    expect(createConfig({ format }).format).toBe(format);
  });

  it("rejects an unknown format and lists the valid ones", () => {
    expect(() => createConfig({ format: "xml" })).toThrow(ConfigError);
    expect(() => createConfig({ format: "xml" })).toThrow(/text, json, sarif/);
  });

  it.each([
    ["empty target", { target: "" }],
    ["NUL in target", { target: "a\0b" }],
    ["empty output", { output: "" }],
    ["NUL in output", { output: "a\0b" }],
    ["non-string target", { target: 5 as unknown as string }],
    ["plugin with a path separator", { plugins: ["../evil"] }],
    ["plugin with a space", { plugins: ["a b"] }],
    ["empty plugin name", { plugins: [""] }],
    ["non-array plugins", { plugins: "semgrep" as unknown as string[] }],
  ])("rejects %s", (_n, input) => {
    expect(() => createConfig(input)).toThrow(ConfigError);
  });

  it("removes duplicate plugins, keeping first-seen order", () => {
    expect(createConfig({ plugins: ["b", "a", "b"] }).plugins).toEqual(["b", "a"]);
  });

  it("returns an immutable config that does not alias the input array", () => {
    const plugins = ["semgrep"];
    const c = createConfig({ plugins });
    plugins.push("other");
    expect(c.plugins).toEqual(["semgrep"]);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.plugins)).toBe(true);
  });
});

describe("createConfig: failOn", () => {
  it("defaults to low", () => {
    expect(createConfig({}).failOn).toBe("low");
  });

  it.each(["critical", "high", "medium", "low", "info", "none"])("accepts %s", (failOn) => {
    expect(createConfig({ failOn }).failOn).toBe(failOn);
  });

  it("rejects an unknown threshold and lists the valid ones", () => {
    expect(() => createConfig({ failOn: "severe" })).toThrow(/critical, high, medium, low, info, none/);
  });
});
