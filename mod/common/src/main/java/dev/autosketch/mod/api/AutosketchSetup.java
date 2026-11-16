package dev.autosketch.mod.api;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * The registrations made during setup, without any loader's event type, so registration code can
 * live in the common module (14, *Build layout*). Each loader hands it to the silos in its own way;
 * on NeoForge it is wrapped by {@code AutosketchSetupEvent}, which has the same methods. Registration
 * closes when setup returns.
 */
public final class AutosketchSetup {
    private final MessageRegistry messages;
    private final List<CommandExtension> commands = new ArrayList<>();
    private final List<WandMode> wandModes = new ArrayList<>();
    private PatchStatus patchStatus = PatchStatus.NONE;
    private boolean closed;

    public AutosketchSetup(MessageRegistry messages) {
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

    // ── read by the mod after setup ───────────────────────────────────────────────────────────

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
