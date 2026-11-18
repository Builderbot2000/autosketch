package dev.autosketch.mod.client.ui.screen;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.client.ui.blocks.BlockDrawer;
import dev.autosketch.mod.client.ui.blocks.BlockMesh;
import dev.autosketch.mod.client.ui.blocks.BlockMesher;
import dev.autosketch.mod.client.ui.blocks.PaletteRegion;
import dev.autosketch.mod.protocol.Bodies;
import dev.autosketch.mod.protocol.Box;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * A prefab's 3D orbit preview in a pane (16, *Library screen*; 17 piece 4), shared by the library
 * screen and the candidates screen: its {@code library.preview} voxels meshed once with the ghosts'
 * block drawing ({@code client.ui.blocks}, models only) and drawn in a square with an orbit camera
 * the player turns by dragging. The screen calls {@link #load} on selection, {@link #layout} while
 * laying out the pane, {@link #render} from {@code renderPane}, the mouse methods from its own, and
 * {@link #close} when the selection changes or the screen closes (which frees the meshes).
 */
final class OrbitPreview {
    private static final Logger LOG = LogUtils.getLogger();

    private final PaneScreen screen;
    private final List<BlockMesh> meshes = new ArrayList<>();
    private int[] size = {0, 0, 0};
    private @Nullable Component note;
    private int noteColour = PaneScreen.DIM;
    private boolean loaded;
    private float yaw = 35, pitch = 25;
    private int draws;
    /** The square in content coordinates of {@link #paneKey}'s pane, from the last layout; side 0 when none. */
    private int squareY, side;
    private String paneKey = "";
    private boolean dragging;

    OrbitPreview(PaneScreen screen) {
        this.screen = screen;
    }

    // ── for tests ───────────────────────────────────────────────────────────────────────────────

    /** Quads of the meshes (0 before the voxels arrived). */
    int quads() {
        return meshes.stream().mapToInt(BlockMesh::quads).sum();
    }

    /** Frames that drew the preview so far. */
    int draws() {
        return draws;
    }

    /** The square's centre in screen coordinates, or null when none is laid out. */
    int @Nullable [] centre() {
        if (side == 0) return null;
        for (PaneScreen.Pane p : screen.panes) if (p.key.equals(paneKey)) return new int[] {p.x + side / 2, p.y + squareY - p.scroll + side / 2};
        return null;
    }

    float[] angles() {
        return new float[] {yaw, pitch};
    }

    // ── loading ─────────────────────────────────────────────────────────────────────────────────

    /**
     * Asks for a prefab's voxels and meshes them; {@code wanted} says the answer is still for the
     * selection on screen (else it is dropped). Call {@link #close} first.
     */
    void load(String root, String name, BooleanSupplier wanted) {
        loaded = false;
        note = null;
        Requests.send("library.preview", Requests.args("root", root, "name", name), r -> {
            if (!wanted.getAsBoolean()) return;
            loaded = true;
            if (!r.ok()) {
                note = Component.literal(r.message());
                noteColour = PaneScreen.BAD;
                screen.refresh();
                return;
            }
            try {
                var s = r.result().getAsJsonArray("size");
                int sx = s.get(0).getAsInt(), sy = s.get(1).getAsInt(), sz = s.get(2).getAsInt();
                Bodies.SnapshotBody body = Bodies.decodeSnapshot(r.body(), List.of(new Box(0, 0, 0, sx - 1, sy - 1, sz - 1)));
                PaletteRegion region = PaletteRegion.of(body.palette(), sx, sy, sz, body.regions().get(0).states());
                meshes.addAll(BlockMesher.all(region));
                size = new int[] {sx, sy, sz};
                if (!region.unknown().isEmpty()) {
                    note = PaneScreen.tr("library.preview_unknown", String.join(", ", region.unknown()));
                    noteColour = PaneScreen.WARN;
                }
            } catch (Exception ex) {
                LOG.warn("Autosketch: preview of {} didn't load: {}", name, ex.toString());
                note = PaneScreen.tr("library.preview_failed", ex.getMessage() == null ? ex.toString() : ex.getMessage());
                noteColour = PaneScreen.BAD;
            }
            screen.refresh();
        });
    }

    /** Frees the meshes and forgets the prefab. */
    void close() {
        meshes.forEach(BlockMesh::close);
        meshes.clear();
        size = new int[] {0, 0, 0};
        loaded = false;
        note = null;
    }

    // ── layout and drawing ──────────────────────────────────────────────────────────────────────

    /** Lays out the preview square at content row {@code y} of {@code p}; returns the y below it. */
    int layout(PaneScreen.Pane p, int y) {
        side = 0;
        paneKey = p.key;
        if (!loaded) {
            screen.text(p, 0, y, PaneScreen.tr("library.preview_loading"), PaneScreen.DIM);
            return y + PaneScreen.LINE + 2;
        }
        if (!meshes.isEmpty()) {
            squareY = y;
            // Square, as wide as the pane allows, leaving room below for the actions in a short window.
            side = Math.max(40, Math.min(Math.min(p.w - 6, 140), p.h - y - 72));
            p.content = Math.max(p.content, y + side);
            y += side + 2;
            screen.text(p, 0, y, PaneScreen.tr("library.preview_hint"), PaneScreen.DIM);
            y += PaneScreen.LINE;
        }
        if (note != null) y += screen.wrap(p, 0, y, note, noteColour);
        return y + 2;
    }

    /** Draws the preview if {@code p} is the pane it was laid out in (call from {@code renderPane}). */
    void render(GuiGraphics g, PaneScreen.Pane p) {
        if (!p.key.equals(paneKey) || side == 0 || meshes.isEmpty()) return;
        int x0 = p.x, y0 = p.y + squareY - p.scroll;
        g.fill(x0, y0, x0 + side, y0 + side, 0xFF202020);
        int sx = size[0], sy = size[1], sz = size[2];
        // Fit the region's bounding sphere in the square.
        float extent = (float) Math.sqrt(sx * sx + sy * sy + sz * sz);
        float scale = side * 0.9f / Math.max(1f, extent);
        BlockDrawer.drawInScreen(g, meshes, sx, sy, sz, x0 + side / 2f, y0 + side / 2f, scale, yaw, pitch);
        draws++;
    }

    private boolean over(double mx, double my) {
        if (side == 0) return false;
        for (PaneScreen.Pane p : screen.panes) {
            if (!p.key.equals(paneKey)) continue;
            int y0 = p.y + squareY - p.scroll;
            return p.contains(mx, my) && mx >= p.x && mx < p.x + side && my >= y0 && my < y0 + side;
        }
        return false;
    }

    // ── the orbit camera ────────────────────────────────────────────────────────────────────────

    /** A press starts a drag when it is a left click on the square; returns whether it did. */
    boolean mouseClicked(double mx, double my, int button) {
        dragging = button == 0 && over(mx, my);
        return dragging;
    }

    void mouseReleased() {
        dragging = false;
    }

    /** Dragging across the preview turns it (x) and tilts it (y, kept between -89 and 89 degrees); returns whether it did. */
    boolean mouseDragged(double dx, double dy) {
        if (!dragging) return false;
        yaw = (yaw + (float) dx * 1.5f) % 360f;
        pitch = Math.max(-89f, Math.min(89f, pitch + (float) dy * 1.5f));
        return true;
    }
}
