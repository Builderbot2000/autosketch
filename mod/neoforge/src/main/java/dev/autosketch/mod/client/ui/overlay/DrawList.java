package dev.autosketch.mod.client.ui.overlay;

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
 * as its edges when the camera is near it, else as its faces. The client only chooses between the
 * two drawings the MCP sent; it computes no shape (16, client half thin).
 */
public record DrawList(List<Outline> outlines, List<Label> labels, List<Pulse> pulses, List<Steady> fills) {
    /** A line box: a job's work volume (solid) or one of its context boxes (dashed). */
    public record Outline(String job, Box box, int colour, boolean dashed) {}

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

    public static final DrawList EMPTY = new DrawList(List.of(), List.of(), List.of(), List.of());

    /**
     * The draw list. Nothing while the link isn't {@code connected} (16, *Mod side*); job volumes and
     * steady fills only when {@code volumes} is on, flashes (proposed hits too) only when
     * {@code flashes} is on; only records in {@code dimension} (13, <em>Other dimensions</em>).
     * {@code cx, cy, cz}: the camera, which picks each fill's near or far drawing.
     */
    public static DrawList build(OverlayState state, long now, String dimension, double cx, double cy, double cz, boolean connected, boolean volumes, boolean flashes) {
        if (!connected) return EMPTY;
        List<Outline> outlines = new ArrayList<>();
        List<Label> labels = new ArrayList<>();
        List<Pulse> pulses = new ArrayList<>();
        List<Steady> fills = new ArrayList<>();
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
        return new DrawList(List.copyOf(outlines), List.copyOf(labels), List.copyOf(pulses), List.copyOf(fills));
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
        return outlines.isEmpty() && labels.isEmpty() && pulses.isEmpty() && fills.isEmpty();
    }
}
