import { initializeRuntime } from "./runtime.mjs";

initializeRuntime().catch((err) => {
  console.warn("[SourceD] init failed:", err && err.message ? err.message : err);
});
