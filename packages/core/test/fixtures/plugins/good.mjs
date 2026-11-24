export default {
  name: "good",
  async run(ctx) {
    return [{ ruleId: "demo", severity: "low", message: `scanned ${ctx.root.length > 0 ? "root" : "?"}`, file: "src/a.ts", line: 1 }];
  },
};
