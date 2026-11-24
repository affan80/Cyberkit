export default {
  name: "spin",
  run() {
    for (;;) {
      /* never yields: only a hard kill can stop this */
    }
  },
};
