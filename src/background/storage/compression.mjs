const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function logCompressionWarning(stage, error) {
  console.warn(`[SourceD] ${stage} failed:`, error);
}

async function collectStreamBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = asUint8Array(value);
    if (!chunk || !chunk.byteLength) continue;
    chunks.push(chunk);
    total += chunk.byteLength;
  }

  const result = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return result;
}

async function runTransformStream(StreamCtor, kind, bytes) {
  if (typeof Blob === "function" && typeof Blob.prototype?.stream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new StreamCtor(kind));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }
  const stream = new StreamCtor(kind);
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return collectStreamBytes(stream.readable);
}

export async function encodeBlobContent(content) {
  const text = typeof content === "string" ? content : String(content || "");
  const rawBytes = encoder.encode(text);

  if (!rawBytes.byteLength || typeof CompressionStream !== "function") {
    return {
      content: text,
      compression: "identity",
      storedByteSize: rawBytes.byteLength,
      contentByteSize: rawBytes.byteLength,
    };
  }

  let compressed;
  try {
    compressed = await runTransformStream(CompressionStream, "gzip", rawBytes);
  } catch (error) {
    logCompressionWarning("gzip compression", error);
    return {
      content: text,
      compression: "identity",
      storedByteSize: rawBytes.byteLength,
      contentByteSize: rawBytes.byteLength,
    };
  }
  if (!compressed.byteLength || compressed.byteLength >= rawBytes.byteLength) {
    return {
      content: text,
      compression: "identity",
      storedByteSize: rawBytes.byteLength,
      contentByteSize: rawBytes.byteLength,
    };
  }

  return {
    content: compressed.buffer,
    compression: "gzip",
    storedByteSize: compressed.byteLength,
    contentByteSize: rawBytes.byteLength,
  };
}

export async function decodeBlobContent(record) {
  if (!record || record.content == null) return null;
  if (typeof record.content === "string") return record.content;

  const bytes = asUint8Array(record.content);
  if (!bytes) return String(record.content);

  if (!record.compression || record.compression === "identity") {
    return decoder.decode(bytes);
  }
  if (record.compression === "gzip") {
    if (typeof DecompressionStream !== "function") {
      const rawText = decoder.decode(bytes);
      try {
        JSON.parse(rawText.replace(/^\)\]\}'\s*/, ""));
        console.warn("[SourceD] gzip decompression unavailable; using raw blob text fallback");
        return rawText;
      } catch {
        throw new Error("gzip decompression unavailable");
      }
    }
    try {
      const decompressed = await runTransformStream(DecompressionStream, "gzip", bytes);
      return decoder.decode(decompressed);
    } catch (error) {
      const rawText = decoder.decode(bytes);
      try {
        JSON.parse(rawText.replace(/^\)\]\}'\s*/, ""));
        console.warn("[SourceD] gzip decompression failed, falling back to raw text (data may be uncompressed or corrupted):", error);
        return rawText;
      } catch {
        throw error;
      }
    }
  }
  throw new Error(`Unsupported compression type: ${record.compression}`);
}
