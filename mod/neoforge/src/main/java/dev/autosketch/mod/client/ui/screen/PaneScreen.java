package dev.autosketch.mod.client.ui.screen;

import dev.autosketch.mod.client.ui.LinkState;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import org.jetbrains.annotations.Nullable;

/**
 * The base of the Autosketch screens (16, *Settings screen*, *Library screen*): the layout is
 * rebuilt from the screen's state on every change ({@link #rebuildWidgets()} runs {@link #layout()}
 * again), into rectangular {@link Pane}s that scroll on their own. Rows have varying heights (a
 * setting with notes, a list editor), which vanilla's fixed-height selection lists can't hold, so a
 * pane places widgets and text lines at content coordinates and shows only the widgets that fit
 * whole inside it; text is clipped with a scissor. Typed text survives a rebuild through
 * {@link #field}, keyed by the caller.
 *
 * <p>Every Autosketch screen closes itself when the link drops (16, *Mod side*: nothing drawn while
 * offline), and goes back to {@link #parent} on Esc.
 *
 * <p>1.21.x: {@code Screen.render} draws the background itself, {@code mouseScrolled} takes two
 * deltas, and {@code GuiGraphics.enableScissor} takes screen coordinates.
 */
abstract class PaneScreen extends Screen {
    static final int TEXT = 0xFFFFFF, DIM = 0xA0A0A0, BAD = 0xFF6060, GOOD = 0x80FF80, WARN = 0xFFD060, ACCENT = 0x80C0FF;
    static final int LINE = 10;

    protected final @Nullable Screen parent;

    /** A scrolling rectangle; its contents are laid out at content coordinates from its top-left. */
    protected static final class Pane {
        final String key;
        final int x, y, w, h;
        int scroll, content;
        final List<Text> texts = new ArrayList<>();

        Pane(String key, int x, int y, int w, int h) {
            this.key = key;
            this.x = x;
            this.y = y;
            this.w = w;
            this.h = h;
        }

        boolean contains(double mx, double my) {
            return mx >= x && mx < x + w && my >= y && my < y + h;
        }

        int maxScroll() {
            return Math.max(0, content - h);
        }
    }

    private record Text(int x, int y, FormattedCharSequence text, int color) {}

    protected final List<Pane> panes = new ArrayList<>();
    private final Map<String, Integer> scrolls = new HashMap<>();
    private final Map<String, String> fields = new HashMap<>();
    private @Nullable String focusedField;
    private final Map<EditBox, String> fieldKeys = new HashMap<>();

    protected PaneScreen(Component title, @Nullable Screen parent) {
        super(title);
        this.parent = parent;
    }

    /** Lays out the whole screen from its state: panes, widgets, text. */
    protected abstract void layout();

    @Override
    protected final void init() {
        panes.clear();
        fieldKeys.clear();
        layout();
        boolean clamped = false;
        for (Pane p : panes) {
            int s = Math.min(p.scroll, p.maxScroll());
            if (s != p.scroll) {
                scrolls.put(p.key, s);
                clamped = true;
            }
        }
        if (clamped) {
            panes.clear();
            fieldKeys.clear();
            clearWidgets();
            layout();
        }
        if (focusedField != null)
            for (Map.Entry<EditBox, String> e : fieldKeys.entrySet())
                if (e.getValue().equals(focusedField) && e.getKey().visible) setFocused(e.getKey());
    }

    /** Lays the screen out again from its state (after a result, a click, a scroll). */
    protected void refresh() {
        if (minecraft != null && minecraft.screen == this) rebuildWidgets();
    }

    protected Pane pane(String key, int x, int y, int w, int h) {
        Pane p = new Pane(key, x, y, w, h);
        p.scroll = scrolls.getOrDefault(key, 0);
        panes.add(p);
        return p;
    }

    /** Scrolls a pane back to the top (a new list). */
    protected void resetScroll(String key) {
        scrolls.remove(key);
    }

    /** Places a widget at content position {@code (cx, cy)} of {@code p}; shown only when it fits whole. */
    protected <T extends AbstractWidget> T put(Pane p, T w, int cx, int cy) {
        int sy = p.y + cy - p.scroll;
        w.setX(p.x + cx);
        w.setY(sy);
        w.visible = sy >= p.y && sy + w.getHeight() <= p.y + p.h;
        p.content = Math.max(p.content, cy + w.getHeight());
        return addRenderableWidget(w);
    }

    /** One line of text at content position {@code (cx, cy)}, cut to the pane's width. */
    protected void text(Pane p, int cx, int cy, Component c, int colour) {
        int room = Math.max(10, p.w - cx);
        List<FormattedCharSequence> lines = font.split(c, Integer.MAX_VALUE / 2);
        FormattedCharSequence line = lines.isEmpty() ? FormattedCharSequence.EMPTY : lines.get(0);
        if (font.width(line) > room) line = cut(c.getString(), room);
        p.texts.add(new Text(cx, cy, line, colour));
        p.content = Math.max(p.content, cy + LINE);
    }

    /** Wrapped text from {@code (cx, cy)} to the pane's right edge; returns the height used. */
    protected int wrap(Pane p, int cx, int cy, Component c, int colour) {
        int room = Math.max(20, p.w - cx - 4);
        int y = cy;
        for (FormattedCharSequence line : font.split(c, room)) {
            p.texts.add(new Text(cx, y, line, colour));
            y += LINE;
        }
        if (y == cy) y += LINE;
        p.content = Math.max(p.content, y);
        return y - cy;
    }

    private FormattedCharSequence cut(String s, int room) {
        String ell = "…";
        return Component.literal(font.plainSubstrByWidth(s, room - font.width(ell)) + ell).getVisualOrderText();
    }

    /**
     * A text field whose value survives rebuilds under {@code key}: {@code initial} on first use,
     * then whatever was typed. {@link #forget} drops it (after a save).
     */
    protected EditBox field(String key, int width, String initial, Component hint) {
        EditBox box = new EditBox(font, 0, 0, width, 16, Component.literal(key));
        box.setMaxLength(4096);
        box.setValue(fields.computeIfAbsent(key, k -> initial));
        box.setHint(hint);
        box.setResponder(v -> fields.put(key, v));
        fieldKeys.put(box, key);
        return box;
    }

    protected String fieldValue(String key, String fallback) {
        return fields.getOrDefault(key, fallback);
    }

    protected void setFieldValue(String key, String value) {
        fields.put(key, value);
    }

    protected void forget(String keyPrefix) {
        fields.keySet().removeIf(k -> k.startsWith(keyPrefix));
    }

    @Override
    public void setFocused(@Nullable net.minecraft.client.gui.components.events.GuiEventListener listener) {
        super.setFocused(listener);
        focusedField = listener instanceof EditBox b ? fieldKeys.get(b) : null;
    }

    /** Draws what isn't a widget inside a pane (thumbnails, the preview), clipped to it. */
    protected void renderPane(GuiGraphics g, Pane p, int mouseX, int mouseY, float partialTick) {}

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        renderBackground(g, mouseX, mouseY, partialTick);
        for (Pane p : panes) {
            g.enableScissor(p.x, p.y, p.x + p.w, p.y + p.h);
            for (Text t : p.texts) {
                int y = p.y + t.y - p.scroll;
                if (y + LINE < p.y || y > p.y + p.h) continue;
                g.drawString(font, t.text, p.x + t.x, y, t.color);
            }
            renderPane(g, p, mouseX, mouseY, partialTick);
            g.disableScissor();
            if (p.maxScroll() > 0) {
                int bar = Math.max(8, p.h * p.h / Math.max(1, p.content));
                int top = p.y + (p.h - bar) * p.scroll / p.maxScroll();
                g.fill(p.x + p.w - 2, top, p.x + p.w, top + bar, 0x80FFFFFF);
            }
        }
        for (var r : renderables) r.render(g, mouseX, mouseY, partialTick);
    }

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double scrollX, double scrollY) {
        for (Pane p : panes) {
            if (!p.contains(mouseX, mouseY) || p.maxScroll() == 0) continue;
            int s = Math.max(0, Math.min(p.maxScroll(), p.scroll - (int) Math.round(scrollY * 2 * LINE)));
            if (s != p.scroll) {
                scrolls.put(p.key, s);
                refresh();
            }
            return true;
        }
        return super.mouseScrolled(mouseX, mouseY, scrollX, scrollY);
    }

    @Override
    public void tick() {
        if (!LinkState.connected()) onClose();
    }

    @Override
    public void onClose() {
        minecraft.setScreen(parent);
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }

    static Component tr(String key, Object... args) {
        return Component.translatable("autosketch.screen." + key, args);
    }
}
