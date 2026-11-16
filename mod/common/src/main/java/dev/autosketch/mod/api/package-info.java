/**
 * The extension points the mod's silos code against (docs/briefs/world/README.md, *Mod skeleton*
 * contract). Owned by silo N. Package split: {@code bridge}, {@code volume}, {@code command},
 * {@code protocol}, {@code api} (N); {@code world} (O: snapshots, hashes, patches, change tracker);
 * {@code prompt} (S: in-game requests, focus mode, chat). Each silo registers through
 * {@link dev.autosketch.mod.api.AutosketchSetup} from its own package (on NeoForge, by subscribing
 * to {@code AutosketchSetupEvent}). The {@code api} package spans both modules: everything is in
 * {@code common} except {@code AutosketchSetupEvent}, which is in {@code neoforge}.
 */
@ParametersAreNonnullByDefault
package dev.autosketch.mod.api;

import javax.annotation.ParametersAreNonnullByDefault;
