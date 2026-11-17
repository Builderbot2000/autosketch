package dev.autosketch.mod.client.ui.hud;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.overlay.OverlayClient;
import dev.autosketch.mod.client.ui.overlay.OverlayState;
import dev.autosketch.mod.protocol.UiMessages.Job;
import dev.autosketch.mod.protocol.UiMessages.Refusal;
import dev.autosketch.mod.protocol.UiMessages.RequestInfo;
import dev.autosketch.mod.protocol.UiMessages.Tokens;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.client.event.RegisterGuiLayersEvent;
import net.neoforged.neoforge.client.gui.VanillaGuiLayers;

/**
 * The HUD (16, *HUD*): a corner panel with the open request and its mode, the open job count and the
 * newest briefs, the last refusal, and the current prompt's token totals; one line when collapsed.
 * Every value is the held {@code ui.state}'s, as sent: the panel only lays it out (labels, number
 * abbreviation, truncation to the panel's width).
 *
 * <p>Placement: the top-left corner, which vanilla leaves empty in play (status effects and toasts
 * are top right, boss bars top centre, the scoreboard right, chat bottom left, the action bar and
 * hotbar bottom centre, subtitles bottom right). It steps aside for the F3 debug screen, which uses
 * that corner, and hides with the GUI (F1). Drawn below chat, so an open chat covers it.
 *
 * <p>The toggle key cycles expanded → collapsed → hidden; hidden is {@link UiToggles#hud} off, so
 * the menu's HUD toggle (S) shows and hides the same panel. 1.21.1: {@code RegisterGuiLayersEvent}
 * and {@code LayeredDraw.Layer} are where a port looks first.
 */
public final class HudOverlay {
    private HudOverlay() {}

    public static final ResourceLocation LAYER = ResourceLocation.fromNamespaceAndPath(Autosketch.MOD_ID, "hud");
    /** Newest briefs shown under the job count. */
    public static final int BRIEFS = 3;
    /** Widest line, in GUI pixels; longer lines end with an ellipsis. */
    public static final int WIDTH = 220;
    static final int MARGIN = 4, PAD = 3;

    private static volatile boolean collapsed;

    public static boolean collapsed() {
        return collapsed;
    }

    public static void setCollapsed(boolean c) {
        collapsed = c;
    }

    /** The toggle key: expanded → collapsed → hidden → expanded. Returns the new mode's name. */
    public static String cycle() {
        if (!UiToggles.hud) {
            UiToggles.hud = true;
            collapsed = false;
            return "expanded";
        }
        if (!collapsed) {
            collapsed = true;
            return "collapsed";
        }
        UiToggles.hud = false;
        collapsed = false;
        return "hidden";
    }

    public static void register(RegisterGuiLayersEvent e) {
        e.registerBelow(VanillaGuiLayers.CHAT, LAYER, HudOverlay::render);
    }

    /** The panel's lines as drawn now (before truncation to width); empty when the HUD shows nothing. */
    public static List<String> lines() {
        if (!LinkState.connected() || !UiToggles.hud) return List.of();
        return lines(OverlayClient.state(), collapsed);
    }

    /** The lines for a state. */
    public static List<String> lines(OverlayState s, boolean collapsed) {
        RequestInfo r = s.request();
        List<Job> jobs = s.jobs();
        Tokens t = s.tokens();
        Refusal x = s.refusal();
        List<String> out = new ArrayList<>();
        if (collapsed) {
            StringBuilder b = new StringBuilder("Autosketch: ");
            b.append(r == null ? "no request" : r.mode());
            b.append(" · ").append(jobs.size()).append(jobs.size() == 1 ? " job" : " jobs");
            if (t != null) b.append(" · ").append(tokensShort(t));
            if (x != null) b.append(" · refused ").append(x.code());
            out.add(b.toString());
            return out;
        }
        out.add(r == null ? "Autosketch: no open request" : "Autosketch " + r.mode() + ": " + r.text());
        out.add("Jobs: " + jobs.size());
        for (int i = jobs.size() - 1; i >= Math.max(0, jobs.size() - BRIEFS); i--) out.add("  " + jobs.get(i).brief());
        if (x != null) out.add("Refused " + x.code() + ": " + x.text());
        if (t != null) out.add("Tokens: " + tokensLong(t));
        return out;
    }

    static String tokensShort(Tokens t) {
        String s = "in " + count(t.input()) + " out " + count(t.output());
        return t.cost() == null ? s : s + " " + cost(t.cost());
    }

    static String tokensLong(Tokens t) {
        String s = "in " + count(t.input()) + " · out " + count(t.output()) + " · cache read " + count(t.cacheRead()) + " · cache write " + count(t.cacheCreation());
        return t.cost() == null ? s : s + " · " + cost(t.cost());
    }

    /** 950, 12.3k, 4.5M. */
    public static String count(long n) {
        if (n < 1000) return Long.toString(n);
        if (n < 1_000_000) return String.format(Locale.ROOT, n < 10_000 ? "%.1fk" : "%.0fk", n / 1000.0);
        return String.format(Locale.ROOT, n < 10_000_000 ? "%.1fM" : "%.0fM", n / 1_000_000.0);
    }

    static String cost(double usd) {
        return String.format(Locale.ROOT, "$%.2f", usd);
    }

    private static void render(GuiGraphics g, DeltaTracker delta) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.options.hideGui || mc.getDebugOverlay().showDebugScreen()) return;
        List<String> lines = lines();
        if (lines.isEmpty()) return;
        Font font = mc.font;
        List<String> shown = new ArrayList<>();
        int w = 0;
        for (String l : lines) {
            String s = fit(font, l);
            shown.add(s);
            w = Math.max(w, font.width(s));
        }
        int lh = font.lineHeight + 1;
        int x = MARGIN, y = MARGIN;
        g.fill(x, y, x + w + 2 * PAD, y + shown.size() * lh + 2 * PAD - 1, mc.options.getBackgroundColor(0.5f));
        for (int i = 0; i < shown.size(); i++)
            g.drawString(font, shown.get(i), x + PAD, y + PAD + i * lh, i == 0 ? 0xFFFFFFFF : 0xFFD0D0D0, false);
    }

    private static String fit(Font font, String line) {
        if (font.width(line) <= WIDTH) return line;
        return font.plainSubstrByWidth(line, WIDTH - font.width("…")) + "…";
    }
}
