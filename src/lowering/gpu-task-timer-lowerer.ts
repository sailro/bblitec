import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import {
    pinnedRecordLiteral,
    pinnedRecordSchema,
    type PinnedRecordSchema,
} from "./pinned-record-literal.js";
import {
    sameSource,
    propertyPath,
    isOneOfSources,
} from "../compiler/syntax.js";

const modulePath = "src/engine/gpu-task-timer.ts";
const recordSchema = pinnedRecordSchema("GpuTaskTimingRecord", {
    index: "index",
    name: "name",
    beginQueryIndex: "begin_query_index",
    endQueryIndex: "end_query_index",
});
const entrySchema = pinnedRecordSchema("GpuTaskTimingEntry", {
    index: "index",
    name: "name",
    durationMs: "duration_ms",
});
const activeSchema = pinnedRecordSchema("GpuActiveTaskTiming", {
    beginQueryIndex: "begin_query_index",
    endQueryIndex: "end_query_index",
    passCount: "pass_count",
    conflicted: "conflicted",
    dropped: "dropped",
});
/** The active task's timing; every read follows the pin's own presence guard. */
const active = "bbl::js::present(active_task_timing)";
/** `bigint | null` locals of the readback envelope. */
const envelope = new Set(["earliestBegin", "latestEnd"]);
/** Boolean fields of the timer and its active task timing. */
const booleans = new Set(["skipFrame", "disposed", "conflicted", "dropped"]);

/**
 * Pinned scheduling/readback policy over native query and nonblocking-map
 * transport. The pin attaches its timestamps to the passes a task opens by
 * wrapping the frame encoder; native task execution calls `pass_timestamps`
 * at each source pass instead, and the frame conductor owns the encoder.
 */
export function lowerGpuTaskTimer(context: LoweringContext): string {
    const file = context.sourceFile(modulePath);
    const definition = (name: string) =>
        context.functionDeclaration(modulePath, name).declaration;
    const fail = (node: ts.Node): never =>
        context.contractError(node, "Unrepresented GPU task timer operation.");
    const members: Record<string, string> = {
        records: "records",
        taskCapacity: "task_capacity",
        nextQueryIndex: "next_query_index",
        nextTaskIndex: "next_task_index",
        frameIndex: "frame_index",
        lastPublishedFrameIndex: "last_published_frame_index",
        droppedTaskCount: "dropped_task_count",
        inFlight: "in_flight",
        skipFrame: "skip_frame",
        disposed: "disposed",
    };
    const outputs: string[] = [];
    let completedSnapshot: ts.CallExpression | undefined;
    let skip: ts.IfStatement | undefined;
    type Phase =
        | "begin"
        | "restore"
        | "task-begin"
        | "task-end"
        | "pass"
        | "finish"
        | "complete"
        | "error"
        | "publish"
        | "dispose";
    function body(statements: readonly ts.Statement[], phase: Phase): string {
        const bindings = new Map<string, PinnedBinding>([
            [
                "MAX_IN_FLIGHT_READBACKS",
                { cpp: "max_in_flight", type: "scalar" },
            ],
        ]);
        const fields = [
            ...Object.entries(members).map(
                ([source, native]) => [`timer.${source}`, native] as const,
            ),
            ...Object.entries(activeSchema.fields).map(
                ([source, field]) =>
                    [`timing.${source}`, `${active}.${field.cpp}`] as const,
            ),
        ];
        for (const [path, cpp] of fields)
            bindings.set(path, {
                cpp,
                type:
                    path === "timer.records"
                        ? "opaque"
                        : booleans.has(path.slice(path.indexOf(".") + 1))
                          ? "bool"
                          : "scalar",
            });
        bindings.set("timing", {
            cpp: active,
            type: "opaque",
            absentCpp: "!active_task_timing",
            absentValue: "null",
        });
        bindings.set("taskIndex", { cpp: "task_index", type: "scalar" });
        bindings.set("task.name", { cpp: "name", type: "opaque" });
        bindings.set("pending.frameIndex", {
            cpp: "pending.frame_index",
            type: "scalar",
        });
        bindings.set("pending.droppedTaskCount", {
            cpp: "pending.dropped_task_count",
            type: "scalar",
        });
        bindings.set("snapshot.frameIndex", {
            cpp: "snapshot->frame_index",
            type: "scalar",
        });
        bindings.set("error", { cpp: "error", type: "opaque" });
        const expression = (
            node: ts.Expression,
            lowerer: PinnedNumericLowerer,
        ): string | undefined => {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (
                ts.isBinaryExpression(node) &&
                context.expressionMatchesShape(
                    node,
                    "descriptor?.timestampWrites !== undefined",
                )
            )
                return "has_timestamp_writes";
            if (ts.isPropertyAccessExpression(node)) {
                if (phase === "finish" && sameSource(node, "records.length"))
                    return "static_cast<double>(frame_records.size())";
                if (
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "record"
                ) {
                    const field = recordSchema.fields[node.name.text];
                    if (field) return `record.${field.cpp}`;
                }
            }
            if (
                ts.isElementAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "raw"
            )
                return `raw.at(gpu_timestamp_index(${lowerer.expression(node.argumentExpression)}))`;
            if (ts.isArrayLiteralExpression(node) && !node.elements.length)
                return "std::vector<GpuTaskTimingEntry>{}";
            if (ts.isCallExpression(node)) {
                const name = propertyPath(node.expression)?.join(".");
                if (name === "Number" && node.arguments.length === 1)
                    return `static_cast<double>(${lowerer.expression(node.arguments[0]!)})`;
                if (
                    name === "readbackErrorMessage" &&
                    node.arguments.length === 1
                )
                    return lowerer.expression(node.arguments[0]!);
                if (
                    name === "restoreTimingEncoder" &&
                    context.expressionMatchesShape(
                        node,
                        "restoreTimingEncoder(timer)",
                    )
                )
                    return "restore_timing_encoder()";
                if (name === "timer.records.push") {
                    const record = node.arguments[0];
                    if (
                        node.arguments.length !== 1 ||
                        !record ||
                        !ts.isObjectLiteralExpression(record)
                    )
                        return fail(node);
                    return `records.push_back(${object(record, recordSchema, lowerer)})`;
                }
                if (name === "tasks.push") {
                    const record = node.arguments[0];
                    if (
                        node.arguments.length !== 1 ||
                        !record ||
                        !ts.isObjectLiteralExpression(record)
                    )
                        return fail(node);
                    return `tasks.push_back(${object(record, entrySchema, lowerer)})`;
                }
                if (name === "makeTimingSnapshot")
                    return `bbl::make_gpu_task_timing_snapshot(${node.arguments
                        .map((arg, index) => {
                            const value = lowerer.expression(arg);
                            return node === completedSnapshot && index === 4
                                ? `std::move(${value})`
                                : value;
                        })
                        .join(", ")})`;
                // The publisher every pending readback carries is the one the
                // timer was installed with, which the native timer owns.
                if (name === "publishTaskTimingSnapshot") {
                    const [timer, publisher, snapshot] = node.arguments;
                    if (
                        node.arguments.length !== 3 ||
                        !sameSource(timer, "timer") ||
                        !publisher ||
                        !isOneOfSources(publisher, [
                            "publish",
                            "pending.publish",
                        ]) ||
                        !snapshot
                    )
                        return fail(node);
                    return `publish_snapshot(${lowerer.expression(snapshot)})`;
                }
                if (
                    phase === "publish" &&
                    context.expressionMatchesShape(node, "publish(snapshot)")
                )
                    return "publish(snapshot)";
            }
            return undefined;
        };
        function object(
            node: ts.ObjectLiteralExpression,
            schema: PinnedRecordSchema,
            lowerer: PinnedNumericLowerer,
        ): string {
            const names = Object.keys(schema.fields);
            node.properties.forEach((property, index) => {
                if (
                    (!ts.isShorthandPropertyAssignment(property) &&
                        !ts.isPropertyAssignment(property)) ||
                    context.propertyName(property.name) !== names[index]
                )
                    return fail(property);
            });
            if (node.properties.length !== names.length) return fail(node);
            return pinnedRecordLiteral(
                context,
                lowerer,
                node,
                schema,
                "timing_record",
            );
        }
        // Source statements natively spelled as one fixed line. An empty
        // line is a statement whose only effect is on the WebGPU objects and
        // the encoder instrumentation native task execution replaces.
        const fixed: [shape: string, cpp: string, phases?: Phase[]][] = [
            ["timer.currentEncoder = encoder", "", ["begin"]],
            [
                "timer.patchedEncoderMethods = patchTimingEncoder(timer, encoder)",
                "",
                ["begin"],
            ],
            ["timer.currentEncoder = null", "", ["restore"]],
            ["timer.patchedEncoderMethods = null", "", ["restore"]],
            // `timing` is the object `activeTaskTiming` names; natively they
            // are one storage.
            ["timer.activeTaskTiming = timing", "", ["task-begin"]],
            ["timer.activeTaskTiming = null", "active_task_timing.reset();"],
            ["timer.records.length = 0", "records.clear();"],
            ["buffer.unmap()", "", ["complete"]],
            [
                "timer.pendingReadbacks.delete(buffer)",
                "",
                ["complete", "error"],
            ],
            ["timer.readbackPool.push(buffer)", "", ["complete"]],
            ["buffer.destroy()", "", ["error"]],
            ["timer.querySet.destroy()", "query_set.reset();", ["dispose"]],
            [
                "timer.pendingReadbacks.clear()",
                "pending_readbacks.clear();",
                ["dispose"],
            ],
            ["timer.resolveBuffer.destroy()", "", ["dispose"]],
            ["timer.readbackPool.length = 0", "", ["dispose"]],
        ];
        let laterPass = false;
        return lowerPinnedBody(file, statements, {
            bindings,
            calls: new Map(),
            foldConditions: false,

            expression,
            forOf: (source, element) =>
                sameSource(source, "pending.records")
                    ? {
                          range: "pending.records",
                          bindings: new Map([
                              [
                                  element,
                                  { cpp: element, type: "opaque" as const },
                              ],
                          ]),
                      }
                    : undefined,
            returnValue: (value, lowerer) => {
                if (phase !== "pass")
                    return value ? lowerer.expression(value) : "";
                // A descriptor returned unchanged carries no timestamps; the
                // two spreads are the first pass's pair and a later pass's end.
                if (!value) return fail(statements[0]!);
                if (context.expressionMatchesShape(value, "descriptor"))
                    return "std::nullopt";
                const spread = unwrapExpression(value);
                if (
                    context.expressionMatchesShape(
                        spread,
                        "{ ...descriptor, timestampWrites: { querySet: timer.querySet, beginningOfPassWriteIndex: timing.beginQueryIndex, endOfPassWriteIndex: timing.endQueryIndex } }",
                    )
                )
                    return `pass_writes(${active}.begin_query_index, ${active}.end_query_index)`;
                if (
                    laterPass &&
                    context.expressionMatchesShape(
                        spread,
                        "{ ...descriptor, timestampWrites }",
                    )
                )
                    return `end_write(${active}.end_query_index)`;
                return fail(value);
            },
            statement: (node, lowerer, indent) => {
                // The native conductor executes the task itself; skipping
                // leaves nothing for the timer to bracket. end_task tests the
                // rule again, which holds because only begin_frame writes it.
                if (node === skip)
                    return [
                        `${indent}if (skip_frame) {`,
                        `${indent}    return;`,
                        `${indent}}`,
                    ];
                if (ts.isExpressionStatement(node)) {
                    for (const [shape, cpp, phases] of fixed)
                        if (
                            (!phases || phases.includes(phase)) &&
                            context.expressionMatchesShape(
                                node.expression,
                                shape,
                            )
                        )
                            return cpp ? [`${indent}${cpp}`] : [];
                    const assigned = node.expression;
                    if (
                        ts.isBinaryExpression(assigned) &&
                        assigned.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isIdentifier(assigned.left) &&
                        envelope.has(assigned.left.text)
                    )
                        return [
                            `${indent}${assigned.left.text} = ${lowerer.expression(assigned.right)};`,
                        ];
                }
                if (ts.isForOfStatement(node) && phase === "dispose") {
                    if (
                        !sameSource(node.expression, "timer.readbackPool") &&
                        !sameSource(node.expression, "timer.pendingReadbacks")
                    )
                        return fail(node);
                    const block = ts.isBlock(node.statement)
                        ? node.statement.statements
                        : [node.statement];
                    if (
                        block.length !== 1 ||
                        !ts.isExpressionStatement(block[0]!) ||
                        !context.expressionMatchesShape(
                            block[0].expression,
                            "buffer.destroy()",
                        )
                    )
                        return fail(node);
                    return [];
                }
                if (ts.isVariableStatement(node))
                    return node.declarationList.declarations.flatMap(
                        (local) => {
                            if (
                                !ts.isIdentifier(local.name) ||
                                !local.initializer
                            )
                                return fail(local);
                            const name = local.name.text;
                            const initializer = local.initializer;
                            if (phase === "pass" && name === "timing") {
                                context.assertExpressionShape(
                                    initializer,
                                    "timer.activeTaskTiming",
                                    "Active GPU task timing",
                                );
                                return [];
                            }
                            if (
                                phase === "pass" &&
                                name === "timestampWrites"
                            ) {
                                context.assertExpressionShape(
                                    initializer,
                                    "{ querySet: timer.querySet, endOfPassWriteIndex: timing.endQueryIndex }",
                                    "Later GPU task pass timestamp",
                                );
                                laterPass = true;
                                return [];
                            }
                            if (phase === "task-begin" && name === "taskIndex")
                                return [
                                    `${indent}task_index = ${lowerer.expression(initializer)};`,
                                ];
                            if (phase === "task-begin" && name === "timing")
                                return [
                                    `${indent}active_task_timing = ${pinnedRecordLiteral(context, lowerer, initializer, activeSchema, "task_timing")};`,
                                ];
                            if (envelope.has(name)) {
                                context.assertExpressionShape(
                                    initializer,
                                    "null",
                                    "GPU timing envelope initial value",
                                );
                                lowerer.bindPorts(
                                    [
                                        [
                                            name,
                                            {
                                                cpp: `(*${name})`,
                                                type: "scalar",
                                                absentCpp: `!${name}.has_value()`,
                                                absentValue: "null",
                                            },
                                        ],
                                    ],
                                    node,
                                );
                                return [
                                    `${indent}std::optional<std::uint64_t> ${name};`,
                                ];
                            }
                            if (phase === "finish" && name === "records") {
                                context.assertExpressionShape(
                                    initializer,
                                    "timer.records.slice()",
                                    "Frame GPU timing records",
                                );
                                // The source clears its records before any
                                // statement reads them again (asserted
                                // below), so the frame's copy takes them and
                                // leaves records empty; the reserve restores
                                // the capacity.
                                return [
                                    `${indent}auto frame_records = std::exchange(records, {});`,
                                    `${indent}records.reserve(frame_records.size());`,
                                ];
                            }
                            const cpp = lowerer.expression(initializer);
                            lowerer.bindPorts(
                                [[name, { cpp: name, type: "opaque" }]],
                                node,
                            );
                            const declaration = `${indent}${name === "tasks" ? "auto" : "const auto"} ${name} = ${cpp};`;
                            if (phase === "complete" && name === "tasks") {
                                context.assertExpressionShape(
                                    initializer,
                                    "[]",
                                    "GPU timing task storage",
                                );
                                return [
                                    `${declaration}\n${indent}tasks.reserve(pending.records.size());`,
                                ];
                            }
                            return [declaration];
                        },
                    );
                return undefined;
            },
        });
    }
    function emit(
        source: string,
        signature: string,
        statements: readonly ts.Statement[],
        phase: Phase,
        suffix = "",
    ) {
        outputs.push(
            `// ${context.provenance(modulePath, source)}\n${signature} {\n${body(statements, phase)}${suffix}\n}`,
        );
    }
    // Encoder methods are restored only where the pin patched them; the
    // native frame conductor patches nothing.
    const restore = definition("restoreTimingEncoder");
    const restored = restore.body!.statements;
    context.assertStatementShapes(
        restore,
        restored.slice(0, 2),
        'const patched = timer.patchedEncoderMethods; if (patched) { restoreEncoderMethod(patched.encoder, "beginRenderPass", patched.beginRenderPass); restoreEncoderMethod(patched.encoder, "beginComputePass", patched.beginComputePass); }',
        "Native task timing encoder ownership",
    );
    emit(
        "restoreTimingEncoder",
        "void GpuTaskTimer::restore_timing_encoder()",
        restored.slice(2),
        "restore",
    );
    emit(
        "beginTaskTimingFrame",
        "void GpuTaskTimer::begin_frame()",
        definition("beginTaskTimingFrame").body!.statements,
        "begin",
    );
    // Encoder identity and the task's own execution belong to the native frame
    // conductor, which brackets a task with begin_task and end_task. The index,
    // skip rule, pass bookkeeping and record construction remain the source's.
    const execute = definition("gpuTaskTimerExecute");
    const task = execute.body!.statements;
    context.assertStatementShapes(
        execute,
        task.slice(0, 3),
        "const engine = task.engine; const encoder = engine._currentEncoder; if (timer.currentEncoder !== encoder) { beginTaskTimingFrame(timer, encoder); }",
        "Native task execution boundary",
    );
    skip = task.find(
        (statement): statement is ts.IfStatement =>
            ts.isIfStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "timer.skipFrame",
            ),
    );
    const attempt = task.find(ts.isTryStatement);
    if (!skip || !attempt?.finallyBlock) return fail(execute);
    context.assertStatementShapes(
        execute,
        [skip],
        "if (timer.skipFrame) { return executeTask(task); }",
        "Skipped GPU timing frame",
    );
    const [drawCalls, ...executed] = attempt.tryBlock.statements;
    const drawReturn = executed.pop();
    if (!drawCalls || !drawReturn) return fail(attempt);
    context.assertStatementShapes(
        execute,
        [drawCalls, drawReturn],
        "const drawCalls = executeTask(task); return drawCalls;",
        "Native task execution",
    );
    emit(
        "gpuTaskTimerExecute",
        "void GpuTaskTimer::begin_task()",
        task.slice(3, task.indexOf(attempt)),
        "task-begin",
    );
    emit(
        "gpuTaskTimerExecute",
        "void GpuTaskTimer::end_task(const std::string& name)",
        [skip, ...executed, ...attempt.finallyBlock.statements],
        "task-end",
    );
    emit(
        "withTaskTimestamps",
        "std::optional<GpuTaskPassTimestamps> GpuTaskTimer::pass_timestamps(bool has_timestamp_writes)",
        definition("withTaskTimestamps").body!.statements,
        "pass",
    );
    const finish = definition("finishTaskTimingFrame").body!.statements;
    const transportStart = finish.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (entry) =>
                    ts.isIdentifier(entry.name) &&
                    entry.name.text === "byteLength",
            ),
    );
    if (transportStart < 0) return fail(definition("finishTaskTimingFrame"));
    const copied = finish.findIndex((statement) =>
        context.hasNode(
            statement,
            (node) =>
                ts.isCallExpression(node) &&
                context.expressionMatchesShape(node, "timer.records.slice()"),
        ),
    );
    const cleared = finish.findIndex(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "timer.records.length = 0",
            ),
    );
    if (
        copied < 0 ||
        cleared < copied ||
        finish
            .slice(copied + 1, cleared)
            .some((statement) =>
                context.hasNode(
                    statement,
                    (node) =>
                        ts.isPropertyAccessExpression(node) &&
                        context.expressionMatchesShape(node, "timer.records"),
                ),
            )
    )
        return fail(definition("finishTaskTimingFrame"));
    const increment = finish.find(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "timer.inFlight++",
            ),
    );
    if (!increment) return fail(definition("finishTaskTimingFrame"));
    emit(
        "finishTaskTimingFrame",
        "void GpuTaskTimer::finish_frame()",
        finish.slice(0, transportStart),
        "finish",
        `\n    enqueue_readback(queryCount, frame_index, std::move(frame_records), droppedTaskCount);\n${body([increment], "finish")}`,
    );
    const readback = definition("finishTaskTimingReadback");
    const readbackAttempt = readback.body!.statements.find(ts.isTryStatement);
    if (!readbackAttempt?.catchClause) return fail(readback);
    const complete = readbackAttempt.tryBlock.statements.filter((statement) => {
        if (
            ts.isExpressionStatement(statement) &&
            ts.isAwaitExpression(statement.expression)
        )
            return false;
        if (
            ts.isVariableStatement(statement) &&
            sameSource(statement.declarationList.declarations[0]?.name, "raw")
        )
            return false;
        return true;
    });
    // The final publish transfers this local vector; no source statement can
    // observe it after the snapshot factory takes ownership.
    const publish = complete.at(-1);
    if (!publish || !ts.isExpressionStatement(publish)) return fail(readback);
    context.assertExpressionShape(
        publish.expression,
        'publishTaskTimingSnapshot(timer, pending.publish, makeTimingSnapshot("available", true, true, pending.frameIndex, tasks, pending.droppedTaskCount, totalDurationMs))',
        "Final GPU task timing publication",
    );
    if (!ts.isCallExpression(publish.expression)) return fail(publish);
    const snapshot = publish.expression.arguments[2];
    if (!snapshot || !ts.isCallExpression(snapshot)) return fail(publish);
    completedSnapshot = snapshot;
    emit(
        "finishTaskTimingReadback",
        "void GpuTaskTimer::complete_readback(const GpuTaskTimingReadback& pending, const std::vector<std::uint64_t>& raw)",
        complete,
        "complete",
    );
    emit(
        "finishTaskTimingReadback",
        "void GpuTaskTimer::fail_readback(const GpuTaskTimingReadback& pending, const std::string& error)",
        readbackAttempt.catchClause.block.statements,
        "error",
    );
    emit(
        "publishTaskTimingSnapshot",
        "void GpuTaskTimer::publish_snapshot(std::shared_ptr<GpuTaskTimingSnapshot> snapshot)",
        definition("publishTaskTimingSnapshot").body!.statements,
        "publish",
    );
    emit(
        "disposeGpuTaskTimer",
        "void GpuTaskTimer::dispose()",
        definition("disposeGpuTaskTimer").body!.statements,
        "dispose",
    );
    // Transport readiness replaces mapAsync resumption. Completion/error policy
    // is still the pin's lowered continuation and runs on the owning realm.
    outputs.push(`void GpuTaskTimer::poll() {
    for (std::size_t index = 0; !disposed && index < pending_readbacks.size();) {
        std::optional<std::vector<std::uint64_t>> raw;
        std::optional<std::string> error;
        try { raw = pending_readbacks[index].readback->poll(); }
        catch (const std::exception& failure) { error = failure.what(); }
        if (!raw && !error) { ++index; continue; }
        auto pending = std::move(pending_readbacks[index]);
        pending_readbacks.erase(pending_readbacks.begin() + static_cast<std::ptrdiff_t>(index));
        if (raw) {
            try { complete_readback(pending, *raw); }
            catch (const std::exception& failure) { fail_readback(pending, failure.what()); }
        } else fail_readback(pending, *error);
    }
}`);
    return `namespace bbl::pal {\n${outputs.join("\n\n")}\n}\n`;
}
