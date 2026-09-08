// The material capability facts every consumer reads off the scene's
// composed variants.
//
// Babylon Lite composes one PBR fragment per material feature set and one
// Standard fragment per material word, and every capability define, texture
// slot and loader flag that depends on "does this scene draw X" is a fact
// about that composed set: which extension fragments the pin spliced (the
// variant's fragment key) and which group-1 resources the composed stages
// bind (their binding names). Reading both here, once, is what keeps the
// header emitter and the activation inventory on one derivation instead of
// a per-asset predicate re-typed beside a scene-source reach.
import { variantBindings } from "./pinned-pbr-variant-cpp.js";

/** A composed stage pair, whichever family produced it. */
export interface ComposedStages {
    /** The pin's own composition key -- the fragment ids joined by `|`. */
    fragmentKey?: string;
    vertexWgsl: string;
    fragmentWgsl: string;
}

export interface ComposedMaterialCapabilities {
    /** Some PBR variant spliced the pin's clearcoat fragment. */
    clearcoat: boolean;
    /** Some PBR variant spliced the pin's sheen fragment. */
    sheen: boolean;
    /** Some PBR variant spliced the pin's iridescence fragment. */
    iridescence: boolean;
    /**
     * Some PBR variant binds the spec-gloss pair (`specGlossTexture`), which
     * replaces the metallic-roughness workflow; the pin's feature derivation
     * sets `PBR_HAS_SPEC_GLOSS` only for a material carrying the texture.
     */
    specularGlossiness: boolean;
    /**
     * Some PBR variant binds the dedicated uv2 occlusion pair
     * (`occlusionTexture`), which `createPbrTemplateExt` declares for
     * `_hasOcclusionUv2` alone.
     */
    occlusionUv2: boolean;
    /** A PBR variant binds `lmTexture` or a Standard variant binds `lT`. */
    lightmap: boolean;
    /** The Standard half of `lightmap` alone: some variant binds `lT`. */
    standardLightmap: boolean;
    metallicReflectanceMap: boolean;
    reflectanceMap: boolean;
    anisotropyMap: boolean;
    translucencyColorMap: boolean;
    translucencyIntensityMap: boolean;
    /**
     * A Standard variant binds the pin's bump pair
     * (`normal-map-fragment.ts` `bT`), which is the condition under which
     * the record's bump texture needs a mesh slot and the generated
     * `.babylon` loader fills it.
     */
    standardBump: boolean;
    /**
     * A Standard variant binds the pin's 2D reflection pair
     * (`std-reflection-fragment.ts` `rT`), which is the condition under
     * which the record's reflection_texture needs a mesh slot.
     */
    standardReflection: boolean;
    /** Every group-1 binding name the PBR variants declare. */
    pbrBindingNames: ReadonlySet<string>;
}

function bindingNames(variants: readonly ComposedStages[]): Set<string> {
    return new Set(
        variants.flatMap((variant) =>
            variantBindings(variant.vertexWgsl, variant.fragmentWgsl).map(
                (binding) => binding.name,
            )
        ),
    );
}

/** Whether the pin spliced the named fragment into some variant. */
function composesFragment(
    variants: readonly ComposedStages[],
    fragment: string,
): boolean {
    return variants.some((variant) =>
        variant.fragmentKey?.includes(fragment) === true
    );
}

export function composedMaterialCapabilities(
    pbrVariants: readonly ComposedStages[],
    standardVariants: readonly ComposedStages[],
): ComposedMaterialCapabilities {
    const pbrBindingNames = bindingNames(pbrVariants);
    const standardBindingNames = bindingNames(standardVariants);
    const standardLightmap = standardBindingNames.has("lT");
    return {
        clearcoat: composesFragment(pbrVariants, "clearcoat"),
        sheen: composesFragment(pbrVariants, "sheen"),
        iridescence: composesFragment(pbrVariants, "iridescence"),
        specularGlossiness: pbrBindingNames.has("specGlossTexture"),
        occlusionUv2: pbrBindingNames.has("occlusionTexture"),
        lightmap: pbrBindingNames.has("lmTexture") || standardLightmap,
        standardLightmap,
        metallicReflectanceMap: pbrBindingNames.has("metallicReflectanceMap"),
        reflectanceMap: pbrBindingNames.has("reflectanceMap"),
        anisotropyMap: pbrBindingNames.has("anisotropyTexture_"),
        translucencyColorMap: pbrBindingNames.has("translucencyColorTexture_"),
        translucencyIntensityMap: pbrBindingNames.has(
            "translucencyIntensityTexture_",
        ),
        standardBump: standardBindingNames.has("bT"),
        standardReflection: standardBindingNames.has("rT"),
        pbrBindingNames,
    };
}
