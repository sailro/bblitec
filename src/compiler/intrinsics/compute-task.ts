import ts from "typescript";
import type { IntrinsicCallContext } from "./context.js";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";

export interface ComputeTaskIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            "fail" | "pinValueToTemporary" | "emit" | "allocateTemporaryCppName"
        > {}

export function compileComputeTaskIntrinsic(
    context: ComputeTaskIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        ![
            "createComputeTask",
            "addComputeDispatch",
            "removeComputeDispatch",
            "prepareComputeTask",
            "submitComputeTasks",
        ].includes(name)
    )
        return undefined;
    if (name !== "createComputeTask") {
        context.reachFeature("compute:task-execution", call);
        const membership =
            name === "addComputeDispatch" || name === "removeComputeDispatch";
        context.expectArgumentCount(
            call,
            membership ? 2 : 1,
            membership ? 2 : 1,
        );
        const site = argumentAt(call, 0),
            value = context.compileValue(site);
        if (name === "submitComputeTasks") {
            let values: string;
            if (value.kind === "tuple" && value.tupleElements) {
                const entries = value.tupleElements.map((item) => {
                    context.expectKind(item, "compute-task", site);
                    return context.pinValueToTemporary(
                        item,
                        "submitted_compute_task",
                        site,
                    ).cpp;
                });
                values = `{${entries.join(", ")}}`;
            } else {
                const type = value.dataType;
                if (
                    type?.kind !== "vector" ||
                    type.element.kind !== "handle" ||
                    type.element.handle !== "compute-task"
                )
                    return context.fail(
                        site,
                        "Compute submission requires a retained array of compute tasks.",
                    );
                const array = context.pinValueToTemporary(
                    value,
                    "submitted_compute_tasks",
                    site,
                );
                values = `bbl::js::array_to_vector(${array.cpp})`;
            }
            return {
                kind: "void",
                cpp: `bbl::submit_compute_tasks(${values})`,
            };
        }
        context.expectKind(value, "compute-task", site);
        if (name === "prepareComputeTask")
            return {
                kind: "promise",
                cpp: `bbl::prepare_compute_task(${value.cpp})`,
                promiseType: "bbl::js::PromiseVoid",
                promiseResult: { kind: "void", cpp: "" },
            };
        const task = context.pinValueToTemporary(
            value,
            "compute_membership_task",
            site,
        );
        const dispatch = context.compileValue(argumentAt(call, 1));
        context.expectKind(dispatch, "compute-dispatch", call);
        return {
            kind: "void",
            cpp: `bbl::${name === "addComputeDispatch" ? "add_compute_dispatch" : "remove_compute_dispatch"}(${task.cpp}, ${dispatch.cpp})`,
        };
    }
    context.expectArgumentCount(call, 1, 2);
    context.reachFeature("compute:task", call);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", call);
    if (!engine.ownedEngineCpp)
        return context.fail(
            call,
            "Compute tasks require a realm-owned engine.",
        );
    let label = "";
    if (call.arguments[1]) {
        const value = context.compileValue(call.arguments[1]);
        if (value.kind !== "json-null") {
            context.expectKind(value, "string", call.arguments[1]);
            label = `, ${value.cpp}`;
        }
    }
    return {
        kind: "compute-task",
        dataType: { kind: "handle", handle: "compute-task" },
        engineCpp: engine.cpp,
        cpp: `bbl::create_compute_task(${engine.ownedEngineCpp}${label})`,
    };
}
