import ts from "typescript";
import { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { absentBinding, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";

/** The pinned attachment's registration and returned disposer, over native listeners. */
export function lowerCameraControlLifecycle(
    context: LoweringContext,
    module: string,
    symbol: string,
): { initialization: string; registration: string; disposal: string } {
    const { file, declaration } = context.functionDeclaration(module, symbol);
    const statements = declaration.body!.statements;
    const initialization: string[] = [];
    for (const [source, native] of [
        ["isDragging", "dragging"],
        ["isPanning", "panning"],
    ] as const) {
        const variable = statements
            .flatMap((statement) =>
                ts.isVariableStatement(statement)
                    ? [...statement.declarationList.declarations]
                    : [],
            )
            .find(
                (entry) =>
                    ts.isIdentifier(entry.name) && entry.name.text === source,
            );
        if (!variable?.initializer) continue;
        const value = context.unwrapExpression(variable.initializer);
        if (
            value.kind !== ts.SyntaxKind.TrueKeyword &&
            value.kind !== ts.SyntaxKind.FalseKeyword
        )
            context.contractError(
                value,
                "Expected a literal initial camera drag flag.",
            );
        initialization.push(
            `    control->${native} = ${value.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false"};`,
        );
    }
    const hasCall = (node: ts.Node, path: string) =>
        context
            .findNodes(node, ts.isCallExpression)
            .some(
                (call) =>
                    context.propertyPath(call.expression)?.join(".") === path,
            );
    const start = statements.findIndex((statement) =>
        hasCall(statement, "scene._beforeRender.push"),
    );
    const returned = statements.find(ts.isReturnStatement);
    if (
        start < 0 ||
        !returned?.expression ||
        !ts.isArrowFunction(returned.expression) ||
        !ts.isBlock(returned.expression.body)
    )
        return context.contractError(
            declaration,
            "Expected a camera control registration and disposer.",
        );
    const bindings = new Map<string, PinnedBinding>([
        ["scene", { cpp: "static_cast<bool>(scene_state)", type: "bool" }],
        ["applyInertia", { cpp: "control->update", type: "opaque" }],
        ["update", { cpp: "control->update", type: "opaque" }],
        ["keyboardAttachment", absentBinding()],
    ]);
    for (const statement of statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name)
            bindings.set(statement.name.text, {
                cpp:
                    statement.name.text === "update" ||
                    statement.name.text === "applyInertia"
                        ? "control->update"
                        : "0",
                type: "opaque",
            });
    }
    const events: string[] = [];
    // Names the listener table reads: native listeners keep no options, so a
    // local options record the table shares (`nonPassive`) goes with it.
    const tableNames = new Set<string>();
    const listeners = statements
        .flatMap((statement) =>
            ts.isVariableStatement(statement)
                ? [...statement.declarationList.declarations]
                : [],
        )
        .find(
            (variable) =>
                ts.isIdentifier(variable.name) &&
                variable.name.text === "listeners",
        );
    if (listeners?.initializer) {
        const array = context.unwrapExpression(listeners.initializer);
        if (!ts.isArrayLiteralExpression(array))
            context.contractError(
                array,
                "Expected the control listener table.",
            );
        for (const row of array.elements) {
            if (
                !ts.isArrayLiteralExpression(row) ||
                !ts.isStringLiteral(row.elements[0]!)
            )
                context.contractError(
                    row,
                    "Expected a literal control event name.",
                );
            events.push(row.elements[0].text);
        }
        for (const name of context.findNodes(array, ts.isIdentifier))
            tableNames.add(name.text);
    }
    const lower = (body: readonly ts.Statement[]) =>
        lowerPinnedBody(file, body, {
            bindings,
            calls: new Map([
                [
                    "scene._beforeRender.push",
                    (args: readonly string[]) =>
                        `scene_state->before_render.push_back(${args[0]})`,
                ],
                [
                    "scene._beforeRender.indexOf",
                    (args: readonly string[]) =>
                        `js::array_index_of(static_cast<const SnapshotList<js::Callback<void(double)>>::Storage&>(scene_state->before_render), ${args[0]})`,
                ],
                [
                    "scene._beforeRender.splice",
                    (args: readonly string[]) =>
                        `camera_control_remove_callback(scene_state->before_render, ${args.join(", ")})`,
                ],
                [
                    "canvas.addEventListener",
                    (args: readonly string[]) =>
                        `control->listeners.push_back(${args[0]})`,
                ],
                [
                    "canvas.removeEventListener",
                    (args: readonly string[]) =>
                        `std::erase(control->listeners, std::string_view{${args[0]}})`,
                ],
            ]),
            callShapes: new Map([["scene._beforeRender.indexOf", "scalar"]]),
            expression: (node) =>
                ts.isStringLiteral(node) ? stringLiteral(node.text) : undefined,
            statement: (statement, _lowerer, indent) => {
                if (
                    ts.isVariableStatement(statement) &&
                    statement.declarationList.declarations.some(
                        (variable) =>
                            ts.isIdentifier(variable.name) &&
                            variable.name.text === "listeners",
                    )
                )
                    return [];
                if (
                    ts.isVariableStatement(statement) &&
                    statement.declarationList.declarations.every(
                        (variable) =>
                            ts.isIdentifier(variable.name) &&
                            tableNames.has(variable.name.text) &&
                            variable.initializer !== undefined &&
                            ts.isObjectLiteralExpression(
                                context.unwrapExpression(variable.initializer),
                            ),
                    )
                )
                    return [];
                if (
                    ts.isForOfStatement(statement) &&
                    context.expressionMatchesShape(
                        statement.expression,
                        "listeners",
                    )
                ) {
                    const removing = hasCall(
                        statement,
                        "canvas.removeEventListener",
                    );
                    context.assertStatementShapes(
                        statement,
                        [statement],
                        removing
                            ? "for (const [ev, h] of listeners) { canvas.removeEventListener(ev, h); }"
                            : "for (const [ev, h, opts] of listeners) { canvas.addEventListener(ev, h, opts); }",
                        "Control listener registration loop",
                    );
                    return events.map(
                        (event) =>
                            `${indent}${removing ? `std::erase(control->listeners, std::string_view{${stringLiteral(event)}})` : `control->listeners.push_back(${stringLiteral(event)})`};`,
                    );
                }
                if (
                    ts.isIfStatement(statement) &&
                    hasCall(statement.expression, "canvas.hasAttribute")
                ) {
                    context.assertStatementShapes(
                        statement,
                        [statement],
                        'if (!canvas.hasAttribute("tabindex")) { canvas.tabIndex = 0; }',
                        "Native canvas keyboard focus adaptation",
                    );
                    return [];
                }
                return undefined;
            },
        });
    return {
        initialization: initialization.join("\n"),
        registration: lower(
            statements.slice(start, statements.indexOf(returned)),
        ),
        disposal: lower(returned.expression.body.statements),
    };
}

export const cameraControlLifecycleHelpers = `
namespace {
void camera_control_remove_callback(SnapshotList<js::Callback<void(double)>>& callbacks,
                                    double index, double count) {
    const auto offset = static_cast<std::size_t>(index);
    const auto length = static_cast<std::size_t>(count);
    callbacks.erase(callbacks.begin() + static_cast<std::ptrdiff_t>(offset),
                    callbacks.begin() + static_cast<std::ptrdiff_t>(offset + length));
}
} // namespace
`;

/** Native owner transport; the supplied registration and removal bodies are pinned. */
export function cameraControlPublication(lifecycle: {
    initialization: string;
    registration: string;
    disposal: string;
}): string {
    return `
${lifecycle.initialization}
    auto scene_state = scene.state;
    control->scene = scene_state;
${lifecycle.registration}
    if (!engine.camera_control_bindings) engine.camera_control_bindings = std::make_shared<CameraControlBindings>();
    engine.camera_control_bindings->entries.push_back(control);
    return [control, weak_scene = std::weak_ptr<SceneState>(scene_state),
            weak_bindings = std::weak_ptr<CameraControlBindings>(engine.camera_control_bindings)] {
        const auto scene_state = weak_scene.lock();
${lifecycle.disposal}
        if (const auto bindings = weak_bindings.lock()) std::erase(bindings->entries, control);
    };
`;
}

/** JavaScript array iteration re-reads length and the indexed callback after mutations. */
export function lowerSceneBeforeRenderDispatch(
    context: LoweringContext,
): string {
    const module = "src/scene/scene-core.ts";
    const file = context.sourceFile(module);
    const loops = context.findNodes(
        file,
        (node): node is ts.ForOfStatement =>
            ts.isForOfStatement(node) &&
            context.propertyPath(node.expression)?.join(".") ===
                "ctx._beforeRender",
    );
    if (loops.length !== 1 || !ts.isBlock(loops[0]!.statement))
        context.contractError(
            file,
            "Expected one live scene before-render callback loop.",
        );
    const loop = loops[0]!;
    context.assertStatementShapes(
        loop,
        [loop],
        "for (const cb of ctx._beforeRender) { cb(d); }",
        "Scene before-render callback loop",
    );
    const body = lowerPinnedBody(
        file,
        (loop.statement as ts.Block).statements,
        {
            bindings: new Map([["d", { type: "scalar", cpp: "delta_ms" }]]),
            calls: new Map([
                [
                    "cb",
                    (args: readonly string[]) => `callback(${args.join(", ")})`,
                ],
            ]),
        },
    );
    return `
// ${context.provenance(module, "createSceneContext")}
void run_scene_before_render(Scene& scene, double delta_ms) {
    for (std::size_t index = 0; index < scene.before_render.size(); ++index) {
        const auto callback = scene.before_render[index];
${body}
    }
}
`;
}
