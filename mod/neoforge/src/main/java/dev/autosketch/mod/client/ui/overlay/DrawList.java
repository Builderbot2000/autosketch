package dev.autosketch.mod.client.ui.overlay;

import dev.autosketch.mod.feedback.VolumeOutlines;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.UiMessages.Fill;
import dev.autosketch.mod.protocol.UiMessages.Job;
import java.util.ArrayList;
import java.util.List;

/**
 * What the overlays draw this frame (16, *Overlays in the world*), built from the held
 * {@link OverlayState}, the player's toggles, the link state and the player's dimension. Kept as
 * plain records so client tests assert on it without reading pixels (16, *Testing*). Each part is a
 * straight copy of what the MCP sent: a job's work volume as a solid box and each context box as a
 * dashed one, in the job's colour; the brief as a label; each flash box as a pulse (a proposed hit's,
 * job {@code candidate}, pulses {@link OverlayState#HIT_PULSES} times); each steady fill (18, piece 8)
 * as its edges when the camera is near it, else as its faces; the player's own work and context
 * volumes (and the wand's other modes' boxes) as the server half sent them (18, piece 8, op 4), the
 * canvas among them faint, with its chunk grid on the ground around the player while the wand is held
 * (19, *Placing and moving the brush*). The client only chooses between the two drawings the MCP
 * sent; it computes no shape (16, client half thin) beyond the canvas's chunk lines near the player.
 */
public record DrawList(List<Outline> outlines, List<Label> labels, List<Pulse> pulses, List<Steady> fills, List<Volume> volumes, List<GridLine> grid) {
    /** A line box: a job's work volume (solid) or one of its context boxes (dashed). */
    public record Outline(String job, Box box, int colour, boolean dashed) {}

    /**
     * One of the player's own volumes (13, *Relay to the client*, op 4): a box of wand mode
     * {@code mode} (its index in the server's mode order) in that mode's colour, drawn as wide lines;
     * {@code faint} for the canvas (19), drawn at {@code OverlayRenderer.FAINT} strength.
     */
    public record Volume(int mode, Box box, int colour, boolean faint) {}

    /**
     * One line of the canvas's chunk grid (19): from ({@code x0}, {@code z0}) to ({@code x1},
     * {@code z1}) at height {@code y}, on a chunk boundary inside the canvas, within
     * {@link #GRID_CHUNKS} chunks of the camera.
     */
    public record GridLine(double x0, double z0, double x1, double z1, double y, int colour) {}

    /** How far around the camera's chunk the canvas's chunk grid is drawn, in chunks (a ground grid past that is too dense to read). */
    public static final int GRID_CHUNKS = 8;

    /** A camera-facing label: a job's brief, above the top centre of its work volume. */
    public record Label(String job, String text, double x, double y, double z, int colour) {}

    /** A flash pulse on one changed box; {@code strength} falls from 1 to 0 over the flash's life. */
    public record Pulse(String job, Box box, int colour, float strength) {}

    /**
     * A steady fill as drawn this frame (18, piece 8): near, its {@code edges} as lines (and no faces);
     * far, or when it has no edges (the MCP drops edges first past {@code FILL_SPANS}), its
     * {@code faces} at the constant {@code alpha} (and no edges). Spans as sent: {@code [x1, y1, z1,
     * x2, y2, z2]}, world corner coordinates.
     */
    public record Steady(String id, int colour, int alpha, boolean near, List<int[]> faces, List<int[]> edges) {
        @Override
        public String toString() {
            return "Steady[id=" + id + ", colour=" + String.format("#%06x", colour) + ", alpha=" + alpha + ", near=" + near + ", faces=" + faces.size() + ", edges=" + edges.size() + "]";
        }
    }

    /**
     * Within this distance (blocks, from the camera to the box around a fill's spans) a fill draws its
     * edges, beyond it its faces (18, piece 8: the outline near, the tinted shell far). Four sections:
     * past that a block-exact outline is lines too dense to read, and a shell spanning hundreds of
     * chunks stays one volume.
     */
    public static final double NEAR = 64;

    public static final DrawList EMPTY = new DrawList(List.of(), List.of(), List.of(), List.of(), List.of(), List.of());

    /**
     * The draw list. Nothing while the link isn't {@code connected} (16, *Mod side*); the player's own
     * volumes (op 4) whenever the server half sends them, since the wand and {@code /autosketch show}
     * already decide when they show; job volumes and steady fills only when {@code volumes} is on, flashes (proposed hits too) only when
     * {@code flashes} is on; only records in {@code dimension} (13, <em>Other dimensions</em>).
     * {@code cx, cy, cz}: the camera, which picks each fill's near or far drawing and centres the
     * canvas's grid; {@code groundY}: the block the player stands in, whose bottom the grid lies on.
     */
    public static DrawList build(OverlayState state, long now, String dimension, double cx, double cy, double cz, int groundY, boolean connected, boolean volumes, boolean flashes) {
        if (!connected) return EMPTY;
        List<Outline> outlines = new ArrayList<>();
        List<Label> labels = new ArrayList<>();
        List<Pulse> pulses = new ArrayList<>();
        List<Steady> fills = new ArrayList<>();
        List<Volume> own = new ArrayList<>();
        List<GridLine> grid = new ArrayList<>();
        VolumeOutlines vo = state.volumes();
        if (vo.dimension().equals(dimension))
            for (int i = 0; i < vo.outlines().size(); i++) {
                VolumeOutlines.Entry e = vo.outlines().get(i);
                for (Box b : e.boxes()) own.add(new Volume(i, b, e.colour(), e.faint()));
                if (e.grid() && !e.boxes().isEmpty()) grid(e.boxes().get(0), e.colour(), cx, cz, groundY, grid);
            }
        if (volumes) {
            for (Job j : state.jobs()) {
                if (!j.dimension().equals(dimension)) continue;
                outlines.add(new Outline(j.id(), j.work(), j.colour(), false));
                for (Box c : j.context()) outlines.add(new Outline(j.id(), c, j.colour(), true));
                Box w = j.work();
                labels.add(new Label(j.id(), j.brief(), (w.minX() + w.maxX() + 1) / 2.0, w.maxY() + 1.5, (w.minZ() + w.maxZ() + 1) / 2.0, j.colour()));
            }
            for (Fill f : state.fills()) {
                if (!f.dimension().equals(dimension) || (f.faces().isEmpty() && f.edges().isEmpty())) continue;
                boolean near = !f.edges().isEmpty() && (f.faces().isEmpty() || distance(f, cx, cy, cz) <= NEAR);
                fills.add(new Steady(f.id(), f.colour(), f.alpha(), near, near ? List.of() : f.faces(), near ? f.edges() : List.of()));
            }
        }
        List<OverlayState.ActiveFlash> active = state.flashes(now);
        if (flashes) {
            for (OverlayState.ActiveFlash a : active) {
                if (!a.flash().dimension().equals(dimension)) continue;
                float strength = a.strength(now);
                for (Box b : a.flash().boxes()) pulses.add(new Pulse(a.flash().job(), b, a.flash().colour(), strength));
            }
        }
        return new DrawList(List.copyOf(outlines), List.copyOf(labels), List.copyOf(pulses), List.copyOf(fills), List.copyOf(own), List.copyOf(grid));
    }

    /**
     * The canvas's chunk lines within {@link #GRID_CHUNKS} of the camera's chunk, clipped to the
     * canvas: lines of constant x and of constant z on every chunk boundary, including the canvas's
     * own edges, at {@code groundY}. None when the camera is that far outside the canvas.
     */
    static void grid(Box canvas, int colour, double cx, double cz, int groundY, List<GridLine> out) {
        int ccx = (int) Math.floor(cx) >> 4, ccz = (int) Math.floor(cz) >> 4;
        int x0 = Math.max(canvas.minX(), (ccx - GRID_CHUNKS) << 4), x1 = Math.min(canvas.maxX() + 1, (ccx + GRID_CHUNKS + 1) << 4);
        int z0 = Math.max(canvas.minZ(), (ccz - GRID_CHUNKS) << 4), z1 = Math.min(canvas.maxZ() + 1, (ccz + GRID_CHUNKS + 1) << 4);
        if (x0 >= x1 || z0 >= z1) return;
        double y = groundY + 0.02;
        for (int x = x0; x <= x1; x += 16) out.add(new GridLine(x, z0, x, z1, y, colour));
        for (int z = z0; z <= z1; z += 16) out.add(new GridLine(x0, z, x1, z, y, colour));
    }

    /** Distance from the camera to the box around all of a fill's spans (0 inside it). */
    static double distance(Fill f, double cx, double cy, double cz) {
        double[] lo = {Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE}, hi = {-Double.MAX_VALUE, -Double.MAX_VALUE, -Double.MAX_VALUE};
        for (List<int[]> spans : List.of(f.faces(), f.edges()))
            for (int[] s : spans)
                for (int a = 0; a < 3; a++) {
                    lo[a] = Math.min(lo[a], s[a]);
                    hi[a] = Math.max(hi[a], s[a + 3]);
                }
        double dx = Math.max(0, Math.max(lo[0] - cx, cx - hi[0])), dy = Math.max(0, Math.max(lo[1] - cy, cy - hi[1])), dz = Math.max(0, Math.max(lo[2] - cz, cz - hi[2]));
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    public boolean isEmpty() {
        return outlines.isEmpty() && labels.isEmpty() && pulses.isEmpty() && fills.isEmpty() && volumes.isEmpty() && grid.isEmpty();
    }
}
