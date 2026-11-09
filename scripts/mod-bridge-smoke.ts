/**
 * Smoke test for the companion mod's bridge (docs/design/13-live-world.md, *Connection and
 * handshake*; silo N's "Done when"). Plays the MCP's side with silo L's codec against a running game
 * that has the mod:
 *
 *   1. a wrong token is refused with `bad_token` and the connection closes;
 *   2. protocol 2 is refused with `protocol_mismatch` carrying the mod's version, and closes;
 *   3. the right token pairs: the mod's `hello`, then `volumes`;
 *   4. then every `volumes` the mod sends is printed while the player marks volumes in-game
 *      (work volume, `context add`, `context grow`, `context clear`, `clear`). With `--extend`, the
 *      first work volume seen is extended by one block upwards with `volumes.extend`.
 *
 * Usage: npx tsx scripts/mod-bridge-smoke.ts <instance dir> [--seconds 120] [--extend]
 * The instance dir is the game (or server) directory holding config/autosketch-bridge.toml.
 */
import { connect, type Socket } from "node:net";
import { DEFAULT_VOLATILE, FrameReader, decodeMessage, encodeMessage, readPairing, type Message, type ModMessage } from "../src/world/protocol/index.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: npx tsx scripts/mod-bridge-smoke.ts <instance dir> [--seconds N] [--extend]");
  process.exit(2);
}
const seconds = Number(args[args.indexOf("--seconds") + 1] ?? 120) || 120;
const extend = args.includes("--extend");

interface Session {
  socket: Socket;
  next(timeoutMs?: number): Promise<ModMessage | "closed">;
  send(m: Message): void;
}

function open(port: number): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const reader = new FrameReader();
    const queue: (ModMessage | "closed")[] = [];
    const waiters: ((m: ModMessage | "closed") => void)[] = [];
    const deliver = (m: ModMessage | "closed") => {
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    };
    socket.on("data", (chunk: Buffer) => {
      for (const payload of reader.push(chunk)) deliver(decodeMessage(payload, "mod"));
    });
    socket.on("close", () => deliver("closed"));
    socket.on("error", reject);
    socket.on("connect", () =>
      resolve({
        socket,
        send: (m) => socket.write(encodeMessage(m)),
        next: (timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const q = queue.shift();
            if (q) return res(q);
            const t = setTimeout(() => rej(new Error(`no message within ${timeoutMs} ms`)), timeoutMs);
            waiters.push((m) => {
              clearTimeout(t);
              res(m);
            });
          }),
      }),
    );
  });
}

function hello(token: string, protocol = 1): Message {
  return { type: "hello", protocol, token, client: { name: "autosketch-smoke", version: "0.0.0" }, volatile: DEFAULT_VOLATILE } as Message;
}

function check(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
}

function box(b: { min: number[]; max: number[] }): string {
  const size = b.max.map((v, i) => v - b.min[i]! + 1).join("×");
  return `${b.min.join(",")}..${b.max.join(",")} (${size})`;
}

const pairing = await readPairing(dir);
console.log(`pairing file: port ${pairing.port}, protocol ${pairing.protocol}`);

{
  const s = await open(pairing.port);
  s.send(hello("0".repeat(64)));
  const m = await s.next();
  check(m !== "closed" && m.type === "error" && m.code === "bad_token", "wrong token refused with bad_token");
  check((await s.next()) === "closed", "and the connection closed");
}
{
  const s = await open(pairing.port);
  s.send(hello(pairing.token, 2));
  const m = await s.next();
  check(m !== "closed" && m.type === "error" && m.code === "protocol_mismatch" && m.protocol === 1, "protocol 2 refused with protocol_mismatch (mod speaks 1)");
  check((await s.next()) === "closed", "and the connection closed");
}

const s = await open(pairing.port);
s.send(hello(pairing.token));
const h = await s.next();
check(h !== "closed" && h.type === "hello", "paired: the mod's hello");
if (h !== "closed" && h.type === "hello" && "game" in h) console.log(`     mod ${h.mod.version}, ${h.game.version} (data ${h.game.dataVersion}), ${h.game.loader} ${h.game.loaderVersion}, singleplayer ${h.singleplayer}`);
const v = await s.next();
check(v !== "closed" && v.type === "volumes", "then volumes");

let extended = false;
let nextId = 1;
const report = (m: ModMessage) => {
  if (m.type !== "volumes") return console.log(`     ${m.type}`);
  if (m.work === null) return console.log(`     volumes: link ${m.link}, no work volume`);
  console.log(`     volumes: link ${m.link}, ${m.dimension}, work ${box(m.work)}${m.extended ? `, extended ${box(m.extended)}` : ""}`);
  for (const c of m.context) console.log(`       context ${box(c)}`);
  if (extend && !extended) {
    extended = true;
    s.send({ type: "volumes.extend", id: nextId++, link: m.link, work: { min: m.work.min, max: [m.work.max[0]!, m.work.max[1]! + 1, m.work.max[2]!] } } as Message);
    console.log("     sent volumes.extend (one block up)");
  }
};
if (v !== "closed") report(v);
console.log(`listening for ${seconds} s: mark volumes in-game (/autosketch wand, pos1, pos2, context add|grow|clear, clear)`);
const end = Date.now() + seconds * 1000;
for (;;) {
  const left = end - Date.now();
  if (left <= 0) break;
  let m: ModMessage | "closed";
  try {
    m = await s.next(left);
  } catch {
    break;
  }
  if (m === "closed") {
    console.log("     the mod closed the connection");
    break;
  }
  report(m);
}
s.socket.end();
