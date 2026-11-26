import { describe, expect, it } from "vitest";
import { parseKeys } from "../src/keys.js";

describe("parseKeys", () => {
  it.each([
    ["\u001b[A", "up"], ["\u001b[B", "down"], ["\u001b[C", "right"], ["\u001b[D", "left"],
    ["\u001b[H", "home"], ["\u001b[1~", "home"], ["\u001b[F", "end"], ["\u001b[4~", "end"],
    ["\u001b[5~", "pageup"], ["\u001b[6~", "pagedown"], ["\u001b[Z", "shift-tab"],
    ["\t", "tab"], ["\r", "enter"], ["\n", "enter"], ["\u007f", "backspace"], ["\b", "backspace"],
    ["\u0003", "ctrl-c"], ["\u0004", "ctrl-d"], ["\u0015", "ctrl-u"], ["\u001b", "escape"],
  ])("maps %j to %s", (input, key) => {
    expect(parseKeys(input)).toEqual([key]);
  });

  it("splits a chunk containing several keys (fast typing / paste)", () => {
    expect(parseKeys("jj\u001b[Bq")).toEqual(["j", "j", "down", "q"]);
  });

  it("passes printable characters through, including unicode", () => {
    expect(parseKeys("/lodé")).toEqual(["/", "l", "o", "d", "é"]);
  });

  it("drops unknown control bytes and unknown escape sequences", () => {
    expect(parseKeys("\u0001\u001b[99~x")).toEqual(["x"]);
  });
});
