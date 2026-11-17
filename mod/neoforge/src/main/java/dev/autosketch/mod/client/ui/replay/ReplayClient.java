package dev.autosketch.mod.client.ui.replay;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.UiMessages.ReplayFrame;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.InputEvent;
import net.neoforged.neoforge.event.level.ChunkEvent;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * Replay in the world, client half (16, *Replay in the world*; 13, {@code replay.frame} and the
 * replay request kinds). The client overrides the replayed volume's blocks in its own copy of the
 * world, from a keyframe and then forward deltas; the server's world is never touched, and the
 * server half resends the volume's chunks when the replay closes ({@code ReplayResend}). While open,
 * the server's live block updates inside the volume are dropped (the client mixin asks
 * {@link #dropsServerUpdate}), chunks loading inside the volume get the current frame reapplied, the
 * camera is detached and the player frozen ({@link ReplayCamera}), and the replay keys step, play
 * and jump between markers, each sending {@code replay.seek} or changing the local play speed.
 *
 * <p>It decides nothing about steps: the MCP answers every seek with a frame, and the client only
 * keeps one seek in flight and remembers the step it wants. Deltas apply only when the client shows
 * their {@code from}; otherwise it seeks again and the MCP sends a keyframe. Everything runs on the
 * client thread.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID, value = Dist.CLIENT)
public final class ReplayClient {
    private ReplayClient() {}

    private static final Logger LOG = LogUtils.getLogger();

    /** Play speeds in steps per second; {@link #DEFAULT_SPEED} indexes the default. */
    public static final double[] SPEEDS = {0.5, 1, 2, 4, 8, 16};
    public static final int DEFAULT_SPEED = 2;

    /** Positions written per client tick while a keyframe or a reloaded chunk is applied (spreads big volumes over ticks). */
    static final int APPLY_BUDGET = 65_536;

    /** {@code setBlock} flags: tell the renderer, no neighbour updates or shape changes, so the frame's states show exactly. */
    private static final int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE;

    private static @Nullable ReplayView view;
    /** The id {@code replay.open} answered, while its keyframe hasn't arrived. */
    private static @Nullable String opening;
    private static long target = -1;
    private static long requested = -1;
    private static boolean inFlight;
    private static boolean playing;
    private static int speed = DEFAULT_SPEED;
    private static long nextPlayAt;

    /** Applying the whole volume: the region and position the cursor is at; -1 when done. */
    private static int applyRegion = -1;
    private static int applyIndex;
    /** Chunks that loaded inside the volume and need the frame again. */
    private static final ArrayDeque<ChunkPos> reloads = new ArrayDeque<>();

    // ── state, for the HUD strip, the mixin and tests ─────────────────────────────────────────

    /** Whether a replay is open (the replay keys are active, the camera detached). */
    public static boolean isOpen() {
        return view != null || opening != null;
    }

    /** The open replay's id, or null. */
    public static @Nullable String replay() {
        return view != null ? view.replay : opening;
    }

    /** The step the client shows (-1 before the first keyframe or with no replay). */
    public static long step() {
        return view == null ? -1 : view.step;
    }

    /** The log's steps, or 0. */
    public static long steps() {
        return view == null ? 0 : view.steps;
    }

    public static boolean playing() {
        return playing;
    }

    /** The play speed in steps per second. */
    public static double speed() {
        return SPEEDS[speed];
    }

    /** True when the shown frame is fully written into the client's world (no keyframe or chunk reapply pending). */
    public static boolean settled() {
        return view != null && view.step >= 0 && applyRegion < 0 && reloads.isEmpty() && !inFlight && target == view.step;
    }

    /** The frame's stored state at a position (null outside the volume or with no replay). For tests and the strip. */
    public static @Nullable BlockState frameState(BlockPos p) {
        return view == null ? null : view.stateAt(p);
    }

    static @Nullable ReplayView view() {
        return view;
    }

    /**
     * The mixin's check, one box test per update: a server block update at {@code pos} is dropped
     * while a replay shows that position in the player's current dimension.
     */
    public static boolean dropsServerUpdate(BlockPos pos) {
        ReplayView v = view;
        return v != null && inDimension(v) && v.contains(pos);
    }

    private static boolean inDimension(ReplayView v) {
        ClientLevel l = Minecraft.getInstance().level;
        return l != null && l.dimension().location().toString().equals(v.dimension);
    }

    // ── wiring ────────────────────────────────────────────────────────────────────────────────

    @SubscribeEvent
    static void clientSetup(FMLClientSetupEvent e) {
        e.enqueueWork(() -> {
            UiClient.register("replay.frame", (Frame f, Record m) -> frame((ReplayFrame) m));
            UiClient.onAction("replay.list", a -> list());
            UiClient.onAction("replay.open", a -> open(a.isBlank() ? null : a.strip()));
            UiClient.onAction("replay.close", a -> close());
            AutosketchKeys.setReplayOpen(ReplayClient::isOpen);
            AutosketchKeys.on(AutosketchKeys.REPLAY_BACK, () -> seekBy(-1));
            AutosketchKeys.on(AutosketchKeys.REPLAY_FORWARD, () -> seekBy(1));
            AutosketchKeys.on(AutosketchKeys.REPLAY_PLAY, ReplayClient::togglePlay);
            AutosketchKeys.on(AutosketchKeys.REPLAY_SLOWER, () -> changeSpeed(-1));
            AutosketchKeys.on(AutosketchKeys.REPLAY_FASTER, () -> changeSpeed(1));
            AutosketchKeys.on(AutosketchKeys.REPLAY_PREVIOUS_MARKER, ReplayClient::previousMarker);
            AutosketchKeys.on(AutosketchKeys.REPLAY_NEXT_MARKER, ReplayClient::nextMarker);
            AutosketchKeys.on(AutosketchKeys.REPLAY_CLOSE, ReplayClient::close);
            LinkState.addListener(s -> {
                // Offline or an older MCP: the server half resends the chunks for an open replay on disconnect.
                if (s != LinkState.State.CONNECTED) teardown();
            });
        });
    }

    @SubscribeEvent
    static void loggingOut(ClientPlayerNetworkEvent.LoggingOut e) {
        teardown();
    }

    @SubscribeEvent
    static void chunkLoaded(ChunkEvent.Load e) {
        ReplayView v = view;
        if (v == null || !e.getLevel().isClientSide()) return;
        ChunkPos c = e.getChunk().getPos();
        Box chunk = new Box(c.getMinBlockX(), Integer.MIN_VALUE / 2, c.getMinBlockZ(), c.getMaxBlockX(), Integer.MAX_VALUE / 2, c.getMaxBlockZ());
        for (ReplayView.Region r : v.regions)
            if (r.box().intersects(chunk)) {
                reloads.add(c);
                return;
            }
    }

    @SubscribeEvent
    static void scroll(InputEvent.MouseScrollingEvent e) {
        if (!isOpen() || Minecraft.getInstance().screen != null) return;
        e.setCanceled(true);
        if (e.getScrollDeltaY() != 0 && LinkState.connected()) seekBy(e.getScrollDeltaY() > 0 ? 1 : -1);
    }

    @SubscribeEvent
    static void tick(ClientTickEvent.Post e) {
        if (!isOpen()) return;
        ReplayCamera.tick();
        ReplayView v = view;
        if (v == null) return;
        apply(v);
        if (playing && !inFlight && System.currentTimeMillis() >= nextPlayAt) {
            if (v.step >= v.steps) {
                playing = false;
            } else {
                seekTo(v.step + 1);
                nextPlayAt = System.currentTimeMillis() + (long) (1000 / SPEEDS[speed]);
            }
        }
    }

    // ── commands (client actions from /autosketch replay) ────────────────────────────────────

    /** {@code /autosketch replay}: the workspace's session logs as clickable chat lines, newest first. */
    static void list() {
        if (!LinkState.connected()) return;
        UiClient.request("logs.list", new JsonObject(), r -> {
            if (!r.ok() || r.result() == null) {
                say(Component.literal("Autosketch: couldn't list the session logs: " + r.message()).withStyle(ChatFormatting.RED));
                return;
            }
            JsonArray logs = r.result().getAsJsonArray("logs");
            if (logs == null || logs.isEmpty()) {
                say(Component.literal("Autosketch: no session logs in the workspace"));
                return;
            }
            say(Component.literal("Autosketch: session logs, newest first (click one to replay it)"));
            List<Component> shown = new ArrayList<>();
            for (JsonElement e : logs) shown.add(logLine(e.getAsJsonObject()));
            listed = List.copyOf(shown);
            shown.forEach(ReplayClient::say);
        });
    }

    static Component logLine(JsonObject log) {
        String id = log.get("id").getAsString();
        boolean live = log.has("live") && log.get("live").getAsBoolean();
        String command = "/autosketch replay " + (live ? "live" : id);
        MutableComponent line = Component.literal("  " + str(log, "modified") + "  " + str(log, "doc") + "  " + str(log, "session")).withStyle(ChatFormatting.AQUA);
        if (live) line.append(Component.literal("  (live)").withStyle(ChatFormatting.GREEN));
        return line.withStyle(s -> s.withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, command))
                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Component.literal(command))));
    }

    private static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "" : e.getAsString();
    }

    /** {@code /autosketch replay <log>} ({@code null}: the live session): sends {@code replay.open}. */
    static void open(@Nullable String log) {
        if (!LinkState.connected()) return;
        JsonObject args = new JsonObject();
        args.add("log", log == null ? JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(log));
        UiClient.request("replay.open", args, r -> {
            if (!r.ok() || r.result() == null) {
                say(Component.literal("Autosketch: couldn't open the replay: " + r.message()).withStyle(ChatFormatting.RED));
                return;
            }
            String id = r.result().get("replay").getAsString();
            if (view != null && !view.replay.equals(id)) teardown();
            if (view == null) {
                opening = id;
                ReplayCamera.detach();
            }
        });
    }

    /** Backspace or {@code /autosketch replay close}: sends {@code replay.close} and gives the camera back. */
    public static void close() {
        String id = replay();
        if (id == null) return;
        if (LinkState.connected()) {
            JsonObject args = new JsonObject();
            args.addProperty("replay", id);
            UiClient.request("replay.close", args, r -> {});
        }
        teardown();
    }

    /** Ends the replay locally: camera and player back, no more overrides or dropped updates. The server's chunk resend restores the blocks. */
    static void teardown() {
        if (!isOpen()) return;
        ReplayCamera.restore();
        view = null;
        opening = null;
        target = requested = -1;
        inFlight = playing = false;
        speed = DEFAULT_SPEED;
        applyRegion = -1;
        reloads.clear();
    }

    // ── frames ────────────────────────────────────────────────────────────────────────────────

    static void frame(ReplayFrame f) {
        ReplayView v = view;
        if (f.keyframe()) {
            if (v == null || !v.replay.equals(f.replay())) {
                // A keyframe of a replay the client doesn't show: it opened elsewhere (or replaced ours).
                if (v != null) teardown();
                if (!LinkState.connected()) return;
                v = new ReplayView(f.replay());
                view = v;
                opening = null;
                ReplayCamera.detach();
            }
            v.keyframe(f);
            if (target < 0 || !inFlight) target = f.step();
            if (!inFlight) requested = f.step();
            applyRegion = 0;
            applyIndex = 0;
            reloads.clear();
            pump();
            return;
        }
        if (v == null || !v.replay.equals(f.replay())) return;
        if (f.from() != v.step) {
            LOG.debug("Autosketch replay: dropped a delta from step {} while showing {}", f.from(), v.step);
            requested = -1; // seek again; the MCP answers with a keyframe
            if (target < 0) target = f.step();
            pump();
            return;
        }
        List<WorldBlock> changed = v.delta(f);
        if (inDimension(v)) {
            ClientLevel l = Minecraft.getInstance().level;
            for (WorldBlock b : changed) write(l, b.pos(), v.stateAt(b.pos()));
        }
        pump();
    }

    /** Writes the stored states into the world, up to the budget: the keyframe cursor first, then reloaded chunks. */
    private static void apply(ReplayView v) {
        if (!inDimension(v)) return;
        ClientLevel l = Minecraft.getInstance().level;
        int budget = APPLY_BUDGET;
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        while (applyRegion >= 0 && budget > 0) {
            if (applyRegion >= v.regions.size()) {
                applyRegion = -1;
                break;
            }
            ReplayView.Region r = v.regions.get(applyRegion);
            Box b = r.box();
            int n = r.states().length;
            while (applyIndex < n && budget-- > 0) {
                int i = applyIndex++;
                int dx = i % b.sizeX(), t = i / b.sizeX();
                p.set(b.minX() + dx, b.minY() + t / b.sizeZ(), b.minZ() + t % b.sizeZ());
                write(l, p, v.palette.get(r.states()[i]));
            }
            if (applyIndex >= n) {
                applyRegion++;
                applyIndex = 0;
            }
        }
        while (!reloads.isEmpty() && budget > 0) {
            ChunkPos c = reloads.poll();
            for (ReplayView.Region r : v.regions) {
                Box b = r.box();
                int x0 = Math.max(b.minX(), c.getMinBlockX()), x1 = Math.min(b.maxX(), c.getMaxBlockX());
                int z0 = Math.max(b.minZ(), c.getMinBlockZ()), z1 = Math.min(b.maxZ(), c.getMaxBlockZ());
                for (int y = b.minY(); y <= b.maxY(); y++)
                    for (int z = z0; z <= z1; z++)
                        for (int x = x0; x <= x1; x++) {
                            p.set(x, y, z);
                            write(l, p, v.palette.get(r.states()[r.index(x, y, z)]));
                            budget--;
                        }
            }
        }
    }

    private static void write(@Nullable ClientLevel l, BlockPos p, @Nullable BlockState s) {
        if (l == null || s == null || !l.isLoaded(p)) return;
        if (l.getBlockState(p) != s) l.setBlock(p, s, FLAGS);
    }

    // ── controls ──────────────────────────────────────────────────────────────────────────────

    static void seekBy(int d) {
        ReplayView v = view;
        if (v == null) return;
        long from = target >= 0 ? target : v.step;
        seekTo(from + d);
    }

    /** Asks for a step (clamped to the log); one seek is in flight at a time, later ones replace the wanted step. */
    static void seekTo(long step) {
        ReplayView v = view;
        if (v == null) return;
        target = Math.max(0, Math.min(v.steps, step));
        pump();
    }

    private static void pump() {
        ReplayView v = view;
        if (v == null || inFlight || target < 0 || !LinkState.connected()) return;
        // requested -1: a delta was dropped, so seek even for the step shown (the MCP answers with a keyframe).
        if (requested >= 0 && target == requested) return;
        long want = target;
        JsonObject args = new JsonObject();
        args.addProperty("replay", v.replay);
        args.addProperty("step", want);
        inFlight = true;
        requested = want;
        UiClient.request("replay.seek", args, seekResult(v.replay));
    }

    private static Consumer<UiResult> seekResult(String replay) {
        return r -> {
            ReplayView v = view;
            if (v == null || !v.replay.equals(replay)) return;
            inFlight = false;
            if (!r.ok()) {
                if ("not_found".equals(r.error())) {
                    // The MCP closed it (a resync, a restart): nothing left to show.
                    say(Component.literal("Autosketch: the replay was closed: " + r.message()).withStyle(ChatFormatting.RED));
                    teardown();
                    return;
                }
                if (!"busy".equals(r.error())) {
                    Minecraft.getInstance().player.displayClientMessage(Component.literal("Autosketch: " + r.message()), true);
                    target = v.step;
                    playing = false;
                }
                requested = -1;
                return;
            }
            pump();
        };
    }

    static void togglePlay() {
        ReplayView v = view;
        if (v == null) return;
        playing = !playing;
        if (playing && v.step >= v.steps) seekTo(0);
        nextPlayAt = System.currentTimeMillis();
    }

    static void changeSpeed(int d) {
        speed = Math.max(0, Math.min(SPEEDS.length - 1, speed + d));
    }

    static void previousMarker() {
        ReplayView v = view;
        if (v == null) return;
        long s = v.previousMarker(target >= 0 ? target : v.step);
        if (s >= 0) seekTo(s);
    }

    static void nextMarker() {
        ReplayView v = view;
        if (v == null) return;
        long s = v.nextMarker(target >= 0 ? target : v.step);
        if (s >= 0) seekTo(s);
    }

    private static void say(Component c) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) mc.player.displayClientMessage(c, false);
    }

    private static List<Component> listed = List.of();

    /** For tests: the log lines the last {@code /autosketch replay} listed (they go to the local chat, which tests can't read). */
    public static List<Component> listed() {
        return listed;
    }

    /** For tests: the markers' steps of the open replay. */
    public static List<Long> markerSteps() {
        List<Long> out = new ArrayList<>();
        if (view != null) view.markers.forEach(m -> out.add(m.step()));
        return out;
    }
}
