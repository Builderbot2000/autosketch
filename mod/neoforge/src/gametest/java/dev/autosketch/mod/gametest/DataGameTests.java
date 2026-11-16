package dev.autosketch.mod.gametest;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.bridge.BridgeServer;
import dev.autosketch.mod.data.DataModule;
import dev.autosketch.mod.data.RegistryReport;
import dev.autosketch.mod.data.Upgrades;
import dev.autosketch.mod.discovery.PointerFile;
import dev.autosketch.mod.protocol.BodyTypes.UpgradeData;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.GZIPInputStream;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * Version-specific data from the running game (14, *Version-specific data lives in the mod*): the
 * registry report's content and file, the data fixer's upgrades, and both requests over the bridge.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class DataGameTests {
    private DataGameTests() {}

    private static final int V1_19_4 = 3337, V1_20_1 = 3465;

    private static void check(boolean condition, String message) {
        BridgeGameTests.check(condition, message);
    }

    private static CompoundTag snbt(String s) {
        try {
            return TagParser.parseTag(s);
        } catch (CommandSyntaxException e) {
            throw new IllegalArgumentException(s, e);
        }
    }

    private static List<String> strings(JsonArray a) {
        return a.asList().stream().map(e -> e.getAsString()).toList();
    }

    @GameTest(template = "empty")
    public static void reportHasEveryPropertyAndTag(GameTestHelper h) throws Exception {
        RegistryReport r = DataModule.report();
        JsonObject root = Json.parse(new String(r.json(), StandardCharsets.UTF_8)).getAsJsonObject();
        check(root.get("format").getAsInt() == 1 && root.get("dataVersion").getAsInt() == Upgrades.currentVersion(), "format 1, the game's DataVersion");
        check(root.get("loader").getAsString().equals("neoforge"), "the loader");
        JsonObject blocks = root.getAsJsonObject("blocks");
        JsonObject stairs = blocks.getAsJsonObject("minecraft:oak_stairs");
        check(List.copyOf(stairs.getAsJsonObject("properties").keySet()).equals(List.of("facing", "half", "shape", "waterlogged")), "every property, sorted: " + stairs);
        check(strings(stairs.getAsJsonObject("properties").getAsJsonArray("half")).equals(List.of("top", "bottom")), "values in the game's order");
        JsonObject def = stairs.getAsJsonObject("default");
        check(def.get("facing").getAsString().equals("north") && def.get("half").getAsString().equals("bottom") && def.get("waterlogged").getAsString().equals("false"), "the default state");
        check(!stairs.has("blockEntity"), "stairs have no block entity");
        check(blocks.getAsJsonObject("minecraft:chest").get("blockEntity").getAsBoolean(), "a chest has one");
        check(blocks.getAsJsonObject("minecraft:stone").size() == 0, "a block without properties is {}");
        check(blocks.has("minecraft:air") && blocks.has("minecraft:moving_piston"), "blocks without blockstate files too");
        check(strings(root.getAsJsonObject("tags").getAsJsonArray("minecraft:logs")).contains("minecraft:oak_log"), "block tags");
        check(r.hash() == RegistryReport.hash(r.json()), "the hash covers the JSON");
        check(RegistryReport.build().hash() == r.hash(), "the same game gives the same bytes");

        // Written at server start beside the pointer file (the GameTest run's autosketch.home).
        Path file = PointerFile.gamesDir().resolve(PointerFile.hash(PointerFile.gameDirText(h.getLevel().getServer().getServerDirectory())) + PointerFile.REPORT_SUFFIX);
        h.succeedWhen(() -> {
            check(Files.isRegularFile(file), "the report file " + file);
            try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(Files.readAllBytes(file)))) {
                check(java.util.Arrays.equals(in.readAllBytes(), r.json()), "the file is the gzip of the report");
            } catch (java.io.IOException e) {
                throw new IllegalStateException(e);
            }
        });
    }

    @GameTest(template = "empty")
    public static void upgradesElementsThroughTheDataFixer(GameTestHelper h) {
        CompoundTag sign = snbt("{id:\"minecraft:sign\",Text1:'{\"text\":\"North\"}',Text2:'{\"text\":\"\"}',Text3:'{\"text\":\"\"}',Text4:'{\"text\":\"\"}',Color:\"black\",GlowingText:0b}");
        CompoundTag stand = snbt("{id:\"minecraft:armor_stand\",Invisible:0b}");
        UpgradeData in = UpgradeData.elements(List.of("minecraft:grass", "minecraft:oak_stairs[waterlogged=false,facing=east,half=bottom,shape=straight]", "othermod:gizmo[lit=true]", "broken["),
                List.of(sign), List.of(stand));
        Upgrades.Result r = Upgrades.upgrade(V1_19_4, in);
        check(r.to() == Upgrades.currentVersion(), "to the running version");
        List<String> states = r.data().states();
        check(states.get(0).equals("minecraft:short_grass"), "grass became short_grass (1.20.3): " + states);
        check(states.get(1).equals("minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]"), "unchanged blocks come back with sorted properties: " + states);
        check(states.get(2).equals("othermod:gizmo[lit=true]"), "a block the fixer doesn't know passes through");
        check(states.get(3).equals("broken["), "a state that doesn't parse comes back as it was");
        check(r.failed() == 1, "and is counted: " + r.failed());
        CompoundTag fixed = r.data().blockEntities().get(0);
        check(fixed.getCompound("front_text").getList("messages", 8).getString(0).equals("{\"text\":\"North\"}"), "the sign's text moved to front_text (1.20): " + fixed);
        check(r.data().entities().get(0).getString("id").equals("minecraft:armor_stand"), "entities go through the entity fixer");

        Upgrades.Result same = Upgrades.upgrade(Upgrades.currentVersion(), in);
        check(same.data() == in && same.failed() == 0, "forward only: data at the game's version comes back unchanged");
        h.succeed();
    }

    @GameTest(template = "empty")
    public static void upgradesWholeStructures(GameTestHelper h) {
        CompoundTag s = snbt("{DataVersion:" + V1_20_1 + ",size:[1,1,2],palette:[{Name:\"minecraft:grass\"},{Name:\"minecraft:stone\"}],blocks:[{pos:[0,0,0],state:0},{pos:[0,0,1],state:1}],entities:[]}");
        Upgrades.Result r = Upgrades.upgrade(V1_20_1, UpgradeData.structure(s));
        CompoundTag out = r.data().structure();
        check(out != null && out.getInt("DataVersion") == Upgrades.currentVersion(), "stamped with the running version");
        check(out.getList("palette", 10).getCompound(0).getString("Name").equals("minecraft:short_grass"), "the palette is upgraded: " + out);
        check(r.failed() == 0, "nothing failed");

        // A structure without a DataVersion is read as 500, as the game does: a grass path is a dirt path since 1.17.
        CompoundTag old = snbt("{size:[1,1,1],palette:[{Name:\"minecraft:grass_path\"}],blocks:[{pos:[0,0,0],state:0}],entities:[]}");
        CompoundTag up = Upgrades.upgrade(500, UpgradeData.structure(old)).data().structure();
        check(up.getList("palette", 10).getCompound(0).getString("Name").equals("minecraft:dirt_path"), "from 500: " + up);
        h.succeed();
    }

    @GameTest(template = "empty", batch = "autosketch_data_bridge", timeoutTicks = 2400)
    public static void servesRegistryAndUpgradeOverTheBridge(GameTestHelper h) throws Exception {
        BridgeServer bridge = AutosketchMod.internals().bridge();
        BridgeGameTests.Mcp mcp = new BridgeGameTests.Mcp(bridge.port(), bridge.token());
        long hash = DataModule.report().hash();
        h.startSequence()
                .thenWaitUntil(() -> check(!mcp.frames.isEmpty(), "hello"))
                .thenExecute(() -> {
                    try {
                        Messages.ModHello hello = Messages.ModHello.decode(mcp.frames.peek());
                        check(hello.features() != null && hello.features().containsAll(List.of("registry", "upgrade")), "the hello lists registry and upgrade: " + hello.features());
                        var out = mcp.socket.getOutputStream();
                        out.write(FrameCodec.encode(new Messages.RegistryRequest(1, null).encode()));
                        out.write(FrameCodec.encode(new Messages.RegistryRequest(2, hash).encode()));
                        out.write(FrameCodec.encode(new Messages.UpgradeRequest(3, V1_20_1, UpgradeData.elements(List.of("minecraft:grass"), List.of(), List.of())).encode()));
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                })
                .thenWaitUntil(() -> check(mcp.frames.stream().filter(f -> f.type().endsWith(".result") || f.type().equals("error")).count() >= 3, "three answers: " + mcp.frames.stream().map(f -> f.header().toString()).toList()))
                .thenExecute(() -> {
                    try {
                        List<Frame> answers = mcp.frames.stream().filter(f -> f.type().equals("registry.result") || f.type().equals("upgrade.result")).toList();
                        check(answers.size() == 3, "answers: " + answers);
                        Messages.RegistryResult full = Messages.RegistryResult.decode(answers.get(0));
                        check(full.id() == 1 && full.hash() == hash && full.report() != null, "the report");
                        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(full.report()))) {
                            check(RegistryReport.hash(in.readAllBytes()) == hash, "whose JSON has the hash");
                        }
                        Messages.RegistryResult unchanged = Messages.RegistryResult.decode(answers.get(1));
                        check(unchanged.id() == 2 && unchanged.report() == null, "unchanged for the hash the MCP holds");
                        Messages.UpgradeResult up = Messages.UpgradeResult.decode(answers.get(2));
                        check(up.id() == 3 && up.data().states().equals(List.of("minecraft:short_grass")), "upgraded in arrival order");
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                    mcp.close();
                })
                .thenWaitUntil(() -> check(!Autosketch.bridge().connected(), "disconnected"))
                .thenSucceed();
    }
}
