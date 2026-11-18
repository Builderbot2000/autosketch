package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.List;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The prefab editor (17, piece 6): the fields of {@code prefab.json} the MCP lets the player change
 * (name, tags, front, notes, anchors, roles; {@code 13}'s {@code library.write.prefab}). Anchors and
 * roles are edited as lines, {@code name: x, y, z} and {@code role: block, block}, as the browser
 * editor had them. Only the fields that differ from the loaded entry are sent as {@code meta}, so
 * the file keeps everything else as it was. The blocks themselves aren't edited here: stamp, edit,
 * {@code prefab_save} with {@code overwrite}.
 */
public final class PrefabEditorScreen extends EntryEditorScreen {
    static final List<String> FRONTS = List.of("", "north", "south", "east", "west");
    private String front = "";

    PrefabEditorScreen(@Nullable Screen parent, String root, String name) {
        super(parent, root, "prefabs", name);
    }

    private JsonObject meta() {
        return obj(entry, "meta");
    }

    @Override
    protected void loaded(JsonObject entry) {
        front = LogListScreen.str(obj(entry, "meta"), "front");
    }

    @Override
    protected void form(Pane p, JsonObject entry, int y) {
        JsonObject m = meta();
        int fx = 56, w = Math.max(80, Math.min(260, p.w - fx - 8));
        y = row(p, "meta.name", field("name", w, m.has("name") ? LogListScreen.str(m, "name") : name, Component.empty()), fx, y, 1);
        y = row(p, "meta.tags", field("tags", w, String.join(", ", SettingsScreen.strings(m, "tags")), tr("editor.comma_list")), fx, y, 1);
        y = row(p, "meta.front", Button.builder(front.isEmpty() ? tr("editor.front_none") : Component.literal(front), b -> {
            front = FRONTS.get((FRONTS.indexOf(front) + 1) % FRONTS.size());
            refresh();
        }).size(80, 18).build(), fx, y, 0);
        y = row(p, "meta.notes", area("notes", w, 36, LogListScreen.str(m, "notes"), Component.empty()), fx, y, 0);
        y = row(p, "meta.anchors", area("anchors", w, 46, anchorLines(obj(m, "anchors")), tr("editor.anchors_hint")), fx, y, 0);
        y = row(p, "meta.roles", area("roles", w, 46, lines(obj(m, "roles")), tr("editor.roles_hint")), fx, y, 0);
        wrap(p, 0, y, tr("editor.prefab_blocks"), DIM);
    }

    /** A label and its control on one row; returns the next row. */
    private int row(Pane p, String key, net.minecraft.client.gui.components.AbstractWidget w, int x, int y, int dy) {
        text(p, 0, y + 5, tr("library." + key), DIM);
        put(p, w, x, y + dy);
        return y + Math.max(20, w.getHeight() + 4);
    }

    private static String anchorLines(JsonObject anchors) {
        StringBuilder b = new StringBuilder();
        for (var e : anchors.entrySet()) {
            if (b.length() > 0) b.append('\n');
            b.append(e.getKey()).append(": ");
            if (e.getValue().isJsonArray()) {
                List<String> n = new java.util.ArrayList<>();
                for (JsonElement x : e.getValue().getAsJsonArray()) n.add(x.getAsString());
                b.append(String.join(", ", n));
            } else b.append(e.getValue());
        }
        return b.toString();
    }

    @Override
    protected void submit() {
        JsonObject m = meta();
        JsonObject out = new JsonObject();
        String oldName = m.has("name") ? LogListScreen.str(m, "name") : name, newName = fieldValue("name", oldName).trim();
        if (!newName.equals(oldName)) out.addProperty("name", newName);
        List<String> tags = items(fieldValue("tags", ""));
        if (!tags.equals(SettingsScreen.strings(m, "tags"))) out.add("tags", array(tags));
        if (!front.equals(LogListScreen.str(m, "front"))) out.addProperty("front", front);
        String notes = fieldValue("notes", LogListScreen.str(m, "notes"));
        if (!notes.equals(LogListScreen.str(m, "notes"))) out.addProperty("notes", notes);
        JsonObject anchors = new JsonObject();
        for (String line : fieldValue("anchors", "").split("\n")) {
            if (line.isBlank()) continue;
            int c = line.indexOf(':');
            String[] xyz = c < 0 ? new String[0] : line.substring(c + 1).split(",");
            JsonArray v = new JsonArray();
            try {
                for (String n : xyz) v.add(Integer.parseInt(n.trim()));
            } catch (NumberFormatException e) {
                v = null;
            }
            if (c < 0 || v == null || v.size() != 3) {
                say(tr("editor.bad_anchor", line.trim()), BAD);
                return;
            }
            anchors.add(line.substring(0, c).trim(), v);
        }
        if (!anchors.equals(obj(m, "anchors"))) out.add("anchors", anchors);
        JsonObject roles = new JsonObject();
        for (String line : fieldValue("roles", "").split("\n")) {
            if (line.isBlank()) continue;
            int c = line.indexOf(':');
            if (c < 0) {
                say(tr("editor.bad_role", line.trim()), BAD);
                return;
            }
            roles.add(line.substring(0, c).trim(), array(items(line.substring(c + 1))));
        }
        if (!roles.equals(obj(m, "roles"))) out.add("roles", roles);
        if (out.isEmpty()) {
            say(tr("editor.unchanged"), DIM);
            return;
        }
        save(Requests.args("meta", out), true);
    }

    /** The front the form shows now (for tests). */
    public String front() {
        return front;
    }
}
