/** Bridge protocol between the MCP and the companion mod (docs/design/13-live-world.md, *Wire format*). */
export * from "./messages.js";
export { encodeMessage, decodeMessage, decodeFrame, splitFrame, ProtocolError } from "./codec.js";
export { FrameReader } from "./frame.js";
export { DEFAULT_VOLATILE, mergeVolatile, isStateOnly, canonicalNbt, nbtHash, hash64, sectionHash, sectionsOf, sectionHashes, type BlockReader } from "./hash.js";
export { encodeNbt, decodeNbt } from "./nbt.js";
export { toSnbt, parseSnbt } from "./snbt.js";
export { isCanonicalForm } from "./state.js";
export { formatPairing, parsePairing, pairingPath, readPairing, writePairing, removePairing, type Pairing } from "./pairing.js";
