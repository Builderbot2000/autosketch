package dev.autosketch.mod.world;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ProtocolException;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.level.Level;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** The read area outside the volumes: the select grant, the canvas, their union (13, *Reads inside the canvas*; 19). */
class ReadAreaTest {
    static final ResourceKey<Level> OVERWORLD = ResourceKey.create(Registries.DIMENSION, ResourceLocation.parse("minecraft:overworld"));
    static final ResourceKey<Level> NETHER = ResourceKey.create(Registries.DIMENSION, ResourceLocation.parse("minecraft:the_nether"));
    /** Chunks 0..3 by 0..1, full build height. */
    static final Box CANVAS = new Box(0, -64, 0, 63, 319, 31);

    @AfterEach
    void reset() {
        SelectGrants.clear();
        SelectGrants.canvas(null, null);
    }

    @Test
    void nothingSetIsNoGrant() {
        assertNull(SelectGrants.current());
        assertNull(SelectGrants.area("minecraft:overworld"));
        ProtocolException e = assertThrows(ProtocolException.class, () -> SelectGrants.require(1, "minecraft:overworld"));
        assertEquals("no_grant", e.code());
    }

    @Test
    void theCanvasAloneIsTheReadAreaAndCentresOnItsMiddleChunk() throws Exception {
        SelectGrants.canvas(OVERWORLD, CANVAS);
        SelectGrants.ReadArea a = SelectGrants.require(1, "minecraft:overworld");
        assertNull(a.grant());
        assertTrue(a.hasBox(new Box(0, 70, 0, 63, 70, 31)));
        assertFalse(a.hasBox(new Box(0, 70, 0, 64, 70, 31)), "one block past the canvas's last chunk");
        assertFalse(a.hasBox(new Box(-1, 70, 0, 5, 70, 5)));
        assertTrue(a.hasColumns(new Area(10, 10, 60, 20)));
        assertEquals(1, a.centreX(), "(0 + 3) >> 1");
        assertEquals(0, a.centreZ(), "(0 + 1) >> 1");
        assertEquals("the canvas", a.what());
        ProtocolException e = assertThrows(ProtocolException.class, () -> SelectGrants.require(2, "minecraft:the_nether"));
        assertEquals("wrong_dimension", e.code());
    }

    @Test
    void grantAndCanvasReadAsTheirUnion() {
        SelectGrants.canvas(OVERWORLD, CANVAS);
        SelectGrants.set(OVERWORLD, new BlockPos(16 * 10, 64, 0), 3); // chunks 7..13 by -3..3
        SelectGrants.ReadArea a = SelectGrants.area("minecraft:overworld");
        assertTrue(a.hasChunk(0, 0) && a.hasChunk(13, -3));
        // Chunks 2..9 by 0..1: the canvas holds 2..3, the grant 7..9; 4..6 are in neither.
        assertFalse(a.hasBox(new Box(32, 70, 0, 159, 70, 31)));
        // Chunks 3..7 by 0..1: still the gap 4..6.
        assertFalse(a.hasBox(new Box(48, 70, 0, 127, 70, 31)));
        SelectGrants.set(OVERWORLD, new BlockPos(16 * 6, 64, 0), 2); // chunks 4..8 by -2..2
        a = SelectGrants.area("minecraft:overworld");
        assertTrue(a.hasBox(new Box(32, 70, 0, 143, 70, 31)), "chunks 2..8 by 0..1 straddle the two");
        assertFalse(a.hasBox(new Box(32, 70, 0, 143, 70, 47)), "chunk row 2 is outside the canvas from chunk 0 to 3");
        assertEquals(6, a.centreX(), "a search centres on the grant's player");
        assertEquals("the select grant and the canvas", a.what());
    }

    @Test
    void aGrantInAnotherDimensionLeavesTheCanvas() {
        SelectGrants.canvas(OVERWORLD, CANVAS);
        SelectGrants.set(NETHER, BlockPos.ZERO, 2);
        assertNull(SelectGrants.area("minecraft:overworld").grant());
        assertNull(SelectGrants.area("minecraft:the_nether").canvas());
    }

    @Test
    void aCanvasChangeDropsTheSearchAndFillStateAndClearingTheGrantKeepsTheCanvas() {
        SelectGrants.set(OVERWORLD, BlockPos.ZERO, 2);
        SelectGrants.Held held = SelectGrants.current();
        SelectGrants.canvas(OVERWORLD, CANVAS);
        assertNotSame(held, SelectGrants.current());
        held = SelectGrants.current();
        SelectGrants.canvas(OVERWORLD, CANVAS);
        assertSame(held, SelectGrants.current(), "the same canvas again is no change");
        SelectGrants.clear();
        assertTrue(SelectGrants.current() != null && SelectGrants.canvas() != null && SelectGrants.grant() == null);
        SelectGrants.canvas(null, null);
        assertNull(SelectGrants.current());
    }
}
