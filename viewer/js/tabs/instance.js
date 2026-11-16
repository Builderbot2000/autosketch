// Instance tab and setup wizard (docs/design/15-management-ui.md, *Instance tab and first-run setup*).
// Shows the instance in use, how it was chosen, its registry and the live link (read-only), and the
// instances discovery found (`14`) plus a folder field. Choosing writes `instance` to config.toml
// (PUT /api/instance) and, when nothing is loaded yet, loads it in place; switching away from a
// loaded instance takes effect on restart. *Unlink* removes it (DELETE /api/instance), so the next
// start shows the wizard again. With no instance remembered the tab is the setup wizard, and a
// launch `--instance` is listed first, marked as the launch value, ready to keep with one click.

import { h, poller } from "./ui.js";

const loaderText = (l) => (l ? `${l.name}${l.version ? ` ${l.version}` : ""}` : "");
const LAUNCHERS = { curseforge: "CurseForge", prism: "Prism Launcher", multimc: "MultiMC", vanilla: "Minecraft Launcher", modrinth: "Modrinth App", atlauncher: "ATLauncher", gdlauncher: "GDLauncher", pointer: "Autosketch mod", generic: "folder" };

export async function mount(el, ctx) {
  const wrap = h("div", { class: "wrap" });
  el.append(wrap);
  let view = null;
  let message = null; // { text, cls }
  let busy = false;

  async function load(refresh = false) {
    view = await ctx.api(`instance${refresh ? "?refresh=1" : ""}`);
    render();
  }

  async function choose(body, label) {
    if (busy) return;
    busy = true;
    message = { text: `Saving ${label}…`, cls: "msg" };
    render();
    try {
      const r = await ctx.api("instance", { method: "PUT", body: { ...body, hash: view.hash } });
      message = r.standalone
        ? { text: `Saved ${r.name} in config.toml. Autosketch uses it from its next start (a running server with no instance picks it up on its next tool call).`, cls: "msg" }
        : r.loading
        ? { text: `Saved ${r.name} in config.toml. Loading it now; tools start working once it has loaded.`, cls: "msg" }
        : r.restartNeeded
          ? { text: `Saved ${r.name} in config.toml. Another instance is loaded, so restart the MCP server (restart Claude Code, or reconnect the server) to switch.`, cls: "restart" }
          : { text: `Saved ${r.name} in config.toml; it is the one in use.`, cls: "msg" };
    } catch (e) {
      message = { text: e.status === 409 && e.data?.conflict ? "config.toml changed elsewhere since this page read it; reloaded. Choose again." : e.message, cls: "bad" };
    }
    busy = false;
    await load();
  }

  async function unlink() {
    if (!confirm("Unlink this instance? It stays in use until the server restarts; the next start opens this page to choose one.")) return;
    try {
      const r = await ctx.api("instance", { method: "DELETE", body: { hash: view.hash } });
      message = { text: r.note, cls: "msg" };
    } catch (e) {
      message = { text: e.message, cls: "bad" };
    }
    await load();
  }

  function current(c) {
    if (c.state === "none" && view.standalone)
      return h("div", { class: "notice" }, view.saved ? `No MCP server runs here (autosketch ui): ${view.saved.folder} is saved and loads when Autosketch starts.` : "No MCP server runs here (autosketch ui): choose an instance and Autosketch uses it from its next start.");
    if (c.state === "none")
      return h("div", { class: "notice" + (c.error ? " bad" : "") }, c.error ? `Loading ${c.folder} failed: ${c.error}` : "No instance is loaded: tools answer not_configured until one is chosen.");
    const rows = [
      ["Instance", c.name ?? c.folder ?? ""],
      ["Folder", c.folder ?? ""],
      ["Chosen by", c.source?.label ?? ""],
    ];
    if (c.state === "loaded")
      rows.push(
        ["Minecraft", [c.mcVersion, loaderText(c.loader)].filter(Boolean).join(", ")],
        ["Launcher", LAUNCHERS[c.launcher] ?? c.launcher ?? ""],
        ["Game folder", c.gameDir ?? ""],
        ["Mods", String(c.mods ?? 0)],
        ["Asset registry", `${c.blocks ?? 0} blocks${c.warnings?.length ? `, ${c.warnings.length} warning(s)` : ""}`],
      );
    return h(
      "div",
      { class: "setting" },
      h("div", {}, h("div", { class: "key" }, c.state === "loaded" ? "In use" : c.state === "loading" ? "Loading…" : "Failed"), c.error ? h("div", { class: "bad" }, c.error) : null),
      h("table", { class: "kv" }, rows.map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v)))),
      c.warnings?.length ? h("details", { class: "notes" }, h("summary", {}, "Registry warnings"), h("ul", {}, c.warnings.map((w) => h("li", {}, w)))) : null,
    );
  }

  function candidateRow(c, opts = {}) {
    const disabled = !ctx.canWrite() || busy || !c.check?.ok;
    const marks = [];
    if (opts.launch) marks.push(h("span", { class: "source set" }, `launch value (${opts.launch})`));
    if (opts.inUse) marks.push(h("span", { class: "source config" }, "in use"));
    if (opts.saved) marks.push(h("span", { class: "source config" }, "saved"));
    return h(
      "tr",
      {},
      h("td", {}, h("b", {}, c.name), " ", marks, h("div", { class: "dim small" }, c.folder)),
      h("td", {}, [c.mcVersion, loaderText(c.loader)].filter(Boolean).join(", ")),
      h("td", {}, LAUNCHERS[c.launcher] ?? c.launcher ?? ""),
      h("td", {}, c.check ? (c.check.ok ? c.check.detail : h("span", { class: "bad" }, c.check.detail)) : ""),
      h("td", {}, h("button", { disabled, onclick: () => void choose(c.id ? { id: c.id } : { path: c.folder }, c.name) }, opts.launch ? "Keep" : "Choose")),
    );
  }

  function render() {
    const v = view;
    const same = (a, b) => !!a && !!b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
    const inUse = (folder) => v.current.state !== "none" && same(folder, v.current.folder);
    const saved = (folder) => same(folder, v.saved?.folder);
    // The launch value first (15: offered, not imposed), then the rest of what discovery found.
    const launchCandidate = v.launch ? (v.candidates.find((c) => same(c.folder, v.launch.folder) || same(c.gameDir, v.launch.folder)) ?? { name: v.launch.folder.split(/[\\/]/).pop(), folder: v.launch.folder, check: { ok: true, detail: "given on the launch command" } }) : null;
    const others = v.candidates.filter((c) => c !== launchCandidate);
    const pathInput = h("input", { type: "text", placeholder: "instance folder, e.g. C:/Users/me/curseforge/minecraft/Instances/Craftoria", disabled: !ctx.canWrite() });
    const versionInput = h("input", { type: "text", placeholder: "Minecraft version (only if asked)", disabled: !ctx.canWrite() });
    const jarInput = h("input", { type: "text", placeholder: "client jar path (only if asked)", disabled: !ctx.canWrite() });
    wrap.replaceChildren(
      h("h1", {}, v.wizard ? "Choose your Minecraft instance" : "Instance"),
      v.wizard
        ? h("p", {}, "Autosketch reads blocks, textures and models from one of your Minecraft instances (modded included). Choose it below. It is remembered in ", h("code", {}, v.path), " until you unlink it, so this page only asks once.")
        : h("p", { class: "dim" }, "Remembered in ", h("code", {}, v.path), ". Choosing another instance takes effect when the server restarts."),
      ctx.canWrite() ? null : h("div", { class: "notice" }, "Read-only: this page was opened without the server's token. Open the link the server printed (it ends in #t=…) to choose an instance."),
      v.warnings.length ? h("div", { class: "notice bad" }, "Problems in config.toml (saving is refused until they are fixed by hand): ", h("ul", {}, v.warnings.map((w) => h("li", {}, w)))) : null,
      message ? h("div", { class: `notice ${message.cls === "bad" ? "bad" : ""}` }, message.text) : null,
      v.restartNeeded ? h("div", { class: "notice" }, `config.toml names ${v.saved.folder}, but ${v.current.name ?? v.current.folder} is loaded: restart the MCP server to switch.`) : null,
      h("h3", {}, "In use"),
      current(v.current),
      h("div", { class: "dim" }, "Game link: ", v.link ? `${v.link.state}${v.link.dimension ? ` (${v.link.dimension})` : ""}` : "not available", ". The companion mod's own settings are in its config screen in the game."),
      h("h3", {}, "Instances found ", h("button", { onclick: () => void load(true), title: "Look again in the launchers' folders" }, "Refresh")),
      launchCandidate || others.length
        ? h(
            "table",
            { class: "list" },
            h("tr", {}, ["Name", "Minecraft", "Launcher", "Check", ""].map((t) => h("th", {}, t))),
            launchCandidate ? candidateRow(launchCandidate, { launch: v.launch.label, inUse: inUse(launchCandidate.folder), saved: saved(launchCandidate.folder) }) : null,
            others.map((c) => candidateRow(c, { inUse: inUse(c.folder), saved: saved(c.folder) })),
          )
        : h("p", { class: "dim" }, "No instance was found in the known launcher folders. Give its folder below."),
      v.discoveryWarnings.length ? h("details", {}, h("summary", { class: "dim" }, `${v.discoveryWarnings.length} discovery note(s)`), h("ul", {}, v.discoveryWarnings.map((w) => h("li", {}, w)))) : null,
      h("h3", {}, "Another folder"),
      h(
        "div",
        { class: "control" },
        pathInput,
        h("button", { disabled: !ctx.canWrite(), onclick: () => pathInput.value.trim() && void choose({ path: pathInput.value.trim(), version: versionInput.value, baseJar: jarInput.value }, pathInput.value.trim()) }, "Use this folder"),
      ),
      h("details", {}, h("summary", { class: "dim" }, "Version and client jar (only for a plain .minecraft folder or a jar outside the instance)"), h("div", { class: "control" }, versionInput, jarInput)),
      v.saved ? [h("h3", {}, "Unlink"), h("button", { disabled: !ctx.canWrite(), onclick: () => void unlink() }, "Unlink instance"), h("span", { class: "dim" }, " Removes it from config.toml; the next start shows this wizard again.")] : null,
    );
  }

  // Faster while loading, so the page follows the load.
  const poll = poller(() => (busy ? undefined : load()), 2000);
  try {
    await load();
  } catch (e) {
    wrap.replaceChildren(h("div", { class: "notice bad" }, e.status === 404 ? "The instance isn't available here (a finished log is open, with no server session)." : `This tab failed to load: ${e.message}`));
  }
  return { show: () => poll.start(), hide: () => poll.stop() };
}
