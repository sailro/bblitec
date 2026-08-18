/**
 * Composes a scene's PBR shader variants through Babylon Lite's own pipeline.
 *
 * The renderer currently carries one transcribed fragment per scene and selects
 * per-material behaviour from uniform lanes inside it. Babylon composes one
 * fragment per material feature set — the instrumented capture of Scene 253
 * holds 17 distinct fragment bodies for that scene's 14 materials. A single
 * fragment cannot express a per-material fork, so every fork upstream makes has
 * to be re-expressed here by hand, which is where the re-derived formulas come
 * from and why a missed arm reads as a shading bias rather than a failure.
 *
 * Nothing in this module decides what a variant contains. The feature bits come
 * from the pin's own `_computePbrMaterialFeatures`, which walks the registered
 * extensions' `detect` hooks; the fragments come from those extensions' `frag`
 * hooks; and the assembly comes from `composeShader`. What this module owns is
 * building the material-shaped input from a generated material record and
 * registering the extensions the scene reaches — the same registration the
 * `setPbr*` entry points perform upstream.
 */
import {
    importPinnedModule,
} from "./pinned-shader-composer.js";

/** The material fields the pin's feature derivation and extensions read. */
export interface PinnedMaterialInput {
    emissiveTexture?: unknown;
    normalTexture?: unknown;
    specGlossTexture?: unknown;
    baseColorFactor?: readonly number[];
    alpha?: number;
    alphaBlend?: boolean;
    _alphaCutOff?: number;
    doubleSided?: boolean;
    occlusionStrength?: number;
    enableSpecularAA?: boolean;
    _uv2Mask?: number;
    /** Extension props, read by each ext's `detect`: `_clearCoat`, `_sheen`, … */
    [key: string]: unknown;
}

/** A composed variant plus the feature bits that produced it. */
export interface PinnedPbrVariant {
    /** The pin's own name for the permutation, e.g. `ibl|clearcoat`. */
    fragmentKey: string;
    features: number;
    features2: number;
    vertexWgsl: string;
    fragmentWgsl: string;
    materialUboSpec: unknown;
}

/**
 * The extensions a PBR material can reach, by the module that owns each.
 *
 * **Order is part of the contract.** `pbr-renderable.ts` states it: "Registration
 * order is the iteration order consumed by `_getPbrExts().values()` on the hot
 * paths (composePbr, writeMaterialData, collectPbrBoundTextures)", so it decides
 * the material UBO's field order and the bind-group order, not just which
 * fragments exist. Upstream reaches this order by construction — a `setPbr*`
 * entry point registers its extension when scene code creates the material, and
 * `buildPbrRenderables` registers the environment afterwards — so these are
 * listed in that same sequence rather than alphabetically.
 */
const materialExtensionModules = [
    "material/pbr/fragments/clearcoat-fragment.js",
    "material/pbr/fragments/sheen-fragment.js",
    "material/pbr/fragments/iridescence-fragment.js",
    "material/pbr/fragments/subsurface-fragment.js",
    "material/pbr/fragments/reflectance-fragment.js",
    "material/pbr/fragments/anisotropy-fragment.js",
    "material/pbr/fragments/emissive-fragment.js",
    "material/pbr/fragments/alpha-test-fragment.js",
    "material/pbr/fragments/gamma-fragment.js",
    "material/pbr/fragments/unlit-fragment.js",
    "material/pbr/fragments/uv-transform-fragment.js",
    "material/pbr/fragments/skybox-fragment.js",
] as const;

/** Registered after the material extensions, where `buildPbrRenderables` puts it. */
const environmentExtensionModule =
    "material/pbr/fragments/ibl-fragment.js";

/**
 * `pbr-renderable.ts` drains these last, after the environment extension and
 * after the scene hooks, from its own single scan over the scene's meshes:
 * `_drainPbrExts([[hasSomeSkeletons, skeleton], [hasSomeMorphs, morph]])`.
 * They are mesh properties rather than material ones, so they carry no
 * `setPbr*` entry point, and their position decides the bind-group order for
 * every slot after them.
 */
const meshExtensionModules = [
    "material/pbr/fragments/skeleton-fragment.js",
    "material/pbr/fragments/morph-fragment.js",
] as const;

interface PbrExtDescriptor {
    id: string;
}

let registered: Promise<void> | undefined;

/**
 * Registers the PBR extensions once, in the pin's own order.
 *
 * The environment extension is registered unconditionally here where upstream
 * gates it on `hasEnv`. That is safe because its `frag` hook re-reads
 * `_hasIbl` from the compose context — which comes from `sceneFeatures` — and
 * returns null for a scene without one, so a non-environment variant composes
 * the same either way. Gating the registration instead would make the registry
 * depend on which scene was composed first, and the registry is process-global.
 */
async function registerPbrExtensions(): Promise<void> {
    registered ??= (async () => {
        const flags = await importPinnedModule<{
            _registerPbrExt: (ext: PbrExtDescriptor) => void;
        }>("material/pbr/pbr-flags.js");
        for (const path of [
            ...materialExtensionModules,
            environmentExtensionModule,
        ]) {
            const module = await importPinnedModule<{
                pbrExt?: PbrExtDescriptor;
            }>(path);
            if (module.pbrExt) flags._registerPbrExt(module.pbrExt);
        }
        // Transmission has no `pbrExt` export: `set-transmission.ts` registers a
        // scene hook instead, because enabling it retargets the frame graph's
        // colour buffer, and the hook builds the extension from a factory. Only
        // the extension matters for composition, and its own `detect` returns
        // nothing for a material that is not transmissive, so it is built here
        // directly rather than by standing up a scene.
        const [refraction, dispersion] = await Promise.all([
            importPinnedModule<{
                makeRefractionRttExt: (
                    dispersionSampleWgsl?: string,
                ) => PbrExtDescriptor;
            }>("material/pbr/fragments/refraction-rtt-fragment.js"),
            // `set-dispersion.ts` feeds the ext this sample the moment a
            // dispersion material loads; the ext only composes it when the
            // material's own bit demands it, so passing it unconditionally
            // is the loaded-pin state, not an extra arm.
            importPinnedModule<{ DISPERSION_SAMPLE_WGSL: string }>(
                "material/pbr/fragments/refraction-dispersion-wgsl.js",
            ),
        ]);
        flags._registerPbrExt(
            refraction.makeRefractionRttExt(
                dispersion.DISPERSION_SAMPLE_WGSL,
            ),
        );
        for (const path of meshExtensionModules) {
            const module = await importPinnedModule<{
                pbrExt?: PbrExtDescriptor;
            }>(path);
            if (module.pbrExt) flags._registerPbrExt(module.pbrExt);
        }
        // The geometry-output ext registers when the first geometry view is
        // built -- after everything else -- with a getter over the active
        // attachments; `pbr-geometry-view.ts` sets them around each compose
        // and so does `composePinnedPbrVariant`. Its frag hook returns null
        // without `PBR2_GEOMETRY_OUTPUT`, so every non-geometry variant
        // composes exactly as before.
        const geometry = await importPinnedModule<{
            _ensurePbrGeometryExt: (
                getAttachments: () => readonly number[] | undefined,
            ) => void;
        }>("material/pbr/pbr-geometry-output-shader.js");
        geometry._ensurePbrGeometryExt(() => activeGeometryAttachments);
    })();
    return registered;
}

/**
 * The attachments the geometry-output ext's frag hook reads while a geometry
 * variant composes -- the pin's `_activeAttachments`, set and restored around
 * each `composePbrGeometryShader` call.
 */
let activeGeometryAttachments: readonly number[] | undefined;

/** The extension ids the pin has registered, in its own sorted order. */
export async function registeredPbrExtensionIds(): Promise<readonly string[]> {
    await registerPbrExtensions();
    const flags = await importPinnedModule<{
        _getPbrExtsSorted: () => readonly PbrExtDescriptor[];
    }>("material/pbr/pbr-flags.js");
    return flags._getPbrExtsSorted().map((ext) => ext.id);
}

/**
 * Derives a material's feature bits the way the pin does, including every
 * registered extension's own `detect`.
 */
export async function pinnedMaterialFeatures(
    material: PinnedMaterialInput,
): Promise<{ features: number; features2: number }> {
    await registerPbrExtensions();
    const pbrMaterial = await importPinnedModule<{
        _computePbrMaterialFeatures: (
            material: PinnedMaterialInput,
        ) => { features: number; features2: number };
    }>("material/pbr/pbr-material.js");
    return pbrMaterial._computePbrMaterialFeatures(material);
}

export interface PinnedComposeOptions {
    /**
     * Bits the pin adds per renderable rather than per material.
     * `_computePbrMaterialFeatures` says so itself — "Mesh/pass bits are added
     * per renderable" — so tone mapping and fog, which are scene state, are
     * OR-ed in here instead of being read off the material.
     */
    passFeatures?: number;
    /** Bits ORed into `features2` the same way; `PBR2_NO_COLOR_OUTPUT` for a
     *  depth-only material view is the reached one. */
    passFeatures2?: number;
    /** Mesh bits (`MSH_HAS_TANGENTS`, morph targets, vertex colour, …). */
    meshFeatures?: number;
    /** Scene bits; the environment is read from here, not from the material. */
    sceneFeatures?: number;
    /** 0 none, 1 single analytic light, 2 the multi-light loop. */
    lightMode?: 0 | 1 | 2;
    singleLightType?: string;
    /** Single-light WGSL, supplied by the caller as the pinned renderable does. */
    singleLightWgsl?: string;
    singleLightBlock?: string;
    multiLightWgsl?: string;
    multiLightLoop?: string;
    toneMappingHelpers?: string;
    toneMappingCall?: string;
    uv2Mask?: number;
    /**
     * Compose the pin's geometry-output MRT arm instead of the colour
     * fragment: `composePbrGeometryShader` rewrites the composed return into
     * a FragmentOutput struct with one location per attachment (plus the
     * optional trailing colour), each written by the pin's own
     * `attachmentExpr`. Attachment names are the manifest's
     * `GeometryTextureTypeName`s, mapped onto the pin's enum here.
     */
    geometry?: {
        attachments: readonly string[];
        emitColor: boolean;
    };
}

interface PinnedComposeFn {
    (
        features: number,
        features2?: number,
        meshFeatures?: number,
        sceneFeatures?: number,
        lightMode?: 0 | 1 | 2,
        singleLightType?: string,
        esmShadowDepthCode?: string,
        vbStrides?: unknown,
        vbKey?: string,
        uv2Mask?: number,
    ): {
        _vertexWGSL: string;
        _fragmentWGSL: string;
        _fragmentKey: string;
        _materialUboSpec: unknown;
    };
}

/**
 * Composes the variant for one material.
 *
 * The composer resolves its own dependency graph, so an incomplete set fails
 * here instead of composing something plausible — a clearcoat fragment built
 * against an environment declares `ibl` and is refused without it.
 */
export async function composePinnedPbrVariant(
    material: PinnedMaterialInput,
    options: PinnedComposeOptions = {},
): Promise<PinnedPbrVariant> {
    const { features, features2 } = await pinnedMaterialFeatures(material);
    const [compose, templateExt, flatNormal, fog, thinInstance] =
        await Promise.all([
        importPinnedModule<{
            createPbrComposer: (deps: Record<string, unknown>) => PinnedComposeFn;
        }>("material/pbr/pbr-compose.js"),
        importPinnedModule<{ createPbrTemplateExt: unknown }>(
            "material/pbr/pbr-template-ext.js",
        ),
        // The pin imports these only when a primitive lacks normals or the
        // scene enables fog; passing them unconditionally is identical because
        // insertion is governed by the `MSH_FLAT_NORMAL` mesh bit and the
        // `PBR_HAS_FOG` scene bit. An empty string here is the transcribed
        // fallback in another shape: Scene 255's captured fragment carried the
        // flat-normal lines while "" composed the smooth-normal arm against
        // them, and the byte-for-byte gate only logs a fragment nothing
        // matches.
        importPinnedModule<{ FLAT_NORMAL_WGSL: string }>(
            "material/pbr/fragments/flat-normal-wgsl.js",
        ),
        importPinnedModule<{
            PBR_FOG_HELPER: string;
            PBR_FOG_BLOCK: string;
        }>("material/pbr/pbr-fog-wgsl.js"),
        // Gated by `MSH_HAS_THIN_INSTANCES` exactly like the flat-normal and
        // fog snippets by their bits.
        importPinnedModule<{
            createThinInstanceFragment: (hasInstanceColor: boolean) => unknown;
        }>("shader/fragments/thin-instance-fragment.js"),
    ]);
    const composer = compose.createPbrComposer({
        _singleLightWGSL: options.singleLightWgsl ?? "",
        _getSingleLightBlock: options.singleLightBlock !== undefined
            ? () => options.singleLightBlock ?? ""
            : null,
        _multiLightWGSL: options.multiLightWgsl ?? "",
        _multiLightLoop: options.multiLightLoop ?? "",
        _toneMappingHelpers: options.toneMappingHelpers ?? "",
        _toneMappingCall: options.toneMappingCall ?? "",
        _fogHelper: fog.PBR_FOG_HELPER,
        _fogBlock: fog.PBR_FOG_BLOCK,
        _createPbrTemplateExt: templateExt.createPbrTemplateExt,
        _flatNormalWgsl: flatNormal.FLAT_NORMAL_WGSL,
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment:
            thinInstance.createThinInstanceFragment,
    });
    if (options.geometry) {
        // The pin's own MRT arm: `pbr-geometry-view.ts` composes through
        // `composePbrGeometryShader`, which calls the same composer with
        // `PBR2_GEOMETRY_OUTPUT` set and rewrites the fragment's return into
        // per-attachment writes. The active attachments are set around the
        // call exactly as `_setActivePbrGeometryAttachments` does.
        const [geometry, types] = await Promise.all([
            importPinnedModule<{
                composePbrGeometryShader: (
                    composePbr: PinnedComposeFn,
                    features: number,
                    features2: number,
                    meshFeatures: number,
                    sceneFeatures: number,
                    lightMode: 0 | 1 | 2,
                    singleLightType: string,
                    esmShadowDepthCode: string,
                    vbStrides: unknown,
                    vbKey: string,
                    attachments: readonly number[],
                    emitColor: boolean,
                    uv2Mask?: number,
                ) => {
                    _vertexWGSL: string;
                    _fragmentWGSL: string;
                    _fragmentKey: string;
                    _materialUboSpec: unknown;
                };
            }>("material/pbr/pbr-geometry-output-shader.js"),
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
        const previous = activeGeometryAttachments;
        activeGeometryAttachments = attachments;
        try {
            const composed = geometry.composePbrGeometryShader(
                composer,
                features | (options.passFeatures ?? 0),
                features2 | (options.passFeatures2 ?? 0),
                options.meshFeatures ?? 0,
                options.sceneFeatures ?? 0,
                options.lightMode ?? 0,
                options.singleLightType ?? "",
                "",
                undefined,
                "",
                attachments,
                options.geometry.emitColor,
                options.uv2Mask ?? 0,
            );
            return {
                fragmentKey: composed._fragmentKey,
                features,
                features2,
                vertexWgsl: composed._vertexWGSL,
                fragmentWgsl: composed._fragmentWGSL,
                materialUboSpec: composed._materialUboSpec,
            };
        } finally {
            activeGeometryAttachments = previous;
        }
    }
    const composed = composer(
        features | (options.passFeatures ?? 0),
        features2 | (options.passFeatures2 ?? 0),
        options.meshFeatures ?? 0,
        options.sceneFeatures ?? 0,
        options.lightMode ?? 0,
        options.singleLightType ?? "",
        "",
        undefined,
        "",
        options.uv2Mask ?? 0,
    );
    return {
        fragmentKey: composed._fragmentKey,
        features,
        features2,
        vertexWgsl: composed._vertexWGSL,
        fragmentWgsl: composed._fragmentWGSL,
        materialUboSpec: composed._materialUboSpec,
    };
}
