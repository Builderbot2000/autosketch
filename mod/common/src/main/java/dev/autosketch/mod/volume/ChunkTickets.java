package dev.autosketch.mod.volume;

import dev.autosketch.mod.protocol.Box;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;
import org.jetbrains.annotations.Nullable;

/**
 * Keeps the chunks under the link's volumes loaded while linked (13, *Work and context volumes
 * in-game*; M4), so patches and snapshots never meet an unloaded chunk. Plain region tickets at the
 * full-chunk level: nothing is saved with the world (unlike forced chunks), and they vanish when the
 * server stops. Server thread only.
 */
public final class ChunkTickets {
    /** Not registry content: a ticket type is a plain object the chunk map compares by identity. */
    public static final TicketType<ChunkPos> TYPE = TicketType.create("autosketch_link", Comparator.comparingLong(ChunkPos::toLong));

    /** Distance 0: the chunk itself is fully loaded (block access), without ticking a radius around it. */
    private static final int DISTANCE = 0;

    private @Nullable ServerLevel level;
    private final Set<Long> held = new HashSet<>();

    /** Holds exactly the chunks under {@code boxes} in {@code level}, releasing the rest. */
    public void hold(ServerLevel newLevel, List<Box> boxes) {
        if (level != null && level != newLevel) releaseAll();
        level = newLevel;
        Set<Long> want = new HashSet<>();
        for (Box b : boxes)
            for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++)
                for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++) want.add(ChunkPos.asLong(cx, cz));
        for (Long c : held)
            if (!want.contains(c)) remove(c);
        for (Long c : want)
            if (!held.contains(c)) newLevel.getChunkSource().addRegionTicket(TYPE, new ChunkPos(c), DISTANCE, new ChunkPos(c));
        held.retainAll(want);
        held.addAll(want);
    }

    public void releaseAll() {
        if (level != null) for (Long c : held) remove(c);
        held.clear();
        level = null;
    }

    private void remove(long c) {
        level.getChunkSource().removeRegionTicket(TYPE, new ChunkPos(c), DISTANCE, new ChunkPos(c));
    }

    public Set<Long> held() {
        return Set.copyOf(held);
    }

    public @Nullable ServerLevel level() {
        return level;
    }
}
