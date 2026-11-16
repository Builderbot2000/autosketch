package dev.autosketch.mod.volume;

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
 * The client half's two messages (13, B2), registered optional so a client or server without the
 * mod still connects: {@link Click} (client → server: a left click into the air, or a new distance)
 * and {@link State} (server → client: air mode on or off, the distance and the wand item, so the
 * client previews the point and handles sneak+scroll). Neither touches client classes, so both sides
 * load this.
 */
public final class AirPayloads {
    private AirPayloads() {}

    /** {@code corner} 1 for a left click into the air, 0 for a distance change only. */
    public record Click(int corner, int reach) implements CustomPacketPayload {
        public static final Type<Click> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath(Autosketch.MOD_ID, "air_click"));
        public static final StreamCodec<ByteBuf, Click> CODEC = StreamCodec.composite(ByteBufCodecs.VAR_INT, Click::corner, ByteBufCodecs.VAR_INT, Click::reach, Click::new);

        @Override
        public Type<Click> type() {
            return TYPE;
        }
    }

    public record State(boolean on, int reach, String wandItem) implements CustomPacketPayload {
        public static final Type<State> TYPE = new Type<>(ResourceLocation.fromNamespaceAndPath(Autosketch.MOD_ID, "air_state"));
        public static final StreamCodec<ByteBuf, State> CODEC = StreamCodec.composite(ByteBufCodecs.BOOL, State::on, ByteBufCodecs.VAR_INT, State::reach,
                ByteBufCodecs.STRING_UTF8, State::wandItem, State::new);

        @Override
        public Type<State> type() {
            return TYPE;
        }
    }

    /** The client half's copy of the last {@link State} its server sent (null: none, the server's air mode is off or unknown). */
    public static volatile State clientState;

    public static void register(RegisterPayloadHandlersEvent e, AirMode air) {
        PayloadRegistrar r = e.registrar("1").optional();
        r.playToServer(Click.TYPE, Click.CODEC, (m, ctx) -> ctx.enqueueWork(() -> {
            if (ctx.player() instanceof ServerPlayer p) air.clientClick(p, m.corner(), m.reach());
        }));
        r.playToClient(State.TYPE, State.CODEC, (m, ctx) -> clientState = m.on() ? m : null);
    }

    public static boolean hasClientHalf(ServerPlayer p) {
        return p.connection != null && p.connection.hasChannel(State.TYPE);
    }

    public static void sendState(ServerPlayer p, boolean on, int reach, String wandItem) {
        if (hasClientHalf(p)) PacketDistributor.sendToPlayer(p, new State(on, reach, wandItem));
    }
}
