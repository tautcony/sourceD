import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    extends: "./vitest.config.mjs",
    test: {
      name: "node",
      include: ["tests/**/*.test.js"],
    },
  },
  {
    extends: "./vitest.browser.config.mjs",
    test: {
      name: "browser",
      include: ["tests/**/*.test.jsx"],
    },
  },
]);
