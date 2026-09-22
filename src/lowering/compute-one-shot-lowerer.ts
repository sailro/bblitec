import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import {
    type LoweringContext,
    type LoweredSource,
    unwrapExpression,
} from "./context.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    pinnedRecordSchema,
} from "./pinned-record-literal.js";

const path = "src/compute/compute-one-shot.ts";
const shotSchema = pinnedRecordSchema("ComputeOneShot", {
    task: "task",
    completion: "completion",
    _generation: "generation",
    _armed: "armed",
    _disposed: "disposed",
    _resolve: "resolve",
    _reject: "reject",
});
const stateSchema = pinnedRecordSchema("ComputeOneShotState", {
    engine: "engine",
    shots: "shots",
    recordedByEncoder: "recorded",
    removeFramePostSubmit: "remove_frame_post_submit",
});
const completionSchema = pinnedRecordSchema("ComputeOneShotCompletion", {
    resolve: "resolve",
    reject: "reject",
});
const functions: Record<string, string> = {
    stateFor: "compute_one_shot_state_for",
    completeSubmittedOneShots: "complete_submitted_one_shots",
    rejectPending: "reject_pending_one_shot",
    releaseState: "release_one_shot_state",
    armInternal: "arm_one_shot_internal",
    createComputeOneShot: "create_compute_one_shot",
    armComputeOneShot: "arm_compute_one_shot",
    disposeComputeOneShot: "dispose_compute_one_shot",
};

function bodyScope(
    context: LoweringContext,
    file: ts.SourceFile,
): PinnedBodyScope {
    const bindings = new Map<string, PinnedBinding>();
    const bind = (
        name: string,
        cpp: string,
        type: PinnedBinding["type"] = "opaque",
    ) => bindings.set(name, { cpp, type });
    for (const name of [
        "oneShot",
        "state",
        "states",
        "engine",
        "encoder",
        "batch",
        "completions",
        "resolve",
        "reject",
        "error",
        "task",
    ])
        bind(name, name);
    bind("generation", "generation", "scalar");
    for (const [source, cpp, type] of [
        ["oneShot._generation", "oneShot->generation", "scalar"],
        ["oneShot._armed", "oneShot->armed", "bool"],
        ["oneShot._disposed", "oneShot->disposed", "bool"],
        ["oneShot._resolve", "oneShot->resolve", "opaque"],
        ["oneShot._reject", "oneShot->reject", "opaque"],
        ["oneShot.completion", "oneShot->completion", "opaque"],
        ["oneShot.task", "oneShot->task", "opaque"],
        ["oneShot.task.engine", "oneShot->task->engine", "opaque"],
        ["oneShot.task.name", "oneShot->task->name", "opaque"],
        ["oneShot.task._disposed", "oneShot->task->disposed", "bool"],
        [
            "oneShot.task.executionEnabled",
            "oneShot->task->execution_enabled",
            "bool",
        ],
        [
            "oneShot.task._oneShotRecorded",
            "oneShot->task->one_shot_recorded",
            "opaque",
        ],
        [
            "oneShot.task._oneShotDispose",
            "oneShot->task->one_shot_dispose",
            "opaque",
        ],
        ["task.name", "task->name", "opaque"],
        ["task.engine", "task->engine", "opaque"],
        ["task._disposed", "task->disposed", "bool"],
        ["task._oneShotRecorded", "task->one_shot_recorded", "opaque"],
        ["task._oneShotDispose", "task->one_shot_dispose", "opaque"],
        [
            "state.shots.size",
            "static_cast<double>(state->shots.size())",
            "scalar",
        ],
        ["state.engine", "state->engine.lock()", "opaque"],
        [
            "state.removeFramePostSubmit",
            "state->remove_frame_post_submit",
            "opaque",
        ],
        ["engine._currentEncoder", "engine->current_compute_encoder", "opaque"],
        [
            "engine._computeOneShotSubmitted",
            "engine->compute_one_shot_submitted",
            "opaque",
        ],
        [
            "completions.length",
            "static_cast<double>(completions.size())",
            "scalar",
        ],
    ] as const)
        bind(source, cpp, type);
    const calls = new Map<string, (args: readonly string[]) => string>(
        Object.entries(functions).map(([name, cpp]) => [
            name,
            (args) => `${cpp}(${args.join(", ")})`,
        ]),
    );
    calls.set(
        "state.recordedByEncoder.get",
        (args) =>
            `([&](){auto value=state->recorded.get(${args[0]});return value ? *value : nullptr;}())`,
    );
    calls.set(
        "state.recordedByEncoder.set",
        (args) => `state->recorded.set(${args.join(", ")})`,
    );
    calls.set(
        "state.recordedByEncoder.delete",
        (args) => `state->recorded.erase(${args.join(", ")})`,
    );
    calls.set("batch.set", (args) => `batch->set(${args.join(", ")})`);
    calls.set(
        "state.shots.add",
        (args) => `state->shots.add(${args.join(", ")})`,
    );
    calls.set(
        "state.removeFramePostSubmit",
        () => "state->remove_frame_post_submit()",
    );
    calls.set(
        "Promise.reject",
        (args) => `js::Promise<js::PromiseVoid>::rejected(${args.join(", ")})`,
    );
    calls.set(
        "Promise.resolve",
        () => "js::Promise<js::PromiseVoid>::resolved(js::PromiseVoid{})",
    );
    const closure = (
        arrow: ts.ArrowFunction,
        captures: readonly string[],
        parameters: readonly string[],
    ): string => {
        const names = captures
            .map(
                (name, index) =>
                    `[[maybe_unused]] const auto ${name}=std::get<${index}>(capture);`,
            )
            .join("\n");
        const scope = bodyScope(context, file);
        const { returnValue, ...numericScope } = scope;
        void returnValue;
        const lowerer = new PinnedNumericLowerer(file, numericScope);
        const body = ts.isBlock(arrow.body)
            ? lowerPinnedBody(file, arrow.body.statements, scope)
            : `${lowerer.expression(arrow.body)};`;
        return `js::make_closure(std::tuple{${captures.join(",")}},[](${["auto& capture", ...parameters].join(",")}){\n${names}\n${body}\n})`;
    };
    return {
        bindings,
        calls,
        booleanOr: true,
        booleanAnd: true,
        foldConditions: false,
        forOf(iterated, element) {
            if (
                iterated !== "batch" ||
                element.replace(/\s/g, "") !== "[oneShot,generation]"
            )
                return undefined;
            return {
                range: "*batch",
                bindings: new Map([
                    ["oneShot", { cpp: "oneShot", type: "opaque" }],
                    ["generation", { cpp: "generation", type: "scalar" }],
                ]),
            };
        },
        expression(node, lowerer) {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (
                node.kind === ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(node) && node.text === "undefined")
            )
                return "{}";
            if (ts.isTemplateExpression(node))
                return [
                    `std::string{${stringLiteral(node.head.text)}}`,
                    ...node.templateSpans.flatMap((span) => [
                        lowerer.expression(span.expression),
                        `std::string{${stringLiteral(span.literal.text)}}`,
                    ]),
                ].join("+");
            if (ts.isVoidExpression(node))
                return `(void)(${lowerer.expression(node.expression)})`;
            if (ts.isNewExpression(node)) {
                const name = node.expression.getText(file);
                if (name === "Error" && node.arguments?.length === 1)
                    return `js::make_error("Error",${lowerer.expression(node.arguments[0]!)})`;
                if (name === "Set")
                    return "js::Set<std::shared_ptr<ComputeOneShot>>{}";
                if (name === "WeakMap")
                    return "js::WeakMap<std::shared_ptr<ComputeOneShotBatch>>{}";
                if (name === "Map")
                    return "js::make_gc_shared<ComputeOneShotBatch>()";
                if (name === "Promise") {
                    const executor = node.arguments?.[0];
                    if (
                        !executor ||
                        !ts.isArrowFunction(executor) ||
                        !ts.isBlock(executor.body)
                    )
                        return context.contractError(
                            node,
                            "Expected one-shot promise executor.",
                        );
                    const body = lowerPinnedBody(
                        file,
                        executor.body.statements,
                        bodyScope(context, file),
                    );
                    return `([&](){js::Promise<js::PromiseVoid> promise;js::Callback<void()> resolve=js::make_closure(std::tuple{promise},[](auto& capture){std::get<0>(capture).resolve(js::PromiseVoid{});});js::Callback<void(std::exception_ptr)> reject=js::make_closure(std::tuple{promise},[](auto& capture,std::exception_ptr error){std::get<0>(capture).reject(error);});${body}\nreturn promise;}())`;
                }
            }
            if (ts.isObjectLiteralExpression(node)) {
                const names = node.properties.map((property) =>
                    property.name?.getText(file),
                );
                if (names.includes("task"))
                    return `js::make_gc_shared<ComputeOneShot>(${pinnedRecordLiteral(context, lowerer, node, shotSchema)})`;
                if (names.includes("recordedByEncoder"))
                    return `js::make_gc_shared<ComputeOneShotState>(${pinnedRecordLiteral(context, lowerer, node, stateSchema)})`;
            }
            if (ts.isArrowFunction(node)) {
                if (
                    !node.parameters.length &&
                    ts.isBlock(node.body) &&
                    node.body.statements.length === 0
                )
                    return "js::Callback<void()>([](){})";
                const names = node.parameters.map((parameter) =>
                    parameter.name.getText(file),
                );
                if (names.length === 1 && names[0] === "encoder")
                    return closure(
                        node,
                        ts.isBlock(node.body)
                            ? ["oneShot", "generation", "state"]
                            : ["state"],
                        ["std::shared_ptr<pal::ComputeCommandEncoder> encoder"],
                    );
                if (names.length === 0 && ts.isCallExpression(node.body))
                    return closure(
                        node,
                        node.body.expression.getText(file) ===
                            "disposeComputeOneShot"
                            ? ["oneShot"]
                            : ["state", "engine"],
                        [],
                    );
            }
            if (ts.isCallExpression(node)) {
                const name = unwrapExpression(node.expression).getText(file);
                if (name === "states.get")
                    return `find_compute_one_shot_state(${lowerer.expression(node.arguments[0]!)})`;
                if (name === "states.set")
                    return `states.insert_or_assign(${node.arguments.map((arg) => lowerer.expression(arg)).join(",")})`;
                if (name === "_engineStates?.get")
                    return `find_compute_one_shot_state(${lowerer.expression(node.arguments[0]!)})`;
                if (name === "_engineStates?.delete")
                    return `js::realm_scratch<ComputeOneShotRegistry>().values.erase(${lowerer.expression(node.arguments[0]!)})`;
                if (name === "addFramePostSubmitHook")
                    return `install_one_shot_frame_hook(${node.arguments.map((arg) => lowerer.expression(arg)).join(",")})`;
                if (name === "oneShot.completion.catch") {
                    context.assertExpressionShape(
                        node.arguments[0]!,
                        "() => undefined",
                        "One-shot handled rejection",
                    );
                    return "oneShot->completion.catch_error([](std::exception_ptr){return js::PromiseVoid{};})";
                }
                if (
                    name ===
                    "state.engine._device.queue.onSubmittedWorkDone().then"
                ) {
                    const loops = node.arguments.map((callback, index) => {
                        if (
                            !ts.isArrowFunction(callback) ||
                            !ts.isCallExpression(callback.body) ||
                            callback.body.expression.getText(file) !==
                                "completions.forEach"
                        )
                            return context.contractError(
                                callback,
                                "Expected one-shot completion fanout.",
                            );
                        const each = callback.body.arguments[0];
                        if (
                            !each ||
                            !ts.isArrowFunction(each) ||
                            !ts.isObjectBindingPattern(each.parameters[0]!.name)
                        )
                            return context.contractError(
                                callback,
                                "Expected completion record destructuring.",
                            );
                        const field =
                            each.parameters[0]!.name.elements[0]?.name.getText(
                                file,
                            );
                        if (field !== (index === 0 ? "resolve" : "reject"))
                            return context.contractError(
                                each,
                                "Expected completion callback field.",
                            );
                        if (ts.isBlock(each.body))
                            return context.contractError(
                                each.body,
                                "Expected completion invocation expression.",
                            );
                        context.assertExpressionShape(
                            each.body,
                            index === 0 ? "resolve?.()" : "reject?.(error)",
                            "Optional one-shot completion callback",
                        );
                        return `js::make_closure(std::tuple{completions},[](auto& capture,${index === 0 ? "const js::PromiseVoid&" : "std::exception_ptr error"}){for(const auto& entry:std::get<0>(capture)){if(entry.${field})entry.${field}(${index === 0 ? "" : "error"});}})`;
                    });
                    if (loops.length !== 2)
                        return context.contractError(
                            node,
                            "Expected both GPU completion outcomes.",
                        );
                    return `pal::submitted_gpu_work(state->engine.lock()->offscreen_run).then(${loops.join(",")})`;
                }
            }
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (
                ts.isVariableStatement(node) &&
                node.declarationList.declarations.length === 1
            ) {
                const declaration = node.declarationList.declarations[0]!;
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !declaration.initializer
                )
                    return undefined;
                const name = declaration.name.text;
                if (name === "generation")
                    return [
                        `${indent}const double generation=${lowerer.expression(declaration.initializer)};`,
                    ];
                if (name === "states") {
                    context.assertExpressionShape(
                        declaration.initializer,
                        "(_engineStates ??= new WeakMap())",
                        "One-shot weak engine index",
                    );
                    return [
                        `${indent}auto& states=js::realm_scratch<ComputeOneShotRegistry>().values;`,
                    ];
                }
                if (name === "completions") {
                    context.assertExpressionShape(
                        declaration.initializer,
                        "[]",
                        "One-shot completion batch",
                    );
                    return [
                        `${indent}js::Array<ComputeOneShotCompletion> completions;`,
                    ];
                }
                if (["state", "oneShot", "batch"].includes(name))
                    return [
                        `${indent}auto ${name}=${lowerer.expression(declaration.initializer)};`,
                    ];
            }
            if (ts.isExpressionStatement(node)) {
                const call = unwrapExpression(node.expression);
                if (ts.isVoidExpression(call))
                    return [
                        `${indent}(void)(${lowerer.expression(call.expression)});`,
                    ];
                if (ts.isCallExpression(call)) {
                    const name = call.expression.getText(file);
                    if (name === "completions.push")
                        return [
                            `${indent}completions.push_back(${pinnedRecordLiteral(context, lowerer, call.arguments[0]!, completionSchema)});`,
                        ];
                    if (name === "oneShot._reject")
                        return [
                            `${indent}if(oneShot->reject)oneShot->reject(${lowerer.expression(call.arguments[0]!)});`,
                        ];
                    if (name === "state?.shots.delete")
                        return [
                            `${indent}if(state)(void)state->shots.erase(${lowerer.expression(call.arguments[0]!)});`,
                        ];
                }
            }
            return undefined;
        },
        returnValue: (node, lowerer) => (node ? lowerer.expression(node) : ""),
    };
}

export function lowerComputeOneShot(context: LoweringContext): LoweredSource {
    const signatures: Record<string, string> = {
        stateFor:
            "static std::shared_ptr<ComputeOneShotState> compute_one_shot_state_for(const std::shared_ptr<Engine>& engine)",
        completeSubmittedOneShots:
            "static void complete_submitted_one_shots(const std::shared_ptr<ComputeOneShotState>& state,const std::shared_ptr<pal::ComputeCommandEncoder>& encoder)",
        rejectPending:
            "static void reject_pending_one_shot(const std::shared_ptr<ComputeOneShot>& oneShot,std::exception_ptr error)",
        releaseState:
            "static void release_one_shot_state(const std::shared_ptr<Engine>& engine,const std::shared_ptr<ComputeOneShotState>& state)",
        armInternal:
            "static js::Promise<js::PromiseVoid> arm_one_shot_internal(const std::shared_ptr<ComputeOneShot>& oneShot)",
        createComputeOneShot:
            "std::shared_ptr<ComputeOneShot> create_compute_one_shot(const std::shared_ptr<ComputeTask>& task)",
        armComputeOneShot:
            "js::Promise<js::PromiseVoid> arm_compute_one_shot(const std::shared_ptr<ComputeOneShot>& oneShot)",
        disposeComputeOneShot:
            "void dispose_compute_one_shot(const std::shared_ptr<ComputeOneShot>& oneShot)",
    };
    const output = Object.entries(signatures).map(([name, signature]) => {
        const { file, declaration } = context.functionDeclaration(path, name);
        return `// ${context.provenance(path, name)}\n${signature}{\n${lowerPinnedBody(file, declaration.body!.statements, bodyScope(context, file))}\n}`;
    });
    return {
        modulePath: path,
        symbolName: "createComputeOneShot",
        header: "",
        source: `#include <bblite/pal_compute_one_shot.hpp>\nnamespace bbl {\n${Object.values(
            signatures,
        )
            .map((signature) => signature + ";")
            .join("\n")}\n${output.join("\n")}\n}\n`,
    };
}
