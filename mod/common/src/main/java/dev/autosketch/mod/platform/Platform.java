package dev.autosketch.mod.platform;

import java.nio.file.Path;
import java.util.Objects;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jetbrains.annotations.Nullable;

/**
 * What the common code needs from the mod loader (14, *Build layout*): the running server, the
 * config folder, the loader's name and version for the {@code hello} message, and a place in the
 * player's saved data. Each loader
 * module installs one implementation from its entry point before anything else runs.
 */
public interface Platform {
    /** The running server (dedicated or integrated), or null when none is running. */
    @Nullable MinecraftServer currentServer();

    /** The game's config folder. */
    Path configDir();

    /** The loader's id as sent in {@code hello} (13, *Wire format*), e.g. {@code neoforge}. */
    String loader();

    /** The loader's version. */
    String loaderVersion();

    /**
     * Mod data saved with the player (and kept across death), which vanilla has no place for. On
     * NeoForge, the entity's persistent data.
     */
    CompoundTag playerData(ServerPlayer player);

    /**
     * Whether the player's client runs the mod's optional client half (13, B2), so it draws its own
     * air-mode preview. False on a loader without one.
     */
    default boolean hasClientHalf(ServerPlayer player) {
        return false;
    }

    /** Sends the air-mode state to the player's client half, when it has one; nothing otherwise. */
    default void sendAirState(ServerPlayer player, boolean on, int reach, String wandItem) {}

    /** The installed platform. */
    static Platform get() {
        Platform p = Holder.platform;
        if (p == null) throw new IllegalStateException("no Autosketch platform installed");
        return p;
    }

    /** Installs the loader's implementation (once, from the entry point). */
    static void install(Platform platform) {
        Holder.platform = Objects.requireNonNull(platform);
    }

    final class Holder {
        private Holder() {}

        private static volatile @Nullable Platform platform;
    }
}
