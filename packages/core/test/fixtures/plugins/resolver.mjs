// Reports which paths ctx.resolve() accepts inside the worker (#56).
export default {
  name: "resolver",
  async run(ctx) {
    const out = [];
    for (const p of ["src/a.ts", "../outside.txt", "/etc/hosts", "link-out"]) {
      const ok = await ctx.resolve(p).then(() => true, () => false);
      out.push({ ruleId: ok ? "accepted" : "refused", severity: "info", message: p });
    }
    return out;
  },
};
