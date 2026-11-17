package dev.autosketch.mod.gametest.client.link;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;

/**
 * The client's link state follows the MCP (16, *Mod side*; briefs/ui/L): connected with an MCP that
 * lists {@code ui}, offline when it goes, too old when an MCP without {@code ui} connects. The state
 * travels from the server half as op {@code LINK} on {@code autosketch:ui} into {@link LinkState}.
 */
public final class LinkStateClientTests {
    private LinkStateClientTests() {}

    private static ClientTestSuite.Condition is(LinkState.State want) {
        return () -> {
            check(LinkState.get() == want, "link state " + LinkState.get() + ", want " + want);
            return true;
        };
    }

    @ClientTest("link")
    public static void linkStateFollowsTheMcp(ClientTestSuite s) {
        s.waitUntil("connected with the suite's MCP (ui listed)", is(LinkState.State.CONNECTED), 200);
        s.step("the MCP goes away", s::stopMcp);
        s.waitUntil("offline", is(LinkState.State.OFFLINE), 200);
        s.step("an MCP without ui connects", () -> s.startMcp("{\"hello\":{\"features\":[\"prompt.close\"]}}"));
        s.waitUntil("too old", is(LinkState.State.TOO_OLD), 400);
        s.step("the old MCP goes away", s::stopMcp);
        s.waitUntil("offline again", is(LinkState.State.OFFLINE), 200);
        s.step("an MCP with ui connects", () -> s.startMcp("{}"));
        s.waitUntil("connected again", is(LinkState.State.CONNECTED), 400);
    }
}
