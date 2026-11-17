package dev.autosketch.mod.ui;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.ui.relay.ReplayResend;
import dev.autosketch.mod.ui.replay.ReplayCommand;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.server.ServerAboutToStartEvent;
import org.jetbrains.annotations.Nullable;

/**
 * NeoForge's hooks for replay's server half (16, *Replay in the world*): the {@code replay}
 * subcommand, and the chunk resend ({@link ReplayResend}) hooked onto C's relay once it exists.
 * Never references client classes.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class ReplayEvents {
    private ReplayEvents() {}

    private static volatile @Nullable ReplayResend resend;

    /** The resend, once a server started. */
    public static ReplayResend resend() {
        ReplayResend r = resend;
        if (r == null) throw new IllegalStateException("the Autosketch replay resend isn't set up yet");
        return r;
    }

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        e.commands(new ReplayCommand((p, action) -> UiNetwork.relay().sendAction(p, action)));
        // The relay is built by UiNetwork's own setup listener; hook on once it surely exists.
        NeoForge.EVENT_BUS.addListener((ServerAboutToStartEvent ev) -> {
            if (resend == null) resend = new ReplayResend(UiNetwork.relay(), Autosketch.bridge());
        });
        NeoForge.EVENT_BUS.addListener((PlayerEvent.PlayerLoggedOutEvent ev) -> {
            ReplayResend r = resend;
            if (r != null && ev.getEntity() instanceof ServerPlayer p) r.playerLeft(p);
        });
    }
}
