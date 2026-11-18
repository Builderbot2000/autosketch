package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The base of the library editors (17, piece 6; 15, *Library tab*, editors), reached from the
 * library screen's entry detail: one subclass per entry kind, each laying out its own form from the
 * entry {@code library.entry} sent. A save sends the kind's {@code library.write.*} request with the
 * {@code hash} the form started from; the MCP answers the file's new hash, which the next save sends
 * (prefab and palette forms load the entry again to show what the MCP normalised; text forms keep
 * editing).
 * A {@code conflict} (the file changed since it was read, e.g. the agent saved it) drops what was
 * typed and loads the entry again, so a file the agent just saved is never overwritten. Any other
 * refusal is shown as the MCP worded it, with the typed values kept.
 *
 * <p>The client checks nothing the MCP decides: values travel as typed (lists split on commas and
 * lines, numbers parsed only to send them as numbers), and the MCP's validation message is shown.
 * Entries the MCP marks {@code editable: false} (a read-only root, a loose schematic file) open
 * without a Save; the library screen offers <i>Copy to my library</i> for them first.
 *
 * <p>Multi-line text is a vanilla {@link MultiLineEditBox} kept across rebuilds (the screens rebuild
 * their widgets on every change), so the cursor and its scroll survive a result arriving.
 *
 * <p>1.21.x: {@code MultiLineEditBox} is built with its constructor here (later versions use a
 * builder) and shows a character counter only when a limit is set, so none is.
 */
public abstract class EntryEditorScreen extends PaneScreen {
    protected final String root, kind, name;
    protected @Nullable JsonObject entry;
    private @Nullable String hash;
    private @Nullable Component loadError;
    private @Nullable Component message;
    private int messageColour = TEXT;
    private int loads, saves;
    private boolean saving;
    private final Map<String, MultiLineEditBox> areas = new HashMap<>();
    private @Nullable String focusedArea;

    protected EntryEditorScreen(@Nullable Screen parent, String root, String kind, String name) {
        super(tr("editor.title", tr("library.kinds_one." + kind), name), parent);
        this.root = root;
        this.kind = kind;
        this.name = name;
        load();
    }

    /** The editor for an entry of {@code kind} ({@code library.list}'s kind names). */
    public static EntryEditorScreen open(@Nullable Screen parent, String root, String kind, String name) {
        return switch (kind) {
            case "prefabs" -> new PrefabEditorScreen(parent, root, name);
            case "palettes" -> new PaletteEditorScreen(parent, root, name);
            case "procedures" -> new ProcedureEditorScreen(parent, root, name);
            case "knowledge" -> new KnowledgeEditorScreen(parent, root, name);
            default -> throw new IllegalArgumentException("no editor for " + kind);
        };
    }

    // ── for tests ───────────────────────────────────────────────────────────────────────────────

    /** How many {@code library.entry} results this editor has taken. */
    public int loads() {
        return loads;
    }

    /** How many writes the MCP accepted. */
    public int saves() {
        return saves;
    }

    /** The hash the next save sends: the loaded entry's, then each accepted write's. */
    public @Nullable String hash() {
        return hash;
    }

    public @Nullable JsonObject entry() {
        return entry;
    }

    public @Nullable Component message() {
        return message;
    }

    /** Whether the loaded entry can be saved here ({@code library.entry}'s {@code editable}). */
    public boolean editable() {
        return entry != null && LibraryScreen.bool(entry, "editable");
    }

    // ── requests ────────────────────────────────────────────────────────────────────────────────

    /** Loads the entry, dropping whatever was typed. */
    protected void load() {
        Requests.send("library.entry", Requests.args("root", root, "kind", kind, "name", name), r -> {
            loads++;
            if (r.ok()) {
                entry = r.result();
                hash = LogListScreen.str(entry, "hash");
                loadError = null;
                forget("");
                areas.clear();
                loaded(entry);
            } else loadError = Component.literal(r.message());
            refresh();
        });
    }

    /** A new entry arrived: reset the form's own state (toggles, row counts) from it. */
    protected void loaded(JsonObject entry) {}

    /**
     * Sends the kind's write with the form's {@code args} plus root, name and the hash it started
     * from. {@code reload} loads the entry after an accepted write (when the file's shape changed,
     * as palettes' members do).
     */
    protected void save(JsonObject args, boolean reload) {
        if (entry == null || saving) return;
        saving = true;
        args.addProperty("root", root);
        args.addProperty("name", name);
        args.addProperty("hash", hash);
        Requests.send("library.write." + writeKind(), args, r -> {
            saving = false;
            written(r, args, reload);
        });
        refresh();
    }

    private String writeKind() {
        return switch (kind) {
            case "prefabs" -> "prefab";
            case "palettes" -> "palette";
            case "procedures" -> "procedure";
            default -> kind;
        };
    }

    private void written(UiResult r, JsonObject args, boolean reload) {
        if (r.ok()) {
            saves++;
            hash = LogListScreen.str(r.result(), "hash");
            // A text write keeps editing on the new hash: what was sent is now the file.
            if (entry != null && args.has("text")) entry.add("text", args.get("text"));
            List<String> warnings = SettingsScreen.strings(r.result(), "warnings");
            say(warnings.isEmpty() ? tr("editor.saved") : tr("editor.saved_warnings", String.join("; ", warnings)), warnings.isEmpty() ? GOOD : WARN);
            if (reload) load();
        } else if ("conflict".equals(r.error())) {
            say(tr("editor.conflict"), BAD);
            load();
        } else say(Component.literal(r.message()), BAD);
    }

    /** Shows a line under the form (a result, or why nothing was sent). */
    protected void say(Component c, int colour) {
        message = c;
        messageColour = colour;
        refresh();
    }

    // ── layout ──────────────────────────────────────────────────────────────────────────────────

    @Override
    protected final void layout() {
        Pane p = pane("form", 12, 26, width - 24, height - 26 - 46);
        int bw = 80;
        Button save = addRenderableWidget(Button.builder(tr("save"), b -> submit()).bounds(width / 2 - bw * 3 / 2 - 4, height - 26, bw, 20).build());
        save.active = editable() && !saving;
        save.visible = entry == null || editable();
        addRenderableWidget(Button.builder(tr("reload"), b -> {
            message = null;
            load();
        }).bounds(width / 2 - bw / 2, height - 26, bw, 20).build());
        addRenderableWidget(Button.builder(tr("done"), b -> onClose()).bounds(width / 2 + bw / 2 + 4, height - 26, bw, 20).build());
        if (loadError != null) {
            wrap(p, 0, 0, loadError, BAD);
            return;
        }
        if (entry == null) {
            text(p, 0, 0, tr("loading"), DIM);
            return;
        }
        int y = 0;
        y += wrap(p, 0, y, Component.literal(root + " / " + kind + " / " + name), DIM);
        if (!editable()) y += wrap(p, 0, y, tr("editor.read_only", root), WARN);
        y += 2;
        form(p, entry, y);
        if (focusedArea != null && areas.containsKey(focusedArea) && areas.get(focusedArea).visible) super.setFocused(areas.get(focusedArea));
    }

    /** Lays out the kind's form for {@code entry} from content row {@code y}. */
    protected abstract void form(Pane p, JsonObject entry, int y);

    /** Collects the form into the kind's write arguments and sends them, or says why it can't. */
    protected abstract void submit();

    /**
     * A multi-line text box under {@code key}, {@code initial} on first use; the same widget is reused
     * across rebuilds while its size stays the same. Its message is {@code key} (tests find it so).
     */
    protected MultiLineEditBox area(String key, int w, int h, String initial, Component placeholder) {
        MultiLineEditBox box = areas.get(key);
        if (box == null || box.getWidth() != w || box.getHeight() != h) {
            String value = box != null ? box.getValue() : fieldValue(key, initial);
            box = new MultiLineEditBox(font, 0, 0, w, h, placeholder, Component.literal(key));
            box.setValue(value);
            setFieldValue(key, value);
            box.setValueListener(v -> setFieldValue(key, v));
            areas.put(key, box);
        }
        return box;
    }

    @Override
    public void setFocused(@Nullable GuiEventListener listener) {
        super.setFocused(listener);
        focusedArea = null;
        if (listener instanceof MultiLineEditBox m) for (Map.Entry<String, MultiLineEditBox> e : areas.entrySet()) if (e.getValue() == m) focusedArea = e.getKey();
    }

    /** The message line, drawn between the form and the buttons. */
    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, 10, TEXT);
        if (saving) g.drawString(font, tr("editor.saving"), 12, height - 42, DIM);
        else if (message != null) {
            var lines = font.split(message, width - 24);
            if (!lines.isEmpty()) g.drawString(font, lines.get(0), 12, height - 42, messageColour);
        }
    }

    // ── helpers for the forms ───────────────────────────────────────────────────────────────────

    static JsonObject obj(@Nullable JsonObject o, String key) {
        return o != null && o.has(key) && o.get(key).isJsonObject() ? o.getAsJsonObject(key) : new JsonObject();
    }

    /** Comma- or line-separated items, trimmed, empties dropped. */
    static List<String> items(String text) {
        return java.util.Arrays.stream(text.split("[,\\n]")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    static com.google.gson.JsonArray array(List<String> items) {
        com.google.gson.JsonArray a = new com.google.gson.JsonArray();
        for (String s : items) a.add(s);
        return a;
    }

    /** {@code name: value} lines of a JSON object whose values are arrays, the array items comma-separated. */
    static String lines(JsonObject o) {
        StringBuilder b = new StringBuilder();
        for (Map.Entry<String, JsonElement> e : o.entrySet()) {
            if (b.length() > 0) b.append('\n');
            b.append(e.getKey()).append(": ").append(String.join(", ", SettingsScreen.strings(o, e.getKey())));
        }
        return b.toString();
    }
}
