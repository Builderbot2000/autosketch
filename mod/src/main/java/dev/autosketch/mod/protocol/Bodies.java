package dev.autosketch.mod.protocol;

import dev.autosketch.mod.protocol.BodyTypes.AckLists;
import dev.autosketch.mod.protocol.BodyTypes.BlockEntityNbt;
import dev.autosketch.mod.protocol.BodyTypes.Encoded;
import dev.autosketch.mod.protocol.BodyTypes.Normalized;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.Rejected;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;

/**
 * Binary bodies (13, *Wire format*, *Binary bodies*). Positions are gap-coded ascending linear
 * indices into the message grid; palettes are string tables in first-use order; NBT lists and hash
 * lists address entries by gap-coded ordinal. Encoders sort entries by grid index, so callers may
 * pass them in any order. Decoders check every index, count and table reference, and that the body
 * is fully consumed, throwing {@code bad_request} otherwise.
 */
public final class Bodies {
    private Bodies() {}

    // ── shared pieces ─────────────────────────────────────────────────────────────────────────

    /** Grid indices of {@code items}, and the permutation that lists them in ascending order. */
    private record Sorted(long[] idx, int[] perm) {}

    private static <T> Sorted sort(Grid grid, List<T> items, Function<T, BlockPos> pos, String what) {
        int n = items.size();
        long[] idx = new long[n];
        boolean ascending = true;
        for (int i = 0; i < n; i++) {
            idx[i] = grid.indexOf(pos.apply(items.get(i)));
            if (i > 0 && idx[i] <= idx[i - 1]) ascending = false;
        }
        int[] perm = new int[n];
        if (ascending) {
            for (int i = 0; i < n; i++) perm[i] = i;
            return new Sorted(idx, perm);
        }
        if (grid.volume() < (1L << 32)) {
            long[] packed = new long[n];
            for (int i = 0; i < n; i++) packed[i] = (idx[i] << 31) | i;
            Arrays.sort(packed);
            for (int i = 0; i < n; i++) perm[i] = (int) (packed[i] & 0x7fffffffL);
        } else {
            Integer[] boxed = new Integer[n];
            for (int i = 0; i < n; i++) boxed[i] = i;
            Arrays.sort(boxed, Comparator.comparingLong(i -> idx[i]));
            for (int i = 0; i < n; i++) perm[i] = boxed[i];
        }
        for (int i = 1; i < n; i++)
            if (idx[perm[i]] == idx[perm[i - 1]]) throw new IllegalArgumentException(what + " lists position " + grid.posAt(idx[perm[i]]) + " twice");
        return new Sorted(idx, perm);
    }

    private static void writeGaps(ByteWriter w, Sorted s) {
        long prev = -1;
        for (int i : s.perm) {
            w.varint(s.idx[i] - prev - 1);
            prev = s.idx[i];
        }
    }

    private static long[] readGaps(ByteReader r, int n, Grid grid, String what) throws ProtocolException {
        long[] out = new long[n];
        long prev = -1, limit = grid.volume();
        for (int i = 0; i < n; i++) {
            prev = prev + r.varint() + 1;
            if (prev >= limit) throw ProtocolException.malformed(what + ": index " + prev + " outside a grid of " + limit);
            out[i] = prev;
        }
        return out;
    }

    /** First-use string table. */
    private static final class Table {
        final List<String> list = new ArrayList<>();
        private final Map<String, Integer> map = new HashMap<>();

        int of(String s) {
            Integer i = map.get(s);
            if (i == null) {
                i = list.size();
                list.add(s);
                map.put(s, i);
            }
            return i;
        }
    }

    private static String entry(List<String> table, long i, String what) throws ProtocolException {
        if (i >= table.size()) throw ProtocolException.malformed(what + ": index " + i + " outside its table of " + table.size());
        return table.get((int) i);
    }

    /** Count of a list whose entries each take at least one byte, so it can't exceed what remains. */
    private static int count(ByteReader r, String what) throws ProtocolException {
        return r.count(r.remaining(), what);
    }

    private record Ord(int ordinal, CompoundTag nbt) {}

    private static void writeNbtList(ByteWriter w, List<Ord> nbts) {
        w.varint(nbts.size());
        long prev = -1;
        for (Ord o : nbts) {
            w.varint(o.ordinal - prev - 1);
            prev = o.ordinal;
            byte[] b = Nbt.write(o.nbt);
            w.varint(b.length);
            w.bytes(b);
        }
    }

    private static List<Ord> readNbtList(ByteReader r, long limit, String what) throws ProtocolException {
        int n = count(r, what + " NBT count");
        List<Ord> out = new ArrayList<>(n);
        long prev = -1;
        for (int i = 0; i < n; i++) {
            prev = prev + r.varint() + 1;
            if (prev >= limit) throw ProtocolException.malformed(what + ": NBT for entry " + prev + " of " + limit);
            int len = r.count(r.remaining(), what + " NBT length");
            CompoundTag c = Nbt.read(r.buffer(), r.position(), len);
            r.skip(len);
            out.add(new Ord((int) prev, c));
        }
        return out;
    }

    private static void checkCount(int body, int header, String what) throws ProtocolException {
        if (body != header) throw ProtocolException.malformed(what + ": header count " + header + ", body lists " + body);
    }

    // ── patch ─────────────────────────────────────────────────────────────────────────────────

    /** {@code patch}: palette · N · positions · expected states · new states · hashList · nbtList. */
    public static Encoded encodePatch(List<PatchBlock> blocks) {
        Grid grid = Grid.around(blocks.stream().map(PatchBlock::pos).toList());
        Sorted s = sort(grid, blocks, PatchBlock::pos, "patch");
        int n = blocks.size();
        Table pal = new Table();
        int[] expected = new int[n], next = new int[n];
        List<Ord> nbts = new ArrayList<>();
        ByteWriter hashes = new ByteWriter(64);
        int hashCount = 0;
        long prevHash = -1;
        for (int i = 0; i < n; i++) {
            PatchBlock b = blocks.get(s.perm[i]);
            expected[i] = pal.of(b.expected());
            next[i] = pal.of(b.state());
            if (b.expectedNbtHash() != null) {
                hashes.varint(i - prevHash - 1);
                hashes.hash(b.expectedNbtHash());
                prevHash = i;
                hashCount++;
            }
            if (b.nbt() != null) nbts.add(new Ord(i, b.nbt()));
        }
        ByteWriter w = new ByteWriter(Math.max(1024, n * 4));
        w.table(pal.list);
        w.varint(n);
        writeGaps(w, s);
        for (int e : expected) w.varint(e);
        for (int e : next) w.varint(e);
        w.varint(hashCount);
        hashes.writeTo(w);
        writeNbtList(w, nbts);
        return new Encoded(grid, w.toByteArray());
    }

    public static List<PatchBlock> decodePatch(byte[] body, Grid grid, int count) throws ProtocolException {
        ByteReader r = new ByteReader(body);
        List<String> pal = r.table();
        int n = count(r, "patch count");
        checkCount(n, count, "patch");
        long[] idx = readGaps(r, n, grid, "patch");
        String[] expected = new String[n], next = new String[n];
        for (int i = 0; i < n; i++) expected[i] = entry(pal, r.varint(), "patch expected state");
        for (int i = 0; i < n; i++) next[i] = entry(pal, r.varint(), "patch new state");
        Long[] hashes = new Long[n];
        int h = count(r, "patch hash count");
        long prev = -1;
        for (int i = 0; i < h; i++) {
            prev = prev + r.varint() + 1;
            if (prev >= n) throw ProtocolException.malformed("patch: NBT hash for entry " + prev + " of " + n);
            hashes[(int) prev] = r.hash();
        }
        CompoundTag[] nbt = new CompoundTag[n];
        for (Ord o : readNbtList(r, n, "patch")) nbt[o.ordinal] = o.nbt;
        r.expectEnd("patch");
        List<PatchBlock> out = new ArrayList<>(n);
        for (int i = 0; i < n; i++) out.add(new PatchBlock(grid.posAt(idx[i]), expected[i], next[i], hashes[i], nbt[i]));
        return out;
    }

    // ── block lists: dirty, ack skipped ───────────────────────────────────────────────────────

    private static void writeBlockList(ByteWriter w, Grid grid, List<WorldBlock> blocks, String what) {
        Sorted s = sort(grid, blocks, WorldBlock::pos, what);
        Table pal = new Table();
        int[] states = new int[blocks.size()];
        List<Ord> nbts = new ArrayList<>();
        for (int i = 0; i < s.perm.length; i++) {
            WorldBlock b = blocks.get(s.perm[i]);
            states[i] = pal.of(b.state());
            if (b.nbt() != null) nbts.add(new Ord(i, b.nbt()));
        }
        w.table(pal.list);
        w.varint(blocks.size());
        writeGaps(w, s);
        for (int st : states) w.varint(st);
        writeNbtList(w, nbts);
    }

    private static List<WorldBlock> readBlockList(ByteReader r, Grid grid, int count, String what) throws ProtocolException {
        List<String> pal = r.table();
        int n = count(r, what + " count");
        checkCount(n, count, what);
        long[] idx = readGaps(r, n, grid, what);
        String[] states = new String[n];
        for (int i = 0; i < n; i++) states[i] = entry(pal, r.varint(), what + " state");
        CompoundTag[] nbt = new CompoundTag[n];
        for (Ord o : readNbtList(r, n, what)) nbt[o.ordinal] = o.nbt;
        List<WorldBlock> out = new ArrayList<>(n);
        for (int i = 0; i < n; i++) out.add(new WorldBlock(grid.posAt(idx[i]), states[i], nbt[i]));
        return out;
    }

    /** {@code dirty}: one block list. */
    public static Encoded encodeDirty(List<WorldBlock> blocks) {
        Grid grid = Grid.around(blocks.stream().map(WorldBlock::pos).toList());
        ByteWriter w = new ByteWriter(Math.max(256, blocks.size() * 4));
        writeBlockList(w, grid, blocks, "dirty");
        return new Encoded(grid, w.toByteArray());
    }

    public static List<WorldBlock> decodeDirty(byte[] body, Grid grid, int count) throws ProtocolException {
        ByteReader r = new ByteReader(body);
        List<WorldBlock> out = readBlockList(r, grid, count, "dirty");
        r.expectEnd("dirty");
        return out;
    }

    // ── patch.ack ─────────────────────────────────────────────────────────────────────────────

    /** {@code patch.ack}: skipped block list · reasons · rejected · normalized · normalized NBT. One grid over all three lists. */
    public static Encoded encodeAck(AckLists ack) {
        Grid grid = Grid.around(ack.skipped().stream().map(WorldBlock::pos).toList(),
                ack.rejected().stream().map(Rejected::pos).toList(),
                ack.normalized().stream().map(Normalized::pos).toList());
        ByteWriter w = new ByteWriter();
        writeBlockList(w, grid, ack.skipped(), "ack skipped");
        Sorted rej = sort(grid, ack.rejected(), Rejected::pos, "ack rejected");
        Table reasons = new Table();
        int[] codes = new int[rej.perm.length];
        for (int i = 0; i < codes.length; i++) codes[i] = reasons.of(ack.rejected().get(rej.perm[i]).reason());
        w.table(reasons.list);
        w.varint(codes.length);
        writeGaps(w, rej);
        for (int c : codes) w.varint(c);
        Sorted norm = sort(grid, ack.normalized(), Normalized::pos, "ack normalized");
        w.varint(norm.perm.length);
        writeGaps(w, norm);
        List<Ord> nbts = new ArrayList<>();
        for (int i = 0; i < norm.perm.length; i++) {
            CompoundTag c = ack.normalized().get(norm.perm[i]).nbt();
            if (c != null) nbts.add(new Ord(i, c));
        }
        writeNbtList(w, nbts);
        return new Encoded(grid, w.toByteArray());
    }

    public static AckLists decodeAck(byte[] body, Grid grid, int skipped, int rejected, int normalized) throws ProtocolException {
        ByteReader r = new ByteReader(body);
        List<WorldBlock> skip = readBlockList(r, grid, skipped, "ack skipped");
        List<String> reasons = r.table();
        for (String s : reasons) if (!ErrorCodes.isRejectReason(s)) throw ProtocolException.malformed("ack: unknown reject reason \"" + s + "\"");
        int nr = count(r, "ack rejected count");
        checkCount(nr, rejected, "ack rejected");
        long[] ridx = readGaps(r, nr, grid, "ack rejected");
        List<Rejected> rej = new ArrayList<>(nr);
        for (int i = 0; i < nr; i++) rej.add(new Rejected(grid.posAt(ridx[i]), entry(reasons, r.varint(), "ack reason")));
        int nn = count(r, "ack normalized count");
        checkCount(nn, normalized, "ack normalized");
        long[] nidx = readGaps(r, nn, grid, "ack normalized");
        CompoundTag[] nbt = new CompoundTag[nn];
        for (Ord o : readNbtList(r, nn, "ack normalized")) nbt[o.ordinal] = o.nbt;
        r.expectEnd("ack");
        List<Normalized> norm = new ArrayList<>(nn);
        for (int i = 0; i < nn; i++) norm.add(new Normalized(grid.posAt(nidx[i]), nbt[i]));
        return new AckLists(skip, rej, norm);
    }

    // ── snapshot.result ───────────────────────────────────────────────────────────────────────

    /**
     * {@code snapshot.result}: palette, then every position of every region (in region order, each
     * in its box's index order) as a palette index, then one NBT list whose ordinals run over all
     * regions' positions concatenated. {@code palette} may hold unused or out-of-order entries: the
     * encoder writes the used ones in first-use order and remaps the indices.
     */
    public static byte[] encodeSnapshot(List<String> palette, List<SnapshotRegion> regions) {
        int[] remap = new int[palette.size()];
        Arrays.fill(remap, -1);
        List<String> used = new ArrayList<>();
        long total = 0;
        for (SnapshotRegion reg : regions) {
            long vol = reg.box().volume();
            if (reg.states().length != vol) throw new IllegalArgumentException("snapshot region holds " + reg.states().length + " states for a box of " + vol);
            total += vol;
            for (int st : reg.states()) {
                if (remap[st] == -1) {
                    remap[st] = used.size();
                    used.add(palette.get(st));
                }
            }
        }
        ByteWriter w = new ByteWriter((int) Math.min(Integer.MAX_VALUE - 64, Math.max(1024, total + 64)));
        w.table(used);
        for (SnapshotRegion reg : regions) for (int st : reg.states()) w.varint(remap[st]);
        List<Ord> ords = new ArrayList<>();
        long base = 0;
        for (SnapshotRegion reg : regions) {
            Grid g = reg.box().grid();
            List<Ord> local = new ArrayList<>(reg.blockEntities().size());
            for (BlockEntityNbt be : reg.blockEntities()) {
                if (!reg.box().contains(be.pos())) throw new IllegalArgumentException("snapshot block entity at " + be.pos() + " lies outside its region");
                local.add(new Ord(Math.toIntExact(base + g.indexOf(be.pos())), be.nbt()));
            }
            local.sort(Comparator.comparingInt(Ord::ordinal));
            for (int i = 1; i < local.size(); i++)
                if (local.get(i).ordinal == local.get(i - 1).ordinal) throw new IllegalArgumentException("snapshot region lists two block entities at one position");
            ords.addAll(local);
            base += reg.states().length;
        }
        writeNbtList(w, ords);
        return w.toByteArray();
    }

    /** Decodes a snapshot body against the header's regions; returns the palette and the regions. */
    public static SnapshotBody decodeSnapshot(byte[] body, List<Box> boxes) throws ProtocolException {
        ByteReader r = new ByteReader(body);
        List<String> palette = r.table();
        long total = 0;
        for (Box b : boxes) total += b.volume();
        if (total > r.remaining()) throw ProtocolException.malformed("snapshot: " + total + " positions can't fit in " + r.remaining() + " bytes");
        List<int[]> states = new ArrayList<>(boxes.size());
        for (Box b : boxes) {
            int[] s = new int[(int) b.volume()];
            for (int i = 0; i < s.length; i++) {
                long v = r.varint();
                if (v >= palette.size()) throw ProtocolException.malformed("snapshot: state index " + v + " outside the palette of " + palette.size());
                s[i] = (int) v;
            }
            states.add(s);
        }
        List<List<BlockEntityNbt>> bes = new ArrayList<>(boxes.size());
        for (int i = 0; i < boxes.size(); i++) bes.add(new ArrayList<>());
        int reg = 0;
        long base = 0;
        for (Ord o : readNbtList(r, total, "snapshot")) {
            while (o.ordinal >= base + states.get(reg).length) base += states.get(reg++).length;
            Box b = boxes.get(reg);
            bes.get(reg).add(new BlockEntityNbt(b.grid().posAt(o.ordinal - base), o.nbt));
        }
        r.expectEnd("snapshot");
        List<SnapshotRegion> regions = new ArrayList<>(boxes.size());
        for (int i = 0; i < boxes.size(); i++) regions.add(new SnapshotRegion(boxes.get(i), states.get(i), bes.get(i)));
        return new SnapshotBody(palette, regions);
    }

    public record SnapshotBody(List<String> palette, List<SnapshotRegion> regions) {}
}
