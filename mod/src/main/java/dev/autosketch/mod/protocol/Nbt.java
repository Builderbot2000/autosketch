package dev.autosketch.mod.protocol;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.nbt.ByteArrayTag;
import net.minecraft.nbt.ByteTag;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.FloatTag;
import net.minecraft.nbt.IntArrayTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.LongArrayTag;
import net.minecraft.nbt.LongTag;
import net.minecraft.nbt.NumericTag;
import net.minecraft.nbt.ShortTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;

/**
 * Binary NBT for the bridge (13, *Wire format*, *NBT*): uncompressed and big-endian, a root compound
 * with an empty name, strings in Java modified UTF-8. Unlike {@code NbtIo}, the writer is
 * deterministic: compound keys sorted recursively in UTF-16 code-unit order ({@code String.compareTo})
 * and empty lists written with element type End. The same bytes are the canonical form hashing
 * builds on (*Hashing*). The reader accepts any key order.
 */
public final class Nbt {
    private Nbt() {}

    private static final int MAX_DEPTH = 512;

    /** The compound as a named root (tag id 0x0A, empty name, payload). */
    public static byte[] write(CompoundTag tag) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(64);
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            write(out, tag);
        } catch (IOException e) {
            throw new IllegalArgumentException("NBT can't be written: " + e.getMessage(), e);
        }
        return bytes.toByteArray();
    }

    public static void write(DataOutputStream out, CompoundTag tag) throws IOException {
        out.writeByte(Tag.TAG_COMPOUND);
        out.writeUTF("");
        writePayload(out, tag, 0);
    }

    private static void writePayload(DataOutputStream out, Tag tag, int depth) throws IOException {
        if (depth > MAX_DEPTH) throw new IOException("NBT nested deeper than " + MAX_DEPTH);
        switch (tag.getId()) {
            case Tag.TAG_BYTE, Tag.TAG_SHORT, Tag.TAG_INT, Tag.TAG_LONG, Tag.TAG_FLOAT, Tag.TAG_DOUBLE -> writeNumber(out, (NumericTag) tag);
            case Tag.TAG_BYTE_ARRAY -> {
                byte[] a = ((ByteArrayTag) tag).getAsByteArray();
                out.writeInt(a.length);
                out.write(a);
            }
            case Tag.TAG_STRING -> out.writeUTF(tag.getAsString());
            case Tag.TAG_LIST -> {
                ListTag list = (ListTag) tag;
                out.writeByte(list.isEmpty() ? Tag.TAG_END : list.getElementType());
                out.writeInt(list.size());
                for (Tag t : list) writePayload(out, t, depth + 1);
            }
            case Tag.TAG_COMPOUND -> {
                CompoundTag c = (CompoundTag) tag;
                List<String> keys = new ArrayList<>(c.getAllKeys());
                keys.sort(String::compareTo);
                for (String k : keys) {
                    Tag v = c.get(k);
                    out.writeByte(v.getId());
                    out.writeUTF(k);
                    writePayload(out, v, depth + 1);
                }
                out.writeByte(Tag.TAG_END);
            }
            case Tag.TAG_INT_ARRAY -> {
                int[] a = ((IntArrayTag) tag).getAsIntArray();
                out.writeInt(a.length);
                for (int v : a) out.writeInt(v);
            }
            case Tag.TAG_LONG_ARRAY -> {
                long[] a = ((LongArrayTag) tag).getAsLongArray();
                out.writeInt(a.length);
                for (long v : a) out.writeLong(v);
            }
            default -> throw new IOException("unknown NBT tag type " + tag.getId());
        }
    }

    private static void writeNumber(DataOutputStream out, NumericTag n) throws IOException {
        switch (n.getId()) {
            case Tag.TAG_BYTE -> out.writeByte(n.getAsByte());
            case Tag.TAG_SHORT -> out.writeShort(n.getAsShort());
            case Tag.TAG_INT -> out.writeInt(n.getAsInt());
            case Tag.TAG_LONG -> out.writeLong(n.getAsLong());
            case Tag.TAG_FLOAT -> out.writeFloat(n.getAsFloat());
            default -> out.writeDouble(n.getAsDouble());
        }
    }

    /** Reads exactly one named-root compound occupying all of {@code buf[off, off+len)}. */
    public static CompoundTag read(byte[] buf, int off, int len) throws ProtocolException {
        try {
            ByteArrayInputStream bytes = new ByteArrayInputStream(buf, off, len);
            DataInputStream in = new DataInputStream(bytes);
            if (in.readUnsignedByte() != Tag.TAG_COMPOUND) throw ProtocolException.malformed("NBT root is not a compound");
            in.readUTF();
            CompoundTag tag = (CompoundTag) readPayload(in, Tag.TAG_COMPOUND, 0);
            if (bytes.available() != 0) throw ProtocolException.malformed("NBT length doesn't match its content");
            return tag;
        } catch (IOException e) {
            throw ProtocolException.malformed("malformed NBT: " + e.getMessage());
        }
    }

    private static Tag readPayload(DataInputStream in, int type, int depth) throws IOException, ProtocolException {
        if (depth > MAX_DEPTH) throw ProtocolException.malformed("NBT nested deeper than " + MAX_DEPTH);
        switch (type) {
            case Tag.TAG_BYTE:
                return ByteTag.valueOf(in.readByte());
            case Tag.TAG_SHORT:
                return ShortTag.valueOf(in.readShort());
            case Tag.TAG_INT:
                return IntTag.valueOf(in.readInt());
            case Tag.TAG_LONG:
                return LongTag.valueOf(in.readLong());
            case Tag.TAG_FLOAT:
                return FloatTag.valueOf(in.readFloat());
            case Tag.TAG_DOUBLE:
                return DoubleTag.valueOf(in.readDouble());
            case Tag.TAG_BYTE_ARRAY: {
                byte[] a = new byte[length(in, 1)];
                in.readFully(a);
                return new ByteArrayTag(a);
            }
            case Tag.TAG_STRING:
                return StringTag.valueOf(in.readUTF());
            case Tag.TAG_LIST: {
                int elem = in.readUnsignedByte();
                int n = in.readInt();
                if (n < 0) throw ProtocolException.malformed("negative NBT list length");
                if (n > 0 && elem == Tag.TAG_END) throw ProtocolException.malformed("non-empty NBT list of type End");
                ListTag list = new ListTag();
                for (int i = 0; i < n; i++) list.add(readPayload(in, elem, depth + 1));
                return list;
            }
            case Tag.TAG_COMPOUND: {
                CompoundTag c = new CompoundTag();
                while (true) {
                    int t = in.readUnsignedByte();
                    if (t == Tag.TAG_END) return c;
                    String key = in.readUTF();
                    if (c.contains(key)) throw ProtocolException.malformed("NBT compound repeats key \"" + key + "\"");
                    c.put(key, readPayload(in, t, depth + 1));
                }
            }
            case Tag.TAG_INT_ARRAY: {
                int[] a = new int[length(in, 4)];
                for (int i = 0; i < a.length; i++) a[i] = in.readInt();
                return new IntArrayTag(a);
            }
            case Tag.TAG_LONG_ARRAY: {
                long[] a = new long[length(in, 8)];
                for (int i = 0; i < a.length; i++) a[i] = in.readLong();
                return new LongArrayTag(a);
            }
            default:
                throw ProtocolException.malformed("unknown NBT tag type " + type);
        }
    }

    private static int length(DataInputStream in, int elementSize) throws IOException, ProtocolException {
        int n = in.readInt();
        if (n < 0 || (long) n * elementSize > in.available()) throw ProtocolException.malformed("NBT array length " + n + " can't fit");
        return n;
    }
}
