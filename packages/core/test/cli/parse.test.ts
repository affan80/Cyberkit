import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/cli/config.js";
import { HELP_TEXT, parseCliArgs } from "../../src/cli/parse.js";

const config = (argv: string[]) => {
  const r = parseCliArgs(argv);
  if (r.kind !== "run") throw new Error(`expected run, got ${r.kind}`);
  return r.config;
};

describe("parseCliArgs: commands", () => {
  it("scan with no target defaults to the current directory", () => {
    expect(config(["scan"])).toMatchObject({ target: ".", format: "text", quiet: false, plugins: [] });
  });

  it("scan takes one positional target", () => {
    expect(config(["scan", "./src"]).target).toBe("./src");
  });

  it("no arguments shows help", () => {
    expect(parseCliArgs([])).toEqual({ kind: "help", text: HELP_TEXT });
  });

  it.each([["--help"], ["-h"], ["scan", "--help"], ["scan", "-h", "x"]])("%s shows help", (...argv) => {
    expect(parseCliArgs(argv).kind).toBe("help");
  });

  it.each([["--version"], ["-v"]])("%s asks for the version", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ kind: "version" });
  });

  it("rejects an unknown command", () => {
    expect(() => parseCliArgs(["deploy"])).toThrow(ConfigError);
    expect(() => parseCliArgs(["deploy"])).toThrow(/unknown command "deploy"/);
  });
});

describe("parseCliArgs: options", () => {
  it("parses --format in both spellings and -f", () => {
    expect(config(["scan", "--format", "json"]).format).toBe("json");
    expect(config(["scan", "--format=sarif"]).format).toBe("sarif");
    expect(config(["scan", "-f", "json"]).format).toBe("json");
  });

  it("parses --output / -o", () => {
    expect(config(["scan", "--output", "r.json"]).output).toBe("r.json");
    expect(config(["scan", "-o", "r.json"]).output).toBe("r.json");
  });

  it("parses repeatable --plugin / -p", () => {
    expect(config(["scan", "--plugin", "semgrep", "-p", "x"]).plugins).toEqual(["semgrep", "x"]);
  });

  it("parses --quiet / -q", () => {
    expect(config(["scan", "--quiet"]).quiet).toBe(true);
    expect(config(["scan", "-q"]).quiet).toBe(true);
  });

  it("accepts options before or after the target", () => {
    expect(config(["scan", "-q", "dir", "-f", "json"])).toMatchObject({ target: "dir", quiet: true, format: "json" });
  });

  it("treats everything after -- as the target, even if it looks like a flag", () => {
    expect(config(["scan", "--", "--weird"]).target).toBe("--weird");
  });
});

describe("parseCliArgs: errors", () => {
  it.each([
    [["scan", "--nope"], /unknown option/i],
    [["scan", "a", "b"], /one target/i],
    [["scan", "--format"], /argument|value/i],
    [["scan", "--format", "xml"], /text, json, sarif/],
    [["scan", "--plugin", "../x"], /plugin/i],
    [["scan", "--quiet=yes"], /./],
  ])("%j throws a ConfigError", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(ConfigError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it("never throws anything other than ConfigError for hostile input", () => {
    for (const argv of [["scan", "\0"], ["scan", "--output", ""], ["\0"], ["scan", "--plugin", "a\0b"]]) {
      try {
        parseCliArgs(argv);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
      }
    }
  });

  it("does not read process.argv or mutate its input", () => {
    const argv = Object.freeze(["scan", "-q"]) as unknown as string[];
    expect(() => parseCliArgs(argv)).not.toThrow();
  });
});
