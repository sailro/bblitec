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
    const [flags, meshBits, pipeline, fog, vertexColor, morph] =
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
    if (meshFeatures & meshBits.MSH_HAS_THIN_INSTANCES) {
        throw new Error(
            "Pinned Standard thin instances are not composable yet: the " +
                "renderable splices the thin-instance fragment and its " +
                "instance-colour BC slot, which this port has not wired for " +
                "the Standard family.",
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
