import assert from "node:assert/strict";
import test from "node:test";
import { floatLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMorphShadowBounds } from "../src/lowering/morph-shadow-bounds.js";
import { doctoredContext } from "./doctored-store.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const modulePath = "src/shadow/enable-morph-target-shadows.ts";
const deltas = [
    [0.1, 0.2, 0.3, 1.1, 1.2, 1.3].map(Math.fround),
    [-2, -3, -4, 2, 3, 4],
];

async function pinnedBounds(weights: readonly number[]): Promise<number[]> {
    const pin = await import("@babylonjs/lite");
    let fitted: readonly {
        boundMin?: readonly number[];
        boundMax?: readonly number[];
    }[] = [];
    const generator = {
        _preloadShadowTask: () => undefined,
        _ensureShadowTaskState: (
            _engine: unknown,
            _scene: unknown,
            meshes: readonly {
                boundMin?: readonly number[];
                boundMax?: readonly number[];
            }[],
        ) => ({ _casterMeshes: meshes }),
        _renderShadowMap: (
            _engine: unknown,
            state: { _casterMeshes: typeof fitted },
        ) => {
            fitted = state._casterMeshes;
        },
    };
    // Only the three hooks wrapped by the pinned provider are used.
    pin.enableMorphTargetShadows(generator);
    const mesh = {
        _cpuPositions: new Float32Array([-1, -2, -3, 1, 2, 3]),
        boundMin: [-1, -2, -3],
        boundMax: [1, 2, 3],
        worldMatrixVersion: 0,
        morphTargets: {
            count: deltas.length,
            targets: deltas.map((values) => ({
                positions: new Float32Array(values),
            })),
            weights: [...weights],
        },
    };
    generator._renderShadowMap(
        null,
        generator._ensureShadowTaskState(null, null, [mesh]),
    );
    return [...fitted[0]!.boundMin!, ...fitted[0]!.boundMax!].map(Math.fround);
}

test("morph shadow bounds lower the pinned weight guard and arithmetic", () => {
    const ordinary = lowerMorphShadowBounds(new LoweringContext());
    assert.match(ordinary, /number_truthy/);
    assert.match(ordinary, /morphBoundsProvider\.getLocalBounds/);
    const changed = lowerMorphShadowBounds(
        doctoredContext(
            modulePath,
            "min[axis] = min[axis]! + targetMin[axis]! * weight;",
            "min[axis] = min[axis]! + targetMin[axis]! * weight * 2;",
        ),
    );
    assert.notEqual(changed, ordinary);
    assert.match(changed, /\* 2\.0/);
    const changedGuard = lowerMorphShadowBounds(
        doctoredContext(
            modulePath,
            "if (!range || !weight)",
            "if (!range || weight === 0)",
        ),
    );
    assert.notEqual(changedGuard, ordinary);
    assert.doesNotMatch(changedGuard, /number_truthy\(weight\)/);
});

test("morph bounds match the pin for missing, zero, negative, finite and NaN weights", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const cases = [[], [0, 0], [-1, 0.5], [Number.NaN, 0.25], [0.1, 0.2]].map(
        (values) => values.map(Math.fround),
    );
    const expected = await Promise.all(cases.map(pinnedBounds));
    const number = (value: number): string =>
        Number.isNaN(value)
            ? "std::numeric_limits<float>::quiet_NaN()"
            : floatLiteral(value);
    const ranges = deltas
        .map(
            (values) =>
                `{Vec3{${values.slice(0, 3).map(number).join(",")}}, Vec3{${values.slice(3).map(number).join(",")}}}`,
        )
        .join(",");
    const output = runGeneratedProgram(
        tools,
        "morph-shadow-bounds",
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cstdio>
namespace bbl::upstream {
${lowerMorphShadowBounds(new LoweringContext())}
}
int main() {
    using namespace bbl;
    const std::vector<std::array<Vec3, 2>> ranges{${ranges}};
    const auto fit = [&](const std::vector<float>& weights) {
        std::array<float, 3> min{-1,-2,-3}, max{1,2,3};
        upstream::expand_morph_caster_bounds(ranges, weights.data(), weights.size(), min, max);
        for (float value : min) std::printf("%.9g ", static_cast<double>(value));
        for (float value : max) std::printf("%.9g ", static_cast<double>(value));
        std::printf("\\n");
    };
${cases.map((values) => `    fit({${values.map(number).join(",")}});`).join("\n")}
}
`,
    );
    const actual = output
        .trim()
        .split(/\r?\n/)
        .map((line) =>
            line
                .trim()
                .split(/\s+/)
                .map((value) => Math.fround(Number(value))),
        );
    assert.deepEqual(actual, expected);
});
