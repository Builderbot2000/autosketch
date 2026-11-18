package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The palette editor (17, piece 6; {@code 13}'s {@code library.write.palette}): tags and notes, and
 * per role its members with their weights (shown as the share of the role, in percent), each member
 * removable, the role renamable or dropped, and blocks added by id (no sheet in the game, so no cell
 * references). A new role is made by adding blocks under a new name. The changes go as
 * {@code palette_edit}'s operations ({@code 03}): {@code rename}, {@code drop}, {@code remove},
 * {@code weights}, and {@code addBlocks}; the MCP applies them and normalises the weights, then the
 * form loads the file again to show what was written. Member changes need the MCP's loaded instance,
 * which the MCP says when it refuses; tags and notes don't.
 *
 * <p>The MCP applies {@code addBlocks} to the roles as they were, then renames and drops, then
 * removes and reweights under the roles' new names, so the form names them that way.
 */
public final class PaletteEditorScreen extends EntryEditorScreen {
    private final Set<String> dropped = new HashSet<>();
    /** {@code role + "\n" + block} of members marked for removal. */
    private final Set<String> removed = new HashSet<>();

    PaletteEditorScreen(@Nullable Screen parent, String root, String name) {
        super(parent, root, "palettes", name);
    }

    @Override
    protected void loaded(JsonObject entry) {
        dropped.clear();
        removed.clear();
    }

    private JsonObject palette() {
        return obj(entry, "palette");
    }

    /** Role → its members ({@code block}, {@code family}, {@code weight}), in file order. */
    private Map<String, List<JsonObject>> roles() {
        Map<String, List<JsonObject>> out = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> r : obj(palette(), "roles").entrySet()) {
            List<JsonObject> ms = new ArrayList<>();
            if (r.getValue().isJsonArray()) for (JsonElement m : r.getValue().getAsJsonArray()) if (m.isJsonObject()) ms.add(m.getAsJsonObject());
            out.put(r.getKey(), ms);
        }
        return out;
    }

    static String percent(JsonObject member) {
        double w = member.has("weight") && member.get("weight").isJsonPrimitive() ? member.get("weight").getAsDouble() : 0;
        double pc = Math.round(w * 1000) / 10.0;
        return pc == Math.rint(pc) ? String.valueOf((long) pc) : String.valueOf(pc);
    }

    private static String shortId(String block) {
        return block.startsWith("minecraft:") ? block.substring(10) : block;
    }

    @Override
    protected void form(Pane p, JsonObject entry, int y) {
        if (!entry.has("palette") || !entry.get("palette").isJsonObject()) {
            y += wrap(p, 0, y, tr("editor.palette_unreadable"), BAD);
            for (String line : LogListScreen.str(entry, "text").split("\n", -1)) y += wrap(p, 0, y, Component.literal(line.isEmpty() ? " " : line), TEXT);
            return;
        }
        JsonObject pal = palette();
        int fx = 56, w = Math.max(80, Math.min(260, p.w - fx - 8));
        text(p, 0, y + 5, tr("library.meta.tags"), DIM);
        put(p, field("tags", w, String.join(", ", SettingsScreen.strings(pal, "tags")), tr("editor.comma_list")), fx, y + 1);
        y += 20;
        text(p, 0, y + 5, tr("library.meta.notes"), DIM);
        put(p, area("notes", w, 36, LogListScreen.str(pal, "notes"), Component.empty()), fx, y);
        y += 42;
        for (Map.Entry<String, List<JsonObject>> r : roles().entrySet()) {
            String role = r.getKey();
            boolean drop = dropped.contains(role);
            text(p, 0, y + 5, tr("editor.role"), ACCENT);
            put(p, field("role:" + role, 90, role, Component.empty()), fx, y + 1);
            put(p, Button.builder(tr(drop ? "editor.keep_role" : "editor.drop_role"), b -> {
                if (!dropped.remove(role)) dropped.add(role);
                refresh();
            }).size(70, 18).build(), fx + 94, y);
            y += 20;
            if (drop) {
                y += wrap(p, 12, y, tr("editor.role_dropped"), BAD);
                continue;
            }
            for (JsonObject m : r.getValue()) {
                String block = LogListScreen.str(m, "block"), key = role + "\n" + block;
                boolean gone = removed.contains(key);
                text(p, 12, y + 5, Component.literal(shortId(block)), gone ? DIM : TEXT);
                int bx = Math.max(fx + 40, Math.min(p.w - 120, 150));
                if (!gone) {
                    var box = put(p, field("w:" + key, 40, percent(m), Component.empty()), bx, y + 1);
                    box.setFilter(t -> t.matches("[0-9]*\\.?[0-9]*"));
                    text(p, bx + 43, y + 5, Component.literal("%"), DIM);
                }
                put(p, Button.builder(tr(gone ? "editor.keep" : "editor.remove"), b -> {
                    if (!removed.remove(key)) removed.add(key);
                    refresh();
                }).size(54, 18).build(), bx + 54, y);
                y += 20;
            }
            text(p, 12, y + 5, tr("editor.add_blocks"), DIM);
            put(p, field("add:" + role, w - 30, "", tr("editor.block_ids")), fx + 30, y + 1);
            y += 22;
        }
        text(p, 0, y + 5, tr("editor.new_role"), ACCENT);
        put(p, field("new:role", 90, "", tr("editor.role_name")), fx, y + 1);
        y += 20;
        text(p, 12, y + 5, tr("editor.add_blocks"), DIM);
        put(p, field("new:blocks", w - 30, "", tr("editor.block_ids")), fx + 30, y + 1);
        y += 22;
        wrap(p, 0, y, tr("editor.palette_instance"), DIM);
    }

    @Override
    protected void submit() {
        JsonObject pal = palette();
        JsonObject rename = new JsonObject(), remove = new JsonObject(), weights = new JsonObject(), add = new JsonObject();
        JsonArray drop = new JsonArray();
        for (Map.Entry<String, List<JsonObject>> r : roles().entrySet()) {
            String role = r.getKey();
            if (dropped.contains(role)) {
                drop.add(role);
                continue;
            }
            List<String> ids = items(fieldValue("add:" + role, ""));
            if (!ids.isEmpty()) add.add(role, array(ids));
            String to = fieldValue("role:" + role, role).trim();
            if (!to.isEmpty() && !to.equals(role)) rename.addProperty(role, to);
            String now = to.isEmpty() ? role : to;
            JsonArray gone = new JsonArray();
            JsonObject ws = new JsonObject();
            boolean changed = false;
            for (JsonObject m : r.getValue()) {
                String block = LogListScreen.str(m, "block"), key = role + "\n" + block;
                if (removed.contains(key)) {
                    gone.add(block);
                    continue;
                }
                String typed = fieldValue("w:" + key, percent(m)).trim();
                double v;
                try {
                    v = Double.parseDouble(typed);
                } catch (NumberFormatException e) {
                    v = -1;
                }
                if (!(v > 0)) {
                    say(tr("editor.bad_weight", shortId(block), role), BAD);
                    return;
                }
                if (!typed.equals(percent(m))) changed = true;
                ws.addProperty(block, v);
            }
            if (!gone.isEmpty()) remove.add(now, gone);
            if (changed) weights.add(now, ws);
        }
        String newRole = fieldValue("new:role", "").trim();
        List<String> newIds = items(fieldValue("new:blocks", ""));
        if (!newRole.isEmpty() && !newIds.isEmpty()) {
            JsonArray a = add.has(newRole) ? add.getAsJsonArray(newRole) : new JsonArray();
            for (String id : newIds) a.add(id);
            add.add(newRole, a);
        } else if (!newRole.isEmpty() || !newIds.isEmpty()) {
            say(tr("editor.new_role_needs"), BAD);
            return;
        }
        JsonObject args = new JsonObject();
        List<String> tags = items(fieldValue("tags", ""));
        if (!tags.equals(SettingsScreen.strings(pal, "tags"))) args.add("tags", array(tags));
        String notes = fieldValue("notes", LogListScreen.str(pal, "notes"));
        if (!notes.equals(LogListScreen.str(pal, "notes"))) args.addProperty("notes", notes);
        JsonObject edit = new JsonObject();
        if (!rename.isEmpty()) edit.add("rename", rename);
        if (!drop.isEmpty()) edit.add("drop", drop);
        if (!remove.isEmpty()) edit.add("remove", remove);
        if (!weights.isEmpty()) edit.add("weights", weights);
        if (!edit.isEmpty()) args.add("edit", edit);
        if (!add.isEmpty()) args.add("addBlocks", add);
        if (args.isEmpty()) {
            say(tr("editor.unchanged"), DIM);
            return;
        }
        save(args, true);
    }
}
