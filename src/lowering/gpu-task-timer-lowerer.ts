import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import type { LoweringContext } from "./context.js";
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

/** Pinned scheduling/readback policy over native query and nonblocking-map transport. */
export function lowerGpuTaskTimer(context: LoweringContext): string {
    const file = context.sourceFile(modulePath);
    const definition = (name: string) =>
        context.functionDeclaration(modulePath, name).declaration;
    const fail = (node: ts.Node): never =>
        context.contractError(node, "Unrepresented GPU task timer operation.");
    const members: Record<string, string> = {
        records: "records",
        taskCapacity: "task_capacity",
        frameIndex: "frame_index",
        droppedTaskCount: "dropped_task_count",
        inFlight: "in_flight",
        skipFrame: "skip_frame",
        disposed: "disposed",
    };
    const outputs: string[] = [];
    let completedSnapshot: ts.CallExpression | undefined;
    type Phase = "begin" | "task" | "finish" | "complete" | "error" | "dispose";
    function body(statements: readonly ts.Statement[], phase: Phase): string {
        const bindings = new Map<string, PinnedBinding>([
            [
                "MAX_IN_FLIGHT_READBACKS",
                { cpp: "max_in_flight", type: "scalar" },
            ],
        ]);
        for (const [source, native] of Object.entries(members))
            bindings.set(`timer.${source}`, {
                cpp: native,
                type:
                    source === "records"
                        ? "opaque"
                        : source === "skipFrame" || source === "disposed"
                          ? "bool"
                          : "scalar",
            });
        bindings.set("task.name", { cpp: "name", type: "opaque" });
        bindings.set("pending.frameIndex", {
            cpp: "pending.frame_index",
            type: "scalar",
        });
        bindings.set("pending.droppedTaskCount", {
            cpp: "pending.dropped_task_count",
            type: "scalar",
        });
        bindings.set("error", { cpp: "error", type: "opaque" });
        const expression = (
            node: ts.Expression,
            lowerer: PinnedNumericLowerer,
        ): string | undefined => {
            if (ts.isStringLiteralLike(node))
                return `std::string{${stringLiteral(node.text)}}`;
            if (ts.isPropertyAccessExpression(node)) {
                if (node.getText(file) === "timer.records.length")
                    return "static_cast<double>(records.size())";
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
                const name = node.expression.getText(file);
                if (name === "executeTask") return "std::nullopt";
                if (name === "Number" && node.arguments.length === 1)
                    return `static_cast<double>(${lowerer.expression(node.arguments[0]!)})`;
                if (
                    name === "readbackErrorMessage" &&
                    node.arguments.length === 1
                )
                    return lowerer.expression(node.arguments[0]!);
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
                if (name === "pending.publish")
                    return `publish(${node.arguments.map((arg) => lowerer.expression(arg)).join(", ")})`;
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
        const noOperations = new Map<string, Phase[]>([
            ["timer.currentEncoder = encoder", ["begin"]],
            ["buffer.unmap()", ["complete"]],
            ["timer.pendingReadbacks.delete(buffer)", ["complete", "error"]],
            ["timer.readbackPool.push(buffer)", ["complete"]],
            ["buffer.destroy()", ["error"]],
            ["timer.resolveBuffer.destroy()", ["dispose"]],
            ["timer.readbackPool.length = 0", ["dispose"]],
        ]);
        return lowerPinnedBody(file, statements, {
            bindings,
            calls: new Map(),
            foldConditions: false,
            booleanOr: true,
            booleanAnd: true,
            expression,
            forOf: (source, element) =>
                source === "pending.records"
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
            returnValue: (value, lowerer) =>
                value ? lowerer.expression(value) : "",
            statement: (node, lowerer, indent) => {
                if (ts.isExpressionStatement(node)) {
                    for (const [shape, phases] of noOperations)
                        if (
                            phases.includes(phase) &&
                            context.expressionMatchesShape(
                                node.expression,
                                shape,
                            )
                        )
                            return [];
                    if (
                        context.expressionMatchesShape(
                            node.expression,
                            "timer.records.length = 0",
                        )
                    )
                        return [`${indent}records.clear();`];
                    if (
                        phase === "dispose" &&
                        context.expressionMatchesShape(
                            node.expression,
                            "timer.querySet.destroy()",
                        )
                    )
                        return [`${indent}query_set.reset();`];
                    if (
                        phase === "dispose" &&
                        context.expressionMatchesShape(
                            node.expression,
                            "timer.pendingReadbacks.clear()",
                        )
                    )
                        return [`${indent}pending_readbacks.clear();`];
                }
                if (ts.isForOfStatement(node) && phase === "dispose") {
                    if (
                        node.expression.getText(file) !==
                            "timer.readbackPool" &&
                        node.expression.getText(file) !==
                            "timer.pendingReadbacks"
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
                    return node.declarationList.declarations.map((local) => {
                        if (!ts.isIdentifier(local.name) || !local.initializer)
                            return fail(local);
                        const cpp = lowerer.expression(local.initializer);
                        bindings.set(local.name.text, {
                            cpp: local.name.text,
                            type: "opaque",
                        });
                        const declaration = `${indent}${local.name.text === "tasks" ? "auto" : "const auto"} ${local.name.text} = ${cpp};`;
                        if (
                            phase === "complete" &&
                            local.name.text === "tasks"
                        ) {
                            context.assertExpressionShape(
                                local.initializer,
                                "[]",
                                "GPU timing task storage",
                            );
                            return `${declaration}\n${indent}tasks.reserve(pending.records.size());`;
                        }
                        return declaration;
                    });
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
    emit(
        "beginTaskTimingFrame",
        "void GpuTaskTimer::begin_frame()",
        definition("beginTaskTimingFrame").body!.statements,
        "begin",
    );
    const task = definition("gpuTaskTimerExecute").body!.statements;
    // Encoder identity and the actual task execution belong to the native frame
    // conductor. The source's capacity, indices and record construction remain.
    const selectedTask = task.filter((statement) => {
        if (ts.isVariableStatement(statement)) {
            const local = statement.declarationList.declarations[0];
            if (
                local &&
                ts.isIdentifier(local.name) &&
                (local.name.text === "encoder" ||
                    local.name.text === "drawCalls")
            ) {
                context.assertExpressionShape(
                    local.initializer!,
                    local.name.text === "encoder"
                        ? "task.engine._currentEncoder"
                        : "executeTask(task)",
                    "Native task execution boundary",
                );
                return false;
            }
        }
        if (
            ts.isIfStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "timer.currentEncoder !== encoder",
            )
        )
            return false;
        if (
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression) &&
            statement.expression.expression.getText(file).endsWith(".end")
        ) {
            const call = statement.expression.expression;
            if (
                !ts.isPropertyAccessExpression(call) ||
                !ts.isCallExpression(call.expression) ||
                call.expression.expression.getText(file) !==
                    "encoder.beginComputePass"
            )
                return fail(statement);
            const descriptor = call.expression.arguments[0];
            if (!descriptor) return fail(statement);
            if (
                !context.expressionMatchesShape(
                    descriptor,
                    "{ timestampWrites: { querySet: timer.querySet, beginningOfPassWriteIndex: beginQueryIndex } }",
                ) &&
                !context.expressionMatchesShape(
                    descriptor,
                    "{ timestampWrites: { querySet: timer.querySet, endOfPassWriteIndex: endQueryIndex } }",
                )
            )
                return fail(descriptor);
            return false;
        }
        return !(
            ts.isReturnStatement(statement) &&
            statement.expression?.getText(file) === "drawCalls"
        );
    });
    emit(
        "gpuTaskTimerExecute",
        "std::optional<GpuTaskTimingTask> GpuTaskTimer::begin_task(const std::string& name)",
        selectedTask,
        "task",
        "\n    return writes(beginQueryIndex, endQueryIndex);",
    );
    const recordStatement = task.find(
        (statement): statement is ts.ExpressionStatement =>
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression) &&
            statement.expression.expression.getText(file) ===
                "timer.records.push",
    );
    if (!recordStatement || !ts.isCallExpression(recordStatement.expression))
        return fail(definition("gpuTaskTimerExecute"));
    const record = recordStatement.expression.arguments[0];
    if (!record || !ts.isObjectLiteralExpression(record))
        return fail(recordStatement);
    const nameProperty = record.properties.find(
        (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            context.propertyName(property.name) === "name",
    );
    if (!nameProperty) return fail(record);
    const finalName = new PinnedNumericLowerer(file, {
        bindings: new Map([["task.name", { cpp: "name", type: "opaque" }]]),
        calls: new Map(),
    }).expression(nameProperty.initializer);
    outputs.push(
        `// ${context.provenance(modulePath, "gpuTaskTimerExecute")}\nvoid GpuTaskTimer::end_task(const GpuTimestampWrite& end, const std::string& name) {\n    records.at(end.index / 2).name = ${finalName};\n}`,
    );
    const finish = definition("finishTaskTimingFrame").body!.statements;
    const transportStart = finish.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations[0]?.name.getText(file) ===
                "byteLength",
    );
    if (transportStart < 0) return fail(definition("finishTaskTimingFrame"));
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
        `\n    enqueue_readback(queryCount, frame_index, records, dropped_task_count);\n${body([increment], "finish")}`,
    );
    const readback = definition("finishTaskTimingReadback");
    const attempt = readback.body!.statements.find(ts.isTryStatement);
    if (!attempt?.catchClause) return fail(readback);
    const complete = attempt.tryBlock.statements.filter((statement) => {
        if (
            ts.isExpressionStatement(statement) &&
            ts.isAwaitExpression(statement.expression)
        )
            return false;
        if (
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations[0]?.name.getText(file) ===
                "raw"
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
        'pending.publish(makeTimingSnapshot("available", true, true, pending.frameIndex, tasks, pending.droppedTaskCount))',
        "Final GPU task timing publication",
    );
    if (!ts.isCallExpression(publish.expression)) return fail(publish);
    const snapshot = publish.expression.arguments[0];
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
        attempt.catchClause.block.statements,
        "error",
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
