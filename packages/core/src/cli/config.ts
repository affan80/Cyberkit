/** Validated, immutable scan configuration. Pure: no I/O, no process access. */

export const FORMATS = ["text", "json", "sarif"] as const;
export type Format = (typeof FORMATS)[number];

/** Lowest severity that makes the scan exit with FINDINGS; "none" never fails on findings. */
export const FAIL_ON = ["critical", "high", "medium", "low", "info", "none"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface Config {
  readonly target: string;
  readonly format: Format;
  readonly output: string | undefined;
  readonly plugins: readonly string[];
  readonly quiet: boolean;
  readonly failOn: FailOn;
}

export interface ConfigInput {
  target?: string;
  format?: string;
  output?: string;
  plugins?: readonly string[];
  quiet?: boolean;
  failOn?: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export const DEFAULT_CONFIG: Config = Object.freeze({
  target: ".",
  format: "text",
  output: undefined,
  plugins: Object.freeze([]),
  quiet: false,
  failOn: "low",
});

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isFormat = (v: string): v is Format => (FORMATS as readonly string[]).includes(v);
const isFailOn = (v: unknown): v is FailOn => (FAIL_ON as readonly unknown[]).includes(v);

function pathValue(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${what} must be a non-empty string`);
  }
  if (value.includes("\0")) throw new ConfigError(`${what} must not contain NUL bytes`);
  return value;
}

export function createConfig(input: ConfigInput): Config {
  const target = input.target === undefined ? DEFAULT_CONFIG.target : pathValue(input.target, "target");
  const output = input.output === undefined ? undefined : pathValue(input.output, "output");

  const format = input.format ?? DEFAULT_CONFIG.format;
  if (typeof format !== "string" || !isFormat(format)) {
    throw new ConfigError(`format must be one of: ${FORMATS.join(", ")}`);
  }

  if (input.plugins !== undefined && !Array.isArray(input.plugins)) {
    throw new ConfigError("plugins must be an array of plugin names");
  }
  const plugins = new Set<string>();
  for (const name of input.plugins ?? []) {
    if (typeof name !== "string" || !PLUGIN_NAME.test(name)) {
      throw new ConfigError(`invalid plugin name: ${JSON.stringify(name)}`);
    }
    plugins.add(name);
  }

  if (input.quiet !== undefined && typeof input.quiet !== "boolean") {
    throw new ConfigError("quiet must be a boolean");
  }

  const failOn = input.failOn ?? DEFAULT_CONFIG.failOn;
  if (!isFailOn(failOn)) throw new ConfigError(`fail-on must be one of: ${FAIL_ON.join(", ")}`);

  return Object.freeze({
    target,
    format,
    output,
    plugins: Object.freeze([...plugins]),
    quiet: input.quiet ?? false,
    failOn,
  });
}
