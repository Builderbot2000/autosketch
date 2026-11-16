package dev.autosketch.mod.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;

/** Access to the shared golden vectors in {@code test/data/world-protocol/} (13, *Golden vectors*). */
final class Golden {
    private Golden() {}

    static Path dir() {
        String p = System.getProperty("autosketch.goldenDir");
        if (p == null) throw new IllegalStateException("autosketch.goldenDir is not set (run the tests through Gradle)");
        return Path.of(p);
    }

    /** Names of every frame vector (a {@code .bin} with its {@code .json} sidecar). */
    static List<String> frameNames() {
        try (Stream<Path> s = Files.list(dir())) {
            return s.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".bin")).map(n -> n.substring(0, n.length() - 4)).sorted().toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static byte[] bin(String name) {
        try {
            return Files.readAllBytes(dir().resolve(name + ".bin"));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static JsonObject json(String name) {
        try {
            return Json.parse(Files.readString(dir().resolve(name + ".json"), StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static CompoundTag snbt(String s) {
        try {
            return TagParser.parseTag(s);
        } catch (CommandSyntaxException e) {
            throw new IllegalArgumentException("bad SNBT in a sidecar: " + s, e);
        }
    }

    static BlockPos pos(JsonElement e) {
        JsonArray a = e.getAsJsonArray();
        return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return sb.toString();
    }
}
