import type { PublicBox } from "./region.js";

/**
 * Observability events (docs/design/12-observability.md, *Event stream*). `document/` and
 * `server/` publish through `EventSink` and never import `observe/`. With observability off they
 * hold `NO_EVENTS`, so an op pays one property check.
 *
 * Events are for the human only: no tool reads them and no tool result depends on them (12,
 * *Principles*). `emit` must return immediately; consumers buffer and drop, never block.
 *
 * The envelope fields (`v`, `seq`, `t`, `doc`) are added by the bus, so emitters pass only `kind`
 * and the payload. Boxes are public inclusive boxes in the base document's local frame. The
 * journal sequence number is `jseq`, because `seq` is the envelope's session-wide counter.
 */

/** Block counts of an op: placed blocks by block id (no properties), and positions cleared to air. */
export interface BlockCounts {
  placed: Record<string, number>;
  removed: number;
}

/**
 * A byte range of `deltas.bin` (12, *Block deltas*): 16-byte records `(x, y, z, stateId)`, int32
 * x/y/z in the emitting document's local frame after the step and uint32 `stateId` from the
 * `state.add` table, little-endian. Added by the delta writer in `observe/`, never by emitters.
 */
export interface DeltaRef {
  offset: number;
  length: number;
}

export type ObserveEvent =
  | { kind: "session.open"; name: string; bounds?: PublicBox; version?: string }
  | { kind: "session.close"; name: string }
  | { kind: "doc.op"; jseq: number; op: string; summary: string; changed: number; box?: PublicBox; counts: BlockCounts; shift?: [number, number, number]; delta?: DeltaRef }
  | { kind: "doc.undo" | "doc.redo"; jseq: number; op: string; changed: number; box?: PublicBox; delta?: DeltaRef }
  | { kind: "state.add"; id: number; state: string }
  | { kind: "doc.checkpoint"; name: string; jseq: number }
  | { kind: "call.start"; call: number; tool: string; scope?: string }
  | { kind: "call.end"; call: number; tool: string; scope?: string; ms: number; ok: boolean; chars: number; images: number; pixels: number }
  | { kind: "call.refused"; call: number; tool: string; scope?: string; code: string; message: string }
  | { kind: "render.produced"; view: string; size: [number, number]; scope?: string; source?: "tool" | "snapshot"; path?: string }
  // Scoped sessions (11): emitted by src/scope/scopes.ts through the parent document's sink.
  | { kind: "scope.fork"; scope: string; parent: string; depth: number; work: PublicBox; context: PublicBox; translation: [number, number, number]; brief: string; [extra: string]: unknown }
  | { kind: "scope.merge"; scope: string; report: string; box?: PublicBox; jseq: number; [extra: string]: unknown }
  | { kind: "scope.abandon"; scope: string; reason: "call" | "restart" };

export type ObserveKind = ObserveEvent["kind"];

/** Envelope added by the bus (12, *Envelope*). */
export interface EventEnvelope {
  v: 1;
  /** Unique within the server session, increasing across all documents. */
  seq: number;
  /** Epoch milliseconds. */
  t: number;
  /** "base" or a scope id. */
  doc: string;
}

export type LoggedEvent = EventEnvelope & ObserveEvent;

export interface EventSink {
  /** False for the no-op sink, so emitters can skip building payloads. */
  readonly enabled: boolean;
  /** Publishes one event. Never throws, never waits. */
  emit(e: ObserveEvent): void;
}

export const NO_EVENTS: EventSink = Object.freeze({ enabled: false, emit() {} });

/**
 * A refusal code on a thrown error (`lock_overlap`, `scope_required`, …, see 12 *Kinds*). The
 * server adapter logs errors that carry one as `call.refused`; the tool result is unchanged.
 */
export function refusalCode(e: unknown): string | undefined {
  const r = (e as { refusal?: unknown } | null)?.refusal;
  return typeof r === "string" && r ? r : undefined;
}
