// Material option lowering: PBR, grid, clearcoat, and sheen options.
//
// Each function turns a material factory's options argument into the
// positional C++ arguments the PAL constructor takes, resolving the
// pinned defaults at compile time. The PBR lowering also records the
// resolved record in the scene-material manifest, because the pinned
// composer's `createPbrMaterial` is `{...props}` and the feature
// derivation reads exactly these values back. The intrinsic lowerer
// in material.ts calls these through its context.
import ts from "typescript";
import type {
    ScenePbrAnisotropyManifest,
    ScenePbrClearCoatManifest,
    ScenePbrIridescenceManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrMaterialManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
    Value,
    ValueKind,
} from "../types.js";
import {
    compileOptionalStaticBoolean,
    staticNumberPair,
    staticNumberValue,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";
// The pin's own `?? d` fallbacks, stated once: the UBO-writer lowerer
// asserts each discarded pinned default against this table, and the
// defaults below read the same entries, so the record seed IS the number
// the assert pins.
import {
    pinnedDefaultColor3,
    pinnedDefaultColor3Cpp,
    pinnedDefaultFloatCpp,
    pinnedDefaultNumber,
    pinnedDefaultVec2,
    pinnedDefaultVec2Cpp,
    type PinnedMaterialDefaultName,
} from "../../lowering/pinned-material-defaults.js";

/** One pinned scalar default, in the two forms a setter resolves. */
function pinnedScalarDefault(
    name: PinnedMaterialDefaultName,
): { cpp: string; value: number } {
    return {
        cpp: pinnedDefaultFloatCpp(name),
        value: pinnedDefaultNumber(name),
    };
}

export interface MaterialOptionContext
    extends ObjectValidationContext, PositiveIntegerContext {
    readonly scenePbrMaterials: ScenePbrMaterialManifest[];
    currentGltfAssetCount(): number;
    recordSceneMaterialSlot(): number;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileColor4(expression: ts.Expression): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileVec2(expression: ts.Expression): string;
}

/**
 * `createPbrMaterial`'s resolved options: the two texture values, the
 * nineteen native scalar/flag literals in constructor order, the resolved
 * scene-code occlusion strength and internal metallic F0 factor, and the
 * appended `scenePbrMaterials` index that is this material's compile-time
 * identity.
 */
/**
 * What a reached `createPbrMaterial` settled.
 *
 * Named rather than positional: every field but the two textures and the
 * manifest row is a C++ expression string, so a tuple lets an entry inserted
 * at the wrong index compile and emit the wrong option. The argument list is
 * written out once, at the call site, from these names.
 */
export interface CompiledPbrMaterialOptions {
    baseColor: Value;
    baseColorFactor: string;
    orm: Value;
    metallicFactor: string;
    roughnessFactor: string;
    directIntensity: string;
    environmentIntensity: string;
    alpha: string;
    alphaBlend: string;
    reflectance: string;
    unlit: string;
    doubleSided: string;
    enableSpecularAA: string;
    skyboxMode: string;
    transmission: string;
    indexOfRefraction: string;
    thickness: string;
    useThicknessAsDepth: string;
    hasVolume: string;
    attenuationColor: string;
    attenuationDistance: string;
    occlusionStrength: string;
    metallicF0Factor: string;
    usePhysicalLightFalloff: string;
    /** The row `composeScenePbrVariants` composes this material from. */
    scenePbrMaterialIndex: number;
}

/** What a reached `setPbrAnisotropy` settled: the emitted arguments, and the
 *  manifest the composition input reads. Its numbers come from the pinned AST
 *  through `staticNumberValue`, not from the C++ just emitted -- a scene that
 *  computes its intensity has no number to state, and the manifest says so
 *  rather than carrying the `NaN` a re-parse would produce. */
export interface CompiledAnisotropyOptions {
    enabled: string;
    intensity: string;
    direction: string;
    manifest: ScenePbrAnisotropyManifest;
}

export interface CompiledMetallicReflectanceOptions {
    colorCpp?: string;
    texture?: Value;
    reflectanceTexture?: Value;
    manifest: ScenePbrMetallicReflectanceManifest;
}

/** A reached layer setter's emitted arguments and its AST-derived composition
 *  input. Keeping both here prevents the manifest from parsing C++ text. */
export interface CompiledClearCoatOptions {
    enabled: string;
    intensity: string;
    roughness: string;
    indexOfRefraction: string;
    bumpTextureScale: string;
    manifest: ScenePbrClearCoatManifest;
}

export interface CompiledIridescenceOptions {
    enabled: string;
    intensity: string;
    indexOfRefraction: string;
    minimumThickness: string;
    maximumThickness: string;
    manifest: ScenePbrIridescenceManifest;
}

export interface CompiledSheenOptions {
    enabled: string;
    color: string;
    roughness: string;
    intensity: string;
    texture: ts.Expression | undefined;
    albedoScaling: boolean;
    manifest: ScenePbrSheenManifest;
}

export interface CompiledSubsurfaceOptions {
    intensity: string;
    color: string;
    diffusionDistance: string;
    thicknessTexture?: Value;
    minimumThickness: string;
    maximumThickness: string;
    manifest: ScenePbrSubsurfaceManifest;
}

/** A static RGB tuple in either source shape `compileColor3` accepts. */
export function staticColor3Value(
    context: PositiveIntegerContext & {
        objectProperty(
            object: ts.ObjectLiteralExpression,
            name: string,
        ): ts.Expression | undefined;
    },
    expression: ts.Expression,
): readonly [number, number, number] | undefined {
    const node = context.resolveStaticExpression(expression);
    let channelValues: readonly (ts.Expression | undefined)[] | undefined;
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 3) {
        channelValues = node.elements;
    } else if (ts.isObjectLiteralExpression(node)) {
        channelValues = ["r", "g", "b"].map((name) =>
            context.objectProperty(node, name)
        );
    }
    if (!channelValues || channelValues.some((value) => value === undefined)) {
        // Syntactic resolution follows `??`, module constants and const
        // literal initializers, and stops at a binding that has none of
        // those -- an inlined user function's parameter. The emitted half
        // of the same call reads that binding out of the value model
        // (`StaticEvaluator.tupleElements`), so the folded half reads the
        // same tuple's channels rather than refusing a colour the compiler
        // demonstrably knows. Only a compile-time tuple qualifies: a data
        // tuple's lanes are runtime expressions with no `staticNumber`, and
        // a channel generation needs is genuinely absent there.
        //
        // FOUR sinks read this, not one, and they split two ways. The
        // unlit tint and the two subsurface options FAIL on undefined, so
        // for them this is refusal-to-acceptance and cannot move an
        // existing scene. `setPbrEmissive` and the sheen colour are VALUE
        // sinks: they omit the field instead of refusing, so a colour that
        // used to default -- black for emissive, absent for sheen -- now
        // folds into the composed variant. That is the same defect being
        // fixed, one sink over, but it is a value change rather than a
        // refusal change, which is why the neutrality proof for this edit
        // has to be a whole-tree one. Measured: the three corpus scenes
        // reaching either sink regenerate byte-identically, because scene
        // 20's emissive channels are runtime randoms and still refuse.
        return staticTupleChannels(context, node);
    }
    const [r, g, b] = channelValues.map((value) =>
        staticNumberValue(context, value!)
    );
    return r === undefined || g === undefined || b === undefined
        ? undefined
        : [r, g, b];
}

/** The three static channels of a bound compile-time 3-tuple, if it is one. */
function staticTupleChannels(
    context: Pick<PositiveIntegerContext, "lookupOptional">,
    node: ts.Expression,
): readonly [number, number, number] | undefined {
    if (!ts.isIdentifier(node)) return undefined;
    const bound = context.lookupOptional(node);
    if (bound?.kind !== "tuple" || bound.tupleElements?.length !== 3) {
        return undefined;
    }
    const channels = bound.tupleElements.map((element) =>
        element.kind === "number" ? element.staticNumber : undefined
    );
    const [r, g, b] = channels;
    return r === undefined || g === undefined || b === undefined
        ? undefined
        : [r, g, b];
}

/**
 * A setter's linear-RGB argument as both halves its caller needs: the
 * channels generation folds into static material state, and the emitted
 * colour. This remains the stricter path for setters whose reached slice
 * needs the channel values themselves at generation.
 */
export function requiredStaticColor3(
    context: Parameters<typeof staticColor3Value>[0] & {
        compileColor3(expression: ts.Expression): string;
    },
    expression: ts.Expression,
    message: string,
): { cpp: string; channels: readonly [number, number, number] } {
    const channels = staticColor3Value(context, expression);
    if (
        !channels ||
        channels.some((channel) => !Number.isFinite(channel))
    ) {
        context.fail(expression, message);
    }
    return { cpp: context.compileColor3(expression), channels };
}

function requiredStaticFiniteNumber(
    context: MaterialOptionContext,
    expression: ts.Expression | undefined,
    fallback: number,
    label: string,
): { cpp: string; value: number } {
    if (!expression) return { cpp: `${fallback}.0f`, value: fallback };
    const value = staticNumberValue(context, expression);
    if (value === undefined || !Number.isFinite(value)) {
        context.fail(
            expression,
            `${label} must be a finite static number; the pinned material block is composed at generation.`,
        );
    }
    return { cpp: context.compileNumber(expression), value };
}

/**
 * Scene 26's public subsurface setter: thin-surface translucency plus one
 * thickness texture. The pin's color/intensity texture arms and their live UV
 * transforms remain explicit refusals until a reached scene measures them.
 */
export function compileSubsurfaceOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): CompiledSubsurfaceOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["translucency", "thickness"],
        "Reached subsurface options support translucency and a thickness texture with static min/max.",
    );
    const translucencyExpression = context.objectProperty(
        object,
        "translucency",
    );
    if (!translucencyExpression) {
        context.fail(
            object,
            "Reached setPbrSubsurface requires translucency; refraction uses setPbrTransmission.",
        );
    }
    const translucency = context.expectObjectLiteral(translucencyExpression);
    validateObjectProperties(
        context,
        translucency,
        ["intensity", "color", "diffusionDistance"],
        "Reached translucency supports static intensity, color, and diffusionDistance values.",
    );
    const intensity = requiredStaticFiniteNumber(
        context,
        context.objectProperty(translucency, "intensity"),
        pinnedDefaultNumber("subsurfaceIntensity"),
        "Translucency intensity",
    );
    const colorExpression = context.objectProperty(translucency, "color");
    const color = colorExpression
        ? staticColor3Value(context, colorExpression)
        : pinnedDefaultColor3("subsurfaceColor");
    if (!color || color.some((channel) => !Number.isFinite(channel))) {
        context.fail(
            colorExpression!,
            "Translucency color must be a finite static RGB tuple.",
        );
    }
    const diffusionExpression = context.objectProperty(
        translucency,
        "diffusionDistance",
    );
    const diffusionDistance = diffusionExpression
        ? staticColor3Value(context, diffusionExpression)
        : pinnedDefaultColor3("subsurfaceDiffusionDistance");
    if (
        !diffusionDistance ||
        diffusionDistance.some((channel) => !Number.isFinite(channel))
    ) {
        context.fail(
            diffusionExpression!,
            "Translucency diffusionDistance must be a finite static RGB tuple.",
        );
    }

    const thicknessExpression = context.objectProperty(object, "thickness");
    let thicknessTexture: Value | undefined;
    let minimum = pinnedScalarDefault("subsurfaceMinimumThickness");
    let maximum = pinnedScalarDefault("subsurfaceMaximumThickness");
    if (thicknessExpression) {
        const thickness = context.expectObjectLiteral(thicknessExpression);
        validateObjectProperties(
            context,
            thickness,
            ["texture", "min", "max"],
            "Reached thickness options support one file texture and static min/max values.",
        );
        const textureExpression = context.objectProperty(thickness, "texture");
        if (textureExpression) {
            thicknessTexture = context.compileValue(textureExpression);
            if (
                thicknessTexture.kind !== "texture" ||
                !thicknessTexture.textureFile
            ) {
                context.fail(
                    textureExpression,
                    "Reached subsurface thickness maps must come from loadTexture2D.",
                );
            }
            if (thicknessTexture.textureFile.srgb) {
                context.fail(
                    textureExpression,
                    "Subsurface thickness maps must be linear textures.",
                );
            }
        }
        minimum = requiredStaticFiniteNumber(
            context,
            context.objectProperty(thickness, "min"),
            pinnedDefaultNumber("subsurfaceMinimumThickness"),
            "Minimum thickness",
        );
        maximum = requiredStaticFiniteNumber(
            context,
            context.objectProperty(thickness, "max"),
            pinnedDefaultNumber("subsurfaceMaximumThickness"),
            "Maximum thickness",
        );
    }

    return {
        intensity: intensity.cpp,
        color: colorExpression
            ? context.compileColor3(colorExpression)
            : pinnedDefaultColor3Cpp("subsurfaceColor"),
        diffusionDistance: diffusionExpression
            ? context.compileColor3(diffusionExpression)
            : pinnedDefaultColor3Cpp("subsurfaceDiffusionDistance"),
        ...(thicknessTexture ? { thicknessTexture } : {}),
        minimumThickness: minimum.cpp,
        maximumThickness: maximum.cpp,
        manifest: {
            intensity: intensity.value,
            color,
            diffusionDistance,
            hasThicknessTexture: thicknessTexture !== undefined,
            minimumThickness: minimum.value,
            maximumThickness: maximum.value,
        },
    };
}

export function compilePbrMaterialOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): CompiledPbrMaterialOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "baseColorTexture",
            "baseColorFactor",
            "ormTexture",
            "metallicFactor",
            "roughnessFactor",
            "directIntensity",
            "environmentIntensity",
            "alpha",
            "alphaBlend",
            "reflectance",
            "occlusionStrength",
            "_metallicF0Factor",
            "enableSpecularAA",
            "doubleSided",
            "transmissive",
            "subsurface",
            "usePhysicalLightFalloff",
        ],
        "Reached PBR lowering supports base/ORM textures, the base color factor, metallic/roughness factors, alpha and alpha blending, reflectance, occlusion strength, specular AA, the internal metallic F0 factor, lighting intensities, the light falloff mode, skybox mode, and transmission subsurface fields.",
    );
    const baseColorExpression = context.objectProperty(object, "baseColorTexture");
    const baseColorFactorExpression = context.objectProperty(
        object,
        "baseColorFactor",
    );
    const ormExpression = context.objectProperty(object, "ormTexture");
    // createPbrMaterial installs the pin's fallback resolver: either absent
    // slot samples the same shared 1x1 white rgba8unorm texture. Carry that
    // exact quantized texel directly when the source omits a texture.
    const whiteFallback: Value = {
        kind: "texture",
        textureStorage: "solid",
        cpp:
            "bbl::SolidTexture{" +
            "bbl::Color4{1.0f, 1.0f, 1.0f, 1.0f}, " +
            "std::array<std::uint8_t, 4>{255u, 255u, 255u, 255u}}",
    };
    const baseColor = baseColorExpression
        ? context.compileValue(baseColorExpression)
        : whiteFallback;
    const orm = ormExpression
        ? context.compileValue(ormExpression)
        : whiteFallback;
    if (baseColorExpression) {
        context.expectKind(baseColor, "texture", baseColorExpression);
    }
    if (ormExpression) {
        context.expectKind(orm, "texture", ormExpression);
    }
    const baseColorFactor = baseColorFactorExpression
        ? staticPbrBaseColorFactor(context, baseColorFactorExpression)
        : undefined;
    const metallic = context.objectProperty(object, "metallicFactor");
    const roughness = context.objectProperty(object, "roughnessFactor");
    const direct = context.objectProperty(object, "directIntensity");
    const environment = context.objectProperty(
        object,
        "environmentIntensity",
    );
    const alpha = context.objectProperty(object, "alpha");
    const alphaBlend = context.objectProperty(
        object,
        "alphaBlend",
    );
    const reflectance = context.objectProperty(object, "reflectance");
    const occlusionStrength = context.objectProperty(
        object,
        "occlusionStrength",
    );
    const metallicF0Factor = context.objectProperty(
        object,
        "_metallicF0Factor",
    );
    const enableSpecularAA = context.objectProperty(
        object,
        "enableSpecularAA",
    );
    const doubleSided = context.objectProperty(object, "doubleSided");
    const physicalLightFalloff = context.objectProperty(
        object,
        "usePhysicalLightFalloff",
    );
    const transmissive = context.objectProperty(object, "transmissive");
    const subsurfaceExpression = context.objectProperty(object, "subsurface");
    let transmission = pinnedDefaultFloatCpp("transmissionIntensity");
    let ior = pinnedDefaultFloatCpp("transmissionIndexOfRefraction");
    // NOT the pin's `?? 1`: with a refraction object and no thickness the
    // pinned writer reads `thick?.max ?? 1` while this record seeds 0 —
    // the absent-subsurface ground state. UNREACHABLE today, measured
    // 2026-08-24: a scene-code refraction shape refuses at generation
    // ("no composed arm yet", the open transmission item in TODO), so the
    // divergence cannot reach a composed variant. When that arm lands,
    // resolve this seed against the pin's `?? 1` for the
    // refraction-without-thickness shape before measuring. The `?? 1` arm
    // the defaults table anchors is the inner thickness branch below.
    let thickness = "0.0f";
    let useThicknessAsDepth = "false";
    let hasVolume = "false";
    let attenuationColor = pinnedDefaultColor3Cpp("attenuationColor");
    let attenuationDistance = pinnedDefaultFloatCpp("attenuationDistance");
    if (subsurfaceExpression) {
        const subsurface = context.expectObjectLiteral(subsurfaceExpression);
        const refractionExpression = context.objectProperty(
            subsurface,
            "refraction",
        );
        if (refractionExpression) {
            const refraction = context.expectObjectLiteral(refractionExpression);
            const intensity = context.objectProperty(refraction, "intensity");
            const indexOfRefraction = context.objectProperty(
                refraction,
                "indexOfRefraction",
            );
            const thicknessAsDepth = context.objectProperty(
                refraction,
                "useThicknessAsDepth",
            );
            transmission = intensity
                ? context.compileNumber(intensity)
                : transmissive
                    ? "1.0f"
                    : pinnedDefaultFloatCpp("transmissionIntensity");
            ior = indexOfRefraction
                ? context.compileNumber(indexOfRefraction)
                : pinnedDefaultFloatCpp("transmissionIndexOfRefraction");
            useThicknessAsDepth = thicknessAsDepth
                ? context.compileBoolean(thicknessAsDepth)
                : "false";
        }
        const thicknessExpression = context.objectProperty(
            subsurface,
            "thickness",
        );
        if (thicknessExpression) {
            const thicknessObject =
                context.expectObjectLiteral(thicknessExpression);
            const maximum = context.objectProperty(thicknessObject, "max");
            thickness = maximum
                ? context.compileNumber(maximum)
                : pinnedDefaultFloatCpp("transmissionThicknessMax");
        }
        const tintExpression = context.objectProperty(subsurface, "tint");
        if (tintExpression) {
            const tint = context.expectObjectLiteral(tintExpression);
            const color = context.objectProperty(tint, "color");
            const distance = context.objectProperty(tint, "atDistance");
            hasVolume = distance ? "true" : "false";
            attenuationColor = color
                ? context.compileColor3(color)
                : attenuationColor;
            attenuationDistance = distance
                ? context.compileNumber(distance)
                : attenuationDistance;
        }
    }
    const metallicCpp = metallic
        ? context.compileNumber(metallic)
        : pinnedDefaultFloatCpp("pbrMetallicFactor");
    const roughnessCpp = roughness
        ? context.compileNumber(roughness)
        : pinnedDefaultFloatCpp("pbrRoughnessFactor");
    const directCpp = direct
        ? context.compileNumber(direct)
        : pinnedDefaultFloatCpp("pbrDirectIntensity");
    const environmentCpp = environment
        ? context.compileNumber(environment)
        : pinnedDefaultFloatCpp("pbrEnvironmentIntensity");
    const alphaCpp = alpha
        ? context.compileNumber(alpha)
        : pinnedDefaultFloatCpp("pbrAlpha");
    const staticAlphaBlend = compileOptionalStaticBoolean(
        context,
        alphaBlend,
        false,
        "PBR alphaBlend",
    );
    const alphaBlendCpp = staticAlphaBlend
        ? "true"
        : "false";
    const reflectanceCpp = reflectance
        ? context.compileNumber(reflectance)
        : pinnedDefaultFloatCpp("pbrReflectance");
    const staticOcclusionStrength = occlusionStrength
        ? staticNumberValue(context, occlusionStrength)
        : pinnedDefaultNumber("occlusionStrength");
    if (
        staticOcclusionStrength === undefined ||
        !Number.isFinite(staticOcclusionStrength)
    ) {
        context.fail(
            occlusionStrength!,
            "PBR occlusionStrength must be a finite static number: generation composes the occlusion shader arm from it.",
        );
    }
    const occlusionStrengthCpp = occlusionStrength
        ? context.compileNumber(occlusionStrength)
        : pinnedDefaultFloatCpp("occlusionStrength");
    const staticMetallicF0Factor = metallicF0Factor
        ? staticNumberValue(context, metallicF0Factor)
        : pinnedDefaultNumber("metallicF0Factor");
    if (
        staticMetallicF0Factor === undefined ||
        !Number.isFinite(staticMetallicF0Factor)
    ) {
        context.fail(
            metallicF0Factor!,
            "PBR _metallicF0Factor must be a finite static number: generation composes the reflectance-factor shader arm from it when the pinned extension is registered.",
        );
    }
    const metallicF0FactorCpp = metallicF0Factor
        ? context.compileNumber(metallicF0Factor)
        : pinnedDefaultFloatCpp("metallicF0Factor");
    const doubleSidedCpp = doubleSided
        ? context.compileBoolean(doubleSided)
        : "false";
    const staticEnableSpecularAA = compileOptionalStaticBoolean(
        context,
        enableSpecularAA,
        false,
        "PBR enableSpecularAA",
    );
    const enableSpecularAACpp = staticEnableSpecularAA ? "true" : "false";
    // The pin's own default is true (`usePhysicalLightFalloff === false ? 0
    // : 1` in `_writeMaterialData`), so an absent option and an explicit
    // `true` are one value. It is a uniform lane rather than a composition
    // key: every punctual arm carries both falloffs and selects on it.
    const staticPhysicalLightFalloff = compileOptionalStaticBoolean(
        context,
        physicalLightFalloff,
        true,
        "PBR usePhysicalLightFalloff",
    );
    const physicalLightFalloffCpp = staticPhysicalLightFalloff
        ? "true"
        : "false";
    // The resolved option values, in creation order, for the pinned
    // composer: the pin's `createPbrMaterial` is `{...props}`, so these
    // ARE the material record its feature derivation reads. Every value
    // above compiles from a static literal, which is why parsing the C++
    // text back is exact.
    const sceneMaterialIndex = context.scenePbrMaterials.push({
        materialsBefore: context.recordSceneMaterialSlot(),
        gltfAssetsBefore: context.currentGltfAssetCount(),
        hasBaseColorTexture: true,
        hasOrmTexture: true,
        ...(baseColorFactor ? { baseColorFactor: baseColorFactor.value } : {}),
        metallicFactor: Number.parseFloat(metallicCpp),
        roughnessFactor: Number.parseFloat(roughnessCpp),
        directIntensity: Number.parseFloat(directCpp),
        environmentIntensity: Number.parseFloat(environmentCpp),
        alpha: Number.parseFloat(alphaCpp),
        ...(staticAlphaBlend ? { alphaBlend: true } : {}),
        reflectance: Number.parseFloat(reflectanceCpp),
        ...(staticOcclusionStrength === pinnedDefaultNumber("occlusionStrength")
            ? {}
            : { occlusionStrength: staticOcclusionStrength }),
        ...(staticMetallicF0Factor === pinnedDefaultNumber("metallicF0Factor")
            ? {}
            : { metallicF0Factor: staticMetallicF0Factor }),
        ...(staticEnableSpecularAA ? { enableSpecularAA: true } : {}),
        doubleSided: doubleSidedCpp === "true",
        transmission: Number.parseFloat(transmission),
        ior: Number.parseFloat(ior),
        thickness: Number.parseFloat(thickness),
        ...(staticPhysicalLightFalloff
            ? {}
            : { usePhysicalLightFalloff: false }),
    }) - 1;
    return {
        baseColor,
        baseColorFactor:
            baseColorFactor?.cpp ??
            "bbl::Color4{1.0f, 1.0f, 1.0f, 1.0f}",
        orm,
        metallicFactor: metallicCpp,
        roughnessFactor: roughnessCpp,
        directIntensity: directCpp,
        environmentIntensity: environmentCpp,
        alpha: alphaCpp,
        alphaBlend: alphaBlendCpp,
        reflectance: reflectanceCpp,
        // `setPbrUnlit` and `setPbrSkybox` are the opt-ins that raise these;
        // the creation options carry neither.
        unlit: "false",
        doubleSided: doubleSidedCpp,
        enableSpecularAA: enableSpecularAACpp,
        skyboxMode: "false",
        transmission,
        indexOfRefraction: ior,
        thickness,
        useThicknessAsDepth,
        hasVolume,
        attenuationColor,
        attenuationDistance,
        occlusionStrength: occlusionStrengthCpp,
        metallicF0Factor: metallicF0FactorCpp,
        usePhysicalLightFalloff: physicalLightFalloffCpp,
        scenePbrMaterialIndex: sceneMaterialIndex,
    };
}

/**
 * `baseColorFactor` contributes a UBO field by property presence, so the
 * composer needs the exact tuple at generation rather than only the emitted
 * C++ expression. Native keeps this tuple separate from the material-wide
 * alpha, matching the pin's two UBO inputs and their fragment multiplication.
 */
function staticPbrBaseColorFactor(
    context: MaterialOptionContext,
    expression: ts.Expression,
): {
    cpp: string;
    value: readonly [number, number, number, number];
} {
    const resolved = context.resolveStaticExpression(expression);
    let channels: readonly ts.Expression[] | undefined;
    if (
        ts.isArrayLiteralExpression(resolved) &&
        resolved.elements.length === 4
    ) {
        channels = resolved.elements;
    } else if (ts.isObjectLiteralExpression(resolved)) {
        channels = ["r", "g", "b", "a"].map((name) => {
            const channel = context.objectProperty(resolved, name);
            if (!channel) {
                context.fail(
                    resolved,
                    `PBR baseColorFactor requires a '${name}' channel.`,
                );
            }
            return channel;
        });
    }
    if (!channels) {
        context.fail(
            expression,
            "PBR baseColorFactor must be a static [r, g, b, a] tuple or { r, g, b, a } object: generation composes a UBO field from its presence.",
        );
    }
    const value = channels.map((channel) =>
        staticNumberValue(context, channel),
    );
    if (
        value.some(
            (channel): boolean =>
                channel === undefined || !Number.isFinite(channel),
        )
    ) {
        context.fail(
            expression,
            "PBR baseColorFactor channels must be finite static numbers: generation composes a UBO field from the factor.",
        );
    }
    const tuple = value as [number, number, number, number];
    return {
        cpp: context.compileColor4(expression),
        value: tuple,
    };
}

/** A setter option that is absent through an inlined optional record field. */
function optionalRecordOption(
    context: MaterialOptionContext,
    expression: ts.Expression | undefined,
): Value | undefined {
    if (!expression) return undefined;
    const resolved = context.resolveStaticExpression(expression);
    if (
        ts.isIdentifier(resolved) &&
        resolved.text === "undefined" &&
        !context.lookupOptional(resolved)
    ) {
        return undefined;
    }
    if (
        ts.isPropertyAccessExpression(resolved) &&
        ts.isIdentifier(resolved.expression)
    ) {
        const owner = context.lookupOptional(resolved.expression);
        if (owner?.kind === "record") {
            return owner.recordProperties?.[resolved.name.text];
        }
    }
    return context.compileValue(resolved);
}

export function compileMetallicReflectanceOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): CompiledMetallicReflectanceOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "color",
            "texture",
            "reflectanceTexture",
            "useOnlyMetallicFromTexture",
        ],
        "Reached metallic-reflectance lowering supports color, the two file-texture slots, and useOnlyMetallicFromTexture.",
    );
    const colorExpression = context.objectProperty(object, "color");
    let colorCpp: string | undefined;
    let color: readonly [number, number, number] | undefined;
    if (colorExpression) {
        const resolved = context.resolveStaticExpression(colorExpression);
        if (
            !ts.isArrayLiteralExpression(resolved) ||
            resolved.elements.length !== 3
        ) {
            context.fail(
                colorExpression,
                "setPbrMetallicReflectance color must be a static RGB tuple.",
            );
        }
        const values = resolved.elements.map((element) =>
            staticNumberValue(context, element),
        );
        if (
            values.every((value) =>
                value !== undefined && Number.isFinite(value)
            )
        ) {
            color = values as [number, number, number];
        }
        colorCpp = context.compileColor3(colorExpression);
    }
    const texture = optionalRecordOption(
        context,
        context.objectProperty(object, "texture"),
    );
    const reflectanceTexture = optionalRecordOption(
        context,
        context.objectProperty(object, "reflectanceTexture"),
    );
    for (const value of [texture, reflectanceTexture]) {
        if (!value) continue;
        if (value.kind !== "texture" || !value.textureFile) {
            context.fail(
                expression,
                "Reached metallic-reflectance maps must come from loadTexture2D.",
            );
        }
        if (value.textureFile.srgb) {
            context.fail(
                expression,
                "Metallic-reflectance maps must be linear textures; the pinned fragment performs its own RGB decode.",
            );
        }
    }
    const useOnly = optionalRecordOption(
        context,
        context.objectProperty(object, "useOnlyMetallicFromTexture"),
    );
    if (
        useOnly &&
        (useOnly.kind !== "boolean" ||
            (useOnly.cpp !== "true" && useOnly.cpp !== "false"))
    ) {
        context.fail(
            expression,
            "useOnlyMetallicFromTexture must be a static boolean.",
        );
    }
    if (
        colorCpp &&
        !color &&
        !texture &&
        !reflectanceTexture
    ) {
        context.fail(
            colorExpression!,
            "A color-only metallic-reflectance setter requires finite static RGB values so its fragment arm can be determined.",
        );
    }
    return {
        ...(colorCpp ? { colorCpp } : {}),
        ...(texture ? { texture } : {}),
        ...(reflectanceTexture ? { reflectanceTexture } : {}),
        manifest: {
            hasColor: colorCpp !== undefined,
            ...(color ? { color } : {}),
            hasMetallicTexture: texture !== undefined,
            hasReflectanceTexture: reflectanceTexture !== undefined,
            ...(useOnly
                ? { useOnlyMetallicFromTexture: useOnly.cpp === "true" }
                : {}),
        },
    };
}

export function compileGridMaterialOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): string[] {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "name",
            "mainColor",
            "lineColor",
            "gridRatio",
            "gridOffset",
            "majorUnitFrequency",
            "minorUnitVisibility",
            "opacity",
            "antialias",
            "preMultiplyAlpha",
            "useMaxLine",
            "visibility",
            "backFaceCulling",
        ],
        "Grid material options support colors, object-space spacing/offset, line frequency/visibility, opacity, antialiasing, premultiplication, max-line composition, visibility, and culling.",
    );
    const mainColor = context.objectProperty(object, "mainColor");
    const lineColor = context.objectProperty(object, "lineColor");
    const gridRatio = context.objectProperty(object, "gridRatio");
    const gridOffset = context.objectProperty(object, "gridOffset");
    const majorUnitFrequency = context.objectProperty(
        object,
        "majorUnitFrequency",
    );
    const minorUnitVisibility = context.objectProperty(
        object,
        "minorUnitVisibility",
    );
    const opacity = context.objectProperty(object, "opacity");
    const visibility = context.objectProperty(object, "visibility");
    const antialias = context.objectProperty(object, "antialias");
    const preMultiplyAlpha = context.objectProperty(
        object,
        "preMultiplyAlpha",
    );
    const useMaxLine = context.objectProperty(object, "useMaxLine");
    const backFaceCulling = context.objectProperty(
        object,
        "backFaceCulling",
    );
    return [
        mainColor
            ? context.compileColor3(mainColor)
            : "bbl::Color3{0.0f, 0.0f, 0.0f}",
        lineColor
            ? context.compileColor3(lineColor)
            : "bbl::Color3{0.0f, 0.5f, 0.5f}",
        gridRatio ? context.compileNumber(gridRatio) : "1.0f",
        gridOffset ? context.compileVec3(gridOffset) : "bbl::Vec3{}",
        majorUnitFrequency
            ? context.compileNumber(majorUnitFrequency)
            : "10.0f",
        minorUnitVisibility
            ? context.compileNumber(minorUnitVisibility)
            : "0.33f",
        opacity ? context.compileNumber(opacity) : "1.0f",
        visibility ? context.compileNumber(visibility) : "1.0f",
        antialias ? context.compileBoolean(antialias) : "true",
        preMultiplyAlpha
            ? context.compileBoolean(preMultiplyAlpha)
            : "false",
        useMaxLine ? context.compileBoolean(useMaxLine) : "false",
        backFaceCulling
            ? context.compileBoolean(backFaceCulling)
            : "true",
    ];
}

/**
 * The reached slice of `ClearCoatProps`. The pinned defaults come from
 * `writeClearcoatUBO`, which is also where the `isEnabled` guard lives:
 * a disabled coat writes no slice at all. The three optional textures
 * are rejected rather than ignored — no reached scene carries one, and
 * they would need their own binding pairs.
 */
export function compileClearCoatOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): CompiledClearCoatOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "isEnabled",
            "intensity",
            "roughness",
            "indexOfRefraction",
            "bumpTextureScale",
        ],
        "Reached clearcoat options support isEnabled, intensity, roughness, indexOfRefraction, and bumpTextureScale.",
    );
    const isEnabled = context.objectProperty(object, "isEnabled");
    const intensity = context.objectProperty(object, "intensity");
    const roughness = context.objectProperty(object, "roughness");
    const indexOfRefraction = context.objectProperty(
        object,
        "indexOfRefraction",
    );
    const bumpTextureScale = context.objectProperty(
        object,
        "bumpTextureScale",
    );
    const enabled = isEnabled ? context.compileBoolean(isEnabled) : "false";
    const staticIntensity = intensity
        ? staticNumberValue(context, intensity)
        : pinnedDefaultNumber("clearcoatIntensity");
    const staticRoughness = roughness
        ? staticNumberValue(context, roughness)
        : pinnedDefaultNumber("clearcoatRoughness");
    const staticIndexOfRefraction = indexOfRefraction
        ? staticNumberValue(context, indexOfRefraction)
        : pinnedDefaultNumber("clearcoatIndexOfRefraction");
    return {
        enabled,
        intensity: intensity
            ? context.compileNumber(intensity)
            : pinnedDefaultFloatCpp("clearcoatIntensity"),
        roughness: roughness
            ? context.compileNumber(roughness)
            : pinnedDefaultFloatCpp("clearcoatRoughness"),
        indexOfRefraction: indexOfRefraction
            ? context.compileNumber(indexOfRefraction)
            : pinnedDefaultFloatCpp("clearcoatIndexOfRefraction"),
        bumpTextureScale: bumpTextureScale
            ? context.compileNumber(bumpTextureScale)
            : pinnedDefaultFloatCpp("clearcoatBumpTextureScale"),
        manifest: {
            isEnabled: enabled === "true",
            ...(staticIntensity !== undefined
                ? { intensity: staticIntensity }
                : {}),
            ...(staticRoughness !== undefined
                ? { roughness: staticRoughness }
                : {}),
            ...(staticIndexOfRefraction !== undefined
                ? { indexOfRefraction: staticIndexOfRefraction }
                : {}),
        },
    };
}

/**
 * The reached slice of `IridescenceProps`. The pinned defaults come from
 * `writeIridescenceUBO`, which is also where the `isEnabled` guard lives:
 * `iri.intensity ?? 1`, `indexOfRefraction ?? 1.3`, and the 100..400 nm
 * thickness pair. A scene-code coat differs from the glTF one here — the
 * loader passes `iridescenceFactor ?? 0` for the intensity, so an omitted
 * intensity means full strength from scene code and none from an asset.
 * The two texture slots are rejected: each needs its own binding pair and
 * UV, and `createPbrMaterial` produces no texture for them.
 */
export function compileIridescenceOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): CompiledIridescenceOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "isEnabled",
            "intensity",
            "indexOfRefraction",
            "minimumThickness",
            "maximumThickness",
        ],
        "Reached iridescence options support isEnabled, intensity, indexOfRefraction, minimumThickness, and maximumThickness.",
    );
    const isEnabled = context.objectProperty(object, "isEnabled");
    const intensity = context.objectProperty(object, "intensity");
    const indexOfRefraction = context.objectProperty(
        object,
        "indexOfRefraction",
    );
    const minimumThickness = context.objectProperty(
        object,
        "minimumThickness",
    );
    const maximumThickness = context.objectProperty(
        object,
        "maximumThickness",
    );
    const enabled = isEnabled ? context.compileBoolean(isEnabled) : "false";
    const staticIntensity = intensity
        ? staticNumberValue(context, intensity)
        : pinnedDefaultNumber("iridescenceIntensity");
    const staticIndexOfRefraction = indexOfRefraction
        ? staticNumberValue(context, indexOfRefraction)
        : pinnedDefaultNumber("iridescenceIndexOfRefraction");
    const staticMinimumThickness = minimumThickness
        ? staticNumberValue(context, minimumThickness)
        : pinnedDefaultNumber("iridescenceMinimumThickness");
    const staticMaximumThickness = maximumThickness
        ? staticNumberValue(context, maximumThickness)
        : pinnedDefaultNumber("iridescenceMaximumThickness");
    return {
        enabled,
        intensity: intensity
            ? context.compileNumber(intensity)
            : pinnedDefaultFloatCpp("iridescenceIntensity"),
        indexOfRefraction: indexOfRefraction
            ? context.compileNumber(indexOfRefraction)
            : pinnedDefaultFloatCpp("iridescenceIndexOfRefraction"),
        minimumThickness: minimumThickness
            ? context.compileNumber(minimumThickness)
            : pinnedDefaultFloatCpp("iridescenceMinimumThickness"),
        maximumThickness: maximumThickness
            ? context.compileNumber(maximumThickness)
            : pinnedDefaultFloatCpp("iridescenceMaximumThickness"),
        manifest: {
            isEnabled: enabled === "true",
            ...(staticIntensity !== undefined
                ? { intensity: staticIntensity }
                : {}),
            ...(staticIndexOfRefraction !== undefined
                ? { indexOfRefraction: staticIndexOfRefraction }
                : {}),
            ...(staticMinimumThickness !== undefined
                ? { minimumThickness: staticMinimumThickness }
                : {}),
            ...(staticMaximumThickness !== undefined
                ? { maximumThickness: staticMaximumThickness }
                : {}),
        },
    };
}

/**
 * The reached slice of `AnisotropyProps`.
 *
 * The defaults are `writeUbo`'s own — `intensity ?? 1.0` and
 * `direction ?? [1, 0]` in `fragments/anisotropy-fragment.ts` — and the
 * `isEnabled` guard stays there too, which is why a disabled layer still
 * stamps the material. `texture` is rejected: it carries the extension's
 * second feature bit (`PBR2_HAS_ANISO_TEX`), its own binding pair and its
 * own UV transform, and no reached call passes one.
 */
export function compileAnisotropyOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): CompiledAnisotropyOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["isEnabled", "intensity", "direction"],
        "Reached anisotropy options support isEnabled, intensity, and direction.",
    );
    const isEnabled = context.objectProperty(object, "isEnabled");
    const intensity = context.objectProperty(object, "intensity");
    const direction = context.objectProperty(object, "direction");
    const enabled = isEnabled
        ? context.compileBoolean(isEnabled)
        : "false";
    const staticDirection = direction
        ? staticNumberPair(context, direction) ??
            context.fail(
                direction,
                "An anisotropy direction must be a static [x, y].",
            )
        : pinnedDefaultVec2("anisotropyDirection");
    const staticIntensity = intensity
        ? staticNumberValue(context, intensity)
        : pinnedDefaultNumber("anisotropyIntensity");
    return {
        enabled,
        intensity: intensity
            ? context.compileNumber(intensity)
            : pinnedDefaultFloatCpp("anisotropyIntensity"),
        direction: direction
            ? context.compileVec2(direction)
            : pinnedDefaultVec2Cpp("anisotropyDirection"),
        manifest: {
            isEnabled: enabled === "true",
            // Omitted where the scene computes the value: the composition
            // then replays the pin's own `?? 1.0` default, which is what the
            // variant reads. Nothing in the pinned `detect` selects on it.
            ...(staticIntensity !== undefined
                ? { intensity: staticIntensity }
                : {}),
            direction: staticDirection,
        },
    };
}

/**
 * The reached slice of `SheenProps`. The pinned defaults come from
 * `writeSheenUBO`, which is also where the `isEnabled` guard lives.
 * `albedoScaling` is read here rather than rejected because it selects
 * which of the two pinned sheen models the fragment composes, and the
 * reached scene leaves it at its legacy default. `roughnessTexture` is
 * rejected: it would need its own binding pair and its own UV.
 */
export function compileSheenOptions(
    context: MaterialOptionContext,
    expression: ts.Expression,
): CompiledSheenOptions {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "isEnabled",
            "color",
            "roughness",
            "intensity",
            "texture",
            "albedoScaling",
        ],
        "Reached sheen options support isEnabled, color, roughness, intensity, texture, and albedoScaling.",
    );
    const isEnabled = context.objectProperty(object, "isEnabled");
    const color = context.objectProperty(object, "color");
    const roughness = context.objectProperty(object, "roughness");
    const intensity = context.objectProperty(object, "intensity");
    const albedoScaling = context.objectProperty(
        object,
        "albedoScaling",
    );
    const albedoScalingValue = albedoScaling
        ? context.compileBoolean(albedoScaling)
        : "false";
    if (
        albedoScalingValue !== "true" &&
        albedoScalingValue !== "false"
    ) {
        context.fail(
            albedoScaling ?? object,
            "Sheen albedoScaling must be a static boolean; it selects the composed fragment.",
        );
    }
    const enabled = isEnabled
        ? context.compileBoolean(isEnabled)
        : "false";
    const staticColor = color
        ? staticColor3Value(context, color)
        : pinnedDefaultColor3("sheenColor");
    const staticRoughness = roughness
        ? staticNumberValue(context, roughness)
        : pinnedDefaultNumber("sheenRoughness");
    const staticIntensity = intensity
        ? staticNumberValue(context, intensity)
        : pinnedDefaultNumber("sheenIntensity");
    const texture = context.objectProperty(object, "texture");
    const albedoScalingEnabled = albedoScalingValue === "true";
    return {
        enabled,
        color: color
            ? context.compileColor3(color)
            : pinnedDefaultColor3Cpp("sheenColor"),
        roughness: roughness
            ? context.compileNumber(roughness)
            : pinnedDefaultFloatCpp("sheenRoughness"),
        intensity: intensity
            ? context.compileNumber(intensity)
            : pinnedDefaultFloatCpp("sheenIntensity"),
        texture,
        albedoScaling: albedoScalingEnabled,
        manifest: {
            isEnabled: enabled === "true",
            ...(staticColor !== undefined ? { color: staticColor } : {}),
            ...(staticRoughness !== undefined
                ? { roughness: staticRoughness }
                : {}),
            ...(staticIntensity !== undefined
                ? { intensity: staticIntensity }
                : {}),
            hasTexture: texture !== undefined,
            albedoScaling: albedoScalingEnabled,
        },
    };
}
