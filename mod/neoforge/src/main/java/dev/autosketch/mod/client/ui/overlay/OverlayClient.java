package dev.autosketch.mod.client.ui.overlay;

import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.hud.HudOverlay;
import dev.autosketch.mod.feedback.VolumeOutlines;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.UiMessages.UiFlash;
import dev.autosketch.mod.protocol.UiMessages.UiState;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;

/**
 * Silo O's client entry (16, *Overlays in the world*, *HUD*): registers the {@code ui.state} and
 * {@code ui.flash} handlers and the volume outlines' (op 4, 18 piece 8) on {@link UiClient}, the toggle keys' actions on {@link AutosketchKeys},
 * the world overlay's render listener and the HUD layer. A second client entry point of the mod (as
 * the client test driver is), so {@code AutosketchClient} stays C's.
 *
 * <p>Owns the {@code seq} check's consequence: a {@code ui.state} change that doesn't follow the held
 * state sends one {@code resync} request (13, <em>Sequence and resync</em>); another is sent only
 * after its answer arrives. Leaving {@code connected} forgets the state, since the next MCP sends a
 * full one. Client thread.
 */
@Mod(value = Autosketch.MOD_ID, dist = Dist.CLIENT)
public final class OverlayClient {
    private static final Logger LOG = LogUtils.getLogger();

    private static final OverlayState STATE = new OverlayState();
    private static boolean resyncPending;
    private static int resyncs;

    public OverlayClient(IEventBus modBus) {
        UiClient.register("ui.state", (f, m) -> onState((UiState) m));
        UiClient.register("ui.flash", (f, m) -> STATE.flash((UiFlash) m, Util.getMillis()));
        UiClient.onOutlines(json -> {
            try {
                STATE.volumes(VolumeOutlines.parse(json));
            } catch (ProtocolException e) {
                LOG.warn("Autosketch UI: dropped malformed volume outlines: {}", e.getMessage());
            }
        });
        LinkState.addListener(s -> {
            if (s != LinkState.State.CONNECTED) {
                STATE.clear();
                resyncPending = false;
            }
        });
        // Silo O's block in the key table: the job volume, flash and HUD toggles.
        AutosketchKeys.on(AutosketchKeys.TOGGLE_VOLUMES, () -> {
            UiToggles.toggleVolumes();
            say("job volumes " + (UiToggles.volumes ? "on" : "off"));
        });
        AutosketchKeys.on(AutosketchKeys.TOGGLE_FLASHES, () -> {
            UiToggles.toggleFlashes();
            say("change flashes " + (UiToggles.flashes ? "on" : "off"));
        });
        AutosketchKeys.on(AutosketchKeys.TOGGLE_HUD, () -> say("HUD " + HudOverlay.cycle()));
        NeoForge.EVENT_BUS.addListener(OverlayClient::render);
        modBus.addListener(HudOverlay::register);
    }

    /** The held state (read by the HUD and by client tests). */
    public static OverlayState state() {
        return STATE;
    }

    /** How many {@code resync} requests this client sent (for tests). */
    public static int resyncs() {
        return resyncs;
    }

    /** What the overlays draw now, for the player's current dimension. */
    public static DrawList drawList() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.level == null) return DrawList.EMPTY;
        net.minecraft.world.phys.Vec3 cam = mc.gameRenderer.getMainCamera().getPosition();
        return DrawList.build(STATE, Util.getMillis(), mc.level.dimension().location().toString(), cam.x, cam.y, cam.z, LinkState.connected(), UiToggles.volumes,
                UiToggles.flashes);
    }

    private static void onState(UiState s) {
        if (STATE.apply(s)) {
            if (s.full()) resyncPending = false;
            return;
        }
        LOG.debug("Autosketch UI: ui.state {} doesn't follow {}; resyncing", s.seq(), STATE.seq());
        if (resyncPending || !LinkState.connected()) return;
        resyncPending = true;
        resyncs++;
        UiClient.request("resync", new JsonObject(), r -> {
            resyncPending = false;
            if (!r.ok()) LOG.warn("Autosketch UI: resync failed: {} {}", r.error(), r.message());
        });
    }

    private static void render(RenderLevelStageEvent e) {
        if (e.getStage() != RenderLevelStageEvent.Stage.AFTER_TRANSLUCENT_BLOCKS) return;
        DrawList list = drawList();
        if (list.isEmpty()) return;
        OverlayRenderer.render(list, e.getPoseStack(), e.getCamera(), Minecraft.getInstance().renderBuffers().bufferSource());
    }

    private static void say(String text) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) mc.player.displayClientMessage(Component.literal("Autosketch: " + text), true);
    }
}
