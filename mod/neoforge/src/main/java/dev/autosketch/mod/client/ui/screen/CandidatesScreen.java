package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Checkbox;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The candidates screen (17, piece 4), opened from a reply's clickable line ({@link ReplyActions}):
 * {@code candidates.open {id}} answers with the agent's question and its list, which the screen shows
 * as the question line and a {@link ThumbnailGrid} labelled by cell. Selecting a candidate shows its
 * {@link OrbitPreview}, size, tags and notes, with its tick box and label field. An optional note and
 * <b>Submit</b> send {@code candidates.submit} with the ticked candidates in the list's order; once
 * the MCP took them the screen closes (the MCP clears the candidate ghost). The screen decides
 * nothing: the list, its cells and the request it answers come from the MCP, and the picks go back as
 * they were ticked. A list already answered comes back as the error {@code answered}, which the
 * screen shows in place of the list.
 */
public final class CandidatesScreen extends PaneScreen {
    private final String id;
    private @Nullable JsonObject list;
    private @Nullable Component loadError;
    private boolean answered;
    private @Nullable String selected;
    private final Map<String, Boolean> ticked = new HashMap<>();
    private @Nullable Component message;
    private int messageColour = TEXT;
    private boolean submitting;
    private int loads;
    private final List<String> detailLines = new ArrayList<>();

    private boolean closed;
    private final ThumbnailGrid grid = new ThumbnailGrid(() -> closed);
    private final OrbitPreview preview = new OrbitPreview(this);

    /** Opens the list {@code id} (a candidates id from a reply line's action). */
    public CandidatesScreen(@Nullable Screen parent, String id) {
        super(tr("candidates.title"), parent);
        this.id = id;
        load();
    }

    // ── for tests ───────────────────────────────────────────────────────────────────────────────

    public String id() {
        return id;
    }

    /** Answers to {@code candidates.open} so far. */
    public int loads() {
        return loads;
    }

    /** Whether the MCP said the list was already answered. */
    public boolean answered() {
        return answered;
    }

    /** The question line as shown. */
    public String question() {
        return questionLine().getString();
    }

    /** The cells of the grid, in the list's order. */
    public List<String> cells() {
        List<String> out = new ArrayList<>();
        for (JsonObject e : entries()) out.add(s(e, "cell"));
        return out;
    }

    public @Nullable String selected() {
        return selected;
    }

    /** The ticked cells, in the list's order. */
    public List<String> ticked() {
        List<String> out = new ArrayList<>();
        for (JsonObject e : entries()) if (isTicked(s(e, "cell"))) out.add(s(e, "cell"));
        return out;
    }

    /** The detail pane's text lines from the last layout (name, size, tags, notes). */
    public List<String> detailLines() {
        return List.copyOf(detailLines);
    }

    public @Nullable Component message() {
        return message;
    }

    public @Nullable Component loadError() {
        return loadError;
    }

    public int texturesLoaded() {
        return grid.texturesLoaded();
    }

    public int previewQuads() {
        return preview.quads();
    }

    // ── requests ────────────────────────────────────────────────────────────────────────────────

    private void load() {
        Requests.send("candidates.open", Requests.args("id", id), r -> {
            loads++;
            if (r.ok()) {
                list = r.result();
                loadError = null;
                answered = false;
            } else {
                list = null;
                answered = "answered".equals(r.error());
                loadError = answered ? tr("candidates.answered") : Component.literal(r.message());
            }
            refresh();
        });
    }

    private void select(JsonObject e) {
        String cell = s(e, "cell");
        if (cell.equals(selected)) return;
        selected = cell;
        resetScroll("detail");
        preview.close();
        preview.load(s(e, "root"), s(e, "prefab"), () -> !closed && cell.equals(selected));
        refresh();
    }

    private void submit() {
        JsonArray picks = new JsonArray();
        for (JsonObject e : entries()) {
            String cell = s(e, "cell");
            if (!isTicked(cell)) continue;
            JsonObject pick = new JsonObject();
            pick.addProperty("prefab", s(e, "prefab"));
            pick.addProperty("cell", cell);
            String label = fieldValue(labelKey(cell), "").trim();
            if (!label.isEmpty()) pick.addProperty("label", label);
            picks.add(pick);
        }
        if (picks.isEmpty()) return;
        JsonObject args = Requests.args("id", id, "picks", picks);
        String note = fieldValue("note", "").trim();
        if (!note.isEmpty()) args.addProperty("note", note);
        submitting = true;
        message = null;
        refresh();
        Requests.send("candidates.submit", args, r -> {
            submitting = false;
            if (r.ok()) {
                JsonElement req = r.result() == null ? null : r.result().get("request");
                if (minecraft != null && minecraft.player != null)
                    minecraft.player.displayClientMessage(tr("candidates.sent", req == null || req.isJsonNull() ? "?" : req.getAsString()), true);
                if (minecraft != null && minecraft.screen == this) onClose();
                return;
            }
            if ("answered".equals(r.error())) {
                answered = true;
                list = null;
                loadError = tr("candidates.answered");
            } else {
                message = Component.literal(r.message());
                messageColour = BAD;
            }
            refresh();
        });
    }

    // ── state ───────────────────────────────────────────────────────────────────────────────────

    private List<JsonObject> entries() {
        List<JsonObject> out = new ArrayList<>();
        if (list == null || !list.has("entries") || !list.get("entries").isJsonArray()) return out;
        for (JsonElement e : list.getAsJsonArray("entries")) if (e.isJsonObject()) out.add(e.getAsJsonObject());
        return out;
    }

    private @Nullable JsonObject entry(@Nullable String cell) {
        if (cell == null) return null;
        for (JsonObject e : entries()) if (s(e, "cell").equals(cell)) return e;
        return null;
    }

    private boolean isTicked(String cell) {
        return ticked.getOrDefault(cell, false);
    }

    private static String labelKey(String cell) {
        return "label:" + cell;
    }

    private Component questionLine() {
        if (list == null) return Component.empty();
        String q = s(list, "question");
        return q.isEmpty() ? tr("candidates.no_question") : tr("candidates.question", q);
    }

    // ── layout ──────────────────────────────────────────────────────────────────────────────────

    @Override
    protected void layout() {
        detailLines.clear();
        int leftW = Math.max(160, (width - 24) * 11 / 20);
        int top = 22, bottom = height - 54;
        Pane head = pane("head", 8, top, width - 16, 2 * LINE);
        Pane listPane = pane("list", 8, top + 2 * LINE + 4, leftW, bottom - top - 2 * LINE - 20);
        int dx = 8 + leftW + 8;
        Pane detail = pane("detail", dx, top + 2 * LINE + 4, width - dx - 8, bottom - top - 2 * LINE - 20);
        if (loadError != null || list == null) {
            if (loadError != null) wrap(head, 0, 0, loadError, answered ? WARN : BAD);
            else text(head, 0, 0, tr("loading"), DIM);
            addRenderableWidget(Button.builder(tr("done"), b -> onClose()).bounds(width / 2 - 50, height - 26, 100, 20).build());
            return;
        }
        text(head, 0, 0, questionLine(), TEXT);
        if (list.get("request") == null || list.get("request").isJsonNull()) text(head, 0, LINE, tr("candidates.request_closed"), DIM);
        List<JsonObject> entries = entries();
        if (entries.isEmpty()) text(listPane, 0, 0, tr("candidates.none"), DIM);
        else grid.layout(this, listPane, entries, Card::new);
        JsonObject e = entry(selected);
        if (e != null) detail(detail, e);
        else wrap(detail, 0, 0, tr("candidates.hint"), DIM);

        Pane picks = pane("picks", 8, bottom - 14, width - 16, LINE + 2);
        List<String> chosen = new ArrayList<>();
        for (JsonObject x : entries) {
            String cell = s(x, "cell");
            if (!isTicked(cell)) continue;
            String label = fieldValue(labelKey(cell), "").trim();
            chosen.add(cell + " " + s(x, "prefab") + (label.isEmpty() ? "" : " \"" + label + "\""));
        }
        if (message != null) text(picks, 0, 0, message, messageColour);
        else text(picks, 0, 0, chosen.isEmpty() ? tr("candidates.none_picked") : tr("candidates.picked", String.join(", ", chosen)), chosen.isEmpty() ? DIM : TEXT);

        EditBox note = field("note", width - 16, "", tr("candidates.note"));
        note.setX(8);
        note.setY(bottom + 2);
        addRenderableWidget(note);
        Button submit = addRenderableWidget(Button.builder(tr("candidates.submit"), b -> submit()).bounds(width / 2 - 102, height - 26, 100, 20).build());
        submit.active = !chosen.isEmpty() && !submitting;
        addRenderableWidget(Button.builder(tr("cancel"), b -> onClose()).bounds(width / 2 + 2, height - 26, 100, 20).build());
    }

    private void detail(Pane p, JsonObject e) {
        String cell = s(e, "cell");
        int y = 0;
        line(p, y, Component.literal(cell + "  " + s(e, "prefab")), TEXT);
        y += LINE;
        line(p, y, Component.literal(s(e, "root")), DIM);
        y += LINE + 2;
        put(p, Checkbox.builder(tr("candidates.pick", cell), font).selected(isTicked(cell)).onValueChange((box, on) -> {
            ticked.put(cell, on);
            refresh();
        }).build(), 0, y);
        y += 20;
        int w = Math.min(160, p.w - 6);
        EditBox label = field(labelKey(cell), w, "", tr("candidates.label"));
        label.setResponder(v -> {
            setFieldValue(labelKey(cell), v);
            // A label names a pick: typing one ticks the candidate.
            if (!v.isBlank() && !isTicked(cell)) ticked.put(cell, true);
            refresh();
        });
        put(p, label, 0, y + 1);
        y += 22;
        y = preview.layout(p, y);
        JsonArray size = e.has("size") && e.get("size").isJsonArray() ? e.getAsJsonArray("size") : null;
        if (size != null && size.size() == 3) y = row(p, y, "size", size.get(0).getAsString() + "×" + size.get(1).getAsString() + "×" + size.get(2).getAsString());
        y = row(p, y, "tags", String.join(", ", SettingsScreen.strings(e, "tags")));
        row(p, y, "notes", s(e, "notes"));
    }

    private void line(Pane p, int y, Component c, int colour) {
        text(p, 0, y, c, colour);
        detailLines.add(c.getString());
    }

    private int row(Pane p, int y, String key, String value) {
        if (value.isEmpty()) return y;
        Component label = tr("library.meta." + key);
        text(p, 0, y, label, DIM);
        detailLines.add(label.getString() + " " + value);
        return y + wrap(p, 50, y, Component.literal(value), TEXT);
    }

    // ── preview input, lifetime ─────────────────────────────────────────────────────────────────

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
        closed = true;
        preview.close();
        grid.release();
    }

    @Override
    public void added() {
        closed = false;
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, 8, TEXT);
    }

    /** A candidate in the grid: its thumbnail, titled by cell and prefab; green mark when ticked. Its message is the prefab's name. */
    private final class Card extends ThumbnailGrid.Card {
        final JsonObject e;

        Card(JsonObject e) {
            super(grid, s(e, "root"), s(e, "prefab"));
            this.e = e;
        }

        @Override
        boolean selected() {
            return s(e, "cell").equals(CandidatesScreen.this.selected);
        }

        @Override
        void select() {
            CandidatesScreen.this.select(e);
        }

        @Override
        String title() {
            return s(e, "cell") + " " + s(e, "prefab");
        }

        @Override
        int mark() {
            return isTicked(s(e, "cell")) ? 0xFF60E060 : 0;
        }
    }

    private static String s(JsonObject o, String key) {
        return LogListScreen.str(o, key);
    }
}
