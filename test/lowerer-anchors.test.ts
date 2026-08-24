import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
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
    const context = new LoweringContext();
    const lowered = new FactoryLowerer(context).lowerMeshFactories();
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
    // Ground: the pinned winding order, name by name, now inside the body
    // PinnedNumericLowerer translated rather than an interpolated list.
    assert.match(
        lowered.source,
        /static_cast<std::uint32_t>\(bottomRight\)[\s\S]*static_cast<std::uint32_t>\(topRight\)[\s\S]*static_cast<std::uint32_t>\(topLeft\)[\s\S]*static_cast<std::uint32_t>\(bottomLeft\)[\s\S]*static_cast<std::uint32_t>\(bottomRight\)[\s\S]*static_cast<std::uint32_t>\(topLeft\)/,
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
    assert.match(
        lowered.source,
        /totalZRotationSteps = \(2\.0 \+ segments\)/,
    );
    assert.match(
        lowered.source,
        /totalYRotationSteps = \(2\.0 \* totalZRotationSteps\)/,
    );
    assert.match(
        lowered.source,
        /std::max<double>\(3\.0, options\.segments\)/,
    );
    assert.match(
        lowered.source,
        /static_cast<std::uint32_t>\(a\)[\s\S]*static_cast<std::uint32_t>\(\(a \+ 1\.0\)\)[\s\S]*static_cast<std::uint32_t>\(b\)/,
    );
    // Torus: TWO_PI's factor, the reciprocal of the pinned Math.PI / 2
    // phase, and the pinned triangulation order. The whole chain is the
    // pin's own precision, so the constants are doubles with it.
    assert.match(
        lowered.source,
        /const double TWO_PI = \(pi_double \* 2\.0\)/,
    );
    assert.match(lowered.source, /\(pi_double \/ 2\.0\)/);
    assert.match(
        lowered.source,
        /static_cast<std::uint32_t>\(\(\(i \* stride\) \+ j\)\)[\s\S]*static_cast<std::uint32_t>\(\(\(i \* stride\) \+ nextJ\)\)[\s\S]*static_cast<std::uint32_t>\(\(\(nextI \* stride\) \+ j\)\)/,
    );

    // Store-width gate: each helper's float narrowing must be an indexed
    // store that corresponds one-for-one with an assignment to a buffer the
    // pinned body allocated with `new F32(...)`. This is derived from that
    // body rather than a hand-maintained count.
    const pinnedF32StoreCount = (
        modulePath: string,
        symbolName: string,
    ): number => {
        const { declaration } = context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const buffers = new Set(
            context
                .findNodes(
                    declaration,
                    (node): node is ts.VariableDeclaration =>
                        ts.isVariableDeclaration(node),
                )
                .filter((declaration) => {
                    const initializer = declaration.initializer;
                    return (
                        ts.isIdentifier(declaration.name) &&
                        !!initializer &&
                        ts.isNewExpression(initializer) &&
                        ts.isIdentifier(initializer.expression) &&
                        initializer.expression.text === "F32"
                    );
                })
                .map((declaration) =>
                    (declaration.name as ts.Identifier).text,
                ),
        );
        return context
            .findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter(
                (assignment) =>
                    assignment.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isElementAccessExpression(assignment.left) &&
                    ts.isIdentifier(assignment.left.expression) &&
                    buffers.has(assignment.left.expression.text),
            ).length;
    };
    for (const [modulePath, symbolName, emittedName, nextName] of [
        [
            "src/mesh/create-ground.ts",
            "createFlatGroundData",
            "pinned_create_flat_ground_data",
            "MeshHandle create_ground",
        ],
        [
            "src/mesh/create-sphere.ts",
            "createSphereData",
            "pinned_create_sphere_data",
            "static ModelGeometry build_sphere_geometry",
        ],
        [
            "src/mesh/create-torus.ts",
            "createTorusData",
            "pinned_create_torus_data",
            "MeshHandle create_torus",
        ],
    ] as const) {
        const start = lowered.source.indexOf(emittedName);
        const end = lowered.source.indexOf(nextName, start);
        assert.notEqual(start, -1);
        assert.notEqual(end, -1);
        const helper = lowered.source.slice(start, end);
        const casts = helper.match(/static_cast<float>\(/g)?.length ?? 0;
        const stores =
            helper.match(/\] = static_cast<float>\(/g)?.length ?? 0;
        assert.equal(casts, stores, `${emittedName} narrows only at stores`);
        assert.equal(
            stores,
            pinnedF32StoreCount(modulePath, symbolName),
            `${emittedName} lowers every pinned F32 store`,
        );
    }
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
