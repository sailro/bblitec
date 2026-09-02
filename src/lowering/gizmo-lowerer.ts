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
 * own body rather than a second copy of it -- including the two the
 * local-coordinate follow adds, `quatMul` and `transformDirectionByWorld`.
 *
 * The three COMPOSITES (`src/gizmo/composite-gizmos.ts`) are folded the
 * same way, statement for statement: each pinned factory resolves its
 * options through a `??`, builds sub-widgets with the axis, colour and
 * option values it passes each one, turns local-coordinate mode on where
 * the pin turns it on, and returns the list. `wireCrossAxisDisable` is the
 * one statement dropped, because it subscribes drag observers alone.
 *
 * One thing here is asserted rather than emitted: that the pinned gizmo
 * pointer-drag dispatcher map has exactly one writer, reached from exactly
 * one place. That is the fact a camera's folded `attachControl` deferral
 * bag rests on, and it is a statement about the pin, so it is checked
 * beside the family rather than at the compiler's call site.
 */
import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    lowerMat4MultiplyWriterCpp,
    lowerObjectComponents,
    lowerPinnedFunction,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";
import {
    type PinnedBinding,
    type PinnedNumericScope,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";
import {
    PINNED_DECOMPOSE_ROTATION,
    lowerMat4DecomposeRotation,
} from "./pinned-mat4-decompose.js";
import { pinnedMeshOptionFlag } from "../pinned-mesh-defaults.js";
import { pinnedPolyhedron } from "../pinned-polyhedra.js";

const UTILITY_MODULE = "src/gizmo/utility-layer.ts";
const MATH_MODULE = "src/gizmo/gizmo-math.ts";
const CORE_MODULE = "src/gizmo/gizmo-core.ts";
const CAMERA_MODULE = "src/gizmo/camera-gizmo.ts";
const LIGHT_MODULE = "src/gizmo/light-gizmo.ts";
const LENGTH_MODULE = "src/math/length-vec3.ts";
const NORMALIZE_MODULE = "src/math/normalize-vec3-object.ts";
const AXIS_DRAG_MODULE = "src/gizmo/axis-drag-gizmo.ts";
const AXIS_SCALE_MODULE = "src/gizmo/axis-scale-gizmo.ts";
const PLANE_DRAG_MODULE = "src/gizmo/plane-drag-gizmo.ts";
const PLANE_ROTATION_MODULE = "src/gizmo/plane-rotation-gizmo.ts";
const COMPOSITE_MODULE = "src/gizmo/composite-gizmos.ts";
const POINTER_DRAG_MODULE = "src/gizmo/pointer-drag.ts";
const POLYHEDRON_MODULE = "src/mesh/create-polyhedron.ts";
const BOUNDING_BOX_MODULE = "src/gizmo/bounding-box-gizmo.ts";
const COMPUTE_AABB_MODULE = "src/math/compute-aabb.ts";
const MAT4_FROM_QUAT_MODULE = "src/math/mat4-from-quat.ts";
const MAT4_COMPOSE_MODULE = "src/math/mat4-compose-into.ts";

/**
 * Where a folded sub-gizmo call may be broken across lines. The composite
 * emitter builds one argument list and the statement emitter decides the
 * indent, because the same call is emitted at two depths.
 */
const ARGUMENT_BREAK = "\u0000";

/** One editing widget's module, as everything below it needs to see it. */
interface EditModule {
    modulePath: string;
    /** The pinned factory. */
    factory: string;
    /** The pinned attach call. */
    attach: string;
    /** `dragAxis`, `dragPlaneNormal` or `planeNormal`. */
    axis: string;
    /** The feature row that gates the emitted builder. */
    feature: string;
    /** The generated native factory. */
    cppFactory: string;
    /**
     * The optional parameters the generated factory takes after its axis,
     * by the pin's own option names and in the emitted order. A composite
     * passes its own values through these, so the order is stated once.
     */
    options: readonly string[];
}

/** The four editing widgets' modules and their factory names. */
const EDIT_MODULES: readonly EditModule[] = [
    {
        modulePath: AXIS_DRAG_MODULE,
        factory: "createAxisDragGizmo",
        axis: "dragAxis",
        attach: "attachAxisDragGizmoToNode",
        feature: "gizmo:axis-drag",
        cppFactory: "create_axis_drag_gizmo",
        options: ["color", "thickness"],
    },
    {
        modulePath: AXIS_SCALE_MODULE,
        factory: "createAxisScaleGizmo",
        axis: "dragAxis",
        attach: "attachAxisScaleGizmoToNode",
        feature: "gizmo:axis-scale",
        cppFactory: "create_axis_scale_gizmo",
        options: ["color", "thickness", "uniformScaling"],
    },
    {
        modulePath: PLANE_DRAG_MODULE,
        factory: "createPlaneDragGizmo",
        axis: "dragPlaneNormal",
        attach: "attachPlaneDragGizmoToNode",
        feature: "gizmo:plane-drag",
        cppFactory: "create_plane_drag_gizmo",
        options: ["color"],
    },
    {
        modulePath: PLANE_ROTATION_MODULE,
        factory: "createPlaneRotationGizmo",
        axis: "planeNormal",
        attach: "attachPlaneRotationGizmoToNode",
        feature: "gizmo:plane-rotation",
        cppFactory: "create_plane_rotation_gizmo",
        options: ["color", "tessellation", "thickness"],
    },
];

/** One composite gizmo's factory and the fan-outs the pin declares beside it. */
interface CompositeModule {
    factory: string;
    cppFactory: string;
    feature: string;
    /** The pinned coordinate-mode fan-out. */
    setLocal: string;
    /** The pinned attach fan-out. */
    attach: string;
    /**
     * The options the pinned factory defaults through a `??`, in the order
     * the generated factory takes them. `pinned` is the pin's own local,
     * which is also the member it reads.
     */
    options: readonly { pinned: string; cpp: string }[];
}

const COMPOSITE_MODULES: readonly CompositeModule[] = [
    {
        factory: "createPositionGizmo",
        cppFactory: "create_position_gizmo",
        feature: "gizmo:position",
        setLocal: "setPositionGizmoLocalCoordinates",
        attach: "attachPositionGizmoToNode",
        options: [
            { pinned: "planarEnabled", cpp: "planar_enabled" },
            { pinned: "thickness", cpp: "thickness" },
        ],
    },
    {
        factory: "createRotationGizmo",
        cppFactory: "create_rotation_gizmo",
        feature: "gizmo:rotation",
        setLocal: "setRotationGizmoLocalCoordinates",
        attach: "attachRotationGizmoToNode",
        options: [
            { pinned: "tessellation", cpp: "tessellation" },
            { pinned: "thickness", cpp: "thickness" },
        ],
    },
    {
        factory: "createScaleGizmo",
        cppFactory: "create_scale_gizmo",
        feature: "gizmo:scale",
        setLocal: "setScaleGizmoLocalCoordinates",
        attach: "attachScaleGizmoToNode",
        options: [{ pinned: "thickness", cpp: "thickness" }],
    },
];

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
    public constructor(
        private readonly context: LoweringContext,
        private readonly features: readonly string[] = [],
    ) {}

    /**
     * Whether this scene reaches an editing widget.
     *
     * The four editors are 28% of the emitted unit, and a scene reaching
     * only the utility layer and the two display gizmos -- scene 223 --
     * can call none of them. The features already exist and are already
     * reached at the intrinsic; this is the emitter consulting them.
     */
    private reachesEditGizmos(): boolean {
        return EDIT_MODULES.some(({ feature }) =>
            this.features.includes(feature),
        );
    }

    /** The composites this scene reaches, in the pin's own order. */
    private reachedComposites(): readonly CompositeModule[] {
        return COMPOSITE_MODULES.filter(({ feature }) =>
            this.features.includes(feature),
        );
    }

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

    /**
     * A pinned body that returns `[x, y, z, w]` in one arm and the value
     * of another helper in the next -- which is every quaternion helper
     * here, because each guards a degenerate axis with an early
     * `return [0, 0, 0, 1]`.
     */
    private quatReturn(modulePath: string, symbolName: string): {
        type: string;
        value: (
            lowerer: PinnedNumericLowerer,
            expression: ts.Expression | undefined,
        ) => string;
    } {
        const at = this.context.functionDeclaration(
            modulePath,
            symbolName,
        ).declaration;
        return {
            type: "std::array<double, 4>",
            value: (lowerer, expression) => {
                const returned = expression
                    ? this.context.unwrapExpression(expression)
                    : undefined;
                if (!returned) {
                    return this.context.contractError(
                        at,
                        `Expected pinned ${symbolName} to return a value.`,
                    );
                }
                return ts.isArrayLiteralExpression(returned)
                    ? `std::array<double, 4>{${lowerTupleComponents(
                          this.context,
                          lowerer,
                          returned,
                          { arity: 4, at },
                      ).join(", ")}}`
                    : lowerer.expression(returned);
            },
        };
    }

    /** The pin's own quaternion helpers, as C++. */
    private mathHelpers(): string {
        const calls = new Map([
            ...pinnedNumericMathCallsWithHypot(),
            [
                "quatFromBjsEuler",
                (args: readonly string[]): string =>
                    `quat_from_bjs_euler(${args.join(", ")})`,
            ],
            [
                "lengthVec3",
                (args: readonly string[]): string =>
                    `length_vec3(${args.join(", ")})`,
            ],
            [
                "quatFromAxisAngle",
                (args: readonly string[]): string =>
                    `quat_from_axis_angle(${args.join(", ")})`,
            ],
            [
                "quatNormalize",
                (args: readonly string[]): string =>
                    `quat_normalize(${args.join(", ")})`,
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
                    // `const auto&`: the pin's `Vec3` is a JavaScript
                    // number triple, and the two callers hold it at
                    // different widths -- a light's `direction` is the
                    // float the record stores, a gizmo's drag axis is the
                    // double the scene wrote. The annotation below is
                    // what checks the pin still spells it `Vec3`.
                    cppType: "auto",
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
        // The four the editing widgets add. `lookAtQuat` is what orients
        // every one of their roots onto its drag axis or plane normal,
        // and it is the pin's own shortest-arc rotation rather than a
        // second copy of it -- so are the three helpers under it, down to
        // the `Math.hypot(...) || 1` guard `quatNormalize` opens with.
        const lengthVec3 = lowerPinnedFunction(
            this.context,
            LENGTH_MODULE,
            "lengthVec3",
            [
                {
                    pinned: "v",
                    kind: "record",
                    cpp: "v",
                    cppType: "auto",
                    annotation: "Vec3",
                },
            ],
            {
                cppName: "length_vec3",
                calls,
                memberBindings: new Map([
                    ["v.x", { cpp: "v.x", type: "scalar" as const }],
                    ["v.y", { cpp: "v.y", type: "scalar" as const }],
                    ["v.z", { cpp: "v.z", type: "scalar" as const }],
                ]),
                returns: "double",
            },
        );
        const normalizeVec3 = lowerPinnedFunction(
            this.context,
            NORMALIZE_MODULE,
            "normalizeVec3",
            [
                {
                    pinned: "v",
                    kind: "record",
                    cpp: "v",
                    cppType: "auto",
                    annotation: "Vec3",
                },
            ],
            {
                cppName: "normalize_vec3",
                calls,
                memberBindings: new Map([
                    ["v.x", { cpp: "v.x", type: "scalar" as const }],
                    ["v.y", { cpp: "v.y", type: "scalar" as const }],
                    ["v.z", { cpp: "v.z", type: "scalar" as const }],
                ]),
                returns: {
                    type: "Vec3d",
                    value: (lowerer, expression) =>
                        `Vec3d{${lowerObjectComponents(
                            this.context,
                            lowerer,
                            expression ??
                                this.context.contractError(
                                    this.context.functionDeclaration(
                                        NORMALIZE_MODULE,
                                        "normalizeVec3",
                                    ).declaration,
                                    "Expected pinned normalizeVec3 to " +
                                        "return a value.",
                                ),
                            ["x", "y", "z"],
                        ).join(", ")}}`,
                },
            },
        );
        const quatFromAxisAngle = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "quatFromAxisAngle",
            [
                { pinned: "ax", kind: "number", cpp: "ax" },
                { pinned: "ay", kind: "number", cpp: "ay" },
                { pinned: "az", kind: "number", cpp: "az" },
                { pinned: "angle", kind: "number", cpp: "angle" },
            ],
            {
                cppName: "quat_from_axis_angle",
                calls,
                returns: this.quatReturn(MATH_MODULE, "quatFromAxisAngle"),
            },
        );
        const quatNormalize = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "quatNormalize",
            [
                {
                    pinned: "q",
                    kind: "record",
                    cpp: "q",
                    cppType: "std::array<double, 4>",
                    annotation: "[number, number, number, number]",
                },
            ],
            {
                cppName: "quat_normalize",
                calls,
                memberBindings: new Map([
                    ["q[0]", { cpp: "q[0]", type: "scalar" as const }],
                    ["q[1]", { cpp: "q[1]", type: "scalar" as const }],
                    ["q[2]", { cpp: "q[2]", type: "scalar" as const }],
                    ["q[3]", { cpp: "q[3]", type: "scalar" as const }],
                ]),
                returns: this.quatReturn(MATH_MODULE, "quatNormalize"),
            },
        );
        const quatMul = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "quatMul",
            [
                { pinned: "ax", kind: "number", cpp: "ax" },
                { pinned: "ay", kind: "number", cpp: "ay" },
                { pinned: "az", kind: "number", cpp: "az" },
                { pinned: "aw", kind: "number", cpp: "aw" },
                { pinned: "bx", kind: "number", cpp: "bx" },
                { pinned: "by", kind: "number", cpp: "by" },
                { pinned: "bz", kind: "number", cpp: "bz" },
                { pinned: "bw", kind: "number", cpp: "bw" },
            ],
            {
                cppName: "quat_mul",
                calls,
                returns: this.quatReturn(MATH_MODULE, "quatMul"),
            },
        );
        // The local-coordinate arm's other half: the world drag axis, from
        // the attached node's world matrix. The pin reads nine of the
        // sixteen elements by index and ends in `normalizeVec3`, so the
        // bindings below are those nine at the width the follow holds them
        // -- a pin that reached a tenth fails here rather than lowering a
        // silently different direction.
        const transformDirectionByWorld = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "transformDirectionByWorld",
            [
                {
                    pinned: "wm",
                    kind: "record",
                    cpp: "wm",
                    cppType: "std::array<float, 16>",
                    annotation: "Mat4",
                },
                {
                    pinned: "dir",
                    kind: "record",
                    cpp: "dir",
                    cppType: "auto",
                    annotation: "Vec3",
                },
            ],
            {
                cppName: "transform_direction_by_world",
                calls: new Map([
                    ...calls,
                    [
                        "normalizeVec3",
                        (args: readonly string[]): string =>
                            `normalize_vec3(${args.join(", ")})`,
                    ],
                ]),
                memberBindings: new Map([
                    ...([0, 1, 2, 4, 5, 6, 8, 9, 10] as const).map(
                        (index): [string, PinnedBinding] => [
                            `wm[${index}]`,
                            {
                                cpp: `static_cast<double>(wm[${index}])`,
                                type: "scalar",
                            },
                        ],
                    ),
                    ["dir.x", { cpp: "dir.x", type: "scalar" as const }],
                    ["dir.y", { cpp: "dir.y", type: "scalar" as const }],
                    ["dir.z", { cpp: "dir.z", type: "scalar" as const }],
                ]),
                returns: {
                    type: "Vec3d",
                    value: (lowerer, expression) => {
                        const at = this.context.functionDeclaration(
                            MATH_MODULE,
                            "transformDirectionByWorld",
                        ).declaration;
                        const returned = expression
                            ? this.context.unwrapExpression(expression)
                            : undefined;
                        if (
                            !returned ||
                            !ts.isCallExpression(returned) ||
                            !ts.isIdentifier(returned.expression) ||
                            returned.expression.text !== "normalizeVec3" ||
                            returned.arguments.length !== 1
                        ) {
                            this.context.contractError(
                                at,
                                "Expected pinned transformDirectionByWorld " +
                                    "to return normalizeVec3 of its own " +
                                    "combination.",
                            );
                        }
                        return `normalize_vec3(Vec3d{${lowerObjectComponents(
                            this.context,
                            lowerer,
                            returned.arguments[0]!,
                            ["x", "y", "z"],
                        ).join(", ")}})`;
                    },
                },
            },
        );
        const lookAtQuat = lowerPinnedFunction(
            this.context,
            MATH_MODULE,
            "lookAtQuat",
            [
                {
                    pinned: "dir",
                    kind: "record",
                    cpp: "dir",
                    cppType: "auto",
                    annotation: "Vec3",
                },
            ],
            {
                cppName: "look_at_quat",
                calls,
                memberBindings: new Map([
                    ["dir.x", { cpp: "dir.x", type: "scalar" as const }],
                    ["dir.y", { cpp: "dir.y", type: "scalar" as const }],
                    ["dir.z", { cpp: "dir.z", type: "scalar" as const }],
                ]),
                returns: this.quatReturn(MATH_MODULE, "lookAtQuat"),
            },
        );
        // `lengthVec3` and `normalizeVec3` serve `directionToQuat`,
        // which the light gizmo reaches; the shortest-arc trio below
        // them is called only from an editing widget's root
        // orientation, and an emitted static function nothing calls is
        // an error under -Werror.
        return [
            quatFromBjsEuler,
            rotateVec3ByQuat,
            directionToQuat,
            lengthVec3,
            normalizeVec3,
            ...(this.reachesEditGizmos()
                ? [
                      quatFromAxisAngle,
                      quatNormalize,
                      lookAtQuat,
                      quatMul,
                      transformDirectionByWorld,
                  ]
                : []),
            lowerMat4DecomposeRotation(this.context),
        ].join("\n\n");
    }

    // ---------------------------------------------------------------
    // The four editing widgets.
    //
    // Read exactly the way the two display gizmos are: the option object
    // of every mesh factory the pinned body calls, and the arguments of
    // every `.position.set` / `.rotation.set` / `.scaling.set` beside it,
    // lowered through the shared numeric translator so a member the pin
    // COMPUTES (`0.0375 * (1 + (thickness - 1) / 4)`) travels as the pin's
    // own expression over a live `thickness` rather than as a folded
    // number. Nothing about a widget's geometry is spelled in this file.
    // ---------------------------------------------------------------

    /** A `PinnedNumericLowerer` over one pinned module, with `Math.PI`. */
    private widgetLowerer(
        modulePath: string,
        bindings: ReadonlyMap<string, string>,
    ): PinnedNumericLowerer {
        return new PinnedNumericLowerer(
            this.context.sourceFile(modulePath),
            {
                bindings: new Map([
                    ["Math.PI", { cpp: "pi_double", type: "scalar" }],
                    ...[...bindings].map(
                        ([pinned, cpp]): [string, PinnedBinding] => [
                            pinned,
                            { cpp, type: "scalar" },
                        ],
                    ),
                ]),
                calls: pinnedNumericMathCallsWithHypot(),
            },
        );
    }

    /**
     * A pinned body's statements, optionally without the arm guarded by
     * one boolean parameter.
     *
     * `buildScaleArrow` builds two different widgets in one body -- the
     * uniform-scale octahedron behind `if (centered)`, then the arrow --
     * and the two share their local names. Dropping the guarded arm is
     * what makes "the head" name one declaration.
     */
    private bodyScope(
        modulePath: string,
        holder: string,
        guardName?: string,
        mode: "exclude" | "only" = "exclude",
    ): { at: ts.Node; roots: readonly ts.Node[] } {
        const declaration = this.context.functionDeclaration(
            modulePath,
            holder,
        ).declaration;
        if (!guardName) {
            return { at: declaration, roots: [declaration] };
        }
        const statements = declaration.body!.statements;
        const guarded = statements.filter(
            (statement) =>
                ts.isIfStatement(statement) &&
                ts.isIdentifier(statement.expression) &&
                statement.expression.text === guardName,
        );
        if (guarded.length !== 1) {
            this.context.contractError(
                declaration,
                `Expected pinned ${holder} to guard exactly one arm on ` +
                    `'${guardName}'.`,
            );
        }
        return {
            at: declaration,
            roots:
                mode === "only"
                    ? [guarded[0]!]
                    : statements.filter(
                          (statement) => statement !== guarded[0],
                      ),
        };
    }

    /** The `const <name> = ...` initializer inside one pinned body. */
    private localInitializer(
        scope: ts.Node | readonly ts.Node[],
        name: string,
    ): ts.Expression {
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (
                !found &&
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name &&
                node.initializer
            ) {
                found = node.initializer;
            }
            ts.forEachChild(node, visit);
        };
        const roots = Array.isArray(scope)
            ? (scope as readonly ts.Node[])
            : [scope as ts.Node];
        for (const root of roots) visit(root);
        return (
            found ??
            this.context.contractError(
                roots[0]!,
                `Expected the pinned body to declare '${name}'.`,
            )
        );
    }

    /**
     * The widget's own local-frame axis, as the pinned body derives it.
     *
     * Two shapes reach this and both are the pin's: a member-wise copy of
     * the option (`{ x: options.dragAxis.x, ... }`) and a normalization of
     * it (`normalizeVec3Obj(options.planeNormal)`), the second of which
     * one widget reaches through a named intermediate. Which one a widget
     * uses is a difference the follow can see -- the rotation ring's world
     * normal is normalized where the drag arrow's is not -- so it is read
     * rather than assumed.
     */
    private widgetLocalAxis(
        modulePath: string,
        factory: string,
        local: string,
        axisMember: string,
        axisCpp: string,
        extraVectors: ReadonlyMap<string, string> = new Map(),
    ): string {
        const declaration = this.context.functionDeclaration(
            modulePath,
            factory,
        ).declaration;
        const vectors = new Map<string, string>([
            [`options.${axisMember}`, axisCpp],
            ...extraVectors,
        ]);
        const scalars = new Map<string, PinnedBinding>();
        for (const [pinned, cpp] of vectors) {
            for (const component of ["x", "y", "z"]) {
                scalars.set(`${pinned}.${component}`, {
                    cpp: `${cpp}.${component}`,
                    type: "scalar",
                });
            }
        }
        const lowerer = new PinnedNumericLowerer(
            this.context.sourceFile(modulePath),
            {
                bindings: scalars,
                calls: pinnedNumericMathCallsWithHypot(),
            },
        );
        const render = (expression: ts.Expression): string => {
            const node = this.context.unwrapExpression(expression);
            const path = ts.isIdentifier(node)
                ? node.text
                : this.context.propertyPath(node)?.join(".");
            const bound = path === undefined ? undefined : vectors.get(path);
            if (bound) {
                return bound;
            }
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                (node.expression.text === "normalizeVec3Obj" ||
                    node.expression.text === "normalizeVec3") &&
                node.arguments.length === 1
            ) {
                return `normalize_vec3(${render(node.arguments[0]!)})`;
            }
            if (ts.isObjectLiteralExpression(node)) {
                return `Vec3d{${lowerObjectComponents(
                    this.context,
                    lowerer,
                    node,
                    ["x", "y", "z"],
                ).join(", ")}}`;
            }
            return this.context.contractError(
                node,
                `Expected pinned ${factory} to derive '${local}' from ` +
                    `its ${axisMember} option.`,
            );
        };
        return render(this.localInitializer(declaration, local));
    }

    /**
     * The root orientation the pin writes in one guarded arm, as four
     * lowered components.
     *
     * `createAxisScaleGizmo` replaces its baked lookAt with the identity
     * when the handle is the central uniform one, because BJS keeps that
     * one world-aligned -- so the identity is read out of that arm rather
     * than spelled in the emitted body.
     */
    private rootRotationQuaternion(
        modulePath: string,
        factory: string,
        guardName: string,
    ): readonly string[] {
        const { roots } = this.bodyScope(
            modulePath,
            factory,
            guardName,
            "only",
        );
        const lowerer = this.widgetLowerer(modulePath, new Map());
        let found: ts.CallExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "set" &&
                ts.isPropertyAccessExpression(node.expression.expression) &&
                node.expression.expression.name.text ===
                    "rotationQuaternion" &&
                ts.isIdentifier(node.expression.expression.expression) &&
                node.expression.expression.expression.text === "root"
            ) {
                found = node;
                return;
            }
            ts.forEachChild(node, visit);
        };
        for (const root of roots) visit(root);
        if (!found || found.arguments.length !== 4) {
            this.context.contractError(
                roots[0]!,
                `Expected pinned ${factory} to set its root's rotation ` +
                    `quaternion inside the '${guardName}' arm.`,
            );
        }
        return found.arguments.map((argument) =>
            lowerer.expression(argument),
        );
    }

    /** A pinned mesh factory option that has to be a compile-time number. */
    private widgetOptionNumber(
        part: {
            options: ReadonlyMap<
                string,
                { cpp: string; node: ts.Expression }
            >;
            at: ts.Node;
        },
        name: string,
    ): number {
        const value = part.options.get(name);
        if (!value) {
            this.context.contractError(
                part.at,
                `Expected the pinned mesh factory to declare '${name}'.`,
            );
        }
        return this.context.numericValue(
            value.node,
            value.node.getSourceFile(),
        );
    }

    /** The boolean form of `optionDefault`, for a `?? false` flag. */
    private optionDefaultFlag(
        declaration: ts.Node,
        member: string,
    ): string {
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            const coalesce = ts.isExpression(node)
                ? this.context.nullishDefault(node)
                : undefined;
            if (
                coalesce &&
                ts.isPropertyAccessExpression(
                    this.context.unwrapExpression(coalesce.left),
                ) &&
                (
                    this.context.unwrapExpression(
                        coalesce.left,
                    ) as ts.PropertyAccessExpression
                ).name.text === member
            ) {
                found = this.context.unwrapExpression(coalesce.right);
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (
            !found ||
            (found.kind !== ts.SyntaxKind.TrueKeyword &&
                found.kind !== ts.SyntaxKind.FalseKeyword)
        ) {
            this.context.contractError(
                declaration,
                `Expected the pinned body to default '${member}' to a ` +
                    "boolean literal through a nullish coalesce.",
            );
        }
        return found.kind === ts.SyntaxKind.TrueKeyword
            ? "true"
            : "false";
    }

    /** The right side of the pin's own `options.<member> ?? <default>`. */
    private optionDefault(
        declaration: ts.Node,
        member: string,
        file: ts.SourceFile,
    ): number {
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                ts.isPropertyAccessExpression(
                    this.context.unwrapExpression(node.left),
                ) &&
                (
                    this.context.unwrapExpression(
                        node.left,
                    ) as ts.PropertyAccessExpression
                ).name.text === member
            ) {
                found = node.right;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        return found
            ? this.context.numericValue(found, file)
            : this.context.contractError(
                  declaration,
                  `Expected the pinned body to default '${member}' ` +
                      "through a nullish coalesce.",
              );
    }

    /** The three arguments of `<local>.<channel>.set(a, b, c)`. */
    private channel(
        scope: ts.Node | readonly ts.Node[],
        local: string,
        channelName: string,
        lowerer: PinnedNumericLowerer,
        fallback: readonly [string, string, string],
    ): readonly string[] {
        let found: ts.CallExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "set" &&
                ts.isPropertyAccessExpression(node.expression.expression) &&
                node.expression.expression.name.text === channelName &&
                ts.isIdentifier(
                    node.expression.expression.expression,
                ) &&
                node.expression.expression.expression.text === local
            ) {
                found = node;
            }
            ts.forEachChild(node, visit);
        };
        for (const root of Array.isArray(scope)
            ? (scope as readonly ts.Node[])
            : [scope as ts.Node]) {
            visit(root);
        }
        if (!found) return fallback;
        if (found.arguments.length !== 3) {
            this.context.contractError(
                found,
                `Expected pinned ${local}.${channelName}.set to take ` +
                    "three components.",
            );
        }
        return found.arguments.map((argument) =>
            lowerer.expression(argument),
        );
    }

    /** `<local>.visible = false`, which is what makes a part pick-only. */
    private assertHidden(
        scope: ts.Node | readonly ts.Node[],
        local: string,
        member = "visible",
    ): void {
        const roots = Array.isArray(scope)
            ? (scope as readonly ts.Node[])
            : [scope as ts.Node];
        // The hide must be one the pinned body performs AT BUILD TIME, so
        // the walk stops at any nested function. Two of the pin's bodies
        // hide the same local a second time from a drag callback
        // (`createPlaneRotationGizmo` in `onDragEnd`), and a scan that
        // reached those would be satisfied by the copy that only runs once
        // a pointer event arrives -- leaving the build-time hide free to
        // disappear upstream while this assertion still passed.
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                node.left.name.text === member &&
                // Matched by TEXT rather than as an identifier: the cage
                // clears the flag on `c.meshes[1]!`, an element access,
                // where the widgets clear it on a plain local.
                node.left.expression.getText(
                    node.getSourceFile(),
                ) === local &&
                node.right.kind === ts.SyntaxKind.FalseKeyword
            ) {
                found = true;
                return;
            }
            if (ts.isFunctionLike(node)) return;
            node.forEachChild(visit);
        };
        for (const root of roots) {
            const body = ts.isFunctionLike(root)
                ? (root as ts.FunctionLikeDeclaration).body
                : root;
            if (body) body.forEachChild(visit);
        }
        if (!found) {
            this.context.contractError(
                roots[0]!,
                `Expected the pinned body to clear '${local}.${member}' ` +
                    "before any pointer event: this port builds only what " +
                    "a widget draws, and that part is reached by picking " +
                    "alone.",
            );
        }
    }

    /** One pinned mesh factory call bound to a local, as C++ arguments. */
    private widgetMesh(
        modulePath: string,
        holder: string,
        local: string,
        lowerer: PinnedNumericLowerer,
        guardName?: string,
        guardMode: "exclude" | "only" = "exclude",
    ): {
        options: ReadonlyMap<string, { cpp: string; node: ts.Expression }>;
        scalar: string | undefined;
        at: ts.Node;
        position: readonly string[];
        rotation: readonly string[];
        scaling: readonly string[];
    } {
        const { roots } = this.bodyScope(
            modulePath,
            holder,
            guardName,
            guardMode,
        );
        const initializer = this.context.unwrapExpression(
            this.localInitializer(roots, local),
        );
        if (!ts.isCallExpression(initializer)) {
            this.context.contractError(
                initializer,
                `Expected pinned '${local}' to be a mesh factory call.`,
            );
        }
        const argument = initializer.arguments[1];
        const options = new Map<
            string,
            { cpp: string; node: ts.Expression }
        >();
        let scalar: string | undefined;
        if (argument && ts.isObjectLiteralExpression(argument)) {
            for (const property of argument.properties) {
                // `{ tessellation }` is the pin's own shorthand for
                // `{ tessellation: tessellation }`, and the local it names
                // is one the emitted builder already carries.
                const value = ts.isPropertyAssignment(property)
                    ? property.initializer
                    : ts.isShorthandPropertyAssignment(property)
                      ? property.name
                      : undefined;
                const name = value
                    ? this.context.propertyName(property.name as ts.PropertyName)
                    : undefined;
                if (!value || !name) {
                    this.context.contractError(
                        property,
                        "Expected a pinned mesh factory option to be a " +
                            "plain named property assignment.",
                    );
                }
                options.set(name, {
                    cpp: lowerer.expression(value),
                    node: this.context.unwrapExpression(value),
                });
            }
        } else if (argument) {
            scalar = lowerer.expression(argument);
        }
        return {
            options,
            scalar,
            at: initializer,
            position: this.channel(roots, local, "position", lowerer, [
                "0.0",
                "0.0",
                "0.0",
            ]),
            rotation: this.channel(roots, local, "rotation", lowerer, [
                "0.0",
                "0.0",
                "0.0",
            ]),
            scaling: this.channel(roots, local, "scaling", lowerer, [
                "1.0",
                "1.0",
                "1.0",
            ]),
        };
    }

    /** A widget part's option, lowered, or a named failure. */
    private widgetOption(
        part: {
            options: ReadonlyMap<
                string,
                { cpp: string; node: ts.Expression }
            >;
            at: ts.Node;
        },
        name: string,
    ): string {
        const value = part.options.get(name);
        return (
            value?.cpp ??
            this.context.contractError(
                part.at,
                `Expected the pinned mesh factory to declare '${name}'.`,
            )
        );
    }

    /** `CylinderOptions{...}` for one pinned `createCylinder` call. */
    private widgetCylinder(part: {
        options: ReadonlyMap<string, { cpp: string; node: ts.Expression }>;
        at: ts.Node;
    }): string {
        const top = part.options.get("diameterTop");
        // The record carries the pin's own zero QUESTION, not just the
        // value: the builder reuses the previous ring's normals at a cone
        // tip only when the caller NAMED a zero top diameter.
        const namedZero =
            top !== undefined &&
            ts.isNumericLiteral(top.node) &&
            Number(top.node.text) === 0;
        return (
            `CylinderOptions{` +
            `${this.widgetOption(part, "height")}, ` +
            `${this.widgetOption(part, "diameterTop")}, ` +
            `${this.widgetOption(part, "diameterBottom")}, ` +
            `${this.widgetOption(part, "tessellation")}, ` +
            `1.0, ${namedZero ? "true" : "false"}}`
        );
    }

    /** One widget part as an `edit_gizmo_mesh(...)` call. */
    private widgetPart(
        factory: string,
        part: {
            position: readonly string[];
            rotation: readonly string[];
            scaling: readonly string[];
        },
        indent = "    ",
    ): string {
        return `${indent}edit_gizmo_mesh(
${indent}    engine,
${indent}    scene,
${indent}    ${factory},
${indent}    material,
${indent}    Vec3d{${part.position.join(", ")}},
${indent}    std::array<double, 3>{${part.rotation.join(", ")}},
${indent}    Vec3{${part.scaling
            .map((value) => `static_cast<float>(${value})`)
            .join(", ")}},
${indent}    root);`;
    }

    /**
     * The two `buildArrow`-shaped calls a widget makes: one rendered, one
     * an invisible collider. Only the first is built, and this asserts the
     * second is the collider and that the pin still hides every mesh it
     * makes -- so an upstream change that rendered one fails here.
     */
    private assertColliderArm(
        modulePath: string,
        factory: string,
        builder: string,
        colliderFlagIndex: number,
        locals: readonly string[],
        excludeGuard?: string,
    ): void {
        const declaration = this.context.functionDeclaration(
            modulePath,
            factory,
        ).declaration;
        const calls: ts.CallExpression[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === builder
            ) {
                calls.push(node);
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (
            calls.length !== 2 ||
            calls[0]!.arguments[colliderFlagIndex]?.kind !==
                ts.SyntaxKind.FalseKeyword ||
            calls[1]!.arguments[colliderFlagIndex]?.kind !==
                ts.SyntaxKind.TrueKeyword
        ) {
            this.context.contractError(
                declaration,
                `Expected pinned ${factory} to call ${builder} twice, ` +
                    "rendered then collider.",
            );
        }
        // Scoped the way the emitter is: `buildScaleArrow`'s `centered`
        // arm is dropped by `bodyScope`, and it hides the same locals, so
        // asserting over the whole declaration would let that arm answer
        // for the one this port keeps.
        const builderScope = this.bodyScope(
            modulePath,
            builder,
            excludeGuard,
        );
        for (const local of locals) {
            this.assertHidden(builderScope.roots, local);
        }
    }

    /**
     * The scale ratio each factory hands `attachFollowTarget`.
     *
     * Lowered rather than folded: the pin writes `1 / 3`, and the
     * division is what the follow multiplies by.
     */
    private followScaleRatio(
        modulePath: string,
        factory: string,
        lowerer: PinnedNumericLowerer,
    ): string {
        const declaration = this.context.functionDeclaration(
            modulePath,
            factory,
        ).declaration;
        const call = this.context.callExpression(
            declaration,
            "attachFollowTarget",
        );
        const ratio = call.arguments[3];
        if (!ratio) {
            this.context.contractError(
                declaration,
                `Expected pinned ${factory} to pass a scale ratio to ` +
                    "attachFollowTarget.",
            );
        }
        return lowerer.expression(ratio);
    }

    /** The root's own creation scaling, as the pinned body sets it. */
    private rootScaling(
        modulePath: string,
        factory: string,
        lowerer: PinnedNumericLowerer,
    ): readonly string[] {
        return this.channel(
            this.context.functionDeclaration(modulePath, factory)
                .declaration,
            "root",
            "scaling",
            lowerer,
            ["1.0", "1.0", "1.0"],
        );
    }

    /**
     * The shared half of an editing widget: the pin's own material
     * builder, the root node, one part, and the record plus the follow.
     *
     * `createGizmoMaterials` makes three -- coloured, hover and disabled
     * -- and only the coloured one is ever assigned to a mesh outside a
     * pointer callback, so only it is built. Its two colours are the pin's
     * own expressions: the diffuse is the colour, and the specular is the
     * colour minus the pin's own offset, unclamped, read out of that
     * array literal rather than restated here.
     */
    private editGizmoRuntime(): string {
        const file = this.context.sourceFile(CORE_MODULE);
        const declaration = this.context.functionDeclaration(
            CORE_MODULE,
            "createGizmoMaterials",
        ).declaration;
        let specular: ts.ArrayLiteralExpression | undefined;
        this.context.hasNode(declaration, (node) => {
            if (
                !specular &&
                ts.isBinaryExpression(node) &&
                ts.isPropertyAccessExpression(node.left) &&
                node.left.name.text === "specularColor" &&
                ts.isArrayLiteralExpression(
                    this.context.unwrapExpression(node.right),
                )
            ) {
                specular = this.context.unwrapExpression(
                    node.right,
                ) as ts.ArrayLiteralExpression;
            }
            return false;
        });
        if (!specular) {
            this.context.contractError(
                declaration,
                "Expected the pinned gizmo material builder to write a " +
                    "specular colour from the supplied one.",
            );
        }
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["color[0]", { cpp: "color.x", type: "scalar" }],
                ["color[1]", { cpp: "color.y", type: "scalar" }],
                ["color[2]", { cpp: "color.z", type: "scalar" }],
            ]),
            calls: new Map(),
        });
        const components = specular.elements.map((element) =>
            lowerer.expression(element),
        );
        if (components.length !== 3) {
            this.context.contractError(
                specular,
                "Expected the pinned gizmo specular colour to have three " +
                    "components.",
            );
        }
        return `// ${this.context.provenance(
            CORE_MODULE,
            "createGizmoMaterials",
        )}
MaterialHandle gizmo_material(
    Engine& engine,
    Vec3d color,
    bool double_sided) {
    const MaterialHandle material = create_standard_material(engine);
    MaterialRecord& record = engine.materials[material.value];
    record.diffuse_color = Color3{
        static_cast<float>(color.x),
        static_cast<float>(color.y),
        static_cast<float>(color.z)};
    record.specular_color = Color3{
        static_cast<float>(${components[0]}),
        static_cast<float>(${components[1]}),
        static_cast<float>(${components[2]})};
    // \`backFaceCulling === false\` is the native \`double_sided\`, which is
    // the pipeline's cull state and nothing else.
    record.double_sided = double_sided;
    return material;
}

/** A widget's root: a node at the origin, oriented onto its axis. */
TransformNodeHandle edit_gizmo_root(
    Engine& engine,
    Scene& scene,
    const std::array<double, 4>& rotation,
    Vec3 scaling) {
    const TransformNodeHandle root = create_transform_node(
        engine,
        "gizmoRoot",
        Vec3d{0.0, 0.0, 0.0},
        Vec4{
            static_cast<float>(rotation[0]),
            static_cast<float>(rotation[1]),
            static_cast<float>(rotation[2]),
            static_cast<float>(rotation[3])},
        scaling);
    add_to_scene(scene, root);
    return root;
}

/** One rendered widget part, placed the way the pinned body places it. */
void edit_gizmo_mesh(
    Engine& engine,
    Scene& scene,
    MeshHandle mesh,
    MaterialHandle material,
    Vec3d position,
    const std::array<double, 3>& rotation,
    Vec3 scaling,
    TransformNodeHandle parent) {
    engine.meshes[mesh.value].material = material;
    add_to_scene(scene, mesh);
    // The pin writes \`mesh.rotation\`, which is a BJS Euler triple; the
    // quaternion helper above is the pin's own conversion for it.
    place_mesh(
        engine,
        mesh,
        position,
        scaling,
        quat_from_bjs_euler(rotation[0], rotation[1], rotation[2]),
        parent);
}

/**
 * The record and the per-frame follow (gizmo-core.ts
 * \`attachFollowTarget\`): the attached node's world translation onto the
 * root, and the root scaled by the gizmo's PROJECTED depth along the
 * utility camera's forward axis times the widget's scale ratio -- not the
 * Euclidean distance, which over-scales an off-centre widget.
 */
EditGizmoHandle push_edit_gizmo(
    Engine& engine,
    Scene& scene,
    UtilityLayerHandle layer,
    TransformNodeHandle root,
    double scale_ratio,
    Vec3d local_axis,
    const std::array<double, 4>& baked_rotation,
    GizmoLocalOrientation orientation) {
    EditGizmoRecord gizmo;
    gizmo.root = root;
    gizmo.scale_ratio = scale_ratio;
    gizmo.local_axis = local_axis;
    gizmo.baked_rotation = baked_rotation;
    gizmo.orientation = orientation;
    engine.edit_gizmos.push_back(gizmo);
    const EditGizmoHandle handle{
        static_cast<std::uint32_t>(engine.edit_gizmos.size() - 1u)};
    Engine* live_engine = &engine;
    on_before_render(scene, [live_engine, handle, layer](float) {
        Engine& e = *live_engine;
        EditGizmoRecord& g = e.edit_gizmos[handle.value];
        if (g.attached_node.value >= e.meshes.size()) return;
        const std::array<float, 16> wm = upstream::mesh_world_matrix(
            e,
            e.meshes[g.attached_node.value]);
        const double tx = static_cast<double>(wm[12]);
        const double ty = static_cast<double>(wm[13]);
        const double tz = static_cast<double>(wm[14]);
        set_transform_node_position(e, g.root, Vec3d{tx, ty, tz});
        Scene& utility = utility_layer_scene(e, layer);
        if (utility.camera.value >= e.cameras.size()) return;
        const std::array<float, 16> cw =
            upstream::camera_world_matrix(e.cameras[utility.camera.value]);
        const double ox = tx - static_cast<double>(cw[12]);
        const double oy = ty - static_cast<double>(cw[13]);
        const double oz = tz - static_cast<double>(cw[14]);
        const double dist =
            (ox * static_cast<double>(cw[8]) +
             oy * static_cast<double>(cw[9]) +
             oz * static_cast<double>(cw[10])) *
            g.scale_ratio;
        set_transform_node_scaling(
            e,
            g.root,
            Vec3{
                static_cast<float>(dist),
                static_cast<float>(dist),
                static_cast<float>(dist)});
        // \`attachFollowTarget\`'s \`onAfterFollow\`: the widget's
        // local-coordinate arm, which every composite reaches at load.
        // The three drag and rotation widgets re-take the pin's
        // shortest-arc \`lookAtQuat\` of the transformed axis; the scale
        // widget's cube is not roll-symmetric, so it composes the node's
        // world rotation onto the orientation baked at creation.
        //
        // The non-local arm writes that baked orientation unconditionally
        // where the pin writes it only when its stored world axis has
        // moved. Outside local mode the value IS baked_rotation, which
        // edit_gizmo_root already put on the root at creation, so the
        // write would be a no-op that still costs a full subtree dirty
        // walk every frame -- a third one, after the position and scale
        // above. Skipped instead.
        if (!g.use_local_coordinates) return;
        std::array<double, 4> rotation = g.baked_rotation;
        {
            if (
                g.orientation ==
                GizmoLocalOrientation::compose_baked_rotation) {
                const PinnedQuat node_rotation =
                    ${PINNED_DECOMPOSE_ROTATION}(wm);
                rotation = quat_mul(
                    node_rotation.x,
                    node_rotation.y,
                    node_rotation.z,
                    node_rotation.w,
                    g.baked_rotation[0],
                    g.baked_rotation[1],
                    g.baked_rotation[2],
                    g.baked_rotation[3]);
            } else {
                rotation = look_at_quat(
                    transform_direction_by_world(wm, g.local_axis));
            }
        }
        set_transform_node_rotation_quaternion(
            e,
            g.root,
            Vec4{
                static_cast<float>(rotation[0]),
                static_cast<float>(rotation[1]),
                static_cast<float>(rotation[2]),
                static_cast<float>(rotation[3])});
    });
    return handle;
}`;
    }

    /** The four editing widgets' builders, as one C++ block. */
    private editGizmos(): string {
        // Every one of the four attaches the same way upstream -- bind the
        // node, enable the drag -- so one generated entry point serves all
        // four, and a pin that changed one of the bodies fails here.
        const attachBodies = EDIT_MODULES.map(({ modulePath, attach }) =>
            this.context
                .functionDeclaration(modulePath, attach)
                .declaration.body!.getText(
                    this.context.sourceFile(modulePath),
                ),
        );
        if (
            new Set(
                attachBodies.map((body) =>
                    body.replace(/\s+/g, " ").trim(),
                ),
            ).size !== 1
        ) {
            this.context.contractError(
                this.context.functionDeclaration(
                    AXIS_DRAG_MODULE,
                    "attachAxisDragGizmoToNode",
                ).declaration,
                "Expected the four pinned gizmo attach bodies to agree; " +
                    "one generated entry point serves all four.",
            );
        }
        // Every pinned factory hides its own root, and that
        // invisibility is the whole premise of substituting a transform
        // node for the pin's zero-height cylinder: a root that started
        // drawing would be a mesh this port does not create. Asserted
        // here rather than assumed.
        for (const { modulePath, factory } of EDIT_MODULES) {
            this.assertHidden(
                this.context.functionDeclaration(modulePath, factory)
                    .declaration,
                "root",
            );
        }
        return [
            this.axisDragGizmo(),
            this.axisScaleGizmo(),
            this.planeDragGizmo(),
            this.planeRotationGizmo(),
            ...this.reachedComposites().map((composite) =>
                this.compositeGizmo(composite),
            ),
        ].join("\n\n");
    }

    /**
     * The pinned fan-out members one composite entry point names, in the
     * order it names them.
     *
     * Both fan-outs are a list of `gizmo.<sub>` reads, and which subs each
     * one covers is the contract the emitted record's two counts carry --
     * the attach reaches every sub-gizmo, the coordinate-mode setter
     * reaches every one but the scale composite's central uniform handle.
     */
    private compositeFanOut(
        symbolName: string,
        parts: readonly string[],
    ): readonly string[] {
        const declaration = this.context.functionDeclaration(
            COMPOSITE_MODULE,
            symbolName,
        ).declaration;
        const named: string[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "gizmo" &&
                parts.includes(node.name.text) &&
                !named.includes(node.name.text)
            ) {
                named.push(node.name.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        return named;
    }

    /** One sub-widget call inside a pinned composite factory. */
    private compositeSubGizmo(
        widget: EditModule,
        call: ts.CallExpression,
        lowerer: PinnedNumericLowerer,
    ): string {
        if (call.arguments.length !== 3) {
            this.context.contractError(
                call,
                `Expected the pinned composite to call ${widget.factory} ` +
                    "with an engine, a layer and one options object.",
            );
        }
        const options = this.context.unwrapExpression(call.arguments[2]!);
        if (!ts.isObjectLiteralExpression(options)) {
            this.context.contractError(
                options,
                `Expected the pinned ${widget.factory} call to take an ` +
                    "options object literal.",
            );
        }
        const member = (name: string): ts.Expression | undefined => {
            for (const property of options.properties) {
                const propertyName =
                    ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(property)
                        ? this.context.propertyName(property.name)
                        : undefined;
                if (propertyName !== name) continue;
                return ts.isPropertyAssignment(property)
                    ? property.initializer
                    : (property.name as ts.Expression);
            }
            return undefined;
        };
        for (const property of options.properties) {
            const propertyName =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? this.context.propertyName(property.name)
                    : undefined;
            if (
                !propertyName ||
                (propertyName !== widget.axis &&
                    !widget.options.includes(propertyName))
            ) {
                this.context.contractError(
                    property,
                    `The pinned composite passes ${widget.factory} an ` +
                        "option this port does not serve; the generated " +
                        "widget would ignore it.",
                );
            }
        }
        const axis = member(widget.axis);
        if (!axis) {
            this.context.contractError(
                options,
                `Expected the pinned composite to give ${widget.factory} ` +
                    `its ${widget.axis}.`,
            );
        }
        const supplied = widget.options.map((name) => {
            const value = member(name);
            if (name === "color") {
                return value
                    ? `std::optional<Vec3d>{Vec3d{${lowerTupleComponents(
                          this.context,
                          lowerer,
                          value,
                          { arity: 3, at: options },
                      ).join(", ")}}}`
                    : "std::optional<Vec3d>{}";
            }
            if (name === "uniformScaling") {
                if (!value) return "std::optional<bool>{}";
                const flag = this.context.unwrapExpression(value);
                if (
                    flag.kind !== ts.SyntaxKind.TrueKeyword &&
                    flag.kind !== ts.SyntaxKind.FalseKeyword
                ) {
                    this.context.contractError(
                        flag,
                        "Expected the pinned composite to select the " +
                            "uniform-scale handle with a boolean literal.",
                    );
                }
                return `std::optional<bool>{${
                    flag.kind === ts.SyntaxKind.TrueKeyword
                        ? "true"
                        : "false"
                }}`;
            }
            return value
                ? `std::optional<double>{${lowerer.expression(value)}}`
                : "std::optional<double>{}";
        });
        // The argument list is joined on a placeholder the statement
        // emitter replaces with its own indent, so a sub-gizmo built
        // inside the optional arm lines up with it.
        return [
            `${widget.cppFactory}(`,
            "engine,",
            "layer,",
            `Vec3d{${lowerObjectComponents(
                this.context,
                lowerer,
                axis,
                ["x", "y", "z"],
            ).join(", ")}}${supplied.length > 0 ? "," : ")"}`,
            ...supplied.map(
                (argument, index) =>
                    `${argument}${
                        index === supplied.length - 1 ? ")" : ","
                    }`,
            ),
        ].join(ARGUMENT_BREAK);
    }

    /**
     * One composite, folded from the pinned factory that assembles it.
     *
     * The composite IS its statement list -- resolve the options, build
     * the sub-widgets, turn the coordinate mode on where the pin turns it
     * on, and return the record -- so the emitted body is that list,
     * statement for statement. `wireCrossAxisDisable` is the one the
     * emitted body drops: it subscribes drag observers that grey the
     * sibling axes out, and pointer drag is not reached.
     */
    private compositeGizmo(composite: CompositeModule): string {
        const file = this.context.sourceFile(COMPOSITE_MODULE);
        const declaration = this.context.functionDeclaration(
            COMPOSITE_MODULE,
            composite.factory,
        ).declaration;
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["Math.PI", { cpp: "pi_double", type: "scalar" }],
                ...composite.options.map(
                    ({ pinned, cpp }): [string, PinnedBinding] => [
                        pinned,
                        { cpp, type: "scalar" },
                    ],
                ),
            ]),
            calls: pinnedNumericMathCallsWithHypot(),
        });
        const prologue: string[] = [];
        /** The C++ type each option's `value_or` resolves to. */
        const optionTypes = new Map<string, string>();
        const parts: {
            local: string;
            guard: string | undefined;
            cpp: string;
        }[] = [];
        const tail: string[] = [];
        for (const statement of declaration.body!.statements) {
            if (ts.isVariableStatement(statement)) {
                for (const binding of statement.declarationList
                    .declarations) {
                    if (
                        !ts.isIdentifier(binding.name) ||
                        !binding.initializer
                    ) {
                        this.context.contractError(
                            binding,
                            "Expected a pinned composite local to be a " +
                                "plain named declaration.",
                        );
                    }
                    const local = binding.name.text;
                    const initializer = this.context.unwrapExpression(
                        binding.initializer,
                    );
                    const coalesce =
                        this.context.nullishDefault(initializer);
                    if (coalesce) {
                        const option = composite.options.find(
                            ({ pinned }) => pinned === local,
                        );
                        if (!option) {
                            this.context.contractError(
                                binding,
                                `The pinned ${composite.factory} defaults ` +
                                    `an option '${local}' the generated ` +
                                    "factory does not take.",
                            );
                        }
                        const right = this.context.unwrapExpression(
                            coalesce.right,
                        );
                        const flag =
                            right.kind === ts.SyntaxKind.TrueKeyword ||
                            right.kind === ts.SyntaxKind.FalseKeyword;
                        optionTypes.set(
                            option.cpp,
                            flag ? "bool" : "double",
                        );
                        prologue.push(
                            flag
                                ? `    const bool ${option.cpp} = ` +
                                      `${option.cpp}_option.value_or(` +
                                      `${
                                          right.kind ===
                                          ts.SyntaxKind.TrueKeyword
                                              ? "true"
                                              : "false"
                                      });`
                                : `    const double ${option.cpp} = ` +
                                      `${option.cpp}_option.value_or(` +
                                      `${this.context.doubleLiteral(
                                          this.context.numericValue(
                                              right,
                                              file,
                                          ),
                                      )});`,
                        );
                        continue;
                    }
                    let guard: string | undefined;
                    let call = initializer;
                    if (ts.isConditionalExpression(initializer)) {
                        if (
                            !ts.isIdentifier(initializer.condition) ||
                            this.context.unwrapExpression(
                                initializer.whenFalse,
                            ).kind !== ts.SyntaxKind.NullKeyword
                        ) {
                            this.context.contractError(
                                initializer,
                                "Expected a pinned optional sub-gizmo to " +
                                    "be one flag selecting the factory or " +
                                    "null.",
                            );
                        }
                        guard = initializer.condition.text;
                        call = this.context.unwrapExpression(
                            initializer.whenTrue,
                        );
                    }
                    const widget =
                        ts.isCallExpression(call) &&
                        ts.isIdentifier(call.expression)
                            ? EDIT_MODULES.find(
                                  ({ factory }) =>
                                      factory ===
                                      (
                                          call as ts.CallExpression
                                      ).expression.getText(file),
                              )
                            : undefined;
                    if (!widget || !ts.isCallExpression(call)) {
                        this.context.contractError(
                            binding,
                            `Expected ${composite.factory} to bind each ` +
                                "local to one of the four pinned editing " +
                                "widgets.",
                        );
                    }
                    parts.push({
                        local,
                        guard,
                        cpp: this.compositeSubGizmo(
                            widget,
                            call,
                            lowerer,
                        ),
                    });
                }
                continue;
            }
            if (ts.isExpressionStatement(statement)) {
                const expression = this.context.unwrapExpression(
                    statement.expression,
                );
                if (
                    ts.isBinaryExpression(expression) &&
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(expression.left) &&
                    expression.left.name.text === "useLocalCoordinates" &&
                    ts.isIdentifier(expression.left.expression)
                ) {
                    const owner = expression.left.expression.text;
                    const index = parts.findIndex(
                        ({ local }) => local === owner,
                    );
                    const right = this.context.unwrapExpression(
                        expression.right,
                    );
                    if (
                        index < 0 ||
                        (right.kind !== ts.SyntaxKind.TrueKeyword &&
                            right.kind !== ts.SyntaxKind.FalseKeyword)
                    ) {
                        this.context.contractError(
                            expression,
                            "Expected a pinned composite coordinate-mode " +
                                "seed to set one of its own sub-gizmos " +
                                "from a boolean literal.",
                        );
                    }
                    tail.push(
                        `    set_edit_gizmo_local_coordinates(\n` +
                            `        engine,\n` +
                            `        gizmo.parts[${index}],\n` +
                            `        ${
                                right.kind === ts.SyntaxKind.TrueKeyword
                                    ? "true"
                                    : "false"
                            });`,
                    );
                    continue;
                }
                if (
                    ts.isCallExpression(expression) &&
                    ts.isIdentifier(expression.expression) &&
                    expression.expression.text === "wireCrossAxisDisable"
                ) {
                    // Drag observers only: the pin subscribes each
                    // sub-gizmo's `onDragStart`/`onDragEnd` so the other
                    // axes grey out while one is dragged, and pointer drag
                    // is not reached.
                    continue;
                }
            }
            if (ts.isReturnStatement(statement)) {
                continue;
            }
            this.context.contractError(
                statement,
                `Expected ${composite.factory} to resolve its options, ` +
                    "build its sub-gizmos and return them.",
            );
        }
        const locals = parts.map(({ local }) => local);
        const guarded = parts.filter(({ guard }) => guard !== undefined);
        const guards = new Set(guarded.map(({ guard }) => guard!));
        if (
            guards.size > 1 ||
            parts.slice(parts.length - guarded.length).length !==
                guarded.length ||
            guarded.some(
                (part, index) =>
                    parts[parts.length - guarded.length + index] !== part,
            )
        ) {
            this.context.contractError(
                declaration,
                `Expected ${composite.factory}'s optional sub-gizmos to ` +
                    "share one flag and come last.",
            );
        }
        const attached = this.compositeFanOut(composite.attach, locals);
        if (attached.length !== locals.length) {
            this.context.contractError(
                declaration,
                `Expected ${composite.attach} to reach every sub-gizmo.`,
            );
        }
        const local = this.compositeFanOut(composite.setLocal, locals);
        if (
            local.some((name, index) => locals[index] !== name) ||
            (local.length !== locals.length && guarded.length > 0)
        ) {
            this.context.contractError(
                declaration,
                `Expected ${composite.setLocal} to reach a leading run of ` +
                    `${composite.factory}'s own sub-gizmos.`,
            );
        }
        const unguarded = parts.length - guarded.length;
        const emitPart = (index: number, indent: string): string =>
            `${indent}gizmo.parts[${index}] = ${parts[index]!.cpp
                .split(ARGUMENT_BREAK)
                .join(`\n${indent}    `)};`;
        const body = [
            ...prologue,
            "    CompositeGizmoHandle gizmo;",
            ...parts
                .slice(0, unguarded)
                .map((_, index) => emitPart(index, "    ")),
            `    gizmo.part_count = ${unguarded}u;`,
            ...(guarded.length > 0
                ? [
                      `    if (${
                          composite.options.find(
                              ({ pinned }) => pinned === [...guards][0]!,
                          )?.cpp ?? [...guards][0]!
                      }) {`,
                      ...guarded.map((_, offset) =>
                          emitPart(unguarded + offset, "        "),
                      ),
                      `        gizmo.part_count = ${parts.length}u;`,
                      "    }",
                  ]
                : []),
            ...tail,
            local.length === locals.length
                ? "    gizmo.local_coordinate_count = gizmo.part_count;"
                : `    gizmo.local_coordinate_count = ${local.length}u;`,
            "    return gizmo;",
        ].join("\n");
        return `// ${this.context.provenance(
            COMPOSITE_MODULE,
            composite.factory,
        )}
CompositeGizmoHandle ${composite.cppFactory}(
    Engine& engine,
    UtilityLayerHandle layer${composite.options
        .map(
            ({ cpp, pinned }) =>
                `,\n    std::optional<${
                    optionTypes.get(cpp) ??
                    this.context.contractError(
                        declaration,
                        `Expected ${composite.factory} to default ` +
                            `'${pinned}' through a nullish coalesce.`,
                    )
                }> ${cpp}_option`,
        )
        .join("")}) {
${body}
}`;
    }

    private axisDragGizmo(): string {
        const file = this.context.sourceFile(AXIS_DRAG_MODULE);
        const factory = this.context.functionDeclaration(
            AXIS_DRAG_MODULE,
            "createAxisDragGizmo",
        ).declaration;
        const thickness = this.optionDefault(factory, "thickness", file);
        const color = this.context
            .numericTuple(
                this.context.nullishDefault(
                    this.localInitializer(factory, "color"),
                )!.right,
                file,
            )
            .map((component) => this.context.doubleLiteral(component));
        const arrow = this.widgetLowerer(
            AXIS_DRAG_MODULE,
            new Map([["thickness", "thickness"]]),
        );
        const cone = this.widgetMesh(
            AXIS_DRAG_MODULE,
            "buildArrow",
            "cone",
            arrow,
        );
        const line = this.widgetMesh(
            AXIS_DRAG_MODULE,
            "buildArrow",
            "line",
            arrow,
        );
        this.assertColliderArm(
            AXIS_DRAG_MODULE,
            "createAxisDragGizmo",
            "buildArrow",
            5,
            ["cone", "line"],
        );
        const rootScale = this.rootScaling(
            AXIS_DRAG_MODULE,
            "createAxisDragGizmo",
            this.widgetLowerer(AXIS_DRAG_MODULE, new Map()),
        );
        return `// ${this.context.provenance(
            AXIS_DRAG_MODULE,
            "createAxisDragGizmo",
        )}
EditGizmoHandle create_axis_drag_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d drag_axis,
    std::optional<Vec3d> color,
    std::optional<double> thickness_option) {
    Scene& scene = layer_record(engine, layer).scene;
    const double thickness = thickness_option.value_or(${this.context.doubleLiteral(
        thickness,
    )});
    const MaterialHandle material = gizmo_material(
        engine, color.value_or(Vec3d{${color.join(", ")}}), false);
    const std::array<double, 4> baked = look_at_quat(drag_axis);
    const TransformNodeHandle root = edit_gizmo_root(
        engine,
        scene,
        baked,
        Vec3{${rootScale
            .map((value) => `static_cast<float>(${value})`)
            .join(", ")}});
${this.widgetPart(
    `create_cylinder(engine, ${this.widgetCylinder(cone)})`,
    cone,
)}
${this.widgetPart(
    `create_cylinder(engine, ${this.widgetCylinder(line)})`,
    line,
)}
    return push_edit_gizmo(
        engine,
        scene,
        layer,
        root,
        ${this.followScaleRatio(
            AXIS_DRAG_MODULE,
            "createAxisDragGizmo",
            arrow,
        )},
        ${this.widgetLocalAxis(
            AXIS_DRAG_MODULE,
            "createAxisDragGizmo",
            "localAxis",
            "dragAxis",
            "drag_axis",
        )},
        baked,
        GizmoLocalOrientation::look_at_world_axis);
}`;
    }

    private axisScaleGizmo(): string {
        const file = this.context.sourceFile(AXIS_SCALE_MODULE);
        const factory = this.context.functionDeclaration(
            AXIS_SCALE_MODULE,
            "createAxisScaleGizmo",
        ).declaration;
        const thickness = this.optionDefault(factory, "thickness", file);
        const uniformScalingDefault = this.optionDefaultFlag(
            factory,
            "uniformScaling",
        );
        const color = this.context
            .numericTuple(
                this.context.nullishDefault(
                    this.localInitializer(factory, "color"),
                )!.right,
                file,
            )
            .map((component) => this.context.doubleLiteral(component));
        const arrow = this.widgetLowerer(
            AXIS_SCALE_MODULE,
            new Map([["thickness", "thickness"]]),
        );
        const head = this.widgetMesh(
            AXIS_SCALE_MODULE,
            "buildScaleArrow",
            "head",
            arrow,
            "centered",
        );
        const tail = this.widgetMesh(
            AXIS_SCALE_MODULE,
            "buildScaleArrow",
            "tail",
            arrow,
            "centered",
        );
        this.assertColliderArm(
            AXIS_SCALE_MODULE,
            "createAxisScaleGizmo",
            "buildScaleArrow",
            5,
            ["head", "tail"],
            // The pin hides `head` in its `centered` arm too, and this
            // port drops that arm; excluding it here is what makes the
            // assertion anchor the arrow arm it actually emits.
            "centered",
        );
        // The uniform-scale handle is the pin's own `centered` arm, and
        // `uniformScaling` is what selects it. Asserted rather than
        // assumed: a pin that moved the octahedron out from behind that
        // guard would change which handle each arm builds.
        const centeredGuard = this.context.hasNode(
            this.context.functionDeclaration(
                AXIS_SCALE_MODULE,
                "buildScaleArrow",
            ).declaration,
            (node) =>
                ts.isIfStatement(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "centered" &&
                this.context.hasNode(
                    node.thenStatement,
                    (inner) =>
                        ts.isCallExpression(inner) &&
                        ts.isIdentifier(inner.expression) &&
                        inner.expression.text === "createPolyhedron",
                ),
        );
        if (!centeredGuard) {
            this.context.contractError(
                factory,
                "Expected the pinned uniform-scale octahedron to stay " +
                    "behind buildScaleArrow's `centered` guard.",
            );
        }
        const rootScale = this.rootScaling(
            AXIS_SCALE_MODULE,
            "createAxisScaleGizmo",
            this.widgetLowerer(AXIS_SCALE_MODULE, new Map()),
        );
        const size = head.scalar;
        if (size === undefined) {
            this.context.contractError(
                head.at,
                "Expected the pinned scale head to be a box sized by one " +
                    "scalar.",
            );
        }
        // The uniform-scale handle: `buildScaleArrow`'s own `centered`
        // arm, an octahedron at the gizmo origin with no tail. Read from
        // that arm rather than the arrow one, which shares its local
        // names.
        const uniformHead = this.widgetMesh(
            AXIS_SCALE_MODULE,
            "buildScaleArrow",
            "head",
            arrow,
            "centered",
            "only",
        );
        this.assertHidden(
            this.bodyScope(
                AXIS_SCALE_MODULE,
                "buildScaleArrow",
                "centered",
                "only",
            ).roots,
            "head",
        );
        const uniformType = this.widgetOptionNumber(uniformHead, "type");
        const preset = pinnedPolyhedron(uniformType);
        const polyhedronRows = (
            table: readonly (readonly number[])[],
        ): string =>
            `{${table
                .map(
                    (row) =>
                        `{${row
                            .map((value) =>
                                this.context.doubleLiteral(value),
                            )
                            .join(", ")}}`,
                )
                .join(", ")}}`;
        // The pinned octahedron passes no `flat`, so the emitted record
        // carries `createPolyhedronData`'s own default for it.
        const uniformFlat = pinnedMeshOptionFlag(
            POLYHEDRON_MODULE,
            "createPolyhedronData",
            "flat",
        );
        // The root's own orientation, which the uniform arm replaces with
        // the identity: BJS keeps the central handle world-aligned.
        const identityRotation = this.rootRotationQuaternion(
            AXIS_SCALE_MODULE,
            "createAxisScaleGizmo",
            "uniformScaling",
        );
        return `// ${this.context.provenance(
            AXIS_SCALE_MODULE,
            "createAxisScaleGizmo",
        )}
EditGizmoHandle create_axis_scale_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d drag_axis,
    std::optional<Vec3d> color,
    std::optional<double> thickness_option,
    std::optional<bool> uniform_scaling_option) {
    Scene& scene = layer_record(engine, layer).scene;
    const double thickness = thickness_option.value_or(${this.context.doubleLiteral(
        thickness,
    )});
    const bool uniform_scaling = uniform_scaling_option.value_or(${uniformScalingDefault});
    const MaterialHandle material = gizmo_material(
        engine, color.value_or(Vec3d{${color.join(", ")}}), false);
    // The pin bakes the axis lookAt ONCE through setDirection (yaw and
    // pitch, no roll) rather than the shortest-arc rotation the drag and
    // rotation widgets take: the scale cube is not roll-symmetric.
    const std::array<double, 4> baked =
        uniform_scaling
            ? std::array<double, 4>{${identityRotation.join(", ")}}
            : direction_to_quat(normalize_vec3(drag_axis));
    const TransformNodeHandle root = edit_gizmo_root(
        engine,
        scene,
        baked,
        Vec3{${rootScale
            .map((value) => `static_cast<float>(${value})`)
            .join(", ")}});
    if (uniform_scaling) {
        const double uniform_size = ${this.widgetOption(uniformHead, "size")};
${this.widgetPart(
    "create_polyhedron(engine, PolyhedronOptions{" +
        "uniform_size, uniform_size, uniform_size, " +
        `${uniformFlat ? "true" : "false"}, ` +
        `${polyhedronRows(preset.vertex)}, ` +
        `${polyhedronRows(preset.face)}})`,
    uniformHead,
    "        ",
)}
    } else {
        const double head_size = ${size};
${this.widgetPart(
    "create_box(engine, BoxOptions{" +
        "static_cast<float>(head_size), " +
        "static_cast<float>(head_size), " +
        "static_cast<float>(head_size)})",
    head,
    "        ",
)}
${this.widgetPart(
    `create_cylinder(engine, ${this.widgetCylinder(tail)})`,
    tail,
    "        ",
)}
    }
    return push_edit_gizmo(
        engine,
        scene,
        layer,
        root,
        ${this.followScaleRatio(
            AXIS_SCALE_MODULE,
            "createAxisScaleGizmo",
            arrow,
        )},
        ${this.widgetLocalAxis(
            AXIS_SCALE_MODULE,
            "createAxisScaleGizmo",
            "localAxis",
            "dragAxis",
            "drag_axis",
        )},
        baked,
        GizmoLocalOrientation::compose_baked_rotation);
}`;
    }

    private planeDragGizmo(): string {
        const file = this.context.sourceFile(PLANE_DRAG_MODULE);
        const factory = this.context.functionDeclaration(
            PLANE_DRAG_MODULE,
            "createPlaneDragGizmo",
        ).declaration;
        const color = this.context
            .numericTuple(
                this.context.nullishDefault(
                    this.localInitializer(factory, "color"),
                )!.right,
                file,
            )
            .map((component) => this.context.doubleLiteral(component));
        // The pin turns culling OFF on all three materials: the card is a
        // single quad and is looked at from both sides.
        if (
            !this.context.hasNode(
                factory,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    ts.isPropertyAccessExpression(node.left) &&
                    node.left.name.text === "backFaceCulling" &&
                    node.right.kind === ts.SyntaxKind.FalseKeyword,
            )
        ) {
            this.context.contractError(
                factory,
                "Expected the pinned plane-drag materials to clear " +
                    "backFaceCulling.",
            );
        }
        const lowerer = this.widgetLowerer(PLANE_DRAG_MODULE, new Map());
        const plane = this.widgetMesh(
            PLANE_DRAG_MODULE,
            "createPlaneDragGizmo",
            "plane",
            lowerer,
        );
        const rootScale = this.rootScaling(
            PLANE_DRAG_MODULE,
            "createPlaneDragGizmo",
            lowerer,
        );
        const size = this.widgetOption(plane, "size");
        return `// ${this.context.provenance(
            PLANE_DRAG_MODULE,
            "createPlaneDragGizmo",
        )}
EditGizmoHandle create_plane_drag_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d drag_plane_normal,
    std::optional<Vec3d> color) {
    Scene& scene = layer_record(engine, layer).scene;
    const MaterialHandle material = gizmo_material(
        engine, color.value_or(Vec3d{${color.join(", ")}}), true);
    const std::array<double, 4> baked = look_at_quat(drag_plane_normal);
    const TransformNodeHandle root = edit_gizmo_root(
        engine,
        scene,
        baked,
        Vec3{${rootScale
            .map((value) => `static_cast<float>(${value})`)
            .join(", ")}});
    const double plane_size = ${size};
${this.widgetPart(
    "create_plane(engine, PlaneOptions{" +
        "static_cast<float>(plane_size), " +
        "static_cast<float>(plane_size)})",
    plane,
)}
    return push_edit_gizmo(
        engine,
        scene,
        layer,
        root,
        ${this.followScaleRatio(
            PLANE_DRAG_MODULE,
            "createPlaneDragGizmo",
            lowerer,
        )},
        ${this.widgetLocalAxis(
            PLANE_DRAG_MODULE,
            "createPlaneDragGizmo",
            "localNormal",
            "dragPlaneNormal",
            "drag_plane_normal",
        )},
        baked,
        GizmoLocalOrientation::look_at_world_axis);
}`;
    }

    private planeRotationGizmo(): string {
        const file = this.context.sourceFile(PLANE_ROTATION_MODULE);
        const factory = this.context.functionDeclaration(
            PLANE_ROTATION_MODULE,
            "createPlaneRotationGizmo",
        ).declaration;
        const color = this.context
            .numericTuple(
                this.context.nullishDefault(
                    this.localInitializer(factory, "color"),
                )!.right,
                file,
            )
            .map((component) => this.context.doubleLiteral(component));
        const thickness = this.optionDefault(factory, "thickness", file);
        const tessellation = this.optionDefault(
            factory,
            "tessellation",
            file,
        );
        const lowerer = this.widgetLowerer(
            PLANE_ROTATION_MODULE,
            new Map([
                ["thickness", "thickness"],
                ["tessellation", "tessellation"],
            ]),
        );
        const ring = this.widgetMesh(
            PLANE_ROTATION_MODULE,
            "createPlaneRotationGizmo",
            "ring",
            lowerer,
        );
        // The thicker torus is the pick region and the camembert quad is
        // the drag readout; both are hidden at build time, and neither is
        // built here. A pin that showed either fails by name.
        this.assertHidden(factory, "collider");
        this.assertHidden(factory, "rotationDisplayPlane");
        const rootScale = this.rootScaling(
            PLANE_ROTATION_MODULE,
            "createPlaneRotationGizmo",
            lowerer,
        );
        return `// ${this.context.provenance(
            PLANE_ROTATION_MODULE,
            "createPlaneRotationGizmo",
        )}
EditGizmoHandle create_plane_rotation_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    Vec3d plane_normal,
    std::optional<Vec3d> color,
    std::optional<double> tessellation_option,
    std::optional<double> thickness_option) {
    Scene& scene = layer_record(engine, layer).scene;
    const double thickness = thickness_option.value_or(${this.context.doubleLiteral(
        thickness,
    )});
    const double tessellation = tessellation_option.value_or(${this.context.doubleLiteral(
        tessellation,
    )});
    const MaterialHandle material = gizmo_material(
        engine, color.value_or(Vec3d{${color.join(", ")}}), false);
    const Vec3d initial_normal = ${this.widgetLocalAxis(
        PLANE_ROTATION_MODULE,
        "createPlaneRotationGizmo",
        "initialNormal",
        "planeNormal",
        "plane_normal",
    )};
    const std::array<double, 4> baked = look_at_quat(plane_normal);
    const TransformNodeHandle root = edit_gizmo_root(
        engine,
        scene,
        baked,
        Vec3{${rootScale
            .map((value) => `static_cast<float>(${value})`)
            .join(", ")}});
${this.widgetPart(
    `create_torus(engine, TorusOptions{` +
        `${this.widgetOption(ring, "diameter")}, ` +
        `${this.widgetOption(ring, "thickness")}, ` +
        `static_cast<std::uint32_t>(${this.widgetOption(
            ring,
            "tessellation",
        )})})`,
    ring,
)}
    return push_edit_gizmo(
        engine,
        scene,
        layer,
        root,
        ${this.followScaleRatio(
            PLANE_ROTATION_MODULE,
            "createPlaneRotationGizmo",
            lowerer,
        )},
        ${this.widgetLocalAxis(
            PLANE_ROTATION_MODULE,
            "createPlaneRotationGizmo",
            "localNormal",
            "planeNormal",
            "plane_normal",
            new Map([["initialNormal", "initial_normal"]]),
        )},
        baked,
        GizmoLocalOrientation::look_at_world_axis);
}`;
    }

    /** Whether this scene reaches the bounding-box gizmo. */
    private reachesBoundingBox(): boolean {
        return this.features.includes("gizmo:bounding-box");
    }

    /**
     * The right side of the pin's own `options.<member> ?? [a, b, c]`.
     *
     * The tuple twin of `optionDefault`, for the one option in this family
     * whose default is a colour rather than a number.
     */
    private optionDefaultTuple(
        declaration: ts.Node,
        member: string,
        file: ts.SourceFile,
    ): readonly number[] {
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                ts.isPropertyAccessExpression(
                    this.context.unwrapExpression(node.left),
                ) &&
                (
                    this.context.unwrapExpression(
                        node.left,
                    ) as ts.PropertyAccessExpression
                ).name.text === member
            ) {
                found = node.right;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!found) {
            this.context.contractError(
                declaration,
                `Expected the pinned body to default '${member}' ` +
                    "through a nullish coalesce.",
            );
        }
        return this.context.numericTuple(found, file);
    }

    /**
     * The pinned `for (let i = 0; i < N; i++)` whose body pushes onto one
     * named list.
     *
     * How many edges, corners, rotation anchors and face handles the cage
     * has, and what each is named, are the pin's own -- read from that
     * loop rather than restated, which is what keeps the emitted record's
     * vectors and the layout's own indices in step with an upstream
     * change.
     */
    private pushedLoop(
        declaration: ts.Node,
        list: string,
    ): ts.ForStatement {
        let loop: ts.ForStatement | undefined;
        const visit = (node: ts.Node): void => {
            if (loop) return;
            if (
                ts.isForStatement(node) &&
                node.condition &&
                ts.isBinaryExpression(node.condition) &&
                node.condition.operatorToken.kind ===
                    ts.SyntaxKind.LessThanToken &&
                this.context.hasNode(
                    node.statement,
                    (inner) =>
                        ts.isCallExpression(inner) &&
                        ts.isPropertyAccessExpression(inner.expression) &&
                        inner.expression.name.text === "push" &&
                        ts.isIdentifier(inner.expression.expression) &&
                        inner.expression.expression.text === list,
                )
            ) {
                loop = node;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!loop) {
            this.context.contractError(
                declaration,
                `Expected the pinned body to fill '${list}' from a ` +
                    "counted for loop.",
            );
        }
        return loop;
    }

    /** One counted pinned loop's own bound. */
    private loopCount(loop: ts.ForStatement, file: ts.SourceFile): number {
        return this.context.numericValue(
            (loop.condition as ts.BinaryExpression).right,
            file,
        );
    }

    /** The pinned `<local>.<member> = "<text>"` a build performs. */
    private stringAssignment(
        scope: ts.Node,
        local: string,
        member: string,
    ): string {
        const file = scope.getSourceFile();
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                node.left.name.text === member &&
                node.left.expression.getText(file) === local
            ) {
                found = this.context.unwrapExpression(node.right);
            }
            ts.forEachChild(node, visit);
        };
        visit(scope);
        if (!found || !ts.isStringLiteral(found)) {
            this.context.contractError(
                found ?? scope,
                `Expected the pinned body to give '${local}' a literal ` +
                    `${member}.`,
            );
        }
        return found.text;
    }

    /**
     * One pinned material builder's writes, as native record stores.
     *
     * The cage has two materials and what makes each render the way it
     * does is exactly this list: the coloured one is unlit because the pin
     * writes an emissive white and clears lighting, and the body draws
     * nothing in the colour pass because the pin writes a zero alpha. Both
     * are READ here rather than restated, so a pin that dropped the
     * emissive would stop emitting it instead of quietly keeping a flat
     * widget upstream had started shading.
     */
    private materialWrites(
        scope: ts.Node,
        local: string,
        target: string,
        lowerer: PinnedNumericLowerer,
    ): string {
        const fields = new Map<string, "color3" | "number" | "boolean">([
            ["diffuseColor", "color3"],
            ["emissiveColor", "color3"],
            ["specularColor", "color3"],
            ["alpha", "number"],
            ["disableLighting", "boolean"],
        ]);
        const natives = new Map<string, string>([
            ["diffuseColor", "diffuse_color"],
            ["emissiveColor", "emissive_factor"],
            ["specularColor", "specular_color"],
            ["alpha", "alpha"],
            ["disableLighting", "disable_lighting"],
        ]);
        const lines: string[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === local
            ) {
                const member = node.left.name.text;
                const kind = fields.get(member);
                if (!kind) {
                    this.context.contractError(
                        node,
                        "The pinned bounding-box material writes " +
                            `'${member}', which this port does not carry ` +
                            "on a Standard material record.",
                    );
                }
                const value = this.context.unwrapExpression(node.right);
                if (kind === "boolean") {
                    if (
                        value.kind !== ts.SyntaxKind.TrueKeyword &&
                        value.kind !== ts.SyntaxKind.FalseKeyword
                    ) {
                        this.context.contractError(
                            node,
                            `Expected the pinned '${member}' write to be ` +
                                "a boolean literal.",
                        );
                    }
                    lines.push(
                        `    ${target}.${natives.get(member)!} = ` +
                            `${
                                value.kind === ts.SyntaxKind.TrueKeyword
                                    ? "true"
                                    : "false"
                            };`,
                    );
                } else if (kind === "number") {
                    lines.push(
                        `    ${target}.${natives.get(member)!} = ` +
                            "static_cast<float>(" +
                            `${lowerer.expression(value)});`,
                    );
                    if (member === "alpha") {
                        // The pin reads `mat.alpha < 1` live when it
                        // builds renderables, so writing the factor is
                        // what moves the material between the opaque and
                        // blended families -- through the same one home
                        // every other alpha write goes through, which is
                        // what makes the pin's zero-alpha body draw
                        // nothing in the colour pass.
                        lines.push(
                            `    derive_material_alpha_mode(${target});`,
                        );
                    }
                } else {
                    // A colour the pin spells out, or the resolved option
                    // it hands over whole -- which is the same value read
                    // lane by lane, because a native colour is three
                    // members where the pin's is three elements.
                    const components = ts.isArrayLiteralExpression(value)
                        ? value.elements.map((element) =>
                              lowerer.expression(element),
                          )
                        : ["x", "y", "z"].map(
                              (lane) =>
                                  `${lowerer.expression(value)}.${lane}`,
                          );
                    if (components.length !== 3) {
                        this.context.contractError(
                            node,
                            `Expected the pinned '${member}' write to be ` +
                                "a three-component colour.",
                        );
                    }
                    lines.push(
                        `    ${target}.${natives.get(member)!} = Color3{`,
                        ...components.map(
                            (component, lane) =>
                                `        static_cast<float>(${component})` +
                                `${lane === 2 ? "};" : ","}`,
                        ),
                    );
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(scope);
        if (lines.length === 0) {
            this.context.contractError(
                scope,
                `Expected the pinned body to configure '${local}'.`,
            );
        }
        return lines.join("\n");
    }

    /**
     * The pinned template-literal mesh name, as a native concatenation.
     *
     * Every part the cage builds is named from the pin's own
     * `bbox-<group>${i}` template inside its build loop, so the prefix is
     * read from that template rather than restated.
     */
    private loopMeshName(scope: ts.Node, local: string): string {
        const file = scope.getSourceFile();
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                node.left.name.text === "name" &&
                node.left.expression.getText(file) === local
            ) {
                found = this.context.unwrapExpression(node.right);
            }
            ts.forEachChild(node, visit);
        };
        visit(scope);
        if (
            !found ||
            !ts.isTemplateExpression(found) ||
            found.templateSpans.length !== 1 ||
            found.templateSpans[0]!.literal.text !== ""
        ) {
            this.context.contractError(
                found ?? scope,
                `Expected the pinned body to name '${local}' from a ` +
                    "template literal with one interpolated index.",
            );
        }
        const span = (found as ts.TemplateExpression).templateSpans[0]!;
        const index = this.context.unwrapExpression(span.expression);
        if (!ts.isIdentifier(index)) {
            this.context.contractError(
                span,
                "Expected the pinned mesh name to interpolate the " +
                    "build loop's own counter.",
            );
        }
        return (
            `"${(found as ts.TemplateExpression).head.text}" + ` +
            `std::to_string(${index.text})`
        );
    }

    /** The `const <name> = (...) => {...}` arrow inside one pinned body. */
    private arrowLocal(
        scope: ts.Node,
        name: string,
    ): ts.ArrowFunction {
        const initializer = this.context.unwrapExpression(
            this.localInitializer(scope, name),
        );
        if (!ts.isArrowFunction(initializer)) {
            this.context.contractError(
                initializer,
                `Expected the pinned body's '${name}' to be an arrow ` +
                    "function.",
            );
        }
        return initializer;
    }

    /** Every `createBox(engine, <size>)` in one pinned body, in order. */
    private boxSizes(
        scope: ts.Node,
        lowerer: PinnedNumericLowerer,
    ): string[] {
        const sizes: string[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "createBox"
            ) {
                if (node.arguments.length !== 2) {
                    this.context.contractError(
                        node,
                        "Expected the pinned box factory to take one size.",
                    );
                }
                sizes.push(lowerer.expression(node.arguments[1]!));
            }
            ts.forEachChild(node, visit);
        };
        visit(scope);
        return sizes;
    }

    /**
     * `rotatePoint`, the pin's own Vec3 wrapper over `rotateVec3ByQuat`.
     *
     * Lowered whole rather than restated, because the quaternion rotation
     * every cage coordinate passes through is this call and nothing else.
     */
    private loweredPinnedRotatePoint(file: ts.SourceFile): string {
        const declaration = this.context.functionDeclaration(
            BOUNDING_BOX_MODULE,
            "rotatePoint",
        ).declaration;
        let lowerer: PinnedNumericLowerer | undefined;
        const scope: PinnedNumericScope = {
            bindings: new Map<string, PinnedBinding>([
                ["q", { cpp: "q", type: "scalar" }],
                ["p.x", { cpp: "p.x", type: "scalar" }],
                ["p.y", { cpp: "p.y", type: "scalar" }],
                ["p.z", { cpp: "p.z", type: "scalar" }],
            ]),
            calls: new Map([
                [
                    "rotateVec3ByQuat",
                    (args: readonly string[]): string =>
                        `rotate_vec3_by_quat(${args.join(", ")})`,
                ],
            ]),
            tupleCalls: new Map([["rotateVec3ByQuat", 3]]),
            vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
            returnValue: (expression) =>
                expression
                    ? lowerer!.expression(expression)
                    : this.context.contractError(
                          declaration,
                          "Expected pinned rotatePoint to return a point.",
                      ),
        };
        lowerer = new PinnedNumericLowerer(file, scope);
        const body = declaration
            .body!.statements.flatMap((statement) =>
                lowerer!.statement(statement, "    "),
            )
            .join("\n");
        return `// ${this.context.provenance(
            BOUNDING_BOX_MODULE,
            "rotatePoint",
        )}
Vec3d bbox_rotate_point(const std::array<double, 4>& q, Vec3d p) {
${body}
}`;
    }

    /**
     * `computeAabb`'s WORLD arm: the fold every candidate mesh goes
     * through, lowered from the pinned body.
     *
     * The pinned function guards its two arms on whether a world matrix
     * was supplied and the cage always supplies one, so the arm that
     * transforms is the one emitted -- and it is asserted to be that
     * guard rather than assumed.
     */
    private loweredComputeAabb(): string {
        const { file, declaration } = this.context.functionDeclaration(
            COMPUTE_AABB_MODULE,
            "computeAabb",
        );
        if (
            declaration.parameters.length !== 2 ||
            (declaration.parameters[0]!.name as ts.Identifier).text !==
                "positions" ||
            (declaration.parameters[1]!.name as ts.Identifier).text !== "world"
        ) {
            this.context.contractError(
                declaration,
                "Expected pinned computeAabb to take (positions, world).",
            );
        }
        let lowerer: PinnedNumericLowerer | undefined;
        const scope: PinnedNumericScope = {
            bindings: new Map<string, PinnedBinding>([
                ["positions", { cpp: "positions", type: "scalar" }],
                [
                    "positions.length",
                    {
                        cpp: "static_cast<std::int64_t>(positions.size())",
                        type: "scalar",
                    },
                ],
                ["world", { cpp: "world", type: "scalar" }],
            ]),
            calls: new Map(),
            returnValue: (expression) => {
                const returned = expression
                    ? this.context.unwrapExpression(expression)
                    : undefined;
                if (
                    !returned ||
                    !ts.isArrayLiteralExpression(returned) ||
                    returned.elements.length !== 2
                ) {
                    return this.context.contractError(
                        declaration,
                        "Expected pinned computeAabb to return a min/max " +
                            "pair.",
                    );
                }
                const rows = returned.elements.map((row) => {
                    const literal = this.context.unwrapExpression(row);
                    if (
                        !ts.isArrayLiteralExpression(literal) ||
                        literal.elements.length !== 3
                    ) {
                        return this.context.contractError(
                            declaration,
                            "Expected each pinned AABB corner to have " +
                                "three components.",
                        );
                    }
                    return `{${literal.elements
                        .map((element) => lowerer!.expression(element))
                        .join(", ")}}`;
                });
                return `std::array<std::array<double, 3>, 2>{{${rows.join(
                    ", ",
                )}}}`;
            },
        };
        lowerer = new PinnedNumericLowerer(file, scope);
        const statements = declaration.body!.statements;
        const guard = statements.find(
            (statement): statement is ts.IfStatement =>
                ts.isIfStatement(statement) &&
                ts.isIdentifier(statement.expression) &&
                statement.expression.text === "world",
        );
        if (!guard || !ts.isBlock(guard.thenStatement)) {
            this.context.contractError(
                declaration,
                "Expected pinned computeAabb to guard its transforming " +
                    "arm on the supplied world matrix.",
            );
        }
        const body = statements
            .flatMap((statement) =>
                statement === guard
                    ? (guard.thenStatement as ts.Block).statements.flatMap(
                          (inner) => lowerer!.statement(inner, "    "),
                      )
                    : lowerer!.statement(statement, "    "),
            )
            .join("\n");
        return `// ${this.context.provenance(
            COMPUTE_AABB_MODULE,
            "computeAabb",
        )}
std::array<std::array<double, 3>, 2> bbox_compute_aabb(
    const BoundingBoxPositions& positions,
    const std::array<float, 16>& world) {
${body}
}`;
    }

    /** `mat4FromQuat`, over the pinned compose the loader also uses. */
    private loweredMat4FromQuat(file: ts.SourceFile): string {
        const declaration = this.context.functionDeclaration(
            MAT4_FROM_QUAT_MODULE,
            "mat4FromQuat",
        ).declaration;
        const call = this.context.callExpression(
            declaration,
            "mat4ComposeInto",
        );
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>(
                ["qx", "qy", "qz", "qw"].map((name): [
                    string,
                    PinnedBinding,
                ] => [name, { cpp: name, type: "scalar" }]),
            ),
            calls: new Map(),
        });
        const allocated = this.context.unwrapExpression(call.arguments[0]!);
        if (!ts.isIdentifier(allocated)) {
            this.context.contractError(
                call,
                "Expected pinned mat4FromQuat to compose into a local " +
                    "matrix it allocated.",
            );
        }
        const target = allocated.text;
        const supplied = call.arguments
            .slice(1)
            .map((argument) => lowerer.expression(argument));
        return `// ${this.context.provenance(
            MAT4_FROM_QUAT_MODULE,
            "mat4FromQuat",
        )}
std::array<float, 16> bbox_mat4_from_quat(
    double qx,
    double qy,
    double qz,
    double qw) {
    // The pin allocates its matrix at f32 width, which is where every
    // store below rounds.
    std::array<float, 16> ${target}{};
    mat4_compose_into(${target}, ${supplied.join(", ")});
    return ${target};
}`;
    }

    /**
     * The arguments the pinned refresh takes the node's rotation through
     * to get its inverse -- the conjugate, which is the one thing about
     * the bounds frame that is not obvious from the call site.
     */
    private refreshInverseArguments(
        factory: ts.Node,
        file: ts.SourceFile,
    ): string {
        const call = this.context.callExpression(factory, "mat4FromQuat");
        if (call.arguments.length !== 4) {
            this.context.contractError(
                call,
                "Expected the pinned refresh to build its inverse frame " +
                    "from four quaternion lanes.",
            );
        }
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["q", { cpp: "q", type: "scalar" }],
            ]),
            calls: new Map(),
        });
        return call.arguments
            .map((argument) => lowerer.expression(argument))
            .join(", ");
    }

    /**
     * One pinned arrow body, lowered whole through the shared translator.
     *
     * The four placement callbacks the cage builds are closures over the
     * mesh they were made for, so the emitted function takes that mesh and
     * the caller binds every write the closure performs. The BODY is the
     * pin's own, statement for statement.
     */
    private loweredArrow(
        arrow: ts.ArrowFunction,
        scope: PinnedNumericScope,
        file: ts.SourceFile,
        skip: (statement: ts.Statement) => boolean = () => false,
    ): string {
        const lowerer = new PinnedNumericLowerer(file, scope);
        if (!ts.isBlock(arrow.body)) {
            this.context.contractError(
                arrow,
                "Expected a pinned placement callback with a block body.",
            );
        }
        return arrow.body.statements
            .filter((statement) => !skip(statement))
            .flatMap((statement) => lowerer.statement(statement, "    "))
            .join("\n");
    }

    /**
     * The scope every cage placement callback shares: the pin's own
     * `Math` set, its `rotatePoint`, and the three TRS writes a callback
     * performs, each spelled as the setter the native record needs.
     */
    private placementScope(
        writes: ReadonlyMap<string, string>,
        extra: ReadonlyMap<string, PinnedBinding> = new Map(),
    ): PinnedNumericScope {
        const targets = new Map(writes);
        return {
            bindings: new Map<string, PinnedBinding>([
                ...[...targets.keys()].map(
                    (pinned): [string, PinnedBinding] => [
                        pinned,
                        { cpp: pinned, type: "scalar" },
                    ],
                ),
                ...extra,
            ]),
            calls: new Map([
                ...pinnedNumericMathCallsWithHypot(),
                [
                    "rotatePoint",
                    (args: readonly string[]): string =>
                        `bbox_rotate_point(${args.join(", ")})`,
                ],
            ]),
            recordCalls: new Map([["rotatePoint", ["x", "y", "z"]]]),
            methods: new Map([
                [
                    "set",
                    (receiver: string, args: readonly string[]): string => {
                        const target = targets.get(receiver);
                        if (target === undefined) {
                            throw new Error(
                                "Unbound pinned placement write " +
                                    `'${receiver}'.`,
                            );
                        }
                        return `${target}, ${args.join(", ")})`;
                    },
                ],
            ]),
            booleanAnd: true,
            vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
        };
    }

    /**
     * The bounding-box gizmo (`src/gizmo/bounding-box-gizmo.ts`).
     *
     * Split where the rest of the family splits. What the cage IS -- two
     * materials, the counts of each handle group, every mesh factory's
     * options and every geometric expression behind a handle's size and
     * offset -- is read out of the pinned build and emitted as the same
     * tree of native factory calls. The four placement callbacks and the
     * whole `layout` body are LOWERED from the pin through the shared
     * numeric translator, so the coordinate each of the 55 handles takes
     * is the pin's own expression rather than a second copy of it.
     *
     * Two things are emitted as native behaviour over live records, for
     * the same reason the family's per-frame follow is: `refresh` and
     * `computeBoundsRecursive` walk the SCENE, and the tables they walk
     * are this port's rather than the pin's -- a mesh's parent chain, the
     * layer's main scene, one geometry's model vertices. Every number
     * either of them computes still comes from a lowered pinned body: the
     * attached node's rotation from `rotationQuatFromMatrix`, its inverse
     * from `mat4FromQuat` over the pinned compose, the per-mesh matrix
     * from `mat4MultiplyInto`, and the fold itself from `computeAabb`.
     *
     * The drag half is absent exactly as it is for the four editing
     * widgets (`display-only-editing-gizmo`): no collider registration, no
     * hover material -- nothing assigns it outside a drag callback -- and
     * no `_initialBoundingDiag`, which only the rotation drag divides by.
     */
    private boundingBox(): { helpers: string; factories: string } {
        const file = this.context.sourceFile(BOUNDING_BOX_MODULE);
        const factory = this.context.functionDeclaration(
            BOUNDING_BOX_MODULE,
            "createBoundingBoxGizmo",
        ).declaration;
        // The pin hides its root, which is what lets a transform node
        // stand in for it here exactly as it does for the four editors.
        this.assertHidden(factory, "root");

        // ---- the options the pinned factory defaults through a `??` ----
        const colorDefault = this.optionDefaultTuple(factory, "color", file);
        if (colorDefault.length !== 3) {
            this.context.contractError(
                factory,
                "Expected the pinned bounding-box colour default to have " +
                    "three components.",
            );
        }
        const edgeThicknessDefault = this.optionDefault(
            factory,
            "edgeThickness",
            file,
        );
        const scaleBoxSizeDefault = this.optionDefault(
            factory,
            "scaleBoxSize",
            file,
        );
        const rotationAnchorDefault = this.optionDefault(
            factory,
            "rotationAnchorSize",
            file,
        );
        const constants = this.widgetLowerer(
            BOUNDING_BOX_MODULE,
            new Map([
                ["scaleBoxSize", "scale_box_size"],
                ["rotationAnchorLength", "rotation_anchor_length"],
            ]),
        );
        const cornerArmLen = constants.expression(
            this.localInitializer(factory, "cornerArmLen"),
        );
        const rotationAnchorThickness = constants.expression(
            this.localInitializer(factory, "rotationAnchorThickness"),
        );
        const faceBoxSize = constants.expression(
            this.localInitializer(factory, "faceBoxSize"),
        );

        // ---- the two materials, read from the pin's own writes ----
        const materialLowerer = this.widgetLowerer(
            BOUNDING_BOX_MODULE,
            new Map([
                ["color", "color"],
                ["color.x", "color.x"],
                ["color.y", "color.y"],
                ["color.z", "color.z"],
            ]),
        );
        const materialWrites = this.materialWrites(
            factory,
            "material",
            "engine.materials[gizmo.material.value]",
            materialLowerer,
        );
        const bodyMaterialWrites = this.materialWrites(
            factory,
            "bodyMaterial",
            "engine.materials[gizmo.body_material.value]",
            materialLowerer,
        );

        // ---- the group counts, from the pin's own build loops ----
        const edgeLoop = this.pushedLoop(factory, "edges");
        const cornerLoop = this.pushedLoop(factory, "corners");
        const rotatorLoop = this.pushedLoop(factory, "rotators");
        const faceLoop = this.pushedLoop(factory, "faces");
        const edgeCount = this.loopCount(edgeLoop, file);
        const cornerCount = this.loopCount(cornerLoop, file);
        const rotatorCount = this.loopCount(rotatorLoop, file);
        const faceCount = this.loopCount(faceLoop, file);
        const edgeName = this.loopMeshName(edgeLoop, "e.mesh");
        const cornerName = this.loopMeshName(cornerLoop, "c.mesh");
        const rotatorName = this.loopMeshName(rotatorLoop, "h.mesh");
        const faceName = this.loopMeshName(faceLoop, "h.mesh");

        // ---- the mesh factories each builder calls ----
        const edgeBuilder = this.context.functionDeclaration(
            BOUNDING_BOX_MODULE,
            "buildEdge",
        ).declaration;
        const handleBuilder = this.context.functionDeclaration(
            BOUNDING_BOX_MODULE,
            "buildHandle",
        ).declaration;
        const anchorBuilder = this.context.functionDeclaration(
            BOUNDING_BOX_MODULE,
            "buildEdgeAnchor",
        ).declaration;
        const cornerBuilder = this.context.functionDeclaration(
            BOUNDING_BOX_MODULE,
            "buildCornerHandle",
        ).declaration;
        this.assertHidden(edgeBuilder, "mesh", "pickable");
        const edgeCalls = this.factoryCalls(file, edgeBuilder, [
            "createCylinder",
        ]);
        if (edgeCalls.length !== 1) {
            this.context.contractError(
                edgeBuilder,
                "Expected the pinned edge builder to make one cylinder.",
            );
        }
        const edgeOptions = edgeCalls[0]!;
        const cylinderOption = (name: string): string => {
            if (!edgeOptions.options.has(name)) {
                this.context.contractError(
                    edgeBuilder,
                    `Expected the pinned edge cylinder to declare ` +
                        `'${name}'.`,
                );
            }
            const constant = edgeOptions.options.get(name);
            // The two diameters are the caller's live `thickness`; the
            // rest are the pin's own literals.
            return constant === undefined
                ? "edge_thickness"
                : this.context.doubleLiteral(constant);
        };
        const rootCalls = this.factoryCalls(
            file,
            this.localInitializer(factory, "root"),
            ["createCylinder"],
        );
        if (rootCalls.length !== 1) {
            this.context.contractError(
                factory,
                "Expected the pinned bounding-box root to be one " +
                    "zero-extent cylinder.",
            );
        }

        // ---- the rotation-anchor scaling and the corner geometry ----
        const anchorLowerer = this.widgetLowerer(
            BOUNDING_BOX_MODULE,
            new Map([
                ["axis.x", "axis.x"],
                ["axis.y", "axis.y"],
                ["axis.z", "axis.z"],
                ["length", "rotation_anchor_length"],
                ["thickness", "rotation_anchor_thickness"],
            ]),
        );
        const anchorScaling = this.channel(
            anchorBuilder,
            "mesh",
            "scaling",
            new PinnedNumericLowerer(file, {
                bindings: new Map<string, PinnedBinding>([
                    ["axis.x", { cpp: "axis.x", type: "scalar" }],
                    ["axis.y", { cpp: "axis.y", type: "scalar" }],
                    ["axis.z", { cpp: "axis.z", type: "scalar" }],
                    [
                        "length",
                        { cpp: "rotation_anchor_length", type: "scalar" },
                    ],
                    [
                        "thickness",
                        { cpp: "rotation_anchor_thickness", type: "scalar" },
                    ],
                    ["ax", { cpp: "ax", type: "scalar" }],
                    ["ay", { cpp: "ay", type: "scalar" }],
                    ["az", { cpp: "az", type: "scalar" }],
                ]),
                calls: pinnedNumericMathCallsWithHypot(),
                booleanAnd: true,
            }),
            ["1.0", "1.0", "1.0"],
        );
        const anchorAbs = ["ax", "ay", "az"].map(
            (name) =>
                `    const double ${name} = ` +
                `${anchorLowerer.expression(
                    this.localInitializer(anchorBuilder, name),
                )};`,
        );
        const cornerLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["size", { cpp: "scale_box_size", type: "scalar" }],
                ["armLen", { cpp: "corner_arm_len", type: "scalar" }],
                ["axisSigns", { cpp: "axis_signs", type: "scalar" }],
            ]),
            calls: pinnedNumericMathCallsWithHypot(),
        });
        const cornerParts = [
            { local: "anchor", target: "corner.anchor" },
            { local: "yArm", target: "corner.y_arm" },
            { local: "zArm", target: "corner.z_arm" },
        ].map(({ local, target }) => ({
            local,
            target,
            scaling: this.channel(
                cornerBuilder,
                local,
                "scaling",
                cornerLowerer,
                ["1.0", "1.0", "1.0"],
            ),
            position: this.channel(
                cornerBuilder,
                local,
                "position",
                cornerLowerer,
                ["0.0", "0.0", "0.0"],
            ),
        }));
        const cornerOffsets = ["offX", "offY", "offZ"].map((name) =>
            cornerLowerer.expression(
                this.localInitializer(cornerBuilder, name),
            ),
        );
        this.assertHidden(cornerLoop, "c.meshes[1]!", "pickable");
        this.assertHidden(cornerLoop, "c.meshes[2]!", "pickable");

        // ---- the corner octant signs, over the pin's own bit tests ----
        const signLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["i", { cpp: "i", type: "scalar" }],
            ]),
            calls: new Map(),
        });
        const cornerSigns = ["sx", "sy", "sz"].map(
            (name) =>
                `        const double ${name} = ` +
                `${signLowerer.expression(
                    this.localInitializer(factory, name),
                )};`,
        );
        const cornerCall = this.context.callExpression(
            factory,
            "buildCornerHandle",
        );
        const axisSigns = this.context.unwrapExpression(
            cornerCall.arguments[5]!,
        );
        if (
            !ts.isArrayLiteralExpression(axisSigns) ||
            axisSigns.elements.length !== 3
        ) {
            this.context.contractError(
                cornerCall,
                "Expected the pinned corner builder to take a three-sign " +
                    "octant tuple.",
            );
        }
        const cornerSignTuple = axisSigns.elements.map((element) =>
            new PinnedNumericLowerer(file, {
                bindings: new Map<string, PinnedBinding>([
                    ["sx", { cpp: "sx", type: "scalar" }],
                    ["sy", { cpp: "sy", type: "scalar" }],
                    ["sz", { cpp: "sz", type: "scalar" }],
                ]),
                calls: new Map(),
            }).expression(element),
        );

        // ---- the rotation-anchor axis table ----
        const axisTable = this.context.unwrapExpression(
            this.localInitializer(factory, "rotationAxes"),
        );
        if (
            !ts.isArrayLiteralExpression(axisTable) ||
            axisTable.elements.length !== rotatorCount
        ) {
            this.context.contractError(
                factory,
                "Expected the pinned rotation-axis table to carry one " +
                    "entry per rotation anchor.",
            );
        }
        const axisEntries = axisTable.elements.map((element) =>
            new PinnedNumericLowerer(file, {
                bindings: new Map(),
                calls: new Map(),
                vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
            }).expression(element),
        );

        // ---- the four placement callbacks, lowered whole ----
        const vec3 = (name: string, cpp: string): [string, PinnedBinding][] =>
            ["x", "y", "z"].map((lane): [string, PinnedBinding] => [
                `${name}.${lane}`,
                { cpp: `${cpp}.${lane}`, type: "scalar" },
            ]);
        const placeEdge = this.loweredArrow(
            this.arrowLocal(edgeBuilder, "place"),
            this.placementScope(
                new Map([
                    ["mesh.position", "bbox_set_position(engine, mesh"],
                    ["mesh.scaling", "bbox_set_scaling(engine, mesh"],
                    ["mesh.rotationQuaternion", "bbox_set_rotation(engine, mesh"],
                ]),
                new Map([...vec3("a", "a"), ...vec3("b", "b")]),
            ),
            file,
        );
        const handlePlace = this.arrowLocal(handleBuilder, "place");
        const anchorPlace = this.arrowLocal(anchorBuilder, "place");
        if (
            handlePlace.body.getText(file).replace(/\s+/g, " ") !==
            anchorPlace.body.getText(file).replace(/\s+/g, " ")
        ) {
            this.context.contractError(
                anchorPlace,
                "Expected the pinned face-handle and rotation-anchor " +
                    "placements to agree; one generated writer serves both.",
            );
        }
        const placeHandle = this.loweredArrow(
            handlePlace,
            this.placementScope(
                new Map([
                    ["mesh.position", "bbox_set_position(engine, mesh"],
                    ["mesh.rotationQuaternion", "bbox_set_rotation(engine, mesh"],
                ]),
                new Map([
                    ...vec3("p", "p"),
                    ["q", { cpp: "q", type: "scalar" }],
                ]),
            ),
            file,
        );
        const placeCorner = this.loweredArrow(
            this.arrowLocal(cornerBuilder, "place"),
            this.placementScope(
                new Map([
                    ["anchor.position", "bbox_set_position(engine, corner.anchor"],
                    [
                        "anchor.rotationQuaternion",
                        "bbox_set_rotation(engine, corner.anchor",
                    ],
                    ["yArm.position", "bbox_set_position(engine, corner.y_arm"],
                    [
                        "yArm.rotationQuaternion",
                        "bbox_set_rotation(engine, corner.y_arm",
                    ],
                    ["zArm.position", "bbox_set_position(engine, corner.z_arm"],
                    [
                        "zArm.rotationQuaternion",
                        "bbox_set_rotation(engine, corner.z_arm",
                    ],
                ]),
                new Map<string, PinnedBinding>([
                    ...vec3("p", "p"),
                    ["q", { cpp: "q", type: "scalar" }],
                    ["offX", { cpp: "corner.offsets.x", type: "scalar" }],
                    ["offY", { cpp: "corner.offsets.y", type: "scalar" }],
                    ["offZ", { cpp: "corner.offsets.z", type: "scalar" }],
                ]),
            ),
            file,
        );

        // ---- `layout`, lowered whole ----
        const layout = this.arrowLocal(factory, "layout");
        const boxAxes = ["xs", "ys", "zs"].map((name) => {
            const initializer = this.context.unwrapExpression(
                this.localInitializer(layout, name),
            );
            if (
                !ts.isArrayLiteralExpression(initializer) ||
                initializer.elements.length !== 2
            ) {
                this.context.contractError(
                    layout,
                    `Expected the pinned layout to bracket '${name}' ` +
                        "between two bounds.",
                );
            }
            const bounds = initializer.elements.map((element) =>
                new PinnedNumericLowerer(file, {
                    bindings: new Map<string, PinnedBinding>([
                        ...vec3("b.min", "b.min"),
                        ...vec3("b.max", "b.max"),
                    ]),
                    calls: new Map(),
                }).expression(element),
            );
            return (
                `    const std::array<double, 2> ${name}{` +
                `${bounds.join(", ")}};`
            );
        }).join("\n");
        // `toWorld` is the pin's own one-expression alias for
        // `rotatePoint(q, ...)`, and the translator inlines only a block
        // body -- so it is asserted here and bound as that call instead.
        const toWorld = this.context.unwrapExpression(
            this.localInitializer(layout, "toWorld"),
        );
        if (
            !ts.isArrowFunction(toWorld) ||
            toWorld.parameters.length !== 1 ||
            ts.isBlock(toWorld.body) ||
            !ts.isCallExpression(toWorld.body) ||
            !ts.isIdentifier(toWorld.body.expression) ||
            toWorld.body.expression.text !== "rotatePoint" ||
            toWorld.body.arguments.length !== 2 ||
            toWorld.body.arguments[0]!.getText(file) !== "q" ||
            toWorld.body.arguments[1]!.getText(file) !==
                (toWorld.parameters[0]!.name as ts.Identifier).text
        ) {
            this.context.contractError(
                layout,
                "Expected the pinned layout to take every frame point " +
                    "through rotatePoint(q, ...).",
            );
        }
        const layoutSkipped = new Set<string>([
            "toWorld",
            "xs",
            "ys",
            "zs",
        ]);
        const layoutScope = this.placementScope(
            new Map([
                ["body.position", "bbox_set_position(engine, record.body"],
                ["body.scaling", "bbox_set_scaling(engine, record.body"],
                ["body.rotationQuaternion", "bbox_set_rotation(engine, record.body"],
            ]),
            new Map<string, PinnedBinding>([
                ...vec3("b.min", "b.min"),
                ...vec3("b.max", "b.max"),
                ...vec3("b.centre", "b.centre"),
                ...vec3("b.size", "b.size"),
                ["b.centre", { cpp: "b.centre", type: "vec3" }],
                ["q", { cpp: "q", type: "scalar" }],
                ["worldCenter", { cpp: "world_center", type: "vec3" }],
                ...vec3("worldCenter", "world_center"),
                ["faceBoxSize", { cpp: "record.face_box_size", type: "scalar" }],
                ["xs", { cpp: "xs", type: "scalar" }],
                ["ys", { cpp: "ys", type: "scalar" }],
                ["zs", { cpp: "zs", type: "scalar" }],
                ["edges", { cpp: "record.edges", type: "scalar" }],
                ["rotators", { cpp: "record.rotators", type: "scalar" }],
                ["corners", { cpp: "record.corners", type: "scalar" }],
                ["faces", { cpp: "record.faces", type: "scalar" }],
            ]),
        );
        layoutScope.calls = new Map([
            ...layoutScope.calls,
            [
                "toWorld",
                (args: readonly string[]): string =>
                    `bbox_rotate_point(q, ${args[0]})`,
            ],
        ]);
        layoutScope.recordCalls = new Map([
            ...(layoutScope.recordCalls ?? []),
            ["toWorld", ["x", "y", "z"]],
        ]);
        layoutScope.forOf = (iterated, element) => ({
            range: iterated,
            bindings: new Map<string, PinnedBinding>([
                [element, { cpp: element, type: "scalar" }],
            ]),
        });
        layoutScope.methods = new Map([
            ...(layoutScope.methods ?? []),
            [
                "place",
                (receiver: string, args: readonly string[]): string => {
                    if (receiver.startsWith("record.edges")) {
                        return `bbox_place_edge(engine, ${receiver}, ` +
                            `${args.join(", ")})`;
                    }
                    if (receiver.startsWith("record.corners")) {
                        return `bbox_place_corner(engine, ${receiver}, ` +
                            `${args.join(", ")})`;
                    }
                    return `bbox_place_handle(engine, ${receiver}, ` +
                        `${args.join(", ")})`;
                },
            ],
        ]);
        // The pin's own per-rotator world-axis refresh writes `r.axis`,
        // which only the rotation DRAG reads back -- the same half of this
        // family the four editors leave out. Asserted, then dropped.
        if (!ts.isBlock(layout.body)) {
            this.context.contractError(
                layout,
                "Expected the pinned layout to have a block body.",
            );
        }
        const axisRefresh = layout.body.statements.filter(
            (statement): statement is ts.ForOfStatement =>
                ts.isForOfStatement(statement) &&
                statement.expression.getText(file) === "rotators",
        );
        if (
            axisRefresh.length !== 1 ||
            this.context.hasNode(
                axisRefresh[0]!.statement,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(node.left) &&
                    !node.left.expression.getText(file).startsWith("r.axis"),
            )
        ) {
            this.context.contractError(
                layout,
                "Expected the pinned layout's rotator sweep to update " +
                    "only the world axis the unreached rotation drag " +
                    "rotates around.",
            );
        }
        const layoutBody = this.loweredArrow(
            layout,
            layoutScope,
            file,
            (statement) =>
                statement === axisRefresh[0] ||
                (ts.isVariableStatement(statement) &&
                    statement.declarationList.declarations.some(
                        (declaration) =>
                            ts.isIdentifier(declaration.name) &&
                            layoutSkipped.has(declaration.name.text),
                    )),
        );

        // ---- rotatePoint, computeAabb and mat4FromQuat ----
        const rotatePoint = this.loweredPinnedRotatePoint(file);
        const computeAabb = this.loweredComputeAabb();
        const fromQuat = this.loweredMat4FromQuat(file);
        const refreshArguments = this.refreshInverseArguments(factory, file);
        const identity = this.context.unwrapExpression(
            this.context.moduleScopeConstant(file, "IDENTITY_QUAT") ??
                this.context.contractError(
                    file,
                    "Expected the pinned cage to declare IDENTITY_QUAT.",
                ),
        );
        if (
            !ts.isArrayLiteralExpression(identity) ||
            identity.elements.length !== 4
        ) {
            this.context.contractError(
                identity,
                "Expected the pinned IDENTITY_QUAT to be a four-lane " +
                    "quaternion literal.",
            );
        }
        const identityQuat = identity.elements
            .map((element) =>
                this.context.doubleLiteral(
                    this.context.numericValue(element, file),
                ),
            )
            .join(", ");

        // ---- the remaining pinned box sizes and the body's own name ----
        // `size` is a parameter of all four builders and means a DIFFERENT
        // quantity in each -- the face box, the rotation-anchor bar, the
        // corner arm, the body. Only the face builder gets it bound. The
        // other three read their sizes from literals today, and binding
        // `size` for them as well would have quietly given a pin that
        // started writing `createBox(engine, size)` the face box's size:
        // right shape, wrong geometry, clean generation. Unbound, that
        // same edit fails generation by the name that reads it.
        const faceLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["size", { cpp: "face_box_size", type: "scalar" }],
            ]),
            calls: new Map(),
        });
        const unitLowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>(),
            calls: new Map(),
        });
        const faceBoxSizes = this.boxSizes(handleBuilder, faceLowerer);
        const anchorBoxSizes = this.boxSizes(anchorBuilder, unitLowerer);
        const cornerBoxSizes = this.boxSizes(cornerBuilder, unitLowerer);
        if (
            faceBoxSizes.length !== 1 ||
            anchorBoxSizes.length !== 1 ||
            cornerBoxSizes.length !== 3
        ) {
            this.context.contractError(
                factory,
                "Expected the pinned cage to build one face box, one " +
                    "rotation bar and three corner arms.",
            );
        }
        const bodyName = this.stringAssignment(factory, "body", "name");
        const bodyBoxSizes = this.boxSizes(
            this.localInitializer(factory, "body"),
            unitLowerer,
        );
        if (bodyBoxSizes.length !== 1) {
            this.context.contractError(
                factory,
                "Expected the pinned cage's translate body to be one box.",
            );
        }
        const cube = (size: string): string =>
            `BoxOptions{` +
            `static_cast<float>(${size}), ` +
            `static_cast<float>(${size}), ` +
            `static_cast<float>(${size})}`;
        const rootOptions = rootCalls[0]!;
        const rootOption = (name: string): string => {
            const constant = rootOptions.options.get(name);
            if (constant === undefined) {
                this.context.contractError(
                    factory,
                    `Expected the pinned bounding-box root cylinder to ` +
                        `spell '${name}' as a constant.`,
                );
            }
            return this.context.doubleLiteral(constant);
        };
        // The root is the invisible anchor every widget in this family
        // keeps; a transform node stands in for the pin's zero-extent
        // cylinder here for the same reason it does for the four editors,
        // and the pin's own zero extents are read so a root that started
        // having a shape fails generation instead of drawing one.
        for (const name of [
            "diameterTop",
            "diameterBottom",
            "height",
        ]) {
            if (rootOption(name) !== this.context.doubleLiteral(0)) {
                this.context.contractError(
                    factory,
                    "Expected the pinned bounding-box root to be a " +
                        "zero-extent stand-in with no geometry of its own.",
                );
            }
        }

        return {
            helpers: `// ${this.context.provenance(
                BOUNDING_BOX_MODULE,
                "createBoundingBoxGizmo",
            )}

/** The pin's AabbBounds, which its layout reads four vectors off. */
struct BoundingBoxBounds {
    Vec3d min{};
    Vec3d max{};
    Vec3d centre{};
    Vec3d size{};
};

/**
 * The pin's own _cpuPositions stream over a native geometry.
 *
 * Upstream a mesh keeps its local positions as one flat Float32Array and
 * the pinned fold walks it three components at a time; this port keeps
 * them as model vertices, so the same walk reads through this view rather
 * than through a copy built per frame.
 */
struct BoundingBoxPositions {
    const std::vector<ModelVertex>* vertices = nullptr;
    double operator[](std::size_t index) const {
        const ModelVertex& vertex = (*vertices)[index / 3u];
        const std::size_t lane = index % 3u;
        return lane == 0u
            ? static_cast<double>(vertex.position.x)
            : lane == 1u
                ? static_cast<double>(vertex.position.y)
                : static_cast<double>(vertex.position.z);
    }
    std::size_t size() const { return vertices->size() * 3u; }
};

${lowerMat4MultiplyWriterCpp(this.context)}

${lowerPinnedFunction(
    this.context,
    MAT4_COMPOSE_MODULE,
    "mat4ComposeInto",
    [
        { pinned: "dst", kind: "mat4", cpp: "dst" },
        { pinned: "off", kind: "number", cpp: "off" },
        { pinned: "tx", kind: "number", cpp: "tx" },
        { pinned: "ty", kind: "number", cpp: "ty" },
        { pinned: "tz", kind: "number", cpp: "tz" },
        { pinned: "qx", kind: "number", cpp: "qx" },
        { pinned: "qy", kind: "number", cpp: "qy" },
        { pinned: "qz", kind: "number", cpp: "qz" },
        { pinned: "qw", kind: "number", cpp: "qw" },
        { pinned: "sx", kind: "number", cpp: "sx" },
        { pinned: "sy", kind: "number", cpp: "sy" },
        { pinned: "sz", kind: "number", cpp: "sz" },
    ],
    { cppName: "mat4_compose_into", returns: "void" },
)}

${fromQuat}

${computeAabb}

${rotatePoint}

/**
 * The three TRS writes a pinned placement callback performs.
 *
 * A cage handle carries no parent and is positioned directly in world
 * space, so each write is one record store plus a dirty mark -- and the
 * quaternion goes through the setter, which is what selects the quaternion
 * lane over the record's Euler one.
 *
 * The mark is the RUNTIME-TRANSFORM one, because layout runs from
 * onBeforeRender: all 55 cage meshes are rewritten every frame, and the
 * plain mark would rebuild and re-upload every one of their baked vertex
 * streams each time. That is the rule mark_mesh_runtime_transform states
 * for exactly this shape, and the same rule meshTransformDirtyEntry
 * applies to a transform written inside a frame callback.
 */
void bbox_set_position(
    Engine& engine,
    MeshHandle mesh,
    double x,
    double y,
    double z) {
    engine.meshes[mesh.value].position = Vec3d{x, y, z};
    mark_mesh_runtime_transform(engine, mesh);
}

void bbox_set_scaling(
    Engine& engine,
    MeshHandle mesh,
    double x,
    double y,
    double z) {
    engine.meshes[mesh.value].scaling = Vec3{
        static_cast<float>(x),
        static_cast<float>(y),
        static_cast<float>(z)};
    mark_mesh_runtime_transform(engine, mesh);
}

void bbox_set_rotation(
    Engine& engine,
    MeshHandle mesh,
    double x,
    double y,
    double z,
    double w) {
    set_mesh_rotation_quaternion(
        engine,
        mesh,
        Vec4{
            static_cast<float>(x),
            static_cast<float>(y),
            static_cast<float>(z),
            static_cast<float>(w)},
        true);
}

// ${this.context.provenance(BOUNDING_BOX_MODULE, "buildEdge")}
void bbox_place_edge(
    Engine& engine,
    MeshHandle mesh,
    Vec3d a,
    Vec3d b) {
${placeEdge}
}

// ${this.context.provenance(
            BOUNDING_BOX_MODULE,
            "buildHandle",
            "the identical rotation-anchor placement beside it",
        )}
void bbox_place_handle(
    Engine& engine,
    MeshHandle mesh,
    Vec3d p,
    const std::array<double, 4>& q) {
${placeHandle}
}

// ${this.context.provenance(BOUNDING_BOX_MODULE, "buildCornerHandle")}
void bbox_place_corner(
    Engine& engine,
    const BoundingBoxCorner& corner,
    Vec3d p,
    const std::array<double, 4>& q) {
${placeCorner}
}

// ${this.context.provenance(BOUNDING_BOX_MODULE, "layout")}
void bbox_layout(
    Engine& engine,
    BoundingBoxGizmoRecord& record,
    const BoundingBoxBounds& b,
    const std::array<double, 4>& q) {
    Vec3d world_center{};
${boxAxes}
${layoutBody}
}

/**
 * computeBoundsRecursive's parent-chain test, over the native tables.
 *
 * Upstream one SceneNode walks its own parent link to the root; a mesh here
 * parents to a mesh or to a transform node and the two live in different
 * tables, so the walk asks each link which it has.
 */
bool bbox_is_descendant(
    const Engine& engine,
    const MeshRecord& mesh,
    TransformNodeHandle root) {
    if (mesh.transform_parent.value >= engine.transform_nodes.size()) {
        if (mesh.parent.value >= engine.meshes.size()) return false;
        return bbox_is_descendant(
            engine,
            engine.meshes[mesh.parent.value],
            root);
    }
    TransformNodeHandle node = mesh.transform_parent;
    while (node.value < engine.transform_nodes.size()) {
        if (node.value == root.value) return true;
        node = engine.transform_nodes[node.value].parent;
    }
    return false;
}

/**
 * computeBoundsRecursive's visit: one mesh's world AABB folded into the
 * running bounds, in the rotation-removed frame the caller supplies.
 *
 * The pinned guard is a GPU resource plus CPU positions plus a world
 * matrix -- a renderable mesh with CPU positions -- which here is a
 * record carrying a geometry.
 */
void bbox_fold_mesh(
    const Engine& engine,
    const MeshRecord& mesh,
    const std::array<float, 16>& pre_transform,
    BoundingBoxBounds& bounds) {
    if (mesh.geometry >= engine.geometries.size()) return;
    const std::vector<ModelVertex>& vertices =
        engine.geometries[mesh.geometry].vertices;
    if (vertices.empty()) return;
    std::array<float, 16> world{};
    mat4_multiply_into(
        world,
        0,
        pre_transform,
        0,
        upstream::mesh_world_matrix(engine, mesh),
        0);
    const std::array<std::array<double, 3>, 2> aabb =
        bbox_compute_aabb(BoundingBoxPositions{&vertices}, world);
    if (!std::isfinite(aabb[0][0])) return;
    if (aabb[0][0] < bounds.min.x) bounds.min.x = aabb[0][0];
    if (aabb[0][1] < bounds.min.y) bounds.min.y = aabb[0][1];
    if (aabb[0][2] < bounds.min.z) bounds.min.z = aabb[0][2];
    if (aabb[1][0] > bounds.max.x) bounds.max.x = aabb[1][0];
    if (aabb[1][1] > bounds.max.y) bounds.max.y = aabb[1][1];
    if (aabb[1][2] > bounds.max.z) bounds.max.z = aabb[1][2];
}

/**
 * computeBoundsRecursive: the attached subtree's world bounds.
 *
 * Two sweeps, exactly as the pin: the traversal list a node keeps, then
 * the main scene's own meshes filtered by the parent-chain test -- which
 * is the arm that finds a cube attached through the parent setter alone,
 * without ever being pushed into that list.
 */
BoundingBoxBounds bbox_compute_bounds(
    const Engine& engine,
    TransformNodeHandle root,
    const Scene& main_scene,
    const std::array<float, 16>& pre_transform) {
    const double infinity = std::numeric_limits<double>::infinity();
    BoundingBoxBounds bounds;
    bounds.min = Vec3d{infinity, infinity, infinity};
    bounds.max = Vec3d{-infinity, -infinity, -infinity};
    std::vector<std::uint32_t> visited;
    const auto seen = [&visited](std::uint32_t mesh) {
        return std::find(visited.begin(), visited.end(), mesh) !=
            visited.end();
    };
    // The pin's own stack walk over the traversal list, which is why it
    // is a stack rather than one pass: a node's children carry children.
    // The root itself is visited upstream too and folds nothing, because
    // a transform node has no positions to fold.
    std::vector<MeshHandle> pending;
    if (root.value < engine.transform_nodes.size()) {
        for (const MeshHandle child :
             engine.transform_nodes[root.value].children) {
            pending.push_back(child);
        }
    }
    while (!pending.empty()) {
        const MeshHandle node = pending.back();
        pending.pop_back();
        if (node.value >= engine.meshes.size() || seen(node.value)) {
            continue;
        }
        visited.push_back(node.value);
        const MeshRecord& record = engine.meshes[node.value];
        bbox_fold_mesh(engine, record, pre_transform, bounds);
        for (const MeshHandle child : record.children) {
            pending.push_back(child);
        }
    }
    for (const MeshHandle candidate : main_scene.meshes) {
        if (candidate.value >= engine.meshes.size() || seen(candidate.value)) {
            continue;
        }
        const MeshRecord& mesh = engine.meshes[candidate.value];
        if (!bbox_is_descendant(engine, mesh, root)) continue;
        visited.push_back(candidate.value);
        bbox_fold_mesh(engine, mesh, pre_transform, bounds);
    }
    if (!std::isfinite(bounds.min.x)) {
        return BoundingBoxBounds{};
    }
    bounds.centre = Vec3d{
        (bounds.min.x + bounds.max.x) * 0.5,
        (bounds.min.y + bounds.max.y) * 0.5,
        (bounds.min.z + bounds.max.z) * 0.5};
    bounds.size = Vec3d{
        bounds.max.x - bounds.min.x,
        bounds.max.y - bounds.min.y,
        bounds.max.z - bounds.min.z};
    return bounds;
}

/**
 * The pin's own per-frame refresh: the attached node's world rotation,
 * the bounds in the frame that rotation removes, and one layout over the
 * two. A detached gizmo lays out the pin's degenerate box at identity,
 * which collapses every handle onto the origin exactly as upstream does.
 */
void bbox_refresh(Engine& engine, BoundingBoxGizmoHandle handle) {
    BoundingBoxGizmoRecord& record = engine.bounding_box_gizmos[handle.value];
    const std::array<double, 4> identity{${identityQuat}};
    if (
        !record.attached ||
        record.attached_node.value >= engine.transform_nodes.size()) {
        bbox_layout(engine, record, BoundingBoxBounds{}, identity);
        return;
    }
    const PinnedQuat rotation = ${PINNED_DECOMPOSE_ROTATION}(
        upstream::transform_node_world(engine, record.attached_node));
    const std::array<double, 4> q{
        rotation.x, rotation.y, rotation.z, rotation.w};
    const std::array<float, 16> inverse = bbox_mat4_from_quat(${refreshArguments});
    UtilityLayerRecord& layer = layer_record(engine, record.layer);
    const BoundingBoxBounds bounds = bbox_compute_bounds(
        engine,
        record.attached_node,
        *layer.main_scene,
        inverse);
    bbox_layout(engine, record, bounds, q);
}

BoundingBoxGizmoHandle push_bounding_box_gizmo(
    Engine& engine,
    Scene& scene,
    BoundingBoxGizmoRecord gizmo) {
    engine.bounding_box_gizmos.push_back(std::move(gizmo));
    const BoundingBoxGizmoHandle handle{
        static_cast<std::uint32_t>(engine.bounding_box_gizmos.size() - 1u)};
    Engine* live_engine = &engine;
    // The pin subscribes the same refresh to the utility scene, because
    // the attached node moves outside a gizmo drag as well as inside one.
    on_before_render(scene, [live_engine, handle](float) {
        bbox_refresh(*live_engine, handle);
    });
    return handle;
}
`,
            factories: `// ${this.context.provenance(
                BOUNDING_BOX_MODULE,
                "createBoundingBoxGizmo",
                `${BOUNDING_BOX_MODULE}#attachBoundingBoxGizmoToNode`,
            )}
BoundingBoxGizmoHandle create_bounding_box_gizmo(
    Engine& engine,
    UtilityLayerHandle layer,
    std::optional<Vec3d> color_option,
    std::optional<double> edge_thickness_option,
    std::optional<double> scale_box_size_option,
    std::optional<double> rotation_anchor_size_option) {
    const Vec3d color = color_option.value_or(Vec3d{${colorDefault
        .map((component) => this.context.doubleLiteral(component))
        .join(", ")}});
    const double edge_thickness = edge_thickness_option.value_or(
        ${this.context.doubleLiteral(edgeThicknessDefault)});
    const double scale_box_size = scale_box_size_option.value_or(
        ${this.context.doubleLiteral(scaleBoxSizeDefault)});
    const double corner_arm_len = ${cornerArmLen};
    const double rotation_anchor_length = rotation_anchor_size_option.value_or(
        ${this.context.doubleLiteral(rotationAnchorDefault)});
    const double rotation_anchor_thickness = ${rotationAnchorThickness};
    const double face_box_size = ${faceBoxSize};
    Scene& scene = layer_record(engine, layer).scene;
    BoundingBoxGizmoRecord gizmo;
    gizmo.layer = layer;
    gizmo.face_box_size = face_box_size;
    gizmo.material = create_standard_material(engine);
${materialWrites}
    // The pin declares a readonly root SceneNode on the gizmo and builds
    // every cage part with no parent (its own comments say so), so this
    // mirrors the pinned record rather than serving a hierarchy: nothing
    // is parented to it here because nothing is parented to it there.
    gizmo.root = create_transform_node(
        engine,
        "bboxGizmoRoot",
        Vec3d{0.0, 0.0, 0.0},
        Vec4{0.0f, 0.0f, 0.0f, 1.0f},
        Vec3{1.0f, 1.0f, 1.0f});
    add_to_scene(scene, gizmo.root);
    for (std::int64_t i = 0; i < ${edgeCount}; ++i) {
        const MeshHandle mesh = create_cylinder(
            engine,
            CylinderOptions{
                ${cylinderOption("height")},
                ${cylinderOption("diameterTop")},
                ${cylinderOption("diameterBottom")},
                ${cylinderOption("tessellation")},
                1.0,
                false});
        engine.meshes[mesh.value].name = ${edgeName};
        engine.meshes[mesh.value].material = gizmo.material;
        engine.meshes[mesh.value].pickable = false;
        add_to_scene(scene, mesh);
        gizmo.edges.push_back(mesh);
    }
    for (std::int64_t i = 0; i < ${cornerCount}; ++i) {
${cornerSigns.join("\n")}
        const std::array<double, 3> axis_signs{${cornerSignTuple.join(", ")}};
        BoundingBoxCorner corner;
${cornerParts
    .map(
        (part, index) => `        ${part.target} = create_box(
            engine,
            ${cube(cornerBoxSizes[index]!)});
        engine.meshes[${part.target}.value].material = gizmo.material;
        engine.meshes[${part.target}.value].scaling = Vec3{
            static_cast<float>(${part.scaling[0]}),
            static_cast<float>(${part.scaling[1]}),
            static_cast<float>(${part.scaling[2]})};
        engine.meshes[${part.target}.value].position = Vec3d{
            ${part.position[0]},
            ${part.position[1]},
            ${part.position[2]}};
        add_to_scene(scene, ${part.target});`,
    )
    .join("\n")}
        engine.meshes[corner.anchor.value].name = ${cornerName};
        engine.meshes[corner.y_arm.value].pickable = false;
        engine.meshes[corner.z_arm.value].pickable = false;
        corner.offsets = Vec3d{
            ${cornerOffsets[0]},
            ${cornerOffsets[1]},
            ${cornerOffsets[2]}};
        gizmo.corners.push_back(corner);
    }
    const std::array<Vec3d, ${rotatorCount}> rotation_axes{{
        ${axisEntries.join(",\n        ")}}};
    for (std::int64_t i = 0; i < ${rotatorCount}; ++i) {
        const Vec3d axis = rotation_axes[static_cast<std::size_t>(i)];
        const MeshHandle mesh = create_box(
            engine,
            ${cube(anchorBoxSizes[0]!)});
${anchorAbs.map((line) => `    ${line}`).join("\n")}
        engine.meshes[mesh.value].scaling = Vec3{
            static_cast<float>(${anchorScaling[0]}),
            static_cast<float>(${anchorScaling[1]}),
            static_cast<float>(${anchorScaling[2]})};
        engine.meshes[mesh.value].material = gizmo.material;
        engine.meshes[mesh.value].name = ${rotatorName};
        add_to_scene(scene, mesh);
        gizmo.rotators.push_back(mesh);
    }
    for (std::int64_t i = 0; i < ${faceCount}; ++i) {
        const MeshHandle mesh = create_box(
            engine,
            ${cube(faceBoxSizes[0]!)});
        engine.meshes[mesh.value].material = gizmo.material;
        engine.meshes[mesh.value].name = ${faceName};
        add_to_scene(scene, mesh);
        gizmo.faces.push_back(mesh);
    }
    gizmo.body_material = create_standard_material(engine);
${bodyMaterialWrites}
    gizmo.body = create_box(engine, ${cube(bodyBoxSizes[0]!)});
    engine.meshes[gizmo.body.value].name = "${bodyName}";
    engine.meshes[gizmo.body.value].material = gizmo.body_material;
    add_to_scene(scene, gizmo.body);
    return push_bounding_box_gizmo(engine, scene, std::move(gizmo));
}

void attach_bounding_box_gizmo_to_node(
    Engine& engine,
    BoundingBoxGizmoHandle gizmo,
    TransformNodeHandle node) {
    BoundingBoxGizmoRecord& record = engine.bounding_box_gizmos[gizmo.value];
    record.attached = true;
    record.attached_node = node;
    // The pin recomputes immediately, so the handles match the new target
    // before the first frame rather than one frame later.
    bbox_refresh(engine, gizmo);
}
`,
        };
    }

    /**
     * The one pinned fact a camera's folded `attachControl` options bag
     * rests on: the three gizmo-state predicates are inert here.
     *
     * `isGizmoInteracting`, `isGizmoDragging` and `isGizmoPickPending`
     * each read a module-level dispatcher map through
     * `_dispatchers?.get(canvas)` and return a falsy constant when that is
     * undefined. The map starts null and the only expression that assigns
     * it is inside `getDispatchers`, whose only caller is
     * `registerPointerDrag` -- which this port reaches nowhere, because
     * there is no pointer-input contract to bind a drag to. So the fold
     * the compiler performs is the pinned body's own value, and this
     * asserts the two halves of that: one writer for the map, one caller
     * for the writer.
     *
     * Asserted beside the family rather than at the call site because it
     * is a statement about the pin. A pinned change that gave the map a
     * second writer would leave the compiler folding a predicate that had
     * stopped being constant.
     */
    private assertPointerDispatchersInert(): void {
        const file = this.context.sourceFile(POINTER_DRAG_MODULE);
        const within = (node: ts.Node, holder: string): boolean => {
            const declaration = this.context.functionDeclaration(
                POINTER_DRAG_MODULE,
                holder,
            ).declaration;
            return (
                node.getStart(file) >= declaration.getStart(file) &&
                node.end <= declaration.end
            );
        };
        const writes: ts.Node[] = [];
        const readers: ts.Node[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(node.left) &&
                node.left.text === "_dispatchers"
            ) {
                writes.push(node);
            }
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "getDispatchers"
            ) {
                readers.push(node);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
        if (
            writes.length === 0 ||
            writes.some((node) => !within(node, "getDispatchers")) ||
            readers.length === 0 ||
            readers.some((node) => !within(node, "registerPointerDrag"))
        ) {
            this.context.contractError(
                this.context.functionDeclaration(
                    POINTER_DRAG_MODULE,
                    "registerPointerDrag",
                ).declaration,
                "Expected the pinned gizmo pointer dispatcher map to be " +
                    "filled only by registerPointerDrag: the camera " +
                    "deferral callbacks fold to the value its three state " +
                    "predicates return with no dispatcher registered, and " +
                    "this port registers none.",
            );
        }
        for (const predicate of [
            "isGizmoInteracting",
            "isGizmoDragging",
            "isGizmoPickPending",
        ]) {
            const declaration = this.context.functionDeclaration(
                POINTER_DRAG_MODULE,
                predicate,
            ).declaration;
            if (
                !this.context.hasNode(
                    declaration,
                    (node) =>
                        ts.isIdentifier(node) &&
                        node.text === "_dispatchers",
                )
            ) {
                this.context.contractError(
                    declaration,
                    `Expected pinned ${predicate} to answer from the ` +
                        "dispatcher map this port never fills.",
                );
            }
        }
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
            // The editing widgets. `createGizmoMaterials` is anchored
            // with them rather than above, because it belongs to the four
            // and nothing the display gizmos emit calls it.
            [CORE_MODULE, ["createGizmoMaterials"]],
            [AXIS_DRAG_MODULE, ["buildArrow"]],
            [AXIS_SCALE_MODULE, ["buildScaleArrow"]],
            [
                MATH_MODULE,
                ["lookAtQuat", "quatNormalize", "quatFromAxisAngle"],
            ],
            [LENGTH_MODULE, ["lengthVec3"]],
            [NORMALIZE_MODULE, ["normalizeVec3"]],
            // The bounding-box cage, anchored whole: its factory, its
            // attach and the four builders behind its handle groups, so
            // a pin that renamed one fails generation by name rather
            // than emitting a cage short of a group.
            [
                BOUNDING_BOX_MODULE,
                [
                    "createBoundingBoxGizmo",
                    "attachBoundingBoxGizmoToNode",
                    "rotatePoint",
                    "buildEdge",
                    "buildHandle",
                    "buildEdgeAnchor",
                    "buildCornerHandle",
                    // Anchored by NAME only, like attachFollowTarget: the
                    // native bounds walk reads this port's own transform
                    // and mesh tables rather than lowering this body, so a
                    // pin that changed how the subtree is gathered would
                    // otherwise still generate.
                    "computeBoundsRecursive",
                ],
            ],
            ...EDIT_MODULES.map(
                ({ modulePath, factory, attach }) =>
                    [modulePath, [factory, attach]] as const,
            ),
            // The composites, anchored whole: each scene reaches only the
            // ones it builds, but the module declares all three factories
            // and all three fan-outs, so a pin that renamed any of them
            // fails generation rather than compiling a composite short of
            // an arm.
            [
                COMPOSITE_MODULE,
                COMPOSITE_MODULES.flatMap(
                    ({ factory, attach, setLocal }) => [
                        factory,
                        attach,
                        setLocal,
                    ],
                ),
            ] as const,
        ] as const) {
            for (const symbol of symbols) {
                this.context.functionDeclaration(modulePath, symbol);
            }
        }
        this.assertPointerDispatchersInert();
        // The bounding-box cage, emitted only for a scene that builds
        // one: it is the family's largest widget by some way, and an
        // emitted static function nothing calls fails under -Werror.
        const boundingBox = this.reachesBoundingBox()
            ? this.boundingBox()
            : undefined;
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
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>

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

${this.reachesEditGizmos() ? this.editGizmoRuntime() : ""}

${boundingBox ? boundingBox.helpers : ""}

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

${this.reachesEditGizmos() ? this.editGizmos() : ""}

// ${this.context.provenance(
        AXIS_DRAG_MODULE,
        "attachAxisDragGizmoToNode",
        "the three sibling widgets' identical attach bodies",
    )}
void attach_gizmo_to_node(
    Engine& engine,
    EditGizmoHandle gizmo,
    MeshHandle node) {
    EditGizmoRecord& record = engine.edit_gizmos[gizmo.value];
    record.attached_node = node;
}

${
            this.reachedComposites().length > 0
                ? `
// The pin keeps useLocalCoordinates as a plain mutable field on each
// widget, read by its follow; this is that write. It sits inside the
// composite gate because the composite fan-out below and the composite
// factory bodies are its only callers -- a scene reaching the four single
// widgets alone never sets the mode, and an emitted function nothing calls
// is a -Werror failure.
void set_edit_gizmo_local_coordinates(
    Engine& engine,
    EditGizmoHandle gizmo,
    bool use_local) {
    engine.edit_gizmos[gizmo.value].use_local_coordinates = use_local;
}

// ${this.context.provenance(
                      COMPOSITE_MODULE,
                      "attachPositionGizmoToNode",
                      "the composite coordinate-mode fan-out beside it",
                  )}
void attach_composite_gizmo_to_node(
    Engine& engine,
    CompositeGizmoHandle gizmo,
    MeshHandle node) {
    for (std::uint32_t i = 0; i < gizmo.part_count; ++i) {
        attach_gizmo_to_node(engine, gizmo.parts[i], node);
    }
}

void set_composite_gizmo_local_coordinates(
    Engine& engine,
    CompositeGizmoHandle gizmo,
    bool use_local) {
    for (std::uint32_t i = 0; i < gizmo.local_coordinate_count; ++i) {
        set_edit_gizmo_local_coordinates(
            engine, gizmo.parts[i], use_local);
    }
}
`
                : ""
        }
${boundingBox ? boundingBox.factories : ""}
} // namespace bbl
`,
        };
    }
}
