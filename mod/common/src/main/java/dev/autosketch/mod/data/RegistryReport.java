package dev.autosketch.mod.data;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.GZIPOutputStream;
import net.minecraft.SharedConstants;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;

/**
 * The registry report (14, *Version-specific data lives in the mod*): every block the running game
 * knows, with all its properties, their allowed values and the default state; which blocks have a
 * block entity; the block tags; and the game's DataVersion. Read from the live registries, so modded
 * blocks come with their full property sets (including the ones blockstate files leave out because
 * they don't change the model, such as Create's {@code waterlogged}).
 *
 * <p>Format 1, UTF-8 JSON with keys in a fixed order and blocks, properties and tags sorted, so the
 * same modset gives the same bytes and the same hash:
 * <pre>{"format":1,"minecraft":"1.21.1","dataVersion":3955,"loader":"neoforge","loaderVersion":"21.1.249",
 *  "blocks":{"minecraft:oak_stairs":{"properties":{"facing":["north","south","west","east"],…},
 *            "default":{"facing":"north",…}},"minecraft:chest":{…,"blockEntity":true},"minecraft:stone":{}},
 *  "tags":{"minecraft:logs":["minecraft:oak_log",…]}}</pre>
 * Property values are listed in the game's order. {@code properties} and {@code default} are left out
 * for a block without properties, {@code blockEntity} unless true. The hash is the first 8 bytes of
 * SHA-256 over the JSON bytes, as the protocol's hashes are (13, *Hashing*).
 *
 * <p>This class reads registries through the 1.21.1 API; when a version changes that API, its
 * version-conditional code goes here.
 */
public final class RegistryReport {
    /** The report format this build writes. */
    public static final int FORMAT = 1;

    private final byte[] json;
    private final long hash;
    private final int dataVersion;
    private final int blocks;
    private byte[] gzip;

    private RegistryReport(byte[] json, int dataVersion, int blocks) {
        this.json = json;
        this.hash = hash(json);
        this.dataVersion = dataVersion;
        this.blocks = blocks;
    }

    /** Builds the report from the live registries (the server must be started, so tags are bound). */
    public static RegistryReport build() {
        int dataVersion = SharedConstants.getCurrentVersion().getDataVersion().getVersion();
        JsonObject root = new JsonObject();
        root.addProperty("format", FORMAT);
        root.addProperty("minecraft", SharedConstants.getCurrentVersion().getName());
        root.addProperty("dataVersion", dataVersion);
        Platform platform = Platform.get();
        root.addProperty("loader", platform.loader());
        root.addProperty("loaderVersion", platform.loaderVersion());

        Map<String, Block> byId = new TreeMap<>();
        for (Map.Entry<net.minecraft.resources.ResourceKey<Block>, Block> e : BuiltInRegistries.BLOCK.entrySet())
            byId.put(e.getKey().location().toString(), e.getValue());
        JsonObject blocks = new JsonObject();
        for (Map.Entry<String, Block> e : byId.entrySet()) blocks.add(e.getKey(), block(e.getValue()));
        root.add("blocks", blocks);

        Map<String, List<String>> tags = new TreeMap<>();
        BuiltInRegistries.BLOCK.getTags().forEach(pair -> {
            List<String> members = new ArrayList<>();
            for (Holder<Block> h : pair.getSecond()) h.unwrapKey().ifPresent(k -> members.add(k.location().toString()));
            members.sort(null);
            tags.put(pair.getFirst().location().toString(), members);
        });
        JsonObject tagJson = new JsonObject();
        for (Map.Entry<String, List<String>> e : tags.entrySet()) tagJson.add(e.getKey(), Json.strings(e.getValue()));
        root.add("tags", tagJson);
        return new RegistryReport(Json.write(root).getBytes(StandardCharsets.UTF_8), dataVersion, byId.size());
    }

    private static JsonObject block(Block block) {
        JsonObject o = new JsonObject();
        Collection<Property<?>> props = block.getStateDefinition().getProperties();
        if (!props.isEmpty()) {
            List<Property<?>> sorted = new ArrayList<>(props);
            sorted.sort((a, b) -> a.getName().compareTo(b.getName()));
            BlockState def = block.defaultBlockState();
            JsonObject values = new JsonObject(), defaults = new JsonObject();
            for (Property<?> p : sorted) {
                JsonArray a = new JsonArray();
                for (Object v : p.getPossibleValues()) a.add(valueName(p, v));
                values.add(p.getName(), a);
                defaults.addProperty(p.getName(), valueName(p, def.getValue(p)));
            }
            o.add("properties", values);
            o.add("default", defaults);
        }
        if (block instanceof EntityBlock) o.addProperty("blockEntity", true);
        return o;
    }

    @SuppressWarnings("unchecked")
    private static <T extends Comparable<T>> String valueName(Property<T> p, Object v) {
        return p.getName((T) v);
    }

    public static long hash(byte[] bytes) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(bytes);
            long h = 0;
            for (int i = 0; i < 8; i++) h = (h << 8) | (d[i] & 0xff);
            return h;
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // every JVM has SHA-256
        }
    }

    /** The JSON bytes. */
    public byte[] json() {
        return json;
    }

    public long hash() {
        return hash;
    }

    public int dataVersion() {
        return dataVersion;
    }

    public int blockCount() {
        return blocks;
    }

    /** The file's bytes: gzip of the JSON. */
    public synchronized byte[] gzip() {
        if (gzip == null) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(json.length / 8 + 64);
            try (GZIPOutputStream z = new GZIPOutputStream(out)) {
                z.write(json);
            } catch (IOException e) {
                throw new IllegalStateException(e); // in memory
            }
            gzip = out.toByteArray();
        }
        return gzip;
    }

    /** Writes the gzip file (temporary file, then rename). */
    public Path write(Path file) throws IOException {
        Files.createDirectories(file.getParent());
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.write(tmp, gzip());
        try {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
        }
        return file;
    }
}
