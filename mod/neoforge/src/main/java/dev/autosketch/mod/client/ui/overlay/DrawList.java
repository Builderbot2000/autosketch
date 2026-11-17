package dev.autosketch.mod.client.ui.overlay;

import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.UiMessages.Job;
import java.util.ArrayList;
import java.util.List;

/**
 * What the overlays draw this frame (16, *Overlays in the world*), built from the held
 * {@link OverlayState}, the player's toggles, the link state and the player's dimension. Kept as
 * plain records so client tests assert on it without reading pixels (16, *Testing*). Each part is a
 * straight copy of what the MCP sent: a job's work volume as a solid box and each context box as a
 * dashed one, in the job's colour; the brief as a label; each flash box as a pulse.
 */
public record DrawList(List<Outline> outlines, List<Label> labels, List<Pulse> pulses) {
    /** A line box: a job's work volume (solid) or one of its context boxes (dashed). */
    public record Outline(String job, Box box, int colour, boolean dashed) {}

    /** A camera-facing label: a job's brief, above the top centre of its work volume. */
    public record Label(String job, String text, double x, double y, double z, int colour) {}

    /** A flash pulse on one changed box; {@code strength} falls from 1 to 0 over the flash's life. */
    public record Pulse(String job, Box box, int colour, float strength) {}

    public static final DrawList EMPTY = new DrawList(List.of(), List.of(), List.of());

    /**
     * The draw list. Nothing while the link isn't {@code connected} (16, *Mod side*); job volumes
     * only when {@code volumes} is on, flashes only when {@code flashes} is on; only records in
     * {@code dimension} (13, <em>Other dimensions</em>).
     */
    public static DrawList build(OverlayState state, long now, String dimension, boolean connected, boolean volumes, boolean flashes) {
        if (!connected) return EMPTY;
        List<Outline> outlines = new ArrayList<>();
        List<Label> labels = new ArrayList<>();
        List<Pulse> pulses = new ArrayList<>();
        if (volumes) {
            for (Job j : state.jobs()) {
                if (!j.dimension().equals(dimension)) continue;
                outlines.add(new Outline(j.id(), j.work(), j.colour(), false));
                for (Box c : j.context()) outlines.add(new Outline(j.id(), c, j.colour(), true));
                Box w = j.work();
                labels.add(new Label(j.id(), j.brief(), (w.minX() + w.maxX() + 1) / 2.0, w.maxY() + 1.5, (w.minZ() + w.maxZ() + 1) / 2.0, j.colour()));
            }
        }
        List<OverlayState.ActiveFlash> active = state.flashes(now);
        if (flashes) {
            for (OverlayState.ActiveFlash a : active) {
                if (!a.flash().dimension().equals(dimension)) continue;
                float strength = Math.max(0f, 1f - (now - a.start()) / (float) OverlayState.FLASH_MS);
                for (Box b : a.flash().boxes()) pulses.add(new Pulse(a.flash().job(), b, a.flash().colour(), strength));
            }
        }
        return new DrawList(List.copyOf(outlines), List.copyOf(labels), List.copyOf(pulses));
    }

    public boolean isEmpty() {
        return outlines.isEmpty() && labels.isEmpty() && pulses.isEmpty();
    }
}
