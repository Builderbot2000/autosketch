package dev.autosketch.mod.api;

import org.jetbrains.annotations.Nullable;

/**
 * Patch progress for {@code /autosketch status} and the action bar (13, *Player feedback in-game*).
 * Silo O's patch applier provides it through {@link AutosketchSetupEvent#patchStatus}; read on the
 * server thread.
 */
public interface PatchStatus {
    /** Patches received and not yet acked: queued plus the one applying. */
    int pending();

    /** The last patch finished (acked), or null when none has been since the server started. */
    @Nullable Finished last();

    /** One finished patch: the ack's counts and when it was sent ({@code System.currentTimeMillis()}). */
    record Finished(long id, int applied, int overwritten, int skipped, int rejected, long finishedAtMillis) {}

    /** Status when no applier is registered. */
    PatchStatus NONE = new PatchStatus() {
        @Override
        public int pending() {
            return 0;
        }

        @Override
        public @Nullable Finished last() {
            return null;
        }
    };
}
