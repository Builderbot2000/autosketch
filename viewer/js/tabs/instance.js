// Instance tab (docs/design/15-management-ui.md, *Instance tab and first-run setup*): placeholder
// until phase U4. The shell loads this module the first time the tab is opened; U4 replaces `mount`.

import { h } from "./ui.js";

export function mount(el) {
  el.append(h("div", { class: "wrap" }, h("h1", {}, "Instance"), h("p", { class: "dim" }, "Choosing the Minecraft instance from this page comes in a later version. For now, use autosketch --instance <path> or set instance in ~/.autosketch/config.toml.")));
}
