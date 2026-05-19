import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import Editor, { loader } from "@monaco-editor/react";

// Read-only code viewer doesn't require language workers (no IntelliSense/validation).
// A no-op worker suppresses console errors from Monaco's worker bootstrap.
/* c8 ignore next 5 */
if (!globalThis.MonacoEnvironment) {
  globalThis.MonacoEnvironment = {
    getWorker() {
      return new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" })));
    },
  };
}

loader.config({ monaco });

const LANGUAGE_MAP = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  css: "css", scss: "css", less: "less",
  html: "html", htm: "html",
  svg: "xml", vue: "html",
};

function guessLanguage(filename) {
  const ext = filename?.split(".").pop()?.toLowerCase();
  return LANGUAGE_MAP[ext] || "plaintext";
}

const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "off",
  fontSize: 12,
  lineNumbers: "on",
  folding: true,
  renderLineHighlight: "line",
  automaticLayout: true,
  contextmenu: false,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
};

export default function CodePreview({ code, filename }) {
  const language = guessLanguage(filename);
  return (
    <Editor
      height="100%"
      language={language}
      value={code ?? ""}
      options={EDITOR_OPTIONS}
      theme="vs"
    />
  );
}
