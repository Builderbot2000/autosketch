package dev.autosketch.mod.gametest;

import com.mojang.brigadier.tree.CommandNode;
import dev.autosketch.mod.api.Autosketch;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * In-game checks of the skeleton: the services are installed after setup, and {@code /autosketch}
 * is registered and requires op level 2 (13, *Connection*, "Permissions"). Template
 * {@code autosketch:empty} is a synthetic 3×3×3 of air.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class SkeletonGameTests {
    private SkeletonGameTests() {}

    @GameTest(template = "empty")
    public static void commandRootRequiresOpLevel2(GameTestHelper helper) {
        CommandNode<CommandSourceStack> node = helper.getLevel().getServer().getCommands().getDispatcher().getRoot().getChild("autosketch");
        helper.assertTrue(node != null, "/autosketch is registered");
        helper.assertTrue(node.getChild("status") != null, "/autosketch status is registered");
        CommandSourceStack source = helper.getLevel().getServer().createCommandSourceStack();
        helper.assertTrue(node.canUse(source.withPermission(2)), "op level 2 may use it");
        helper.assertFalse(node.canUse(source.withPermission(1)), "op level 1 may not");
        helper.succeed();
    }

    @GameTest(template = "empty")
    public static void servicesInstalledAndUnlinked(GameTestHelper helper) {
        helper.assertFalse(Autosketch.bridge().connected(), "no MCP connected in a test server");
        helper.assertTrue(Autosketch.link().current() == null, "no work volume set");
        helper.assertTrue(Autosketch.patchStatus().pending() == 0, "no pending patches");
        helper.succeed();
    }
}
