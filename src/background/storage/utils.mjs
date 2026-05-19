import { encodeBlobContent } from "./compression.mjs";

export function uniqueBlobId(blobMap, preferredBlobId, content) {
  let candidate = preferredBlobId;
  let suffix = 1;
  while (blobMap[candidate] && blobMap[candidate].content !== content) {
    candidate = `${preferredBlobId}::dup${suffix}`;
    suffix++;
  }
  return candidate;
}

export function storedBlobBytes(blob) {
  if (!blob) return 0;
  return Number(blob.storedByteSize ?? blob.byteSize) || 0;
}

export function storedBytesForRefs(refs, blobLookup = {}) {
  return (refs || []).reduce((sum, ref) => {
    if (!ref) return sum;
    if (ref.storedByteSize != null) return sum + (Number(ref.storedByteSize) || 0);
    if (ref.blobId && blobLookup[ref.blobId]) return sum + storedBlobBytes(blobLookup[ref.blobId]);
    return sum + (Number(ref.byteSize) || 0);
  }, 0);
}

export function withStoredByteSize(meta, refs, blobLookup = {}) {
  return Object.assign({}, meta, {
    storedByteSize: storedBytesForRefs(refs, blobLookup),
  });
}

export async function prepareBlobRecordForStorage(blob) {
  const encoded = await encodeBlobContent(blob.content);
  return Object.assign({}, blob, {
    compression: encoded.compression,
    content: encoded.content,
    storedByteSize: encoded.storedByteSize,
    contentByteSize: encoded.contentByteSize,
  });
}

export async function prepareBlobMapForStorage(blobMap) {
  const prepared = {};
  await Promise.all(Object.keys(blobMap || {}).map(async (blobId) => {
    prepared[blobId] = await prepareBlobRecordForStorage(blobMap[blobId]);
  }));
  return prepared;
}
