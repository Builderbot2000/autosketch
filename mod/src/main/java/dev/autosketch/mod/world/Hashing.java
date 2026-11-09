package dev.autosketch.mod.world;

import dev.autosketch.mod.protocol.Nbt;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.Tag;
import org.jetbrains.annotations.Nullable;

/**
 * The hashes shared with the MCP (13, *Wire format*, *Hashing*): canonical NBT, the NBT hash and the
 * section hash. A hash is the first 8 bytes of SHA-256, as a big-endian {@code long} (digest order).
 * Must reproduce {@code hash-nbt.json} and {@code hash-sections.json} exactly.
 */
public final class Hashing {
    private Hashing() {}

    /** The block-entity type a compound names, or null when it has no string {@code id}. */
    public static @Nullable String typeOf(CompoundTag nbt) {
        return nbt.contains("id", Tag.TAG_STRING) ? nbt.getString("id") : null;
    }

    /**
     * Canonical bytes: top-level {@code x}, {@code y}, {@code z} and every applicable volatile key
     * path removed, keys sorted recursively, binary NBT. Null when the type is state only. Never
     * mutates {@code nbt}. Throws {@link IllegalArgumentException} for a compound that can't be
     * written (a string over 65,535 modified-UTF-8 bytes, nesting over 512).
     */
    public static byte @Nullable [] canonical(CompoundTag nbt, VolatileKeys keys) {
        String type = typeOf(nbt);
        if (keys.stateOnly(type)) return null;
        CompoundTag top = shallowCopy(nbt);
        top.remove("x");
        top.remove("y");
        top.remove("z");
        for (String[] path : keys.pathsFor(type)) drop(top, path, 0);
        return Nbt.write(top);
    }

    private static CompoundTag shallowCopy(CompoundTag c) {
        CompoundTag out = new CompoundTag();
        for (String k : c.getAllKeys()) out.put(k, c.get(k));
        return out;
    }

    /** Removes one key path from {@code c} (already a private copy), copying compounds along the way. */
    private static void drop(CompoundTag c, String[] path, int i) {
        String head = path[i];
        if (!c.contains(head)) return;
        if (i == path.length - 1) {
            c.remove(head);
            return;
        }
        if (!(c.get(head) instanceof CompoundTag child)) return;
        CompoundTag copy = shallowCopy(child);
        c.put(head, copy);
        drop(copy, path, i + 1);
    }

    /** The NBT hash of a block entity's compound, or null when its type is state only. */
    public static @Nullable Long nbtHash(CompoundTag nbt, VolatileKeys keys) {
        byte[] b = canonical(nbt, keys);
        return b == null ? null : hash64(b);
    }

    public static long hash64(byte[] bytes) {
        return first8(sha256().digest(bytes));
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is missing from this JVM", e);
        }
    }

    static long first8(byte[] d) {
        long h = 0;
        for (int i = 0; i < 8; i++) h = (h << 8) | (d[i] & 0xff);
        return h;
    }

    /**
     * Builds one section hash: feed the positions inside the request's boxes in order y, z, x, each
     * with its canonical state and the NBT hash of its block entity (null for none or state only).
     * Not thread-safe; one per section (or {@link #reset} between sections).
     */
    public static final class SectionHasher {
        private final MessageDigest digest = sha256();
        private final Map<String, byte[]> stateBytes = new HashMap<>();
        private final byte[] buf = new byte[8192];
        private int n;
        private boolean any;

        public void add(String state, @Nullable Long nbtHash) {
            byte[] sb = stateBytes.computeIfAbsent(state, s -> s.getBytes(StandardCharsets.UTF_8));
            if (n + sb.length + 18 > buf.length) flush();
            if (sb.length + 18 > buf.length) {
                writeVarint(sb.length);
                flush();
                digest.update(sb);
            } else {
                writeVarint(sb.length);
                System.arraycopy(sb, 0, buf, n, sb.length);
                n += sb.length;
            }
            if (nbtHash == null) buf[n++] = 0;
            else {
                buf[n++] = 1;
                long h = nbtHash;
                for (int s = 56; s >= 0; s -= 8) buf[n++] = (byte) (h >>> s);
            }
            any = true;
        }

        private void writeVarint(long v) {
            while (v >= 0x80) {
                buf[n++] = (byte) ((v & 0x7f) | 0x80);
                v >>>= 7;
            }
            buf[n++] = (byte) v;
        }

        private void flush() {
            digest.update(buf, 0, n);
            n = 0;
        }

        /** Whether any position was added (a section with none has no hash). */
        public boolean any() {
            return any;
        }

        /** The hash, resetting the hasher for the next section. */
        public long finish() {
            flush();
            any = false;
            return first8(digest.digest());
        }

        public void reset() {
            n = 0;
            any = false;
            digest.reset();
        }
    }
}
