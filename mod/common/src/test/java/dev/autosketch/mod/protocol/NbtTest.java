package dev.autosketch.mod.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.security.MessageDigest;
import java.util.Set;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.IntTag;
import org.junit.jupiter.api.Test;

/**
 * The deterministic NBT writer against the canonical bytes in {@code hash-nbt.json}, for the cases
 * where canonicalisation removes nothing (no volatile keys, no top-level x/y/z), so the expected
 * bytes are exactly the sorted binary form. Volatile-key removal and the hash functions are silo O's.
 */
class NbtTest {
    private static final Set<String> PLAIN = Set.of("empty", "nested", "all-types", "unicode");

    @Test
    void writesHashVectorBytes() throws Exception {
        JsonObject file = Golden.json("hash-nbt");
        int checked = 0;
        for (JsonElement e : file.getAsJsonArray("cases")) {
            JsonObject c = e.getAsJsonObject();
            if (!PLAIN.contains(c.get("name").getAsString())) continue;
            CompoundTag tag = Golden.snbt(c.get("snbt").getAsString());
            byte[] bytes = Nbt.write(tag);
            assertEquals(c.get("canonical").getAsString(), Golden.hex(bytes), c.get("name").getAsString());
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            assertEquals(c.get("hash").getAsString(), Golden.hex(java.util.Arrays.copyOf(digest, 8)), c.get("name").getAsString() + " hash");
            // and reads back to the same compound
            assertEquals(tag, Nbt.read(bytes, 0, bytes.length));
            checked++;
        }
        assertEquals(PLAIN.size(), checked);
    }

    @Test
    void emptyListIsWrittenWithTypeEnd() throws Exception {
        ListTag list = new ListTag();
        list.add(IntTag.valueOf(1));
        list.remove(0); // ListTag keeps its element type after the last element goes
        CompoundTag c = new CompoundTag();
        c.put("l", list);
        assertEquals("0a0000" + "0900016c" + "00" + "00000000" + "00", Golden.hex(Nbt.write(c)));
    }

    @Test
    void rejectsTrailingBytes() {
        byte[] b = {0x0a, 0, 0, 0, 0};
        assertThrows(ProtocolException.class, () -> Nbt.read(b, 0, b.length));
    }
}
