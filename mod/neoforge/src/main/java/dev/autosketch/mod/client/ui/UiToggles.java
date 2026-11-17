package dev.autosketch.mod.client.ui;

/**
 * What the player chose to show (16, *Autosketch menu and key bindings*): the HUD, job volumes,
 * change flashes and ghosts. Read by the overlays, HUD and ghosts (silos O and G) before drawing;
 * written by the menu (S) and the toggle keys ({@link AutosketchKeys}). All on by default; kept for
 * the game session. Client thread.
 */
public final class UiToggles {
    private UiToggles() {}

    public static volatile boolean hud = true;
    public static volatile boolean volumes = true;
    public static volatile boolean flashes = true;
    public static volatile boolean ghosts = true;

    public static void toggleHud() {
        hud = !hud;
    }

    public static void toggleVolumes() {
        volumes = !volumes;
    }

    public static void toggleFlashes() {
        flashes = !flashes;
    }

    public static void toggleGhosts() {
        ghosts = !ghosts;
    }
}
