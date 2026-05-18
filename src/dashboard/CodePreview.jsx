import { useEffect, useRef } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import "highlight.js/styles/github.css";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);

const MAX_HIGHLIGHT_CHARS = 200000;

function guessLanguage(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map = { js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", css: "css", scss: "css", less: "css", html: "xml", htm: "xml", svg: "xml", vue: "xml", json: "json" };
  return map[ext] || null;
}

export default function CodePreview({ code, filename }) {
  const codeRef = useRef(null);
  useEffect(() => {
    /* c8 ignore next */
    if (!codeRef.current || !code) return;
    const currentCode = codeRef.current;
    currentCode.textContent = code;
    /* c8 ignore next 2 */
    const lang = guessLanguage(filename || "");
    if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return;
    const timer = setTimeout(() => {
      try {
        const result = hljs.highlight(code, { language: lang });
        currentCode.innerHTML = result.value;
      } catch {
        currentCode.textContent = code;
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [code, filename]);

  return (
    <pre style={{ margin: 0, padding: 12, overflow: "auto", fontSize: 12, lineHeight: 1.5, background: "#f6f8fa", borderRadius: 4, minHeight: 200, maxHeight: "calc(100vh - 200px)" }}>
      <code ref={codeRef} style={{ fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace", whiteSpace: "pre" }} />
    </pre>
  );
}
