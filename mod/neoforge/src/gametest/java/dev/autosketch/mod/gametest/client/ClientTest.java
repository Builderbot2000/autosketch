package dev.autosketch.mod.gametest.client;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a client test (16, *Testing*, client half): a {@code public static void name(ClientTestSuite s)}
 * method that adds its steps to the named suite. The driver finds these through the mod's scan data,
 * so a feature silo adds tests in its own package ({@code client/overlay/}, {@code client/ghost/}, …)
 * without editing the driver. Tests of one suite share one client boot and one fake MCP, in the order
 * of their class and method names.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface ClientTest {
    /** The suite's name; its fake MCP script is {@code clienttest/<suite>.json} on the gametest classpath. */
    String value();
}
