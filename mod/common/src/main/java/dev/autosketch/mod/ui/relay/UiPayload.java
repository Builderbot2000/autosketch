package dev.autosketch.mod.ui.relay;

import dev.autosketch.mod.api.Autosketch;
import java.nio.charset.StandardCharsets;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

/**
 * The one custom packet between the mod's server half and its client half (13, *Relay to the
 * client*): {@code autosketch:ui}, registered optional, so vanilla clients and servers still join.
 * Vanilla types only, so both halves and every loader share it.
 *
 * <ul>
 *   <li>{@link #FRAME} (server to client): part {@code part} of {@code parts} of a bridge frame,
 *       length prefix included; all parts of one frame share {@code id} and arrive consecutively.
 *   <li>{@link #REQUEST} (client to server): {@code data} is a {@code ui.request} header in UTF-8
 *       JSON, with the client's own number in {@code request} and no {@code player}.
 *   <li>{@link #LINK} (server to client): {@code data} is the link state's wire name
 *       ({@code offline}, {@code too_old}, {@code connected}; 16, *Mod side*).
 *   <li>{@link #CLIENT_ACTION} (server to client): {@code data} is {@code <action> <args…>} in UTF-8,
 *       something a server command hands to the client half ({@code replay.list},
 *       {@code replay.open <log>}, {@code replay.close}, ...). Actions are mod-internal: both halves
 *       ship in one jar, so they are not versioned.
 * </ul>
 */
public record UiPayload(byte op, long id, int part, int parts, byte[] data) implements CustomPacketPayload {
    public static final byte FRAME = 0, REQUEST = 1, LINK = 2, CLIENT_ACTION = 3;

    /** Requests from the client stay small; vanilla limits serverbound custom payloads to 32 KiB. */
    public static final int MAX_REQUEST_BYTES = 30_000;

    public static final Type<UiPayload> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath(Autosketch.MOD_ID, "ui"));

    public static final StreamCodec<FriendlyByteBuf, UiPayload> CODEC = StreamCodec.of((buf, p) -> {
        buf.writeByte(p.op);
        buf.writeVarLong(p.id);
        buf.writeVarInt(p.part);
        buf.writeVarInt(p.parts);
        buf.writeByteArray(p.data);
    }, buf -> new UiPayload(buf.readByte(), buf.readVarLong(), buf.readVarInt(), buf.readVarInt(), buf.readByteArray()));

    /** The link state for the client half. */
    public static UiPayload link(String wire) {
        return new UiPayload(LINK, 0, 0, 0, wire.getBytes(StandardCharsets.UTF_8));
    }

    /** A client action: {@code <action> <args…>}, for the client half's action registry. */
    public static UiPayload action(String text) {
        return new UiPayload(CLIENT_ACTION, 0, 0, 0, text.getBytes(StandardCharsets.UTF_8));
    }

    /** A client's request: its header JSON. */
    public static UiPayload request(String headerJson) {
        return new UiPayload(REQUEST, 0, 0, 0, headerJson.getBytes(StandardCharsets.UTF_8));
    }

    public String text() {
        return new String(data, StandardCharsets.UTF_8);
    }

    @Override
    public Type<UiPayload> type() {
        return TYPE;
    }
}
