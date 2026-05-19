import { initializeRuntime } from "./runtime/index.mjs";

initializeRuntime().catch((err) => {
  console.warn("[SourceD] init failed:", err && err.message ? err.message : err);
});
