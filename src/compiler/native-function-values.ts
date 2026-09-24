import ts from "typescript";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { resolvedSymbol } from "./symbols.js";
import type { Value } from "./types.js";

type Context = Pick<
    LoweringServices,
    | "checker"
    | "callbackIdentity"
    | "dataTypes"
    | "dataLowerer"
    | "reachJsData"
    | "fail"
>;

/** Builtin function objects share declaration identity and typed native calls. */
export function nativeFunctionValue(
    context: Context,
    access: ts.PropertyAccessExpression,
    type: DataType<"function">,
    body: string,
): Value {
    const declaration = resolvedSymbol(
        context.checker,
        access,
    )?.valueDeclaration;
    if (!declaration)
        return context.fail(
            access,
            "Builtin function has no resolved library declaration.",
        );
    context.reachJsData();
    const parameters = type.parameters.map(
        (parameter, index) =>
            `${context.dataTypes.cppType(parameter)} argument_${index}`,
    );
    return context.dataLowerer.leafValue(
        `${context.dataTypes.cppType(type)}{${context.callbackIdentity(declaration, undefined)}u, ` +
            `[](${parameters.join(", ")}) -> ${type.result ? context.dataTypes.cppType(type.result) : "void"} { ${body} }}`,
        type,
    );
}

export function arrayFunctionValue(
    context: Context & Pick<LoweringServices, "libraryGlobal" | "reachJson">,
    access: ts.PropertyAccessExpression,
): Value | undefined {
    if (
        access.name.text !== "isArray" ||
        context.libraryGlobal(access.expression) !== "Array"
    )
        return undefined;
    context.reachJson();
    return nativeFunctionValue(
        context,
        access,
        {
            kind: "function",
            parameters: [{ kind: "json" }],
            result: { kind: "boolean" },
            identity: true,
        },
        "return argument_0.is_array();",
    );
}
