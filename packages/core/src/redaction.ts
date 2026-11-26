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
  // PEM / PGP private keys ("... PRIVATE KEY BLOCK"), including truncated
  // blocks with no END marker.
  [/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g, REDACTED],

  // PuTTY .ppk private keys: header through the Private-MAC line (or the end).
  [/PuTTY-User-Key-File-\d+:[\s\S]*?(?:Private-MAC:[^\r\n]*|$)/g, REDACTED],

  // JSON / dict form of auth and cookie headers (HAR files, request logs):
  // {"Authorization": "Bearer ..."}, {'cookie': '...'}, {"set-cookie": ["a=b", ...]}.
  // Strings stop at an unescaped quote or the end of the line, so this stays linear.
  [
    /(["'])((?:proxy-)?authorization|x-api-key|set-cookie|cookie)\1([ \t]*:[ \t]*)(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')/gi,
    `$1$2$1$3"${REDACTED}"`,
  ],
  [
    /(["'])((?:proxy-)?authorization|x-api-key|set-cookie|cookie)\1([ \t]*:[ \t]*)\[(?:\s*(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')\s*,?)*/gi,
    `$1$2$1$3["${REDACTED}"`,
  ],

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
  // JWTs. The lookbehind (not \b) keeps "eyJ-eyJ-eyJ-..." from retrying a scan
  // at every "eyJ" in one run, which was quadratic (#50).
  [/(?<![\w-])eyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{5,}/g, REDACTED],
  // GitLab personal/deploy/runner/trigger/service-account tokens.
  [/\bgl(?:pat|dt|rt|ptt|soat)-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Slack incoming webhooks and workflow triggers: the whole URL is the secret.
  [/\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[^\s"'<>`]+/gi, REDACTED],
  // Stripe secret / restricted keys and webhook signing secrets.
  [/\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,})/g, REDACTED],
  // OpenAI (sk-, sk-proj-, sk-svcacct-, sk-admin-) and Anthropic (sk-ant-) keys.
  [/\bsk-(?:proj-|ant-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],

  // Credentials embedded in URLs: scheme://user:SECRET@host. Scheme length is
  // bounded so runs like "a.a.a.a..." don't make every \b a full rescan (#50).
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, `$1${REDACTED}$2`],
  // Token-only userinfo: scheme://TOKEN@host (git remotes with a PAT). Like the
  // supply-chain engine's maskCredentials(), the conventional ssh user "git@"
  // is left alone.
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)(?!git@)[^\s/:@[\]"'<>]+(@)/gi, `$1${REDACTED}$2`],

  // key=value / "key": "value" / 'key': 'value' for secret-looking keys. An
  // auth scheme (Bearer/Basic/Token) before the value is kept with the key; a
  // JSON array value was already handled by the header rule above.
  //
  // Linear time (#50): the key starts only at a word start, the keyword is
  // found by a lookahead, and the key is then one greedy [\w-]+ run. The old
  // \w*?KEYWORD\w* pair re-scanned the rest of the word for every split, so
  // "tokentoken..." without a ":" or "=" took quadratic time.
  [
    /(?<![\w-])((?=[\w-]*?(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|authorization|cookie))[\w-]+["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token)[ \t]+)?)(?!\[["'])[^\s"',;&]+/gi,
    `$1${REDACTED}`,
  ],
  // "auth" only as a whole key (Docker config.json, .npmrc _auth), never as part of "author".
  [/(?<![\w-])(_?auth(["']?)[ \t]*[:=][ \t]*["']?)[^\s"',;&]+/gi, `$1${REDACTED}`],
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
