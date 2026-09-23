import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types.js";
import { EmissionMap } from "./emission-transaction.js";
import { browserGlobalNamed } from "./browser-erasure.js";
import { declaredInDefaultLibrary } from "./symbols.js";

type Context = Pick<
    LoweringServices,
    | "options"
    | "checker"
    | "unwrap"
    | "lookupOptional"
    | "isDefaultLibraryIdentifier"
    | "dataTypes"
    | "dataLowerer"
    | "compileValue"
    | "allocateTemporaryCppName"
    | "registerNativeFunction"
    | "emit"
    | "fail"
>;

/** Statically named Window extensions retain ordinary typed values for one realm. */
export class WindowProperties {
    private readonly fields = new EmissionMap<
        string,
        { type: DataType; cpp: string }
    >();
    constructor(private readonly context: Context) {}

    private target(
        expression: ts.Expression,
    ): ts.PropertyAccessExpression | undefined {
        const context = this.context;
        if (!context.options.workers || context.options.workers.namespace)
            return undefined;
        const node = context.unwrap(expression);
        if (!ts.isPropertyAccessExpression(node)) return undefined;
        const owner = context.unwrap(node.expression);
        const global = browserGlobalNamed(context, owner)?.text;
        const alias = ts.isIdentifier(owner)
            ? context.lookupOptional(owner)
            : undefined;
        if (
            !["window", "globalThis"].includes(global ?? "") &&
            alias?.domEventTargetCpp !== "bbl::DomEventTarget::window()"
        )
            return undefined;
        const symbol = context.checker.getSymbolAtLocation(node.name);
        if (declaredInDefaultLibrary(symbol)) return undefined;
        return node;
    }

    read(expression: ts.PropertyAccessExpression): Value | undefined {
        const target = this.target(expression);
        if (!target) return undefined;
        const field = this.fields.get(target.name.text);
        if (!field) return undefined;
        return this.context.dataLowerer.leafValue(field.cpp, field.type);
    }

    call(expression: ts.Expression): Value | undefined {
        const call = this.context.unwrap(expression);
        if (!ts.isCallExpression(call)) return undefined;
        const target = this.target(call.expression);
        if (!target) return undefined;
        const field = this.fields.get(target.name.text);
        if (!field) return undefined;
        const type =
            field.type.kind === "optional" ? field.type.inner : field.type;
        if (type.kind !== "function")
            return this.context.fail(
                call,
                "Window extension call requires function storage.",
            );
        const cpp =
            field.type.kind === "optional"
                ? `(${field.cpp}.has_value() ? *${field.cpp} : ${this.context.dataTypes.cppType(type)}{})`
                : field.cpp;
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
        let field = this.fields.get(target.name.text);
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
            const type: DataType =
                valueType.kind === "optional"
                    ? valueType
                    : {
                          kind: "optional",
                          inner: valueType,
                          undefinedOnly: true,
                      };
            const cppType = context.dataTypes.cppType(type);
            const name = context.allocateTemporaryCppName("window_property");
            context.registerNativeFunction(`${cppType}& ${name}();`, [
                `${cppType}& ${name}() {`,
                `    struct Storage { ${cppType} value{}; };`,
                "    return bbl::js::realm_scratch<Storage>().value;",
                "}",
            ]);
            field = { type, cpp: `bblscene::${name}()` };
            this.fields.set(target.name.text, field);
        }
        const stored: DataType =
            field.type.kind === "optional" &&
            field.type.inner.kind === "function"
                ? {
                      ...field.type,
                      inner: { ...field.type.inner, identity: true },
                  }
                : field.type;
        context.emit(
            `${field.cpp} = ${context.dataLowerer.compileForSink(expression.right, stored)};`,
        );
        return true;
    }

    remove(expression: ts.DeleteExpression): boolean {
        const target = this.target(expression.expression);
        if (!target) return false;
        const field = this.fields.get(target.name.text);
        if (!field)
            return this.context.fail(
                expression,
                "Window extension deletion requires a known property type.",
            );
        this.context.emit(`${field.cpp} = std::nullopt;`);
        return true;
    }
}
