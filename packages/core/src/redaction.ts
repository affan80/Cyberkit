/**
 * Irreversible redaction of secrets in free text.
 *
 * Pure and offline: no I/O, no shared regex state. Patterns avoid nested
 * quantifiers so large inputs are scanned in linear time.
 */

export const REDACTED = "[REDACTED]";

type Rule = readonly [pattern: RegExp, replacement: string];

// Order matters: whole-block and header rules run before generic key=value.
const RULES: readonly Rule[] = [
  // PEM private keys, including truncated blocks with no END marker.
  [/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, REDACTED],

  // Auth and cookie headers: keep the header name, drop the rest of the line.
  [
    /(?<![\w-])((?:proxy-)?authorization|x-api-key|set-cookie|cookie)([ \t]*:[ \t]*)[^\r\n]+/gi,
    `$1$2${REDACTED}`,
  ],

  // Well-known token formats.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  [/\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{5,}/g, REDACTED],

  // Credentials embedded in URLs: scheme://user:SECRET@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, `$1${REDACTED}$2`],

  // key=value / "key": "value" for secret-looking keys.
  [
    /(?<!\w)(\w*?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\w*"?[ \t]*[:=][ \t]*"?)[^\s"',;&]+/gi,
    `$1${REDACTED}`,
  ],
];

export function redact(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError("redact() expects a string");
  }
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
