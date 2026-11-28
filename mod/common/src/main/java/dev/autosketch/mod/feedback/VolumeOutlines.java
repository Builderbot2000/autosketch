package dev.autosketch.mod.feedback;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.UiMessages;
import java.util.ArrayList;
import java.util.List;

/**
 * The player's volume outlines as the server half sends them to its own client half (13, *Relay to
 * the client*, op {@code 4}; 18, piece 8): the player's dimension and, per wand mode in mode order,
 * its colour and the boxes {@code WandMode.outline} gives. An empty {@code outlines} hides them. The
 * canvas mode's entry (19, *Placing and moving the brush*) is {@code faint} (the canvas as a faint
 * box) and, while the wand is held, {@code grid} (a chunk grid on the ground inside it).
 * Mod-internal (both halves ship in one jar), so it has no version and no golden vector.
 */
public record VolumeOutlines(String dimension, List<Entry> outlines) {
    /** One wand mode's boxes in its colour ({@code 0xRRGGBB}); {@code faint} and {@code grid} for the canvas (19). */
    public record Entry(int colour, List<Box> boxes, boolean faint, boolean grid) {
        public Entry(int colour, List<Box> boxes) {
            this(colour, boxes, false, false);
        }
    }

    public VolumeOutlines {
        outlines = List.copyOf(outlines);
    }

    /** Nothing to draw, in {@code dimension}. */
    public static VolumeOutlines none(String dimension) {
        return new VolumeOutlines(dimension, List.of());
    }

    /** {@code {"dimension": "…", "outlines": [{"colour": "#rrggbb", "boxes": [Box…]}…]}}. */
    public String toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("dimension", dimension);
        JsonArray a = new JsonArray();
        for (Entry e : outlines) {
            JsonObject x = new JsonObject();
            x.addProperty("colour", UiMessages.colour(e.colour()));
            x.add("boxes", Json.boxes(e.boxes()));
            if (e.faint()) x.addProperty("faint", true);
            if (e.grid()) x.addProperty("grid", true);
            a.add(x);
        }
        o.add("outlines", a);
        return Json.write(o);
    }

    /** Parses {@link #toJson()}'s form; anything else is {@code bad_request}. */
    public static VolumeOutlines parse(String json) throws ProtocolException {
        JsonElement e;
        try {
            e = Json.parse(json);
        } catch (RuntimeException ex) {
            throw ProtocolException.badRequest(null, "volume outlines aren't JSON: " + ex.getMessage());
        }
        if (!e.isJsonObject()) throw ProtocolException.badRequest(null, "volume outlines must be an object");
        JsonObject o = e.getAsJsonObject();
        List<Entry> out = new ArrayList<>();
        for (JsonElement x : Json.reqArray(o, "outlines", null)) {
            if (!x.isJsonObject()) throw ProtocolException.badRequest(null, "an outline entry must be an object");
            JsonObject xo = x.getAsJsonObject();
            out.add(new Entry(UiMessages.parseColour(Json.reqString(xo, "colour", null)), List.copyOf(Json.reqBoxes(xo, "boxes", null)), flag(xo, "faint"), flag(xo, "grid")));
        }
        return new VolumeOutlines(Json.reqString(o, "dimension", null), out);
    }

    private static boolean flag(JsonObject o, String key) throws ProtocolException {
        if (!o.has(key)) return false;
        JsonElement v = o.get(key);
        if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isBoolean()) throw ProtocolException.badRequest(null, "\"" + key + "\" must be a boolean");
        return v.getAsBoolean();
    }

    /** Whether nothing is drawn. */
    public boolean isEmpty() {
        return outlines.stream().allMatch(e -> e.boxes().isEmpty());
    }
}
