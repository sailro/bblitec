import assert from "node:assert/strict";
import test from "node:test";
import { floatLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    pinnedShadowHeader,
    shadowFactorySource,
} from "../src/lowering/shadow-lowerer.js";
import { lowerSkeletonShadowBounds } from "../src/lowering/skeleton-shadow-bounds.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

/**
 * `enableSkeletonShadows`: a skinned caster is fitted by its bones' live
 * boxes. The pin's own providers run here over a stand-in generator and their
 * fitted bounds are the reference for the native provider, alone and
 * composed over the morph provider's box.
 */

interface PinnedCaster {
    boundMin?: readonly number[];
    boundMax?: readonly number[];
}

/** Four vertices; bone 2 is never weighted, joint 7 is out of range. */
const positions = [1, 2, 3, -4, 0.5, 2, 0, -1, -3, 2.25, 3, 0];
const joints = [0, 1, 0, 0, 1, 7, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0];
const weights = [0.75, 0.25, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0];
/** Column-major bone palette: a rotation about Y with a translation, and a scaled offset. */
const boneMatrices = [
    0.6, 0, -0.8, 0, 0, 1, 0, 0, 0.8, 0, 0.6, 0, 1.5, -2, 0.25, 1, 2, 0, 0, 0,
    0, 0.5, 0, 0, 0, 0, 1, 0, -1, 0, 3, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
    0, 0, 0, 1,
];
/** One morph target whose delta range the morph stage scales by 0.5. */
const morphDeltas = [0.5, 0, 0, -1, 2, 0, 0, 0, 0.25, 0, 0, 0];

/** The bounds the pin fits one caster with, under the providers asked for. */
async function pinnedBounds(providers: {
    skeleton: boolean;
    morph: boolean;
}): Promise<number[]> {
    const pin = await import("@babylonjs/lite");
    let fitted: PinnedCaster[] = [];
    const generator = {
        _preloadShadowTask: () => undefined,
        _ensureShadowTaskState: (
            _engine: unknown,
            _scene: unknown,
            casterMeshes: readonly PinnedCaster[],
        ) => ({ _casterMeshes: casterMeshes }),
        _renderShadowMap: (
            _engine: unknown,
            state: { _casterMeshes: readonly PinnedCaster[] },
        ) => {
            fitted = [...state._casterMeshes];
        },
    };
    // A stand-in for the three task hooks the providers wrap; the pin's
    // generator type carries the whole task machinery besides.
    const shadow = generator as unknown as Parameters<
        typeof pin.enableSkeletonShadows
    >[0];
    if (providers.skeleton) pin.enableSkeletonShadows(shadow);
    if (providers.morph) pin.enableMorphTargetShadows(shadow);
    const mesh = {
        _cpuPositions: new Float32Array(positions),
        boundMin: [-4, -1, -3],
        boundMax: [2.25, 3, 3],
        worldMatrixVersion: 0,
        skeleton: {
            boneCount: 3,
            joints: new Uint16Array(joints),
            weights: new Float32Array(weights),
            boneMatrices: new Float32Array(boneMatrices),
        },
        morphTargets: {
            count: 1,
            targets: [{ positions: new Float32Array(morphDeltas) }],
            weights: [0.5],
        },
    };
    generator._renderShadowMap(
        null,
        generator._ensureShadowTaskState(null, null, [mesh]),
    );
    const caster = fitted[0]!;
    return [...caster.boundMin!, ...caster.boundMax!];
}

/**
 * The native provider over the same skin: one line of six bounds per fit,
 * from the geometry box alone, then composed over the given morph box.
 */
function nativeBounds(
    native: NonNullable<ReturnType<typeof optionalNativeFixtureTools>>,
    morph: readonly number[],
): number[][] {
    const floats = (values: readonly number[]): string =>
        values.map(floatLiteral).join(",");
    const vertices = Array.from(
        { length: 4 },
        (_, vertex) =>
            `{ModelVertex v; v.position={${floats(positions.slice(vertex * 3, vertex * 3 + 3))}}; ` +
            `v.joints={${joints.slice(vertex * 4, vertex * 4 + 4).join(",")}}; ` +
            `v.weights={${floats(weights.slice(vertex * 4, vertex * 4 + 4))}}; geometry.vertices.push_back(v);}`,
    ).join("\n    ");
    const palette = Array.from(
        { length: 3 },
        (_, bone) =>
            `{${floats(boneMatrices.slice(bone * 16, bone * 16 + 16))}}`,
    ).join(",");
    const output = runGeneratedProgram(
        native,
        "skeleton-shadow-bounds",
        `#include <bblite/runtime.hpp>
#include <cstdio>
namespace bbl::upstream {
${lowerSkeletonShadowBounds(new LoweringContext())}
}
int main() {
    using namespace bbl;
    Engine engine;
    engine.geometries.emplace_back();
    ModelGeometry& geometry = engine.geometries[0];
    ${vertices}
    MeshRecord mesh;
    mesh.bone_matrices = {${palette}};
    const auto fit = [&](std::array<float, 3> min, std::array<float, 3> max, bool composed) {
        upstream::expand_skeleton_caster_bounds(geometry, mesh, composed, min, max);
        for (const float value : min) std::printf("%.9g ", static_cast<double>(value));
        for (const float value : max) std::printf("%.9g ", static_cast<double>(value));
        std::printf("\\n");
    };
    fit({${floats([-4, -1, -3])}}, {${floats([2.25, 3, 3])}}, false);
    fit({${floats(morph.slice(0, 3))}}, {${floats(morph.slice(3))}}, true);
    // Both fits read one cache: bones 0 and 1, built once.
    return geometry.skinned_bones.boxes.size() == 2 ? 0 : 2;
}
`,
    );
    return (
        output
            .trim()
            .split(/\r?\n/)
            // `%.9g` round-trips a float through a float parse: back to float32.
            .map((line) =>
                line
                    .trim()
                    .split(" ")
                    .map((value) => Math.fround(Number(value))),
            )
    );
}

test("emits the skeleton caster bounds only for a scene that registers them", () => {
    const plain = pinnedShadowHeader(new LoweringContext());
    assert.doesNotMatch(
        plain,
        /expand_skeleton_caster_bounds|bone_matrices_version|skeleton_shadow_bounds/,
    );
    const skeleton = pinnedShadowHeader(new LoweringContext(), [
        "shadow:skeleton-bounds",
    ]);
    assert.match(skeleton, /inline void grow_corners_by_matrix\(/);
    assert.match(skeleton, /inline void expand_skeleton_caster_bounds\(/);
    assert.match(
        skeleton,
        /if \(generator\.skeleton_shadow_bounds\) sum \+= mesh\.bone_matrices_version;/,
    );
    assert.match(
        shadowFactorySource(new LoweringContext(), [
            "shadow:pcf",
            "shadow:skeleton-bounds",
        ]).source,
        /void enable_skeleton_shadows\(/,
    );
});

test("fits a skinned caster by its bones' live boxes, as the pin does", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const morph = await pinnedBounds({ skeleton: false, morph: true });
    const [alone, composed] = nativeBounds(native, morph);
    assert.deepEqual(
        alone,
        (await pinnedBounds({ skeleton: true, morph: false })).map(Math.fround),
    );
    assert.deepEqual(
        composed,
        (await pinnedBounds({ skeleton: true, morph: true })).map(Math.fround),
    );
});
