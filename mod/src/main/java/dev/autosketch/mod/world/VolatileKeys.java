package dev.autosketch.mod.world;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jetbrains.annotations.Nullable;

/**
 * The volatile-key list from the MCP's {@code hello} (13, *Wire format*, *Hashing*), parsed once:
 * per block-entity type (or {@code *}) either key paths to drop before hashing, or "state only".
 * The mod keeps no list of its own. Malformed entries (neither a list of strings nor
 * {@code "state_only"}) are ignored rather than guessed at. Immutable.
 */
public final class VolatileKeys {
    public static final VolatileKeys EMPTY = new VolatileKeys(Map.of(), Map.of(), false);

    private final Map<String, List<String[]>> paths;
    private final Map<String, Boolean> stateOnly;
    private final boolean allStateOnly;

    private VolatileKeys(Map<String, List<String[]>> paths, Map<String, Boolean> stateOnly, boolean allStateOnly) {
        this.paths = paths;
        this.stateOnly = stateOnly;
        this.allStateOnly = allStateOnly;
    }

    public static VolatileKeys parse(@Nullable JsonObject json) {
        if (json == null || json.isEmpty()) return EMPTY;
        Map<String, List<String[]>> paths = new HashMap<>();
        Map<String, Boolean> stateOnly = new HashMap<>();
        for (Map.Entry<String, JsonElement> e : json.entrySet()) {
            JsonElement v = e.getValue();
            if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isString() && v.getAsString().equals("state_only")) {
                stateOnly.put(e.getKey(), true);
            } else if (v.isJsonArray()) {
                List<String[]> list = new ArrayList<>();
                for (JsonElement p : (JsonArray) v)
                    if (p.isJsonPrimitive() && p.getAsJsonPrimitive().isString()) list.add(p.getAsString().split("/", -1));
                paths.put(e.getKey(), List.copyOf(list));
            }
        }
        return new VolatileKeys(Map.copyOf(paths), Map.copyOf(stateOnly), stateOnly.containsKey("*"));
    }

    /** Whether NBT of this block-entity type (null when the compound has no string {@code id}) is never compared. */
    public boolean stateOnly(@Nullable String type) {
        return allStateOnly || (type != null && stateOnly.containsKey(type));
    }

    /** The key paths of {@code *} and of the type, each split at {@code /}. */
    public List<String[]> pathsFor(@Nullable String type) {
        List<String[]> all = paths.getOrDefault("*", List.of());
        List<String[]> own = type == null ? List.of() : paths.getOrDefault(type, List.of());
        if (own.isEmpty()) return all;
        if (all.isEmpty()) return own;
        List<String[]> both = new ArrayList<>(all);
        both.addAll(own);
        return both;
    }
}
