/**
 * Which halves of the shadow family a scene compiles, derived once.
 *
 * Five defines govern the shadow code in both PALs and they are not
 * independent: the generator half exists whenever SOME family composes a
 * receiver, and each family's own define gates only that family's bind path.
 * Every `#if` nesting decision in the PALs rests on that containment, so all
 * five are computed here and the header is written from them, rather than as
 * separate expressions over the same inputs.
 *
 * `feature-activation.ts` checks its own inventory against this record. That
 * comparison means something only while the two stay different derivations,
 * so its rows spell their reasons from the reached features directly.
 */
import type { Feature } from "./compiler/types.js";

/**
 * The features that reach a shadow generator.
 *
 * The two filters are siblings — `createPcfSpotlightShadowGenerator` and
 * `createEsmDirectionalShadowGenerator` build the same maps, the same
 * receiver blocks and the same caster pass — so every consumer wants both,
 * and each site that spelled the disjunction itself was a place they could
 * drift. Two already had. Consumers that need the list rather than the
 * predicate — the generated-source rule, whose own row is an ANY over
 * features — take it from here, so the containment is structural.
 */
export const shadowGeneratorFeatures: readonly Feature[] = [
    "shadow:pcf",
    "shadow:esm",
];

/**
 * Whether a scene reaches a shadow generator at all.
 *
 * The argument stays a loose string list because a manifest's features are
 * deliberately open — `feature-activation.ts` carries an unmapped name as
 * its own drift detector. What is typed is the list above, which is where a
 * mis-spelling would otherwise compile.
 */
export function reachesShadowGenerator(
    features: readonly string[],
): boolean {
    return shadowGeneratorFeatures.some((feature) =>
        features.includes(feature)
    );
}

/** What the shadow defines are derived from. */
export interface ShadowCapabilityInputs {
    features: readonly string[];
    /** How many Standard variants the scene composed. */
    standardVariants: number;
    /** How many PBR variants the scene composed. */
    pbrVariants: number;
    /**
     * How many composed node graphs receive a shadow -- a node receiver is
     * not a variant of its own, because `node-shadow.ts` appends to the
     * GRAPH's own group 1 and mixes by the `meshU.receivesShadow` lane
     * rather than by a composition key.
     */
    nodeShadowReceivers: number;
    /** How many composed node graphs also carry an ESM caster module. */
    nodeEsmCasters: number;
}

export interface ShadowCapabilities {
    /** That a shadow generator is reached at all, under either filter. */
    reached: boolean;
    /**
     * The ESM generator's own resources: four textures and a separable blur.
     *
     * What it gates includes the caster's own material view, so it is a
     * conjunction with the families that HAVE one -- Standard and node. A
     * scene reaching the filter whose casters are all of some third family
     * would compile this to zero and then refresh its directional generator
     * through the PCF spot's matrix builder, which answers rather than
     * failing, so `assertShadowCapabilities` refuses that pair by name.
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
    const node = reached &&
        (inputs.nodeShadowReceivers > 0 || inputs.nodeEsmCasters > 0);
    return {
        reached,
        esm:
            inputs.features.includes("shadow:esm") &&
            (inputs.standardVariants > 0 || inputs.nodeEsmCasters > 0),
        standard,
        pbr,
        receivers: standard || pbr || node,
    };
}

/**
 * Refuse a scene whose defines would compile to a runtime that answers
 * wrongly rather than failing.
 *
 * `BBLITE_SHADOWS_ESM` gates the ESM generator's own resources, and every
 * site that reads it is Standard-family code -- the caster's material view
 * most of all, since `material/pbr/esm-shadow-view.ts` composes here for
 * nothing yet. A scene reaching the filter with no Standard variant would
 * compile that define to zero and then refresh its directional generator
 * through the PCF spot's matrix builder, which answers rather than failing.
 *
 * Separate from `shadowCapabilities` because that function is also asked
 * what a define WOULD be, over synthetic inputs, by the activation
 * inventory. Only the emission path enforces.
 */
export function assertShadowCapabilities(
    inputs: ShadowCapabilityInputs,
): void {
    if (
        inputs.features.includes("shadow:esm") &&
        inputs.standardVariants === 0 &&
        inputs.nodeEsmCasters === 0
    ) {
        throw new Error(
            "A scene reaching the ESM shadow generator composes no " +
                "Standard variant and no node ESM caster. The caster's own " +
                "material view is those two families'; the PBR one " +
                "(material/pbr/esm-shadow-view.ts) composes nothing yet.",
        );
    }
}
