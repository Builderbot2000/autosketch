package dev.autosketch.mod.gametest;

import static dev.autosketch.mod.gametest.UiRelayGameTests.check;

import com.google.gson.JsonObject;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.UiMessages;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import dev.autosketch.mod.ui.ReplayEvents;
import dev.autosketch.mod.ui.UiNetwork;
import dev.autosketch.mod.ui.relay.ReplayResend;
import dev.autosketch.mod.ui.relay.UiPayload;
import dev.autosketch.mod.ui.relay.UiRelay;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.LevelChunk;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * Replay's server half (16, *Replay in the world*; briefs/ui/R): when a player's replay closes, the
 * server resends the chunks covering the replayed volume to that player only, so their client shows
 * the server's world again. Driven through the real relay and bridge with the in-process fake MCP;
 * the chunk packets are recorded instead of sent (mock players have no client).
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class ReplayGameTests {
    private ReplayGameTests() {}

    /** Records which chunks would go to which player; every chunk counts as held by the client. */
    static final class Chunks implements ReplayResend.Sender {
        final Map<UUID, Set<ChunkPos>> sent = new ConcurrentHashMap<>();
        int packets;

        @Override
        public boolean hasChunk(ServerPlayer player, ChunkPos pos) {
            return true;
        }

        @Override
        public void send(ServerPlayer player, LevelChunk chunk) {
            packets++;
            sent.computeIfAbsent(player.getUUID(), k -> ConcurrentHashMap.newKeySet()).add(chunk.getPos());
        }

        Set<ChunkPos> of(ServerPlayer p) {
            return sent.getOrDefault(p.getUUID(), Set.of());
        }
    }

    private static UiPayload request(long id, String kind, String argsJson) {
        return UiPayload.request("{\"type\":\"ui.request\",\"request\":" + id + ",\"kind\":\"" + kind + "\",\"args\":" + argsJson + "}");
    }

    /** Answers the newest {@code ui.request} with {@code result}. */
    private static void answer(FakeMcp mcp, int index, JsonObject result) {
        try {
            UiMessages.UiRequest r = UiMessages.UiRequest.decode(mcp.received("ui.request").get(index));
            mcp.send(UiResult.ok(r.request(), r.player().uuid(), result).encode());
        } catch (Exception e) {
            throw new GameTestAssertException(e.toString());
        }
    }

    /** A volume over several chunks of the test's area, and the loaded chunks it covers. */
    private static Box volume(GameTestHelper h) {
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0));
        return new Box(a.getX() - 20, a.getY(), a.getZ() - 20, a.getX() + 20, a.getY() + 3, a.getZ() + 20);
    }

    private static Set<ChunkPos> covered(GameTestHelper h, Box b) {
        Set<ChunkPos> out = new HashSet<>();
        for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++)
            for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++)
                if (h.getLevel().getChunkSource().getChunkNow(cx, cz) != null) out.add(new ChunkPos(cx, cz));
        return out;
    }

    private static JsonObject opened(Box b) {
        JsonObject o = new JsonObject();
        o.addProperty("replay", "r1");
        o.addProperty("steps", 3);
        o.addProperty("step", 0);
        o.addProperty("dimension", "minecraft:overworld");
        o.add("volume", Json.boxes(List.of(b)).get(0));
        return o;
    }

    /**
     * {@code replay.close} resends exactly the chunks covering the replayed volume, to the player
     * whose replay it was and nobody else; another player's close (with no replay open) sends nothing,
     * and nothing is sent before the close.
     */
    @GameTest(template = "empty", batch = "autosketch_replay_close", timeoutTicks = 400)
    public static void closeResendsTheVolumesChunksToThatPlayerOnly(GameTestHelper h) {
        UiRelay relay = UiNetwork.relay();
        UiRelayGameTests.Recording rec = new UiRelayGameTests.Recording();
        UiRelay.Transport old = relay.setTransport(rec);
        Chunks chunks = new Chunks();
        ReplayResend.Sender oldSender = ReplayEvents.resend().setSender(chunks);
        ServerPlayer a = VolumeGameTests.op(h), b = VolumeGameTests.op(h);
        rec.withChannel.add(a.getUUID());
        rec.withChannel.add(b.getUUID());
        Box vol = volume(h);
        Set<ChunkPos> want = covered(h, vol);
        FakeMcp mcp = FakeMcp.open();
        var seq = mcp.start(h)
                .thenExecute(() -> {
                    check(want.size() >= 4, "the volume covers several loaded chunks, got " + want);
                    relay.clientRequest(a, request(1, "replay.open", "{\"log\":null}"));
                })
                .thenWaitUntil(() -> check(mcp.received("ui.request").size() == 1, "replay.open reaches the MCP"))
                .thenExecute(() -> answer(mcp, 0, opened(vol)))
                .thenWaitUntil(() -> check(rec.frames(a).size() == 1, "the open result reaches a"))
                .thenExecute(() -> {
                    check(ReplayEvents.resend().open(a.getUUID()) != null, "the server half knows a's replay");
                    check(chunks.packets == 0, "nothing resent on open");
                    relay.clientRequest(b, request(1, "replay.close", "{\"replay\":\"r1\"}"));
                })
                .thenWaitUntil(() -> check(mcp.received("ui.request").size() == 2, "b's close reaches the MCP"))
                .thenExecute(() -> answer(mcp, 1, new JsonObject()))
                .thenWaitUntil(() -> check(rec.frames(b).size() == 1, "b's close result returns"))
                .thenExecute(() -> {
                    check(chunks.packets == 0, "b had no replay open: nothing resent");
                    relay.clientRequest(a, request(2, "replay.close", "{\"replay\":\"r1\"}"));
                })
                .thenWaitUntil(() -> check(mcp.received("ui.request").size() == 3, "a's close reaches the MCP"))
                .thenExecute(() -> answer(mcp, 2, new JsonObject()))
                .thenWaitUntil(() -> check(rec.frames(a).size() == 2, "a's close result returns"))
                .thenExecute(() -> {
                    check(chunks.of(a).equals(want), "a gets exactly the volume's chunks: " + chunks.of(a) + ", want " + want);
                    check(chunks.packets == want.size(), "each once, got " + chunks.packets + " packets");
                    check(chunks.of(b).isEmpty(), "b gets none");
                    check(ReplayEvents.resend().open(a.getUUID()) == null, "a's replay is forgotten");
                    ReplayEvents.resend().setSender(oldSender);
                    relay.setTransport(old);
                    for (ServerPlayer p : List.of(a, b)) h.getLevel().getServer().getPlayerList().remove(p);
                });
        mcp.finish(seq);
    }

    /**
     * When the MCP goes away with a replay open, the client closes its replay (the link is offline)
     * and the relay can't forward a close, so the server half resends the volume's chunks itself.
     */
    @GameTest(template = "empty", batch = "autosketch_replay_disconnect", timeoutTicks = 400)
    public static void disconnectResendsAnOpenReplaysChunks(GameTestHelper h) {
        UiRelay relay = UiNetwork.relay();
        UiRelayGameTests.Recording rec = new UiRelayGameTests.Recording();
        UiRelay.Transport old = relay.setTransport(rec);
        Chunks chunks = new Chunks();
        ReplayResend.Sender oldSender = ReplayEvents.resend().setSender(chunks);
        ServerPlayer a = VolumeGameTests.op(h);
        rec.withChannel.add(a.getUUID());
        Box vol = volume(h);
        Set<ChunkPos> want = covered(h, vol);
        FakeMcp mcp = FakeMcp.open();
        mcp.start(h)
                .thenExecute(() -> relay.clientRequest(a, request(1, "replay.open", "{\"log\":\"s1\"}")))
                .thenWaitUntil(() -> check(mcp.received("ui.request").size() == 1, "replay.open reaches the MCP"))
                .thenExecute(() -> answer(mcp, 0, opened(vol)))
                .thenWaitUntil(() -> check(ReplayEvents.resend().open(a.getUUID()) != null, "the server half knows a's replay"))
                .thenExecute(mcp::close)
                .thenWaitUntil(() -> check(!Autosketch.bridge().connected(), "the MCP disconnects"))
                .thenWaitUntil(() -> check(chunks.of(a).equals(want), "a gets the volume's chunks: " + chunks.of(a) + ", want " + want))
                .thenExecute(() -> {
                    check(ReplayEvents.resend().open(a.getUUID()) == null, "and the replay is forgotten");
                    ReplayEvents.resend().setSender(oldSender);
                    relay.setTransport(old);
                    h.getLevel().getServer().getPlayerList().remove(a);
                })
                .thenSucceed();
    }
}
