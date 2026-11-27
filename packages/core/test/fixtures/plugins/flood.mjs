// Returns far more items than the host will examine, with a huge message (#52).
export default {
  name: "flood",
  async run() {
    const items = Array.from({ length: 60_000 }, (_, i) => ({ ruleId: "r", severity: "low", message: "m", file: `../x/${i}.js` }));
    items[0] = { ruleId: "big", severity: "low", message: "A".repeat(4 * 1024 * 1024), file: "src/a.ts" };
    return items;
  },
};
