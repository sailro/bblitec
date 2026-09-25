import { stringLiteral as cppStringLiteral } from "../cpp-literals.js";
import ts from "typescript";
import { type LoweringContext, type LoweredSource } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type {
    PinnedBinding,
    PinnedCallSpelling,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { nestedFunctionDeclaration } from "./pinned-function-lowerer.js";
import {
    cameraPlatformStatement,
    cameraPointerDeltaBindings,
} from "./camera-mutation-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

const configurableModule = "src/camera/configurable-free-camera-controls.ts";
const freeModule = "src/camera/free-camera-controls.ts";

/** One pinned free-camera control factory and the names its closure uses. */
interface FreeControlSource {
    modulePath: string;
    symbol: string;
    /** The DOM event parameter every handler names. */
    event: string;
    /** The closure's last client position. */
    lastPosition: readonly [string, string];
}

const freeControl: FreeControlSource = {
    modulePath: freeModule,
    symbol: "attachFreeControl",
    event: "e",
    lastPosition: ["lastPX", "lastPY"],
};

const configurableControl: FreeControlSource = {
    modulePath: configurableModule,
    symbol: "attachConfigurableFreeControl",
    event: "event",
    lastPosition: ["lastPointerX", "lastPointerY"],
};

/**
 * The camera fields both free-camera factories read and write. Their
 * `_yaw`/`_pitch` and position components are accessors that version the
 * camera, so a store goes through the generated setter the scene compiler
 * also writes through.
 */
function freeCameraBindings(): Map<string, PinnedBinding> {
    const bindings = new Map<string, PinnedBinding>();
    bindings.set("Math.PI", { type: "scalar", cpp: "std::numbers::pi" });
    for (const [source, native] of Object.entries({
        "camera.speed": "camera.speed",
        "camera.inertia": "camera.inertia",
        "camera.angularSensitivity": "camera.angular_sensibility",
        "camera._yaw": "camera.free_yaw",
        "camera._pitch": "camera.free_pitch",
        "camera.position.x": "camera.position.x",
        "camera.position.y": "camera.position.y",
        "camera.position.z": "camera.position.z",
        deltaMs: "delta_ms",
    }))
        bindings.set(source, { type: "scalar", cpp: native });
    return bindings;
}

function freeCameraCalls(): Map<string, PinnedCallSpelling> {
    const calls = pinnedNumericMathCalls();
    calls.set("keys.has", (args) => `pressed(${args.join(", ")})`);
    calls.set(
        "camera.target.set",
        (args) =>
            `set_camera_vector(camera, &CameraRecord::target, Vec3d{${args.join(", ")}})`,
    );
    return calls;
}

function stringLiteral(node: ts.Expression): string | undefined {
    return ts.isStringLiteral(node) ? cppStringLiteral(node.text) : undefined;
}

/** Stores into the camera's accessor-backed fields, through their setters. */
function accessorStatement(
    context: LoweringContext,
): NonNullable<PinnedNumericScope["statement"]> {
    return (statement, lowerer, indent) => {
        if (
            !ts.isExpressionStatement(statement) ||
            !ts.isBinaryExpression(statement.expression)
        )
            return undefined;
        const assignment = statement.expression;
        const path = context.propertyPath(assignment.left)?.join(".");
        const field =
            path === "camera._yaw"
                ? "free_yaw"
                : path === "camera._pitch"
                  ? "free_pitch"
                  : undefined;
        const component = ["x", "y", "z"].find(
            (axis) => path === `camera.position.${axis}`,
        );
        if (!field && !component) return undefined;
        const operator = assignment.operatorToken.kind;
        if (
            ![
                ts.SyntaxKind.EqualsToken,
                ts.SyntaxKind.PlusEqualsToken,
                ts.SyntaxKind.MinusEqualsToken,
            ].includes(operator)
        )
            context.contractError(
                assignment,
                "Unsupported camera accessor assignment.",
            );
        const right = lowerer.expression(assignment.right);
        const value =
            operator === ts.SyntaxKind.EqualsToken
                ? right
                : `${lowerer.expression(assignment.left)} ${operator === ts.SyntaxKind.PlusEqualsToken ? "+" : "-"} (${right})`;
        return [
            indent +
                (field
                    ? `write_camera_scalar(camera, &CameraRecord::${field}, ${value});`
                    : `write_camera_vector_component(camera, &CameraRecord::position, &Vec3d::${component}, ${value});`),
        ];
    };
}

/** A factory's per-frame `update(deltaMs)`, over its closure's accumulators. */
function lowerFreeUpdate(
    context: LoweringContext,
    control: FreeControlSource,
    state: ReadonlyMap<string, PinnedBinding>,
    extraCalls: ReadonlyMap<string, PinnedCallSpelling> = new Map(),
): string {
    const { file, declaration: callback } = nestedFunctionDeclaration(
        context,
        control.modulePath,
        control.symbol,
        "update",
    );
    const bindings = freeCameraBindings();
    for (const [name, binding] of state) bindings.set(name, binding);
    const calls = freeCameraCalls();
    for (const [name, spelling] of extraCalls) calls.set(name, spelling);
    return lowerPinnedBody(file, callback.body!.statements, {
        bindings,
        calls,
        expression: stringLiteral,

        statement: accessorStatement(context),
    });
}

/**
 * A factory's pointer callback over the native pointer state: the drag
 * flag is the caller's, the DOM button and relative motion the platform
 * layer's.
 */
function lowerFreePointer(
    context: LoweringContext,
    control: FreeControlSource,
    name: "onPointerDown" | "onPointerMove" | "onPointerUp",
    state: ReadonlyMap<string, PinnedBinding>,
    dragging: PinnedBinding,
): string {
    const { file, declaration: callback } = nestedFunctionDeclaration(
        context,
        control.modulePath,
        control.symbol,
        name,
    );
    const bindings = freeCameraBindings();
    for (const [source, binding] of state) bindings.set(source, binding);
    bindings.set("isDragging", dragging);
    bindings.set(`${control.event}.button`, {
        type: "scalar",
        cpp: "button",
    });
    for (const [source, binding] of cameraPointerDeltaBindings(
        control.event,
        control.lastPosition,
    ))
        bindings.set(source, binding);
    return lowerPinnedBody(file, callback.body!.statements, {
        bindings,
        calls: freeCameraCalls(),

        statement: cameraPlatformStatement(
            context,
            control.event,
            control.lastPosition,
        ),
    });
}

/** attachFreeControl's closure accumulators, held on the camera record. */
const freeAccumulators = new Map<string, PinnedBinding>([
    ["cdX", { type: "scalar", cpp: "camera.inertial_direction.x" }],
    ["cdY", { type: "scalar", cpp: "camera.inertial_direction.y" }],
    ["cdZ", { type: "scalar", cpp: "camera.inertial_direction.z" }],
    ["crX", { type: "scalar", cpp: "camera.inertial_pitch_offset" }],
    ["crY", { type: "scalar", cpp: "camera.inertial_yaw_offset" }],
]);

const draggingReference: PinnedBinding = { type: "bool", cpp: "is_dragging" };

/**
 * attachFreeControl's handlers and per-frame update, lowered whole from the
 * pinned closure. The platform layer supplies the DOM button, the relative
 * pointer motion, the frame's delta and the pressed `KeyboardEvent.code`s.
 */
export function lowerFreeCameraControls(context: LoweringContext): {
    declarations: string;
    definitions: string;
} {
    const pointer = (
        name: "onPointerDown" | "onPointerMove" | "onPointerUp",
    ): string =>
        lowerFreePointer(
            context,
            freeControl,
            name,
            freeAccumulators,
            draggingReference,
        );
    return {
        declarations: `
// ${context.provenance(freeModule, "attachFreeControl")}
// The handlers of the pinned closure: the drag flag is the platform
// layer's pointer state, the button a DOM \`PointerEvent.button\`, the
// deltas relative client motion and \`pressed\` answers \`keys.has\` for a
// \`KeyboardEvent.code\`. The closure's accumulators live on the record.
void free_camera_pointer_down(bool& is_dragging, double button);
void free_camera_pointer_move(
    CameraRecord& camera, bool is_dragging, double delta_x, double delta_y);
void free_camera_pointer_up(bool& is_dragging);
void free_camera_update(
    CameraRecord& camera,
    double delta_ms,
    const std::function<bool(std::string_view)>& pressed);
`,
        definitions: `
// ${context.provenance(freeModule, "attachFreeControl")}
void free_camera_pointer_down(bool& is_dragging, double button) {
${pointer("onPointerDown")}
}

void free_camera_pointer_move(
    CameraRecord& camera, bool is_dragging, double delta_x, double delta_y) {
${pointer("onPointerMove")}
}

void free_camera_pointer_up(bool& is_dragging) {
${pointer("onPointerUp")}
}

void free_camera_update(
    CameraRecord& camera,
    double delta_ms,
    const std::function<bool(std::string_view)>& pressed) {
${lowerFreeUpdate(context, freeControl, freeAccumulators)}
}
`,
    };
}

/** Control state and event units are native adapters; every update expression comes from the pin. */
export function lowerConfigurableCameraControls(
    context: LoweringContext,
): LoweredSource {
    const { file, declaration } = context.functionDeclaration(
        configurableModule,
        "attachConfigurableFreeControl",
    );
    const state = new Map<string, PinnedBinding>();
    const fields: string[] = [];
    for (const name of [
        "directionX",
        "directionY",
        "directionZ",
        "rotationX",
        "rotationY",
    ]) {
        const value = context.numericValue(
            context.variableInitializer(declaration, name),
            file,
        );
        fields.push(`    double ${name} = ${value};`);
        state.set(name, { type: "scalar", cpp: `state->${name}` });
    }
    const optionInitializers: string[] = [];
    for (const name of ["upKeys", "downKeys", "fastKeys", "fastMultiplier"]) {
        const initializer = context.variableInitializer(declaration, name);
        if (
            !ts.isBinaryExpression(initializer) ||
            initializer.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken ||
            !ts.isPropertyAccessExpression(initializer.left) ||
            !ts.isIdentifier(initializer.left.expression) ||
            initializer.left.expression.text !== "options" ||
            initializer.left.name.text !== name
        )
            context.contractError(
                initializer,
                "Configurable camera option default changed.",
            );
        const fallback = initializer.right;
        const numeric = name === "fastMultiplier";
        let cpp: string;
        if (numeric) cpp = String(context.numericValue(fallback, file));
        else {
            if (
                !ts.isArrayLiteralExpression(fallback) ||
                !fallback.elements.every(ts.isStringLiteral)
            )
                context.contractError(
                    fallback,
                    "Camera key defaults require literal codes.",
                );
            cpp = `std::vector<std::string>{${fallback.elements.map((element) => cppStringLiteral(ts.isStringLiteral(element) ? element.text : context.contractError(element, "Expected a literal key code."))).join(", ")}}`;
        }
        fields.push(
            `    ${numeric ? "double" : "std::vector<std::string>"} ${name};`,
        );
        optionInitializers.push(
            `    state->${name} = options.${name}.value_or(${cpp});`,
        );
        state.set(name, {
            type: numeric ? "scalar" : "opaque",
            cpp: `state->${name}`,
        });
    }
    const hasAny = context.variableInitializer(declaration, "hasAny");
    if (!ts.isArrowFunction(hasAny) || !ts.isBlock(hasAny.body))
        context.contractError(hasAny, "Expected the pinned key predicate.");
    const predicate = lowerPinnedBody(file, hasAny.body.statements, {
        bindings: new Map(),
        calls: freeCameraCalls(),
        expression: stringLiteral,
        forOf: (source, element) =>
            source === "codes"
                ? {
                      range: "codes",
                      bindings: new Map([
                          [element, { type: "opaque", cpp: element }],
                      ]),
                  }
                : undefined,
        returnValue: (node, lowerer) =>
            node
                ? lowerer.expression(node)
                : context.contractError(
                      hasAny,
                      "Key predicate requires a boolean result.",
                  ),
    });
    const updateBody = lowerFreeUpdate(
        context,
        configurableControl,
        state,
        new Map([["hasAny", (args) => `has_any(${args.join(", ")})`]]),
    );
    // The platform layer only moves a dragging configurable camera, so the
    // drag flag the callback tests is the one it was called under.
    const pointerBody = lowerFreePointer(
        context,
        configurableControl,
        "onPointerMove",
        state,
        { type: "bool", cpp: "true", staticBoolean: true },
    );
    // The record has no configurable pointer-down or pointer-up slot: the
    // platform layer starts and ends a free-camera drag through
    // attachFreeControl's lowered handlers, which is exact only while this
    // module's handlers lower to the same statements.
    for (const name of ["onPointerDown", "onPointerUp"] as const) {
        const configurable = lowerFreePointer(
            context,
            configurableControl,
            name,
            state,
            draggingReference,
        );
        if (
            configurable !==
            lowerFreePointer(
                context,
                freeControl,
                name,
                freeAccumulators,
                draggingReference,
            )
        )
            context.contractError(
                nestedFunctionDeclaration(
                    context,
                    configurableControl.modulePath,
                    configurableControl.symbol,
                    name,
                ).declaration,
                `Configurable ${name} no longer matches attachFreeControl's.`,
            );
    }
    return {
        modulePath: configurableModule,
        symbolName: "attachConfigurableFreeControl",
        header: "",
        source: `
// ${context.provenance(configurableModule, "attachConfigurableFreeControl")}
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
namespace bbl {
void attach_configurable_free_control(Engine& engine, CameraHandle handle, const Scene& scene, ConfigurableFreeControlOptions options) {
    struct State {
${fields.join("\n")}
    };
    auto state = std::make_shared<State>();
${optionInitializers.join("\n")}
    auto& camera = ${recordAt("engine.cameras", "handle")};
    camera.controls_enabled = true;
    camera.controls_scene = scene.state;
    camera.configurable_free_pointer = [state](CameraRecord& camera, double delta_x, double delta_y) {
${pointerBody}
    };
    camera.configurable_free_update = [state](CameraRecord& camera, double delta_ms, const std::function<bool(std::string_view)>& pressed) {
        const auto has_any = [&pressed](const std::vector<std::string>& codes) -> bool {
${predicate}
        };
${updateBody}
    };
}
}
`,
    };
}
