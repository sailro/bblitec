import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { type LoweredSource, type LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerGpuTaskTimer } from "./gpu-task-timer-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    type PinnedRecordSchema,
} from "./pinned-record-literal.js";

const modulePath = "src/engine/gpu-task-timing.ts";
const timerPath = "src/engine/gpu-task-timer.ts";
const snapshotType = "std::shared_ptr<pal::GpuTaskTimingSnapshot>";
const functions = new Map([
    ["isRenderTaskGpuTimingSupported", "is_render_task_gpu_timing_supported"],
    ["getRenderTaskGpuTimings", "get_render_task_gpu_timings"],
    ["setRenderTaskGpuTimingEnabled", "set_render_task_gpu_timing_enabled"],
    ["makeTimingSnapshot", "make_gpu_task_timing_snapshot"],
]);
const move = (value: string): string => `std::move(${value})`;
const snapshotSchema: PinnedRecordSchema = {
    cpp: "pal::GpuTaskTimingSnapshot",
    fields: {
        status: { cpp: "status", convert: move },
        supported: { cpp: "supported" },
        enabled: { cpp: "enabled" },
        frameIndex: { cpp: "frame_index" },
        tasks: { cpp: "tasks", convert: move },
        droppedTaskCount: { cpp: "dropped_task_count" },
        error: { cpp: "error", convert: move },
    },
};

/** Retain the pin's lifecycle and epoch guards; PAL owns device queries and async readback. */
export function lowerGpuTaskTiming(context: LoweringContext): LoweredSource {
    const timerFile = context.sourceFile(timerPath);
    const capacity = context.numericValue(
        context.moduleScopeConstant(timerFile, "INITIAL_TASK_CAPACITY")!,
        timerFile,
    );
    const maxInFlight = context.numericValue(
        context.moduleScopeConstant(timerFile, "MAX_IN_FLIGHT_READBACKS")!,
        timerFile,
    );
    const sources: string[] = [];
    for (const [name, native] of functions) {
        const { file, declaration } = context.functionDeclaration(
            modulePath,
            name,
        );
        if (!declaration.body)
            return context.contractError(
                declaration,
                "Expected GPU timing body.",
            );
        const setter = name === "setRenderTaskGpuTimingEnabled";
        const factory = name === "makeTimingSnapshot";
        if (factory)
            // Owning parameters are used only by this return, so their final
            // transfer into the snapshot cannot change source observations.
            context.assertFunctionBodyShape(
                declaration,
                "{ return { status, supported, enabled, frameIndex, tasks, droppedTaskCount, error }; }",
                "GPU task timing snapshot ownership transfer",
            );
        const bindings = new Map<string, PinnedBinding>();
        const bind = (name: string, cpp = name): void => {
            bindings.set(name, { cpp, type: "opaque" });
        };
        bind("engine");
        bind("enabled");
        const fail = (node: ts.Node): never =>
            context.contractError(
                node,
                "Unrepresented GPU task timing operation.",
            );
        const memberNames: Record<string, string> = {
            _gpuTaskTimerWanted: "wanted",
            _gpuTaskTimerEpoch: "epoch",
            _gpuTaskTimingResult: "result",
            _gpuTaskTimer: "timer",
            _gpuTaskTimerDisable: "disable",
        };
        for (const [property, member] of Object.entries(memberNames))
            bind(`engine.${property}`, `engine->${member}`);
        const expression = (
            node: ts.Expression,
            lowerer: PinnedNumericLowerer,
        ): string | undefined => {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (ts.isIdentifier(node) && node.text === "undefined")
                return "nullptr";
            if (ts.isArrayLiteralExpression(node) && !node.elements.length)
                return "std::vector<pal::GpuTaskTimingEntry>{}";
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "engine"
            ) {
                const member = memberNames[node.name.text];
                if (member) return `engine->${member}`;
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ) {
                context.assertExpressionShape(
                    node,
                    "engine._gpuTaskTimerEpoch ?? 0",
                    "Native timing epoch initial value",
                );
                return "engine->epoch";
            }
            if (ts.isCallExpression(node)) {
                if (
                    context.expressionMatchesShape(
                        node,
                        'engine._device.features.has("timestamp-query")',
                    )
                )
                    return "engine->supported";
                if (
                    context.expressionMatchesShape(
                        node,
                        "engine._gpuTaskTimerDisable?.()",
                    )
                )
                    return "([&] { if (engine->disable) engine->disable(); }())";
                if (ts.isIdentifier(node.expression)) {
                    if (node.expression.text === "createGpuTaskTimer") {
                        context.assertExpressionShape(
                            node,
                            "createGpuTaskTimer(engine._device)",
                            "Native timing device creation",
                        );
                        return `engine->create_timer(${capacity}, ${maxInFlight})`;
                    }
                    if (node.expression.text === "installGpuTaskTimer") {
                        if (
                            node.arguments.length !== 3 ||
                            node.arguments[0]?.getText(file) !== "timer" ||
                            node.arguments[1]?.getText(file) !== "engine"
                        )
                            return fail(node);
                        const callback = node.arguments[2]!;
                        if (
                            !ts.isArrowFunction(callback) ||
                            callback.parameters.length !== 1 ||
                            callback.parameters[0]?.name.getText(file) !==
                                "snapshot" ||
                            !ts.isBlock(callback.body)
                        )
                            return fail(callback);
                        const saved = new Map(bindings);
                        bind("snapshot");
                        const body = lowerPinnedBody(
                            file,
                            callback.body.statements,
                            scope(false),
                        );
                        bindings.clear();
                        for (const [key, value] of saved)
                            bindings.set(key, value);
                        // The source closure retains the engine. The installed native callback
                        // uses its existing state owner weakly to avoid a transport cycle.
                        return `engine->install_timer(timer, [weak = std::weak_ptr<pal::GpuTaskTimingState>(engine), epoch](${snapshotType} snapshot) {\n    if (const auto engine = weak.lock()) {\n${body}\n    }\n})`;
                    }
                }
            }
            if (factory && ts.isObjectLiteralExpression(node)) {
                return `std::make_shared<pal::GpuTaskTimingSnapshot>(${pinnedRecordLiteral(context, lowerer, node, snapshotSchema)})`;
            }
            return undefined;
        };
        const scope = (async: boolean) => ({
            bindings,
            foldConditions: false,
            calls: new Map(
                [...functions].map(([source, target]) => [
                    source,
                    (args: readonly string[]) =>
                        `${target}(${args.join(", ")})`,
                ]),
            ),
            booleanOr: true,
            booleanAnd: true,
            expression,
            returnValue: (
                value: ts.Expression | undefined,
                lowerer: PinnedNumericLowerer,
            ) => (value ? lowerer.expression(value) : ""),
            statement: (
                node: ts.Statement,
                lowerer: PinnedNumericLowerer,
                indent: string,
            ): readonly string[] | undefined => {
                if (ts.isReturnStatement(node) && async)
                    return [
                        `${indent}co_return ${node.expression ? lowerer.expression(node.expression) : ""};`,
                    ];
                if (ts.isVariableStatement(node))
                    return node.declarationList.declarations.map((local) => {
                        if (ts.isObjectBindingPattern(local.name)) {
                            if (
                                !local.initializer ||
                                !context.expressionMatchesShape(
                                    local.initializer,
                                    'await import("./gpu-task-timer.js")',
                                ) ||
                                local.name.elements
                                    .map((element) =>
                                        element.name.getText(file),
                                    )
                                    .join(",") !==
                                    "createGpuTaskTimer,installGpuTaskTimer"
                            )
                                return fail(local);
                            // The linked profiler is already available, but the source await still
                            // yields so disable/re-enable can invalidate the installation epoch.
                            return `${indent}co_await js::Promise<js::PromiseVoid>::resolved({});`;
                        }
                        if (!ts.isIdentifier(local.name) || !local.initializer)
                            return fail(local);
                        const value = lowerer.expression(local.initializer);
                        bind(local.name.text);
                        return `${indent}const auto ${local.name.text} = ${value};`;
                    });
                return undefined;
            },
        });
        const parameters: Record<string, string> = factory
            ? {
                  status: "std::string",
                  supported: "bool",
                  enabled: "bool",
                  frameIndex: "double",
                  tasks: "std::vector<pal::GpuTaskTimingEntry>",
                  droppedTaskCount: "double",
                  error: "std::optional<std::string>",
              }
            : {
                  engine: "std::shared_ptr<pal::GpuTaskTimingState>",
                  ...(setter ? { enabled: "bool" } : {}),
              };
        if (declaration.parameters.length !== Object.keys(parameters).length)
            return fail(declaration);
        const signature = declaration.parameters.map((parameter) => {
            if (!ts.isIdentifier(parameter.name)) return fail(parameter);
            const cppType = parameters[parameter.name.text];
            if (!cppType) return fail(parameter);
            bind(parameter.name.text);
            return `${cppType} ${parameter.name.text}`;
        });
        const resultType =
            name === "isRenderTaskGpuTimingSupported"
                ? "bool"
                : setter
                  ? `js::Promise<${snapshotType}>`
                  : snapshotType;
        sources.push(
            `// ${context.provenance(modulePath, name)}\n${resultType} ${native}(${signature.join(", ")}) {\n${lowerPinnedBody(file, declaration.body.statements, scope(setter))}\n}`,
        );
    }
    return {
        modulePath,
        symbolName: [...functions.keys()].join(","),
        header: "",
        source: `#include <bblite/pal_gpu_task_timing.hpp>\nnamespace bbl {\n${sources.join("\n\n")}\n}\n${lowerGpuTaskTimer(context)}`,
    };
}
