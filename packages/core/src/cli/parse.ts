/** Pure CLI argument parser built on node:util parseArgs. Never reads process.argv. */
import { parseArgs } from "node:util";
import { type Config, ConfigError, createConfig } from "./config.js";

export const HELP_TEXT = `Usage: cyberkit scan [target] [options]

Options:
  -f, --format <fmt>    Output format: text, json, sarif (default: text)
  -o, --output <file>   Write the report to a file instead of stdout
  -p, --plugin <name>   Enable a plugin (repeatable)
  -q, --quiet           Suppress progress output
  -h, --help            Show this help
  -v, --version         Show the version
`;

export type ParseResult =
  | { readonly kind: "run"; readonly config: Config }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "version" };

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  format: { type: "string", short: "f" },
  output: { type: "string", short: "o" },
  plugin: { type: "string", short: "p", multiple: true },
  quiet: { type: "boolean", short: "q" },
} as const;

export function parseCliArgs(argv: readonly string[]): ParseResult {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : "invalid arguments");
  }
  const { values, positionals } = parsed;

  if (values.help) return { kind: "help", text: HELP_TEXT };
  if (values.version) return { kind: "version" };

  const [command, ...rest] = positionals;
  if (command === undefined) return { kind: "help", text: HELP_TEXT };
  if (command !== "scan") throw new ConfigError(`unknown command "${command}"`);
  if (rest.length > 1) throw new ConfigError("scan takes at most one target");

  return {
    kind: "run",
    config: createConfig({
      target: rest[0],
      format: values.format,
      output: values.output,
      plugins: values.plugin,
      quiet: values.quiet,
    }),
  };
}
