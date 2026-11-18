package dev.autosketch.mod.gametest.client.screen;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.client.ui.screen.LibraryScreen;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.ConfirmScreen;

/**
 * The library screen (16, *Library screen*; briefs/ui/S), against the fake MCP's library
 * ({@code clienttest/screen.json}: a writable root {@code user} and the read-only {@code starter},
 * four prefabs, one hidden): lists the entries in the MCP's order, filters by text and {@code tag:},
 * shows hidden entries on request, loads thumbnails as textures (and frees them on close), and sends
 * each action's request, Delete and Empty trash after a confirmation. One screenshot check: the grid
 * with its thumbnails drawn differs from the same grid without them.
 */
public final class LibraryClientTests {
    private LibraryClientTests() {}

    /** The library screen last seen open: a confirmation on top keeps it, and {@link #acts} counts its lists across one. */
    private static LibraryScreen last;

    private static LibraryScreen screen() {
        return last = Ui.screen(LibraryScreen.class);
    }

    private static void open(ClientTestSuite s) {
        s.waitUntil("connected", Ui.connected(), 400);
        s.step("open the library screen", () -> s.mc().setScreen(new LibraryScreen(null)));
        s.waitUntil("the list arrived", () -> screen().loads() >= 1 && !screen().shown().isEmpty(), 200);
    }

    private static void filter(ClientTestSuite s, String text, List<String> want) {
        s.step("filter \"" + text + "\"", () -> ((EditBox) s.widget("filter")).setValue(text));
        s.waitUntil("shows " + want, () -> {
            check(screen().shown().equals(want), "shown " + screen().shown());
            return true;
        }, 20);
    }

    @ClientTest("screen")
    public static void listsFiltersAndLoadsThumbnails(ClientTestSuite s) {
        LibraryScreen[] first = new LibraryScreen[1];
        open(s);
        s.step("prefabs in the MCP's order, the hidden one left out", () -> {
            check(screen().tab().equals("prefabs"), "tab " + screen().tab());
            check(screen().shown().equals(List.of("tower", "hut", "park_bench")), "shown " + screen().shown());
            first[0] = screen();
        });
        s.waitUntil("a thumbnail texture per card", () -> {
            check(screen().texturesLoaded() == 3, "textures " + screen().texturesLoaded());
            return true;
        }, 200);
        filter(s, "tag:park", List.of("park_bench"));
        filter(s, "TOWER", List.of("tower"));
        filter(s, "medieval hut", List.of("hut"));
        filter(s, "tag:medieval tag:tall", List.of("tower"));
        filter(s, "", List.of("tower", "hut", "park_bench"));
        s.step("show hidden", () -> s.clickWidget("Hidden: off"));
        s.waitUntil("the hidden entry shows", () -> screen().shown().contains("old_well"), 20);
        s.step("hide them again; the Palettes tab", () -> {
            s.clickWidget("Hidden: on");
            s.clickWidget("Palettes (1)");
        });
        s.waitUntil("palettes listed", () -> screen().shown().equals(List.of("castle")), 20);
        s.step("close the screen", () -> s.mc().setScreen(null));
        s.waitUntil("its textures are freed", () -> {
            check(first[0].texturesLoaded() == 0, "textures " + first[0].texturesLoaded());
            return true;
        }, 20);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    /** Selects an entry by clicking its card or row, and waits for its {@code library.entry}. */
    private static void select(ClientTestSuite s, String name) {
        int[] before = new int[1];
        s.step("select " + name, () -> {
            before[0] = Ui.requests(s, "library.entry").size();
            s.clickWidget(name);
        });
        s.waitUntil(name + "'s entry arrived", () -> {
            check(Ui.requests(s, "library.entry").size() > before[0], "no library.entry");
            check(Ui.lastArgs(s, "library.entry").get("name").getAsString().equals(name), "entry args " + Ui.lastArgs(s, "library.entry"));
            check(screen().entry() != null, "no entry shown");
            return true;
        }, 100);
    }

    /** Runs {@code act} and waits for a request of {@code kind} whose args pass {@code ok}. */
    private static void sends(ClientTestSuite s, String what, ClientTestSuite.Action act, String kind, Predicate<JsonObject> ok) {
        int[] before = new int[1];
        s.step(what, () -> {
            before[0] = Ui.requests(s, kind).size();
            act.run();
        });
        s.waitUntil(what + " sends " + kind, () -> {
            check(Ui.requests(s, kind).size() > before[0], "no " + kind + " yet");
            JsonObject a = Ui.lastArgs(s, kind);
            check(ok.test(a), kind + " args " + a);
            return true;
        }, 100);
    }

    /**
     * As {@link #sends}, then waits for the list the screen loads once the action's result is in. The
     * result can clear the selection (a copy or rename selects the new entry on the next list, a delete
     * selects nothing), so a test that selects the next entry before it lands would see that entry's
     * {@code library.entry} answer dropped.
     */
    private static void acts(ClientTestSuite s, String what, ClientTestSuite.Action act, String kind, Predicate<JsonObject> ok) {
        int[] loads = new int[1];
        LibraryScreen[] lib = new LibraryScreen[1];
        s.step("before " + what, () -> {
            lib[0] = s.mc().screen instanceof ConfirmScreen ? last : screen();
            loads[0] = lib[0].loads();
        });
        sends(s, what, act, kind, ok);
        s.waitUntil("the list reloaded after " + kind, () -> {
            check(s.mc().screen == lib[0], "screen " + s.mc().screen);
            check(lib[0].loads() > loads[0], "loads " + lib[0].loads());
            return true;
        }, 100);
    }

    private static boolean is(JsonObject a, String key, String value) {
        return a.has(key) && a.get(key).getAsString().equals(value);
    }

    private static void confirmYes(ClientTestSuite s) throws Exception {
        check(s.mc().screen instanceof ConfirmScreen, "no confirmation; screen " + s.mc().screen);
        s.clickWidget("Yes");
    }

    @ClientTest("screen")
    public static void actionsSendTheirRequests(ClientTestSuite s) {
        open(s);
        s.waitUntil("thumbnails loaded", () -> screen().texturesLoaded() == 3, 200);
        select(s, "tower");
        acts(s, "Rename to tower2", () -> {
            ((EditBox) s.widget("act:rename")).setValue("tower2");
            s.clickWidget("Rename");
        }, "library.rename", a -> is(a, "root", "user") && is(a, "kind", "prefabs") && is(a, "name", "tower") && is(a, "to", "tower2"));
        select(s, "tower");
        acts(s, "Duplicate", () -> s.clickWidget("Duplicate"), "library.duplicate", a -> is(a, "name", "tower") && is(a, "to", "tower_copy"));
        select(s, "tower");
        s.waitUntil("Delete is in view", () -> Ui.reveal(() -> s.widget("Delete"), s.mc().screen.width - 40, s.mc().screen.height / 2).test(), 100);
        s.step("Delete asks first", () -> Ui.click(s.widget("Delete")));
        s.waitUntil("a confirmation", () -> s.mc().screen instanceof ConfirmScreen, 20);
        acts(s, "confirm the delete", () -> confirmYes(s), "library.delete", a -> is(a, "root", "user") && is(a, "kind", "prefabs") && is(a, "name", "tower"));
        s.step("back on the library, its textures kept", () -> check(screen().texturesLoaded() == 3, "textures " + screen().texturesLoaded()));
        select(s, "park_bench");
        acts(s, "Copy to my library", () -> s.clickWidget("Copy to my library"), "library.copy", a -> is(a, "root", "starter") && is(a, "name", "park_bench"));
        select(s, "park_bench");
        acts(s, "Hide (with config.toml's hash from settings.list)", () -> s.clickWidget("Hide"), "library.hide",
                a -> is(a, "root", "starter") && is(a, "name", "park_bench") && a.get("hidden").getAsBoolean() && is(a, "hash", "hash-1"));
        sends(s, "Roots tab, user's trash", () -> {
            s.clickWidget("Roots");
            s.clickWidget("Trash (1)");
        }, "library.trash", a -> is(a, "root", "user"));
        s.waitUntil("the trash listed", () -> screen().trash() != null && screen().trash().size() == 1, 100);
        acts(s, "Restore", () -> s.clickWidget("Restore"), "library.restore", a -> is(a, "root", "user") && is(a, "id", "t0"));
        s.waitUntil("the trash listed again", () -> screen().trash() != null, 100);
        s.step("Empty trash asks first", () -> s.clickWidget("Empty trash"));
        s.waitUntil("a confirmation", () -> s.mc().screen instanceof ConfirmScreen, 20);
        acts(s, "confirm emptying", () -> confirmYes(s), "library.empty_trash", a -> is(a, "root", "user"));
        s.waitUntil("the result is said", () -> {
            var m = screen().message();
            check(m != null && m.getString().equals("Emptied 1 from the trash."), "message " + m);
            return true;
        }, 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("screen")
    public static void gridScreenshotShowsTheThumbnails(ClientTestSuite s) {
        NativeImage[] shots = new NativeImage[2];
        open(s);
        s.waitUntil("thumbnails loaded", () -> screen().texturesLoaded() == 3, 200);
        s.step("draw the grid without thumbnails", () -> screen().drawThumbnails(false));
        s.waitFrames("drawn", 3);
        s.step("screenshot the empty grid", () -> shots[0] = s.screenshot("library-grid-empty"));
        s.step("draw the thumbnails", () -> screen().drawThumbnails(true));
        s.waitFrames("drawn", 3);
        s.step("screenshot the grid; the thumbnails changed pixels", () -> {
            shots[1] = s.screenshot("library-grid");
            long changed = ClientTestSuite.changedPixels(shots[0], shots[1], 24);
            // Three 52×52 thumbnails at GUI scale 1 or more: at least about 8,000 pixels change.
            check(changed >= 3 * 52 * 52 / 2, "only " + changed + " pixels changed");
        });
        s.cleanup("close", () -> {
            for (NativeImage i : shots) if (i != null) i.close();
            s.mc().setScreen(null);
        });
    }
}
