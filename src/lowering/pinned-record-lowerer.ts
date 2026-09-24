/**
 * Lowers pinned modules whose state is plain JavaScript records: objects
 * with identity, arrays, maps, sets, typed arrays and optional values.
 *
 * `PinnedNumericLowerer` owns arithmetic, JavaScript's operators and the
 * statements it already translates; this layer adds the record model on
 * top of it, typed by the TypeScript checker over the recovered pinned
 * sources (`pinned-typed-program.ts`). Every expression's native form is
 * chosen from its checked type, never from its spelling:
 *
 *  - an object type the schema names is a native record, held through
 *    `std::shared_ptr` when the pin shares it by identity and by value
 *    otherwise; its struct is emitted from the pinned declaration itself,
 *    so a member the pin adds or renames moves the struct;
 *  - `T[]`, `Map`, `Set` and `WeakMap` are the runtime's JavaScript
 *    containers (`bbl::js::Array`, `Map`, `Set`, `WeakMap`), which share
 *    storage on copy exactly as a JavaScript reference does;
 *  - typed arrays are `bbl::js::TypedArray`, including views over another
 *    array's buffer;
 *  - `T | undefined` is `std::optional<T>` for a value and the same null
 *    handle for a reference; a union of distinct shapes is a
 *    `std::variant`. A read the checker narrowed converts at the read.
 *
 * Platform calls the pin makes (a text shaper, a GPU device, the console)
 * are the caller's adapters, each named by the pinned declaration it
 * replaces. Anything else the translator does not recognise fails
 * generation with the pinned source location.
 */
import ts from "typescript";
import { declaredSymbol, resolvedSymbol } from "../compiler/symbols.js";
import { posix } from "node:path";
import {
    cppIdentifier,
    doubleLiteral,
    pinnedSnakeCase,
    stringLiteral,
} from "../cpp-literals.js";
import type {
    Transported,
    TransportedGraph,
    TransportRecord,
    TransportSchema,
    TransportShape,
} from "../pinned-record-transport.js";
import type { LoweringContext } from "./context.js";
import { cppPrimary, type RenderedCpp } from "./pinned-numeric-expression.js";
import {
    PinnedNumericLowerer,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    jsBitwiseCall,
    PINNED_BITWISE_ASSIGNMENT_OPERATORS,
    pinnedNumericMathCalls,
} from "./pinned-operators.js";
import { isPinnedErrorCall } from "./pinned-error.js";
import { cppCondition } from "../cpp-expressions.js";
import type { PinnedTypedProgram } from "./pinned-typed-program.js";

/** The native form of one pinned type. */
export type RecordShape =
    | {
          readonly kind:
              "number" | "boolean" | "string" | "void" | "object" | "buffer";
      }
    | {
          readonly kind: "native";
          readonly cpp: string;
          /** The native value is itself nullable (a handle), as `T | null` is. */
          readonly nullable?: boolean;
          /** Crosses from generation as the string it holds there. */
          readonly fromString?: boolean;
      }
    | { readonly kind: "record"; readonly name: string }
    | { readonly kind: "array" | "set"; readonly element: RecordShape }
    | { readonly kind: "tuple"; readonly length: number }
    | {
          readonly kind: "map";
          readonly key: RecordShape;
          readonly value: RecordShape;
      }
    | { readonly kind: "weakmap"; readonly value: RecordShape }
    | { readonly kind: "weakset" }
    | { readonly kind: "typed"; readonly element: "f32" | "u32" | "u8" }
    | {
          readonly kind: "function";
          readonly parameters: readonly RecordShape[];
          readonly result: RecordShape;
      }
    | { readonly kind: "optional"; readonly value: RecordShape }
    | { readonly kind: "variant"; readonly members: readonly RecordShape[] };

/** One member the port spells itself. */
export interface MemberSpec {
    readonly shape: RecordShape;
    /** The native field; defaults to the pinned name's own snake case. */
    readonly field?: string;
    /** A read that is not a field of the owner (a library handle's getter). */
    readonly access?: (owner: string) => string;
    /**
     * A function member's call, when it is not a call of the member's
     * value (a platform object's method the runtime spells itself).
     */
    readonly call?: (owner: string, args: readonly string[]) => string;
}

/** One pinned record type and its native struct. */
export interface RecordSpec {
    /**
     * The pinned type names (interface or type alias) this struct stands
     * for. The first is the declaration the struct is emitted from; the
     * others are the pin's narrower views of the same object
     * (`TextData` under `DefaultTextData`).
     */
    readonly pinned: readonly string[];
    readonly cpp: string;
    /** Shared by identity, as a JavaScript object the pin keeps is. */
    readonly reference: boolean;
    /** The handle alias a reference record's signatures spell. */
    readonly handle?: string;
    /** Declared by a native header; its members are exactly `members`. */
    readonly native?: boolean;
    /** Emitted from the return type of this pinned function (`module#name`). */
    readonly returnOf?: string;
    /** Pinned members the port does not represent, each with its reason. */
    readonly omit?: ReadonlyMap<string, string>;
    /** Members the port spells or types itself. */
    readonly members?: ReadonlyMap<string, MemberSpec>;
    /**
     * Records whose members this one has too, which its struct inherits:
     * the pin passes it where one of those is expected (`ensureStyleGpu`
     * takes any record with a style buffer).
     */
    readonly bases?: readonly string[];
    /**
     * Members the pin's object literals implement as getter/setter pairs
     * (an Euler proxy's `x`), which the interface declares as properties:
     * each is a `get_`/`set_` function pair on the struct.
     */
    readonly accessors?: ReadonlySet<string>;
    /**
     * Members an erased base interface declares -- one from a type-only
     * module the source maps do not carry (`Renderable`) -- typed by the
     * port, as `unresolved` types erased names.
     */
    readonly erased?: ReadonlyMap<string, MemberSpec>;
    /**
     * `module#Interface.member`: the struct is the type literal that
     * member declares (an options object's anonymous quaternion).
     */
    readonly typeOf?: string;
}

/** A platform call a lowered body makes, by the pinned declaration it replaces. */
export interface CallAdapter {
    /**
     * The native spelling, or `null` when the statement is the platform's
     * own work already done (the packaged glyph repertoire has every
     * outline). `argument` lowers one pinned argument on demand, so an
     * adapter that drops an argument never translates it.
     */
    readonly cpp: (
        argument: (index: number) => string,
        call: ts.CallExpression,
        local: (name: string) => string,
    ) => string | null;
    /**
     * The native shapes the platform takes its arguments as, by index,
     * where they are not the pinned parameters' own (a scene hook takes
     * its builder as the function the platform calls).
     */
    readonly parameters?: readonly (RecordShape | undefined)[];
}

/** A pinned module variable the platform owns, read as a native value. */
export interface ModuleValue {
    readonly shape: RecordShape;
    readonly cpp: string;
}

export interface RecordSchema {
    readonly records: readonly RecordSpec[];
    /** Pinned type names represented by a native value. */
    readonly values: ReadonlyMap<string, RecordShape>;
    /** Platform calls, keyed `module#name` or by callee text (`console.warn`). */
    readonly adapters: ReadonlyMap<string, CallAdapter>;
    /**
     * Locals a platform adapter makes unnecessary, keyed
     * `module#function#local`, each with its reason. A read of one outside
     * an adapter's dropped argument fails.
     */
    readonly omittedLocals?: ReadonlyMap<string, string>;
    /**
     * Platform constants a pinned read folds to, keyed by the global that
     * declares them and the member (`GPUBufferUsage.VERTEX`), however the
     * pin reaches it (`BU.VERTEX` snapshots the same global).
     */
    readonly constants?: ReadonlyMap<string, number>;
    /**
     * Types the pin declares in modules the source maps do not carry
     * (type-only modules erase to nothing), by the name the pin spells.
     */
    readonly unresolved?: ReadonlyMap<string, RecordShape>;
    /**
     * The functions native callers name (`module#name`), which live in
     * `bbl`; every other lowered function lives in its module's detail
     * namespace. Without it, a pinned export is a native export.
     */
    readonly exported?: ReadonlySet<string>;
    /**
     * Module variables the platform owns, keyed `module#name`: a read is
     * the native value, a write refuses (the installed weight-variant
     * resolver is the native pipeline's own).
     */
    readonly moduleValues?: ReadonlyMap<string, ModuleValue>;
}

interface ResolvedMember {
    readonly name: string;
    readonly field: string;
    readonly shape: RecordShape;
    readonly access: (owner: string) => string;
    readonly call?: (owner: string, args: readonly string[]) => string;
    /** A getter's read, for a member the pin implements with accessors. */
    readonly get?: (owner: string) => string;
    /** A setter's store, for a member the pin implements with accessors. */
    readonly set?: (owner: string, value: string) => string;
    /**
     * How the struct stores the member: a field, a `get_`/`set_` function
     * pair (`accessor`), or nothing (a class's accessor or method, which
     * are lowered functions over the instance).
     */
    readonly storage: "field" | "accessor" | "none";
    /** The record whose struct declares the field (a base's, when inherited). */
    readonly declaredBy: string;
}

interface ResolvedRecord {
    readonly spec: RecordSpec;
    members(): ReadonlyMap<string, ResolvedMember>;
}

/**
 * A pinned body lowered to one native function: a module function, a
 * class's method, accessor or constructor (a class without one constructs
 * from its declaration).
 */
export type PinnedCallable =
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.ConstructorDeclaration
    | ts.ClassDeclaration;

/** A pinned function this model lowers. */
interface LoweredFunction {
    readonly module: string;
    /**
     * The pinned name (`Class.member`, `Class.get member`, `Class.set
     * member`, `Class.constructor` for a class's), with the argument
     * shapes of a specialization.
     */
    readonly name: string;
    readonly declaration: PinnedCallable;
    readonly cpp: string;
    readonly namespace: string;
    /** The class record a member or constructor lowers over. */
    readonly owner?: string;
    /**
     * Parameter shapes a call decided, by index: a parameter whose type a
     * type-only module erased takes the argument's shape, and the function
     * is lowered once per distinct signature (a native overload).
     */
    readonly parameters?: readonly (RecordShape | undefined)[];
}

/** One parameter of a lowered function's native signature. */
interface NativeParameter {
    readonly name: ts.Identifier;
    readonly shape: RecordShape;
    readonly optional: boolean;
    readonly node: ts.ParameterDeclaration;
}

/**
 * A pinned module-scope `let` the lowered bodies read or write, or a
 * module `const` bound to an object the pin constructs once
 * (`const _mvpScratch = new Float32Array(16)`).
 */
interface ModuleVariable {
    readonly declaration: ts.VariableDeclaration;
    readonly cpp: string;
    readonly namespace: string;
    readonly shape: RecordShape;
    /** The constructed initial value; absent state starts empty. */
    readonly initializer?: string;
}

const nullishFlags =
    ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

/** The native namespace of a module's internal functions. */
function detailNamespace(module: string): string {
    // `_matrix-allocator.ts` is internal by its underscore; the native
    // namespace already says so.
    let stem = posix.basename(module, ".ts");
    while (stem.startsWith("_")) stem = stem.slice(1);
    return `bbl::${stem.replaceAll("-", "_")}_detail`;
}

/** Whether a node is a function-like body the record model lowers. */
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
    return (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
    );
}

/** Whether an identifier is the name a declaration binds, not a use. */
function isDeclarationName(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (
        (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isBindingElement(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent)) &&
        parent.name === node
    );
}

/** The function-like a node sits in (a parameter belongs to its own). */
function enclosingFunctionLike(node: ts.Node): ts.Node | undefined {
    if (ts.isParameter(node)) return node.parent;
    for (let current = node.parent; current; current = current.parent)
        if (isFunctionLike(current)) return current;
    return undefined;
}

function isExported(node: ts.Node): boolean {
    return (
        ts.canHaveModifiers(node) &&
        (ts
            .getModifiers(node)
            ?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            ) ??
            false)
    );
}

/** The store path of a program source file. */
function modulePathOf(file: ts.SourceFile): string {
    return file.fileName.replaceAll("\\", "/");
}

/**
 * The record model of one set of pinned modules: shapes, native structs,
 * module state and the call graph lowered from a set of roots.
 */
export class PinnedRecordModel {
    private readonly records = new Map<string, ResolvedRecord>();
    /** Lowered functions by `module#name` (a specialization's name included). */
    private readonly functions = new Map<string, LoweredFunction>();
    private readonly order: LoweredFunction[] = [];
    private readonly variables = new Map<
        ts.VariableDeclaration,
        ModuleVariable
    >();
    public readonly checker: ts.TypeChecker;
    /** Environment structs named so far, so each has its own name. */
    private environments = 0;

    public constructor(
        public readonly context: LoweringContext,
        public readonly typed: PinnedTypedProgram,
        public readonly schema: RecordSchema,
    ) {
        this.checker = typed.checker;
        for (const spec of schema.records) {
            const resolved = this.resolveRecord(spec);
            for (const name of spec.pinned) this.records.set(name, resolved);
            if (spec.returnOf || spec.typeOf)
                this.anonymous.set(
                    this.recordSource(spec).type,
                    spec.pinned[0]!,
                );
        }
    }

    /** A fresh name for one lowered function's environment struct. */
    public environmentName(entry: { cpp: string }): string {
        this.environments += 1;
        return `${entry.cpp}_environment_${this.environments}`;
    }

    /** Anonymous pinned object types a record is emitted from (a return type). */
    private readonly anonymous = new Map<ts.Type, string>();

    /** `module#name` of every function and module variable lowered so far. */
    public emittedKeys(): string[] {
        return [
            ...this.order.map((entry) => `${entry.module}#${entry.name}`),
            ...[...this.variables.values()].map(
                (variable) =>
                    `${modulePathOf(variable.declaration.getSourceFile())}#${variable.declaration.name.getText()}`,
            ),
        ];
    }

    public fail(node: ts.Node, message: string): never {
        return this.context.contractError(node, message);
    }

    // ── Shapes ───────────────────────────────────────────────────────────

    /** Whether a pinned type name is one of this model's records. */
    public isRecordName(name: string): boolean {
        return this.records.has(name);
    }

    /** The key a record's shapes carry: its first pinned name. */
    public recordKey(name: string): string {
        return this.record(name).spec.pinned[0]!;
    }

    public record(name: string): ResolvedRecord {
        const record = this.records.get(name);
        if (!record) throw new Error(`Unknown pinned record '${name}'.`);
        return record;
    }

    /**
     * The native form of a declaration's type: the checked type, or, when a
     * type-only module the source maps do not carry left it unresolved, the
     * shape the schema gives the name the pin spells.
     */
    public declaredShape(type: ts.Type, declaration: ts.Node): RecordShape {
        const unresolved = this.unresolvedShape(type, declaration);
        return unresolved ?? this.shapeOf(type, declaration);
    }

    /**
     * The schema's shape for an annotation a type-only module erased part
     * of (`Mat4Storage`, `Mat4 | null`, `() => Mat4`), read from the
     * annotation the pin spells.
     */
    public unresolvedShape(
        type: ts.Type,
        declaration: ts.Node,
    ): RecordShape | undefined {
        if (!this.erased(type)) return undefined;
        // A method member's type is its whole signature, not the return
        // annotation its declaration carries.
        if (
            (ts.isMethodSignature(declaration) ||
                ts.isMethodDeclaration(declaration)) &&
            type.getCallSignatures().length > 0
        )
            return this.functionShape(declaration);
        const annotation =
            ts.isParameter(declaration) ||
            ts.isVariableDeclaration(declaration) ||
            ts.isPropertySignature(declaration) ||
            ts.isPropertyDeclaration(declaration) ||
            ts.isFunctionDeclaration(declaration) ||
            ts.isMethodSignature(declaration) ||
            ts.isMethodDeclaration(declaration) ||
            ts.isGetAccessorDeclaration(declaration) ||
            ts.isAsExpression(declaration)
                ? declaration.type
                : undefined;
        const shape = annotation ? this.annotationShape(annotation) : undefined;
        // An optional member or parameter of an erased type may be absent.
        const optional =
            (ts.isParameter(declaration) ||
                ts.isPropertySignature(declaration) ||
                ts.isPropertyDeclaration(declaration)) &&
            declaration.questionToken !== undefined;
        return shape && optional ? optionalOf(shape) : shape;
    }

    /** A declared function's value shape: its parameters and result as declared. */
    public functionShape(declaration: ts.SignatureDeclaration): RecordShape {
        return {
            kind: "function",
            parameters: declaration.parameters.map((parameter) =>
                this.declaredShape(
                    this.checker.getTypeAtLocation(parameter.name),
                    parameter,
                ),
            ),
            result: this.returnShape(declaration),
        };
    }

    /** Whether a checked type lost part of itself to an erased module. */
    public erased(type: ts.Type, depth = 0): boolean {
        if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
        if (depth > 3) return false;
        if (type.isUnion())
            return type.types.some((member) => this.erased(member, depth + 1));
        const signatures = type.getCallSignatures();
        if (signatures.length === 1 && type.getProperties().length === 0) {
            const signature = signatures[0]!;
            return (
                this.erased(
                    this.checker.getReturnTypeOfSignature(signature),
                    depth + 1,
                ) ||
                signature.parameters.some((parameter) =>
                    parameter.valueDeclaration
                        ? this.erased(
                              this.checker.getTypeOfSymbolAtLocation(
                                  parameter,
                                  parameter.valueDeclaration,
                              ),
                              depth + 1,
                          )
                        : false,
                )
            );
        }
        if (
            type.flags & ts.TypeFlags.Object &&
            (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
        )
            return this.checker
                .getTypeArguments(type as ts.TypeReference)
                .some((argument) => this.erased(argument, depth + 1));
        return false;
    }

    /**
     * An annotation's shape, erased names mapped by the schema: a union
     * with `null`/`undefined` is optional, a function type maps its
     * parameters and result, and anything the checker resolved is its
     * checked shape.
     */
    private annotationShape(node: ts.TypeNode): RecordShape | undefined {
        if (ts.isParenthesizedTypeNode(node))
            return this.annotationShape(node.type);
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const name = node.typeName.text;
            // `Readonly<Vec3>` is the erased `Vec3` itself.
            if (name === "Readonly" && node.typeArguments?.length === 1)
                return this.annotationShape(node.typeArguments[0]!);
            const mapped = this.schema.unresolved?.get(name);
            if (mapped) return mapped;
        }
        if (ts.isUnionTypeNode(node)) {
            const present = node.types.filter(
                (member) =>
                    !(
                        (ts.isLiteralTypeNode(member) &&
                            member.literal.kind ===
                                ts.SyntaxKind.NullKeyword) ||
                        member.kind === ts.SyntaxKind.UndefinedKeyword
                    ),
            );
            if (present.length !== 1) return undefined;
            const shape = this.annotationShape(present[0]!);
            return shape && present.length !== node.types.length
                ? optionalOf(shape)
                : shape;
        }
        if (ts.isFunctionTypeNode(node)) {
            const parameters = node.parameters.map((parameter) =>
                parameter.type
                    ? this.annotationShape(parameter.type)
                    : undefined,
            );
            const result = this.annotationShape(node.type);
            if (!result || parameters.some((shape) => shape === undefined))
                return undefined;
            return {
                kind: "function",
                parameters: parameters.map((shape) => shape!),
                result,
            };
        }
        if (ts.isArrayTypeNode(node)) {
            const element = this.annotationShape(node.elementType);
            return element ? { kind: "array", element } : undefined;
        }
        const type = this.checker.getTypeFromTypeNode(node);
        return this.erased(type) ? undefined : this.shapeOf(type, node);
    }

    /** The native form of a checked pinned type. */
    public shapeOf(type: ts.Type, site: ts.Node): RecordShape {
        const anonymous = this.anonymous.get(type);
        if (anonymous !== undefined) return { kind: "record", name: anonymous };
        const alias = type.aliasSymbol?.name;
        if (alias !== undefined) {
            const value = this.schema.values.get(alias);
            if (value) return value;
            const record = this.records.get(alias);
            if (record) return { kind: "record", name: record.spec.pinned[0]! };
        }
        if (type.isUnion()) {
            const present = type.types.filter(
                (member) => (member.flags & nullishFlags) === 0,
            );
            if (present.length === 0) return { kind: "void" };
            const shape = this.unionShape(present, site);
            return present.length === type.types.length
                ? shape
                : optionalOf(shape);
        }
        const flags = type.flags;
        if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
            return this.fail(
                site,
                `Pinned type '${this.checker.typeToString(type)}' is unresolved; the record model needs every value typed.`,
            );
        if (flags & ts.TypeFlags.NumberLike) return { kind: "number" };
        if (flags & ts.TypeFlags.BooleanLike) return { kind: "boolean" };
        if (flags & ts.TypeFlags.StringLike) return { kind: "string" };
        if (flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined))
            return { kind: "void" };
        if (flags & ts.TypeFlags.NonPrimitive) return { kind: "object" };
        if (flags & ts.TypeFlags.Object) {
            const symbol = type.getSymbol();
            const name = symbol?.name;
            if (this.checker.isTupleType(type)) {
                const elements = this.checker.getTypeArguments(
                    type as ts.TypeReference,
                );
                if (
                    elements.some(
                        (element) =>
                            this.shapeOf(element, site).kind !== "number",
                    )
                )
                    return this.fail(
                        site,
                        "Pinned tuples are admitted over numbers only.",
                    );
                return { kind: "tuple", length: elements.length };
            }
            const argumentsOf = (): readonly ts.Type[] =>
                this.checker.getTypeArguments(type as ts.TypeReference);
            if (name === "Array" || name === "ReadonlyArray")
                return {
                    kind: "array",
                    element: this.shapeOf(argumentsOf()[0]!, site),
                };
            if (name === "Map" || name === "ReadonlyMap") {
                const [key, value] = argumentsOf();
                return {
                    kind: "map",
                    key: this.shapeOf(key!, site),
                    value: this.shapeOf(value!, site),
                };
            }
            if (name === "Set" || name === "ReadonlySet")
                return {
                    kind: "set",
                    element: this.shapeOf(argumentsOf()[0]!, site),
                };
            if (name === "WeakMap")
                return {
                    kind: "weakmap",
                    value: this.shapeOf(argumentsOf()[1]!, site),
                };
            if (name === "WeakSet") return { kind: "weakset" };
            if (name === "Float32Array")
                return { kind: "typed", element: "f32" };
            if (name === "Uint32Array")
                return { kind: "typed", element: "u32" };
            if (name === "Uint8Array") return { kind: "typed", element: "u8" };
            // `ArrayBufferLike` names both; this runtime has one kind of buffer.
            if (name === "ArrayBuffer" || name === "SharedArrayBuffer")
                return { kind: "buffer" };
            if (name !== undefined) {
                const value = this.schema.values.get(name);
                if (value) return value;
                const record = this.records.get(name);
                if (record)
                    return { kind: "record", name: record.spec.pinned[0]! };
            }
            const signatures = type.getCallSignatures();
            if (signatures.length === 1 && type.getProperties().length === 0) {
                const signature = signatures[0]!;
                return {
                    kind: "function",
                    parameters: signature.parameters.map((parameter) =>
                        this.shapeOf(
                            this.checker.getTypeOfSymbolAtLocation(
                                parameter,
                                site,
                            ),
                            site,
                        ),
                    ),
                    result: this.shapeOf(
                        this.checker.getReturnTypeOfSignature(signature),
                        site,
                    ),
                };
            }
            if (type.getProperties().length === 0 && signatures.length === 0)
                return { kind: "object" };
            // One arm of a discriminated record union (`TextDataUpdate`
            // narrowed by its `update` tag) is that union's struct.
            const owner = this.unionRecordOf(type);
            if (owner !== undefined) return { kind: "record", name: owner };
            // A fresh literal of an anonymous record's members (`rq ?? { x:
            // 0, y: 0, z: 0, w: 1 }` under an options quaternion) is that
            // record, as TypeScript's structural typing already says.
            const structural = this.structuralRecordOf(type, site);
            if (structural !== undefined)
                return { kind: "record", name: structural };
        }
        return this.fail(
            site,
            `Pinned type '${this.checker.typeToString(type)}' has no native record representation.`,
        );
    }

    /**
     * The one anonymous record (a return or member type literal) whose
     * members `type` has exactly, with the same native shapes.
     */
    private structuralRecordOf(
        type: ts.Type,
        site: ts.Node,
    ): string | undefined {
        const properties = this.checker.getPropertiesOfType(type);
        if (properties.length === 0 || type.getCallSignatures().length > 0)
            return undefined;
        const matches: string[] = [];
        for (const [anonymousType, name] of this.anonymous) {
            const expected = this.checker.getPropertiesOfType(anonymousType);
            if (
                expected.length !== properties.length ||
                !expected.every((member) => {
                    const actual = properties.find(
                        (property) => property.name === member.name,
                    );
                    return (
                        actual !== undefined &&
                        this.cppType(
                            this.shapeOf(
                                this.checker.getTypeOfSymbolAtLocation(
                                    actual,
                                    site,
                                ),
                                site,
                            ),
                        ) ===
                            this.cppType(
                                this.shapeOf(
                                    this.checker.getTypeOfSymbolAtLocation(
                                        member,
                                        site,
                                    ),
                                    site,
                                ),
                            )
                    );
                })
            )
                continue;
            matches.push(name);
        }
        return matches.length === 1 ? matches[0] : undefined;
    }

    private unionArms: Map<ts.Type, string> | undefined;

    /** The record whose pinned declaration is a union with `type` as an arm. */
    private unionRecordOf(type: ts.Type): string | undefined {
        if (!this.unionArms) {
            this.unionArms = new Map();
            for (const spec of this.schema.records) {
                if (spec.native || spec.returnOf || spec.typeOf) continue;
                const source = this.recordSource(spec).type;
                if (source.isUnion())
                    for (const arm of source.types)
                        this.unionArms.set(arm, spec.pinned[0]!);
            }
        }
        return this.unionArms.get(type);
    }

    private aliasUnions: Map<string, RecordShape> | undefined;

    /**
     * A union the checker spelled without its alias (`TextGroupKey`
     * widened by `| undefined` loses the name) that has exactly the
     * constituents of an aliased union the schema represents natively.
     */
    private aliasedUnion(types: readonly ts.Type[]): RecordShape | undefined {
        const key = (members: readonly ts.Type[]): string =>
            members
                .map((member) => this.checker.typeToString(member))
                .sort()
                .join("|");
        if (!this.aliasUnions) {
            this.aliasUnions = new Map();
            for (const file of this.typed.program.getSourceFiles()) {
                if (!modulePathOf(file).startsWith("src/")) continue;
                for (const statement of file.statements) {
                    if (!ts.isTypeAliasDeclaration(statement)) continue;
                    const value = this.schema.values.get(statement.name.text);
                    if (!value) continue;
                    const aliased = this.checker.getTypeAtLocation(
                        statement.name,
                    );
                    if (aliased.isUnion())
                        this.aliasUnions.set(key(aliased.types), value);
                }
            }
        }
        return this.aliasUnions.get(key(types));
    }

    private unionShape(types: readonly ts.Type[], site: ts.Node): RecordShape {
        const aliased = this.aliasedUnion(types);
        if (aliased) return aliased;
        if (types.every((type) => type.flags & ts.TypeFlags.BooleanLike))
            return { kind: "boolean" };
        if (types.every((type) => type.flags & ts.TypeFlags.NumberLike))
            return { kind: "number" };
        if (types.every((type) => type.flags & ts.TypeFlags.StringLike))
            return { kind: "string" };
        const shapes: RecordShape[] = [];
        for (const type of types) {
            const shape = this.shapeOf(type, site);
            if (
                !shapes.some(
                    (existing) =>
                        this.cppType(existing) === this.cppType(shape),
                )
            )
                shapes.push(shape);
        }
        return this.variantOf(shapes);
    }

    /** One shape per distinct native type, primitives first, then by name. */
    private variantOf(shapes: readonly RecordShape[]): RecordShape {
        if (shapes.length === 1) return shapes[0]!;
        const rank = (shape: RecordShape): number =>
            ["number", "boolean", "string"].indexOf(shape.kind) + 1 || 4;
        return {
            kind: "variant",
            members: [...shapes].sort(
                (a, b) =>
                    rank(a) - rank(b) ||
                    this.cppType(a).localeCompare(this.cppType(b)),
            ),
        };
    }

    /** The C++ type of a shape. */
    public cppType(shape: RecordShape): string {
        switch (shape.kind) {
            case "number":
                return "double";
            case "boolean":
                return "bool";
            case "string":
                return "std::string";
            case "void":
                return "void";
            case "object":
                // Any shared object, compared by identity: a fresh `{}` or
                // a record the pin passes as `object`.
                return "std::shared_ptr<const void>";
            case "buffer":
                return "bbl::js::ArrayBuffer";
            case "native":
                return shape.cpp;
            case "record": {
                const spec = this.record(shape.name).spec;
                if (!spec.reference) return `bbl::${spec.cpp}`;
                return spec.handle
                    ? `bbl::${spec.handle}`
                    : `std::shared_ptr<bbl::${spec.cpp}>`;
            }
            case "array":
                return `bbl::js::Array<${this.cppType(shape.element)}>`;
            case "set":
                return `bbl::js::Set<${this.cppType(shape.element)}>`;
            case "tuple":
                return `bbl::js::Tuple<${shape.length}>`;
            case "map":
                return `bbl::js::Map<${this.cppType(shape.key)}, ${this.cppType(shape.value)}>`;
            case "weakmap":
                return `bbl::js::WeakMap<${this.cppType(shape.value)}>`;
            case "weakset":
                return "bbl::js::WeakMap<bool>";
            case "typed":
                return `bbl::js::TypedArray<${{ f32: "float", u32: "std::uint32_t", u8: "std::uint8_t" }[shape.element]}>`;
            case "function":
                // A JavaScript function object: copies share its identity
                // and its environment, which cycle collection traces.
                return `bbl::js::Callback<${this.cppType(shape.result)}(${shape.parameters.map((parameter) => this.cppType(parameter)).join(", ")})>`;
            case "optional":
                return nullableByRepresentation(shape.value, this)
                    ? this.cppType(shape.value)
                    : `std::optional<${this.cppType(shape.value)}>`;
            case "variant":
                return `std::variant<${shape.members.map((member) => this.cppType(member)).join(", ")}>`;
        }
    }

    /** The absent value of a shape a pinned `null`/`undefined` stands for. */
    public absent(shape: RecordShape, site: ts.Node): string {
        if (shape.kind === "optional")
            return nullableByRepresentation(shape.value, this)
                ? `${this.cppType(shape.value)}{}`
                : "std::nullopt";
        if (nullableByRepresentation(shape, this))
            return `${this.cppType(shape)}{}`;
        return this.fail(site, "Pinned absent value has a non-optional type.");
    }

    // ── Records ──────────────────────────────────────────────────────────

    private resolveRecord(spec: RecordSpec): ResolvedRecord {
        let members: Map<string, ResolvedMember> | undefined;
        return {
            spec,
            members: () => (members ??= this.recordMembers(spec)),
        };
    }

    /** The pinned declaration a record is emitted from, and its type. */
    private recordSource(spec: RecordSpec): {
        type: ts.Type;
        site: ts.Node;
    } {
        if (spec.returnOf) {
            const [module, name] = spec.returnOf.split("#");
            const declaration = this.functionDeclaration(module!, name!);
            const signature =
                this.checker.getSignatureFromDeclaration(declaration);
            if (!signature)
                return this.fail(
                    declaration,
                    "Pinned record source has no signature.",
                );
            return {
                type: this.checker.getReturnTypeOfSignature(signature),
                site: declaration,
            };
        }
        if (spec.typeOf) {
            const [module, path] = spec.typeOf.split("#");
            const [owner, member] = path!.split(".");
            const declaration = this.typed
                .sourceFile(module!)
                .statements.find(
                    (statement): statement is ts.InterfaceDeclaration =>
                        ts.isInterfaceDeclaration(statement) &&
                        statement.name.text === owner,
                )
                ?.members.find(
                    (candidate): candidate is ts.PropertySignature =>
                        ts.isPropertySignature(candidate) &&
                        candidate.name.getText() === member,
                );
            if (!declaration?.type)
                throw new Error(
                    `Pinned member type ${spec.typeOf} is not declared.`,
                );
            return {
                type: this.checker.getTypeFromTypeNode(declaration.type),
                site: declaration,
            };
        }
        const name = spec.pinned[0]!;
        for (const file of this.typed.program.getSourceFiles()) {
            if (!modulePathOf(file).startsWith("src/")) continue;
            for (const statement of file.statements) {
                if (
                    (ts.isInterfaceDeclaration(statement) ||
                        ts.isTypeAliasDeclaration(statement) ||
                        ts.isClassDeclaration(statement)) &&
                    statement.name?.text === name
                ) {
                    const symbol = declaredSymbol(
                        this.checker,
                        statement.name,
                    )!;
                    return {
                        type: this.checker.getDeclaredTypeOfSymbol(symbol),
                        site: statement,
                    };
                }
            }
        }
        throw new Error(`Pinned record type '${name}' is not declared.`);
    }

    private recordMembers(spec: RecordSpec): Map<string, ResolvedMember> {
        const members = new Map<string, ResolvedMember>();
        const pointer = (owner: string) =>
            spec.reference ? `${owner}->` : `${owner}.`;
        const add = (
            name: string,
            shape: RecordShape,
            override?: MemberSpec,
            field = override?.field ?? cppIdentifier(pinnedSnakeCase(name)),
        ) => {
            // A member the pin's literals implement with accessors is a
            // getter/setter pair; the struct stores the two functions.
            const accessor = spec.accessors?.has(name) === true;
            members.set(name, {
                name,
                field,
                shape,
                access:
                    override?.access ??
                    ((owner) =>
                        accessor
                            ? this.fail(
                                  this.recordSource(spec).site,
                                  `Pinned accessor member '${name}' has no stored value.`,
                              )
                            : `${pointer(owner)}${field}`),
                ...(override?.call ? { call: override.call } : {}),
                ...(accessor
                    ? {
                          get: (owner: string) =>
                              `${pointer(owner)}get_${field}()`,
                          set: (owner: string, value: string) =>
                              `${pointer(owner)}set_${field}(${value})`,
                      }
                    : {}),
                storage: accessor ? "accessor" : "field",
                declaredBy: spec.pinned[0]!,
            });
        };
        if (spec.native) {
            for (const [name, member] of spec.members ?? [])
                add(name, member.shape, member);
            return members;
        }
        const { type, site } = this.recordSource(spec);
        if (ts.isClassDeclaration(site))
            return this.classMembers(spec, site, type);
        const variants = type.isUnion() ? type.types : [type];
        const collected = new Map<
            string,
            { shapes: RecordShape[]; everywhere: boolean }
        >();
        for (const [index, variant] of variants.entries()) {
            const names = new Set<string>();
            for (const property of this.checker.getPropertiesOfType(variant)) {
                const name = property.getName();
                if (name.startsWith("__@")) {
                    const brand = this.checker.getTypeOfSymbolAtLocation(
                        property,
                        site,
                    );
                    if (!(brand.flags & ts.TypeFlags.BooleanLiteral))
                        this.fail(site, `Pinned member '${name}' is computed.`);
                    continue;
                }
                if (spec.omit?.has(name)) continue;
                names.add(name);
                const override = spec.members?.get(name);
                const shape =
                    override?.shape ??
                    this.declaredShape(
                        this.checker.getTypeOfSymbolAtLocation(property, site),
                        property.valueDeclaration ?? site,
                    );
                const entry = collected.get(name);
                if (!entry)
                    collected.set(name, {
                        shapes: [shape],
                        everywhere: index === 0,
                    });
                else if (
                    !entry.shapes.some(
                        (existing) =>
                            this.cppType(existing) === this.cppType(shape),
                    )
                )
                    entry.shapes.push(shape);
            }
            for (const [name, entry] of collected)
                if (!names.has(name)) entry.everywhere = false;
        }
        for (const [name, entry] of collected) {
            const merged =
                entry.shapes.length === 1
                    ? entry.shapes[0]!
                    : this.mergeShapes(entry.shapes);
            add(
                name,
                entry.everywhere || variants.length === 1
                    ? merged
                    : optionalOf(merged),
                spec.members?.get(name),
            );
        }
        for (const name of spec.members?.keys() ?? [])
            if (!members.has(name))
                this.fail(
                    site,
                    `Pinned record member '${name}' is not declared.`,
                );
        for (const [name, member] of spec.erased ?? []) {
            if (members.has(name))
                this.fail(
                    site,
                    `Pinned record member '${name}' is declared; it is not erased.`,
                );
            add(name, member.shape, member);
        }
        for (const base of spec.bases ?? []) {
            for (const inherited of this.record(base).members().values()) {
                const own = members.get(inherited.name);
                if (
                    !own ||
                    this.cppType(own.shape) !== this.cppType(inherited.shape)
                )
                    this.fail(
                        site,
                        `Pinned record ${spec.pinned[0]!} does not have ${base}'s member '${inherited.name}'.`,
                    );
                members.set(inherited.name, inherited);
            }
        }
        this.separateFields(members, (member, field) =>
            add(
                member.name,
                member.shape,
                spec.members?.get(member.name),
                field,
            ),
        );
        return members;
    }

    /**
     * Two pinned members may spell one native field (`runs` and `_runs`,
     * a class's `_x` behind its accessor `x`): the underscored one keeps a
     * trailing underscore. Only stored members occupy a field name.
     */
    private separateFields(
        members: Map<string, ResolvedMember>,
        rename: (member: ResolvedMember, field: string) => void,
    ): void {
        const fields = new Map<string, string>();
        for (const member of [...members.values()]) {
            if (member.storage !== "field") continue;
            const other = fields.get(member.field);
            if (other !== undefined) {
                const renamed = member.name.startsWith("_")
                    ? member
                    : members.get(other)!;
                rename(renamed, `${renamed.field}_`);
            }
            fields.set(member.field, member.name);
        }
    }

    /**
     * A class's members: its property declarations are the struct's
     * fields; its accessors and methods are functions lowered over the
     * instance, called by name.
     */
    private classMembers(
        spec: RecordSpec,
        declaration: ts.ClassDeclaration,
        type: ts.Type,
    ): Map<string, ResolvedMember> {
        if (!spec.reference)
            this.fail(declaration, "A pinned class is shared by identity.");
        if (
            declaration.heritageClauses?.some(
                (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
            )
        )
            this.fail(declaration, "Pinned class inheritance is not lowered.");
        const members = new Map<string, ResolvedMember>();
        const record = spec.pinned[0]!;
        for (const property of this.checker.getPropertiesOfType(type)) {
            const name = property.getName();
            if (spec.omit?.has(name)) continue;
            const declarations = property.declarations ?? [];
            const shapeOf = (site: ts.Node): RecordShape =>
                spec.members?.get(name)?.shape ??
                this.declaredShape(
                    this.checker.getTypeOfSymbolAtLocation(property, site),
                    site,
                );
            const base = {
                name,
                field: cppIdentifier(pinnedSnakeCase(name)),
                declaredBy: record,
            };
            const getter = declarations.find(ts.isGetAccessorDeclaration);
            const setter = declarations.find(ts.isSetAccessorDeclaration);
            const method = declarations.find(ts.isMethodDeclaration);
            const field = declarations.find(ts.isPropertyDeclaration);
            // An accessor's or method's shape is read only when a lowered
            // body uses it: a member nothing reaches may take a type a
            // type-only module erased.
            let lazy: RecordShape | undefined;
            const lazyShape = (site: ts.Node) => () => (lazy ??= shapeOf(site));
            if (getter || setter) {
                const site = (getter ?? setter)!;
                const shape = lazyShape(site);
                members.set(name, {
                    ...base,
                    get shape() {
                        return shape();
                    },
                    access: () =>
                        this.fail(
                            site,
                            `Pinned accessor '${name}' has no stored value.`,
                        ),
                    ...(getter
                        ? {
                              get: (owner: string) =>
                                  `${this.qualified(this.lowered(getter))}(${owner})`,
                          }
                        : {}),
                    ...(setter
                        ? {
                              set: (owner: string, value: string) =>
                                  `${this.qualified(this.lowered(setter))}(${owner}, ${value})`,
                          }
                        : {}),
                    storage: "none",
                });
            } else if (method) {
                const shape = lazyShape(method);
                members.set(name, {
                    ...base,
                    get shape() {
                        return shape();
                    },
                    access: () =>
                        this.fail(
                            method,
                            `Pinned method '${name}' is read as a value.`,
                        ),
                    call: (owner, args) =>
                        `${this.qualified(this.lowered(method))}(${[owner, ...args].join(", ")})`,
                    storage: "none",
                });
            } else if (field) {
                if (
                    field.modifiers?.some(
                        (modifier) =>
                            modifier.kind === ts.SyntaxKind.StaticKeyword,
                    )
                )
                    continue;
                members.set(name, {
                    ...base,
                    shape: shapeOf(field),
                    access: (owner) => `${owner}->${base.field}`,
                    storage: "field",
                });
            } else
                this.fail(
                    declaration,
                    `Pinned class member '${name}' is neither a field, an accessor nor a method.`,
                );
        }
        this.separateFields(members, (member, field) =>
            members.set(member.name, {
                ...member,
                field,
                access: (owner) => `${owner}->${field}`,
            }),
        );
        return members;
    }

    private mergeShapes(shapes: readonly RecordShape[]): RecordShape {
        const optional = shapes.some((shape) => shape.kind === "optional");
        const members: RecordShape[] = [];
        for (const shape of shapes) {
            const value = shape.kind === "optional" ? shape.value : shape;
            for (const member of value.kind === "variant"
                ? value.members
                : [value])
                if (
                    !members.some(
                        (existing) =>
                            this.cppType(existing) === this.cppType(member),
                    )
                )
                    members.push(member);
        }
        const merged: RecordShape = this.variantOf(members);
        return optional ? optionalOf(merged) : merged;
    }

    /** The member a pinned property read resolves to. */
    public member(record: string, name: string, site: ts.Node): ResolvedMember {
        const resolved = this.record(record);
        const member = resolved.members().get(name);
        if (!member) {
            const reason = resolved.spec.omit?.get(name);
            return this.fail(
                site,
                reason
                    ? `Pinned member '${name}' is not represented: ${reason}`
                    : `Pinned member '${name}' of ${record} is not represented.`,
            );
        }
        return member;
    }

    /**
     * The native read of one member for a native caller (the compiler's
     * text transforms): a stored member's field, an accessor's getter.
     */
    public memberRead(owner: string, record: string, name: string): string {
        const member = this.member(record, name, this.recordSite(record));
        return member.get ? member.get(owner) : member.access(owner);
    }

    /** The native store of one member for a native caller: a field, or a setter. */
    public memberWrite(
        owner: string,
        record: string,
        name: string,
        value: string,
    ): string {
        const member = this.member(record, name, this.recordSite(record));
        if (member.set) return member.set(owner, value);
        if (member.storage !== "field")
            return this.fail(
                this.recordSite(record),
                `Pinned member '${name}' of ${record} has no setter.`,
            );
        return `${member.access(owner)} = ${value}`;
    }

    /** The native call of one method member for a native caller. */
    public memberCall(
        owner: string,
        record: string,
        name: string,
        args: readonly string[],
    ): string {
        const member = this.member(record, name, this.recordSite(record));
        if (member.shape.kind !== "function")
            return this.fail(
                this.recordSite(record),
                `Pinned member '${name}' of ${record} is not a method.`,
            );
        return member.call
            ? member.call(owner, args)
            : `${member.access(owner)}(${args.join(", ")})`;
    }

    /** The shape of one member, for a native caller. */
    public memberShape(record: string, name: string): RecordShape {
        return this.member(record, name, this.recordSite(record)).shape;
    }

    private recordSite(record: string): ts.Node {
        const spec = this.record(record).spec;
        return spec.native
            ? this.typed.program.getSourceFiles()[0]!
            : this.recordSource(spec).site;
    }

    // ── Values the pin built at generation ─────────────────────────────

    /** The shape walk the generation child performs over these records. */
    public transportSchema(): TransportSchema {
        const records: Record<string, TransportRecord> = {};
        const visit = (shape: RecordShape): TransportShape => {
            switch (shape.kind) {
                case "record": {
                    // A native record (a font, a GPU lease) is the runtime's own.
                    if (this.record(shape.name).spec.native)
                        return { kind: "native" };
                    if (!(shape.name in records)) {
                        const record = this.record(shape.name);
                        const members: (readonly [string, TransportShape])[] =
                            [];
                        records[shape.name] = {
                            reference: record.spec.reference,
                            members,
                        };
                        for (const member of record.members().values())
                            if (member.storage !== "none")
                                members.push([
                                    member.name,
                                    member.storage === "accessor"
                                        ? { kind: "function" }
                                        : visit(member.shape),
                                ]);
                    }
                    return { kind: "record", name: shape.name };
                }
                case "native":
                    return shape.fromString
                        ? { kind: "native", string: true }
                        : { kind: "native" };
                case "array":
                case "set":
                    return { kind: shape.kind, element: visit(shape.element) };
                case "map":
                    return {
                        kind: "map",
                        key: visit(shape.key),
                        value: visit(shape.value),
                    };
                case "optional":
                    return { kind: "optional", value: visit(shape.value) };
                case "variant":
                    return {
                        kind: "variant",
                        members: shape.members.map(visit),
                    };
                case "tuple":
                    return { kind: "tuple", length: shape.length };
                case "typed":
                    return { kind: "typed", element: shape.element };
                default:
                    return { kind: shape.kind };
            }
        };
        for (const [name] of this.records)
            if (!this.record(name).spec.native) visit({ kind: "record", name });
        return { records };
    }

    /**
     * The C++ that rebuilds a transported graph as `shape`. `buffer` spells
     * the `bbl::js::ArrayBuffer` of one transported buffer.
     */
    public transportCpp(
        graph: TransportedGraph,
        shape: RecordShape,
        buffer: (index: number) => string,
    ): string {
        const lines: string[] = [];
        const declared = new Set<number>();
        const site = this.typed.program.getSourceFiles()[0]!;
        const value = (transported: Transported, to: RecordShape): string => {
            if (to.kind === "optional") {
                if (transported === null) return this.absent(to, site);
                const present = value(transported, to.value);
                return nullableByRepresentation(to.value, this)
                    ? present
                    : `${this.cppType(to)}(${present})`;
            }
            if (transported === null)
                // A native value (a font, a GPU lease) is the runtime's own:
                // generation leaves it unset.
                return (to.kind === "native" && !to.fromString) ||
                    (to.kind === "record" && this.record(to.name).spec.native)
                    ? `${this.cppType(to)}{}`
                    : this.fail(
                          site,
                          `Transported ${this.cppType(to)} is absent.`,
                      );
            if (typeof transported === "number")
                return doubleLiteral(transported);
            if (typeof transported === "boolean") return String(transported);
            if (typeof transported === "string")
                return to.kind === "native"
                    ? `${to.cpp}(std::string(${stringLiteral(transported)}))`
                    : `std::string(${stringLiteral(transported)})`;
            if ("number" in transported)
                return transported.number === "NaN"
                    ? "std::numeric_limits<double>::quiet_NaN()"
                    : `${transported.number.startsWith("-") ? "-" : ""}std::numeric_limits<double>::infinity()`;
            if ("ref" in transported) {
                if (to.kind !== "record")
                    return this.fail(
                        site,
                        "Transported record into a non-record.",
                    );
                return `record_${transported.ref}`;
            }
            if ("value" in transported) {
                if (to.kind !== "record")
                    return this.fail(
                        site,
                        "Transported value record into a non-record.",
                    );
                const record = this.record(to.name);
                const members = [...record.members().values()]
                    .filter((member) => member.storage === "field")
                    .map(
                        (member) =>
                            `.${member.field} = ${value(transported.value[member.name] ?? null, member.shape)}`,
                    );
                return `bbl::${record.spec.cpp}{${members.join(", ")}}`;
            }
            if ("tuple" in transported)
                return `${this.cppType(to)}{${transported.tuple.map(doubleLiteral).join(", ")}}`;
            if ("typed" in transported)
                return `${this.cppType(to)}(${buffer(transported.buffer)}, ${transported.byteOffset}.0, ${transported.length}.0)`;
            if ("variant" in transported) {
                if (to.kind !== "variant")
                    return this.fail(
                        site,
                        "Transported variant into a non-variant.",
                    );
                return `${this.cppType(to)}(${value(transported.of, to.members[transported.variant]!)})`;
            }
            const id = transported.container;
            if (!declared.has(id)) {
                declared.add(id);
                const container = graph.containers[id]!;
                let items: string[];
                if (container.kind === "map") {
                    if (to.kind !== "map")
                        return this.fail(
                            site,
                            "Transported map into a non-map.",
                        );
                    items = container.entries.map(
                        ([key, entry]) =>
                            `{${value(key, to.key)}, ${value(entry, to.value)}}`,
                    );
                } else {
                    if (to.kind !== "array" && to.kind !== "set")
                        return this.fail(
                            site,
                            "Transported list into a non-list.",
                        );
                    items = container.items.map((item) =>
                        value(item, to.element),
                    );
                }
                lines.push(
                    `    ${this.cppType(to)} container_${id}{${items.join(", ")}};`,
                );
            }
            return `container_${id}`;
        };
        const root = value(graph.root, shape);
        const fills: string[] = [];
        for (const [id, record] of graph.records.entries()) {
            const resolved = this.record(record.name);
            for (const member of resolved.members().values())
                if (member.storage === "field")
                    fills.push(
                        `    ${member.access(`record_${id}`)} = ${value(record.fields[member.name] ?? null, member.shape)};`,
                    );
        }
        const creations = graph.records.map(
            (record, id) =>
                `    auto record_${id} = bbl::js::make_gc_shared<bbl::${this.record(record.name).spec.cpp}>();`,
        );
        return `[&] {\n${[...creations, ...lines, ...fills].join("\n")}\n    return ${root};\n}()`;
    }

    /** Struct definitions for every emitted record, forward declared first. */
    public structs(names: readonly string[]): string {
        const emitted = names.map((name) => this.record(name));
        const lines: string[] = [];
        for (const record of emitted)
            if (!record.spec.native) lines.push(`struct ${record.spec.cpp};`);
        for (const record of emitted) {
            const spec = record.spec;
            if (spec.native) continue;
            const { site } = this.recordSource(spec);
            const bases = (spec.bases ?? []).map(
                (base) => `bbl::${this.record(base).spec.cpp}`,
            );
            lines.push(
                `// ${this.context.provenance(modulePathOf(site.getSourceFile()), spec.returnOf?.split("#")[1] ?? spec.typeOf?.split("#")[1] ?? spec.pinned[0]!)}`,
                `struct ${spec.cpp}${bases.length ? ` : ${bases.join(", ")}` : ""} {`,
            );
            const traced: string[] = [];
            for (const member of record.members().values()) {
                if (member.storage === "none") continue;
                const fields: (readonly [string, string])[] =
                    member.storage === "accessor"
                        ? [
                              [
                                  `get_${member.field}`,
                                  this.cppType({
                                      kind: "function",
                                      parameters: [],
                                      result: member.shape,
                                  }),
                              ],
                              [
                                  `set_${member.field}`,
                                  this.cppType({
                                      kind: "function",
                                      parameters: [member.shape],
                                      result: { kind: "void" },
                                  }),
                              ],
                          ]
                        : [[member.field, this.cppType(member.shape)]];
                for (const [field, cpp] of fields) {
                    if (member.declaredBy === spec.pinned[0])
                        lines.push(
                            `    ${cpp} ${field}${member.storage === "field" ? memberInitializer(member.shape) : "{}"};`,
                        );
                    if (
                        member.storage === "accessor" ||
                        !["number", "boolean", "string"].includes(
                            member.shape.kind,
                        )
                    )
                        traced.push(field);
                }
            }
            // A struct that can hold a function -- whose environment may
            // hold anything -- or itself can close a cycle: it describes its
            // edges, so `make_gc_shared` registers it for cycle collection.
            if (this.traced(spec.pinned[0]!) && traced.length > 0)
                lines.push(
                    "    void gc_trace(const bbl::js::TraceVisitor& visitor) const {",
                    ...traced.map((field) => `        visitor(${field});`),
                    "    }",
                );
            lines.push("};");
        }
        return lines.join("\n");
    }

    private readonly tracedRecords = new Map<string, boolean>();

    /**
     * Whether a record's instances can close a reference cycle: its stored
     * members reach a function (a closure's environment may hold anything)
     * or the record itself.
     */
    public traced(name: string): boolean {
        const start = this.recordKey(name);
        const known = this.tracedRecords.get(start);
        if (known !== undefined) return known;
        const visited = new Set<string>();
        const reaches = (shape: RecordShape): boolean => {
            switch (shape.kind) {
                case "function":
                case "object":
                    return true;
                case "record": {
                    const key = this.recordKey(shape.name);
                    if (key === start) return true;
                    // A native record's header describes its own edges.
                    if (visited.has(key) || this.record(key).spec.native)
                        return false;
                    visited.add(key);
                    return stored(key);
                }
                case "array":
                case "set":
                    return reaches(shape.element);
                case "map":
                    return reaches(shape.key) || reaches(shape.value);
                case "weakmap":
                case "optional":
                    return reaches(shape.value);
                case "variant":
                    return shape.members.some(reaches);
                default:
                    return false;
            }
        };
        const stored = (key: string): boolean =>
            [...this.record(key).members().values()].some(
                (member) =>
                    member.storage === "accessor" ||
                    (member.storage === "field" && reaches(member.shape)),
            );
        const result = stored(start);
        this.tracedRecords.set(start, result);
        return result;
    }

    // ── Functions and module state ──────────────────────────────────────

    public functionDeclaration(
        module: string,
        name: string,
    ): ts.FunctionDeclaration {
        const file = this.typed.sourceFile(module);
        const found = file.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === name &&
                statement.body !== undefined,
        );
        if (!found)
            throw new Error(
                `Pinned function ${module}#${name} is not declared.`,
            );
        return found;
    }

    /** The declaration a reference names, through import aliases. */
    public declarationOf(node: ts.Node): ts.Declaration | undefined {
        const symbol = resolvedSymbol(this.checker, node);
        return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    }

    /** `module#name` of a module-level declaration. */
    public keyOf(declaration: ts.Declaration): string | undefined {
        const name = ts.getNameOfDeclaration(declaration);
        return name && ts.isIdentifier(name)
            ? `${modulePathOf(declaration.getSourceFile())}#${name.text}`
            : undefined;
    }

    /**
     * Register a pinned function (and, lazily, what it reaches): a module
     * function, or a class's method, accessor or constructor.
     * `parameters` specializes the parameters a type-only module erased
     * to the shapes a call passes; each signature is its own overload.
     */
    public lowered(
        declaration: PinnedCallable,
        parameters?: readonly (RecordShape | undefined)[],
    ): LoweredFunction {
        const module = modulePathOf(declaration.getSourceFile());
        const named = this.callableName(declaration);
        const specialized = parameters?.some((shape) => shape !== undefined)
            ? parameters
            : undefined;
        const name = specialized
            ? `${named.name}(${specialized.map((shape) => (shape ? this.cppType(shape) : "_")).join(", ")})`
            : named.name;
        const key = `${module}#${name}`;
        const existing = this.functions.get(key);
        if (existing) return existing;
        const entry: LoweredFunction = {
            module,
            name,
            declaration,
            cpp: named.cpp,
            namespace: (
                this.schema.exported
                    ? this.schema.exported.has(`${module}#${named.exported}`)
                    : isExported(named.declared)
            )
                ? "bbl"
                : detailNamespace(module),
            ...(named.owner !== undefined ? { owner: named.owner } : {}),
            ...(specialized ? { parameters: specialized } : {}),
        };
        this.functions.set(key, entry);
        this.order.push(entry);
        return entry;
    }

    /**
     * The pinned and native names of a callable: a class member's name is
     * its class's and its own (`ObservableVec3.set x`,
     * `observable_vec3_set_x`); `exported` is the name `schema.exported`
     * lists (`ObservableVec3.x` for both its accessors).
     */
    private callableName(declaration: PinnedCallable): {
        name: string;
        cpp: string;
        exported: string;
        declared: ts.Node;
        owner?: string;
    } {
        if (ts.isFunctionDeclaration(declaration)) {
            if (!declaration.name || !ts.isSourceFile(declaration.parent))
                return this.fail(
                    declaration,
                    "Pinned nested functions are closures, not module functions.",
                );
            const name = declaration.name.text;
            return {
                name,
                cpp: cppIdentifier(pinnedSnakeCase(name)),
                exported: name,
                declared: declaration,
            };
        }
        const owner = ts.isClassDeclaration(declaration)
            ? declaration
            : declaration.parent;
        if (!ts.isClassDeclaration(owner) || !owner.name)
            return this.fail(
                declaration,
                "Pinned methods and accessors outside a class are closures.",
            );
        const className = owner.name.text;
        if (!this.records.has(className))
            return this.fail(
                owner,
                `Pinned class ${className} is not a record of this model.`,
            );
        const stem = cppIdentifier(pinnedSnakeCase(className));
        const base = {
            declared: owner,
            owner: this.recordKey(className),
        };
        if (
            ts.isClassDeclaration(declaration) ||
            ts.isConstructorDeclaration(declaration)
        )
            return {
                ...base,
                name: `${className}.constructor`,
                cpp: `${stem}_construct`,
                exported: `${className}.constructor`,
            };
        const member = declaration.name.getText();
        const snake = pinnedSnakeCase(member);
        if (ts.isGetAccessorDeclaration(declaration))
            return {
                ...base,
                name: `${className}.get ${member}`,
                cpp: `${stem}_get_${snake}`,
                exported: `${className}.${member}`,
            };
        if (ts.isSetAccessorDeclaration(declaration))
            return {
                ...base,
                name: `${className}.set ${member}`,
                cpp: `${stem}_set_${snake}`,
                exported: `${className}.${member}`,
            };
        return {
            ...base,
            name: `${className}.${member}`,
            cpp: `${stem}_${snake}`,
            exported: `${className}.${member}`,
        };
    }

    /**
     * A class member's declaration by name (`kind` picks an accessor's
     * half), or the class's constructor (its declaration, when implicit).
     */
    public classMember(
        module: string,
        className: string,
        member: string,
        kind: "method" | "get" | "set" | "constructor",
    ): PinnedCallable {
        const owner = this.typed
            .sourceFile(module)
            .statements.find(
                (statement): statement is ts.ClassDeclaration =>
                    ts.isClassDeclaration(statement) &&
                    statement.name?.text === className,
            );
        if (!owner)
            throw new Error(
                `Pinned class ${module}#${className} is not declared.`,
            );
        if (kind === "constructor")
            return owner.members.find(ts.isConstructorDeclaration) ?? owner;
        const found = owner.members.find(
            (candidate) =>
                candidate.name?.getText() === member &&
                (kind === "get"
                    ? ts.isGetAccessorDeclaration(candidate)
                    : kind === "set"
                      ? ts.isSetAccessorDeclaration(candidate)
                      : ts.isMethodDeclaration(candidate)),
        );
        if (
            !found ||
            !(
                ts.isGetAccessorDeclaration(found) ||
                ts.isSetAccessorDeclaration(found) ||
                ts.isMethodDeclaration(found)
            )
        )
            throw new Error(
                `Pinned ${kind} ${className}.${member} is not declared.`,
            );
        return found;
    }

    public qualified(entry: { namespace: string; cpp: string }): string {
        return `${entry.namespace}::${entry.cpp}`;
    }

    /**
     * Register a pinned module-scope `let` a body reads or writes, or a
     * `const` holding a constructed object; `initialize` lowers its
     * initializer as the variable's shape.
     */
    public variable(
        declaration: ts.VariableDeclaration,
        initialize?: (shape: RecordShape) => string,
    ): ModuleVariable {
        const existing = this.variables.get(declaration);
        if (existing) return existing;
        if (!ts.isIdentifier(declaration.name))
            return this.fail(declaration, "Pinned module state needs a name.");
        const statement = declaration.parent.parent;
        const module = modulePathOf(declaration.getSourceFile());
        const shape = this.declaredShape(
            this.checker.getTypeAtLocation(declaration.name),
            declaration,
        );
        const entry: ModuleVariable = {
            declaration,
            cpp: cppIdentifier(pinnedSnakeCase(declaration.name.text)),
            // Realm state sits in its own namespace, so no lowered local of
            // the same name hides it.
            namespace: `${isExported(statement) ? "bbl" : detailNamespace(module)}::realm`,
            shape,
            ...(initialize ? { initializer: initialize(shape) } : {}),
        };
        this.variables.set(declaration, entry);
        return entry;
    }

    /** The C++ parameter list of a lowered function. */
    private signature(entry: LoweredFunction, defaults: boolean): string {
        const returns = this.returnShapeOf(entry);
        const parameters = this.parametersOf(entry).map(
            (parameter) =>
                `${this.cppType(parameter.shape)} ${cppIdentifier(parameter.name.text)}${parameter.optional && defaults ? ` = ${this.absent(parameter.shape, parameter.node)}` : ""}`,
        );
        const self = this.selfShape(entry);
        return `${this.cppType(returns)} ${entry.cpp}(${[
            ...(self ? [`${this.cppType(self)} self`] : []),
            ...parameters,
        ].join(", ")})`;
    }

    /** The instance a class member lowers over, as its first parameter. */
    public selfShape(entry: LoweredFunction): RecordShape | undefined {
        return entry.owner !== undefined &&
            !ts.isClassDeclaration(entry.declaration) &&
            !ts.isConstructorDeclaration(entry.declaration)
            ? { kind: "record", name: entry.owner }
            : undefined;
    }

    /** A lowered function's pinned parameters with their native shapes. */
    public parametersOf(entry: LoweredFunction): NativeParameter[] {
        const declaration = entry.declaration;
        if (ts.isClassDeclaration(declaration)) return [];
        return declaration.parameters.map((parameter, index) => {
            if (!ts.isIdentifier(parameter.name))
                return this.fail(parameter, "Pinned parameters must be named.");
            if (parameter.initializer)
                this.fail(
                    parameter,
                    "Pinned default parameters are not lowered.",
                );
            if (ts.getModifiers(parameter)?.length)
                this.fail(
                    parameter,
                    "Pinned parameter properties are not lowered.",
                );
            if (entry.owner !== undefined && parameter.name.text === "self")
                this.fail(
                    parameter,
                    "A pinned method's parameter is named as its receiver.",
                );
            return {
                name: parameter.name,
                shape:
                    entry.parameters?.[index] ??
                    this.declaredShape(
                        this.checker.getTypeAtLocation(parameter.name),
                        parameter,
                    ),
                optional: parameter.questionToken !== undefined,
                node: parameter,
            };
        });
    }

    /** What a lowered function returns: a constructor returns its instance. */
    public returnShapeOf(entry: LoweredFunction): RecordShape {
        const declaration = entry.declaration;
        if (
            ts.isClassDeclaration(declaration) ||
            ts.isConstructorDeclaration(declaration)
        )
            return { kind: "record", name: entry.owner! };
        if (ts.isSetAccessorDeclaration(declaration)) return { kind: "void" };
        return this.returnShape(declaration);
    }

    public returnShape(declaration: ts.SignatureDeclaration): RecordShape {
        const signature = this.checker.getSignatureFromDeclaration(declaration);
        if (!signature)
            return this.fail(declaration, "Pinned function has no signature.");
        return this.declaredShape(
            this.checker.getReturnTypeOfSignature(signature),
            declaration,
        );
    }

    /**
     * Lower `roots` and every pinned function they reach, then emit only
     * the ones `emit` selects (functions another header already carries
     * are declared there). Returns the module state, prototypes and
     * definitions, each group within its namespace.
     */
    public lower(
        roots: readonly PinnedCallable[],
        emit: (entry: { module: string; name: string }) => boolean = () => true,
    ): { declarations: string; definitions: string } {
        for (const root of roots) this.lowered(root);
        const bodies = new Map<
            LoweredFunction,
            { environments: string; body: string }
        >();
        for (let index = 0; index < this.order.length; index += 1) {
            const entry = this.order[index]!;
            const lowerer = new RecordBodyLowerer(this, entry);
            const body = lowerer.body();
            bodies.set(entry, {
                environments: lowerer.environmentStructs(),
                body,
            });
        }
        const selected = this.order.filter((entry) => emit(entry));
        const grouped = <T>(
            items: readonly T[],
            namespace: (item: T) => string,
            line: (item: T) => string,
        ): string => {
            const byNamespace = new Map<string, string[]>();
            for (const item of items) {
                const key = namespace(item);
                const list = byNamespace.get(key) ?? [];
                list.push(line(item));
                byNamespace.set(key, list);
            }
            return [...byNamespace]
                .map(([name, lines]) =>
                    name === "bbl"
                        ? lines.join("\n")
                        : `namespace ${name.slice("bbl::".length)} {\n${lines.join("\n")}\n} // namespace ${name.slice("bbl::".length)}`,
                )
                .join("\n");
        };
        const variables = [...this.variables.values()].filter((variable) =>
            emit({
                module: modulePathOf(variable.declaration.getSourceFile()),
                name: variable.declaration.name.getText(),
            }),
        );
        const declarations = [
            grouped(
                variables,
                (variable) => variable.namespace,
                (variable) => {
                    const initializer = variable.declaration.initializer;
                    if (
                        variable.initializer === undefined &&
                        initializer &&
                        initializer.kind !== ts.SyntaxKind.NullKeyword &&
                        !(
                            ts.isIdentifier(initializer) &&
                            initializer.text === "undefined"
                        )
                    )
                        this.fail(
                            initializer,
                            "Pinned module state starts from null or undefined only.",
                        );
                    return `// ${this.context.provenance(modulePathOf(variable.declaration.getSourceFile()), variable.declaration.name.getText(), "realm state")}\ninline thread_local ${this.cppType(variable.shape)} ${variable.cpp}${variable.initializer !== undefined ? ` = ${variable.initializer}` : "{}"};`;
                },
            ),
            grouped(
                selected,
                (entry) => entry.namespace,
                (entry) => `${this.signature(entry, true)};`,
            ),
        ]
            .filter((part) => part.length > 0)
            .join("\n");
        const definitions = grouped(
            selected,
            (entry) => entry.namespace,
            (entry) => {
                const { environments, body } = bodies.get(entry)!;
                return `${environments}// ${this.context.provenance(entry.module, entry.name)}\ninline ${this.signature(entry, false)} {\n${body}\n}`;
            },
        );
        return { declarations, definitions };
    }
}

/** Whether absence is a state of the native value itself. */
function nullableByRepresentation(
    shape: RecordShape,
    model: PinnedRecordModel,
): boolean {
    return (
        shape.kind === "object" ||
        shape.kind === "function" ||
        (shape.kind === "native" && shape.nullable === true) ||
        (shape.kind === "record" && model.record(shape.name).spec.reference)
    );
}

function optionalOf(shape: RecordShape): RecordShape {
    return shape.kind === "optional"
        ? shape
        : { kind: "optional", value: shape };
}

/** A struct member's initializer: JavaScript numbers and flags start at zero. */
function memberInitializer(shape: RecordShape): string {
    return shape.kind === "number"
        ? " = 0"
        : shape.kind === "boolean"
          ? " = false"
          : "{}";
}

interface Local {
    readonly storage: RecordShape;
    /** The C++ name of a local its frame declares itself. */
    readonly cpp?: string;
    /** A binding closures capture: its field in its frame's environment. */
    readonly captured?: {
        readonly frame: Frame;
        readonly field: string;
        /** Its slot is a `LexicalBinding`: a closure may read it first. */
        readonly temporal: boolean;
    };
}

/**
 * The environment of one function-like whose bindings closures capture:
 * a struct holding them, allocated for cycle collection when the frame
 * runs, and shared by every closure the frame creates -- one environment
 * per invocation, as JavaScript's scope is.
 */
interface Environment {
    readonly owner: Frame;
    readonly struct: string;
    /** The C++ name of the environment pointer inside its own frame. */
    readonly variable: string;
    readonly fields: {
        readonly field: string;
        readonly storage: RecordShape;
        readonly temporal: boolean;
    }[];
    /** The defining frame's environment, reachable through `enclosing`. */
    readonly enclosing?: Environment;
}

/** One function-like body being lowered: the function itself, or a closure in it. */
interface Frame {
    readonly node: ts.Node;
    readonly returns: RecordShape;
    /** The environment this frame's bindings live in, when closures capture them. */
    environment?: Environment;
    /** The defining frame's environment, as a closure receives it. */
    readonly received?: {
        readonly variable: string;
        readonly environment: Environment;
    };
    /** The receiver a class member lowers over. */
    readonly self?: string;
}

/** How a sink receives a converted value. */
interface Place {
    /** The readable C++ lvalue, when the place is one. */
    readonly cpp?: string;
    readonly storage: RecordShape;
    /** The store, for a place written through a helper. */
    readonly store: (value: string) => string;
}

/**
 * One lowered function body: the record statements and expressions, with
 * JavaScript's arithmetic delegated to `PinnedNumericLowerer`.
 */
class RecordBodyLowerer extends PinnedNumericLowerer {
    private readonly locals = new Map<ts.Symbol, Local>();
    private readonly names: Set<string>[] = [new Set()];
    private readonly declared = new Set<string>();
    private readonly substitutions = new Map<ts.Node, string>();
    private readonly source: ts.SourceFile;
    private temporaries = 0;
    private catchVariable: ts.Symbol | undefined;
    /** Bindings a closure inside this function reads or writes. */
    private readonly captured = new Set<ts.Symbol>();
    /** Where the first closure over each captured binding is created. */
    private readonly earliestCapture = new Map<ts.Symbol, number>();
    /** The frames being lowered, innermost last. */
    private readonly frames: Frame[] = [];
    /** Environment struct definitions, in the order frames created them. */
    private readonly environments: string[] = [];

    public constructor(
        private readonly model: PinnedRecordModel,
        private readonly entry: LoweredFunction,
    ) {
        const calls = pinnedNumericMathCalls();
        calls.set(
            "Math.fround",
            (args) => `static_cast<double>(static_cast<float>(${args[0]}))`,
        );
        calls.set("Number.isFinite", (args) => `std::isfinite(${args[0]})`);
        const scope: PinnedNumericScope = {
            bindings: new Map(),
            calls,
            booleanAnd: true,
            booleanOr: true,
        };
        super(entry.declaration.getSourceFile(), scope);
        this.source = entry.declaration.getSourceFile();
        this.findCaptures();
        const self = model.selfShape(entry);
        const constructs =
            ts.isClassDeclaration(entry.declaration) ||
            ts.isConstructorDeclaration(entry.declaration);
        this.frames.push({
            node: entry.declaration,
            returns: model.returnShapeOf(entry),
            ...(self || constructs ? { self: "self" } : {}),
        });
        if (self || constructs) this.names[0]!.add("self");
        for (const parameter of model.parametersOf(entry))
            this.declare(
                parameter.name,
                parameter.shape,
                cppIdentifier(parameter.name.text),
            );
    }

    private get checker(): ts.TypeChecker {
        return this.model.checker;
    }

    private refuse(node: ts.Node, message: string): never {
        return this.model.fail(node, message);
    }

    private get frame(): Frame {
        return this.frames[this.frames.length - 1]!;
    }

    private get returns(): RecordShape {
        return this.frame.returns;
    }

    public body(): string {
        const declaration = this.entry.declaration;
        const lines = this.frameProlog(
            ts.isClassDeclaration(declaration) ? [] : declaration.parameters,
            ts.isClassDeclaration(declaration)
                ? []
                : (declaration.body?.statements ?? []),
            "    ",
        );
        if (
            ts.isClassDeclaration(declaration) ||
            ts.isConstructorDeclaration(declaration)
        )
            return this.constructorBody(lines);
        return [
            ...lines,
            ...this.statements(
                this.hoisted(declaration.body!.statements),
                "    ",
            ),
        ].join("\n");
    }

    /** The environment structs this function's frames declared. */
    public environmentStructs(): string {
        return this.environments.map((struct) => `${struct}\n`).join("");
    }

    /**
     * A constructor: the instance, its field initializers in declaration
     * order, then the pin's constructor statements over it.
     */
    private constructorBody(prolog: readonly string[]): string {
        const owner = this.entry.owner!;
        const spec = this.model.record(owner).spec;
        const declaration = this.entry.declaration;
        const members = this.model.record(owner).members();
        const classDeclaration = ts.isClassDeclaration(declaration)
            ? declaration
            : declaration.parent;
        if (!ts.isClassDeclaration(classDeclaration))
            return this.refuse(
                declaration,
                "Pinned constructor outside a class.",
            );
        const lines = [
            `    auto self = bbl::js::make_gc_shared<bbl::${spec.cpp}>();`,
            ...prolog,
        ];
        for (const member of classDeclaration.members) {
            if (
                !ts.isPropertyDeclaration(member) ||
                !member.initializer ||
                ts
                    .getModifiers(member)
                    ?.some(
                        (modifier) =>
                            modifier.kind === ts.SyntaxKind.StaticKeyword,
                    )
            )
                continue;
            const resolved = members.get(member.name.getText());
            if (!resolved)
                this.refuse(member, "Pinned class field is not represented.");
            lines.push(
                `    ${resolved.access("self")} = ${this.convert(member.initializer, resolved.shape)};`,
            );
        }
        if (ts.isConstructorDeclaration(declaration) && declaration.body) {
            const returns = this.model.context.findNodes(
                declaration.body,
                (node): node is ts.ReturnStatement =>
                    ts.isReturnStatement(node) &&
                    enclosingFunctionLike(node) === declaration,
            );
            if (returns.length > 0)
                this.refuse(returns[0]!, "A pinned constructor returns early.");
            lines.push(
                ...this.statements(
                    this.hoisted(declaration.body.statements),
                    "    ",
                ),
            );
        }
        lines.push("    return self;");
        return lines.join("\n");
    }

    // ── Closures ────────────────────────────────────────────────────────

    /**
     * Which bindings closures capture: every parameter, local or nested
     * function a function-like other than its own reads or writes. A
     * captured binding lives in its frame's environment, so the frame and
     * all of its closures share it, as JavaScript's scope does.
     */
    private findCaptures(): void {
        const root = this.entry.declaration;
        const visit = (node: ts.Node): void => {
            if (
                ts.isIdentifier(node) &&
                !isDeclarationName(node) &&
                !(
                    ts.isPropertyAccessExpression(node.parent) &&
                    node.parent.name === node
                )
            ) {
                const symbol = declaredSymbol(this.checker, node);
                const declaration =
                    symbol?.valueDeclaration ?? symbol?.declarations?.[0];
                if (
                    symbol &&
                    declaration &&
                    this.isBinding(declaration) &&
                    declaration !== root &&
                    this.within(root, declaration) &&
                    enclosingFunctionLike(declaration) !==
                        enclosingFunctionLike(node)
                ) {
                    this.captured.add(symbol);
                    if (!this.topLevel(declaration))
                        this.refuse(
                            node,
                            "A pinned closure captures a block-scoped binding.",
                        );
                    if (ts.isBindingElement(declaration))
                        this.refuse(
                            node,
                            "A pinned closure captures a destructured binding.",
                        );
                    const created = this.creation(
                        node,
                        enclosingFunctionLike(declaration)!,
                    );
                    this.earliestCapture.set(
                        symbol,
                        Math.min(
                            created,
                            this.earliestCapture.get(symbol) ?? created,
                        ),
                    );
                }
            }
            if (
                node.kind === ts.SyntaxKind.ThisKeyword &&
                !ts.isClassDeclaration(root) &&
                enclosingFunctionLike(node) !== root
            )
                this.refuse(node, "A pinned closure reads `this`.");
            ts.forEachChild(node, visit);
        };
        // An implicit constructor runs its class's field initializers only.
        if (ts.isClassDeclaration(root)) {
            for (const member of root.members)
                if (ts.isPropertyDeclaration(member) && member.initializer)
                    visit(member.initializer);
            return;
        }
        ts.forEachChild(root, visit);
    }

    /**
     * Where the closure through which `node` reaches `owner`'s binding is
     * created in `owner`'s body: the closure `owner` itself creates (a
     * nested function exists from the frame's start, hoisted).
     */
    private creation(node: ts.Node, owner: ts.Node): number {
        let closure: ts.Node = node;
        for (
            let current = enclosingFunctionLike(node);
            current && current !== owner;
            current = enclosingFunctionLike(current)
        )
            closure = current;
        return ts.isFunctionDeclaration(closure)
            ? owner.getStart()
            : closure.getStart();
    }

    /**
     * Whether a captured `let`/`const` can be read by a closure before its
     * declaration runs (a closure created, or a function hoisted, above
     * it): its environment slot is then a `bbl::js::LexicalBinding`, and
     * such a read throws, as JavaScript's temporal dead zone does.
     */
    private temporal(symbol: ts.Symbol, declaration: ts.Node): boolean {
        return (
            ts.isVariableDeclaration(declaration) &&
            (this.earliestCapture.get(symbol) ?? Infinity) <
                declaration.getStart()
        );
    }

    /** A declaration that binds a name in a function's scope. */
    private isBinding(declaration: ts.Node): boolean {
        return (
            ts.isParameter(declaration) ||
            ts.isVariableDeclaration(declaration) ||
            ts.isBindingElement(declaration) ||
            (ts.isFunctionDeclaration(declaration) &&
                !ts.isSourceFile(declaration.parent))
        );
    }

    private within(root: ts.Node, node: ts.Node): boolean {
        for (
            let current: ts.Node | undefined = node;
            current;
            current = current.parent
        )
            if (current === root) return true;
        return false;
    }

    /** Whether a binding is declared at its function's top level. */
    private topLevel(declaration: ts.Node): boolean {
        if (ts.isParameter(declaration)) return true;
        const owner = enclosingFunctionLike(declaration);
        const body = owner && isFunctionLike(owner) ? owner.body : undefined;
        let statement: ts.Node = declaration;
        while (
            statement.parent &&
            !ts.isBlock(statement.parent) &&
            !ts.isSourceFile(statement.parent)
        ) {
            if (isFunctionLike(statement.parent)) return false;
            statement = statement.parent;
        }
        return statement.parent === body;
    }

    /** A frame's statements with its nested function declarations hoisted out. */
    private hoisted(statements: readonly ts.Statement[]): ts.Statement[] {
        return statements.filter(
            (statement) => !ts.isFunctionDeclaration(statement),
        );
    }

    /**
     * What a frame does before its first statement: allocate its
     * environment, move captured parameters into it, and create its
     * nested functions -- hoisted, as JavaScript does -- before anything
     * can call them.
     */
    private frameProlog(
        parameters: readonly ts.ParameterDeclaration[],
        statements: readonly ts.Statement[],
        indent: string,
    ): string[] {
        const frame = this.frame;
        const owned = (declaration: ts.Node): boolean =>
            enclosingFunctionLike(declaration) === frame.node;
        const bindings: {
            name: ts.Identifier;
            storage: () => RecordShape;
        }[] = [];
        for (const parameter of parameters)
            if (ts.isIdentifier(parameter.name)) {
                const name = parameter.name;
                bindings.push({ name, storage: () => this.localStorage(name) });
            }
        const functions: ts.FunctionDeclaration[] = [];
        for (const statement of statements) {
            if (ts.isFunctionDeclaration(statement)) {
                const name = statement.name;
                if (!name || !statement.body)
                    return this.refuse(
                        statement,
                        "Pinned nested function shape.",
                    );
                functions.push(statement);
                bindings.push({
                    name,
                    storage: () =>
                        this.model.shapeOf(this.typeAt(name), statement),
                });
            }
            if (ts.isVariableStatement(statement))
                for (const declaration of statement.declarationList
                    .declarations)
                    if (ts.isIdentifier(declaration.name))
                        bindings.push({
                            name: declaration.name,
                            storage: () => this.storageOf(declaration),
                        });
        }
        const capturedHere = bindings
            .filter(({ name }) => {
                const symbol = declaredSymbol(this.checker, name);
                const declaration =
                    symbol?.valueDeclaration ?? symbol?.declarations?.[0];
                return (
                    symbol !== undefined &&
                    this.captured.has(symbol) &&
                    declaration !== undefined &&
                    owned(declaration)
                );
            })
            .map(({ name, storage }) => ({ name, storage: storage() }));
        const lines: string[] = [];
        if (capturedHere.length > 0) {
            const struct = this.model.environmentName(this.entry);
            const variable = this.temporary("environment");
            const fields: {
                field: string;
                storage: RecordShape;
                temporal: boolean;
            }[] = [];
            const taken = new Set(["enclosing", "gc_trace"]);
            const environment: Environment = {
                owner: frame,
                struct,
                variable,
                fields,
                ...(frame.received
                    ? { enclosing: frame.received.environment }
                    : {}),
            };
            frame.environment = environment;
            // A captured parameter moves into the environment it shares.
            const moves: string[] = [];
            for (const { name, storage } of capturedHere) {
                let field = cppIdentifier(name.text);
                while (taken.has(field)) field = `${field}_`;
                taken.add(field);
                const symbol = declaredSymbol(this.checker, name)!;
                const temporal = this.temporal(symbol, name.parent);
                fields.push({ field, storage, temporal });
                const parameter = this.locals.get(symbol);
                if (ts.isParameter(name.parent) && parameter?.cpp)
                    moves.push(
                        `${indent}${variable}->${field} = ${parameter.cpp};`,
                    );
                this.locals.set(symbol, {
                    storage,
                    captured: { frame, field, temporal },
                });
            }
            this.environments.push(this.environmentStruct(environment));
            lines.push(
                `${indent}auto ${variable} = bbl::js::make_gc_shared<${struct}>();`,
            );
            if (frame.received)
                lines.push(
                    `${indent}${variable}->enclosing = ${frame.received.variable};`,
                );
            lines.push(...moves);
        }
        for (const declaration of functions) {
            const symbol = declaredSymbol(this.checker, declaration.name!)!;
            const storage = this.model.shapeOf(
                this.typeAt(declaration.name!),
                declaration,
            );
            if (storage.kind !== "function")
                this.refuse(declaration, "Pinned nested function type.");
            const value = this.closure(declaration, storage, indent);
            const local = this.locals.get(symbol);
            if (local?.captured)
                lines.push(`${indent}${this.localCpp(local)} = ${value};`);
            else
                lines.push(
                    `${indent}${this.cpp(storage)} ${this.declare(declaration.name!, storage)} = ${value};`,
                );
        }
        return lines;
    }

    /** The indent of a closure's closing brace, by how deeply it nests. */
    private closureIndent(): string {
        return "    ".repeat(this.frames.length);
    }

    /** The struct one frame's environment is. */
    private environmentStruct(environment: Environment): string {
        const lines = [`struct ${environment.struct} {`];
        const traced: string[] = [];
        if (environment.enclosing) {
            lines.push(
                `    std::shared_ptr<${environment.enclosing.struct}> enclosing{};`,
            );
            traced.push("enclosing");
        }
        for (const { field, storage, temporal } of environment.fields) {
            lines.push(
                temporal
                    ? `    bbl::js::LexicalBinding<${this.cpp(storage)}> ${field}{};`
                    : `    ${this.cpp(storage)} ${field}${memberInitializer(storage)};`,
            );
            if (!["number", "boolean", "string"].includes(storage.kind))
                traced.push(field);
        }
        if (traced.length > 0)
            lines.push(
                "    void gc_trace(const bbl::js::TraceVisitor& visitor) const {",
                ...traced.map((field) => `        visitor(${field});`),
                "    }",
            );
        lines.push("};");
        return lines.join("\n");
    }

    /** A binding's storage, before or after its frame declared it. */
    private localStorage(name: ts.Identifier): RecordShape {
        const symbol = declaredSymbol(this.checker, name);
        const local = symbol ? this.locals.get(symbol) : undefined;
        if (local) return local.storage;
        const declaration = name.parent;
        if (ts.isParameter(declaration))
            return this.model.declaredShape(this.typeAt(name), declaration);
        return this.refuse(name, "Pinned binding has no storage.");
    }

    /** The native spelling of a local where the current frame reads it. */
    private localCpp(local: Local): string {
        if (!local.captured) return local.cpp!;
        const slot = this.localSlot(local);
        return local.captured.temporal ? `${slot}.get()` : slot;
    }

    /** A captured binding's environment slot, as the current frame reaches it. */
    private localSlot(local: Local): string {
        if (!local.captured) return local.cpp!;
        const frame = this.frame;
        let environment = frame.environment ?? frame.received?.environment;
        let path =
            frame.environment?.variable ?? frame.received?.variable ?? "";
        while (environment && environment.owner !== local.captured.frame) {
            path = `${path}->enclosing`;
            environment = environment.enclosing;
        }
        if (!environment)
            return this.refuse(
                frame.node,
                "A pinned closure reads a binding outside its environments.",
            );
        return `${path}->${local.captured.field}`;
    }

    /**
     * A function value from a pinned arrow, function expression, method,
     * accessor or nested function: a `bbl::js::Callback` whose invoker
     * receives the environment it closes over. `to` is the function the
     * callers see; a closure that declares fewer parameters ignores the
     * rest, as JavaScript does.
     */
    private closure(
        node: ts.FunctionLikeDeclaration,
        to: RecordShape,
        indent: string,
    ): string {
        if (to.kind !== "function")
            return this.refuse(node, `Pinned function as ${this.cpp(to)}.`);
        if (node.parameters.length > to.parameters.length)
            return this.refuse(
                node,
                "A pinned closure takes more parameters than its callers pass.",
            );
        if (
            (ts.isFunctionDeclaration(node) ||
                ts.isFunctionExpression(node) ||
                ts.isMethodDeclaration(node)) &&
            (node.asteriskToken ||
                ts
                    .getModifiers(node)
                    ?.some(
                        (modifier) =>
                            modifier.kind === ts.SyntaxKind.AsyncKeyword,
                    ))
        )
            return this.refuse(node, "Pinned generator or async closure.");
        const outer = this.frame;
        const visible = outer.environment ?? outer.received?.environment;
        const visibleVariable =
            outer.environment?.variable ?? outer.received?.variable;
        const received = visible
            ? { variable: this.temporary("environment"), environment: visible }
            : undefined;
        const inner = `${indent}    `;
        this.frames.push({
            node,
            returns: to.result,
            ...(received ? { received } : {}),
        });
        this.names.push(new Set());
        try {
            return this.withBindings(() => {
                const parameters = to.parameters.map((shape, index) => {
                    const parameter = node.parameters[index];
                    if (!parameter)
                        return `[[maybe_unused]] ${this.cpp(shape)} ${this.temporary("unused")}`;
                    if (
                        !ts.isIdentifier(parameter.name) ||
                        parameter.initializer
                    )
                        return this.refuse(
                            parameter,
                            "Pinned closure parameter shape.",
                        );
                    return `${this.cpp(shape)} ${this.declare(parameter.name, shape)}`;
                });
                const body = node.body;
                if (!body)
                    return this.refuse(node, "Pinned closure has no body.");
                const statements = ts.isBlock(body) ? body.statements : [];
                const lines = [
                    ...this.frameProlog(node.parameters, statements, inner),
                ];
                if (ts.isBlock(body))
                    lines.push(
                        ...this.statements(
                            this.hoisted(body.statements),
                            inner,
                        ),
                    );
                else if (to.result.kind === "void") {
                    const effect = this.effect(this.skipParentheses(body));
                    if (effect !== null) lines.push(`${inner}${effect};`);
                } else
                    lines.push(
                        `${inner}return ${this.convert(body, to.result)};`,
                    );
                const signature = [
                    ...(received
                        ? [
                              `std::shared_ptr<${received.environment.struct}>& ${received.variable}`,
                          ]
                        : []),
                    ...parameters,
                ].join(", ");
                const lambda = `[](${signature}) -> ${this.cpp(to.result)} {\n${lines.join("\n")}\n${indent}}`;
                return received
                    ? `${this.cpp(to)}(bbl::js::make_closure(${visibleVariable}, ${lambda}))`
                    : `${this.cpp(to)}(${lambda})`;
            });
        } finally {
            this.frames.pop();
            const closed = this.names.pop()!;
            for (const name of closed) this.declared.delete(name);
        }
    }

    /**
     * Whether a local may end up unread: every read of it in the pinned
     * body is an argument of an adapted platform call, which may drop it.
     * The pin's declaration is still emitted, marked as possibly unused.
     */
    private mayBeUnread(name: ts.Identifier): boolean {
        const symbol = declaredSymbol(this.checker, name);
        let unread = true;
        const visit = (node: ts.Node): void => {
            if (!unread) return;
            if (
                ts.isIdentifier(node) &&
                node !== name &&
                declaredSymbol(this.checker, node) === symbol &&
                !this.adaptedArgument(node)
            )
                unread = false;
            ts.forEachChild(node, visit);
        };
        visit(this.entry.declaration);
        return unread;
    }

    /** Whether `node` sits in an argument of an adapted platform call. */
    private adaptedArgument(node: ts.Node): boolean {
        for (
            let child = node, parent = node.parent;
            parent !== this.entry.declaration;
            child = parent, parent = parent.parent
        )
            if (
                ts.isCallExpression(parent) &&
                parent.expression !== child &&
                this.adapterOf(parent)
            )
                return true;
        return false;
    }

    /**
     * The value an adapted callee receives for one parameter: the argument,
     * or the parameter's declared default, or its absence.
     */
    private adapterArgument(node: ts.CallExpression, index: number): string {
        const argument = node.arguments[index];
        const platform = this.adapterOf(node)?.parameters?.[index];
        if (platform)
            return argument
                ? this.convert(argument, platform)
                : this.model.absent(optionalOf(platform), node);
        const callee = this.skipParentheses(node.expression);
        const declaration = this.model.declarationOf(
            ts.isPropertyAccessExpression(callee) ? callee.name : callee,
        );
        const parameter =
            declaration && ts.isFunctionDeclaration(declaration)
                ? declaration.parameters[index]
                : undefined;
        if (!parameter) {
            if (!argument)
                return this.refuse(
                    node,
                    `Pinned adapter argument ${index} is absent.`,
                );
            return this.value(argument);
        }
        const shape = this.model.declaredShape(
            this.checker.getTypeAtLocation(parameter.name),
            parameter,
        );
        if (argument) return this.convert(argument, shape);
        if (parameter.initializer)
            return this.convert(parameter.initializer, shape);
        return this.model.absent(optionalOf(shape), parameter);
    }

    /** The platform adapter standing in for a pinned call, if one does. */
    private adapterOf(node: ts.CallExpression): CallAdapter | undefined {
        const callee = this.skipParentheses(node.expression);
        const declaration =
            ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
                ? this.model.declarationOf(
                      ts.isPropertyAccessExpression(callee)
                          ? callee.name
                          : callee,
                  )
                : undefined;
        const key = declaration ? this.model.keyOf(declaration) : undefined;
        return (
            (key ? this.model.schema.adapters.get(key) : undefined) ??
            this.model.schema.adapters.get(callee.getText(this.source))
        );
    }

    // ── Names and locals ────────────────────────────────────────────────

    private declare(
        name: ts.Identifier,
        storage: RecordShape,
        cpp?: string,
    ): string {
        const symbol = declaredSymbol(this.checker, name);
        if (!symbol) return this.refuse(name, "Pinned local has no symbol.");
        let chosen = cpp ?? cppIdentifier(name.text);
        const visible = (candidate: string) =>
            this.names.some((scope) => scope.has(candidate)) ||
            this.declared.has(candidate);
        if (cpp === undefined && visible(chosen)) {
            let suffix = 1;
            while (visible(`${chosen}_${suffix}`)) suffix += 1;
            chosen = `${chosen}_${suffix}`;
        }
        this.names[this.names.length - 1]!.add(chosen);
        this.locals.set(symbol, { cpp: chosen, storage });
        return chosen;
    }

    private temporary(stem: string): string {
        this.temporaries += 1;
        const name = `${stem}_${this.temporaries}`;
        this.declared.add(name);
        return name;
    }

    private scoped<T>(action: () => T): T {
        this.names.push(new Set());
        try {
            return this.withBindings(action);
        } finally {
            const closed = this.names.pop()!;
            // Sibling scopes may reuse a name; an enclosing one may not,
            // which MSVC reports as a hidden declaration.
            for (const name of closed) this.declared.delete(name);
        }
    }

    private typeAt(node: ts.Node): ts.Type {
        return this.checker.getTypeAtLocation(node);
    }

    private shapeAt(node: ts.Node): RecordShape {
        // A class member's `this` is its instance (the checker's polymorphic
        // `this` type names no record).
        if (node.kind === ts.SyntaxKind.ThisKeyword && this.entry.owner)
            return { kind: "record", name: this.entry.owner };
        if (ts.isIdentifier(node)) {
            const declaration = this.model.declarationOf(node);
            const platform = declaration
                ? this.moduleValue(declaration)
                : undefined;
            if (platform) return platform.shape;
        }
        const type = this.typeAt(node);
        // A record's member is the shape its record declares, whether the
        // checker spells the member's type by name or anonymously (a
        // layer's `{ x, y }`); the checker still says whether it is present.
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.recordOwner(node.expression);
            if (owner !== undefined) {
                const record = this.model.record(owner);
                if (record.spec.members?.has(node.name.text)) {
                    const member = this.model.member(
                        owner,
                        node.name.text,
                        node,
                    );
                    // An erased member type says nothing of absence: the
                    // member's own shape and the chain decide.
                    const nullish =
                        type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
                            ? member.shape.kind === "optional" ||
                              ts.isOptionalChain(node)
                            : type.isUnion()
                              ? type.types.some(
                                    (part) => (part.flags & nullishFlags) !== 0,
                                )
                              : (type.flags & nullishFlags) !== 0;
                    return nullish
                        ? optionalOf(member.shape)
                        : this.stripOptional(member.shape);
                }
            }
        }
        if (this.containsAny(type)) {
            const structural = this.structuralShape(node);
            // An optional chain's value may be absent whatever it reads.
            if (structural)
                return ts.isOptionalChain(node)
                    ? optionalOf(structural)
                    : structural;
        }
        return this.model.shapeOf(type, node);
    }

    /** The record an expression holds (through `?.`/`!`), if it holds one. */
    private recordOwner(node: ts.Expression): string | undefined {
        const shape = this.recordShapeOf(node);
        return shape?.kind === "record" ? shape.name : undefined;
    }

    private recordShapeOf(node: ts.Expression): RecordShape | undefined {
        if (node.kind === ts.SyntaxKind.ThisKeyword && this.entry.owner)
            return { kind: "record", name: this.entry.owner };
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.recordOwner(node.expression);
            const member =
                owner !== undefined
                    ? this.model.record(owner).members().get(node.name.text)
                    : undefined;
            if (member) return this.stripOptional(member.shape);
        }
        const type = this.checker.getNonNullableType(this.typeAt(node));
        const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
        return name !== undefined && this.model.isRecordName(name)
            ? { kind: "record", name: this.model.recordKey(name) }
            : undefined;
    }

    private containsAny(type: ts.Type): boolean {
        return this.model.erased(type);
    }

    /**
     * The shape a value has by construction, where the checker typed it as
     * `any`: a library the typed program cannot resolve (the text shaper),
     * or an untyped `new Map()` a `??=` stores into a typed place. The
     * storage the port chose is then the value's shape.
     */
    private structuralShape(node: ts.Node): RecordShape | undefined {
        if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
            return this.structuralShape(node.expression);
        if (ts.isAsExpression(node))
            return (
                this.model.unresolvedShape(this.typeAt(node), node) ??
                this.structuralShape(node.expression)
            );
        if (ts.isElementAccessExpression(node)) {
            const owner = this.stripOptional(this.shapeAt(node.expression));
            if (owner.kind === "typed") return { kind: "number" };
            if (owner.kind === "array") return owner.element;
            return undefined;
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
            const left = this.structuralShape(node.left);
            return left && this.isAbsentLiteral(node.right)
                ? optionalOf(this.stripOptional(left))
                : left;
        }
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(this.checker, node);
            const local = symbol ? this.locals.get(symbol) : undefined;
            if (local) return local.storage;
            const declaration =
                symbol?.valueDeclaration ?? symbol?.declarations?.[0];
            if (declaration && ts.isVariableDeclaration(declaration)) {
                // A local not yet declared: its annotation or initializer decides.
                if (!ts.isSourceFile(declaration.parent.parent.parent))
                    return this.storageOf(declaration);
                return this.model.variable(declaration).shape;
            }
            if (declaration && ts.isParameter(declaration))
                return this.model.unresolvedShape(
                    this.typeAt(declaration.name),
                    declaration,
                );
            // A module function as a value: its declared signature.
            if (
                declaration &&
                ts.isFunctionDeclaration(declaration) &&
                ts.isSourceFile(declaration.parent)
            )
                return this.model.functionShape(declaration);
            return undefined;
        }
        // A function value's call: its declared result.
        if (ts.isCallExpression(node)) {
            const callee = this.skipParentheses(node.expression);
            const declaration =
                ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
                    ? this.model.declarationOf(
                          ts.isPropertyAccessExpression(callee)
                              ? callee.name
                              : callee,
                      )
                    : undefined;
            if (
                declaration &&
                ts.isFunctionDeclaration(declaration) &&
                ts.isSourceFile(declaration.parent)
            )
                return this.model.returnShape(declaration);
            if (!ts.isPropertyAccessExpression(callee)) {
                const shape = this.stripOptional(this.shapeAt(callee));
                if (shape.kind === "function") return shape.result;
            }
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
            return this.shapeAt(node.right);
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.stripOptional(this.shapeAt(node.expression));
            if (owner.kind === "record")
                return this.model.member(owner.name, node.name.text, node)
                    .shape;
            return undefined;
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionEqualsToken
        )
            return this.stripOptional(this.place(node.left).storage);
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression)
        ) {
            const receiver = this.stripOptional(
                this.shapeAt(node.expression.expression),
            );
            const name = node.expression.name.text;
            if (receiver.kind === "record") {
                const member = this.model.member(
                    receiver.name,
                    name,
                    node.expression,
                );
                if (member.shape.kind === "function")
                    return member.shape.result;
            }
            if (
                (receiver.kind === "map" || receiver.kind === "weakmap") &&
                name === "get"
            )
                return optionalOf(receiver.value);
        }
        return undefined;
    }

    private cpp(shape: RecordShape): string {
        return this.model.cppType(shape);
    }

    private same(a: RecordShape, b: RecordShape): boolean {
        return this.cpp(a) === this.cpp(b);
    }

    // ── Conversions ─────────────────────────────────────────────────────

    /** A value of shape `from` as shape `to`. */
    private coerce(
        value: string,
        from: RecordShape,
        to: RecordShape,
        site: ts.Node,
    ): string {
        if (this.same(from, to)) return value;
        if (to.kind === "optional") {
            if (from.kind === "optional")
                return this.coerce(value, from.value, to.value, site) === value
                    ? value
                    : this.refuse(site, "Pinned optional conversion.");
            const inner = this.coerce(value, from, to.value, site);
            // A handle is its own optional.
            return nullableByRepresentation(to.value, this.model)
                ? inner
                : `${this.cpp(to)}(${inner})`;
        }
        if (from.kind === "optional") {
            const present = nullableByRepresentation(from.value, this.model)
                ? value
                : `bbl::pinned::present(${value})`;
            return this.coerce(present, from.value, to, site);
        }
        if (from.kind === "variant") {
            const member = from.members.find((candidate) =>
                this.same(candidate, to),
            );
            if (member) return `std::get<${this.cpp(member)}>(${value})`;
        }
        if (to.kind === "variant") {
            const member = to.members.find((candidate) =>
                this.same(candidate, from),
            );
            if (member) return `${this.cpp(to)}(${value})`;
        }
        if (to.kind === "native" || to.kind === "function")
            return `${this.cpp(to)}(${value})`;
        // A record passed where one of its bases is expected is that base.
        if (
            to.kind === "record" &&
            from.kind === "record" &&
            this.derives(from.name, to.name)
        )
            return `${this.cpp(to)}(${value})`;
        // A shared record passed as `object` keeps its identity.
        if (
            to.kind === "object" &&
            from.kind === "record" &&
            this.model.record(from.name).spec.reference
        )
            return `${this.cpp(to)}(${value})`;
        return this.refuse(
            site,
            `Pinned value of native type ${this.cpp(from)} cannot become ${this.cpp(to)}.`,
        );
    }

    /** Whether record `name` inherits `base`. */
    private derives(name: string, base: string): boolean {
        const bases = this.model.record(name).spec.bases ?? [];
        return bases.some(
            (candidate) =>
                this.model.recordKey(candidate) ===
                    this.model.recordKey(base) || this.derives(candidate, base),
        );
    }

    /** `node` lowered into a sink of shape `to`. */
    public convert(node: ts.Expression, to: RecordShape): string {
        const unwrapped = this.skipParentheses(node);
        if (this.isAbsentLiteral(unwrapped))
            return this.model.absent(to, unwrapped);
        if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped))
            return this.closure(
                unwrapped,
                this.stripOptional(to),
                this.closureIndent(),
            );
        if (ts.isObjectLiteralExpression(unwrapped))
            return this.objectLiteral(unwrapped, to);
        if (ts.isArrayLiteralExpression(unwrapped))
            return this.arrayLiteral(unwrapped, to);
        if (ts.isNewExpression(unwrapped)) {
            const constructed = this.construct(unwrapped, to);
            if (constructed !== undefined) return constructed;
        }
        const filled = this.filledArray(unwrapped, to);
        if (filled !== undefined) return filled;
        if (ts.isConditionalExpression(unwrapped))
            return `(${this.truthy(unwrapped.condition)} ? ${this.convert(unwrapped.whenTrue, to)} : ${this.convert(unwrapped.whenFalse, to)})`;
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        )
            return this.nullish(unwrapped, to);
        if (ts.isIdentifier(unwrapped)) {
            const declaration = this.model.declarationOf(unwrapped);
            if (
                declaration &&
                ts.isFunctionDeclaration(declaration) &&
                ts.isSourceFile(declaration.parent)
            )
                return this.coerce(
                    this.functionReference(unwrapped, declaration),
                    this.shapeAt(unwrapped),
                    to,
                    unwrapped,
                );
        }
        return this.coerce(
            this.value(unwrapped),
            this.shapeAt(unwrapped),
            to,
            unwrapped,
        );
    }

    private skipParentheses(node: ts.Expression): ts.Expression {
        let current = node;
        while (ts.isParenthesizedExpression(current))
            current = current.expression;
        return current;
    }

    private isAbsentLiteral(node: ts.Expression): boolean {
        return (
            node.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(node) && node.text === "undefined")
        );
    }

    /** `node`'s value, in the native form of its checked type. */
    public value(node: ts.Expression): string {
        return this.renderExpression(node).text;
    }

    public override renderExpression(expression: ts.Expression): RenderedCpp {
        const substituted = this.substitutions.get(expression);
        if (substituted !== undefined) return cppPrimary(substituted);
        if (ts.isNonNullExpression(expression)) {
            const inner = this.value(expression.expression);
            return cppPrimary(
                this.coerce(
                    inner,
                    this.shapeAt(expression.expression),
                    this.shapeAt(expression),
                    expression,
                ),
            );
        }
        if (
            ts.isAsExpression(expression) ||
            ts.isTypeAssertionExpression(expression) ||
            ts.isSatisfiesExpression(expression)
        ) {
            let inner: ts.Expression = expression;
            while (
                ts.isAsExpression(inner) ||
                ts.isTypeAssertionExpression(inner) ||
                ts.isSatisfiesExpression(inner) ||
                ts.isParenthesizedExpression(inner)
            )
                inner = inner.expression;
            if (ts.isObjectLiteralExpression(inner))
                return cppPrimary(
                    this.objectLiteral(inner, this.shapeAt(expression)),
                );
            return this.renderExpression(inner);
        }
        if (ts.isParenthesizedExpression(expression)) {
            const typed = this.typed(expression.expression);
            if (typed !== undefined) return cppPrimary(`(${typed})`);
        }
        return super.renderExpression(expression);
    }

    protected override expressionDomain(
        node: ts.Expression,
    ): string | RenderedCpp | undefined {
        return this.typed(node) ?? super.expressionDomain(node);
    }

    /** Everything that is not JavaScript arithmetic over numbers. */
    private typed(node: ts.Expression): string | undefined {
        const substituted = this.substitutions.get(node);
        if (substituted !== undefined) return substituted;
        if (ts.isIdentifier(node)) return this.identifier(node);
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            const self = this.frames[0]!.self;
            if (!self || this.frames.length > 1)
                return this.refuse(
                    node,
                    "Pinned `this` outside a class member.",
                );
            return self;
        }
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
            return this.closure(node, this.shapeAt(node), this.closureIndent());
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)
        )
            return stringLiteral(node.text);
        if (ts.isTemplateExpression(node)) return this.template(node);
        if (this.isAbsentLiteral(node))
            return this.model.absent(this.shapeAt(node), node);
        if (ts.isPropertyAccessExpression(node)) return this.propertyRead(node);
        if (ts.isElementAccessExpression(node)) return this.elementRead(node);
        if (ts.isCallExpression(node)) return this.callValue(node);
        if (ts.isNewExpression(node)) {
            const constructed = this.construct(node, this.shapeAt(node));
            if (constructed !== undefined) return constructed;
            return this.refuse(node, "Unsupported pinned construction.");
        }
        if (ts.isObjectLiteralExpression(node))
            return this.objectLiteral(node, this.shapeAt(node));
        if (ts.isArrayLiteralExpression(node))
            return this.arrayLiteral(node, this.shapeAt(node));
        if (ts.isConditionalExpression(node))
            return this.convert(node, this.shapeAt(node));
        if (ts.isPrefixUnaryExpression(node)) {
            if (node.operator === ts.SyntaxKind.ExclamationToken)
                return `!${this.truthy(node.operand)}`;
            if (
                node.operator === ts.SyntaxKind.PlusPlusToken ||
                node.operator === ts.SyntaxKind.MinusMinusToken
            )
                return `(${node.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--"}${this.numericPlace(node.operand)})`;
            return undefined;
        }
        if (ts.isPostfixUnaryExpression(node))
            return `(${this.numericPlace(node.operand)}${node.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--"})`;
        if (ts.isTypeOfExpression(node))
            return this.refuse(node, "Pinned typeof outside a comparison.");
        if (ts.isBinaryExpression(node)) return this.binaryValue(node);
        return undefined;
    }

    private identifier(node: ts.Identifier): string | undefined {
        if (node.text === "undefined") return undefined;
        // `{ data }` names the property; its value is the local `data`.
        const symbol = declaredSymbol(this.checker, node);
        const local = symbol ? this.locals.get(symbol) : undefined;
        if (local)
            return this.narrowed(this.localCpp(local), local.storage, node);
        const declaration = this.model.declarationOf(node);
        if (!declaration) return undefined;
        // The ES library's numeric globals.
        if (declaration.getSourceFile().isDeclarationFile) {
            if (node.text === "NaN")
                return "std::numeric_limits<double>::quiet_NaN()";
            if (node.text === "Infinity")
                return "std::numeric_limits<double>::infinity()";
        }
        const platform = this.moduleValue(declaration);
        if (platform) return platform.cpp;
        if (ts.isFunctionDeclaration(declaration))
            return this.functionReference(node, declaration);
        if (
            ts.isVariableDeclaration(declaration) &&
            ts.isSourceFile(declaration.parent.parent.parent) &&
            !declaration.getSourceFile().isDeclarationFile
        ) {
            if (declaration.parent.flags & ts.NodeFlags.Const) {
                // A constant bound to an object the pin constructs once
                // (a scratch matrix) is one object for the realm.
                if (
                    declaration.initializer &&
                    ts.isNewExpression(
                        this.skipParentheses(declaration.initializer),
                    )
                ) {
                    const variable = this.model.variable(declaration, (shape) =>
                        this.convert(declaration.initializer!, shape),
                    );
                    return this.narrowed(
                        this.model.qualified(variable),
                        variable.shape,
                        node,
                    );
                }
                // A module constant is the pin's own value, lowered where
                // it is read; a number keeps the numeric lowerer's fold.
                if (declaration.getSourceFile() === this.source) {
                    if (this.shapeAt(node).kind === "number") return undefined;
                    return this.convert(
                        declaration.initializer!,
                        this.shapeAt(node),
                    );
                }
                return this.convert(
                    declaration.initializer!,
                    this.shapeAt(node),
                );
            }
            const variable = this.model.variable(declaration);
            return this.narrowed(
                this.model.qualified(variable),
                variable.shape,
                node,
            );
        }
        const omitted = this.omittedReason(node);
        if (omitted)
            return this.refuse(
                node,
                `Pinned local '${node.text}' is omitted: ${omitted}`,
            );
        return undefined;
    }

    /** The C++ spelling of a pinned local or parameter an adapter names. */
    private localNamed(name: string, site: ts.Node): string {
        const found = [...this.locals].filter(
            ([symbol]) => symbol.name === name,
        );
        if (found.length !== 1)
            return this.refuse(
                site,
                `Pinned adapter needs the local '${name}'.`,
            );
        return this.localCpp(found[0]![1]);
    }

    /** A module variable the platform owns (`schema.moduleValues`). */
    private moduleValue(declaration: ts.Declaration): ModuleValue | undefined {
        const key = this.model.keyOf(declaration);
        return key !== undefined && ts.isVariableDeclaration(declaration)
            ? this.model.schema.moduleValues?.get(key)
            : undefined;
    }

    private omittedReason(node: ts.Identifier): string | undefined {
        return this.model.schema.omittedLocals?.get(
            `${this.entry.module}#${this.entry.name}#${node.text}`,
        );
    }

    private functionReference(
        node: ts.Identifier,
        declaration: ts.FunctionDeclaration,
    ): string {
        const key = this.model.keyOf(declaration);
        if (key && this.model.schema.adapters.has(key))
            return this.refuse(
                node,
                `Pinned platform function '${key}' is referenced as a value.`,
            );
        return this.model.qualified(this.model.lowered(declaration));
    }

    /** A stored value read where the checker narrowed its type. */
    private narrowed(
        cpp: string,
        storage: RecordShape,
        node: ts.Expression,
    ): string {
        const at = this.shapeAt(node);
        if (this.same(storage, at)) return cpp;
        if (at.kind === "array" && this.hasNever(at))
            return this.coerce(cpp, storage, this.stripOptional(storage), node);
        return this.coerce(cpp, storage, at, node);
    }

    private hasNever(shape: RecordShape): boolean {
        return shape.kind === "array" && shape.element.kind === "void";
    }

    private stripOptional(shape: RecordShape): RecordShape {
        return shape.kind === "optional" ? shape.value : shape;
    }

    private template(node: ts.TemplateExpression): string {
        const parts: string[] = [];
        if (node.head.text) parts.push(stringLiteral(node.head.text));
        for (const span of node.templateSpans) {
            const shape = this.shapeAt(span.expression);
            const value = this.value(span.expression);
            parts.push(
                shape.kind === "number"
                    ? `bbl::js::NumberPart(${value})`
                    : shape.kind === "string"
                      ? value
                      : this.refuse(span.expression, "Pinned template part."),
            );
            if (span.literal.text) parts.push(stringLiteral(span.literal.text));
        }
        return `bbl::js::concat(${parts.map((part) => (part.startsWith('"') ? `std::string_view(${part})` : part)).join(", ")})`;
    }

    // ── Truthiness and comparisons ──────────────────────────────────────

    /** A statement's condition, without the grouping its operator carries. */
    private statementCondition(node: ts.Expression): string {
        return cppCondition(this.truthy(node));
    }

    /** JavaScript's truthiness of `node`, as a C++ condition. */
    public truthy(node: ts.Expression): string {
        const unwrapped = this.skipParentheses(node);
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator === ts.SyntaxKind.ExclamationToken
        )
            return `!${this.truthy(unwrapped.operand)}`;
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken ||
                unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        )
            return `(${this.truthy(unwrapped.left)} ${unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ? "||" : "&&"} ${this.truthy(unwrapped.right)})`;
        const shape = this.shapeAt(unwrapped);
        const value = this.value(unwrapped);
        return shape.kind === "boolean"
            ? value
            : `bbl::pinned::truthy(${value})`;
    }

    private binaryValue(node: ts.BinaryExpression): string | undefined {
        const kind = node.operatorToken.kind;
        // `a = b` as a value (`m[0] = m[5] = 1`): the stored value, once.
        if (kind === ts.SyntaxKind.EqualsToken) {
            const place = this.place(node.left);
            const type = this.cpp(place.storage);
            const assigned = this.temporary("assigned");
            return `[&]() -> ${type} { ${type} ${assigned} = ${this.convert(node.right, place.storage)}; ${place.store(assigned)}; return ${assigned}; }()`;
        }
        if (kind === ts.SyntaxKind.QuestionQuestionToken)
            return this.nullish(node, this.shapeAt(node));
        if (
            kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            kind === ts.SyntaxKind.BarBarToken
        ) {
            if (this.shapeAt(node).kind !== "boolean")
                return this.refuse(
                    node,
                    "Pinned value-selecting logical operator.",
                );
            return this.truthy(node);
        }
        if (
            kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            kind === ts.SyntaxKind.EqualsEqualsToken ||
            kind === ts.SyntaxKind.ExclamationEqualsToken
        )
            return this.equality(node);
        if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
            return this.nullishAssign(node);
        if (
            kind === ts.SyntaxKind.PlusToken &&
            this.shapeAt(node).kind === "string"
        ) {
            const part = (operand: ts.Expression): string => {
                const value = this.value(operand);
                if (this.stripOptional(this.shapeAt(operand)).kind === "number")
                    return `bbl::js::NumberPart(${value})`;
                return ts.isStringLiteral(this.skipParentheses(operand))
                    ? `std::string_view(${value})`
                    : value;
            };
            return `bbl::js::concat(${part(node.left)}, ${part(node.right)})`;
        }
        return undefined;
    }

    private equality(node: ts.BinaryExpression): string | undefined {
        const negated =
            node.operatorToken.kind ===
                ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
        const left = this.skipParentheses(node.left);
        const right = this.skipParentheses(node.right);
        const typeofTest = ts.isTypeOfExpression(left)
            ? { operand: left.expression, expected: right }
            : ts.isTypeOfExpression(right)
              ? { operand: right.expression, expected: left }
              : undefined;
        if (typeofTest) {
            if (!ts.isStringLiteral(typeofTest.expected))
                return this.refuse(
                    node,
                    "Pinned typeof against a non-literal.",
                );
            const test = this.typeofTest(
                typeofTest.operand,
                typeofTest.expected.text,
            );
            return negated ? `!(${test})` : test;
        }
        const absentSide = this.isAbsentLiteral(right)
            ? left
            : this.isAbsentLiteral(left)
              ? right
              : undefined;
        if (absentSide) {
            // `null` and `undefined` are one absence in this model; the
            // pin's strict comparison against one of them is the same test.
            const shape = this.shapeAt(absentSide);
            const test =
                shape.kind === "optional" ||
                nullableByRepresentation(shape, this.model)
                    ? `!bbl::pinned::truthy_object(${this.value(absentSide)})`
                    : "false";
            return negated ? `!(${test})` : test;
        }
        const leftShape = this.shapeAt(left);
        const rightShape = this.shapeAt(right);
        if (leftShape.kind === "number" && rightShape.kind === "number")
            return undefined;
        const comparison = `(${this.value(left)} == ${this.value(right)})`;
        return negated ? `!${comparison}` : comparison;
    }

    private typeofTest(operand: ts.Expression, expected: string): string {
        const shape = this.shapeAt(operand);
        const name = (candidate: RecordShape): string =>
            candidate.kind === "number"
                ? "number"
                : candidate.kind === "boolean"
                  ? "boolean"
                  : candidate.kind === "string"
                    ? "string"
                    : candidate.kind === "function"
                      ? "function"
                      : "object";
        if (shape.kind === "variant") {
            const members = shape.members.filter(
                (member) => name(member) === expected,
            );
            return members.length === 0
                ? "false"
                : `(${members.map((member) => `std::holds_alternative<${this.cpp(member)}>(${this.value(operand)})`).join(" || ")})`;
        }
        return name(shape) === expected ? "true" : "false";
    }

    /** `left ?? right` as a value of shape `to`. */
    private nullish(node: ts.BinaryExpression, to: RecordShape): string {
        const leftShape = this.shapeAt(node.left);
        // A left side that is never absent is the whole value.
        if (
            leftShape.kind !== "optional" &&
            !nullableByRepresentation(leftShape, this.model)
        )
            return this.convert(node.left, to);
        const left = this.optionalValue(node.left);
        const result = this.cpp(to);
        return `bbl::pinned::nullish<${result}>(${left}, [&]() -> ${result} { return ${this.convert(node.right, to)}; })`;
    }

    /** The left side of a `??`, as an optional or nullable native value. */
    private optionalValue(node: ts.Expression): string {
        return this.value(node);
    }

    private nullishAssign(node: ts.BinaryExpression): string {
        const place = this.place(node.left);
        if (place.cpp === undefined)
            return this.refuse(node, "Pinned `??=` over a computed place.");
        const stored = this.stripOptional(place.storage);
        return `bbl::pinned::nullish_assign(${place.cpp}, [&]() -> ${this.cpp(stored)} { return ${this.convert(node.right, stored)}; })`;
    }

    // ── Reads ───────────────────────────────────────────────────────────

    /** The record a member is read from, through a present optional. */
    private ownerShape(owner: ts.Expression): RecordShape {
        return this.stripOptional(this.shapeAt(owner));
    }

    private propertyRead(
        node: ts.PropertyAccessExpression,
        chained = false,
    ): string {
        if (!chained && ts.isOptionalChain(node) && !this.inChain(node))
            return this.optionalChain(node);
        const name = node.name.text;
        const owner = node.expression;
        const constant = this.constant(node);
        if (constant !== undefined) return doubleLiteral(constant);
        if (ts.isIdentifier(owner) && owner.text === "Number") {
            if (name === "POSITIVE_INFINITY")
                return "std::numeric_limits<double>::infinity()";
            if (name === "NEGATIVE_INFINITY")
                return "(-std::numeric_limits<double>::infinity())";
        }
        const shape = this.ownerShape(owner);
        const value = (): string => this.presentValue(owner);
        switch (shape.kind) {
            case "record": {
                const member = this.model.member(shape.name, name, node);
                if (member.storage !== "field" && !member.get)
                    return this.refuse(
                        node,
                        `Pinned member '${name}' has no getter.`,
                    );
                return this.narrowed(
                    member.get ? member.get(value()) : member.access(value()),
                    member.shape,
                    node,
                );
            }
            case "array":
            case "typed":
            case "set":
            case "map":
                if (name === "length" || name === "size")
                    return `static_cast<double>(${value()}.size())`;
                if (shape.kind === "typed") {
                    if (name === "byteLength")
                        return `static_cast<double>(${value()}.byte_length())`;
                    if (name === "byteOffset")
                        return `static_cast<double>(${value()}.byte_offset())`;
                    if (name === "buffer") return `${value()}.buffer()`;
                }
                break;
            case "tuple":
                if (name === "length") return `${shape.length}.0`;
                break;
            case "buffer":
                if (name === "byteLength")
                    return `static_cast<double>(${value()}.byte_length())`;
                break;
            default:
                break;
        }
        return this.refuse(
            node,
            `Pinned member '${name}' has no native reading.`,
        );
    }

    /**
     * A platform constant (`GPUBufferUsage.VERTEX`, or `BU.VERTEX` over
     * the same global), by the global declaration its member belongs to.
     */
    private constant(node: ts.PropertyAccessExpression): number | undefined {
        const constants = this.model.schema.constants;
        if (!constants) return undefined;
        const declaration = this.model.declarationOf(node.name);
        if (!declaration || !ts.isPropertySignature(declaration))
            return undefined;
        let holder: ts.Node = declaration.parent;
        while (holder && !ts.isVariableDeclaration(holder))
            holder = holder.parent;
        if (!holder || !ts.isIdentifier(holder.name)) return undefined;
        return constants.get(`${holder.name.text}.${node.name.text}`);
    }

    /** An owner's value with any optional it carries proven present. */
    private presentValue(owner: ts.Expression): string {
        const substituted = this.substitutions.get(owner);
        if (substituted !== undefined) return substituted;
        const shape = this.shapeAt(owner);
        const value = this.value(owner);
        return shape.kind === "optional" &&
            !nullableByRepresentation(shape.value, this.model)
            ? `bbl::pinned::present(${value})`
            : value;
    }

    private elementRead(node: ts.ElementAccessExpression): string {
        if (ts.isOptionalChain(node) && !this.inChain(node))
            return this.optionalChain(node);
        const shape = this.ownerShape(node.expression);
        const owner = this.presentValue(node.expression);
        const index = this.value(node.argumentExpression);
        switch (shape.kind) {
            case "array": {
                const element = shape.element;
                if (element.kind === "number")
                    return `bbl::pinned::number_at(${owner}, ${index})`;
                // A reference reads null past the end, as `undefined` is
                // null in this model; a value element reads its default.
                return this.narrowed(
                    `bbl::js::array_at_or_default(${owner}, ${index})`,
                    element,
                    node,
                );
            }
            case "typed":
                return `bbl::pinned::typed_get(${owner}, ${index})`;
            case "tuple":
                return `bbl::pinned::tuple_at(${owner}, ${index})`;
            default:
                return this.refuse(node, "Pinned element read of a non-array.");
        }
    }

    // ── Optional chains ─────────────────────────────────────────────────

    /** Whether a chain node is inside a larger chain (lowered from its root). */
    private inChain(node: ts.Node): boolean {
        const parent = node.parent;
        return (
            (ts.isPropertyAccessExpression(parent) ||
                ts.isElementAccessExpression(parent) ||
                ts.isCallExpression(parent)) &&
            parent.expression === node &&
            ts.isOptionalChain(parent)
        );
    }

    /** `a?.b.c(...)`: `a` once, tested, then the chain over it. */
    private optionalChain(node: ts.Expression): string {
        let head: ts.Expression | undefined;
        let current: ts.Expression = node;
        while (
            ts.isPropertyAccessExpression(current) ||
            ts.isElementAccessExpression(current) ||
            ts.isCallExpression(current)
        ) {
            // The outermost `?.`: a chain in its head is lowered as its own chain.
            if (current.questionDotToken) {
                head = current.expression;
                break;
            }
            current = current.expression;
        }
        if (!head)
            return this.refuse(node, "Pinned optional chain has no `?.`.");
        if (!this.pure(head))
            return this.refuse(
                head,
                "Pinned optional chain over an effectful head.",
            );
        const headShape = this.shapeAt(head);
        const headValue = ts.isOptionalChain(head)
            ? this.optionalChain(head)
            : this.value(head);
        const present =
            headShape.kind === "optional" &&
            !nullableByRepresentation(headShape.value, this.model)
                ? `bbl::pinned::present(${headValue})`
                : headValue;
        const result = this.shapeAt(node);
        this.substitutions.set(head, present);
        let inner: string;
        try {
            inner = this.chainRest(node);
        } finally {
            this.substitutions.delete(head);
        }
        const innerShape = this.chainShape(node);
        return `(bbl::pinned::truthy_object(${headValue}) ? ${this.coerce(inner, innerShape, result, node)} : ${this.model.absent(result, node)})`;
    }

    /** The chain's own reading once its head is present. */
    private chainRest(node: ts.Expression): string {
        if (ts.isPropertyAccessExpression(node)) {
            const shape = this.ownerShape(node.expression);
            if (shape.kind === "record") {
                const member = this.model.member(
                    shape.name,
                    node.name.text,
                    node,
                );
                const owner = this.chainOwner(node.expression);
                return member.get ? member.get(owner) : member.access(owner);
            }
            return this.propertyRead(node, true);
        }
        if (ts.isCallExpression(node)) return this.callValue(node, true);
        return this.refuse(node, "Pinned optional chain form.");
    }

    private chainOwner(node: ts.Expression): string {
        const substituted = this.substitutions.get(node);
        if (substituted !== undefined) return substituted;
        return this.chainRest(node);
    }

    /** A chain's value shape before its `undefined` arm joins it. */
    private chainShape(node: ts.Expression): RecordShape {
        if (ts.isPropertyAccessExpression(node)) {
            const shape = this.ownerShape(node.expression);
            if (shape.kind === "record")
                return this.model.member(shape.name, node.name.text, node)
                    .shape;
        }
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (ts.isPropertyAccessExpression(callee)) {
                const owner = this.ownerShape(callee.expression);
                if (owner.kind === "record") {
                    const member = this.model.member(
                        owner.name,
                        callee.name.text,
                        callee,
                    );
                    if (member.shape.kind === "function")
                        return member.shape.result;
                }
                if (owner.kind === "map" && callee.name.text === "get")
                    return optionalOf(owner.value);
                if (owner.kind === "weakmap" && callee.name.text === "get")
                    return optionalOf(owner.value);
            }
        }
        return this.stripOptional(this.shapeAt(node));
    }

    /** Whether evaluating `node` twice is the same as once. */
    private pure(node: ts.Expression): boolean {
        const unwrapped = this.skipParentheses(node);
        if (ts.isIdentifier(unwrapped)) return true;
        if (ts.isPropertyAccessExpression(unwrapped))
            return this.pure(unwrapped.expression);
        if (ts.isElementAccessExpression(unwrapped))
            return (
                this.pure(unwrapped.expression) &&
                (ts.isNumericLiteral(unwrapped.argumentExpression) ||
                    this.pure(unwrapped.argumentExpression))
            );
        return false;
    }

    // ── Calls ───────────────────────────────────────────────────────────

    private callValue(node: ts.CallExpression, inChain = false): string {
        if (!inChain && ts.isOptionalChain(node) && !this.inChain(node))
            return this.optionalChain(node);
        const callee = this.skipParentheses(node.expression);
        const declaration =
            ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
                ? this.model.declarationOf(
                      ts.isPropertyAccessExpression(callee)
                          ? callee.name
                          : callee,
                  )
                : undefined;
        const adapter = this.adapterOf(node);
        if (adapter) {
            const spelled = adapter.cpp(
                (index) => this.adapterArgument(node, index),
                node,
                (name) => this.localNamed(name, node),
            );
            if (spelled === null)
                return this.refuse(
                    node,
                    "Pinned platform statement used as a value.",
                );
            return spelled;
        }
        if (ts.isPropertyAccessExpression(callee)) {
            const method = this.method(node, callee);
            if (method !== undefined) return method;
        }
        // A local function (a parameter, a closure, a nested function).
        if (ts.isIdentifier(callee)) {
            const symbol = declaredSymbol(this.checker, callee);
            const local = symbol ? this.locals.get(symbol) : undefined;
            if (local)
                return this.functionValueCall(
                    node,
                    this.localCpp(local),
                    local.storage,
                );
        }
        if (
            declaration &&
            ts.isFunctionDeclaration(declaration) &&
            ts.isSourceFile(declaration.parent) &&
            declaration.body
        ) {
            const entry = this.model.lowered(
                declaration,
                this.specialization(node, declaration),
            );
            return `${this.model.qualified(entry)}(${this.arguments(node, entry)})`;
        }
        // A computed function value (`(_allocate ?? _defaultAllocate)()`).
        if (!ts.isPropertyAccessExpression(callee))
            return this.functionValueCall(
                node,
                this.value(callee),
                this.shapeAt(callee),
            );
        return this.refuse(
            node,
            `Pinned call '${callee.getText(this.source)}' has no native lowering.`,
        );
    }

    /** A call of a function value: its arguments as its parameters. */
    private functionValueCall(
        node: ts.CallExpression,
        callee: string,
        storage: RecordShape,
    ): string {
        const shape = this.stripOptional(storage);
        if (shape.kind !== "function")
            return this.refuse(node, "Pinned call of a non-function value.");
        if (node.arguments.length > shape.parameters.length)
            return this.refuse(node, "Pinned call passes extra arguments.");
        const args = shape.parameters.map((parameter, index) => {
            const argument = node.arguments[index];
            return argument
                ? this.convert(argument, parameter)
                : this.model.absent(parameter, node);
        });
        return `${callee}(${args.join(", ")})`;
    }

    /**
     * The shapes a call's arguments give the parameters a type-only
     * module erased (a structural `Vec3` that receives an `ObservableVec3`):
     * the callee is lowered once per distinct signature.
     */
    private specialization(
        node: ts.CallExpression,
        declaration: ts.FunctionDeclaration,
    ): (RecordShape | undefined)[] {
        return declaration.parameters.map((parameter, index) => {
            const type = this.checker.getTypeAtLocation(parameter.name);
            if (
                !this.containsAny(type) ||
                this.model.unresolvedShape(type, parameter) !== undefined
            )
                return undefined;
            const argument = node.arguments[index];
            if (!argument)
                return this.refuse(
                    node,
                    "A pinned erased parameter needs an argument to take its shape from.",
                );
            return this.shapeAt(argument);
        });
    }

    /** Arguments converted to a lowered function's parameter shapes. */
    private arguments(node: ts.CallExpression, entry: LoweredFunction): string {
        const parameters = this.model.parametersOf(entry);
        if (node.arguments.length > parameters.length)
            return this.refuse(node, "Pinned call passes extra arguments.");
        return node.arguments
            .map((argument, index) =>
                this.convert(argument, parameters[index]!.shape),
            )
            .join(", ");
    }

    /** A method of a native container, a record's function member or a platform value. */
    private method(
        node: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): string | undefined {
        const name = callee.name.text;
        const receiverNode = callee.expression;
        if (ts.isIdentifier(receiverNode)) {
            if (
                receiverNode.text === "Math" ||
                receiverNode.text === "Number"
            ) {
                const lowered = super.expressionDomain(node);
                if (lowered === undefined)
                    return this.refuse(
                        node,
                        `Pinned ${receiverNode.text}.${name}.`,
                    );
                return typeof lowered === "string" ? lowered : lowered.text;
            }
            if (receiverNode.text === "Object" && name === "assign")
                return this.objectAssign(node);
            if (receiverNode.text === "console")
                return `bbl::pinned::console_line(${node.arguments.map((argument) => this.value(argument)).join(", ")})`;
        }
        const shape = this.ownerShape(receiverNode);
        const receiver = (): string =>
            this.substitutions.get(receiverNode) ??
            this.presentValue(receiverNode);
        const args = (shapes?: readonly RecordShape[]): string[] =>
            node.arguments.map((argument, index) =>
                shapes?.[index]
                    ? this.convert(argument, shapes[index])
                    : this.value(argument),
            );
        switch (shape.kind) {
            case "array": {
                const element = shape.element;
                switch (name) {
                    case "push": {
                        const values = args(node.arguments.map(() => element));
                        const place = receiver();
                        return values.length === 1
                            ? `${place}.push_back(${values[0]})`
                            : `(${values.map((value) => `${place}.push_back(${value})`).join(", ")})`;
                    }
                    case "pop":
                        return `bbl::pinned::array_pop(${receiver()})`;
                    case "indexOf":
                        return `bbl::js::array_index_of(${receiver()}, ${this.convert(node.arguments[0]!, element)})`;
                    case "slice":
                        return `bbl::js::array_slice(${receiver()}, ${node.arguments[0] ? this.value(node.arguments[0]) : "0.0"}, ${node.arguments[1] ? this.value(node.arguments[1]) : "std::numeric_limits<double>::infinity()"})`;
                    case "splice": {
                        const [start, count, ...items] = node.arguments;
                        if (!start || !count)
                            return this.refuse(
                                node,
                                "Pinned splice needs a start and a count.",
                            );
                        return `bbl::js::array_splice(${receiver()}, ${this.value(start)}, ${this.value(count)}, {${items.map((item) => this.convert(item, element)).join(", ")}})`;
                    }
                    case "sort": {
                        const comparator = node.arguments[0];
                        if (!comparator || node.arguments.length !== 1)
                            return this.refuse(
                                node,
                                "Pinned sort needs a comparator.",
                            );
                        const compare = this.convert(comparator, {
                            kind: "function",
                            parameters: [element, element],
                            result: { kind: "number" },
                        });
                        return `bbl::pinned::array_sort(${receiver()}, ${compare})`;
                    }
                    default:
                        break;
                }
                break;
            }
            case "typed":
                switch (name) {
                    case "set":
                        return `bbl::pinned::typed_set(${receiver()}, ${this.value(node.arguments[0]!)}${node.arguments[1] ? `, ${this.value(node.arguments[1])}` : ""})`;
                    case "subarray":
                        return `bbl::js::typed_array_subarray(${receiver()}, ${node.arguments[0] ? this.value(node.arguments[0]) : "0.0"}, ${node.arguments[1] ? this.value(node.arguments[1]) : "std::numeric_limits<double>::infinity()"})`;
                    case "copyWithin":
                        return `bbl::js::array_copy_within(${receiver()}, ${args().join(", ")})`;
                    case "fill":
                        if (node.arguments.length !== 1)
                            return this.refuse(
                                node,
                                "Pinned typed fill of a range.",
                            );
                        return `bbl::pinned::typed_fill(${receiver()}, ${this.value(node.arguments[0]!)})`;
                    default:
                        break;
                }
                break;
            case "map":
                switch (name) {
                    case "get":
                        return `bbl::pinned::map_get(${receiver()}, ${this.convert(node.arguments[0]!, shape.key)})`;
                    case "has":
                        return `${receiver()}.has(${this.convert(node.arguments[0]!, shape.key)})`;
                    case "set":
                        return `${receiver()}.set(${this.convert(node.arguments[0]!, shape.key)}, ${this.convert(node.arguments[1]!, shape.value)})`;
                    case "delete":
                        return `${receiver()}.erase(${this.convert(node.arguments[0]!, shape.key)})`;
                    case "clear":
                        return `${receiver()}.clear()`;
                    default:
                        break;
                }
                break;
            case "weakmap":
                switch (name) {
                    case "get":
                        return `bbl::pinned::weak_get(${receiver()}, ${this.value(node.arguments[0]!)})`;
                    case "has":
                        return `bbl::pinned::weak_has(${receiver()}, ${this.value(node.arguments[0]!)})`;
                    case "set":
                        return `bbl::pinned::weak_set(${receiver()}, ${this.value(node.arguments[0]!)}, ${this.convert(node.arguments[1]!, shape.value)})`;
                    case "delete":
                        return `bbl::pinned::weak_delete(${receiver()}, ${this.value(node.arguments[0]!)})`;
                    default:
                        break;
                }
                break;
            case "set":
                switch (name) {
                    case "add":
                        return `${receiver()}.add(${this.convert(node.arguments[0]!, shape.element)})`;
                    case "has":
                        return `${receiver()}.has(${this.convert(node.arguments[0]!, shape.element)})`;
                    default:
                        break;
                }
                break;
            case "record": {
                const member = this.model.member(shape.name, name, callee);
                if (member.shape.kind === "function") {
                    const parameters = member.shape.parameters;
                    if (node.arguments.length > parameters.length)
                        return this.refuse(
                            node,
                            "Pinned method call passes extra arguments.",
                        );
                    return member.call
                        ? member.call(receiver(), args(parameters))
                        : `${member.access(receiver())}(${args(parameters).join(", ")})`;
                }
                break;
            }
            case "weakset":
                switch (name) {
                    case "add":
                        return `bbl::pinned::weak_set(${receiver()}, ${this.value(node.arguments[0]!)}, true)`;
                    case "has":
                        return `bbl::pinned::weak_has(${receiver()}, ${this.value(node.arguments[0]!)})`;
                    case "delete":
                        return `bbl::pinned::weak_delete(${receiver()}, ${this.value(node.arguments[0]!)})`;
                    default:
                        break;
                }
                break;
            default:
                break;
        }
        if (shape.kind === "native" || shape.kind === "record")
            return this.refuse(
                node,
                `Pinned method '${name}' has no native lowering.`,
            );
        return undefined;
    }

    /**
     * `new Array(n).fill(v)`: an untyped allocation the pin fills at once,
     * so its element type is the sink's.
     */
    private filledArray(
        node: ts.Expression,
        to: RecordShape,
    ): string | undefined {
        if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            node.expression.name.text !== "fill" ||
            node.arguments.length !== 1
        )
            return undefined;
        const created = this.skipParentheses(node.expression.expression);
        if (
            !ts.isNewExpression(created) ||
            !ts.isIdentifier(created.expression) ||
            created.expression.text !== "Array" ||
            created.arguments?.length !== 1
        )
            return undefined;
        const shape = this.stripOptional(to);
        if (shape.kind !== "array")
            return this.refuse(
                node,
                "Pinned filled array needs an array sink.",
            );
        return `${this.cpp(shape)}(bbl::pinned::array_length(${this.value(created.arguments[0]!)}), ${this.convert(node.arguments[0]!, shape.element)})`;
    }

    /** `Object.assign(target, { ... })` onto a record. */
    private objectAssign(node: ts.CallExpression): string {
        const [target, source] = node.arguments;
        if (!target || !source || node.arguments.length !== 2)
            return this.refuse(
                node,
                "Pinned Object.assign takes a target and one literal.",
            );
        const literal = this.skipParentheses(source);
        if (!ts.isObjectLiteralExpression(literal))
            return this.refuse(
                source,
                "Pinned Object.assign needs an object literal.",
            );
        const shape = this.ownerShape(target);
        if (
            shape.kind !== "record" ||
            !this.model.record(shape.name).spec.reference
        )
            return this.refuse(
                target,
                "Pinned Object.assign onto a non-reference record.",
            );
        const name = this.temporary("assigned");
        const writes = this.propertyWrites(literal, shape.name, name);
        return `[&] { auto ${name} = ${this.value(target)}; ${writes.filter((write) => write.length > 0).join(" ")} return ${name}; }()`;
    }

    private propertyWrites(
        literal: ts.ObjectLiteralExpression,
        record: string,
        owner: string,
    ): string[] {
        return literal.properties.map((property) => {
            const name =
                property.name &&
                (ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name))
                    ? property.name.text
                    : this.refuse(property, "Pinned record literal member.");
            // A tag the port does not store (`_kind: "text-layer"`), or a
            // function it does not represent; dropping either drops no
            // evaluation.
            const spec = this.model.record(record).spec;
            if (spec.omit?.has(name)) {
                if (
                    !ts.isMethodDeclaration(property) &&
                    !ts.isGetAccessorDeclaration(property) &&
                    !ts.isSetAccessorDeclaration(property) &&
                    !(
                        ts.isPropertyAssignment(property) &&
                        this.inert(property.initializer)
                    )
                )
                    return this.refuse(
                        property,
                        `Pinned omitted member '${name}' is not a literal.`,
                    );
                return "";
            }
            const member = this.model.member(record, name, property);
            const indent = this.closureIndent();
            if (
                ts.isGetAccessorDeclaration(property) ||
                ts.isSetAccessorDeclaration(property)
            ) {
                if (member.storage !== "accessor")
                    return this.refuse(
                        property,
                        `Pinned accessor '${name}' implements a member the port stores.`,
                    );
                const getter = ts.isGetAccessorDeclaration(property);
                const pointer = spec.reference ? "->" : ".";
                return `${owner}${pointer}${getter ? "get" : "set"}_${member.field} = ${this.closure(
                    property,
                    getter
                        ? {
                              kind: "function",
                              parameters: [],
                              result: member.shape,
                          }
                        : {
                              kind: "function",
                              parameters: [member.shape],
                              result: { kind: "void" },
                          },
                    indent,
                )};`;
            }
            if (member.storage === "accessor")
                return this.refuse(
                    property,
                    `Pinned member '${name}' is implemented with accessors elsewhere.`,
                );
            if (ts.isMethodDeclaration(property))
                return `${member.access(owner)} = ${this.closure(property, member.shape, indent)};`;
            const initializer = ts.isShorthandPropertyAssignment(property)
                ? property.name
                : ts.isPropertyAssignment(property)
                  ? property.initializer
                  : this.refuse(property, "Pinned record literal member.");
            return `${member.access(owner)} = ${this.convert(initializer, member.shape)};`;
        });
    }

    /** A literal, or a module constant bound to one: dropping it drops nothing. */
    private inert(node: ts.Expression): boolean {
        const unwrapped = this.skipParentheses(node);
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNumericLiteral(unwrapped) ||
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword
        )
            return true;
        if (!ts.isIdentifier(unwrapped)) return false;
        const declaration = this.model.declarationOf(unwrapped);
        return (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
            declaration.initializer !== undefined &&
            this.inert(
                ts.isAsExpression(declaration.initializer)
                    ? declaration.initializer.expression
                    : declaration.initializer,
            )
        );
    }

    // ── Constructions ───────────────────────────────────────────────────

    private objectLiteral(
        node: ts.ObjectLiteralExpression,
        to: RecordShape,
    ): string {
        const shape = this.stripOptional(to);
        if (shape.kind === "object") {
            if (node.properties.length > 0)
                return this.refuse(
                    node,
                    "Pinned identity object with members.",
                );
            return "std::make_shared<bbl::pinned::PlainObject>()";
        }
        if (shape.kind === "variant") {
            const records = shape.members.filter(
                (member) => member.kind === "record",
            );
            if (records.length !== 1)
                return this.refuse(
                    node,
                    `Pinned object literal as ${this.cpp(to)} names no single record.`,
                );
            return `${this.cpp(shape)}(${this.objectLiteral(node, records[0]!)})`;
        }
        if (shape.kind !== "record")
            return this.refuse(
                node,
                `Pinned object literal as ${this.cpp(to)}.`,
            );
        const spec = this.model.record(shape.name).spec;
        const name = this.temporary("record");
        const writes = this.propertyWrites(node, shape.name, name);
        // A record that can close a cycle joins cycle collection; any
        // other `make_gc_shared` releases by reference counting alone.
        const created = spec.reference
            ? `auto ${name} = bbl::js::make_gc_shared<bbl::${spec.cpp}>();`
            : `bbl::${spec.cpp} ${name}{};`;
        return `[&] { ${created} ${writes.filter((write) => write.length > 0).join(" ")} return ${name}; }()`;
    }

    private arrayLiteral(
        node: ts.ArrayLiteralExpression,
        to: RecordShape,
    ): string {
        const shape = this.stripOptional(to);
        if (shape.kind === "tuple") {
            if (node.elements.length !== shape.length)
                return this.refuse(node, "Pinned tuple literal arity.");
            return `${this.cpp(shape)}{${node.elements.map((element) => this.convert(element, { kind: "number" })).join(", ")}}`;
        }
        if (shape.kind !== "array")
            return this.refuse(
                node,
                `Pinned array literal as ${this.cpp(to)}.`,
            );
        const elements = node.elements.map((element) =>
            this.convert(element, shape.element),
        );
        const value = `${this.cpp(shape)}{${elements.join(", ")}}`;
        return to.kind === "optional" ? `${this.cpp(to)}(${value})` : value;
    }

    /** `new Map()`, `new Float32Array(n)` and their kin, typed by `to`. */
    private construct(
        node: ts.NewExpression,
        to: RecordShape,
    ): string | undefined {
        if (!ts.isIdentifier(node.expression)) return undefined;
        const args = node.arguments ?? [];
        const declaration = this.model.declarationOf(node.expression);
        // A pinned class the schema represents constructs through its
        // lowered constructor.
        if (
            declaration &&
            ts.isClassDeclaration(declaration) &&
            declaration.name &&
            this.model.isRecordName(declaration.name.text)
        ) {
            const constructor =
                declaration.members.find(ts.isConstructorDeclaration) ??
                declaration;
            const entry = this.model.lowered(constructor);
            const parameters = this.model.parametersOf(entry);
            if (args.length > parameters.length)
                return this.refuse(
                    node,
                    "Pinned construction passes extra arguments.",
                );
            return this.coerce(
                `${this.model.qualified(entry)}(${args.map((argument, index) => this.convert(argument, parameters[index]!.shape)).join(", ")})`,
                { kind: "record", name: entry.owner! },
                to,
                node,
            );
        }
        // `new F32(16)`: the pin's short alias of a library constructor.
        const name =
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
            declaration.initializer &&
            ts.isIdentifier(declaration.initializer) &&
            !declaration.getSourceFile().isDeclarationFile
                ? declaration.initializer.text
                : node.expression.text;
        const shape = this.stripOptional(to);
        switch (name) {
            case "WeakSet":
                if (shape.kind !== "weakset" || args.length !== 0)
                    return this.refuse(node, "Pinned new WeakSet.");
                return `${this.cpp(shape)}{}`;
            case "Map":
            case "Set":
            case "WeakMap":
                if (
                    (name === "Map" && shape.kind !== "map") ||
                    (name === "Set" && shape.kind !== "set") ||
                    (name === "WeakMap" && shape.kind !== "weakmap")
                )
                    return this.refuse(
                        node,
                        `Pinned new ${name} as ${this.cpp(to)}.`,
                    );
                if (args.length === 0) return `${this.cpp(shape)}{}`;
                if (name === "Map" && shape.kind === "map") {
                    const entries = this.skipParentheses(args[0]!);
                    if (!ts.isArrayLiteralExpression(entries))
                        return this.refuse(
                            node,
                            "Pinned Map seed must be a literal.",
                        );
                    return `${this.cpp(shape)}{${entries.elements
                        .map((entry) => {
                            if (
                                !ts.isArrayLiteralExpression(entry) ||
                                entry.elements.length !== 2
                            )
                                return this.refuse(
                                    entry,
                                    "Pinned Map seed entry.",
                                );
                            return `{${this.convert(entry.elements[0]!, shape.key)}, ${this.convert(entry.elements[1]!, shape.value)}}`;
                        })
                        .join(", ")}}`;
                }
                return this.refuse(node, `Pinned seeded ${name}.`);
            case "Array":
                if (shape.kind !== "array" || args.length !== 1)
                    return this.refuse(
                        node,
                        "Pinned new Array needs a length.",
                    );
                return `${this.cpp(shape)}(bbl::pinned::array_length(${this.value(args[0]!)}))`;
            case "Float32Array":
            case "Uint32Array":
            case "Uint8Array": {
                if (shape.kind !== "typed" || args.length !== 1)
                    return this.refuse(node, `Pinned new ${name}.`);
                const argument = args[0]!;
                const literal = this.skipParentheses(argument);
                if (ts.isArrayLiteralExpression(literal))
                    return `${this.cpp(shape)}{${literal.elements
                        .map(
                            (element) =>
                                `static_cast<${{ f32: "float", u32: "std::uint32_t", u8: "std::uint8_t" }[shape.element]}>(${this.convert(element, { kind: "number" })})`,
                        )
                        .join(", ")}}`;
                const argumentShape = this.shapeAt(argument);
                if (argumentShape.kind === "buffer")
                    return `${this.cpp(shape)}(${this.value(argument)})`;
                if (argumentShape.kind === "number")
                    return `${this.cpp(shape)}(bbl::pinned::array_length(${this.value(argument)}))`;
                return this.refuse(
                    node,
                    `Pinned new ${name} from a non-length.`,
                );
            }
            default:
                return undefined;
        }
    }

    // ── Places ──────────────────────────────────────────────────────────

    /** Where an assignment stores. */
    private place(target: ts.Expression): Place {
        const node = this.skipParentheses(target);
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(this.checker, node);
            const local = symbol ? this.locals.get(symbol) : undefined;
            if (local) {
                const cpp = this.localCpp(local);
                return {
                    cpp,
                    storage: local.storage,
                    store: (value) => `${cpp} = ${value}`,
                };
            }
            const declaration = this.model.declarationOf(node);
            if (declaration && this.moduleValue(declaration))
                return this.refuse(
                    node,
                    "Pinned write to a module variable the platform owns.",
                );
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                ts.isSourceFile(declaration.parent.parent.parent)
            ) {
                const variable = this.model.variable(declaration);
                const cpp = this.model.qualified(variable);
                return {
                    cpp,
                    storage: variable.shape,
                    store: (value) => `${cpp} = ${value}`,
                };
            }
            return this.refuse(node, "Pinned assignment target.");
        }
        if (ts.isPropertyAccessExpression(node)) {
            const shape = this.ownerShape(node.expression);
            if (shape.kind === "array" && node.name.text === "length")
                return {
                    storage: { kind: "number" },
                    store: (value) =>
                        `bbl::js::array_truncate(${this.presentValue(node.expression)}, ${value})`,
                };
            if (shape.kind !== "record")
                return this.refuse(
                    node,
                    "Pinned member write to a non-record.",
                );
            const member = this.model.member(shape.name, node.name.text, node);
            const owner = this.presentValue(node.expression);
            // A setter stores through its function; no lvalue to update.
            if (member.set) {
                const set = member.set;
                return {
                    storage: member.shape,
                    store: (value) => set(owner, value),
                };
            }
            if (member.storage !== "field")
                return this.refuse(
                    node,
                    `Pinned member '${node.name.text}' has no setter.`,
                );
            const cpp = member.access(owner);
            return {
                cpp,
                storage: member.shape,
                store: (value) => `${cpp} = ${value}`,
            };
        }
        if (ts.isElementAccessExpression(node)) {
            const shape = this.ownerShape(node.expression);
            const owner = this.presentValue(node.expression);
            const index = this.value(node.argumentExpression);
            if (shape.kind === "array")
                return {
                    storage: shape.element,
                    store: (value) =>
                        `bbl::js::array_index_write(${owner}, bbl::pinned::array_length(${index})) = ${value}`,
                };
            if (shape.kind === "typed")
                return {
                    storage: { kind: "number" },
                    store: (value) =>
                        `bbl::js::typed_array_write(${owner}, ${index}, ${value})`,
                };
            return this.refuse(node, "Pinned element write to a non-array.");
        }
        return this.refuse(node, "Pinned assignment target.");
    }

    /** A numeric lvalue an increment or compound assignment updates. */
    private numericPlace(target: ts.Expression): string {
        const place = this.place(target);
        if (place.cpp === undefined || place.storage.kind !== "number")
            return this.refuse(
                target,
                "Pinned numeric update of a computed place.",
            );
        return place.cpp;
    }

    // ── Statements ──────────────────────────────────────────────────────

    public override statement(
        statement: ts.Statement,
        indent: string,
    ): string[] {
        if (ts.isVariableStatement(statement))
            return this.variableStatement(statement, indent);
        if (ts.isExpressionStatement(statement))
            return this.expressionLines(statement, indent);
        if (ts.isIfStatement(statement)) {
            const lines = [
                `${indent}if (${this.statementCondition(statement.expression)}) {`,
                ...this.nested(statement.thenStatement, indent),
            ];
            if (statement.elseStatement)
                lines.push(
                    `${indent}} else {`,
                    ...this.nested(statement.elseStatement, indent),
                );
            lines.push(`${indent}}`);
            return lines;
        }
        if (ts.isForStatement(statement))
            return this.forStatement(statement, indent);
        if (ts.isForOfStatement(statement))
            return this.forOf(statement, indent);
        if (ts.isWhileStatement(statement))
            return [
                `${indent}while (${this.statementCondition(statement.expression)}) {`,
                ...this.nested(statement.statement, indent),
                `${indent}}`,
            ];
        if (ts.isReturnStatement(statement)) {
            if (!statement.expression) return [`${indent}return;`];
            return [
                `${indent}return ${this.convert(statement.expression, this.returns)};`,
            ];
        }
        if (ts.isSwitchStatement(statement))
            return this.switchChain(statement, indent);
        if (ts.isTryStatement(statement))
            return this.tryStatement(statement, indent);
        if (ts.isThrowStatement(statement) && this.catchVariable) {
            const thrown = this.skipParentheses(statement.expression);
            if (
                ts.isIdentifier(thrown) &&
                declaredSymbol(this.checker, thrown) === this.catchVariable
            )
                return [`${indent}throw;`];
        }
        if (ts.isBlock(statement))
            return [
                `${indent}{`,
                ...this.nested(statement, indent),
                `${indent}}`,
            ];
        return super.statement(statement, indent);
    }

    private nested(statement: ts.Statement, indent: string): string[] {
        const inner = `${indent}    `;
        return this.scoped(() =>
            ts.isBlock(statement)
                ? this.statements(statement.statements, inner)
                : this.statement(statement, inner),
        );
    }

    private variableStatement(
        statement: ts.VariableStatement,
        indent: string,
    ): string[] {
        return statement.declarationList.declarations.flatMap((declaration) =>
            this.declaration(declaration, indent),
        );
    }

    private declaration(
        declaration: ts.VariableDeclaration,
        indent: string,
    ): string[] {
        if (ts.isObjectBindingPattern(declaration.name))
            return this.destructured(declaration, declaration.name, indent);
        if (ts.isArrayBindingPattern(declaration.name))
            return this.tupleDestructured(
                declaration,
                declaration.name,
                indent,
            );
        if (!ts.isIdentifier(declaration.name))
            return this.refuse(
                declaration,
                "Pinned destructuring declaration.",
            );
        if (this.omittedReason(declaration.name)) return [];
        const symbol = declaredSymbol(this.checker, declaration.name);
        const captured = symbol ? this.locals.get(symbol) : undefined;
        const storage = captured?.captured
            ? captured.storage
            : this.storageOf(declaration);
        const initializer = declaration.initializer;
        const value = initializer
            ? this.convert(initializer, storage)
            : storage.kind === "number"
              ? "0"
              : `${this.cpp(storage)}{}`;
        // A captured binding already lives in its frame's environment.
        if (captured?.captured)
            return [
                captured.captured.temporal
                    ? `${indent}${this.localSlot(captured)}.initialize(${value});`
                    : `${indent}${this.localCpp(captured)} = ${value};`,
            ];
        const cpp = this.declare(declaration.name, storage);
        return [
            `${indent}${this.mayBeUnread(declaration.name) ? "[[maybe_unused]] " : ""}${this.cpp(storage)} ${cpp} = ${value};`,
        ];
    }

    /** A local's storage: its erased annotation, its initializer's shape, or its type's. */
    private storageOf(declaration: ts.VariableDeclaration): RecordShape {
        const declared = this.checker.getTypeAtLocation(declaration.name);
        return (
            this.model.unresolvedShape(declared, declaration) ??
            (this.containsAny(declared) && declaration.initializer
                ? this.structuralShape(declaration.initializer)
                : undefined) ??
            this.model.shapeOf(declared, declaration)
        );
    }

    /** `const [a, b] = tuple`: the tuple once, then each element. */
    private tupleDestructured(
        declaration: ts.VariableDeclaration,
        pattern: ts.ArrayBindingPattern,
        indent: string,
    ): string[] {
        const initializer = declaration.initializer;
        if (!initializer)
            return this.refuse(
                declaration,
                "Pinned destructuring needs a value.",
            );
        const shape = this.stripOptional(this.shapeAt(initializer));
        if (shape.kind !== "tuple")
            return this.refuse(
                initializer,
                "Pinned array destructuring of a non-tuple.",
            );
        const source = this.temporary("destructured");
        const lines = [
            `${indent}const ${this.cpp(shape)} ${source} = ${this.convert(initializer, shape)};`,
        ];
        for (const [index, element] of pattern.elements.entries()) {
            if (ts.isOmittedExpression(element)) continue;
            if (
                element.dotDotDotToken ||
                element.initializer ||
                !ts.isIdentifier(element.name)
            )
                return this.refuse(element, "Pinned destructuring element.");
            const value = `bbl::pinned::tuple_at(${source}, ${index}.0)`;
            const symbol = declaredSymbol(this.checker, element.name);
            const captured = symbol ? this.locals.get(symbol) : undefined;
            if (captured?.captured) {
                lines.push(`${indent}${this.localCpp(captured)} = ${value};`);
                continue;
            }
            const cpp = this.declare(element.name, { kind: "number" });
            lines.push(
                `${indent}${this.mayBeUnread(element.name) ? "[[maybe_unused]] " : ""}double ${cpp} = ${value};`,
            );
        }
        return lines;
    }

    /** `const { _a: a, b } = value`: the value once, then each named member. */
    private destructured(
        declaration: ts.VariableDeclaration,
        pattern: ts.ObjectBindingPattern,
        indent: string,
    ): string[] {
        const initializer = declaration.initializer;
        if (!initializer)
            return this.refuse(
                declaration,
                "Pinned destructuring needs a value.",
            );
        const shape = this.stripOptional(this.shapeAt(initializer));
        if (shape.kind !== "record")
            return this.refuse(
                initializer,
                "Pinned destructuring of a non-record.",
            );
        const source = this.temporary("destructured");
        const lines = [
            `${indent}${this.cpp(shape)} ${source} = ${this.convert(initializer, shape)};`,
        ];
        for (const element of pattern.elements) {
            const property = element.propertyName ?? element.name;
            if (
                element.dotDotDotToken ||
                element.initializer ||
                !ts.isIdentifier(element.name) ||
                !(ts.isIdentifier(property) || ts.isStringLiteral(property))
            )
                return this.refuse(element, "Pinned destructuring element.");
            const member = this.model.member(
                shape.name,
                property.text,
                element,
            );
            const storage = this.model.declaredShape(
                this.checker.getTypeAtLocation(element.name),
                element,
            );
            const value = this.coerce(
                member.access(source),
                member.shape,
                storage,
                element,
            );
            const cpp = this.declare(element.name, storage);
            lines.push(
                `${indent}${this.mayBeUnread(element.name) ? "[[maybe_unused]] " : ""}${this.cpp(storage)} ${cpp} = ${value};`,
            );
        }
        return lines;
    }

    private expressionLines(
        statement: ts.ExpressionStatement,
        indent: string,
    ): string[] {
        const expression = this.skipParentheses(statement.expression);
        if (
            ts.isCallExpression(expression) &&
            isPinnedErrorCall(this.source, expression)
        )
            return super.statement(statement, indent);
        const effect = this.effect(expression);
        return effect === null ? [] : [`${indent}${effect};`];
    }

    /**
     * An expression evaluated for its effect, spelled without a statement
     * terminator (a statement or a for-loop incrementor); null for an
     * adapted platform call with no native effect.
     */
    private effect(expression: ts.Expression): string | null {
        if (ts.isCallExpression(expression)) {
            const adapter = this.adapterOf(expression);
            if (adapter)
                return adapter.cpp(
                    (index) => this.adapterArgument(expression, index),
                    expression,
                    (name) => this.localNamed(name, expression),
                );
            const value = this.value(expression);
            const type = this.typeAt(expression);
            return type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)
                ? value
                : `static_cast<void>(${value})`;
        }
        if (ts.isBinaryExpression(expression)) {
            const kind = expression.operatorToken.kind;
            if (kind === ts.SyntaxKind.EqualsToken) {
                const place = this.place(expression.left);
                return place.store(
                    this.convert(expression.right, place.storage),
                );
            }
            if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
                return `static_cast<void>(${this.nullishAssign(expression)})`;
            if (
                kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
                kind === ts.SyntaxKind.BarBarEqualsToken
            ) {
                const place = this.place(expression.left);
                if (place.cpp === undefined || place.storage.kind !== "boolean")
                    return this.refuse(
                        expression,
                        "Pinned logical assignment of a non-flag.",
                    );
                return `${place.cpp} = ${place.cpp} ${kind === ts.SyntaxKind.BarBarEqualsToken ? "||" : "&&"} ${this.truthy(expression.right)}`;
            }
            const compound = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.PlusEqualsToken, "+="],
                [ts.SyntaxKind.MinusEqualsToken, "-="],
                [ts.SyntaxKind.AsteriskEqualsToken, "*="],
                [ts.SyntaxKind.SlashEqualsToken, "/="],
            ]).get(kind);
            // `r <<= 1` stores `r << 1` through the shared JavaScript helper.
            const bitwise = PINNED_BITWISE_ASSIGNMENT_OPERATORS.get(kind);
            if (bitwise !== undefined) {
                const place = this.numericPlace(expression.left);
                return `${place} = static_cast<double>(${jsBitwiseCall(bitwise, place, this.value(expression.right))})`;
            }
            if (compound)
                return `${this.numericPlace(expression.left)} ${compound} ${this.value(expression.right)}`;
        }
        if (
            ts.isPrefixUnaryExpression(expression) ||
            ts.isPostfixUnaryExpression(expression)
        ) {
            if (
                expression.operator === ts.SyntaxKind.PlusPlusToken ||
                expression.operator === ts.SyntaxKind.MinusMinusToken
            )
                return `${expression.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--"}${this.numericPlace(expression.operand)}`;
        }
        return this.refuse(
            expression,
            "Unsupported pinned expression statement.",
        );
    }

    private forStatement(statement: ts.ForStatement, indent: string): string[] {
        return this.scoped(() => {
            const initializer = statement.initializer;
            let declared = "";
            if (initializer) {
                if (!ts.isVariableDeclarationList(initializer))
                    return this.refuse(statement, "Pinned for initializer.");
                const parts = initializer.declarations.map((declaration) => {
                    if (
                        !ts.isIdentifier(declaration.name) ||
                        !declaration.initializer
                    )
                        return this.refuse(
                            declaration,
                            "Pinned for initializer.",
                        );
                    const storage = this.model.shapeOf(
                        this.checker.getTypeAtLocation(declaration.name),
                        declaration,
                    );
                    if (storage.kind !== "number")
                        return this.refuse(
                            declaration,
                            "Pinned for loops count numbers.",
                        );
                    const value = this.convert(
                        declaration.initializer,
                        storage,
                    );
                    return `${this.declare(declaration.name, storage)} = ${value}`;
                });
                declared = `double ${parts.join(", ")}`;
            }
            const condition = statement.condition
                ? this.statementCondition(statement.condition)
                : "";
            const incrementor = statement.incrementor
                ? (this.effect(this.skipParentheses(statement.incrementor)) ??
                  this.refuse(
                      statement.incrementor,
                      "Pinned loop incrementor without a native effect.",
                  ))
                : "";
            return [
                `${indent}for (${declared}; ${condition}; ${incrementor}) {`,
                ...this.nested(statement.statement, indent),
                `${indent}}`,
            ];
        });
    }

    private forOf(statement: ts.ForOfStatement, indent: string): string[] {
        const list = statement.initializer;
        if (
            !ts.isVariableDeclarationList(list) ||
            list.declarations.length !== 1
        )
            return this.refuse(statement, "Pinned for-of binding.");
        const binding = list.declarations[0]!.name;
        let iterated = this.skipParentheses(statement.expression);
        let view: "values" | "entries" = "entries";
        if (
            ts.isCallExpression(iterated) &&
            ts.isPropertyAccessExpression(iterated.expression) &&
            iterated.arguments.length === 0 &&
            ["values", "keys", "entries"].includes(
                iterated.expression.name.text,
            )
        ) {
            const kind = iterated.expression.name.text;
            if (kind === "keys")
                return this.refuse(iterated, "Pinned map key iteration.");
            view = kind === "values" ? "values" : "entries";
            iterated = iterated.expression.expression;
        }
        const shape = this.ownerShape(iterated);
        const range = this.temporary("range");
        const lines = [
            `${indent}{`,
            `${indent}    auto ${range} = ${this.presentValue(iterated)};`,
        ];
        const body = (bindings: () => string[]): string[] =>
            this.scoped(() => {
                const bound = bindings();
                const inner = `${indent}        `;
                return [
                    ...bound.map((line) => `${inner}${line}`),
                    ...(ts.isBlock(statement.statement)
                        ? this.statements(statement.statement.statements, inner)
                        : this.statement(statement.statement, inner)),
                ];
            });
        if (shape.kind === "array") {
            if (!ts.isIdentifier(binding))
                return this.refuse(
                    binding,
                    "Pinned array iteration binds one name.",
                );
            const index = this.temporary("index");
            lines.push(
                `${indent}    for (std::size_t ${index} = 0; ${index} < ${range}.size(); ++${index}) {`,
                ...body(() => {
                    const storage = this.model.shapeOf(
                        this.checker.getTypeAtLocation(binding),
                        binding,
                    );
                    const name = this.declare(binding, storage);
                    return [
                        `${this.cpp(storage)} ${name} = ${range}[${index}];`,
                    ];
                }),
                `${indent}    }`,
            );
        } else if (shape.kind === "map" || shape.kind === "set") {
            const entry = this.temporary("entry");
            lines.push(
                `${indent}    for (auto& ${entry} : ${range}) {`,
                ...body(() => {
                    if (shape.kind === "set" || view === "values") {
                        if (!ts.isIdentifier(binding))
                            return this.refuse(
                                binding,
                                "Pinned value iteration binds one name.",
                            );
                        const storage = this.model.shapeOf(
                            this.checker.getTypeAtLocation(binding),
                            binding,
                        );
                        const name = this.declare(binding, storage);
                        return [
                            `${this.cpp(storage)} ${name} = ${entry}${shape.kind === "map" ? ".second" : ""};`,
                        ];
                    }
                    const names = ts.isArrayBindingPattern(binding)
                        ? binding.elements.flatMap((element) =>
                              ts.isBindingElement(element) &&
                              ts.isIdentifier(element.name)
                                  ? [element.name]
                                  : [],
                          )
                        : [];
                    if (
                        !ts.isArrayBindingPattern(binding) ||
                        binding.elements.length !== 2 ||
                        names.length !== 2
                    )
                        return this.refuse(
                            binding,
                            "Pinned map entry binding.",
                        );
                    return names.map((name, index) => {
                        const storage = this.model.shapeOf(
                            this.checker.getTypeAtLocation(name),
                            name,
                        );
                        const cpp = this.declare(name, storage);
                        return `${this.cpp(storage)} ${cpp} = ${entry}.${index === 0 ? "first" : "second"};`;
                    });
                }),
                `${indent}    }`,
            );
        } else
            return this.refuse(
                statement,
                "Pinned iteration of a non-collection.",
            );
        lines.push(`${indent}}`);
        return lines;
    }

    private switchChain(
        statement: ts.SwitchStatement,
        indent: string,
    ): string[] {
        const discriminant = this.temporary("selected");
        const shape = this.shapeAt(statement.expression);
        if (shape.kind !== "string" && shape.kind !== "number")
            return this.refuse(
                statement,
                "Pinned switch over a non-primitive.",
            );
        const lines = [
            `${indent}{`,
            `${indent}    const ${this.cpp(shape)} ${discriminant} = ${this.value(statement.expression)};`,
        ];
        let first = true;
        let defaultClause: ts.DefaultClause | undefined;
        const clauses = statement.caseBlock.clauses;
        for (const [index, clause] of clauses.entries()) {
            if (ts.isDefaultClause(clause)) {
                defaultClause = clause;
                continue;
            }
            const statements = [...clause.statements];
            const last = statements[statements.length - 1];
            if (last && ts.isBreakStatement(last)) statements.pop();
            else if (
                index !== clauses.length - 1 &&
                !(
                    last &&
                    (ts.isReturnStatement(last) ||
                        ts.isThrowStatement(last) ||
                        ts.isBlock(last))
                )
            )
                return this.refuse(
                    clause,
                    "Pinned switch clause falls through.",
                );
            lines.push(
                `${indent}    ${first ? "" : "} else "}if (${discriminant} == ${this.value(clause.expression)}) {`,
                ...this.scoped(() =>
                    this.statements(statements, `${indent}        `),
                ),
            );
            first = false;
        }
        if (defaultClause)
            lines.push(
                `${indent}    ${first ? "{" : "} else {"}`,
                ...this.scoped(() =>
                    this.statements(
                        defaultClause.statements,
                        `${indent}        `,
                    ),
                ),
            );
        if (!first || defaultClause) lines.push(`${indent}    }`);
        lines.push(`${indent}}`);
        return lines;
    }

    private tryStatement(statement: ts.TryStatement, indent: string): string[] {
        if (statement.finallyBlock) return super.statement(statement, indent);
        const clause = statement.catchClause;
        if (!clause) return this.refuse(statement, "Pinned try without catch.");
        const variable = clause.variableDeclaration;
        const previous = this.catchVariable;
        this.catchVariable =
            variable && ts.isIdentifier(variable.name)
                ? declaredSymbol(this.checker, variable.name)
                : undefined;
        try {
            if (variable && ts.isIdentifier(variable.name)) {
                const symbol = this.catchVariable;
                const reads = this.model.context.findNodes(
                    clause.block,
                    (node): node is ts.Identifier =>
                        ts.isIdentifier(node) &&
                        declaredSymbol(this.checker, node) === symbol,
                );
                if (reads.some((read) => !ts.isThrowStatement(read.parent)))
                    return this.refuse(
                        clause,
                        "Pinned catch reads its error beyond rethrowing it.",
                    );
            }
            return [
                `${indent}try {`,
                ...this.scoped(() =>
                    this.statements(
                        statement.tryBlock.statements,
                        `${indent}    `,
                    ),
                ),
                `${indent}} catch (...) {`,
                ...this.scoped(() =>
                    this.statements(clause.block.statements, `${indent}    `),
                ),
                `${indent}}`,
            ];
        } finally {
            this.catchVariable = previous;
        }
    }
}
