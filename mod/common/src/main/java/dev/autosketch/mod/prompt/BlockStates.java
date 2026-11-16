package dev.autosketch.mod.prompt;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;

/**
 * Prints a block state in the wire's canonical form (13, *Wire format*, *Block states*): namespaced
 * id, every property sorted by name, cave and void air as {@code minecraft:air}. For the crosshair
 * block in a {@code prompt}'s context. (Silo O's world I/O prints states the same way.)
 */
public final class BlockStates {
    private BlockStates() {}

    public static String canonical(BlockState state) {
        if (state.is(Blocks.CAVE_AIR) || state.is(Blocks.VOID_AIR)) return "minecraft:air";
        String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        List<Property<?>> props = new ArrayList<>(state.getProperties());
        if (props.isEmpty()) return id;
        props.sort(Comparator.comparing(Property::getName));
        StringBuilder sb = new StringBuilder(id).append('[');
        for (int i = 0; i < props.size(); i++) {
            if (i > 0) sb.append(',');
            Property<?> p = props.get(i);
            sb.append(p.getName()).append('=').append(value(state, p));
        }
        return sb.append(']').toString();
    }

    private static <T extends Comparable<T>> String value(BlockState state, Property<T> p) {
        return p.getName(state.getValue(p));
    }
}
