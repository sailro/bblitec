import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { EnvironmentLowerer } from "../src/lowering/environment-lowerer.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";

/**
 * Round-2 anchors: these lowerers no longer carry re-typed copies of the
 * pinned geometry tables and sizing literals — the values flow from the
 * pinned AST into the emission. The assertions here pin the flowed results
 * (and would catch an extraction that silently starts reading the wrong
 * slot), while the structural contracts inside the lowerers are what stop
 * generation when the pin itself moves.
 */

test("mesh factory tables flow from the pinned builders", () => {
    const lowered = new FactoryLowerer(
        new LoweringContext(),
    ).lowerMeshFactories();
    // Box: the first face decoded from the pinned BOX_POSITION_SIGNS
    // words, and one face per pinned table group.
    assert.match(
        lowered.source,
        /add_face\(\n        Vec3\{half_width, -half_height, half_depth\},\n        Vec3\{-half_width, -half_height, half_depth\},\n        Vec3\{-half_width, half_height, half_depth\},\n        Vec3\{half_width, half_height, half_depth\},\n        Vec3\{0\.0f, 0\.0f, 1\.0f\}\);/,
    );
    assert.equal(
        lowered.source.match(/add_face\(\n/g)?.length,
        6,
    );
    // The shared local quad pattern and UV quad, decoded from BOX_INDICES
    // and BOX_UVS.
    assert.match(
        lowered.source,
        /\{start, start \+ 1, start \+ 2, start, start \+ 2, start \+ 3\}/,
    );
    assert.match(
        lowered.source,
        /Vec2\{1\.0f, 1\.0f\}\},\n\s*ModelVertex\{b/,
    );
    // Ground: the pinned winding order, name by name.
    assert.match(
        lowered.source,
        /\{\n                    bottom_right,\n                    top_right,\n                    top_left,\n                    bottom_left,\n                    bottom_right,\n                    top_left,\n                \}/,
    );
    // Plane: the table-driven quad.
    assert.match(
        lowered.source,
        /geometry\.indices = \{0, 1, 2, 0, 2, 3\};/,
    );
    assert.match(
        lowered.source,
        /Vec3\{-half_width, -half_height, 0\.0f\}/,
    );
    // Sphere: the tessellation constants extracted from the pinned
    // arithmetic (2 + segments, 2 * z_steps, the 3-segment clamp) and the
    // pinned triangulation order.
    assert.match(lowered.source, /z_steps = 2 \+ segments;/);
    assert.match(lowered.source, /y_steps = 2 \* z_steps;/);
    assert.match(
        lowered.source,
        /std::max<std::uint32_t>\(3, options\.segments\)/,
    );
    assert.match(
        lowered.source,
        /\{a, a \+ 1, b, b, a \+ 1, b \+ 1\}/,
    );
    // Torus: TWO_PI's factor, the reciprocal of the pinned Math.PI / 2
    // phase, and the pinned triangulation order.
    assert.match(
        lowered.source,
        /outer_index\) \* 2\.0f \* pi/,
    );
    assert.match(lowered.source, /pi \* 0\.5f;/);
    assert.match(
        lowered.source,
        /\{\n                    outer_index \* stride \+ inner_index,\n                    outer_index \* stride \+ next_inner,\n                    next_outer \* stride \+ inner_index,/,
    );
});

test("environment sizing constants flow slot by slot", () => {
    const adapter = new EnvironmentLowerer(
        new LoweringContext(),
    ).lowerLoaderAdapter();
    // Each literal is tied to its parameter position in the pinned
    // computeSceneSize, then interpolated here: defaults, the diagonal
    // override, the two final scales, and the root composition.
    assert.match(adapter.source, /ground_size = 15\.0f;/);
    assert.match(
        adapter.source,
        /options\.skybox_size : 20\.0f;/,
    );
    assert.match(adapter.source, /double ground_size = 15\.0;/);
    assert.match(adapter.source, /diagonal \* 2\.0;/);
    assert.match(adapter.source, /ground_size \*= 1\.1;/);
    assert.match(adapter.source, /skybox_size \*= 1\.5;/);
    assert.match(
        adapter.source,
        /bounds_min\[0\] \+ dx \* 0\.5/,
    );
    assert.match(
        adapter.source,
        /bounds_min\[1\] - 0\.00001/,
    );
    assert.match(
        adapter.source,
        /bounds_min\[2\] \+ dz \* 0\.5/,
    );
});

test("harmonic pre-scale terms stay paired with the pinned structure", () => {
    const parser = new EnvironmentLowerer(
        new LoweringContext(),
    ).lowerParser();
    // lowerParser now walks polynomialToPreScaledHarmonics term by term
    // (input groups at poly[3k + i], stores at out[4k + i], one structural
    // assert per term); reaching the emission at all means those pairings
    // held, and the emitted terms carry the constants extracted from the
    // same declaration.
    assert.match(
        parser.source,
        /\(xx \+ yy\) \* c00xy \+ zz \* c00z/,
    );
    assert.match(
        parser.source,
        /zz \* c20zz - \(xx \+ yy\) \* c20xy/,
    );
    assert.match(parser.source, /\(xx - yy\) \* c22/);
    assert.match(
        parser.source,
        /constexpr float c1 = 1\.4999984284682104f/,
    );
});

test("the copy-blit Y-flip is anchored to the pinned viewport composition", () => {
    const lowered = new GeometryOutputLowerer(
        new LoweringContext(),
    ).lowerTaskRecords();
    // The pinned buildBlitPath composes { x, y: h - yTop - vh, w: vw,
    // h: vh }; the lowerer asserts that composition field by field, so the
    // emitted target-space flip below is upstream provenance, not a native
    // orientation choice.
    assert.match(
        lowered.source,
        /static_cast<std::int32_t>\(target_height\) -\n\s*y_top -\n\s*viewport_height/,
    );
});
