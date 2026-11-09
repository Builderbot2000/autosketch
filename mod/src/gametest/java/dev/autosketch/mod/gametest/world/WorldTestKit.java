package dev.autosketch.mod.gametest.world;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.Inbound;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorMessage;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.volume.LinkVolumesHolder;
import dev.autosketch.mod.world.States;
import dev.autosketch.mod.world.WorldBlocks;
import dev.autosketch.mod.world.WorldModule;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.jetbrains.annotations.Nullable;

/** Shared pieces of the world GameTests: volumes, sessions, exchanges and patches. */
final class WorldTestKit {
    private WorldTestKit() {}

    /** The MCP's default volatile list (13, *Hashing*). */
    static final String DEFAULT_VOLATILE = """
            { "minecraft:furnace": ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
              "minecraft:blast_furnace": ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
              "minecraft:smoker": ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
              "minecraft:hopper": ["TransferCooldown"],
              "minecraft:brewing_stand": ["BrewTime"] }""";

    private static final AtomicLong LINKS = new AtomicLong(1000);
    private static final AtomicLong IDS = new AtomicLong(1);

    static BridgeSession session() {
        JsonObject v = JsonParser.parseString(DEFAULT_VOLATILE).getAsJsonObject();
        return new BridgeSession(IDS.incrementAndGet(), "gametest", "1", v);
    }

    static long nextId() {
        return IDS.incrementAndGet();
    }

    /** Links the volumes: {@code work}, context = work grown by 3 plus {@code extra}. Returns them. */
    static LinkVolumes link(GameTestHelper h, Box work, Box... extra) {
        List<Box> ctx = new java.util.ArrayList<>();
        ctx.add(work.grow(3));
        ctx.addAll(List.of(extra));
        LinkVolumes v = new LinkVolumes(LINKS.incrementAndGet(), h.getLevel().dimension(), work, null, ctx);
        ((LinkVolumesHolder) Autosketch.link()).set(v);
        WorldModule.services().tracker().refresh();
        return v;
    }

    static void unlink() {
        ((LinkVolumesHolder) Autosketch.link()).set(null);
        WorldModule.services().tracker().refresh();
        WorldModule.budgetOverride = 0;
        WorldModule.modeOverride = null;
    }

    /** The box of absolute positions for relative corners. */
    static Box box(GameTestHelper h, int x0, int y0, int z0, int x1, int y1, int z1) {
        return Box.of(h.absolutePos(new BlockPos(x0, y0, z0)), h.absolutePos(new BlockPos(x1, y1, z1)));
    }

    static String dim(GameTestHelper h) {
        return h.getLevel().dimension().location().toString();
    }

    static BlockState state(String s) {
        BlockState st = States.parse(s);
        if (st == null) throw new IllegalArgumentException("not canonical: " + s);
        return st;
    }

    static CompoundTag snbt(String s) {
        try {
            return TagParser.parseTag(s);
        } catch (Exception e) {
            throw new IllegalArgumentException(s, e);
        }
    }

    /** Puts a block (and optional NBT) into the world the side-effect-free way, as test setup. */
    static void put(ServerLevel level, BlockPos pos, String state, @Nullable CompoundTag nbt) {
        BlockState st = state(state);
        WorldBlocks.Prepared p = WorldBlocks.prepare(pos, st, nbt, level.registryAccess());
        if (!p.ok()) throw new IllegalArgumentException("bad test NBT " + nbt);
        WorldBlocks.write(level, pos, st, p.blockEntity());
    }

    static String print(ServerLevel level, BlockPos pos) {
        return States.print(WorldBlocks.state(level, pos));
    }

    static PatchBlock block(BlockPos pos, String expected, String state) {
        return new PatchBlock(pos, expected, state, null, null);
    }

    /** Sends a patch through the handler, as the dispatcher would. */
    static TestExchange patch(LinkVolumes v, boolean force, List<PatchBlock> blocks, BridgeSession session) {
        Messages.Patch p = new Messages.Patch(nextId(), v.link(), v.dimension().location().toString(), force, blocks);
        TestExchange ex = new TestExchange(p.id());
        try {
            WorldModule.handlePatch(new Inbound(p.encode(), session), ex);
        } catch (ProtocolException e) {
            throw new IllegalStateException(e);
        }
        return ex;
    }

    static TestExchange patch(LinkVolumes v, List<PatchBlock> blocks) {
        return patch(v, false, blocks, session());
    }

    /** An exchange that records its completion. */
    static final class TestExchange implements Exchange {
        private final Long id;
        volatile @Nullable Frame reply;
        volatile @Nullable String errorCode;
        volatile boolean done, deferred;
        volatile long doneAtTick = -1;

        TestExchange(Long id) {
            this.id = id;
        }

        @Override
        public Long id() {
            return id;
        }

        @Override
        public void reply(Frame response) {
            reply = response;
            complete();
        }

        @Override
        public void error(String code, String message) {
            errorCode = code + ": " + message;
            reply = new ErrorMessage(id, code, message, null).encode();
            complete();
        }

        @Override
        public void complete() {
            if (!done) {
                done = true;
                net.minecraft.server.MinecraftServer s = net.neoforged.neoforge.server.ServerLifecycleHooks.getCurrentServer();
                doneAtTick = s == null ? -1 : s.getTickCount();
            }
        }

        @Override
        public void defer() {
            deferred = true;
        }

        @Override
        public boolean live() {
            return true;
        }

        Messages.PatchAck ack() {
            if (!done || reply == null) throw new IllegalStateException("no reply yet");
            if (errorCode != null) throw new IllegalStateException("error " + errorCode);
            try {
                return Messages.PatchAck.decode(reply);
            } catch (ProtocolException e) {
                throw new IllegalStateException(e);
            }
        }
    }
}
