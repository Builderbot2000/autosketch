package dev.autosketch.mod.protocol;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads the wire primitives from a byte range (13, *Wire format*, *Primitives*). Every failure is
 * a {@link ProtocolException} {@code bad_request}: truncation, a non-minimal or over-long varint,
 * invalid UTF-8.
 */
public final class ByteReader {
    private final byte[] buf;
    private int pos;
    private final int end;

    public ByteReader(byte[] buf) {
        this(buf, 0, buf.length);
    }

    public ByteReader(byte[] buf, int off, int end) {
        this.buf = buf;
        this.pos = off;
        this.end = end;
    }

    public int position() {
        return pos;
    }

    public int remaining() {
        return end - pos;
    }

    public byte[] buffer() {
        return buf;
    }

    public void skip(int n) throws ProtocolException {
        need(n);
        pos += n;
    }

    private void need(int n) throws ProtocolException {
        if (n < 0 || n > end - pos) throw ProtocolException.malformed("body truncated");
    }

    public int u8() throws ProtocolException {
        need(1);
        return buf[pos++] & 0xff;
    }

    public long u32() throws ProtocolException {
        need(4);
        long v = ((long) (buf[pos] & 0xff) << 24) | ((buf[pos + 1] & 0xff) << 16) | ((buf[pos + 2] & 0xff) << 8) | (buf[pos + 3] & 0xff);
        pos += 4;
        return v;
    }

    public long varint() throws ProtocolException {
        long v = 0;
        for (int i = 0; i < 8; i++) {
            int b = u8();
            v |= (long) (b & 0x7f) << (7 * i);
            if ((b & 0x80) == 0) {
                if (b == 0 && i > 0) throw ProtocolException.malformed("non-minimal varint");
                if (v > ByteWriter.MAX_VARINT) throw ProtocolException.malformed("varint beyond 2^53 - 1");
                return v;
            }
        }
        throw ProtocolException.malformed("varint longer than 8 bytes");
    }

    /** A varint that must fit an int and not exceed {@code max}: counts, lengths, table indices. */
    public int count(long max, String what) throws ProtocolException {
        long v = varint();
        if (v > max) throw ProtocolException.malformed(what + " " + v + " exceeds " + max);
        return (int) v;
    }

    public byte[] bytes(int n) throws ProtocolException {
        need(n);
        byte[] out = new byte[n];
        System.arraycopy(buf, pos, out, 0, n);
        pos += n;
        return out;
    }

    public long hash() throws ProtocolException {
        need(8);
        long h = 0;
        for (int i = 0; i < 8; i++) h = (h << 8) | (buf[pos++] & 0xff);
        return h;
    }

    public String str() throws ProtocolException {
        int n = count(remaining(), "string length");
        try {
            String s = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(buf, pos, n))
                    .toString();
            pos += n;
            return s;
        } catch (CharacterCodingException e) {
            throw ProtocolException.malformed("invalid UTF-8 in a string");
        }
    }

    public List<String> table() throws ProtocolException {
        // Each string takes at least one byte, so a count beyond the remaining bytes can't fit.
        int n = count(remaining(), "table size");
        List<String> out = new ArrayList<>(n);
        for (int i = 0; i < n; i++) out.add(str());
        return out;
    }

    public void expectEnd(String what) throws ProtocolException {
        if (pos != end) throw ProtocolException.malformed(what + ": " + (end - pos) + " trailing bytes");
    }
}
