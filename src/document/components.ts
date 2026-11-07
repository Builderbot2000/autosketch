import type { Box, Vec3 } from "../core/region.js";

/**
 * Semantic layer (docs/design/04-document.md): named parts such as "tower_ne" so the agent and
 * analysis can refer to parts instead of coordinates. Boxes and anchors are in store coordinates;
 * the document converts them at its boundary. Components are metadata only.
 */
export interface Component {
  id: string;
  kind?: string;
  box: Box;
  parent?: string;
  anchors: Record<string, Vec3>;
  tags: string[];
  notes?: string;
}

const ID = /^[a-z0-9_][a-z0-9_.-]*$/i;

export function checkComponentId(id: string): void {
  if (!ID.test(id)) throw new Error(`component id must be letters, digits, _ . or - (got "${id}")`);
}

export function cloneComponents(list: Iterable<Component>): Component[] {
  return [...list].map((c) => structuredClone(c));
}
