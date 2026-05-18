// Stub for @monaco-editor/react in tests — renders a simple <pre><code> so existing assertions work
export default function MockEditor({ value }) {
  return <pre><code>{value ?? ""}</code></pre>;
}
export const loader = { config: () => {} };
