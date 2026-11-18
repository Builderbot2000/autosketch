package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonObject;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The knowledge pack editor, kits included (17, piece 6; {@code 13}'s
 * {@code library.write.knowledge}): the frontmatter (the lines between the opening and closing
 * {@code ---}) and the Markdown text, each in its own box, joined back into the whole file on save.
 * A pack without frontmatter starts with an empty box, and an empty box writes none. The lines are
 * the file's own: a kit's {@code entries:} list is edited as written.
 */
public final class KnowledgeEditorScreen extends EntryEditorScreen {
    KnowledgeEditorScreen(@Nullable Screen parent, String root, String name) {
        super(parent, root, "knowledge", name);
    }

    /** {@code [frontmatter, text]} of a pack's file; the frontmatter is empty when the file has none. */
    static String[] split(String file) {
        String f = file.replace("\r\n", "\n");
        if (f.startsWith("---\n")) {
            int end = f.indexOf("\n---", 3);
            if (end >= 0) {
                int after = f.indexOf('\n', end + 4);
                String rest = after < 0 ? "" : f.substring(after + 1);
                String fm = end <= 4 ? "" : f.substring(4, end);
                return new String[] {fm, rest};
            }
        }
        return new String[] {"", f};
    }

    /** The file from its two parts (the inverse of {@link #split} for what it produces). */
    static String join(String frontmatter, String text) {
        String fm = frontmatter.strip();
        return fm.isEmpty() ? text : "---\n" + fm + "\n---\n" + text;
    }

    @Override
    protected void form(Pane p, JsonObject entry, int y) {
        String[] parts = split(LogListScreen.str(entry, "text"));
        int fh = Math.max(36, Math.min(80, (p.h - y) / 3));
        text(p, 0, y, tr("editor.frontmatter"), DIM);
        y += LINE + 1;
        put(p, area("frontmatter", p.w - 4, fh, parts[0], Component.empty()), 0, y);
        y += fh + 4;
        text(p, 0, y, tr("editor.text"), DIM);
        y += LINE + 1;
        put(p, area("text", p.w - 4, Math.max(40, p.h - y - 2), parts[1], Component.empty()), 0, y);
    }

    @Override
    protected void submit() {
        String[] parts = split(LogListScreen.str(entry, "text"));
        String fm = fieldValue("frontmatter", parts[0]), text = fieldValue("text", parts[1]);
        if (fm.equals(parts[0]) && text.equals(parts[1])) {
            say(tr("editor.unchanged"), DIM);
            return;
        }
        save(Requests.args("text", join(fm, text)), false);
    }
}
