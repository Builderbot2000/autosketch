package dev.autosketch.mod.gametest;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.command.RequestCommands;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.RequestMessages;
import dev.autosketch.mod.protocol.RequestMessages.RequestControl;
import dev.autosketch.mod.protocol.RequestMessages.Status;
import dev.autosketch.mod.protocol.RequestMessages.StatusAction;
import dev.autosketch.mod.prompt.InGamePrompts;
import dev.autosketch.mod.prompt.PromptModule;
import dev.autosketch.mod.prompt.StatusLines;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.jetbrains.annotations.Nullable;

/**
 * Request control in game, server half (19, *Stop*, *Queueing*, *Status line*; briefs/canvas/G):
 * {@code /autosketch stop}, {@code queue} and {@code queue cancel <n>} send {@code request.control}
 * (and only to an MCP listing {@code requests}); status lines are relayed whole to a client half,
 * with each button's action number, and printed as plain lines with a command hint otherwise, one per
 * state change; and the whole server path over the real bridge.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class RequestGameTests {
    private RequestGameTests() {}

    static void check(boolean ok, String message) {
        if (!ok) throw new GameTestAssertException(message);
    }

    /** A connected bridge that keeps what it is sent, its MCP listing {@code features}. */
    private record RecordingBridge(boolean connected, List<String> features, List<Frame> sent) implements Bridge {
        RecordingBridge(boolean connected, List<String> features) {
            this(connected, features, new ArrayList<>());
        }

        @Override
        public @Nullable BridgeSession session() {
            return connected ? new BridgeSession(1, "test", "0", new JsonObject(), List.of("ask", "plan", "build"), features) : null;
        }

        @Override
        public boolean send(Frame frame) {
            if (!connected) return false;
            sent.add(frame);
            return true;
        }

        @Override
        public void addListener(Listener listener) {}
    }

    /** Action-bar and chat lines by player. */
    static final class Recorder implements InGamePrompts.Output {
        final Map<UUID, List<String>> bar = new HashMap<>();
        final Map<UUID, List<Component>> chat = new HashMap<>();

        @Override
        public synchronized void actionBar(ServerPlayer player, Component text) {
            bar.computeIfAbsent(player.getUUID(), k -> new ArrayList<>()).add(text.getString());
        }

        @Override
        public synchronized void chat(ServerPlayer player, Component text) {
            chat.computeIfAbsent(player.getUUID(), k -> new ArrayList<>()).add(text);
        }

        synchronized List<String> barOf(ServerPlayer p) {
            return List.copyOf(bar.getOrDefault(p.getUUID(), List.of()));
        }

        synchronized List<Component> chatOf(ServerPlayer p) {
            return List.copyOf(chat.getOrDefault(p.getUUID(), List.of()));
        }

        List<String> textOf(ServerPlayer p) {
            return chatOf(p).stream().map(Component::getString).toList();
        }
    }

    private static void with(Bridge bridge, Recorder out, Runnable body) {
        Bridge oldBridge = Autosketch.bridge();
        InGamePrompts.Output oldOut = InGamePrompts.setOutput(out);
        Autosketch.install(bridge, Autosketch.link(), Autosketch.patchStatus(), Autosketch.wandModes());
        try {
            body.run();
        } finally {
            Autosketch.install(oldBridge, Autosketch.link(), Autosketch.patchStatus(), Autosketch.wandModes());
            InGamePrompts.setOutput(oldOut);
        }
    }

    private static void run(ServerPlayer p, String command) {
        p.getServer().getCommands().performPrefixedCommand(p.createCommandSourceStack().withPermission(2), command);
    }

    static RequestControl control(Frame f) {
        try {
            return RequestControl.decode(f);
        } catch (ProtocolException e) {
            throw new GameTestAssertException("bad request.control: " + e.getMessage());
        }
    }

    /** A status line for {@code player} in {@code state}, with the buttons that state has (13, {@code actions}). */
    public static Status status(long request, UUID player, String state, long calls, @Nullable Integer queuePos) {
        String text = "build a gatehouse on the east wall";
        JsonObject args = new JsonObject();
        args.addProperty("request", request);
        List<StatusAction> actions = switch (state) {
            case "working" -> List.of(new StatusAction("Stop", "request.stop", args));
            case "queued" -> List.of(new StatusAction("Send now", "queue.send", args), new StatusAction("Cancel", "queue.cancel", args));
            case "stopped" -> List.of(new StatusAction("Undo request", "request.undo", args));
            default -> List.of();
        };
        String line = switch (state) {
            case "working" -> "⏳ Working · \"" + text + "\" · " + calls + " calls · 0:42";
            case "stopping" -> "■ Stopping… · \"" + text + "\" · " + calls + " calls · 0:44";
            case "stopped" -> "■ Stopped · \"" + text + "\" · " + calls + " calls · 0:47";
            case "done" -> "✔ Done · \"" + text + "\" · " + calls + " calls · 2:10";
            default -> "⧗ Queued · \"" + text + "\"";
        };
        return new Status(request, player, List.of(line), state, text, calls, 1000, queuePos, false, actions);
    }

    /** The click command anywhere in a chat line, or null. */
    static @Nullable String click(Component c) {
        String[] found = {null};
        c.visit((style, text) -> {
            if (style.getClickEvent() != null) found[0] = style.getClickEvent().getValue();
            return java.util.Optional.empty();
        }, net.minecraft.network.chat.Style.EMPTY);
        return found[0];
    }

    /**
     * The three commands each send one {@code request.control} with the player (and the position for
     * a cancel); the alias has them; an MCP without {@code requests} gets nothing and the player hears
     * that it's too old; offline they're locked.
     */
    @GameTest(template = "empty")
    public static void stopAndQueueCommandsSendRequestControl(GameTestHelper h) {
        ServerPlayer p = VolumeGameTests.op(h);
        Recorder out = new Recorder();
        RecordingBridge listed = new RecordingBridge(true, List.of("prompt.close", "ui", RequestMessages.FEATURE_REQUESTS));
        with(listed, out, () -> {
            run(p, "autosketch stop");
            run(p, "autosketch queue");
            run(p, "autosketch queue cancel 2");
            run(p, "autosketch queue cancel 0"); // not a position: brigadier refuses it
        });
        check(listed.sent.size() == 3, "three request.control sent, got " + listed.sent.size());
        List<RequestControl> cs = listed.sent.stream().map(RequestGameTests::control).toList();
        check(cs.stream().allMatch(c -> c.player().uuid().equals(p.getUUID()) && c.player().name().equals(p.getGameProfile().getName())), "each names the player: " + cs);
        check(cs.get(0).action().equals("stop") && cs.get(0).position() == null, "stop: " + cs.get(0));
        check(cs.get(1).action().equals("queue") && cs.get(1).position() == null, "queue: " + cs.get(1));
        check(cs.get(2).action().equals("queue.cancel") && cs.get(2).position() == 2, "queue cancel 2: " + cs.get(2));
        check(listed.sent.stream().allMatch(f -> f.id() == null), "no id, as prompt.close");
        check(out.barOf(p).equals(List.of(RequestCommands.STOPPING)), "the stop says it went out, the MCP answers the rest: " + out.barOf(p));

        var dispatcher = new com.mojang.brigadier.CommandDispatcher<net.minecraft.commands.CommandSourceStack>();
        PromptModule.alias(dispatcher, "zz");
        var alias = dispatcher.getRoot().getChild("zz");
        check(alias.getChild("stop") != null && alias.getChild("queue") != null && alias.getChild("queue").getChild("cancel") != null, "/zz stop, queue, queue cancel");

        RecordingBridge old = new RecordingBridge(true, List.of("prompt.close", "ui"));
        Recorder out2 = new Recorder();
        with(old, out2, () -> {
            run(p, "autosketch stop");
            run(p, "autosketch queue");
        });
        check(old.sent.isEmpty(), "nothing sent to an MCP without requests");
        check(out2.barOf(p).equals(List.of(RequestCommands.UNSUPPORTED, RequestCommands.UNSUPPORTED)), "too old, on the action bar: " + out2.barOf(p));

        RecordingBridge down = new RecordingBridge(false, List.of());
        Recorder out3 = new Recorder();
        with(down, out3, () -> run(p, "autosketch stop"));
        check(down.sent.isEmpty() && out3.barOf(p).isEmpty(), "locked offline (16), nothing sent: " + out3.barOf(p));
        h.getLevel().getServer().getPlayerList().remove(p);
        h.succeed();
    }

    /**
     * Without the client half: one plain line per state change ({@code working} twice prints once),
     * {@code lines[0]} as sent, with {@code /autosketch stop} after a working line and
     * {@code /autosketch queue cancel <n>} after a queued one, each a vanilla run-command click.
     */
    @GameTest(template = "empty")
    public static void plainLinesWithoutTheClientHalf(GameTestHelper h) {
        MinecraftServer server = h.getLevel().getServer();
        ServerPlayer p = VolumeGameTests.op(h);
        Recorder out = new Recorder();
        StatusLines.Relay prev = StatusLines.setRelay((pl, f) -> false);
        List<String> results = new ArrayList<>();
        try {
            with(new RecordingBridge(true, List.of(RequestMessages.FEATURE_REQUESTS)), out, () -> {
                results.add(StatusLines.onStatus(status(9001, p.getUUID(), "working", 3, null), server));
                results.add(StatusLines.onStatus(status(9001, p.getUUID(), "working", 14, null), server));
                results.add(StatusLines.onStatus(status(9001, p.getUUID(), "stopping", 15, null), server));
                results.add(StatusLines.onStatus(status(9001, p.getUUID(), "stopped", 15, null), server));
                results.add(StatusLines.onStatus(status(9002, p.getUUID(), "queued", 0, 1), server));
            });
        } finally {
            StatusLines.setRelay(prev);
        }
        check(results.equals(List.of("printed", "skipped", "printed", "printed", "printed")), "one line per state change: " + results);
        List<String> want = List.of(
                "⏳ Working · \"build a gatehouse on the east wall\" · 3 calls · 0:42  /autosketch stop",
                "■ Stopping… · \"build a gatehouse on the east wall\" · 15 calls · 0:44",
                "■ Stopped · \"build a gatehouse on the east wall\" · 15 calls · 0:47",
                "⧗ Queued · \"build a gatehouse on the east wall\"  /autosketch queue cancel 1");
        check(out.textOf(p).equals(want), "three plain lines for the request, one for the queued prompt: " + out.textOf(p));
        List<Component> cs = out.chatOf(p);
        check("/autosketch stop".equals(click(cs.get(0))), "the working line's hint runs /autosketch stop: " + click(cs.get(0)));
        check(click(cs.get(1)) == null && click(cs.get(2)) == null, "stopping and stopped have no command");
        check("/autosketch queue cancel 1".equals(click(cs.get(3))), "the queued line's hint: " + click(cs.get(3)));
        server.getPlayerList().remove(p);
        h.succeed();
    }

    /**
     * With the client half: the frame goes to the client whole, nothing is printed, and the relayed
     * copy carries one {@code /autosketch action} number per button, naming that button's
     * {@code ui.request}; another player, or a player who isn't an op, gets nothing.
     */
    @GameTest(template = "empty")
    public static void relayedWholeToTheClientHalfWithActionNumbers(GameTestHelper h) {
        MinecraftServer server = h.getLevel().getServer();
        ServerPlayer p = VolumeGameTests.op(h), other = VolumeGameTests.op(h);
        ServerPlayer stranger = h.makeMockServerPlayerInLevel();
        Recorder out = new Recorder();
        List<Frame> relayed = new ArrayList<>();
        List<UUID> to = new ArrayList<>();
        StatusLines.Relay prev = StatusLines.setRelay((pl, f) -> {
            relayed.add(f);
            to.add(pl.getUUID());
            return true;
        });
        String r1, r2;
        try {
            r1 = StatusLines.onStatus(status(9101, p.getUUID(), "queued", 0, 2), server);
            r2 = StatusLines.onStatus(status(9102, stranger.getUUID(), "working", 1, null), server);
        } finally {
            StatusLines.setRelay(prev);
        }
        check(r1.equals("relayed") && r2.equals("skipped"), "relayed to the op, skipped for a non-op: " + r1 + " " + r2);
        check(relayed.size() == 1 && to.equals(List.of(p.getUUID())), "to its own player only: " + to);
        check(out.chatOf(p).isEmpty() && out.chatOf(other).isEmpty(), "nothing printed");
        Frame f = relayed.get(0);
        try {
            Status back = Status.decode(f);
            check(back.equals(status(9101, p.getUUID(), "queued", 0, 2)), "the frame decodes to the status sent: " + back);
        } catch (ProtocolException e) {
            throw new GameTestAssertException("relayed frame doesn't decode: " + e.getMessage());
        }
        JsonArray ids = f.header().getAsJsonArray(StatusLines.ACTION_IDS);
        check(ids != null && ids.size() == 2, "one number per button: " + ids);
        Messages.ChatAction send = InGamePrompts.action(ids.get(0).getAsLong()), cancel = InGamePrompts.action(ids.get(1).getAsLong());
        check(send != null && send.kind().equals("queue.send") && send.args().get("request").getAsLong() == 9101, "Send now: " + send);
        check(cancel != null && cancel.kind().equals("queue.cancel"), "Cancel: " + cancel);
        check(dev.autosketch.mod.ui.ReplyActionCommand.clientAction(send).equals("chat.action queue.send {\"request\":9101}"), "the click hands the client queue.send");
        for (ServerPlayer x : List.of(p, other, stranger)) server.getPlayerList().remove(x);
        h.succeed();
    }

    /**
     * The server path over the real bridge: the mod's hello lists {@code requests}; {@code /autosketch
     * stop} reaches the MCP as {@code request.control}; a status line the MCP sends reaches the
     * player as a plain line (a mock player's client has no client half), and the {@code prompt.result}
     * {@code queued} says so on the action bar.
     */
    @GameTest(template = "empty", batch = "autosketch_requests", timeoutTicks = 200)
    public static void serverPathOverTheBridge(GameTestHelper h) {
        ServerPlayer p = VolumeGameTests.op(h);
        Recorder out = new Recorder();
        InGamePrompts.Output prev = InGamePrompts.setOutput(out);
        FakeMcp mcp = FakeMcp.open(List.of("prompt.close", "ui", RequestMessages.FEATURE_REQUESTS));
        var seq = mcp.start(h)
                .thenExecute(() -> {
                    Frame hello = mcp.received("hello").get(0);
                    check(hello.header().getAsJsonArray("features").toString().contains("\"requests\""), "the mod's hello lists requests: " + hello.header());
                    run(p, "autosketch stop");
                })
                .thenWaitUntil(() -> check(mcp.received("request.control").size() == 1, "request.control reaches the MCP"))
                .thenExecute(() -> {
                    RequestControl c = control(mcp.received("request.control").get(0));
                    check(c.action().equals("stop") && c.player().uuid().equals(p.getUUID()), "stop from the player: " + c);
                    mcp.send(status(9201, p.getUUID(), "stopping", 4, null).encode());
                    InGamePrompts.request(p, "build", "make the roof steeper", Autosketch.bridge());
                })
                .thenWaitUntil(() -> check(!out.textOf(p).isEmpty() && mcp.received("prompt").size() == 1, "the status line arrives and the prompt goes out"))
                .thenExecute(() -> {
                    check(out.textOf(p).equals(List.of("■ Stopping… · \"build a gatehouse on the east wall\" · 4 calls · 0:44")), "a plain line: " + out.textOf(p));
                    long id = mcp.received("prompt").get(0).id();
                    mcp.send(new Messages.PromptResult(id, false, null, 9201L, 1).encode());
                })
                .thenWaitUntil(() -> check(out.barOf(p).contains(InGamePrompts.queuedText(1)), "queued, on the action bar: " + out.barOf(p)))
                .thenExecute(() -> {
                    InGamePrompts.setOutput(prev);
                    h.getLevel().getServer().getPlayerList().remove(p);
                });
        mcp.finish(seq);
    }
}
