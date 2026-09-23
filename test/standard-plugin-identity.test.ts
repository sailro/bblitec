import assert from "node:assert/strict";
import test from "node:test";

test("Standard plugin signatures select distinct shaders with identical feature flags", async () => {
    const { enablePinnedMaterialPlugins } =
        await import("../src/pinned-material-plugins.js");
    const { composePinnedStandardVariant } =
        await import("../src/pinned-standard-variants.js");
    await enablePinnedMaterialPlugins([
        [
            {
                name: "first",
                fragment: {
                    CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                        "baseColor = vec3<f32>(0.25);",
                },
            },
        ],
        [
            {
                name: "second",
                fragment: {
                    CUSTOM_FRAGMENT_UPDATE_DIFFUSE:
                        "baseColor = vec3<f32>(0.75);",
                },
            },
        ],
    ]);
    const first = await composePinnedStandardVariant({ pluginIndex: 1 });
    const second = await composePinnedStandardVariant({ pluginIndex: 2 });
    assert.equal(first.features, second.features);
    assert.equal(first.meshFeatures, second.meshFeatures);
    assert.notEqual(first.fragmentKey, second.fragmentKey);
    assert.match(first.fragmentWgsl, /0\.25/);
    assert.match(second.fragmentWgsl, /0\.75/);
    assert.doesNotMatch(first.fragmentWgsl, /0\.75/);
});
