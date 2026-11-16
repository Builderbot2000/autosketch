// Settings tab (docs/design/15-management-ui.md, *Settings tab*). Generated from the server's
// settings registry (GET /api/settings), so a new setting shows up here with no UI change. The
// control follows the setting's parser; each row shows the effective value, where it came from, any
// launch value config.toml overrides, and *restart needed* when the saved value isn't the one the
// server is running with. Saving writes ~/.autosketch/config.toml through the server's
// compare-and-set (PUT /api/settings/<key> with the hash last read); Reset removes the key.
//
// The server watches config.toml, so `autosketch config set` or a hand edit shows here on the next
// poll (every 2 s while the tab is open).

import { h, poller } from "./ui.js";

const fmt = (v) => (v === null || v === undefined ? "none" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : String(v));

export async function mount(el, ctx) {
  const wrap = h("div", { class: "wrap" });
  el.append(wrap);
  let view = null;
  /** key → { text, cls }: the last save's outcome, shown on the row. */
  const messages = new Map();

  const editing = () => el.contains(document.activeElement) && document.activeElement.matches("input[type=text], input[type=number]");

  async function load(force = false) {
    const v = await ctx.api("settings");
    if (!force && view && JSON.stringify(v) === JSON.stringify(view)) return;
    if (!force && editing()) return; // don't replace a field being typed in; the next poll catches up
    view = v;
    render();
  }

  async function save(key, value) {
    await write(key, { method: "PUT", body: { value, hash: view.hash } }, "saved to config.toml");
  }

  async function reset(key) {
    await write(key, { method: "DELETE", body: { hash: view.hash } }, "removed from config.toml");
  }

  async function write(key, opts, ok) {
    try {
      await ctx.api(`settings/${encodeURIComponent(key)}`, opts);
      messages.set(key, { text: ok, cls: "msg" });
    } catch (e) {
      const text = e.status === 409 && e.data?.conflict ? "config.toml changed elsewhere since this page read it; reloaded. Check the value and save again." : e.message;
      messages.set(key, { text, cls: "bad" });
    }
    await load(true);
  }

  function control(s, disabled) {
    const c = s.control;
    if (c.type === "toggle")
      return h("label", {}, h("input", { type: "checkbox", checked: s.value === true, disabled, onchange: (e) => void save(s.key, e.target.checked) }), " ", s.value === true ? "on" : "off");
    if (c.type === "select") {
      const sel = h("select", { disabled, onchange: (e) => void save(s.key, e.target.value) }, c.options.map((o) => h("option", { value: o }, o)));
      sel.value = s.text;
      return sel;
    }
    if (c.type === "list") return listEditor(s, disabled);
    const input = h("input", { type: c.type === "number" ? "number" : "text", value: s.text, placeholder: s.accepts, disabled, onkeydown: (e) => e.key === "Enter" && void save(s.key, input.value) });
    if (c.type === "number") Object.assign(input, { min: c.min, max: c.max, step: 1 });
    return [input, h("button", { disabled, onclick: () => void save(s.key, input.value) }, "Save")];
  }

  function listEditor(s, disabled) {
    const items = h("div", { class: "list-editor" });
    const add = (value = "") =>
      items.append(h("div", { class: "item" }, h("input", { type: "text", value, disabled }), h("button", { disabled, title: "Remove", onclick: (e) => e.target.parentElement.remove() }, "×")));
    for (const v of Array.isArray(s.value) ? s.value : []) add(v);
    const values = () => [...items.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    return [
      items,
      h("button", { disabled, onclick: () => add() }, "+"),
      h("button", { disabled, onclick: () => void save(s.key, values()) }, "Save"),
    ];
  }

  function row(s) {
    const disabled = !ctx.canWrite();
    const notes = [];
    if (s.overrides) notes.push(h("div", { class: s.overrides.same ? "meta" : "over" }, s.overrides.note));
    if (s.invalid) notes.push(h("div", { class: "bad" }, s.invalid.note));
    if (s.error) notes.push(h("div", { class: "bad" }, s.error));
    if (s.restartNeeded) notes.push(h("div", { class: "restart" }, `restart needed: the server is running with ${fmt(s.running)} until it restarts`));
    const msg = messages.get(s.key);
    if (msg) notes.push(h("div", { class: msg.cls }, msg.text));
    return h(
      "div",
      { class: "setting", id: `setting-${s.key}` },
      h(
        "div",
        {},
        h("div", { class: "key" }, s.key),
        s.summary ? h("div", { class: "summary" }, s.summary) : null,
        h("div", { class: "meta" }, h("span", { class: `source ${s.source.kind}` }, s.source.label), ` · default ${fmt(s.default)} · ${s.applies === "live" ? "applies at once" : "applies on restart"}`),
      ),
      h(
        "div",
        { class: "control" },
        control(s, disabled),
        h("button", { disabled: disabled || s.source.kind !== "config", title: "Remove from config.toml, so the launch value or the default applies", onclick: () => void reset(s.key) }, "Reset"),
      ),
      notes.length ? h("div", { class: "notes" }, notes) : null,
    );
  }

  function render() {
    const groups = new Map();
    for (const s of view.settings) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    wrap.replaceChildren(
      h("h1", {}, "Settings"),
      h("div", { class: "dim" }, "Saved in ", h("code", {}, view.path), view.exists ? "" : " (not created yet)", ". A value saved here beats the launch command and the environment; those still apply to every setting not saved here."),
      ctx.canWrite() ? null : h("div", { class: "notice" }, "Read-only: this page was opened without the server's token. Open the link the server printed (it ends in #t=…) to change settings."),
      view.warnings.length ? h("div", { class: "notice bad" }, "Problems in config.toml (saving is refused until they are fixed by hand): ", h("ul", {}, view.warnings.map((w) => h("li", {}, w)))) : null,
      view.unknown.length ? h("div", { class: "notice" }, `config.toml names settings this server doesn't know (ignored): ${view.unknown.join(", ")}`) : null,
      ...[...groups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([group, rows]) => [h("h3", {}, group), ...rows.map(row)]),
    );
  }

  const poll = poller(() => load(), 2000);
  try {
    await load(true);
  } catch (e) {
    wrap.replaceChildren(h("div", { class: "notice bad" }, e.status === 404 ? "Settings aren't available here (a finished log is open, with no server session)." : `Settings failed to load: ${e.message}`));
  }
  return { show: () => (void load(), poll.start()), hide: () => poll.stop() };
}
