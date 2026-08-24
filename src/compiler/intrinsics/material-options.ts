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
    CompileAsset,
    ScenePbrAnisotropyManifest,
    ScenePbrMaterialManifest,
    Value,
    ValueKind,
} from "../types.js";
import {
    staticNumberPair,
    staticNumberValue,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";

export interface MaterialOptionContext
    extends ObjectValidationContext, PositiveIntegerContext {
    readonly scenePbrMaterials: ScenePbrMaterialManifest[];
    readonly assets: ReadonlyMap<string, CompileAsset>;
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
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileVec2(expression: ts.Expression): string;
}

/**
 * `createPbrMaterial`'s resolved options: the two texture values, the
 * sixteen native scalar/flag literals in constructor order, the resolved
 * scene-code occlusion strength, and the
 * appended `scenePbrMaterials` index that is this material's compile-time
 * identity.
 */
export type CompiledPbrMaterialOptions = [
    Value,
    Value,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    number,
];

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

/** The reached slice of the extension option objects the setters take. */
export type CompiledLayerOptions = [
    string,
    string,
    string,
    string,
    string,
];

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
            "ormTexture",
            "metallicFactor",
            "roughnessFactor",
            "directIntensity",
            "environmentIntensity",
            "alpha",
            "reflectance",
            "occlusionStrength",
            "doubleSided",
            "transmissive",
            "subsurface",
        ],
        "Reached PBR lowering supports base/ORM textures, metallic/roughness factors, alpha, reflectance, occlusion strength, lighting intensities, skybox mode, and transmission subsurface fields.",
    );
    const baseColorExpression = context.objectProperty(object, "baseColorTexture");
    const ormExpression = context.objectProperty(object, "ormTexture");
    if (!baseColorExpression || !ormExpression) {
        context.fail(object, "PBR material requires baseColorTexture and ormTexture.");
    }
    const baseColor = context.compileValue(baseColorExpression);
    const orm = context.compileValue(ormExpression);
    context.expectKind(baseColor, "texture", baseColorExpression);
    context.expectKind(orm, "texture", ormExpression);
    const metallic = context.objectProperty(object, "metallicFactor");
    const roughness = context.objectProperty(object, "roughnessFactor");
    const direct = context.objectProperty(object, "directIntensity");
    const environment = context.objectProperty(
        object,
        "environmentIntensity",
    );
    const alpha = context.objectProperty(object, "alpha");
    const reflectance = context.objectProperty(object, "reflectance");
    const occlusionStrength = context.objectProperty(
        object,
        "occlusionStrength",
    );
    const doubleSided = context.objectProperty(object, "doubleSided");
    const transmissive = context.objectProperty(object, "transmissive");
    const subsurfaceExpression = context.objectProperty(object, "subsurface");
    let transmission = "0.0f";
    let ior = "1.5f";
    let thickness = "0.0f";
    let useThicknessAsDepth = "false";
    let hasVolume = "false";
    let attenuationColor = "bbl::Color3{1.0f, 1.0f, 1.0f}";
    let attenuationDistance = "1.0f";
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
                    : "0.0f";
            ior = indexOfRefraction
                ? context.compileNumber(indexOfRefraction)
                : "1.5f";
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
            thickness = maximum ? context.compileNumber(maximum) : "1.0f";
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
        : "1.0f";
    const roughnessCpp = roughness
        ? context.compileNumber(roughness)
        : "1.0f";
    const directCpp = direct ? context.compileNumber(direct) : "1.0f";
    const environmentCpp = environment
        ? context.compileNumber(environment)
        : "1.0f";
    const alphaCpp = alpha ? context.compileNumber(alpha) : "1.0f";
    const reflectanceCpp = reflectance
        ? context.compileNumber(reflectance)
        : "0.04f";
    const staticOcclusionStrength = occlusionStrength
        ? staticNumberValue(context, occlusionStrength)
        : 1;
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
        : "1.0f";
    const doubleSidedCpp = doubleSided
        ? context.compileBoolean(doubleSided)
        : "false";
    // The resolved option values, in creation order, for the pinned
    // composer: the pin's `createPbrMaterial` is `{...props}`, so these
    // ARE the material record its feature derivation reads. Every value
    // above compiles from a static literal, which is why parsing the C++
    // text back is exact.
    const sceneMaterialIndex = context.scenePbrMaterials.push({
        materialsBefore: context.recordSceneMaterialSlot(),
        gltfAssetsBefore: [...context.assets.values()].filter(
            (asset) => asset.kind === "gltf",
        ).length,
        hasBaseColorTexture: true,
        hasOrmTexture: true,
        metallicFactor: Number.parseFloat(metallicCpp),
        roughnessFactor: Number.parseFloat(roughnessCpp),
        directIntensity: Number.parseFloat(directCpp),
        environmentIntensity: Number.parseFloat(environmentCpp),
        alpha: Number.parseFloat(alphaCpp),
        reflectance: Number.parseFloat(reflectanceCpp),
        ...(staticOcclusionStrength === 1
            ? {}
            : { occlusionStrength: staticOcclusionStrength }),
        doubleSided: doubleSidedCpp === "true",
        transmission: Number.parseFloat(transmission),
        ior: Number.parseFloat(ior),
        thickness: Number.parseFloat(thickness),
    }) - 1;
    return [
        baseColor,
        orm,
        metallicCpp,
        roughnessCpp,
        directCpp,
        environmentCpp,
        alphaCpp,
        reflectanceCpp,
        "false",
        doubleSidedCpp,
        "false",
        transmission,
        ior,
        thickness,
        useThicknessAsDepth,
        hasVolume,
        attenuationColor,
        attenuationDistance,
        occlusionStrengthCpp,
        sceneMaterialIndex,
    ];
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
): CompiledLayerOptions {
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
    return [
        isEnabled ? context.compileBoolean(isEnabled) : "false",
        intensity ? context.compileNumber(intensity) : "1.0f",
        roughness ? context.compileNumber(roughness) : "0.0f",
        indexOfRefraction
            ? context.compileNumber(indexOfRefraction)
            : "1.5f",
        bumpTextureScale
            ? context.compileNumber(bumpTextureScale)
            : "1.0f",
    ];
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
): CompiledLayerOptions {
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
    return [
        isEnabled ? context.compileBoolean(isEnabled) : "false",
        intensity ? context.compileNumber(intensity) : "1.0f",
        indexOfRefraction
            ? context.compileNumber(indexOfRefraction)
            : "1.3f",
        minimumThickness
            ? context.compileNumber(minimumThickness)
            : "100.0f",
        maximumThickness
            ? context.compileNumber(maximumThickness)
            : "400.0f",
    ];
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
        : ([1, 0] as const);
    const staticIntensity = intensity
        ? staticNumberValue(context, intensity)
        : 1;
    return {
        enabled,
        intensity: intensity ? context.compileNumber(intensity) : "1.0f",
        direction: direction
            ? context.compileVec2(direction)
            : "bbl::Vec2{1.0f, 0.0f}",
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
): {
    enabled: string;
    color: string;
    roughness: string;
    intensity: string;
    texture: ts.Expression | undefined;
    albedoScaling: boolean;
} {
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
    return {
        enabled: isEnabled
            ? context.compileBoolean(isEnabled)
            : "false",
        color: color
            ? context.compileColor3(color)
            : "bbl::Color3{1.0f, 1.0f, 1.0f}",
        roughness: roughness
            ? context.compileNumber(roughness)
            : "0.0f",
        intensity: intensity
            ? context.compileNumber(intensity)
            : "1.0f",
        texture: context.objectProperty(object, "texture"),
        albedoScaling: albedoScalingValue === "true",
    };
}
