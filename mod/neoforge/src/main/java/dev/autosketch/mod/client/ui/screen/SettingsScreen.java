package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The settings screen (16, *Settings screen*; 15, *Settings tab*), generated from the MCP's
 * {@code settings.list} rows, so a new setting shows with no change here. Rows are shown in the
 * order sent, under their {@code group} heading (a group starts where its first row is). Each row:
 * key, summary, source, default, when it applies, the control its {@code control} names (toggle,
 * select, number field with its bounds, list editor, text field), Reset (removes the key from
 * {@code config.toml}, enabled when the value comes from there), and its notes: the launch value it
 * overrides, an invalid file value, a launch error, restart needed.
 *
 * <p>Saving sends {@code settings.set}/{@code settings.unset} with the hash last read; a
 * {@code conflict} reloads the rows and says so on the row. Bounds and values are the MCP's to check:
 * its refusal message is shown on the row as it comes.
 */
public final class SettingsScreen extends PaneScreen {
    private @Nullable JsonObject view;
    private @Nullable Component loadError;
    private final Map<String, Component> messages = new HashMap<>();
    private final Map<String, Integer> messageColours = new HashMap<>();
    private final Map<String, String> selects = new HashMap<>();
    private final Map<String, Integer> listSizes = new HashMap<>();
    private final Map<String, AbstractWidget> controls = new LinkedHashMap<>();
    private int loads;

    public SettingsScreen(@Nullable Screen parent) {
        super(tr("settings.title"), parent);
        load();
    }

    // ── for tests ───────────────────────────────────────────────────────────────────────────────

    /** The main control of each row, by key, in row order (empty until the rows arrived). */
    public Map<String, AbstractWidget> controls() {
        return controls;
    }

    /** How many {@code settings.list} results this screen has taken. */
    public int loads() {
        return loads;
    }

    public @Nullable Component message(String key) {
        return messages.get(key);
    }

    public @Nullable String hash() {
        return view == null ? null : LogListScreen.str(view, "hash");
    }

    // ── requests ────────────────────────────────────────────────────────────────────────────────

    private void load() {
        Requests.send("settings.list", new JsonObject(), r -> {
            loads++;
            if (r.ok()) {
                view = r.result();
                loadError = null;
            } else loadError = Component.literal(r.message());
            refresh();
        });
    }

    void save(String key, String value) {
        if (view == null) return;
        Requests.send("settings.set", Requests.args("key", key, "value", value, "hash", hash()), r -> written(key, r, tr("settings.saved")));
    }

    void reset(String key) {
        if (view == null) return;
        Requests.send("settings.unset", Requests.args("key", key, "hash", hash()), r -> written(key, r, tr("settings.removed")));
    }

    private void written(String key, UiResult r, Component ok) {
        if (r.ok()) {
            messages.put(key, ok);
            messageColours.put(key, GOOD);
            forget("v:" + key);
            forget("l:" + key + ":");
            listSizes.remove(key);
            selects.remove(key);
            if (view != null && r.result().has("hash")) view.add("hash", r.result().get("hash"));
        } else {
            messages.put(key, "conflict".equals(r.error()) ? tr("settings.conflict") : Component.literal(r.message()));
            messageColours.put(key, BAD);
        }
        load();
    }

    // ── layout ──────────────────────────────────────────────────────────────────────────────────

    @Override
    protected void layout() {
        controls.clear();
        Pane p = pane("settings", 12, 26, width - 24, height - 56);
        int bw = 100;
        addRenderableWidget(Button.builder(tr("reload"), b -> load()).bounds(width / 2 - bw - 2, height - 26, bw, 20).build());
        addRenderableWidget(Button.builder(tr("done"), b -> onClose()).bounds(width / 2 + 2, height - 26, bw, 20).build());
        if (loadError != null) {
            wrap(p, 0, 0, loadError, BAD);
            return;
        }
        if (view == null) {
            text(p, 0, 0, tr("loading"), DIM);
            return;
        }
        int y = 0;
        y += wrap(p, 0, y, tr("settings.path", LogListScreen.str(view, "path")), DIM);
        for (String w : strings(view, "warnings")) y += wrap(p, 0, y, tr("settings.warning", w), BAD);
        List<String> unknown = strings(view, "unknown");
        if (!unknown.isEmpty()) y += wrap(p, 0, y, tr("settings.unknown", String.join(", ", unknown)), WARN);
        String group = null;
        for (JsonElement e : view.getAsJsonArray("settings")) {
            JsonObject s = e.getAsJsonObject();
            String g = LogListScreen.str(s, "group");
            if (!g.equals(group)) {
                group = g;
                y += 6;
                text(p, 0, y, Component.literal(g), ACCENT);
                y += LINE + 2;
            }
            y = row(p, s, y) + 6;
        }
    }

    private int row(Pane p, JsonObject s, int y) {
        String key = LogListScreen.str(s, "key");
        text(p, 0, y, Component.literal(key), TEXT);
        y += LINE;
        if (s.has("summary")) y += wrap(p, 4, y, Component.literal(LogListScreen.str(s, "summary")), DIM);
        JsonObject source = s.getAsJsonObject("source");
        Component applies = tr("live".equals(LogListScreen.str(s, "applies")) ? "settings.applies_live" : "settings.applies_restart");
        y += wrap(p, 4, y, tr("settings.meta", LogListScreen.str(source, "label"), fmt(s.get("default")), applies), DIM);
        y += 1;
        int x = 4;
        JsonObject control = s.getAsJsonObject("control");
        String type = LogListScreen.str(control, "type");
        switch (type) {
            case "toggle" -> {
                boolean on = s.get("value").isJsonPrimitive() && s.get("value").getAsBoolean();
                Button b = put(p, Button.builder(MenuScreen.onOff(on), w -> save(key, on ? "false" : "true")).size(60, 18).build(), x, y);
                controls.put(key, b);
                x += 64;
            }
            case "select" -> {
                List<String> options = strings(control, "options");
                String chosen = selects.getOrDefault(key, LogListScreen.str(s, "text"));
                Button b = put(p, Button.builder(Component.literal(chosen), w -> {
                    int i = options.indexOf(selects.getOrDefault(key, LogListScreen.str(s, "text")));
                    if (!options.isEmpty()) selects.put(key, options.get((i + 1) % options.size()));
                    refresh();
                }).size(120, 18).build(), x, y);
                controls.put(key, b);
                x += 124;
                put(p, Button.builder(tr("save"), w -> save(key, selects.getOrDefault(key, LogListScreen.str(s, "text")))).size(40, 18).build(), x, y);
                x += 44;
            }
            case "number", "text" -> {
                Component hint = "number".equals(type) ? tr("settings.bounds", LogListScreen.str(control, "min"), LogListScreen.str(control, "max"))
                        : Component.literal(LogListScreen.str(s, "accepts"));
                EditBox box = put(p, field("v:" + key, 160, LogListScreen.str(s, "text"), hint), x, y + 1);
                if ("number".equals(type)) box.setFilter(t -> t.matches("-?[0-9]*"));
                controls.put(key, box);
                x += 164;
                put(p, Button.builder(tr("save"), w -> save(key, fieldValue("v:" + key, LogListScreen.str(s, "text")))).size(40, 18).build(), x, y);
                x += 44;
            }
            case "list" -> {
                List<String> current = s.get("value").isJsonArray() ? strings(s, "value") : List.of();
                int n = listSizes.getOrDefault(key, current.size());
                for (int i = 0; i < n; i++) {
                    int idx = i;
                    EditBox box = put(p, field("l:" + key + ":" + i, 160, i < current.size() ? current.get(i) : "", Component.empty()), x, y + 1);
                    if (i == 0) controls.put(key, box);
                    put(p, Button.builder(Component.literal("×"), w -> removeItem(key, idx, n, current)).size(18, 18).build(), x + 164, y);
                    y += 20;
                }
                Button add = put(p, Button.builder(Component.literal("+"), w -> {
                    listSizes.put(key, n + 1);
                    refresh();
                }).size(18, 18).build(), x, y);
                controls.putIfAbsent(key, add);
                x += 22;
                put(p, Button.builder(tr("save"), w -> save(key, listValue(key, n, current))).size(40, 18).build(), x, y);
                x += 44;
            }
            default -> {
                text(p, x, y + 4, Component.literal(LogListScreen.str(s, "text")), TEXT);
                x += 164;
            }
        }
        Button reset = put(p, Button.builder(tr("settings.reset"), w -> reset(key)).size(50, 18).build(), x, y);
        reset.active = "config".equals(LogListScreen.str(source, "kind"));
        y += 20;
        if (s.has("overrides")) {
            JsonObject o = s.getAsJsonObject("overrides");
            boolean same = o.has("same") && o.get("same").getAsBoolean();
            y += wrap(p, 4, y, Component.literal(LogListScreen.str(o, "note")), same ? DIM : WARN);
        }
        if (s.has("invalid")) y += wrap(p, 4, y, Component.literal(LogListScreen.str(s.getAsJsonObject("invalid"), "note")), BAD);
        if (s.has("error")) y += wrap(p, 4, y, Component.literal(LogListScreen.str(s, "error")), BAD);
        if (s.has("restartNeeded") && s.get("restartNeeded").getAsBoolean())
            y += wrap(p, 4, y, tr("settings.restart_needed", fmt(s.get("running"))), WARN);
        Component m = messages.get(key);
        if (m != null) y += wrap(p, 4, y, m, messageColours.getOrDefault(key, TEXT));
        return y;
    }

    private String listValue(String key, int n, List<String> current) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            String v = fieldValue("l:" + key + ":" + i, i < current.size() ? current.get(i) : "").trim();
            if (!v.isEmpty()) out.add(v);
        }
        return String.join(", ", out);
    }

    private void removeItem(String key, int idx, int n, List<String> current) {
        List<String> values = new ArrayList<>();
        for (int i = 0; i < n; i++) if (i != idx) values.add(fieldValue("l:" + key + ":" + i, i < current.size() ? current.get(i) : ""));
        forget("l:" + key + ":");
        for (int i = 0; i < values.size(); i++) field("l:" + key + ":" + i, 0, values.get(i), Component.empty());
        listSizes.put(key, values.size());
        refresh();
    }

    /** A value as the row shows it: {@code none} for null or an empty list, a list comma-separated. */
    static String fmt(@Nullable JsonElement v) {
        if (v == null || v.isJsonNull()) return "none";
        if (v.isJsonArray()) {
            JsonArray a = v.getAsJsonArray();
            if (a.isEmpty()) return "none";
            List<String> out = new ArrayList<>();
            for (JsonElement e : a) out.add(e.isJsonPrimitive() ? e.getAsString() : e.toString());
            return String.join(", ", out);
        }
        return v.isJsonPrimitive() ? v.getAsString() : v.toString();
    }

    static List<String> strings(JsonObject o, String key) {
        List<String> out = new ArrayList<>();
        JsonElement e = o.get(key);
        if (e != null && e.isJsonArray()) for (JsonElement x : e.getAsJsonArray()) out.add(x.isJsonPrimitive() ? x.getAsString() : x.toString());
        return out;
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, 10, TEXT);
    }
}
