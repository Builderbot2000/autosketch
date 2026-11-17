package dev.autosketch.mod.ui;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.ui.relay.UiPayload;
import dev.autosketch.mod.ui.relay.UiRelay;
import java.util.function.Consumer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.network.PacketDistributor;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.handling.DirectionalPayloadHandler;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;
import org.jetbrains.annotations.Nullable;

/**
 * NeoForge's side of the in-game UI channel (13, *Relay to the client*; 16, *Mod side*): registers
 * {@code autosketch:ui} optional (vanilla clients and servers still join), builds the {@link UiRelay}
 * with a transport over NeoForge's packets, and hands client requests to it. The client half receives
 * its packets through {@link #clientSink}, which {@code client.ui.UiClient} sets, so this class
 * never references client classes and loads on a dedicated server.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class UiNetwork {
    private UiNetwork() {}

    private static volatile @Nullable UiRelay relay;

    /** Where the client half takes packets from the server (set by the client half; null on a dedicated server). Called on the client thread. */
    public static volatile @Nullable Consumer<UiPayload> clientSink;

    /** The transport over NeoForge's packets. */
    public static final UiRelay.Transport TRANSPORT = new UiRelay.Transport() {
        @Override
        public boolean hasChannel(ServerPlayer player) {
            return player.connection != null && player.connection.hasChannel(UiPayload.TYPE);
        }

        @Override
        public void send(ServerPlayer player, UiPayload payload) {
            PacketDistributor.sendToPlayer(player, payload);
        }
    };

    /** The relay, once setup ran. */
    public static UiRelay relay() {
        UiRelay r = relay;
        if (r == null) throw new IllegalStateException("the Autosketch UI relay isn't set up yet");
        return r;
    }

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        UiRelay r = new UiRelay(Autosketch.bridge(), TRANSPORT, true);
        r.setup(e.setup());
        relay = r;
        NeoForge.EVENT_BUS.addListener((PlayerEvent.PlayerLoggedInEvent ev) -> {
            if (ev.getEntity() instanceof ServerPlayer p) r.playerJoined(p);
        });
        NeoForge.EVENT_BUS.addListener((PlayerEvent.PlayerLoggedOutEvent ev) -> {
            if (ev.getEntity() instanceof ServerPlayer p) r.playerLeft(p);
        });
    }

    /** Registers the payload (from the mod's entry point, on the mod bus). */
    public static void register(RegisterPayloadHandlersEvent e) {
        PayloadRegistrar r = e.registrar("1").optional();
        r.playBidirectional(UiPayload.TYPE, UiPayload.CODEC, new DirectionalPayloadHandler<>(
                (m, ctx) -> {
                    Consumer<UiPayload> sink = clientSink;
                    if (sink != null) ctx.enqueueWork(() -> sink.accept(m));
                },
                (m, ctx) -> {
                    if (m.op() != UiPayload.REQUEST || m.data().length > UiPayload.MAX_REQUEST_BYTES) return;
                    ctx.enqueueWork(() -> {
                        UiRelay rl = relay;
                        if (rl != null && ctx.player() instanceof ServerPlayer p) rl.clientRequest(p, m);
                    });
                }));
    }

    /** Sends a packet to a player whose client runs the client half; nothing otherwise. */
    public static void send(ServerPlayer player, UiPayload payload) {
        if (TRANSPORT.hasChannel(player)) TRANSPORT.send(player, payload);
    }

    /** Client side: sends a packet to the server (a request). */
    public static void sendToServer(UiPayload payload) {
        PacketDistributor.sendToServer(payload);
    }
}
