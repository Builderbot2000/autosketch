package dev.autosketch.mod.link;

import dev.autosketch.mod.api.Autosketch;
import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;

/**
 * The link status to the client half (16, *Mod side*; briefs/ui/L, deliverable 2), registered
 * optional so a vanilla client still joins. <b>Interim</b>: silo C's {@code autosketch:ui} channel
 * carries this as its {@code LINK} op once it lands; then {@link #sendStatus} becomes
 * {@code UiNetwork.send(player, UiPayload.link(status.wire()))} and {@link #clientStatus} gives way
 * to C's {@code client.ui.LinkState} (the one call site is in {@link #register}). Touches no client
 * classes, so both sides load it.
 */
public final class LinkPayloads {
    private LinkPayloads() {}

    /** Server → client: the status's wire name ({@code offline}, {@code too_old}, {@code connected}). */
    public record Status(String wire) implements CustomPacketPayload {
        public static final Type<Status> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath(Autosketch.MOD_ID, "link_state"));
        public static final StreamCodec<ByteBuf, Status> CODEC = StreamCodec.composite(ByteBufCodecs.STRING_UTF8, Status::wire, Status::new);

        @Override
        public Type<Status> type() {
            return TYPE;
        }
    }

    /**
     * The client half's copy of the last status its server sent; {@link LinkStatus#OFFLINE} until one
     * arrives, and again after leaving the server. Client features check it before drawing or sending.
     */
    public static volatile LinkStatus clientStatus = LinkStatus.OFFLINE;

    public static void register(RegisterPayloadHandlersEvent e) {
        PayloadRegistrar r = e.registrar("1").optional();
        r.playToClient(Status.TYPE, Status.CODEC, (m, ctx) -> clientStatus = LinkStatus.fromWire(m.wire()));
    }

    public static void sendStatus(ServerPlayer p, LinkStatus status) {
        if (p.connection != null && p.connection.hasChannel(Status.TYPE)) PacketDistributor.sendToPlayer(p, new Status(status.wire()));
    }
}
