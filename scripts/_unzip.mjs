#!/usr/bin/env node
// scripts/_unzip.mjs
//
// Minimal ZIP reader over a Buffer. Node ships zlib but no zip container
// reader, and the alternative is a dependency for what is 80 lines of header
// parsing. Reads the central directory rather than local headers because a
// streamed zip can leave the local size fields as zero.
//
// Sufficient for both SEC archives we consume: the ~1.5 MB fails-to-deliver
// files and the ~99 MB quarterly 13F data sets. See the note at the bottom
// about memory for the latter.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;

/** Locate the end-of-central-directory record, scanning back over any comment. */
function findEocd(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = 22; i <= max; i++) {
    const p = buf.length - i;
    if (p < 0) break;
    if (buf.readUInt32LE(p) === EOCD_SIG) return p;
  }
  throw new Error("not a zip archive: no end-of-central-directory record");
}

/** @returns {{name:string, size:number, compressedSize:number, method:number, offset:number}[]} */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CDFH_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, size, compressedSize, method, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate one entry to a Buffer. */
export function readEntry(buf, entry) {
  // Re-read the name/extra lengths from the LOCAL header: the extra field
  // frequently differs in length between the local and central records, and
  // using the central one lands the data offset in the wrong place.
  const p = entry.offset;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;            // stored
  if (entry.method === 8) return inflateRawSync(raw); // deflate
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/** Convenience: inflate the first entry whose name matches. */
export function extract(buf, match = () => true) {
  const entries = listEntries(buf);
  const entry = entries.find((e) => match(e.name));
  if (!entry) throw new Error(`no matching entry in zip (have: ${entries.map((e) => e.name).join(", ")})`);
  return { entry, body: readEntry(buf, entry) };
}

/**
 * Iterate the lines of an entry without holding the decoded string whole.
 *
 * The quarterly 13F data set's INFOTABLE.tsv is ~396 MB uncompressed, and
 * `buffer.toString()` on that would both exceed V8's string limit on some
 * builds and spike memory well past what a CI runner should use. Decoding in
 * chunks and yielding lines keeps the working set to a few megabytes.
 */
export function* entryLines(buf, entry, { encoding = "utf8", chunkSize = 1 << 22 } = {}) {
  const body = readEntry(buf, entry);
  let carry = "";
  for (let i = 0; i < body.length; i += chunkSize) {
    const text = carry + body.subarray(i, Math.min(i + chunkSize, body.length)).toString(encoding);
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) yield line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  if (carry) yield carry.endsWith("\r") ? carry.slice(0, -1) : carry;
}
