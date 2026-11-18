package dev.autosketch.mod.gametest.client.screen;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import dev.autosketch.mod.client.ui.screen.EntryEditorScreen;
import dev.autosketch.mod.client.ui.screen.KnowledgeEditorScreen;
import dev.autosketch.mod.client.ui.screen.LibraryScreen;
import dev.autosketch.mod.client.ui.screen.PaletteEditorScreen;
import dev.autosketch.mod.client.ui.screen.PrefabEditorScreen;
import dev.autosketch.mod.client.ui.screen.ProcedureEditorScreen;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;

/**
 * The library editors (17, piece 6; briefs/components/E step E2), against the fake MCP's library
 * ({@code clienttest/editors.json}: a writable root {@code user} with one entry of each kind, the
 * read-only {@code starter} with one prefab). The script answers {@code library.entry} per entry
 * (replies matched on root, kind and name), and refuses {@code library.write.procedure} with
 * {@code conflict} only for the conflict test's typed text, so one fake MCP serves every test and a
 * test counts requests from its own start. Each editor opens, sends its
 * {@code library.write.*} with the hash it started from and the form's changes, and takes the new
 * hash; a {@code conflict} reloads the entry; a read-only entry offers <i>Copy to my library</i> and
 * no editor.
 */
public final class EditorClientTests {
    private EditorClientTests() {}

    private static void connected(ClientTestSuite s) {
        s.waitUntil("connected", Ui.connected(), 400);
    }

    private static <T extends EntryEditorScreen> void openEditor(ClientTestSuite s, Class<T> type, String kind, String name) {
        s.step("open the " + kind + " editor on " + name, () -> s.mc().setScreen(EntryEditorScreen.open(null, "user", kind, name)));
        loaded(s, type, 1);
    }

    private static <T extends EntryEditorScreen> void loaded(ClientTestSuite s, Class<T> type, int loads) {
        s.waitUntil("the entry loaded (" + loads + ")", () -> {
            T e = Ui.screen(type);
            check(e.loads() >= loads && e.entry() != null, "loads " + e.loads());
            return true;
        }, 200);
    }

    private static EntryEditorScreen editor() {
        return Ui.screen(EntryEditorScreen.class);
    }

    /** Clicks Save and waits for the kind's write; returns its args through {@code out}. */
    private static void save(ClientTestSuite s, String kind, JsonObject[] out) {
        int[] before = new int[1];
        s.step("Save", () -> {
            before[0] = Ui.requests(s, kind).size();
            Ui.click(s.widget("Save"));
        });
        s.waitUntil(kind + " sent", () -> {
            check(Ui.requests(s, kind).size() > before[0], "no " + kind + " yet");
            out[0] = Ui.lastArgs(s, kind);
            return true;
        }, 100);
    }

    private static String str(JsonObject o, String key) {
        return o.has(key) ? o.get(key).getAsString() : "<absent>";
    }

    private static void setArea(ClientTestSuite s, String key, String value) {
        ((MultiLineEditBox) s.widget(key)).setValue(value);
    }

    private static void setField(ClientTestSuite s, String key, String value) {
        ((EditBox) s.widget(key)).setValue(value);
    }

    /** Scrolls the form until the widget labelled {@code label} on {@code near}'s row shows, then clicks it. */
    private static void clickOnRow(ClientTestSuite s, String near, String label) {
        s.waitUntil(label + " beside " + near.replace('\n', ' ') + " is in view",
                Ui.reveal(() -> Ui.onRow(s.widget(near), label), 100, 60), 100);
        s.step("click " + label + " beside " + near.replace('\n', ' '), () -> Ui.click(Ui.onRow(s.widget(near), label)));
    }

    @ClientTest("editors")
    public static void prefabEditorFromTheLibrarySendsTheChangedFields(ClientTestSuite s) {
        JsonObject[] args = new JsonObject[1];
        int[] lists = new int[1];
        connected(s);
        s.step("open the library screen", () -> s.mc().setScreen(new LibraryScreen(null)));
        s.waitUntil("the list arrived", () -> !Ui.screen(LibraryScreen.class).shown().isEmpty(), 200);
        s.step("select tower", () -> s.clickWidget("tower"));
        s.waitUntil("its entry arrived and Edit is enabled", () -> {
            check(Ui.screen(LibraryScreen.class).entry() != null, "no entry");
            check(s.widget("Edit").active, "Edit disabled");
            return true;
        }, 100);
        s.waitUntil("Edit is in view", Ui.reveal(() -> s.widget("Edit"), s.mc().getWindow().getGuiScaledWidth() - 40, 120), 100);
        s.step("Edit", () -> {
            lists[0] = Ui.screen(LibraryScreen.class).loads();
            Ui.click(s.widget("Edit"));
        });
        loaded(s, PrefabEditorScreen.class, 1);
        s.step("the form shows prefab.json", () -> {
            check(((EditBox) s.widget("name")).getValue().equals("tower"), "name " + ((EditBox) s.widget("name")).getValue());
            check(((EditBox) s.widget("tags")).getValue().equals("medieval"), "tags");
            check(((MultiLineEditBox) s.widget("anchors")).getValue().equals("base: 2, 0, 2"), "anchors " + ((MultiLineEditBox) s.widget("anchors")).getValue());
            check(((MultiLineEditBox) s.widget("notes")).getValue().equals("Synthetic test prefab"), "notes");
            check(Ui.screen(PrefabEditorScreen.class).front().equals("south"), "front");
        });
        s.step("change name, tags, front, anchors and roles", () -> {
            setField(s, "name", "Tall tower");
            setField(s, "tags", "medieval, tall,stone");
            Ui.click(s.widget("south"));
            setArea(s, "anchors", "base: 2, 0, 2\ndoor: 2, 0, -1");
            setArea(s, "roles", "wall: stone_bricks, andesite");
        });
        s.step("front cycled to east", () -> check(Ui.screen(PrefabEditorScreen.class).front().equals("east"), "front " + Ui.screen(PrefabEditorScreen.class).front()));
        save(s, "library.write.prefab", args);
        s.step("library.write.prefab carries the hash and only the changed fields", () -> {
            JsonObject a = args[0];
            check(str(a, "root").equals("user") && str(a, "name").equals("tower") && str(a, "hash").equals("e-1"), "args " + a);
            JsonObject m = a.getAsJsonObject("meta");
            check(m.keySet().equals(java.util.Set.of("name", "tags", "front", "anchors", "roles")), "meta keys " + m.keySet());
            check(str(m, "name").equals("Tall tower") && str(m, "front").equals("east"), "meta " + m);
            check(m.get("tags").toString().equals("[\"medieval\",\"tall\",\"stone\"]"), "tags " + m.get("tags"));
            check(m.get("anchors").toString().equals("{\"base\":[2,0,2],\"door\":[2,0,-1]}"), "anchors " + m.get("anchors"));
            check(m.get("roles").toString().equals("{\"wall\":[\"stone_bricks\",\"andesite\"]}"), "roles " + m.get("roles"));
        });
        s.waitUntil("saved: the new hash, and the entry loaded again", () -> {
            EntryEditorScreen e = editor();
            check(e.saves() == 1 && e.loads() >= 2, "saves " + e.saves() + " loads " + e.loads());
            check(e.message() != null && e.message().getString().equals("Saved."), "message " + e.message());
            return true;
        }, 100);
        s.step("a bad anchor line isn't sent", () -> {
            setArea(s, "anchors", "door: 2, 0");
            Ui.click(s.widget("Save"));
            check(editor().message().getString().startsWith("Not saved"), "message " + editor().message());
        });
        s.step("Done goes back to the library", () -> Ui.click(s.widget("Done")));
        s.waitUntil("the library lists again", () -> {
            check(Ui.screen(LibraryScreen.class).loads() > lists[0], "no new library.list");
            return true;
        }, 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("editors")
    public static void paletteEditorSendsItsOperations(ClientTestSuite s) {
        JsonObject[] args = new JsonObject[1];
        connected(s);
        openEditor(s, PaletteEditorScreen.class, "palettes", "castle");
        s.step("roles, members and weights as percent", () -> {
            check(((EditBox) s.widget("w:wall\nminecraft:stone_bricks")).getValue().equals("50"), "weight");
            check(((EditBox) s.widget("role:roof")).getValue().equals("roof"), "role");
        });
        s.step("tags, a weight, a rename, blocks added, a new role", () -> {
            setField(s, "tags", "stone, grey");
            setField(s, "w:wall\nminecraft:stone_bricks", "75");
            setField(s, "role:roof", "roofing");
            setField(s, "add:wall", "cobblestone");
            setField(s, "new:role", "glass");
            setField(s, "new:blocks", "glass, tinted_glass");
        });
        clickOnRow(s, "w:wall\nminecraft:andesite", "Remove");
        clickOnRow(s, "role:trim", "Drop role");
        s.waitUntil("the role shows as dropped", () -> {
            Ui.onRow(s.widget("role:trim"), "Keep role");
            return true;
        }, 20);
        save(s, "library.write.palette", args);
        s.step("library.write.palette carries palette_edit's operations", () -> {
            JsonObject a = args[0];
            check(str(a, "hash").equals("p-1") && str(a, "name").equals("castle") && !a.has("notes"), "args " + a);
            check(a.get("tags").toString().equals("[\"stone\",\"grey\"]"), "tags " + a.get("tags"));
            JsonObject e = a.getAsJsonObject("edit");
            check(e.get("rename").toString().equals("{\"roof\":\"roofing\"}"), "rename " + e.get("rename"));
            check(e.get("drop").toString().equals("[\"trim\"]"), "drop " + e.get("drop"));
            check(e.get("remove").toString().equals("{\"wall\":[\"minecraft:andesite\"]}"), "remove " + e.get("remove"));
            JsonObject w = e.getAsJsonObject("weights").getAsJsonObject("wall");
            check(w.keySet().equals(java.util.Set.of("minecraft:stone_bricks")) && w.get("minecraft:stone_bricks").getAsDouble() == 75, "weights " + w);
            check(a.get("addBlocks").toString().equals("{\"wall\":[\"cobblestone\"],\"glass\":[\"glass\",\"tinted_glass\"]}"), "addBlocks " + a.get("addBlocks"));
        });
        s.waitUntil("saved with the MCP's warning, and loaded again", () -> {
            EntryEditorScreen e = editor();
            check(e.saves() == 1 && e.loads() >= 2, "saves " + e.saves() + " loads " + e.loads());
            check(e.message() != null && e.message().getString().startsWith("Saved, with warnings: glass: minecraft:tinted_glass"), "message " + e.message());
            return true;
        }, 100);
        s.step("the reload dropped the marks", () -> Ui.onRow(s.widget("role:trim"), "Drop role"));
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("editors")
    public static void procedureEditorSavesItsSourceAndKeepsEditing(ClientTestSuite s) {
        JsonObject[] args = new JsonObject[1];
        connected(s);
        openEditor(s, ProcedureEditorScreen.class, "procedures", "stairs");
        s.step("the source is in the box", () -> check(((MultiLineEditBox) s.widget("text")).getValue().startsWith("// Builds a stair run\n"), "text"));
        s.step("Save with nothing changed sends nothing", () -> {
            int before = Ui.requests(s, "library.write.procedure").size();
            Ui.click(s.widget("Save"));
            check(editor().message().getString().equals("Nothing changed."), "message " + editor().message());
            check(Ui.requests(s, "library.write.procedure").size() == before, "sent");
        });
        s.step("edit the source", () -> setArea(s, "text", "// v2\nexport default function stairs(ctx) {}\n"));
        save(s, "library.write.procedure", args);
        s.step("library.write.procedure carries the whole text and the loaded hash", () -> {
            check(str(args[0], "hash").equals("s-1") && str(args[0], "name").equals("stairs"), "args " + args[0]);
            check(str(args[0], "text").equals("// v2\nexport default function stairs(ctx) {}\n"), "text " + args[0]);
        });
        s.waitUntil("saved on the new hash, without a reload", () -> {
            check("s-2".equals(editor().hash()) && editor().saves() == 1, "hash " + editor().hash());
            check(editor().loads() == 1, "loads " + editor().loads());
            return true;
        }, 100);
        s.step("edit again", () -> setArea(s, "text", "// v3\n"));
        save(s, "library.write.procedure", args);
        s.step("the second save sends the hash the first returned", () -> check(str(args[0], "hash").equals("s-2") && str(args[0], "text").equals("// v3\n"), "args " + args[0]));
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("editors")
    public static void knowledgeEditorSplitsFrontmatterAndText(ClientTestSuite s) {
        JsonObject[] args = new JsonObject[1];
        connected(s);
        s.step("open the knowledge editor on a kit", () -> s.mc().setScreen(EntryEditorScreen.open(null, "user", "knowledge", "kits/cathedral")));
        loaded(s, KnowledgeEditorScreen.class, 1);
        s.step("frontmatter and text in their boxes", () -> {
            String fm = ((MultiLineEditBox) s.widget("frontmatter")).getValue(), text = ((MultiLineEditBox) s.widget("text")).getValue();
            check(fm.equals("name: Cathedral kit\nkind: kit\nentries:\n  - corner tower = tower"), "frontmatter " + fm);
            check(text.equals("# Cathedral\nNotes.\n"), "text " + text);
        });
        s.step("edit both", () -> {
            setArea(s, "frontmatter", "name: Cathedral kit\nkind: kit\nentries:\n  - corner tower = tower\n  - spire = spire_b");
            setArea(s, "text", "# Cathedral\nMore notes.\n");
        });
        save(s, "library.write.knowledge", args);
        s.step("library.write.knowledge carries the whole file", () -> {
            check(str(args[0], "hash").equals("k-1") && str(args[0], "name").equals("kits/cathedral"), "args " + args[0]);
            String want = "---\nname: Cathedral kit\nkind: kit\nentries:\n  - corner tower = tower\n  - spire = spire_b\n---\n# Cathedral\nMore notes.\n";
            check(str(args[0], "text").equals(want), "text " + args[0]);
        });
        s.waitUntil("saved", () -> "k-2".equals(editor().hash()), 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("editors")
    public static void conflictReloadsTheEntry(ClientTestSuite s) {
        JsonObject[] args = new JsonObject[1];
        int[] entries = new int[1];
        connected(s);
        openEditor(s, ProcedureEditorScreen.class, "procedures", "stairs");
        s.step("type over the source", () -> {
            entries[0] = Ui.requests(s, "library.entry").size();
            setArea(s, "text", "// typed, never saved\n");
        });
        save(s, "library.write.procedure", args);
        s.waitUntil("refused: the entry loaded again, the typed text dropped", () -> {
            EntryEditorScreen e = editor();
            check(e.loads() >= 2, "loads " + e.loads());
            check(Ui.requests(s, "library.entry").size() > entries[0], "no library.entry");
            check(e.saves() == 0 && "s-1".equals(e.hash()), "saves " + e.saves() + " hash " + e.hash());
            String text = ((MultiLineEditBox) s.widget("text")).getValue();
            check(text.startsWith("// Builds a stair run\n"), "text " + text);
            check(e.message() != null && e.message().getString().startsWith("The file changed since it was opened"), "message " + e.message());
            return true;
        }, 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("editors")
    public static void readOnlyEntryOffersCopyFirst(ClientTestSuite s) {
        connected(s);
        s.step("open the library screen", () -> s.mc().setScreen(new LibraryScreen(null)));
        s.waitUntil("the list arrived", () -> !Ui.screen(LibraryScreen.class).shown().isEmpty(), 200);
        s.step("select park_bench", () -> s.clickWidget("park_bench"));
        s.waitUntil("its entry arrived", () -> Ui.screen(LibraryScreen.class).entry() != null, 100);
        s.step("Copy to my library is the first action, and there is no Edit", () -> {
            AbstractWidget copy = s.widget("Copy to my library"), hide = s.widget("Hide");
            check(copy.getY() < hide.getY(), "copy at " + copy.getY() + ", hide at " + hide.getY());
            for (GuiEventListener l : s.mc().screen.children())
                check(!(l instanceof AbstractWidget w && w.getMessage().getString().equals("Edit")), "an Edit button");
        });
        s.step("an editor opened on it anyway has no Save and says to copy first", () -> s.mc().setScreen(EntryEditorScreen.open(null, "starter", "prefabs", "park_bench")));
        loaded(s, PrefabEditorScreen.class, 1);
        s.step("no Save", () -> {
            check(!editor().editable(), "editable");
            check(!s.widget("Save").visible, "Save shows");
        });
        s.cleanup("close", () -> s.mc().setScreen(null));
    }
}
