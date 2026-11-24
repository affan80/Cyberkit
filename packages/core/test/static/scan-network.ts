/**
 * Test utility: static detector for network usage in source text.
 * Flags imports/requires of network modules and network globals.
 * Comments are stripped first so documentation can mention them.
 */

const NETWORK_MODULES = new Set([
  "http", "https", "http2", "net", "dns", "tls", "dgram",
  "undici", "axios", "node-fetch", "cross-fetch", "isomorphic-fetch", "got", "ky",
  "ofetch", "superagent", "request", "needle", "ws", "socket.io", "socket.io-client",
]);

const MODULE_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']/g;
const FETCH_CALL = /(?<![\w$.])fetch\s*\(|\bglobalThis\.fetch\b/;
const NETWORK_CONSTRUCTOR = /\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b/g;

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<![:"'\w])\/\/[^\n]*/g, "");
}

export function findNetworkUsage(code: string): string[] {
  const text = stripComments(code);
  const found: string[] = [];

  for (const m of text.matchAll(MODULE_SPECIFIER)) {
    const base = (m[1] ?? "").replace(/^node:/, "").split("/")[0] ?? "";
    if (NETWORK_MODULES.has(base)) found.push(`imports network module "${base}"`);
  }
  if (FETCH_CALL.test(text)) found.push("calls fetch()");
  for (const m of text.matchAll(NETWORK_CONSTRUCTOR)) found.push(`uses new ${m[1]}`);

  return found;
}
