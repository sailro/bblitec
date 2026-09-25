import {
    emissionArray,
    EmissionMap,
    EmissionSet,
    writable,
} from "./emission-transaction.js";
import { SharedNativeFunctions } from "./shared-native-functions.js";
import type { NativeFunctionDefinition } from "./source-units.js";
import ts from "typescript";
import type { CapturedClosure } from "./closure-captures.js";
import type { Value } from "./types.js";
import type { LoweringServices } from "./lowering-services.js";

/** What the native emission registry reads of the compiler. */
export interface NativeEmissionContext extends Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "bindings"
    | "emit"
    | "fail"
    | "sourceFile"
    | "symbols"
> {
    /** Identity of the C++ lexical scope currently receiving emitted lines. */
    readonly activeEmissionScope: number;
}

/**
 * The namespace-level C++ the entry body calls: native functions and templates with the source
 * that owns them, shared closure and coroutine bodies interned by text, closure environment
 * structs, hoisted static record tables and function-local statics.
 */
export class NativeEmissionRegistry {
    constructor(private readonly context: NativeEmissionContext) {}

    public readonly nativeDefinitions =
        emissionArray<NativeFunctionDefinition>();
    private readonly sharedNativeFunctions = new SharedNativeFunctions();
    public readonly staticNativeDeclarations: string[] = emissionArray([]);

    /**
     * One native accessor per materialized compile-time table: a record
     * read under a run-time key lowers to a lookup in a `bbl::js::Map`
     * built from the record's entries, and every function reading the same
     * record used to carry its own function-local copy of that map -- five
     * 23-entry block registries in the voxel demo. The map is keyed by its
     * full initializer text, so two reads that materialize the same table
     * at the same types share one definition, and a read whose entries
     * emitted helper lines at the call site keeps its inline form.
     */
    private readonly staticRecordAccessors = new EmissionMap<string, string>();

    /** Closure environment structs already registered, by name. */
    public readonly environmentStructs = new EmissionSet<string>();

    public recordAccessor(
        owner: Value,
        mapType: string,
        entries: readonly string[],
        canHoist: boolean,
    ): string {
        if (!canHoist) {
            if (
                !owner.runtimeRecordCpp ||
                owner.runtimeRecordScope !== this.context.activeEmissionScope
            ) {
                const table = writable(owner);
                const cppName =
                    this.context.allocateTemporaryCppName("record_table");
                table.runtimeRecordCpp = cppName;
                table.runtimeRecordScope = this.context.activeEmissionScope;
                this.context.emit(
                    `${mapType} ${cppName}{${entries.join(", ")}};`,
                );
                return cppName;
            }
            return owner.runtimeRecordCpp;
        }
        const initializer = `${mapType} values{${entries.join(", ")}};`;
        const existing = this.staticRecordAccessors.get(initializer);
        if (existing) return `bblscene::${existing}()`;
        const name = `bbl_static_table_${this.staticRecordAccessors.size}`;
        this.registerNativeFunction(`${mapType}& ${name}();`, [
            `${mapType}& ${name}() {`,
            `    static thread_local ${initializer}`,
            `    return values;`,
            `}`,
        ]);
        this.staticRecordAccessors.set(initializer, name);
        return `bblscene::${name}()`;
    }

    public registerNativeFunction(
        prototype: string,
        definitionLines: string[],
        source: ts.Node = this.context.sourceFile,
    ): void {
        this.nativeDefinitions.push({
            kind: "function",
            source: source.getSourceFile().fileName,
            prototype,
            lines: definitionLines,
        });
    }

    public registerSharedNativeFunction(
        name: string,
        definitionLines: string[],
        localBindings: readonly string[],
        declaration?: { source: ts.Node; prototype: string },
    ): string {
        const entry = this.sharedNativeFunctions.intern(
            name,
            definitionLines.join("\n"),
            new Set(localBindings),
        );
        if (entry.added) {
            if (declaration)
                this.registerNativeFunction(
                    declaration.prototype,
                    definitionLines,
                    declaration.source,
                );
            else this.registerNativeTemplate(entry.name, definitionLines);
        }
        return entry.name;
    }

    public renderSharedCoroutine(
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters = "",
        args = "",
        environment = closure.initializer,
        parameterNames: readonly string[] = [],
    ): string {
        const shared = this.registerSharedClosureBody(
            this.context.allocateTemporaryCppName("async_body"),
            closure,
            returnType,
            source,
            parameters,
            parameterNames,
            "value",
        );
        return `bblscene::${shared}(${environment}${args ? `, ${args}` : ""})`;
    }

    public renderSharedClosure(
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters: string,
        parameterNames: readonly string[],
        name = this.context.allocateTemporaryCppName("closure_body"),
    ): string {
        const shared = this.registerSharedClosureBody(
            name,
            closure,
            returnType,
            source,
            parameters,
            parameterNames,
            "reference",
        );
        const invocation = closure.environmentType
            ? shared
            : `${shared}<decltype(${closure.initializer})>`;
        return `bbl::js::make_closure(${closure.initializer}, bblscene::${invocation})`;
    }

    private registerSharedClosureBody(
        name: string,
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters: string,
        parameterNames: readonly string[],
        passing: "value" | "reference",
    ): string {
        const signature = `${returnType} ${name}([[maybe_unused]] ${closure.environmentType ?? "Environment"}${passing === "reference" ? "&" : ""} ${closure.environment}${parameters ? `, ${parameters}` : ""})`;
        return this.registerSharedNativeFunction(
            name,
            [
                ...(closure.environmentType
                    ? []
                    : ["template<typename Environment>"]),
                `${signature} {`,
                ...closure.lines,
                "}",
            ],
            [...closure.localBindings, ...parameterNames],
            closure.environmentType
                ? { source, prototype: `${signature};` }
                : undefined,
        );
    }

    public registerNativeTemplate(
        name: string,
        lines: string[],
        prototype?: string,
    ): void {
        this.nativeDefinitions.push({
            kind: "template",
            name,
            lines,
            ...(prototype === undefined ? {} : { prototype }),
        });
    }

    public materializeStaticNativeValue(
        identifier: ts.Identifier,
        value: Value,
    ): Value {
        const existing = this.context.bindings.lookupOptional(identifier);
        if (existing) return existing;
        const symbol = this.context.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.context.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const cppName = this.context.bindings.cppIdentifier(identifier.text);
        // A function-local static: its construction can throw, which a
        // namespace-scope initializer would turn into termination.
        this.staticNativeDeclarations.push(
            `auto& ${cppName}() {\n    static auto value = ${value.cpp};\n    return value;\n}`,
        );
        const stored = { ...value, cpp: `${cppName}()` };
        this.context.bindings.variableScopes[0]!.set(symbol, {
            name: identifier.text,
            value: stored,
        });
        return stored;
    }
}
