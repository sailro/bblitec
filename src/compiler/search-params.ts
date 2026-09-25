import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

/** Reached mutable query state invalidates earlier deployment-query folds. */
export class RuntimeSearchParamsRequired extends Error {
    constructor(readonly location = false) {
        super("Query state requires retained runtime storage.");
    }
}

/** The runtime query bag over `input`: the one spelling every URLSearchParams value shares. */
function searchParamsValue(lowerer: DataLowerer, input: string): Value {
    const type = { kind: "search-params" } as const;
    lowerer.context.reachJsData();
    return {
        ...lowerer.leafValue(
            `${lowerer.context.dataTypes.cppType(type)}(${input})`,
            type,
        ),
        impure: true,
    };
}

/**
 * The deployment query as a native bag, for a read the generation-time fold
 * could not answer (a key computed at run time). Its text is generation-known,
 * so every emitting function reads the same immutable bag in its realm.
 */
export function deploymentSearchParamsValue(
    lowerer: DataLowerer,
    search: string,
): Value {
    const context = lowerer.context;
    const bag = searchParamsValue(lowerer, context.cppString(search));
    const type = { kind: "search-params" } as const;
    return lowerer.leafValue(
        context.nativeEmission.deploymentQuery(
            bag.cpp,
            context.dataTypes.cppType(type),
            !!context.options.workers,
        ),
        type,
    );
}

export function compileSearchParams(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    if (context.libraryGlobal(node.expression) !== "URLSearchParams")
        return undefined;
    const args = node.arguments ?? [];
    if (args.length !== 1)
        context.fail(
            node,
            "Runtime URLSearchParams requires a string initializer.",
        );
    return searchParamsValue(
        lowerer,
        lowerer.compileForSink(args[0]!, { kind: "string" }),
    );
}

export function compileSearchParamsMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value {
    const context = lowerer.context;
    if (method === "set" && !context.options.runtimeSearchParams)
        throw new RuntimeSearchParamsRequired();
    if (!["get", "has", "set", "toString"].includes(method))
        return context.fail(
            call,
            `Runtime URLSearchParams.${method} is not lowered.`,
        );
    const minimum = method === "toString" ? 0 : method === "set" ? 2 : 1;
    context.expectArgumentCount(call, minimum, method === "has" ? 2 : minimum);
    const receiver = context.bindings.pinValueToTemporary(
        owner,
        "query_receiver",
    );
    const arguments_ = call.arguments.map((argument) => {
        const compiled = context.compileValue(argument);
        const value = context.bindings.pinValueToTemporary(
            compiled,
            "query_argument",
        );
        return lowerer.compileKnownValueForSink(
            value,
            { kind: "string" },
            argument,
        );
    });
    const cpp = `(${receiver.cpp}).${method === "toString" ? "to_string" : method}(${arguments_.join(", ")})`;
    if (method === "set") return { kind: "void", cpp };
    return lowerer.leafValue(
        cpp,
        method === "has"
            ? { kind: "boolean" }
            : method === "toString"
              ? { kind: "string" }
              : { kind: "optional", inner: { kind: "string" } },
    );
}
