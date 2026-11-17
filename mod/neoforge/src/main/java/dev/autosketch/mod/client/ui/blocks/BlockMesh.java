package dev.autosketch.mod.client.ui.blocks;

import com.mojang.blaze3d.vertex.VertexBuffer;

/**
 * One meshed box of a {@link BlockRegion} on the GPU, built by {@link BlockMesher} and drawn by
 * {@link BlockDrawer}. Vertex positions are relative to the box's corner {@code (x, y, z)} in the
 * region's coordinates, so drawing it at the region's origin plus that corner puts every block in
 * place. Close it when done ({@link #close}, render thread): it holds GL buffers.
 */
public final class BlockMesh implements AutoCloseable {
    private final VertexBuffer buffer;
    private final int x, y, z;
    private final int quads;
    private final long bytes;
    private boolean closed;

    BlockMesh(VertexBuffer buffer, int x, int y, int z, int quads, long bytes) {
        this.buffer = buffer;
        this.x = x;
        this.y = y;
        this.z = z;
        this.quads = quads;
        this.bytes = bytes;
    }

    /** The box's corner in region coordinates. */
    public int x() {
        return x;
    }

    public int y() {
        return y;
    }

    public int z() {
        return z;
    }

    /** Quads in the mesh. */
    public int quads() {
        return quads;
    }

    /** GPU memory the vertices take (indices come from the game's shared quad index buffer). */
    public long bytes() {
        return bytes;
    }

    public boolean closed() {
        return closed;
    }

    VertexBuffer buffer() {
        return buffer;
    }

    /** Frees the GL buffers. Render thread; closing twice does nothing. */
    @Override
    public void close() {
        if (closed) return;
        closed = true;
        buffer.close();
    }
}
