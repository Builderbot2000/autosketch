import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SchematicUpgrader } from "../../../src/formats/upgrade.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { Session } from "../../../src/server/session.js";

/**
 * docs/ARCHITECTURE.md, *Dependency rules*: `server/index.ts` is the one place that wires `world/`
 * in. The session, tools and ops may name its types, never import its code.
 */

const SRC = join(import.meta.dirname, "../../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("layering", () => {
  it("session, tools and ops import nothing from world/ at runtime", () => {
    const checked = [join(SRC, "server/session.ts"), ...files(join(SRC, "server/tools")), ...files(join(SRC, "ops"))];
    const offenders: string[] = [];
    for (const f of checked) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]*\/world\/[^"]*)";/gms)) offenders.push(`${f.slice(SRC.length + 1)}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the session's upgrader is injected, and schematicVersion uses it", () => {
    const session = new Session("/nonexistent");
    const registry = fakeRegistry([]);
    expect(session.schematicVersion(registry, 3955)).toEqual({ dataVersion: 3955 });
    const upgrader: SchematicUpgrader = { dataVersion: 4189, upgrade: () => Promise.reject(new Error("unused")) };
    session.upgrader = () => upgrader;
    expect(session.schematicVersion(registry, 3955)).toEqual({ dataVersion: 4189, upgrader });
  });
});
