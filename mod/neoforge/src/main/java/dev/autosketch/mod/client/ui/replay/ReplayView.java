package dev.autosketch.mod.client.ui.replay;

import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.UiMessages.Flash;
import dev.autosketch.mod.protocol.UiMessages.Hud;
import dev.autosketch.mod.protocol.UiMessages.Job;
import dev.autosketch.mod.protocol.UiMessages.Marker;
import dev.autosketch.mod.protocol.UiMessages.ReplayFrame;
import dev.autosketch.mod.world.States;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;
import org.jetbrains.annotations.Nullable;

/**
 * What one open replay shows (16, *Replay in the world*): the replayed volume's states at the step
 * the client shows, as the last keyframe plus the deltas applied since, and the frame's strip text,
 * jobs, flashes and markers. The client's world copy is written from this ({@link ReplayClient}), and
 * rewritten from it when a chunk loads inside the volume. It decides nothing: every value is the
 * MCP's. Client thread.
 */
final class ReplayView {
    /** One keyframe region: its box and a palette index per position, x fastest, then z, then y (the snapshot order). */
    record Region(Box box, int[] states) {
        int index(int x, int y, int z) {
            return (x - box.minX()) + box.sizeX() * ((z - box.minZ()) + box.sizeZ() * (y - box.minY()));
        }
    }

    final String replay;
    long steps;
    /** The step the client shows once every frame received is applied; -1 before the first keyframe. */
    long step = -1;
    String dimension = "";
    final List<Region> regions = new ArrayList<>();
    /** Palette of the stored states; null where the game doesn't know the state (that position keeps the server's block). */
    final List<@Nullable BlockState> palette = new ArrayList<>();
    private final Map<String, Integer> paletteIndex = new HashMap<>();
    String time = "";
    Hud hud = new Hud("", null, null);
    List<Job> jobs = List.of();
    List<Flash> flashes = List.of();
    List<Marker> markers = List.of();
    /** {@code System.currentTimeMillis()} when the last frame arrived, for the flash pulse. */
    long frameAt;

    ReplayView(String replay) {
        this.replay = replay;
    }

    /** Takes a keyframe: every position of its regions. */
    void keyframe(ReplayFrame f) {
        regions.clear();
        palette.clear();
        paletteIndex.clear();
        int[] map = new int[f.palette().size()];
        for (int i = 0; i < map.length; i++) map[i] = intern(f.palette().get(i));
        for (SnapshotRegion r : f.regions()) {
            int[] s = new int[r.states().length];
            for (int i = 0; i < s.length; i++) s[i] = map[r.states()[i]];
            regions.add(new Region(r.box(), s));
        }
        markers = f.markers();
        dimension = f.dimension();
        frame(f);
    }

    /** Takes a delta's positions into the stored states; returns the positions inside the volume with their state. */
    List<WorldBlock> delta(ReplayFrame f) {
        List<WorldBlock> inside = new ArrayList<>(f.blocks().size());
        for (WorldBlock b : f.blocks()) {
            Region r = regionAt(b.pos());
            if (r == null) continue;
            r.states[r.index(b.pos().getX(), b.pos().getY(), b.pos().getZ())] = intern(b.state());
            inside.add(b);
        }
        frame(f);
        return inside;
    }

    private void frame(ReplayFrame f) {
        step = f.step();
        steps = f.steps();
        time = f.time();
        hud = f.hud();
        jobs = f.jobs();
        flashes = f.flashes();
        frameAt = System.currentTimeMillis();
    }

    private int intern(String state) {
        Integer i = paletteIndex.get(state);
        if (i != null) return i;
        palette.add(States.parse(state));
        paletteIndex.put(state, palette.size() - 1);
        return palette.size() - 1;
    }

    @Nullable Region regionAt(BlockPos p) {
        for (Region r : regions) if (r.box.contains(p)) return r;
        return null;
    }

    /** The stored state at a position inside the volume, or null (outside, or unknown to the game). */
    @Nullable BlockState stateAt(BlockPos p) {
        Region r = regionAt(p);
        return r == null ? null : palette.get(r.states[r.index(p.getX(), p.getY(), p.getZ())]);
    }

    boolean contains(BlockPos p) {
        return regionAt(p) != null;
    }

    /** The previous marker's step before {@code from}, or -1. */
    long previousMarker(long from) {
        long best = -1;
        for (Marker m : markers) if (m.step() < from) best = m.step();
        return best;
    }

    /** The next marker's step after {@code from}, or -1. */
    long nextMarker(long from) {
        for (Marker m : markers) if (m.step() > from) return m.step();
        return -1;
    }
}
