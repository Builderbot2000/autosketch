package dev.autosketch.mod.gametest;

import static dev.autosketch.mod.gametest.VolumeGameTests.op;
import static dev.autosketch.mod.gametest.VolumeGameTests.run;
import static dev.autosketch.mod.gametest.VolumeGameTests.xyz;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorMessage;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.RequestMessages;
import dev.autosketch.mod.volume.CanvasManager;
import dev.autosketch.mod.world.SelectGrants;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * The canvas in the mod (19, *Setting the canvas*; 13, *Request control and canvas*; briefs/canvas/K,
 * K1): the wand's {@code canvas} mode and {@code /autosketch canvas here|grow|clear|show}, widened to
 * whole chunk columns and the full build height; the {@code canvasChunks} cap; a work volume marked
 * outside the canvas clearing it; the {@code canvas} messages to an MCP listing the feature (after
 * {@code volumes} on connect, on every change) and none to one that doesn't; {@code canvas.set} and its
 * refusals. The canvas is global, so each test runs in its own batch and clears it.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class CanvasGameTests {
    private CanvasGameTests() {}

    static final List<String> WITH_CANVAS = List.of(Messages.MCP_FEATURE_PROMPT_CLOSE, "ui", RequestMessages.FEATURE_CANVAS);

    static CanvasManager canvas() {
        return AutosketchMod.internals().canvas();
    }

    /** The canvas over chunks {@code cx0..cx1} by {@code cz0..cz1}, full build height. */
    static Box chunks(ServerLevel level, int cx0, int cz0, int cx1, int cz1) {
        return new Box(cx0 << 4, level.getMinBuildHeight(), cz0 << 4, (cx1 << 4) + 15, level.getMaxBuildHeight() - 1, (cz1 << 4) + 15);
    }

    static List<RequestMessages.Canvas> canvases(FakeMcp mcp) {
        List<RequestMessages.Canvas> out = new ArrayList<>();
        for (Frame f : mcp.received("canvas"))
            try {
                out.add(RequestMessages.Canvas.decode(f));
            } catch (ProtocolException e) {
                throw new GameTestAssertException("undecodable canvas: " + e.getMessage());
            }
        return out;
    }

    static void check(boolean ok, String message) {
        if (!ok) throw new GameTestAssertException(message);
    }

    static void cleanup(GameTestHelper h, ServerPlayer p) {
        canvas().clear();
        AutosketchMod.internals().volumes().clear();
        h.getLevel().getServer().getPlayerList().remove(p);
    }

    @GameTest(template = "empty", batch = "k_canvas_commands", timeoutTicks = 400)
    public static void commandsAndWandSetTheCanvas(GameTestHelper h) {
        FakeMcp mcp = FakeMcp.open(WITH_CANVAS);
        ServerPlayer[] p = new ServerPlayer[1];
        ServerLevel level = h.getLevel();
        Box[] expect = new Box[3];
        mcp.finish(mcp.start(h).thenWaitUntil(() -> {
            if (canvases(mcp).isEmpty()) throw new GameTestAssertException("waiting for the canvas after the hello");
        }).thenExecute(() -> {
            try {
                check(canvases(mcp).get(0).equals(RequestMessages.Canvas.none()), "none after the hello: " + canvases(mcp));
                List<String> types = mcp.frames.stream().map(Frame::type).toList();
                check(types.indexOf("volumes") >= 0 && types.indexOf("volumes") < types.indexOf("canvas"), "canvas after volumes: " + types);
                p[0] = op(h);
                BlockPos at = h.absolutePos(new BlockPos(1, 1, 1));
                p[0].moveTo(at.getX() + 0.5, at.getY(), at.getZ() + 0.5);
                int cx = at.getX() >> 4, cz = at.getZ() >> 4;

                run(p[0], "autosketch canvas here 2");
                expect[0] = chunks(level, cx - 2, cz - 2, cx + 2, cz + 2);
                check(expect[0].equals(canvas().box()) && level.dimension().equals(canvas().dimension()), "here 2: 5x5 chunks around the player's: " + canvas().box());
                check(SelectGrants.area(level.dimension().location().toString()).canvas() != null, "the read area holds the canvas");

                run(p[0], "autosketch canvas grow 1");
                expect[1] = chunks(level, cx - 3, cz - 3, cx + 3, cz + 3);
                check(expect[1].equals(canvas().box()), "grow 1: 7x7 chunks: " + canvas().box());

                run(p[0], "autosketch canvas show");
                check(AutosketchMod.internals().players().get(p[0].getUUID()).show, "show turns the outlines on");

                // The wand's canvas mode: two corners, widened.
                run(p[0], "autosketch mode canvas");
                check(AutosketchMod.internals().wand().mode(p[0]).name().equals("canvas"), "mode canvas");
                BlockPos a = new BlockPos((cx << 4) + 5, 70, (cz << 4) + 9), b = new BlockPos(((cx + 3) << 4) + 2, 80, ((cz + 1) << 4) + 1);
                run(p[0], "autosketch pos1 " + xyz(a));
                check(expect[1].equals(canvas().box()), "one corner doesn't change the canvas");
                run(p[0], "autosketch pos2 " + xyz(b));
                expect[2] = chunks(level, cx, cz, cx + 3, cz + 1);
                check(expect[2].equals(canvas().box()), "two corners: 4x2 chunks: " + canvas().box());

                run(p[0], "autosketch canvas clear");
                check(canvas().box() == null && SelectGrants.canvas() == null, "clear");
            } catch (RuntimeException e) {
                if (p[0] != null) cleanup(h, p[0]);
                throw e;
            }
        }).thenWaitUntil(() -> {
            if (canvases(mcp).size() < 5) throw new GameTestAssertException("waiting for a canvas message per change: " + canvases(mcp).size());
        }).thenExecute(() -> {
            try {
                List<RequestMessages.Canvas> sent = canvases(mcp);
                List<Box> boxes = sent.stream().map(RequestMessages.Canvas::box).toList();
                check(boxes.equals(java.util.Arrays.asList(null, expect[0], expect[1], expect[2], null)), "a canvas message per change: " + boxes);
                check(sent.stream().allMatch(c -> c.id() == null), "no ids on player changes");
            } finally {
                cleanup(h, p[0]);
            }
        }));
    }

    @GameTest(template = "empty", batch = "k_canvas_cap", timeoutTicks = 200)
    public static void canvasChunksCapsPlayerAndAgent(GameTestHelper h) {
        FakeMcp mcp = FakeMcp.open(WITH_CANVAS);
        ServerPlayer[] p = new ServerPlayer[1];
        ServerLevel level = h.getLevel();
        int saved = AutosketchConfig.get().volumes.canvasChunks;
        long[] ids = {9001, 9002, 9003};
        mcp.finish(mcp.start(h).thenExecute(() -> {
            p[0] = op(h);
            AutosketchConfig.get().volumes.canvasChunks = 4;
            run(p[0], "autosketch canvas here 2"); // 5 chunks across
            check(canvas().box() == null, "over canvasChunks is refused for the player");
            run(p[0], "autosketch canvas here 1"); // 3 chunks
            check(canvas().box() != null, "within it is accepted");
            mcp.send(new RequestMessages.CanvasSet(ids[0], level.dimension().location().toString(), new Box(0, 0, 0, 16 * 4, 0, 0)).encode()); // 5 chunks after widening
            mcp.send(new RequestMessages.CanvasSet(ids[1], "minecraft:no_such_place", new Box(0, 0, 0, 1, 1, 1)).encode());
            mcp.send(new RequestMessages.CanvasSet(ids[2], level.dimension().location().toString(), new Box(-20, 70, 5, 20, 75, 6)).encode());
        }).thenWaitUntil(() -> {
            if (mcp.received("error").size() < 2 || canvases(mcp).stream().noneMatch(c -> c.id() != null))
                throw new GameTestAssertException("waiting for the answers: " + mcp.frames.stream().map(Frame::type).toList());
        }).thenExecute(() -> {
            try {
                List<ErrorMessage> errors = new ArrayList<>();
                for (Frame f : mcp.received("error")) errors.add(ErrorMessage.decode(f));
                ErrorMessage wide = errors.stream().filter(e -> e.id() != null && e.id() == ids[0]).findFirst().orElseThrow();
                check(wide.code().equals("bad_volumes") && wide.message().contains("canvasChunks"), "over the cap: bad_volumes naming the key: " + wide.code() + " " + wide.message());
                ErrorMessage dim = errors.stream().filter(e -> e.id() != null && e.id() == ids[1]).findFirst().orElseThrow();
                check(dim.code().equals("wrong_dimension"), "unknown dimension: " + dim.code());
                RequestMessages.Canvas ok = canvases(mcp).stream().filter(c -> c.id() != null).findFirst().orElseThrow();
                check(ok.id() == ids[2] && ok.box().equals(chunks(level, -2, 0, 1, 0)) && ok.dimension().equals(level.dimension().location().toString()),
                        "canvas.set widened and confirmed with its id: " + ok);
                check(ok.box().equals(canvas().box()), "and set");
                check(canvases(mcp).stream().filter(c -> c.box() != null && c.box().equals(ok.box())).count() == 1, "the confirmation is the change notice, not sent twice");
            } catch (ProtocolException e) {
                throw new GameTestAssertException("undecodable error: " + e.getMessage());
            } finally {
                AutosketchConfig.get().volumes.canvasChunks = saved;
                if (p[0] != null) cleanup(h, p[0]);
            }
        }));
    }

    @GameTest(template = "empty", batch = "k_canvas_clearing", timeoutTicks = 200)
    public static void aWorkVolumeMarkedOutsideClearsTheCanvas(GameTestHelper h) {
        FakeMcp mcp = FakeMcp.open(WITH_CANVAS);
        Box[] farWork = new Box[1], canvasBox = new Box[1];
        ServerPlayer[] p = new ServerPlayer[1];
        ServerLevel level = h.getLevel();
        mcp.finish(mcp.start(h).thenExecute(() -> {
            try {
                p[0] = op(h);
                BlockPos at = h.absolutePos(new BlockPos(1, 1, 1));
                p[0].moveTo(at.getX() + 0.5, at.getY(), at.getZ() + 0.5);
                run(p[0], "autosketch canvas here 1");
                Box c = canvas().box();
                check(c != null, "canvas set");
                canvasBox[0] = c;
                run(p[0], "autosketch mode work");
                run(p[0], "autosketch pos1 " + xyz(at));
                run(p[0], "autosketch pos2 " + xyz(at.offset(3, 3, 3)));
                check(Autosketch.link().current() != null && c.equals(canvas().box()), "a work volume inside the canvas keeps it");
                BlockPos far = new BlockPos(c.maxX() + 40, at.getY(), at.getZ());
                run(p[0], "autosketch pos1 " + xyz(far));
                run(p[0], "autosketch pos2 " + xyz(far.offset(3, 3, 3)));
                farWork[0] = Box.of(far, far.offset(3, 3, 3));
                check(Autosketch.link().current() != null && Autosketch.link().current().work().equals(farWork[0]), "the new work volume is set");
                check(canvas().box() == null, "and the canvas is cleared");
                // An agent's volumes.set never clears it.
                run(p[0], "autosketch canvas here 1");
                AutosketchMod.internals().volumes().setFromAgent(1, level.dimension().location().toString(), Box.of(far, far.offset(1, 1, 1)), null);
                check(canvas().box() != null, "volumes.set outside the canvas keeps it (the MCP decides, 19 F2)");
            } catch (ProtocolException e) {
                if (p[0] != null) cleanup(h, p[0]);
                throw new GameTestAssertException("volumes.set refused: " + e.getMessage());
            }
        }).thenWaitUntil(() -> {
            if (canvases(mcp).size() < 4) throw new GameTestAssertException("waiting for the canvas messages: " + canvases(mcp).size());
        }).thenExecute(() -> {
            try {
                // The cleared canvas's none comes right after the volumes naming the first work volume outside it.
                List<Frame> frames = List.copyOf(mcp.frames);
                int cleared = -1, canvasSeen = 0;
                for (int i = 0; i < frames.size() && cleared < 0; i++)
                    if (frames.get(i).type().equals("canvas") && ++canvasSeen == 3) cleared = i;
                check(cleared > 0 && RequestMessages.Canvas.decode(frames.get(cleared)).box() == null, "the third canvas is none: " + frames.stream().map(Frame::type).toList());
                Frame before = frames.get(cleared - 1);
                Box work = before.type().equals("volumes") ? Messages.Volumes.decode(before).work() : null;
                check(work != null && !canvasBox[0].contains(work), "volumes with a work volume outside the canvas, then canvas none: " + frames.stream().map(Frame::type).toList());
            } catch (ProtocolException e) {
                throw new GameTestAssertException("undecodable frame: " + e.getMessage());
            } finally {
                cleanup(h, p[0]);
            }
        }));
    }

    /** An MCP whose hello doesn't list {@code canvas} gets no {@code canvas}; the canvas still works. */
    @GameTest(template = "empty", batch = "k_canvas_unlisted", timeoutTicks = 200)
    public static void noCanvasMessagesWithoutTheFeature(GameTestHelper h) {
        FakeMcp mcp = FakeMcp.open();
        ServerPlayer[] p = new ServerPlayer[1];
        mcp.finish(mcp.start(h).thenExecute(() -> {
            try {
                p[0] = op(h);
                run(p[0], "autosketch canvas here 1");
                check(canvas().box() != null, "the canvas is set all the same");
            } finally {
                if (p[0] != null) cleanup(h, p[0]);
            }
        }).thenIdle(2).thenExecute(() -> check(mcp.received("canvas").isEmpty(), "no canvas message: " + mcp.received("canvas"))));
    }
}
