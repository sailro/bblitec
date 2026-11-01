import { stringLiteral as cppStringLiteral } from "../cpp-literals.js";
import ts from "typescript";
import { type LoweringContext, type LoweredSource } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

import {
    collectionBinding,
    type PinnedBinding,
    type PinnedCallSpelling,
} from "./pinned-numeric-lowerer.js";
import { nestedFunctionDeclaration } from "./pinned-function-lowerer.js";
import {
    cameraPlatformStatement,
    cameraPointerDeltaBindings,
} from "./camera-mutation-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import {
    cameraScalarWrite,
    cameraVectorComponentWrite,
} from "../compiler/camera-setters.js";
import {
    cameraControlLifecycleHelpers,
    cameraControlPublication,
    lowerCameraControlLifecycle,
} from "./camera-control-attachment.js";

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
        deltaMs: "delta_ms",
    }))
        bindings.set(source, { type: "scalar", cpp: native });
    for (const [source, field] of [
        ["camera._yaw", "free_yaw"],
        ["camera._pitch", "free_pitch"],
    ] as const)
        bindings.set(source, {
            type: "scalar",
            cpp: `camera.${field}`,
            store: (value) => cameraScalarWrite("camera", field, value),
        });
    for (const axis of ["x", "y", "z"])
        bindings.set(`camera.position.${axis}`, {
            type: "scalar",
            cpp: `camera.position.${axis}`,
            store: (value) =>
                cameraVectorComponentWrite("camera", "position", axis, value),
        });
    return bindings;
}

function freeCameraCalls(): Map<string, PinnedCallSpelling> {
    const calls = new Map<string, PinnedCallSpelling>();
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
    attachment: string;
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
        attachment: lowerOwnedFreeControl(context),
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

function ownedCallbacks(
    context: LoweringContext,
    control: FreeControlSource,
    state: ReadonlyMap<string, PinnedBinding>,
    update: string,
): string {
    const pointer = (name: "onPointerDown" | "onPointerMove" | "onPointerUp") =>
        lowerFreePointer(context, control, name, state, {
            type: "bool",
            cpp: "pointer->dragging",
        });
    const keyboard = (name: "onKeyDown" | "onKeyUp") => {
        const { file, declaration } = nestedFunctionDeclaration(
            context,
            control.modulePath,
            control.symbol,
            name,
        );
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: new Map([
                [`${control.event}.code`, { type: "opaque", cpp: "code" }],
            ]),
            calls: new Map([
                [
                    "keys.add",
                    (args: readonly string[]) =>
                        `state->keys.insert(std::string(${args[0]}))`,
                ],
                [
                    "keys.delete",
                    (args: readonly string[]) =>
                        `state->keys.erase(std::string(${args[0]}))`,
                ],
            ]),
        });
    };
    return `
    auto control = std::make_shared<CameraControlAttachment>();
    control->pointer_down = [pointer = control.get()](double button, [[maybe_unused]] bool touch) {
${pointer("onPointerDown")}
    };
    control->pointer_move = [state, pointer = control.get(), camera_record = &camera]([[maybe_unused]] double touch_count, double delta_x, double delta_y) {
        auto& camera = *camera_record;
${pointer("onPointerMove")}
    };
    control->pointer_up = [pointer = control.get()] {
${pointer("onPointerUp")}
    };
    control->key_down = [state](std::string_view code) {
${keyboard("onKeyDown")}
    };
    control->key_up = [state](std::string_view code) {
${keyboard("onKeyUp")}
    };
    control->update = [state, camera_record = &camera](double delta_ms) {
        auto& camera = *camera_record;
        const auto pressed = [&state](std::string_view code) { return state->keys.contains(code); };
${update}
    };
`;
}

function lowerOwnedFreeControl(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        freeModule,
        freeControl.symbol,
    );
    const state = new Map<string, PinnedBinding>();
    const fields: string[] = [];
    for (const name of ["cdX", "cdY", "cdZ", "crX", "crY"]) {
        fields.push(
            `double ${name} = ${context.doubleLiteral(context.numericValue(context.variableInitializer(declaration, name), file))};`,
        );
        state.set(name, { type: "scalar", cpp: `state->${name}` });
    }
    context.assertExpressionShape(
        context.variableInitializer(declaration, "keys"),
        "new Set<string>()",
        "Free control key owner",
    );
    return `
js::Callback<void()> attach_free_control(Engine& engine, CameraHandle handle, const Scene& scene) {
    struct State { ${fields.join(" ")} std::set<std::string, std::less<>> keys; };
    auto state = std::make_shared<State>();
    auto& camera = ${recordAt("engine.cameras", "handle")};
${ownedCallbacks(context, freeControl, state, lowerFreeUpdate(context, freeControl, state))}
${cameraControlPublication(lowerCameraControlLifecycle(context, freeModule, freeControl.symbol))}
}
`;
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
            `    ${numeric ? "double" : "std::vector<std::string>"} ${name}{};`,
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
        bindings: new Map([["codes", collectionBinding("codes")]]),
        calls: freeCameraCalls(),
        expression: stringLiteral,
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
#include <set>
namespace bbl {
${cameraControlLifecycleHelpers}
js::Callback<void()> attach_configurable_free_control(Engine& engine, CameraHandle handle, const Scene& scene, ConfigurableFreeControlOptions options) {
    struct State {
${fields.join("\n")}
        std::set<std::string, std::less<>> keys;
    };
    auto state = std::make_shared<State>();
${optionInitializers.join("\n")}
    auto& camera = ${recordAt("engine.cameras", "handle")};
${ownedCallbacks(
    context,
    configurableControl,
    state,
    `
        const auto has_any = [&pressed](const std::vector<std::string>& codes) -> bool {
${predicate}
        };
${updateBody}
`,
)}
${cameraControlPublication(lowerCameraControlLifecycle(context, configurableModule, configurableControl.symbol))}
}
}
`,
    };
}
