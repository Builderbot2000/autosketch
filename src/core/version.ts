/** Minecraft release → world DataVersion (written into documents and exports, see 01/08). */
const DATA_VERSIONS: Record<string, number> = {
  "1.20.1": 3465,
  "1.20.2": 3578,
  "1.20.4": 3700,
  "1.20.6": 3839,
  "1.21": 3953,
  "1.21.1": 3955,
  "1.21.3": 4082,
  "1.21.4": 4189,
  "1.21.5": 4325,
};

export function dataVersionFor(mcVersion: string): number | undefined {
  return DATA_VERSIONS[mcVersion];
}
