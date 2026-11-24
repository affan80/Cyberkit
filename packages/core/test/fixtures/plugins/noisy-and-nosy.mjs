export default {
  name: "nosy",
  async run() {
    globalThis.console.log("PLUGIN-STDOUT-MARKER");
    globalThis.console.error("PLUGIN-STDERR-MARKER");
    Object.prototype.polluted = "yes";
    globalThis.hostGlobal = "overwritten";
    const env = globalThis.process.env;
    return [{ ruleId: "env", severity: "info", message: `hostvar:${env.CYBERKIT_TEST_SECRET ? "leaked" : "absent"} path:${env.PATH ? "set" : "absent"}` }];
  },
};
