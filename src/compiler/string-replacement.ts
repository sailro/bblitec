import ts from "typescript";
import { constInitializer } from "./browser-erasure.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    regexpCaptureCount,
    regexpCapturesMayBeUnmatched,
    type RegExpLayout,
} from "./regexp-grammar.js";
import { valueForKind, type Value } from "./types.js";
import { argumentAt, regularExpressionParts } from "./syntax.js";

/** Both replacement overloads use the ordinary inline/stored callback invocation path. */
export function replacementCallback(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    replacement: Value,
    pattern?: Value,
): string {
    const context = lowerer.context;
    let stored: Value | undefined;
    if (replacement.dataType?.kind === "function") {
        const cpp = context.allocateTemporaryCppName("replacement_callback");
        context.emit({
            kind: "declaration",
            type: "const auto",
            name: cpp,
            initializer: replacement.cpp,
        });
        stored = {
            ...replacement,
            cpp,
            nativeCaptures: [context.registerNativeBinding(cpp)],
        };
    }
    const adapter = context.allocateTemporaryCppName("replacement_invoke");
    const packet = context.allocateTemporaryCppName("replacement_match");
    let supplied: Value[];
    let parameters: string;
    // A capture read can be lowered into a function template that reaches
    // the packet through its environment, where `argument` is a dependent
    // template name.
    if (pattern) {
        parameters = `[[maybe_unused]] const bbl::js::RegExpReplacement& ${packet}`;
        const captures = pattern.regexpLayout?.captureCount;
        if (captures !== undefined) {
            supplied = [
                lowerer.leafValue(`*${packet}.groups[0]`, { kind: "string" }),
                ...Array.from({ length: captures }, (_unused, index) =>
                    lowerer.leafValue(
                        `${packet}.template argument<std::string>(${index + 1})`,
                        { kind: "optional", inner: { kind: "string" } },
                    ),
                ),
                lowerer.leafValue(`${packet}.offset`, { kind: "number" }),
                lowerer.leafValue(`${packet}.input`, { kind: "string" }),
            ];
        } else {
            const signature = context.checker
                .getTypeAtLocation(argumentAt(call, 1))
                .getCallSignatures()[0];
            if (!signature)
                return context.fail(
                    call,
                    "RegExp replacement requires a callable signature.",
                );
            supplied = signature.parameters.map((parameter, index) => {
                if (index === 0)
                    return lowerer.leafValue(`*${packet}.groups[0]`, {
                        kind: "string",
                    });
                const declared = context.dataTypes.fromTsType(
                    context.checker.getTypeOfSymbolAtLocation(parameter, call),
                    call,
                );
                const inner =
                    declared?.kind === "optional" ? declared.inner : declared;
                const scalar = (type: DataType): boolean =>
                    type.kind === "string" ||
                    type.kind === "number" ||
                    (type.kind === "union" && type.members.every(scalar));
                if (!inner || !scalar(inner))
                    return context.fail(
                        call,
                        "A runtime RegExp pattern requires concrete string/number callback parameter types.",
                    );
                return lowerer.leafValue(
                    `${packet}.template argument<${context.dataTypes.cppType(inner)}>(${index})`,
                    { kind: "optional", inner },
                );
            });
        }
    } else {
        const types: DataType[] = [
            { kind: "string" },
            { kind: "number" },
            { kind: "string" },
        ];
        supplied = types.map((type) =>
            lowerer.leafValue(
                context.allocateTemporaryCppName("replacement_arg"),
                type,
            ),
        );
        parameters = supplied
            .map(
                (value) =>
                    `[[maybe_unused]] ${context.dataTypes.cppType(value.dataType!)} ${value.cpp}`,
            )
            .join(", ");
    }
    context.emit(`const auto ${adapter} = [&](${parameters}) -> std::string {`);
    context.increaseIndent();
    context.bindings.pushScope(context.allocateBlockPrefix());
    context.enterRuntimeControlFlow();
    context.enterRuntimeIteration();
    try {
        const packetOwner = pattern
            ? context.registerNativeBinding(packet)
            : undefined;
        const values = supplied.map((value) => ({
            ...value,
            nativeCaptures: [
                packetOwner ?? context.registerNativeBinding(value.cpp),
            ],
        }));
        const invoke = () =>
            replacement.callbackDeclaration
                ? context.compileCallbackWithValues(
                      replacement.callbackDeclaration,
                      values,
                      call,
                  )
                : context.fail(
                      call,
                      "String replacement requires a callable value.",
                  );
        const result = stored
            ? lowerer.compileFunctionValueCall(stored, values, call)
            : replacement.callbackRecordOwner
              ? context.withRecordScopes(
                    replacement.callbackRecordOwner,
                    invoke,
                )
              : invoke();
        context.emit({
            kind: "control",
            code: `return ${lowerer.compileKnownValueForSink(result, { kind: "string" }, call)};`,
            transfer: "return",
        });
    } finally {
        context.leaveRuntimeIteration();
        context.leaveRuntimeControlFlow();
        context.bindings.popScope();
        context.decreaseIndent();
    }
    context.emit("};");
    return adapter;
}

/**
 * A RegExp's capture lists: strings when no capture can be unmatched,
 * else `string | undefined`, with the runtime's matching template argument.
 */
export function regexpGroupsType(
    layout: RegExpLayout | undefined,
    cppType: (type: DataType) => string,
): { element: DataType; template: string } {
    if (layout?.optionalCaptures === false)
        return { element: { kind: "string" }, template: "" };
    const element: DataType = {
        kind: "optional",
        inner: { kind: "string" },
        undefinedOnly: true,
    };
    return { element, template: `<${cppType(element)}>` };
}

/**
 * The pattern and flags a RegExp expression has at generation: a literal,
 * `new RegExp` of literal text, or a `const` bound to one.
 */
function staticRegExpSource(
    context: Pick<LoweringServices, "symbols" | "unwrap">,
    expression: ts.Expression,
    depth = 0,
): { pattern: string; flags: string } | undefined {
    const node = context.unwrap(expression);
    if (ts.isRegularExpressionLiteral(node))
        return regularExpressionParts(node);
    if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "RegExp" &&
        node.arguments?.[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (!node.arguments[1] || ts.isStringLiteralLike(node.arguments[1]))
    )
        return {
            pattern: node.arguments[0].text,
            flags: node.arguments[1]?.text ?? "",
        };
    if (!ts.isIdentifier(node) || depth > 4) return undefined;
    const initializer = constInitializer(context, node);
    return initializer
        ? staticRegExpSource(context, initializer, depth + 1)
        : undefined;
}

/**
 * A RegExp value's capture facts: its own metadata, else the generation-known
 * source of the expression that produced it.
 */
export function regexpCaptureFacts(
    context: Pick<LoweringServices, "symbols" | "unwrap">,
    value: Value,
    expression: ts.Expression,
): Value {
    if (value.regexpLayout?.optionalCaptures !== undefined) return value;
    const source = staticRegExpSource(context, expression);
    return source
        ? valueForKind(value.kind, {
              ...value,
              regexpLayout: {
                  ...value.regexpLayout,
                  global: source.flags.includes("g"),
                  captureCount: regexpCaptureCount(source.pattern),
                  optionalCaptures: regexpCapturesMayBeUnmatched(
                      source.pattern,
                  ),
              },
          })
        : value;
}
