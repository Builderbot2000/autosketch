package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import org.jetbrains.annotations.Nullable;

/**
 * The library screen (16, *Library screen*; 15, *Library tab*), from {@code library.list}: a Roots
 * tab (roots in search order with their counts, each writable root's trash with Restore and Empty
 * trash), and one tab per kind (prefabs as a thumbnail grid, the others as rows), filtered by text
 * and {@code tag:}, hidden entries shown on request. Each entry carries its flags (root, overrides,
 * shadowed by, hidden). The detail pane shows the selected entry ({@code library.entry}) and its
 * actions: edit (the kind's {@link EntryEditorScreen}, when the MCP says the entry is editable),
 * rename, duplicate and delete in a writable root; copy to my library and hide or unhide in a
 * read-only one. Delete and Empty trash ask first.
 *
 * <p>The prefab grid is a {@link ThumbnailGrid}: the MCP's PNGs ({@code library.thumbnail}), asked
 * for one at a time as cards come into view, loaded as dynamic textures, and freed when the screen
 * closes. Lists keep the MCP's order; only the filter and the hidden switch leave entries out.
 *
 * <p>A selected prefab gets a <b>3D preview</b> in the detail pane, an {@link OrbitPreview}: its
 * {@code library.preview} voxels drawn with an orbit camera the player turns by dragging; meshes are
 * freed when the selection changes or the screen closes.
 */
public final class LibraryScreen extends PaneScreen {
    static final List<String> KINDS = List.of("prefabs", "palettes", "procedures", "knowledge");

    private @Nullable JsonObject view;
    private @Nullable Component loadError;
    private String tab = "prefabs";
    private boolean showHidden;
    private @Nullable JsonObject selected;
    private @Nullable JsonObject entry;
    private @Nullable Component entryError;
    private @Nullable Component message;
    private int messageColour = TEXT;
    private @Nullable String trashOf;
    private @Nullable List<JsonObject> trash;
    private int loads;

    private boolean closed, childOpen, editing;
    private final ThumbnailGrid grid = new ThumbnailGrid(() -> closed);
    private final OrbitPreview preview = new OrbitPreview(this);

    public LibraryScreen(@Nullable Screen parent) {
        super(tr("library.title"), parent);
        load();
    }

    // ── for tests ───────────────────────────────────────────────────────────────────────────────

    public int loads() {
        return loads;
    }

    public String tab() {
        return tab;
    }

    /** Names of the entries the current kind tab shows, in order. */
    public List<String> shown() {
        List<String> out = new ArrayList<>();
        for (JsonObject e : visible()) out.add(LogListScreen.str(e, "name"));
        return out;
    }

    /** How many thumbnails are loaded as textures right now. */
    public int texturesLoaded() {
        return grid.texturesLoaded();
    }

    public @Nullable JsonObject entry() {
        return entry;
    }

    public @Nullable Component message() {
        return message;
    }

    public @Nullable List<JsonObject> trash() {
        return trash;
    }

    /** Draws the cards without their thumbnails (a test compares the grid with and without). */
    public void drawThumbnails(boolean draw) {
        grid.drawThumbnails(draw);
    }

    // ── requests ────────────────────────────────────────────────────────────────────────────────

    private void load() {
        Requests.send("library.list", new JsonObject(), r -> {
            loads++;
            if (r.ok()) {
                view = r.result();
                loadError = null;
                if (selected != null && find(selected) == null) {
                    selected = null;
                    entry = null;
                }
                JsonObject next = pendingSelect == null ? null : find(pendingSelect[0], pendingSelect[1], pendingSelect[2]);
                if (next != null) {
                    pendingSelect = null;
                    tab = s(next, "kind");
                    select(next);
                } else if (selected != null) selected = find(selected);
            } else loadError = Component.literal(r.message());
            refresh();
        });
        if (trashOf != null) loadTrash(trashOf);
    }

    private void loadTrash(String root) {
        Requests.send("library.trash", Requests.args("root", root), r -> {
            if (!root.equals(trashOf)) return;
            if (r.ok()) {
                List<JsonObject> out = new ArrayList<>();
                for (JsonElement e : r.result().getAsJsonArray("trash")) out.add(e.getAsJsonObject());
                trash = out;
            } else say(Component.literal(r.message()), BAD);
            refresh();
        });
    }

    private void select(JsonObject e) {
        selected = e;
        entry = null;
        entryError = null;
        forget("act:");
        resetScroll("detail");
        String root = LogListScreen.str(e, "root"), kind = LogListScreen.str(e, "kind"), name = LogListScreen.str(e, "name");
        preview.close();
        if (kind.equals("prefabs")) preview.load(root, name, () -> !closed && isSelected(e));
        Requests.send("library.entry", Requests.args("root", root, "kind", kind, "name", name), r -> {
            if (!isSelected(e)) return;
            if (r.ok()) entry = r.result();
            else entryError = Component.literal(r.message());
            refresh();
        });
        refresh();
    }

    /**
     * Sends an action and reloads the list after it, saying what happened: the MCP's message when it
     * refused, else {@code ok} with the result.
     */
    private void act(String kind, JsonObject args, java.util.function.Function<JsonObject, Component> ok) {
        Requests.send(kind, args, r -> {
            if (r.ok()) say(ok.apply(r.result()), GOOD);
            else say("conflict".equals(r.error()) ? tr("library.conflict") : Component.literal(r.message()), BAD);
            load();
        });
    }

    private void say(Component c, int colour) {
        message = c;
        messageColour = colour;
        refresh();
    }

    private void rename(JsonObject e, String to) {
        act("library.rename", Requests.args("root", s(e, "root"), "kind", s(e, "kind"), "name", s(e, "name"), "to", to), r -> {
            selectLater(s(e, "root"), s(e, "kind"), LogListScreen.str(r, "name"));
            return tr("library.renamed", s(e, "name"), LogListScreen.str(r, "name"));
        });
    }

    private void duplicate(JsonObject e, String to) {
        act("library.duplicate", Requests.args("root", s(e, "root"), "kind", s(e, "kind"), "name", s(e, "name"), "to", to),
                r -> tr("library.duplicated", s(e, "name"), LogListScreen.str(r, "name")));
    }

    private void delete(JsonObject e) {
        act("library.delete", Requests.args("root", s(e, "root"), "kind", s(e, "kind"), "name", s(e, "name")), r -> {
            selected = null;
            entry = null;
            return tr("library.deleted", s(e, "name"), s(e, "root"));
        });
    }

    private void copy(JsonObject e) {
        act("library.copy", Requests.args("root", s(e, "root"), "kind", s(e, "kind"), "name", s(e, "name")), r -> {
            selectLater(LogListScreen.str(r, "root"), s(e, "kind"), LogListScreen.str(r, "name"));
            return tr("library.copied", s(e, "name"), LogListScreen.str(r, "root"));
        });
    }

    /** Hide or unhide: needs {@code config.toml}'s hash, which only {@code settings.list} carries. */
    private void hide(JsonObject e, boolean hidden) {
        Requests.send("settings.list", new JsonObject(), r -> {
            if (!r.ok()) {
                say(Component.literal(r.message()), BAD);
                return;
            }
            act("library.hide", Requests.args("root", s(e, "root"), "kind", s(e, "kind"), "name", s(e, "name"), "hidden", hidden, "hash", LogListScreen.str(r.result(), "hash")),
                    x -> tr(hidden ? "library.hidden_now" : "library.unhidden_now", s(e, "kind") + "/" + s(e, "name")));
        });
    }

    private void restore(String root, JsonObject item) {
        act("library.restore", Requests.args("root", root, "id", s(item, "id")), r -> tr("library.restored", s(item, "name")));
    }

    private void emptyTrash(String root) {
        act("library.empty_trash", Requests.args("root", root), r -> tr("library.emptied", LogListScreen.str(r, "emptied")));
    }

    private @Nullable String[] pendingSelect;

    /** Selects the entry with this address once the next list holds it (after a rename or copy). */
    private void selectLater(String root, String kind, String name) {
        pendingSelect = new String[] {root, kind, name};
        selected = null;
        entry = null;
    }

    /** Opens the entry's editor (17, piece 6); coming back reloads the list and the entry. */
    private void edit(JsonObject e) {
        childOpen = true;
        editing = true;
        minecraft.setScreen(EntryEditorScreen.open(this, s(e, "root"), s(e, "kind"), s(e, "name")));
    }

    private void confirm(Component title, Component text, Runnable yes) {
        childOpen = true;
        minecraft.setScreen(new ConfirmScreen(ok -> {
            minecraft.setScreen(this);
            if (ok) yes.run();
        }, title, text));
    }

    // ── filtering ───────────────────────────────────────────────────────────────────────────────

    private List<JsonObject> entries(String kind) {
        List<JsonObject> out = new ArrayList<>();
        if (view == null || !view.has("entries")) return out;
        JsonObject all = view.getAsJsonObject("entries");
        if (all.has(kind)) for (JsonElement e : all.getAsJsonArray(kind)) out.add(e.getAsJsonObject());
        return out;
    }

    private List<JsonObject> visible() {
        List<JsonObject> out = new ArrayList<>();
        if (!KINDS.contains(tab)) return out;
        String q = fieldValue("filter", "").trim().toLowerCase(Locale.ROOT);
        for (JsonObject e : entries(tab)) if (matches(e, q)) out.add(e);
        return out;
    }

    private boolean matches(JsonObject e, String q) {
        if (bool(e, "hidden") && !showHidden) return false;
        if (q.isEmpty()) return true;
        List<String> tags = SettingsScreen.strings(e, "tags");
        String hay = (s(e, "name") + " " + s(e, "title") + " " + s(e, "summary") + " " + String.join(" ", tags)).toLowerCase(Locale.ROOT);
        for (String w : q.split("\\s+")) {
            if (w.startsWith("tag:") ? !tags.contains(w.substring(4)) : !hay.contains(w)) return false;
        }
        return true;
    }

    private @Nullable JsonObject find(JsonObject e) {
        return find(s(e, "root"), s(e, "kind"), s(e, "name"));
    }

    private @Nullable JsonObject find(String root, String kind, String name) {
        for (JsonObject x : entries(kind)) if (s(x, "root").equals(root) && s(x, "name").equals(name)) return x;
        return null;
    }

    private boolean isSelected(JsonObject e) {
        return selected != null && s(selected, "root").equals(s(e, "root")) && s(selected, "kind").equals(s(e, "kind")) && s(selected, "name").equals(s(e, "name"));
    }

    // ── layout ──────────────────────────────────────────────────────────────────────────────────

    @Override
    protected void layout() {
        childOpen = false;
        int leftW = Math.max(160, (width - 24) * 11 / 20);
        int x = 8, y = 26;
        addRenderableWidget(Button.builder(tr("library.roots"), b -> tab("roots")).bounds(x, y, font.width(tr("library.roots")) + 10, 18).build()).active = !tab.equals("roots");
        x += font.width(tr("library.roots")) + 12;
        for (String k : KINDS) {
            long n = entries(k).stream().filter(e -> showHidden || !bool(e, "hidden")).count();
            Component label = tr("library.tab", tr("library.kinds." + k), n);
            Button b = addRenderableWidget(Button.builder(label, w -> tab(k)).bounds(x, y, font.width(label) + 10, 18).build());
            b.active = !tab.equals(k);
            x += font.width(label) + 12;
        }
        y += 22;
        EditBox filter = field("filter", Math.min(140, leftW - 90), "", tr("library.filter"));
        filter.setResponder(v -> {
            setFieldValue("filter", v);
            resetScroll("list");
            refresh();
        });
        filter.setX(8);
        filter.setY(y + 1);
        addRenderableWidget(filter);
        addRenderableWidget(Button.builder(tr("library.show_hidden", MenuScreen.onOff(showHidden)), b -> {
            showHidden = !showHidden;
            refresh();
        }).bounds(8 + filter.getWidth() + 4, y, 86, 18).build());
        y += 22;
        Pane list = pane("list", 8, y, leftW, height - y - 30);
        int dx = 8 + leftW + 8;
        Pane detail = pane("detail", dx, 50, width - dx - 8, height - 50 - 30);
        addRenderableWidget(Button.builder(tr("reload"), b -> load()).bounds(width / 2 - 102, height - 26, 100, 20).build());
        addRenderableWidget(Button.builder(tr("done"), b -> onClose()).bounds(width / 2 + 2, height - 26, 100, 20).build());
        if (loadError != null) {
            wrap(list, 0, 0, loadError, BAD);
            return;
        }
        if (view == null) {
            text(list, 0, 0, tr("loading"), DIM);
            return;
        }
        if (tab.equals("roots")) roots(list);
        else if (tab.equals("prefabs")) grid(list);
        else rows(list);
        if (selected != null) detail(detail, selected);
        else if (message == null) wrap(detail, 0, 0, tr("library.hint"), DIM);
    }

    private void tab(String t) {
        tab = t;
        resetScroll("list");
        refresh();
    }

    private void roots(Pane p) {
        int y = 0;
        for (JsonElement el : view.getAsJsonArray("roots")) {
            JsonObject r = el.getAsJsonObject();
            String label = s(r, "label");
            boolean writable = bool(r, "writable");
            text(p, 0, y, Component.literal(label), TEXT);
            text(p, font.width(label) + 6, y, tr(writable ? "library.root_writable" : "library.root_readonly", s(r, "kind")), DIM);
            y += LINE;
            y += wrap(p, 4, y, Component.literal(s(r, "path")), DIM);
            JsonObject counts = r.has("counts") ? r.getAsJsonObject("counts") : new JsonObject();
            List<String> parts = new ArrayList<>();
            for (String k : KINDS) parts.add(tr("library.count", LogListScreen.str(counts, k), tr("library.kinds." + k)).getString());
            y += wrap(p, 4, y, Component.literal(String.join(", ", parts)), DIM);
            if (writable) {
                put(p, Button.builder(tr("library.trash", LogListScreen.str(r, "trash")), b -> {
                    trashOf = label.equals(trashOf) ? null : label;
                    trash = null;
                    if (trashOf != null) loadTrash(label);
                    refresh();
                }).size(90, 18).build(), 4, y);
                y += 20;
                if (label.equals(trashOf)) y = trashList(p, label, y);
            }
            y += 6;
        }
    }

    private int trashList(Pane p, String root, int y) {
        if (trash == null) {
            text(p, 8, y, tr("loading"), DIM);
            return y + LINE;
        }
        if (trash.isEmpty()) {
            text(p, 8, y, tr("library.trash_empty"), DIM);
            return y + LINE;
        }
        for (JsonObject t : trash) {
            put(p, Button.builder(tr("library.restore"), b -> restore(root, t)).size(54, 16).build(), 8, y);
            text(p, 66, y + 4, Component.literal(s(t, "kind") + "/" + s(t, "name") + "  " + s(t, "deletedAt")), TEXT);
            y += 18;
        }
        int n = trash.size();
        put(p, Button.builder(tr("library.empty_trash"), b -> confirm(tr("library.empty_trash"), tr("library.empty_trash_confirm", n, root), () -> emptyTrash(root)))
                .size(90, 18).build(), 8, y);
        return y + 20;
    }

    private void grid(Pane p) {
        List<JsonObject> list = visible();
        if (list.isEmpty()) {
            text(p, 0, 0, tr("library.nothing"), DIM);
            return;
        }
        grid.layout(this, p, list, Card::new);
    }

    private void rows(Pane p) {
        List<JsonObject> list = visible();
        if (list.isEmpty()) {
            text(p, 0, 0, tr("library.nothing"), DIM);
            return;
        }
        int y = 0;
        for (JsonObject e : list) {
            put(p, new Row(e, p.w - 6), 0, y);
            y += 34;
        }
    }

    private void detail(Pane p, JsonObject e) {
        int y = 0;
        text(p, 0, y, Component.literal(s(e, "name")), TEXT);
        y += LINE;
        y += wrap(p, 0, y, tr("library.kinds_one." + s(e, "kind")), DIM);
        y += wrap(p, 0, y, flags(e), TEXT);
        if (s(e, "kind").equals("prefabs")) y = preview.layout(p, y + 2);
        y += 2;
        int w = Math.min(120, p.w - 70);
        if (bool(e, "writable")) {
            put(p, field("act:rename", w, s(e, "name"), Component.empty()), 0, y + 1);
            put(p, Button.builder(tr("library.rename"), b -> rename(e, fieldValue("act:rename", s(e, "name")))).size(64, 18).build(), w + 4, y);
            y += 20;
            put(p, field("act:duplicate", w, s(e, "name") + "_copy", Component.empty()), 0, y + 1);
            put(p, Button.builder(tr("library.duplicate"), b -> duplicate(e, fieldValue("act:duplicate", s(e, "name") + "_copy"))).size(64, 18).build(), w + 4, y);
            y += 20;
            Button edit = put(p, Button.builder(tr("library.edit"), b -> edit(e)).size(64, 18).build(), 0, y);
            edit.active = entry != null && bool(entry, "editable");
            put(p, Button.builder(tr("library.delete"), b -> confirm(tr("library.delete"), tr("library.delete_confirm", s(e, "kind") + "/" + s(e, "name"), s(e, "root")), () -> delete(e)))
                    .size(64, 18).build(), 68, y);
            y += 22;
        } else {
            put(p, Button.builder(tr("library.copy"), b -> copy(e)).size(Math.min(p.w - 4, 120), 18).build(), 0, y);
            y += 20;
            boolean hidden = bool(e, "hidden");
            put(p, Button.builder(tr(hidden ? "library.unhide" : "library.hide"), b -> hide(e, !hidden)).size(64, 18).build(), 0, y);
            y += 22;
        }
        if (message != null) y += wrap(p, 0, y, message, messageColour) + 2;
        if (entryError != null) {
            wrap(p, 0, y, entryError, BAD);
            return;
        }
        if (entry == null) {
            text(p, 0, y, tr("loading"), DIM);
            return;
        }
        String kind = s(e, "kind");
        if (kind.equals("prefabs")) y = prefabMeta(p, y);
        else if (kind.equals("palettes") && entry.has("palette") && entry.get("palette").isJsonObject()) y = palette(p, y);
        else if (entry.has("text")) {
            for (String line : s(entry, "text").split("\n", -1)) y += wrap(p, 0, y, Component.literal(line.isEmpty() ? " " : line), TEXT);
        }
    }

    /** The prefab's {@code prefab.json} fields, as the old tab listed them. */
    private int prefabMeta(Pane p, int y) {
        JsonObject m = entry.has("meta") && entry.get("meta").isJsonObject() ? entry.getAsJsonObject("meta") : new JsonObject();
        String size = "";
        if (m.has("footprint") && m.get("footprint").isJsonArray() && m.getAsJsonArray("footprint").size() == 2)
            size = m.getAsJsonArray("footprint").get(0).getAsString() + "×" + (m.has("height") ? LogListScreen.str(m, "height") : "?") + "×" + m.getAsJsonArray("footprint").get(1).getAsString();
        String[][] rows = {
            {"name", LogListScreen.str(m, "name")}, {"tags", String.join(", ", SettingsScreen.strings(m, "tags"))}, {"front", LogListScreen.str(m, "front")},
            {"size", size}, {"anchors", String.join(", ", keys(m, "anchors"))}, {"roles", String.join(", ", keys(m, "roles"))}, {"notes", LogListScreen.str(m, "notes")}};
        for (String[] r : rows) {
            if (r[1].isEmpty()) continue;
            Component label = tr("library.meta." + r[0]);
            text(p, 0, y, label, DIM);
            y += wrap(p, 50, y, Component.literal(r[1]), TEXT);
        }
        return y;
    }

    private int palette(Pane p, int y) {
        JsonObject pal = entry.getAsJsonObject("palette");
        if (!pal.has("roles") || !pal.get("roles").isJsonObject()) return y;
        for (Map.Entry<String, JsonElement> role : pal.getAsJsonObject("roles").entrySet()) {
            List<String> members = new ArrayList<>();
            if (role.getValue().isJsonArray())
                for (JsonElement me : role.getValue().getAsJsonArray()) {
                    JsonObject mo = me.getAsJsonObject();
                    String block = LogListScreen.str(mo, "block");
                    members.add(mo.has("weight") ? block + " " + Math.round(mo.get("weight").getAsDouble() * 100) + "%" : block);
                }
            text(p, 0, y, Component.literal(role.getKey()), DIM);
            y += wrap(p, 50, y, Component.literal(String.join(", ", members)), TEXT);
        }
        return y;
    }

    private static List<String> keys(JsonObject o, String key) {
        return o.has(key) && o.get(key).isJsonObject() ? new ArrayList<>(o.getAsJsonObject(key).keySet()) : List.of();
    }

    /** The entry's flags: its root, what it overrides, what shadows it, hidden. */
    private Component flags(JsonObject e) {
        MutableComponent c = Component.literal(s(e, "root")).withColor(bool(e, "writable") ? ACCENT : DIM);
        JsonElement over = e.get("overrides");
        if (over != null && !over.isJsonNull()) {
            String text = over.isJsonArray() ? String.join(", ", SettingsScreen.strings(e, "overrides")) : over.getAsString();
            if (!text.isEmpty()) c.append(Component.literal("  ")).append(tr("library.overrides", text).copy().withColor(WARN));
        }
        if (e.has("shadowedBy") && !e.get("shadowedBy").isJsonNull()) c.append(Component.literal("  ")).append(tr("library.shadowed", s(e, "shadowedBy")).copy().withColor(DIM));
        if (bool(e, "hidden")) c.append(Component.literal("  ")).append(tr("library.hidden").copy().withColor(BAD));
        return c;
    }

    // ── 3D preview ──────────────────────────────────────────────────────────────────────────────

    /** Quads of the preview's meshes (0 before it arrived, for tests). */
    public int previewQuads() {
        return preview.quads();
    }

    /** Frames that drew the preview so far (for tests). */
    public int previewDraws() {
        return preview.draws();
    }

    /** The preview square's centre in screen coordinates, or null when none is laid out (for tests). */
    public int @Nullable [] previewCentre() {
        return preview.centre();
    }

    public float[] previewAngles() {
        return preview.angles();
    }

    @Override
    protected void renderPane(GuiGraphics g, Pane p, int mouseX, int mouseY, float partialTick) {
        preview.render(g, p);
    }

    @Override
    public boolean mouseClicked(double mx, double my, int button) {
        boolean dragging = preview.mouseClicked(mx, my, button);
        return super.mouseClicked(mx, my, button) || dragging;
    }

    @Override
    public boolean mouseReleased(double mx, double my, int button) {
        preview.mouseReleased();
        return super.mouseReleased(mx, my, button);
    }

    @Override
    public boolean mouseDragged(double mx, double my, int button, double dx, double dy) {
        return preview.mouseDragged(dx, dy) || super.mouseDragged(mx, my, button, dx, dy);
    }

    @Override
    public void removed() {
        if (childOpen) return; // a confirmation on top; coming back keeps the textures and the preview
        closed = true;
        preview.close();
        grid.release();
    }

    @Override
    public void added() {
        closed = false;
        if (editing) {
            editing = false;
            load();
            if (selected != null) select(selected);
        }
    }

    // ── widgets ─────────────────────────────────────────────────────────────────────────────────

    /** A prefab in the grid: its thumbnail and title; selects on click. Its message is the entry's name. */
    private final class Card extends ThumbnailGrid.Card {
        final JsonObject e;

        Card(JsonObject e) {
            super(grid, s(e, "root"), s(e, "name"));
            this.e = e;
        }

        @Override
        boolean selected() {
            return isSelected(e);
        }

        @Override
        void select() {
            LibraryScreen.this.select(e);
        }

        @Override
        String title() {
            return s(e, "title").isEmpty() ? s(e, "name") : s(e, "title");
        }

        @Override
        int titleColour() {
            return bool(e, "hidden") ? BAD : TEXT;
        }

        @Override
        int mark() {
            return bool(e, "hidden") || e.has("shadowedBy") || e.has("overrides") ? (bool(e, "hidden") ? 0xFFFF6060 : 0xFFFFD060) : 0;
        }
    }

    /** An entry of the other kinds: name and title, summary, flags. Its message is the entry's name. */
    private final class Row extends AbstractWidget {
        final JsonObject e;

        Row(JsonObject e, int width) {
            super(0, 0, width, 32, Component.literal(s(e, "name")));
            this.e = e;
        }

        @Override
        protected void renderWidget(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
            g.fill(getX(), getY(), getX() + width, getY() + height, isSelected(e) ? 0x60FFFFFF : isHovered() ? 0x40FFFFFF : 0x30000000);
            String head = s(e, "name") + (s(e, "title").isEmpty() || s(e, "title").equals(s(e, "name")) ? "" : "  " + s(e, "title"));
            g.drawString(font, font.plainSubstrByWidth(head, width - 4), getX() + 2, getY() + 2, TEXT);
            g.drawString(font, font.plainSubstrByWidth(s(e, "summary"), width - 4), getX() + 2, getY() + 12, DIM);
            List<net.minecraft.util.FormattedCharSequence> f = font.split(flags(e), width - 4);
            if (!f.isEmpty()) g.drawString(font, f.get(0), getX() + 2, getY() + 22, TEXT);
        }

        @Override
        public void onClick(double mouseX, double mouseY) {
            select(e);
        }

        @Override
        protected void updateWidgetNarration(NarrationElementOutput out) {
            defaultButtonNarrationText(out);
        }
    }

    static String s(JsonObject o, String key) {
        return LogListScreen.str(o, key);
    }

    static boolean bool(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() && e.getAsBoolean();
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, 8, TEXT);
        if (message != null && selected == null) g.drawString(font, message, 8 + Math.max(160, (width - 24) * 11 / 20) + 8, 52, messageColour);
    }
}
