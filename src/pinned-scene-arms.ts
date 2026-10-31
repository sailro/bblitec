/**
 * The scene-shaped half of the pin's composer input.
 *
 * `pbr-renderable.ts` composes each renderable from two halves: the material's
 * own feature bits, and the scene's — the environment, tone mapping, fog, and
 * the light mode with its per-kind WGSL. The material half comes from the asset;
 * this module owns the scene half, assembled the way `buildPbrRenderables`
 * assembles it, from the pin's own modules.
 *
 * One module rather than one per consumer: `scene -- diff --compose` sweeps these
 * against the browser's captured fragments, and generation composes the variant
 * table from them. If the two built their inputs separately, a byte-identical
 * sweep would stop proving anything about what was emitted.
 */
import type { LightKind } from "./compiler/types.js";
import type { PinnedComposeOptions } from "./pinned-pbr-variants.js";
import {
    pinnedAreaPbrLighting,
    rectAreaLightingModes,
    type RectAreaLightingMode,
} from "./pinned-rect-area-lights.js";
import { importPinnedModule } from "./pinned-shader-composer.js";
import {
    defaultToneMappingName,
    pinnedToneMapping,
} from "./pinned-tone-mapping.js";

/** One reachable scene arm: what it is, and the composer input for it. */
export interface PinnedSceneArm {
    /** Human-readable, and the disambiguating half of a variant's file name. */
    label: string;
    lightMode: 0 | 1 | 2;
    /** The single-light kind for `lightMode` 1, empty otherwise. */
    singleLightType: string;
    toneMapping: boolean;
    /**
     * The scene's area lighting this arm composes under, as its
     * `rectAreaLightingModes` index; absent in a program that never enables
     * area lighting, whose keys carry no area lane.
     */
    areaLighting?: number;
    /**
     * An installed area lighting's scene bits with `RECT_AREA_PBR_SELECTED`
     * added: what the arm's renderables compose under when an area light
     * reaches them, which only the layered-BRDF refusal reads.
     */
    areaSelectedFeatures?: number;
    options: PinnedComposeOptions;
}

interface PinnedSceneArmRequest {
    /** Which single-light kinds to include an arm for. */
    lightKinds: readonly LightKind[];
    /**
     * The area lightings a scene of the program can draw under
     * (`reachedRectAreaLightings`). An installed one is
     * `enableRectAreaLights(scene)`'s lighting extension: `pbr-renderable.ts`
     * then takes the multi-light loop and the rectangular single-light
     * source from `scene._lighting`, and ORs the extension's `_pbrFeatures`
     * into every renderable's scene bits.
     */
    rectAreaLightings?: readonly RectAreaLightingMode[];
    /** Include the multi-light loop arm. */
    multiLight: boolean;
    /** Include the no-light arm. */
    noLight: boolean;
    /** Tone-mapping states to include; `[false]` for a scene without it. */
    toneMapping: readonly boolean[];
    /**
     * The pinned tone-mapping export the scene selected, or undefined for the
     * pin's own default -- which is exactly what `pbr-renderable.ts` composes
     * for an unset `imageProcessing.toneMapping`.
     */
    toneMappingName?: string;
    /** Whether the scene has an environment (`PBR_HAS_ENV`). */
    environment: boolean;
    /** Whether the scene reaches fog (`PBR_HAS_FOG`); the composed fog arm's
     *  helper and block are lifted from the pin unconditionally, and this bit
     *  is what makes the composer insert them. */
    fog: boolean;
}

/**
 * Builds the arms a scene can reach.
 *
 * Each piece is imported rather than written: the multi-light structs and loop
 * come from `multilight-wgsl.js`, each single-light block from its own
 * `singlelight-<kind>-wgsl.js`, and the tone mapping from the record the scene
 * selected — `pbr-renderable.ts` composes
 * `scene.imageProcessing.toneMapping ?? StandardToneMapping`, so an unset
 * selection reaches the pin's own default here for the same reason. Supplying
 * any of them another way composes a different fragment.
 */
export async function pinnedSceneArms(
    request: PinnedSceneArmRequest,
): Promise<readonly PinnedSceneArm[]> {
    const [bits, multiLight] = await Promise.all([
        importPinnedModule<{
            PBR_HAS_ENV: number;
            PBR_HAS_TONEMAP: number;
            PBR_HAS_FOG: number;
        }>("material/pbr/pbr-flag-bits.js"),
        importPinnedModule<{
            MULTI_LIGHT_STRUCTS: () => string;
            COMPUTE_PBR_LIGHT: string;
            getMultiLightLoop: () => string;
        }>("material/pbr/fragments/multilight-wgsl.js"),
    ]);
    const toneMapping = pinnedToneMapping(
        request.toneMappingName ?? defaultToneMappingName,
    );
    // The whole record, because the composer takes the whole record: a tone
    // mapping is a value upstream, and splitting it here is what let its
    // dependency key move without anything noticing.
    const tone = { toneMapping };
    const arms: PinnedSceneArm[] = [];
    for (const mode of request.rectAreaLightings ?? [undefined]) {
        // `scene._lighting` when the scene enabled area lighting: its
        // multi-light contribution replaces the module's, its single source
        // answers the rectangular type, and its `_pbrFeatures` adds the
        // scene bits.
        const area =
            mode === undefined || mode === "none"
                ? undefined
                : await pinnedAreaPbrLighting(mode);
        const areaMulti = area?.multi();
        const multi = areaMulti
            ? {
                  multiLightWgsl: areaMulti._helpers,
                  multiLightLoop: areaMulti._loop,
              }
            : {
                  multiLightWgsl:
                      multiLight.MULTI_LIGHT_STRUCTS() +
                      multiLight.COMPUTE_PBR_LIGHT,
                  multiLightLoop: multiLight.getMultiLightLoop(),
              };
        // `scene._lighting?._single?.(type) ?? importSingleLightWgsl(type)`.
        // A rectangular light in a scene that never enabled area lighting
        // has no single source at all: its `_validateLighting` throws at
        // registration (natively too) before any renderable composes, so it
        // has no arm.
        const singleKinds = request.lightKinds.filter(
            (type) => type !== "rectArea" || area !== undefined,
        );
        const singles = await Promise.all(
            singleKinds.map(async (type) => {
                const module =
                    area?.single(type) ??
                    (await importPinnedModule<{
                        SINGLE_LIGHT_STRUCTS: string;
                        getSingleLightBlock: () => string;
                    }>(`material/pbr/fragments/singlelight-${type}-wgsl.js`));
                return {
                    type,
                    singleLightWgsl: module.SINGLE_LIGHT_STRUCTS,
                    singleLightBlock: module.getSingleLightBlock(),
                };
            }),
        );
        const areaKey =
            mode === undefined
                ? {}
                : { areaLighting: rectAreaLightingModes.indexOf(mode) };
        const areaLabel = area ? ` +area ${mode}` : "";
        for (const toneMappingOn of request.toneMapping) {
            const toneLabel = toneMappingOn ? " +tonemap" : "";
            const sceneFeatures =
                (request.environment ? bits.PBR_HAS_ENV : 0) |
                (request.fog ? bits.PBR_HAS_FOG : 0) |
                (toneMappingOn ? bits.PBR_HAS_TONEMAP : 0) |
                (area?.sceneFeatures ?? 0);
            const toneOptions = toneMappingOn ? tone : {};
            const push = (
                label: string,
                lightMode: 0 | 1 | 2,
                singleLightType: string,
                lightOptions: PinnedComposeOptions,
            ) => {
                arms.push({
                    label: `${label}${areaLabel}${toneLabel}`,
                    lightMode,
                    singleLightType,
                    toneMapping: toneMappingOn,
                    ...areaKey,
                    ...(area
                        ? {
                              areaSelectedFeatures:
                                  sceneFeatures | area.selected,
                          }
                        : {}),
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
    }
    return arms;
}
