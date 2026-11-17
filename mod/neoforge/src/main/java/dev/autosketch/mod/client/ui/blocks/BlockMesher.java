package dev.autosketch.mod.client.ui.blocks;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.BufferBuilder;
import com.mojang.blaze3d.vertex.ByteBufferBuilder;
import com.mojang.blaze3d.vertex.DefaultVertexFormat;
import com.mojang.blaze3d.vertex.MeshData;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexBuffer;
import com.mojang.blaze3d.vertex.VertexFormat;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.renderer.block.BlockRenderDispatcher;
import net.minecraft.client.resources.model.BakedModel;
import net.minecraft.core.BlockPos;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.BlockAndTintGetter;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.neoforged.neoforge.client.model.data.ModelData;
import org.jetbrains.annotations.Nullable;

/**
 * Meshes a {@link BlockRegion} with the game's own block renderer (16, *Ghost blocks*): each block's
 * baked model, every render layer it has (solid, cutout, translucent) into one mesh, fluids through
 * the liquid renderer, faces between drawn blocks culled as in the world. Blocks with block-entity
 * renderers contribute only their baked model, which for some (chests, signs) is empty (16,
 * *Decisions*: block models only). Modded models get {@code ModelData.EMPTY}, since a drawn region
 * has no block entities to fill it.
 *
 * <p>The unit is one 16³ section of the region's grid (section {@code (cx,cy,cz)} covers
 * {@code [16c, 16c + 16)} on each axis), as the world's own chunk meshes: an edit re-meshes only its
 * section, and the liquid renderer's section-relative positions stay correct. Render thread only
 * (it uploads to the GPU).
 *
 * <p>1.21.x: {@code ModelBlockRenderer.tesselateBlock}'s NeoForge overload (model data, render
 * type), {@code BakedModel.getRenderTypes}, {@code BufferBuilder}/{@code ByteBufferBuilder}/
 * {@code MeshData} (new in 1.21) and {@code VertexBuffer.upload} are what a port checks; this
 * follows vanilla's {@code SectionCompiler.compile}.
 */
public final class BlockMesher {
    private BlockMesher() {}

    private static @Nullable ByteBufferBuilder scratch;
    private static long sectionsMeshed;
    private static long nanosMeshing;

    /** Sections meshed since the client started, and the time they took (measurements, tests). */
    public static long sectionsMeshed() {
        return sectionsMeshed;
    }

    public static long nanosMeshing() {
        return nanosMeshing;
    }

    /**
     * Meshes section {@code (cx,cy,cz)} of {@code region}, or returns null when it draws nothing.
     *
     * @param tints a world to take biome colours from, at region position plus {@code (ox,oy,oz)};
     *              null for fixed plains-like colours (a screen)
     */
    public static @Nullable BlockMesh section(BlockRegion region, int cx, int cy, int cz, @Nullable BlockAndTintGetter tints, int ox, int oy, int oz) {
        RenderSystem.assertOnRenderThread();
        long start = System.nanoTime();
        try {
            return build(new RegionLevel(region, tints, ox, oy, oz), cx, cy, cz);
        } finally {
            sectionsMeshed++;
            nanosMeshing += System.nanoTime() - start;
        }
    }

    /** Meshes every section of a region that draws something (a screen's preview), with fixed colours. */
    public static List<BlockMesh> all(BlockRegion region) {
        List<BlockMesh> out = new ArrayList<>();
        int nx = (region.sizeX() + 15) >> 4, ny = (region.sizeY() + 15) >> 4, nz = (region.sizeZ() + 15) >> 4;
        for (int cy = 0; cy < ny; cy++)
            for (int cz = 0; cz < nz; cz++)
                for (int cx = 0; cx < nx; cx++) {
                    BlockMesh m = section(region, cx, cy, cz, null, 0, 0, 0);
                    if (m != null) out.add(m);
                }
        return out;
    }

    private static @Nullable BlockMesh build(RegionLevel level, int cx, int cy, int cz) {
        Minecraft mc = Minecraft.getInstance();
        BlockRenderDispatcher dispatcher = mc.getBlockRenderer();
        if (scratch == null) scratch = new ByteBufferBuilder(1 << 18);
        BufferBuilder builder = new BufferBuilder(scratch, VertexFormat.Mode.QUADS, DefaultVertexFormat.BLOCK);
        PoseStack pose = new PoseStack();
        RandomSource random = RandomSource.create();
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        int x0 = cx << 4, y0 = cy << 4, z0 = cz << 4;
        for (int y = 0; y < 16; y++)
            for (int z = 0; z < 16; z++)
                for (int x = 0; x < 16; x++) {
                    pos.set(x0 + x, y0 + y, z0 + z);
                    BlockState state = level.getBlockState(pos);
                    if (state.isAir()) continue;
                    FluidState fluid = state.getFluidState();
                    // The liquid renderer writes section-relative positions itself (pos & 15).
                    if (!fluid.isEmpty()) dispatcher.renderLiquid(pos, level, builder, state, fluid);
                    if (state.getRenderShape() == RenderShape.INVISIBLE) continue;
                    BakedModel model = dispatcher.getBlockModel(state);
                    ModelData data = model.getModelData(level, pos, state, ModelData.EMPTY);
                    long seed = state.getSeed(pos);
                    random.setSeed(seed);
                    for (RenderType layer : model.getRenderTypes(state, random, data)) {
                        pose.pushPose();
                        pose.translate(x, y, z);
                        dispatcher.getModelRenderer().tesselateBlock(level, model, state, pos, pose, builder, true, random, seed,
                                net.minecraft.client.renderer.texture.OverlayTexture.NO_OVERLAY, data, layer);
                        pose.popPose();
                    }
                }
        MeshData mesh = builder.build();
        if (mesh == null) return null;
        MeshData.DrawState draw = mesh.drawState();
        int quads = draw.vertexCount() / 4;
        long bytes = (long) draw.vertexCount() * draw.format().getVertexSize();
        VertexBuffer vb = new VertexBuffer(VertexBuffer.Usage.STATIC);
        vb.bind();
        vb.upload(mesh); // closes the mesh, which hands its memory back to the scratch builder
        VertexBuffer.unbind();
        return new BlockMesh(vb, x0, y0, z0, quads, bytes);
    }
}
