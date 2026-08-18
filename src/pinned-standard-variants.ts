/**
 * Composes Standard-material shader variants through Babylon Lite's own
 * pipeline — the Standard sibling of `pinned-pbr-variants.ts`.
 *
 * The renderer currently ships `shader-builtins-standard.ts`, a hand-rewritten
 * fragment that re-encodes `createStandardTemplate` + `LIGHTING_FN` behind
 * uniform lanes (`textureOptions`, `uvOptions`, unrolled light slots). Babylon
 * composes one fragment per material feature set instead, through
 * `composeStandardShader` (`standard-pipeline.ts`), and every fork the
 * transcription re-expresses is a place it can drift. Nothing in this module
 * decides what a variant contains: the feature bits come from the pin's own
 * `_computeStandardMaterialFeatures`, the fragments from the pin's own std-*
 * fragment modules, and the assembly from `composeShader` via
 * `composeStandardShader` — the same execute-the-pin shape the shipped PBR
 * migration uses.
 *
 * How this repo's reach signals map onto the pin's bits, with the deriving
 * pinned site for each (all in `standard-material.ts`
 * `_computeStandardMaterialFeatures` unless noted; the renderable half is
 * `standard-renderable.ts` `rebuildSingle`):
 *
 * - `.babylon` material `diffuseTexture` → `HAS_DIFFUSE_TEXTURE` (and
 *   `NEEDS_UV`); `coordinatesIndex === 1` (cli `reachedDiffuseUv2` →
 *   `standardDiffuseUv2`) → `DIFFUSE_USES_UV2` (+`NEEDS_UV2`).
 * - `emissiveTexture` → `HAS_EMISSIVE_TEXTURE`; a render-texture source
 *   (`_sampleType === "depth"`) → `HAS_DEPTH_EMISSIVE_TEXTURE`.
 * - `bumpTexture` (cli `reachedStandardBump` → `standardBump`) →
 *   `HAS_BUMP_TEXTURE`.
 * - `specularTexture` → `HAS_SPECULAR_TEXTURE`; `coordinatesIndex === 1` →
 *   `SPECULAR_USES_UV2`.
 * - `ambientTexture` → `HAS_AMBIENT_TEXTURE`; `coordinatesIndex === 1` →
 *   `AMBIENT_USES_UV2`.
 * - `opacityTexture` → `HAS_OPACITY_TEXTURE` (`opacityFromRGB` →
 *   `OPACITY_FROM_RGB`, unreached by this port's loader).
 * - `lightmapTexture` → `HAS_LIGHTMAP_TEXTURE` family — no reached scene
 *   carries one; composes here regardless, since the pin's ext owns it.
 * - `backFaceCulling === false` → `DOUBLE_SIDED` (pipeline cull state; no
 *   WGSL change).
 * - `reflectionCubeTexture` → `HAS_CUBE_REFLECTION`; a 2D
 *   `reflectionTexture` → `HAS_REFLECTION_TEXTURE` (unreached: this port
 *   loads only the cube form).
 * - `disableLighting` → `DISABLE_LIGHTING`; `alpha < 1` →
 *   `MATERIAL_ALPHA_BLEND`.
 * - Feature `material:standard-vertex-colors` → the pin's opt-in
 *   `enableStandardVertexColors` + a mesh colour buffer: `rebuildSingle`
 *   pushes `_stdVertexColorFragment(hasDiffuse, vertexAlpha)`, and
 *   `hasVertexAlpha` adds `VERTEX_ALPHA | MATERIAL_ALPHA_BLEND`.
 * - Feature `renderer:fog` → `scene.fog`: `standard-group-builder.ts` builds
 *   `sceneShader = { _features: STD_SCENE_FOG, _fragments: [fogFragment] }`.
 * - `standardLights` / `standardSpotLights` / `standardLightLists` map to
 *   **no feature bit**: the pinned fragment always declares
 *   `array<LightEntry, MAX_LIGHTS>` and loops `min(mesh.lc, MAX_LIGHTS)`
 *   through `mli()` (`standard-template.ts` LIGHTING_FN + `lights-ubo.ts`),
 *   so light count, kind dispatch and per-mesh lists are UBO data — the
 *   transcription's unrolled slots and its spot empty-slot tagging retire.
 * - `geometryOutputTasks` → the pin's own MRT arm,
 *   `composeStandardGeometryShader` (`standard-geometry-output-shader.ts`),
 *   reached through a material view carrying
 *   `(features & ~MATERIAL_ALPHA_BLEND) | GEOMETRY_OUTPUT`.
 * - Feature `material:no-color-view` → `NO_COLOR_OUTPUT` as a pass feature
 *   (`no-color-view.ts` ORs it onto the view).
 *
 * Everything the pin's renderable can reach that this repo cannot yet supply
 * throws by name below — the wave-D worklist, not a silent approximation.
 */
import ts from "typescript";
import type { LoweringContext } from "./lowering/context.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

/** The material fields the pin's Standard feature derivation reads. */
export interface PinnedStandardMaterialInput {
    diffuseTexture?: unknown;
    diffuseCoordIndex?: number;
    emissiveTexture?: unknown;
    bumpTexture?: unknown;
    specularTexture?: unknown;
    specularCoordIndex?: number;
    ambientTexture?: unknown;
    ambientCoordIndex?: number;
    lightmapTexture?: unknown;
    lightmapCoordIndex?: number;
    useLightmapAsShadowmap?: boolean;
    opacityTexture?: unknown;
    opacityFromRGB?: boolean;
    reflectionTexture?: unknown;
    reflectionCubeTexture?: unknown;
    /** The pin's default is `true` (`createStandardMaterial`); an absent
     *  value is normalized to it so `DOUBLE_SIDED` needs an explicit opt-in
     *  the way it does upstream. */
    backFaceCulling?: boolean;
    disableLighting?: boolean;
    /** Defaults to the pin's 1; below 1 adds `MATERIAL_ALPHA_BLEND`. */
    alpha?: number;
    [key: string]: unknown;
}

/** A composed Standard variant plus the bits that produced it. */
export interface PinnedStandardVariant {
    /** The pin's own key: the composed fragment ids joined `|`, from
     *  `composeShader`'s `_fragmentKey` (empty for the bare template). */
    fragmentKey: string;
    features: number;
    meshFeatures: number;
    vertexWgsl: string;
    fragmentWgsl: string;
    /**
     * The composed mesh-UBO layout (`_meshUboSpec`), plain. The Standard
     * template carries no `_baseMaterialUboFields`, so `composeShader`
     * returns no `_materialUboSpec`: the material block is the template's
     * own inline `matUniforms` text, fixed at the renderable's `F32(24)`
     * (96 bytes), which `pinnedStandardVariantsHeader` mirrors and
     * cross-checks.
     */
    meshUboSpec: unknown;
}

export interface PinnedStandardComposeOptions {
    /** The pin's `MSH_*` bits for the mesh this material is drawn on. */
    meshFeatures?: number;
    /** Bits a material view ORs in — `NO_COLOR_OUTPUT` is the reached one. */
    passFeatures?: number;
    /** `scene.fog`: composes the pin's std-fog fragment as the scene shader. */
    fog?: boolean;
    /**
     * The pin's opt-in vertex-colour fragment
     * (`enableStandardVertexColors` + a mesh colour buffer). `vertexAlpha`
     * mirrors `mesh.hasVertexAlpha`, which also adds
     * `VERTEX_ALPHA | MATERIAL_ALPHA_BLEND` the way `rebuildSingle` does.
     */
    vertexColors?: { vertexAlpha: boolean };
    /**
     * Compose the pin's geometry-output MRT arm instead of the colour
     * fragment. Attachment names are the manifest's
     * `GeometryTextureTypeName`s, mapped onto the pin's enum here.
     */
    geometry?: {
        attachments: readonly string[];
        emitColor: boolean;
    };
}

/** The subset of a pinned std extension the composition path reads. */
interface StdExtDescriptor {
    _id: string;
    _feature: number;
    _meshFeatures?: (meshFeatures: number) => number;
    _frag: (features: number, meshFeatures: number) => unknown;
}

/**
 * The pin's own material-extension registrations, from
 * `standard-group-builder.ts` `_STD_MAT_EXTS`. Upstream registers each on
 * demand when a scene material carries the property; iteration order is
 * `_getStdExtsSorted()` — sorted by id — either way, and none of these
 * contributes `_meshFeatures`, so registering all of them unconditionally
 * composes identically for every feature set while keeping the process-global
 * registry independent of which scene composes first (the same reasoning as
 * the PBR environment extension).
 *
 * Deliberately absent: `stdSkeletonExt` — upstream registers it only through
 * `enableStandardSkeleton()`, which no reached scene calls, and unlike these
 * eight it rewrites mesh bits into feature bits (`_meshFeatures`), so its
 * registration is observable. A skeleton request throws below instead.
 */
const standardExtensionModules: ReadonlyArray<readonly [string, string]> = [
    ["material/standard/fragments/normal-map-fragment.js", "bumpStdExt"],
    ["material/standard/fragments/std-emissive-fragment.js", "stdEmissiveExt"],
    ["material/standard/fragments/std-specular-fragment.js", "stdSpecularExt"],
    ["material/standard/fragments/std-ambient-fragment.js", "stdAmbientExt"],
    ["material/standard/fragments/std-lightmap-fragment.js", "stdLightmapExt"],
    ["material/standard/fragments/std-opacity-fragment.js", "stdOpacityExt"],
    [
        "material/standard/fragments/std-reflection-fragment.js",
        "stdReflectionExt",
    ],
    [
        "material/standard/fragments/std-cube-reflection-fragment.js",
        "stdCubeReflectionExt",
    ],
];

let registered: Promise<void> | undefined;

async function registerStandardExtensions(): Promise<void> {
    registered ??= (async () => {
        const flags = await importPinnedModule<{
            _registerStdExt: (ext: StdExtDescriptor) => void;
        }>("material/standard/standard-flags.js");
        for (const [path, exportName] of standardExtensionModules) {
            const module = await importPinnedModule<
                Record<string, StdExtDescriptor>
            >(path);
            const ext = module[exportName];
            if (!ext) {
                throw new Error(
                    `Pinned module ${path} no longer exports ` +
                        `${exportName}.`,
                );
            }
            flags._registerStdExt(ext);
        }
    })();
    return registered;
}

/** The std extension ids the pin has registered, in its own sorted order. */
export async function registeredStandardExtensionIds(): Promise<
    readonly string[]
> {
    await registerStandardExtensions();
    const flags = await importPinnedModule<{
        _getStdExtsSorted: () => readonly StdExtDescriptor[];
    }>("material/standard/standard-flags.js");
    return flags._getStdExtsSorted().map((ext) => ext._id);
}

/**
 * Derives a material's Standard feature bits the way the pin does.
 *
 * The input is normalized with the two defaults `createStandardMaterial`
 * seeds — `backFaceCulling: true` and `alpha: 1` — because the pin's detect
 * reads them as plain truthiness (`!m.backFaceCulling`, `m.alpha < 1`) and an
 * absent property would otherwise flip bits no upstream material flips.
 */
export async function pinnedStandardMaterialFeatures(
    material: PinnedStandardMaterialInput,
): Promise<number> {
    const materialModule = await importPinnedModule<{
        _computeStandardMaterialFeatures: (
            material: PinnedStandardMaterialInput,
        ) => number;
    }>("material/standard/standard-material.js");
    return materialModule._computeStandardMaterialFeatures({
        ...material,
        backFaceCulling: material.backFaceCulling ?? true,
        alpha: material.alpha ?? 1,
    });
}

interface ComposedStandardShader {
    _vertexWGSL: string;
    _fragmentWGSL: string;
    _fragmentKey: string;
    _meshUboSpec: unknown;
}

/** `_meshUboSpec` as plain data, mirroring `plainMaterialUboSpec` for PBR. */
function plainMeshUboSpec(spec: unknown): unknown {
    const record = spec as
        | { _totalBytes?: number; _offsets?: unknown; _structBody?: string }
        | undefined;
    if (!record) return spec;
    const offsets: Record<string, number> = {};
    if (record._offsets instanceof Map) {
        for (const [name, offset] of record._offsets as Map<string, number>) {
            offsets[name] = offset;
        }
    }
    return {
        _totalBytes: record._totalBytes,
        _offsets: offsets,
        _structBody: record._structBody,
    };
}

/**
 * Composes the Standard variant for one material.
 *
 * The fragments array is assembled exactly the way
 * `standard-renderable.ts#rebuildSingle` assembles it — morph first (its
 * `_pc` hook must sit at index 0 for `composeStandardShader` to apply it),
 * then each registered extension's `_frag` in sorted-id order, then the
 * vertex-colour fragment — and every renderable input this repo cannot yet
 * supply throws by name rather than composing a plausible neighbour.
 */
export async function composePinnedStandardVariant(
    material: PinnedStandardMaterialInput,
    options: PinnedStandardComposeOptions = {},
): Promise<PinnedStandardVariant> {
    await registerStandardExtensions();
    const [flags, meshBits, pipeline, fog, vertexColor, morph, thinInstance] =
        await Promise.all([
            importPinnedModule<{
                _getStdExtsSorted: () => readonly StdExtDescriptor[];
                STD_SCENE_FOG: number;
                HAS_DIFFUSE_TEXTURE: number;
                VERTEX_ALPHA: number;
                MATERIAL_ALPHA_BLEND: number;
                ESM_SHADOW_OUTPUT: number;
                GEOMETRY_OUTPUT: number;
            }>("material/standard/standard-flags.js"),
            importPinnedModule<{
                MSH_HAS_SKELETON: number;
                MSH_HAS_SKELETON_8: number;
                MSH_VAT: number;
                MSH_HAS_MORPH_TARGETS: number;
                MSH_HAS_THIN_INSTANCES: number;
                MSH_HAS_INSTANCE_COLOR: number;
                MSH_RECEIVE_SHADOWS: number;
            }>("material/mesh-features.js"),
            importPinnedModule<{
                composeStandardShader: (
                    features: number,
                    meshFeatures: number,
                    fragments: readonly unknown[],
                    esmShadowDepthCode: string,
                    sceneShader: unknown,
                ) => ComposedStandardShader;
            }>("material/standard/standard-pipeline.js"),
            importPinnedModule<{
                createStandardFogFragment: () => unknown;
            }>("material/standard/std-fog-wgsl.js"),
            importPinnedModule<{
                createStdVertexColorFragment: (
                    hasDiffuse: boolean,
                    hasVertexAlpha: boolean,
                ) => unknown;
            }>("material/standard/fragments/std-vertex-color-fragment.js"),
            importPinnedModule<{
                createMorphFragment: () => unknown;
            }>("shader/fragments/morph-fragment-core.js"),
            // The pin's shared thin-instance fragment: the same module the
            // Standard group builder imports for a pool-carrying mesh
            // (`standard-group-builder.ts` resolves `tiFragment` from it),
            // and the same one the PBR composition already passes through
            // `_createThinInstanceFragment`.
            importPinnedModule<{
                createThinInstanceFragment: (
                    hasInstanceColor: boolean,
                ) => unknown;
            }>("shader/fragments/thin-instance-fragment.js"),
        ]);
    const meshFeatures = options.meshFeatures ?? 0;
    if (
        meshFeatures &
        (meshBits.MSH_HAS_SKELETON | meshBits.MSH_HAS_SKELETON_8 |
            meshBits.MSH_VAT)
    ) {
        throw new Error(
            "Pinned Standard skeletons are not composable yet: upstream " +
                "reaches them through enableStandardSkeleton(), which " +
                "registers stdSkeletonExt and rewrites mesh bits into " +
                "HAS_SKELETON, and no reached scene enables it.",
        );
    }
    if (meshFeatures & meshBits.MSH_RECEIVE_SHADOWS) {
        throw new Error(
            "Pinned Standard received shadows are not composable yet: the " +
                "shadow fragment (createStdShadowFragment) is built from the " +
                "scene's shadow-generator slots, which this port does not " +
                "carry.",
        );
    }
    if (meshFeatures & meshBits.MSH_HAS_INSTANCE_COLOR) {
        throw new Error(
            "Pinned Standard instance colours are not composable yet: " +
                "rebuildSingle rewrites the thin-instance fragment's BC " +
                "slot with an inline literal this module does not carry, " +
                "and no reached scene supplies per-instance colours.",
        );
    }
    let features = await pinnedStandardMaterialFeatures(material);
    const passFeatures = options.passFeatures ?? 0;
    if ((features | passFeatures) & flags.ESM_SHADOW_OUTPUT) {
        throw new Error(
            "Pinned Standard ESM shadow output is not composable yet: the " +
                "depth code is supplied per material by the ESM shadow view " +
                "(_esmShadowDepthCode), which this port does not build.",
        );
    }
    // `rebuildSingle` adds the vertex-alpha bits before the extension loop,
    // so `_frag(features, ...)` sees them exactly as it does upstream.
    if (options.vertexColors?.vertexAlpha) {
        features |= flags.VERTEX_ALPHA | flags.MATERIAL_ALPHA_BLEND;
    }
    const fragments: unknown[] = [];
    if (meshFeatures & meshBits.MSH_HAS_MORPH_TARGETS) {
        fragments.push(morph.createMorphFragment());
    }
    for (const ext of flags._getStdExtsSorted()) {
        features |= ext._meshFeatures?.(meshFeatures) ?? 0;
        if (features & ext._feature) {
            const fragment = ext._frag(features, meshFeatures);
            if (fragment) fragments.push(fragment);
        }
    }
    if (options.vertexColors) {
        fragments.push(
            vertexColor.createStdVertexColorFragment(
                (features & flags.HAS_DIFFUSE_TEXTURE) !== 0,
                options.vertexColors.vertexAlpha,
            ),
        );
    }
    // `rebuildSingle` splices the thin-instance fragment after the
    // vertex-colour one (the shadow fragment between them throws above), so
    // the composed order is the pin's own. The colourless form is pushed
    // unrewritten, exactly as the renderable does when the pool carries no
    // instance colours.
    if (meshFeatures & meshBits.MSH_HAS_THIN_INSTANCES) {
        fragments.push(thinInstance.createThinInstanceFragment(false));
    }
    const sceneShader = options.fog
        ? {
            _features: flags.STD_SCENE_FOG,
            _fragments: [fog.createStandardFogFragment()],
        }
        : null;
    if (options.geometry) {
        // The pin's own MRT arm. `createStandardGeometryMaterialView` keys
        // the view on `(features & ~MATERIAL_ALPHA_BLEND) | GEOMETRY_OUTPUT`
        // and `composeStandardGeometryShader` strips the blend bit again
        // before composing, rewrites the composed return into per-attachment
        // writes, and appends its own params fragment when an attachment
        // needs the gp UBO, velocity varyings or the local position.
        const [geometry, types] = await Promise.all([
            importPinnedModule<{
                composeStandardGeometryShader: (
                    features: number,
                    meshFeatures: number,
                    extFragments: readonly unknown[],
                    attachments: readonly number[],
                    esmShadowDepthCode: string,
                    emitColor: boolean,
                    sceneShader: unknown,
                ) => ComposedStandardShader;
            }>("material/standard/standard-geometry-output-shader.js"),
            importPinnedModule<{
                GeometryTextureType: Record<string, number>;
            }>("frame-graph/geometry-types.js"),
        ]);
        const attachments = options.geometry.attachments.map((name) => {
            const value = types.GeometryTextureType[name];
            if (value === undefined) {
                throw new Error(
                    `Unknown geometry texture type '${name}'.`,
                );
            }
            return value;
        });
        const viewFeatures =
            (features & ~flags.MATERIAL_ALPHA_BLEND) | flags.GEOMETRY_OUTPUT |
            passFeatures;
        const composed = geometry.composeStandardGeometryShader(
            viewFeatures,
            meshFeatures,
            fragments,
            attachments,
            "",
            options.geometry.emitColor,
            sceneShader,
        );
        return {
            fragmentKey: composed._fragmentKey,
            features: viewFeatures,
            meshFeatures,
            vertexWgsl: composed._vertexWGSL,
            fragmentWgsl: composed._fragmentWGSL,
            meshUboSpec: plainMeshUboSpec(composed._meshUboSpec),
        };
    }
    const composed = pipeline.composeStandardShader(
        features | passFeatures,
        meshFeatures,
        fragments,
        "",
        sceneShader,
    );
    return {
        fragmentKey: composed._fragmentKey,
        features: features | passFeatures,
        meshFeatures,
        vertexWgsl: composed._vertexWGSL,
        fragmentWgsl: composed._fragmentWGSL,
        meshUboSpec: plainMeshUboSpec(composed._meshUboSpec),
    };
}

/**
 * One emitted Standard variant, as `upstream-lower.ts` writes it into the
 * generated tree — the Standard mirror of `PinnedVariantManifestEntry`.
 * Selector rows (which renderable resolves which variant) are wave-D work:
 * generation-side composition ships first, behind an option nothing sets.
 */
export interface PinnedStandardVariantManifestEntry {
    fragmentKey: string;
    features: number;
    meshFeatures: number;
    /** Emitted file names, `<stem>.vert.wgsl` / `<stem>.frag.wgsl`. */
    vertex: string;
    fragment: string;
    vertexWgsl: string;
    fragmentWgsl: string;
}

/** A deterministic file stem for a composed Standard variant. */
export function pinnedStandardVariantFileStem(
    variant: Pick<
        PinnedStandardVariant,
        "fragmentKey" | "features" | "meshFeatures"
    >,
): string {
    const slug = variant.fragmentKey
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    return [
        slug || "base",
        `f${variant.features}`,
        variant.meshFeatures ? `msh${variant.meshFeatures}` : "",
    ].filter((part) => part !== "").join("-");
}

/** Builds the manifest entry for one composed variant. */
export function pinnedStandardVariantManifestEntry(
    variant: PinnedStandardVariant,
): PinnedStandardVariantManifestEntry {
    const stem = pinnedStandardVariantFileStem(variant);
    return {
        fragmentKey: variant.fragmentKey,
        features: variant.features,
        meshFeatures: variant.meshFeatures,
        vertex: `${stem}.vert.wgsl`,
        fragment: `${stem}.frag.wgsl`,
        vertexWgsl: variant.vertexWgsl,
        fragmentWgsl: variant.fragmentWgsl,
    };
}

/**
 * One selector row: how a native draw resolves its composed variant.
 *
 * Unlike the PBR family, the key deliberately carries no material index.
 * Scene-code Standard materials are not manifest-tracked per handle (only
 * `sceneMaterialCount` counts them), and the runtime sweep keeps creating
 * them after registration — so an index-keyed table cannot cover the reached
 * corpus. What the native side *can* recover exactly is the pin's own
 * feature word: `standard_material_features` below is lowered from
 * `_computeStandardMaterialFeatures`'s own AST over the fields the record
 * carries, and generation composes with the same pinned function over the
 * same correspondences, so the two agree bit for bit.
 */
export interface PinnedStandardSelector {
    /** The pin's feature word as the native derivation computes it. */
    features: number;
    /** The `MSH_*` bits for the mesh half of the key. */
    meshFeatures: number;
    /** The geometry-output task an MRT variant draws in; absent for the
     *  colour and depth-only passes. */
    geometryTask?: number;
    /** Index into the emitted variant table. */
    variant: number;
}

/** A numeric pinned constant, evaluated from its own declaration. */
function pinnedNumericConstant(
    context: LoweringContext,
    modulePath: string,
    name: string,
): number {
    const file = context.sourceFile(modulePath);
    const evaluate = (expression: ts.Expression): number => {
        const unwrapped = context.unwrapExpression(expression);
        if (ts.isNumericLiteral(unwrapped)) {
            return Number.parseInt(unwrapped.text, 10);
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const left = evaluate(unwrapped.left);
            const right = evaluate(unwrapped.right);
            switch (unwrapped.operatorToken.kind) {
                case ts.SyntaxKind.LessThanLessThanToken:
                    return left << right;
                case ts.SyntaxKind.BarToken:
                    return left | right;
                default:
                    break;
            }
        }
        if (ts.isIdentifier(unwrapped)) {
            return evaluate(
                context.variableInitializer(file, unwrapped.text),
            );
        }
        throw new Error(
            `Pinned constant ${name} in ${modulePath} is not a shift/or ` +
                "expression over numeric literals.",
        );
    };
    return evaluate(context.variableInitializer(file, name));
}

/**
 * How the pin's `StandardMaterialProps` reads map onto our MaterialRecord.
 *
 * A null source folds the pin's condition to false because the generated
 * loader never fills the input — each null names the loader fact that makes
 * it so, and the generation-side composition input builder must mirror the
 * same absences so the two derivations stay bit-identical.
 */
const standardFeatureRecordSources: Readonly<
    Record<string, string | null>
> = {
    // babylon-loader-cpp.ts fills base_color_texture from diffuseTexture.
    diffuseTexture: "!material.base_color_texture.bytes.empty()",
    diffuseCoordIndex: "material.diffuse_coord_index",
    // The compiled `material.emissiveTexture = <render texture>` setter is
    // the only native source of a Standard emissive texture (the .babylon
    // loader loads none), and it is always the pin's depth-sampled render
    // texture, so both the presence bit and the depth arm key off the flag.
    emissiveTexture: "material.has_emissive_render_texture",
    bumpTexture: "!material.bump_texture.bytes.empty()",
    specularTexture: "!material.specular_texture.bytes.empty()",
    specularCoordIndex: "material.specular_coord_index",
    ambientTexture: "!material.ambient_texture.bytes.empty()",
    ambientCoordIndex: "material.ambient_coord_index",
    // The generated .babylon loader loads no lightmap slot.
    lightmapTexture: null,
    lightmapCoordIndex: null,
    useLightmapAsShadowmap: null,
    opacityTexture: "!material.opacity_texture.bytes.empty()",
    // The loader never reads getAlphaFromRGB, so the record cannot carry it.
    opacityFromRGB: null,
    // texture_data() drops isCube entries and the loader keeps only the cube
    // form of reflectionTexture, so the 2D arm is unreachable natively.
    reflectionTexture: null,
    reflectionCubeTexture: "material.reflection_cube != invalid_handle",
    backFaceCulling: "!material.double_sided",
    disableLighting: "material.disable_lighting",
    // Standard alpha rides the record's base colour alpha: the compiled
    // `material.alpha` setter writes base_color_factor.a and the loader
    // seeds it from the .babylon `alpha`.
    alpha: "material.base_color_factor.a",
};

/**
 * `_computeStandardMaterialFeatures`, lowered from its own pinned AST.
 *
 * The structure — which condition guards which `f |= FLAG`, and how the
 * conditions nest — is walked out of the declaration; only the property→
 * record correspondence above is this repo's. A condition over an unmapped
 * property folds to false exactly as the absent loader input would upstream,
 * and a shape the walker does not recognize fails by name so a pin change
 * arrives as a generation error rather than a silent approximation.
 */
function lowerStandardFeatureDerivation(
    context: LoweringContext,
): string {
    const modulePath = "src/material/standard/standard-material.ts";
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        "_computeStandardMaterialFeatures",
    );
    const flagValue = (name: string): number =>
        pinnedNumericConstant(
            context,
            "src/material/standard/standard-flags.ts",
            name,
        );
    const fail = (node: ts.Node, reason: string): never => {
        throw new Error(
            `Cannot lower _computeStandardMaterialFeatures: ${reason} ` +
                `(${node.getText(file)}).`,
        );
    };
    const propertyName = (expression: ts.Expression): string | undefined => {
        const unwrapped = context.unwrapExpression(expression);
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "m"
        ) {
            return unwrapped.name.text;
        }
        return undefined;
    };
    /** A condition as C++, or undefined for a branch that folds to false. */
    const lowerCondition = (
        expression: ts.Expression,
    ): string | undefined => {
        const unwrapped = context.unwrapExpression(expression);
        const direct = propertyName(unwrapped);
        if (direct !== undefined) {
            const source = standardFeatureRecordSources[direct];
            if (source === undefined) {
                fail(unwrapped, `property '${direct}' has no record source`);
            }
            return source === null ? undefined : source;
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator === ts.SyntaxKind.ExclamationToken
        ) {
            const operand = lowerCondition(unwrapped.operand);
            // `!absent` is truthy upstream only for inputs the loader never
            // fills with a value that flips the pin's default; the one `!`
            // the pin uses is backFaceCulling, whose source is mapped.
            return operand === undefined
                ? fail(unwrapped, "negation of an unmapped property")
                : `!(${operand})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const operator = unwrapped.operatorToken.kind;
            const left = context.unwrapExpression(unwrapped.left);
            const right = context.unwrapExpression(unwrapped.right);
            // `m.emissiveTexture._sampleType === "depth"`: the native
            // record's only emissive source is the compiled render-texture
            // setter, which is the pin's depth-sampled texture.
            if (
                operator === ts.SyntaxKind.EqualsEqualsEqualsToken &&
                ts.isPropertyAccessExpression(left) &&
                left.name.text === "_sampleType" &&
                propertyName(left.expression) === "emissiveTexture" &&
                ts.isStringLiteral(right) &&
                right.text === "depth"
            ) {
                return standardFeatureRecordSources["emissiveTexture"] ??
                    undefined;
            }
            // `m.lightmapTexture.uAng === Math.PI` and any other read off an
            // unmapped property folds with its property.
            if (
                ts.isPropertyAccessExpression(left) &&
                propertyName(left.expression) !== undefined &&
                standardFeatureRecordSources[
                    propertyName(left.expression)!
                ] === null
            ) {
                return undefined;
            }
            const property = propertyName(left);
            if (property !== undefined) {
                const source = standardFeatureRecordSources[property];
                if (source === undefined) {
                    fail(left, `property '${property}' has no record source`);
                }
                if (source === null) return undefined;
                if (!ts.isNumericLiteral(right)) {
                    return fail(right, "comparison against a non-literal");
                }
                if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken) {
                    return `${source} == ${right.text}u`;
                }
                if (operator === ts.SyntaxKind.LessThanToken) {
                    return `${source} < ${right.text}.0f`;
                }
                fail(unwrapped, "unsupported comparison operator");
            }
        }
        return fail(unwrapped, "unsupported condition shape");
    };
    const lines: string[] = [];
    const lowerStatements = (
        statements: ts.NodeArray<ts.Statement>,
        indent: string,
    ): void => {
        for (const statement of statements) {
            if (ts.isVariableStatement(statement)) continue;
            if (ts.isReturnStatement(statement)) continue;
            if (
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.BarEqualsToken
            ) {
                const flag = context.unwrapExpression(
                    statement.expression.right,
                );
                if (!ts.isIdentifier(flag)) {
                    fail(flag, "|= against a non-identifier flag");
                    continue;
                }
                lines.push(
                    `${indent}features |= ${
                        flagValue((flag as ts.Identifier).text)
                    }u; // ${(flag as ts.Identifier).text}`,
                );
                continue;
            }
            if (ts.isIfStatement(statement)) {
                if (!ts.isBlock(statement.thenStatement)) {
                    fail(statement, "if without a block body");
                    continue;
                }
                if (statement.elseStatement) {
                    fail(statement, "else branches are not lowered");
                }
                const condition = lowerCondition(statement.expression);
                if (condition === undefined) continue;
                lines.push(`${indent}if (${condition}) {`);
                lowerStatements(
                    (statement.thenStatement as ts.Block).statements,
                    `${indent}    `,
                );
                lines.push(`${indent}}`);
                continue;
            }
            fail(statement, "unsupported statement shape");
        }
    };
    if (!declaration.body) {
        throw new Error(
            "_computeStandardMaterialFeatures has no body to lower.",
        );
    }
    lowerStatements(declaration.body.statements, "    ");
    return lines.join("\n");
}

/** What a scene reaches, as the Standard composition driver needs it. */
export interface StandardSceneCompositionInput {
    /** Materialized `.babylon` asset paths, in load order. */
    babylonAssets: readonly string[];
    /** The emit options that shape the generated loader's material records:
     *  the bump slot exists only under `standardBump`, and the diffuse
     *  coordinate index is read only under `standardDiffuseUv2`. */
    bumpTexture: boolean;
    diffuseUv2: boolean;
    fog: boolean;
    /** `material:standard-vertex-colors` reached (the pin's opt-in). */
    vertexColors: boolean;
    /** `material:no-color-view` reached: depth-only views over the
     *  scene-code materials. */
    noColorViews: boolean;
    /** Whether the compiled surface can hand a render texture to
     *  `material.emissiveTexture` (any scene with frame tasks can). */
    emissiveRenderTexture: boolean;
    /** `mesh:thin-instances*` reached: pools can attach to scene meshes. */
    thinInstances: boolean;
    /** Morph storage/deformation reached for scene meshes. */
    morphTargets: boolean;
    /** Whether the scene creates Standard materials from scene code. */
    sceneMaterials: boolean;
    /** Distinct mesh-feature values of the scene-code meshes. */
    sceneMeshFeatureValues: readonly number[];
    geometryTasks: readonly {
        index: number;
        attachments: readonly string[];
        emitColor: boolean;
    }[];
}

export interface StandardSceneComposition {
    variants: PinnedStandardVariantManifestEntry[];
    selectors: PinnedStandardSelector[];
}

interface BabylonTextureJson {
    name?: string;
    isCube?: boolean;
    coordinatesIndex?: number;
}

interface BabylonMaterialJson {
    diffuseTexture?: BabylonTextureJson | null;
    specularTexture?: BabylonTextureJson | null;
    opacityTexture?: BabylonTextureJson | null;
    ambientTexture?: BabylonTextureJson | null;
    bumpTexture?: BabylonTextureJson | null;
    reflectionTexture?: BabylonTextureJson | null;
    backFaceCulling?: boolean;
    alpha?: number;
}

/**
 * A 2D slot the generated loader's `texture_data` would fill. A `.babylon`
 * export writes an unused slot as JSON null rather than omitting it — Sponza
 * does for every one — and the loader's `is_object()` reads null as absent.
 */
function babylonTexture2d(
    texture: BabylonTextureJson | null | undefined,
): texture is BabylonTextureJson {
    return texture !== undefined &&
        texture !== null &&
        typeof texture === "object" &&
        texture.isCube !== true &&
        typeof texture.name === "string" &&
        texture.name !== "";
}

/**
 * A `.babylon` material as the pin's feature derivation must see it to match
 * the generated loader's record — every absence below mirrors a loader fact
 * (`babylon-loader-cpp.ts`): no emissive/lightmap slots, no 2D reflections,
 * the bump slot only under its option, the diffuse coordinate index only
 * under its option, and `disableLighting` never read.
 */
function babylonMaterialInput(
    material: BabylonMaterialJson,
    options: { bumpTexture: boolean; diffuseUv2: boolean },
): PinnedStandardMaterialInput {
    const coord = (texture: BabylonTextureJson | undefined): number =>
        texture?.coordinatesIndex === 1 ? 1 : 0;
    return {
        ...(babylonTexture2d(material.diffuseTexture)
            ? {
                diffuseTexture: {},
                diffuseCoordIndex: options.diffuseUv2
                    ? coord(material.diffuseTexture)
                    : 0,
            }
            : {}),
        ...(babylonTexture2d(material.specularTexture)
            ? {
                specularTexture: {},
                specularCoordIndex: coord(material.specularTexture),
            }
            : {}),
        ...(babylonTexture2d(material.opacityTexture)
            ? { opacityTexture: {} }
            : {}),
        ...(babylonTexture2d(material.ambientTexture)
            ? {
                ambientTexture: {},
                ambientCoordIndex: coord(material.ambientTexture),
            }
            : {}),
        ...(options.bumpTexture && babylonTexture2d(material.bumpTexture)
            ? { bumpTexture: {} }
            : {}),
        ...(material.reflectionTexture?.isCube === true &&
                typeof material.reflectionTexture.name === "string" &&
                material.reflectionTexture.name !== ""
            ? { reflectionCubeTexture: {} }
            : {}),
        backFaceCulling: material.backFaceCulling ?? true,
        alpha: material.alpha ?? 1,
    };
}

/**
 * The scene-code material inputs the compiled setter surface can produce.
 *
 * `createStandardMaterial` takes no arguments and the compiled assignment
 * surface writes exactly `disableLighting`, `backFaceCulling`, `alpha` (and
 * the colours, which flip no feature bit) — plus `emissiveTexture`, which
 * only accepts a render texture. So the reachable feature space is the
 * closure over those setters, a language-surface fact rather than a scene
 * heuristic.
 */
function sceneCodeMaterialInputs(
    options: { emissiveRenderTexture: boolean },
): PinnedStandardMaterialInput[] {
    const inputs: PinnedStandardMaterialInput[] = [];
    for (const disableLighting of [false, true]) {
        for (const doubleSided of [false, true]) {
            for (const alphaBlend of [false, true]) {
                for (
                    const emissive of options.emissiveRenderTexture
                        ? [false, true]
                        : [false]
                ) {
                    inputs.push({
                        ...(disableLighting
                            ? { disableLighting: true }
                            : {}),
                        backFaceCulling: !doubleSided,
                        alpha: alphaBlend ? 0.5 : 1,
                        ...(emissive
                            ? {
                                emissiveTexture: {
                                    _sampleType: "depth",
                                },
                            }
                            : {}),
                    });
                }
            }
        }
    }
    return inputs;
}

/**
 * Composes every Standard variant a scene can reach, with the selector rows
 * that resolve them, deduplicated by composed text the way
 * `writePinnedPbrVariants` deduplicates the PBR set.
 */
export async function composeSceneStandardVariants(
    input: StandardSceneCompositionInput,
    readAsset: (path: string) => string,
): Promise<StandardSceneComposition> {
    const meshBits = await importPinnedModule<{
        MSH_HAS_MORPH_TARGETS: number;
        MSH_HAS_THIN_INSTANCES: number;
        MSH_HAS_VERTEX_COLOR: number;
    }>("material/mesh-features.js");
    const flags = await importPinnedModule<{
        NO_COLOR_OUTPUT: number;
    }>("material/standard/standard-flags.js");
    // The material feature values reachable, derivation by the pin itself.
    const materialInputs: PinnedStandardMaterialInput[] = [];
    if (input.sceneMaterials) {
        materialInputs.push(
            ...sceneCodeMaterialInputs({
                emissiveRenderTexture: input.emissiveRenderTexture,
            }),
        );
    }
    for (const asset of input.babylonAssets) {
        const document = JSON.parse(readAsset(asset)) as {
            materials?: BabylonMaterialJson[];
        };
        for (const material of document.materials ?? []) {
            materialInputs.push(
                babylonMaterialInput(material, {
                    bumpTexture: input.bumpTexture,
                    diffuseUv2: input.diffuseUv2,
                }),
            );
        }
        // The loader's lazily-created fallback material for a mesh with no
        // resolvable id: the pin's plain defaults.
        materialInputs.push({});
    }
    const featureValues: number[] = [];
    for (const material of materialInputs) {
        const features = await pinnedStandardMaterialFeatures(material);
        if (!featureValues.includes(features)) {
            featureValues.push(features);
        }
    }
    // Keep one representative input per feature value: composition depends
    // only on the derived word (and the options), so the first input with a
    // value stands for every material sharing it.
    const representative = new Map<number, PinnedStandardMaterialInput>();
    for (const material of materialInputs) {
        const features = await pinnedStandardMaterialFeatures(material);
        if (!representative.has(features)) {
            representative.set(features, material);
        }
    }
    // The mesh half: `.babylon` renderables carry no composition-relevant
    // bits (zero rows), scene meshes their own recorded sets, plus the
    // runtime-attachable pool and deformation arms.
    const meshValues: number[] = [];
    const addMesh = (bits: number): void => {
        if (!meshValues.includes(bits)) meshValues.push(bits);
    };
    if (input.babylonAssets.length > 0) addMesh(0);
    for (const bits of input.sceneMeshFeatureValues) addMesh(bits);
    if (input.thinInstances) {
        for (const bits of [...meshValues]) {
            addMesh(bits | meshBits.MSH_HAS_THIN_INSTANCES);
        }
    }
    if (input.morphTargets) {
        for (const bits of [...meshValues]) {
            addMesh(bits | meshBits.MSH_HAS_MORPH_TARGETS);
        }
    }
    if (meshValues.length === 0) addMesh(0);
    // Compose, deduplicating by composed text.
    const variants: PinnedStandardVariantManifestEntry[] = [];
    const byText = new Map<string, number>();
    const usedStems = new Set<string>();
    const selectors: PinnedStandardSelector[] = [];
    const seenKeys = new Set<string>();
    const add = async (
        material: PinnedStandardMaterialInput,
        meshFeatures: number,
        selectorFeatures: number,
        options: PinnedStandardComposeOptions,
        geometryTask?: number,
    ): Promise<void> => {
        const key = `${selectorFeatures}:${meshFeatures}:${
            geometryTask ?? "-"
        }`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        const composed = await composePinnedStandardVariant(material, {
            ...options,
            meshFeatures,
        });
        const text = `${composed.vertexWgsl} ${composed.fragmentWgsl}`;
        let index = byText.get(text);
        if (index === undefined) {
            index = variants.length;
            byText.set(text, index);
            const entry = pinnedStandardVariantManifestEntry(composed);
            // Two feature words can compose byte-identical stages while the
            // emitted stem carries the first word; the selector rows keep
            // every word resolving to the shared file. The reverse also
            // happens — one word composing different stages per geometry
            // task — so a taken stem gets a numeric suffix, the same
            // de-collision `writePinnedPbrVariants` applies.
            const base = entry.vertex.replace(/\.vert\.wgsl$/, "");
            let stem = base;
            for (let suffix = 2; usedStems.has(stem); suffix += 1) {
                stem = `${base}-${suffix}`;
            }
            usedStems.add(stem);
            entry.vertex = `${stem}.vert.wgsl`;
            entry.fragment = `${stem}.frag.wgsl`;
            variants.push(entry);
        }
        selectors.push({
            features: selectorFeatures,
            meshFeatures,
            ...(geometryTask !== undefined ? { geometryTask } : {}),
            variant: index,
        });
    };
    for (const features of featureValues) {
        const material = representative.get(features)!;
        for (const meshFeatures of meshValues) {
            const vertexColors = input.vertexColors &&
                    (meshFeatures & meshBits.MSH_HAS_VERTEX_COLOR) !== 0
                ? { vertexColors: { vertexAlpha: false } }
                : {};
            await add(material, meshFeatures, features, {
                fog: input.fog,
                ...vertexColors,
            });
            if (input.noColorViews && input.sceneMaterials) {
                await add(
                    material,
                    meshFeatures,
                    features | flags.NO_COLOR_OUTPUT,
                    {
                        fog: input.fog,
                        ...vertexColors,
                        passFeatures: flags.NO_COLOR_OUTPUT,
                    },
                );
            }
            for (const task of input.geometryTasks) {
                await add(
                    material,
                    meshFeatures,
                    features,
                    {
                        fog: input.fog,
                        ...vertexColors,
                        geometry: {
                            attachments: task.attachments,
                            emitColor: task.emitColor,
                        },
                    },
                    task.index,
                );
            }
        }
    }
    return { variants, selectors };
}

/**
 * The `.babylon` renderable count, mirroring the generated loader's mesh
 * walk (`babylon-loader-cpp.ts`): visible, unparented meshes with positions,
 * normals and indices produce one record per valid submesh. The Standard
 * mesh-feature table needs one zero row per record so scene-code mesh
 * handles land at their correct indices behind them.
 */
export function babylonRenderableCount(documentText: string): number {
    const document = JSON.parse(documentText) as {
        meshes?: {
            isVisible?: boolean;
            parentId?: string | null;
            positions?: unknown[];
            normals?: unknown[];
            indices?: unknown[];
            subMeshes?: {
                indexCount?: number;
                indexStart?: number;
            }[];
        }[];
    };
    let count = 0;
    for (const mesh of document.meshes ?? []) {
        if (mesh.isVisible === false) continue;
        if (typeof mesh.parentId === "string" && mesh.parentId !== "") {
            continue;
        }
        if (
            !Array.isArray(mesh.positions) ||
            !Array.isArray(mesh.normals) ||
            !Array.isArray(mesh.indices) ||
            mesh.indices.length === 0
        ) {
            continue;
        }
        const submeshes = Array.isArray(mesh.subMeshes) &&
                mesh.subMeshes.length > 0
            ? mesh.subMeshes
            : [{ indexStart: 0, indexCount: mesh.indices.length }];
        for (const submesh of submeshes) {
            const start = submesh.indexStart ?? 0;
            const length = submesh.indexCount ?? 0;
            if (length === 0 || start + length > mesh.indices.length) {
                continue;
            }
            count += 1;
        }
    }
    return count;
}

/** Inputs for the native-support block appended to standard_variants.hpp. */
export interface PinnedStandardSupportOptions {
    selectors: readonly PinnedStandardSelector[];
    /** Mesh-feature bits per runtime mesh handle, creation-ordered across
     *  every loaded asset's renderables and the scene-code meshes. */
    renderableMeshFeatures: readonly number[];
    /** Bits for meshes created past the static table, or undefined when the
     *  scene's builders disagree (such a draw then refuses by npos). */
    runtimeMeshFeatures?: number | undefined;
}

/**
 * Emits the native-support block `upstream-lower.ts` appends after
 * `pinnedStandardVariantsHeader`'s output: the pieces a PAL needs to resolve
 * and feed a composed Standard variant that the header itself does not carry.
 *
 * Everything pin-derived flows from the pin: the feature derivation is
 * lowered from `_computeStandardMaterialFeatures`'s AST, the flag and MSH_*
 * values are evaluated from their own declarations, and the record
 * correspondences are the same tables the composition input builders use.
 */
export function pinnedStandardSupportBlock(
    context: LoweringContext,
    options: PinnedStandardSupportOptions,
): string {
    const flag = (name: string): number =>
        pinnedNumericConstant(
            context,
            "src/material/standard/standard-flags.ts",
            name,
        );
    const mesh = (name: string): number =>
        pinnedNumericConstant(
            context,
            "src/material/mesh-features.ts",
            name,
        );
    const derivation = lowerStandardFeatureDerivation(context);
    const selectorRows = options.selectors.map((selector) =>
        `    {${selector.features}u, ${selector.meshFeatures}u, ` +
        `${
            selector.geometryTask ??
                "std::numeric_limits<std::size_t>::max()"
        }, ${selector.variant}},`
    );
    const meshRows = options.renderableMeshFeatures.map(
        (bits) => `    ${bits},`,
    );
    return `
// ---------------------------------------------------------------------------
// Native support for the pinned Standard variants, appended by
// src/pinned-standard-variants.ts pinnedStandardSupportBlock: the selector,
// the record-derived halves of its key, and the record->props fill the two
// lowered UBO writers above read.
#include <limits>
#include <bblite/upstream/material_texture_slots.hpp>

namespace bbl::upstream {

using bbl::MaterialRecord;

// src/material/mesh-features.ts -- the pin's own MSH_* values, evaluated
// from their declarations. The runtime ORs the pool/deformation bits onto
// the static per-handle table below, because thin instances attach and
// morph weights arrive after mesh creation.
inline constexpr std::uint32_t std_msh_has_morph_targets =
    ${mesh("MSH_HAS_MORPH_TARGETS")}u;
inline constexpr std::uint32_t std_msh_has_thin_instances =
    ${mesh("MSH_HAS_THIN_INSTANCES")}u;

// src/material/standard/standard-flags.ts NEEDS_UV -- the mask
// writeStdMaterialData's textureLevel parameter is derived from
// ((features & NEEDS_UV) != 0 ? 1 : 0, standard-renderable.ts).
inline constexpr std::uint32_t standard_needs_uv_mask = ${flag("NEEDS_UV")}u;

// The pass bit a depth-only material view ORs onto its features
// (src/material/standard/no-color-view.ts).
inline constexpr std::uint32_t standard_no_color_output_flag =
    ${flag("NO_COLOR_OUTPUT")}u;

// The blend bits the pipeline state keys on (standard-pipeline.ts
// getOrCreateStandardPipeline: needsBlend = HAS_OPACITY_TEXTURE ||
// MATERIAL_ALPHA_BLEND; cull = DOUBLE_SIDED ? none : back).
inline constexpr std::uint32_t standard_alpha_blend_flag =
    ${flag("MATERIAL_ALPHA_BLEND")}u;
inline constexpr std::uint32_t standard_opacity_texture_flag =
    ${flag("HAS_OPACITY_TEXTURE")}u;
inline constexpr std::uint32_t standard_double_sided_flag =
    ${flag("DOUBLE_SIDED")}u;

// src/material/standard/standard-material.ts
// _computeStandardMaterialFeatures, lowered from its own AST over the
// record fields the generated loader and compiled setters fill. The
// generation side executes the same pinned function over the same
// correspondences, so a draw's derived word matches its selector row
// bit for bit.
inline std::uint32_t standard_material_features(
    const MaterialRecord& material) {
    std::uint32_t features = 0;
${derivation}
    return features;
}

// src/material/standard/standard-pipeline.ts writeStdMaterialData's
// textureLevel parameter, from the renderable's own derivation.
inline float standard_texture_level(std::uint32_t features) {
    return (features & standard_needs_uv_mask) != 0u ? 1.0f : 0.0f;
}

// src/material/standard/standard-pipeline.ts isStandardUvInverted,
// mirrored condition for condition: the diffuse texture's invertY when one
// exists, else the opacity texture's, else the bump texture's. The record's
// TextureData::invert_y is the loader's own stamp for each slot.
inline bool standard_uv_inverted(
    std::uint32_t features,
    const MaterialRecord& material) {
    if ((features & ${flag("HAS_DIFFUSE_TEXTURE")}u) != 0u) {
        return material.base_color_texture.invert_y;
    }
    if ((features & ${flag("HAS_OPACITY_TEXTURE")}u) != 0u) {
        return material.opacity_texture.invert_y;
    }
    return (features & ${flag("HAS_BUMP_TEXTURE")}u) != 0u &&
        material.bump_texture.invert_y;
}

// MaterialRecord -> StandardMaterialProps, the record gaps closed:
//  - bump_level: the record stores the pinned fragment's 1/level
//    (babylon-loader-cpp.ts), and writeStdMaterialData divides by the
//    authored level itself, so the fill inverts the record back.
//  - alpha: rides base_color_factor.a (the compiled setter and the loader
//    both write it there).
//  - lightmap_level / reflection_coord_mode: no record field exists and no
//    generated loader fills the pin's inputs, so the pin's own defaults in
//    StandardMaterialProps stand.
inline StandardMaterialProps standard_material_props(
    const MaterialRecord& material) {
    StandardMaterialProps props{};
    props.diffuse_color = material.diffuse_color;
    props.alpha = material.base_color_factor.a;
    props.specular_color = material.specular_color;
    props.specular_power = material.specular_power;
    props.emissive_color = material.emissive_factor;
    props.ambient_color = material.ambient_color;
    props.bump_level = material.bump_scale != 0.0f
        ? 1.0f / material.bump_scale
        : 0.0f;
    props.ambient_tex_level = material.ambient_level;
    props.opacity_level = material.opacity_level;
    props.alpha_cutoff = material.alpha_cutoff;
    props.reflection_level = material.reflection_level;
    props.uv_scale = {
        material.diffuse_u_scale,
        material.diffuse_v_scale,
    };
    return props;
}

// The composed variants' group-1 texture bindings, resolved by the pin's
// own names. Slot-table rows cover every 2D slot; the cube reflection pair
// is the one resource outside it (each backend holds the mesh's uploaded
// reflection cube and its own sampler).
struct StandardBindingResource {
    std::string_view texture_name;
    std::string_view sampler_name;
    /** material_texture_slots row source, or the cube marker below. */
    MaterialTextureSource source;
    bool reflection_cube;
};

inline constexpr std::array<StandardBindingResource, 7>
    standard_binding_resources{{
    // The template's own diffuse pair (standard-template.ts).
    {"dT", "dS", MaterialTextureSource::base_color, false},
    // std-specular-fragment.ts.
    {"sT", "sS",
     MaterialTextureSource::specular_or_metallic_roughness, false},
    // std-opacity-fragment.ts.
    {"oT", "oS", MaterialTextureSource::opacity_or_normal, false},
    // std-ambient-fragment.ts.
    {"aT", "aS", MaterialTextureSource::ambient_or_emissive, false},
    // std-emissive-fragment.ts.
    {"eT", "eS", MaterialTextureSource::standard_emissive, false},
    // normal-map-fragment.ts.
    {"bT", "bS", MaterialTextureSource::standard_bump, false},
    // std-cube-reflection-fragment.ts; outside the slot table.
    {"cRT", "cRS", MaterialTextureSource::base_color, true},
}};

struct StandardVariantSelector {
    /** standard_material_features(record), plus the no-color pass bit for a
     *  depth-only view's rows. */
    std::uint32_t features;
    std::uint32_t mesh_features;
    /** The geometry-output task an MRT variant draws in, npos for the
     *  colour and depth-only passes. */
    std::size_t geometry_task;
    std::size_t variant;
};

inline constexpr std::array<StandardVariantSelector, ${selectorRows.length}>
    standard_variant_selectors{{
${selectorRows.join("\n")}
}};

/**
 * The mesh-feature bits per runtime mesh handle, creation-ordered: each
 * loaded asset's renderables in its loader's own walk, then the scene-code
 * meshes. The pool and deformation bits are ORed on by the caller from the
 * record, because both attach after creation.
 */
inline constexpr std::array<
    std::size_t,
    ${meshRows.length}> standard_renderable_mesh_features{{
${meshRows.join("\n")}
}};

/** The bits for meshes created past the static table, npos to refuse. */
inline constexpr std::size_t standard_runtime_mesh_features =
    ${
        options.runtimeMeshFeatures ??
            "std::numeric_limits<std::size_t>::max()"
    };

/** The variant a Standard draw composes, or npos when none was emitted. */
inline std::size_t standard_variant_for(
    std::uint32_t features,
    std::uint32_t mesh_features,
    std::size_t geometry_task = std::numeric_limits<std::size_t>::max()) {
    for (const StandardVariantSelector& selector :
         standard_variant_selectors) {
        if (
            selector.features == features &&
            selector.mesh_features == mesh_features &&
            selector.geometry_task == geometry_task) {
            return selector.variant;
        }
    }
    return std::numeric_limits<std::size_t>::max();
}

} // namespace bbl::upstream
`;
}
