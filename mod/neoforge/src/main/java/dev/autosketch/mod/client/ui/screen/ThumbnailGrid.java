package dev.autosketch.mod.client.ui.screen;

import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.logging.LogUtils;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * A grid of prefab thumbnails (16, *Library screen*; 17 piece 4), shared by the library screen and
 * the candidates screen: cards laid out in a {@link PaneScreen.Pane}, each with the MCP's PNG
 * ({@code library.thumbnail}), asked for one at a time as cards come into view, loaded as dynamic
 * textures, and freed by {@link #release()} when the screen closes. Thumbnails are keyed by root and
 * prefab name. What a card shows under its picture, whether it is selected and what a click does
 * belong to the screen, through a {@link Card} subclass.
 */
final class ThumbnailGrid {
    private static final Logger LOG = LogUtils.getLogger();
    static final int CARD_W = 60, CARD_H = 70, THUMB = 52;

    /** A thumbnail: its texture, or none (the entry has no thumbnail, or it failed). */
    private record Thumb(@Nullable ResourceLocation texture, int width, int height) {}

    private final Map<String, Thumb> thumbs = new HashMap<>();
    private final Map<String, Boolean> asked = new HashMap<>();
    private static int textureCounter;
    private final BooleanSupplier closed;
    private boolean drawThumbnails = true;

    /** {@code closed} says the screen has closed, so a late thumbnail is dropped. */
    ThumbnailGrid(BooleanSupplier closed) {
        this.closed = closed;
    }

    /** How many thumbnails are loaded as textures right now. */
    int texturesLoaded() {
        return (int) thumbs.values().stream().filter(t -> t.texture != null).count();
    }

    /** Draws the cards without their thumbnails (a test compares the grid with and without). */
    void drawThumbnails(boolean draw) {
        drawThumbnails = draw;
    }

    /**
     * Lays out one card per entry in rows that fill the pane's width, and asks for the thumbnails of
     * the cards in view.
     */
    <T> void layout(PaneScreen screen, PaneScreen.Pane p, List<T> entries, Function<T, Card> card) {
        int cols = Math.max(1, (p.w - 4) / (CARD_W + 4));
        for (int i = 0; i < entries.size(); i++) {
            Card c = screen.put(p, card.apply(entries.get(i)), (i % cols) * (CARD_W + 4), (i / cols) * (CARD_H + 4));
            if (c.visible) ask(c.root, c.name);
        }
    }

    private static String key(String root, String name) {
        return root + "\n" + name;
    }

    private void ask(String root, String name) {
        String key = key(root, name);
        if (asked.containsKey(key)) return;
        asked.put(key, true);
        Requests.send("library.thumbnail", Requests.args("root", root, "name", name), r -> {
            if (closed.getAsBoolean()) return;
            if (!r.ok() || r.body().length == 0) {
                thumbs.put(key, new Thumb(null, 0, 0));
                return;
            }
            try {
                NativeImage img = NativeImage.read(r.body());
                ResourceLocation loc = ResourceLocation.fromNamespaceAndPath("autosketch", "library_thumb/" + (++textureCounter));
                Minecraft.getInstance().getTextureManager().register(loc, new DynamicTexture(img));
                thumbs.put(key, new Thumb(loc, img.getWidth(), img.getHeight()));
            } catch (Exception ex) {
                LOG.warn("Autosketch: thumbnail of {} didn't load: {}", name, ex.toString());
                thumbs.put(key, new Thumb(null, 0, 0));
            }
        });
    }

    /** Frees every texture and forgets what was asked (the screen closed). */
    void release() {
        for (Thumb t : thumbs.values()) if (t.texture != null) Minecraft.getInstance().getTextureManager().release(t.texture);
        thumbs.clear();
        asked.clear();
    }

    /**
     * A card: the prefab's thumbnail and a title line under it; selects on click. Its message is the
     * prefab's name. Subclasses say whether it is selected, what a click does and what the title is.
     */
    abstract static class Card extends AbstractWidget {
        private final ThumbnailGrid grid;
        final String root, name;

        Card(ThumbnailGrid grid, String root, String name) {
            super(0, 0, CARD_W, CARD_H, Component.literal(name));
            this.grid = grid;
            this.root = root;
            this.name = name;
        }

        abstract boolean selected();

        abstract void select();

        /** The line under the thumbnail. */
        abstract String title();

        int titleColour() {
            return PaneScreen.TEXT;
        }

        /** Colour of a small mark in the top-right corner, or 0 for none. */
        int mark() {
            return 0;
        }

        @Override
        protected void renderWidget(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
            Font font = Minecraft.getInstance().font;
            boolean sel = selected();
            g.fill(getX(), getY(), getX() + width, getY() + height, sel ? 0x60FFFFFF : isHovered() ? 0x40FFFFFF : 0x30000000);
            int tx = getX() + (width - THUMB) / 2, ty = getY() + 2;
            Thumb t = grid.thumbs.get(key(root, name));
            if (grid.drawThumbnails && t != null && t.texture != null) g.blit(t.texture, tx, ty, THUMB, THUMB, 0, 0, t.width, t.height, t.width, t.height);
            else if (grid.drawThumbnails) g.drawCenteredString(font, t == null ? PaneScreen.tr("loading") : PaneScreen.tr("library.no_thumbnail"), getX() + width / 2, ty + THUMB / 2 - 4, PaneScreen.DIM);
            g.drawString(font, font.plainSubstrByWidth(title(), width - 4), getX() + 2, getY() + THUMB + 4, titleColour());
            int mark = mark();
            if (mark != 0) g.fill(getX() + width - 5, getY() + 1, getX() + width - 1, getY() + 5, mark);
            if (sel) g.renderOutline(getX(), getY(), width, height, 0xFFFFFFFF);
        }

        @Override
        public void onClick(double mouseX, double mouseY) {
            select();
        }

        @Override
        protected void updateWidgetNarration(NarrationElementOutput out) {
            defaultButtonNarrationText(out);
        }
    }
}
