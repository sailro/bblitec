/**
 * The pin's scene-code material option defaults, stated once.
 *
 * Each pinned UBO writer guards its optional properties with `?? <default>`,
 * and the record-mapped lowering discards that fallback ("the record always
 * carries a value") — so the same numbers were restated as bare literals in
 * `src/compiler/intrinsics/material-options.ts` (and the pure-2D particle
 * bridge's in `intrinsics/particle.ts`) with nothing tying either copy to
 * the pin. A pin bump that moved one default moved the browser reference and
 * not the native record: a silent parity split visible only when a corpus
 * scene omits that exact option.
 *
 * This table is the one copy serving both ends:
 *
 * - `pinned-ubo-writer-lowerer.ts` evaluates the pin's own discarded default
 *   at the discard site and asserts it equals the entry here, so a pin that
 *   moves a default fails generation naming the property and both values.
 * - The intrinsics read their defaults from the same entries through the
 *   shared literal helpers, so the record seed IS the asserted number.
 *
 * Entries the writers never discard (the pure-2D bridge quartet) are
 * anchored instead by `node-particle-lowerer.ts`, which asserts the pinned
 * declarations' `?? <default>` shapes against the values here.
 */
import { floatLiteral } from "../cpp-literals.js";

export interface PinnedMaterialDefault {
    /**
     * `<pinned module>#<writer symbol>#<property>` — the key the UBO-writer
     * lowerer builds at a mapped `?? default` discard site, or the pinned
     * declaration a non-writer anchor reads.
     */
    readonly pinned: string;
    /** The pin's fallback, as the intrinsics restate it. */
    readonly value: number | boolean | readonly number[];
    /**
     * Other pin sites' fallbacks for the same property, accepted by the
     * discard assert. `writeRefractionUBO` reads `thick?.max` twice — `?? 1`
     * at the thickness lanes (the arm the intrinsic mirrors) and `?? 0.0`
     * under its thickness-as-depth conditional.
     */
    readonly alsoPinned?: readonly (number | readonly number[])[];
}

const clearcoatModule = "src/material/pbr/fragments/clearcoat-fragment.ts";
const iridescenceModule = "src/material/pbr/fragments/iridescence-fragment.ts";
const sheenModule = "src/material/pbr/fragments/sheen-fragment.ts";
const anisotropyModule = "src/material/pbr/fragments/anisotropy-fragment.ts";
const reflectanceModule = "src/material/pbr/fragments/reflectance-fragment.ts";
const subsurfaceModule = "src/material/pbr/fragments/subsurface-fragment.ts";
const refractionModule =
    "src/material/pbr/fragments/refraction-rtt-fragment.ts";
const baseWriterModule = "src/material/pbr/pbr-renderable.ts";
const sprite2dBridgeModule = "src/particle/particle-sprite-2d.ts";
const particleSceneModule = "src/particle/particle-scene.ts";

const PINNED_MATERIAL_DEFAULTS = {
    // ------------------------------------------------------------------
    // `_writeMaterialData` — the base PBR writer's own `?? d` fallbacks,
    // restated by `compilePbrMaterialOptions`.
    // ------------------------------------------------------------------
    pbrEnvironmentIntensity: {
        pinned: `${baseWriterModule}#_writeMaterialData#environmentIntensity`,
        value: 1,
    },
    pbrDirectIntensity: {
        pinned: `${baseWriterModule}#_writeMaterialData#directIntensity`,
        value: 1,
    },
    pbrReflectance: {
        pinned: `${baseWriterModule}#_writeMaterialData#reflectance`,
        value: 0.04,
    },
    pbrAlpha: {
        pinned: `${baseWriterModule}#_writeMaterialData#alpha`,
        value: 1,
    },
    pbrMetallicFactor: {
        pinned: `${baseWriterModule}#_writeMaterialData#metallicFactor`,
        value: 1,
    },
    pbrRoughnessFactor: {
        pinned: `${baseWriterModule}#_writeMaterialData#roughnessFactor`,
        value: 1,
    },
    /** glTF-lane only — no scene-code setter names it; anchored anyway. */
    pbrNormalTextureScale: {
        pinned: `${baseWriterModule}#_writeMaterialData#normalTextureScale`,
        value: 1,
    },
    // ------------------------------------------------------------------
    // `writeClearcoatUBO` — restated by `compileClearCoatOptions`.
    // ------------------------------------------------------------------
    clearcoatIntensity: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#intensity`,
        value: 1,
    },
    clearcoatRoughness: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#roughness`,
        value: 0,
    },
    clearcoatIndexOfRefraction: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#indexOfRefraction`,
        value: 1.5,
    },
    clearcoatBumpTextureScale: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#bumpTextureScale`,
        value: 1,
    },
    // ------------------------------------------------------------------
    // `writeIridescenceUBO` — restated by `compileIridescenceOptions`.
    // ------------------------------------------------------------------
    iridescenceIntensity: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#intensity`,
        value: 1,
    },
    iridescenceIndexOfRefraction: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#indexOfRefraction`,
        value: 1.3,
    },
    iridescenceMinimumThickness: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#minimumThickness`,
        value: 100,
    },
    iridescenceMaximumThickness: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#maximumThickness`,
        value: 400,
    },
    // ------------------------------------------------------------------
    // `writeSheenUBO` — restated by `compileSheenOptions`.
    // ------------------------------------------------------------------
    sheenColor: {
        pinned: `${sheenModule}#writeSheenUBO#color`,
        value: [1, 1, 1],
    },
    sheenIntensity: {
        pinned: `${sheenModule}#writeSheenUBO#intensity`,
        value: 1,
    },
    sheenRoughness: {
        pinned: `${sheenModule}#writeSheenUBO#roughness`,
        value: 0,
    },
    // ------------------------------------------------------------------
    // The anisotropy extension's `pbrExt.writeUbo` — restated by
    // `compileAnisotropyOptions`.
    // ------------------------------------------------------------------
    anisotropyIntensity: {
        pinned: `${anisotropyModule}#pbrExt.writeUbo#intensity`,
        value: 1,
    },
    anisotropyDirection: {
        pinned: `${anisotropyModule}#pbrExt.writeUbo#direction`,
        value: [1, 0],
    },
    // ------------------------------------------------------------------
    // `writeReflectanceUBO` — restated by `compilePbrMaterialOptions`.
    // ------------------------------------------------------------------
    occlusionStrength: {
        pinned: `${reflectanceModule}#writeReflectanceUBO#occlusionStrength`,
        value: 1,
    },
    metallicF0Factor: {
        pinned: `${reflectanceModule}#writeReflectanceUBO#_metallicF0Factor`,
        value: 1,
    },
    /**
     * Ground state of the pin's chained fallback
     * `_specularWeight ?? _metallicF0Factor ?? 1.0`: the discard assert
     * folds a nested `??` to the all-absent arm, so this anchors the
     * terminal constant. No intrinsic reads it — the loader seeds the
     * record's `specular_weight` through the same chain.
     */
    specularWeight: {
        pinned: `${reflectanceModule}#writeReflectanceUBO#_specularWeight`,
        value: 1,
    },
    // ------------------------------------------------------------------
    // `writeSubsurfaceUBO` — restated by `compileSubsurfaceOptions`.
    // ------------------------------------------------------------------
    subsurfaceIntensity: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#intensity`,
        value: 1,
    },
    subsurfaceColor: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#color`,
        value: [1, 1, 1],
    },
    subsurfaceDiffusionDistance: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#diffusionDistance`,
        value: [1, 1, 1],
    },
    subsurfaceMinimumThickness: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#min`,
        value: 0,
    },
    subsurfaceMaximumThickness: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#max`,
        value: 1,
    },
    // ------------------------------------------------------------------
    // `writeRefractionUBO` — restated by `compilePbrMaterialOptions`'s
    // subsurface/refraction lanes.
    // ------------------------------------------------------------------
    transmissionIntensity: {
        pinned: `${refractionModule}#writeRefractionUBO#intensity`,
        value: 0,
    },
    transmissionIndexOfRefraction: {
        pinned: `${refractionModule}#writeRefractionUBO#indexOfRefraction`,
        value: 1.5,
    },
    transmissionThicknessMax: {
        pinned: `${refractionModule}#writeRefractionUBO#max`,
        value: 1,
        // The thickness-as-depth lane reads the same property under
        // `?? 0.0`; the intrinsic mirrors the `?? 1` thickness arm.
        alsoPinned: [0],
    },
    attenuationColor: {
        pinned: `${refractionModule}#writeRefractionUBO#color`,
        value: [1, 1, 1],
    },
    attenuationDistance: {
        pinned: `${refractionModule}#writeRefractionUBO#atDistance`,
        value: 1,
    },
    /** glTF-lane only (KHR_materials_dispersion); anchored, not restated. */
    dispersion: {
        pinned: `${refractionModule}#writeRefractionUBO#dispersion`,
        value: 0,
    },
    // ------------------------------------------------------------------
    // The pure-2D particle bridge's mapping defaults — restated by
    // `intrinsics/particle.ts` and anchored by `node-particle-lowerer.ts`
    // against the pinned declarations named here (they never pass through
    // a UBO writer's discard site).
    // ------------------------------------------------------------------
    sprite2dPixelsPerUnit: {
        pinned:
            `${sprite2dBridgeModule}#createParticleSprite2DBridge` +
            "#pixelsPerUnit",
        value: 1,
    },
    sprite2dOriginPx: {
        pinned:
            `${sprite2dBridgeModule}#createParticleSprite2DBridge#originPx`,
        value: [0, 0],
    },
    sprite2dInvertY: {
        pinned:
            `${sprite2dBridgeModule}#createParticleSprite2DBridge#invertY`,
        value: true,
    },
    sprite2dAutoStart: {
        pinned:
            `${sprite2dBridgeModule}#registerNodeParticleSet2D#autoStart`,
        value: true,
    },
    /** The 3D registrar's own `options.autoStart ?? true`. */
    nodeParticleAutoStart: {
        pinned:
            `${particleSceneModule}#registerNodeParticleSet#autoStart`,
        value: true,
    },
} as const satisfies Record<string, PinnedMaterialDefault>;

export type PinnedMaterialDefaultName = keyof typeof PINNED_MATERIAL_DEFAULTS;

/** The discard-site lookup, by the `pinned` key each entry names. */
const byPinnedKey = new Map<string, PinnedMaterialDefault>();
for (const entry of Object.values(PINNED_MATERIAL_DEFAULTS)) {
    if (byPinnedKey.has(entry.pinned)) {
        throw new Error(
            `PINNED_MATERIAL_DEFAULTS names '${entry.pinned}' twice.`,
        );
    }
    byPinnedKey.set(entry.pinned, entry);
}

/**
 * The entry a UBO-writer discard site should assert against, if the table
 * carries one for `<module>#<writer>#<property>`.
 */
export function pinnedDefaultForDiscard(
    key: string,
): PinnedMaterialDefault | undefined {
    return byPinnedKey.get(key);
}

function entry(name: PinnedMaterialDefaultName): PinnedMaterialDefault {
    return PINNED_MATERIAL_DEFAULTS[name];
}

/** A scalar default, for the manifest values the intrinsics record. */
export function pinnedDefaultNumber(
    name: PinnedMaterialDefaultName,
): number {
    const { value } = entry(name);
    if (typeof value !== "number") {
        throw new Error(
            `Pinned material default '${name}' is not a scalar.`,
        );
    }
    return value;
}

/** A boolean default (the bridge's `invertY`/`autoStart`). */
export function pinnedDefaultFlag(
    name: PinnedMaterialDefaultName,
): boolean {
    const { value } = entry(name);
    if (typeof value !== "boolean") {
        throw new Error(
            `Pinned material default '${name}' is not a flag.`,
        );
    }
    return value;
}

function vectorValue(
    name: PinnedMaterialDefaultName,
    lanes: number,
): readonly number[] {
    const { value } = entry(name);
    if (!Array.isArray(value) || value.length !== lanes) {
        throw new Error(
            `Pinned material default '${name}' is not a ${lanes}-lane ` +
                "vector.",
        );
    }
    return value;
}

/** A three-lane default, typed the way the manifests carry colours. */
export function pinnedDefaultColor3(
    name: PinnedMaterialDefaultName,
): readonly [number, number, number] {
    return vectorValue(name, 3) as readonly [number, number, number];
}

/** A two-lane default (the anisotropy direction, the bridge origin). */
export function pinnedDefaultVec2(
    name: PinnedMaterialDefaultName,
): readonly [number, number] {
    return vectorValue(name, 2) as readonly [number, number];
}

/** A scalar default as the shared C++ float literal. */
export function pinnedDefaultFloatCpp(
    name: PinnedMaterialDefaultName,
): string {
    return floatLiteral(pinnedDefaultNumber(name));
}

/** A three-lane default as the `bbl::Color3{...}` the intrinsics emit. */
export function pinnedDefaultColor3Cpp(
    name: PinnedMaterialDefaultName,
): string {
    return `bbl::Color3{${
        pinnedDefaultColor3(name).map(floatLiteral).join(", ")
    }}`;
}

/** A two-lane default as the `bbl::Vec2{...}` the intrinsics emit. */
export function pinnedDefaultVec2Cpp(
    name: PinnedMaterialDefaultName,
): string {
    return `bbl::Vec2{${
        pinnedDefaultVec2(name).map(floatLiteral).join(", ")
    }}`;
}
