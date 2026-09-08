import assert from "node:assert/strict";
import test from "node:test";
import {
    GenerationRefusal,
    refusalReachedFrom,
    refuseGeneration,
    refuseUnsupportedCombinations,
    unsupportedCombinations,
    type UnsupportedCombinationInputs,
} from "../src/generation-refusal.js";

const sites = {
    "shadow:esm": "scene.ts:12",
    "loader:splat": "scene.ts:20",
    "loader:babylon": "scene.ts:31",
    "renderer:floating-origin": "scene.ts:3",
};

function inputs(
    overrides: Partial<UnsupportedCombinationInputs> = {},
): UnsupportedCombinationInputs {
    return {
        features: ["core", "renderer:scene"],
        shadows: {
            features: ["core", "renderer:scene"],
            standardVariants: 0,
            pbrVariants: 0,
            nodeShadowReceivers: 0,
            nodeEsmCasters: 0,
        },
        nodeGeometryViews: 0,
        ...overrides,
    };
}

test("a refusal names its unit and the site that reached it", () => {
    assert.throws(
        () => refuseGeneration("loader:splat", "Clouds are not lowered here.", sites),
        (error: unknown) =>
            error instanceof GenerationRefusal &&
            error.unit === "loader:splat" &&
            error.message ===
                "Clouds are not lowered here. (reached from scene.ts:20)",
    );
    // A unit with no recorded site -- an asset, a pinned module, a feature
    // the scene never reached -- refuses with the reason alone.
    assert.throws(
        () => refuseGeneration("asset.glb", "asset.glb: not lowered.", sites),
        (error: unknown) =>
            error instanceof GenerationRefusal &&
            error.message === "asset.glb: not lowered.",
    );
    assert.equal(refusalReachedFrom(undefined, "loader:splat"), "");
    assert.equal(
        refusalReachedFrom(sites, "loader:splat"),
        " (reached from scene.ts:20)",
    );
});

test("the combination table refuses each pair by the unit to drop", () => {
    // Nothing reached: every row stays quiet.
    assert.doesNotThrow(() => refuseUnsupportedCombinations(inputs(), sites));

    // ESM reached with no family composing a caster view.
    const esm = ["core", "renderer:scene", "shadow:esm"];
    assert.throws(
        () =>
            refuseUnsupportedCombinations(
                inputs({ features: esm, shadows: { ...inputs().shadows, features: esm } }),
                sites,
            ),
        /ESM shadow generator composes no material family.*\(reached from scene\.ts:12\)/,
    );
    // The same reach with a composed Standard variant is a supported pair.
    assert.doesNotThrow(() =>
        refuseUnsupportedCombinations(
            inputs({
                features: esm,
                shadows: { ...inputs().shadows, features: esm, standardVariants: 1 },
            }),
            sites,
        )
    );

    // A floating-origin scene reaching a subsystem still drawn in absolute
    // space is refused naming that subsystem and its own site.
    assert.throws(
        () =>
            refuseUnsupportedCombinations(
                inputs({
                    features: ["core", "renderer:floating-origin", "loader:splat"],
                }),
                sites,
            ),
        /floating-origin scene reaches loader:splat.*\(reached from scene\.ts:20\)/,
    );
    assert.doesNotThrow(() =>
        refuseUnsupportedCombinations(
            inputs({ features: ["core", "loader:splat"] }),
            sites,
        )
    );

    // Node geometry views over the Babylon loader.
    assert.throws(
        () =>
            refuseUnsupportedCombinations(
                inputs({
                    features: ["core", "loader:babylon", "material:node"],
                    nodeGeometryViews: 1,
                }),
                sites,
            ),
        /Babylon loader does not provide that source contract.*\(reached from scene\.ts:31\)/,
    );
    assert.doesNotThrow(() =>
        refuseUnsupportedCombinations(
            inputs({ features: ["core", "loader:babylon"], nodeGeometryViews: 0 }),
            sites,
        )
    );

    // Every row names a unit a scene can drop.
    for (const combination of unsupportedCombinations) {
        assert.ok(combination.unit.includes(":"), combination.unit);
    }
});
