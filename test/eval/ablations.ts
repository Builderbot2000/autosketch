/**
 * Ablations (docs/design/10-testing.md, tier 3): the main suite rerun with features switched off,
 * by hiding tools with the server's `server.hideTools` setting. This is how we decide which
 * perception features earn their token cost.
 *
 * Hiding a tool removes it from the tool list and names it in the instructions; tool arguments
 * are untouched. Limits that follow from that:
 *  - no_components hides the tools built around components (anchors, prefab stamping). The `as:` argument on ops and `{component}` selections stay available.
 *  - text_only hides the image tools. Ops' optional preview renders stay available.
 *  - images_only hides the exact text perception tools; `doc_info` stays (it is not perception).
 */

export interface Ablation {
  name: string;
  description: string;
  hide: string[];
}

export const ABLATIONS: Ablation[] = [
  { name: "full", description: "every tool", hide: [] },
  { name: "no_analyze", description: "no structural analysis", hide: ["analyze"] },
  { name: "no_components", description: "no anchors or prefab stamping", hide: ["anchor", "stamp"] },
  { name: "text_only", description: "no image tools", hide: ["render", "palette_sheet", "prefab_sheet"] },
  { name: "images_only", description: "no exact text perception", hide: ["analyze", "view_slice", "query_block", "query_column", "query_region", "diff"] },
  { name: "no_palette_sheets", description: "no palette sheet images", hide: ["palette_sheet"] },
];

/** Tools of scoped sessions (11, silo F). Hidden for monolithic runs. */
export const SCOPE_TOOLS = ["scope_fork", "scope_merge", "scope_abandon", "scope_list"];
/** A delegated run needs at least these. */
export const SCOPE_REQUIRED = ["scope_fork", "scope_merge"];

export const ablationByName = (name: string): Ablation | undefined => ABLATIONS.find((a) => a.name === name);
