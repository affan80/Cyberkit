export default {
  name: "hog",
  run() {
    const keep = [];
    for (;;) keep.push(new Array(1e6).fill(Math.random()));
  },
};
