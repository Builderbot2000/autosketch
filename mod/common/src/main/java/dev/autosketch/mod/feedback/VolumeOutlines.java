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
 * its colour and the boxes {@code WandMode.outline} gives. An empty {@code outlines} hides them.
 * Mod-internal (both halves ship in one jar), so it has no version and no golden vector.
 */
public record VolumeOutlines(String dimension, List<Entry> outlines) {
    /** One wand mode's boxes in its colour ({@code 0xRRGGBB}). */
    public record Entry(int colour, List<Box> boxes) {}

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
            out.add(new Entry(UiMessages.parseColour(Json.reqString(xo, "colour", null)), List.copyOf(Json.reqBoxes(xo, "boxes", null))));
        }
        return new VolumeOutlines(Json.reqString(o, "dimension", null), out);
    }

    /** Whether nothing is drawn. */
    public boolean isEmpty() {
        return outlines.stream().allMatch(e -> e.boxes().isEmpty());
    }
}
