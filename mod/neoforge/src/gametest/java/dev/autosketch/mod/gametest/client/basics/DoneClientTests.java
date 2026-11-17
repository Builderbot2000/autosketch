package dev.autosketch.mod.gametest.client.basics;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.util.List;

/**
 * {@code /autosketch done} typed by the player (13, B6; {@code docs/briefs/world/test-setup.md} step
 * 8): the mod says it is ending the request, sends {@code prompt.close} naming the player to the MCP,
 * and the MCP's answer (scripted in {@code clienttest/basics.json}) reaches the action bar.
 */
public final class DoneClientTests {
    private DoneClientTests() {}

    @ClientTest("basics")
    public static void doneSendsPromptCloseAndShowsTheAnswer(ClientTestSuite s) {
        int[] before = new int[1];
        s.step("notices on, then /autosketch done", () -> {
            s.command("autosketch notices on");
            before[0] = s.mcp().received("prompt.close").size();
            s.clearMessages();
            s.command("autosketch done");
        });
        s.waitUntil("the action bar says the request is being ended", () -> {
            check(s.actionBarHas("ending the open request"), "action bar: " + s.actionBar());
            return true;
        }, 100);
        s.waitUntil("the MCP received prompt.close naming the player", () -> {
            List<JsonObject> closes = s.mcp().received("prompt.close");
            check(closes.size() > before[0], "prompt.close frames: " + closes);
            JsonObject player = closes.get(closes.size() - 1).getAsJsonObject("player");
            check(player != null && player.get("uuid").getAsString().equals(s.player().getUUID().toString()), "player " + player);
            return true;
        }, 100);
        s.waitUntil("the MCP's notice is on the action bar", () -> {
            check(s.actionBarHas("no ask, plan or scan request is open"), "action bar: " + s.actionBar());
            return true;
        }, 100);
    }
}
