// The one generation-side refusal.
//
// Generation refuses in two voices. The compiler's `fail()` names a scene
// source location (`CompileError`); everything after it -- asset
// specialization, composition, emission -- names the UNIT it could not
// lower: a runtime feature, a capability, an asset, a pinned module. This
// module is the second voice. Every refusal past the compiler goes through
// `refuseGeneration`, which appends the scene call site that first reached
// the feature owning the refused unit whenever the compiler recorded one,
// so a composition- or lowering-time refusal carries the closest
// scene-source anchor it can. The unsupported-combination table lives here
// for the same reason: a combination is refused by naming the feature the
// scene should drop, with the site that reached it.
import {
    shadowCapabilities,
    type ShadowCapabilityInputs,
} from "./shadow-capabilities.js";

/** feature -> "file:line" of the first scene-source call site reaching it. */
export type FeatureSites = Readonly<Record<string, string>>;

export class GenerationRefusal extends Error {
    public constructor(
        /**
         * What was refused: a runtime feature, a capability define, an asset
         * output name or a pinned module path.
         */
        public readonly unit: string,
        message: string,
    ) {
        super(message);
        this.name = "GenerationRefusal";
    }
}

/**
 * The " (reached from <file:line>)" suffix a refusal appends, naming the
 * scene call site that first reached the feature owning the refused unit.
 * The compiler records only first-reach sites, so this is the closest
 * scene-source anchor a composition/lowering-time refusal can carry; empty
 * when no site was recorded (a caller without the record, an asset-joined
 * feature, a unit that is not a feature), which leaves the reason alone.
 */
export function refusalReachedFrom(
    featureSites: FeatureSites | undefined,
    feature: string,
): string {
    const site = featureSites?.[feature];
    return site === undefined ? "" : ` (reached from ${site})`;
}

/**
 * Refuse generation of `unit` for `reason`.
 *
 * `unit` names what is refused and doubles as the key the reaching site is
 * looked up by, so a refusal keyed on a feature always names the scene line
 * that reached it. A unit with no recorded site -- an asset, a pinned
 * module, a feature the scene never reached -- refuses with the reason
 * alone.
 */
export function refuseGeneration(
    unit: string,
    reason: string,
    featureSites?: FeatureSites,
): never {
    throw new GenerationRefusal(
        unit,
        `${reason}${refusalReachedFrom(featureSites, unit)}`,
    );
}

/** What the unsupported-combination rows are evaluated over. */
export interface UnsupportedCombinationInputs {
    features: readonly string[];
    /** What the shadow defines are derived from, for the ESM row. */
    shadows: ShadowCapabilityInputs;
    /** How many node geometry-output views the scene composed. */
    nodeGeometryViews: number;
}

interface UnsupportedCombination {
    /**
     * The unit refused -- the feature the scene should drop -- and the key
     * its reaching site is looked up by.
     */
    unit: string;
    reached: (inputs: UnsupportedCombinationInputs) => boolean;
    reason: string;
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
 * Every combination of reached units generation refuses rather than
 * emitting a runtime that answers wrongly. One table, so the edge of what
 * combines is read in one place; each row names the unit to drop.
 *
 * The node-geometry rule has a second half evaluated where the glTF
 * documents are (`composeScenePipeline`): a view over an asset whose
 * shape the retained-attribute contract does not cover refuses there
 * through the same helper, under the same unit.
 */
export const unsupportedCombinations: readonly UnsupportedCombination[] = [
    {
        // `BBLITE_SHADOWS_ESM` gates the ESM generator's own resources, and
        // what reads it is each family's caster view. A scene reaching the
        // filter that composes no family at all would compile that define
        // to zero and then refresh its directional generator through the
        // PCF spot's matrix builder, which answers rather than failing.
        unit: "shadow:esm",
        reached: (inputs) =>
            inputs.features.includes("shadow:esm") &&
            !shadowCapabilities(inputs.shadows).esm,
        reason:
            "A scene reaching the ESM shadow generator composes no material " +
            "family to cast through. Each family carries its own caster " +
            "view (material/<family>/esm-shadow-view.ts), and a scene " +
            "reaching none of them would refresh its directional " +
            "generator through the PCF spot's matrix builder.",
    },
    ...floatingOriginUnwired.map(
        ({ feature, why }): UnsupportedCombination => ({
            unit: feature,
            reached: (inputs) =>
                inputs.features.includes("renderer:floating-origin") &&
                inputs.features.includes(feature),
            reason:
                `A floating-origin scene reaches ${feature}, which is not ` +
                `in the eye-relative frame yet: ${why}. Wire it, or drop ` +
                "useFloatingOrigin from the engine.",
        }),
    ),
    {
        unit: "loader:babylon",
        reached: (inputs) =>
            inputs.nodeGeometryViews > 0 &&
            inputs.features.includes("loader:babylon"),
        reason:
            "Node geometry views require retained local vertex attributes; " +
            "the Babylon loader does not provide that source contract.",
    },
];

/** Refuse the first unsupported combination the scene reaches, if any. */
export function refuseUnsupportedCombinations(
    inputs: UnsupportedCombinationInputs,
    featureSites?: FeatureSites,
): void {
    for (const combination of unsupportedCombinations) {
        if (combination.reached(inputs)) {
            refuseGeneration(combination.unit, combination.reason, featureSites);
        }
    }
}
