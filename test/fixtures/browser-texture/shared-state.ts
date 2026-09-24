/** Module state another fixture module writes through an import. */
import type { Texture2D } from "@babylonjs/lite";

export const sharedTiles: { last?: Texture2D } = {};
