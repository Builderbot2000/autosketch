package dev.autosketch.mod.api;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import net.neoforged.bus.api.Event;
import net.neoforged.fml.event.IModBusEvent;

/**
 * Posted once on the mod's event bus during common setup, before any server starts. Each silo's
 * package subscribes to it from its own class, so registering never edits another silo's files:
 *
 * <pre>{@code
 * @EventBusSubscriber(modid = Autosketch.MOD_ID, bus = EventBusSubscriber.Bus.MOD)
 * public final class WorldModule {
 *     @SubscribeEvent
 *     static void setup(AutosketchSetupEvent event) {
 *         event.messages().register("patch", new PatchHandler());
 *         event.patchStatus(applier);
 *     }
 * }
 * }</pre>
 *
 * Runtime services ({@link Autosketch#bridge()}, {@link Autosketch#link()}) are available from the
 * same point on. Registration closes when the event returns.
 */
public final class AutosketchSetupEvent extends Event implements IModBusEvent {
    private final MessageRegistry messages;
    private final List<CommandExtension> commands = new ArrayList<>();
    private final List<WandMode> wandModes = new ArrayList<>();
    private PatchStatus patchStatus = PatchStatus.NONE;
    private boolean closed;

    public AutosketchSetupEvent(MessageRegistry messages) {
        this.messages = messages;
    }

    /** Handlers for MCP → mod message types. */
    public MessageRegistry messages() {
        check();
        return messages;
    }

    /** Adds subcommands under {@code /autosketch}. */
    public void commands(CommandExtension extension) {
        check();
        commands.add(Objects.requireNonNull(extension));
    }

    /** Adds a wand mode; modes cycle in registration order. Names must be unique. */
    public void wandModes(WandMode mode) {
        check();
        for (WandMode m : wandModes) if (m.name().equals(mode.name())) throw new IllegalArgumentException("wand mode \"" + mode.name() + "\" registered twice");
        wandModes.add(mode);
    }

    /** Sets the patch applier's status source (silo O). Only one. */
    public void patchStatus(PatchStatus status) {
        check();
        if (patchStatus != PatchStatus.NONE) throw new IllegalStateException("patch status already set");
        patchStatus = Objects.requireNonNull(status);
    }

    private void check() {
        if (closed) throw new IllegalStateException("Autosketch setup is over");
    }

    // ── read by the mod after posting ─────────────────────────────────────────────────────────

    public void close() {
        closed = true;
    }

    public List<CommandExtension> commandExtensions() {
        return Collections.unmodifiableList(commands);
    }

    public List<WandMode> registeredWandModes() {
        return Collections.unmodifiableList(wandModes);
    }

    public PatchStatus registeredPatchStatus() {
        return patchStatus;
    }
}
