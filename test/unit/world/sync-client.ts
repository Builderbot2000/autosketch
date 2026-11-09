import { connect, type Socket } from "node:net";
import type { Vec3 } from "../../../src/core/region.js";
import { decodeMessage, encodeMessage } from "../../../src/world/protocol/codec.js";
import { FrameReader } from "../../../src/world/protocol/frame.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import type { DirtyMessage, McpMessage, ModMessage, PatchAck, PatchBlock, SectionHash, SnapshotResult, VolatileList, VolumesMessage, WireBox } from "../../../src/world/protocol/messages.js";
import { readPairing } from "../../../src/world/protocol/pairing.js";
import type { WorldSource } from "../../../src/world/sync.js";
import type { FakeHost } from "../../support/fake-host.js";

/**
 * A bare protocol client for the sync tests, standing in for silo P's bridge: requests by id,
 * the latest `volumes`, and the `dirty` notices received. Implements `WorldSource`.
 */
export class SyncClient implements WorldSource {
  readonly inbox: ModMessage[] = [];
  readonly dirty: DirtyMessage[] = [];
  volumes?: VolumesMessage;
  private nextId = 1;
  private readonly waiting = new Map<number, (m: ModMessage) => void>();

  private constructor(
    readonly socket: Socket,
    readonly volatile: VolatileList,
  ) {
    const reader = new FrameReader();
    socket.on("data", (c) => {
      for (const f of reader.push(c)) {
        const m = decodeMessage(f, "mod");
        this.inbox.push(m);
        if (m.type === "volumes") this.volumes = m;
        if (m.type === "dirty") this.dirty.push(m);
        const id = (m as { id?: unknown }).id;
        if (typeof id === "number" && m.type !== "prompt") {
          this.waiting.get(id)?.(m);
          this.waiting.delete(id);
        }
      }
    });
    socket.on("error", () => {});
  }

  static async open(host: FakeHost, volatile: VolatileList = DEFAULT_VOLATILE): Promise<SyncClient> {
    const p = await readPairing(host.instanceDir);
    const socket = connect(p.port, p.host);
    await new Promise<void>((r) => socket.once("connect", () => r()));
    const c = new SyncClient(socket, volatile);
    c.socket.write(encodeMessage({ type: "hello", protocol: p.protocol, token: p.token, client: { name: "test", version: "0" }, volatile }));
    await host.waitFor(() => c.volumes);
    return c;
  }

  get dimension(): string {
    const v = this.volumes;
    if (!v || v.work === null) throw new Error("no volumes");
    return v.dimension;
  }

  private request<T extends ModMessage>(m: McpMessage & { id: number }): Promise<T> {
    return new Promise((resolve, reject) => {
      this.waiting.set(m.id, (r) => (r.type === "error" ? reject(new Error(`${r.code}: ${r.message}`)) : resolve(r as T)));
      this.socket.write(encodeMessage(m));
    });
  }

  async hashes(boxes: WireBox[]): Promise<SectionHash[]> {
    return (await this.request<{ type: "hashes.result"; id: number; sections: SectionHash[] }>({ type: "hashes", id: this.nextId++, dimension: this.dimension, boxes })).sections;
  }

  snapshot(req: { sections: Vec3[] } | { boxes: WireBox[] }): Promise<SnapshotResult> {
    return this.request<SnapshotResult>({ type: "snapshot", id: this.nextId++, dimension: this.dimension, ...req } as McpMessage & { id: number });
  }

  patch(blocks: PatchBlock[], force = false): Promise<PatchAck> {
    const v = this.volumes!;
    return this.request<PatchAck>({ type: "patch", id: this.nextId++, link: v.link, dimension: this.dimension, ...(force ? { force: true } : {}), blocks });
  }

  /** Waits until `n` dirty notices have arrived. */
  async waitDirty(host: FakeHost, n: number): Promise<DirtyMessage[]> {
    await host.waitFor(() => this.dirty.length >= n);
    return this.dirty;
  }

  close(): void {
    this.socket.destroy();
  }
}
