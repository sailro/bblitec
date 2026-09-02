import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { EnvironmentLowerer } from "../src/lowering/environment-lowerer.js";
import { GeometryOutputLowerer } from "../src/lowering/geometry-output-lowerer.js";
import { NodeParticleLowerer } from "../src/lowering/node-particle-lowerer.js";

/**
 * Round-2 anchors: these lowerers no longer carry re-typed copies of the
 * pinned geometry tables and sizing literals — the values flow from the
 * pinned AST into the emission. The assertions here pin the flowed results
 * (and would catch an extraction that silently starts reading the wrong
 * slot), while the structural contracts inside the lowerers are what stop
 * generation when the pin itself moves.
 */

test("node-particle billboard options initialize custom texture names", () => {
    const lowered = new NodeParticleLowerer(new LoweringContext()).lower([
        {
            bake: {
                set: 0,
                system: 0,
                capacity: 16,
                blendMode: 0,
                updateSpeed: 0,
                stepIsIdentity: true,
                texture: {
                    url: "textures/flare.png",
                    invertY: false,
                    sceneAssigned: false,
                    width: 128,
                    height: 128,
                },
                spriteSheet: null,
                alive: 0,
                positions: [],
                sizes: [],
                colors: [],
                rotations: [],
                frames: null,
            },
            exactBlend: false,
            textureAsset: "flare.png",
        },
    ]);

    assert.match(
        lowered.source,
        /\.custom_textures = \{\},\n\s*\.custom_texture_names = \{\},/,
    );
});

test("the grown-array builders flow their pinned defaults and rounding", () => {
    // The half of the family that GROWS a `number[]` and converts at the
    // end. Each assertion is a value the PIN states, so a pin that moves a
    // default or a rounding boundary fails here rather than at a parity
    // number: the disc's radius/tessellation, the cylinder's height and
    // tessellation floor, and the ribbon's value-selecting `|| 1`, which
    // must stay `or_number` and not become a C++ boolean.
    const context = new LoweringContext();
    const lowered = new FactoryLowerer(context).lowerMeshFactories([
        "mesh:disc",
        "mesh:cylinder",
        "mesh:polyhedron",
        "mesh:ribbon",
    ]);
    for (const builder of [
        "pinned_create_disc_data",
        "pinned_create_cylinder_data",
        "pinned_create_polyhedron_data",
        "pinned_create_ribbon_data",
        "pinned_compute_normals",
    ]) {
        assert.ok(
            lowered.source.includes(builder),
            `${builder} is not emitted`,
        );
    }
    // `computeNormals` is shared, not copied per builder.
    assert.equal(
        lowered.source.match(/static std::vector<double> pinned_compute_normals/g)
            ?.length,
        1,
    );
    // The disc's own `??` defaults, flowed rather than restated.
    assert.match(lowered.source, /const double radius = options\.radius;/);
    // The cylinder's tessellation floor is the pin's `Math.max(3, …)`.
    assert.match(lowered.source, /std::max<double>\(3\.0,/);
    // The ribbon's seam normal: a VALUE-selecting `||`, which a boolean
    // operator would flatten to the constant 1.
    assert.match(lowered.source, /bbl::js::or_number\(/);
    // A grown list rounds once, through the pin's own conversion.
    assert.match(lowered.source, /bbl::js::f32_array_from\(/);
    assert.match(lowered.source, /bbl::js::u32_array_from\(/);
    // A FIXED `new F64(n)` scratch is indexed directly; only a growable
    // list reaches `at_grow`.
    const start = lowered.source.indexOf(
        "static std::vector<double> pinned_compute_normals",
    );
    const body = lowered.source.slice(
        start,
        lowered.source.indexOf("\n}", start),
    );
    assert.ok(start >= 0);
    assert.doesNotMatch(body, /at_grow/);
});

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
    ).lowerLoaderAdapter({ loadEnvironment: true, ddsBackground: false });
    // Each literal is tied to its parameter position in the pinned
    // computeSceneSize, then interpolated here: defaults, the diagonal
    // override, the two final scales, and the root composition.
    assert.match(adapter.source, /ground_size = 15\.0f;/);
    assert.match(
        adapter.source,
        /options\.skybox_size : 20\.0f;/,
    );
    assert.match(adapter.source, /double ground_size = 15\.0;/);
    assert.match(
        adapter.source,
        /\*camera\.upper_radius_limit \*\s*2\.0/,
    );
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
    // The deferred builder sees the scene as it exists at registration,
    // including procedural meshes and their live parented transforms. The
    // pin expands each local box through mesh.worldMatrix at that point.
    assert.match(
        adapter.source,
        /upstream::mesh_world_matrix\(\*scene\.engine, mesh\)/,
    );
    assert.match(
        adapter.source,
        /world\[12 \+ row\]/,
    );
    assert.match(
        adapter.source,
        /world\[column \* 4 \+ row\]/,
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
