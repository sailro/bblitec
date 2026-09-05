// Utility layers host display and editing gizmos over a shared camera.
// Explicit pointer-drag registration reaches native axis/plane translation,
// including source-defined canvas proxies; other editing families retain the
// documented display-only adaptation. Camera deferral callbacks remain live.
import ts from "typescript";
import { validateObjectProperties } from "../option-helpers.js";
import type { Feature, Value, ValueKind } from "../types.js";
import type { DataType } from "../data-types.js";
import type { CapturedClosure, NativeCaptureBinding } from "../closure-captures.js";
import type { IntrinsicCallContext } from "./context.js";
import { compilePointerDragRegistration, pointerDispatcherCpp } from "../pointer-drag.js";

/** Camera-owned callbacks querying the gizmo dispatcher. */
export interface CameraDeferralContext {
    compileStoredDataFunction(expression: ts.ArrowFunction, type: DataType & { kind: "function" }): string;
    compileValue(expression: ts.Expression): Value;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    propertyName(name: ts.PropertyName): string | undefined;
    fail(node: ts.Node, message: string): never;
}

export interface GizmoIntrinsicContext
    extends IntrinsicCallContext,
        CameraDeferralContext {
    emit(line: string): void;
    allocateTemporaryCppName(label: string): string;
    withRecordScopes<T>(owner: Value, work: () => T): T;
    compileCallbackWithValues(declaration: NonNullable<Value["callbackDeclaration"]>, arguments_: readonly Value[], node: ts.Node, discard?: boolean): Value;
    emitDiscardedValue(value: Value): void;
    captureManagedClosureLines(work: () => void): CapturedClosure;
    registerNativeBinding(name: string, borrowed?: boolean): NativeCaptureBinding;
    useNativeValue(value: Value): void;
    requireEngine(value: Value, node: ts.Node): string;
    requireDefaultEngine(node: ts.Node): string;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
}

/**
 * The options bag each factory takes, refused rather than half-supported.
 *
 * Every member of `UtilityLayerOptions`, `CameraGizmoOptions` and
 * `LightGizmoOptions` changes what the generated family unit BUILDS -- a
 * colour, a light intensity, whether the body or the frustum exists at all
 * -- and the unit is emitted from the pin's defaults. A scene supplying one
 * therefore refuses by name instead of compiling a widget that ignores it.
 */
function refuseOptions(
    context: GizmoIntrinsicContext,
    call: ts.CallExpression,
    index: number,
    factory: string,
): void {
    if (call.arguments.length > index) {
        context.fail(
            call.arguments[index]!,
            `${factory} options are not supported: the generated gizmo ` +
                "family is built from the pinned factory's own defaults, " +
                "so a supplied colour, light intensity or display flag " +
                "would be accepted and then ignored.",
        );
    }
}

/**
 * One editing widget, as the factory and its attach call need to see it.
 *
 * The four differ in three things and share everything else: the options
 * member naming the widget's axis, the mesh factories the pinned body
 * calls, and the value kind that keeps one widget's attach call from
 * accepting another's handle.
 */
interface EditGizmoShape {
    /** The pinned factory, for the refusal wording. */
    factory: string;
    /** The pinned attach call this widget's handle belongs to. */
    attach: string;
    kind: ValueKind;
    /** The generated native factory. */
    cppFactory: string;
    /** `dragAxis`, `dragPlaneNormal` or `planeNormal`. */
    axis: string;
    /**
     * The options past the axis the pinned factory defaults through a
     * `??`, in the order the generated factory takes them. Each travels
     * as the pin's own optional, so the default it falls back to stays in
     * the generated body where the pin writes it -- `color` is the first
     * of them for all four.
     */
    options: readonly { name: string; kind: "number" | "boolean" }[];
    feature: Feature;
    /** What the pinned body's own mesh factories build. */
    meshFeatures: readonly Feature[];
}

const editGizmos: readonly EditGizmoShape[] = [
    {
        factory: "createAxisDragGizmo",
        attach: "attachAxisDragGizmoToNode",
        kind: "axis-drag-gizmo",
        cppFactory: "bbl::create_axis_drag_gizmo",
        axis: "dragAxis",
        options: [
            { name: "color", kind: "number" },
            { name: "thickness", kind: "number" },
        ],
        feature: "gizmo:axis-drag",
        meshFeatures: ["mesh:cylinder"],
    },
    {
        factory: "createAxisScaleGizmo",
        attach: "attachAxisScaleGizmoToNode",
        kind: "axis-scale-gizmo",
        cppFactory: "bbl::create_axis_scale_gizmo",
        axis: "dragAxis",
        options: [
            { name: "color", kind: "number" },
            { name: "thickness", kind: "number" },
            { name: "uniformScaling", kind: "boolean" },
        ],
        feature: "gizmo:axis-scale",
        // Three, because the pinned module imports three: the arrow arm's
        // box and cylinder, and the `centered` arm's octahedron, which
        // `uniformScaling` selects at run time inside `buildScaleArrow`.
        // Reached here because that is where the pin reaches them.
        meshFeatures: ["mesh:box", "mesh:cylinder", "mesh:polyhedron"],
    },
    {
        factory: "createPlaneDragGizmo",
        attach: "attachPlaneDragGizmoToNode",
        kind: "plane-drag-gizmo",
        cppFactory: "bbl::create_plane_drag_gizmo",
        axis: "dragPlaneNormal",
        options: [{ name: "color", kind: "number" }],
        feature: "gizmo:plane-drag",
        meshFeatures: ["mesh:plane"],
    },
    {
        factory: "createPlaneRotationGizmo",
        attach: "attachPlaneRotationGizmoToNode",
        kind: "plane-rotation-gizmo",
        cppFactory: "bbl::create_plane_rotation_gizmo",
        axis: "planeNormal",
        options: [
            { name: "color", kind: "number" },
            { name: "tessellation", kind: "number" },
            { name: "thickness", kind: "number" },
        ],
        feature: "gizmo:plane-rotation",
        meshFeatures: ["mesh:torus"],
    },
];

/**
 * One optional member of a gizmo options bag, as the generated factory
 * takes it.
 *
 * Every one of them travels as the pin's own `std::optional`: the
 * `?? [0.5, 0.5, 0.5]`, `?? 1`, `?? 32` and `?? false` behind them stay in
 * the generated body, where the lowerer reads each default out of that
 * coalesce instead of this file restating it.
 */
function compileGizmoOption(
    context: GizmoIntrinsicContext,
    factory: string,
    option: { name: string; kind: "number" | "boolean" },
    expression: ts.Expression | undefined,
): string {
    if (option.name === "color") {
        return expression
            ? `std::optional<bbl::Vec3d>{` +
                  `${context.compileVec3(expression, "double")}}`
            : "std::optional<bbl::Vec3d>{}";
    }
    if (!expression) {
        return option.kind === "number"
            ? "std::optional<double>{}"
            : "std::optional<bool>{}";
    }
    if (option.kind === "number") {
        return (
            "std::optional<double>{" +
            `${context.compileNumber(expression, "double")}}`
        );
    }
    const value = context.compileValue(expression);
    if (value.kind !== "boolean") {
        context.fail(
            expression,
            `${factory}'s ${option.name} is a boolean, received ` +
                `${value.kind}.`,
        );
    }
    return `std::optional<bool>{${value.cpp}}`;
}

/**
 * `create<Widget>Gizmo(engine, layer, options)`.
 *
 * The axis and every member the pinned factory defaults through a `??`
 * that changes what the widget DRAWS are served: the axis is the widget's
 * whole orientation, the colour is a material value, and `thickness`,
 * `tessellation` and `uniformScaling` each select geometry the generated
 * builder emits both arms of. What still refuses by name is the rest --
 * `hoverColor`, `disableColor`, `rotationColor` and `sensitivity` name a
 * material or a strength only a pointer drag installs, and pointer
 * interaction is not reached.
 */
function compileEditGizmo(
    context: GizmoIntrinsicContext,
    shape: EditGizmoShape,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 3, 3);
    const engine = context.compileValue(call.arguments[0]!);
    const layer = context.compileValue(call.arguments[1]!);
    context.expectKind(engine, "engine", call.arguments[0]!);
    context.expectKind(layer, "utility-layer", call.arguments[1]!);
    context.expectSameEngine(engine, layer, call);
    const options = context.expectObjectLiteral(call.arguments[2]!);
    validateObjectProperties(
        context,
        options,
        [shape.axis, ...shape.options.map(({ name }) => name)],
        `${shape.factory} options support ${shape.axis} and ` +
            `${shape.options.map(({ name }) => name).join(", ")}. ` +
            "The rest name a material or a strength only a pointer drag " +
            "installs, and pointer interaction is not reached.",
    );
    const axisExpression = context.objectProperty(options, shape.axis);
    if (!axisExpression) {
        context.fail(
            options,
            `${shape.factory} requires ${shape.axis}: the pinned body ` +
                "orients its root onto it, and there is no default.",
        );
    }
    const supplied = shape.options.map((option) =>
        compileGizmoOption(
            context,
            shape.factory,
            option,
            context.objectProperty(options, option.name),
        ),
    );
    context.reachFeature(shape.feature, call);
    // The layer's own hosting: every widget hangs off a transform node
    // parented under nothing and carrying the meshes below it.
    context.reachFeature("mesh:transform-node", call);
    context.reachFeature("mesh:parenting", call);
    for (const feature of shape.meshFeatures) {
        context.reachFeature(feature, call);
    }
    return {
        kind: shape.kind,
        cpp:
            `${shape.cppFactory}(${engine.cpp}, ${layer.cpp}, ` +
            `${context.compileVec3(axisExpression, "double")}` +
            `${supplied.map((argument) => `, ${argument}`).join("")})`,
        engineCpp: engine.cpp,
    };
}

export function compileCameraDeferralOptions(
    context: CameraDeferralContext,
    expression: ts.Expression,
): Array<{ member: string; cpp: string }> {
    const options = context.expectObjectLiteral(expression);
    const fields = [
        ["shouldHandlePointerDown", "should_handle_pointer_down"],
        ["isExternalDragActive", "external_drag_active"],
        ["isExternalPickPending", "external_pick_pending"],
    ] as const;
    validateObjectProperties(context, options, fields.map(([name]) => name), "Unsupported camera-deferral option.");
    return fields.flatMap(([source, member]) => {
        const callback = context.objectProperty(options, source);
        if (!callback) return [];
        if (!ts.isArrowFunction(callback) || callback.parameters.length !== 0) {
            context.fail(callback, "Camera deferral requires a zero-argument predicate callback.");
        }
        return [{ member, cpp: context.compileStoredDataFunction(callback, {
            kind: "function", parameters: [], result: { kind: "boolean" },
        }) }];
    });
}

/**
 * One composite gizmo, as its three entry points need to see it.
 *
 * The pin declares all three in one module and builds each from the four
 * widgets above, so what differs between them is the option bag the
 * factory takes, which widgets its body reaches, and the value kind that
 * keeps one composite's setter from accepting another's handle.
 */
interface CompositeGizmoShape {
    factory: string;
    attach: string;
    dispose: string;
    /** The pinned coordinate-mode fan-out, where the pin declares one. */
    setLocal: string;
    kind: ValueKind;
    cppFactory: string;
    feature: Feature;
    /**
     * The options the pinned factory defaults through a `??`, in the
     * order the generated factory takes them. Each travels as the pin's
     * own optional so the default stays in the generated body.
     */
    options: readonly { name: string; kind: "number" | "boolean" }[];
    /** Every feature the pinned body's own factory calls reach. */
    reached: readonly Feature[];
}

const compositeGizmos: readonly CompositeGizmoShape[] = [
    {
        factory: "createPositionGizmo",
        attach: "attachPositionGizmoToNode",
        dispose: "disposePositionGizmo",
        setLocal: "setPositionGizmoLocalCoordinates",
        kind: "position-gizmo",
        cppFactory: "bbl::create_position_gizmo",
        feature: "gizmo:position",
        options: [
            { name: "planarEnabled", kind: "boolean" },
            { name: "thickness", kind: "number" },
        ],
        // The pinned body imports and calls both widget factories
        // unconditionally -- `planarEnabled` is a run-time ternary inside
        // it, not an import guard -- so both are reached where the pin
        // reaches them.
        reached: [
            "gizmo:axis-drag",
            "gizmo:plane-drag",
            "mesh:cylinder",
            "mesh:plane",
        ],
    },
    {
        factory: "createRotationGizmo",
        attach: "attachRotationGizmoToNode",
        dispose: "disposeRotationGizmo",
        setLocal: "setRotationGizmoLocalCoordinates",
        kind: "rotation-gizmo",
        cppFactory: "bbl::create_rotation_gizmo",
        feature: "gizmo:rotation",
        options: [
            { name: "tessellation", kind: "number" },
            { name: "thickness", kind: "number" },
        ],
        reached: ["gizmo:plane-rotation", "mesh:torus"],
    },
    {
        factory: "createScaleGizmo",
        attach: "attachScaleGizmoToNode",
        dispose: "disposeScaleGizmo",
        setLocal: "setScaleGizmoLocalCoordinates",
        kind: "scale-gizmo",
        cppFactory: "bbl::create_scale_gizmo",
        feature: "gizmo:scale",
        options: [{ name: "thickness", kind: "number" }],
        // The central uniform handle is `buildScaleArrow`'s `centered`
        // arm, whose octahedron is a `createPolyhedron` -- so a scale
        // composite reaches one mesh family the single widget does not.
        reached: [
            "gizmo:axis-scale",
            "mesh:box",
            "mesh:cylinder",
            "mesh:polyhedron",
        ],
    },
];

/** `create<Composite>Gizmo(engine, layer, options?)`. */
function compileCompositeGizmo(
    context: GizmoIntrinsicContext,
    shape: CompositeGizmoShape,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 3);
    const engine = context.compileValue(call.arguments[0]!);
    const layer = context.compileValue(call.arguments[1]!);
    context.expectKind(engine, "engine", call.arguments[0]!);
    context.expectKind(layer, "utility-layer", call.arguments[1]!);
    context.expectSameEngine(engine, layer, call);
    const options = call.arguments[2]
        ? context.expectObjectLiteral(call.arguments[2])
        : undefined;
    if (options) {
        validateObjectProperties(
            context,
            options,
            shape.options.map(({ name }) => name),
            `${shape.factory} options support ` +
                `${shape.options.map(({ name }) => name).join(" and ")}: ` +
                "those are the members the pinned factory declares.",
        );
    }
    const supplied = shape.options.map((option) =>
        compileGizmoOption(
            context,
            shape.factory,
            option,
            options
                ? context.objectProperty(options, option.name)
                : undefined,
        ),
    );
    context.reachFeature(shape.feature, call);
    for (const feature of shape.reached) {
        context.reachFeature(feature, call);
    }
    // Every sub-widget hangs off its own transform node, as the single
    // widgets do.
    context.reachFeature("mesh:transform-node", call);
    context.reachFeature("mesh:parenting", call);
    return {
        kind: shape.kind,
        cpp:
            `${shape.cppFactory}(${engine.cpp}, ${layer.cpp}` +
            `${supplied.map((argument) => `, ${argument}`).join("")})`,
        engineCpp: engine.cpp,
    };
}

/** `attach<Composite>GizmoToNode(gizmo, node)`. */
function compileCompositeAttach(
    context: GizmoIntrinsicContext,
    shape: CompositeGizmoShape,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const gizmo = context.compileValue(call.arguments[0]!);
    const node = context.compileValue(call.arguments[1]!);
    context.expectKind(gizmo, shape.kind, call.arguments[0]!);
    context.expectKind(node, "mesh", call.arguments[1]!);
    context.expectSameEngine(gizmo, node, call);
    return {
        kind: "void",
        cpp:
            `bbl::attach_composite_gizmo_to_node(` +
            `${context.requireEngine(gizmo, call)}, ` +
            `${gizmo.cpp}, ${node.cpp})`,
    };
}

/** `set<Composite>GizmoLocalCoordinates(gizmo, useLocal)`. */
function compileCompositeLocalCoordinates(
    context: GizmoIntrinsicContext,
    shape: CompositeGizmoShape,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const gizmo = context.compileValue(call.arguments[0]!);
    context.expectKind(gizmo, shape.kind, call.arguments[0]!);
    const useLocal = context.compileValue(call.arguments[1]!);
    if (useLocal.kind !== "boolean") {
        context.fail(
            call.arguments[1]!,
            `${shape.setLocal} takes a boolean, received ` +
                `${useLocal.kind}.`,
        );
    }
    return {
        kind: "void",
        cpp:
            `bbl::set_composite_gizmo_local_coordinates(` +
            `${context.requireEngine(gizmo, call)}, ` +
            `${gizmo.cpp}, ${useLocal.cpp})`,
    };
}

/** `dispose<Composite>Gizmo(gizmo, layer)`. */
function compileCompositeDispose(
    context: GizmoIntrinsicContext,
    shape: CompositeGizmoShape,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const gizmo = context.compileValue(call.arguments[0]!);
    const layer = context.compileValue(call.arguments[1]!);
    context.expectKind(gizmo, shape.kind, call.arguments[0]!);
    context.expectKind(layer, "utility-layer", call.arguments[1]!);
    context.expectSameEngine(gizmo, layer, call);
    return {
        kind: "void",
        cpp:
            `bbl::dispose_composite_gizmo(` +
            `${context.requireEngine(gizmo, call)}, ` +
            `${gizmo.cpp}, ${layer.cpp})`,
    };
}

/** `attach<Widget>GizmoToNode(gizmo, node)`. */
function compileEditGizmoAttach(
    context: GizmoIntrinsicContext,
    shape: EditGizmoShape,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const gizmo = context.compileValue(call.arguments[0]!);
    const node = context.compileValue(call.arguments[1]!);
    context.expectKind(gizmo, shape.kind, call.arguments[0]!);
    context.expectKind(node, "mesh", call.arguments[1]!);
    context.expectSameEngine(gizmo, node, call);
    return {
        kind: "void",
        cpp:
            `bbl::attach_gizmo_to_node(` +
            `${context.requireEngine(gizmo, call)}, ` +
            `${gizmo.cpp}, ${node.cpp})`,
    };
}

/**
 * The bounding-box gizmo's options, in the order the generated factory
 * takes them.
 *
 * All four are members the pinned factory defaults through a `??` and all
 * four change what the cage DRAWS -- the material colour, the wireframe
 * tube diameter, the corner arm size (which the pin also multiplies into
 * the arm length) and the rotation bar length (which sets its thickness).
 * Each travels as the pin's own optional so the default stays in the
 * generated body, where the lowerer reads it out of the coalesce.
 */
const boundingBoxOptions: readonly {
    name: string;
    kind: "number" | "boolean";
}[] = [
    { name: "color", kind: "number" },
    { name: "edgeThickness", kind: "number" },
    { name: "scaleBoxSize", kind: "number" },
    { name: "rotationAnchorSize", kind: "number" },
];

/** `createBoundingBoxGizmo(engine, layer, options?)`. */
function compileBoundingBoxGizmo(
    context: GizmoIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 3);
    const engine = context.compileValue(call.arguments[0]!);
    const layer = context.compileValue(call.arguments[1]!);
    context.expectKind(engine, "engine", call.arguments[0]!);
    context.expectKind(layer, "utility-layer", call.arguments[1]!);
    context.expectSameEngine(engine, layer, call);
    const options = call.arguments[2]
        ? context.expectObjectLiteral(call.arguments[2])
        : undefined;
    if (options) {
        validateObjectProperties(
            context,
            options,
            boundingBoxOptions.map(({ name }) => name),
            "createBoundingBoxGizmo options support " +
                `${boundingBoxOptions
                    .map(({ name }) => name)
                    .join(", ")}: those are the members the pinned ` +
                "BoundingBoxGizmoOptions declares.",
        );
    }
    const supplied = boundingBoxOptions.map((option) =>
        compileGizmoOption(
            context,
            "createBoundingBoxGizmo",
            option,
            options
                ? context.objectProperty(options, option.name)
                : undefined,
        ),
    );
    context.reachFeature("gizmo:bounding-box", call);
    // What the pinned body's own factory calls build: the wireframe
    // edges are cylinders, and every handle -- corner arms, rotation
    // bars, face cubes and the invisible body -- is a box. Reached here
    // because that is where the pin reaches them.
    context.reachFeature("mesh:box", call);
    context.reachFeature("mesh:cylinder", call);
    // The cage's own root, which stands in for the pin's invisible
    // zero-extent cylinder the way every other widget's root does.
    context.reachFeature("mesh:transform-node", call);
    return {
        kind: "bounding-box-gizmo",
        cpp:
            `bbl::create_bounding_box_gizmo(` +
            `${engine.cpp}, ${layer.cpp}` +
            `${supplied.map((argument) => `, ${argument}`).join("")})`,
        engineCpp: engine.cpp,
    };
}

/**
 * `attachBoundingBoxGizmoToNode(gizmo, node)`.
 *
 * The pinned parameter is a `SceneNode`, which upstream is one type over
 * both a mesh and a transform node. This port keeps them in separate
 * tables, and what the attach binds is read back by two things -- the
 * node's world matrix and the parent-chain test that decides which of the
 * main scene's meshes the bounds walk folds in -- so the record carries
 * one identity. A mesh target refuses by name rather than being bound to
 * a handle both readers would misread.
 */
function compileBoundingBoxAttach(
    context: GizmoIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const gizmo = context.compileValue(call.arguments[0]!);
    const node = context.compileValue(call.arguments[1]!);
    context.expectKind(gizmo, "bounding-box-gizmo", call.arguments[0]!);
    if (node.kind !== "transform-node") {
        context.fail(
            call.arguments[1]!,
            "attachBoundingBoxGizmoToNode binds a transform node here, " +
                `received ${node.kind}. The pinned parameter is a ` +
                "SceneNode, which upstream covers a mesh as well; this " +
                "port keeps the two in separate tables and the bounds " +
                "walk tests each candidate mesh's parent chain against " +
                "the bound handle, so a mesh target would need its own " +
                "identity in the record and its own arm in both readers.",
        );
    }
    context.expectSameEngine(gizmo, node, call);
    return {
        kind: "void",
        cpp:
            `bbl::attach_bounding_box_gizmo_to_node(` +
            `${context.requireEngine(gizmo, call)}, ` +
            `${gizmo.cpp}, ${node.cpp})`,
    };
}

export function compileGizmoIntrinsic(
    context: GizmoIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    for (const shape of editGizmos) {
        if (importedName === shape.factory) {
            return compileEditGizmo(context, shape, call);
        }
        if (importedName === shape.attach) {
            return compileEditGizmoAttach(context, shape, call);
        }
    }
    for (const shape of compositeGizmos) {
        if (importedName === shape.factory) {
            return compileCompositeGizmo(context, shape, call);
        }
        if (importedName === shape.attach) {
            return compileCompositeAttach(context, shape, call);
        }
        if (importedName === shape.setLocal) {
            return compileCompositeLocalCoordinates(
                context,
                shape,
                call,
            );
        }
        if (importedName === shape.dispose) {
            return compileCompositeDispose(context, shape, call);
        }
    }
    switch (importedName) {
        case "registerPointerDrag": {
            return compilePointerDragRegistration(context, call);
        }

        case "isGizmoDragging":
        case "isGizmoPickPending":
        case "isGizmoInteracting":
            context.expectArgumentCount(call, 1, 1);
            return {
                kind: "boolean",
                cpp: `bbl::pointer_drag_state(${pointerDispatcherCpp(context, context.compileValue(call.arguments[0]!), call)}, ${importedName === "isGizmoDragging" ? 0 : importedName === "isGizmoPickPending" ? 1 : 2}u)`,
            };

        case "createBoundingBoxGizmo":
            return compileBoundingBoxGizmo(context, call);

        case "attachBoundingBoxGizmoToNode":
            return compileBoundingBoxAttach(context, call);

        case "createUtilityLayer": {
            context.expectArgumentCount(call, 2, 3);
            refuseOptions(context, call, 2, "createUtilityLayer");
            const engine = context.compileValue(call.arguments[0]!);
            const scene = context.compileValue(call.arguments[1]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[1]!);
            context.reachFeature("gizmo:utility-layer", call);
            // The pin's own default light, created by this factory.
            context.reachFeature("light:hemispheric", call);
            // Every gizmo the layer hosts hangs off transform nodes, and
            // the layer is where the family's node parenting starts.
            context.reachFeature("mesh:transform-node", call);
            context.reachFeature("mesh:parenting", call);
            return {
                kind: "utility-layer",
                cpp:
                    `bbl::create_utility_layer(` +
                    `${engine.cpp}, ${scene.cpp})`,
                engineCpp: engine.cpp,
            };
        }

        case "registerUtilityLayer": {
            context.expectArgumentCount(call, 1, 1);
            const layer = context.compileValue(call.arguments[0]!);
            context.expectKind(
                layer,
                "utility-layer",
                call.arguments[0]!,
            );
            // Registration order is what makes the layer an overlay: the
            // pin's `configureSwapchainOverlayScene` reads the surface's
            // LAST rendering context as the base. A scene registering the
            // layer before its main scene would make the main scene the
            // overlay, which is a different picture -- and one this port
            // would render, so the order is left to the scene exactly as
            // upstream leaves it.
            return {
                kind: "void",
                cpp:
                    `bbl::register_utility_layer(` +
                    `${context.requireEngine(layer, call)}, ${layer.cpp})`,
            };
        }

        case "disposeUtilityLayer": {
            context.expectArgumentCount(call, 1, 1);
            const layer = context.compileValue(call.arguments[0]!);
            context.expectKind(
                layer,
                "utility-layer",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::dispose_utility_layer(` +
                    `${context.requireEngine(layer, call)}, ${layer.cpp})`,
            };
        }

        case "createCameraGizmo": {
            context.expectArgumentCount(call, 2, 3);
            refuseOptions(context, call, 2, "createCameraGizmo");
            const engine = context.compileValue(call.arguments[0]!);
            const layer = context.compileValue(call.arguments[1]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            context.expectKind(
                layer,
                "utility-layer",
                call.arguments[1]!,
            );
            context.expectSameEngine(engine, layer, call);
            context.reachFeature("gizmo:camera", call);
            // What the pinned camera-gizmo body builds: BJS
            // `_CreateCameraMesh` is a box plus three cylinders, and the
            // frustum wireframe is twelve more cylinders. Reached at this
            // factory because that is where the pin reaches them.
            context.reachFeature("mesh:box", call);
            context.reachFeature("mesh:cylinder", call);
            return {
                kind: "camera-gizmo",
                cpp:
                    `bbl::create_camera_gizmo(` +
                    `${engine.cpp}, ${layer.cpp})`,
                engineCpp: engine.cpp,
            };
        }

        case "attachCameraGizmoToCamera": {
            context.expectArgumentCount(call, 2, 2);
            const gizmo = context.compileValue(call.arguments[0]!);
            const camera = context.compileValue(call.arguments[1]!);
            context.expectKind(
                gizmo,
                "camera-gizmo",
                call.arguments[0]!,
            );
            context.expectKind(camera, "camera", call.arguments[1]!);
            context.expectSameEngine(gizmo, camera, call);
            return {
                kind: "void",
                cpp:
                    `bbl::attach_camera_gizmo_to_camera(` +
                    `${context.requireEngine(gizmo, call)}, ` +
                    `${gizmo.cpp}, ${camera.cpp})`,
            };
        }

        case "createLightGizmo": {
            context.expectArgumentCount(call, 2, 3);
            refuseOptions(context, call, 2, "createLightGizmo");
            const engine = context.compileValue(call.arguments[0]!);
            const layer = context.compileValue(call.arguments[1]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            context.expectKind(
                layer,
                "utility-layer",
                call.arguments[1]!,
            );
            context.expectSameEngine(engine, layer, call);
            context.reachFeature("gizmo:light", call);
            // What the pinned light-gizmo body builds: a sphere per type,
            // the cylinder rays of `_CreateLightLines`, and the hemisphere
            // dome it assembles itself through `createMeshFromData`.
            context.reachFeature("mesh:sphere", call);
            context.reachFeature("mesh:cylinder", call);
            context.reachFeature("mesh:from-data", call);
            return {
                kind: "light-gizmo",
                cpp:
                    `bbl::create_light_gizmo(` +
                    `${engine.cpp}, ${layer.cpp})`,
                engineCpp: engine.cpp,
            };
        }

        case "attachLightGizmoToLight": {
            context.expectArgumentCount(call, 2, 2);
            const gizmo = context.compileValue(call.arguments[0]!);
            const light = context.compileValue(call.arguments[1]!);
            context.expectKind(
                gizmo,
                "light-gizmo",
                call.arguments[0]!,
            );
            context.expectKind(light, "light", call.arguments[1]!);
            context.expectSameEngine(gizmo, light, call);
            // Which geometry the attach builds follows the light's TYPE,
            // and the record carries it -- the same tag the per-frame
            // follow asks for the position and direction arms.
            return {
                kind: "void",
                cpp:
                    `bbl::attach_light_gizmo_to_light(` +
                    `${context.requireEngine(gizmo, call)}, ` +
                    `${gizmo.cpp}, ${light.cpp})`,
            };
        }

        default:
            return undefined;
    }
}
