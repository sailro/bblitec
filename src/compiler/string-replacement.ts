import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";
import { argumentAt } from "./syntax.js";

/** The empty first alternative exposes every capture without needing a matching input. */
export function regexpCaptureCount(pattern: string): number {
    return new RegExp(`|(?:${pattern})`).exec("")!.length - 1;
}

/** Both replacement overloads use the ordinary inline/stored callback invocation path. */
export function replacementCallback(
    lowerer: DataLowerer, call: ts.CallExpression, replacement: Value, pattern?: Value,
): string {
    const context = lowerer.context;
    let stored: Value | undefined;
    if (replacement.dataType?.kind === "function") {
        const cpp = context.allocateTemporaryCppName("replacement_callback");
        context.emit(`const auto ${cpp} = ${replacement.cpp};`);
        stored = {...replacement, cpp, nativeCaptures: [context.registerNativeBinding(cpp)]};
    }
    const adapter = context.allocateTemporaryCppName("replacement_invoke");
    const packet = context.allocateTemporaryCppName("replacement_match");
    let supplied: Value[];
    let parameters: string;
    if (pattern) {
        parameters = `[[maybe_unused]] const bbl::js::RegExpReplacement& ${packet}`;
        const captures = pattern.regexpCaptureCount;
        if (captures !== undefined) {
            supplied = [lowerer.leafValue(`*${packet}.groups[0]`, {kind: "string"}),
                ...Array.from({length: captures}, (_unused, index) => lowerer.leafValue(
                    `${packet}.argument<std::string>(${index + 1})`, {kind: "optional", inner: {kind: "string"}})),
                lowerer.leafValue(`${packet}.offset`, {kind: "number"}),
                lowerer.leafValue(`${packet}.input`, {kind: "string"})];
        } else {
            const signature = context.checker.getTypeAtLocation(argumentAt(call, 1)).getCallSignatures()[0];
            if (!signature) return context.fail(call, "RegExp replacement requires a callable signature.");
            supplied = signature.parameters.map((parameter, index) => {
                if (index === 0) return lowerer.leafValue(`*${packet}.groups[0]`, {kind: "string"});
                const declared = context.dataTypes.fromTsType(context.checker.getTypeOfSymbolAtLocation(parameter, call), call);
                const inner = declared?.kind === "optional" ? declared.inner : declared;
                const scalar = (type: DataType): boolean => type.kind === "string" || type.kind === "number" ||
                    (type.kind === "union" && type.members.every(scalar));
                if (!inner || !scalar(inner)) return context.fail(call,
                    "A runtime RegExp pattern requires concrete string/number callback parameter types.");
                return lowerer.leafValue(`${packet}.argument<${context.dataTypes.cppType(inner)}>(${index})`, {kind: "optional", inner});
            });
        }
    } else {
        const types: DataType[] = [{kind: "string"}, {kind: "number"}, {kind: "string"}];
        supplied = types.map(type => lowerer.leafValue(context.allocateTemporaryCppName("replacement_arg"), type));
        parameters = supplied.map(value => `[[maybe_unused]] ${context.dataTypes.cppType(value.dataType!)} ${value.cpp}`).join(", ");
    }
    context.emit(`const auto ${adapter} = [&](${parameters}) -> std::string {`);
    context.increaseIndent();
    context.pushScope(context.allocateBlockPrefix());
    context.enterRuntimeControlFlow();
    context.enterRuntimeIteration();
    try {
        const packetOwner = pattern ? context.registerNativeBinding(packet) : undefined;
        const values = supplied.map(value => ({...value,
            nativeCaptures: [packetOwner ?? context.registerNativeBinding(value.cpp)]}));
        const invoke = () => replacement.callbackDeclaration
            ? context.compileCallbackWithValues(replacement.callbackDeclaration, values, call)
            : context.fail(call, "String replacement requires a callable value.");
        const result = stored ? lowerer.compileFunctionValueCall(stored, values, call)
            : replacement.callbackRecordOwner ? context.withRecordScopes(replacement.callbackRecordOwner, invoke) : invoke();
        context.emit(`return ${lowerer.compileKnownValueForSink(result, {kind: "string"}, call)};`);
    } finally {
        context.leaveRuntimeIteration();
        context.leaveRuntimeControlFlow();
        context.popScope();
        context.decreaseIndent();
    }
    context.emit("};");
    return adapter;
}
