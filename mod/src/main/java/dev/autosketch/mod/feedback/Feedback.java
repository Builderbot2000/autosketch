package dev.autosketch.mod.feedback;

import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.PatchStatus;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.volume.PlayerStates;
import dev.autosketch.mod.volume.Wand;
import java.util.List;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import net.minecraft.core.particles.DustParticleOptions;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jetbrains.annotations.Nullable;
import org.joml.Vector3f;

/**
 * What the player sees of the link (13, *Player feedback in-game*; M11): volume outlines as dust
 * particles in each wand mode's colour, while the wand is held or after {@code /autosketch show};
 * the wand's mode on the action bar; action-bar notices from the MCP and for finished patches,
 * toggled per player with {@code /autosketch notices}. Particles go only to the player who sees
 * them. Server thread only.
 */
public final class Feedback {
    /** How long a notice keeps the wand's mode line off the action bar. */
    private static final int NOTICE_TICKS = 60;
    private static final int OUTLINE_PERIOD = 10;
    private static final int MODE_LINE_PERIOD = 20;
    /** Outline points farther than this from the player aren't sent. */
    private static final double OUTLINE_RANGE = 96;
    private static final int MAX_POINTS = 2400;

    private final PlayerStates players;
    private final BooleanSupplier noticesDefault;
    private final Supplier<List<WandMode>> modes;
    private final Supplier<PatchStatus> patches;
    private long lastPatchId = -1;

    public Feedback(PlayerStates players, BooleanSupplier noticesDefault, Supplier<List<WandMode>> modes, Supplier<PatchStatus> patches) {
        this.players = players;
        this.noticesDefault = noticesDefault;
        this.modes = modes;
        this.patches = patches;
    }

    public void serverStarted() {
        lastPatchId = -1;
    }

    public boolean noticesOn(ServerPlayer p) {
        Boolean b = players.get(p.getUUID()).notices;
        return b != null ? b : noticesDefault.getAsBoolean();
    }

    /** Shows {@code text} on the player's action bar and holds the mode line back for a few seconds. */
    public void actionBar(ServerPlayer p, Component text) {
        p.displayClientMessage(text, true);
        players.get(p.getUUID()).actionBarBusyUntil = p.serverLevel().getGameTime() + NOTICE_TICKS;
    }

    /** A notice: to one player, or (player null) to every op with notices on. Respects the player's notices setting. */
    public void notice(MinecraftServer server, @Nullable UUID player, String text) {
        Component c = Component.literal(text);
        if (player != null) {
            ServerPlayer p = server.getPlayerList().getPlayer(player);
            if (p != null && noticesOn(p)) actionBar(p, c);
            return;
        }
        for (ServerPlayer p : server.getPlayerList().getPlayers())
            if (p.hasPermissions(CommandExtension.OP_LEVEL) && noticesOn(p)) actionBar(p, c);
    }

    /** End of every server tick. */
    public void tick(MinecraftServer server) {
        PatchStatus.Finished last = patches.get().last();
        if (last != null && last.id() != lastPatchId) {
            lastPatchId = last.id();
            notice(server, null, patchLine(last));
        }
        long tick = server.getTickCount();
        boolean outlines = tick % OUTLINE_PERIOD == 0, modeLine = tick % MODE_LINE_PERIOD == 0;
        if (!outlines && !modeLine) return;
        List<WandMode> all = modes.get();
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (!p.hasPermissions(CommandExtension.OP_LEVEL)) continue;
            PlayerStates.State st = players.get(p.getUUID());
            boolean holding = Wand.isWand(p.getMainHandItem());
            if (outlines && (holding || st.show)) drawOutlines(p, all);
            if (modeLine && holding && p.serverLevel().getGameTime() >= st.actionBarBusyUntil && !all.isEmpty())
                p.displayClientMessage(Component.literal("Autosketch wand: " + all.get(Math.floorMod(st.mode, all.size())).name() + " mode"), true);
        }
    }

    /** {@code Autosketch: 1,204 placed, 3 skipped} (13, *Player feedback in-game*). */
    public static String patchLine(PatchStatus.Finished f) {
        StringBuilder sb = new StringBuilder(String.format("Autosketch: %,d placed, %,d skipped", f.applied(), f.skipped()));
        if (f.rejected() > 0) sb.append(String.format(", %,d rejected", f.rejected()));
        if (f.overwritten() > 0) sb.append(String.format(" (%,d hand edits overwritten)", f.overwritten()));
        return sb.toString();
    }

    private void drawOutlines(ServerPlayer p, List<WandMode> all) {
        int[] budget = {MAX_POINTS};
        for (WandMode m : all) {
            int rgb = m.colour();
            DustParticleOptions dust = new DustParticleOptions(new Vector3f(((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f), 1.0f);
            for (Box b : m.outline(p)) drawBox(p, dust, b, budget);
        }
    }

    /** The 12 edges of a box, on block boundaries (max + 1), a point per block or sparser on long edges. */
    private static void drawBox(ServerPlayer p, DustParticleOptions dust, Box b, int[] budget) {
        double x0 = b.minX(), y0 = b.minY(), z0 = b.minZ(), x1 = b.maxX() + 1, y1 = b.maxY() + 1, z1 = b.maxZ() + 1;
        double[][] corners = {{x0, y0, z0}, {x1, y0, z0}, {x0, y1, z0}, {x1, y1, z0}, {x0, y0, z1}, {x1, y0, z1}, {x0, y1, z1}, {x1, y1, z1}};
        int[][] edges = {{0, 1}, {2, 3}, {4, 5}, {6, 7}, {0, 2}, {1, 3}, {4, 6}, {5, 7}, {0, 4}, {1, 5}, {2, 6}, {3, 7}};
        for (int[] e : edges) {
            double[] a = corners[e[0]], c = corners[e[1]];
            double len = Math.abs(c[0] - a[0]) + Math.abs(c[1] - a[1]) + Math.abs(c[2] - a[2]);
            double step = Math.max(1, Math.ceil(len / 64));
            for (double t = 0; t <= len; t += step) {
                if (budget[0]-- <= 0) return;
                double f = len == 0 ? 0 : t / len;
                double x = a[0] + (c[0] - a[0]) * f, y = a[1] + (c[1] - a[1]) * f, z = a[2] + (c[2] - a[2]) * f;
                if (p.distanceToSqr(x, y, z) > OUTLINE_RANGE * OUTLINE_RANGE) {
                    budget[0]++;
                    continue;
                }
                p.serverLevel().sendParticles(p, dust, true, x, y, z, 1, 0, 0, 0, 0);
            }
        }
    }
}
