/**
 * Which halves of the shadow family a scene compiles, derived once.
 *
 * Five defines govern the shadow code in both PALs and they are not
 * independent: the generator half exists whenever SOME family composes a
 * receiver, and each family's own define gates only that family's bind path.
 * Every `#if` nesting decision in the PALs rests on that containment, so the
 * values are computed here and the header is written from them — rather than
 * as separate expressions over the same inputs, which is how the source table
 * came to declare `shadow.cpp` for one filter and the emitter for two.
 *
 * `feature-activation.ts` publishes these as the values it CHECKS its own
 * reasoning against, which only means something while the two are different
 * expressions: this module answers from the emitter's inputs, and the
 * inventory answers from the reached features. A drift between them is the
 * disagreement the check exists to catch.
 */

/**
 * Whether a scene reaches a shadow generator at all.
 *
 * The two filters are siblings — `createPcfSpotlightShadowGenerator` and
 * `createEsmDirectionalShadowGenerator` build the same maps, the same
 * receiver blocks and the same caster pass — so every consumer wants both,
 * and each site that spelled the disjunction itself was a place they could
 * drift. Two already had.
 */
export function reachesShadowGenerator(
    features: readonly string[],
): boolean {
    return (
        features.includes("shadow:pcf") || features.includes("shadow:esm")
    );
}

/** What the shadow defines are derived from. */
export interface ShadowCapabilityInputs {
    features: readonly string[];
    /** How many Standard variants the scene composed. */
    standardVariants: number;
    /** How many PBR variants the scene composed. */
    pbrVariants: number;
}

export interface ShadowCapabilities {
    /**
     * The ESM generator's own resources: four textures and a separable blur.
     * A Standard conjunction because what it gates includes the caster's own
     * material view, and only the Standard family has one so far.
     */
    esm: boolean;
    /** The Standard family's receiver bind path. */
    standard: boolean;
    /** The PBR family's receiver bind path. */
    pbr: boolean;
    /**
     * The generator half, which belongs to no material family: the maps, the
     * samplers, the receiver blocks, the caster pass and the standard-Z depth
     * state its target takes. The UNION of the family halves by construction,
     * which is the containment the PALs' `#if` nesting depends on.
     */
    receivers: boolean;
}

export function shadowCapabilities(
    inputs: ShadowCapabilityInputs,
): ShadowCapabilities {
    const reached = reachesShadowGenerator(inputs.features);
    const standard = reached && inputs.standardVariants > 0;
    const pbr = reached && inputs.pbrVariants > 0;
    return {
        esm:
            inputs.features.includes("shadow:esm") &&
            inputs.standardVariants > 0,
        standard,
        pbr,
        receivers: standard || pbr,
    };
}
