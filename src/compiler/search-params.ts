import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";

/** The runtime query bag over `input`: the one spelling every URLSearchParams value shares. */
export function searchParamsValue(lowerer: DataLowerer, input: string): Value {
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
 * so each emitting function parses it once through a function-local static,
 * as the packaged-asset table does; under workers a static JS container would
 * be owned by several threads, so each read parses its own.
 */
export function deploymentSearchParamsValue(
    lowerer: DataLowerer,
    search: string,
): Value {
    const context = lowerer.context;
    const bag = searchParamsValue(lowerer, context.cppString(search));
    if (context.options.workers) return bag;
    const name = context.allocateTemporaryCppName("deployment_query");
    context.emit({
        kind: "declaration",
        type: "static thread_local const auto",
        name,
        initializer: bag.cpp,
    });
    return lowerer.leafValue(name, { kind: "search-params" });
}

export function compileSearchParams(
    lowerer: DataLowerer,
    node: ts.NewExpression,
): Value | undefined {
    const context = lowerer.context;
    if (
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== "URLSearchParams" ||
        !context.isDefaultLibraryIdentifier(node.expression)
    )
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
    if (method !== "get" && method !== "has")
        return context.fail(
            call,
            `Runtime URLSearchParams.${method} is not lowered.`,
        );
    context.expectArgumentCount(call, 1, method === "has" ? 2 : 1);
    const receiver = context.pinValueToTemporary(owner, "query_receiver");
    const arguments_ = call.arguments.map((argument) => {
        const compiled = context.compileValue(argument);
        // A plain name is already stable; only a computed key needs a pin.
        const value = cppIdentifierPattern.test(compiled.cpp)
            ? compiled
            : context.pinValueToTemporary(compiled, "query_argument");
        return lowerer.compileKnownValueForSink(
            value,
            { kind: "string" },
            argument,
        );
    });
    return lowerer.leafValue(
        `(${receiver.cpp}).${method}(${arguments_.join(", ")})`,
        method === "has"
            ? { kind: "boolean" }
            : { kind: "optional", inner: { kind: "string" } },
    );
}
