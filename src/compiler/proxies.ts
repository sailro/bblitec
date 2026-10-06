import ts from "typescript";
import { renderClosure } from "./closure-captures.js";
import {
    dataTypesEqual,
    type DataStructField,
    type DataType,
} from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import {
    tryResolveFunctionDeclaration,
    functionUsesDynamicThis,
    type SupportedFunction,
} from "./user-functions.js";

/** Finite record proxies keep the target's typed slots and their own object identity. */
export class RecordProxies {
    constructor(private readonly context: LoweringServices) {}

    public requireIndependentFunction(
        field: DataStructField,
        source: SupportedFunction | ts.Identifier,
    ): void {
        if (field.accessorReceiver && this.usesDynamicThis(source))
            this.context.fail(
                source,
                "Proxy method forwarding requires a receiver-independent stored function.",
            );
    }

    private usesDynamicThis(
        source: SupportedFunction | ts.Identifier,
    ): boolean {
        const declaration = ts.isIdentifier(source)
            ? tryResolveFunctionDeclaration(this.context.checker, source)
            : source;
        return !!declaration && functionUsesDynamicThis(declaration);
    }

    public construct(node: ts.NewExpression): Value | undefined {
        const context: LoweringServices = this.context;
        if (context.libraryGlobal(node.expression) !== "Proxy")
            return undefined;
        const [targetNode, handlerNode] = node.arguments ?? [];
        if (!targetNode || !handlerNode || node.arguments?.length !== 2)
            context.fail(node, "Proxy requires one target and one handler.");
        if (!ts.isObjectLiteralExpression(context.unwrap(handlerNode)))
            context.fail(
                handlerNode,
                "A typed Proxy requires a fresh literal handler.",
            );
        const raw = context.compileValue(targetNode);
        const type =
            raw.dataType ??
            context.dataTypes.fromStoredTsType(
                context.checker.getTypeAtLocation(targetNode),
                targetNode,
            );
        if (
            type?.kind !== "struct" ||
            context.dataTypes.isClassStruct(type.name)
        )
            context.fail(
                targetNode,
                "A typed Proxy requires a finite plain record target.",
            );
        const fields = context.dataTypes.structFields(
            type.name,
            node,
            "accessors",
        );
        if (!fields.length || fields.some((field) => field.uncheckedProperty))
            context.fail(
                node,
                "A typed Proxy requires a declared finite target layout.",
            );
        context.dataTypes.requireProxyRecord(type, node);
        const target = context.bindings.pinValueToTemporary(
            context.dataLowerer.leafValue(
                context.dataLowerer.compileKnownValueForSink(
                    raw,
                    type,
                    targetNode,
                ),
                type,
            ),
            "proxy_target",
            targetNode,
        );
        const handler = context.compileValue(handlerNode);
        if (handler.kind !== "record")
            context.fail(
                handlerNode,
                "A typed Proxy requires retained authored trap methods.",
            );
        const names = new Set([
            ...Object.keys(handler.recordMethods ?? {}),
            ...Object.keys(handler.recordProperties ?? {}),
            ...Object.keys(handler.recordGetters ?? {}),
            ...Object.keys(handler.recordSetters ?? {}),
        ]);
        for (const name of names) {
            const trap = this.trap(handler, name);
            if (
                !["get", "set", "deleteProperty", "defineProperty"].includes(
                    name,
                ) ||
                !trap
            )
                context.fail(
                    handlerNode,
                    `Proxy trap '${name}' has no finite native contract.`,
                );
            if (this.usesDynamicThis(trap))
                context.fail(
                    trap,
                    "Proxy traps require a receiver-independent authored function.",
                );
        }
        const define = this.trap(handler, "defineProperty");
        if (
            define &&
            (ts.isIdentifier(define) ||
                define.parameters.length > 2 ||
                define.parameters.some(
                    (parameter) => parameter.dotDotDotToken,
                ) ||
                context.userFunctions.argumentsReference(define))
        )
            context.fail(
                define,
                "A typed Proxy defineProperty trap cannot inspect an unrepresented descriptor.",
            );
        if (define && !this.trap(handler, "set"))
            context.fail(
                handlerNode,
                "A typed Proxy defineProperty trap requires an explicit set trap.",
            );
        const parts = fields.map((field) =>
            this.slot(type, field, target, handler, node),
        );
        context.reachJsData();
        return context.dataLowerer.leafValue(
            context.dataLowerer.structAggregate(type, parts),
            type,
        );
    }

    private slot(
        type: DataType<"struct">,
        field: DataStructField,
        target: Value,
        handler: Value,
        node: ts.Node,
    ): string {
        const context: LoweringServices = this.context;
        const receiverCpp = context.dataTypes.cppType(type);
        const valueCpp = context.dataTypes.cppType(field.type);
        const receiverName = context.allocateTemporaryCppName("proxy_receiver");
        const valueName = context.allocateTemporaryCppName("proxy_value");
        const key: Value = {
            kind: "string",
            cpp: context.cppString(field.sourceName),
            staticString: field.sourceName,
        };
        const argument = (name: string, argumentType: DataType): Value => ({
            ...context.dataLowerer.leafValue(name, argumentType),
            nativeCaptures: [
                context.registerNativeBinding(
                    name,
                    false,
                    false,
                    context.dataTypes.cppType(argumentType),
                ),
            ],
        });
        const getter = context.captureManagedClosureLines(() => {
            const receiver = argument(receiverName, type);
            const value =
                this.invokeTrap(
                    handler,
                    "get",
                    [target, key, receiver],
                    node,
                ) ??
                context.dataLowerer.leafValue(
                    `${target.cpp}->${field.name}.get(${receiverName})`,
                    field.type,
                );
            context.useNativeValue(target);
            context.emit(
                `return ${context.dataLowerer.compileKnownValueForSink(value, field.type, node)};`,
            );
        });
        const setter = context.captureManagedClosureLines(() => {
            const receiver = argument(receiverName, type);
            const value = argument(valueName, field.type);
            const accepted = this.invokeTrap(
                handler,
                "set",
                [target, key, value, receiver],
                node,
            );
            if (accepted) {
                const condition = context.dataLowerer.compileKnownValueForSink(
                    accepted,
                    { kind: "boolean" },
                    node,
                );
                context.emit(`return ${condition};`);
            } else {
                context.useNativeValue(target);
                context.emit(
                    `return ${target.cpp}->${field.name}.try_set(${receiverName}, ${valueName});`,
                );
            }
        });
        const presence = context.captureManagedClosureLines(() => {
            context.useNativeValue(target);
            context.emit(
                `return ${context.dataTypes.ownPresence(type.name, field, target.cpp, "->", node)?.ownCpp ?? "true"};`,
            );
        });
        const mutation = (
            name: "deleteProperty" | "defineProperty",
        ): string => {
            const body = context.captureManagedClosureLines(() => {
                if (name === "defineProperty") argument(valueName, field.type);
                const result = this.invokeTrap(
                    handler,
                    name,
                    [target, key],
                    node,
                );
                if (result) {
                    context.emit(
                        `return ${context.dataLowerer.compileKnownValueForSink(result, { kind: "boolean" }, node)};`,
                    );
                } else {
                    context.useNativeValue(target);
                    context.emit(
                        `return ${target.cpp}->${field.name}.${name === "deleteProperty" ? "erase()" : `define_value(${valueName}, ${!!field.optionalProperty})`};`,
                    );
                }
            });
            return name === "deleteProperty"
                ? `bbl::js::Callback<bool()>(${renderClosure(body, "", "bool")})`
                : `bbl::js::Callback<bool(${valueCpp})>(${renderClosure(body, `[[maybe_unused]] ${valueCpp} ${valueName}`, "bool")})`;
        };
        return `${context.dataTypes.structFieldCppType(field)}(bbl::js::Callback<${valueCpp}(${receiverCpp})>(${renderClosure(getter, `[[maybe_unused]] ${receiverCpp} ${receiverName}`, valueCpp)}), bbl::js::Callback<bool(${receiverCpp}, ${valueCpp})>(${renderClosure(setter, `[[maybe_unused]] ${receiverCpp} ${receiverName}, [[maybe_unused]] ${valueCpp} ${valueName}`, "bool")}), bbl::js::Callback<bool()>(${renderClosure(presence, "", "bool")}), ${mutation("deleteProperty")}, ${mutation("defineProperty")})`;
    }

    private trap(handler: Value, name: string) {
        return (
            handler.recordMethods?.[name] ??
            handler.recordProperties?.[name]?.callbackDeclaration
        );
    }

    private invokeTrap(
        handler: Value,
        name: string,
        values: readonly Value[],
        node: ts.Node,
    ): Value | undefined {
        const trap = this.trap(handler, name);
        if (!trap) return undefined;
        const owner =
            handler.recordProperties?.[name]?.callbackRecordOwner ?? handler;
        return this.context.withRecordScopes(
            owner,
            () => this.context.compileCallbackWithValues(trap, values, node),
            trap,
        );
    }

    public reflect(call: ts.CallExpression): Value | undefined {
        const context: LoweringServices = this.context;
        const callee = context.unwrap(call.expression);
        if (!ts.isPropertyAccessExpression(callee)) return undefined;
        const library = context.libraryGlobal(callee.expression);
        if (
            (library === "Reflect" &&
                ["set", "deleteProperty", "defineProperty"].includes(
                    callee.name.text,
                )) ||
            (library === "Object" && callee.name.text === "defineProperty")
        )
            return context.probeEmission(() =>
                this.mutate(call, callee.name.text, library === "Object"),
            );
        if (library !== "Reflect" || callee.name.text !== "get")
            return undefined;
        const [targetNode, keyNode, receiverNode] = call.arguments;
        if (!targetNode || !keyNode || call.arguments.length > 3)
            context.fail(
                call,
                "Reflect.get requires a target, a finite key and an optional receiver.",
            );
        const target = context.bindings.pinValueToTemporary(
            context.compileValue(targetNode),
            "reflect_target",
            targetNode,
        );
        const key = context.compileValue(keyNode);
        context.emitDiscardedValue(key);
        if (
            target.dataType?.kind !== "struct" ||
            key.staticString === undefined
        )
            context.fail(
                call,
                "Reflect.get requires one represented record and a generation-known key.",
            );
        const receiver = receiverNode
            ? context.bindings.pinValueToTemporary(
                  context.compileValue(receiverNode),
                  "reflect_receiver",
                  receiverNode,
              )
            : target;
        if (
            !receiver.dataType ||
            !dataTypesEqual(receiver.dataType, target.dataType)
        )
            context.fail(
                call,
                "Reflect.get receiver must share the target's represented record layout.",
            );
        const field = context.dataTypes.structField(
            target.dataType.name,
            key.staticString,
            call,
            "accessors",
        );
        context.useNativeValue(target);
        context.useNativeValue(receiver);
        const member = context.dataTypes.isReferenceStruct(target.dataType.name)
            ? "->"
            : ".";
        const slot = `${target.cpp}${member}${field.name}`;
        if (field.accessor && !field.accessorReceiver && receiverNode)
            context.fail(
                call,
                "Reflect.get of a stored getter requires receiver-aware record storage.",
            );
        return {
            ...context.dataLowerer.leafValue(
                field.accessorReceiver
                    ? `${slot}.get(${receiver.cpp})`
                    : field.accessor
                      ? `${slot}.get()`
                      : slot,
                field.type,
            ),
            ...(field.accessor ? { impure: true } : {}),
        };
    }

    private mutationTarget(
        owner: Value,
        key: Value,
        node: ts.Node,
    ): { field: DataStructField; slot: string } | undefined {
        const context: LoweringServices = this.context;
        if (owner.dataType?.kind !== "struct") return undefined;
        const fields = context.dataTypes.structFields(
            owner.dataType.name,
            node,
            "accessors",
        );
        if (!fields.some((field) => field.accessorReceiver)) return undefined;
        if (key.staticString === undefined)
            context.fail(
                node,
                "A typed Proxy mutation requires a generation-known property key.",
            );
        const field = fields.find(
            (field) => field.sourceName === key.staticString,
        );
        if (!field)
            context.fail(
                node,
                "A typed Proxy mutation cannot add an unrepresented property.",
            );
        context.useNativeValue(owner);
        return { field, slot: `${owner.cpp}->${field.name}` };
    }

    private mutate(
        call: ts.CallExpression,
        operation: string,
        strict: boolean,
    ): Value | undefined {
        const context: LoweringServices = this.context;
        const [ownerNode, keyNode, valueNode] = call.arguments;
        if (!ownerNode || !keyNode)
            context.fail(
                call,
                "A reflected mutation requires a target and property key.",
            );
        // Resolve the owner before the key, retaining both evaluations even if a trap rejects the write.
        const owner = context.bindings.pinValueToTemporary(
            context.compileValue(ownerNode),
            "proxy_mutation",
            ownerNode,
        );
        const key = context.compileValue(keyNode);
        context.emitDiscardedValue(key);
        const target = this.mutationTarget(owner, key, call);
        if (!target) return undefined;
        const { field, slot } = target;
        let cpp: string;
        if (operation === "deleteProperty") {
            context.expectArgumentCount(call, 2, 2);
            if (!field.optionalProperty)
                context.fail(
                    call,
                    "Deleting a typed record property requires optional storage.",
                );
            cpp = `${slot}.erase()`;
        } else {
            if (!valueNode)
                context.fail(
                    call,
                    "A reflected property write requires a value.",
                );
            if (operation === "defineProperty") {
                context.expectArgumentCount(call, 3, 3);
                const descriptor = context.compileValue(valueNode);
                if (
                    descriptor.kind !== "record" ||
                    Object.keys(descriptor.recordProperties ?? {}).join(",") !==
                        "value" ||
                    Object.keys(descriptor.recordGetters ?? {}).length ||
                    Object.keys(descriptor.recordMethods ?? {}).length
                )
                    context.fail(
                        valueNode,
                        "A typed property descriptor requires only a value field.",
                    );
                cpp = `${slot}.define_value(${context.dataLowerer.compileKnownValueForSink(descriptor.recordProperties!.value!, field.type, valueNode)}, ${!!field.optionalProperty})`;
            } else {
                context.expectArgumentCount(call, 3, 3);
                const value = context.bindings.pinValueToTemporary(
                    context.compileValue(valueNode),
                    "proxy_value",
                    valueNode,
                );
                cpp = `${slot}.try_set(${owner.cpp}, ${context.dataLowerer.compileKnownValueForSink(value, field.type, valueNode)})`;
            }
        }
        if (strict) {
            this.rejectFalse(cpp);
            return owner;
        }
        return { kind: "boolean", cpp, impure: true };
    }

    public remove(expression: ts.DeleteExpression): boolean {
        return (
            this.context.probeEmission(() => {
                const context: LoweringServices = this.context;
                const access = context.unwrap(expression.expression);
                if (
                    !ts.isPropertyAccessExpression(access) &&
                    !ts.isElementAccessExpression(access)
                )
                    return false;
                const owner = context.bindings.pinValueToTemporary(
                    context.compileValue(access.expression),
                    "proxy_mutation",
                    access.expression,
                );
                const key: Value = ts.isPropertyAccessExpression(access)
                    ? {
                          kind: "string",
                          cpp: context.cppString(access.name.text),
                          staticString: access.name.text,
                      }
                    : context.compileValue(access.argumentExpression);
                const target = this.mutationTarget(owner, key, expression);
                if (!target) return false;
                if (!target.field.optionalProperty)
                    context.fail(
                        expression,
                        "Deleting a typed record property requires optional storage.",
                    );
                context.emitDiscardedValue(key);
                this.rejectFalse(`${target.slot}.erase()`);
                return true;
            }, Boolean) ?? false
        );
    }

    private rejectFalse(cpp: string): void {
        this.context.emit(
            `if (!(${cpp})) std::rethrow_exception(bbl::js::make_error("TypeError", "Proxy trap rejected the property mutation"));`,
        );
    }
}
