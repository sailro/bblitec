import { stringLiteral } from "../cpp-literals.js";
import ts from "typescript";
import { cameraRecordField } from "../compiler/properties.js";
import { snakeCase } from "../cpp-literals.js";
import { LoweringContext } from "./context.js";
import {
    absentBinding,
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedCallSpelling,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const ARC = "src/camera/arc-rotate.ts";
const CONTROLS = "src/camera/arc-rotate-controls.ts";
const OBSERVABLE = "src/math/observable-vec3.ts";
const axes = ["x", "y", "z"] as const;
const scalarFields = ["alpha", "beta", "radius"] as const;

/**
 * The statements of a pinned DOM handler that have no native counterpart,
 * which the camera controls elide. The platform layer hands the handlers
 * relative pointer motion, so the closure's last client position
 * (`lastX = e.clientX`) is not state here; SDL captures a pressed mouse
 * itself (`canvas.setPointerCapture`); and no browser default exists to
 * prevent (`e.preventDefault()`). Every other statement is lowered, so a
 * handler that gained behaviour fails generation rather than vanishing.
 */
export function cameraPlatformStatement(
    context: LoweringContext,
    event: string,
    lastPosition: readonly [string, string],
): NonNullable<PinnedNumericScope["statement"]> {
    const elided = [
        `canvas.setPointerCapture(${event}.pointerId)`,
        `canvas.releasePointerCapture(${event}.pointerId)`,
        `${event}.preventDefault()`,
        `${lastPosition[0]} = ${event}.clientX`,
        `${lastPosition[1]} = ${event}.clientY`,
    ];
    return (statement) =>
        ts.isExpressionStatement(statement) &&
        elided.some((shape) =>
            context.expressionMatchesShape(statement.expression, shape),
        )
            ? []
            : undefined;
}

/**
 * The pin's per-event pointer delta (`e.clientX - lastX`) is the relative
 * motion the platform layer reports, so both differences bind to the
 * handler's delta parameters.
 */
export function cameraPointerDeltaBindings(
    event: string,
    lastPosition: readonly [string, string],
): [string, PinnedBinding][] {
    return [
        [
            `${event}.clientX - ${lastPosition[0]}`,
            { cpp: "delta_x", type: "scalar" },
        ],
        [
            `${event}.clientY - ${lastPosition[1]}`,
            { cpp: "delta_y", type: "scalar" },
        ],
    ];
}

/** The native state and hooks one pinned control handler is lowered over. */
interface ControlAdapter {
    bindings?: ReadonlyMap<string, PinnedBinding>;
    calls?: ReadonlyMap<string, PinnedCallSpelling>;
    statement?: PinnedNumericScope["statement"];
    expression?: PinnedNumericScope["expression"];
}

/** Source setters are the only transform-version writers. Matrix reads cannot
 * recover writes that returned a value to its starting point before a draw. */
export class CameraMutationLowerer {
    constructor(private readonly context: LoweringContext) {}

    private lower(
        file: ts.SourceFile,
        body: ts.Block,
        bindings: Map<string, PinnedBinding>,
        calls: ReadonlyMap<string, PinnedCallSpelling> = new Map(),
        adapter: Pick<ControlAdapter, "statement" | "expression"> = {},
    ): string {
        return lowerPinnedBody(file, body.statements, {
            bindings,
            calls,

            ...(adapter.statement ? { statement: adapter.statement } : {}),
            ...(adapter.expression ? { expression: adapter.expression } : {}),
        });
    }

    private dirty(): string {
        const module = "src/scene/world-matrix-state.ts";
        const { file, declaration } = this.context.functionDeclaration(
            module,
            "createWorldMatrixState",
        );
        const invalidate = this.context.findNodes(
            declaration,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "invalidate",
        )[0];
        if (!invalidate?.body)
            this.context.contractError(
                declaration,
                "Expected world-state invalidate body.",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "_worldVersion"),
            "0",
            "Initial camera transform version",
        );
        const mark = this.context.findNodes(
            declaration,
            (node): node is ts.MethodDeclaration =>
                ts.isMethodDeclaration(node) &&
                this.context.propertyName(node.name) === "markLocalDirty",
        )[0];
        if (!mark?.body) {
            this.context.contractError(
                declaration,
                "Camera dirty entry changed.",
            );
        }
        this.context.assertStatementShapes(
            mark,
            mark.body.statements,
            "_cachedLocal = null; invalidate();",
            "Camera dirty entry",
        );
        const inventory = ts.createSourceFile(
            "camera-invalidate.ts",
            `const body = () => ${invalidate.body.getText(file)}`,
            ts.ScriptTarget.Latest,
            true,
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(inventory, "body"),
            `() => {
            _cachedWorld = null;
            _worldVersion++;
            for (const child of _children) { child._invalidate(); }
        }`,
            "Unparented camera dirty propagation",
        );
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map([
                [
                    "_worldVersion",
                    { cpp: "camera.world_matrix_version", type: "scalar" },
                ],
            ]),
            calls: new Map(),
        });
        return lowerer
            .statement(invalidate.body.statements[1]!, "    ")
            .join("\n");
    }

    public setters(): string {
        const { file, declaration } = this.context.functionDeclaration(
            ARC,
            "createArcRotateCamera",
        );
        const define = this.context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                this.context.propertyPath(node.expression)?.join(".") ===
                    "Object.defineProperty",
        );
        if (define.length !== 1)
            this.context.contractError(
                declaration,
                "Expected one shared arc camera scalar setter.",
            );
        const loop = this.context.findNodes(
            declaration,
            (node): node is ts.ForOfStatement =>
                ts.isForOfStatement(node) &&
                this.context.hasNode(
                    node.statement,
                    (child) => child === define[0],
                ),
        )[0];
        if (!loop)
            this.context.contractError(
                declaration,
                "Expected the shared scalar accessor loop.",
            );
        this.context.assertExpressionShape(
            this.context.unwrapExpression(loop.expression),
            '["alpha", "beta", "radius"]',
            "Tracked arc camera scalar fields",
        );
        const descriptor = define[0]!.arguments[2];
        if (!descriptor || !ts.isObjectLiteralExpression(descriptor))
            this.context.contractError(
                define[0]!,
                "Expected camera accessor descriptor.",
            );
        const setter = this.context.propertyInitializer(descriptor, "set");
        if (!ts.isArrowFunction(setter) || !ts.isBlock(setter.body))
            this.context.contractError(
                setter,
                "Expected camera scalar setter body.",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "onDirty"),
            "(): void => wm.markLocalDirty()",
            "Arc camera dirty callback",
        );
        const scalar = this.lower(
            file,
            setter.body,
            new Map([
                [
                    "scalars[key]",
                    { cpp: "camera.*field", type: "scalar", mutable: true },
                ],
                ["v", { cpp: "value", type: "scalar" }],
            ]),
            new Map([
                ["onDirty", () => "dirty_camera_transform(camera)"],
                [
                    "cam._clampToLimits",
                    () => "clamp_installed_camera_limits(camera)",
                ],
            ]),
        );
        const observable = this.context.sourceFile(OBSERVABLE);
        const componentBodies = axes.map((axis) => {
            const setter = this.context.findNodes(
                observable,
                (node): node is ts.SetAccessorDeclaration =>
                    ts.isSetAccessorDeclaration(node) &&
                    this.context.propertyName(node.name) === axis,
            )[0];
            if (!setter?.body)
                this.context.contractError(
                    observable,
                    `Missing observable ${axis} setter.`,
                );
            return this.lower(
                observable,
                setter.body,
                new Map([
                    [
                        `this._${axis}`,
                        { cpp: "(camera.*vector).*component", type: "scalar" },
                    ],
                    ["v", { cpp: "value", type: "scalar" }],
                ]),
                new Map([
                    ["this._onDirty", () => "dirty_camera_transform(camera)"],
                ]),
            );
        });
        if (!componentBodies.every((body) => body === componentBodies[0]))
            this.context.contractError(
                observable,
                "Observable vector component setters differ.",
            );
        const bulk = this.context.findNodes(
            observable,
            (node): node is ts.MethodDeclaration =>
                ts.isMethodDeclaration(node) &&
                this.context.propertyName(node.name) === "set",
        )[0];
        if (!bulk?.body)
            this.context.contractError(
                observable,
                "Missing observable bulk setter.",
            );
        const bulkBody = this.lower(
            observable,
            bulk.body,
            new Map(
                axes.flatMap((axis): [string, PinnedBinding][] => [
                    [
                        `this._${axis}`,
                        { cpp: `(camera.*vector).${axis}`, type: "scalar" },
                    ],
                    [axis, { cpp: `value.${axis}`, type: "scalar" }],
                ]),
            ),
            new Map([
                ["this._onDirty", () => "dirty_camera_transform(camera)"],
            ]),
        );
        const freeModule = "src/camera/free-camera.ts";
        const { file: freeFile, declaration: freeFactory } =
            this.context.functionDeclaration(freeModule, "_createFreeCamera");
        this.context.assertExpressionShape(
            this.context.variableInitializer(freeFactory, "onDirty"),
            "() => wm.markLocalDirty()",
            "Free camera dirty callback",
        );
        const freeSetters = ["_yaw", "_pitch"].map((field) => {
            const define = this.context.findNodes(
                freeFactory,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    this.context.propertyPath(node.expression)?.join(".") ===
                        "Object.defineProperty" &&
                    node.arguments[1]?.getText(freeFile) ===
                        stringLiteral(field),
            )[0];
            const descriptor = define?.arguments[2];
            if (!descriptor || !ts.isObjectLiteralExpression(descriptor))
                this.context.contractError(
                    freeFactory,
                    `Expected free camera ${field} descriptor.`,
                );
            const setter = descriptor.properties.find(
                (node): node is ts.MethodDeclaration =>
                    ts.isMethodDeclaration(node) &&
                    this.context.propertyName(node.name) === "set",
            );
            if (!setter?.body)
                this.context.contractError(
                    descriptor,
                    `Expected free camera ${field} setter.`,
                );
            return this.lower(
                freeFile,
                setter.body,
                new Map([
                    [
                        field,
                        { cpp: "camera.*field", type: "scalar", mutable: true },
                    ],
                    ["v", { cpp: "value", type: "scalar" }],
                ]),
                new Map([["onDirty", () => "dirty_camera_transform(camera)"]]),
            );
        });
        if (freeSetters[0] !== freeSetters[1])
            this.context.contractError(
                freeFactory,
                "Free camera scalar setters differ.",
            );
        return `// ${this.context.provenance(ARC, "createArcRotateCamera", OBSERVABLE)}
void dirty_camera_transform(CameraRecord& camera) {
${this.dirty()}
}
void clamp_installed_camera_limits(CameraRecord& camera) {
    if (camera.limits_installed) clamp_camera_to_limits(camera);
}
void write_camera_scalar(CameraRecord& camera, double CameraRecord::*field, double value) {
    if (field == &CameraRecord::free_yaw || field == &CameraRecord::free_pitch) {
${freeSetters[0]}
        return;
    }
    if (field != &CameraRecord::alpha && field != &CameraRecord::beta && field != &CameraRecord::radius) {
        camera.*field = value;
        return;
    }
${scalar}
}
void write_camera_vector_component(CameraRecord& camera, Vec3d CameraRecord::*vector,
    double Vec3d::*component, double value) {
${componentBodies[0]}
}
void set_camera_vector(CameraRecord& camera, Vec3d CameraRecord::*vector, Vec3d value) {
${bulkBody}
}`;
    }

    /** Route writes in the actual pin body through its accessor, then reuse
     * numeric lowering for every condition, intermediate and store order. */
    private controlBody(name: string, adapter: ControlAdapter = {}): string {
        const file = this.context.sourceFile(CONTROLS);
        const declaration = this.context.findNodes(
            file,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) && node.name?.text === name,
        )[0];
        if (!declaration?.body)
            this.context.contractError(file, `Missing ${name}.`);
        const transformed = ts.transform(declaration.body, [
            (context) => {
                const visit: ts.Visitor = (node) => {
                    if (ts.isBinaryExpression(node)) {
                        const path = this.context
                            .propertyPath(node.left)
                            ?.join(".");
                        const field = scalarFields.find(
                            (field) => path === `camera.${field}`,
                        );
                        const axis = axes.find(
                            (axis) => path === `camera.target.${axis}`,
                        );
                        if (field || axis) {
                            const operators = new Map<
                                ts.SyntaxKind,
                                ts.BinaryOperator | undefined
                            >([
                                [ts.SyntaxKind.EqualsToken, undefined],
                                [
                                    ts.SyntaxKind.PlusEqualsToken,
                                    ts.SyntaxKind.PlusToken,
                                ],
                                [
                                    ts.SyntaxKind.MinusEqualsToken,
                                    ts.SyntaxKind.MinusToken,
                                ],
                            ]);
                            if (operators.has(node.operatorToken.kind)) {
                                const operator = operators.get(
                                    node.operatorToken.kind,
                                );
                                const value =
                                    operator === undefined
                                        ? node.right
                                        : ts.factory.createBinaryExpression(
                                              node.left,
                                              operator,
                                              node.right,
                                          );
                                return ts.factory.createCallExpression(
                                    ts.factory.createIdentifier(
                                        `write_${field ?? `target_${axis}`}`,
                                    ),
                                    undefined,
                                    [value],
                                );
                            }
                            if (
                                node.operatorToken.kind >=
                                    ts.SyntaxKind.FirstAssignment &&
                                node.operatorToken.kind <=
                                    ts.SyntaxKind.LastAssignment
                            ) {
                                this.context.contractError(
                                    node,
                                    "Camera control setter gained an unsupported compound assignment.",
                                );
                            }
                        }
                    }
                    if (
                        (ts.isPrefixUnaryExpression(node) ||
                            ts.isPostfixUnaryExpression(node)) &&
                        this.context.propertyPath(node.operand)?.[0] ===
                            "camera"
                    ) {
                        this.context.contractError(
                            node,
                            "Camera control gained an unrepresented unary store.",
                        );
                    }
                    return ts.visitEachChild(node, visit, context);
                };
                return (node) => ts.visitNode(node, visit) as ts.Block;
            },
        ]);
        const translated = ts.createSourceFile(
            `${name}.ts`,
            `function body() ${ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0]!, file)}`,
            ts.ScriptTarget.Latest,
            true,
        );
        transformed.dispose();
        const body = translated.statements[0];
        if (!body || !ts.isFunctionDeclaration(body) || !body.body)
            throw new Error("Camera body reconstruction failed.");
        const bindings = new Map<string, PinnedBinding>();
        bindings.set("Math.PI", { cpp: "pi_double", type: "scalar" });
        for (const property of [
            "inertialAlphaOffset",
            "inertialBetaOffset",
            "inertialRadiusOffset",
            "inertialPanningX",
            "inertialPanningY",
            "inertia",
            "panningInertia",
            "angularSensibility",
            "panningSensibility",
            "wheelPrecision",
        ]) {
            bindings.set(`camera.${property}`, {
                cpp: `camera.${snakeCase(property)}`,
                type: "scalar",
            });
        }
        for (const access of this.context.findNodes(
            body,
            ts.isPropertyAccessExpression,
        )) {
            const path = this.context.propertyPath(access);
            if (path?.length === 2 && path[0] === "camera") {
                const field = cameraRecordField(path[1]!);
                if (field)
                    bindings.set(path.join("."), {
                        cpp: `camera.${field}`,
                        type: "scalar",
                    });
                else if (path[1]?.endsWith("Limit")) {
                    const field = snakeCase(path[1]);
                    bindings.set(path.join("."), {
                        cpp: `*camera.${field}`,
                        type: "scalar",
                        absentCpp: `!camera.${field}.has_value()`,
                    });
                }
            }
        }
        for (const axis of axes)
            bindings.set(`camera.target.${axis}`, {
                cpp: `camera.target.${axis}`,
                type: "scalar",
            });
        const attach = this.context.findNodes(
            file,
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "attachControl",
        )[0]!;
        // The keyboard enabler and keyboard options are refused by the scene intrinsic.
        this.context.assertExpressionShape(
            this.context.variableInitializer(attach, "keyboardAttachment"),
            "_arcRotateKeyboardFactory?.(camera, canvas, options?.keyboard)",
            "Optional keyboard attachment",
        );
        bindings.set("keyboardAttachment", absentBinding());
        for (const constant of [
            "ROTATION_EPSILON",
            "RADIUS_EPSILON",
            "PANNING_EPSILON",
        ]) {
            bindings.set(constant, {
                cpp: this.context.doubleLiteral(
                    this.context.numericValue(
                        this.context.variableInitializer(attach, constant),
                        file,
                    ),
                ),
                type: "scalar",
            });
        }
        for (const [source, binding] of adapter.bindings ?? [])
            bindings.set(source, binding);
        return this.lower(
            translated,
            body.body,
            bindings,
            new Map([
                ...pinnedNumericMathCalls(),
                ...scalarFields.map((field): [string, PinnedCallSpelling] => [
                    `write_${field}`,
                    (args) =>
                        `write_camera_scalar(camera, &CameraRecord::${field}, ${args.join(", ")})`,
                ]),
                ...axes.map((axis): [string, PinnedCallSpelling] => [
                    `write_target_${axis}`,
                    (args) =>
                        `write_camera_vector_component(camera, &CameraRecord::target, &Vec3d::${axis}, ${args.join(", ")})`,
                ]),
                ...(adapter.calls ?? []),
            ]),
            adapter,
        );
    }

    public clamp(): string {
        return this.controlBody("clampCameraToLimits");
    }
    public inertia(): string {
        return this.controlBody("applyInertia");
    }

    /**
     * The native side of attachControl's closure: the drag flags are the
     * caller's pointer state, and the optional `AttachControlOptions`
     * predicates are the record's deferral hooks (the scene intrinsic
     * compiles each as a zero-argument predicate and refuses the other
     * options, so the pointer mappings are absent).
     */
    private pointerAdapter(): ControlAdapter {
        const hook = (member: string): string =>
            `(camera.${member} && camera.${member}())`;
        return {
            bindings: new Map<string, PinnedBinding>([
                ["isDragging", { cpp: "is_dragging", type: "bool" }],
                ["isPanning", { cpp: "is_panning", type: "bool" }],
                ["options?.pointerMappings", absentBinding()],
                ...cameraPointerDeltaBindings("e", ["lastX", "lastY"]),
            ]),
            calls: new Map<string, PinnedCallSpelling>([
                [
                    "options?.isExternalDragActive?.()",
                    () => hook("external_drag_active"),
                ],
                [
                    "options?.isExternalPickPending?.()",
                    () => hook("external_pick_pending"),
                ],
            ]),
            statement: cameraPlatformStatement(this.context, "e", [
                "lastX",
                "lastY",
            ]),
        };
    }

    /**
     * attachControl's onPointerDown. The DOM button and pointer type are the
     * event's; the chosen `ArcRotatePointerAction` is a JavaScript string,
     * held as the optional string view it is (`undefined` for a button
     * that starts no gesture).
     */
    public pointerDown(): string {
        const adapter = this.pointerAdapter();
        const bindings = new Map(adapter.bindings);
        // The event reaches the deferral predicate only as its argument; the
        // native predicate takes none.
        bindings.set("e", { cpp: "event", type: "opaque" });
        bindings.set("e.button", { cpp: "button", type: "scalar" });
        bindings.set('e.pointerType === "touch"', {
            cpp: "touch",
            type: "bool",
        });
        bindings.set("options?.shouldHandlePointerDown", {
            cpp: "static_cast<bool>(camera.should_handle_pointer_down)",
            type: "bool",
        });
        bindings.set("pointerAction", {
            cpp: "(*pointer_action)",
            type: "opaque",
            absentCpp: "!pointer_action.has_value()",
        });
        const calls = new Map(adapter.calls);
        calls.set(
            "options.shouldHandlePointerDown",
            () => "camera.should_handle_pointer_down()",
        );
        const platform = adapter.statement!;
        return this.controlBody("onPointerDown", {
            bindings,
            calls,
            statement: (statement, lowerer, indent) => {
                const elided = platform(statement, lowerer, indent);
                if (elided) return elided;
                if (!ts.isVariableStatement(statement)) return undefined;
                const [declaration] = statement.declarationList.declarations;
                if (
                    statement.declarationList.declarations.length !== 1 ||
                    !declaration ||
                    !ts.isIdentifier(declaration.name) ||
                    declaration.name.text !== "pointerAction" ||
                    !declaration.initializer
                )
                    return undefined;
                return [
                    `${indent}const std::optional<std::string_view> pointer_action = ${lowerer.expression(declaration.initializer)};`,
                ];
            },
            expression: (node) =>
                ts.isStringLiteral(node)
                    ? `std::string_view{${stringLiteral(node.text)}}`
                    : ts.isIdentifier(node) && node.text === "undefined"
                      ? "std::optional<std::string_view>{}"
                      : undefined,
        });
    }

    /** attachControl's onPointerMove, over the platform's relative motion. */
    public pointerMove(): string {
        const adapter = this.pointerAdapter();
        const bindings = new Map(adapter.bindings);
        bindings.set("activeTouches.size", {
            cpp: "touch_count",
            type: "scalar",
        });
        return this.controlBody("onPointerMove", { ...adapter, bindings });
    }

    /** attachControl's onPointerUp. */
    public pointerUp(): string {
        return this.controlBody("onPointerUp", this.pointerAdapter());
    }

    /** attachControl's onWheel, over the DOM `deltaY` the platform reports. */
    public wheel(): string {
        const adapter = this.pointerAdapter();
        const bindings = new Map(adapter.bindings);
        bindings.set("e.deltaY", { cpp: "delta_y", type: "scalar" });
        return this.controlBody("onWheel", { ...adapter, bindings });
    }
}
