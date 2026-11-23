package dev.autosketch.mod;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.config.ConfigToml;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Function;
import me.shedaniel.autoconfig.AutoConfig;
import me.shedaniel.autoconfig.ConfigData;
import me.shedaniel.autoconfig.ConfigHolder;
import me.shedaniel.autoconfig.annotation.Config;
import me.shedaniel.autoconfig.annotation.ConfigEntry;
import me.shedaniel.autoconfig.serializer.ConfigSerializer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * The mod's settings, in {@code config/autosketch.toml} (not the pairing file, which the mod writes
 * itself: 13, *Pairing file*), through Cloth Config's AutoConfig so every loader reads the same file
 * and clients get a config screen (14, *Config across loaders*). Loaded when the mod is constructed,
 * so the bridge can read the port before a world loads, and read again on every server start and
 * whenever the file changes while a server runs (as NeoForge's config watcher did).
 *
 * <p>The file keeps the sections and keys of the {@code ModConfigSpec} file older builds wrote
 * ({@code config/autosketch-common.toml}). On the first start without {@code autosketch.toml} that
 * file is read once, every value kept, and renamed to {@code autosketch-common.toml.bak}.
 * Out-of-range numbers are clamped to the range and invalid values reset to the default, as
 * {@code ModConfigSpec} did.
 */
@Config(name = AutosketchConfig.NAME)
public final class AutosketchConfig implements ConfigData {
    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    public static final String NAME = "autosketch";
    /** The file this build reads and writes, in the game's config folder. */
    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    public static final String FILE = NAME + ".toml";
    /** The {@code ModConfigSpec} file of builds before Cloth Config, migrated once. */
    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    public static final String LEGACY_FILE = "autosketch-common.toml";

    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    private static final Logger LOG = LogUtils.getLogger();

    @ConfigEntry.Category("bridge")
    @ConfigEntry.Gui.TransitiveObject
    public Bridge bridge = new Bridge();

    @ConfigEntry.Category("patches")
    @ConfigEntry.Gui.TransitiveObject
    public Patches patches = new Patches();

    @ConfigEntry.Category("tracking")
    @ConfigEntry.Gui.TransitiveObject
    public Tracking tracking = new Tracking();

    @ConfigEntry.Category("volumes")
    @ConfigEntry.Gui.TransitiveObject
    public Volumes volumes = new Volumes();

    @ConfigEntry.Category("feedback")
    @ConfigEntry.Gui.TransitiveObject
    public Feedback feedback = new Feedback();

    @ConfigEntry.Category("prompts")
    @ConfigEntry.Gui.TransitiveObject
    public Prompts prompts = new Prompts();

    @ConfigEntry.Category("scan")
    @ConfigEntry.Gui.TransitiveObject
    public Scan scan = new Scan();

    @ConfigEntry.Category("discovery")
    @ConfigEntry.Gui.TransitiveObject
    public Discovery discovery = new Discovery();

    @ConfigEntry.Category("select")
    @ConfigEntry.Gui.TransitiveObject
    public Select select = new Select();

    public static final class Bridge {
        @ConfigEntry.Gui.Tooltip(count = 2)
        public int port = 0;
    }

    public static final class Patches {
        @ConfigEntry.Gui.Tooltip
        public int tickBudget = 20_000;
    }

    public static final class Tracking {
        @ConfigEntry.Gui.Tooltip(count = 2)
        public int dirtyCap = 4096;
        // Silo O (change tracker, M9).
        @ConfigEntry.Gui.Tooltip(count = 3)
        public String tracker = "both";
        @ConfigEntry.Gui.Tooltip
        public int scanPeriod = 20;
    }

    public static final class Volumes {
        @ConfigEntry.Gui.Tooltip
        public long contextCap = 4_194_304L;
        // Silo Y (B1): the wand is any stack of this item.
        @ConfigEntry.Gui.Tooltip(count = 2)
        public String wandItem = DEFAULT_WAND;
    }

    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    public static final String DEFAULT_WAND = "minecraft:blaze_rod";

    /** An item id with its namespace ({@code blaze_rod} → {@code minecraft:blaze_rod}), or null when it isn't a valid id. */
    public static @Nullable String itemId(@Nullable String s) {
        if (s == null) return null;
        net.minecraft.resources.ResourceLocation id = net.minecraft.resources.ResourceLocation.tryParse(s.trim());
        return id == null ? null : id.toString();
    }

    public static final class Feedback {
        @ConfigEntry.Gui.Tooltip
        public boolean noticesDefault = true;
    }

    public static final class Prompts {
        @ConfigEntry.Gui.Tooltip
        public String askAlias = "";
        @ConfigEntry.Gui.Tooltip
        public double targetReach = 64.0;
    }

    public static final class Discovery {
        @ConfigEntry.Gui.Tooltip(count = 2)
        public boolean pointer = true;
    }

    /** {@code /autosketch scan} (13, B4): the grant a scan request gives the MCP to read. */
    public static final class Scan {
        @ConfigEntry.Gui.Tooltip
        public int scanChunks = 4;
        @ConfigEntry.Gui.Tooltip
        public int scanChunksMax = 12;
        @ConfigEntry.Gui.Tooltip
        public int scanBelow = 32;
        @ConfigEntry.Gui.Tooltip
        public int scanAbove = 64;
        @ConfigEntry.Gui.Tooltip
        public long scanCap = 4_194_304L;
    }

    /**
     * {@code /autosketch select} (18): the read grant's radius, which also caps a search's, and the
     * search's defaults. Interim values until 18's *Measure first*.
     */
    public static final class Select {
        @ConfigEntry.Gui.Tooltip(count = 2)
        public int selectChunks = 256;
        @ConfigEntry.Gui.Tooltip
        public int searchGap = 2;
        @ConfigEntry.Gui.Tooltip
        public int searchStop = 1;
    }

    // ── keys: file layout, comments, ranges ───────────────────────────────────────────────────

    /** One setting: where it lives in the file, its comment, and how a read value is checked. */
    record Key(String section, String key, List<String> comment, @Nullable String range,
               Function<AutosketchConfig, Object> get, BiConsumer<AutosketchConfig, Object> set) {
        String path() {
            return section + "." + key;
        }
    }

    private static Key intKey(String section, String key, int min, int max, Function<AutosketchConfig, Integer> get,
                              BiConsumer<AutosketchConfig, Integer> set, String... comment) {
        return new Key(section, key, List.of(comment), min + " ~ " + max, get::apply, (c, v) -> {
            if (v instanceof Long l) set.accept(c, (int) Math.max(min, Math.min(max, l)));
            else if (v instanceof Double d && d == Math.rint(d)) set.accept(c, (int) Math.max(min, Math.min(max, d)));
        });
    }

    /** The settings in file order, with the comments and ranges the {@code ModConfigSpec} file had. */
    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    static final List<Key> KEYS = List.of(
            intKey("bridge", "port", 0, 65535, c -> c.bridge.port, (c, v) -> c.bridge.port = v,
                    "TCP port for the MCP connection on 127.0.0.1. 0 picks a free port on every start (written to config/autosketch-bridge.toml)."),
            intKey("patches", "tickBudget", 1, 10_000_000, c -> c.patches.tickBudget, (c, v) -> c.patches.tickBudget = v,
                    "Most blocks a patch writes per server tick; larger patches continue on the next ticks (M7)."),
            intKey("tracking", "dirtyCap", 1, 4096, c -> c.tracking.dirtyCap, (c, v) -> c.tracking.dirtyCap = v,
                    "Most changed positions one dirty notice lists; beyond it the notice says \"everything\" and the MCP compares section hashes.",
                    "The protocol caps it at 4096."),
            new Key("tracking", "tracker", List.of(
                    "How block changes are detected: \"hook\" (a mixin on chunk block writes, immediate), \"scan\" (periodic comparison of the volumes' sections, which also sees writers that bypass the hook, such as Axiom,",
                    "for when the mixin conflicts with another mod; the mixin is then not applied at all, read at game start) or \"both\" (the default: measured on Craftoria, see 13)."),
                    null, c -> c.tracking.tracker, (c, v) -> {
                        if (v instanceof String s && validTracker(s)) c.tracking.tracker = s;
                    }),
            intKey("tracking", "scanPeriod", 1, 1200, c -> c.tracking.scanPeriod, (c, v) -> c.tracking.scanPeriod = v,
                    "Ticks for the scan tracker to compare every section of the volumes once."),
            new Key("volumes", "contextCap", List.of("Most blocks the context boxes may cover in total, so snapshots stay practical."),
                    "1 ~ " + (1L << 40), c -> c.volumes.contextCap, (c, v) -> {
                        if (v instanceof Long l) c.volumes.contextCap = Math.max(1L, Math.min(1L << 40, l));
                    }),
            new Key("volumes", "wandItem", List.of(
                    "The wand: any stack of this item, held in the main hand by an op, sets corners (left click corner 1, right click corner 2) and never uses the item or the block.",
                    "An item id, e.g. \"minecraft:blaze_rod\" (the default)."),
                    null, c -> c.volumes.wandItem, (c, v) -> {
                        if (v instanceof String s && itemId(s) != null) c.volumes.wandItem = itemId(s);
                    }),
            new Key("feedback", "noticesDefault", List.of("Whether action-bar notices are on for a player who hasn't set /autosketch notices."),
                    null, c -> c.feedback.noticesDefault, (c, v) -> {
                        if (v instanceof Boolean b) c.feedback.noticesDefault = b;
                    }),
            new Key("prompts", "askAlias", List.of("A short top-level root for the request commands (e.g. \"as\" gives /as build <text>, /as ask <text>), or empty for none."),
                    null, c -> c.prompts.askAlias, (c, v) -> {
                        if (v instanceof String s) c.prompts.askAlias = s;
                    }),
            new Key("prompts", "targetReach", List.of("How far (blocks) the crosshair block is looked for when a request attaches game context."),
                    "1.0 ~ 512.0", c -> c.prompts.targetReach, (c, v) -> {
                        if (v instanceof Double d && !d.isNaN()) c.prompts.targetReach = Math.max(1.0, Math.min(512.0, d));
                        else if (v instanceof Long l) c.prompts.targetReach = Math.max(1.0, Math.min(512.0, l));
                    }),
            new Key("discovery", "pointer", List.of(
                    "Whether the server writes a pointer file, <user.home>/.autosketch/games/<hash>.toml, naming this game folder and its pairing file,",
                    "so a local Autosketch MCP can find this game (14, *Instance discovery*). Off: no file is written and this game's old one is removed."),
                    null, c -> c.discovery.pointer, (c, v) -> {
                        if (v instanceof Boolean b) c.discovery.pointer = b;
                    }),
            intKey("scan", "scanChunks", 0, 32, c -> c.scan.scanChunks, (c, v) -> c.scan.scanChunks = v,
                    "Default radius of /autosketch scan, in chunks around the player's chunk (4: 9x9 chunks, 144 blocks across)."),
            intKey("scan", "scanChunksMax", 0, 32, c -> c.scan.scanChunksMax, (c, v) -> c.scan.scanChunksMax = v,
                    "Largest scan radius in chunks; a larger request is clipped with a warning (12: 25x25 chunks, 400 blocks across)."),
            intKey("scan", "scanBelow", 0, 4096, c -> c.scan.scanBelow, (c, v) -> c.scan.scanBelow = v,
                    "How far below the player's feet the full-block part of a scan reaches."),
            intKey("scan", "scanAbove", 0, 4096, c -> c.scan.scanAbove, (c, v) -> c.scan.scanAbove = v,
                    "How far above the player's feet the full-block part of a scan reaches."),
            new Key("scan", "scanCap", List.of("Most blocks the full-block part of a scan may cover; its width shrinks to fit (default: the context cap)."),
                    "1 ~ " + (1L << 40), c -> c.scan.scanCap, (c, v) -> {
                        if (v instanceof Long l) c.scan.scanCap = Math.max(1L, Math.min(1L << 40, l));
                    }),
            intKey("select", "selectChunks", 0, 256, c -> c.select.selectChunks, (c, v) -> c.select.selectChunks = v,
                    "How far a select request lets the agent read, in chunks around the player's chunk when the request is sent (256: 513x513 chunks),",
                    "and the largest search radius; a larger search is clipped. Interim default (18, *Measure first*)."),
            intKey("select", "searchGap", 1, 64, c -> c.select.searchGap, (c, v) -> c.select.searchGap = v,
                    "Rings of chunks a search walks past a cluster of matches with no new match touching it before the cluster counts as closed."),
            intKey("select", "searchStop", 1, 1024, c -> c.select.searchStop, (c, v) -> c.select.searchStop = v,
                    "Closed clusters after which a search stops (it can be continued for more)."));


    static boolean validTracker(String s) {
        return s.equals("hook") || s.equals("scan") || s.equals("both");
    }

    /** Clamps and resets the way reading a file does, for values set through the config screen. */
    @Override
    public void validatePostLoad() {
        AutosketchConfig defaults = new AutosketchConfig();
        for (Key k : KEYS) {
            Object v = k.get().apply(this);
            k.set().accept(this, v instanceof Integer i ? (Object) (long) i : v); // clamps numbers
        }
        if (tracking.tracker == null || !validTracker(tracking.tracker)) tracking.tracker = defaults.tracking.tracker;
        if (prompts.askAlias == null) prompts.askAlias = defaults.prompts.askAlias;
        volumes.wandItem = itemId(volumes.wandItem) == null ? defaults.volumes.wandItem : itemId(volumes.wandItem);
    }

    /** A config with the values {@code text} sets; keys it lacks or can't read keep their defaults. */
    static AutosketchConfig read(String text) {
        AutosketchConfig c = new AutosketchConfig();
        Map<String, Object> values = ConfigToml.parse(text);
        for (Key k : KEYS) {
            Object v = values.get(k.path());
            if (v != null) k.set().accept(c, v);
        }
        return c;
    }

    /** The file's text: every key with its comment, default and range, in the old file's layout. */
    static String write(AutosketchConfig c) {
        AutosketchConfig defaults = new AutosketchConfig();
        StringBuilder sb = new StringBuilder();
        sb.append("# Autosketch companion mod (docs/design/13-live-world.md). Read at game start, on every server start, and when this file changes.\n\n");
        String section = null;
        for (Key k : KEYS) {
            if (!k.section().equals(section)) {
                if (section != null) sb.append('\n');
                section = k.section();
                sb.append('[').append(section).append("]\n");
            }
            for (String line : k.comment()) sb.append("\t# ").append(line).append('\n');
            Object def = k.get().apply(defaults);
            if (k.range() != null) sb.append("\t# Default: ").append(literal(def)).append('\n').append("\t# Range: ").append(k.range()).append('\n');
            sb.append('\t').append(k.key()).append(" = ").append(literal(k.get().apply(c))).append('\n');
        }
        return sb.toString();
    }

    private static String literal(Object v) {
        return v instanceof String s ? ConfigToml.quote(s) : String.valueOf(v);
    }

    // ── registration ──────────────────────────────────────────────────────────────────────────

    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    private static volatile @Nullable ConfigHolder<AutosketchConfig> holder;
    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    private static final AutosketchConfig DEFAULTS = new AutosketchConfig();

    /**
     * Registers with AutoConfig, reading {@code configDir/autosketch.toml} (migrating the legacy file
     * first if this is the first start), and writes the file back with any missing keys filled in.
     * Called once by the loader's entry point.
     */
    public static void register(Path configDir) {
        if (holder != null) return;
        holder = AutoConfig.register(AutosketchConfig.class, (definition, type) -> new Serializer(configDir));
        file = configDir.resolve(FILE);
        lastModified = modified(file);
    }

    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    private static volatile @Nullable Path file;
    @ConfigEntry.Gui.Excluded // not a setting: AutoConfig's screen would try to show it
    private static volatile @Nullable FileTime lastModified;

    private static @Nullable FileTime modified(@Nullable Path f) {
        try {
            return f == null ? null : Files.getLastModifiedTime(f);
        } catch (IOException e) {
            return null;
        }
    }

    /** Reads the file again (on server start), so edits made while the game ran take effect. */
    public static void reload() {
        ConfigHolder<AutosketchConfig> h = holder;
        if (h == null) return;
        lastModified = modified(file);
        h.load();
    }

    /**
     * Reads the file again if it changed since it was last read or written, as NeoForge's config
     * watcher did for the {@code ModConfigSpec} file. Called about once a second from the server tick.
     */
    public static void reloadIfChanged() {
        FileTime now = modified(file);
        if (holder == null || now == null || now.equals(lastModified)) return;
        reload();
    }

    /** The current settings; the defaults before {@link #register}. */
    public static AutosketchConfig get() {
        ConfigHolder<AutosketchConfig> h = holder;
        return h == null ? DEFAULTS : h.getConfig();
    }

    /**
     * Migrates {@code autosketch-common.toml} into a config, keeping every key and value, and renames
     * it to {@code autosketch-common.toml.bak}. Null if there is nothing to migrate.
     */
    static @Nullable AutosketchConfig migrate(Path configDir) throws IOException {
        Path legacy = configDir.resolve(LEGACY_FILE);
        if (!Files.isRegularFile(legacy)) return null;
        AutosketchConfig c = read(Files.readString(legacy, StandardCharsets.UTF_8));
        Files.move(legacy, configDir.resolve(LEGACY_FILE + ".bak"), StandardCopyOption.REPLACE_EXISTING);
        LOG.info("Autosketch: migrated config/{} to config/{} (the old file is kept as {}.bak)", LEGACY_FILE, FILE, LEGACY_FILE);
        return c;
    }

    /** AutoConfig's reader and writer for the commented TOML file. */
    static final class Serializer implements ConfigSerializer<AutosketchConfig> {
        private final Path dir;

        Serializer(Path dir) {
            this.dir = dir;
        }

        @Override
        public void serialize(AutosketchConfig config) throws SerializationException {
            try {
                Files.createDirectories(dir);
                Path tmp = dir.resolve(FILE + ".tmp");
                Files.writeString(tmp, write(config), StandardCharsets.UTF_8);
                Files.move(tmp, dir.resolve(FILE), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException e) {
                throw new SerializationException(e);
            }
        }

        @Override
        public AutosketchConfig deserialize() throws SerializationException {
            try {
                Path file = dir.resolve(FILE);
                if (Files.isRegularFile(file)) return read(Files.readString(file, StandardCharsets.UTF_8));
                AutosketchConfig migrated = migrate(dir);
                return migrated != null ? migrated : createDefault();
            } catch (IOException e) {
                throw new SerializationException(e);
            }
        }

        @Override
        public AutosketchConfig createDefault() {
            return new AutosketchConfig();
        }
    }
}
