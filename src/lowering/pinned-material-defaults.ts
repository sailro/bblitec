/**
 * The pin's scene-code material option defaults, read from the pin.
 *
 * Each pinned UBO writer guards its optional properties with `?? <default>`,
 * and the record-mapped lowering discards that fallback ("the record always
 * carries a value") — so the intrinsics that seed the native record
 * (`src/compiler/intrinsics/material-options.ts`, the pure-2D particle
 * bridge in `intrinsics/particle.ts`) and the glTF material projection's
 * absent keys (`gltf/material-projection.ts`) need the same numbers. This table names
 * WHERE each default is written; its value is the pin's own `?? <default>`
 * at that site, folded here, so the record seed cannot drift from the pin.
 *
 * - `pinned-ubo-writer-lowerer.ts` asks at every discard site whether the
 *   property is anchored here, so a writer growing a default no intrinsic
 *   seeds fails generation by name.
 * - `node-particle-lowerer.ts` asserts the pure-2D bridge's `?? <default>`
 *   shapes, which the entries below also read.
 */
import ts from "typescript";
import { floatLiteral } from "../cpp-literals.js";
import {
    nullishDefault,
    sharedPinnedContext,
    unwrapExpression,
    type LoweringContext,
} from "./context.js";
import {
    pinnedDefaultValue,
    samePinnedDefault,
    type PinnedDefaultValue,
} from "./pinned-option-defaults.js";

export interface PinnedMaterialDefault {
    /**
     * `<pinned module>#<writer symbol>#<property>` — the key the UBO-writer
     * lowerer builds at a mapped `?? default` discard site, or the pinned
     * declaration a non-writer anchor reads.
     */
    readonly pinned: string;
    /**
     * The pin states more than one default for this property: the one the
     * intrinsic mirrors is the default of the local the pin binds under the
     * property's own name, and the others read the same record value.
     * `writeRefractionUBO` binds `const max = thick?.max ?? 1` for its
     * thickness lanes and reads `thick?.max ?? 0.0` under its
     * thickness-as-depth conditional. A property whose sites disagree
     * without this is refused.
     */
    readonly divergentSites?: true;
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
const alphaTestModule = "src/material/pbr/fragments/alpha-test-fragment.ts";
const unlitModule = "src/material/pbr/fragments/unlit-fragment.ts";
const shadowOnlyModule = "src/material/pbr/fragments/shadow-only-fragment.ts";
const sprite2dBridgeModule = "src/particle/particle-sprite-2d.ts";
const particleSceneModule = "src/particle/particle-scene.ts";

const PINNED_MATERIAL_DEFAULTS = {
    // `_writeMaterialData` — the base PBR writer, seeded by
    // `compilePbrMaterialOptions`.
    pbrEnvironmentIntensity: {
        pinned: `${baseWriterModule}#_writeMaterialData#environmentIntensity`,
    },
    pbrDirectIntensity: {
        pinned: `${baseWriterModule}#_writeMaterialData#directIntensity`,
    },
    pbrReflectance: {
        pinned: `${baseWriterModule}#_writeMaterialData#reflectance`,
    },
    pbrAlpha: { pinned: `${baseWriterModule}#_writeMaterialData#alpha` },
    pbrMetallicFactor: {
        pinned: `${baseWriterModule}#_writeMaterialData#metallicFactor`,
    },
    pbrRoughnessFactor: {
        pinned: `${baseWriterModule}#_writeMaterialData#roughnessFactor`,
    },
    /** glTF-lane only — no scene-code setter names it; anchored anyway. */
    pbrNormalTextureScale: {
        pinned: `${baseWriterModule}#_writeMaterialData#normalTextureScale`,
    },
    /** The alpha-test extension's cutoff, absent on a non-MASK glTF material. */
    alphaCutOff: { pinned: `${alphaTestModule}#pbrExt.writeUbo#_alphaCutOff` },
    /** `writeUnlitUBO`'s tint, absent unless the unlit setter was given one. */
    unlitColor: { pinned: `${unlitModule}#writeUnlitUBO#_unlitColor` },
    // `writeShadowOnlyUBO` — seeded whole by the shadow-only factory.
    shadowOnlyColor: {
        pinned: `${shadowOnlyModule}#writeShadowOnlyUBO#_shadowOnlyColor`,
    },
    shadowOnlyOpacity: {
        pinned: `${shadowOnlyModule}#writeShadowOnlyUBO#_shadowOnlyOpacity`,
    },
    shadowOnlyFalloff: {
        pinned: `${shadowOnlyModule}#writeShadowOnlyUBO#_shadowOnlyFalloff`,
    },
    // `writeClearcoatUBO` — seeded by `compileClearCoatOptions`.
    clearcoatIntensity: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#intensity`,
    },
    clearcoatRoughness: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#roughness`,
    },
    clearcoatIndexOfRefraction: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#indexOfRefraction`,
    },
    clearcoatBumpTextureScale: {
        pinned: `${clearcoatModule}#writeClearcoatUBO#bumpTextureScale`,
    },
    // `writeIridescenceUBO` — seeded by `compileIridescenceOptions`.
    iridescenceIntensity: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#intensity`,
    },
    iridescenceIndexOfRefraction: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#indexOfRefraction`,
    },
    iridescenceMinimumThickness: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#minimumThickness`,
    },
    iridescenceMaximumThickness: {
        pinned: `${iridescenceModule}#writeIridescenceUBO#maximumThickness`,
    },
    // `writeSheenUBO` — seeded by `compileSheenOptions`.
    sheenColor: { pinned: `${sheenModule}#writeSheenUBO#color` },
    sheenIntensity: { pinned: `${sheenModule}#writeSheenUBO#intensity` },
    sheenRoughness: { pinned: `${sheenModule}#writeSheenUBO#roughness` },
    // The anisotropy extension's `pbrExt.writeUbo` — seeded by
    // `compileAnisotropyOptions`.
    anisotropyIntensity: {
        pinned: `${anisotropyModule}#pbrExt.writeUbo#intensity`,
    },
    anisotropyDirection: {
        pinned: `${anisotropyModule}#pbrExt.writeUbo#direction`,
    },
    // `writeReflectanceUBO` — seeded by `compilePbrMaterialOptions`.
    occlusionStrength: {
        pinned: `${reflectanceModule}#writeReflectanceUBO#occlusionStrength`,
    },
    metallicF0Factor: {
        pinned: `${reflectanceModule}#writeReflectanceUBO#_metallicF0Factor`,
    },
    /**
     * The ground state of the pin's chained fallback
     * `_specularWeight ?? _metallicF0Factor ?? 1.0`: a nested `??` folds to
     * its all-absent arm. No intrinsic reads it — the loader seeds the
     * record's `specular_weight` through the same chain.
     */
    specularWeight: {
        pinned: `${reflectanceModule}#writeReflectanceUBO#_specularWeight`,
    },
    // `writeSubsurfaceUBO` — seeded by `compileSubsurfaceOptions`.
    subsurfaceIntensity: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#intensity`,
    },
    subsurfaceColor: { pinned: `${subsurfaceModule}#writeSubsurfaceUBO#color` },
    subsurfaceDiffusionDistance: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#diffusionDistance`,
    },
    subsurfaceMinimumThickness: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#min`,
    },
    subsurfaceMaximumThickness: {
        pinned: `${subsurfaceModule}#writeSubsurfaceUBO#max`,
    },
    // `writeRefractionUBO` — the refraction ground state
    // `compilePbrMaterialOptions` seeds; the thickness max, which no
    // creation option reaches, anchors the writer's discard sites only.
    transmissionIntensity: {
        pinned: `${refractionModule}#writeRefractionUBO#intensity`,
    },
    transmissionIndexOfRefraction: {
        pinned: `${refractionModule}#writeRefractionUBO#indexOfRefraction`,
    },
    transmissionThicknessMax: {
        pinned: `${refractionModule}#writeRefractionUBO#max`,
        divergentSites: true,
    },
    attenuationColor: {
        pinned: `${refractionModule}#writeRefractionUBO#color`,
    },
    attenuationDistance: {
        pinned: `${refractionModule}#writeRefractionUBO#atDistance`,
    },
    /** glTF-lane only (KHR_materials_dispersion); anchored, not seeded. */
    dispersion: {
        pinned: `${refractionModule}#writeRefractionUBO#dispersion`,
    },
    // The pure-2D particle bridge's mapping defaults — seeded by
    // `intrinsics/particle.ts` and asserted by `node-particle-lowerer.ts`
    // (they never pass through a UBO writer's discard site).
    sprite2dPixelsPerUnit: {
        pinned:
            `${sprite2dBridgeModule}#createParticleSprite2DBridge` +
            "#pixelsPerUnit",
    },
    sprite2dOriginPx: {
        pinned: `${sprite2dBridgeModule}#createParticleSprite2DBridge#originPx`,
    },
    sprite2dInvertY: {
        pinned: `${sprite2dBridgeModule}#createParticleSprite2DBridge#invertY`,
    },
    sprite2dAutoStart: {
        pinned: `${sprite2dBridgeModule}#registerNodeParticleSet2D#autoStart`,
    },
    /** The 3D registrar's own `options.autoStart ?? true`. */
    nodeParticleAutoStart: {
        pinned: `${particleSceneModule}#registerNodeParticleSet#autoStart`,
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

/**
 * The property a `<read> ?? <default>` guards: the left-most read of its
 * left spine, as the UBO-writer lowerer's discard site names it.
 */
function nullishGuardedProperty(
    expression: ts.BinaryExpression,
): string | undefined {
    const guarded = nullishDefault(expression);
    if (!guarded) return undefined;
    let node = guarded.left;
    for (
        let chained = nullishDefault(node);
        chained;
        chained = nullishDefault(node)
    ) {
        node = chained.left;
    }
    node = unwrapExpression(node);
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return ts.isIdentifier(node) ? node.text : undefined;
}

const derived = new Map<string, readonly PinnedDefaultValue[]>();

/**
 * The pin's constant defaults at every site the entry's property is written,
 * folded once per process, the one the intrinsics seed the record with
 * first: the only site, or with `divergentSites` the one binding a local of
 * the property's own name. Sites that disagree refuse unless the entry
 * declares `divergentSites`.
 */
export function pinnedDefaultSites(
    entry: PinnedMaterialDefault,
): readonly PinnedDefaultValue[] {
    const cached = derived.get(entry.pinned);
    if (cached) return cached;
    const reader: LoweringContext = sharedPinnedContext();
    const [module, ...rest] = entry.pinned.split("#");
    const property = rest.pop();
    const symbol = rest.join("#");
    if (!module || !symbol || !property) {
        throw new Error(`Malformed pinned default key '${entry.pinned}'.`);
    }
    const { file, declaration } = symbol.includes(".")
        ? reader.methodDeclaration(module, symbol)
        : reader.functionDeclaration(module, symbol);
    const sites = reader
        .findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                nullishGuardedProperty(node) === property,
        )
        .flatMap((site) => {
            const value = pinnedDefaultValue(reader, site.right, file);
            return value === undefined ? [] : [{ site, value }];
        });
    // `const max = thick?.max ?? 1`: the local the pin binds the property
    // under, which is the value the record mirrors.
    const binding = sites.filter(
        ({ site }) =>
            ts.isVariableDeclaration(site.parent) &&
            ts.isIdentifier(site.parent.name) &&
            site.parent.name.text === property,
    );
    const mirrored = entry.divergentSites
        ? binding.length === 1
            ? binding[0]
            : undefined
        : sites[0];
    if (mirrored === undefined) {
        reader.contractError(
            declaration,
            `Expected ${symbol} to default '${property}' with ` +
                (entry.divergentSites
                    ? `\`const ${property} = ... ?? <constant>\` once.`
                    : "`?? <constant>`."),
        );
    }
    if (
        !entry.divergentSites &&
        sites.some(({ value }) => !samePinnedDefault(value, mirrored.value))
    ) {
        reader.contractError(
            declaration,
            `${symbol} states different defaults for '${property}'; the ` +
                "native record carries one value, so the entry must say " +
                "the sites diverge (divergentSites).",
        );
    }
    const values = [
        mirrored.value,
        ...sites
            .filter((candidate) => candidate !== mirrored)
            .map(({ value }) => value),
    ];
    derived.set(entry.pinned, values);
    return values;
}

function entryValue(name: PinnedMaterialDefaultName): PinnedDefaultValue {
    return pinnedDefaultSites(PINNED_MATERIAL_DEFAULTS[name])[0]!;
}

/** A scalar default, for the manifest values the intrinsics record. */
export function pinnedDefaultNumber(name: PinnedMaterialDefaultName): number {
    const value = entryValue(name);
    if (typeof value !== "number") {
        throw new Error(`Pinned material default '${name}' is not a scalar.`);
    }
    return value;
}

/** A boolean default (the bridge's `invertY`/`autoStart`). */
export function pinnedDefaultFlag(name: PinnedMaterialDefaultName): boolean {
    const value = entryValue(name);
    if (typeof value !== "boolean") {
        throw new Error(`Pinned material default '${name}' is not a flag.`);
    }
    return value;
}

function vectorValue(
    name: PinnedMaterialDefaultName,
    lanes: number,
): readonly number[] {
    const value = entryValue(name);
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        value.length !== lanes
    ) {
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
    const [r, g, b] = vectorValue(name, 3);
    return [r!, g!, b!];
}

/** A two-lane default (the anisotropy direction, the bridge origin). */
export function pinnedDefaultVec2(
    name: PinnedMaterialDefaultName,
): readonly [number, number] {
    const [x, y] = vectorValue(name, 2);
    return [x!, y!];
}

/** A scalar default as the shared C++ float literal. */
export function pinnedDefaultFloatCpp(name: PinnedMaterialDefaultName): string {
    return floatLiteral(pinnedDefaultNumber(name));
}

/** A three-lane default as the `bbl::Color3{...}` the intrinsics emit. */
export function pinnedDefaultColor3Cpp(
    name: PinnedMaterialDefaultName,
): string {
    return `bbl::Color3{${pinnedDefaultColor3(name)
        .map(floatLiteral)
        .join(", ")}}`;
}

/** A two-lane default as the `bbl::Vec2{...}` the intrinsics emit. */
export function pinnedDefaultVec2Cpp(name: PinnedMaterialDefaultName): string {
    return `bbl::Vec2{${pinnedDefaultVec2(name).map(floatLiteral).join(", ")}}`;
}

/**
 * `writeReflectanceUBO`'s absent metallic reflectance colour: the pin
 * reads `mrc ? mrc[i] : <lane>` rather than a `??`, so the three lanes are
 * the conditionals' own false arms.
 */
function pinnedMetallicReflectanceColorAbsent(): readonly [
    number,
    number,
    number,
] {
    const reader = sharedPinnedContext();
    const { file, declaration } = reader.functionDeclaration(
        reflectanceModule,
        "writeReflectanceUBO",
    );
    const lanes: number[] = [];
    for (const conditional of reader.findNodes(
        declaration,
        (node): node is ts.ConditionalExpression =>
            ts.isConditionalExpression(node),
    )) {
        const condition = unwrapExpression(conditional.condition);
        const read = unwrapExpression(conditional.whenTrue);
        if (
            !ts.isIdentifier(condition) ||
            condition.text !== "mrc" ||
            !ts.isElementAccessExpression(read) ||
            !ts.isIdentifier(read.expression) ||
            read.expression.text !== "mrc"
        ) {
            continue;
        }
        const lane = reader.numericValue(read.argumentExpression, file);
        lanes[lane] = reader.numericValue(conditional.whenFalse, file);
    }
    const [r, g, b] = lanes;
    if (
        lanes.length !== 3 ||
        r === undefined ||
        g === undefined ||
        b === undefined
    ) {
        return reader.contractError(
            declaration,
            "Expected writeReflectanceUBO to read three `mrc ? mrc[i] : <lane>` lanes.",
        );
    }
    return [r, g, b];
}

/**
 * `_writeMaterialData`'s absent `usePhysicalLightFalloff`: the lane is
 * `material.usePhysicalLightFalloff === false ? 0 : 1`, so an absent option
 * writes what the record's `true` writes.
 */
function pinnedPhysicalLightFalloffAbsent(): boolean {
    const reader = sharedPinnedContext();
    const { declaration } = reader.functionDeclaration(
        baseWriterModule,
        "_writeMaterialData",
    );
    const lane = reader
        .findNodes(
            declaration,
            (node): node is ts.ConditionalExpression =>
                ts.isConditionalExpression(node) &&
                reader.expressionMatchesShape(
                    node.condition,
                    "material.usePhysicalLightFalloff === false",
                ),
        )
        .at(0);
    if (!lane) {
        return reader.contractError(
            declaration,
            "Expected _writeMaterialData to write `material.usePhysicalLightFalloff === false ? 0 : 1`.",
        );
    }
    reader.assertExpressionShape(
        lane,
        "material.usePhysicalLightFalloff === false ? 0 : 1",
        "PBR light falloff lane",
    );
    return true;
}

/**
 * The statements that write every key of a PBR material record that the
 * pin's writers read through `?? <default>` or a conditional's absent arm:
 * the pinned value a material carries until its creation options or a
 * setter says otherwise. `createPbrMaterial` is `{...props}` and the glTF
 * builder assembles its own props, so a key neither names reads its
 * default in every writer; the record starts there rather than at an
 * initializer. A clear coat, sheen or iridescence layer is absent until a
 * setter or the loader enables it (`has_clearcoat`, `has_sheen`,
 * `has_iridescence`), and its lanes hold the writer's defaults meanwhile.
 */
export function pbrMaterialRecordSeedCpp(
    record: string,
    indent: string,
): string {
    const number = (field: string, name: PinnedMaterialDefaultName) =>
        `${indent}${record}.${field} = ${pinnedDefaultFloatCpp(name)};`;
    const color = (field: string, name: PinnedMaterialDefaultName) =>
        `${indent}${record}.${field} = ${pinnedDefaultColor3Cpp(name)};`;
    const mrc = pinnedMetallicReflectanceColorAbsent();
    return [
        number("metallic_factor", "pbrMetallicFactor"),
        number("roughness_factor", "pbrRoughnessFactor"),
        number("direct_intensity", "pbrDirectIntensity"),
        number("environment_intensity", "pbrEnvironmentIntensity"),
        number("reflectance", "pbrReflectance"),
        number("normal_texture_scale", "pbrNormalTextureScale"),
        `${indent}${record}.use_physical_light_falloff = ${pinnedPhysicalLightFalloffAbsent() ? "true" : "false"};`,
        number("occlusion_strength", "occlusionStrength"),
        number("metallic_f0_factor", "metallicF0Factor"),
        // `_specularWeight ?? _metallicF0Factor ?? 1.0` with both absent.
        number("specular_weight", "specularWeight"),
        `${indent}${record}.metallic_reflectance_color = bbl::Color3{${mrc.map(floatLiteral).join(", ")}};`,
        color("unlit_color", "unlitColor"),
        number("transmission_factor", "transmissionIntensity"),
        number("index_of_refraction", "transmissionIndexOfRefraction"),
        color("attenuation_color", "attenuationColor"),
        number("attenuation_distance", "attenuationDistance"),
        number("dispersion", "dispersion"),
        number("subsurface_intensity", "subsurfaceIntensity"),
        color("subsurface_color", "subsurfaceColor"),
        color("subsurface_diffusion_distance", "subsurfaceDiffusionDistance"),
        number("subsurface_minimum_thickness", "subsurfaceMinimumThickness"),
        number("subsurface_maximum_thickness", "subsurfaceMaximumThickness"),
        number("clearcoat_intensity", "clearcoatIntensity"),
        number("clearcoat_roughness", "clearcoatRoughness"),
        number("clearcoat_index_of_refraction", "clearcoatIndexOfRefraction"),
        number("clearcoat_normal_scale", "clearcoatBumpTextureScale"),
        color("sheen_color", "sheenColor"),
        number("sheen_roughness", "sheenRoughness"),
        number("sheen_intensity", "sheenIntensity"),
        number("iridescence_intensity", "iridescenceIntensity"),
        number(
            "iridescence_index_of_refraction",
            "iridescenceIndexOfRefraction",
        ),
        number("iridescence_minimum_thickness", "iridescenceMinimumThickness"),
        number("iridescence_maximum_thickness", "iridescenceMaximumThickness"),
        number("anisotropy_intensity", "anisotropyIntensity"),
        `${indent}${record}.anisotropy_direction = ${pinnedDefaultVec2Cpp("anisotropyDirection")};`,
        color("shadow_only_color", "shadowOnlyColor"),
        number("shadow_only_opacity", "shadowOnlyOpacity"),
        number("shadow_only_falloff", "shadowOnlyFalloff"),
    ].join("\n");
}
