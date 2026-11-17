package dev.autosketch.mod.gametest;

import com.google.gson.JsonObject;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.UiMessages;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import dev.autosketch.mod.ui.UiNetwork;
import dev.autosketch.mod.ui.relay.UiPayload;
import dev.autosketch.mod.ui.relay.UiRelay;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * The in-game UI relay, server half (16, *Testing*, *Mod, server half*; 13, *In-game UI*, *Relay to
 * the client*), driven by the in-process fake MCP through the real bridge. The players' connections
 * are simulated by a recording transport: which payloads would go to which client.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class UiRelayGameTests {
    private UiRelayGameTests() {}

    /** Records the payloads each player's client would get; only {@code withChannel} players have the client half. */
    static final class Recording implements UiRelay.Transport {
        final Set<UUID> withChannel = ConcurrentHashMap.newKeySet();
        final Map<UUID, List<UiPayload>> sent = new ConcurrentHashMap<>();

        @Override
        public boolean hasChannel(ServerPlayer player) {
            return withChannel.contains(player.getUUID());
        }

        @Override
        public void send(ServerPlayer player, UiPayload payload) {
            sent.computeIfAbsent(player.getUUID(), k -> new CopyOnWriteArrayList<>()).add(payload);
        }

        List<UiPayload> of(ServerPlayer p) {
            return sent.getOrDefault(p.getUUID(), List.of());
        }

        /** The frames a client would have joined from its parts, in order; checks every part's order. */
        List<Frame> frames(ServerPlayer p) {
            List<Frame> out = new ArrayList<>();
            ByteArrayOutputStream buf = null;
            long id = -1;
            int next = 0;
            for (UiPayload u : of(p)) {
                if (u.op() != UiPayload.FRAME) continue;
                if (u.part() == 0) {
                    buf = new ByteArrayOutputStream();
                    id = u.id();
                    next = 0;
                }
                check(buf != null && u.id() == id && u.part() == next, "parts arrive consecutively and in order");
                buf.writeBytes(u.data());
                next++;
                if (next == u.parts()) {
                    try {
                        out.add(FrameCodec.decode(buf.toByteArray()));
                    } catch (Exception e) {
                        throw new GameTestAssertException("joined parts don't decode: " + e);
                    }
                    buf = null;
                }
            }
            return out;
        }
    }

    static void check(boolean condition, String message) {
        if (!condition) throw new GameTestAssertException(message);
    }

    private static Frame state(List<UUID> players, long seq) {
        return new UiMessages.UiState(players, seq, true, List.of(), List.of(), Optional.empty(), Optional.empty(), Optional.empty()).encode();
    }

    /** A ghost of {@code n} whole sections, two states mixed. */
    private static Frame ghost(UUID player, int n) {
        List<UiMessages.GhostSection> sections = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            int[] states = new int[4096];
            for (int j = 0; j < states.length; j++) states[j] = (i + j) % 2;
            sections.add(new UiMessages.GhostSection(i % 32, i / 1024, (i / 32) % 32, states));
        }
        sections.sort((a, b) -> a.sy() != b.sy() ? Integer.compare(a.sy(), b.sy()) : a.sz() != b.sz() ? Integer.compare(a.sz(), b.sz()) : Integer.compare(a.sx(), b.sx()));
        return new UiMessages.UiGhost(List.of(player), "j1", "minecraft:overworld", 0, 64, 0, 0x3fa7d6, true, List.of("minecraft:air", "minecraft:stone"), sections).encode();
    }

    /**
     * With {@code ui} in both hellos: a {@code ui.state} naming one of two players reaches only that
     * player's connection, and not a named player without the channel; a 3 MiB {@code ui.ghost}
     * arrives as consecutive parts of at most 1,000,000 bytes that join to the frame; a client's
     * request reaches the MCP with the player's UUID and the relay's own number, and the result comes
     * back to that client under the client's number; a joining player gets the last full state again.
     */
    @GameTest(template = "empty", batch = "autosketch_ui_relay", timeoutTicks = 400)
    public static void forwardsToNamedPlayersSplitsAndRoutesRequests(GameTestHelper h) {
        UiRelay relay = UiNetwork.relay();
        Recording rec = new Recording();
        UiRelay.Transport old = relay.setTransport(rec);
        ServerPlayer a = VolumeGameTests.op(h), b = VolumeGameTests.op(h), c = VolumeGameTests.op(h);
        rec.withChannel.add(a.getUUID());
        rec.withChannel.add(b.getUUID());
        FakeMcp mcp = FakeMcp.open();
        Frame big = ghost(a.getUUID(), 800);
        long[] wireRequest = new long[1];
        var seq = mcp.start(h)
                .thenExecute(() -> {
                    Frame hello = mcp.received("hello").get(0);
                    check(hello.header().getAsJsonArray("features").toString().contains("\"ui\""), "the mod's hello lists ui");
                    check(relay.enabled(), "both hellos list ui");
                    mcp.send(state(List.of(a.getUUID(), c.getUUID()), 1));
                })
                .thenWaitUntil(() -> check(rec.frames(a).size() == 1, "the state reaches the named player"))
                .thenExecute(() -> {
                    check(rec.of(b).isEmpty(), "and not the other player");
                    check(rec.of(c).isEmpty(), "nor a named player whose client lacks the channel");
                    check(rec.frames(a).get(0).type().equals("ui.state"), "a ui.state");
                    check(FrameCodec.encode(big).length > 3 * 1024 * 1024, "the ghost is over 3 MiB");
                    mcp.send(big);
                })
                .thenWaitUntil(() -> check(rec.frames(a).size() == 2, "the ghost arrives"))
                .thenExecute(() -> {
                    List<UiPayload> parts = rec.of(a).stream().skip(1).toList();
                    check(parts.size() == 4, "in four parts, got " + parts.size());
                    for (UiPayload p : parts) check(p.data().length <= UiMessages.PART_BYTES, "each part at most 1,000,000 bytes");
                    check(java.util.Arrays.equals(FrameCodec.encode(rec.frames(a).get(1)), FrameCodec.encode(big)), "the parts join to the frame");
                    relay.clientRequest(a, UiPayload.request("{\"type\":\"ui.request\",\"request\":7,\"kind\":\"logs.list\",\"args\":{}}"));
                })
                .thenWaitUntil(() -> check(mcp.received("ui.request").size() == 1, "the request reaches the MCP"))
                .thenExecute(() -> {
                    UiMessages.UiRequest r;
                    try {
                        r = UiMessages.UiRequest.decode(mcp.received("ui.request").get(0));
                    } catch (Exception e) {
                        throw new GameTestAssertException(e.toString());
                    }
                    check(r.player().uuid().equals(a.getUUID()) && r.player().name().equals(a.getGameProfile().getName()), "with the player from the connection");
                    check(r.kind().equals("logs.list"), "and its kind");
                    wireRequest[0] = r.request();
                    JsonObject result = new JsonObject();
                    result.add("logs", new com.google.gson.JsonArray());
                    mcp.send(UiResult.ok(r.request(), a.getUUID(), result).encode());
                })
                .thenWaitUntil(() -> check(rec.frames(a).size() == 3, "the result comes back"))
                .thenExecute(() -> {
                    Frame f = rec.frames(a).get(2);
                    check(f.type().equals("ui.result") && f.header().get("ok").getAsBoolean(), "an ok ui.result");
                    check(f.header().get("request").getAsLong() == 7, "under the client's own number, not the relay's " + wireRequest[0]);
                    check(relay.pending() == 0, "nothing left pending");
                    check(rec.of(b).isEmpty(), "b still got nothing");
                    relay.playerJoined(a);
                })
                .thenWaitUntil(() -> check(rec.frames(a).size() == 4 && rec.frames(a).get(3).type().equals("ui.state"), "a joining player gets the last full state again"))
                .thenExecute(() -> {
                    relay.setTransport(old);
                    for (ServerPlayer p : List.of(a, b, c)) h.getLevel().getServer().getPlayerList().remove(p);
                });
        mcp.finish(seq);
    }

    /**
     * Without {@code ui} in the MCP's hello nothing is relayed, and a client's request is answered by
     * the server half itself (the MCP is too old), never sent.
     */
    @GameTest(template = "empty", batch = "autosketch_ui_gate", timeoutTicks = 200)
    public static void nothingIsSentWithoutUiInBothHellos(GameTestHelper h) {
        UiRelay relay = UiNetwork.relay();
        Recording rec = new Recording();
        UiRelay.Transport old = relay.setTransport(rec);
        ServerPlayer a = VolumeGameTests.op(h);
        rec.withChannel.add(a.getUUID());
        FakeMcp mcp = FakeMcp.open(List.of(Messages.MCP_FEATURE_PROMPT_CLOSE));
        var seq = mcp.start(h)
                .thenExecute(() -> {
                    check(!relay.enabled(), "the MCP's hello lacks ui");
                    mcp.send(state(List.of(a.getUUID()), 1));
                    relay.clientRequest(a, UiPayload.request("{\"type\":\"ui.request\",\"request\":3,\"kind\":\"resync\",\"args\":{}}"));
                })
                .thenIdle(10)
                .thenExecute(() -> {
                    List<Frame> got = rec.frames(a);
                    check(got.size() == 1 && got.get(0).type().equals("ui.result"), "only the server half's own answer, got " + got);
                    check(got.get(0).header().get("error").getAsString().equals("internal") && got.get(0).header().get("request").getAsLong() == 3, "an error under the client's number");
                    check(mcp.received("ui.request").isEmpty(), "no ui.request reached the MCP");
                    relay.setTransport(old);
                    h.getLevel().getServer().getPlayerList().remove(a);
                });
        mcp.finish(seq);
    }
}
