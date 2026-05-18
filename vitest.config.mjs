import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import path from "node:path";

const monacoMock = path.resolve("tests/__mocks__/monaco-editor.js");
const monacoReactMock = path.resolve("tests/__mocks__/monaco-react.jsx");

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
        resolve: {
          alias: [
            { find: "@monaco-editor/react", replacement: monacoReactMock },
            { find: /^monaco-editor(\/.*)?$/, replacement: monacoMock },
          ],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
    },
  },
});

