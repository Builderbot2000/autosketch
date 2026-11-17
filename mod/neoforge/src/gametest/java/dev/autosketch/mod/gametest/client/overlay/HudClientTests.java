package dev.autosketch.mod.gametest.client.overlay;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.hud.HudOverlay;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.util.List;
import org.lwjgl.glfw.GLFW;

/**
 * The HUD (16, *HUD*; briefs/ui/O): its text matches the fake MCP's {@code ui.state} (request and
 * mode, job count and newest briefs, last refusal, token totals), follows a change, and the HUD key
 * cycles expanded, collapsed (one line) and hidden.
 */
public final class HudClientTests {
    private HudClientTests() {}

    static final List<String> EXPANDED = List.of(
            "Autosketch ask: how tall should the east tower be?",
            "Jobs: 3",
            "  nether job",
            "  " + OverlayScript.J2_BRIEF,
            "  " + OverlayScript.J1_BRIEF,
            "Tokens: in 18k · out 2.2k · cache read 120k · cache write 5.3k · $0.48");

    @ClientTest("overlay")
    public static void hudTextMatchesTheState(ClientTestSuite s) {
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("expanded lines", () -> check(HudOverlay.lines().equals(EXPANDED), "lines " + HudOverlay.lines()));
        s.step("the MCP removes j2 and reports a refusal", () -> OverlayScript.trigger("logs.list"));
        s.waitUntil("one job, the refusal shown", () -> {
            List<String> want = List.of(
                    "Autosketch ask: how tall should the east tower be?",
                    "Jobs: 2",
                    "  nether job",
                    "  " + OverlayScript.J1_BRIEF,
                    "Refused outside_work_volume: fill reached outside j1's work volume",
                    "Tokens: in 18k · out 2.2k · cache read 120k · cache write 5.3k · $0.48");
            check(HudOverlay.lines().equals(want), "lines " + HudOverlay.lines());
            return true;
        }, 200);
    }

    @ClientTest("overlay")
    public static void hudKeyCyclesExpandedCollapsedHidden(ClientTestSuite s) {
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("bind the HUD key; press it", () -> {
            OverlayScript.bind(AutosketchKeys.TOGGLE_HUD, GLFW.GLFW_KEY_KP_3);
            check(UiToggles.hud && !HudOverlay.collapsed(), "the HUD starts expanded");
            s.click(AutosketchKeys.TOGGLE_HUD);
        });
        s.waitUntil("collapsed to one line", () -> {
            check(HudOverlay.lines().equals(List.of("Autosketch: ask · 3 jobs · in 18k out 2.2k $0.48")), "lines " + HudOverlay.lines());
            return true;
        }, 100);
        s.step("press again", () -> s.click(AutosketchKeys.TOGGLE_HUD));
        s.waitUntil("hidden: no lines", () -> !UiToggles.hud && HudOverlay.lines().isEmpty(), 100);
        s.step("press again", () -> s.click(AutosketchKeys.TOGGLE_HUD));
        s.waitUntil("expanded again", () -> {
            check(HudOverlay.lines().equals(EXPANDED), "lines " + HudOverlay.lines());
            return true;
        }, 100);
        s.cleanup("unbind, HUD expanded", () -> {
            OverlayScript.unbind(AutosketchKeys.TOGGLE_HUD);
            UiToggles.hud = true;
            HudOverlay.setCollapsed(false);
        });
    }
}
