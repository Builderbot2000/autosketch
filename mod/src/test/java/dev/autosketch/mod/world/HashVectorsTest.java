package dev.autosketch.mod.world;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.autosketch.mod.protocol.Messages;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The hash vectors shared with the TypeScript side ({@code hash-nbt.json}, {@code hash-sections.json};
 * 13, *Golden vectors*): canonical bytes and hashes must match exactly. Section hashes are fed
 * through {@link Hashing.SectionHasher} in the order {@link WorldReads} uses (y, z, x over the
 * positions inside any box).
 */
class HashVectorsTest {
    static JsonObject vectors(String name) throws IOException {
        String dir = System.getProperty("autosketch.goldenDir");
        return JsonParser.parseString(Files.readString(Path.of(dir, name), StandardCharsets.UTF_8)).getAsJsonObject();
    }

    static CompoundTag snbt(String s) {
        try {
            return TagParser.parseTag(s);
        } catch (Exception e) {
            throw new IllegalArgumentException(s, e);
        }
    }

    @TestFactory
    Stream<DynamicTest> nbtHashes() throws IOException {
        List<DynamicTest> out = new ArrayList<>();
        for (JsonElement e : vectors("hash-nbt.json").getAsJsonArray("cases")) {
            JsonObject c = e.getAsJsonObject();
            out.add(DynamicTest.dynamicTest(c.get("name").getAsString(), () -> {
                CompoundTag tag = snbt(c.get("snbt").getAsString());
                VolatileKeys keys = VolatileKeys.parse(c.getAsJsonObject("volatile"));
                byte[] canonical = Hashing.canonical(tag, keys);
                if (c.get("hash").isJsonNull()) {
                    assertNull(canonical, "state only has no canonical form");
                    assertNull(Hashing.nbtHash(tag, keys));
                    return;
                }
                assertEquals(c.get("canonical").getAsString(), HexFormat.of().formatHex(canonical));
                assertEquals(c.get("hash").getAsString(), Messages.hex(Hashing.nbtHash(tag, keys)));
            }));
        }
        return out.stream();
    }

    @TestFactory
    Stream<DynamicTest> sectionHashes() throws IOException {
        List<DynamicTest> out = new ArrayList<>();
        for (JsonElement e : vectors("hash-sections.json").getAsJsonArray("cases")) {
            JsonObject c = e.getAsJsonObject();
            out.add(DynamicTest.dynamicTest(c.get("name").getAsString(), () -> {
                JsonArray s = c.getAsJsonArray("section");
                int sx = s.get(0).getAsInt(), sy = s.get(1).getAsInt(), sz = s.get(2).getAsInt();
                List<int[]> boxes = new ArrayList<>();
                for (JsonElement b : c.getAsJsonArray("boxes")) {
                    JsonArray mn = b.getAsJsonObject().getAsJsonArray("min"), mx = b.getAsJsonObject().getAsJsonArray("max");
                    boxes.add(new int[] {mn.get(0).getAsInt(), mn.get(1).getAsInt(), mn.get(2).getAsInt(), mx.get(0).getAsInt(), mx.get(1).getAsInt(), mx.get(2).getAsInt()});
                }
                VolatileKeys keys = VolatileKeys.parse(c.getAsJsonObject("volatile"));
                String fill = c.get("fill").getAsString();
                Map<String, JsonObject> blocks = new HashMap<>();
                for (JsonElement b : c.getAsJsonArray("blocks")) {
                    JsonArray p = b.getAsJsonObject().getAsJsonArray("pos");
                    blocks.put(p.get(0).getAsInt() + "," + p.get(1).getAsInt() + "," + p.get(2).getAsInt(), b.getAsJsonObject());
                }
                Hashing.SectionHasher h = new Hashing.SectionHasher();
                for (int y = sy * 16; y < sy * 16 + 16; y++)
                    for (int z = sz * 16; z < sz * 16 + 16; z++)
                        for (int x = sx * 16; x < sx * 16 + 16; x++) {
                            boolean in = false;
                            for (int[] b : boxes) in |= x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
                            if (!in) continue;
                            JsonObject blk = blocks.get(x + "," + y + "," + z);
                            String state = blk == null ? fill : blk.get("state").getAsString();
                            Long nbtHash = blk != null && blk.has("nbt") ? Hashing.nbtHash(snbt(blk.get("nbt").getAsString()), keys) : null;
                            h.add(state, nbtHash);
                        }
                assertTrue(h.any());
                assertEquals(c.get("hash").getAsString(), Messages.hex(h.finish()));
            }));
        }
        return out.stream();
    }

    @Test
    void canonicalDoesNotMutateInput() {
        CompoundTag t = snbt("{id:\"minecraft:furnace\",x:1,y:2,z:3,BurnTime:5s,Network:{Stress:1,Keep:2}}");
        CompoundTag before = t.copy();
        Hashing.canonical(t, VolatileKeys.parse(JsonParser.parseString("{\"*\":[\"Network/Stress\"],\"minecraft:furnace\":[\"BurnTime\"]}").getAsJsonObject()));
        assertEquals(before, t);
    }

    @Test
    void varintAndLongStatesHashLikeShortOnes() {
        // A state string longer than the hasher's buffer goes through the slow path; the hash must
        // equal hashing the same stream in one go.
        String longState = "x".repeat(20000);
        Hashing.SectionHasher h = new Hashing.SectionHasher();
        h.add("minecraft:stone", null);
        h.add(longState, 0x0102030405060708L);
        long got = h.finish();
        byte[] ls = longState.getBytes(StandardCharsets.UTF_8);
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        bo.write(15);
        bo.writeBytes("minecraft:stone".getBytes(StandardCharsets.UTF_8));
        bo.write(0);
        bo.write(0xa0); // 20000 = 0x4e20 → a0 9c 01
        bo.write(0x9c);
        bo.write(0x01);
        bo.writeBytes(ls);
        bo.write(1);
        bo.writeBytes(new byte[] {1, 2, 3, 4, 5, 6, 7, 8});
        assertEquals(Hashing.hash64(bo.toByteArray()), got);
        assertArrayEquals(new byte[0], new byte[0]);
    }
}
