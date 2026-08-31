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
    /** How many composed node graphs cast through a depth-only PCF view. */
    nodePcfCasters?: number;
}

export interface ShadowCapabilities {
    /** That a shadow generator is reached at all, under either filter. */
    reached: boolean;
    /**
     * The ESM generator's own resources: four textures and a separable blur.
     *
     * What it gates includes the caster's own material view, and all three
     * families now have one, so it is the same union `receivers` is. A scene
     * reaching the filter that composes no family at all would compile this
     * to zero and then refresh its directional generator through the PCF
     * spot's matrix builder, which answers rather than failing, so
     * `assertShadowCapabilities` refuses that pair by name.
     */
    esm: boolean;
    /** The Standard family's receiver bind path. */
    standard: boolean;
    /** The PBR family's receiver bind path. */
    pbr: boolean;
    /**
     * The node family's own half: a composed graph that receives a shadow
     * or carries an ESM caster module.
     *
     * Not a "receiver bind path" like the other two, because the node
     * receiver has no group of its own -- its three bindings per light
     * continue the graph's own group 1, and its factor is mixed by the
     * `meshU.receivesShadow` lane rather than by a composed variant. What
     * it gates is the same generator half the others need.
     */
    node: boolean;
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
        (inputs.nodeShadowReceivers > 0 ||
            inputs.nodeEsmCasters > 0 ||
            (inputs.nodePcfCasters ?? 0) > 0);
    const receivers = standard || pbr || node;
    return {
        reached,
        node,
        esm: inputs.features.includes("shadow:esm") && receivers,
        standard,
        pbr,
        receivers,
    };
}

/**
 * The two node counts every caller derives, from the composed graphs.
 *
 * Stated once because two files ask for them -- the emitter that writes the
 * defines and the activation inventory that checks what they say -- and a
 * pair derived twice is a pair that can drift while both self-checks pass.
 */
export function nodeShadowInputs(
    nodeVariants: readonly {
        composed: {
            shadowBindings: readonly unknown[];
            caster: null | { kind: "esm" | "pcf" };
        };
    }[],
): Pick<
    ShadowCapabilityInputs,
    "nodeShadowReceivers" | "nodeEsmCasters" | "nodePcfCasters"
> {
    return {
        nodeShadowReceivers: nodeVariants.filter(
            (variant) => variant.composed.shadowBindings.length > 0,
        ).length,
        nodeEsmCasters: nodeVariants.filter(
            (variant) => variant.composed.caster?.kind === "esm",
        ).length,
        nodePcfCasters: nodeVariants.filter(
            (variant) => variant.composed.caster?.kind === "pcf",
        ).length,
    };
}

/**
 * Refuse a scene whose defines would compile to a runtime that answers
 * wrongly rather than failing.
 *
 * `BBLITE_SHADOWS_ESM` gates the ESM generator's own resources, and what
 * reads it is each family's caster view. A scene reaching the filter that
 * composes no family at all would compile that define to zero and then
 * refresh its directional generator through the PCF spot's matrix builder,
 * which answers rather than failing.
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
        !shadowCapabilities(inputs).esm
    ) {
        throw new Error(
            "A scene reaching the ESM shadow generator composes no material " +
                "family to cast through. Each family carries its own caster " +
                "view (material/<family>/esm-shadow-view.ts), and a scene " +
                "reaching none of them would refresh its directional " +
                "generator through the PCF spot's matrix builder.",
        );
    }
}

/**
 * The subsystems a floating-origin scene may not reach yet.
 *
 * `useFloatingOrigin` changes the frame the WHOLE render is in: the view
 * translation goes to zero, a mesh keeps local vertices, and every world,
 * light and anchor is rebuilt against the eye. Anything that still composes
 * an absolute world would then be drawn five million units from where the
 * rest of the scene is -- silently, because it lands consistently with
 * itself.
 *
 * So each subsystem is either moved into the frame or named here. The list
 * is the honest edge of the mode, not a wish: a scene reaching one fails at
 * generation with the subsystem's name instead of rendering something
 * plausible.
 */
const floatingOriginUnwired: readonly {
    feature: string;
    why: string;
}[] = [
    {
        feature: "loader:splat",
        why: "a splat cloud composes its own absolute world and multiplies " +
            "it by the frame's view",
    },
    {
        feature: "material:shader",
        why: "a ShaderMaterial serializes its own system-uniform block and " +
            "still reads the identity world the bake used to justify",
    },
    {
        feature: "loader:gltf",
        why: "the glTF loader bakes each primitive's node world into its " +
            "vertices in float32, which quantizes them before the " +
            "eye-relative subtraction could recover the remainder",
    },
    {
        feature: "loader:gltf-cameras",
        why: "a parented camera's world is its fixup node's product, and " +
            "the offset is read off the camera's own local eye",
    },
];

/**
 * Refuse a floating-origin scene that reaches a subsystem still drawn in
 * absolute space.
 */
export function assertFloatingOriginCapabilities(
    features: readonly string[],
): void {
    if (!features.includes("renderer:floating-origin")) return;
    for (const { feature, why } of floatingOriginUnwired) {
        if (!features.includes(feature)) continue;
        throw new Error(
            `A floating-origin scene reaches ${feature}, which is not in ` +
                `the eye-relative frame yet: ${why}. Wire it, or drop ` +
                "useFloatingOrigin from the engine.",
        );
    }
}
