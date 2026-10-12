import ts from "typescript";
import {
    lowerMeshGeometryResize,
    lowerRenderBundleInvalidation,
} from "../mesh-geometry-resize.js";
import { lowerMeshAttributeUpdates } from "../mesh-attribute-updates.js";
import { lowerMeshGeometryUpdates } from "../mesh-geometry-updates.js";
import { lowerMeshAttributeCapacities } from "../mesh-attribute-capacities.js";
import { lowerMeshCpuStreamRetainers } from "../mesh-cpu-streams.js";
import { cppIdentifierPattern } from "../../cpp-literals.js";
import { LoweredSource, LoweringContext } from "../context.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "../pinned-numeric-lowerer.js";

import { pinnedMeshOptionLocals } from "../../pinned-mesh-defaults.js";
import { lowerComputeAabb } from "../pinned-compute-aabb.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import {
    lowerObjectComponents,
    lowerTupleComponents,
} from "../pinned-function-lowerer.js";
import { recordAt } from "../../compiler/record-access.js";

/**
 * The names one pinned closure reads from OUTSIDE itself.
 *
 * A JavaScript closure captures by name, and a free C++ function cannot —
 * so what a closure reads has to become parameters, and reading that list
 * off the arrow is what keeps it the pin's rather than one typed beside the
 * emitter. Only value positions count: `Math.cos`'s `cos` is a member, not
 * a name being read, so a property access contributes its receiver alone.
 *
 * `Math` is subtracted because the translator answers it from the shared
 * `calls` table rather than from a binding; every other free name is the
 * caller's to recognise, and one it does not recognise is a contract error
 * there rather than a silently-dropped read here.
 */
function freeIdentifiers(
    arrow: ts.ArrowFunction,
    parameters: ReadonlySet<string>,
): ReadonlySet<string> {
    const declared = new Set<string>(parameters);
    const read = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            declared.add(node.name.text);
        }
        if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
            declared.add(node.name.text);
        }
        if (ts.isPropertyAccessExpression(node)) {
            visit(node.expression);
            return;
        }
        if (ts.isIdentifier(node)) {
            read.add(node.text);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(arrow.body);
    const free = new Set<string>();
    for (const name of read) {
        if (!declared.has(name) && name !== "Math") free.add(name);
    }
    return free;
}

type MeshBuilderEmitter = (
    file: ts.SourceFile,
    declaration: ts.FunctionDeclaration,
    optionBindings: ReadonlyMap<string, string>,
    optionTypes?: ReadonlyMap<string, PinnedBinding["type"]>,
    extra?: {
        statements?: readonly ts.Statement[];
        calls?: ReadonlyMap<string, (args: readonly string[]) => string>;
        fixedTupleCalls?: ReadonlyMap<string, number>;
        methods?: ReadonlyMap<
            string,
            (
                receiver: string,
                args: readonly string[],
                binding: PinnedBinding,
            ) => string
        >;
        receiverReturningMethods?: ReadonlySet<string>;
    },
) => string;

interface MeshBuilderAssertions {
    assertVariable: (
        root: ts.Node,
        name: string,
        expected: string,
        label: string,
    ) => ts.Expression;
    constructorArrayElements: (
        root: ts.Node,
        variableName: string,
        constructorName: string,
    ) => {
        expression: ts.Expression;
        elements: readonly ts.Expression[];
    };
    numericConstructorArray: (
        file: ts.SourceFile,
        variableName: string,
        constructorName: string,
    ) => {
        expression: ts.Expression;
        values: number[];
    };
}

/**
 * The mesh-builder half of the factory unit: the pinned CreateBox /
 * CreateGround / CreateSphere / CreateTorus / CreateCylinder family and
 * the geometry plumbing their emitted C++ shares. The material and
 * texture factories extend this class in `material-factories.ts`; the
 * combined surface stays `FactoryLowerer`, re-exported by
 * `factory-lowerer.ts`.
 */
export class MeshBuilderLowerer {
    public constructor(protected readonly context: LoweringContext) {}

    /**
     * @param features - what the scene reached. Every builder below is
     * emitted only where its own feature is in it, the way the rest of this
     * unit's surface follows what the scene touches.
     */
    public lowerMeshFactories(features: readonly string[] = []): LoweredSource {
        // Asked of the feature list rather than taken as one positional
        // boolean per builder: which builders a scene reached is already
        // stated there, and the family only grows.
        const instanceColors = features.includes("mesh:thin-instance-colors");
        const heightMapGround = features.includes("mesh:ground-heightmap");
        const disc = features.includes("mesh:disc");
        const cylinder = features.includes("mesh:cylinder");
        const capsule = features.includes("mesh:capsule");
        const polyhedron = features.includes("mesh:polyhedron");
        // The tube and the extrude both finish through the ribbon under
        // their own names -- which is how the pin composes them -- so
        // reaching either reaches this unit's ribbon.
        const ribbon =
            features.includes("mesh:ribbon") ||
            features.includes("mesh:extrude") ||
            features.includes("mesh:tube");
        const torusKnot = features.includes("mesh:torus-knot");
        const reachedTorus = features.includes("mesh:torus");
        // `enableMorphTargetShadows`' per-target range cache exists only in
        // a scene that registers it, so only there has a replaced delta set
        // a cache to drop.
        const morphBounds = features.includes("shadow:morph-bounds");
        const boxModule = "src/mesh/create-box.ts";
        const groundModule = "src/mesh/create-ground.ts";
        const planeModule = "src/mesh/create-plane.ts";
        const sphereModule = "src/mesh/create-sphere.ts";
        const torusModule = "src/mesh/create-torus.ts";
        const discModule = "src/mesh/create-disc.ts";
        const cylinderModule = "src/mesh/create-cylinder.ts";
        const capsuleModule = "src/mesh/create-capsule.ts";
        const polyhedronModule = "src/mesh/create-polyhedron.ts";
        const ribbonModule = "src/mesh/create-ribbon.ts";
        const torusKnotModule = "src/mesh/create-torus-knot.ts";
        const boxFile = this.context.sourceFile(boxModule);
        const { declaration: box } = this.context.functionDeclaration(
            boxModule,
            "createBoxData",
        );
        const { file: groundFile, declaration: ground } =
            this.context.functionDeclaration(
                groundModule,
                "createFlatGroundData",
            );
        const { file: planeFile, declaration: plane } =
            this.context.functionDeclaration(planeModule, "createPlaneData");
        const { file: sphereFile, declaration: sphere } =
            this.context.functionDeclaration(sphereModule, "createSphereData");
        const morphModule = "src/morph/create-morph-targets.ts";
        const morphFile = this.context.sourceFile(morphModule);
        const { declaration: morphTargets } = this.context.functionDeclaration(
            morphModule,
            "createMorphTargets",
        );
        this.context.functionDeclaration(morphModule, "setMorphTargetWeights");
        // The pin's own maths, plus the one helper three builders share:
        // `computeNormals` is emitted once beside them, so a call to it is
        // a call rather than another copy of its body.
        const meshMathCalls = new Map([
            [
                "len",
                (args: readonly string[]): string =>
                    `pinned_ribbon_len(${args.join(", ")})`,
            ],
            [
                "sub",
                (args: readonly string[]): string =>
                    `pinned_ribbon_sub(${args.join(", ")})`,
            ],
            [
                "computeNormals",
                (args: readonly string[]): string =>
                    `pinned_compute_normals(${args.join(", ")})`,
            ],
        ]);
        /**
         * Lower one pinned generator body into the shared native array
         * record. The four arrays and their indexed stores come from the
         * function's own AST; only the option spellings are specialized to
         * the native record that has already applied the same defaults.
         */
        const lowerPinnedMeshBuilder =
            this.createMeshBuilderLowerer(meshMathCalls);
        /**
         * The pin's displacement pass, lowered from its own body.
         *
         * It returns nothing and mutates the record the grid builder above
         * produced, so it binds that record's three arrays rather than
         * producing new ones -- the same translator, a different shape.
         */
        const lowerPinnedHeightmap = this.createHeightmapLowerer(
            groundModule,
            meshMathCalls,
        );
        const heightmapBody = heightMapGround ? lowerPinnedHeightmap() : "";
        const groundBuilderBody = lowerPinnedMeshBuilder(
            groundFile,
            ground,
            new Map([
                ["opts.width", "options.width"],
                ["opts.height", "options.height"],
                ["opts.subdivisions", "options.subdivisions"],
                ["opts.uvScale?.[0]", "options.uv_scale.x"],
                ["opts.uvScale?.[1]", "options.uv_scale.y"],
            ]),
        );
        const sphereBuilderBody = lowerPinnedMeshBuilder(
            sphereFile,
            sphere,
            new Map([
                ["options.segments", "options.segments"],
                ["options.diameter", "options.diameter_x"],
                ["options.diameterX", "options.diameter_x"],
                ["options.diameterY", "options.diameter_y"],
                ["options.diameterZ", "options.diameter_z"],
            ]),
        );
        // The disc, the first builder the pin writes with a GROWN
        // `number[]` rather than a preallocated typed array: it pushes its
        // positions and its indices and converts at the end, which is where
        // its float rounding happens. `vertexCount`/`indexCount` are bound
        // rather than returned, because the pin's own return names neither.
        const discFactory = this.lowerDiscFactory(
            disc,
            lowerPinnedMeshBuilder,
            discModule,
        );
        // The cylinder, cone and truncated cone are one pinned builder. Its
        // diameters bind UNCLAMPED, because the body asks two different
        // questions of the same field: the ring maths uses the value after
        // a zero is clamped to 0.00001, and the cone-tip normal reuse asks
        // whether the SCENE wrote a zero. Both reads work off the raw value
        // because the clamp is a local the body writes itself.
        const cylinderFactory = this.lowerCylinderFactory(
            cylinder,
            lowerPinnedMeshBuilder,
            cylinderModule,
        );
        // The capsule. Every option it takes is resolved by a TRUTHINESS
        // ternary rather than the `??` the rest of the family writes, so
        // an absent option and an explicit zero are the SAME answer to the
        // pin -- which is why the record carries zero for an option the
        // scene omitted and the body's own ternary supplies the default.
        // Nothing is folded at generation: `radiusTop` falls back to the
        // resolved `radius` and each cap to `capDetail`, and those chains
        // are the pin's to run.
        const capsuleFactory = this.lowerCapsuleFactory(
            capsule,
            lowerPinnedMeshBuilder,
            capsuleModule,
        );
        // `computeNormals`, the accumulation four of the pinned builders
        // hand their grown positions and indices to. Emitted once, from the
        // pin's own body, because the four call it rather than each
        // carrying a copy.
        const normalsModule = "src/mesh/compute-normals.ts";
        // `computeAabb`'s local arm: the bounds `createMeshFromData` folds
        // over the positions it was handed, lowered from the pinned body.
        const computeAabb = lowerComputeAabb(this.context, {
            arm: "local",
            cppName: "compute_aabb",
        });
        const computeNormals = this.lowerNormals(
            polyhedron,
            ribbon,
            torusKnot,
            normalsModule,
            meshMathCalls,
        );
        // The polyhedron. Its type table is pinned DATA and the type a
        // scene names is a compile-time value, so generation picks the row
        // and the record carries that row's own vertex and face lists --
        // which is why `type`, `size` and `data` are bound here rather than
        // recomputed: each is a local the caller already resolved.
        const polyhedronBuilderBody = !polyhedron
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(polyhedronModule),
                  this.context.functionDeclaration(
                      polyhedronModule,
                      "createPolyhedronData",
                  ).declaration,
                  new Map([
                      ["type", "0"],
                      ["size", "0.0"],
                      ["data", "options"],
                      ["data.vertex", "options.vertex"],
                      ["data.face", "options.face"],
                      ["sizeX", "options.size_x"],
                      ["sizeY", "options.size_y"],
                      ["sizeZ", "options.size_z"],
                      ["flat", "options.flat"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map([
                      ["flat", "bool"],
                      ["data.vertex", "f64-list-2d"],
                      ["data.face", "f64-list-2d"],
                  ]),
              );
        const polyhedronFactory = !polyhedron
            ? ""
            : `static PinnedMeshData pinned_create_polyhedron_data(
    PolyhedronOptions options) {
${polyhedronBuilderBody}
}

MeshHandle create_polyhedron(Engine& engine, PolyhedronOptions options) {
    PinnedMeshData data =
        pinned_create_polyhedron_data(std::move(options));
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createPolyhedron")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        // `len` and `sub`, the two vector helpers `createRibbonData`
        // declares beside itself. Lowered from their own bodies rather than
        // written here, because a square root and three subtractions are
        // exactly the kind of formula this port must not re-type.
        const ribbonFactory = this.lowerRibbonFactory(
            ribbon,
            ribbonModule,
            meshMathCalls,
            lowerPinnedMeshBuilder,
        );
        // The torus knot. It grows its `number[]`s like the four above and
        // finishes through the same `computeNormals`, but it is the first
        // builder whose local closure RETURNS a value: `getPos(angle)`
        // hands back the curve point as a `[number, number, number]`, and
        // the body binds two of them and reads their components. So the
        // closure is lowered into a function of its own -- the shape
        // `createRibbonData`'s `len` and `sub` already take -- and the
        // three builder locals it closes over travel as parameters.
        const torusKnotFactory = this.lowerTorusKnotFactory(
            torusKnot,
            torusKnotModule,
            meshMathCalls,
            lowerPinnedMeshBuilder,
        );
        const {
            assertVariable,
            numericConstructorArray,
            constructorArrayElements,
        } = this.createBuilderAssertions();

        assertVariable(
            morphFile,
            "MORPH_WEIGHTS_HEADER_BYTES",
            "16",
            "Morph weights header bytes",
        );
        assertVariable(
            morphFile,
            "MORPH_FLOATS_PER_VERTEX",
            "6",
            "Morph floats per vertex",
        );
        assertVariable(
            morphTargets,
            "targetCount",
            "targets.length",
            "Morph target count",
        );

        const boxDataFactory = this.lowerBoxFactory(
            boxFile,
            numericConstructorArray,
            box,
            lowerPinnedMeshBuilder,
        );

        const planeData = this.lowerPlaneData(
            assertVariable,
            plane,
            planeFile,
            constructorArrayElements,
        );

        const torusBuilderBody = this.lowerTorusBuilder(
            reachedTorus,
            torusModule,
            lowerPinnedMeshBuilder,
        );
        const modulePath = this.validateMeshFactory(instanceColors);
        const invalidation = features.includes(
            "mesh:render-bundle-invalidation",
        );

        // `bbl::js::` reaches this unit through the grown-array builders'
        // own `new F32(list)` rounding and through the heightmap pass's
        // value-selecting `||`. Read off what was emitted rather than off a
        // second copy of the predicates behind it: a builder that starts
        // converting a list arrives with its include, and one that stops
        // does not leave a dead one behind.
        const usesJsData =
            instanceColors ||
            [
                boxDataFactory,
                heightmapBody,
                discFactory,
                cylinderFactory,
                capsuleFactory,
                polyhedronFactory,
                ribbonFactory,
                torusKnotFactory,
                computeNormals,
            ].some((emitted) => emitted.includes("bbl::js::"));
        return {
            modulePath,
            symbolName: [
                "createBox,createGround,createPlane,createSphere",
                "createBoxData,createSphereData,createMorphTargets",
                "setMorphTargetWeights,createMeshFromData",
                ...(reachedTorus ? ["createTorus"] : []),
                ...(disc ? ["createDisc"] : []),
                ...(cylinder ? ["createCylinder"] : []),
                ...(capsule ? ["createCapsule"] : []),
                ...(polyhedron ? ["createPolyhedron"] : []),
                ...(ribbon ? ["createRibbon"] : []),
                ...(torusKnot ? ["createTorusKnot"] : []),
            ].join(","),
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                [
                    "createBox, createGround, createPlane, createSphere",
                    "createBoxData, createSphereData, createMorphTargets",
                    "setMorphTargetWeights, createMeshFromData",
                    ...(reachedTorus ? ["createTorus"] : []),
                    ...(disc ? ["createDisc"] : []),
                    ...(cylinder ? ["createCylinder"] : []),
                    ...(capsule ? ["createCapsule"] : []),
                    ...(polyhedron ? ["createPolyhedron"] : []),
                    ...(ribbon ? ["createRibbon"] : []),
                    ...(torusKnot ? ["createTorusKnot"] : []),
                ].join(", "),
                [
                    "src/mesh/create-box.ts, src/mesh/create-ground.ts",
                    "src/mesh/create-plane.ts, src/mesh/create-sphere.ts",
                    "src/morph/create-morph-targets.ts",
                    ...(reachedTorus ? [torusModule] : []),
                    ...(disc ? ["src/mesh/create-disc.ts"] : []),
                    ...(cylinder ? ["src/mesh/create-cylinder.ts"] : []),
                    ...(capsule ? ["src/mesh/create-capsule.ts"] : []),
                    ...(polyhedron ? ["src/mesh/create-polyhedron.ts"] : []),
                    ...(ribbon ? ["src/mesh/create-ribbon.ts"] : []),
                    ...(torusKnot ? ["src/mesh/create-torus-knot.ts"] : []),
                    // The shared accumulator, listed exactly when it is
                    // emitted -- read off the emission itself rather than
                    // off a second copy of the predicate behind it.
                    ...(computeNormals ? ["src/mesh/compute-normals.ts"] : []),
                ].join(", ") +
                    " defaults, and src/math/compute-aabb.ts bounds folding",
            )}
${usesJsData ? "#include <bblite/js_data.hpp>\n" : ""}\
#include <bblite/runtime.hpp>
#include <bblite/pal_mesh_attributes.hpp>
${features.includes("mesh:update-geometry") ? "#include <bblite/pal_mesh_geometry.hpp>\n" : ""}\
#include <bblite/mesh_vertex_packing.hpp>
${
    heightMapGround
        ? `\
#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
`
        : ""
}
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <span>
#include <set>
#include <stdexcept>
#include <utility>

namespace bbl {

${this.boxFactorySource(boxDataFactory)}${this.groundFactorySource(groundBuilderBody, heightMapGround, heightmapBody)}${this.planeAndSphereFactorySource(planeData, sphereBuilderBody)}${this.morphAndBuilderSource(morphBounds, reachedTorus, torusBuilderBody, computeNormals, discFactory, cylinderFactory, capsuleFactory, polyhedronFactory, ribbonFactory, torusKnotFactory, computeAabb)}${this.meshDataFactorySource(features.includes("mesh:update-attributes"))}${invalidation ? lowerRenderBundleInvalidation(this.context) : ""}${features.includes("mesh:resize-geometry") ? lowerMeshGeometryResize(this.context, invalidation) : ""}${features.includes("mesh:update-geometry") ? lowerMeshGeometryUpdates(this.context) : ""}} // namespace bbl
`,
        };
    }

    private createMeshBuilderLowerer(
        meshMathCalls: Map<string, (args: readonly string[]) => string>,
    ): MeshBuilderEmitter {
        const lowerPinnedMeshBuilder = (
            file: ts.SourceFile,
            declaration: ts.FunctionDeclaration,
            optionBindings: ReadonlyMap<string, string>,
            // A binding whose type is not the scalar every option is: a
            // jagged table the pin indexes, or a flag it branches on.
            optionTypes: ReadonlyMap<string, PinnedBinding["type"]> = new Map(),
            // A builder that declares a helper of its own beside the family
            // maths: `calls` spells it, and `fixedTupleCalls` states the
            // arity of a result the body binds whole and then indexes.
            // Per-builder rather than shared, so one builder's `getPos`
            // cannot answer for another builder's.
            extra: {
                statements?: readonly ts.Statement[];
                calls?: ReadonlyMap<
                    string,
                    (args: readonly string[]) => string
                >;
                fixedTupleCalls?: ReadonlyMap<string, number>;
                // A method the builder calls on a list it grew, plus
                // whether that method hands the list back so a store over
                // its own source is the mutation alone. `createCapsuleData`
                // is the one that needs it: it finishes with
                // `indices = indices.reverse()`.
                methods?: ReadonlyMap<
                    string,
                    (
                        receiver: string,
                        args: readonly string[],
                        binding: PinnedBinding,
                    ) => string
                >;
                receiverReturningMethods?: ReadonlySet<string>;
            } = {},
        ): string => {
            if (!declaration.body) {
                this.context.contractError(
                    declaration,
                    "Expected the pinned mesh builder to have a body.",
                );
            }
            const bindings = new Map<string, PinnedBinding>([
                ["Math.PI", { cpp: "pi_double", type: "scalar" }],
                ...Array.from(
                    optionBindings,
                    ([name, cpp]) =>
                        [
                            name,
                            {
                                cpp,
                                type: optionTypes.get(name) ?? "scalar",
                            },
                        ] as [string, PinnedBinding],
                ),
            ]);
            let lowerer: PinnedNumericLowerer;
            const returnValue = (
                expression: ts.Expression | undefined,
            ): string => {
                if (!expression || !ts.isObjectLiteralExpression(expression)) {
                    return this.context.contractError(
                        declaration,
                        "Expected the pinned mesh builder to return an object literal.",
                    );
                }
                const members = new Map<string, ts.Expression>();
                for (const property of expression.properties) {
                    if (
                        ts.isShorthandPropertyAssignment(property) &&
                        ts.isIdentifier(property.name)
                    ) {
                        members.set(property.name.text, property.name);
                    } else if (
                        ts.isPropertyAssignment(property) &&
                        ts.isIdentifier(property.name)
                    ) {
                        members.set(property.name.text, property.initializer);
                    } else {
                        this.context.contractError(
                            property,
                            "Expected named mesh-data return fields.",
                        );
                    }
                }
                const required = (name: string): ts.Expression => {
                    const value = members.get(name);
                    if (!value) {
                        return this.context.contractError(
                            expression,
                            `Expected mesh-data return field '${name}'.`,
                        );
                    }
                    return value;
                };
                const arrays = ["positions", "normals", "uvs", "indices"].map(
                    (name) => {
                        const value = lowerer.expression(required(name));
                        // Named buffers move vectors or copy fixed arrays through
                        // the typed overload; converted temporaries transfer directly.
                        return cppIdentifierPattern.test(value)
                            ? `mesh_data_buffer(${value})`
                            : value;
                    },
                );
                const localCount = (name: string): string | undefined =>
                    lowerer.portBinding(name, expression)?.cpp;
                const vertexCount = members.has("vertexCount")
                    ? lowerer.expression(required("vertexCount"))
                    : localCount("vertexCount");
                const indexCount = members.has("indexCount")
                    ? lowerer.expression(required("indexCount"))
                    : localCount("indexCount");
                if (!vertexCount || !indexCount) {
                    return this.context.contractError(
                        expression,
                        "Expected mesh-data vertexCount and indexCount locals.",
                    );
                }
                return (
                    `PinnedMeshData{${arrays.join(", ")}, ` +
                    `static_cast<std::uint32_t>(${vertexCount}), ` +
                    `static_cast<std::uint32_t>(${indexCount})}`
                );
            };
            lowerer = new PinnedNumericLowerer(file, {
                bindings,
                calls: new Map([
                    ...meshMathCalls,
                    ...(extra.calls ?? new Map()),
                ]),
                listCalls: new Set(["computeNormals"]),
                ...(extra.fixedTupleCalls
                    ? { fixedTupleCalls: extra.fixedTupleCalls }
                    : {}),
                ...(extra.methods ? { methods: extra.methods } : {}),
                ...(extra.receiverReturningMethods
                    ? {
                          receiverReturningMethods:
                              extra.receiverReturningMethods,
                      }
                    : {}),
                returnValue,
                maybeUnusedConst: true,
            });
            return (extra.statements ?? declaration.body.statements)
                .flatMap((statement) => lowerer.statement(statement, "    "))
                .join("\n");
        };
        return lowerPinnedMeshBuilder;
    }

    private createHeightmapLowerer(
        groundModule: "src/mesh/create-ground.ts",
        meshMathCalls: Map<string, (args: readonly string[]) => string>,
    ) {
        const lowerPinnedHeightmap = (): string => {
            const { file, declaration } = this.context.functionDeclaration(
                groundModule,
                "applyHeightmap",
            );
            if (!declaration.body) {
                this.context.contractError(
                    declaration,
                    "Expected the pinned heightmap pass to have a body.",
                );
            }
            const bindings = new Map<string, PinnedBinding>([
                ["ground.positions", { cpp: "data.positions", type: "f32" }],
                ["ground.normals", { cpp: "data.normals", type: "f32" }],
                ["ground.indices", { cpp: "data.indices", type: "u32" }],
                ["heightmapData", { cpp: "pixels", type: "u8-view" }],
                ["hmWidth", { cpp: "hm_width", type: "scalar" }],
                ["hmHeight", { cpp: "hm_height", type: "scalar" }],
                ["subdivisions", { cpp: "subdivisions", type: "scalar" }],
                ["minHeight", { cpp: "min_height", type: "scalar" }],
                ["maxHeight", { cpp: "max_height", type: "scalar" }],
            ]);

            return lowerPinnedBody(file, declaration.body.statements, {
                bindings,
                calls: meshMathCalls,
                methods: new Map([
                    [
                        "fill",
                        (receiver, args) =>
                            `std::fill(${receiver}.begin(), ` +
                            `${receiver}.end(), ` +
                            `static_cast<float>(${args[0]}))`,
                    ],
                ]),
                maybeUnusedConst: true,
            });
        };
        return lowerPinnedHeightmap;
    }

    private lowerDiscFactory(
        disc: boolean,
        lowerPinnedMeshBuilder: MeshBuilderEmitter,
        discModule: "src/mesh/create-disc.ts",
    ) {
        const discBuilderBody = !disc
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(discModule),
                  this.context.functionDeclaration(discModule, "createDiscData")
                      .declaration,
                  new Map([
                      ["options.radius", "options.radius"],
                      ["options.tessellation", "options.tessellation"],
                      ["options.arc", "options.arc"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
              );
        const discFactory = !disc
            ? ""
            : `static PinnedMeshData pinned_create_disc_data(
    DiscOptions options) {
${discBuilderBody}
}

MeshHandle create_disc(Engine& engine, DiscOptions options) {
    PinnedMeshData data = pinned_create_disc_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createDisc")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        return discFactory;
    }

    private lowerCylinderFactory(
        cylinder: boolean,
        lowerPinnedMeshBuilder: MeshBuilderEmitter,
        cylinderModule: "src/mesh/create-cylinder.ts",
    ) {
        const cylinderBuilderBody = !cylinder
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(cylinderModule),
                  this.context.functionDeclaration(
                      cylinderModule,
                      "createCylinderData",
                  ).declaration,
                  new Map([
                      ["options.height", "options.height"],
                      ["options.diameterTop", "options.diameter_top"],
                      // The cone-tip arm asks whether the SCENE named a
                      // zero top -- a different question from the clamped
                      // value the rings use, and one the record answers.
                      [
                          "options.diameterTop === 0",
                          "options.diameter_top_is_zero",
                      ],
                      ["options.diameterBottom", "options.diameter_bottom"],
                      ["options.tessellation", "options.tessellation"],
                      ["options.subdivisions", "options.subdivisions"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map([["options.diameterTop === 0", "bool"]]),
              );
        const cylinderFactory = !cylinder
            ? ""
            : `static PinnedMeshData pinned_create_cylinder_data(
    CylinderOptions options) {
${cylinderBuilderBody}
}

MeshHandle create_cylinder(Engine& engine, CylinderOptions options) {
    PinnedMeshData data = pinned_create_cylinder_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createCylinder")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        return cylinderFactory;
    }

    private lowerCapsuleFactory(
        capsule: boolean,
        lowerPinnedMeshBuilder: MeshBuilderEmitter,
        capsuleModule: "src/mesh/create-capsule.ts",
    ) {
        const capsuleBuilderBody = !capsule
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(capsuleModule),
                  this.context.functionDeclaration(
                      capsuleModule,
                      "createCapsuleData",
                  ).declaration,
                  new Map([
                      ["options.height", "options.height"],
                      ["options.radius", "options.radius"],
                      ["options.radiusTop", "options.radius_top"],
                      ["options.radiusBottom", "options.radius_bottom"],
                      ["options.tessellation", "options.tessellation"],
                      ["options.subdivisions", "options.subdivisions"],
                      ["options.capSubdivisions", "options.cap_subdivisions"],
                      [
                          "options.topCapSubdivisions",
                          "options.top_cap_subdivisions",
                      ],
                      [
                          "options.bottomCapSubdivisions",
                          "options.bottom_cap_subdivisions",
                      ],
                      ["vertexCount", "vertices.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map(),
                  {
                      // `indices = indices.reverse()`: the pin's own last
                      // statement. `Array.prototype.reverse` reverses in
                      // place and returns the same array, which is what
                      // `std::reverse` over the whole range is.
                      methods: new Map([
                          [
                              "reverse",
                              (receiver: string): string =>
                                  `std::reverse(${receiver}.begin(), ` +
                                  `${receiver}.end())`,
                          ],
                      ]),
                      receiverReturningMethods: new Set(["reverse"]),
                  },
              );
        const capsuleFactory = !capsule
            ? ""
            : `static PinnedMeshData pinned_create_capsule_data(
    CapsuleOptions options) {
${capsuleBuilderBody}
}

MeshHandle create_capsule(Engine& engine, CapsuleOptions options) {
    PinnedMeshData data = pinned_create_capsule_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createCapsule")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        return capsuleFactory;
    }

    private lowerNormals(
        polyhedron: boolean,
        ribbon: boolean,
        torusKnot: boolean,
        normalsModule: "src/mesh/compute-normals.ts",
        meshMathCalls: Map<string, (args: readonly string[]) => string>,
    ) {
        const computeNormals =
            !polyhedron && !ribbon && !torusKnot
                ? ""
                : (() => {
                      const { file, declaration } =
                          this.context.functionDeclaration(
                              normalsModule,
                              "computeNormals",
                          );
                      if (!declaration.body) {
                          this.context.contractError(
                              declaration,
                              "Expected computeNormals to have a body.",
                          );
                      }

                      const body = lowerPinnedBody(
                          file,
                          declaration.body.statements,
                          {
                              bindings: new Map<string, PinnedBinding>([
                                  [
                                      "Math.PI",
                                      { cpp: "pi_double", type: "scalar" },
                                  ],
                                  [
                                      "positions",
                                      { cpp: "positions", type: "f64-list" },
                                  ],
                                  [
                                      "indices",
                                      { cpp: "indices", type: "f64-list" },
                                  ],
                              ]),
                              calls: meshMathCalls,
                              returnValue: (expression, lowerer) =>
                                  expression
                                      ? lowerer.expression(expression)
                                      : this.context.contractError(
                                            declaration,
                                            "Expected computeNormals to return.",
                                        ),

                              maybeUnusedConst: true,
                          },
                      );
                      return `// ${this.context.provenance(
                          normalsModule,
                          "computeNormals",
                      )}
static std::vector<double> pinned_compute_normals(
    const std::vector<double>& positions,
    const std::vector<double>& indices) {
${body}
}

`;
                  })();
        return computeNormals;
    }

    private lowerRibbonFactory(
        ribbon: boolean,
        ribbonModule: "src/mesh/create-ribbon.ts",
        meshMathCalls: Map<string, (args: readonly string[]) => string>,
        lowerPinnedMeshBuilder: MeshBuilderEmitter,
    ) {
        const ribbonVectorHelpers = !ribbon
            ? ""
            : (() => {
                  const file = this.context.sourceFile(ribbonModule);
                  const lowerHelper = (
                      symbol: string,
                      parameters: readonly string[],
                      signature: string,
                      returns: (
                          expression: ts.Expression,
                          lowerer: PinnedNumericLowerer,
                      ) => string,
                  ): string => {
                      const { declaration } = this.context.functionDeclaration(
                          ribbonModule,
                          symbol,
                      );
                      if (!declaration.body) {
                          this.context.contractError(
                              declaration,
                              `Expected ${symbol} to have a body.`,
                          );
                      }

                      const body = lowerPinnedBody(
                          file,
                          declaration.body.statements,
                          {
                              bindings: new Map<string, PinnedBinding>(
                                  parameters.map((parameter) => [
                                      parameter,
                                      { cpp: parameter, type: "vec3" },
                                  ]),
                              ),
                              calls: meshMathCalls,
                              returnValue: (expression, lowerer) =>
                                  expression
                                      ? returns(expression, lowerer)
                                      : this.context.contractError(
                                            declaration,
                                            `${symbol} returns nothing.`,
                                        ),
                          },
                      );
                      return `${signature} {\n${body}\n}\n\n`;
                  };
                  return (
                      lowerHelper(
                          "len",
                          ["v"],
                          "static double pinned_ribbon_len(const Vec3d& v)",
                          (expression, lowerer) =>
                              lowerer.expression(expression),
                      ) +
                      lowerHelper(
                          "sub",
                          ["a", "b"],
                          "static Vec3d pinned_ribbon_sub(\n" +
                              "    const Vec3d& a,\n    const Vec3d& b)",
                          // The pin returns a `{x, y, z}` literal, and
                          // the record this port stores is that literal's
                          // three components in the pin's own order.
                          (expression, lowerer) =>
                              `Vec3d{${lowerObjectComponents(
                                  this.context,
                                  lowerer,
                                  expression,
                                  ["x", "y", "z"],
                              ).join(", ")}}`,
                      )
                  );
              })();
        const ribbonBuilderBody = !ribbon
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(ribbonModule),
                  this.context.functionDeclaration(
                      ribbonModule,
                      "createRibbonData",
                  ).declaration,
                  new Map([
                      // The record is taken by value and dead after this
                      // read, and the pin reads `pathArray` exactly once,
                      // so the rows MOVE rather than being deep-copied.
                      ["options.pathArray", "std::move(options.path_array)"],
                      // The two flags bind as the LOCALS the pin resolves
                      // them into, so its `options.closeArray || false`
                      // coercion is one generation already made -- which
                      // leaves the body's only other `||` the
                      // value-selecting one, lowered as such.
                      ["closeArray", "options.close_array"],
                      ["closePath", "options.close_path"],
                      // No reached ribbon names an offset, and the pin's
                      // own default for it is not a constant -- it is
                      // `floor(pathArray[0].length / 2)`, which the body
                      // computes one line above. Binding the read to that
                      // local is taking the absent arm exactly.
                      ["options.offset", "defaultOffset"],
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map([
                      ["options.pathArray", "vec3-list-2d"],
                      ["closeArray", "bool"],
                      ["closePath", "bool"],
                  ]),
              );
        const ribbonFactory = !ribbon
            ? ""
            : `${ribbonVectorHelpers}static PinnedMeshData pinned_create_ribbon_data(
    RibbonOptions options) {
${ribbonBuilderBody}
}

/**
 * The ribbon, under whichever pinned factory's name asked for it.
 *
 * \`createExtrudeShape\` finishes through \`createRibbonData\` too, under its
 * own mesh name -- so the triangulation lives here once and the name is the
 * caller's, which is exactly how the pin composes the two.
 */
MeshHandle create_ribbon_mesh(
    Engine& engine,
    RibbonOptions options,
    std::string_view name) {
    PinnedMeshData data = pinned_create_ribbon_data(std::move(options));
    return create_mesh_from_data(
        engine,
        std::string(name),
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}

MeshHandle create_ribbon(Engine& engine, RibbonOptions options) {
    return create_ribbon_mesh(
        engine,
        std::move(options),
        "${this.context.pinnedFactoryMeshName("createRibbon")}");
}
`;
        return ribbonFactory;
    }

    private lowerTorusKnotFactory(
        torusKnot: boolean,
        torusKnotModule: "src/mesh/create-torus-knot.ts",
        meshMathCalls: Map<string, (args: readonly string[]) => string>,
        lowerPinnedMeshBuilder: MeshBuilderEmitter,
    ) {
        const torusKnotHelper: {
            source: string;
            call: string;
            arity: number;
        } = !torusKnot
            ? { source: "", call: "", arity: 0 }
            : (() => {
                  const file = this.context.sourceFile(torusKnotModule);
                  const { declaration } = this.context.functionDeclaration(
                      torusKnotModule,
                      "createTorusKnotData",
                  );
                  const initializer = this.context.unwrapExpression(
                      this.context.variableInitializer(declaration, "getPos"),
                  );
                  if (
                      !ts.isArrowFunction(initializer) ||
                      !ts.isBlock(initializer.body)
                  ) {
                      return this.context.contractError(
                          initializer,
                          "Expected createTorusKnotData's getPos to be a " +
                              "block-bodied arrow function.",
                      );
                  }
                  // The arity comes from the pin's own return annotation,
                  // so a curve point that gains a component fails here
                  // rather than reading past a three-element array.
                  const annotation = initializer.type;
                  if (
                      !annotation ||
                      !ts.isTupleTypeNode(annotation) ||
                      annotation.elements.some(
                          (element) =>
                              element.kind !== ts.SyntaxKind.NumberKeyword,
                      )
                  ) {
                      return this.context.contractError(
                          annotation ?? initializer,
                          "Expected getPos to return a tuple of numbers.",
                      );
                  }
                  const arity = annotation.elements.length;
                  const parameters = initializer.parameters.map((parameter) => {
                      if (
                          !ts.isIdentifier(parameter.name) ||
                          parameter.type?.kind !== ts.SyntaxKind.NumberKeyword
                      ) {
                          return this.context.contractError(
                              parameter,
                              "Expected a numeric getPos parameter.",
                          );
                      }
                      return parameter.name.text;
                  });
                  const captured = freeIdentifiers(
                      initializer,
                      new Set(parameters),
                  );
                  // Which of the builder's own locals the closure reads,
                  // in the pin's declaration order. Derived rather than
                  // listed: a pin that starts reading `tube` in the curve
                  // grows a parameter here instead of compiling against a
                  // name this function does not have.
                  const options = pinnedMeshOptionLocals(
                      torusKnotModule,
                      "createTorusKnotData",
                  );
                  for (const name of captured) {
                      if (!options.includes(name)) {
                          this.context.contractError(
                              initializer,
                              `getPos closes over '${name}', which is not ` +
                                  "one of createTorusKnotData's options.",
                          );
                      }
                  }
                  // Every captured name is an option, asserted above, so
                  // this is the capture list in the pin's own option order.
                  const closes = options.filter((name) => captured.has(name));
                  const signature = [...parameters, ...closes].map(
                      (name) => `double ${name}`,
                  );
                  const bindings = new Map<string, PinnedBinding>([
                      ["Math.PI", { cpp: "pi_double", type: "scalar" }],
                      ...[...parameters, ...closes].map(
                          (name) =>
                              [name, { cpp: name, type: "scalar" }] as [
                                  string,
                                  PinnedBinding,
                              ],
                      ),
                  ]);

                  const body = lowerPinnedBody(
                      file,
                      initializer.body.statements,
                      {
                          bindings,
                          calls: meshMathCalls,
                          // The tuple return is the shared shape the
                          // splat lowerer's writers already take; only the
                          // `std::array` wrapper is this caller's.
                          returnValue: (expression, lowerer) =>
                              `std::array<double, ${arity}>{` +
                              `${lowerTupleComponents(
                                  this.context,
                                  lowerer,
                                  expression,
                                  { arity, at: initializer },
                              ).join(", ")}}`,

                          maybeUnusedConst: true,
                      },
                  );
                  return {
                      source: `// ${this.context.provenance(
                          torusKnotModule,
                          "createTorusKnotData#getPos",
                      )}
static std::array<double, ${arity}> pinned_torus_knot_pos(
    ${signature.join(",\n    ")}) {
${body}
}

`,
                      call: closes.join(", "),
                      arity,
                  };
              })();
        const torusKnotBuilderBody = !torusKnot
            ? ""
            : lowerPinnedMeshBuilder(
                  this.context.sourceFile(torusKnotModule),
                  this.context.functionDeclaration(
                      torusKnotModule,
                      "createTorusKnotData",
                  ).declaration,
                  new Map([
                      ["opts.radius", "options.radius"],
                      ["opts.tube", "options.tube"],
                      ["opts.radialSegments", "options.radial_segments"],
                      ["opts.tubularSegments", "options.tubular_segments"],
                      ["opts.p", "options.p"],
                      ["opts.q", "options.q"],
                      // The pin's own return names neither count, so both
                      // come from the grown arrays, as the disc's do.
                      ["vertexCount", "positions.size() / 3"],
                      ["indexCount", "indices.size()"],
                  ]),
                  new Map(),
                  {
                      calls: new Map([
                          [
                              "getPos",
                              (args: readonly string[]): string =>
                                  "pinned_torus_knot_pos(" +
                                  [...args, torusKnotHelper.call]
                                      .filter((part) => part.length > 0)
                                      .join(", ") +
                                  ")",
                          ],
                      ]),
                      fixedTupleCalls: new Map([
                          ["getPos", torusKnotHelper.arity],
                      ]),
                  },
              );
        const torusKnotFactory = !torusKnot
            ? ""
            : `${torusKnotHelper.source}static PinnedMeshData pinned_create_torus_knot_data(
    TorusKnotOptions options) {
${torusKnotBuilderBody}
}

MeshHandle create_torus_knot(Engine& engine, TorusKnotOptions options) {
    PinnedMeshData data = pinned_create_torus_knot_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createTorusKnot")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`;
        return torusKnotFactory;
    }

    private createBuilderAssertions(): MeshBuilderAssertions {
        const assertVariable = (
            root: ts.Node,
            name: string,
            expected: string,
            label: string,
        ): ts.Expression => {
            const expression = this.context.variableInitializer(root, name);
            this.context.assertExpressionShape(expression, expected, label);
            return expression;
        };
        const constructorArrayElements = (
            root: ts.Node,
            variableName: string,
            constructorName: string,
        ): {
            expression: ts.Expression;
            elements: readonly ts.Expression[];
        } => {
            const expression = this.context.variableInitializer(
                root,
                variableName,
            );
            const unwrapped = this.context.unwrapExpression(expression);
            if (
                !ts.isNewExpression(unwrapped) ||
                !ts.isIdentifier(unwrapped.expression) ||
                unwrapped.expression.text !== constructorName ||
                unwrapped.arguments?.length !== 1 ||
                !ts.isArrayLiteralExpression(unwrapped.arguments[0]!)
            ) {
                this.context.contractError(
                    expression,
                    `Expected ${variableName} to be a ${constructorName} array.`,
                );
            }
            return {
                expression,
                elements: unwrapped.arguments[0].elements,
            };
        };
        const numericConstructorArray = (
            file: ts.SourceFile,
            variableName: string,
            constructorName: string,
        ): {
            expression: ts.Expression;
            values: number[];
        } => {
            const { expression, elements } = constructorArrayElements(
                file,
                variableName,
                constructorName,
            );
            return {
                expression,
                values: elements.map((element) =>
                    this.context.numericValue(element, file),
                ),
            };
        };
        return {
            assertVariable,
            numericConstructorArray,
            constructorArrayElements,
        };
    }

    /**
     * The pinned createBoxData as the native create_box_data, the body every box
     * is built from. The compiler intrinsic resolves the number/object
     * option head before the call, so that head is the one specialized
     * part; the allocation, the sign expansion, the table copies and the
     * counts are the pin's own statements.
     */
    private lowerBoxFactory(
        boxFile: ts.SourceFile,
        numericConstructorArray: MeshBuilderAssertions["numericConstructorArray"],
        box: ts.FunctionDeclaration,
        lowerPinnedMeshBuilder: MeshBuilderEmitter,
    ): string {
        const boxSigns = this.context.unwrapExpression(
            this.context.variableInitializer(boxFile, "BOX_POSITION_SIGNS"),
        );
        if (!ts.isArrayLiteralExpression(boxSigns)) {
            this.context.contractError(
                boxSigns,
                "Expected BOX_POSITION_SIGNS to be an array literal.",
            );
        }
        const boxSignWords = boxSigns.elements.map((element) =>
            this.context.numericValue(element, boxFile),
        );
        const boxBindings = this.context.findNodes(
            box,
            (node): node is ts.BindingElement => ts.isBindingElement(node),
        );
        for (const [name, expected] of [
            ["size", "1"],
            ["width", "size"],
            ["height", "size"],
            ["depth", "size"],
        ] as const) {
            const binding = boxBindings.find(
                (candidate) =>
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === name,
            );
            if (!binding?.initializer) {
                this.context.contractError(
                    box,
                    `Expected box binding '${name}'.`,
                );
            }
            this.context.assertExpressionShape(
                binding.initializer,
                expected,
                `Box '${name}' default`,
            );
        }
        this.context.assertStatementInventory(
            box,
            box.body!.statements,
            "createBoxData",
            "only the option head is specialized",
            [
                "variable statement",
                "if statement",
                "variable statement",
                "for statement",
                "return statement",
            ],
        );
        const optionBranch = box.body!.statements[1]!;
        if (!ts.isIfStatement(optionBranch) || !optionBranch.elseStatement) {
            this.context.contractError(
                optionBranch,
                "Expected the box number/object option branches.",
            );
        }
        this.context.assertExpressionShape(
            box.parameters[0]!.initializer!,
            "1",
            "default box size",
        );
        this.context.assertExpressionShape(
            optionBranch.expression,
            'typeof options === "number"',
            "box option type",
        );
        this.context.expectShapeCount(
            optionBranch.thenStatement,
            "dimensions = [options, options, options]",
            "numeric box dimensions",
        );
        this.context.expectShapeCount(
            optionBranch.elseStatement,
            "dimensions = [width, height, depth]",
            "object box dimensions",
        );
        const copies = new Map<string, (args: readonly string[]) => string>();
        for (const [name, type, constructorName] of [
            ["BOX_NORMALS", "float", "F32"],
            ["BOX_UVS", "float", "F32"],
            ["BOX_INDICES", "std::uint32_t", "U32"],
        ] as const) {
            const { values } = numericConstructorArray(
                boxFile,
                name,
                constructorName,
            );
            copies.set(`${name}.slice`, (args) => {
                if (args.length)
                    this.context.contractError(
                        box,
                        "Box table copies must include every lane.",
                    );
                return `std::vector<${type}>{${values
                    .map((value) =>
                        type === "float"
                            ? this.context.floatLiteral(value)
                            : `${value}u`,
                    )
                    .join(", ")}}`;
            });
        }
        const body = lowerPinnedMeshBuilder(
            boxFile,
            box,
            new Map([
                ["dimensions", "dimensions"],
                ["BOX_POSITION_SIGNS", "signs"],
            ]),
            new Map([
                ["dimensions", "f64-buffer"],
                ["BOX_POSITION_SIGNS", "u32"],
            ]),
            { statements: box.body!.statements.slice(2), calls: copies },
        );
        return `MeshData create_box_data(double width, double height, double depth) {
    const std::array<double, 3> dimensions{width, height, depth};
    constexpr std::array<std::uint32_t, ${boxSignWords.length}> signs{${boxSignWords.map((value) => `${value}u`).join(", ")}};
${body}
}
`;
    }

    /**
     * The pinned createPlaneData's four arrays, each element the pin's own
     * expression: the half extents are its `width / 2` and `height / 2`,
     * every F32 element rounds once at its store, and the index list is
     * read verbatim. The size fallbacks ahead of them are the compiler
     * intrinsic's, which hands the resolved width and height to the native
     * options record.
     */
    private lowerPlaneData(
        assertVariable: MeshBuilderAssertions["assertVariable"],
        plane: ts.FunctionDeclaration,
        planeFile: ts.SourceFile,
        constructorArrayElements: MeshBuilderAssertions["constructorArrayElements"],
    ): {
        halfExtents: string;
        positions: string;
        normals: string;
        uvs: string;
        indices: string;
    } {
        for (const [name, expected] of [
            ["size", "options.size ?? 1"],
            ["width", "options.width ?? size"],
            ["height", "options.height ?? size"],
        ] as const) {
            assertVariable(plane, name, expected, `Plane '${name}'`);
        }
        const lowerer = new PinnedNumericLowerer(planeFile, {
            bindings: new Map<string, PinnedBinding>([
                ["width", { cpp: "width", type: "scalar" }],
                ["height", { cpp: "height", type: "scalar" }],
                ["hw", { cpp: "hw", type: "scalar" }],
                ["hh", { cpp: "hh", type: "scalar" }],
            ]),
            calls: new Map(),
        });
        const halfExtents = (["hw", "hh"] as const)
            .map(
                (name) =>
                    `    const double ${name} = ${lowerer.expression(
                        this.context.variableInitializer(plane, name),
                    )};`,
            )
            .join("\n");
        const f32 = (name: "positions" | "normals" | "uvs"): string =>
            `std::vector<float>{${constructorArrayElements(plane, name, "F32")
                .elements.map(
                    (element) =>
                        `static_cast<float>(${lowerer.expression(element)})`,
                )
                .join(", ")}}`;
        const indices = `std::vector<std::uint32_t>{${constructorArrayElements(
            plane,
            "indices",
            "U32",
        )
            .elements.map((element) => {
                const value = this.context.numericValue(element, planeFile);
                if (!Number.isInteger(value) || value < 0) {
                    this.context.contractError(
                        element,
                        "Expected a plane index to be a non-negative integer.",
                    );
                }
                return `${value}u`;
            })
            .join(", ")}}`;
        return {
            halfExtents,
            positions: f32("positions"),
            normals: f32("normals"),
            uvs: f32("uvs"),
            indices,
        };
    }

    private lowerTorusBuilder(
        reachedTorus: boolean,
        torusModule: "src/mesh/create-torus.ts",
        lowerPinnedMeshBuilder: MeshBuilderEmitter,
    ): string {
        if (!reachedTorus) return "";
        const { file: torusFile, declaration: torus } =
            this.context.functionDeclaration(torusModule, "createTorusData");
        return lowerPinnedMeshBuilder(
            torusFile,
            torus,
            new Map([
                ["opts.diameter", "options.diameter"],
                ["opts.thickness", "options.thickness"],
                ["opts.tessellation", "options.tessellation"],
            ]),
        );
    }

    private validateMeshFactory(instanceColors: boolean) {
        const modulePath = "src/mesh/mesh-factories.ts";
        const { declaration: meshFromData } = this.context.functionDeclaration(
            modulePath,
            "createMeshFromData",
        );
        // The record's `name` comes second, right after the engine — the
        // compiled intrinsic maps the scene's argument 1 onto it, and the
        // factory literals above are read from the same position.
        const nameParameter = meshFromData.parameters[1];
        if (
            !nameParameter ||
            !ts.isIdentifier(nameParameter.name) ||
            nameParameter.name.text !== "name"
        ) {
            this.context.contractError(
                meshFromData,
                "Expected createMeshFromData to take the mesh name second.",
            );
        }
        const aabbCall = this.context.findNodes(
            meshFromData,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "computeAabb",
        )[0];
        if (!aabbCall) {
            this.context.contractError(
                meshFromData,
                "Expected createMeshFromData to fold bounds through computeAabb.",
            );
        }
        this.context.functionDeclaration(
            "src/math/compute-aabb.ts",
            "computeAabb",
        );
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "setThinInstances",
        );
        if (instanceColors) {
            this.context.functionDeclaration(
                "src/mesh/thin-instance.ts",
                "setThinInstanceColors",
            );
        }
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "setThinInstanceCount",
        );
        this.context.functionDeclaration(
            "src/mesh/thin-instance.ts",
            "flushThinInstances",
        );
        return modulePath;
    }

    /**
     * The pinned createBox: createBoxData's arrays handed to
     * createMeshFromData under the pin's own mesh name, so the bounds are
     * computeAabb's fold over those positions.
     */
    private boxFactorySource(boxDataFactory: string): string {
        return `// The common return shape of the pinned typed-array builders. Their
// bodies below are translated from the pinned AST by PinnedNumericLowerer;
// this record is only the native carrier handed to create_mesh_from_data.
using PinnedMeshData = MeshData;

// A literal-sized pinned allocation lowers to std::array; a dynamic one
// lowers to std::vector. Both return the same owned mesh-data buffer.
template <typename T>
static std::vector<T> mesh_data_buffer(std::vector<T>& values) {
    return std::move(values);
}
template <typename T, std::size_t N>
static std::vector<T> mesh_data_buffer(const std::array<T, N>& values) {
    return {values.begin(), values.end()};
}

${boxDataFactory}
MeshHandle create_box(Engine& engine, BoxOptions options) {
    const MeshData data =
        create_box_data(options.width, options.height, options.depth);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createBox")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}

`;
    }

    private groundFactorySource(
        groundBuilderBody: string,
        heightMapGround: boolean,
        heightmapBody: string,
    ): string {
        return `static PinnedMeshData pinned_create_flat_ground_data(
    GroundOptions options) {
${groundBuilderBody}
}

MeshHandle create_ground(Engine& engine, GroundOptions options) {
    const PinnedMeshData data =
        pinned_create_flat_ground_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createGround")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}

${
    !heightMapGround
        ? ""
        : `// The pin's displacement pass, translated from its own body: it reads the
// image's luminance into the grid's Y and then rebuilds the normals. The
// image reaches it as RGBA8 because that is what the pin's own canvas
// readback hands it.
static void pinned_apply_heightmap(
    PinnedMeshData& data,
    const std::vector<std::uint8_t>& pixels,
    double hm_width,
    double hm_height,
    double subdivisions,
    double min_height,
    double max_height) {
${heightmapBody}
}

MeshHandle create_ground_from_height_map(
    Engine& engine,
    GroundOptions options,
    double min_height,
    double max_height,
    const char* height_map) {
    PinnedMeshData data =
        pinned_create_flat_ground_data(options);
    const pal::DecodedImage image = pal::decode_image(
        js::ArrayBuffer(
            pal::read_binary_file(asset_path(height_map))));
    pinned_apply_heightmap(
        data,
        image.rgba,
        static_cast<double>(image.width),
        static_cast<double>(image.height),
        static_cast<double>(options.subdivisions),
        min_height,
        max_height);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createGroundFromHeightMap")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`
}
`;
    }

    private planeAndSphereFactorySource(
        planeData: ReturnType<MeshBuilderLowerer["lowerPlaneData"]>,
        sphereBuilderBody: string,
    ): string {
        return `MeshHandle create_plane(Engine& engine, PlaneOptions options) {
    const double width = options.width;
    const double height = options.height;
${planeData.halfExtents}
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createPlane")}",
        ${planeData.positions},
        ${planeData.normals},
        ${planeData.indices},
        ${planeData.uvs},
        {},
        {},
        {});
}

static PinnedMeshData pinned_create_sphere_data(
    SphereOptions options) {
${sphereBuilderBody}
}

MeshData create_sphere_data(SphereOptions options) {
    return pinned_create_sphere_data(options);
}

MeshHandle create_sphere(Engine& engine, SphereOptions options) {
    const PinnedMeshData data = pinned_create_sphere_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createSphere")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}

`;
    }

    private morphAndBuilderSource(
        morphBounds: boolean,
        reachedTorus: boolean,
        torusBuilderBody: string,
        computeNormals: string,
        discFactory: string,
        cylinderFactory: string,
        capsuleFactory: string,
        polyhedronFactory: string,
        ribbonFactory: string,
        torusKnotFactory: string,
        computeAabb: string,
    ): string {
        return `void attach_morph_target(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    double vertex_count,
    float weight) {
    if (
        mesh.value >= engine.meshes.size() ||
        !std::isfinite(vertex_count) ||
        vertex_count < 0.0 ||
        std::floor(vertex_count) != vertex_count) {
        throw std::runtime_error(
            "Invalid direct morph target mesh or vertex count.");
    }
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    if (
        record.geometry == invalid_handle ||
        record.geometry >= engine.geometries.size()) {
        throw std::runtime_error(
            "Direct morph targets require mesh geometry.");
    }
    ModelGeometry& geometry =
        engine.geometries[record.geometry];
    const std::size_t count =
        static_cast<std::size_t>(vertex_count);
    if (
        count != geometry.vertices.size() ||
        positions.size() != count * 3 ||
        (!normals.empty() &&
         normals.size() != count * 3)) {
        throw std::runtime_error(
            "Direct morph target data does not match the mesh vertex count.");
    }
    std::vector<Vec3> position_deltas(
        count,
        Vec3{});
    // A missing normal stream leaves positive zero in the pin's F32 payload.
    std::vector<Vec3> normal_deltas(
        count,
        Vec3{});
    for (
        std::size_t index = 0;
        index < count;
        ++index) {
        // The deltas stay the pin's lanes: the GPU upload carries them
        // unchanged, as it does a loaded primitive's.
        position_deltas[index] = Vec3{
            positions[index * 3],
            positions[index * 3 + 1],
            positions[index * 3 + 2],
        };
        if (!normals.empty()) {
            normal_deltas[index] = Vec3{
                normals[index * 3],
                normals[index * 3 + 1],
                normals[index * 3 + 2],
            };
        }
    }
    geometry.morph_positions.clear();
    geometry.morph_positions.push_back(
        std::move(position_deltas));
${
    morphBounds
        ? `    // The shadow fit caches each target's own delta AABB beside these,
    // keyed on the list's length; a second call replaces the deltas
    // without changing that length, so the cache is dropped HERE, where
    // the thing it is derived from is replaced.
    geometry.morph_bounds.clear();
`
        : ""
}    geometry.morph_normals.clear();
    geometry.morph_normals.push_back(
        std::move(normal_deltas));
    geometry.morph_tangents.assign(
        1,
        std::vector<Vec3>(count, Vec3{}));
    record.gpu_deformation = true;
    record.scene_morph_targets = true;
    record.morph_weights = {};
    record.morph_weights[0] = weight;
    record.morph_storage_weights = {weight};
    ++record.morph_weights_version;
    ++record.transform_version;
}

void set_morph_target_weights(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<float>& weights) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error(
            "Invalid direct morph target mesh.");
    }
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    if (!record.gpu_deformation) {
        throw std::runtime_error(
            "Morph target weights require an attached morph target.");
    }
    const float weight =
        weights.empty() ? 0.0f : weights[0];
    record.morph_weights = {};
    record.morph_weights[0] = weight;
    record.morph_storage_weights = {weight};
    ++record.morph_weights_version;
}

${
    reachedTorus
        ? `static PinnedMeshData pinned_create_torus_data(
    TorusOptions options) {
${torusBuilderBody}
}

MeshHandle create_torus(Engine& engine, TorusOptions options) {
    const PinnedMeshData data = pinned_create_torus_data(options);
    return create_mesh_from_data(
        engine,
        "${this.context.pinnedFactoryMeshName("createTorus")}",
        data.positions,
        data.normals,
        data.indices,
        data.uvs,
        {},
        {},
        {});
}
`
        : ""
}
${computeNormals}${discFactory}${cylinderFactory}${capsuleFactory}${polyhedronFactory}${ribbonFactory}${torusKnotFactory}
namespace {

${computeAabb}

} // namespace

`;
    }

    private meshDataFactorySource(updateAttributes: boolean): string {
        return `${lowerMeshAttributeCapacities(this.context)}
static std::uint32_t upload_mesh_geometry_data(
    Engine& engine,
    const std::vector<float>& positions,
    const std::vector<float>& normals,
    const std::vector<std::uint32_t>& indices,
    const std::vector<float>& uvs,
    const std::vector<float>& uvs2,
    const std::vector<float>& tangents,
    const std::vector<float>& colors) {
    const std::size_t vertex_count = positions.size() / 3;
    ModelGeometry geometry;
    geometry.owned_packed_geometry = true;
    geometry.attribute_capacities = uploaded_mesh_attribute_capacities(
        static_cast<double>(positions.size()), static_cast<double>(normals.size()),
        static_cast<double>(uvs.size()), static_cast<double>(uvs2.size()),
        static_cast<double>(tangents.size()), static_cast<double>(colors.size()));
    geometry.vertices = pal::pack_mesh_vertices(positions, normals, uvs, uvs2, tangents, colors);
    geometry.indices = indices;
    geometry.has_tangents = !tangents.empty();
    geometry.cpu_uv2s = !uvs2.empty();
    geometry.cpu_tangents = !tangents.empty();
    geometry.cpu_colors = !colors.empty();
    // The optional streams the call left out, as the node family's
    // writeAttributeFlags reads them: an omitted one is an absent
    // attribute, not a zero-filled one.
    geometry.has_uvs = !uvs.empty();
    geometry.has_vertex_colors = !colors.empty();
    // computeAabb over the positions the call handed in, whole triples
    // only; empty input keeps the record's default bounds (the pinned
    // helper returns infinities that createMeshFromData filters through
    // isFinite). The fold is the pin's double fold; the one float rounding
    // is the record's own store.
    if (vertex_count > 0) {
        const std::array<std::array<double, 3>, 2> aabb = compute_aabb(
            std::span<const float>{positions.data(), vertex_count * 3});
        geometry.bounds_min = Vec3{
            static_cast<float>(aabb[0][0]),
            static_cast<float>(aabb[0][1]),
            static_cast<float>(aabb[0][2])};
        geometry.bounds_max = Vec3{
            static_cast<float>(aabb[1][0]),
            static_cast<float>(aabb[1][1]),
            static_cast<float>(aabb[1][2])};
    }
    return store_geometry_record(engine, std::move(geometry));
}
MeshHandle create_mesh_from_data(Engine& engine, const std::string& name,
    const std::vector<float>& positions, const std::vector<float>& normals,
    const std::vector<std::uint32_t>& indices, const std::vector<float>& uvs,
    const std::vector<float>& uvs2, const std::vector<float>& tangents,
    const std::vector<float>& colors) {
    MeshRecord mesh;
    mesh.name = name;
    mesh.geometry = upload_mesh_geometry_data(engine,positions,normals,indices,uvs,uvs2,tangents,colors);
    // \`boundMin: isFinite(min[0]) ? min : undefined\`: the fold
    // upload_mesh_geometry_data stored its box from.
    mesh.has_bounds = positions.size() >= 3;
    return store_mesh_record(engine, std::move(mesh));
}

${updateAttributes ? lowerMeshAttributeUpdates(this.context) : ""}
${lowerMeshCpuStreamRetainers(this.context)}

`;
    }
}
