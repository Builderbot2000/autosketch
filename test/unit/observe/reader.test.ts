import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEventLog, readSessionLog, readWorkspaceEvents, resolveSessionDir } from "../../../src/observe/reader.js";

const roots: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-reader-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const line = (seq: number, kind = "doc.checkpoint") => JSON.stringify({ v: 1, seq, t: seq, doc: "base", kind, name: `c${seq}`, jseq: seq }) + "\n";

describe("session log reader (12)", () => {
  it("parses ndjson in seq order, counts dropped markers and skips torn lines", () => {
    const text = line(2) + JSON.stringify({ v: 1, kind: "observe.dropped", t: 0, count: 3 }) + "\n" + line(1) + '{"v":1,"seq":';
    const { events, dropped } = parseEventLog(text);
    expect([...events.keys()].sort()).toEqual([1, 2]);
    expect(dropped).toBe(3);
  });

  it("reads one session folder with its deltas size and snapshots", async () => {
    const ws = temp();
    const dir = join(ws, "keep", "observe", "20261108T000000000Z-abcd");
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "events.ndjson"), line(3) + line(1));
    writeFileSync(join(dir, "deltas.bin"), Buffer.alloc(32));
    writeFileSync(join(dir, "snapshots", "12.png"), "");
    writeFileSync(join(dir, "snapshots", "4.png"), "");
    const log = await readSessionLog(dir);
    expect(log.sessionId).toBe("20261108T000000000Z-abcd");
    expect(log.events.map((e) => e.seq)).toEqual([1, 3]);
    expect(log.deltaBytes).toBe(32);
    expect(log.snapshots).toEqual([{ seq: 4, file: "4.png" }, { seq: 12, file: "12.png" }]);
  });

  it("resolves a session, observe or document folder to the newest session", async () => {
    const ws = temp();
    for (const s of ["20261101T000000000Z-aaaa", "20261102T000000000Z-bbbb"]) {
      mkdirSync(join(ws, "keep", "observe", s), { recursive: true });
      writeFileSync(join(ws, "keep", "observe", s, "events.ndjson"), line(1));
    }
    const newest = join(ws, "keep", "observe", "20261102T000000000Z-bbbb");
    expect(await resolveSessionDir(join(ws, "keep"))).toBe(newest);
    expect(await resolveSessionDir(join(ws, "keep", "observe"))).toBe(newest);
    const older = join(ws, "keep", "observe", "20261101T000000000Z-aaaa");
    expect(await resolveSessionDir(older)).toBe(older);
    await expect(resolveSessionDir(ws)).rejects.toThrow(/no session log/);
  });

  it("merges every session of a workspace by seq (the eval join's input)", async () => {
    const ws = temp();
    mkdirSync(join(ws, "a", "observe", "s"), { recursive: true });
    mkdirSync(join(ws, "b", "observe", "s"), { recursive: true });
    writeFileSync(join(ws, "a", "observe", "s", "events.ndjson"), line(1) + line(4));
    writeFileSync(join(ws, "b", "observe", "s", "events.ndjson"), line(2) + line(3));
    expect((await readWorkspaceEvents(ws)).events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});
