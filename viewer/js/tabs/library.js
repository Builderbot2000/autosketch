// Library tab (docs/design/15-management-ui.md, *Library tab*): placeholder until phase U3.
// The shell loads this module the first time the tab is opened; U3 replaces `mount`.

import { h } from "./ui.js";

export function mount(el) {
  el.append(h("div", { class: "wrap" }, h("h1", {}, "Library"), h("p", { class: "dim" }, "Browsing and managing library roots, prefabs, palettes, procedures and knowledge packs comes in a later version.")));
}
