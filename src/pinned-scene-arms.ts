/**
 * The scene-shaped half of the pin's composer input.
 *
 * `pbr-renderable.ts` composes each renderable from two halves: the material's
 * own feature bits, and the scene's — the environment, tone mapping, fog, and
 * the light mode with its per-kind WGSL. The material half comes from the asset;
 * this module owns the scene half, assembled the way `buildPbrRenderables`
 * assembles it, from the pin's own modules.
 *
 * One module rather than one per consumer: `scene -- compose` sweeps these
 * against the browser's captured fragments, and generation composes the variant
 * table from them. If the two built their inputs separately, a byte-identical
 * sweep would stop proving anything about what was emitted.
 */
import type { PinnedComposeOptions } from "./pinned-pbr-variants.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

/** The light kinds the pin ships a single-light module for. */
export const pinnedSingleLightTypes = [
    "hemispheric",
    "directional",
    "point",
    "spot",
] as const;

export type PinnedSingleLightType = typeof pinnedSingleLightTypes[number];

/** One reachable scene arm: what it is, and the composer input for it. */
export interface PinnedSceneArm {
    /** Human-readable, and the disambiguating half of a variant's file name. */
    label: string;
    lightMode: 0 | 1 | 2;
    /** The single-light kind for `lightMode` 1, empty otherwise. */
    singleLightType: string;
    toneMapping: boolean;
    options: PinnedComposeOptions;
}

export interface PinnedSceneArmRequest {
    /** Which single-light kinds to include an arm for. */
    lightKinds: readonly PinnedSingleLightType[];
    /** Include the multi-light loop arm. */
    multiLight: boolean;
    /** Include the no-light arm. */
    noLight: boolean;
    /** Tone-mapping states to include; `[false]` for a scene without it. */
    toneMapping: readonly boolean[];
    /** Whether the scene has an environment (`PBR_HAS_ENV`). */
    environment: boolean;
}

/**
 * Builds the arms a scene can reach.
 *
 * Each piece is imported rather than written: the multi-light structs and loop
 * come from `multilight-wgsl.js`, each single-light block from its own
 * `singlelight-<kind>-wgsl.js`, and the tone mapping from the pin's
 * `StandardToneMapping` — which is what `pbr-renderable.ts` passes when
 * `scene.imageProcessing.toneMapping` is left at its default. Supplying any of
 * them another way composes a different fragment.
 */
export async function pinnedSceneArms(
    request: PinnedSceneArmRequest,
): Promise<readonly PinnedSceneArm[]> {
    const [bits, multiLight, toneMapping] = await Promise.all([
        importPinnedModule<{ PBR_HAS_ENV: number; PBR_HAS_TONEMAP: number }>(
            "material/pbr/pbr-flag-bits.js",
        ),
        importPinnedModule<{
            MULTI_LIGHT_STRUCTS: () => string;
            COMPUTE_PBR_LIGHT: string;
            getMultiLightLoop: () => string;
        }>("material/pbr/fragments/multilight-wgsl.js"),
        importPinnedModule<{
            StandardToneMapping: { helpersWGSL: string; callWGSL: string };
        }>("material/pbr/tone-mapping.js"),
    ]);
    const multi = {
        multiLightWgsl:
            multiLight.MULTI_LIGHT_STRUCTS() + multiLight.COMPUTE_PBR_LIGHT,
        multiLightLoop: multiLight.getMultiLightLoop(),
    };
    const tone = {
        toneMappingHelpers: toneMapping.StandardToneMapping.helpersWGSL,
        toneMappingCall: toneMapping.StandardToneMapping.callWGSL,
    };
    const singles = await Promise.all(
        request.lightKinds.map(async (type) => {
            const module = await importPinnedModule<{
                SINGLE_LIGHT_STRUCTS: string;
                getSingleLightBlock: () => string;
            }>(`material/pbr/fragments/singlelight-${type}-wgsl.js`);
            return {
                type,
                singleLightWgsl: module.SINGLE_LIGHT_STRUCTS,
                singleLightBlock: module.getSingleLightBlock(),
            };
        }),
    );
    const arms: PinnedSceneArm[] = [];
    for (const toneMappingOn of request.toneMapping) {
        const toneLabel = toneMappingOn ? " +tonemap" : "";
        const sceneFeatures = (request.environment ? bits.PBR_HAS_ENV : 0) |
            (toneMappingOn ? bits.PBR_HAS_TONEMAP : 0);
        const toneOptions = toneMappingOn ? tone : {};
        const push = (
            label: string,
            lightMode: 0 | 1 | 2,
            singleLightType: string,
            lightOptions: PinnedComposeOptions,
        ) => {
            arms.push({
                label: `${label}${toneLabel}`,
                lightMode,
                singleLightType,
                toneMapping: toneMappingOn,
                options: {
                    sceneFeatures,
                    lightMode,
                    ...(singleLightType ? { singleLightType } : {}),
                    ...lightOptions,
                    ...toneOptions,
                },
            });
        };
        if (request.noLight) push("lights 0", 0, "", {});
        for (const single of singles) {
            push("light 1 " + single.type, 1, single.type, {
                singleLightWgsl: single.singleLightWgsl,
                singleLightBlock: single.singleLightBlock,
            });
        }
        if (request.multiLight) push("lights 2", 2, "", multi);
    }
    return arms;
}
