import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.test.js"],
          environment: "jsdom",
          setupFiles: ["./tests/setup.js"],
          globals: true,
        },
        esbuild: { jsx: "automatic" },
      },
      {
        test: {
          name: "browser",
          include: ["tests/**/*.test.jsx"],
          globals: true,
          setupFiles: ["./tests/setup.browser.js"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
        esbuild: { jsx: "automatic" },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});
