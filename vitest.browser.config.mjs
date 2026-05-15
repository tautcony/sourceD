import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.jsx"],
    globals: true,
    setupFiles: ["./tests/setup.browser.js"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [
        {
          browser: "chromium",
        },
      ],
    },
  },
  esbuild: {
    jsx: "automatic",
  },
});
