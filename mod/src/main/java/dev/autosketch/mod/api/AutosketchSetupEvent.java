package dev.autosketch.mod.api;

import java.util.List;
import net.neoforged.bus.api.Event;
import net.neoforged.fml.event.IModBusEvent;

/**
 * Posted once on the mod's event bus during common setup, before any server starts. Each silo's
 * package subscribes to it from its own class, so registering never edits another silo's files:
 *
 * <pre>{@code
 * @EventBusSubscriber(modid = Autosketch.MOD_ID, bus = EventBusSubscriber.Bus.MOD)
 * public final class WorldEvents {
 *     @SubscribeEvent
 *     static void setup(AutosketchSetupEvent event) {
 *         WorldModule.setup(event.setup()); // registration code in the common module
 *     }
 * }
 * }</pre>
 *
 * The NeoForge face of {@link AutosketchSetup}: the same methods, delegated, so registration code
 * in the common module takes {@link #setup()} (14, *Build layout*). Runtime services
 * ({@link Autosketch#bridge()}, {@link Autosketch#link()}) are available from the same point on.
 * Registration closes when the event returns.
 */
public final class AutosketchSetupEvent extends Event implements IModBusEvent {
    private final AutosketchSetup setup;

    public AutosketchSetupEvent(AutosketchSetup setup) {
        this.setup = setup;
    }

    public AutosketchSetupEvent(MessageRegistry messages) {
        this(new AutosketchSetup(messages));
    }

    /** The loader-neutral registrations, for registration code in the common module. */
    public AutosketchSetup setup() {
        return setup;
    }

    /** Handlers for MCP → mod message types. */
    public MessageRegistry messages() {
        return setup.messages();
    }

    /** Adds subcommands under {@code /autosketch}. */
    public void commands(CommandExtension extension) {
        setup.commands(extension);
    }

    /** Adds a wand mode; modes cycle in registration order. Names must be unique. */
    public void wandModes(WandMode mode) {
        setup.wandModes(mode);
    }

    /** Sets the patch applier's status source (silo O). Only one. */
    public void patchStatus(PatchStatus status) {
        setup.patchStatus(status);
    }

    // ── read by the mod after posting ─────────────────────────────────────────────────────────

    public void close() {
        setup.close();
    }

    public List<CommandExtension> commandExtensions() {
        return setup.commandExtensions();
    }

    public List<WandMode> registeredWandModes() {
        return setup.registeredWandModes();
    }

    public PatchStatus registeredPatchStatus() {
        return setup.registeredPatchStatus();
    }
}
