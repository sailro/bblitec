/**
 * The clustered-light PBR extensions, registered from the pin's own objects.
 *
 * `light/clustered.ts` bins a large point/spot field into screen-space
 * clusters on the CPU and shades it from three data textures plus a params
 * block. Composition needs only the two `PbrExt` records: their `detect`
 * reads `_clusteredLightState` off the material, and their `frag` builds the
 * block from `clustered-light-wgsl.ts`.
 *
 * **Neither ext is exported.** Upstream registers them from the scene calls
 * that reach the feature — `addClusteredLightContainer` for the point one and
 * `createClusteredSpotLight` (through `_enableClusteredSpotSupport`) for the
 * spot one — because that is where a bundle learns it needs them. Calling
 * either here would drag in `buildClusteredLightGpuState` and a real device,
 * so the ext objects are lifted out of their modules instead, the way the DDS
 * loader's module-local `computeSH` is: what runs is still the pin's own
 * record, and a pin that renames or drops one fails here by name.
 *
 * Registration is unconditional, on the argument that already licenses the
 * environment extension's: both `detect` hooks return `{f: 0, f2: 0}` for a
 * material carrying no `_clusteredLightState`, and every material in a scene
 * that never reaches the feature carries none — so a non-clustered variant
 * composes identically either way, while gating the registration would make
 * the process-global registry depend on which scene composed first.
 */
import { importPinnedModuleWithExports } from "./pinned-shader-composer.js";

/** The shape `_computePbrMaterialFeatures` reads through each ext's `detect`. */
export interface PinnedClusteredMarker {
    /** Set once the container held spot lights when its GPU state was built. */
    _hasSpots?: true;
}

interface PbrExtRecord {
    readonly id: string;
}

/**
 * The pin's own two extension records, in the order upstream registers them.
 *
 * The point ext yields to the spot one on the same material: its `detect`
 * answers `state && !state._hasSpots`, because the spot shader's stride-3
 * layout carries point lights too (`w < 0` in the third texel means point).
 */
export async function pinnedClusteredLightExtensions(): Promise<
    readonly PbrExtRecord[]
> {
    const [point, spot] = await Promise.all([
        importPinnedModuleWithExports<{
            clusteredPointPbrExt: PbrExtRecord;
        }>("light/clustered.js", ["clusteredPointPbrExt"]),
        importPinnedModuleWithExports<{
            clusteredSpotPbrExt: PbrExtRecord;
        }>("light/clustered-spot-support.js", ["clusteredSpotPbrExt"]),
    ]);
    return [point.clusteredPointPbrExt, spot.clusteredSpotPbrExt];
}
