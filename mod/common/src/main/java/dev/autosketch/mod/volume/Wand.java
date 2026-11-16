package dev.autosketch.mod.volume;

import net.minecraft.core.component.DataComponents;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.CustomData;

/**
 * The wand (13, *Work and context volumes in-game*): a vanilla blaze rod marked with
 * {@code custom_data {autosketch_wand:1b}}, so it needs no registered item (M2) and doesn't clash with
 * WorldEdit's wooden axe or Axiom's tools. Any item carrying the marker works as the wand.
 */
public final class Wand {
    private Wand() {}

    public static final String MARKER = "autosketch_wand";

    public static ItemStack create() {
        ItemStack stack = new ItemStack(Items.BLAZE_ROD);
        CompoundTag tag = new CompoundTag();
        tag.putBoolean(MARKER, true);
        stack.set(DataComponents.CUSTOM_DATA, CustomData.of(tag));
        stack.set(DataComponents.CUSTOM_NAME, Component.literal("Autosketch wand"));
        stack.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true);
        return stack;
    }

    public static boolean isWand(ItemStack stack) {
        if (stack.isEmpty()) return false;
        CustomData data = stack.get(DataComponents.CUSTOM_DATA);
        return data != null && data.contains(MARKER);
    }
}
