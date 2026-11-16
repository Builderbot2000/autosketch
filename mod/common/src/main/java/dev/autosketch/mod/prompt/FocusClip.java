package dev.autosketch.mod.prompt;

import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.Box;
import java.util.ArrayList;
import java.util.List;
import org.jetbrains.annotations.Nullable;

/**
 * Clips a focus box to the link's volumes (13, *Prompting from the game*: the focus box "must lie
 * inside the work or context volume (it is clipped to them, with a warning)"). A box is a box, so
 * the clip is the focus box's intersection with the one volume box (the effective work volume or a
 * context box) it overlaps most; the context always includes the work volume grown by at least one,
 * so a focus box around the work volume's edge keeps the seam.
 */
public final class FocusClip {
    private FocusClip() {}

    /** The clipped box, and whether clipping changed it. */
    public record Result(Box box, boolean clipped) {}

    /** The focus box clipped to the volumes, or null when it overlaps none. Unchanged when there are no volumes. */
    public static @Nullable Result clip(Box focus, @Nullable LinkVolumes volumes) {
        if (volumes == null) return new Result(focus, false);
        List<Box> boxes = new ArrayList<>();
        boxes.add(volumes.effectiveWork());
        boxes.addAll(volumes.context());
        return clip(focus, boxes);
    }

    /** The focus box intersected with the box of {@code volumes} it overlaps most, or null when it overlaps none. */
    public static @Nullable Result clip(Box focus, List<Box> volumes) {
        Box best = null;
        for (Box v : volumes) {
            Box i = intersect(focus, v);
            if (i != null && (best == null || i.volume() > best.volume())) best = i;
        }
        return best == null ? null : new Result(best, !best.equals(focus));
    }

    public static @Nullable Box intersect(Box a, Box b) {
        if (!a.intersects(b)) return null;
        return new Box(Math.max(a.minX(), b.minX()), Math.max(a.minY(), b.minY()), Math.max(a.minZ(), b.minZ()),
                Math.min(a.maxX(), b.maxX()), Math.min(a.maxY(), b.maxY()), Math.min(a.maxZ(), b.maxZ()));
    }

    /** {@code 5×3×2}. */
    public static String size(Box b) {
        return b.sizeX() + "×" + b.sizeY() + "×" + b.sizeZ();
    }
}
