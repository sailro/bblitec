/**
 * The display-gizmo family: `createUtilityLayer` and the camera and light
 * gizmos built on top of it.
 *
 * Two halves, split the way this repository already splits a ported
 * builder. The SHAPE -- which nodes exist, what each is parented to, which
 * factory made it -- is the contract, so it is read out of the pinned
 * declarations and emitted as the same tree of native factory calls. The
 * per-frame FOLLOW is behaviour over live state (the attached camera's
 * world matrix, the attached light's position and direction, the utility
 * scene's own camera for distance scaling), so it is emitted as a native
 * before-render callback over the same records.
 *
 * The three module constants and every mesh factory's option object, in
 * the order the pinned body creates them, are READ from the pinned source
 * rather than restated here. A pin that renames one of those constants,
 * reorders a body's factory calls or changes one of their option objects
 * fails generation by name instead of silently drawing a different widget.
 *
 * Three pinned BODIES are not read that way and are transcribed into the
 * emitted C++ below: `buildHemisphereMesh` and `lineDefsForLevel` from
 * `src/gizmo/light-gizmo.ts`, and `buildFrustumWireframe`/`buildFrustumEdge`
 * from `src/gizmo/camera-gizmo.ts`, along with the placement literals their
 * callers pass. Every construct in them is one `lowerPinnedFunction`
 * already handles -- `for`, `if`, `Math.*`, and `push` onto a grown list --
 * so this is a gap rather than a limit, and it is the one place where an
 * upstream edit to a gizmo's geometry would compile clean and draw a
 * different widget. [TODO](../../TODO.md)'s gizmo entry carries it.
 *
 * What is deliberately NOT re-derived: the quaternion helpers. Those are
 * lowered from `src/gizmo/gizmo-math.ts` through the shared pinned-function
 * translator, so the arithmetic that orients every gizmo node is the pin's
 * own body rather than a second copy of it.
 */
import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import {
    PINNED_DECOMPOSE_ROTATION,
    lowerMat4DecomposeRotation,
} from "./pinned-mat4-decompose.js";

const UTILITY_MODULE = "src/gizmo/utility-layer.ts";
const MATH_MODULE = "src/gizmo/gizmo-math.ts";
const CORE_MODULE = "src/gizmo/gizmo-core.ts";
const CAMERA_MODULE = "src/gizmo/camera-gizmo.ts";
const LIGHT_MODULE = "src/gizmo/light-gizmo.ts";

/** One pinned mesh-factory call, as the emitted tree needs to see it. */
interface PinnedFactoryCall {
    /** `createCylinder`, `createSphere`, `createBox`. */
    callee: string;
    /**
     * The option object's members, by the pin's own names. A member the
     * pin spells as a constant carries its value; one it computes from a
     * parameter (the frustum edge's thickness) carries undefined, and its
     * value comes from the module constant the caller reads instead.
     */
    options: ReadonlyMap<string, number | undefined>;
    /** A bare numeric second argument, where the factory takes one. */
    scalar?: number;
}

export class GizmoLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * Every mesh-factory call inside one pinned declaration, in source
     * order.
     *
     * Order is the contract: the emitted tree creates its nodes in the
     * same sequence, so a pin that inserts, removes or reorders a factory
     * call moves the list and the caller's own arity check fails.
     */
    private factoryCalls(
        file: ts.SourceFile,
        declaration: ts.Node,
        callees: readonly string[],
    ): PinnedFactoryCall[] {
        const calls: PinnedFactoryCall[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                callees.includes(node.expression.text)
            ) {
                const argument = node.arguments[1];
                const options = new Map<string, number | undefined>();
                let scalar: number | undefined;
                if (argument && ts.isObjectLiteralExpression(argument)) {
                    for (const property of argument.properties) {
                        const name = ts.isPropertyAssignment(property)
                            ? this.context.propertyName(property.name)
                            : undefined;
                        if (!ts.isPropertyAssignment(property) || !name) {
                            this.context.contractError(
                                property,
                                "Expected a pinned mesh factory option to " +
                                    "be a plain named property assignment.",
                            );
                        }
                        const initializer =
                            this.context.unwrapExpression(
                                property.initializer,
                            );
                        const constant =
                            ts.isNumericLiteral(initializer) ||
                            ts.isPrefixUnaryExpression(initializer)
                                ? this.context.numericValue(
                                      initializer,
                                      file,
                                  )
                                : undefined;
                        options.set(name, constant);
                    }
                } else if (argument) {
                    scalar = this.context.numericValue(argument, file);
                }
                calls.push(
                    scalar === undefined
                        ? {
                              callee: node.expression.text,
                              options,
                          }
                        : {
                              callee: node.expression.text,
                              options,
                              scalar,
                          },
                );
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        return calls;
    }

    /**
     * One factory call's constant option, or a named failure.
     *
     * `fallback` is for the one member the pin computes rather than
     * spells -- the frustum edge's thickness, which is its own module
     * constant -- and the member still has to be DECLARED, so a pin that
     * drops it fails here rather than silently taking the fallback.
     */
    private option(
        call: PinnedFactoryCall,
        name: string,
        at: ts.Node,
        fallback?: number,
    ): number {
        if (!call.options.has(name)) {
            return this.context.contractError(
                at,
                `Expected pinned ${call.callee} to declare '${name}'.`,
            );
        }
        const value = call.options.get(name) ?? fallback;
        if (value === undefined) {
            return this.context.contractError(
                at,
                `Expected pinned ${call.callee} '${name}' to be a constant.`,
            );
        }
        return value;
    }

    /** A module-scope numeric constant, read where the pin declares it. */
    private constant(modulePath: string, name: string): number {
        const file = this.context.sourceFile(modulePath);
        const initializer = this.context.moduleScopeConstant(file, name);
        if (!initializer) {
            return this.context.contractError(
                file,
                `Expected ${modulePath} to declare the constant ` +
                    `'${name}'.`,
            );
        }
        return this.context.numericValue(initializer, file);
    }

    /** The pin's own quaternion helpers, as C++. */
    private mathHelpers(): string {
        const calls = new Map([
            ...pinnedNumericMathCalls(),
            [
                "quatFromBjsEuler",
                (args: readonly string[]): string =>
                    `quat_from_bjs_euler(${args.join(", ")})`,
            ],
        ]);
        const quatFromBjsEuler = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "quatFromBjsEuler",
            [
                { pinned: "rx", kind: "number", cpp: "rx" },
                { pinned: "ry", kind: "number", cpp: "ry" },
                { pinned: "rz", kind: "number", cpp: "rz" },
            ],
            {
                cppName: "quat_from_bjs_euler",
                calls,
                returns: {
                    type: "std::array<double, 4>",
                    value: (lowerer, expression) =>
                        `std::array<double, 4>{${lowerTupleComponents(
                            this.context,
                            lowerer,
                            expression,
                            {
                                arity: 4,
                                at: this.context.functionDeclaration(
                                    MATH_MODULE,
                                    "quatFromBjsEuler",
                                ).declaration,
                            },
                        ).join(", ")}}`,
                },
            },
        );
        const rotateVec3ByQuat = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "rotateVec3ByQuat",
            [
                { pinned: "qx", kind: "number", cpp: "qx" },
                { pinned: "qy", kind: "number", cpp: "qy" },
                { pinned: "qz", kind: "number", cpp: "qz" },
                { pinned: "qw", kind: "number", cpp: "qw" },
                { pinned: "vx", kind: "number", cpp: "vx" },
                { pinned: "vy", kind: "number", cpp: "vy" },
                { pinned: "vz", kind: "number", cpp: "vz" },
            ],
            {
                cppName: "rotate_vec3_by_quat",
                calls,
                returns: {
                    type: "std::array<double, 3>",
                    value: (lowerer, expression) =>
                        `std::array<double, 3>{${lowerTupleComponents(
                            this.context,
                            lowerer,
                            expression,
                            {
                                arity: 3,
                                at: this.context.functionDeclaration(
                                    MATH_MODULE,
                                    "rotateVec3ByQuat",
                                ).declaration,
                            },
                        ).join(", ")}}`,
                },
            },
        );
        // `directionToQuat` reads its parameter's three members and ends
        // in a call to the helper above, so it binds the members by the
        // text the pinned body spells them with.
        const directionToQuat = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "directionToQuat",
            [
                {
                    pinned: "dir",
                    kind: "record",
                    cpp: "dir",
                    cppType: "Vec3",
                    annotation: "Vec3",
                },
            ],
            {
                cppName: "direction_to_quat",
                calls,
                memberBindings: new Map([
                    ["dir.x", { cpp: "dir.x", type: "scalar" as const }],
                    ["dir.y", { cpp: "dir.y", type: "scalar" as const }],
                    ["dir.z", { cpp: "dir.z", type: "scalar" as const }],
                    // The pin's own constant, at the width its body reads
                    // it: a JavaScript number, so a double here.
                    ["Math.PI", { cpp: "pi_double", type: "scalar" as const }],
                ]),
                returns: {
                    type: "std::array<double, 4>",
                    value: (lowerer, expression) =>
                        expression
                            ? lowerer.expression(expression)
                            : this.context.contractError(
                                  this.context.functionDeclaration(
                                      MATH_MODULE,
                                      "directionToQuat",
                                  ).declaration,
                                  "Expected pinned directionToQuat to " +
                                      "return a value.",
                              ),
                },
            },
        );
        // `rotationQuatFromMatrix` is the pin's own one-liner over
        // `mat4Decompose`. Asserted rather than re-typed: what the emitted
        // follow calls is the decomposition this repository already lowers.
        const rotationQuat = this.context.functionDeclaration(
            MATH_MODULE,
            "rotationQuatFromMatrix",
        );
        this.context.callExpression(
            rotationQuat.declaration,
            "mat4Decompose",
        );
        if (
            !this.context.hasNode(
                rotationQuat.declaration,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "rotation",
            )
        ) {
            this.context.contractError(
                rotationQuat.declaration,
                "Expected pinned rotationQuatFromMatrix to take " +
                    "mat4Decompose(m).rotation.",
            );
        }
        return [
            quatFromBjsEuler,
            rotateVec3ByQuat,
            directionToQuat,
            lowerMat4DecomposeRotation(this.context),
        ].join("\n\n");
    }

    public lower(): LoweredSource {
        // Anchored: the pinned surface this family is generated from.
        // `createGizmoMaterials` is NOT anchored -- it belongs to the four
        // editing gizmos, which this port does not reach, so requiring it
        // would assert nothing about what is generated here.
        // `attachFollowTarget` is anchored by NAME only: the native follow
        // reads live records rather than lowering that body, so a pin that
        // changed how the follow places its root would still generate.
        for (const [modulePath, symbols] of [
            [
                UTILITY_MODULE,
                ["createUtilityLayer", "registerUtilityLayer"],
            ],
            [CORE_MODULE, ["attachFollowTarget"]],
            [
                CAMERA_MODULE,
                ["createCameraGizmo", "attachCameraGizmoToCamera"],
            ],
            [
                LIGHT_MODULE,
                ["createLightGizmo", "attachLightGizmoToLight"],
            ],
        ] as const) {
            for (const symbol of symbols) {
                this.context.functionDeclaration(modulePath, symbol);
            }
        }
        const utilityFile = this.context.sourceFile(UTILITY_MODULE);
        const utility = this.context.functionDeclaration(
            UTILITY_MODULE,
            "createUtilityLayer",
        );
        // The pin's own default light: a hemispheric light pointing up,
        // whose intensity and ground colour are the two literals the
        // factory writes.
        const utilityLight = this.context.callExpression(
            utility.declaration,
            "createHemisphericLight",
        );
        const utilityDirection = this.context
            .numericTuple(utilityLight.arguments[0]!, utilityFile)
            .map((component) => this.context.floatLiteral(component))
            .join(", ");
        // `light.intensity = options?.lightIntensity ?? 2` -- the pin's own
        // default, read from the coalesce rather than restated.
        let utilityIntensity: number | undefined;
        this.context.hasNode(utility.declaration, (node) => {
            if (!ts.isExpression(node)) return false;
            const coalesce = this.context.nullishDefault(node);
            if (coalesce && utilityIntensity === undefined) {
                utilityIntensity = this.context.numericValue(
                    coalesce.right,
                    utilityFile,
                );
            }
            return false;
        });
        if (utilityIntensity === undefined) {
            this.context.contractError(
                utility.declaration,
                "Expected createUtilityLayer to default its light " +
                    "intensity through a nullish coalesce.",
            );
        }
        const cameraFile = this.context.sourceFile(CAMERA_MODULE);
        const lightFile = this.context.sourceFile(LIGHT_MODULE);
        const bodyScale = this.constant(
            CAMERA_MODULE,
            "CAMERA_BODY_SCALE",
        );
        const edgeThickness = this.constant(
            CAMERA_MODULE,
            "FRUSTUM_EDGE_THICKNESS",
        );
        const lightScale = this.constant(LIGHT_MODULE, "LIGHT_GIZMO_SCALE");
        const bodyCalls = this.factoryCalls(
            cameraFile,
            this.context.functionDeclaration(
                CAMERA_MODULE,
                "buildCameraBodyMesh",
            ).declaration,
            ["createBox", "createCylinder"],
        );
        if (
            bodyCalls.length !== 4 ||
            bodyCalls[0]!.callee !== "createBox" ||
            bodyCalls.slice(1).some((call) => call.callee !== "createCylinder")
        ) {
            this.context.contractError(
                this.context.functionDeclaration(
                    CAMERA_MODULE,
                    "buildCameraBodyMesh",
                ).declaration,
                "Expected the pinned camera body to be one box and three " +
                    "cylinders, in that order.",
            );
        }
        const edgeCall = this.factoryCalls(
            cameraFile,
            this.context.functionDeclaration(
                CAMERA_MODULE,
                "buildFrustumEdge",
            ).declaration,
            ["createCylinder"],
        )[0]!;
        const lineCall = this.factoryCalls(
            lightFile,
            this.context.functionDeclaration(
                LIGHT_MODULE,
                "buildLightLines",
            ).declaration,
            ["createCylinder"],
        )[0]!;
        const typeCalls = this.factoryCalls(
            lightFile,
            this.context.functionDeclaration(
                LIGHT_MODULE,
                "buildLightTypeMesh",
            ).declaration,
            ["createSphere", "createCylinder"],
        );
        // directional: sphere, shaft, head. point/hemi/spot: one sphere
        // each for point and spot (the hemispheres come from the pin's own
        // mesh builder, which has no factory call).
        if (typeCalls.length !== 5) {
            this.context.contractError(
                this.context.functionDeclaration(
                    LIGHT_MODULE,
                    "buildLightTypeMesh",
                ).declaration,
                "Expected the pinned per-type light geometry to make five " +
                    "factory meshes (directional sphere, shaft, head; the " +
                    "point and spot spheres).",
            );
        }
        const [dirSphere, shaft, head, pointSphere, spotSphere] = typeCalls as [
            PinnedFactoryCall,
            PinnedFactoryCall,
            PinnedFactoryCall,
            PinnedFactoryCall,
            PinnedFactoryCall,
        ];
        const cylinder = (
            call: PinnedFactoryCall,
            at: ts.Node,
            diameterFallback?: number,
        ): string => {
            const top = this.option(
                call,
                "diameterTop",
                at,
                diameterFallback,
            );
            const bottom = this.option(
                call,
                "diameterBottom",
                at,
                diameterFallback,
            );
            return (
                `CylinderOptions{` +
                `${this.context.doubleLiteral(
                    this.option(call, "height", at),
                )}, ` +
                `${this.context.doubleLiteral(top)}, ` +
                `${this.context.doubleLiteral(bottom)}, ` +
                `${this.context.doubleLiteral(
                    this.option(call, "tessellation", at),
                )}, ` +
                `1.0, ` +
                `${top === 0 ? "true" : "false"}}`
            );
        };
        const sphere = (call: PinnedFactoryCall, at: ts.Node): string => {
            const diameter = this.option(call, "diameter", at);
            return (
                `SphereOptions{` +
                `${this.option(call, "segments", at)}u, ` +
                `${this.context.doubleLiteral(diameter)}, ` +
                `${this.context.doubleLiteral(diameter)}, ` +
                `${this.context.doubleLiteral(diameter)}}`
            );
        };
        const cameraDeclaration = this.context.functionDeclaration(
            CAMERA_MODULE,
            "buildCameraBodyMesh",
        ).declaration;
        const lightDeclaration = this.context.functionDeclaration(
            LIGHT_MODULE,
            "buildLightTypeMesh",
        ).declaration;
        return {
            modulePath: CAMERA_MODULE,
            symbolName: "createCameraGizmo",
            header: "",
            source: `// ${this.context.provenance(
                UTILITY_MODULE,
                "createUtilityLayer",
                `${CAMERA_MODULE}#createCameraGizmo and ` +
                    `${LIGHT_MODULE}#createLightGizmo`,
            )}
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <stdexcept>

namespace bbl {

namespace {

${this.mathHelpers()}

UtilityLayerRecord& layer_record(
    Engine& engine,
    UtilityLayerHandle layer) {
    if (layer.value >= engine.utility_layers.size()) {
        throw std::runtime_error("Invalid utility layer handle.");
    }
    return *engine.utility_layers[layer.value];
}

/** One gizmo mesh: the shared material, unpickable, added to the layer. */
MeshHandle gizmo_mesh(
    Engine& engine,
    Scene& scene,
    MeshHandle mesh,
    MaterialHandle material) {
    engine.meshes[mesh.value].material = material;
    engine.meshes[mesh.value].pickable = false;
    add_to_scene(scene, mesh);
    return mesh;
}

void place_mesh(
    Engine& engine,
    MeshHandle mesh,
    Vec3d position,
    Vec3 scaling,
    const std::array<double, 4>& rotation,
    TransformNodeHandle parent) {
    MeshRecord& record = engine.meshes[mesh.value];
    record.position = position;
    record.scaling = scaling;
    // Through the setter rather than the field: a quaternion write also
    // selects the quaternion lane over the record's Euler one, which is
    // what the world composition reads.
    set_mesh_rotation_quaternion(
        engine,
        mesh,
        Vec4{
            static_cast<float>(rotation[0]),
            static_cast<float>(rotation[1]),
            static_cast<float>(rotation[2]),
            static_cast<float>(rotation[3])},
        false);
    set_mesh_transform_parent(engine, mesh, parent);
    mark_mesh_dirty(engine, mesh);
}

/**
 * The pin's own hemisphere (light-gizmo.ts buildHemisphereMesh): a half
 * UV sphere from the apex down to the equator plus a disc cap.
 */
MeshHandle build_hemisphere_mesh(
    Engine& engine,
    double segments,
    double diameter) {
    const double r = diameter / 2.0;
    const double rings = std::max(3.0, segments);
    const double radial = rings * 2.0;
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<float> uvs;
    std::vector<std::uint32_t> indices;
    for (double i = 0.0; i <= rings; i += 1.0) {
        const double az = (i / rings) * (pi_double / 2.0);
        const double sinz = std::sin(az);
        const double cosz = std::cos(az);
        for (double j = 0.0; j <= radial; j += 1.0) {
            const double ay = (j / radial) * pi_double * 2.0;
            const double nx = sinz * std::cos(ay);
            const double ny = cosz;
            const double nz = -sinz * std::sin(ay);
            positions.push_back(static_cast<float>(r * nx));
            positions.push_back(static_cast<float>(r * ny));
            positions.push_back(static_cast<float>(r * nz));
            normals.push_back(static_cast<float>(nx));
            normals.push_back(static_cast<float>(ny));
            normals.push_back(static_cast<float>(nz));
            uvs.push_back(static_cast<float>(j / radial));
            uvs.push_back(static_cast<float>(i / rings));
        }
    }
    const std::uint32_t stride = static_cast<std::uint32_t>(radial) + 1u;
    for (std::uint32_t i = 0; i < static_cast<std::uint32_t>(rings); ++i) {
        for (
            std::uint32_t j = 0;
            j < static_cast<std::uint32_t>(radial);
            ++j) {
            const std::uint32_t a = i * stride + j;
            const std::uint32_t b = a + stride;
            indices.push_back(a);
            indices.push_back(a + 1u);
            indices.push_back(b);
            indices.push_back(b);
            indices.push_back(a + 1u);
            indices.push_back(b + 1u);
        }
    }
    const std::uint32_t center_index =
        static_cast<std::uint32_t>(positions.size() / 3u);
    positions.push_back(0.0f);
    positions.push_back(0.0f);
    positions.push_back(0.0f);
    normals.push_back(0.0f);
    normals.push_back(-1.0f);
    normals.push_back(0.0f);
    uvs.push_back(0.5f);
    uvs.push_back(0.5f);
    const std::uint32_t cap_start =
        static_cast<std::uint32_t>(positions.size() / 3u);
    for (double j = 0.0; j <= radial; j += 1.0) {
        const double ay = (j / radial) * pi_double * 2.0;
        positions.push_back(static_cast<float>(r * std::cos(ay)));
        positions.push_back(0.0f);
        positions.push_back(static_cast<float>(-r * std::sin(ay)));
        normals.push_back(0.0f);
        normals.push_back(-1.0f);
        normals.push_back(0.0f);
        uvs.push_back(static_cast<float>(j / radial));
        uvs.push_back(0.0f);
    }
    for (std::uint32_t j = 0; j < static_cast<std::uint32_t>(radial); ++j) {
        indices.push_back(center_index);
        indices.push_back(cap_start + j + 1u);
        indices.push_back(cap_start + j);
    }
    return create_mesh_from_data(
        engine,
        "hemisphere",
        positions,
        normals,
        indices,
        uvs,
        {},
        {},
        {});
}

/** The pin's own _CreateLightLines table (light-gizmo.ts). */
struct GizmoLineDef {
    double pivot_y;
    double pivot_z;
    double pos_y;
    double sx;
    double sy;
    double sz;
};

std::vector<GizmoLineDef> line_defs_for_level(double levels) {
    const double dist_from_sphere = 1.2;
    const double full_pos_y = 1.0 * 0.5 + dist_from_sphere;
    const double half_pos_y = 0.5 * 0.5 + dist_from_sphere;
    std::vector<GizmoLineDef> defs;
    defs.push_back(GizmoLineDef{0.0, 0.0, full_pos_y, 1.0, 1.0, 1.0});
    for (double i = 0.0; i < 4.0; i += 1.0) {
        defs.push_back(GizmoLineDef{
            pi_double / 2.0 + (pi_double / 2.0) * i,
            pi_double / 4.0,
            half_pos_y,
            0.8,
            0.5,
            0.8});
    }
    if (levels < 3.0) return defs;
    for (double i = 0.0; i < 4.0; i += 1.0) {
        defs.push_back(GizmoLineDef{
            (pi_double / 2.0) * i,
            pi_double / 2.0,
            full_pos_y,
            1.0,
            1.0,
            1.0});
    }
    if (levels < 4.0) return defs;
    for (double i = 0.0; i < 4.0; i += 1.0) {
        defs.push_back(GizmoLineDef{
            pi_double / 2.0 + (pi_double / 2.0) * i,
            pi_double + pi_double / 4.0,
            half_pos_y,
            0.8,
            0.5,
            0.8});
    }
    if (levels < 5.0) return defs;
    defs.push_back(GizmoLineDef{0.0, pi_double, full_pos_y, 1.0, 1.0, 1.0});
    return defs;
}

void build_light_lines(
    Engine& engine,
    Scene& scene,
    MaterialHandle material,
    TransformNodeHandle parent,
    double levels) {
    const std::array<double, 4> root_q =
        quat_from_bjs_euler(pi_double / 2.0, 0.0, 0.0);
    const TransformNodeHandle lines_root = create_transform_node(
        engine,
        "lightLinesRoot",
        Vec3d{0.0, 0.0, 0.0},
        Vec4{
            static_cast<float>(root_q[0]),
            static_cast<float>(root_q[1]),
            static_cast<float>(root_q[2]),
            static_cast<float>(root_q[3])},
        Vec3{1.0f, 1.0f, 1.0f});
    set_transform_node_parent(engine, lines_root, parent);
    for (const GizmoLineDef& def : line_defs_for_level(levels)) {
        const std::array<double, 4> q =
            quat_from_bjs_euler(0.0, def.pivot_y, def.pivot_z);
        const std::array<double, 3> p = rotate_vec3_by_quat(
            q[0],
            q[1],
            q[2],
            q[3],
            0.0,
            def.pos_y,
            0.0);
        const MeshHandle line = create_cylinder(
            engine,
            ${cylinder(lineCall, lightDeclaration)});
        engine.meshes[line.value].name = "lightLine";
        gizmo_mesh(engine, scene, line, material);
        place_mesh(
            engine,
            line,
            Vec3d{p[0], p[1], p[2]},
            Vec3{
                static_cast<float>(def.sx),
                static_cast<float>(def.sy),
                static_cast<float>(def.sz)},
            q,
            lines_root);
    }
}

} // namespace

UtilityLayerHandle create_utility_layer(
    Engine& engine,
    Scene& main_scene) {
    auto record = std::make_unique<UtilityLayerRecord>();
    record->scene = create_scene_context(engine);
    record->main_scene = &main_scene;
    record->scene.clear_color = Color4{0.0f, 0.0f, 0.0f, 0.0f};
    record->scene.camera = main_scene.camera;
    UtilityLayerRecord* live = record.get();
    on_before_render(record->scene, [live](float) {
        if (live->scene.camera.value != live->main_scene->camera.value) {
            live->scene.camera = live->main_scene->camera;
        }
    });
    const LightHandle light = create_hemispheric_light(
        engine,
        Vec3{${utilityDirection}},
        ${this.context.floatLiteral(utilityIntensity)});
    engine.lights[light.value].ground_color = Color3{0.5f, 0.5f, 0.5f};
    add_to_scene(record->scene, light);
    engine.utility_layers.push_back(std::move(record));
    return UtilityLayerHandle{
        static_cast<std::uint32_t>(engine.utility_layers.size() - 1u)};
}

Scene& utility_layer_scene(Engine& engine, UtilityLayerHandle layer) {
    return layer_record(engine, layer).scene;
}

void register_utility_layer(Engine& engine, UtilityLayerHandle layer) {
    register_scene(layer_record(engine, layer).scene);
}

CameraGizmoHandle create_camera_gizmo(
    Engine& engine,
    UtilityLayerHandle layer) {
    Scene& scene = layer_record(engine, layer).scene;
    CameraGizmoRecord gizmo;
    gizmo.layer = layer;
    gizmo.material = create_standard_material(engine);
    engine.materials[gizmo.material.value].diffuse_color =
        Color3{0.5f, 0.5f, 0.5f};
    engine.materials[gizmo.material.value].specular_color =
        Color3{0.1f, 0.1f, 0.1f};
    gizmo.frustum_material = create_standard_material(engine);
    engine.materials[gizmo.frustum_material.value].diffuse_color =
        Color3{1.0f, 1.0f, 1.0f};
    engine.materials[gizmo.frustum_material.value].emissive_factor =
        Color3{1.0f, 1.0f, 1.0f};
    engine.materials[gizmo.frustum_material.value].disable_lighting = true;
    gizmo.root = create_transform_node(
        engine,
        "cameraGizmoRoot",
        Vec3d{0.0, 0.0, 0.0},
        Vec4{0.0f, 0.0f, 0.0f, 1.0f},
        Vec3{1.0f, 1.0f, 1.0f});
    add_to_scene(scene, gizmo.root);

    const std::array<double, 4> outer_rot =
        quat_from_bjs_euler(0.0, -pi_double * 0.5, 0.0);
    const TransformNodeHandle body_outer = create_transform_node(
        engine,
        "cameraBodyOuter",
        Vec3d{0.0, 0.0, 0.0},
        Vec4{
            static_cast<float>(outer_rot[0]),
            static_cast<float>(outer_rot[1]),
            static_cast<float>(outer_rot[2]),
            static_cast<float>(outer_rot[3])},
        Vec3{1.0f, 1.0f, 1.0f});
    set_transform_node_parent(engine, body_outer, gizmo.root);
    const TransformNodeHandle body_mesh = create_transform_node(
        engine,
        "cameraBodyMesh",
        Vec3d{-0.9, 0.0, 0.0},
        Vec4{0.0f, 0.0f, 0.0f, 1.0f},
        Vec3{1.0f, 1.0f, 1.0f});
    set_transform_node_parent(engine, body_mesh, body_outer);
    gizmo.body_outer = body_outer;

    const std::array<double, 4> rot_x =
        quat_from_bjs_euler(pi_double * 0.5, 0.0, 0.0);
    const std::array<double, 4> rot_z =
        quat_from_bjs_euler(0.0, 0.0, pi_double * 0.5);
    const std::array<double, 4> identity_rot{0.0, 0.0, 0.0, 1.0};
    const MeshHandle box = create_box(
        engine,
        BoxOptions{
            ${this.context.floatLiteral(bodyCalls[0]!.scalar ?? 1)},
            ${this.context.floatLiteral(bodyCalls[0]!.scalar ?? 1)},
            ${this.context.floatLiteral(bodyCalls[0]!.scalar ?? 1)}});
    gizmo_mesh(engine, scene, box, gizmo.material);
    place_mesh(
        engine,
        box,
        Vec3d{0.0, 0.0, 0.0},
        Vec3{1.0f, 0.8f, 0.5f},
        identity_rot,
        body_mesh);
    const MeshHandle reel_a = create_cylinder(
        engine,
        ${cylinder(bodyCalls[1]!, cameraDeclaration)});
    gizmo_mesh(engine, scene, reel_a, gizmo.material);
    place_mesh(
        engine,
        reel_a,
        Vec3d{-0.6, 0.3, 0.0},
        Vec3{1.0f, 1.0f, 1.0f},
        rot_x,
        body_mesh);
    const MeshHandle reel_b = create_cylinder(
        engine,
        ${cylinder(bodyCalls[2]!, cameraDeclaration)});
    gizmo_mesh(engine, scene, reel_b, gizmo.material);
    place_mesh(
        engine,
        reel_b,
        Vec3d{0.4, 0.5, 0.0},
        Vec3{1.0f, 1.0f, 1.0f},
        rot_x,
        body_mesh);
    const MeshHandle lens = create_cylinder(
        engine,
        ${cylinder(bodyCalls[3]!, cameraDeclaration)});
    gizmo_mesh(engine, scene, lens, gizmo.material);
    place_mesh(
        engine,
        lens,
        Vec3d{0.6, 0.0, 0.0},
        Vec3{1.0f, 1.0f, 1.0f},
        rot_z,
        body_mesh);

    engine.camera_gizmos.push_back(gizmo);
    const CameraGizmoHandle handle{
        static_cast<std::uint32_t>(engine.camera_gizmos.size() - 1u)};
    Engine* live_engine = &engine;
    on_before_render(scene, [live_engine, handle, layer](float) {
        Engine& e = *live_engine;
        CameraGizmoRecord& g = e.camera_gizmos[handle.value];
        if (g.attached_camera.value >= e.cameras.size()) return;
        const std::array<float, 16> wm =
            upstream::camera_world_matrix(e.cameras[g.attached_camera.value]);
        set_transform_node_position(
            e,
            g.root,
            Vec3d{
                static_cast<double>(wm[12]),
                static_cast<double>(wm[13]),
                static_cast<double>(wm[14])});
        const PinnedQuat q = ${PINNED_DECOMPOSE_ROTATION}(wm);
        set_transform_node_rotation_quaternion(
            e,
            g.root,
            Vec4{
                static_cast<float>(q.x),
                static_cast<float>(q.y),
                static_cast<float>(q.z),
                static_cast<float>(q.w)});
        Scene& utility = utility_layer_scene(e, layer);
        double dist = ${this.context.doubleLiteral(bodyScale)};
        if (utility.camera.value < e.cameras.size()) {
            const std::array<float, 16> cw =
                upstream::camera_world_matrix(e.cameras[utility.camera.value]);
            dist = bbl::js::hypot_js({
                       static_cast<double>(cw[12]) -
                           static_cast<double>(wm[12]),
                       static_cast<double>(cw[13]) -
                           static_cast<double>(wm[13]),
                       static_cast<double>(cw[14]) -
                           static_cast<double>(wm[14])}) *
                   ${this.context.doubleLiteral(bodyScale)};
        }
        set_transform_node_scaling(
            e,
            g.body_outer,
            Vec3{
                static_cast<float>(dist),
                static_cast<float>(dist),
                static_cast<float>(dist)});
    });
    return handle;
}

void attach_camera_gizmo_to_camera(
    Engine& engine,
    CameraGizmoHandle gizmo,
    CameraHandle camera) {
    CameraGizmoRecord& record = engine.camera_gizmos[gizmo.value];
    record.attached_camera = camera;
    if (record.frustum_built || camera.value >= engine.cameras.size()) {
        return;
    }
    record.frustum_built = true;
    Scene& scene = layer_record(engine, record.layer).scene;
    const CameraRecord& cam = engine.cameras[camera.value];
    const double canvas_width = engine.canvas_client_width;
    const double canvas_height = engine.canvas_client_height;
    const double aspect =
        canvas_width > 0.0 && canvas_height > 0.0
            ? canvas_width / canvas_height
            : 16.0 / 9.0;
    const double tan_half = std::tan(cam.fov * 0.5);
    const double near_p = std::max(cam.near_plane, 1e-4);
    const double far_v = std::max(cam.far_plane, near_p);
    const double near_v = (far_v * near_p) / (2.0 * far_v - near_p);
    const double nh = tan_half * near_v;
    const double nw = nh * aspect;
    const double fh = tan_half * far_v;
    const double fw = fh * aspect;
    const std::array<std::array<double, 3>, 8> corners{{
        {{-nw, -nh, near_v}},
        {{nw, -nh, near_v}},
        {{nw, nh, near_v}},
        {{-nw, nh, near_v}},
        {{-fw, -fh, far_v}},
        {{fw, -fh, far_v}},
        {{fw, fh, far_v}},
        {{-fw, fh, far_v}},
    }};
    const std::array<std::array<int, 2>, 12> edges{{
        {{0, 1}}, {{1, 2}}, {{2, 3}}, {{3, 0}},
        {{4, 5}}, {{5, 6}}, {{6, 7}}, {{7, 4}},
        {{0, 4}}, {{1, 5}}, {{2, 6}}, {{3, 7}},
    }};
    for (const std::array<int, 2>& edge : edges) {
        const std::array<double, 3>& a =
            corners[static_cast<std::size_t>(edge[0])];
        const std::array<double, 3>& b =
            corners[static_cast<std::size_t>(edge[1])];
        const MeshHandle mesh = create_cylinder(
            engine,
            ${cylinder(edgeCall, cameraDeclaration, edgeThickness)});
        gizmo_mesh(engine, scene, mesh, record.frustum_material);
        const double dx = b[0] - a[0];
        const double dy = b[1] - a[1];
        const double dz = b[2] - a[2];
        double len = bbl::js::hypot_js({dx, dy, dz});
        if (len == 0.0) len = 1.0;
        const double nx = dx / len;
        const double ny = dy / len;
        const double nz = dz / len;
        const double cx = nz;
        const double cy = 0.0;
        const double cz = -nx;
        const double c_len = bbl::js::hypot_js({cx, cy, cz});
        const double dot = ny;
        std::array<double, 4> rotation{0.0, 0.0, 0.0, 1.0};
        if (c_len < 1e-7) {
            rotation = dot > 0.0
                ? std::array<double, 4>{0.0, 0.0, 0.0, 1.0}
                : std::array<double, 4>{1.0, 0.0, 0.0, 0.0};
        } else {
            const double angle = std::atan2(c_len, dot);
            const double s = std::sin(angle * 0.5);
            rotation = std::array<double, 4>{
                (cx / c_len) * s,
                (cy / c_len) * s,
                (cz / c_len) * s,
                std::cos(angle * 0.5)};
        }
        place_mesh(
            engine,
            mesh,
            Vec3d{
                (a[0] + b[0]) * 0.5,
                (a[1] + b[1]) * 0.5,
                (a[2] + b[2]) * 0.5},
            Vec3{1.0f, static_cast<float>(len), 1.0f},
            rotation,
            record.root);
    }
}

LightGizmoHandle create_light_gizmo(
    Engine& engine,
    UtilityLayerHandle layer) {
    Scene& scene = layer_record(engine, layer).scene;
    LightGizmoRecord gizmo;
    gizmo.layer = layer;
    gizmo.material = create_standard_material(engine);
    engine.materials[gizmo.material.value].diffuse_color =
        Color3{0.5f, 0.5f, 0.5f};
    engine.materials[gizmo.material.value].specular_color =
        Color3{0.1f, 0.1f, 0.1f};
    gizmo.root = create_transform_node(
        engine,
        "lightGizmoRoot",
        Vec3d{0.0, 0.0, 0.0},
        Vec4{0.0f, 0.0f, 0.0f, 1.0f},
        Vec3{1.0f, 1.0f, 1.0f});
    add_to_scene(scene, gizmo.root);
    engine.light_gizmos.push_back(gizmo);
    const LightGizmoHandle handle{
        static_cast<std::uint32_t>(engine.light_gizmos.size() - 1u)};
    Engine* live_engine = &engine;
    on_before_render(scene, [live_engine, handle, layer](float) {
        Engine& e = *live_engine;
        LightGizmoRecord& g = e.light_gizmos[handle.value];
        if (g.attached_light.value >= e.lights.size()) return;
        const LightRecord& light = e.lights[g.attached_light.value];
        // The pin tests \`if (pos)\` and \`if (dir)\` on the light OBJECT,
        // and which of the two a light carries is decided by the factory
        // that made it: hemispheric declares only a direction, point only
        // a position, directional and spot both.
        const bool has_position =
            light.kind == LightKind::point ||
            light.kind == LightKind::spot ||
            light.kind == LightKind::directional;
        const bool has_direction =
            light.kind == LightKind::hemispheric ||
            light.kind == LightKind::spot ||
            light.kind == LightKind::directional;
        if (has_position) {
            set_transform_node_position(
                e,
                g.root,
                Vec3d{
                    static_cast<double>(light.position.x),
                    static_cast<double>(light.position.y),
                    static_cast<double>(light.position.z)});
        }
        if (has_direction) {
            const std::array<double, 4> q =
                direction_to_quat(light.direction);
            set_transform_node_rotation_quaternion(
                e,
                g.root,
                Vec4{
                    static_cast<float>(q[0]),
                    static_cast<float>(q[1]),
                    static_cast<float>(q[2]),
                    static_cast<float>(q[3])});
        }
        Scene& utility = utility_layer_scene(e, layer);
        const Vec3d root_position =
            e.transform_nodes[g.root.value].position;
        double dist = ${this.context.doubleLiteral(lightScale)};
        if (utility.camera.value < e.cameras.size()) {
            const std::array<float, 16> cw =
                upstream::camera_world_matrix(e.cameras[utility.camera.value]);
            dist = bbl::js::hypot_js({
                       static_cast<double>(cw[12]) - root_position.x,
                       static_cast<double>(cw[13]) - root_position.y,
                       static_cast<double>(cw[14]) - root_position.z}) *
                   ${this.context.doubleLiteral(lightScale)};
        }
        set_transform_node_scaling(
            e,
            g.root,
            Vec3{
                static_cast<float>(dist),
                static_cast<float>(dist),
                static_cast<float>(dist)});
    });
    return handle;
}

void attach_light_gizmo_to_light(
    Engine& engine,
    LightGizmoHandle gizmo,
    LightHandle light) {
    LightGizmoRecord& record = engine.light_gizmos[gizmo.value];
    record.attached_light = light;
    if (light.value >= engine.lights.size()) return;
    const LightKind kind = engine.lights[light.value].kind;
    if (record.built) {
        // The pin's _build has two arms: it early-returns when the new
        // light's lightType matches the one it built for, and otherwise
        // DISPOSES the widget and builds the other type's. Only the first
        // arm is lowered -- the second needs the pinned disposal this port
        // does not reach -- so a re-attach to a different type fails by
        // name rather than keeping a widget that no longer describes the
        // light it follows.
        if (record.built_kind != kind) {
            throw std::runtime_error(
                "A light gizmo was re-attached to a light of a different "
                "type. The pin rebuilds the widget for the new type; this "
                "port builds it once.");
        }
        return;
    }
    record.built = true;
    record.built_kind = kind;
    Scene& scene = layer_record(engine, record.layer).scene;
    const std::array<double, 4> identity_rot{0.0, 0.0, 0.0, 1.0};
    if (kind == LightKind::directional) {
        const std::array<double, 4> mq =
            quat_from_bjs_euler(0.0, pi_double / 2.0, pi_double / 2.0);
        const TransformNodeHandle mesh_root = create_transform_node(
            engine,
            "directionalLight",
            Vec3d{0.0, 0.0, 0.0},
            Vec4{
                static_cast<float>(mq[0]),
                static_cast<float>(mq[1]),
                static_cast<float>(mq[2]),
                static_cast<float>(mq[3])},
            Vec3{1.0f, 1.0f, 1.0f});
        set_transform_node_parent(engine, mesh_root, record.root);
        const MeshHandle sphere = create_sphere(
            engine,
            ${sphere(dirSphere, lightDeclaration)});
        gizmo_mesh(engine, scene, sphere, record.material);
        place_mesh(
            engine,
            sphere,
            Vec3d{0.0, 0.0, 0.0},
            Vec3{1.0f, 1.0f, 1.0f},
            identity_rot,
            mesh_root);
        const std::array<std::array<double, 2>, 3> shafts{{
            {{0.0, 1.0}}, {{1.25, 0.5}}, {{-1.25, 0.5}},
        }};
        for (const std::array<double, 2>& entry : shafts) {
            const MeshHandle shaft = create_cylinder(
                engine,
                ${cylinder(shaft, lightDeclaration)});
            gizmo_mesh(engine, scene, shaft, record.material);
            place_mesh(
                engine,
                shaft,
                Vec3d{entry[0], 0.0, 0.0},
                Vec3{1.0f, static_cast<float>(entry[1]), 1.0f},
                identity_rot,
                mesh_root);
        }
        const std::array<std::array<double, 2>, 3> heads{{
            {{0.0, 3.0}}, {{1.25, 1.5}}, {{-1.25, 1.5}},
        }};
        for (const std::array<double, 2>& entry : heads) {
            const MeshHandle head = create_cylinder(
                engine,
                ${cylinder(head, lightDeclaration)});
            gizmo_mesh(engine, scene, head, record.material);
            place_mesh(
                engine,
                head,
                Vec3d{entry[0], entry[1], 0.0},
                Vec3{1.0f, 1.0f, 1.0f},
                identity_rot,
                mesh_root);
        }
        return;
    }
    const std::string type_name =
        kind == LightKind::point
            ? "pointLight"
            : kind == LightKind::hemispheric ? "hemisphericLight"
                                             : "spotLight";
    const TransformNodeHandle type_root = create_transform_node(
        engine,
        type_name,
        Vec3d{0.0, 0.0, 0.0},
        Vec4{0.0f, 0.0f, 0.0f, 1.0f},
        Vec3{1.0f, 1.0f, 1.0f});
    set_transform_node_parent(engine, type_root, record.root);
    if (kind == LightKind::point) {
        const MeshHandle sphere = create_sphere(
            engine,
            ${sphere(pointSphere, lightDeclaration)});
        gizmo_mesh(engine, scene, sphere, record.material);
        place_mesh(
            engine,
            sphere,
            Vec3d{0.0, 0.0, 0.0},
            Vec3{1.0f, 1.0f, 1.0f},
            quat_from_bjs_euler(pi_double / 2.0, 0.0, 0.0),
            type_root);
        build_light_lines(engine, scene, record.material, type_root, 5.0);
        return;
    }
    if (kind == LightKind::hemispheric) {
        const MeshHandle hemi = build_hemisphere_mesh(engine, 10.0, 1.0);
        gizmo_mesh(engine, scene, hemi, record.material);
        place_mesh(
            engine,
            hemi,
            Vec3d{0.0, 0.0, -0.15},
            Vec3{1.0f, 1.0f, 1.0f},
            quat_from_bjs_euler(pi_double / 2.0, 0.0, 0.0),
            type_root);
        build_light_lines(engine, scene, record.material, type_root, 3.0);
        return;
    }
    const MeshHandle sphere = create_sphere(
        engine,
        ${sphere(spotSphere, lightDeclaration)});
    gizmo_mesh(engine, scene, sphere, record.material);
    place_mesh(
        engine,
        sphere,
        Vec3d{0.0, 0.0, 0.0},
        Vec3{1.0f, 1.0f, 1.0f},
        identity_rot,
        type_root);
    const MeshHandle hemi = build_hemisphere_mesh(engine, 10.0, 2.0);
    gizmo_mesh(engine, scene, hemi, record.material);
    place_mesh(
        engine,
        hemi,
        Vec3d{0.0, 0.0, 0.0},
        Vec3{1.0f, 1.0f, 1.0f},
        quat_from_bjs_euler(-pi_double / 2.0, 0.0, 0.0),
        type_root);
    build_light_lines(engine, scene, record.material, type_root, 2.0);
}

} // namespace bbl
`,
        };
    }
}
