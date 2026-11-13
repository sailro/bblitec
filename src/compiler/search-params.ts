import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";
import { isMemberAccess } from "./syntax.js";

/** Reached mutable query state invalidates earlier deployment-query folds. */
export class RuntimeSearchParamsRequired extends Error {
    constructor(readonly location = false) {
        super("Query state requires retained runtime storage.");
    }
}

/** The URLSearchParams methods that change the query (and its URL's). */
export const searchParamsMutators: ReadonlySet<string> = new Set([
    "set",
    "delete",
]);

/** Lowered URLSearchParams methods: the native method each calls. */
const NATIVE_METHODS: ReadonlyMap<string, string> = new Map([
    ["get", "get"],
    ["has", "has"],
    ["set", "set"],
    ["delete", "remove"],
    ["toString", "to_string"],
]);

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
    if (
        searchParamsMutators.has(method) &&
        !context.options.runtimeSearchParams
    )
        throw new RuntimeSearchParamsRequired();
    if (method === "entries" || method === "keys" || method === "values") {
        context.expectArgumentCount(call, 0, 0);
        const string = { kind: "string" } as const;
        const element = context.dataTypes.mapPartElement(
            method,
            string,
            string,
        );
        context.reachJsData();
        return lowerer.leafValue(
            `bbl::js::search_params_iterator<${context.dataTypes.cppType(element)}, bbl::js::MapPart::${method}>(${owner.cpp})`,
            { kind: "iterator", element, traced: true },
        );
    }
    const native = NATIVE_METHODS.get(method);
    if (!native)
        return context.fail(
            call,
            `Runtime URLSearchParams.${method} is not lowered.`,
        );
    const minimum = method === "toString" ? 0 : method === "set" ? 2 : 1;
    context.expectArgumentCount(
        call,
        minimum,
        method === "has" || method === "delete" ? 2 : minimum,
    );
    const callee = context.unwrap(call.expression);
    const pins = context.evaluationOrder.operandsToPin([
        isMemberAccess(callee) ? callee.expression : callee,
        ...call.arguments,
    ]);
    const receiver = pins[0]
        ? context.bindings.pinValueToTemporary(owner, "query_receiver")
        : owner;
    const arguments_ = call.arguments.map((argument, index) => {
        const compiled = context.compileValue(argument);
        const value = pins[index + 1]
            ? context.bindings.pinValueToTemporary(compiled, "query_argument")
            : compiled;
        return lowerer.compileKnownValueForSink(
            value,
            { kind: "string" },
            argument,
        );
    });
    const cpp = `(${receiver.cpp}).${native}(${arguments_.join(", ")})`;
    if (searchParamsMutators.has(method)) return { kind: "void", cpp };
    return lowerer.leafValue(
        cpp,
        method === "has"
            ? { kind: "boolean" }
            : method === "toString"
              ? { kind: "string" }
              : { kind: "optional", inner: { kind: "string" } },
    );
}
