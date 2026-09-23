import ts from "typescript";
import { type LoweringContext, type LoweredSource } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

const modulePath = "src/camera/configurable-free-camera-controls.ts";

/** Control state and event units are native adapters; every update expression comes from the pin. */
export function lowerConfigurableCameraControls(
    context: LoweringContext,
): LoweredSource {
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        "attachConfigurableFreeControl",
    );
    const bindings = new Map<string, PinnedBinding>();
    bindings.set("Math.PI", { type: "scalar", cpp: "std::numbers::pi" });
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
        bindings.set(name, { type: "scalar", cpp: `state->${name}` });
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
            cpp = `std::vector<std::string>{${fallback.elements.map((element) => JSON.stringify(ts.isStringLiteral(element) ? element.text : context.contractError(element, "Expected a literal key code."))).join(", ")}}`;
        }
        fields.push(
            `    ${numeric ? "double" : "std::vector<std::string>"} ${name};`,
        );
        optionInitializers.push(
            `    state->${name} = options.${name}.value_or(${cpp});`,
        );
        bindings.set(name, {
            type: numeric ? "scalar" : "opaque",
            cpp: `state->${name}`,
        });
    }
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
    const calls = pinnedNumericMathCalls();
    calls.set("keys.has", (args) => `pressed(${args.join(", ")})`);
    calls.set("hasAny", (args) => `has_any(${args.join(", ")})`);
    calls.set(
        "camera.target.set",
        (args) =>
            `set_camera_vector(camera, &CameraRecord::target, Vec3d{${args.join(", ")}})`,
    );
    const stringLiteral = (node: ts.Expression): string | undefined =>
        ts.isStringLiteral(node) ? JSON.stringify(node.text) : undefined;
    const hasAny = context.variableInitializer(declaration, "hasAny");
    if (!ts.isArrowFunction(hasAny) || !ts.isBlock(hasAny.body))
        context.contractError(hasAny, "Expected the pinned key predicate.");
    const predicate = lowerPinnedBody(file, hasAny.body.statements, {
        bindings: new Map(),
        calls,
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
    const nested = (name: string): ts.FunctionDeclaration => {
        const result = declaration.body!.statements.find(
            (node): node is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === name &&
                !!node.body,
        );
        return (
            result ??
            context.contractError(
                declaration,
                `Expected camera control callback '${name}'.`,
            )
        );
    };
    const update = nested("update");
    const updateBody = lowerPinnedBody(file, update.body!.statements, {
        bindings: new Map(bindings),
        calls,
        expression: stringLiteral,
        booleanOr: true,
        statement: (statement, lowerer, indent) => {
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
        },
    });
    const pointer = nested("onPointerMove");
    const pointerBindings = new Map(bindings);
    for (const axis of ["X", "Y"]) {
        pointerBindings.set(`lastPointer${axis}`, {
            type: "scalar",
            cpp: `previous_${axis}`,
        });
        pointerBindings.set(`event.client${axis}`, {
            type: "scalar",
            cpp: `delta_${axis}`,
        });
    }
    pointerBindings.set("isDragging", {
        type: "bool",
        cpp: "true",
        staticBoolean: true,
    });
    const pointerBody = lowerPinnedBody(file, pointer.body!.statements, {
        bindings: pointerBindings,
        calls,
    });
    return {
        modulePath,
        symbolName: "attachConfigurableFreeControl",
        header: "",
        source: `
// ${context.provenance(modulePath, "attachConfigurableFreeControl")}
#include <bblite/runtime.hpp>
#include <algorithm>
#include <cmath>
#include <numbers>
namespace bbl {
void attach_configurable_free_control(Engine& engine, CameraHandle handle, ConfigurableFreeControlOptions options) {
    struct State {
${fields.join("\n")}
    };
    auto state = std::make_shared<State>();
${optionInitializers.join("\n")}
    auto& camera = engine.cameras[handle.value];
    camera.controls_enabled = true;
    camera.configurable_free_pointer = [state](CameraRecord& camera, double delta_X, double delta_Y) {
        [[maybe_unused]] double previous_X = 0, previous_Y = 0;
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
