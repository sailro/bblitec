import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { optionalPresentCpp, type Value } from "./types.js";
import type { DataType } from "./data-types.js";
import { EmissionMap } from "./emission-transaction.js";
import { declaredInDefaultLibrary, resolvedSymbol } from "./symbols.js";
import { nullability } from "./type-facts.js";
import { eventTargetCpp } from "./dom-targets.js";
import { isAbsentWindowMember } from "./browser-erasure.js";

type Context = Pick<
    LoweringServices,
    | "options"
    | "checker"
    | "unwrap"
    | "bindings"
    | "libraryGlobal"
    | "dataTypes"
    | "dataLowerer"
    | "compileValue"
    | "allocateTemporaryCppName"
    | "nativeEmission"
    | "emit"
    | "fail"
    | "probeEmission"
    | "defaultEngine"
    | "requireDefaultEngine"
    | "reachFeature"
>;

/** Statically named Window extensions retain ordinary typed values for one realm. */
export class WindowProperties {
    private isNativeMember(node: ts.PropertyAccessExpression): boolean {
        const checker = this.context.checker;
        if (declaredInDefaultLibrary(resolvedSymbol(checker, node)))
            return true;
        const windowSymbol = checker.resolveName(
            "Window",
            undefined,
            ts.SymbolFlags.Type,
            false,
        );
        return (
            windowSymbol !== undefined &&
            declaredInDefaultLibrary(
                checker.getPropertyOfType(
                    checker.getDeclaredTypeOfSymbol(windowSymbol),
                    node.name.text,
                ),
            )
        );
    }
    private readonly fields = new EmissionMap<
        string,
        { type: DataType; functionCpp: string }
    >();
    constructor(private readonly context: Context) {}

    private target(
        expression: ts.Expression,
    ): { node: ts.PropertyAccessExpression; owner: Value } | undefined {
        const context = this.context;
        if (!context.options.workers || context.options.workers.namespace)
            return undefined;
        const node = context.unwrap(expression);
        if (!ts.isPropertyAccessExpression(node)) return undefined;
        if (isAbsentWindowMember(node.name.text)) return undefined;
        if (this.isNativeMember(node)) return undefined;
        const owner = context.probeEmission(() => {
            const value = context.compileValue(node.expression);
            return value.domEventTargetCpp ===
                "bbl::DomEventTarget::window()" ||
                value.dataType?.kind === "event-target"
                ? value
                : undefined;
        });
        return owner ? { node, owner } : undefined;
    }

    read(expression: ts.PropertyAccessExpression): Value | undefined {
        const target = this.target(expression);
        if (!target) return undefined;
        return this.readFromValue(target.owner, target.node);
    }

    readFromValue(
        owner: Value,
        node: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (
            !this.context.options.workers ||
            this.context.options.workers.namespace ||
            isAbsentWindowMember(node.name.text) ||
            this.isNativeMember(node) ||
            !(
                owner.domEventTargetCpp === "bbl::DomEventTarget::window()" ||
                owner.dataType?.kind === "event-target"
            )
        )
            return undefined;
        const field =
            this.fields.get(node.name.text) ?? this.declaredField(node);
        if (!field) return undefined;
        return this.context.dataLowerer.leafValue(
            this.fieldCpp(field, { owner, node }),
            field.type,
        );
    }

    private fieldCpp(
        field: { functionCpp: string },
        target: { node: ts.PropertyAccessExpression; owner: Value },
    ): string {
        return `${field.functionCpp}(${eventTargetCpp(this.context, target.owner, target.node.expression)})`;
    }

    private declaredField(target: ts.PropertyAccessExpression) {
        const sourceType = this.context.checker.getTypeAtLocation(target);
        if (!nullability(sourceType).undefined) return undefined;
        const type = this.context.dataTypes.fromTsType(sourceType, target);
        if (!type) return undefined;
        return this.createField(target.name.text, type);
    }

    private createField(name: string, valueType: DataType) {
        const context = this.context;
        const type = context.dataTypes.markStoredObjectReferences(
            valueType.kind === "optional"
                ? valueType
                : { kind: "optional", inner: valueType, undefinedOnly: true },
        );
        const cppType = context.dataTypes.cppType(type);
        const cppName = context.allocateTemporaryCppName("window_property");
        context.nativeEmission.registerNativeFunction(
            `${cppType}& ${cppName}(bbl::DomEventTargetValue owner);`,
            [
                `${cppType}& ${cppName}(bbl::DomEventTargetValue owner) {`,
                `    struct Storage { ${cppType} value{}; };`,
                "    return bbl::dom_window_property<Storage>(owner).value;",
                "}",
            ],
        );
        const field = { type, functionCpp: `bblscene::${cppName}` };
        this.fields.set(name, field);
        return field;
    }

    call(expression: ts.Expression): Value | undefined {
        const call = this.context.unwrap(expression);
        if (!ts.isCallExpression(call)) return undefined;
        const target = this.target(call.expression);
        if (!target) return undefined;
        const field =
            this.fields.get(target.node.name.text) ??
            this.declaredField(target.node);
        if (!field) return undefined;
        const type =
            field.type.kind === "optional" ? field.type.inner : field.type;
        if (type.kind !== "function")
            return this.context.fail(
                call,
                "Window extension call requires function storage.",
            );
        const owner = this.context.allocateTemporaryCppName("window_target");
        this.context.emit({
            kind: "declaration",
            type: "const auto",
            name: owner,
            initializer: eventTargetCpp(
                this.context,
                target.owner,
                target.node.expression,
            ),
        });
        const valueCpp = `${field.functionCpp}(${owner})`;
        const cpp =
            field.type.kind === "optional"
                ? `(${optionalPresentCpp(valueCpp)} ? *${valueCpp} : ${this.context.dataTypes.cppType(type)}{})`
                : valueCpp;
        return this.context.dataLowerer.compileStoredCall(call, cpp, type);
    }

    assign(expression: ts.BinaryExpression): boolean {
        const target = this.target(expression.left);
        if (!target) return false;
        const context = this.context;
        if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
            return context.fail(
                expression,
                "Window extension properties require plain assignment.",
            );
        let field =
            this.fields.get(target.node.name.text) ??
            this.declaredField(target.node);
        if (!field) {
            const valueType = context.dataTypes.fromTsType(
                context.checker.getTypeAtLocation(expression.right),
                expression.right,
            );
            if (!valueType)
                return context.fail(
                    expression.right,
                    "Window extension requires a represented value type.",
                );
            field = this.createField(target.node.name.text, valueType);
        }
        const stored: DataType =
            field.type.kind === "optional" &&
            field.type.inner.kind === "function"
                ? {
                      ...field.type,
                      inner: { ...field.type.inner, identity: true },
                  }
                : field.type;
        const owner = context.allocateTemporaryCppName("window_target");
        context.emit({
            kind: "declaration",
            type: "const auto",
            name: owner,
            initializer: eventTargetCpp(
                context,
                target.owner,
                target.node.expression,
            ),
        });
        context.emit({
            kind: "expression",
            code: `${field.functionCpp}(${owner}) = ${context.dataLowerer.compileForRetainedSink(expression.right, stored, "a Window extension")};`,
        });
        return true;
    }

    remove(expression: ts.DeleteExpression): boolean {
        const target = this.target(expression.expression);
        if (!target) return false;
        const field =
            this.fields.get(target.node.name.text) ??
            this.declaredField(target.node);
        if (!field)
            return this.context.fail(
                expression,
                "Window extension deletion requires a known property type.",
            );
        this.context.emit({
            kind: "expression",
            code: `${this.fieldCpp(field, target)} = ${this.context.dataTypes.absentValue(field.type)};`,
        });
        return true;
    }
}
