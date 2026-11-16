package dev.autosketch.mod.volume;

import dev.autosketch.mod.AutosketchConfig;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

/**
 * The wand (13, B1): as WorldEdit's wand is any wooden axe, ours is any stack of the configured item
 * ({@code wandItem}, default {@code minecraft:blaze_rod}), with no marker and no command to hand it
 * out. It needs no registered item (M2); who may use it and with which hand is {@link WandControl}'s.
 */
public final class Wand {
    private Wand() {}

    /** The configured wand item's id, with its namespace. */
    public static String itemId() {
        String id = AutosketchConfig.itemId(AutosketchConfig.get().volumes.wandItem);
        return id == null ? AutosketchConfig.DEFAULT_WAND : id;
    }

    /** A plain stack of the wand item (the default blaze rod when the configured id names no item). */
    public static ItemStack create() {
        ResourceLocation id = ResourceLocation.tryParse(itemId());
        var item = id == null ? Items.BLAZE_ROD : BuiltInRegistries.ITEM.getOptional(id).orElse(Items.BLAZE_ROD);
        return new ItemStack(item);
    }

    /** Whether the stack is the wand item: any stack of it, whatever its components. */
    public static boolean isWand(ItemStack stack) {
        if (stack.isEmpty()) return false;
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId());
    }
}
