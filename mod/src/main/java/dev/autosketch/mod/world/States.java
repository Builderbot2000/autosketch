package dev.autosketch.mod.world;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.StateDefinition;
import net.minecraft.world.level.block.state.properties.Property;
import org.jetbrains.annotations.Nullable;

/**
 * Canonical block-state strings (13, *Wire format*, *Block states*): {@code namespace:path[k=v,...]}
 * with every property present, sorted by name, no whitespace; cave and void air print as
 * {@code minecraft:air}. The mod prints world states this way, compares expected states by string,
 * and accepts a new state only if it is exactly the canonical printing of a known state. Both
 * directions are cached (states are finite; only strings that parse are cached). Thread-safe.
 */
public final class States {
    private States() {}

    public static final String AIR = "minecraft:air";

    private static final Map<BlockState, String> PRINTED = new ConcurrentHashMap<>();
    private static final Map<String, BlockState> PARSED = new ConcurrentHashMap<>();

    /** The canonical printing of a state. */
    public static String print(BlockState state) {
        String s = PRINTED.get(state);
        if (s == null) {
            s = printUncached(state);
            PRINTED.put(state, s);
        }
        return s;
    }

    private static String printUncached(BlockState state) {
        Block block = state.getBlock();
        if (block == Blocks.CAVE_AIR || block == Blocks.VOID_AIR) return AIR;
        StringBuilder sb = new StringBuilder(BuiltInRegistries.BLOCK.getKey(block).toString());
        List<Property<?>> props = new ArrayList<>(state.getProperties());
        if (props.isEmpty()) return sb.toString();
        props.sort((a, b) -> a.getName().compareTo(b.getName()));
        sb.append('[');
        for (int i = 0; i < props.size(); i++) {
            if (i > 0) sb.append(',');
            Property<?> p = props.get(i);
            sb.append(p.getName()).append('=').append(valueName(state, p));
        }
        return sb.append(']').toString();
    }

    private static <T extends Comparable<T>> String valueName(BlockState state, Property<T> p) {
        return p.getName(state.getValue(p));
    }

    /**
     * The state a canonical string names, or null when the string isn't exactly the canonical
     * printing of a state the game knows (unknown block, property or value, a missing property,
     * wrong order, whitespace, a non-canonical air): the position is then rejected
     * {@code unknown_state}, never written as air.
     */
    public static @Nullable BlockState parse(String s) {
        BlockState cached = PARSED.get(s);
        if (cached != null) return cached;
        BlockState st = parseUncached(s);
        if (st == null || !print(st).equals(s)) return null;
        PARSED.put(s, st);
        return st;
    }

    private static @Nullable BlockState parseUncached(String s) {
        int br = s.indexOf('[');
        String name = br < 0 ? s : s.substring(0, br);
        if (name.indexOf(':') < 0) return null;
        ResourceLocation id = ResourceLocation.tryParse(name);
        if (id == null) return null;
        Optional<Block> block = BuiltInRegistries.BLOCK.getOptional(id);
        if (block.isEmpty()) return null;
        BlockState state = block.get().defaultBlockState();
        if (br < 0) return state;
        if (!s.endsWith("]") || s.length() < br + 3) return null;
        StateDefinition<Block, BlockState> def = block.get().getStateDefinition();
        for (String kv : s.substring(br + 1, s.length() - 1).split(",", -1)) {
            int eq = kv.indexOf('=');
            if (eq <= 0) return null;
            Property<?> p = def.getProperty(kv.substring(0, eq));
            if (p == null) return null;
            state = with(state, p, kv.substring(eq + 1));
            if (state == null) return null;
        }
        return state;
    }

    private static <T extends Comparable<T>> @Nullable BlockState with(BlockState state, Property<T> p, String value) {
        Optional<T> v = p.getValue(value);
        return v.map(t -> state.setValue(p, t)).orElse(null);
    }
}
