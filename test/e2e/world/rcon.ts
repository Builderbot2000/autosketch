import { connect, type Socket } from "node:net";

/**
 * A minimal RCON client (the Source RCON protocol Minecraft speaks) for the end-to-end world tier:
 * the "player" of the tests. Hand edits are `setblock`/`fill` commands, and volumes are set with the
 * mod's console form of `/autosketch pos1|pos2 <x y z>`. One command at a time.
 */
export class Rcon {
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private waiting?: { id: number; resolve: (body: string) => void; reject: (e: Error) => void; parts: string[] };
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly socket: Socket) {
    socket.on("data", (d: Buffer) => this.onData(d));
    socket.on("close", () => this.waiting?.reject(new Error("rcon connection closed")));
  }

  static async open(port: number, password: string, host = "127.0.0.1"): Promise<Rcon> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host, port }, () => resolve(s));
      s.once("error", reject);
    });
    const r = new Rcon(socket);
    await r.raw(3, password).catch((e: Error) => {
      socket.destroy();
      throw e;
    });
    return r;
  }

  /** Runs a command (without the leading slash) and returns the server's reply text. */
  command(cmd: string): Promise<string> {
    const run = this.chain.then(() => this.raw(2, cmd));
    this.chain = run.catch(() => {});
    return run;
  }

  close(): void {
    this.socket.destroy();
  }

  private raw(type: number, body: string): Promise<string> {
    const id = this.nextId++;
    const payload = Buffer.from(body, "utf8");
    const pkt = Buffer.alloc(14 + payload.length);
    pkt.writeInt32LE(10 + payload.length, 0);
    pkt.writeInt32LE(id, 4);
    pkt.writeInt32LE(type, 8);
    payload.copy(pkt, 12);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`rcon: no reply to "${body}"`)), 30_000);
      this.waiting = {
        id,
        parts: [],
        resolve: (b) => (clearTimeout(timer), resolve(b)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.socket.write(pkt);
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const id = this.buf.readInt32LE(4);
      const body = this.buf.subarray(12, 4 + len - 2).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      const w = this.waiting;
      if (!w) continue;
      if (id === -1) {
        this.waiting = undefined;
        w.reject(new Error("rcon: wrong password"));
      } else if (id === w.id) {
        // Minecraft answers each command in one packet (replies over 4,096 bytes are split, rare here).
        this.waiting = undefined;
        w.resolve(w.parts.join("") + body);
      }
    }
  }
}
