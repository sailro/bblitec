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
import { importPinnedModule } from "./pinned-shader-composer.js";

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
    "material/pbr/fragments/reflectance-fragment.js",
    "material/pbr/fragments/anisotropy-fragment.js",
] as const;

/** Registered after the material extensions, where `buildPbrRenderables` puts it. */
const environmentExtensionModule =
    "material/pbr/fragments/ibl-fragment.js";

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
    })();
    return registered;
}

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
    const [compose, templateExt] = await Promise.all([
        importPinnedModule<{
            createPbrComposer: (deps: Record<string, unknown>) => PinnedComposeFn;
        }>("material/pbr/pbr-compose.js"),
        importPinnedModule<{ createPbrTemplateExt: unknown }>(
            "material/pbr/pbr-template-ext.js",
        ),
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
        _fogHelper: "",
        _fogBlock: "",
        _createPbrTemplateExt: templateExt.createPbrTemplateExt,
        _flatNormalWgsl: "",
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment: null,
    });
    const composed = composer(
        features,
        features2,
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
