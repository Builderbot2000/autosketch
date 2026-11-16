package dev.autosketch.mod.config;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The small TOML subset the mod's config file uses: {@code [section]} headers, {@code key = value}
 * lines with a string, boolean, integer or float value, and {@code #} comments. It reads both the
 * Cloth Config file the mod writes and the {@code ModConfigSpec} file older builds wrote (same
 * sections and keys), so migration is a plain read (14, *Config across loaders*). Lenient: a line it
 * can't read is skipped, so one bad value keeps its default instead of resetting the whole file.
 * Vanilla Java only, so it stays in the common module on every loader.
 */
public final class ConfigToml {
    private ConfigToml() {}

    /** Every readable {@code section.key} in the text, mapped to a String, Boolean, Long or Double. */
    public static Map<String, Object> parse(String text) {
        Map<String, Object> out = new LinkedHashMap<>();
        String section = "";
        for (String raw : text.split("\r?\n", -1)) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) continue;
            if (line.startsWith("[")) {
                int end = line.indexOf(']');
                if (end > 1 && !line.startsWith("[[")) section = unquoteKey(line.substring(1, end).strip());
                continue;
            }
            int eq = line.indexOf('=');
            if (eq <= 0) continue;
            String key = unquoteKey(line.substring(0, eq).strip());
            Object value = value(line.substring(eq + 1).strip());
            if (value != null && !key.isEmpty()) out.put(section.isEmpty() ? key : section + "." + key, value);
        }
        return out;
    }

    private static String unquoteKey(String k) {
        if (k.length() >= 2 && (k.startsWith("\"") && k.endsWith("\"") || k.startsWith("'") && k.endsWith("'"))) return k.substring(1, k.length() - 1);
        return k;
    }

    /** A value with any trailing comment, or null if it isn't one of the supported forms. */
    static Object value(String v) {
        if (v.startsWith("\"")) return basicString(v);
        if (v.startsWith("'")) {
            int end = v.indexOf('\'', 1);
            return end < 0 || !trailingOk(v.substring(end + 1)) ? null : v.substring(1, end);
        }
        int hash = v.indexOf('#');
        String t = (hash >= 0 ? v.substring(0, hash) : v).strip();
        if (t.equals("true")) return Boolean.TRUE;
        if (t.equals("false")) return Boolean.FALSE;
        String n = t.replace("_", "");
        try {
            if (n.matches("[+-]?\\d+")) return Long.parseLong(n);
            if (n.matches("[+-]?(\\d+\\.?\\d*([eE][+-]?\\d+)?|\\.\\d+([eE][+-]?\\d+)?)")) return Double.parseDouble(n);
        } catch (NumberFormatException e) {
            return null;
        }
        return null;
    }

    private static boolean trailingOk(String rest) {
        String r = rest.strip();
        return r.isEmpty() || r.startsWith("#");
    }

    private static String basicString(String v) {
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '"') return trailingOk(v.substring(i + 1)) ? sb.toString() : null;
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            if (++i >= v.length()) return null;
            char e = v.charAt(i);
            switch (e) {
                case 'n' -> sb.append('\n');
                case 't' -> sb.append('\t');
                case 'r' -> sb.append('\r');
                case 'b' -> sb.append('\b');
                case 'f' -> sb.append('\f');
                case '"' -> sb.append('"');
                case '\\' -> sb.append('\\');
                case 'u', 'U' -> {
                    int len = e == 'u' ? 4 : 8;
                    if (i + len >= v.length()) return null;
                    try {
                        sb.appendCodePoint(Integer.parseInt(v.substring(i + 1, i + 1 + len), 16));
                    } catch (IllegalArgumentException x) {
                        return null;
                    }
                    i += len;
                }
                default -> {
                    return null;
                }
            }
        }
        return null; // unterminated
    }

    /** A TOML basic string literal for {@code s}. */
    public static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\t' -> sb.append("\\t");
                case '\r' -> sb.append("\\r");
                default -> {
                    if (c < 0x20 || c == 0x7f) sb.append(String.format("\\u%04X", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.append('"').toString();
    }
}
