// Library tab (docs/design/15-management-ui.md, *Library tab*): the library roots in search order and
// their entries per kind, with where each comes from, what it overrides or is shadowed by, and
// whether it is hidden. Prefabs show their thumbnails and a 3D preview drawn with the Observe tab's
// renderer (loaded only when a preview is opened). Actions: in a writable root rename, duplicate and
// delete (to the root's trash, restorable); in a read-only root (starter, Axiom) copy to my library
// and hide. Entries are addressed as <root>/<kind>/<name>, never by path.

import { h, poller } from "./ui.js";

const KINDS = [["prefabs", "Prefabs"], ["palettes", "Palettes"], ["procedures", "Procedures"], ["knowledge", "Knowledge"]];
const addr = (e) => `library/${encodeURIComponent(e.root)}/${e.kind}/${e.name.split("/").map(encodeURIComponent).join("/")}`;

export async function mount(el, ctx) {
  const wrap = h("div", { class: "wrap wide" });
  el.append(wrap);
  let view = null;
  let kind = "prefabs";
  let filter = "";
  let showHidden = false;
  let selected = null; // { root, kind, name }
  let message = null;
  let trashOf = null; // root label whose trash is open
  let trash = [];
  let preview = null; // { view, key }

  async function load() {
    const v = await ctx.api("library");
    if (view && JSON.stringify(v) === JSON.stringify(view)) return;
    // Don't redraw over an editor in use; a save reloads, and a stale save gets its 409.
    if (view && document.activeElement?.closest?.(".detail")) return;
    view = v;
    if (trashOf) trash = (await ctx.api(`library/${encodeURIComponent(trashOf)}/trash`)).trash;
    render();
  }

  async function act(path, opts, ok) {
    try {
      const r = await ctx.api(path, opts);
      message = { text: ok(r), cls: "msg" };
    } catch (e) {
      message = { text: e.message, cls: "bad" };
    }
    view = null;
    await load();
  }

  const post = (e, action, body) => act(`${addr(e)}/${action}`, { method: "POST", body: body ?? {} }, (r) => describe(action, e, r));

  function describe(action, e, r) {
    if (action === "rename") return `Renamed ${e.name} to ${r.renamed.name}.`;
    if (action === "duplicate") return `Duplicated ${e.name} as ${r.duplicated.name}.`;
    if (action === "copy") return `Copied ${e.name} to ${r.copied.root}; your copy now wins over the original and can be edited.`;
    if (action === "delete") return `Moved ${e.name} to ${e.root}'s trash (restore it from the roots table).`;
    if (action === "hide") return `Hidden ${e.kind}/${e.name}: it no longer shows in any listing (saved in config.toml as library.hidden).`;
    return `${e.kind}/${e.name} shows again.`;
  }

  function flags(e) {
    const out = [h("span", { class: `source ${e.writable ? "config" : ""}` }, e.root)];
    if (e.overrides?.length) out.push(h("span", { class: "source set" }, `overrides ${e.overrides.join(", ")}`));
    if (e.shadowedBy) out.push(h("span", { class: "source" }, `shadowed by ${e.shadowedBy}`));
    if (e.hidden) out.push(h("span", { class: "source env" }, "hidden"));
    return out;
  }

  function actions(e) {
    const dis = !ctx.canWrite();
    if (e.writable)
      return [
        h("button", { disabled: dis, onclick: () => { const to = prompt(`Rename ${e.name} to:`, e.name); if (to && to !== e.name) void post(e, "rename", { to }); } }, "Rename"),
        h("button", { disabled: dis, onclick: () => { const to = prompt(`Duplicate ${e.name} as:`, `${e.name}_copy`); if (to) void post(e, "duplicate", { to }); } }, "Duplicate"),
        h("button", { disabled: dis, onclick: () => void post(e, "delete") }, "Delete"),
      ];
    return [
      h("button", { disabled: dis, onclick: () => void post(e, "copy") }, "Copy to my library"),
      e.hidden ? h("button", { disabled: dis, onclick: () => void post(e, "unhide") }, "Unhide") : h("button", { disabled: dis, onclick: () => void post(e, "hide") }, "Hide"),
    ];
  }

  function matches(e) {
    if (e.hidden && !showHidden) return false;
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return q.split(/\s+/).every((w) => (w.startsWith("tag:") ? e.tags.includes(w.slice(4)) : `${e.name} ${e.title} ${e.summary} ${e.tags.join(" ")}`.toLowerCase().includes(w)));
  }

  function rootsTable() {
    return h(
      "table",
      { class: "list" },
      h("tr", {}, ["Root", "Folder", "Entries", "Trash", ""].map((t) => h("th", {}, t))),
      view.roots.map((r) =>
        h(
          "tr",
          {},
          h("td", {}, h("b", {}, r.label), h("div", { class: "dim small" }, `${r.kind}, ${r.writable ? "writable" : "read-only"}`)),
          h("td", { class: "small" }, r.path),
          h("td", { class: "small" }, KINDS.map(([k, t]) => `${r.counts[k]} ${t.toLowerCase()}`).join(", ")),
          h("td", {}, r.writable ? h("button", { onclick: () => void openTrash(r.label) }, `${r.trash} in trash`) : ""),
          h("td", {}, h("button", { disabled: !ctx.canWrite(), title: "Open in the file manager", onclick: () => void act(`library/${encodeURIComponent(r.label)}/open`, { method: "POST" }, () => `Opened ${r.path}.`) }, "Open folder")),
        ),
      ),
    );
  }

  async function openTrash(label) {
    trashOf = trashOf === label ? null : label;
    trash = trashOf ? (await ctx.api(`library/${encodeURIComponent(label)}/trash`)).trash : [];
    render();
  }

  function trashPanel() {
    if (!trashOf) return null;
    const root = encodeURIComponent(trashOf);
    return h(
      "div",
      { class: "setting" },
      h("div", {}, h("div", { class: "key" }, `${trashOf}'s trash`), h("div", { class: "summary" }, "Deleted entries wait here until the trash is emptied.")),
      h(
        "div",
        {},
        trash.length
          ? h("table", { class: "list" }, trash.map((t) => h("tr", {}, h("td", {}, `${t.kind}/${t.name}`), h("td", { class: "dim small" }, new Date(t.deletedAt).toLocaleString()), h("td", {}, h("button", { disabled: !ctx.canWrite(), onclick: () => void act(`library/${root}/trash/${encodeURIComponent(t.id)}/restore`, { method: "POST" }, () => `Restored ${t.name}.`) }, "Restore")))))
          : h("div", { class: "dim" }, "Empty."),
        trash.length ? h("button", { disabled: !ctx.canWrite(), onclick: () => confirm(`Delete ${trash.length} entr${trash.length === 1 ? "y" : "ies"} for good?`) && void act(`library/${root}/trash`, { method: "DELETE" }, (r) => `Emptied ${r.emptied}.`) }, "Empty trash") : null,
      ),
    );
  }

  function prefabCard(e) {
    const img = h("img", { loading: "lazy", alt: "", src: `api/${addr(e)}?thumb` });
    img.addEventListener("error", () => img.replaceWith(h("div", { class: "nothumb" }, "no thumbnail")));
    return h("div", { class: `card${isSelected(e) ? " selected" : ""}`, onclick: () => select(e) }, img, h("div", { class: "card-name" }, e.title), h("div", { class: "flags" }, flags(e)));
  }

  function row(e) {
    return h("tr", { class: isSelected(e) ? "selected" : "", onclick: () => select(e) }, h("td", {}, h("b", {}, e.name), e.title !== e.name ? h("span", { class: "dim" }, ` ${e.title}`) : null), h("td", { class: "small" }, e.summary), h("td", {}, flags(e)));
  }

  const isSelected = (e) => selected && selected.root === e.root && selected.kind === e.kind && selected.name === e.name;

  function select(e) {
    selected = { root: e.root, kind: e.kind, name: e.name };
    render();
  }

  async function detailPane(e) {
    const pane = h("div", { class: "detail" }, h("h3", {}, `${e.kind.replace(/s$/, "")}: ${e.name}`), h("div", { class: "flags" }, flags(e)), h("div", { class: "control" }, actions(e)));
    try {
      const d = await ctx.api(addr(e));
      const canEdit = d.editable && ctx.canWrite();
      if (e.kind === "prefabs") {
        const m = d.meta ?? {};
        pane.append(
          canEdit
            ? prefabEditor(e, d, m)
            : h("table", { class: "kv" }, [["Name", m.name], ["Tags", (m.tags ?? []).join(", ")], ["Front", m.front ?? ""], ["Size", m.footprint ? `${m.footprint[0]}×${m.height ?? "?"}×${m.footprint[1]}` : ""], ["Anchors", Object.keys(m.anchors ?? {}).join(", ")], ["Roles", Object.keys(m.roles ?? {}).join(", ")], ["Notes", m.notes ?? ""]].map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v ?? "")))),
          h("button", { onclick: (ev) => void showPreview(e, ev.target) }, "3D preview"),
        );
      } else if (e.kind === "palettes" && d.palette) pane.append(canEdit ? paletteEditor(e, d) : paletteTable(d.palette));
      else if (canEdit) {
        const area = h("textarea", { spellcheck: false }, d.text);
        pane.append(area, h("div", { class: "control" }, h("button", { onclick: () => void save(e, { hash: d.hash, text: area.value }) }, "Save")));
      } else pane.append(h("pre", { class: "text" }, d.text));
    } catch (err) {
      pane.append(h("div", { class: "bad" }, err.message));
    }
    return pane;
  }

  // -- editors (U3b): each write sends the hash it started from; a 409 means the file changed meanwhile.

  async function save(e, body) {
    try {
      const r = await ctx.api(addr(e), { method: "PUT", body });
      message = { text: `Saved ${e.name}.${r.warnings?.length ? ` ${r.warnings.join("; ")}` : ""}`, cls: "msg" };
    } catch (err) {
      message = { text: err.status === 409 ? `${err.message}. The version on disk was kept and is shown again.` : err.message, cls: "bad" };
    }
    view = null;
    await load();
  }

  const lines = (obj, fmt) => Object.entries(obj ?? {}).map(([k, v]) => `${k}: ${fmt(v)}`).join("\n");
  const parseLines = (text, parse) => {
    const out = {};
    for (const line of text.split("\n")) {
      const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
      if (m) out[m[1]] = parse(m[2]);
    }
    return out;
  };

  function prefabEditor(e, d, m) {
    const name = h("input", { type: "text", value: m.name ?? e.name });
    const tags = h("input", { type: "text", value: (m.tags ?? []).join(", "), placeholder: "tags, comma-separated" });
    const front = h("select", {}, ["", "north", "south", "east", "west"].map((f) => h("option", { value: f }, f || "(none)")));
    front.value = m.front ?? "";
    const notes = h("textarea", { class: "short" }, m.notes ?? "");
    const anchors = h("textarea", { class: "short", placeholder: "one per line: name: x, y, z" }, lines(m.anchors, (v) => v.join(", ")));
    const roles = h("textarea", { class: "short", placeholder: "one per line: role: block, block" }, lines(m.roles, (v) => v.join(", ")));
    const submit = () => {
      const metadata = {
        name: name.value,
        tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean),
        front: front.value,
        notes: notes.value,
        anchors: parseLines(anchors.value, (v) => v.split(",").map((n) => Number(n.trim()))),
        roles: parseLines(roles.value, (v) => v.split(",").map((b) => b.trim()).filter(Boolean)),
      };
      void save(e, { hash: d.hash, metadata });
    };
    const row = (label, el) => h("tr", {}, h("th", {}, label), h("td", {}, el));
    return h("div", {}, h("table", { class: "kv edit" }, row("Name", name), row("Tags", tags), row("Front", front), row("Notes", notes), row("Anchors", anchors), row("Roles", roles)), h("div", { class: "control" }, h("button", { onclick: submit }, "Save prefab.json")));
  }

  function paletteTable(p) {
    return h("table", { class: "kv" }, Object.entries(p.roles ?? {}).map(([role, ms]) => h("tr", {}, h("th", {}, role), h("td", {}, ms.map((m) => `${m.block.replace(/^minecraft:/, "")} ${Math.round(m.weight * 100)}%`).join(", ")))));
  }

  function paletteEditor(e, d) {
    const p = d.palette;
    const tags = h("input", { type: "text", value: (p.tags ?? []).join(", "), placeholder: "tags, comma-separated" });
    const notes = h("textarea", { class: "short" }, p.notes ?? "");
    const roleEls = Object.entries(p.roles ?? {}).map(([role, ms]) => {
      const rename = h("input", { type: "text", value: role, size: 10 });
      const drop = h("input", { type: "checkbox" });
      const members = ms.map((m) => ({ m, weight: h("input", { type: "number", min: 0.001, step: 0.05, value: Math.round(m.weight * 1000) / 1000, size: 5 }), remove: h("input", { type: "checkbox" }) }));
      const add = h("input", { type: "text", placeholder: "add blocks by id, comma-separated" });
      const el = h(
        "div",
        { class: "role" },
        h("div", { class: "control" }, "Role ", rename, h("label", {}, drop, " drop role")),
        h("table", { class: "kv" }, members.map((x) => h("tr", {}, h("th", {}, h("span", { title: x.m.family }, x.m.block.replace(/^minecraft:/, "")), x.m.color ? h("span", { class: "swatch", style: `background:${x.m.color}` }) : null), h("td", {}, x.weight, " ", h("label", {}, x.remove, " remove"))))),
        add,
      );
      return { role, rename, drop, members, add, el };
    });
    const submit = () => {
      const edit = { weights: {}, remove: {}, drop: [], rename: {} };
      const addBlocks = {};
      for (const r of roleEls) {
        if (r.drop.checked) {
          edit.drop.push(r.role);
          continue;
        }
        const w = {};
        for (const x of r.members) {
          if (x.remove.checked) (edit.remove[r.role] ??= []).push(x.m.block);
          else if (Number(x.weight.value) > 0 && Math.abs(Number(x.weight.value) - x.m.weight) > 1e-6) w[x.m.block] = Number(x.weight.value);
        }
        if (Object.keys(w).length) edit.weights[r.role] = Object.fromEntries(r.members.filter((x) => !x.remove.checked).map((x) => [x.m.block, Number(x.weight.value) || x.m.weight]));
        const ids = r.add.value.split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length) addBlocks[r.role] = ids;
        if (r.rename.value.trim() && r.rename.value.trim() !== r.role) edit.rename[r.role] = r.rename.value.trim();
      }
      for (const k of Object.keys(edit)) if (!Object.keys(edit[k]).length) delete edit[k];
      void save(e, { hash: d.hash, edit, addBlocks, tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean), notes: notes.value });
    };
    return h("div", {}, h("table", { class: "kv edit" }, h("tr", {}, h("th", {}, "Tags"), h("td", {}, tags)), h("tr", {}, h("th", {}, "Notes"), h("td", {}, notes))), roleEls.map((r) => r.el), h("div", { class: "control" }, h("button", { onclick: submit }, "Save palette")), h("div", { class: "dim small" }, "Changing members needs a loaded instance; tags and notes don't."));
  }

  async function showPreview(e, button) {
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const [{ VoxelView }, { VoxelGrid, decodeVoxels }] = await Promise.all([import("../gl.js"), import("../voxels.js")]);
      const r = await ctx.api(`${addr(e)}?preview`);
      const bytes = Uint8Array.from(atob(r.voxels), (c) => c.charCodeAt(0));
      const { header, records } = decodeVoxels(bytes.buffer);
      preview?.view.destroy();
      const canvas = h("canvas", { class: "preview" });
      button.replaceWith(canvas);
      const grid = new VoxelGrid();
      grid.applyRecords(records);
      const view = new VoxelView(canvas, grid);
      preview = { view };
      const states = new Map(Object.entries(header.states).map(([id, s]) => [Number(id), s]));
      view.setModels(r.models?.models ?? {}, states);
      if (r.models && r.models.atlas.version >= 0) {
        const img = new Image();
        img.src = `assets/atlas.png?v=${r.models.atlas.version}`;
        img.decode().then(() => view.setAtlas(img), () => {});
      }
      view.fit(header.bounds ?? grid.bounds());
    } catch (err) {
      button.disabled = false;
      button.textContent = `3D preview failed: ${err.message}`;
    }
  }

  function render() {
    preview?.view.destroy();
    preview = null;
    const sel = selected && (view.entries[selected.kind] ?? []).find((e) => isSelected(e));
    const search = h("input", { type: "text", placeholder: "filter by text, or tag:<tag>", value: filter, oninput: (ev) => { filter = ev.target.value; renderList(); } });
    const listEl = h("div", { class: "entries" });
    const renderList = () => {
      const list = (view.entries[kind] ?? []).filter(matches);
      listEl.replaceChildren(
        list.length === 0 ? h("div", { class: "dim" }, "Nothing here.") : kind === "prefabs" ? h("div", { class: "cards" }, list.map(prefabCard)) : h("table", { class: "list" }, list.map(row)),
      );
    };
    const detail = h("div", {});
    wrap.replaceChildren(
      h("h1", {}, "Library"),
      h("p", { class: "dim" }, "Roots are searched in order; the first one holding a name wins. Your first root is where saves go. Which roots are used is set in Settings (Library)."),
      ctx.canWrite() ? null : h("div", { class: "notice" }, "Read-only: this page was opened without the server's token. Open the link the server printed (it ends in #t=…) to make changes."),
      message ? h("div", { class: `notice ${message.cls === "bad" ? "bad" : ""}` }, message.text) : null,
      h("h3", {}, "Roots"),
      rootsTable(),
      trashPanel(),
      h(
        "nav",
        { class: "kinds" },
        KINDS.map(([k, t]) => h("button", { class: k === kind ? "on" : "", onclick: () => { kind = k; render(); } }, `${t} (${(view.entries[k] ?? []).filter((e) => !e.hidden || showHidden).length})`)),
        search,
        h("label", {}, h("input", { type: "checkbox", checked: showHidden, onchange: (ev) => { showHidden = ev.target.checked; render(); } }), " show hidden"),
      ),
      h("div", { class: "lib-body" }, listEl, detail),
    );
    renderList();
    if (sel) void detailPane(sel).then((p) => detail.replaceChildren(p));
  }

  const poll = poller(() => load(), 4000);
  try {
    await load();
  } catch (e) {
    wrap.replaceChildren(h("div", { class: "notice bad" }, e.status === 404 ? "The library isn't available here." : `This tab failed to load: ${e.message}`));
  }
  return { show: () => poll.start(), hide: () => poll.stop() };
}
