import { open, type FileHandle } from "node:fs/promises";

/** Random-access, read-only byte source (a file on disk, a slice of one, or an in-memory buffer). */
export interface ByteSource {
  readonly size: number;
  read(pos: number, len: number): Promise<Buffer>;
}

export class BufferByteSource implements ByteSource {
  constructor(private readonly buf: Buffer) {}
  get size(): number {
    return this.buf.length;
  }
  async read(pos: number, len: number): Promise<Buffer> {
    if (pos < 0 || pos + len > this.buf.length) throw new RangeError(`read out of bounds: ${pos}+${len} > ${this.buf.length}`);
    return this.buf.subarray(pos, pos + len);
  }
}

/** A window into another source, used for stored (uncompressed) jars nested inside jars. */
export class SliceByteSource implements ByteSource {
  constructor(
    private readonly base: ByteSource,
    private readonly offset: number,
    readonly size: number,
  ) {}
  read(pos: number, len: number): Promise<Buffer> {
    if (pos < 0 || pos + len > this.size) return Promise.reject(new RangeError(`slice read out of bounds`));
    return this.base.read(this.offset + pos, len);
  }
}

/**
 * Small LRU pool of open file handles. Big modpacks have hundreds of jars, and keeping all of them
 * open risks hitting fd limits, while reopening for every read is slow on network/WSL mounts.
 */
class HandlePool {
  private readonly handles = new Map<string, Promise<FileHandle>>();
  constructor(private readonly max = 64) {}

  async get(path: string): Promise<FileHandle> {
    const existing = this.handles.get(path);
    if (existing) {
      this.handles.delete(path);
      this.handles.set(path, existing);
      return existing;
    }
    const p = open(path, "r");
    this.handles.set(path, p);
    p.catch(() => this.handles.delete(path));
    while (this.handles.size > this.max) {
      const [oldPath, oldHandle] = this.handles.entries().next().value as [string, Promise<FileHandle>];
      this.handles.delete(oldPath);
      // Delay close slightly so in-flight reads on the evicted handle can finish.
      oldHandle.then((h) => setTimeout(() => void h.close().catch(() => {}), 1000)).catch(() => {});
    }
    return p;
  }

  async closeAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(all.map((p) => p.then((h) => h.close()).catch(() => {})));
  }
}

export const handlePool = new HandlePool();

export class FileByteSource implements ByteSource {
  private constructor(
    readonly path: string,
    readonly size: number,
  ) {}

  static async open(path: string): Promise<FileByteSource> {
    const h = await handlePool.get(path);
    const st = await h.stat();
    return new FileByteSource(path, st.size);
  }

  async read(pos: number, len: number): Promise<Buffer> {
    if (pos < 0 || pos + len > this.size) throw new RangeError(`read out of bounds in ${this.path}: ${pos}+${len} > ${this.size}`);
    const h = await handlePool.get(this.path);
    const buf = Buffer.allocUnsafe(len);
    let done = 0;
    while (done < len) {
      const { bytesRead } = await h.read(buf, done, len - done, pos + done);
      if (bytesRead === 0) throw new Error(`unexpected EOF in ${this.path}`);
      done += bytesRead;
    }
    return buf;
  }
}
