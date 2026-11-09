package dev.autosketch.mod.world.mixin;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.objectweb.asm.tree.ClassNode;
import org.spongepowered.asm.mixin.extensibility.IMixinConfigPlugin;
import org.spongepowered.asm.mixin.extensibility.IMixinInfo;

/**
 * Leaves the tracker's mixin out entirely when {@code config/autosketch-common.toml} sets
 * {@code tracker = "scan"}, so a conflict with another mod's mixin (13, *Open questions*, change
 * tracking) can be avoided by config. Mixins apply before NeoForge loads configs, so this reads the
 * file as text; a missing or unreadable file keeps the default (the mixin applies).
 */
public final class TrackerMixinPlugin implements IMixinConfigPlugin {
    private static final Pattern TRACKER = Pattern.compile("(?m)^\\s*tracker\\s*=\\s*\"(\\w+)\"");
    private boolean apply = true;

    @Override
    public void onLoad(String mixinPackage) {
        try {
            Path file = Path.of("config", "autosketch-common.toml");
            if (Files.isReadable(file)) {
                Matcher m = TRACKER.matcher(Files.readString(file, StandardCharsets.UTF_8));
                if (m.find() && m.group(1).equals("scan")) apply = false;
            }
        } catch (IOException | RuntimeException ignored) {
            // keep the default
        }
    }

    @Override
    public String getRefMapperConfig() {
        return null;
    }

    @Override
    public boolean shouldApplyMixin(String targetClassName, String mixinClassName) {
        return apply;
    }

    @Override
    public void acceptTargets(Set<String> myTargets, Set<String> otherTargets) {}

    @Override
    public List<String> getMixins() {
        return null;
    }

    @Override
    public void preApply(String targetClassName, ClassNode targetClass, String mixinClassName, IMixinInfo mixinInfo) {}

    @Override
    public void postApply(String targetClassName, ClassNode targetClass, String mixinClassName, IMixinInfo mixinInfo) {}
}
