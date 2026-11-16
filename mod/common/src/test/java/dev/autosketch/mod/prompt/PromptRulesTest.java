package dev.autosketch.mod.prompt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.prompt.ChatRules.LogMode;
import java.util.List;
import java.util.UUID;
import net.minecraft.resources.ResourceKey;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import org.junit.jupiter.api.Test;

/** Focus clipping, chat visibility and wrapping, and the refusal texts (13, *Prompting from the game*). */
class PromptRulesTest {
    private static final Box WORK = new Box(0, 0, 0, 9, 9, 9);
    private static final LinkVolumes VOLUMES = new LinkVolumes(1, ResourceKey.create(Registries.DIMENSION, ResourceLocation.withDefaultNamespace("overworld")),
            WORK, null, List.of(WORK.grow(3), new Box(100, 0, 100, 104, 4, 104)));

    @Test
    void focusInsideTheVolumesIsKept() {
        FocusClip.Result r = FocusClip.clip(new Box(2, 0, 2, 4, 3, 4), VOLUMES);
        assertEquals(new Box(2, 0, 2, 4, 3, 4), r.box());
        assertFalse(r.clipped());
        // In the context seam, past the work volume: still inside the context box.
        assertFalse(FocusClip.clip(new Box(8, 0, 8, 12, 1, 12), VOLUMES).clipped());
    }

    @Test
    void focusIsClippedToTheVolumeItOverlapsMost() {
        FocusClip.Result r = FocusClip.clip(new Box(5, 0, 5, 20, 2, 5), VOLUMES);
        assertEquals(new Box(5, 0, 5, 12, 2, 5), r.box());
        assertTrue(r.clipped());
        FocusClip.Result ref = FocusClip.clip(new Box(98, 0, 98, 102, 0, 102), VOLUMES);
        assertEquals(new Box(100, 0, 100, 102, 0, 102), ref.box());
        assertNull(FocusClip.clip(new Box(50, 0, 50, 51, 1, 51), VOLUMES));
    }

    @Test
    void focusWithoutVolumesIsUnchanged() {
        FocusClip.Result r = FocusClip.clip(new Box(50, 0, 50, 51, 1, 51), (LinkVolumes) null);
        assertEquals(new Box(50, 0, 50, 51, 1, 51), r.box());
        assertFalse(r.clipped());
    }

    @Test
    void chatVisibilityFollowsTheLogSetting() {
        UUID me = UUID.randomUUID(), other = UUID.randomUUID();
        // The requesting player: replies always, activity unless off.
        assertTrue(ChatRules.visible(LogMode.OFF, me, me, true));
        assertFalse(ChatRules.visible(LogMode.OFF, me, me, false));
        assertTrue(ChatRules.visible(LogMode.MINE, me, me, false));
        assertTrue(ChatRules.visible(LogMode.ALL, me, me, false));
        // Everyone else, and lines for no player: only with log all.
        for (boolean reply : new boolean[] {true, false}) {
            assertFalse(ChatRules.visible(LogMode.OFF, me, other, reply));
            assertFalse(ChatRules.visible(LogMode.MINE, me, other, reply));
            assertTrue(ChatRules.visible(LogMode.ALL, me, other, reply));
            assertFalse(ChatRules.visible(LogMode.MINE, me, null, reply));
            assertTrue(ChatRules.visible(LogMode.ALL, me, null, reply));
        }
        assertEquals(LogMode.MINE, LogMode.parse("mine"));
        assertNull(LogMode.parse("MINE"));
    }

    @Test
    void longLinesWrapAtSpaces() {
        assertEquals(List.of("short"), ChatRules.wrap("short", 10));
        assertEquals(List.of("aaaa bbbb", "cccc dddd", "ee"), ChatRules.wrap("aaaa bbbb cccc dddd ee", 10));
        assertEquals(List.of("abcdefghij", "klm"), ChatRules.wrap("abcdefghijklm", 10));
    }

    @Test
    void refusalTextsNameTheReason() {
        assertTrue(ChatRules.resultText(true, null).contains("delivered"));
        assertTrue(ChatRules.resultText(false, "no_link").contains("no linked world"));
        assertTrue(ChatRules.resultText(false, "not_allowed").contains("world.promptPlayers"));
        assertTrue(ChatRules.resultText(false, "no_listener").contains("no agent session"));
        assertTrue(ChatRules.resultText(false, "something_new").endsWith("something_new"));
    }
}
