package dev.autosketch.mod;

import net.neoforged.neoforge.common.ModConfigSpec;

/**
 * The mod's settings, in {@code config/autosketch-common.toml} (not the pairing file, which the mod
 * writes itself: 13, *Pairing file*). Common config so the bridge can read the port before a world
 * loads, in singleplayer and on a dedicated server alike.
 */
public final class AutosketchConfig {
    private AutosketchConfig() {}

    private static final ModConfigSpec.Builder B = new ModConfigSpec.Builder();

    static {
        B.push("bridge");
    }

    public static final ModConfigSpec.IntValue PORT = B
            .comment("TCP port for the MCP connection on 127.0.0.1. 0 picks a free port on every start (written to config/autosketch-bridge.toml).")
            .defineInRange("port", 0, 0, 65535);

    static {
        B.pop().push("patches");
    }

    public static final ModConfigSpec.IntValue TICK_BUDGET = B
            .comment("Most blocks a patch writes per server tick; larger patches continue on the next ticks (M7).")
            .defineInRange("tickBudget", 10_000, 1, 10_000_000);

    static {
        B.pop().push("tracking");
    }

    public static final ModConfigSpec.IntValue DIRTY_CAP = B
            .comment("Most changed positions one dirty notice lists; beyond it the notice says \"everything\" and the MCP compares section hashes.",
                    "The protocol caps it at 4096.")
            .defineInRange("dirtyCap", 4096, 1, 4096);

    static {
        B.pop().push("volumes");
    }

    public static final ModConfigSpec.LongValue CONTEXT_CAP = B
            .comment("Most blocks the context boxes may cover in total, so snapshots stay practical.")
            .defineInRange("contextCap", 4_194_304L, 1L, 1L << 40);

    static {
        B.pop().push("feedback");
    }

    public static final ModConfigSpec.BooleanValue NOTICES_DEFAULT = B
            .comment("Whether action-bar notices are on for a player who hasn't set /autosketch notices.")
            .define("noticesDefault", true);

    static {
        B.pop().push("prompts");
    }

    public static final ModConfigSpec.ConfigValue<String> ASK_ALIAS = B
            .comment("A short top-level alias for /autosketch ask (e.g. \"as\"), or empty for none.")
            .define("askAlias", "");

    public static final ModConfigSpec.DoubleValue TARGET_REACH = B
            .comment("How far (blocks) the crosshair block is looked for when a request attaches game context.")
            .defineInRange("targetReach", 64.0, 1.0, 512.0);

    static {
        B.pop();
    }

    public static final ModConfigSpec SPEC = B.build();
}
