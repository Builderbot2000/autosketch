package dev.autosketch.mod.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.stream.JsonReader;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * Frame encoding (13, *Wire format*, *Framing*): {@code u32 frameLength}, {@code u32 headerLength},
 * the JSON header, then the body. Headers are written compact, keys in insertion order.
 */
public final class FrameCodec {
    private FrameCodec() {}

    public static final int MAX_FRAME = 256 * 1024 * 1024;
    public static final int MAX_HEADER = 1024 * 1024;

    /** The only messages that carry a body ({@code dirty} only when not {@code everything}). */
    public static final Set<String> BODY_TYPES = Set.of("patch", "snapshot.result", "patch.ack", "dirty");

    /** The complete frame, length prefix included. */
    public static byte[] encode(Frame frame) {
        byte[] header = Json.write(frame.header()).getBytes(StandardCharsets.UTF_8);
        if (header.length > MAX_HEADER) throw new IllegalArgumentException("header of " + header.length + " bytes exceeds 1 MiB");
        long frameLength = 4L + header.length + frame.body().length;
        if (frameLength > MAX_FRAME) throw new IllegalArgumentException("frame of " + frameLength + " bytes exceeds the maximum");
        ByteWriter w = new ByteWriter((int) frameLength + 4);
        w.u32(frameLength);
        w.u32(header.length);
        w.bytes(header);
        w.bytes(frame.body());
        return w.toByteArray();
    }

    public static void write(OutputStream out, Frame frame) throws IOException {
        out.write(encode(frame));
    }

    /** Decodes one complete frame (length prefix included) and checks nothing follows it. */
    public static Frame decode(byte[] bytes) throws ProtocolException {
        try {
            Frame f = read(new ByteArrayInputStream(bytes));
            if (f == null) throw ProtocolException.malformed("empty input");
            if (bytes.length != frameSize(bytes)) throw ProtocolException.malformed("bytes after the frame");
            return f;
        } catch (IOException e) {
            throw ProtocolException.malformed("truncated frame: " + e.getMessage());
        }
    }

    private static long frameSize(byte[] bytes) {
        return 4 + (((long) (bytes[0] & 0xff) << 24) | ((bytes[1] & 0xff) << 16) | ((bytes[2] & 0xff) << 8) | (bytes[3] & 0xff));
    }

    /**
     * Reads the next frame from a stream; null at a clean end of stream (between frames). A
     * malformed frame throws {@link ProtocolException} {@code bad_request}, after which the
     * connection must be closed; a stream that ends mid-frame throws {@link EOFException}.
     */
    public static Frame read(InputStream in) throws IOException, ProtocolException {
        DataInputStream din = in instanceof DataInputStream d ? d : new DataInputStream(in);
        int b0 = din.read();
        if (b0 < 0) return null;
        long frameLength = ((long) b0 << 24) | ((long) din.readUnsignedByte() << 16) | ((long) din.readUnsignedByte() << 8) | din.readUnsignedByte();
        if (frameLength < 4 || frameLength > MAX_FRAME) throw ProtocolException.malformed("frame length " + frameLength + " out of range");
        long headerLength = Integer.toUnsignedLong(din.readInt());
        if (headerLength > frameLength - 4 || headerLength > MAX_HEADER) throw ProtocolException.malformed("header length " + headerLength + " out of range");
        byte[] header = new byte[(int) headerLength];
        din.readFully(header);
        byte[] body = new byte[(int) (frameLength - 4 - headerLength)];
        din.readFully(body);
        JsonObject h = parseHeader(header);
        Frame frame = new Frame(h, body);
        String type = frame.type();
        boolean bodyAllowed = BODY_TYPES.contains(type) && !(type.equals("dirty") && isTrue(h, "everything"));
        if (body.length > 0 && !bodyAllowed) throw ProtocolException.malformed("a body on a " + (type.isEmpty() ? "header without a type" : type) + " message");
        return frame;
    }

    private static boolean isTrue(JsonObject h, String key) {
        JsonElement e = h.get(key);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() && e.getAsBoolean();
    }

    private static JsonObject parseHeader(byte[] bytes) throws ProtocolException {
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            throw ProtocolException.malformed("header is not UTF-8");
        }
        try {
            // Read through the adapter directly: JsonParser.parseReader would switch to lenient mode.
            JsonReader reader = new JsonReader(new StringReader(text));
            reader.setLenient(false);
            JsonElement e = Json.ELEMENT_ADAPTER.read(reader);
            if (reader.peek() != com.google.gson.stream.JsonToken.END_DOCUMENT) throw ProtocolException.malformed("data after the header object");
            if (!e.isJsonObject()) throw ProtocolException.malformed("header is not a JSON object");
            return e.getAsJsonObject();
        } catch (JsonParseException | IOException | IllegalStateException e) {
            throw ProtocolException.malformed("header is not valid JSON: " + e.getMessage());
        }
    }
}
