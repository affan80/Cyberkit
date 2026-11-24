/** Turns raw terminal input into key names. One chunk may hold several keys (fast typing, paste). */

const SEQUENCES: ReadonlyArray<readonly [string, string]> = [
  ["\u001b[1~", "home"], ["\u001b[4~", "end"], ["\u001b[5~", "pageup"], ["\u001b[6~", "pagedown"],
  ["\u001b[A", "up"], ["\u001b[B", "down"], ["\u001b[C", "right"], ["\u001b[D", "left"],
  ["\u001b[H", "home"], ["\u001b[F", "end"], ["\u001b[Z", "shift-tab"],
  ["\u001bOA", "up"], ["\u001bOB", "down"], ["\u001bOH", "home"], ["\u001bOF", "end"],
];

const CONTROL: Readonly<Record<string, string>> = {
  "\t": "tab", "\r": "enter", "\n": "enter", "\u007f": "backspace", "\b": "backspace",
  "\u0003": "ctrl-c", "\u0004": "ctrl-d", "\u0015": "ctrl-u",
};

// A CSI sequence: ESC [ params final-byte
// eslint-disable-next-line no-control-regex
const CSI = /^\u001b\[[0-9;?]*[@-~]/;

export function parseKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    if (rest.startsWith("\u001b")) {
      const known = SEQUENCES.find(([seq]) => rest.startsWith(seq));
      if (known) {
        keys.push(known[1]);
        i += known[0].length;
        continue;
      }
      const unknown = CSI.exec(rest);
      if (unknown) {
        i += unknown[0].length; // ignore sequences we don't handle
        continue;
      }
      keys.push("escape");
      i += 1;
      continue;
    }
    const ch = String.fromCodePoint(rest.codePointAt(0) as number);
    i += ch.length;
    const named = CONTROL[ch];
    if (named) keys.push(named);
    else if (ch >= " ") keys.push(ch); // printable; other control bytes are dropped
  }
  return keys;
}
