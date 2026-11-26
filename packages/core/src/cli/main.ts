/**
 * CLI entrypoint: argv -> config -> scan() -> reporter -> exit code.
 * main() is pure apart from the injected IO and the scan itself, so it is
 * fully testable; run() binds it to the real process.
 */
import type { Finding } from "../finding.js";
import { redact } from "../redaction.js";
import { renderJson } from "../reporters/json.js";
import { escapeForTerminal, renderPlain } from "../reporters/plain.js";
import { renderSarif } from "../reporters/sarif.js";
import { scan } from "../sdk/scan.js";
import { VERSION } from "../version.js";
import { type Config, ConfigError } from "./config.js";
import { EXIT, type ExitCode, exitCodeForError } from "./exit.js";
import { parseCliArgs } from "./parse.js";
import { writeFileNoFollow } from "./safe-write.js";

export interface CliIO {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
  /** Whether stdout is a terminal (enables colour for text output). */
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const describeError = (e: unknown): string => escapeForTerminal(redact(e instanceof Error ? e.message : String(e)));

function render(findings: readonly Finding[], config: Config, color: boolean): string {
  switch (config.format) {
    case "json":
      return renderJson(findings);
    case "sarif":
      return renderSarif(findings);
    default:
      return renderPlain(findings, { color });
  }
}

export async function main(argv: readonly string[], io: CliIO): Promise<ExitCode> {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.kind === "help") {
      io.stdout.write(parsed.text);
      return EXIT.OK;
    }
    if (parsed.kind === "version") {
      io.stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    }

    const { config } = parsed;
    const result = await scan({ target: config.target, plugins: config.plugins, failOn: config.failOn });

    if (!config.quiet) {
      for (const p of result.plugins) {
        if (p.status !== "ok") io.stderr.write(`cyberkit: plugin ${escapeForTerminal(p.name)}: ${p.status}: ${escapeForTerminal(p.error ?? "failed")}\n`);
      }
    }

    // Colour only for an interactive terminal; NO_COLOR (no-color.org) always wins.
    const color = config.output === undefined && io.isTTY && io.env.NO_COLOR === undefined;
    const report = render(result.findings, config, color);
    if (config.output === undefined) {
      io.stdout.write(report);
    } else {
      // The scanned tree (and usually the cwd) is untrusted: never follow a
      // symlink planted there to write outside it (issue #46).
      await writeFileNoFollow(config.output, report, { untrustedRoots: [process.cwd(), config.target] });
    }
    return result.exitCode;
  } catch (e) {
    io.stderr.write(`cyberkit: ${describeError(e)}\n`);
    if (e instanceof ConfigError) io.stderr.write('Run "cyberkit --help" for usage.\n');
    return exitCodeForError(e);
  }
}

/** Write errors that only mean the reader of stdout went away. */
const READER_GONE = new Set(["EPIPE", "ENOTCONN", "ECONNRESET"]);

/** Binds main() to the real process. Uses process.exitCode so output always flushes. */
export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  // `cyberkit ... | head` closes the pipe early; that is not an error. Pipes
  // report EPIPE; socketpair stdio (child processes on macOS) can report
  // ENOTCONN or ECONNRESET for the same thing.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (!READER_GONE.has(e.code ?? "")) throw e;
  });
  process.exitCode = await main(argv, { stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY === true, env: process.env });
}
