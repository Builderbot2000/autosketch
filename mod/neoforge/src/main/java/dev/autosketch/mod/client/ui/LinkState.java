package dev.autosketch.mod.client.ui;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.jetbrains.annotations.Nullable;

/**
 * The client half's copy of the link state its server sent (16, *Mod side*): {@link State#OFFLINE}
 * (no MCP: draw nothing, send nothing), {@link State#TOO_OLD} (an MCP without {@code ui}: the in-game
 * UI is locked) or {@link State#CONNECTED}. The server half sends it as op {@code LINK} on
 * {@code autosketch:ui} on every change and on join (silo L); {@link UiClient} writes it here, and
 * resets it to offline when the player leaves the server. Every client feature checks it before
 * drawing or sending. Read and written on the client thread.
 */
public final class LinkState {
    private LinkState() {}

    public enum State {
        OFFLINE("offline"),
        TOO_OLD("too_old"),
        CONNECTED("connected");

        private final String wire;

        State(String wire) {
            this.wire = wire;
        }

        public String wire() {
            return wire;
        }

        /** The state with this wire name; offline for an unknown one. */
        public static State fromWire(@Nullable String wire) {
            for (State s : values()) if (s.wire.equals(wire)) return s;
            return OFFLINE;
        }
    }

    private static volatile State state = State.OFFLINE;
    private static final List<Consumer<State>> listeners = new CopyOnWriteArrayList<>();

    public static State get() {
        return state;
    }

    /** Whether the in-game UI may draw and send: an MCP with {@code ui} is connected. */
    public static boolean connected() {
        return state == State.CONNECTED;
    }

    /** Sets the state; listeners hear only real changes. */
    public static void set(State s) {
        if (s == state) return;
        state = s;
        for (Consumer<State> l : listeners) l.accept(s);
    }

    public static void addListener(Consumer<State> listener) {
        listeners.add(listener);
    }
}
