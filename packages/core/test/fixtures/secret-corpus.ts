/**
 * Corpus of fake secrets in the formats redact() must remove. Every value is
 * fake and is assembled at runtime so secret scanners (and GitHub push
 * protection) don't flag the source file.
 *
 * `secret` is the part that must never survive redaction.
 */
const j = (...parts: string[]): string => parts.join("");

export interface SecretCase {
  readonly name: string;
  readonly text: string;
  readonly secret: string;
  /** Issue that added the case, for traceability. */
  readonly issue?: number;
  /** A truncated block with no end marker: redaction runs to the end of the text (fail-safe). */
  readonly toEnd?: boolean;
}

const tok = (name: string, secret: string, issue?: number): SecretCase => ({ name, text: secret, secret, issue });

export const SECRET_CORPUS: readonly SecretCase[] = [
  // Formats that were already covered.
  tok("GitHub classic token", j("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")),
  tok("GitHub fine-grained PAT", j("github_pat_", "A".repeat(30))),
  tok("AWS access key id", j("AKIA", "IOSFODNN7EXAMPLE")),
  tok("Slack bot token", j("xoxb-", "1234567890-abcdefghij")),
  tok("npm token", j("npm_", "a".repeat(36))),

  // Issue #48: common credential formats.
  tok("GitLab PAT", j("glpat-", "Zx9Yw8Vu7Ts6Rq5Po4Nm"), 48),
  tok("GitLab deploy token", j("gldt-", "Zx9Yw8Vu7Ts6Rq5Po4Nm"), 48),
  tok("GitLab runner token", j("glrt-", "Zx9Yw8Vu7Ts6Rq5Po4Nm"), 48),
  tok("Slack webhook", j("https://hooks.slack.com/services/T0001/B0002/", "XyZsecretWebhookPath123"), 48),
  tok("Slack workflow trigger", j("https://hooks.slack.com/triggers/T0001/123/", "abcSecretTriggerPath"), 48),
  tok("Stripe live secret key", j("sk_live_", "51HabcdefGHIJKLmnop"), 48),
  tok("Stripe test secret key", j("sk_test_", "51HabcdefGHIJKLmnop"), 48),
  tok("Stripe restricted key", j("rk_live_", "51HabcdefGHIJKLmnop"), 48),
  tok("Stripe webhook secret", j("whsec_", "AbCdEfGhIjKlMnOpQrStUv"), 48),
  tok("OpenAI project key", j("sk-proj-", "Ab12Cd34Ef56Gh78Ij90KlMnOp"), 48),
  tok("OpenAI legacy key", j("sk-", "Ab12Cd34Ef56Gh78Ij90KlMnOpQrSt"), 48),
  tok("OpenAI service account key", j("sk-svcacct-", "Ab12Cd34Ef56Gh78Ij90KlMn"), 48),
  tok("Anthropic key", j("sk-ant-api03-", "Qw12Er34Ty56Ui78Op90AsDf"), 48),
  tok("Google API key", j("AIza", "SyD-abcdefghijklmnopqrstuvwxyz12345"), 48),
  {
    name: "PGP private key block",
    text: j("-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n", "lQOYBGPGPbody\n-----END PGP PRIVATE KEY BLOCK-----"),
    secret: "lQOYBGPGPbody",
    issue: 48,
  },
  {
    name: "PuTTY private key",
    text: j(
      "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: me\nPublic-Lines: 1\nAAAAPuttyPublic\n",
      "Private-Lines: 1\nAAAAPuttyPrivBody\nPrivate-MAC: 0123abcd",
    ),
    secret: "AAAAPuttyPrivBody",
    issue: 48,
  },
  {
    name: "PuTTY private key without a MAC line (truncated)",
    text: j("PuTTY-User-Key-File-2: ssh-rsa\nPrivate-Lines: 1\n", "AAAAPuttyTruncatedBody"),
    secret: "AAAAPuttyTruncatedBody",
    issue: 48,
    toEnd: true,
  },
];

/** Text that looks a bit like a secret but isn't one, and must survive untouched. */
export const NON_SECRETS: readonly string[] = [
  "task-runner-configuration-v2-enabled",
  "disk-usage-report-for-production-hosts",
  "see sk-learn docs",
  "glpat- is the GitLab token prefix",
  "https://hooks.slack.com/ is the webhook host",
  "AIza is the prefix of Google API keys",
  "-----BEGIN PGP PUBLIC KEY BLOCK-----",
  "PuTTY is an SSH client",
];
