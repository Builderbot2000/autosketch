package dev.autosketch.mod.feedback;

import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.PatchStatus;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.link.Link;
import dev.autosketch.mod.link.LinkStatus;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.volume.PlayerStates;
import dev.autosketch.mod.volume.Wand;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import net.minecraft.core.particles.DustParticleOptions;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jetbrains.annotations.Nullable;
import org.joml.Vector3f;

/**
 * What the player sees of the link (13, *Player feedback in-game*; M11): volume outlines in each wand
 * mode's colour, while the wand is held or after {@code /autosketch show}, sent to the player's client
 * half to draw on its overlay when it registered the UI channel and the link is {@code connected}
 * (13, *Relay to the client*, op {@code 4}; 18, piece 8), else as dust particles;
 * the wand's mode on the action bar; action-bar notices from the MCP and for finished patches,
 * toggled per player with {@code /autosketch notices}. Particles go only to the player who sees
 * them. Server thread only.
 */
public final class Feedback {
    /** How long a notice keeps the wand's mode line off the action bar. */
    private static final int NOTICE_TICKS = 60;
    public static final int OUTLINE_PERIOD = 10;
    private static final int MODE_LINE_PERIOD = 20;
    /**
     * How the wand's mode line starts. The client half keeps its own action-bar lines up for their
     * time by dropping a repeated mode line meanwhile (client {@code ActionBarHold}, 18, C5).
     */
    public static final String MODE_LINE_PREFIX = "Autosketch wand: ";
    /** Outline points farther than this from the player aren't sent. */
    private static final double OUTLINE_RANGE = 96;
    private static final int MAX_POINTS = 2400;

    private final PlayerStates players;
    private final BooleanSupplier noticesDefault;
    private final Supplier<List<WandMode>> modes;
    private final Supplier<PatchStatus> patches;
    private long lastPatchId = -1;
    private record Sent(ServerPlayer player, String json) {}
    /** Per player, the outlines their client half last got (op 4). */
    private final Map<UUID, Sent> sent = new HashMap<>();
    private final Map<UUID, Integer> particles = new ConcurrentHashMap<>();

    public Feedback(PlayerStates players, BooleanSupplier noticesDefault, Supplier<List<WandMode>> modes, Supplier<PatchStatus> patches) {
        this.players = players;
        this.noticesDefault = noticesDefault;
        this.modes = modes;
        this.patches = patches;
    }

    public void serverStarted() {
        lastPatchId = -1;
        sent.clear();
        particles.clear();
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
            // A notice to one player answers something they did (/autosketch done), so it shows whatever their notices setting.
            ServerPlayer p = server.getPlayerList().getPlayer(player);
            if (p != null) actionBar(p, c);
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
        boolean particleTick = tick % OUTLINE_PERIOD == 0, modeLine = tick % MODE_LINE_PERIOD == 0;
        // 16: nothing drawn while no MCP is connected; volumes show again on connect
        LinkStatus link = Link.status();
        List<WandMode> all = modes.get();
        Platform platform = Platform.get();
        List<ServerPlayer> online = server.getPlayerList().getPlayers();
        for (ServerPlayer p : online) {
            boolean op = p.hasPermissions(CommandExtension.OP_LEVEL);
            PlayerStates.State st = op ? players.get(p.getUUID()) : null;
            boolean holding = op && Wand.isWand(p.getMainHandItem());
            boolean shown = op && link != LinkStatus.OFFLINE && (holding || st.show);
            boolean channel = platform.hasUiChannel(p);
            // 13, *Relay to the client*, op 4: the client half draws them while linked; everyone else gets particles.
            if (channel && link == LinkStatus.CONNECTED) send(platform, p, shown ? outlines(p, all) : VolumeOutlines.none(dimension(p)));
            else {
                if (channel) send(platform, p, VolumeOutlines.none(dimension(p)));
                if (shown && particleTick) drawOutlines(p, all);
            }
            if (op && modeLine && link != LinkStatus.OFFLINE && holding && p.serverLevel().getGameTime() >= st.actionBarBusyUntil && !all.isEmpty())
                p.displayClientMessage(Component.literal(MODE_LINE_PREFIX + all.get(Math.floorMod(st.mode, all.size())).name() + " mode"), true);
        }
        if (particleTick && sent.size() > online.size()) sent.keySet().removeIf(u -> server.getPlayerList().getPlayer(u) == null);
    }

    /** What the player's client half draws (op 4): each wand mode's boxes in its colour, in mode order. */
    static VolumeOutlines outlines(ServerPlayer p, List<WandMode> all) {
        List<VolumeOutlines.Entry> out = new ArrayList<>(all.size());
        for (WandMode m : all) out.add(new VolumeOutlines.Entry(m.colour() & 0xFFFFFF, m.outline(p)));
        return new VolumeOutlines(dimension(p), out);
    }

    private static String dimension(ServerPlayer p) {
        return p.serverLevel().dimension().location().toString();
    }

    /**
     * Sends the outlines when they differ from what this player's client last got. A new
     * {@code ServerPlayer} (a join, so a fresh client half) always gets them.
     */
    private void send(Platform platform, ServerPlayer p, VolumeOutlines o) {
        String json = o.toJson();
        Sent prev = sent.get(p.getUUID());
        if (prev != null && prev.player == p && prev.json.equals(json)) return;
        sent.put(p.getUUID(), new Sent(p, json));
        platform.sendVolumeOutlines(p, json);
    }

    /** For tests: the outlines JSON this player's client half last got, or null. */
    public @Nullable String lastOutlines(UUID player) {
        Sent s = sent.get(player);
        return s == null ? null : s.json;
    }

    /** For tests: outline particles sent to this player since the server started. */
    public int particlesSent(UUID player) {
        return particles.getOrDefault(player, 0);
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
        int n = MAX_POINTS - Math.max(budget[0], 0);
        if (n > 0) particles.merge(p.getUUID(), n, Integer::sum);
    }

    /** One box's outline in a colour, for this player only (air mode's preview point, B2). */
    public static void outline(ServerPlayer p, int rgb, Box b) {
        DustParticleOptions dust = new DustParticleOptions(new Vector3f(((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f), 1.0f);
        drawBox(p, dust, b, new int[] {MAX_POINTS});
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
