package dev.autosketch.mod.protocol;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/**
 * A growable big-endian byte buffer with the wire primitives (13, *Wire format*, *Primitives*):
 * unsigned LEB128 varints up to 2^53 − 1, body strings (varint length, standard UTF-8) and tables.
 */
public final class ByteWriter {
    public static final long MAX_VARINT = (1L << 53) - 1;

    private byte[] buf;
    private int len;

    public ByteWriter() {
        this(256);
    }

    public ByteWriter(int capacity) {
        buf = new byte[Math.max(16, capacity)];
    }

    public int length() {
        return len;
    }

    public void reset() {
        len = 0;
    }

    private void ensure(int extra) {
        int need = len + extra;
        if (need < 0) throw new IllegalStateException("message too large");
        if (need > buf.length) buf = Arrays.copyOf(buf, Math.max(need, buf.length * 2));
    }

    public void u8(int v) {
        ensure(1);
        buf[len++] = (byte) v;
    }

    public void u16(int v) {
        ensure(2);
        buf[len++] = (byte) (v >>> 8);
        buf[len++] = (byte) v;
    }

    public void u32(long v) {
        ensure(4);
        buf[len++] = (byte) (v >>> 24);
        buf[len++] = (byte) (v >>> 16);
        buf[len++] = (byte) (v >>> 8);
        buf[len++] = (byte) v;
    }

    public void varint(long v) {
        if (v < 0 || v > MAX_VARINT) throw new IllegalArgumentException("varint out of range: " + v);
        ensure(8);
        while (v >= 0x80) {
            buf[len++] = (byte) ((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        buf[len++] = (byte) v;
    }

    public void bytes(byte[] b) {
        bytes(b, 0, b.length);
    }

    public void bytes(byte[] b, int off, int n) {
        ensure(n);
        System.arraycopy(b, off, buf, len, n);
        len += n;
    }

    /** Body string: varint byte length, then standard UTF-8. */
    public void str(String s) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        varint(b.length);
        bytes(b);
    }

    public void table(List<String> list) {
        varint(list.size());
        for (String s : list) str(s);
    }

    public void hash(long h) {
        ensure(8);
        for (int i = 7; i >= 0; i--) buf[len++] = (byte) (h >>> (i * 8));
    }

    public byte[] toByteArray() {
        return Arrays.copyOf(buf, len);
    }

    /** Copies this buffer's content into {@code w}. */
    public void writeTo(ByteWriter w) {
        w.bytes(buf, 0, len);
    }
}
