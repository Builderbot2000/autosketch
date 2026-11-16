package dev.autosketch.mod.data;

import com.mojang.datafixers.DSL;
import com.mojang.datafixers.DataFixer;
import com.mojang.serialization.Dynamic;
import dev.autosketch.mod.protocol.BodyTypes.UpgradeData;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.nbt.Tag;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.util.datafix.fixes.References;
import org.jetbrains.annotations.Nullable;

/**
 * Upgrades through the game's own data fixer (14, *Schematics from other versions: the established
 * practice*), the code that upgrades old worlds, from a schematic's DataVersion to the running one.
 * Forward only: data at or above the running version comes back unchanged. The fix types follow the
 * tools that read each format: a whole structure file with {@code STRUCTURE}, as the game does for
 * {@code .nbt}; otherwise per element, as WorldEdit does for {@code .schem}: block states as
 * {@code block_state} ({@code {Name, Properties}}), block entities as {@code block_entity}, entities
 * as {@code entity}. An element the fixer throws on comes back unchanged and is counted.
 *
 * <p>Uses the 1.21.1 data fixer API; when a version changes it, its version-conditional code goes here.
 */
public final class Upgrades {
    private Upgrades() {}

    /** The upgraded data and how many elements failed. */
    public record Result(int to, int failed, UpgradeData data) {}

    public static int currentVersion() {
        return SharedConstants.getCurrentVersion().getDataVersion().getVersion();
    }

    public static Result upgrade(int from, UpgradeData in) {
        int to = currentVersion();
        if (from >= to) return new Result(to, 0, in);
        DataFixer fixer = DataFixers.getDataFixer();
        int[] failed = {0};
        if (in.structure() != null) {
            CompoundTag s = in.structure();
            try {
                s = DataFixTypes.STRUCTURE.update(fixer, s.copy(), from, to);
                s.putInt("DataVersion", to);
            } catch (RuntimeException e) {
                failed[0]++;
            }
            return new Result(to, failed[0], UpgradeData.structure(s));
        }
        List<String> states = new ArrayList<>(in.states().size());
        for (String st : in.states()) {
            CompoundTag tag = stateTag(st);
            String out = st;
            if (tag == null) failed[0]++;
            else {
                CompoundTag fixed = fix(fixer, References.BLOCK_STATE, tag, from, to, failed);
                if (fixed != tag) out = stateString(fixed, st);
            }
            states.add(out);
        }
        List<CompoundTag> bes = new ArrayList<>(in.blockEntities().size());
        for (CompoundTag c : in.blockEntities()) bes.add(fix(fixer, References.BLOCK_ENTITY, c, from, to, failed));
        List<CompoundTag> ents = new ArrayList<>(in.entities().size());
        for (CompoundTag c : in.entities()) ents.add(fix(fixer, References.ENTITY, c, from, to, failed));
        return new Result(to, failed[0], UpgradeData.elements(states, bes, ents));
    }

    private static CompoundTag fix(DataFixer fixer, DSL.TypeReference type, CompoundTag tag, int from, int to, int[] failed) {
        try {
            Tag out = fixer.update(type, new Dynamic<>(NbtOps.INSTANCE, (Tag) tag.copy()), from, to).getValue();
            if (out instanceof CompoundTag c) return c;
        } catch (RuntimeException e) {
            // fall through: returned unchanged
        }
        failed[0]++;
        return tag;
    }

    /** {@code ns:id[k=v,…]} as {@code {Name, Properties}}; null when it doesn't parse. */
    static @Nullable CompoundTag stateTag(String state) {
        int b = state.indexOf('[');
        String name = b < 0 ? state : state.substring(0, b);
        if (name.isEmpty()) return null;
        CompoundTag tag = new CompoundTag();
        tag.putString("Name", name);
        if (b < 0) return tag;
        if (!state.endsWith("]")) return null;
        String inner = state.substring(b + 1, state.length() - 1);
        CompoundTag props = new CompoundTag();
        if (!inner.isEmpty())
            for (String kv : inner.split(",")) {
                int eq = kv.indexOf('=');
                if (eq <= 0) return null;
                props.putString(kv.substring(0, eq).trim(), kv.substring(eq + 1).trim());
            }
        if (!props.isEmpty()) tag.put("Properties", props);
        return tag;
    }

    /** {@code {Name, Properties}} as {@code ns:id[k=v,…]}, properties sorted; the original when it has no name. */
    static String stateString(CompoundTag tag, String original) {
        if (!tag.contains("Name", Tag.TAG_STRING)) return original;
        StringBuilder sb = new StringBuilder(tag.getString("Name"));
        CompoundTag props = tag.getCompound("Properties");
        if (!props.isEmpty()) {
            TreeMap<String, String> sorted = new TreeMap<>();
            for (String k : props.getAllKeys()) sorted.put(k, props.getString(k));
            sb.append('[');
            boolean first = true;
            for (var e : sorted.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
            sb.append(']');
        }
        return sb.toString();
    }
}
