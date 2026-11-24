export default {
  name: "exiter",
  run() {
    globalThis.process.exit(3);
  },
};
