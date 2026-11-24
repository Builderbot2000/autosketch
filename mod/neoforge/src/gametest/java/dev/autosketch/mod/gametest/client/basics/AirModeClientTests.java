package dev.autosketch.mod.gametest.client.basics;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.volume.AirMode;
import dev.autosketch.mod.volume.AirPayloads;
import dev.autosketch.mod.volume.PlayerStates;
import net.minecraft.client.CloudStatus;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Items;

/**
 * Air mode's client half (13, B2) in a real client, the checks {@code docs/briefs/world/test-setup.md}
 * step 8 asked a player for: a left click into the air sets corner 1 (16, *Input*), sneak+scroll
 * changes the distance, and the point's white outline is drawn. Input goes through the game's own
 * paths ({@code KeyMapping.click} reaches {@code CommonHooks.onEmptyLeftClick}; scrolling posts
 * {@code InputEvent.MouseScrollingEvent}); results are read from the integrated server's state.
 */
public final class AirModeClientTests {
    private AirModeClientTests() {}

    /** Wand in hand, work mode, air mode on at distance 5, looking up into the sky; corners cleared. */
    static void setUp(ClientTestSuite s) {
        s.step("wand in the main hand, work mode, air on at 5", () -> {
            // By slot, not weapon.mainhand: the server learns of the new slot a tick after the command.
            s.player().getInventory().selected = 0;
            s.command("item replace entity @s hotbar.0 with minecraft:blaze_rod");
            s.command("autosketch mode work");
            s.command("autosketch air on");
            s.command("autosketch air reach 5");
        });
        s.waitUntil("the client half has air mode on at 5 with the wand in hand", () -> {
            AirPayloads.State st = AirPayloads.clientState;
            check(st != null && st.on() && st.reach() == 5, "client air state " + st);
            return s.player().getMainHandItem().is(Items.BLAZE_ROD);
        }, 200);
        s.step("look up into the sky", () -> {
            s.player().setYRot(0f);
            s.player().setXRot(-60f);
        });
        s.waitUntil("the server sees the look", () -> s.onServer(server -> Math.abs(s.serverPlayer(server).getXRot() + 60f) < 0.01f), 100);
        s.step("clear the work corners", () -> s.onServer(server -> {
            states(s.serverPlayer(server)).work.clear();
            return null;
        }));
    }

    static PlayerStates.State states(ServerPlayer p) {
        return AutosketchMod.internals().players().get(p.getUUID());
    }

    static void airOff(ClientTestSuite s) {
        s.cleanup("air off", () -> {
            s.hold(s.mc().options.keyShift, false);
            s.hideGui(false);
            s.command("autosketch air off");
        });
    }

    /** 16, *Input*: the first client test. A left click into the air sets work corner 1 at the air point. */
    @ClientTest("basics")
    public static void leftClickIntoTheAirSetsCorner1(ClientTestSuite s) {
        setUp(s);
        s.step("left click", () -> {
            s.clearMessages();
            s.click(s.mc().options.keyAttack);
        });
        s.waitUntil("work corner 1 is at the air point, 5 blocks along the look", () -> s.onServer(server -> {
            ServerPlayer p = s.serverPlayer(server);
            BlockPos first = states(p).work.first, want = AirMode.point(p, 5);
            check(want.equals(first), "corner 1 " + first + ", air point " + want);
            return true;
        }), 100);
        s.waitUntil("the action bar names corner 1", () -> {
            check(s.actionBarHas("work corner 1"), "action bar: " + s.actionBar());
            return true;
        }, 100);
        airOff(s);
    }

    /** Sneak+scroll changes the air distance (one block per notch, on the server too); scroll without sneak doesn't. */
    @ClientTest("basics")
    public static void sneakScrollChangesTheDistance(ClientTestSuite s) {
        setUp(s);
        s.step("scroll without sneaking is left to the game", () -> check(!s.scroll(1), "the scroll was cancelled without sneak"));
        s.step("sneak", () -> s.hold(s.mc().options.keyShift, true));
        s.waitUntil("the player sneaks", () -> s.player().isShiftKeyDown(), 100);
        s.step("scroll up one notch", () -> {
            s.clearMessages();
            check(s.scroll(1), "air mode cancels the scroll");
        });
        s.waitUntil("distance 6 on the server and on the action bar", () -> {
            int reach = s.onServer(server -> AutosketchMod.internals().air().reach(s.serverPlayer(server)));
            check(reach == 6 && s.actionBarHas("air distance 6"), "reach " + reach + ", action bar " + s.actionBar());
            return true;
        }, 100);
        s.step("scroll down two notches", () -> {
            check(s.scroll(-1), "cancelled");
            check(s.scroll(-1), "cancelled");
        });
        s.waitUntil("distance 4 on the server", () -> s.onServer(server -> AutosketchMod.internals().air().reach(s.serverPlayer(server))) == 4, 100);
        s.step("unsneak", () -> s.hold(s.mc().options.keyShift, false));
        airOff(s);
    }

    /**
     * The air point's outline is drawn while the wand is held (a pixel check: state can't prove a line
     * is on screen). Compares the frame with and without the wand in hand, so it holds on any renderer:
     * white pixels appear where there was sky.
     */
    @ClientTest("basics")
    public static void outlineDrawsAtTheAirPoint(ClientTestSuite s) {
        setUp(s);
        NativeImage[] shots = new NativeImage[2];
        s.step("hide the GUI and the clouds", () -> {
            s.hideGui(true);
            s.mc().options.cloudStatus().set(CloudStatus.OFF);
        });
        s.waitFrames("a frame with the wand", 3);
        s.step("screenshot with the wand", () -> shots[0] = s.screenshot("air-outline-on"));
        s.step("put the wand away (empty slot)", () -> s.player().getInventory().selected = 8);
        s.waitUntil("the main hand is empty", () -> s.player().getMainHandItem().isEmpty(), 100);
        s.waitFrames("a frame without the wand", 3);
        s.step("screenshot without the wand", () -> shots[1] = s.screenshot("air-outline-off"));
        s.step("white outline pixels only with the wand", () -> {
            NativeImage on = shots[0], off = shots[1];
            int white = 0;
            for (int y = 0; y < on.getHeight(); y++)
                for (int x = 0; x < on.getWidth(); x++) {
                    int p = on.getPixelRGBA(x, y), q = off.getPixelRGBA(x, y);
                    if (p != q && (p & 0xFF) > 200 && ((p >> 8) & 0xFF) > 200 && ((p >> 16) & 0xFF) > 200) white++;
                }
            long changed = ClientTestSuite.changedPixels(on, off, 8);
            check(white >= 20, "white outline pixels: " + white + " (changed pixels: " + changed + ")");
            s.assertMatchesReference("air-outline-on", on, 8, 0.01);
        });
        s.cleanup("close the screenshots", () -> {
            for (NativeImage i : shots)
                if (i != null) i.close();
            s.player().getInventory().selected = 0;
            s.mc().options.cloudStatus().set(CloudStatus.FANCY);
        });
        airOff(s);
    }
}
