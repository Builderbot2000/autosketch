import { inflateSync } from "fflate";
import { BufferByteSource, FileByteSource, SliceByteSource, type ByteSource } from "./bytes.js";

export interface ZipEntry {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** Byte lengths from the central directory, used to read header + data in one I/O. */
  nameBytes: number;
  extraBytes: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export type EntryFilter = (name: string) => boolean;

/**
 * Zip reader that indexes the central directory only. Entry data is read and inflated on demand.
 * Handles zip64 and jars nested inside jars (jar-in-jar).
 */
export class ZipArchive {
  private constructor(
    readonly label: string,
    private readonly src: ByteSource,
    readonly entries: Map<string, ZipEntry>,
  ) {}

  /** Size (and mtime for files on disk): enough to detect a replaced or updated archive. */
  get fingerprint(): string {
    return this.src instanceof FileByteSource ? `${this.src.size}:${this.src.mtimeMs}` : `${this.src.size}`;
  }

  /** Rebuilds an archive from a previously indexed entry list (see the index cache in pack.ts). */
  static fromEntries(src: ByteSource, label: string, entries: Iterable<ZipEntry>): ZipArchive {
    return new ZipArchive(label, src, new Map([...entries].map((e) => [e.name, e])));
  }

  static async open(src: ByteSource, label: string, filter?: EntryFilter): Promise<ZipArchive> {
    const { cdOffset, cdSize, count } = await findCentralDirectory(src, label);
    const cd = await src.read(cdOffset, cdSize);
    const entries = new Map<string, ZipEntry>();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG_CD) throw new Error(`${label}: bad central directory entry ${i}`);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);

      if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        // zip64 extended info: present only for the fields that overflowed, in this order.
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (size === 0xffffffff) (size = Number(cd.readBigUInt64LE(q))), (q += 8);
            if (compressedSize === 0xffffffff) (compressedSize = Number(cd.readBigUInt64LE(q))), (q += 8);
            if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(cd.readBigUInt64LE(q));
            break;
          }
          e += 4 + len;
        }
      }

      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue; // directory entry
      if (filter && !filter(name)) continue;
      entries.set(name, { name, method, compressedSize, size, localHeaderOffset, nameBytes: nameLen, extraBytes: extraLen });
    }
    return new ZipArchive(label, src, entries);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async read(name: string): Promise<Buffer> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`${this.label}: no entry ${name}`);
    const raw = await this.readRaw(e);
    if (e.method === 0) return raw;
    if (e.method === 8) return Buffer.from(inflateSync(raw, { out: new Uint8Array(e.size) }));
    throw new Error(`${this.label}: unsupported compression method ${e.method} for ${name}`);
  }

  /**
   * Opens a zip nested inside this one. Stored entries are read in place (no copy); deflated ones are
   * inflated into memory.
   */
  async openNested(name: string, filter?: EntryFilter): Promise<ZipArchive> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`${this.label}: no entry ${name}`);
    const label = `${this.label}!/${name}`;
    if (e.method === 0) {
      const start = await this.dataOffset(e);
      return ZipArchive.open(new SliceByteSource(this.src, start, e.size), label, filter);
    }
    return ZipArchive.open(new BufferByteSource(await this.read(name)), label, filter);
  }

  /**
   * Reads an entry's compressed bytes. Guesses the local header's extra-field length from the central
   * directory so header and data usually arrive in a single read (I/O latency dominates on network
   * and WSL mounts).
   */
  private async readRaw(e: ZipEntry): Promise<Buffer> {
    const guess = 30 + e.nameBytes + e.extraBytes;
    const len = Math.min(guess + e.compressedSize, this.src.size - e.localHeaderOffset);
    const buf = await this.src.read(e.localHeaderOffset, len);
    if (buf.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`${this.label}: bad local header for ${e.name}`);
    const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
    if (start + e.compressedSize <= buf.length) return buf.subarray(start, start + e.compressedSize);
    return this.src.read(e.localHeaderOffset + start, e.compressedSize);
  }

  private async dataOffset(e: ZipEntry): Promise<number> {
    const lh = await this.src.read(e.localHeaderOffset, 30);
    if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`${this.label}: bad local header for ${e.name}`);
    return e.localHeaderOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  }
}

async function findCentralDirectory(src: ByteSource, label: string): Promise<{ cdOffset: number; cdSize: number; count: number }> {
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tailStart = src.size - tailLen;
  const tail = await src.read(tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${label}: not a zip file (no end of central directory)`);

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = tailStart + eocd - 20;
    const loc = await src.read(locPos, 20);
    if (loc.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
      const z64Pos = Number(loc.readBigUInt64LE(8));
      const z = await src.read(z64Pos, 56);
      if (z.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error(`${label}: bad zip64 end record`);
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }
  }
  return { cdOffset, cdSize, count };
}
