package dev.autosketch.mod.client.ui.chat.mixin;

import java.util.List;
import net.minecraft.client.GuiMessage;
import net.minecraft.client.gui.components.ChatComponent;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/**
 * Chat's message list, so the client half can replace a line it added (19, *Status line*: "the
 * client half owns the lines it adds, so it can"). Vanilla only deletes signed messages, leaving a
 * placeholder; this swaps the {@link GuiMessage} at its index and re-wraps the display lines.
 * 1.21.1: {@code allMessages} (newest first) and {@code refreshTrimmedMessages()} are where a port
 * looks first.
 */
@Mixin(ChatComponent.class)
public interface ChatComponentAccess {
    @Accessor("allMessages")
    List<GuiMessage> autosketch$allMessages();

    @Invoker("refreshTrimmedMessages")
    void autosketch$refreshTrimmedMessages();
}
