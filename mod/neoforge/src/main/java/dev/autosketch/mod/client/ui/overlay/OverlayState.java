package dev.autosketch.mod.client.ui.overlay;

import dev.autosketch.mod.protocol.UiMessages.Flash;
import dev.autosketch.mod.protocol.UiMessages.Job;
import dev.autosketch.mod.protocol.UiMessages.Refusal;
import dev.autosketch.mod.protocol.UiMessages.RequestInfo;
import dev.autosketch.mod.protocol.UiMessages.Tokens;
import dev.autosketch.mod.protocol.UiMessages.UiFlash;
import dev.autosketch.mod.protocol.UiMessages.UiState;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.jetbrains.annotations.Nullable;

/**
 * The client's copy of the overlay and HUD state (13, *In-game UI*, {@code ui.state} and
 * {@code ui.flash}; 16, *Overlays in the world*, *HUD*), exactly as the MCP sent it: a map from job
 * id to the job's whole record, the open request, token totals and last refusal, and the flashes
 * still pulsing. Nothing is derived here: a full state replaces everything, a change puts or removes
 * whole jobs by id and replaces the fields it carries (no field-level merge, 13's
 * <em>Why replace-by-key per job</em>).
 *
 * <p>The {@code seq} check (13, <em>Sequence and resync</em>): a full state's {@code seq} is adopted;
 * a change applies only when its {@code seq} is the held one plus 1. Any other change is dropped and
 * {@link #apply} says a {@code resync} is needed. Jobs and flashes in another dimension are kept and
 * only filtered out when drawing (13, <em>Other dimensions</em>). Client thread only.
 */
public final class OverlayState {
    /** How long a flash pulses, in milliseconds (16, *Change flashes*: "a short pulse"). */
    public static final long FLASH_MS = 1500;

    /** A flash and when it arrived ({@code Util.getMillis()} time). */
    public record ActiveFlash(Flash flash, long start) {}

    private long seq; // 0: no full state held
    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private @Nullable RequestInfo request;
    private @Nullable Tokens tokens;
    private @Nullable Refusal refusal;
    private final List<ActiveFlash> flashes = new ArrayList<>();

    /** The held state's {@code seq}; 0 before the first full state (and after {@link #clear}). */
    public long seq() {
        return seq;
    }

    /** Open jobs in the MCP's order (a full state's order; a job added by a change goes last). */
    public List<Job> jobs() {
        return List.copyOf(jobs.values());
    }

    public @Nullable RequestInfo request() {
        return request;
    }

    public @Nullable Tokens tokens() {
        return tokens;
    }

    public @Nullable Refusal refusal() {
        return refusal;
    }

    /**
     * Applies a {@code ui.state}. Returns false when it was a change that doesn't follow the held
     * state (a gap, or no full state yet): it was dropped and the caller asks for a {@code resync}.
     */
    public boolean apply(UiState s) {
        if (s.full()) {
            jobs.clear();
            for (Job j : s.jobs()) jobs.put(j.id(), j);
            request = value(s.request());
            tokens = value(s.tokens());
            refusal = value(s.refusal());
            seq = s.seq();
            return true;
        }
        if (seq == 0 || s.seq() != seq + 1) return false;
        for (Job j : s.jobs()) jobs.put(j.id(), j);
        for (String id : s.removed()) jobs.remove(id);
        if (s.request() != null) request = value(s.request());
        if (s.tokens() != null) tokens = value(s.tokens());
        if (s.refusal() != null) refusal = value(s.refusal());
        seq = s.seq();
        return true;
    }

    private static <T> @Nullable T value(@Nullable Optional<T> o) {
        return o == null ? null : o.orElse(null);
    }

    /** Adds a {@code ui.flash}'s records, pulsing from {@code now}. Fire-and-forget: no seq. */
    public void flash(UiFlash f, long now) {
        for (Flash x : f.flashes()) flashes.add(new ActiveFlash(x, now));
    }

    /** Flashes still pulsing at {@code now}; expired ones are dropped. */
    public List<ActiveFlash> flashes(long now) {
        flashes.removeIf(a -> now - a.start() >= FLASH_MS);
        return List.copyOf(flashes);
    }

    /** Forgets everything (the link went away: the next MCP sends a full state). */
    public void clear() {
        seq = 0;
        jobs.clear();
        request = null;
        tokens = null;
        refusal = null;
        flashes.clear();
    }
}
