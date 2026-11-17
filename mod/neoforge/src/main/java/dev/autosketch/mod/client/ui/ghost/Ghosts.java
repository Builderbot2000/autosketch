package dev.autosketch.mod.client.ui.ghost;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.blocks.BlockDrawer;
import dev.autosketch.mod.client.ui.blocks.BlockMesh;
import dev.autosketch.mod.client.ui.blocks.BlockMesher;
import dev.autosketch.mod.client.ui.blocks.PaletteRegion;
import dev.autosketch.mod.protocol.UiMessages.GhostSection;
import dev.autosketch.mod.protocol.UiMessages.UiGhost;
import dev.autosketch.mod.protocol.UiMessages.UiGhostClear;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.culling.Frustum;
import net.minecraft.core.SectionPos;
import net.minecraft.network.chat.Component;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * Ghost blocks in the world (16, *Ghost blocks*): every {@code ui.ghost} the MCP sends, a sandbox's
 * blocks before merge or an unlinked document at an anchor, drawn translucent in its tint with the
 * shared block drawing ({@code client.ui.blocks}).
 *
 * <ul>
 *   <li><b>Sections.</b> A ghost is meshed per 16³ section of its local grid; an update re-meshes
 *       only the sections it lists (13: whole sections replace whole sections), so a neighbour's
 *       border faces keep the culling they were meshed with. Meshing runs before drawing, within a
 *       per-frame time budget, so a large ghost fills in over a few frames instead of stalling one.
 *   <li><b>Freed</b> on {@code ui.ghost.clear} (that ghost), when the link stops being connected and
 *       when the player leaves the server (every ghost: the MCP resends them on resync), and when the
 *       player leaves a ghost's dimension (its meshes only; the blocks are kept, 13: other
 *       dimensions are kept but not drawn).
 *   <li><b>Drawn</b> only while {@link LinkState#connected()} and {@link UiToggles#ghosts} (toggled
 *       by its key), after the level, frustum-culled per section.
 *   <li><b>Anchors.</b> {@code /autosketch ghost here} and the wand's {@code ghost} mode reach the
 *       client as the action {@code ghost.here <dimension> <x> <y> <z>} and are sent as a
 *       {@code ghost.anchor} request; {@code /autosketch ghost clear} is {@code ghost.clear}, which
 *       sends a {@code ghost.clear} request for each ghost this client anchored.
 * </ul>
 *
 * Client thread (render thread) only. 1.21.x: {@code RenderLevelStageEvent}'s stage and matrices
 * are what a port checks.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID, value = Dist.CLIENT)
public final class Ghosts {
    private Ghosts() {}

    private static final Logger LOG = LogUtils.getLogger();

    /** How strongly the job's colour tints a ghost (the rest is white), and its opacity (tests change it). */
    public static final float TINT_AMOUNT = 0.5f;
    public static volatile float alpha = 0.55f;

    /** Meshing time allowed per frame. Tests raise it. */
    public static volatile long meshBudgetNanos = 4_000_000L;

    private static final Map<String, Ghost> ghosts = new LinkedHashMap<>();
    private static final Set<String> anchored = new LinkedHashSet<>();
    private static int drawnSections;
    private static long drawnFrames;

    @SubscribeEvent
    static void setup(FMLClientSetupEvent e) {
        e.enqueueWork(Ghosts::init);
    }

    private static void init() {
        UiClient.register("ui.ghost", (f, m) -> apply((UiGhost) m));
        UiClient.register("ui.ghost.clear", (f, m) -> clear(((UiGhostClear) m).ghost()));
        UiClient.onAction("ghost.here", Ghosts::here);
        UiClient.onAction("ghost.clear", a -> clearAnchored());
        AutosketchKeys.on(AutosketchKeys.TOGGLE_GHOSTS, UiToggles::toggleGhosts);
        LinkState.addListener(s -> {
            if (s != LinkState.State.CONNECTED) clearAll();
        });
        NeoForge.EVENT_BUS.addListener((ClientPlayerNetworkEvent.LoggingOut ev) -> clearAll());
        NeoForge.EVENT_BUS.addListener(Ghosts::render);
    }

    // ── messages ─────────────────────────────────────────────────────────────────────────────

    /** A {@code ui.ghost}: replaces the listed sections (all of them when {@code full}); moves and retints. */
    static void apply(UiGhost g) {
        if (!LinkState.connected()) return;
        Ghost ghost = ghosts.computeIfAbsent(g.ghost(), Ghost::new);
        ghost.dimension = g.dimension();
        ghost.ox = g.originX();
        ghost.oy = g.originY();
        ghost.oz = g.originZ();
        ghost.tint = g.tint();
        Set<Long> listed = new HashSet<>();
        List<String> unknown = new ArrayList<>();
        BlockState[] palette = PaletteRegion.resolve(g.palette(), unknown);
        if (!unknown.isEmpty()) LOG.debug("Autosketch ghost {}: states this game doesn't know draw as nothing: {}", g.ghost(), unknown);
        boolean[] air = new boolean[palette.length];
        for (int i = 0; i < palette.length; i++) air[i] = palette[i].isAir();
        for (GhostSection s : g.sections()) {
            long key = SectionPos.asLong(s.sx(), s.sy(), s.sz());
            listed.add(key);
            if (allAir(s.states(), air)) ghost.remove(key);
            else ghost.put(key, Ghost.Section.of(palette, s.states()));
        }
        if (g.full())
            for (Long key : new ArrayList<>(ghost.sections.keySet()))
                if (!listed.contains(key)) ghost.remove(key);
    }

    private static boolean allAir(int[] states, boolean[] air) {
        for (int i : states)
            if (!air[i]) return false;
        return true;
    }

    /** A {@code ui.ghost.clear}: removes the ghost and frees its meshes. */
    static void clear(String id) {
        Ghost g = ghosts.remove(id);
        if (g != null) g.free();
        anchored.remove(id);
    }

    static void clearAll() {
        for (Ghost g : ghosts.values()) g.free();
        ghosts.clear();
        anchored.clear();
        drawnSections = 0;
    }

    // ── anchors ──────────────────────────────────────────────────────────────────────────────

    /** The action {@code ghost.here <dimension> <x> <y> <z>}: asks the MCP to anchor the unlinked document there. */
    static void here(String args) {
        if (!LinkState.connected()) return;
        String[] a = args.trim().split(" ");
        if (a.length != 4) {
            LOG.warn("Autosketch: bad ghost.here action \"{}\"", args);
            return;
        }
        JsonObject req = new JsonObject();
        req.addProperty("dimension", a[0]);
        JsonArray pos = new JsonArray();
        for (int i = 1; i < 4; i++) pos.add(Integer.parseInt(a[i]));
        req.add("pos", pos);
        UiClient.request("ghost.anchor", req, r -> {
            if (r.ok() && r.result() != null && r.result().has("ghost")) {
                anchored.add(r.result().get("ghost").getAsString());
                line("Autosketch: document anchored at " + a[1] + " " + a[2] + " " + a[3]);
            } else {
                line("Autosketch: " + (r.message() != null ? r.message() : "couldn't anchor the document"));
            }
        });
    }

    /** The action {@code ghost.clear}: removes the ghosts this client anchored. */
    static void clearAnchored() {
        if (!LinkState.connected()) return;
        if (anchored.isEmpty()) {
            line("Autosketch: no document is anchored");
            return;
        }
        for (String id : List.copyOf(anchored)) {
            JsonObject req = new JsonObject();
            req.addProperty("ghost", id);
            UiClient.request("ghost.clear", req, r -> {
                if (r.ok()) anchored.remove(id);
                else line("Autosketch: " + (r.message() != null ? r.message() : "couldn't clear the ghost"));
            });
        }
    }

    private static void line(String text) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) mc.player.displayClientMessage(Component.literal(text), true);
    }

    // ── drawing ──────────────────────────────────────────────────────────────────────────────

    static void render(RenderLevelStageEvent e) {
        if (e.getStage() != RenderLevelStageEvent.Stage.AFTER_LEVEL) return;
        drawnFrames++;
        drawnSections = 0;
        Minecraft mc = Minecraft.getInstance();
        if (mc.level == null || ghosts.isEmpty()) return;
        String dim = mc.level.dimension().location().toString();
        boolean show = LinkState.connected() && UiToggles.ghosts;
        long deadline = System.nanoTime() + meshBudgetNanos;
        Vec3 cam = e.getCamera().getPosition();
        Frustum frustum = e.getFrustum();
        for (Ghost g : ghosts.values()) {
            if (!show || !g.dimension.equals(dim)) {
                // Not drawn here: let go of the GPU memory, keep the blocks.
                if (!g.meshes.isEmpty()) g.freeMeshes();
                continue;
            }
            mesh(g, mc, deadline);
            List<BlockMesh> visible = new ArrayList<>(g.meshes.size());
            for (BlockMesh m : g.meshes.values()) {
                double x = g.ox + m.x(), y = g.oy + m.y(), z = g.oz + m.z();
                if (frustum == null || frustum.isVisible(new AABB(x, y, z, x + 16, y + 16, z + 16))) visible.add(m);
            }
            drawnSections += visible.size();
            BlockDrawer.draw(visible, e.getModelViewMatrix(), e.getProjectionMatrix(), g.ox - cam.x, g.oy - cam.y, g.oz - cam.z,
                    BlockDrawer.towardWhite(g.tint, TINT_AMOUNT), alpha);
        }
    }

    private static void mesh(Ghost g, Minecraft mc, long deadline) {
        for (Iterator<Long> it = g.dirty.iterator(); it.hasNext() && System.nanoTime() < deadline;) {
            long key = it.next();
            it.remove();
            BlockMesh old = g.meshes.remove(key);
            if (old != null) old.close();
            if (!g.sections.containsKey(key)) continue;
            BlockMesh m = BlockMesher.section(g, SectionPos.x(key), SectionPos.y(key), SectionPos.z(key), mc.level, g.ox, g.oy, g.oz);
            g.meshCounts.merge(key, 1, Integer::sum);
            if (m != null) g.meshes.put(key, m);
        }
    }

    // ── state, for tests and measurements ────────────────────────────────────────────────────

    /** The ghost ids held, in arrival order. */
    public static List<String> ids() {
        return List.copyOf(ghosts.keySet());
    }

    /** A ghost's sections holding blocks, as {@code [sx,sy,sz]}; empty for an unknown ghost. */
    public static Set<List<Integer>> sections(String id) {
        Ghost g = ghosts.get(id);
        return g == null ? Set.of() : keys(g.sections.keySet());
    }

    /** A ghost's sections with a mesh on the GPU. */
    public static Set<List<Integer>> meshed(String id) {
        Ghost g = ghosts.get(id);
        return g == null ? Set.of() : keys(g.meshes.keySet());
    }

    /** How many times each of a ghost's sections was meshed since the ghost arrived. */
    public static Map<List<Integer>, Integer> meshCounts(String id) {
        Ghost g = ghosts.get(id);
        if (g == null) return Map.of();
        Map<List<Integer>, Integer> out = new HashMap<>();
        g.meshCounts.forEach((k, v) -> out.put(key(k), v));
        return out;
    }

    /** Sections of every ghost waiting to be meshed. */
    public static int pending() {
        int n = 0;
        for (Ghost g : ghosts.values()) n += g.dirty.size();
        return n;
    }

    /** A ghost's origin, dimension and tint, or null. */
    public static @Nullable String describe(String id) {
        Ghost g = ghosts.get(id);
        return g == null ? null : g.dimension + " " + g.ox + " " + g.oy + " " + g.oz + " #" + String.format("%06x", g.tint);
    }

    /** GPU bytes of every ghost mesh, and bytes of the blocks held. */
    public static long meshBytes() {
        long n = 0;
        for (Ghost g : ghosts.values())
            for (BlockMesh m : g.meshes.values()) n += m.bytes();
        return n;
    }

    public static long blockBytes() {
        long n = 0;
        for (Ghost g : ghosts.values())
            for (Ghost.Section s : g.sections.values()) n += s.bytes();
        return n;
    }

    /** Ghost ids this client anchored and hasn't cleared. */
    public static Set<String> anchored() {
        return Collections.unmodifiableSet(new LinkedHashSet<>(anchored));
    }

    /** Sections drawn in the last frame, and frames drawn so far (to wait for a fresh frame). */
    public static int drawnSections() {
        return drawnSections;
    }

    public static long drawnFrames() {
        return drawnFrames;
    }

    /** Applies a ghost as if it arrived from the MCP (measurements with ghosts too large for a script). */
    public static void applyForTest(UiGhost g) {
        apply(g);
    }

    /** Removes a ghost as a {@code ui.ghost.clear} would. */
    public static void clearForTest(String id) {
        clear(id);
    }

    private static Set<List<Integer>> keys(Set<Long> ks) {
        Set<List<Integer>> out = new HashSet<>();
        for (long k : ks) out.add(key(k));
        return out;
    }

    private static List<Integer> key(long k) {
        return List.of(SectionPos.x(k), SectionPos.y(k), SectionPos.z(k));
    }
}
