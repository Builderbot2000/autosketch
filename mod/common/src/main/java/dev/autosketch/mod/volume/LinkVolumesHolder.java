package dev.autosketch.mod.volume;

import dev.autosketch.mod.api.LinkState;
import dev.autosketch.mod.api.LinkVolumes;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import org.jetbrains.annotations.Nullable;

/**
 * Holds the link's volumes and notifies listeners on change (13, *Work and context volumes
 * in-game*). Skeleton: starts unlinked; the wand and commands that set it land in the volumes
 * milestone. Server thread only.
 */
public final class LinkVolumesHolder implements LinkState {
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private @Nullable LinkVolumes current;

    @Override
    public @Nullable LinkVolumes current() {
        return current;
    }

    @Override
    public void addListener(Listener listener) {
        listeners.add(listener);
    }

    /** Replaces the volumes and notifies listeners when they changed. */
    public void set(@Nullable LinkVolumes next) {
        LinkVolumes prev = current;
        if (Objects.equals(prev, next)) return;
        current = next;
        for (Listener l : listeners) l.changed(prev, next);
    }
}
