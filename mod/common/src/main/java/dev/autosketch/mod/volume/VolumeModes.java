package dev.autosketch.mod.volume;

import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.protocol.Box;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/** The wand's {@code work} and {@code context} modes (13, *Work and context volumes in-game*). */
public final class VolumeModes {
    private VolumeModes() {}

    public static String size(Box b) {
        return b.sizeX() + "×" + b.sizeY() + "×" + b.sizeZ();
    }

    static String at(BlockPos p) {
        return p.getX() + ", " + p.getY() + ", " + p.getZ();
    }

    /** Left and right click mark the work volume's corners; both set makes it the work volume (a relink). */
    public static final class Work implements WandMode {
        private final VolumeManager volumes;
        private final PlayerStates players;
        private final Feedback feedback;

        public Work(VolumeManager volumes, PlayerStates players, Feedback feedback) {
            this.volumes = volumes;
            this.players = players;
            this.feedback = feedback;
        }

        @Override
        public String name() {
            return "work";
        }

        @Override
        public int colour() {
            return 0x33E05A;
        }

        @Override
        public void setCorner(ServerPlayer player, int corner, BlockPos pos) {
            PlayerStates.Corners c = players.get(player.getUUID()).work;
            if (!c.set(player.serverLevel().dimension(), corner, pos)) {
                feedback.actionBar(player, Component.literal("Autosketch: work corner " + corner + " at " + at(pos)));
                return;
            }
            try {
                volumes.setWork(player.serverLevel(), Box.of(c.first, c.second));
                feedback.actionBar(player, Component.literal("Autosketch: work volume " + size(volumes.work()) + " (link " + volumes.link() + ")"));
            } catch (VolumeManager.Refused e) {
                player.sendSystemMessage(Component.literal("Autosketch: " + e.getMessage()).withStyle(ChatFormatting.RED));
            }
        }

        @Override
        public List<Box> outline(ServerPlayer player) {
            List<Box> out = new ArrayList<>();
            LinkVolumes v = volumes.current();
            if (v != null && v.dimension().equals(player.serverLevel().dimension())) {
                out.add(v.work());
                if (v.extended() != null) out.add(v.extended());
            }
            PlayerStates.Corners c = players.get(player.getUUID()).work;
            pending(c, player, out);
            return out;
        }
    }

    /** Left and right click mark a box that {@code /autosketch context add} adds to the context. */
    public static final class Context implements WandMode {
        private final VolumeManager volumes;
        private final PlayerStates players;
        private final Feedback feedback;

        public Context(VolumeManager volumes, PlayerStates players, Feedback feedback) {
            this.volumes = volumes;
            this.players = players;
            this.feedback = feedback;
        }

        @Override
        public String name() {
            return "context";
        }

        @Override
        public int colour() {
            return 0x3A8DFF;
        }

        @Override
        public void setCorner(ServerPlayer player, int corner, BlockPos pos) {
            PlayerStates.Corners c = players.get(player.getUUID()).context;
            if (c.set(player.serverLevel().dimension(), corner, pos))
                feedback.actionBar(player, Component.literal("Autosketch: context box " + size(Box.of(c.first, c.second)) + " marked; /autosketch context add adds it"));
            else feedback.actionBar(player, Component.literal("Autosketch: context corner " + corner + " at " + at(pos)));
        }

        /** The box marked in context mode, or null. */
        public Box marked(ServerPlayer player) {
            PlayerStates.Corners c = players.get(player.getUUID()).context;
            if (c.first == null || c.second == null || !player.serverLevel().dimension().equals(c.dimension)) return null;
            return Box.of(c.first, c.second);
        }

        public void clearMarked(ServerPlayer player) {
            players.get(player.getUUID()).context.clear();
        }

        @Override
        public List<Box> outline(ServerPlayer player) {
            List<Box> out = new ArrayList<>();
            LinkVolumes v = volumes.current();
            if (v != null && v.dimension().equals(player.serverLevel().dimension())) out.addAll(v.context());
            pending(players.get(player.getUUID()).context, player, out);
            return out;
        }
    }

    /** A half-marked box shows its corner; a fully marked one its box. */
    private static void pending(PlayerStates.Corners c, ServerPlayer player, List<Box> out) {
        if (!player.serverLevel().dimension().equals(c.dimension)) return;
        if (c.first != null && c.second != null) out.add(Box.of(c.first, c.second));
        else if (c.first != null) out.add(Box.of(c.first, c.first));
        else if (c.second != null) out.add(Box.of(c.second, c.second));
    }
}
