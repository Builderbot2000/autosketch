package dev.autosketch.mod.world;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.LinkState;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.api.PatchStatus;
import dev.autosketch.mod.protocol.BodyTypes.AckLists;
import dev.autosketch.mod.protocol.BodyTypes.Normalized;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.Rejected;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.PriorityQueue;
import java.util.function.Function;
import java.util.function.IntSupplier;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * The conditional patch applier (13, *Applying a patch*; M5–M7). Patches queue in id order and apply
 * on the server thread under a per-tick block budget; a patch in progress is visible part-way. Each
 * position goes through the protocol's steps in index order:
 *
 * <ol>
 *   <li>stale link, no volumes or another dimension: {@code stale_link};
 *   <li>outside the effective work volume (even inside a context box), or outside the build height:
 *       {@code outside_volumes};
 *   <li>a new state that isn't canonical and known: {@code unknown_state}; NBT unusable for the new
 *       block: {@code bad_nbt};
 *   <li>the precondition: the world's canonical state equals the expected one and, when an expected
 *       NBT hash is given, the world's block entity has that hash (a missing or state-only block
 *       entity never matches). Otherwise the position is skipped with the world's state and NBT, or,
 *       with {@code force}, written anyway and counted as overwritten;
 *   <li>the side-effect-free write ({@link WorldBlocks#write});
 *   <li>the normalized check: the NBT hash now in the world against the hash of what was sent.
 * </ol>
 *
 * The world is authoritative: nothing but a passing precondition or {@code force} writes a block.
 * Server thread only, except {@link #pending()} and {@link #last()}, which read volatile snapshots.
 */
public final class PatchApplier implements PatchStatus {
    private static final Logger LOG = LogUtils.getLogger();

    /** {@code error} code for a valid request the mod failed to serve (13, *Message schemas*). */
    public static final String INTERNAL = ErrorCodes.INTERNAL;

    private final LinkState link;
    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final IntSupplier budget;
    private final PriorityQueue<Job> queue = new PriorityQueue<>(Comparator.comparingLong(j -> j.patch.id()));
    private @Nullable Job current;
    private int usedThisTick;
    private long tickStart = System.nanoTime();

    /**
     * Server-thread time a tick may spend writing, on top of the block budget: block entities cost
     * far more per block than plain states (13, *Open questions*, throughput), so a budget sized for
     * states could otherwise stall a tick on a stamp full of chests.
     */
    public static volatile long tickNanos = 25_000_000L;
    private volatile int pending;
    private volatile @Nullable Finished last;

    /**
     * @param levels resolves a dimension to its loaded level (null when not loaded)
     * @param budget the per-tick block budget, read at every tick
     */
    public PatchApplier(LinkState link, Function<ResourceKey<Level>, @Nullable ServerLevel> levels, IntSupplier budget) {
        this.link = link;
        this.levels = levels;
        this.budget = budget;
    }

    @Override
    public int pending() {
        return pending;
    }

    @Override
    public @Nullable Finished last() {
        return last;
    }

    /** Queues a decoded patch; its ack goes to {@code exchange} (already deferred by the caller). */
    public void submit(Messages.Patch patch, Exchange exchange, VolatileKeys keys) {
        queue.add(new Job(patch, exchange, keys));
        updatePending();
        pump();
    }

    /** Start of a server tick: a fresh budget, then continue. */
    public void tick() {
        usedThisTick = 0;
        tickStart = System.nanoTime();
        pump();
    }

    /** Applies queued work until the tick's budget is spent or nothing is left. */
    public void pump() {
        int limit = Math.max(1, budget.getAsInt());
        while (usedThisTick < limit) {
            if (current == null) {
                current = queue.poll();
                if (current == null) break;
                // A patch not yet started whose connection closed is discarded (13, *Connection
                // and handshake*, step 7); the one in progress always finishes.
                if (!current.exchange.live()) {
                    current.exchange.complete();
                    current = null;
                    updatePending();
                    continue;
                }
            }
            Job j = current;
            try {
                while (j.next < j.blocks.size() && usedThisTick < limit) {
                    if (step(j, j.blocks.get(j.next))) usedThisTick++;
                    j.next++;
                    if ((j.next & 63) == 0 && System.nanoTime() - tickStart > tickNanos) usedThisTick = limit;
                }
            } catch (RuntimeException e) {
                LOG.error("Autosketch: patch {} failed at position {}", j.patch.id(), j.next, e);
                j.exchange.error(INTERNAL, "the mod failed applying patch " + j.patch.id() + " at entry " + j.next + ": " + e);
                current = null;
                updatePending();
                continue;
            }
            if (j.next >= j.blocks.size()) finish(j);
        }
    }

    /** One position. Returns whether it touched the world (and so counts against the budget). */
    private boolean step(Job j, PatchBlock b) {
        BlockPos pos = b.pos();
        LinkVolumes v = link.current();
        if (v == null || v.link() != j.patch.link() || !v.dimension().location().toString().equals(j.patch.dimension())) {
            j.rejected.add(new Rejected(pos, ErrorCodes.STALE_LINK));
            return false;
        }
        ServerLevel level = levels.apply(v.dimension());
        if (level == null) {
            j.rejected.add(new Rejected(pos, ErrorCodes.STALE_LINK));
            return false;
        }
        if (!v.effectiveWork().contains(pos) || !WorldBlocks.inHeight(level, pos.getY())) {
            j.rejected.add(new Rejected(pos, ErrorCodes.OUTSIDE_VOLUMES));
            return false;
        }
        BlockState next = States.parse(b.state());
        if (next == null) {
            j.rejected.add(new Rejected(pos, ErrorCodes.UNKNOWN_STATE));
            return false;
        }
        WorldBlocks.Prepared prep = WorldBlocks.prepare(pos, next, b.nbt(), level.registryAccess());
        if (!prep.ok()) {
            j.rejected.add(new Rejected(pos, ErrorCodes.BAD_NBT));
            return true;
        }

        String actual = States.print(WorldBlocks.state(level, pos));
        BlockEntity be = WorldBlocks.blockEntity(level, pos);
        CompoundTag actualNbt = be == null ? null : WorldBlocks.nbt(be, level.registryAccess());
        boolean matches = actual.equals(b.expected());
        if (matches && b.expectedNbtHash() != null)
            matches = actualNbt != null && Objects.equals(Hashing.nbtHash(actualNbt, j.keys), b.expectedNbtHash());
        if (!matches) {
            if (!j.patch.force()) {
                j.skipped.add(new WorldBlock(pos, actual, actualNbt));
                return true;
            }
            j.overwritten++;
        }

        WorldBlocks.write(level, pos, next, prep.blockEntity());
        j.applied++;

        BlockEntity now = WorldBlocks.blockEntity(level, pos);
        CompoundTag nowNbt = now == null ? null : WorldBlocks.nbt(now, level.registryAccess());
        Object sent = key(b.nbt(), j.keys), written = key(nowNbt, j.keys);
        if (!sent.equals(written) && sent != STATE_ONLY && written != STATE_ONLY) j.normalized.add(new Normalized(pos, nowNbt));
        return true;
    }

    private static final Object NONE = new Object(), STATE_ONLY = new Object();

    /** "none", "state only", or the NBT hash: the values the normalized check compares. */
    private static Object key(@Nullable CompoundTag nbt, VolatileKeys keys) {
        if (nbt == null) return NONE;
        Long h = Hashing.nbtHash(nbt, keys);
        return h == null ? STATE_ONLY : h;
    }

    private void finish(Job j) {
        current = null;
        updatePending();
        Messages.PatchAck ack = new Messages.PatchAck(j.patch.id(), j.applied, j.overwritten, new AckLists(j.skipped, j.rejected, j.normalized));
        last = new Finished(j.patch.id(), j.applied, j.overwritten, j.skipped.size(), j.rejected.size(), System.currentTimeMillis());
        Frame frame;
        try {
            frame = ack.encode();
        } catch (RuntimeException e) {
            // A skipped block entity the wire can't carry (13, *NBT*, limits).
            LOG.error("Autosketch: ack of patch {} can't be encoded", j.patch.id(), e);
            j.exchange.error(INTERNAL, "the ack of patch " + j.patch.id() + " can't be encoded: " + e.getMessage());
            return;
        }
        j.exchange.reply(frame);
    }

    private void updatePending() {
        pending = queue.size() + (current != null ? 1 : 0);
    }

    private static final class Job {
        final Messages.Patch patch;
        final List<PatchBlock> blocks;
        final Exchange exchange;
        final VolatileKeys keys;
        int next, applied, overwritten;
        final List<WorldBlock> skipped = new ArrayList<>();
        final List<Rejected> rejected = new ArrayList<>();
        final List<Normalized> normalized = new ArrayList<>();

        Job(Messages.Patch patch, Exchange exchange, VolatileKeys keys) {
            this.patch = patch;
            this.blocks = patch.blocks();
            this.exchange = exchange;
            this.keys = keys;
        }
    }
}
