import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
/**
 * Lowers pinned modules whose state is plain JavaScript records: objects
 * with identity, arrays, maps, sets, typed arrays and optional values.
 *
 * `PinnedNumericLowerer` owns arithmetic, JavaScript's operators and the
 * statements it already translates; this layer adds the record model on
 * top of it, typed by the TypeScript checker over the recovered pinned
 * sources (`pinned-program.ts`). Every expression's native form is
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
 *  - `T | undefined` is `js::Nullable<T>` for a value and the same null
 *    handle for a reference; a union of distinct shapes is a
 *    `std::variant`. A read the checker narrowed converts at the read.
 *
 * Platform calls the pin makes (a text shaper, a GPU device, the console)
 * are the caller's adapters, each named by the pinned declaration it
 * replaces. Anything else the translator does not recognise fails
 * generation with the pinned source location.
 */
import ts from "typescript";
import { findAnalysisNode } from "../compiler/analysis-walk.js";
import { ClassHierarchy } from "../compiler/class-members.js";
import { EvaluationOrder } from "../compiler/evaluation-order.js";
import {
    numberConstant,
    numberPredicateCpp,
} from "../compiler/number-intrinsics.js";
import { SYNCHRONOUS_CALLBACK_METHODS } from "../compiler/parameter-effects.js";
import {
    declarationInDefaultLibrary,
    declaredInDefaultLibrary,
    libraryGlobal,
    declaredSymbol,
    resolvedSymbol,
} from "../compiler/symbols.js";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
    cppIdentifier,
    doubleCpp,
    doubleLiteral,
    lazyStaticAccessor,
    snakeCase,
    stringLiteral,
} from "../cpp-literals.js";
import type {
    Transported,
    TransportedGraph,
    TransportRecord,
    TransportSchema,
    TransportShape,
} from "../pinned-record-transport.js";
import { unwrapExpression, type LoweringContext } from "./context.js";
import { cppPrimary, type RenderedCpp } from "./pinned-numeric-expression.js";
import {
    PinnedNumericLowerer,
    type PinnedIteration,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    jsBitwiseCall,
    PINNED_BITWISE_ASSIGNMENT_OPERATORS,
} from "./pinned-operators.js";
import { isPinnedErrorCall } from "./pinned-error.js";
import { cppCondition } from "../cpp-expressions.js";
import type { CheckedPinnedProgram } from "../pinned-program.js";

import {
    RecordRepresentation,
    optionalOf,
    stripOptional,
    primitiveRecordShape,
    typedElementCpp,
    type RecordShape,
} from "./record-shapes.js";
export type { RecordShape } from "./record-shapes.js";

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
    /** A store that is not a field write (a platform object's setter). */
    readonly assign?: (owner: string, value: string) => string;
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
        call: ts.CallExpression | ts.NewExpression,
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
interface ModuleValue {
    readonly shape: RecordShape;
    readonly cpp: string;
}

interface RecordSchema {
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
    /**
     * Platform constructions, keyed by the library global the pin
     * constructs (`URL`, `AbortController`): `new URL(a, b)` is the
     * adapter's call over its arguments.
     */
    readonly constructors?: ReadonlyMap<string, CallAdapter>;
    /**
     * Tests `error instanceof C` of platform error classes, keyed by the
     * library global (`DOMException`), over the error's native spelling.
     */
    readonly instanceOf?: ReadonlyMap<string, (error: string) => string>;
    /**
     * Platform globals read as values (`globalThis.fetch` stored as a
     * function), keyed by the global's name.
     */
    readonly globalValues?: ReadonlyMap<string, ModuleValue>;
    /**
     * Platform globals the pin calls or reads (`fetch`, `setTimeout`,
     * `performance.now`), keyed by the global's dotted name; a call is the
     * adapter's.
     */
    readonly globals?: ReadonlyMap<string, CallAdapter>;
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
    /**
     * A parameter with a default the body evaluates when the argument is
     * absent, as JavaScript does: the native parameter is `shape` (an
     * optional), the local is `local`.
     */
    readonly defaulted?: { readonly local: RecordShape };
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

/** Whether a function-like is `async`. */
function isAsyncFunction(node: ts.FunctionLikeDeclaration): boolean {
    return (
        ts
            .getModifiers(node)
            ?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            ) ?? false
    );
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

/** `Array.from(...)` with the library's own `Array`. */
function isArrayFromCall(
    node: ts.Node,
    checker: ts.TypeChecker,
): node is ts.CallExpression {
    return (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "from" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Array" &&
        declaredInDefaultLibrary(
            resolvedSymbol(checker, node.expression.expression),
        )
    );
}

/**
 * Whether a function literal is an inline callback: the argument of an
 * array method that calls it before returning and keeps nothing of it
 * (`list.findIndex((x) => ...)`, the analysis' own table), an
 * `Array.from` mapper or a `new Promise` executor. It lowers as a native
 * lambda over its frame's own storage, so the bindings it reads are not
 * captures; a closure it creates captures through it.
 */
function isInlineCallback(node: ts.Node, checker: ts.TypeChecker): boolean {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))
        return false;
    let child: ts.Node = node;
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent)) {
        child = parent;
        parent = parent.parent;
    }
    // `Array.from(source, mapper)` calls its mapper before it returns.
    if (
        ts.isCallExpression(parent) &&
        parent.arguments[1] === child &&
        isArrayFromCall(parent, checker)
    )
        return true;
    // `new Promise(executor)` runs its executor before it returns.
    if (
        ts.isNewExpression(parent) &&
        parent.arguments?.[0] === child &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "Promise" &&
        declaredInDefaultLibrary(resolvedSymbol(checker, parent.expression))
    )
        return true;
    if (
        !ts.isCallExpression(parent) ||
        parent.expression === child ||
        !ts.isPropertyAccessExpression(parent.expression) ||
        !SYNCHRONOUS_CALLBACK_METHODS.has(parent.expression.name.text)
    )
        return false;
    const receiver = checker.getNonNullableType(
        checker.getTypeAtLocation(parent.expression.expression),
    );
    return checker.isArrayType(receiver) || checker.isTupleType(receiver);
}

// ── Evaluation order ───────────────────────────────────────────────────

/** Binary operators C++ already sequences (or evaluates conditionally). */
const NONSEQUENCED_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.CommaToken,
]);

/**
 * How a form evaluates its operands natively: `unordered` as a call's
 * arguments (C++ leaves their order unspecified), `ordered` as statements
 * or a chain already in source order, which only an `await` must leave
 * (a lambda cannot hold a `co_await`, and MSVC fails on one inside a
 * braced list beside a lambda).
 */
type OperandOrder = "unordered" | "ordered";

/** An operand a form evaluates ahead of itself, into a temporary. */
interface OrderedSlot {
    /** Its temporary, named once the form reads it. */
    name?: string;
    /** Its native value, rendered where the form first reads it. */
    init?: string;
    /** The native type of `init`, for a temporary declared ahead. */
    type?: () => string;
    /** The representation it was rendered in (a natural value or a sink's). */
    via?: string;
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
    private order_: EvaluationOrder | undefined;

    /**
     * The entry compiler's evaluation-order analysis over this program
     * (which operands of one expression must be read before the rest),
     * built on first use and shared by every body.
     */
    public get evaluationOrder(): EvaluationOrder {
        this.order_ ??= new EvaluationOrder(
            this.checker,
            new ClassHierarchy(this.checker, this.typed.program),
        );
        return this.order_;
    }

    public constructor(
        public readonly context: LoweringContext,
        public readonly typed: CheckedPinnedProgram,
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

    /**
     * Whether a checked type lost part of itself to an erased module. The
     * pin's own `unknown` is not erased: it is a dynamic value.
     */
    public erased(type: ts.Type, depth = 0): boolean {
        if (type.flags & ts.TypeFlags.Any) return true;
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
        ) {
            const typeArguments = this.checker.getTypeArguments(
                type as ts.TypeReference,
            );
            // `Iterable<T>`'s return and next types default to `any`; only
            // its element type is the pin's.
            const elementOnly =
                type.symbol?.name === "Iterable" &&
                declaredInDefaultLibrary(type.symbol);
            return (
                elementOnly ? typeArguments.slice(0, 1) : typeArguments
            ).some((argument) => this.erased(argument, depth + 1));
        }
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

    /**
     * The types a generic closure's type parameters stand for while one
     * instantiation of it is lowered, innermost last.
     */
    public readonly typeBindings: Map<ts.Type, ts.Type>[] = [];

    /** The native form of a checked pinned type. */
    public shapeOf(type: ts.Type, site: ts.Node): RecordShape {
        if (type.flags & ts.TypeFlags.TypeParameter) {
            for (
                let index = this.typeBindings.length - 1;
                index >= 0;
                index--
            ) {
                const bound = this.typeBindings[index]!.get(type);
                if (bound) return this.shapeOf(bound, site);
            }
            return this.fail(
                site,
                `Pinned type parameter '${this.checker.typeToString(type)}' is unbound.`,
            );
        }
        const anonymous = this.anonymous.get(type);
        if (anonymous !== undefined) return { kind: "record", name: anonymous };
        const alias = type.aliasSymbol?.name;
        if (
            alias === "Readonly" &&
            declaredInDefaultLibrary(type.aliasSymbol) &&
            type.aliasTypeArguments?.length === 1
        )
            return this.shapeOf(type.aliasTypeArguments[0]!, site);
        if (alias !== undefined) {
            const value = this.schema.values.get(alias);
            if (value) return value;
            const record = this.records.get(alias);
            if (record) return { kind: "record", name: record.spec.pinned[0]! };
            // `Record<string, unknown>`: an object the pin interrogates
            // dynamically, as a parsed document is.
            if (
                alias === "Record" &&
                declaredInDefaultLibrary(type.aliasSymbol) &&
                type.aliasTypeArguments?.length === 2 &&
                type.aliasTypeArguments[0]!.flags & ts.TypeFlags.String &&
                type.aliasTypeArguments[1]!.flags & ts.TypeFlags.Unknown
            )
                return { kind: "json" };
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
        if (flags & ts.TypeFlags.Unknown) return { kind: "json" };
        // A function that never returns returns nothing (`[[noreturn]]`).
        if (flags & ts.TypeFlags.Never) return { kind: "void" };
        if (flags & ts.TypeFlags.Any)
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
                const elements = this.checker
                    .getTypeArguments(type as ts.TypeReference)
                    .map((element) => this.shapeOf(element, site));
                if (elements.every((element) => element.kind === "number"))
                    return { kind: "tuple", elements };
                // A tuple is an array: one of a single element type (the
                // pin's five image URLs) is that array.
                const [first] = elements;
                if (
                    first === undefined ||
                    elements.some(
                        (element) =>
                            this.cppType(element) !== this.cppType(first),
                    )
                )
                    return this.fail(
                        site,
                        "Pinned tuples are admitted over numbers or one element type.",
                    );
                return { kind: "array", element: first };
            }
            const argumentsOf = (): readonly ts.Type[] =>
                this.checker.getTypeArguments(type as ts.TypeReference);
            const library = declaredInDefaultLibrary(symbol);
            if (library && name === "Float64Array")
                return { kind: "typed", element: "f64" };
            if (library && name === "DataView") return { kind: "dataview" };
            if (library && name === "ArrayLike") {
                const [element] = argumentsOf();
                if (!element || !(element.flags & ts.TypeFlags.NumberLike))
                    return this.fail(
                        site,
                        "Pinned ArrayLike is admitted over numbers only.",
                    );
                return { kind: "arraylike" };
            }
            if (library && name === "Promise") {
                const [value] = argumentsOf();
                return {
                    kind: "promise",
                    value: value ? this.shapeOf(value, site) : { kind: "void" },
                };
            }
            if (
                library &&
                (name === "Error" ||
                    name === "RangeError" ||
                    name === "TypeError" ||
                    name === "DOMException")
            )
                return { kind: "error" };
            // An `Iterable<T>` the pin only iterates holds an array.
            if (library && name === "Iterable")
                return {
                    kind: "array",
                    element: this.shapeOf(argumentsOf()[0]!, site),
                };
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
            if (name === "Int32Array") return { kind: "typed", element: "i32" };
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
            const literal = this.literalRecord(type, site);
            if (literal !== undefined) return { kind: "record", name: literal };
        }
        // `State & { ledger?: Ledger }`: a record seen with optional views of
        // members it already has is that record.
        if (type.isIntersection()) {
            const records = type.types.filter((member) => {
                const name = member.aliasSymbol?.name ?? member.symbol?.name;
                return name !== undefined && this.records.has(name);
            });
            if (records.length === 1) {
                const base = records[0]!;
                const shape = this.shapeOf(base, site);
                if (
                    shape.kind === "record" &&
                    type.types.every(
                        (member) =>
                            member === base ||
                            member
                                .getProperties()
                                .every((property) =>
                                    this.record(shape.name)
                                        .members()
                                        .has(property.name),
                                ),
                    )
                )
                    return shape;
            }
        }
        return this.fail(
            site,
            `Pinned type '${this.checker.typeToString(type)}' has no native record representation.`,
        );
    }

    /** Anonymous record types the model named itself, by struct name. */
    private readonly literalTypes = new Map<
        string,
        { type: ts.Type; site: ts.Node }
    >();
    private readonly pendingLiterals = new Set<ts.Type>();

    /**
     * The struct of an anonymous object type the schema does not name (an
     * object literal's own type, a type literal, a mapped type such as
     * `Partial<Pick<...>>`): a record shared by identity, as the
     * JavaScript object is, named by its members and their native types so
     * every model spells one structure alike. A named interface or class
     * stays the schema's to declare.
     */
    private literalRecord(type: ts.Type, site: ts.Node): string | undefined {
        const objectFlags = (type as ts.ObjectType).objectFlags;
        const symbolName = type.getSymbol()?.name;
        const anonymous =
            (objectFlags &
                (ts.ObjectFlags.Anonymous | ts.ObjectFlags.Mapped)) !==
                0 ||
            symbolName === "__object" ||
            symbolName === "__type";
        const properties = this.checker.getPropertiesOfType(type);
        if (
            !anonymous ||
            properties.length === 0 ||
            type.getCallSignatures().length > 0 ||
            type.getConstructSignatures().length > 0
        )
            return undefined;
        if (this.pendingLiterals.has(type))
            return this.fail(
                site,
                `Pinned anonymous record '${this.checker.typeToString(type)}' refers to itself.`,
            );
        this.pendingLiterals.add(type);
        let members: (readonly [string, string])[];
        try {
            members = properties.map(
                (property) =>
                    [
                        property.name,
                        this.cppType(
                            this.declaredShape(
                                this.checker.getTypeOfSymbolAtLocation(
                                    property,
                                    site,
                                ),
                                property.valueDeclaration ?? site,
                            ),
                        ),
                    ] as const,
            );
        } finally {
            this.pendingLiterals.delete(type);
        }
        // A literal with exactly a schema record's members is that record
        // (`{ ...request, url }`), as TypeScript's structural typing says.
        const matching = this.schema.records.filter((spec) => {
            if (spec.native || this.literalTypes.has(spec.pinned[0]!))
                return false;
            const declared = this.record(spec.pinned[0]!).members();
            const stored = [...declared.values()].filter(
                (member) => member.storage !== "none",
            );
            return (
                stored.length === members.length &&
                members.every(([name, cpp]) => {
                    const member = declared.get(name);
                    return (
                        member !== undefined &&
                        member.storage !== "none" &&
                        this.cppType(member.shape) === cpp
                    );
                })
            );
        });
        if (matching.length === 1) {
            const name = matching[0]!.pinned[0]!;
            this.anonymous.set(type, name);
            return name;
        }
        const signature = members
            .map(([name, cpp]) => `${name}:${cpp}`)
            .join(";");
        const name = `PinnedObject${createHash("sha256").update(signature).digest("hex").slice(0, 10)}`;
        if (!this.records.has(name)) {
            this.literalTypes.set(name, { type, site });
            this.records.set(
                name,
                this.resolveRecord({
                    pinned: [name],
                    cpp: name,
                    reference: true,
                }),
            );
        }
        this.anonymous.set(type, name);
        return name;
    }

    /** Whether a record is an object literal's anonymous type. */
    public isLiteralRecord(name: string): boolean {
        return this.literalTypes.has(name);
    }

    /** The anonymous records the lowered bodies reached, for `structs`. */
    public literalRecords(): string[] {
        return [...this.literalTypes.keys()];
    }

    /** Runtime headers the lowered bodies reached beyond `pinned_records.hpp`. */
    public readonly includes = new Set<string>();

    public include(header: string): void {
        this.includes.add(header);
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
        const primitive = primitiveRecordShape(types);
        if (primitive) return primitive;
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

    public readonly representations = new RecordRepresentation({
        record: (name) => {
            const spec = this.record(name).spec;
            return {
                cpp: !spec.reference
                    ? `bbl::${spec.cpp}`
                    : spec.handle
                      ? `bbl::${spec.handle}`
                      : `std::shared_ptr<bbl::${spec.cpp}>`,
                reference: spec.reference,
            };
        },
        object: "std::shared_ptr<const void>",
        jsNamespace: "bbl::js",
        tuple: (elements) => `bbl::js::Tuple<${elements.length}>`,
    });

    /** The C++ type of a shape. */
    public cppType(shape: RecordShape): string {
        return this.representations.cppType(shape);
    }

    public absent(shape: RecordShape, site: ts.Node): string {
        return (
            this.representations.absent(shape) ??
            this.fail(site, "Pinned absent value has a non-optional type.")
        );
    }

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
        const literal = this.literalTypes.get(name);
        if (literal) return literal;
        const declared = (
            statement: ts.Node,
        ): { type: ts.Type; site: ts.Node } | undefined => {
            if (
                (ts.isInterfaceDeclaration(statement) ||
                    ts.isTypeAliasDeclaration(statement) ||
                    ts.isClassDeclaration(statement)) &&
                statement.name?.text === name
            ) {
                const symbol = declaredSymbol(this.checker, statement.name)!;
                return {
                    type: this.checker.getDeclaredTypeOfSymbol(symbol),
                    site: statement,
                };
            }
            return undefined;
        };
        const files = this.typed.program
            .getSourceFiles()
            .filter((file) => modulePathOf(file).startsWith("src/"));
        for (const file of files)
            for (const statement of file.statements) {
                const found = declared(statement);
                if (found) return found;
            }
        // A declaration local to a function body (a request manager's
        // `FetchedBody`): one, or the name is ambiguous.
        const nested: { type: ts.Type; site: ts.Node }[] = [];
        for (const file of files) {
            const visit = (node: ts.Node): void => {
                const found = declared(node);
                if (found) nested.push(found);
                ts.forEachChild(node, visit);
            };
            visit(file);
        }
        if (nested.length === 1) return nested[0]!;
        throw new Error(
            nested.length === 0
                ? `Pinned record type '${name}' is not declared.`
                : `Pinned record type '${name}' is declared in ${nested.length} function bodies.`,
        );
    }

    private recordMembers(spec: RecordSpec): Map<string, ResolvedMember> {
        const members = new Map<string, ResolvedMember>();
        const pointer = (owner: string) =>
            spec.reference ? `${owner}->` : `${owner}.`;
        const add = (
            name: string,
            shape: RecordShape,
            override?: MemberSpec,
            field = override?.field ?? cppIdentifier(snakeCase(name)),
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
                ...(override?.assign ? { set: override.assign } : {}),
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
        const error = this.extendsError(declaration);
        const members = new Map<string, ResolvedMember>();
        const record = spec.pinned[0]!;
        for (const property of this.checker.getPropertiesOfType(type)) {
            const name = property.getName();
            if (spec.omit?.has(name)) continue;
            const declarations = property.declarations ?? [];
            // An Error subclass stores the `name` and `message` it is
            // thrown with; its stack and cause are the runtime's.
            if (
                error &&
                declarations.every((candidate) =>
                    declarationInDefaultLibrary(candidate),
                )
            ) {
                if (name === "stack" || name === "cause") continue;
                if (name !== "name" && name !== "message")
                    this.fail(
                        declaration,
                        `Pinned Error member '${name}' is not represented.`,
                    );
                members.set(name, {
                    name,
                    field: name,
                    declaredBy: record,
                    shape: { kind: "string" },
                    access: (owner) => `${owner}->${name}`,
                    storage: "field",
                });
                continue;
            }
            const shapeOf = (site: ts.Node): RecordShape =>
                spec.members?.get(name)?.shape ??
                this.declaredShape(
                    this.checker.getTypeOfSymbolAtLocation(property, site),
                    site,
                );
            const base = {
                name,
                field: cppIdentifier(snakeCase(name)),
                declaredBy: record,
            };
            const getter = declarations.find(ts.isGetAccessorDeclaration);
            const setter = declarations.find(ts.isSetAccessorDeclaration);
            const method = declarations.find(ts.isMethodDeclaration);
            const field = declarations.find(ts.isPropertyDeclaration);
            const parameterProperty = declarations.find(
                (candidate): candidate is ts.ParameterDeclaration =>
                    ts.isParameter(candidate) &&
                    ts.isParameterPropertyDeclaration(
                        candidate,
                        candidate.parent,
                    ),
            );
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
            } else if (parameterProperty) {
                // `constructor(readonly url: string)`: a field the
                // constructor assigns from its parameter.
                members.set(name, {
                    ...base,
                    shape: shapeOf(parameterProperty),
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

    /** Whether a record is an authored `class X extends Error`. */
    public errorClass(name: string): boolean {
        const spec = this.record(name).spec;
        if (spec.native || this.literalTypes.has(spec.pinned[0]!)) return false;
        const { site } = this.recordSource(spec);
        return ts.isClassDeclaration(site) && this.extendsError(site);
    }

    /**
     * An Error subclass without a constructor takes Error's: its optional
     * message, the library's own parameter.
     */
    private errorMessageParameter(
        declaration: ts.ClassDeclaration,
    ): NativeParameter[] {
        const base = declaration.heritageClauses?.[0]?.types[0]?.expression;
        const parameter = base
            ? this.checker
                  .getTypeAtLocation(base)
                  .getConstructSignatures()
                  .map((signature) => signature.getDeclaration().parameters[0])
                  .find(
                      (candidate) =>
                          candidate !== undefined &&
                          ts.isIdentifier(candidate.name) &&
                          candidate.name.text === "message",
                  )
            : undefined;
        if (!parameter || !ts.isIdentifier(parameter.name))
            return this.fail(
                declaration,
                "Pinned Error constructor has no message parameter.",
            );
        return [
            {
                name: parameter.name,
                shape: { kind: "optional", value: { kind: "string" } },
                optional: true,
                node: parameter,
            },
        ];
    }

    /**
     * Whether a class extends the library's `Error` (its instances are
     * thrown as authored errors); any other base refuses.
     */
    public extendsError(declaration: ts.ClassDeclaration): boolean {
        const clause = declaration.heritageClauses?.find(
            (candidate) => candidate.token === ts.SyntaxKind.ExtendsKeyword,
        );
        if (!clause) return false;
        const base = clause.types[0]?.expression;
        if (
            clause.types.length !== 1 ||
            !base ||
            !ts.isIdentifier(base) ||
            base.text !== "Error" ||
            !declaredInDefaultLibrary(resolvedSymbol(this.checker, base))
        )
            return this.fail(
                declaration,
                "Pinned class inheritance is not lowered.",
            );
        return true;
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
                    return { kind: "tuple", length: shape.elements.length };
                case "typed":
                    if (shape.element === "f64")
                        throw new Error(
                            "A Float64Array does not cross the generation transport.",
                        );
                    return { kind: "typed", element: shape.element };
                case "json":
                case "dataview":
                case "arraylike":
                case "error":
                case "promise":
                    throw new Error(
                        `A pinned ${shape.kind} value does not cross the generation transport.`,
                    );
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
                return this.representations.nullable(to.value)
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
                // A native base's computed member (its `access` reads no
                // field) holds nothing to trace.
                const declaring =
                    member.declaredBy === spec.pinned[0]
                        ? undefined
                        : this.record(member.declaredBy).spec;
                const computed =
                    declaring?.native === true &&
                    declaring.members?.get(member.name)?.access !== undefined;
                for (const [field, cpp] of fields) {
                    if (member.declaredBy === spec.pinned[0])
                        lines.push(
                            `    ${cpp} ${field}${member.storage === "field" ? memberInitializer(member.shape) : "{}"};`,
                        );
                    if (
                        !computed &&
                        (member.storage === "accessor" ||
                            !["number", "boolean", "string"].includes(
                                member.shape.kind,
                            ))
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
                // A function's environment, a dynamic value, an error and a
                // promise may hold anything.
                case "function":
                case "object":
                case "json":
                case "error":
                case "promise":
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
        const declaration =
            symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (declaration) return declaration;
        // An asset module the program does not resolve (`import TEXT from
        // "./x.wgsl?raw"`): the import clause itself.
        const own = declaredSymbol(this.checker, node)?.declarations?.[0];
        return own && ts.isImportClause(own) ? own : undefined;
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
                cpp: cppIdentifier(snakeCase(name)),
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
        const stem = cppIdentifier(snakeCase(className));
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
        const snake = snakeCase(member);
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

    /** A realm variable's storage: its own name, or its constructed object's accessor. */
    public variableCpp(variable: ModuleVariable): string {
        return `${this.qualified(variable)}${variable.initializer === undefined ? "" : "()"}`;
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
            cpp: cppIdentifier(snakeCase(declaration.name.text)),
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
                `${this.cppType(parameter.shape)} ${parameterCpp(parameter)}${defaults && parameter.node.initializer ? " = {}" : parameter.optional && defaults ? ` = ${this.absent(parameter.shape, parameter.node)}` : ""}`,
        );
        const self = this.selfShape(entry);
        return `${this.cppType(returns)} ${entry.cpp}(${[
            ...(self ? [`${this.cppType(self)} self`] : []),
            ...parameters,
        ].join(", ")})`;
    }

    /** Whether a lowered function's checked result is `never`. */
    private noReturn(entry: LoweredFunction): boolean {
        const declaration = entry.declaration;
        if (ts.isClassDeclaration(declaration)) return false;
        const signature = this.checker.getSignatureFromDeclaration(declaration);
        return (
            signature !== undefined &&
            (this.checker.getReturnTypeOfSignature(signature).flags &
                ts.TypeFlags.Never) !==
                0
        );
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
        if (ts.isClassDeclaration(declaration))
            return this.extendsError(declaration)
                ? this.errorMessageParameter(declaration)
                : [];
        return declaration.parameters.map((parameter, index) => {
            if (!ts.isIdentifier(parameter.name))
                return this.fail(parameter, "Pinned parameters must be named.");
            if (parameter.initializer) {
                const shape = this.declaredShape(
                    this.checker.getTypeAtLocation(parameter.name),
                    parameter,
                );
                // `options = {}` over a value record is its empty record,
                // which C++'s default argument constructs.
                if (!(
                    ts.isObjectLiteralExpression(parameter.initializer) &&
                    parameter.initializer.properties.length === 0 &&
                    shape.kind === "record" &&
                    !this.record(shape.name).spec.reference
                )) {
                    if (ts.getModifiers(parameter)?.length)
                        this.fail(
                            parameter,
                            "Pinned parameter properties are not lowered.",
                        );
                    const local = stripOptional(
                        entry.parameters?.[index] ?? shape,
                    );
                    return {
                        name: parameter.name,
                        shape: optionalOf(local),
                        optional: true,
                        node: parameter,
                        defaulted: { local },
                    };
                }
            }
            // A constructor's parameter property is also its field, which
            // the constructor body assigns.
            if (
                ts.getModifiers(parameter)?.length &&
                !(
                    ts.isConstructorDeclaration(declaration) &&
                    ts.isParameterPropertyDeclaration(parameter, declaration)
                )
            )
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
                    const provenance = `// ${this.context.provenance(modulePathOf(variable.declaration.getSourceFile()), variable.declaration.name.getText(), "realm state")}`;
                    const type = this.cppType(variable.shape);
                    return variable.initializer === undefined
                        ? `${provenance}\ninline thread_local ${type} ${variable.cpp}{};`
                        : `${provenance}\n${lazyStaticAccessor({
                              name: variable.cpp,
                              type,
                              initializer: variable.initializer,
                              storage: "thread_local",
                              inline: true,
                          })}`;
                },
            ),
            grouped(
                selected,
                (entry) => entry.namespace,
                (entry) =>
                    `${this.noReturn(entry) ? "[[noreturn]] " : ""}${this.signature(entry, true)};`,
            ),
        ]
            .filter((part) => part.length > 0)
            .join("\n");
        const definitions = grouped(
            selected,
            (entry) => entry.namespace,
            (entry) => {
                const { environments, body } = bodies.get(entry)!;
                return `${environments}// ${this.context.provenance(entry.module, entry.name)}\n${this.noReturn(entry) ? "[[noreturn]] " : ""}inline ${this.signature(entry, false)} {\n${body}\n}`;
            },
        );
        return { declarations, definitions };
    }
}

/**
 * `Number`'s predicates over a dynamic value, which answers `false` unless
 * it holds a number (over a number they are the entry compiler's,
 * `numberPredicateCpp`).
 */
const JSON_NUMBER_PREDICATES: ReadonlyMap<string, string> = new Map([
    ["isFinite", "bbl::pinned::json_is_finite"],
    ["isNaN", "bbl::pinned::json_is_nan"],
    ["isInteger", "bbl::pinned::json_is_integer"],
    ["isSafeInteger", "bbl::pinned::json_is_safe_integer"],
]);

/** `Number.<name>` over a number and over a dynamic value, when it is a predicate. */
function numberPredicate(
    name: string,
): { readonly number: string; readonly json: string } | undefined {
    const number = numberPredicateCpp(name);
    const json = JSON_NUMBER_PREDICATES.get(name);
    return number && json ? { number, json } : undefined;
}

/** The native name of a parameter: a defaulted one's argument, before its default. */
function parameterCpp(parameter: NativeParameter): string {
    const name = cppIdentifier(parameter.name.text);
    return parameter.defaulted ? `${name}_argument` : name;
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
    /**
     * A generic closure's instantiations, by their function shape's native
     * type: one closure per type argument set its calls use.
     */
    readonly specializations?: ReadonlyMap<string, Local>;
    /** The C++ name of a local its frame declares itself. */
    readonly cpp?: string;
    /** A binding closures capture: its field in its frame's environment. */
    readonly captured?: {
        /** The function-like or block whose environment holds it. */
        readonly scope: ts.Node;
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
    /** The function-like or block whose bindings it holds. */
    readonly owner: ts.Node;
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
    /** An inline callback: a native lambda over its defining frame's storage. */
    readonly inline?: true;
    /** An async function or closure: a coroutine over `js::Promise`. */
    readonly async?: true;
    /** An object literal's method: the environment holding its `this`. */
    readonly literalThis?: Environment;
    /**
     * The block environments entered so far, innermost last: bindings a
     * block declares that closures capture, one environment per execution
     * of the block (per loop iteration), as JavaScript's block scope is.
     */
    readonly scopes: Environment[];
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
    /** Operands a form being lowered evaluates ahead of itself (`sequenced`). */
    private readonly slots = new Map<ts.Node, OrderedSlot>();
    /** Forms `sequenced` is lowering now (their operands are already ordered). */
    private readonly sequencing = new Set<ts.Node>();
    /** Declarations the statements being lowered need first, innermost last. */
    private readonly preludes: string[][] = [];
    private readonly source: ts.SourceFile;
    private temporaries = 0;
    private orderedTemporaries = 0;
    /** Bindings a closure inside this function reads or writes. */
    private readonly captured = new Set<ts.Symbol>();
    /** Where the first closure over each captured binding is created. */
    private readonly earliestCapture = new Map<ts.Symbol, number>();
    /** The decoded views of constant string locals (`stringViewLines`). */
    private readonly stringViews = new Map<
        ts.Symbol,
        { units?: string; length?: string }
    >();
    /** The frames being lowered, innermost last. */
    private readonly frames: Frame[] = [];
    /** Environment struct definitions, in the order frames created them. */
    private readonly environments: string[] = [];

    public constructor(
        private readonly model: PinnedRecordModel,
        private readonly entry: LoweredFunction,
    ) {
        const calls = new Map<string, PinnedCallSpelling>();

        calls.set("Number.isFinite", (args) => `std::isfinite(${args[0]})`);
        const scope: PinnedNumericScope = {
            bindings: new Map(),
            calls,
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
            scopes: [],
            ...(self || constructs ? { self: "self" } : {}),
            ...(!ts.isClassDeclaration(entry.declaration) &&
            isAsyncFunction(entry.declaration)
                ? { async: true as const }
                : {}),
        });
        if (self || constructs) this.names[0]!.add("self");
        for (const parameter of model.parametersOf(entry)) {
            this.names[0]!.add(parameterCpp(parameter));
            if (!parameter.defaulted)
                this.declare(
                    parameter.name,
                    parameter.shape,
                    cppIdentifier(parameter.name.text),
                );
        }
    }

    /**
     * Each defaulted parameter's local: the argument when present, else
     * the pin's default, evaluated in parameter order as JavaScript does.
     */
    private parameterDefaults(indent: string): string[] {
        const lines: string[] = [];
        for (const parameter of this.model.parametersOf(this.entry)) {
            if (!parameter.defaulted) continue;
            const local = parameter.defaulted.local;
            const argument = parameterCpp(parameter);
            const value = `${this.presentTest(argument)} ? ${this.coerce(argument, parameter.shape, local, parameter.node)} : ${this.convert(parameter.node.initializer!, local)}`;
            lines.push(
                `${indent}${this.cpp(local)} ${this.declare(parameter.name, local)} = ${value};`,
            );
        }
        return lines;
    }

    /** Whether a function-like's body names `name` (an unread parameter is marked). */
    private read(
        name: ts.Identifier,
        node: ts.FunctionLikeDeclaration,
    ): boolean {
        const symbol = declaredSymbol(this.checker, name);
        const visit = (child: ts.Node): boolean =>
            (ts.isIdentifier(child) &&
                child !== name &&
                declaredSymbol(this.checker, child) === symbol) ||
            ts.forEachChild(child, (next) =>
                visit(next) ? true : undefined,
            ) === true;
        return node.body !== undefined && visit(node.body);
    }

    /** Whether an expression creates a function value. */
    private containsClosure(node: ts.Node): boolean {
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
            return true;
        return (
            ts.forEachChild(node, (child) =>
                this.containsClosure(child) ? true : undefined,
            ) === true
        );
    }

    /** `value !== undefined` over an optional's native form. */
    private presentTest(value: string): string {
        return `bbl::pinned::truthy_object(${value})`;
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
        const prolog = (): string[] =>
            this.frameProlog(
                ts.isClassDeclaration(declaration)
                    ? []
                    : declaration.parameters,
                ts.isClassDeclaration(declaration)
                    ? []
                    : (declaration.body?.statements ?? []),
                "    ",
            );
        // A default that creates a closure (`create = (d) => device.f(d)`)
        // closes over the parameters it reads: the environment holding them
        // exists before the defaults run. A defaulted parameter a closure
        // captures would need its own slot first, which this does not order.
        const parameters = this.model.parametersOf(this.entry);
        const closureDefault = parameters.some(
            (parameter) =>
                parameter.defaulted &&
                parameter.node.initializer &&
                this.containsClosure(parameter.node.initializer),
        );
        if (closureDefault)
            for (const parameter of parameters) {
                const symbol = declaredSymbol(this.checker, parameter.name);
                if (
                    parameter.defaulted &&
                    symbol !== undefined &&
                    this.captured.has(symbol)
                )
                    this.refuse(
                        parameter.node,
                        "A pinned closure captures a defaulted parameter beside a closure default.",
                    );
            }
        if (
            ts.isClassDeclaration(declaration) ||
            ts.isConstructorDeclaration(declaration)
        )
            return this.constructorBody(
                closureDefault
                    ? [...prolog(), ...this.parameterDefaults("    ")]
                    : [...this.parameterDefaults("    "), ...prolog()],
            );
        const statements = this.hoisted(declaration.body!.statements);
        let lines: string[];
        let rest = statements;
        if (closureDefault)
            lines = [...prolog(), ...this.parameterDefaults("    ")];
        else {
            lines = this.parameterDefaults("    ");
            const guards = this.leadingGuards(declaration, statements);
            lines.push(...this.statements(guards, "    "), ...prolog());
            rest = statements.slice(guards.length);
        }
        const body = [...lines, ...this.statements(rest, "    ")];
        return (
            this.frame.async ? this.coroutine(declaration, body, "    ") : body
        ).join("\n");
    }

    /**
     * A body's leading guards: `if (...) return ...;` (or a throw) with no
     * else, creating no closure and reading no binding the body declares
     * besides its parameters, and not always taken. They run before the
     * frame's environment exists -- a frame that returns at once allocates
     * nothing -- reading captured parameters where they arrived.
     */
    private leadingGuards(
        owner: ts.Node,
        statements: readonly ts.Statement[],
    ): readonly ts.Statement[] {
        const guards: ts.Statement[] = [];
        for (const statement of statements) {
            if (
                !ts.isIfStatement(statement) ||
                statement.elseStatement ||
                this.terminates(statement)
            )
                break;
            const then = statement.thenStatement;
            const exit =
                ts.isBlock(then) && then.statements.length === 1
                    ? then.statements[0]!
                    : then;
            if (
                !ts.isReturnStatement(exit) &&
                !ts.isThrowStatement(exit) &&
                !(
                    ts.isExpressionStatement(exit) &&
                    ts.isCallExpression(exit.expression) &&
                    isPinnedErrorCall(this.source, exit.expression)
                )
            )
                break;
            let clean = true;
            const visit = (node: ts.Node): void => {
                if (!clean) return;
                if (isFunctionLike(node) || ts.isClassExpression(node)) {
                    clean = false;
                    return;
                }
                if (ts.isIdentifier(node)) {
                    const symbol = declaredSymbol(this.checker, node);
                    const declaration =
                        symbol?.valueDeclaration ?? symbol?.declarations?.[0];
                    if (
                        declaration &&
                        !ts.isParameter(declaration) &&
                        this.within(owner, declaration)
                    )
                        clean = false;
                }
                ts.forEachChild(node, visit);
            };
            visit(statement);
            if (!clean) break;
            guards.push(statement);
        }
        return guards;
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
        // What construction does before the constructor's own statements:
        // the class's field initializers, then its parameter properties.
        const initialize = (): string[] => {
            const assigned: string[] = [];
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
                    this.refuse(
                        member,
                        "Pinned class field is not represented.",
                    );
                assigned.push(
                    `    ${resolved.access("self")} = ${this.convert(member.initializer, resolved.shape)};`,
                );
            }
            if (ts.isConstructorDeclaration(declaration))
                for (const parameter of declaration.parameters) {
                    if (
                        !ts.isParameterPropertyDeclaration(
                            parameter,
                            declaration,
                        ) ||
                        !ts.isIdentifier(parameter.name)
                    )
                        continue;
                    const resolved = members.get(parameter.name.text);
                    if (!resolved)
                        this.refuse(
                            parameter,
                            "Pinned parameter property is not represented.",
                        );
                    assigned.push(
                        `    ${resolved.access("self")} = ${this.value(parameter.name)};`,
                    );
                }
            return assigned;
        };
        // An Error subclass is an error first: `super(message)` sets its
        // message (absent, the empty one); its name is Error's until the
        // constructor sets its own.
        const error = this.model.extendsError(classDeclaration);
        let statements: readonly ts.Statement[] =
            ts.isConstructorDeclaration(declaration) && declaration.body
                ? declaration.body.statements
                : [];
        if (error) {
            let message: string;
            if (ts.isConstructorDeclaration(declaration)) {
                const first = statements[0];
                const call =
                    first &&
                    ts.isExpressionStatement(first) &&
                    ts.isCallExpression(first.expression) &&
                    first.expression.expression.kind ===
                        ts.SyntaxKind.SuperKeyword
                        ? first.expression
                        : undefined;
                if (!call || call.arguments.length > 1)
                    return this.refuse(
                        declaration,
                        "A pinned Error subclass's constructor starts with super(message).",
                    );
                const [argument] = call.arguments;
                message = argument
                    ? this.convert(argument, { kind: "string" })
                    : 'std::string("")';
                statements = statements.slice(1);
            } else {
                const [parameter] = this.model.parametersOf(this.entry);
                message = parameter
                    ? `(${this.presentTest(parameterCpp(parameter))} ? ${this.coerce(parameterCpp(parameter), parameter.shape, { kind: "string" }, declaration)} : std::string(""))`
                    : 'std::string("")';
            }
            lines.push(
                '    self->name = "Error";',
                `    self->message = ${message};`,
            );
        }
        lines.push(...initialize());
        if (ts.isConstructorDeclaration(declaration) && declaration.body) {
            const returns = this.model.context.findNodes(
                declaration.body,
                (node): node is ts.ReturnStatement =>
                    ts.isReturnStatement(node) &&
                    enclosingFunctionLike(node) === declaration,
            );
            if (returns.length > 0)
                this.refuse(returns[0]!, "A pinned constructor returns early.");
            lines.push(...this.statements(this.hoisted(statements), "    "));
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
                    this.captureFrame(declaration) !== this.captureFrame(node)
                ) {
                    this.captured.add(symbol);
                    // A block-scoped binding lives in its block's
                    // environment (one per execution of the block).
                    if (!this.topLevel(declaration))
                        this.blockScope(declaration, node);
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
                this.captureFrame(node) !== root &&
                !this.objectMethodThis(node)
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
     * The function-like whose frame holds what `node` reads: its enclosing
     * function-like, through inline callbacks, which share their frame's
     * storage.
     */
    private captureFrame(node: ts.Node): ts.Node | undefined {
        let current = enclosingFunctionLike(node);
        while (current && isInlineCallback(current, this.checker))
            current = enclosingFunctionLike(current);
        return current;
    }

    /**
     * The object-literal method or accessor a `this` names the object of
     * (arrows inherit their frame's `this`), if it is one.
     */
    private objectMethodThis(
        node: ts.Node,
    ):
        | ts.MethodDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration
        | undefined {
        let current = enclosingFunctionLike(node);
        while (current && ts.isArrowFunction(current))
            current = enclosingFunctionLike(current);
        return current &&
            (ts.isMethodDeclaration(current) ||
                ts.isGetAccessorDeclaration(current) ||
                ts.isSetAccessorDeclaration(current)) &&
            ts.isObjectLiteralExpression(current.parent)
            ? current
            : undefined;
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

    /**
     * Whether a binding is declared by a statement of its function's body
     * itself: a loop header's or a case clause's binding is not.
     */
    private topLevel(declaration: ts.Node): boolean {
        if (ts.isParameter(declaration)) return true;
        const owner = enclosingFunctionLike(declaration);
        const body = owner && isFunctionLike(owner) ? owner.body : undefined;
        let node: ts.Node = declaration;
        while (
            ts.isBindingElement(node) ||
            ts.isObjectBindingPattern(node) ||
            ts.isArrayBindingPattern(node)
        )
            node = node.parent;
        if (ts.isVariableDeclaration(node)) {
            const statement = node.parent.parent;
            return (
                ts.isVariableStatement(statement) && statement.parent === body
            );
        }
        return node.parent === body;
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
            .map(({ name, storage }) => {
                // A generic closure holds one slot per instantiation.
                const generic = ts.isVariableDeclaration(name.parent)
                    ? this.instantiations(name.parent)
                    : undefined;
                return generic
                    ? { name, storage: { kind: "void" as const }, generic }
                    : { name, storage: storage() };
            });
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
                owner: frame.node,
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
            for (const { name, storage, generic } of capturedHere) {
                const symbol = declaredSymbol(this.checker, name)!;
                if (generic) {
                    const specializations = new Map<string, Local>();
                    for (const variant of generic.variants) {
                        let field = cppIdentifier(name.text);
                        while (taken.has(field)) field = `${field}_`;
                        taken.add(field);
                        fields.push({
                            field,
                            storage: variant.shape,
                            temporal: false,
                        });
                        specializations.set(variant.key, {
                            storage: variant.shape,
                            captured: {
                                scope: frame.node,
                                field,
                                temporal: false,
                            },
                        });
                    }
                    this.locals.set(symbol, { storage, specializations });
                    continue;
                }
                let field = cppIdentifier(name.text);
                while (taken.has(field)) field = `${field}_`;
                taken.add(field);
                const temporal = this.temporal(symbol, name.parent);
                fields.push({ field, storage, temporal });
                const parameter = this.locals.get(symbol);
                if (ts.isParameter(name.parent) && parameter?.cpp)
                    moves.push(
                        `${indent}${variable}->${field} = ${parameter.cpp};`,
                    );
                this.locals.set(symbol, {
                    storage,
                    captured: { scope: frame.node, field, temporal },
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

    /**
     * A `const f = <T>(...) => ...` closure's instantiations: one per
     * distinct function shape its calls in this body resolve to, with the
     * types its type parameters take there. Reading it otherwise refuses.
     */
    private instantiations(declaration: ts.VariableDeclaration):
        | {
              readonly closure: ts.ArrowFunction | ts.FunctionExpression;
              readonly variants: readonly {
                  readonly key: string;
                  readonly shape: RecordShape;
                  readonly bindings: Map<ts.Type, ts.Type>;
              }[];
          }
        | undefined {
        const closure = declaration.initializer
            ? this.skipParentheses(declaration.initializer)
            : undefined;
        if (
            !closure ||
            !(
                ts.isArrowFunction(closure) || ts.isFunctionExpression(closure)
            ) ||
            !closure.typeParameters?.length ||
            !ts.isIdentifier(declaration.name)
        )
            return undefined;
        const symbol = declaredSymbol(this.checker, declaration.name);
        const declared = this.checker.getSignatureFromDeclaration(closure);
        if (!symbol || !declared)
            return this.refuse(declaration, "Pinned generic closure shape.");
        const variants = new Map<
            string,
            { key: string; shape: RecordShape; bindings: Map<ts.Type, ts.Type> }
        >();
        const visit = (node: ts.Node): void => {
            if (
                ts.isIdentifier(node) &&
                node !== declaration.name &&
                declaredSymbol(this.checker, node) === symbol
            ) {
                const call = node.parent;
                if (!ts.isCallExpression(call) || call.expression !== node)
                    this.refuse(
                        node,
                        "A pinned generic closure is only called, never read as a value.",
                    );
                else {
                    const variant = this.instantiation(call, declared);
                    if (!variants.has(variant.key))
                        variants.set(variant.key, variant);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(this.entry.declaration);
        return { closure, variants: [...variants.values()] };
    }

    /** One call's instantiation of a generic closure: its shape and type arguments. */
    private instantiation(
        call: ts.CallExpression,
        declared: ts.Signature,
    ): { key: string; shape: RecordShape; bindings: Map<ts.Type, ts.Type> } {
        const resolved = this.checker.getResolvedSignature(call);
        if (!resolved)
            return this.refuse(call, "Pinned generic call has no signature.");
        const bindings = new Map<ts.Type, ts.Type>();
        const unify = (generic: ts.Type, actual: ts.Type, depth = 0): void => {
            if (depth > 8) return;
            if (generic.flags & ts.TypeFlags.TypeParameter) {
                bindings.set(generic, actual);
                return;
            }
            const references = (type: ts.Type): boolean =>
                (type.flags & ts.TypeFlags.Object) !== 0 &&
                ((type as ts.ObjectType).objectFlags &
                    ts.ObjectFlags.Reference) !==
                    0;
            if (references(generic) && references(actual)) {
                const genericArguments = this.checker.getTypeArguments(
                    generic as ts.TypeReference,
                );
                const actualArguments = this.checker.getTypeArguments(
                    actual as ts.TypeReference,
                );
                genericArguments.forEach((argument, index) => {
                    const other = actualArguments[index];
                    if (other) unify(argument, other, depth + 1);
                });
                return;
            }
            const [genericSignature] = generic.getCallSignatures();
            const [actualSignature] = actual.getCallSignatures();
            if (genericSignature && actualSignature) {
                genericSignature.getParameters().forEach((parameter, index) => {
                    const other = actualSignature.getParameters()[index];
                    if (other)
                        unify(
                            this.checker.getTypeOfSymbolAtLocation(
                                parameter,
                                call,
                            ),
                            this.checker.getTypeOfSymbolAtLocation(other, call),
                            depth + 1,
                        );
                });
                unify(
                    genericSignature.getReturnType(),
                    actualSignature.getReturnType(),
                    depth + 1,
                );
            }
        };
        declared.getParameters().forEach((parameter, index) => {
            const actual = resolved.getParameters()[index];
            if (actual)
                unify(
                    this.checker.getTypeOfSymbolAtLocation(parameter, call),
                    this.checker.getTypeOfSymbolAtLocation(actual, call),
                );
        });
        unify(declared.getReturnType(), resolved.getReturnType());
        const shape: RecordShape = {
            kind: "function",
            parameters: resolved
                .getParameters()
                .map((parameter) =>
                    this.model.shapeOf(
                        this.checker.getTypeOfSymbolAtLocation(parameter, call),
                        call,
                    ),
                ),
            result: this.model.shapeOf(resolved.getReturnType(), call),
        };
        return { key: this.cpp(shape), shape, bindings };
    }

    /** `f` lowered once per instantiation, its type parameters bound. */
    private instantiated(
        closure: ts.ArrowFunction | ts.FunctionExpression,
        variant: { shape: RecordShape; bindings: Map<ts.Type, ts.Type> },
        indent: string,
    ): string {
        this.model.typeBindings.push(variant.bindings);
        try {
            return this.closure(closure, variant.shape, indent);
        } finally {
            this.model.typeBindings.pop();
        }
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
        const owner = local.captured.scope;
        return `${this.environmentPath((environment) => environment.owner === owner)}->${local.captured.field}`;
    }

    /**
     * The innermost environment code at the current point of `frame` sees
     * (its innermost block's, its own, or the one it received), and the
     * native variable holding it there.
     */
    private visibleEnvironment(
        frame: Frame = this.frame,
    ): { environment: Environment; variable: string } | undefined {
        const scope = frame.scopes[frame.scopes.length - 1];
        if (scope) return { environment: scope, variable: scope.variable };
        if (frame.environment)
            return {
                environment: frame.environment,
                variable: frame.environment.variable,
            };
        return frame.received
            ? {
                  environment: frame.received.environment,
                  variable: frame.received.variable,
              }
            : undefined;
    }

    /**
     * The block a captured `let`/`const` belongs to when it is not its
     * function's top level: a block statement, or the `for` whose header
     * declares it (one binding per iteration). Anything else refuses.
     */
    private blockScope(
        declaration: ts.Node,
        site: ts.Node,
    ): ts.Block | ts.ForStatement {
        if (ts.isVariableDeclaration(declaration)) {
            const list = declaration.parent;
            const owner = list.parent;
            if (
                ts.isVariableDeclarationList(list) &&
                (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0
            ) {
                if (ts.isForStatement(owner) && owner.initializer === list)
                    return owner;
                if (ts.isVariableStatement(owner) && ts.isBlock(owner.parent))
                    return owner.parent;
            }
        }
        return this.refuse(
            site,
            "A pinned closure captures a binding no block scope holds.",
        );
    }

    /**
     * A block's statements; when closures capture bindings it declares,
     * a fresh environment holds them for this execution of the block.
     */
    public override statements(
        list: readonly ts.Statement[],
        indent: string,
    ): string[] {
        const block = list[0]?.parent;
        if (!block || !ts.isBlock(block) || isFunctionLike(block.parent))
            return super.statements(list, indent);
        const bindings: { name: ts.Identifier; storage: RecordShape }[] = [];
        for (const statement of list)
            if (ts.isVariableStatement(statement))
                for (const declaration of statement.declarationList
                    .declarations) {
                    const name = declaration.name;
                    const symbol = ts.isIdentifier(name)
                        ? declaredSymbol(this.checker, name)
                        : undefined;
                    if (
                        ts.isIdentifier(name) &&
                        symbol &&
                        this.captured.has(symbol)
                    )
                        bindings.push({
                            name,
                            storage: this.storageOf(declaration),
                        });
                }
        if (bindings.length === 0) return super.statements(list, indent);
        const { prolog, scope } = this.enterScope(block, bindings, indent);
        try {
            return [...prolog, ...super.statements(list, indent)];
        } finally {
            this.leaveScope(scope);
        }
    }

    /**
     * Allocate a block environment for `bindings`, enclosing the current
     * innermost one, and make it the frame's innermost scope.
     */
    private enterScope(
        owner: ts.Node,
        bindings: readonly { name: ts.Identifier; storage: RecordShape }[],
        indent: string,
    ): { prolog: string[]; scope: Environment } {
        const frame = this.frame;
        const visible = this.visibleEnvironment(frame);
        const fields: Environment["fields"] = [];
        const scope: Environment = {
            owner,
            struct: this.model.environmentName(this.entry),
            variable: this.temporary("environment"),
            fields,
            ...(visible ? { enclosing: visible.environment } : {}),
        };
        const taken = new Set(["enclosing", "gc_trace"]);
        for (const { name, storage } of bindings) {
            let field = cppIdentifier(name.text);
            while (taken.has(field)) field = `${field}_`;
            taken.add(field);
            const symbol = declaredSymbol(this.checker, name)!;
            const temporal = this.temporal(symbol, name.parent);
            fields.push({ field, storage, temporal });
            this.locals.set(symbol, {
                storage,
                captured: { scope: owner, field, temporal },
            });
        }
        this.environments.push(this.environmentStruct(scope));
        frame.scopes.push(scope);
        return {
            prolog: [
                `${indent}auto ${scope.variable} = bbl::js::make_gc_shared<${scope.struct}>();`,
                ...(visible
                    ? [
                          `${indent}${scope.variable}->enclosing = ${visible.variable};`,
                      ]
                    : []),
            ],
            scope,
        };
    }

    private leaveScope(scope: Environment): void {
        const scopes = this.frame.scopes;
        if (scopes[scopes.length - 1] !== scope)
            throw new Error("Pinned block environments left out of order.");
        scopes.pop();
    }

    /**
     * The native path from the current frame to the first environment of
     * its chain that `found` accepts.
     */
    private environmentPath(
        found: (environment: Environment) => boolean,
    ): string {
        const frame = this.frame;
        const visible = this.visibleEnvironment(frame);
        let environment = visible?.environment;
        let path = visible?.variable ?? "";
        while (environment && !found(environment)) {
            path = `${path}->enclosing`;
            environment = environment.enclosing;
        }
        if (!environment)
            return this.refuse(
                frame.node,
                "A pinned closure reads a binding outside its environments.",
            );
        return path;
    }

    /**
     * A function value from a pinned arrow, function expression, method,
     * accessor or nested function: a `bbl::js::Callback` whose invoker
     * receives the environment it closes over. `to` is the function the
     * callers see; a closure that declares fewer parameters ignores the
     * rest, as JavaScript does. An object literal's method whose body
     * reads `this` closes over an environment holding the object
     * (`literal`).
     */
    private closure(
        node: ts.FunctionLikeDeclaration,
        to: RecordShape,
        indent: string,
        literal?: { readonly owner: string; readonly shape: RecordShape },
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
            node.asteriskToken
        )
            return this.refuse(node, "Pinned generator closure.");
        const async = isAsyncFunction(node);
        if (async && to.result.kind !== "promise")
            return this.refuse(
                node,
                `Pinned async closure as ${this.cpp(to)}.`,
            );
        const outer = this.frame;
        let visible = this.visibleEnvironment(outer)?.environment;
        let visibleVariable = this.visibleEnvironment(outer)?.variable;
        // `this` in an object literal's method: the object, held by an
        // environment of its own that encloses the frame's.
        const prelude: string[] = [];
        let thisEnvironment: Environment | undefined;
        if (literal && this.readsLiteralThis(node)) {
            const variable = this.temporary("this_environment");
            thisEnvironment = {
                // Its own owner: no frame's bindings live in it.
                owner: node.parent,
                struct: this.model.environmentName(this.entry),
                variable,
                fields: [
                    { field: "self", storage: literal.shape, temporal: false },
                ],
                ...(visible ? { enclosing: visible } : {}),
            };
            this.environments.push(this.environmentStruct(thisEnvironment));
            prelude.push(
                `auto ${variable} = bbl::js::make_gc_shared<${thisEnvironment.struct}>();`,
                `${variable}->self = ${literal.owner};`,
                ...(visible
                    ? [`${variable}->enclosing = ${visibleVariable};`]
                    : []),
            );
            visible = thisEnvironment;
            visibleVariable = variable;
        }
        const received = visible
            ? { variable: this.temporary("environment"), environment: visible }
            : undefined;
        const inner = `${indent}    `;
        this.frames.push({
            node,
            returns: to.result,
            scopes: [],
            ...(received ? { received } : {}),
            ...(thisEnvironment ? { literalThis: thisEnvironment } : {}),
            ...(async ? { async: true as const } : {}),
        });
        try {
            return this.withBindings(() => {
                const parameters = this.closureParameters(
                    node,
                    to.parameters,
                    inner,
                );
                const lines = [
                    ...parameters.prolog,
                    ...this.closureBody(node, to.result, inner),
                ];
                // A coroutine keeps its own reference to the environment: a
                // reference parameter would outlive the callback's copy.
                // A closure that reads nothing of its environment still
                // holds it (the callback's identity owns it).
                const unused =
                    received !== undefined &&
                    !lines.some((line) => line.includes(received.variable));
                const signature = [
                    ...(received
                        ? [
                              `${unused ? "[[maybe_unused]] " : ""}std::shared_ptr<${received.environment.struct}>${async ? "" : "&"} ${received.variable}`,
                          ]
                        : []),
                    ...parameters.signature,
                ].join(", ");
                const lambda = `[](${signature}) -> ${this.cpp(to.result)} {\n${lines.join("\n")}\n${indent}}`;
                const value = received
                    ? `${this.cpp(to)}(bbl::js::make_closure(${visibleVariable}, ${lambda}))`
                    : `${this.cpp(to)}(${lambda})`;
                return prelude.length > 0
                    ? `[&] { ${prelude.join(" ")} return ${value}; }()`
                    : value;
            });
        } finally {
            this.frames.pop();
        }
    }

    /** Whether an object-literal method's body reads `this` (arrows inherit it). */
    private readsLiteralThis(node: ts.FunctionLikeDeclaration): boolean {
        let reads = false;
        const visit = (child: ts.Node): void => {
            if (reads) return;
            if (
                child.kind === ts.SyntaxKind.ThisKeyword &&
                this.objectMethodThis(child) === node
            )
                reads = true;
            ts.forEachChild(child, visit);
        };
        if (node.body) visit(node.body);
        return reads;
    }

    /**
     * A function literal passed to an array iteration method, as a native
     * lambda over its defining frame's own storage (`[&]`): it never
     * outlives the call that receives it.
     */
    private inlineLambda(
        node: ts.ArrowFunction | ts.FunctionExpression,
        parameters: readonly RecordShape[],
        result: RecordShape,
        body?: (indent: string) => string[],
    ): string {
        if (node.parameters.length > parameters.length)
            return this.refuse(
                node,
                "A pinned callback takes more parameters than its caller passes.",
            );
        if (isAsyncFunction(node) || node.asteriskToken)
            return this.refuse(node, "Pinned async or generator callback.");
        const outer = this.frame;
        const visible = this.visibleEnvironment(outer)?.environment;
        const visibleVariable = this.visibleEnvironment(outer)?.variable;
        const indent = this.closureIndent();
        const inner = `${indent}    `;
        this.frames.push({
            node,
            returns: result,
            scopes: [],
            inline: true,
            ...(visible && visibleVariable
                ? {
                      received: {
                          variable: visibleVariable,
                          environment: visible,
                      },
                  }
                : {}),
            ...(outer.literalThis ? { literalThis: outer.literalThis } : {}),
        });
        try {
            return this.withBindings(() => {
                const bound = this.closureParameters(node, parameters, inner);
                const lines = [
                    ...bound.prolog,
                    ...(body?.(inner) ?? this.closureBody(node, result, inner)),
                ];
                return `[&](${bound.signature.join(", ")}) -> ${this.cpp(result)} {\n${lines.join("\n")}\n${indent}}`;
            });
        } finally {
            this.frames.pop();
        }
    }

    /**
     * A closure's native parameters, one per shape its callers pass, and
     * the statements that bind what they declare: a default where the
     * argument is absent, a destructuring pattern's names.
     */
    private closureParameters(
        node: ts.FunctionLikeDeclaration,
        shapes: readonly RecordShape[],
        indent: string,
    ): { signature: string[]; prolog: string[] } {
        const prolog: string[] = [];
        const signature = shapes.map((shape, index) => {
            const parameter = node.parameters[index];
            if (!parameter)
                return `[[maybe_unused]] ${this.cpp(shape)} ${this.temporary("unused")}`;
            if (parameter.dotDotDotToken)
                return this.refuse(parameter, "Pinned rest parameter.");
            if (ts.isIdentifier(parameter.name) && !parameter.initializer)
                return `${this.read(parameter.name, node) ? "" : "[[maybe_unused]] "}${this.cpp(shape)} ${this.declare(parameter.name, shape)}`;
            const argument = this.temporary("argument");
            let local = shape;
            let value = argument;
            if (parameter.initializer) {
                local = stripOptional(shape);
                value = `${this.presentTest(argument)} ? ${this.coerce(argument, shape, local, parameter)} : ${this.convert(parameter.initializer, local)}`;
            }
            if (ts.isIdentifier(parameter.name))
                prolog.push(
                    `${indent}${this.cpp(local)} ${this.declare(parameter.name, local)} = ${value};`,
                );
            else if (ts.isObjectBindingPattern(parameter.name))
                prolog.push(
                    ...this.objectPattern(parameter.name, value, local, indent),
                );
            else
                return this.refuse(
                    parameter,
                    "Pinned closure parameter pattern.",
                );
            return `${this.cpp(shape)} ${argument}`;
        });
        return { signature, prolog };
    }

    /** A closure's statements after its parameters: its environment, then its body. */
    private closureBody(
        node: ts.FunctionLikeDeclaration,
        result: RecordShape,
        inner: string,
    ): string[] {
        const body = node.body;
        if (!body) return this.refuse(node, "Pinned closure has no body.");
        const statements = ts.isBlock(body) ? body.statements : [];
        const executed = this.hoisted(statements);
        // Leading guards run before the environment is allocated.
        const guards = this.leadingGuards(node, executed);
        const lines = [
            ...this.statements(guards, inner),
            ...this.frameProlog(node.parameters, statements, inner),
        ];
        if (ts.isBlock(body))
            lines.push(
                ...this.statements(executed.slice(guards.length), inner),
            );
        else if (this.frame.async)
            lines.push(
                ...this.collected(
                    inner,
                    () => `${inner}${this.asyncReturn(body)};`,
                ),
            );
        else if (result.kind === "void") {
            const outcome: { effect: string | null } = { effect: null };
            const collected = this.collected(inner, () => {
                outcome.effect = this.effect(this.skipParentheses(body));
                return `${inner}${outcome.effect ?? ""};`;
            });
            if (outcome.effect !== null) lines.push(...collected);
        } else
            lines.push(
                ...this.collected(
                    inner,
                    () => `${inner}return ${this.convert(body, result)};`,
                ),
            );
        return this.frame.async ? this.coroutine(node, lines, inner) : lines;
    }

    /**
     * An async body as a coroutine: it is one even without an `await`
     * (`co_await` of a ready awaiter), and a `Promise<void>` body ends by
     * fulfilling it.
     */
    private coroutine(
        node: ts.FunctionLikeDeclaration,
        lines: readonly string[],
        inner: string,
    ): string[] {
        const body = node.body;
        if (!body) return [...lines];
        // A coroutine over `js::Promise` (`js_promise.hpp`, which it brings).
        this.model.include("bblite/pinned_async.hpp");
        const statements = ts.isBlock(body) ? body.statements : [];
        const last = statements[statements.length - 1];
        const ends =
            ts.isBlock(body) &&
            this.frame.returns.kind === "promise" &&
            this.frame.returns.value.kind === "void" &&
            !(
                last &&
                (ts.isReturnStatement(last) || ts.isThrowStatement(last))
            );
        const coroutine =
            ends ||
            !ts.isBlock(body) ||
            this.containsAwait(body) ||
            this.containsOwnReturn(node);
        return [
            ...(coroutine ? [] : [`${inner}co_await std::suspend_never{};`]),
            ...lines,
            ...(ends ? [`${inner}co_return bbl::js::PromiseVoid{};`] : []),
        ];
    }

    /** The native value a promise settles with (`PromiseVoid` for `Promise<void>`). */
    private promiseValueCpp(shape: RecordShape): string {
        if (shape.kind !== "promise")
            return this.refuse(
                this.frame.node,
                "Pinned promise value of a non-promise.",
            );
        return shape.value.kind === "void"
            ? "bbl::js::PromiseVoid"
            : this.cpp(shape.value);
    }

    /** The shape a promise's fulfillment callbacks take its value as. */
    private settledShape(shape: RecordShape): RecordShape {
        if (shape.kind !== "promise")
            return this.refuse(
                this.frame.node,
                "Pinned settlement of a non-promise.",
            );
        return shape.value.kind === "void"
            ? { kind: "native", cpp: "bbl::js::PromiseVoid" }
            : shape.value;
    }

    /** `resolve` and `reject` of `new Promise<T>`: `resolve()` for `Promise<void>`. */
    private resolvingFunctions(shape: RecordShape): {
        resolve: RecordShape;
        reject: RecordShape;
    } {
        const value =
            shape.kind === "promise" ? shape.value : { kind: "void" as const };
        return {
            resolve: {
                kind: "function",
                parameters: value.kind === "void" ? [] : [value],
                result: { kind: "void" },
            },
            reject: {
                kind: "function",
                parameters: [{ kind: "error" }],
                result: { kind: "void" },
            },
        };
    }

    /**
     * `promise.then(onFulfilled, onRejected)`, `.catch(onRejected)` and
     * `.finally(onFinally)`: each reaction a callback the promise calls
     * later (a closure), with the value or the error it settled with.
     */
    private promiseMethod(
        node: ts.CallExpression,
        name: string,
        shape: RecordShape,
        receiver: string,
    ): string | undefined {
        const [first, second] = node.arguments;
        const error: RecordShape = { kind: "error" };
        const reaction = (
            argument: ts.Expression | undefined,
            parameters: readonly RecordShape[],
        ): string => {
            if (!argument)
                return this.refuse(node, `Pinned ${name} needs a callback.`);
            const result = this.callbackResult(argument);
            return this.convert(argument, {
                kind: "function",
                parameters,
                result,
            });
        };
        this.model.include("bblite/pinned_async.hpp");
        switch (name) {
            case "then":
                if (node.arguments.length > 2)
                    return this.refuse(node, "Pinned then arity.");
                return second
                    ? `${receiver}.then(${reaction(first, [this.settledShape(shape)])}, ${reaction(second, [error])})`
                    : `${receiver}.then(${reaction(first, [this.settledShape(shape)])})`;
            case "catch":
                if (node.arguments.length !== 1)
                    return this.refuse(node, "Pinned catch arity.");
                return `${receiver}.catch_error(${reaction(first, [error])})`;
            case "finally":
                if (node.arguments.length !== 1)
                    return this.refuse(node, "Pinned finally arity.");
                return `${receiver}.finally(${reaction(first, [])})`;
            default:
                return undefined;
        }
    }

    /**
     * What `await value` suspends on: a promise, an absent promise as
     * `undefined`'s, any other value as a fulfilled promise (one tick, as
     * JavaScript awaits it).
     */
    private awaited(expression: ts.Expression): string {
        if (!this.frame.async)
            return this.refuse(
                expression,
                "Pinned await outside an async function.",
            );
        const shape = this.shapeAt(expression);
        const present = stripOptional(shape);
        if (present.kind === "promise") {
            if (shape.kind !== "optional") return this.value(expression);
            if (present.value.kind !== "void")
                return this.refuse(
                    expression,
                    "Pinned await of an optional value promise.",
                );
            this.model.include("bblite/pinned_async.hpp");
            return `bbl::pinned::present_promise(${this.value(expression)})`;
        }
        if (shape.kind === "void")
            return this.refuse(expression, "Pinned await of a void value.");
        return `bbl::js::Promise<${this.cpp(shape)}>::resolved(${this.value(expression)})`;
    }

    /** Whether a function-like returns from its own body (not a nested one's). */
    private containsOwnReturn(node: ts.FunctionLikeDeclaration): boolean {
        let found = false;
        const visit = (child: ts.Node): void => {
            if (found || isFunctionLike(child)) return;
            if (ts.isReturnStatement(child)) found = true;
            else ts.forEachChild(child, visit);
        };
        if (node.body) ts.forEachChild(node.body, visit);
        return found;
    }

    /**
     * `return value` in an async function: its promise fulfills with the
     * value, or adopts a promise returned.
     */
    private asyncReturn(expression: ts.Expression | undefined): string {
        const returns = this.frame.returns;
        if (returns.kind !== "promise")
            return this.refuse(
                expression ?? this.frame.node,
                "Pinned async function without a promise result.",
            );
        if (
            !expression ||
            this.isAbsentLiteral(this.skipParentheses(expression))
        )
            return returns.value.kind === "void"
                ? "co_return bbl::js::PromiseVoid{}"
                : `co_return ${this.model.absent(returns.value, this.frame.node)}`;
        if (stripOptional(this.shapeAt(expression)).kind === "promise")
            return `co_return ${this.convert(expression, returns)}`;
        if (returns.value.kind === "void")
            return `co_return (static_cast<void>(${this.value(expression)}), bbl::js::PromiseVoid{})`;
        return `co_return ${this.convert(expression, returns.value)}`;
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
        // A library function's own parameter types are the platform's to
        // spell; the argument passes as it is.
        const parameter =
            declaration &&
            ts.isFunctionDeclaration(declaration) &&
            !declaration.getSourceFile().isDeclarationFile
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

    /**
     * The dotted name of a library global a callee or read names: `fetch`,
     * `globalThis.fetch` (`fetch`), `performance.now`.
     */
    private libraryPath(node: ts.Expression): string | undefined {
        const unwrapped = this.skipParentheses(node);
        if (ts.isIdentifier(unwrapped)) return this.libraryName(unwrapped);
        if (!ts.isPropertyAccessExpression(unwrapped)) return undefined;
        const owner = this.libraryName(unwrapped.expression);
        if (owner === undefined) return undefined;
        return owner === "globalThis"
            ? unwrapped.name.text
            : `${owner}.${unwrapped.name.text}`;
    }

    /** The platform adapter standing in for a pinned call, if one does. */
    private adapterOf(node: ts.CallExpression): CallAdapter | undefined {
        const callee = this.skipParentheses(node.expression);
        const global = this.libraryPath(callee);
        const platform =
            global !== undefined
                ? this.model.schema.globals?.get(global)
                : undefined;
        if (platform) return platform;
        const declaration =
            ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
                ? this.model.declarationOf(
                      ts.isPropertyAccessExpression(callee)
                          ? callee.name
                          : callee,
                  )
                : undefined;
        // A package the store does not carry (`text-shaper`) is keyed
        // `package#name`, by the import that names it.
        const imported = ts.isIdentifier(callee)
            ? this.packageImport(callee)
            : undefined;
        const key = declaration
            ? this.model.keyOf(declaration)
            : imported
              ? `${imported.specifier}#${imported.name}`
              : undefined;
        return (
            (key ? this.model.schema.adapters.get(key) : undefined) ??
            this.model.schema.adapters.get(callee.getText(this.source))
        );
    }

    /**
     * The package and exported name an identifier imports from a module
     * the typed program does not carry (a bare specifier).
     */
    private packageImport(
        node: ts.Identifier,
    ): { specifier: string; name: string } | undefined {
        const declaration = declaredSymbol(this.checker, node)
            ?.declarations?.[0];
        if (!declaration || !ts.isImportSpecifier(declaration))
            return undefined;
        const module = declaration.parent.parent.parent.moduleSpecifier;
        if (!ts.isStringLiteral(module) || module.text.startsWith("."))
            return undefined;
        return {
            specifier: module.text,
            name: (declaration.propertyName ?? declaration.name).text,
        };
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
        // A parameter property is also a member: its body reads it by the
        // parameter's own symbol.
        const parameter = name.parent;
        if (
            ts.isParameter(parameter) &&
            ts.isParameterPropertyDeclaration(parameter, parameter.parent)
        )
            for (const alias of this.checker.getSymbolsOfParameterPropertyDeclaration(
                parameter,
                name.text,
            ))
                this.locals.set(alias, { cpp: chosen, storage });
        return chosen;
    }

    private temporary(stem: string): string {
        this.temporaries += 1;
        const name = `${stem}_${this.temporaries}`;
        this.declared.add(name);
        return name;
    }

    protected override withBindings<T>(action: () => T): T {
        this.names.push(new Set());
        try {
            return super.withBindings(action);
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

    /**
     * Whether an expression reads a dynamic value's storage: a local or
     * parameter typed `unknown`, a member or element of one, or one under
     * a type assertion. Its shape is what the checker narrowed it to.
     */
    private jsonSource(node: ts.Node): boolean {
        if (
            ts.isParenthesizedExpression(node) ||
            ts.isNonNullExpression(node) ||
            ts.isAsExpression(node) ||
            ts.isSatisfiesExpression(node) ||
            ts.isTypeAssertionExpression(node)
        )
            return this.jsonSource(node.expression);
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(this.checker, node);
            const local = symbol ? this.locals.get(symbol) : undefined;
            return local?.storage.kind === "json";
        }
        if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            const owner = node.expression;
            if (this.jsonSource(owner)) return true;
            // A dynamic value another expression produced (a call's).
            const type = this.typeAt(owner);
            if (type.flags & ts.TypeFlags.Unknown) return true;
            const value = type.aliasTypeArguments?.[1];
            return (
                type.aliasSymbol?.name === "Record" &&
                declaredInDefaultLibrary(type.aliasSymbol) &&
                value !== undefined &&
                (value.flags & ts.TypeFlags.Unknown) !== 0
            );
        }
        return false;
    }

    /**
     * A dynamic value's shape where the checker narrowed it: a primitive a
     * `typeof` test or an assertion proved, a number tuple an assertion
     * named; anything else stays dynamic.
     */
    private jsonNarrowed(type: ts.Type, site: ts.Node): RecordShape {
        const flags = type.flags;
        if (flags & ts.TypeFlags.NumberLike) return { kind: "number" };
        if (flags & ts.TypeFlags.StringLike) return { kind: "string" };
        if (flags & ts.TypeFlags.BooleanLike) return { kind: "boolean" };
        if (
            this.checker.isTupleType(type) &&
            this.checker
                .getTypeArguments(type as ts.TypeReference)
                .every((element) => element.flags & ts.TypeFlags.NumberLike)
        )
            return this.model.shapeOf(type, site);
        return { kind: "json" };
    }

    private shapeAt(node: ts.Node): RecordShape {
        if (this.jsonSource(node))
            return this.jsonNarrowed(this.typeAt(node), node);
        if (ts.isPropertyAccessExpression(node)) {
            const global = this.libraryPath(node);
            const platform =
                global !== undefined
                    ? this.model.schema.globalValues?.get(global)
                    : undefined;
            if (platform) return platform.shape;
        }
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            // An object literal's method: the literal's record.
            const method = this.objectMethodThis(node);
            const literal = method
                ? [...this.frames]
                      .reverse()
                      .find((frame) => frame.node === method)?.literalThis
                : undefined;
            if (literal) return literal.fields[0]!.storage;
            // A class member's `this` is its instance (the checker's
            // polymorphic `this` type names no record).
            if (this.entry.owner)
                return { kind: "record", name: this.entry.owner };
        }
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(this.checker, node);
            const local = symbol ? this.locals.get(symbol) : undefined;
            if (local?.storage.kind === "record") return local.storage;
            // A function, promise or thrown value the lowering chose the
            // storage of (a promise's resolving functions, a caught error
            // the checker types `unknown`): the storage, narrowed present.
            const storage = local?.storage;
            const present = storage ? stripOptional(storage) : undefined;
            // A caught error narrowed to several classes stays the error.
            const narrowedType = this.typeAt(node);
            if (
                present?.kind === "error" &&
                narrowedType.isUnion() &&
                narrowedType.types.every(
                    (part) => (part.flags & nullishFlags) === 0,
                )
            )
                return present;
            if (
                storage &&
                present &&
                (present.kind === "function" ||
                    present.kind === "promise" ||
                    (present.kind === "error" &&
                        this.typeAt(node).flags &
                            (ts.TypeFlags.Unknown | ts.TypeFlags.Any)))
            ) {
                const type = this.typeAt(node);
                const nullish = type.isUnion()
                    ? type.types.some(
                          (part) => (part.flags & nullishFlags) !== 0,
                      )
                    : (type.flags & nullishFlags) !== 0;
                return nullish || present.kind === "error" ? storage : present;
            }
            const declaration = this.model.declarationOf(node);
            const platform = declaration
                ? this.moduleValue(declaration)
                : undefined;
            if (platform) return platform.shape;
        }
        // A numeric element read is a number whether or not it may be
        // absent: a missing element reads NaN, as `undefined` converts.
        if (ts.isElementAccessExpression(node)) {
            const owner = stripOptional(this.shapeAt(node.expression));
            if (
                owner.kind === "typed" ||
                owner.kind === "tuple" ||
                owner.kind === "arraylike" ||
                (owner.kind === "array" && owner.element.kind === "number")
            )
                return { kind: "number" };
        }
        // A call or element read inside an optional chain runs once its
        // head is present: what it returns, not the chain's `undefined`.
        if (
            (ts.isCallExpression(node) || ts.isElementAccessExpression(node)) &&
            ts.isOptionalChain(node) &&
            this.inChain(node)
        )
            return stripOptional(this.model.shapeOf(this.typeAt(node), node));
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
                        : stripOptional(member.shape);
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
        node = this.skipParentheses(node);
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(this.checker, node);
            const local = symbol ? this.locals.get(symbol) : undefined;
            if (local) return stripOptional(local.storage);
        }
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            const shape = this.shapeAt(node);
            return shape.kind === "record" ? shape : undefined;
        }
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.recordOwner(node.expression);
            const member =
                owner !== undefined
                    ? this.model.record(owner).members().get(node.name.text)
                    : undefined;
            if (member) return stripOptional(member.shape);
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
        // `[...view.slice(0, 16), position.x]`: an array of what its parts
        // hold, when they all hold one kind of element.
        if (ts.isArrayLiteralExpression(node) && node.elements.length > 0) {
            const parts = node.elements.map((element) => {
                if (!ts.isSpreadElement(element))
                    return stripOptional(this.shapeAt(element));
                const spread = stripOptional(this.shapeAt(element.expression));
                return spread.kind === "array"
                    ? spread.element
                    : spread.kind === "typed" || spread.kind === "tuple"
                      ? ({ kind: "number" } as const)
                      : undefined;
            });
            const [first] = parts;
            return first &&
                parts.every(
                    (part) => part !== undefined && this.same(part, first),
                )
                ? { kind: "array", element: first }
                : undefined;
        }
        if (ts.isAsExpression(node))
            return (
                this.model.unresolvedShape(this.typeAt(node), node) ??
                this.structuralShape(node.expression)
            );
        if (ts.isElementAccessExpression(node)) {
            const owner = stripOptional(this.shapeAt(node.expression));
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
                ? optionalOf(stripOptional(left))
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
            // `JSON.parse` returns the dynamic value a document is.
            if (
                ts.isPropertyAccessExpression(callee) &&
                callee.name.text === "parse" &&
                this.libraryName(callee.expression) === "JSON"
            )
                return { kind: "json" };
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
                const shape = stripOptional(this.shapeAt(callee));
                if (shape.kind === "function") return shape.result;
            }
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
            return this.shapeAt(node.right);
        // Arithmetic over an erased value is a number, and `+` with a
        // string operand is a string, as JavaScript's operators decide.
        if (
            ts.isBinaryExpression(node) &&
            [
                ts.SyntaxKind.PlusToken,
                ts.SyntaxKind.MinusToken,
                ts.SyntaxKind.AsteriskToken,
                ts.SyntaxKind.SlashToken,
                ts.SyntaxKind.PercentToken,
                ts.SyntaxKind.AsteriskAsteriskToken,
            ].includes(node.operatorToken.kind)
        ) {
            const operands = [node.left, node.right].map((operand) =>
                stripOptional(this.shapeAt(operand)),
            );
            if (
                node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                operands.some((shape) => shape.kind === "string")
            )
                return { kind: "string" };
            if (operands.every((shape) => shape.kind === "number"))
                return { kind: "number" };
            return undefined;
        }
        if (
            ts.isPrefixUnaryExpression(node) &&
            (node.operator === ts.SyntaxKind.MinusToken ||
                node.operator === ts.SyntaxKind.PlusToken) &&
            stripOptional(this.shapeAt(node.operand)).kind === "number"
        )
            return { kind: "number" };
        if (ts.isPropertyAccessExpression(node)) {
            const owner = stripOptional(this.shapeAt(node.expression));
            if (owner.kind === "record")
                return this.model.member(owner.name, node.name.text, node)
                    .shape;
            // A collection's or string's length is a number.
            if (
                (node.name.text === "length" &&
                    ["array", "typed", "tuple", "string"].includes(
                        owner.kind,
                    )) ||
                (node.name.text === "size" &&
                    (owner.kind === "map" || owner.kind === "set"))
            )
                return { kind: "number" };
            return undefined;
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionEqualsToken
        )
            return stripOptional(this.place(node.left).storage);
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression)
        ) {
            const receiver = stripOptional(
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
            if (from.kind === "optional") {
                if (this.coerce(value, from.value, to.value, site) === value)
                    return value;
                // The present value converted, the absent one kept absent
                // (`depthStencil` built as a literal or `undefined`).
                const held = this.temporary("optional");
                const present = this.coerce(
                    this.model.representations.present(held, from),
                    from.value,
                    to,
                    site,
                );
                return `[&](const auto& ${held}) -> ${this.cpp(to)} { if (!bbl::pinned::truthy_object(${held})) return ${this.model.absent(to, site)}; return ${present}; }(${value})`;
            }
            const inner = this.coerce(value, from, to.value, site);
            // A handle is its own optional.
            return this.model.representations.nullable(to.value)
                ? inner
                : `${this.cpp(to)}(${inner})`;
        }
        // A dynamic value the checker narrowed is read as what it holds,
        // asserted; a primitive passed where `unknown` is taken is wrapped.
        if (from.kind === "json") {
            this.model.include("bblite/pinned_json.hpp");
            const target = stripOptional(to);
            const narrowed =
                target.kind === "number"
                    ? `bbl::pinned::json_number(${value})`
                    : target.kind === "string"
                      ? `bbl::pinned::json_string(${value})`
                      : target.kind === "boolean"
                        ? `bbl::pinned::json_boolean(${value})`
                        : target.kind === "tuple"
                          ? `bbl::pinned::json_tuple<${target.elements.length}>(${value})`
                          : undefined;
            if (narrowed !== undefined)
                return this.coerce(narrowed, target, to, site);
        }
        if (to.kind === "json") {
            this.model.include("bblite/pinned_json.hpp");
            const present = stripOptional(from);
            if (
                present.kind === "number" ||
                present.kind === "string" ||
                present.kind === "boolean"
            )
                return `bbl::js::json_value(${value})`;
        }
        // Thrown values: an authored Error instance is the error it is
        // thrown as; an error in an `unknown` slot is the dynamic value
        // holding it, and a dynamic value thrown is its error.
        const errorClass = (shape: RecordShape): boolean =>
            shape.kind === "record" && this.model.errorClass(shape.name);
        if (to.kind === "error" && errorClass(from)) {
            this.model.include("bblite/pinned_values.hpp");
            return `bbl::pinned::class_error(${value})`;
        }
        if (from.kind === "error" && to.kind === "record" && errorClass(to)) {
            this.model.include("bblite/pinned_values.hpp");
            return `bbl::pinned::error_instance<bbl::${this.model.record(to.name).spec.cpp}>(${value})`;
        }
        if (from.kind === "error" && to.kind === "json") {
            this.model.include("bblite/pinned_json.hpp");
            return `bbl::pinned::json_error(${value})`;
        }
        if (from.kind === "json" && to.kind === "error") {
            this.model.include("bblite/pinned_json.hpp");
            return `bbl::pinned::error_of(${value})`;
        }
        if (to.kind === "json" && errorClass(from))
            return this.coerce(
                this.coerce(value, from, { kind: "error" }, site),
                { kind: "error" },
                to,
                site,
            );
        if (from.kind === "optional") {
            const present = this.model.representations.present(value, from);
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
        // A function passed where callers pass more arguments ignores the
        // rest, as JavaScript's does (`then(resolve)` of a void promise).
        // The function receives each argument as its own parameter type (a
        // caught error as the `unknown` it declares) and its result is
        // the caller's.
        if (
            from.kind === "function" &&
            to.kind === "function" &&
            from.parameters.length <= to.parameters.length &&
            (from.parameters.length < to.parameters.length ||
                from.parameters.some(
                    (parameter, index) =>
                        !this.same(parameter, to.parameters[index]!),
                ) ||
                (!this.same(from.result, to.result) &&
                    to.result.kind !== "void"))
        ) {
            const parameters = to.parameters.map(
                (parameter, index) =>
                    `[[maybe_unused]] ${this.cpp(parameter)} argument_${index}`,
            );
            const call = `std::get<0>(captured)(${from.parameters
                .map((parameter, index) =>
                    this.coerce(
                        `argument_${index}`,
                        to.parameters[index]!,
                        parameter,
                        site,
                    ),
                )
                .join(", ")})`;
            const body =
                to.result.kind === "void"
                    ? `static_cast<void>(${call});`
                    : `return ${this.coerce(call, from.result, to.result, site)};`;
            return `${this.cpp(to)}(bbl::js::make_closure(std::tuple{${value}}, [](auto& captured${parameters.map((parameter) => `, ${parameter}`).join("")}) -> ${this.cpp(to.result)} { ${body} }))`;
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
        // A promise where `Promise<unknown>` is taken: the same promise (its
        // identity and reactions), its result read as the dynamic value.
        if (
            from.kind === "promise" &&
            to.kind === "promise" &&
            to.value.kind === "json" &&
            ["void", "number", "string", "boolean"].includes(from.value.kind)
        ) {
            this.model.include("bblite/pinned_json.hpp");
            const result =
                from.value.kind === "void"
                    ? "bbl::js::JsonValue{}"
                    : "bbl::js::json_value(result)";
            return `${this.cpp(to)}::view(${value}, []([[maybe_unused]] const auto& result) { return ${result}; })`;
        }
        if (
            to.kind === "arraylike" &&
            (from.kind === "typed" ||
                from.kind === "tuple" ||
                (from.kind === "array" && from.element.kind === "number"))
        ) {
            this.model.include("bblite/pinned_values.hpp");
            return `bbl::pinned::NumberArrayLike(${value})`;
        }
        // A literal's anonymous record where a platform dictionary is taken
        // (`buffer: dynamicUniform`): the dictionary of the members the
        // literal has, as WebGPU reads a dictionary when it is passed.
        if (
            to.kind === "record" &&
            from.kind === "record" &&
            this.model.isLiteralRecord(from.name) &&
            this.model.record(to.name).spec.native &&
            !this.model.record(to.name).spec.reference
        ) {
            const target = this.model.record(to.name);
            const source = this.temporary("literal");
            const built = this.temporary("dictionary");
            const writes = [...this.model.record(from.name).members().values()]
                .filter((member) => member.storage === "field")
                .map((member) => {
                    const destination = target.members().get(member.name);
                    if (!destination)
                        return this.refuse(
                            site,
                            `Pinned ${to.name} has no member '${member.name}' the literal sets.`,
                        );
                    return `${destination.access(built)} = ${this.coerce(member.access(source), member.shape, destination.shape, site)};`;
                });
            return `[&](const auto& ${source}) { bbl::${target.spec.cpp} ${built}{}; ${writes.join(" ")} return ${built}; }(${value})`;
        }
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
        const ordered = this.orderedOperand(
            node,
            () => `convert ${this.cpp(to)}`,
            () => this.cpp(to),
            () => this.convert(node, to),
        );
        if (ordered !== undefined) return ordered;
        let unwrapped = this.skipParentheses(node);
        // A literal under `satisfies T` is built as the sink takes it: the
        // check names its type, not its storage.
        while (ts.isSatisfiesExpression(unwrapped)) {
            const inner = this.skipParentheses(unwrapped.expression);
            if (
                !ts.isObjectLiteralExpression(inner) &&
                !ts.isArrayLiteralExpression(inner) &&
                !ts.isSatisfiesExpression(inner)
            )
                break;
            unwrapped = inner;
        }
        if (this.isAbsentLiteral(unwrapped))
            return this.model.absent(to, unwrapped);
        if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped))
            return this.closure(
                unwrapped,
                stripOptional(to),
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
        // `Array.from(x)` (or `Array.from(x) as [number, number, number]`)
        // builds what the sink holds.
        const fromCall =
            ts.isAsExpression(unwrapped) &&
            isArrayFromCall(
                this.skipParentheses(unwrapped.expression),
                this.model.checker,
            )
                ? this.skipParentheses(unwrapped.expression)
                : unwrapped;
        if (isArrayFromCall(fromCall, this.model.checker)) {
            const target = stripOptional(to);
            if (target.kind === "array" || target.kind === "tuple")
                return this.coerce(
                    this.arrayFrom(fromCall, target),
                    target,
                    to,
                    fromCall,
                );
        }
        // `Promise.resolve(value)` / `Promise.reject(reason)` settle the
        // promise type the sink holds (`Promise.reject` is `Promise<never>`).
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            ["resolve", "reject"].includes(unwrapped.expression.name.text) &&
            this.libraryName(unwrapped.expression.expression) === "Promise" &&
            stripOptional(to).kind === "promise"
        )
            return this.coerce(
                this.callValue(unwrapped, false, stripOptional(to)),
                stripOptional(to),
                to,
                unwrapped,
            );
        // `list.map(...)` / `list.reduce(...)` build what the sink holds:
        // the callback returns the sink's element (an object literal's
        // record), the accumulator is the sink's.
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            ["map", "reduce"].includes(unwrapped.expression.name.text) &&
            !ts.isOptionalChain(unwrapped)
        ) {
            const target = stripOptional(to);
            const receiver = stripOptional(
                this.shapeAt(unwrapped.expression.expression),
            );
            if (
                (receiver.kind === "array" || receiver.kind === "json") &&
                (unwrapped.expression.name.text === "reduce" ||
                    target.kind === "array")
            )
                return this.coerce(
                    this.callValue(unwrapped, false, target),
                    target,
                    to,
                    unwrapped,
                );
        }
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
        const ordered = this.orderedOperand(
            expression,
            () => "value",
            () => this.cpp(this.shapeAt(expression)),
            () => this.renderExpression(expression).text,
        );
        if (ordered !== undefined) return cppPrimary(ordered);
        // A binary operator's operands, in source order.
        const binary = this.skipParentheses(expression);
        if (
            ts.isBinaryExpression(binary) &&
            !this.sequencing.has(binary) &&
            !NONSEQUENCED_BINARY_OPERATORS.has(binary.operatorToken.kind) &&
            !(
                binary.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                binary.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            ) &&
            this.orderPlan([binary.left, binary.right], "unordered")
        )
            return cppPrimary(
                this.sequenced(
                    binary,
                    [binary.left, binary.right],
                    () => this.renderExpression(expression).text,
                ),
            );
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
            if (ts.isArrayLiteralExpression(inner))
                return cppPrimary(
                    this.arrayLiteral(inner, this.shapeAt(expression)),
                );
            // An assertion over a dynamic value reads what it asserts.
            if (this.jsonSource(inner))
                return cppPrimary(
                    this.coerce(
                        this.value(inner),
                        this.shapeAt(inner),
                        this.shapeAt(expression),
                        expression,
                    ),
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

    protected override stringExpression(expression: ts.Expression): string {
        return this.convert(expression, { kind: "string" });
    }

    /** Everything that is not JavaScript arithmetic over numbers. */
    private typed(node: ts.Expression): string | undefined {
        const substituted = this.substitutions.get(node);
        if (substituted !== undefined) return substituted;
        const ordered = this.orderedOperand(
            node,
            () => "value",
            () => this.cpp(this.shapeAt(node)),
            () => this.renderExpression(node).text,
        );
        if (ordered !== undefined) return ordered;
        // An assertion over a dynamic value reached through grouping
        // (`(value as number) < m`) reads what it asserts.
        if (
            (ts.isAsExpression(node) ||
                ts.isSatisfiesExpression(node) ||
                ts.isTypeAssertionExpression(node) ||
                ts.isNonNullExpression(node)) &&
            this.jsonSource(node.expression)
        )
            return this.renderExpression(node).text;
        if (ts.isIdentifier(node)) return this.identifier(node);
        if (ts.isAwaitExpression(node))
            return `(co_await ${this.awaited(node.expression)})`;
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            // An object literal's method: the object its environment holds.
            const method = this.objectMethodThis(node);
            if (method) {
                const owner = [...this.frames]
                    .reverse()
                    .find((frame) => frame.node === method)?.literalThis;
                if (!owner)
                    return this.refuse(
                        node,
                        "Pinned `this` of a method outside its object literal.",
                    );
                return `${this.environmentPath((environment) => environment === owner)}->self`;
            }
            // A class member's instance, through the inline callbacks that
            // share its frame.
            const self = this.frames[0]!.self;
            if (!self || this.frames.slice(1).some((frame) => !frame.inline))
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
                        this.model.variableCpp(variable),
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
                this.model.variableCpp(variable),
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
        return key !== undefined &&
            (ts.isVariableDeclaration(declaration) ||
                ts.isImportClause(declaration))
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
            return this.coerce(cpp, storage, stripOptional(storage), node);
        return this.coerce(cpp, storage, at, node);
    }

    private hasNever(shape: RecordShape): boolean {
        return shape.kind === "array" && shape.element.kind === "void";
    }

    private template(node: ts.TemplateExpression): string {
        return this.sequenced(
            node,
            node.templateSpans.map((span) => span.expression),
            () => this.unorderedTemplate(node),
        );
    }

    /** A template literal's parts, its substitutions already in order (`template`). */
    private unorderedTemplate(node: ts.TemplateExpression): string {
        const parts: string[] = [];
        if (node.head.text) parts.push(stringLiteral(node.head.text));
        for (const span of node.templateSpans) {
            const shape = this.shapeAt(span.expression);
            const value = this.value(span.expression);
            const present = stripOptional(shape);
            const textual =
                present.kind === "number" ||
                present.kind === "string" ||
                present.kind === "boolean" ||
                present.kind === "json";
            if (shape.kind !== "number" && shape.kind !== "string" && textual)
                this.model.include(
                    present.kind === "json"
                        ? "bblite/pinned_json.hpp"
                        : "bblite/pinned_values.hpp",
                );
            parts.push(
                shape.kind === "number"
                    ? `bbl::js::NumberPart(${value})`
                    : shape.kind === "string"
                      ? value
                      : textual
                        ? `bbl::pinned::template_part(${value})`
                        : this.refuse(span.expression, "Pinned template part."),
            );
            if (span.literal.text) parts.push(stringLiteral(span.literal.text));
        }
        return `bbl::js::concat(${parts.map((part) => (part.startsWith('"') ? `std::string_view(${part})` : part)).join(", ")})`;
    }

    // ── Truthiness and comparisons ──────────────────────────────────────

    /** A statement's condition, without the grouping its operator carries. */
    protected override condition(node: ts.Expression): string {
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
        return this.model.representations.truthy(value, shape);
    }

    private binaryValue(node: ts.BinaryExpression): string | undefined {
        const kind = node.operatorToken.kind;
        // `a = b` as a value (`m[0] = m[5] = 1`): the stored value, once.
        if (kind === ts.SyntaxKind.EqualsToken)
            return this.sequenced(
                node,
                [...this.targetOperands(node.left), node.right],
                () => {
                    const place = this.place(node.left);
                    const type = this.cpp(place.storage);
                    const assigned = this.temporary("assigned");
                    return `[&]() -> ${type} { ${type} ${assigned} = ${this.convert(node.right, place.storage)}; ${place.store(assigned)}; return ${assigned}; }()`;
                },
            );
        if (kind === ts.SyntaxKind.QuestionQuestionToken)
            return this.nullish(node, this.shapeAt(node));
        if (
            kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            kind === ts.SyntaxKind.BarBarToken
        ) {
            const result = this.shapeAt(node);
            if (result.kind === "boolean") return this.truthy(node);
            // `a || b` / `a && b` as a value: the left operand, evaluated
            // once, unless its truthiness selects the right one.
            const leftShape = this.shapeAt(node.left);
            const left = this.temporary("left");
            const test = this.model.representations.truthy(left, leftShape);
            const keep = kind === ts.SyntaxKind.BarBarToken ? test : `!${test}`;
            const type = this.cpp(result);
            return `[&]() -> ${type} { auto ${left} = ${this.value(node.left)}; if (${keep}) return ${this.coerce(left, leftShape, result, node.left)}; return ${this.convert(node.right, result)}; }()`;
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
        if (kind === ts.SyntaxKind.InstanceOfKeyword)
            return this.instanceOf(node);
        if (
            kind === ts.SyntaxKind.PlusToken &&
            this.shapeAt(node).kind === "string"
        ) {
            const part = (operand: ts.Expression): string => {
                const value = this.value(operand);
                if (stripOptional(this.shapeAt(operand)).kind === "number")
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
        const dynamic = (side: ts.Expression): boolean =>
            !this.isAbsentLiteral(side) && this.shapeAt(side).kind === "json";
        if (dynamic(left) || dynamic(right)) {
            const test = this.jsonEquality(node, left, right);
            return negated ? `!${test}` : test;
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
                this.model.representations.nullable(shape)
                    ? `!bbl::pinned::truthy_object(${this.value(absentSide)})`
                    : "false";
            return negated ? `!(${test})` : test;
        }
        const leftShape = this.shapeAt(left);
        const rightShape = this.shapeAt(right);
        if (leftShape.kind === "number" && rightShape.kind === "number")
            return undefined;
        // An optional string against a literal (`x?.y === "a"`): the
        // literal as the string it is, so the optional compares its value.
        const literal = (side: ts.Expression): string =>
            ts.isStringLiteral(side)
                ? `std::string(${this.value(side)})`
                : this.value(side);
        const comparison =
            leftShape.kind === "optional" || rightShape.kind === "optional"
                ? `(${literal(left)} == ${literal(right)})`
                : `(${this.value(left)} == ${this.value(right)})`;
        return negated ? `!${comparison}` : comparison;
    }

    /**
     * `value instanceof C` over a thrown value: the library's Error
     * classes by their name, an authored `class extends Error` by its
     * native record, a platform class (`DOMException`) by its schema test.
     */
    private instanceOf(node: ts.BinaryExpression): string {
        const target = this.skipParentheses(node.right);
        if (!ts.isIdentifier(target))
            return this.refuse(node, "Pinned instanceof of a computed class.");
        if (!this.pure(node.left))
            return this.refuse(
                node,
                "Pinned instanceof of an effectful value.",
            );
        const shape = stripOptional(this.shapeAt(node.left));
        const value = this.value(node.left);
        // The error a value holds, once it is known to hold one.
        const error = (): string => {
            if (shape.kind === "json") {
                this.model.include("bblite/pinned_json.hpp");
                return `bbl::pinned::error_of(${value})`;
            }
            return this.coerce(value, shape, { kind: "error" }, node.left);
        };
        const isError = (): string => {
            this.model.include("bblite/pinned_values.hpp");
            if (shape.kind === "json") {
                this.model.include("bblite/pinned_json.hpp");
                return `bbl::pinned::json_is_error(${value})`;
            }
            if (shape.kind === "error")
                return `bbl::pinned::is_error(${value})`;
            if (shape.kind === "record" && this.model.errorClass(shape.name))
                return `bbl::pinned::truthy_object(${value})`;
            return "false";
        };
        const library = this.libraryName(target);
        const platform =
            library !== undefined
                ? this.model.schema.instanceOf?.get(library)
                : undefined;
        if (platform) return `(${isError()} && ${platform(error())})`;
        if (library === "Error") return isError();
        if (library === "RangeError" || library === "TypeError")
            return `(${isError()} && bbl::js::error_is(${error()}, ${stringLiteral(library)}))`;
        const declaration = this.model.declarationOf(target);
        if (
            declaration &&
            ts.isClassDeclaration(declaration) &&
            declaration.name &&
            this.model.isRecordName(declaration.name.text) &&
            this.model.errorClass(declaration.name.text)
        ) {
            const record = this.model.recordKey(declaration.name.text);
            if (shape.kind === "record")
                return this.model.recordKey(shape.name) === record
                    ? `bbl::pinned::truthy_object(${value})`
                    : "false";
            return `(${isError()} && bbl::pinned::error_instance<bbl::${this.model.record(record).spec.cpp}>(${error()}) != nullptr)`;
        }
        return this.refuse(
            node,
            `Pinned instanceof ${target.text} has no native test.`,
        );
    }

    /**
     * `a === b` with a dynamic side: `undefined` and `null` apart, a
     * primitive by value, an object by identity. A loose comparison is
     * admitted against `null`/`undefined` only (either one).
     */
    private jsonEquality(
        node: ts.BinaryExpression,
        left: ts.Expression,
        right: ts.Expression,
    ): string {
        this.model.include("bblite/pinned_json.hpp");
        const strict =
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind ===
                ts.SyntaxKind.ExclamationEqualsEqualsToken;
        const [json, other] =
            !this.isAbsentLiteral(left) && this.shapeAt(left).kind === "json"
                ? [left, right]
                : [right, left];
        const value = this.value(json);
        if (this.isAbsentLiteral(other)) {
            if (!strict)
                return `(${value}.is_undefined() || ${value}.is_null())`;
            return other.kind === ts.SyntaxKind.NullKeyword
                ? `${value}.is_null()`
                : `${value}.is_undefined()`;
        }
        if (!strict)
            return this.refuse(
                node,
                "Pinned loose comparison of a dynamic value.",
            );
        const otherShape = stripOptional(this.shapeAt(other));
        if (
            otherShape.kind !== "json" &&
            otherShape.kind !== "number" &&
            otherShape.kind !== "string" &&
            otherShape.kind !== "boolean"
        )
            return this.refuse(
                node,
                `Pinned comparison of a dynamic value with ${this.cpp(otherShape)}.`,
            );
        return `${value}.strict_equals(${this.convert(other, otherShape)})`;
    }

    private typeofTest(operand: ts.Expression, expected: string): string {
        const shape = this.shapeAt(operand);
        if (shape.kind === "json") {
            this.model.include("bblite/pinned_json.hpp");
            return `(${this.value(operand)}.type_of() == ${stringLiteral(expected)})`;
        }
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
            !this.model.representations.nullable(leftShape)
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
        const stored = stripOptional(place.storage);
        return `bbl::pinned::nullish_assign(${place.cpp}, [&]() -> ${this.cpp(stored)} { return ${this.convert(node.right, stored)}; })`;
    }

    // ── Reads ───────────────────────────────────────────────────────────

    /** The record a member is read from, through a present optional. */
    private ownerShape(owner: ts.Expression): RecordShape {
        return stripOptional(this.shapeAt(owner));
    }

    private propertyRead(
        node: ts.PropertyAccessExpression,
        chained = false,
    ): string {
        if (!chained && ts.isOptionalChain(node) && !this.inChain(node))
            return this.optionalChain(node);
        const name = node.name.text;
        const owner = node.expression;
        // A platform global read as a value (`globalThis.fetch`).
        const global = this.libraryPath(node);
        const platformValue =
            global !== undefined
                ? this.model.schema.globalValues?.get(global)
                : undefined;
        if (platformValue)
            return this.narrowed(platformValue.cpp, platformValue.shape, node);
        const constant = this.constant(node);
        if (constant !== undefined) return doubleCpp(constant);
        // An enum member (`const enum` included) is its value.
        const member = this.checker.getConstantValue(node);
        if (typeof member === "number") return doubleCpp(member);
        if (typeof member === "string")
            return `std::string(${stringLiteral(member)})`;
        const numericConstant = numberConstant(node, (expression) =>
            libraryGlobal(this.checker, expression),
        );
        if (numericConstant !== undefined) return doubleCpp(numericConstant);
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
                if (name === "length") return `${shape.elements.length}.0`;
                break;
            case "string":
                if (name === "length")
                    return (
                        this.stringView(owner, "length") ??
                        `bbl::js::string_length(${value()})`
                    );
                break;
            case "buffer":
                if (name === "byteLength")
                    return `static_cast<double>(${value()}.byte_length())`;
                break;
            case "dataview":
                if (name === "byteLength" || name === "byteOffset")
                    return `static_cast<double>(${value()}.${name === "byteLength" ? "byte_length" : "byte_offset"}())`;
                if (name === "buffer") return `${value()}.buffer()`;
                break;
            case "arraylike":
                if (name === "length")
                    return `static_cast<double>(${value()}.size())`;
                break;
            case "error":
                // A thrown error's `message`, `name` and `cause`.
                if (name === "message" || name === "name")
                    return `bbl::js::error_${name}(${value()})`;
                if (name === "cause")
                    return this.narrowed(
                        `bbl::js::error_cause(${value()})`,
                        { kind: "error" },
                        node,
                    );
                break;
            case "json":
                // A member of a dynamic value: `undefined` where it has
                // none, a TypeError on a nullish owner, as JavaScript reads.
                this.model.include("bblite/pinned_json.hpp");
                return this.narrowed(
                    `${value()}.read_property(${stringLiteral(name)})`,
                    { kind: "json" },
                    node,
                );
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
        return this.model.representations.present(value, shape);
    }

    private elementRead(
        node: ts.ElementAccessExpression,
        chained = false,
    ): string {
        if (!chained && ts.isOptionalChain(node) && !this.inChain(node))
            return this.optionalChain(node);
        const shape = this.ownerShape(node.expression);
        const owner = this.presentValue(node.expression);
        const index = this.value(node.argumentExpression);
        switch (shape.kind) {
            case "array": {
                const element = shape.element;
                if (element.kind === "number")
                    return `bbl::js::number_at(${owner}, ${index})`;
                // A value element the pin may find absent reads `undefined`
                // past the end.
                const at = this.shapeAt(node);
                if (
                    at.kind === "optional" &&
                    !this.model.representations.nullable(stripOptional(element))
                )
                    return `bbl::pinned::array_at_optional(${owner}, ${index})`;
                // A reference reads null past the end, as `undefined` is
                // null in this model; a value element proven present reads
                // its default only where the pin already failed.
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
            case "arraylike":
                this.model.include("bblite/pinned_values.hpp");
                return `bbl::pinned::array_like_get(${owner}, ${index})`;
            case "json": {
                this.model.include("bblite/pinned_json.hpp");
                const key = stripOptional(
                    this.shapeAt(node.argumentExpression),
                );
                return this.narrowed(
                    key.kind === "string"
                        ? `${owner}.read_property(${index})`
                        : `${owner}.read_index(${index})`,
                    { kind: "json" },
                    node,
                );
            }
            case "record":
                return this.keyedMemberRead(node, shape.name, owner);
            default:
                return this.refuse(node, "Pinned element read of a non-array.");
        }
    }

    /**
     * The members a computed key names on a record: the string literals
     * of its type (`refs[key]` where `key` is `"pinCount" | ...`), each a
     * member of one native type.
     */
    private keyedMembers(
        node: ts.ElementAccessExpression,
        record: string,
    ): ResolvedMember[] {
        const type = this.typeAt(node.argumentExpression);
        const literals = (type.isUnion() ? type.types : [type]).map((part) =>
            part.isStringLiteral()
                ? part.value
                : this.refuse(
                      node.argumentExpression,
                      "Pinned computed member key is not a union of string literals.",
                  ),
        );
        const members = literals.map((name) =>
            this.model.member(record, name, node),
        );
        const first = members[0];
        if (
            !first ||
            members.some(
                (member) =>
                    this.cpp(member.shape) !== this.cpp(first.shape) ||
                    member.storage !== "field",
            )
        )
            return this.refuse(
                node,
                "Pinned computed members differ in native type or are not fields.",
            );
        return members;
    }

    /** `record[key]` over a union of literal member names: the named field. */
    private keyedMemberRead(
        node: ts.ElementAccessExpression,
        record: string,
        owner: string,
    ): string {
        const members = this.keyedMembers(node, record);
        const type = this.cpp(members[0]!.shape);
        const key = this.temporary("key");
        const holder = this.temporary("owner");
        const arms = members
            .map(
                (member) =>
                    `if (${key} == ${stringLiteral(member.name)}) return ${member.access(holder)};`,
            )
            .join(" ");
        return this.narrowed(
            `[&]() -> ${type} { const auto& ${holder} = ${owner}; const std::string ${key} = ${this.convert(node.argumentExpression, { kind: "string" })}; ${arms} throw std::logic_error("Pinned computed member key outside its type."); }()`,
            members[0]!.shape,
            node,
        );
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
        const headShape = this.shapeAt(head);
        // An effectful head (`list.find(f)?.id`) is evaluated once.
        if (!this.pure(head)) {
            const held = this.temporary("chain");
            const evaluated = ts.isOptionalChain(head)
                ? this.optionalChain(head)
                : this.value(head);
            const result = this.shapeAt(node);
            this.substitutions.set(
                head,
                this.model.representations.present(held, headShape),
            );
            let inner: string;
            try {
                inner = this.chainRest(node);
            } finally {
                this.substitutions.delete(head);
            }
            if (result.kind === "void")
                return `[&] { auto ${held} = ${evaluated}; if (bbl::pinned::truthy_object(${held})) ${inner}; }()`;
            return `[&]() -> ${this.cpp(result)} { auto ${held} = ${evaluated}; if (!bbl::pinned::truthy_object(${held})) return ${this.model.absent(result, node)}; return ${this.coerce(inner, this.chainShape(node), result, node)}; }()`;
        }
        const headValue = ts.isOptionalChain(head)
            ? this.optionalChain(head)
            : this.value(head);
        const present = this.model.representations.present(
            headValue,
            headShape,
        );
        const result = this.shapeAt(node);
        this.substitutions.set(head, present);
        let inner: string;
        try {
            inner = this.chainRest(node);
        } finally {
            this.substitutions.delete(head);
        }
        const innerShape = this.chainShape(node);
        // `owner?.method()` returning nothing: the call when present.
        if (result.kind === "void")
            return `(bbl::pinned::truthy_object(${headValue}) ? static_cast<void>(${inner}) : static_cast<void>(0))`;
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
        if (ts.isElementAccessExpression(node))
            return this.elementRead(node, true);
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
        return stripOptional(this.shapeAt(node));
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

    // ── Evaluation order ────────────────────────────────────────────────

    /**
     * The operands a form must evaluate ahead of itself, by index, or none.
     * Which operands another one's evaluation could overtake is the entry
     * compiler's own analysis (`EvaluationOrder.operandsToPin`, over the
     * pinned bodies the operands call); only where the temporaries go is
     * this lowering's. In an unordered form, every operand a later one
     * conflicts with; in any form, an awaited operand (a lambda cannot hold
     * a `co_await`), with every such operand before it.
     */
    private orderPlan(
        operands: readonly ts.Expression[],
        order: OperandOrder,
    ): Set<number> | undefined {
        if (operands.length === 0) return undefined;
        const awaited = operands.map((operand) => this.containsAwait(operand));
        if (order === "ordered" && !awaited.some((awaits) => awaits))
            return undefined;
        const pinned = this.model.evaluationOrder.operandsToPin(operands);
        const hoisted = new Set<number>();
        if (order === "unordered")
            pinned.forEach((pin, index) => {
                if (pin) hoisted.add(index);
            });
        awaited.forEach((awaits, index) => {
            if (awaits && (operands.length > 1 || order === "ordered"))
                hoisted.add(index);
        });
        if (hoisted.size === 0) return undefined;
        const latest = Math.max(...hoisted);
        pinned.forEach((pin, index) => {
            if (pin && index < latest) hoisted.add(index);
        });
        return hoisted;
    }

    /**
     * A form over `operands` whose native spelling may not evaluate them
     * in source order (`orderPlan`): the operands that must run first are
     * evaluated into temporaries, in order, before the form reads them --
     * inside an immediately invoked lambda, or, when an operand awaits,
     * through declared temporaries the comma operator assigns in order.
     * Operands that touch nothing another one changes stay inline, so
     * effect-free code is spelled as before. A `receiver` the form spells
     * as its own postfix operand (`owner->method(...)`), which C++ already
     * evaluates first, is put back.
     */
    private sequenced(
        form: ts.Node,
        operands: readonly ts.Expression[],
        render: () => string,
        order: OperandOrder = "unordered",
        receiver?: ts.Expression,
    ): string {
        if (this.sequencing.has(form)) return render();
        const plan = this.orderPlan(operands, order);
        if (!plan) return render();
        const slots: (OrderedSlot | undefined)[] = operands.map(
            (operand, index) => {
                if (!plan.has(index)) return undefined;
                const slot: OrderedSlot = {};
                this.slots.set(this.skipParentheses(operand), slot);
                return slot;
            },
        );
        this.sequencing.add(form);
        let text: string;
        try {
            text = render();
        } finally {
            this.sequencing.delete(form);
            operands.forEach((operand, index) => {
                if (plan.has(index))
                    this.slots.delete(this.skipParentheses(operand));
            });
        }
        const used = slots.filter(
            (
                slot,
            ): slot is OrderedSlot & {
                name: string;
                init: string;
                type: () => string;
            } =>
                slot?.name !== undefined &&
                slot.init !== undefined &&
                slot.type !== undefined,
        );
        // A receiver hoisted alone: C++ evaluates a postfix receiver before
        // the arguments, so the form keeps it in place.
        const first = used[0];
        if (
            first &&
            used.length === 1 &&
            receiver !== undefined &&
            slots[0] === first &&
            operands[0] === receiver &&
            (text.startsWith(`${first.name}.`) ||
                text.startsWith(`${first.name}->`))
        ) {
            text = `${first.init}${text.slice(first.name.length)}`;
            used.shift();
        }
        if (used.length === 0) return text;
        if (
            !used.some((slot) => slot.init.includes("co_await")) &&
            !text.includes("co_await")
        )
            return `[&] { ${used.map((slot) => `auto ${slot.name} = ${slot.init};`).join(" ")} return ${text}; }()`;
        const prelude = this.preludes[this.preludes.length - 1];
        if (!prelude)
            return this.refuse(
                form,
                "A pinned awaited operand outside a statement.",
            );
        prelude.push(...used.map((slot) => `${slot.type()} ${slot.name}{};`));
        return `(${used.map((slot) => `static_cast<void>(${slot.name} = ${slot.init})`).join(", ")}, ${text})`;
    }

    /** `sequenced` over a form that may decline to lower (`undefined`). */
    private sequencedOptional(
        form: ts.Node,
        operands: readonly ts.Expression[],
        render: () => string | undefined,
        order: OperandOrder = "unordered",
    ): string | undefined {
        let declined = false;
        const text = this.sequenced(
            form,
            operands,
            () => {
                const rendered = render();
                if (rendered === undefined) declined = true;
                return rendered ?? "";
            },
            order,
        );
        return declined ? undefined : text;
    }

    /**
     * An operand `sequenced` evaluates ahead: its temporary, its value
     * rendered once, in the representation (`via`) the form first reads it
     * in.
     */
    private orderedOperand(
        node: ts.Expression,
        via: () => string,
        type: () => string,
        render: () => string,
    ): string | undefined {
        const key = this.skipParentheses(node);
        const slot = this.slots.get(key);
        if (!slot) return undefined;
        if (slot.name === undefined) {
            this.slots.delete(key);
            try {
                slot.init = render();
            } finally {
                this.slots.set(key, slot);
            }
            slot.type = type;
            slot.via = via();
            // Its own counter: a slot the form puts back leaves every other
            // temporary's name as it was.
            this.orderedTemporaries += 1;
            slot.name = `ordered_${this.orderedTemporaries}`;
            this.declared.add(slot.name);
        } else if (slot.via !== via())
            return this.refuse(
                node,
                "A pinned ordered operand read in two representations.",
            );
        return slot.name;
    }

    /** `render`'s line, after the declarations its ordered operands need. */
    private collected(indent: string, render: () => string): string[] {
        const prelude: string[] = [];
        this.preludes.push(prelude);
        let line: string;
        try {
            line = render();
        } finally {
            this.preludes.pop();
        }
        this.refuseAwaitInLambda(this.frame.node, [line]);
        return [
            ...prelude.map((declaration) => `${indent}${declaration}`),
            line,
        ];
    }

    /** Whether a copy of a value of `shape` shares its storage, as a reference does. */
    private sharesStorage(shape: RecordShape): boolean {
        const present = stripOptional(shape);
        if (present.kind === "tuple") return false;
        if (present.kind === "record")
            return this.model.record(present.name).spec.reference;
        return true;
    }

    /** The operands a call evaluates: its receiver, then its arguments. */
    private callOperands(node: ts.CallExpression): {
        operands: ts.Expression[];
        order: OperandOrder;
        receiver?: ts.Expression;
    } {
        const args = node.arguments.map((argument) =>
            ts.isSpreadElement(argument) ? argument.expression : argument,
        );
        const callee = this.skipParentheses(node.expression);
        if (!ts.isPropertyAccessExpression(callee))
            return { operands: args, order: "unordered" };
        const library = this.libraryName(callee.expression);
        // `Object.assign(target, { ... })` writes the target, then each
        // member in order (`objectAssign`).
        if (library === "Object" && callee.name.text === "assign")
            return { operands: args, order: "ordered" };
        // A tuple receiver of a writing method is a value: a copy would
        // take the write.
        if (
            library !== undefined ||
            this.checker.isTupleType(
                this.checker.getNonNullableType(
                    this.checker.getTypeAtLocation(callee.expression),
                ),
            )
        )
            return { operands: args, order: "unordered" };
        return {
            operands: [callee.expression, ...args],
            order: "unordered",
            receiver: callee.expression,
        };
    }

    /**
     * The operands an assignment evaluates before its value: the owner and
     * key of a member or element it writes (a value owner, which the write
     * updates in place, stays where it is).
     */
    private targetOperands(target: ts.Expression): ts.Expression[] {
        const node = this.skipParentheses(target);
        if (
            !ts.isPropertyAccessExpression(node) &&
            !ts.isElementAccessExpression(node)
        )
            return [];
        const owner = this.sharesStorage(this.ownerShape(node.expression))
            ? [node.expression]
            : [];
        return ts.isElementAccessExpression(node)
            ? [...owner, node.argumentExpression]
            : owner;
    }

    /**
     * A compound assignment reads its target before its value; C++
     * evaluates the value first. Refused when the value's effects may
     * change what the target reads.
     */
    private refuseCompoundHazard(node: ts.BinaryExpression): void {
        if (
            this.model.evaluationOrder.operandsToPin([node.left, node.right])[0]
        )
            this.refuse(
                node,
                "Pinned compound assignment whose value's effects may change its target.",
            );
    }

    // ── Calls ───────────────────────────────────────────────────────────

    private callValue(
        node: ts.CallExpression,
        inChain = false,
        to?: RecordShape,
    ): string {
        if (!inChain && ts.isOptionalChain(node) && !this.inChain(node))
            return this.optionalChain(node);
        const { operands, order, receiver } = this.callOperands(node);
        return this.sequenced(
            node,
            operands,
            () => this.unorderedCall(node, to),
            order,
            receiver,
        );
    }

    /** A call, its operands already in order (`callValue`). */
    private unorderedCall(node: ts.CallExpression, to?: RecordShape): string {
        const callee = this.skipParentheses(node.expression);
        if (ts.isIdentifier(callee)) {
            const library = this.libraryFunction(node, callee);
            if (library !== undefined) return library;
        }
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
            const method = this.method(node, callee, to);
            if (method !== undefined) return method;
        }
        // A local function (a parameter, a closure, a nested function).
        if (ts.isIdentifier(callee)) {
            const symbol = declaredSymbol(this.checker, callee);
            const local = symbol ? this.locals.get(symbol) : undefined;
            // A generic closure: the instantiation this call resolves to.
            if (local?.specializations) {
                const declaration = symbol?.valueDeclaration;
                const signature =
                    declaration &&
                    ts.isVariableDeclaration(declaration) &&
                    declaration.initializer &&
                    (ts.isArrowFunction(declaration.initializer) ||
                        ts.isFunctionExpression(declaration.initializer))
                        ? this.checker.getSignatureFromDeclaration(
                              declaration.initializer,
                          )
                        : undefined;
                if (!signature)
                    return this.refuse(node, "Pinned generic closure call.");
                const variant = local.specializations.get(
                    this.instantiation(node, signature).key,
                );
                if (!variant)
                    return this.refuse(
                        node,
                        "Pinned generic closure instantiation was not lowered.",
                    );
                return this.functionValueCall(
                    node,
                    this.localCpp(variant),
                    variant.storage,
                );
            }
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
        const shape = stripOptional(storage);
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
            const argument = node.arguments[index];
            if (!this.containsAny(type)) {
                if (!argument) return undefined;
                const expected = this.model.declaredShape(type, parameter);
                if (expected.kind !== "record") return undefined;
                const actual = this.recordShapeOf(argument);
                return actual?.kind === "record" &&
                    this.cpp(actual) !== this.cpp(expected)
                    ? actual
                    : undefined;
            }
            if (this.model.unresolvedShape(type, parameter) !== undefined)
                return undefined;
            // An omitted argument takes its default, whose shape the
            // declaration gives (`plans: Iterable<Plan> = Array.from(...)`).
            if (!argument && parameter.initializer) return undefined;
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
        to?: RecordShape,
    ): string | undefined {
        const name = callee.name.text;
        const receiverNode = callee.expression;
        const library = this.libraryName(receiverNode);
        if (library !== undefined) {
            const lowered = this.libraryMethod(node, library, name, to);
            if (lowered !== undefined) return lowered;
        }
        // `Object.prototype.hasOwnProperty.call(value, key)`.
        if (
            name === "call" &&
            ts.isPropertyAccessExpression(receiverNode) &&
            receiverNode.name.text === "hasOwnProperty" &&
            ts.isPropertyAccessExpression(receiverNode.expression) &&
            receiverNode.expression.name.text === "prototype" &&
            this.libraryName(receiverNode.expression.expression) === "Object"
        )
            return this.hasOwn(node);
        const regularExpression = this.skipParentheses(receiverNode);
        if (ts.isRegularExpressionLiteral(regularExpression)) {
            if (name !== "test" || node.arguments.length !== 1)
                return this.refuse(
                    node,
                    `Pinned regular expression method '${name}'.`,
                );
            return `${this.regularExpression(regularExpression)}.test(${this.convert(node.arguments[0]!, { kind: "string" })})`;
        }
        const shape = this.ownerShape(receiverNode);
        const iterated = this.iterationMethod(node, name, shape, to);
        if (iterated !== undefined) return iterated;
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
                        return this.collectionResult(
                            `bbl::js::array_pop_or_absent(${receiver()})`,
                            element,
                        );
                    case "indexOf": {
                        // `indexOf(value, fromIndex)`: the search's start.
                        const from = node.arguments[1];
                        return `bbl::js::array_index_of(${receiver()}, ${this.convert(node.arguments[0]!, element)}${from ? `, ${this.convert(from, { kind: "number" })}` : ""})`;
                    }
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
                    case "set": {
                        const source = node.arguments[0]!;
                        const offset = node.arguments[1]
                            ? this.value(node.arguments[1])
                            : "0.0";
                        const from = stripOptional(this.shapeAt(source));
                        // Another kind of number list (`u32.set([a, b], i)`):
                        // each element converted as a store converts it.
                        if (
                            from.kind !== "typed" ||
                            from.element !== shape.element
                        ) {
                            this.model.include("bblite/pinned_array_from.hpp");
                            const values = ts.isArrayLiteralExpression(
                                this.skipParentheses(source),
                            )
                                ? this.convert(source, {
                                      kind: "array",
                                      element: { kind: "number" },
                                  })
                                : this.value(source);
                            return `bbl::pinned::typed_set(${receiver()}, ${values}, ${offset})`;
                        }
                        return `bbl::js::typed_array_set(${receiver()}, ${this.value(source)}, ${offset})`;
                    }
                    case "slice":
                        return `bbl::js::typed_array_slice(${receiver()}, ${node.arguments[0] ? this.value(node.arguments[0]) : "0.0"}, ${node.arguments[1] ? this.value(node.arguments[1]) : "std::numeric_limits<double>::infinity()"})`;
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
            case "dataview": {
                // `view.getUint32(offset, littleEndian)` and its kin.
                const read = /^get(Uint|Int|Float)(8|16|32|64)$/.exec(name);
                if (!read || node.arguments.length < 1) break;
                const [, kind, bits] = read;
                const method = `get_${kind!.toLowerCase()}${bits!}`;
                const offset = `bbl::js::buffer_view_index(${this.convert(node.arguments[0]!, { kind: "number" })})`;
                const little =
                    bits === "8"
                        ? ""
                        : `, ${node.arguments[1] ? this.truthy(node.arguments[1]) : "false"}`;
                return `static_cast<double>(${receiver()}.${method}(${offset}${little}))`;
            }
            case "map":
                switch (name) {
                    case "get":
                        return this.collectionResult(
                            `${receiver()}.get_owned(${this.convert(node.arguments[0]!, shape.key)})`,
                            shape.value,
                        );
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
                        return this.collectionResult(
                            `${receiver()}.get_owned(${this.weakKey(node.arguments[0]!)})`,
                            shape.value,
                        );
                    case "has":
                        return `${receiver()}.has(${this.weakKey(node.arguments[0]!)})`;
                    case "set":
                        return `${receiver()}.set(${this.weakKey(node.arguments[0]!)}, ${this.convert(node.arguments[1]!, shape.value)})`;
                    case "delete":
                        return `${receiver()}.erase(${this.weakKey(node.arguments[0]!)})`;
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
                    case "delete":
                        return `${receiver()}.erase(${this.convert(node.arguments[0]!, shape.element)})`;
                    case "clear":
                        return `${receiver()}.clear()`;
                    default:
                        break;
                }
                break;
            case "record": {
                const member = this.model.member(shape.name, name, callee);
                // An optional method is called where the chain proved it.
                const method = stripOptional(member.shape);
                if (method.kind === "function") {
                    const parameters = method.parameters;
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
            case "string":
                return this.stringMethod(node, name, receiverNode);
            case "promise":
                return this.promiseMethod(node, name, shape, receiver());
            case "weakset":
                switch (name) {
                    case "add":
                        return `${receiver()}.set(${this.weakKey(node.arguments[0]!)}, true)`;
                    case "has":
                        return `${receiver()}.has(${this.weakKey(node.arguments[0]!)})`;
                    case "delete":
                        return `${receiver()}.erase(${this.weakKey(node.arguments[0]!)})`;
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
     * `Array.from(source, mapper?)`: a fresh array of an array, tuple,
     * typed array or map/set view's elements, each mapped when a mapper is
     * given; `Array.from({ length: n }, mapper)` maps the indices of an
     * array-like of `undefined`s. A tuple sink takes exactly its arity.
     */
    private arrayFrom(node: ts.CallExpression, to?: RecordShape): string {
        const [source, mapper] = node.arguments;
        if (
            !source ||
            node.arguments.length > 2 ||
            node.arguments.some(ts.isSpreadElement)
        )
            return this.refuse(
                node,
                "Pinned Array.from takes a source and a mapper.",
            );
        const produced = stripOptional(to ?? this.shapeAt(node));
        const number: RecordShape = { kind: "number" };
        const element =
            produced.kind === "array"
                ? produced.element
                : produced.kind === "tuple"
                  ? number
                  : this.refuse(
                        node,
                        `Pinned Array.from into ${this.cpp(produced)}.`,
                    );
        this.model.include("bblite/pinned_array_from.hpp");
        const finish = (array: string): string =>
            produced.kind === "tuple"
                ? `bbl::pinned::array_tuple<${produced.elements.length}>(${array})`
                : array;
        const unwrapped = this.skipParentheses(source);
        if (ts.isObjectLiteralExpression(unwrapped)) {
            const [length] = unwrapped.properties;
            if (
                unwrapped.properties.length !== 1 ||
                !length ||
                !ts.isPropertyAssignment(length) ||
                length.name.getText() !== "length" ||
                !mapper
            )
                return this.refuse(
                    source,
                    "Pinned Array.from of an array-like is `{ length }` with a mapper.",
                );
            return finish(
                `bbl::pinned::array_from_length<${this.cpp(element)}>(${this.convert(length.initializer, number)}, ${this.callbackArgument(mapper, [{ kind: "json" }, number], element)})`,
            );
        }
        // A map or set view: its values (or keys) in insertion order.
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            unwrapped.arguments.length === 0
        ) {
            const view = unwrapped.expression.name.text;
            const owner = stripOptional(
                this.shapeAt(unwrapped.expression.expression),
            );
            const items =
                owner.kind === "map"
                    ? view === "values"
                        ? owner.value
                        : view === "keys"
                          ? owner.key
                          : undefined
                    : owner.kind === "set" &&
                        (view === "values" || view === "keys")
                      ? owner.element
                      : undefined;
            if (items) {
                const values = `bbl::pinned::array_from_${owner.kind === "map" ? view : "values"}(${this.presentValue(unwrapped.expression.expression)})`;
                return finish(
                    mapper
                        ? `bbl::pinned::array_map<${this.cpp(element)}>(${values}, ${this.callbackArgument(mapper, [items, number], element)})`
                        : this.coerce(
                              values,
                              { kind: "array", element: items },
                              { kind: "array", element },
                              node,
                          ),
                );
            }
        }
        const shape = stripOptional(this.shapeAt(unwrapped));
        const items =
            shape.kind === "array"
                ? shape.element
                : shape.kind === "typed" || shape.kind === "tuple"
                  ? number
                  : this.refuse(
                        source,
                        `Pinned Array.from of ${this.cpp(shape)}.`,
                    );
        const values = `bbl::pinned::array_from<${this.cpp(items)}>(${this.presentValue(unwrapped)})`;
        return finish(
            mapper
                ? `bbl::pinned::array_map<${this.cpp(element)}>(${values}, ${this.callbackArgument(mapper, [items, number], element)})`
                : this.coerce(
                      values,
                      { kind: "array", element: items },
                      { kind: "array", element },
                      node,
                  ),
        );
    }

    /**
     * `new Map(list.map((item) => [key, value]))`: every entry the mapper
     * builds first, then each set in order, as the Map constructor iterates
     * the mapped array.
     */
    private mappedEntries(
        seed: ts.Expression,
        shape: Extract<RecordShape, { kind: "map" }>,
    ): string | undefined {
        if (
            !ts.isCallExpression(seed) ||
            !ts.isPropertyAccessExpression(seed.expression) ||
            seed.expression.name.text !== "map" ||
            ts.isOptionalChain(seed) ||
            seed.arguments.length !== 1
        )
            return undefined;
        const receiver = stripOptional(
            this.shapeAt(seed.expression.expression),
        );
        const mapper = this.skipParentheses(seed.arguments[0]!);
        if (
            receiver.kind !== "array" ||
            !ts.isArrowFunction(mapper) ||
            ts.isBlock(mapper.body)
        )
            return undefined;
        const entry = this.skipParentheses(mapper.body);
        if (!ts.isArrayLiteralExpression(entry) || entry.elements.length !== 2)
            return undefined;
        const pair = `std::pair<${this.cpp(shape.key)}, ${this.cpp(shape.value)}>`;
        const lambda = this.inlineLambda(
            mapper,
            [receiver.element, { kind: "number" }],
            { kind: "native", cpp: pair },
            (indent) => [
                `${indent}return {${this.convert(entry.elements[0]!, shape.key)}, ${this.convert(entry.elements[1]!, shape.value)}};`,
            ],
        );
        const items = this.temporary("items");
        const mapped = this.temporary("mapper");
        const pairs = this.temporary("entries");
        const map = this.temporary("map");
        return `[&] { const auto ${items} = ${this.presentValue(seed.expression.expression)}; const auto ${mapped} = ${lambda}; std::vector<${pair}> ${pairs}; for (std::size_t index = 0; index < ${items}.size(); ++index) ${pairs}.push_back(${mapped}(${items}[index], static_cast<double>(index))); ${this.cpp(shape)} ${map}{}; for (auto& entry : ${pairs}) ${map}.set(std::move(entry.first), std::move(entry.second)); return ${map}; }()`;
    }

    /** The weak key a WeakMap or WeakSet files an object under. */
    private weakKey(argument: ts.Expression): string {
        if (this.shapeAt(argument).kind === "json") {
            this.model.include("bblite/pinned_json.hpp");
            return `bbl::pinned::weak_key(${this.value(argument)})`;
        }
        return `std::weak_ptr<const void>(${this.value(argument)})`;
    }

    /** The library global a receiver names (`Math`, `JSON`), not a pinned binding. */
    private libraryName(node: ts.Expression): string | undefined {
        const unwrapped = this.skipParentheses(node);
        return ts.isIdentifier(unwrapped)
            ? libraryGlobal(this.checker, unwrapped)
            : undefined;
    }

    /**
     * A static method of a library object: `Math` and `Number` through the
     * numeric lowerer (spreads and dynamic arguments here), `Object`,
     * `String.fromCharCode`, `Array.isArray`, `JSON.parse`, `console`.
     */
    private libraryMethod(
        node: ts.CallExpression,
        library: string,
        name: string,
        to?: RecordShape,
    ): string | undefined {
        const [first, second] = node.arguments;
        const spread = node.arguments.some(ts.isSpreadElement);
        switch (library) {
            case "Math": {
                if (spread) {
                    const numbers = this.spreadArguments(node);
                    if (name === "hypot")
                        return `bbl::js::hypot_js(${numbers})`;
                    if (name === "max" || name === "min")
                        return `bbl::js::math_extreme<${name === "max"}>(${numbers})`;
                    return this.refuse(
                        node,
                        `Pinned spread into Math.${name}.`,
                    );
                }
                break;
            }
            case "Number": {
                const predicate = numberPredicate(name);
                if (predicate && first && node.arguments.length === 1) {
                    const shape = this.shapeAt(first);
                    if (shape.kind === "json") {
                        this.model.include("bblite/pinned_json.hpp");
                        return `${predicate.json}(${this.value(first)})`;
                    }
                    if (shape.kind !== "number")
                        return this.refuse(
                            first,
                            `Pinned Number.${name} of ${this.cpp(shape)}.`,
                        );
                    this.model.include("bblite/pinned_values.hpp");
                    return `${predicate.number}(${this.value(first)})`;
                }
                break;
            }
            case "Object":
                if (name === "assign") return this.objectAssign(node);
                if (name === "keys" && first && node.arguments.length === 1) {
                    if (this.shapeAt(first).kind !== "json")
                        return this.refuse(
                            node,
                            "Pinned Object.keys of a non-dynamic value.",
                        );
                    this.model.include("bblite/pinned_json.hpp");
                    return `${this.value(first)}.own_keys()`;
                }
                if (name === "is" && first && second) {
                    const left = this.shapeAt(first);
                    const right = this.shapeAt(second);
                    if (left.kind === "number" && right.kind === "number")
                        return `bbl::js::same_value(${this.value(first)}, ${this.value(second)})`;
                    if (!this.same(left, right))
                        return this.refuse(
                            node,
                            "Pinned Object.is over two native types.",
                        );
                    return `(${this.value(first)} == ${this.value(second)})`;
                }
                return this.refuse(node, `Pinned Object.${name}.`);
            case "String":
                if (name === "fromCharCode")
                    return spread
                        ? `bbl::js::string_from_char_codes(${this.spreadArguments(node)})`
                        : `bbl::js::string_from_char_codes({${node.arguments.map((argument) => this.convert(argument, { kind: "number" })).join(", ")}})`;
                return this.refuse(node, `Pinned String.${name}.`);
            case "Float32Array":
            case "Float64Array":
            case "Uint32Array":
            case "Int32Array":
            case "Uint8Array": {
                // `Float32Array.from(numbers)`: a copy, each element
                // converted as a store converts it.
                const shape = stripOptional(to ?? this.shapeAt(node));
                if (
                    name !== "from" ||
                    !first ||
                    node.arguments.length !== 1 ||
                    shape.kind !== "typed"
                )
                    return this.refuse(node, `Pinned ${library}.${name}.`);
                this.model.include("bblite/pinned_values.hpp");
                return `bbl::pinned::typed_copy<${typedElementCpp[shape.element]}>(${this.value(first)})`;
            }
            case "Array":
                if (name === "from") return this.arrayFrom(node, to);
                if (
                    name === "isArray" &&
                    first &&
                    node.arguments.length === 1
                ) {
                    const shape = this.shapeAt(first);
                    if (shape.kind === "json") {
                        this.model.include("bblite/pinned_json.hpp");
                        return `${this.value(first)}.is_array()`;
                    }
                    const isArray =
                        shape.kind === "array" || shape.kind === "tuple";
                    return this.pure(first)
                        ? String(isArray)
                        : `(static_cast<void>(${this.value(first)}), ${isArray})`;
                }
                return this.refuse(node, `Pinned Array.${name}.`);
            case "JSON":
                if (name === "parse" && first && node.arguments.length === 1) {
                    this.model.include("bblite/pinned_json.hpp");
                    return `bbl::js::json_parse(${this.convert(first, { kind: "string" })})`;
                }
                return this.refuse(node, `Pinned JSON.${name}.`);
            case "console":
                return `bbl::pinned::console_line(${node.arguments.map((argument) => this.value(argument)).join(", ")})`;
            case "Promise": {
                // `Promise.resolve(value)` / `Promise.reject(reason)`, of
                // the promise type the sink holds.
                const shape = stripOptional(to ?? this.shapeAt(node));
                if (shape.kind !== "promise" || node.arguments.length > 1)
                    return this.refuse(node, `Pinned Promise.${name}.`);
                this.model.include("bblite/pinned_async.hpp");
                const value = this.promiseValueCpp(shape);
                if (name === "resolve")
                    return first
                        ? `bbl::js::Promise<${value}>::resolved(${shape.value.kind === "void" ? "{}" : this.convert(first, shape.value)})`
                        : `bbl::js::Promise<${value}>::resolved({})`;
                if (name === "reject")
                    return `bbl::pinned::rejected_promise<${value}>(${first ? this.convert(first, { kind: "error" }) : "bbl::js::Error{}"})`;
                return this.refuse(node, `Pinned Promise.${name}.`);
            }
            default:
                return undefined;
        }
        if (spread)
            return this.refuse(node, `Pinned spread into ${library}.${name}.`);
        const lowered = super.expressionDomain(node);
        if (lowered === undefined)
            return this.refuse(node, `Pinned ${library}.${name}.`);
        return typeof lowered === "string" ? lowered : lowered.text;
    }

    /**
     * A call's arguments with spreads, as the number list they pass: read
     * once, in order, when the call evaluates them.
     */
    private spreadArguments(node: ts.CallExpression): string {
        this.model.include("bblite/pinned_values.hpp");
        const parts = node.arguments.map((argument) =>
            ts.isSpreadElement(argument)
                ? this.spreadPart(argument.expression, { kind: "number" })
                : `.add(${this.convert(argument, { kind: "number" })})`,
        );
        return `bbl::pinned::ArrayBuilder<double>{}${parts.join("")}.array()`;
    }

    /** One `...source` of an array literal or argument list, as a builder step. */
    private spreadPart(source: ts.Expression, element: RecordShape): string {
        const unwrapped = this.skipParentheses(source);
        // `...Array.from(x, mapper)`: the mapper builds the sink's element.
        if (isArrayFromCall(unwrapped, this.model.checker))
            return `.spread(${this.arrayFrom(unwrapped, { kind: "array", element })})`;
        // `...list.map(mapper)`: the mapper builds the sink's element.
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            unwrapped.expression.name.text === "map" &&
            !ts.isOptionalChain(unwrapped) &&
            stripOptional(this.shapeAt(unwrapped.expression.expression))
                .kind === "array"
        )
            return `.spread(${this.convert(unwrapped, { kind: "array", element })})`;
        // `...map.values()` / `...map.keys()`.
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            unwrapped.arguments.length === 0
        ) {
            const view = unwrapped.expression.name.text;
            const owner = stripOptional(
                this.shapeAt(unwrapped.expression.expression),
            );
            if (owner.kind === "map" && (view === "values" || view === "keys"))
                return `.spread_${view}(${this.presentValue(unwrapped.expression.expression)})`;
            if (owner.kind === "set" && (view === "values" || view === "keys"))
                return `.spread(${this.presentValue(unwrapped.expression.expression)})`;
        }
        const shape = stripOptional(this.shapeAt(unwrapped));
        if (
            shape.kind === "array" ||
            shape.kind === "set" ||
            shape.kind === "tuple" ||
            shape.kind === "typed"
        ) {
            const items =
                shape.kind === "array" || shape.kind === "set"
                    ? shape.element
                    : { kind: "number" as const };
            if (!this.same(items, element))
                return this.refuse(
                    source,
                    `Pinned spread of ${this.cpp(items)} into ${this.cpp(element)}.`,
                );
            return `.spread(${this.presentValue(unwrapped)})`;
        }
        return this.refuse(source, `Pinned spread of ${this.cpp(shape)}.`);
    }

    /**
     * A global library function the pin calls: `decodeURIComponent`,
     * `Number(value)`, `String(value)`.
     */
    private libraryFunction(
        node: ts.CallExpression,
        callee: ts.Identifier,
    ): string | undefined {
        const name = this.libraryName(callee);
        if (name === undefined) return undefined;
        const [first] = node.arguments;
        switch (name) {
            case "decodeURIComponent":
                if (!first || node.arguments.length !== 1) break;
                this.model.include("bblite/js_search_params.hpp");
                return `bbl::js::decode_uri_component(${this.convert(first, { kind: "string" })})`;
            case "Number": {
                if (!first || node.arguments.length !== 1) break;
                const shape = this.shapeAt(first);
                if (shape.kind === "json") {
                    this.model.include("bblite/pinned_json.hpp");
                    return `${this.value(first)}.to_number()`;
                }
                if (
                    shape.kind === "string" ||
                    shape.kind === "number" ||
                    shape.kind === "boolean"
                ) {
                    this.model.include("bblite/pinned_values.hpp");
                    return `bbl::pinned::number_of(${this.value(first)})`;
                }
                // `Number(header)` where the header may be absent: `null`
                // converts to 0.
                if (
                    shape.kind === "optional" &&
                    shape.value.kind === "string"
                ) {
                    this.model.include("bblite/pinned_values.hpp");
                    const value = this.temporary("number_source");
                    return `[&] { const auto ${value} = ${this.value(first)}; return ${value} ? bbl::pinned::number_of(*${value}) : 0.0; }()`;
                }
                break;
            }
            case "String": {
                if (!first || node.arguments.length !== 1) break;
                const shape = this.shapeAt(first);
                if (shape.kind === "string") return this.value(first);
                if (shape.kind === "number")
                    return `bbl::js::number_to_string(${this.value(first)})`;
                if (shape.kind === "json") {
                    this.model.include("bblite/pinned_json.hpp");
                    return `${this.value(first)}.to_string()`;
                }
                break;
            }
            default:
                return undefined;
        }
        return this.refuse(node, `Pinned call of '${name}'.`);
    }

    /** `Object.prototype.hasOwnProperty.call(value, key)` over a dynamic value. */
    private hasOwn(node: ts.CallExpression): string {
        const [owner, key] = node.arguments;
        if (
            !owner ||
            !key ||
            node.arguments.length !== 2 ||
            this.shapeAt(owner).kind !== "json"
        )
            return this.refuse(
                node,
                "Pinned hasOwnProperty over a non-dynamic value.",
            );
        this.model.include("bblite/pinned_json.hpp");
        return `${this.value(owner)}.has_own(${this.convert(key, { kind: "string" })})`;
    }

    /**
     * An array method that calls back (`map`, `filter`, `reduce`, `some`,
     * `every`, `find`, `findIndex`, `forEach`, `sort`) or reads
     * (`includes`, `shift`), over an array or a dynamic value holding one.
     * A function literal it receives is an inline lambda.
     */
    private iterationMethod(
        node: ts.CallExpression,
        name: string,
        shape: RecordShape,
        to: RecordShape | undefined,
    ): string | undefined {
        const receiverNode = (node.expression as ts.PropertyAccessExpression)
            .expression;
        if (shape.kind !== "array" && shape.kind !== "json") return undefined;
        const element: RecordShape =
            shape.kind === "array" ? shape.element : { kind: "json" };
        const number: RecordShape = { kind: "number" };
        const receiver = (): string => this.presentValue(receiverNode);
        const [first, second] = node.arguments;
        const callback = (
            parameters: readonly RecordShape[],
            result: RecordShape,
        ): string =>
            first
                ? this.callbackArgument(first, parameters, result)
                : this.refuse(node, `Pinned ${name} needs a callback.`);
        const json = shape.kind === "json";
        if (json) this.model.include("bblite/pinned_json.hpp");
        else this.model.include("bblite/pinned_values.hpp");
        const prefix = json ? "bbl::pinned::json_" : "bbl::pinned::array_";
        switch (name) {
            case "map": {
                const produced = to ?? stripOptional(this.shapeAt(node));
                if (produced.kind !== "array")
                    return this.refuse(node, "Pinned map into a non-array.");
                return `${prefix}map<${this.cpp(produced.element)}>(${receiver()}, ${callback([element, number], produced.element)})`;
            }
            case "forEach":
                return `${prefix}for_each(${receiver()}, ${callback([element, number], { kind: "void" })})`;
            case "some":
            case "every":
                return `${prefix}${name}(${receiver()}, ${callback([element, number], this.callbackResult(first))})`;
            default:
                break;
        }
        if (json) return undefined;
        switch (name) {
            case "filter":
                return `bbl::pinned::array_filter(${receiver()}, ${callback([element, number], this.callbackResult(first))})`;
            case "find":
                return `bbl::pinned::array_find<${this.cpp(optionalOf(element))}>(${receiver()}, ${callback([element, number], this.callbackResult(first))})`;
            case "findIndex":
                return `bbl::pinned::array_find_index(${receiver()}, ${callback([element, number], this.callbackResult(first))})`;
            case "reduce": {
                const accumulator = to ?? stripOptional(this.shapeAt(node));
                const reducer = callback(
                    [accumulator, element, number],
                    accumulator,
                );
                return second
                    ? `bbl::pinned::array_reduce<${this.cpp(accumulator)}>(${receiver()}, ${reducer}, ${this.convert(second, accumulator)})`
                    : `bbl::pinned::array_reduce_first<${this.cpp(accumulator)}>(${receiver()}, ${reducer})`;
            }
            case "sort": {
                // A named comparator is a function value (below); a literal
                // one an inline lambda.
                const comparator = first
                    ? this.skipParentheses(first)
                    : undefined;
                if (
                    !comparator ||
                    node.arguments.length !== 1 ||
                    !(
                        ts.isArrowFunction(comparator) ||
                        ts.isFunctionExpression(comparator)
                    )
                )
                    return undefined;
                return `bbl::pinned::sort_array(${receiver()}, ${callback([element, element], number)})`;
            }
            case "includes":
                if (!first || node.arguments.length !== 1)
                    return this.refuse(node, "Pinned includes from an index.");
                return `bbl::js::array_includes(${receiver()}, ${this.convert(first, element)})`;
            case "shift":
                return `bbl::pinned::array_shift<${this.cpp(optionalOf(element))}>(${receiver()})`;
            case "join": {
                const separator = first
                    ? this.convert(first, { kind: "string" })
                    : 'std::string(",")';
                if (element.kind === "string")
                    return `bbl::js::array_join(${receiver()}, ${separator})`;
                if (element.kind === "number")
                    return `bbl::js::array_join(${receiver()}, ${separator}, [](double value) { return bbl::js::number_to_string(value); })`;
                return this.refuse(
                    node,
                    `Pinned join of ${this.cpp(element)}.`,
                );
            }
            default:
                return undefined;
        }
    }

    /** What a callback argument returns, as its checked signature says. */
    private callbackResult(argument: ts.Expression | undefined): RecordShape {
        if (!argument) return { kind: "void" };
        const signature = this.typeAt(argument).getCallSignatures()[0];
        if (!signature)
            return this.refuse(argument, "Pinned callback is not a function.");
        return this.model.shapeOf(
            this.checker.getReturnTypeOfSignature(signature),
            argument,
        );
    }

    /**
     * A callback an array method calls with `parameters`: a function
     * literal as an inline lambda; a library predicate (`Number.isFinite`)
     * or a function value called with the arguments it declares.
     */
    private callbackArgument(
        argument: ts.Expression,
        parameters: readonly RecordShape[],
        result: RecordShape,
    ): string {
        const unwrapped = this.skipParentheses(argument);
        if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped))
            return this.inlineLambda(unwrapped, parameters, result);
        const names = parameters.map(() => this.temporary("argument"));
        const signature = parameters
            .map(
                (shape, index) =>
                    `[[maybe_unused]] ${this.cpp(shape)} ${names[index]!}`,
            )
            .join(", ");
        // `Number.isFinite` passed as a value: called with the element.
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            this.libraryName(unwrapped.expression) === "Number"
        ) {
            const predicate = numberPredicate(unwrapped.name.text);
            const element = parameters[0];
            if (!predicate || !element)
                return this.refuse(argument, "Pinned library callback.");
            if (element.kind === "json")
                this.model.include("bblite/pinned_json.hpp");
            else if (element.kind !== "number")
                return this.refuse(
                    argument,
                    `Pinned Number.${unwrapped.name.text} over ${this.cpp(element)}.`,
                );
            this.model.include("bblite/pinned_values.hpp");
            return `[&](${signature}) -> bool { return ${element.kind === "json" ? predicate.json : predicate.number}(${names[0]!}); }`;
        }
        const shape = stripOptional(this.shapeAt(unwrapped));
        if (shape.kind !== "function")
            return this.refuse(argument, "Pinned callback is not a function.");
        const value = this.temporary("callback");
        const call = `${value}(${shape.parameters
            .map((parameter, index) =>
                index < parameters.length
                    ? this.coerce(
                          names[index]!,
                          parameters[index]!,
                          parameter,
                          argument,
                      )
                    : this.model.absent(parameter, argument),
            )
            .join(", ")})`;
        return `[&, ${value} = ${this.value(unwrapped)}](${signature}) -> ${this.cpp(result)} { return ${result.kind === "void" ? call : this.coerce(call, shape.result, result, argument)}; }`;
    }

    /**
     * A string method, with JavaScript's UTF-16 semantics over the
     * runtime's strings: `repeat`, `trim`, `split` by a string,
     * `charCodeAt`, and `replace` of a string or of a regular expression
     * literal by a string.
     */
    private stringMethod(
        node: ts.CallExpression,
        name: string,
        receiverNode: ts.Expression,
    ): string {
        const string: RecordShape = { kind: "string" };
        const [first, second] = node.arguments;
        const receiver = (): string => this.value(receiverNode);
        const arity = (count: number): void => {
            if (node.arguments.length !== count)
                this.refuse(node, `Pinned string ${name} arity.`);
        };
        switch (name) {
            case "repeat":
                arity(1);
                return `bbl::js::string_repeat(${receiver()}, ${this.value(first!)})`;
            case "trim":
                arity(0);
                return `bbl::js::string_trim(${receiver()})`;
            case "split": {
                if (node.arguments.length < 1 || node.arguments.length > 2)
                    this.refuse(node, `Pinned string ${name} arity.`);
                const separator = this.skipParentheses(first!);
                const parts = ts.isRegularExpressionLiteral(separator)
                    ? `${this.regularExpression(separator)}.split(${receiver()})`
                    : stripOptional(this.shapeAt(separator)).kind === "string"
                      ? `bbl::js::string_split(${receiver()}, ${this.convert(separator, string)})`
                      : this.refuse(
                            first!,
                            "Pinned split by a non-string separator.",
                        );
                if (!second) return parts;
                this.model.include("bblite/pinned_values.hpp");
                return `bbl::pinned::array_limit(${parts}, ${this.convert(second, { kind: "number" })})`;
            }
            case "includes":
            case "startsWith":
            case "endsWith":
            case "indexOf": {
                if (node.arguments.length < 1 || node.arguments.length > 2)
                    this.refuse(node, `Pinned string ${name} arity.`);
                const helper =
                    name === "includes"
                        ? "string_includes"
                        : name === "startsWith"
                          ? "string_starts_with"
                          : name === "endsWith"
                            ? "string_ends_with"
                            : "string_index_of";
                return `bbl::js::${helper}(${receiver()}, ${this.convert(first!, string)}${second ? `, ${this.convert(second, { kind: "number" })}` : ""})`;
            }
            case "toLowerCase":
            case "toUpperCase":
                arity(0);
                return `bbl::js::string_${name === "toLowerCase" ? "lower" : "upper"}(${receiver()})`;
            case "slice":
            case "substring": {
                if (node.arguments.length < 1 || node.arguments.length > 2)
                    this.refuse(node, `Pinned string ${name} arity.`);
                const end = second
                    ? this.convert(second, { kind: "number" })
                    : "std::numeric_limits<double>::infinity()";
                return `bbl::js::string_${name}(${receiver()}, ${this.convert(first!, { kind: "number" })}, ${end})`;
            }
            case "localeCompare":
                // The default locale's collation, through ICU as the
                // browser's `localeCompare` without arguments.
                arity(1);
                this.model.include("bblite/pal_locale.hpp");
                return `bbl::pal::compare_strings(${receiver()}, ${this.convert(first!, string)}, {}, {})`;
            case "charCodeAt": {
                arity(1);
                // A constant string read by index shares one decoded view.
                const view = this.stringView(receiverNode, "units");
                return `bbl::js::string_char_code_at(${view ?? receiver()}, ${this.value(first!)})`;
            }
            case "replace": {
                arity(2);
                if (stripOptional(this.shapeAt(second!)).kind !== "string")
                    return this.refuse(
                        second!,
                        "Pinned replace with a non-string replacement.",
                    );
                const replacement = this.convert(second!, string);
                const pattern = this.skipParentheses(first!);
                if (ts.isRegularExpressionLiteral(pattern))
                    return `${this.regularExpression(pattern)}.replace(${receiver()}, ${replacement})`;
                if (stripOptional(this.shapeAt(pattern)).kind !== "string")
                    return this.refuse(
                        pattern,
                        "Pinned replace of a non-string pattern.",
                    );
                return `bbl::js::string_replace(${receiver()}, ${this.convert(pattern, string)}, ${replacement}, false)`;
            }
            default:
                return this.refuse(node, `Pinned string method '${name}'.`);
        }
    }

    /**
     * A regular expression literal as the runtime's JavaScript `RegExp`:
     * its source and its global and case-insensitive flags. Other flags
     * refuse.
     */
    private regularExpression(node: ts.RegularExpressionLiteral): string {
        const text = node.text;
        const slash = text.lastIndexOf("/");
        const source = text.slice(1, slash);
        const flags = text.slice(slash + 1);
        for (const flag of flags)
            if (flag !== "g" && flag !== "i")
                return this.refuse(
                    node,
                    `Pinned regular expression flag '${flag}'.`,
                );
        return `bbl::js::RegExp(${stringLiteral(source)}, ${flags.includes("g")}, ${flags.includes("i")})`;
    }

    /**
     * A decoded view of a constant string local that the body reads by
     * index or length (`units`: a `bbl::js::StringIndex`; `length`: its
     * UTF-16 length), declared once beside it; undefined for anything
     * else, which reads the string itself.
     */
    private stringView(
        node: ts.Expression,
        kind: "units" | "length",
    ): string | undefined {
        const unwrapped = this.skipParentheses(node);
        if (!ts.isIdentifier(unwrapped)) return undefined;
        const symbol = declaredSymbol(this.checker, unwrapped);
        return symbol ? this.stringViews.get(symbol)?.[kind] : undefined;
    }

    /**
     * The views a constant string local needs: its body reads its length
     * or its code units by index in a loop, where the string itself would
     * decode from the start on every read.
     */
    private stringViewLines(
        declaration: ts.VariableDeclaration,
        cpp: string,
        indent: string,
    ): string[] {
        if (
            !ts.isIdentifier(declaration.name) ||
            !(declaration.parent.flags & ts.NodeFlags.Const)
        )
            return [];
        const symbol = declaredSymbol(this.checker, declaration.name);
        if (!symbol) return [];
        let units = false,
            length = false;
        const visit = (node: ts.Node): void => {
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                declaredSymbol(this.checker, node.expression) === symbol
            ) {
                if (node.name.text === "length") length = true;
                if (
                    node.name.text === "charCodeAt" &&
                    ts.isCallExpression(node.parent) &&
                    node.parent.expression === node
                )
                    units = true;
            }
            ts.forEachChild(node, visit);
        };
        visit(this.entry.declaration);
        const views: { units?: string; length?: string } = {};
        const lines: string[] = [];
        if (units) {
            views.units = `${cpp}_units`;
            lines.push(`${indent}bbl::js::StringIndex ${views.units}(${cpp});`);
        }
        if (length) {
            views.length = `${cpp}_length`;
            lines.push(
                `${indent}const double ${views.length} = bbl::js::string_length(${cpp});`,
            );
        }
        if (units || length) this.stringViews.set(symbol, views);
        return lines;
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
        const shape = stripOptional(to);
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
            if (ts.isSpreadAssignment(property))
                return this.spreadWrites(property.expression, record, owner);
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
                    { owner, shape: { kind: "record", name: record } },
                )};`;
            }
            if (member.storage === "accessor")
                return this.refuse(
                    property,
                    `Pinned member '${name}' is implemented with accessors elsewhere.`,
                );
            if (ts.isMethodDeclaration(property))
                return `${member.access(owner)} = ${this.closure(property, member.shape, indent, { owner, shape: { kind: "record", name: record } })};`;
            const initializer = ts.isShorthandPropertyAssignment(property)
                ? property.name
                : ts.isPropertyAssignment(property)
                  ? property.initializer
                  : this.refuse(property, "Pinned record literal member.");
            return `${member.access(owner)} = ${this.convert(initializer, member.shape)};`;
        });
    }

    /**
     * `...source` in a record literal, at its position among the literal's
     * members: each member of the target record the source has (a getter
     * read as its value), so a later member overrides it. An absent source
     * spreads nothing; `...(test ? { a } : {})` writes one arm's members.
     */
    private spreadWrites(
        expression: ts.Expression,
        record: string,
        owner: string,
    ): string {
        const source = this.skipParentheses(expression);
        if (ts.isObjectLiteralExpression(source))
            return this.propertyWrites(source, record, owner)
                .filter((write) => write.length > 0)
                .join(" ");
        if (ts.isConditionalExpression(source))
            return `if (${this.truthy(source.condition)}) { ${this.spreadWrites(source.whenTrue, record, owner)} } else { ${this.spreadWrites(source.whenFalse, record, owner)} }`;
        const shape = this.shapeAt(source);
        const present = stripOptional(shape);
        if (present.kind !== "record")
            return this.refuse(
                expression,
                `Pinned spread of ${this.cpp(shape)} into a record.`,
            );
        const target = this.model.record(record).members();
        const temporary = this.temporary("spread");
        const reading = this.model.representations.present(temporary, shape);
        const writes: string[] = [];
        for (const member of this.model
            .record(present.name)
            .members()
            .values()) {
            if (member.storage === "none") continue;
            const write = target.get(member.name);
            if (!write) continue;
            const read = member.get
                ? member.get(reading)
                : member.access(reading);
            const value = this.coerce(
                read,
                member.shape,
                write.shape,
                expression,
            );
            writes.push(
                write.set
                    ? `${write.set(owner, value)};`
                    : `${write.access(owner)} = ${value};`,
            );
        }
        const body = writes.join(" ");
        const optional =
            shape.kind === "optional" ||
            this.model.representations.nullable(present);
        return `{ auto ${temporary} = ${this.value(source)}; ${
            optional
                ? `if (bbl::pinned::truthy_object(${temporary})) { ${body} }`
                : body
        } }`;
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

    /** Native reference handles encode absence themselves; value lookups use js::Nullable. */
    private collectionResult(value: string, element: RecordShape): string {
        return this.model.representations.nullable(element)
            ? `bbl::pinned::nullish<${this.cpp(element)}>(${value}, [] { return ${this.cpp(element)}{}; })`
            : value;
    }

    private objectLiteral(
        node: ts.ObjectLiteralExpression,
        to: RecordShape,
    ): string {
        // Its members are statements in source order; an awaited one
        // leaves the builder lambda.
        const values = node.properties.flatMap((property) =>
            ts.isPropertyAssignment(property)
                ? [property.initializer]
                : ts.isShorthandPropertyAssignment(property)
                  ? [property.name]
                  : ts.isSpreadAssignment(property)
                    ? [property.expression]
                    : [],
        );
        return this.sequenced(
            node,
            values,
            () => this.orderedObjectLiteral(node, to),
            "ordered",
        );
    }

    /** An object literal, its awaited members already evaluated (`objectLiteral`). */
    private orderedObjectLiteral(
        node: ts.ObjectLiteralExpression,
        to: RecordShape,
    ): string {
        const shape = stripOptional(to);
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
        // A braced list and a builder chain evaluate in source order; an
        // awaited element leaves the list.
        return this.sequenced(
            node,
            node.elements.map((element) =>
                ts.isSpreadElement(element) ? element.expression : element,
            ),
            () => this.orderedArrayLiteral(node, to),
            "ordered",
        );
    }

    /** An array literal, its awaited elements already evaluated (`arrayLiteral`). */
    private orderedArrayLiteral(
        node: ts.ArrayLiteralExpression,
        to: RecordShape,
    ): string {
        const shape = stripOptional(to);
        // A fresh number list where `ArrayLike<number>` is taken.
        if (shape.kind === "arraylike") {
            this.model.include("bblite/pinned_values.hpp");
            return `bbl::pinned::NumberArrayLike(${this.arrayLiteral(node, {
                kind: "array",
                element: { kind: "number" },
            })})`;
        }
        // `[...a, b, ...map.values()]`: a fresh array of the parts, in order.
        if (node.elements.some(ts.isSpreadElement)) {
            if (shape.kind !== "array" && shape.kind !== "tuple")
                return this.refuse(
                    node,
                    `Pinned spread array literal as ${this.cpp(to)}.`,
                );
            const element: RecordShape =
                shape.kind === "array" ? shape.element : { kind: "number" };
            this.model.include("bblite/pinned_values.hpp");
            const parts = node.elements.map((item) =>
                ts.isSpreadElement(item)
                    ? this.spreadPart(item.expression, element)
                    : `.add(${this.convert(item, element)})`,
            );
            const built = `bbl::pinned::ArrayBuilder<${this.cpp(element)}>{}${parts.join("")}.${shape.kind === "tuple" ? `tuple<${shape.elements.length}>` : "array"}()`;
            return to.kind === "optional" &&
                !this.model.representations.nullable(shape)
                ? `${this.cpp(to)}(${built})`
                : built;
        }
        if (shape.kind === "tuple") {
            if (node.elements.length !== shape.elements.length)
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
        return this.sequencedOptional(
            node,
            (node.arguments ?? []).map((argument) =>
                ts.isSpreadElement(argument) ? argument.expression : argument,
            ),
            () => this.unorderedConstruct(node, to),
        );
    }

    /** A construction, its arguments already in order (`construct`). */
    private unorderedConstruct(
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
        // A platform class the schema constructs (`new URL(a, base)`).
        const library = this.libraryName(node.expression);
        const constructed =
            library !== undefined
                ? this.model.schema.constructors?.get(library)
                : undefined;
        if (constructed) {
            const spelled = constructed.cpp(
                (index) => {
                    const argument = args[index];
                    const parameter = constructed.parameters?.[index];
                    if (!argument)
                        return parameter
                            ? this.model.absent(optionalOf(parameter), node)
                            : this.refuse(
                                  node,
                                  `Pinned ${library} argument ${index} is absent.`,
                              );
                    return parameter
                        ? this.convert(argument, parameter)
                        : this.value(argument);
                },
                node,
                (name) => this.localNamed(name, node),
            );
            if (spelled === null)
                return this.refuse(
                    node,
                    "Pinned platform construction without a value.",
                );
            return this.coerce(spelled, this.shapeAt(node), to, node);
        }
        // A platform class the port represents natively (text-shaper's
        // `UnicodeBuffer`), constructed empty.
        const platform = this.packageImport(node.expression)
            ? this.model.schema.unresolved?.get(node.expression.text)
            : undefined;
        if (platform?.kind === "record") {
            const spec = this.model.record(platform.name).spec;
            if (!spec.native || !spec.reference || args.length !== 0)
                return this.refuse(
                    node,
                    "A pinned platform class constructs empty, as a native record.",
                );
            return this.coerce(
                `bbl::js::make_gc_shared<bbl::${spec.cpp}>()`,
                platform,
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
        const shape = stripOptional(to);
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
                        return (
                            this.mappedEntries(entries, shape) ??
                            this.refuse(
                                node,
                                "Pinned Map seed must be a literal or a list mapped to entries.",
                            )
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
                // `new Set(values)`: each value added in order.
                if (name === "Set" && shape.kind === "set") {
                    const seed = this.skipParentheses(args[0]!);
                    const set = this.temporary("set");
                    if (ts.isArrayLiteralExpression(seed))
                        return `[&] { ${this.cpp(shape)} ${set}; ${seed.elements
                            .map(
                                (element) =>
                                    `${set}.add(${this.convert(element, shape.element)});`,
                            )
                            .join(" ")} return ${set}; }()`;
                    const source = stripOptional(this.shapeAt(seed));
                    if (
                        (source.kind === "array" || source.kind === "set") &&
                        this.same(source.element, shape.element)
                    )
                        return `[&] { ${this.cpp(shape)} ${set}; for (const auto& value : ${this.presentValue(seed)}) ${set}.add(value); return ${set}; }()`;
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
            case "Float64Array":
            case "Uint32Array":
            case "Int32Array":
            case "Uint8Array": {
                if (shape.kind !== "typed" || args.length < 1)
                    return this.refuse(node, `Pinned new ${name}.`);
                const argument = args[0]!;
                const argumentShape = this.shapeAt(argument);
                // `new Uint8Array(buffer, byteOffset, length)`: a view.
                if (argumentShape.kind === "buffer")
                    return args.length === 1
                        ? `${this.cpp(shape)}(${this.value(argument)})`
                        : `${this.cpp(shape)}(${this.value(argument)}, ${this.convert(args[1]!, { kind: "number" })}${args[2] ? `, ${this.convert(args[2], { kind: "number" })}` : ""})`;
                if (args.length !== 1)
                    return this.refuse(node, `Pinned new ${name}.`);
                const literal = this.skipParentheses(argument);
                if (ts.isArrayLiteralExpression(literal))
                    return `${this.cpp(shape)}{${literal.elements
                        .map(
                            (element) =>
                                `static_cast<${typedElementCpp[shape.element]}>(${this.convert(element, { kind: "number" })})`,
                        )
                        .join(", ")}}`;
                if (argumentShape.kind === "number")
                    return `${this.cpp(shape)}(bbl::pinned::array_length(${this.value(argument)}))`;
                // `new Float32Array(numbers)` / `new Uint8Array(view)`: a
                // copy, each element converted as a store converts it.
                if (
                    argumentShape.kind === "typed" ||
                    (argumentShape.kind === "array" &&
                        argumentShape.element.kind === "number") ||
                    argumentShape.kind === "tuple"
                ) {
                    this.model.include("bblite/pinned_values.hpp");
                    return `bbl::pinned::typed_copy<${typedElementCpp[shape.element]}>(${this.value(argument)})`;
                }
                return this.refuse(
                    node,
                    `Pinned new ${name} from ${this.cpp(argumentShape)}.`,
                );
            }
            case "Promise": {
                // `new Promise<T>((resolve, reject) => ...)`: the executor
                // runs now, an inline lambda over the resolving functions.
                const executor = args[0]
                    ? this.skipParentheses(args[0])
                    : undefined;
                if (
                    library !== "Promise" ||
                    shape.kind !== "promise" ||
                    args.length !== 1 ||
                    !executor ||
                    !(
                        ts.isArrowFunction(executor) ||
                        ts.isFunctionExpression(executor)
                    )
                )
                    return this.refuse(
                        node,
                        "Pinned new Promise takes one executor literal.",
                    );
                this.model.include("bblite/pinned_async.hpp");
                const { resolve, reject } = this.resolvingFunctions(shape);
                return `bbl::pinned::construct_promise<${this.promiseValueCpp(shape)}>(${this.inlineLambda(executor, [resolve, reject], { kind: "void" })})`;
            }
            case "Error":
            case "RangeError":
            case "TypeError": {
                // `new Error(message, { cause })`: a builtin error value.
                if (library !== name || args.length > 2)
                    return this.refuse(node, `Pinned new ${name}.`);
                const [message, options] = args;
                let cause = "std::exception_ptr{}";
                if (options) {
                    const literal = this.skipParentheses(options);
                    const property = ts.isObjectLiteralExpression(literal)
                        ? literal.properties[0]
                        : undefined;
                    if (
                        !ts.isObjectLiteralExpression(literal) ||
                        literal.properties.length !== 1 ||
                        !property ||
                        !(
                            ts.isPropertyAssignment(property) ||
                            ts.isShorthandPropertyAssignment(property)
                        ) ||
                        property.name.getText() !== "cause"
                    )
                        return this.refuse(
                            options,
                            "Pinned error options name only a cause.",
                        );
                    cause = `static_cast<std::exception_ptr>(${this.convert(
                        ts.isPropertyAssignment(property)
                            ? property.initializer
                            : property.name,
                        { kind: "error" },
                    )})`;
                }
                return this.coerce(
                    `bbl::js::make_error(${stringLiteral(name)}, ${message ? this.convert(message, { kind: "string" }) : "std::string()"}, ${cause}, ${message ? "true" : "false"})`,
                    { kind: "error" },
                    to,
                    node,
                );
            }
            case "ArrayBuffer":
                if (shape.kind !== "buffer" || args.length !== 1)
                    return this.refuse(node, "Pinned new ArrayBuffer.");
                return `bbl::js::ArrayBuffer(std::vector<std::uint8_t>(bbl::pinned::array_length(${this.convert(args[0]!, { kind: "number" })})))`;
            case "DataView": {
                if (shape.kind !== "dataview" || args.length < 1)
                    return this.refuse(node, "Pinned new DataView.");
                const offsets = args
                    .slice(1)
                    .map(
                        (argument) =>
                            `bbl::js::buffer_view_index(${this.convert(argument, { kind: "number" })})`,
                    );
                return `bbl::js::DataView(${[this.convert(args[0]!, { kind: "buffer" }), ...offsets].join(", ")})`;
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
                const cpp = this.model.variableCpp(variable);
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
            if (shape.kind === "tuple") {
                this.model.include("bblite/pinned_values.hpp");
                return {
                    storage: { kind: "number" },
                    store: (value) =>
                        `bbl::pinned::tuple_write(${owner}, ${index}, ${value})`,
                };
            }
            if (shape.kind === "record") {
                // `entry[key] = value` over literal member names; the owner
                // and key are names, so reading them after the value is
                // the same as before it.
                if (
                    !this.pure(node.expression) ||
                    !this.pure(node.argumentExpression)
                )
                    return this.refuse(
                        node,
                        "Pinned computed member write over an effectful owner or key.",
                    );
                const members = this.keyedMembers(node, shape.name);
                const key = this.convert(node.argumentExpression, {
                    kind: "string",
                });
                return {
                    storage: members[0]!.shape,
                    store: (value) => {
                        const stored = this.temporary("stored");
                        const arms = members
                            .map(
                                (member) =>
                                    `if (${key} == ${stringLiteral(member.name)}) { ${member.access(owner)} = std::move(${stored}); return; }`,
                            )
                            .join(" ");
                        return `[&](${this.cpp(members[0]!.shape)} ${stored}) { ${arms} throw std::logic_error("Pinned computed member key outside its type."); }(${value})`;
                    },
                };
            }
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

    /** A statement, after the temporaries its ordered operands declare. */
    public override statement(
        statement: ts.Statement,
        indent: string,
    ): string[] {
        const prelude: string[] = [];
        this.preludes.push(prelude);
        let lines: string[];
        try {
            lines = this.statementLines(statement, indent);
        } finally {
            this.preludes.pop();
        }
        this.refuseAwaitInLambda(statement, lines);
        return [
            ...prelude.map((declaration) => `${indent}${declaration}`),
            ...lines,
        ];
    }

    /**
     * A `co_await` lowered inside an immediately invoked `[&]` lambda (a
     * value-selecting `||`, a `??` fallback, an optional chain held once):
     * the lambda is not a coroutine. Refused where it arises, before C++
     * would.
     */
    private refuseAwaitInLambda(node: ts.Node, lines: readonly string[]): void {
        if (!this.frame.async) return;
        const text = lines.join("\n");
        for (
            let start = text.indexOf("[&]");
            start >= 0;
            start = text.indexOf("[&]", start + 3)
        ) {
            const open = text.indexOf("{", start);
            if (open < 0) return;
            let depth = 0;
            let end = open;
            for (; end < text.length; end += 1) {
                const character = text[end];
                if (character === '"') {
                    for (
                        end += 1;
                        end < text.length && text[end] !== '"';
                        end += 1
                    )
                        if (text[end] === "\\") end += 1;
                } else if (character === "{") depth += 1;
                else if (character === "}" && --depth === 0) break;
            }
            if (text.slice(open, end).includes("co_await"))
                this.refuse(
                    node,
                    "A pinned await inside an expression lowered as a lambda (a value-selecting operator, a `??` fallback, an optional chain).",
                );
        }
    }

    private statementLines(statement: ts.Statement, indent: string): string[] {
        if (ts.isVariableStatement(statement))
            return this.variableStatement(statement, indent);
        if (ts.isExpressionStatement(statement))
            return this.expressionLines(statement, indent);
        if (ts.isIfStatement(statement)) {
            const lines = [
                `${indent}if (${this.condition(statement.expression)}) {`,
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
        if (ts.isWhileStatement(statement))
            return [
                `${indent}while (${this.condition(statement.expression)}) {`,
                ...this.nested(statement.statement, indent),
                `${indent}}`,
            ];
        if (ts.isForStatement(statement)) {
            const captured = this.capturedFor(statement, indent);
            if (captured) return captured;
        }
        if (ts.isThrowStatement(statement)) {
            const thrown = this.throwStatement(statement, indent);
            if (thrown) return thrown;
        }
        // A type declared in a body has no runtime statement.
        if (
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)
        )
            return [];
        if (ts.isReturnStatement(statement)) {
            if (this.frame.async)
                return [`${indent}${this.asyncReturn(statement.expression)};`];
            if (!statement.expression) return [`${indent}return;`];
            return [
                `${indent}return ${this.convert(statement.expression, this.returns)};`,
            ];
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
        return this.withBindings(() =>
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
        // A generic closure: one closure per instantiation its calls use.
        const generic = this.instantiations(declaration);
        if (generic && symbol) {
            const lines: string[] = [];
            const specializations = new Map<string, Local>();
            for (const variant of generic.variants) {
                const value = this.instantiated(
                    generic.closure,
                    variant,
                    this.closureIndent(),
                );
                const slot = captured?.specializations?.get(variant.key);
                if (slot) {
                    lines.push(`${indent}${this.localCpp(slot)} = ${value};`);
                    continue;
                }
                const cpp = this.temporary(
                    cppIdentifier(declaration.name.text),
                );
                specializations.set(variant.key, {
                    cpp,
                    storage: variant.shape,
                });
                lines.push(
                    `${indent}${this.cpp(variant.shape)} ${cpp} = ${value};`,
                );
            }
            if (!captured)
                this.locals.set(symbol, {
                    storage: { kind: "void" },
                    specializations,
                });
            return lines;
        }
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
        const owned = initializer
            ? this.ownedRead(initializer, value, storage)
            : value;
        return [
            `${indent}${this.mayBeUnread(declaration.name) ? "[[maybe_unused]] " : ""}${this.cpp(storage)} ${cpp} = ${owned};`,
            ...(storage.kind === "string"
                ? this.stringViewLines(declaration, cpp, indent)
                : []),
        ];
    }

    /**
     * A local initialized by reading existing storage -- a name, a member,
     * an element -- holds its own copy of what is stored there, as the
     * JavaScript binding does.
     */
    private ownedRead(
        source: ts.Expression,
        value: string,
        storage: RecordShape,
    ): string {
        const read = unwrapExpression(source);
        return !this.isAbsentLiteral(read) &&
            (ts.isIdentifier(read) ||
                ts.isPropertyAccessExpression(read) ||
                ts.isElementAccessExpression(read))
            ? this.model.representations.snapshot(value, storage)
            : value;
    }

    /** A local's storage: its erased annotation, its initializer's shape, or its type's. */
    private storageOf(declaration: ts.VariableDeclaration): RecordShape {
        const declared = this.checker.getTypeAtLocation(declaration.name);
        // `const leaf = { ... } satisfies StreamLeaf`: the record it satisfies.
        const initializer = declaration.initializer
            ? this.skipParentheses(declaration.initializer)
            : undefined;
        if (
            !declaration.type &&
            initializer &&
            ts.isSatisfiesExpression(initializer)
        )
            return this.model.shapeOf(
                this.checker.getTypeFromTypeNode(initializer.type),
                declaration,
            );
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
        const shape = stripOptional(this.shapeAt(initializer));
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
        const shape = stripOptional(this.shapeAt(initializer));
        if (shape.kind !== "record")
            return this.refuse(
                initializer,
                "Pinned destructuring of a non-record.",
            );
        return this.objectPattern(
            pattern,
            this.convert(initializer, shape),
            shape,
            indent,
        );
    }

    /** `{ _a: a, b }` bound from `value`, a record evaluated once. */
    private objectPattern(
        pattern: ts.ObjectBindingPattern,
        value: string,
        shape: RecordShape,
        indent: string,
    ): string[] {
        if (shape.kind !== "record")
            return this.refuse(
                pattern,
                "Pinned destructuring of a non-record.",
            );
        const source = this.temporary("destructured");
        const lines = [`${indent}${this.cpp(shape)} ${source} = ${value};`];
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
            const bound = this.coerce(
                member.get ? member.get(source) : member.access(source),
                member.shape,
                storage,
                element,
            );
            const cpp = this.declare(element.name, storage);
            lines.push(
                `${indent}${this.mayBeUnread(element.name) ? "[[maybe_unused]] " : ""}${this.cpp(storage)} ${cpp} = ${bound};`,
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
        // `() => undefined`: nothing to evaluate.
        if (this.isAbsentLiteral(expression)) return null;
        // `await p;` and `void p;`: evaluated, the value dropped.
        if (ts.isAwaitExpression(expression))
            return `static_cast<void>(${this.value(expression)})`;
        if (ts.isVoidExpression(expression))
            return `static_cast<void>(${this.value(expression.expression)})`;
        if (ts.isCallExpression(expression)) {
            const adapter = this.adapterOf(expression);
            if (adapter) {
                // A platform statement (`null`) has no native effect.
                let statement = true;
                const { operands, order, receiver } =
                    this.callOperands(expression);
                const spelled = this.sequenced(
                    expression,
                    operands,
                    () => {
                        const cpp = adapter.cpp(
                            (index) => this.adapterArgument(expression, index),
                            expression,
                            (name) => this.localNamed(name, expression),
                        );
                        statement = cpp !== null;
                        return cpp ?? "";
                    },
                    order,
                    receiver,
                );
                return statement ? spelled : null;
            }
            const value = this.value(expression);
            const type = this.typeAt(expression);
            return type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)
                ? value
                : `static_cast<void>(${value})`;
        }
        if (ts.isBinaryExpression(expression)) {
            const kind = expression.operatorToken.kind;
            const pattern = this.skipParentheses(expression.left);
            if (
                kind === ts.SyntaxKind.EqualsToken &&
                ts.isArrayLiteralExpression(pattern)
            )
                return this.arrayAssignment(pattern, expression.right);
            // The target's owner and key, then the value (C++ evaluates an
            // assignment's value first).
            if (kind === ts.SyntaxKind.EqualsToken)
                return this.sequenced(
                    expression,
                    [...this.targetOperands(expression.left), expression.right],
                    () => {
                        const place = this.place(expression.left);
                        return place.store(
                            this.convert(expression.right, place.storage),
                        );
                    },
                );
            if (
                kind !== ts.SyntaxKind.QuestionQuestionEqualsToken &&
                kind !== ts.SyntaxKind.AmpersandAmpersandEqualsToken &&
                kind !== ts.SyntaxKind.BarBarEqualsToken
            )
                this.refuseCompoundHazard(expression);
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
            // `text += part`: string concatenation, the part as its ToString.
            if (kind === ts.SyntaxKind.PlusEqualsToken) {
                const place = this.place(expression.left);
                if (place.storage.kind === "string") {
                    if (place.cpp === undefined)
                        return this.refuse(
                            expression,
                            "Pinned string append to a computed place.",
                        );
                    const part = stripOptional(this.shapeAt(expression.right));
                    const value = this.value(expression.right);
                    return `${place.cpp} = bbl::js::concat(${place.cpp}, ${
                        part.kind === "string"
                            ? value
                            : part.kind === "number"
                              ? `bbl::js::NumberPart(${value})`
                              : this.refuse(
                                    expression.right,
                                    "Pinned string append of a non-primitive.",
                                )
                    })`;
                }
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

    /**
     * `[a, b] = [b, a]`: the right side's elements, each evaluated once in
     * order, then stored into the targets in order.
     */
    private arrayAssignment(
        targets: ts.ArrayLiteralExpression,
        source: ts.Expression,
    ): string {
        const values = this.skipParentheses(source);
        if (
            !ts.isArrayLiteralExpression(values) ||
            values.elements.length !== targets.elements.length ||
            [...values.elements, ...targets.elements].some(
                (element) =>
                    ts.isSpreadElement(element) ||
                    ts.isOmittedExpression(element),
            )
        )
            return this.refuse(
                targets,
                "Pinned destructuring assignment needs an array literal of as many elements.",
            );
        const places = targets.elements.map((target) => this.place(target));
        const temporaries = places.map(() => this.temporary("assigned"));
        const reads = values.elements.map(
            (value, index) =>
                `${this.cpp(places[index]!.storage)} ${temporaries[index]!} = ${this.convert(value, places[index]!.storage)};`,
        );
        const stores = places.map(
            (place, index) => `${place.store(temporaries[index]!)};`,
        );
        return `[&] { ${[...reads, ...stores].join(" ")} }()`;
    }

    /** Catch clauses the numeric lowering spells itself (`throw caught` is `throw;`). */
    private readonly rethrowingCatches = new Set<ts.CatchClause>();

    /**
     * `throw value` of any thrown value: an error rethrown with its
     * identity, a dynamic value as what it holds. `throw new Error(text)`
     * and a rethrow in a catch the numeric lowering spells stay its own.
     */
    private throwStatement(
        statement: ts.ThrowStatement,
        indent: string,
    ): string[] | undefined {
        const thrown = this.skipParentheses(statement.expression);
        if (
            ts.isNewExpression(thrown) &&
            ts.isIdentifier(thrown.expression) &&
            ["Error", "RangeError"].includes(thrown.expression.text) &&
            thrown.arguments?.length === 1 &&
            this.libraryName(thrown.expression) === thrown.expression.text
        )
            return undefined;
        if (ts.isIdentifier(thrown)) {
            const declaration = this.model.declarationOf(thrown);
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                ts.isCatchClause(declaration.parent) &&
                this.rethrowingCatches.has(declaration.parent)
            )
                return undefined;
        }
        this.model.include("bblite/pinned_values.hpp");
        const shape = this.shapeAt(thrown);
        const error =
            stripOptional(shape).kind === "json"
                ? this.coerce(
                      this.value(thrown),
                      stripOptional(shape),
                      { kind: "error" },
                      thrown,
                  )
                : this.convert(thrown, { kind: "error" });
        return [`${indent}bbl::pinned::throw_error(${error});`];
    }

    /**
     * `try`/`catch`/`finally` over thrown values: the catch binds the
     * error it catches; a catch that awaits runs after its handler (C++
     * has no `co_await` in a handler); `finally` runs on every exit of the
     * try statement, explicitly before an exception propagates. A catch
     * whose binding is only rethrown, in a synchronous body, is the
     * numeric lowering's.
     */
    protected override tryStatement(
        statement: ts.TryStatement,
        indent: string,
    ): string[] {
        const clause = statement.catchClause;
        const variable = clause?.variableDeclaration;
        const binding =
            variable && ts.isIdentifier(variable.name)
                ? declaredSymbol(this.checker, variable.name)
                : undefined;
        if (variable && !binding)
            return this.refuse(variable, "Pinned catch binding pattern.");
        const readsBinding =
            binding !== undefined &&
            clause !== undefined &&
            findAnalysisNode(
                clause.block,
                (node) =>
                    ts.isIdentifier(node) &&
                    declaredSymbol(this.checker, node) === binding &&
                    !ts.isThrowStatement(node.parent),
            ) !== undefined;
        const awaits = (node: ts.Node | undefined): boolean =>
            node !== undefined && this.containsAwait(node);
        if (
            !this.frame.async &&
            !statement.finallyBlock &&
            clause &&
            !readsBinding
        ) {
            this.rethrowingCatches.add(clause);
            return super.tryStatement(statement, indent);
        }
        if (awaits(statement.finallyBlock))
            return this.refuse(
                statement.finallyBlock!,
                "Pinned finally block awaits.",
            );
        if (statement.finallyBlock) this.refuseExits(statement.finallyBlock);
        const inner = `${indent}    `;
        const lines: string[] = [];
        const tryLines = (body: string): string[] => [
            `${body}try {`,
            ...this.withBindings(() =>
                this.statements(statement.tryBlock.statements, `${body}    `),
            ),
        ];
        const handler = (body: string, caught: string): string[] =>
            this.withBindings(() => {
                const declared =
                    variable && ts.isIdentifier(variable.name)
                        ? [
                              `${body}bbl::js::Error ${this.declare(variable.name, { kind: "error" })} = ${caught};`,
                          ]
                        : [];
                return [
                    ...declared,
                    ...this.statements(clause!.block.statements, body),
                ];
            });
        const guarded = (body: string): string[] => {
            if (!clause)
                return [
                    `${body}{`,
                    ...this.withBindings(() =>
                        this.statements(
                            statement.tryBlock.statements,
                            `${body}    `,
                        ),
                    ),
                    `${body}}`,
                ];
            if (!awaits(clause.block))
                return [
                    ...tryLines(body),
                    `${body}} catch (...) {`,
                    ...handler(`${body}    `, "std::current_exception()"),
                    `${body}}`,
                ];
            // A handler that awaits runs once the C++ handler has ended.
            const caught = this.temporary("caught");
            return [
                `${body}std::exception_ptr ${caught};`,
                ...tryLines(body),
                `${body}} catch (...) {`,
                `${body}    ${caught} = std::current_exception();`,
                `${body}}`,
                `${body}if (${caught}) {`,
                ...handler(`${body}    `, caught),
                `${body}}`,
            ];
        };
        if (!statement.finallyBlock) return guarded(indent);
        const cleanup = this.temporary("finally");
        const finallyBody = this.withBindings(() =>
            this.statements(statement.finallyBlock!.statements, `${inner}    `),
        );
        const guard = this.frame.async
            ? "bbl::pinned::async_finally"
            : "bbl::js::finally";
        if (this.frame.async) this.model.include("bblite/pinned_async.hpp");
        lines.push(
            `${indent}{`,
            `${inner}auto ${cleanup} = ${guard}([&] {`,
            ...finallyBody,
            `${inner}});`,
            `${inner}try {`,
            ...guarded(`${inner}    `),
            `${inner}} catch (...) {`,
            `${inner}    ${cleanup}.run();`,
            `${inner}    throw;`,
            `${inner}}`,
            `${indent}}`,
        );
        return lines;
    }

    /** Whether a node holds an `await` of its own function (not a nested one's). */
    private containsAwait(node: ts.Node): boolean {
        let found = false;
        const visit = (child: ts.Node): void => {
            if (found || isFunctionLike(child)) return;
            if (ts.isAwaitExpression(child)) found = true;
            else ts.forEachChild(child, visit);
        };
        visit(node);
        return found;
    }

    /** A `finally` body runs as a native lambda: no return or loop exit leaves it. */
    private refuseExits(block: ts.Block): void {
        const visit = (node: ts.Node, loops: number): void => {
            if (isFunctionLike(node)) return;
            if (
                ts.isReturnStatement(node) ||
                ts.isLabeledStatement(node) ||
                ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) &&
                    (node.label !== undefined || loops === 0))
            )
                this.refuse(node, "Pinned finally block leaves its statement.");
            const loop =
                ts.isForStatement(node) ||
                ts.isForOfStatement(node) ||
                ts.isForInStatement(node) ||
                ts.isWhileStatement(node) ||
                ts.isDoStatement(node) ||
                ts.isSwitchStatement(node);
            ts.forEachChild(node, (child) =>
                visit(child, loops + Number(loop)),
            );
        };
        visit(block, 0);
    }

    /**
     * `for (let i = ...; ...; ...)` whose header binding a closure
     * captures: each iteration has its own binding, copied from the last
     * one before the update runs (CreatePerIterationEnvironment), so a
     * closure keeps the value of the iteration that created it.
     */
    private capturedFor(
        statement: ts.ForStatement,
        indent: string,
    ): string[] | undefined {
        const list = statement.initializer;
        if (!list || !ts.isVariableDeclarationList(list)) return undefined;
        const bindings: { name: ts.Identifier; storage: RecordShape }[] = [];
        for (const declaration of list.declarations) {
            const name = declaration.name;
            const symbol = ts.isIdentifier(name)
                ? declaredSymbol(this.checker, name)
                : undefined;
            if (ts.isIdentifier(name) && symbol && this.captured.has(symbol))
                bindings.push({ name, storage: this.storageOf(declaration) });
        }
        if (bindings.length === 0) return undefined;
        return this.withBindings(() => {
            const inner = `${indent}    `;
            const { prolog, scope } = this.enterScope(
                statement,
                bindings,
                inner,
            );
            try {
                const initial = list.declarations.map((declaration) => {
                    if (!ts.isIdentifier(declaration.name))
                        return this.refuse(
                            declaration,
                            "Pinned for initializer.",
                        );
                    return this.declaration(declaration, inner);
                });
                const condition = statement.condition
                    ? this.condition(statement.condition)
                    : "";
                const update = [
                    `${scope.variable} = bbl::pinned::next_iteration(${scope.variable})`,
                    ...(statement.incrementor
                        ? [this.loopIncrementor(statement.incrementor)]
                        : []),
                ].join(", ");
                return [
                    `${indent}{`,
                    ...prolog,
                    ...initial.flat(),
                    `${inner}for (; ${condition}; ${update}) {`,
                    ...this.nested(statement.statement, inner),
                    `${inner}}`,
                    `${indent}}`,
                ];
            } finally {
                this.leaveScope(scope);
            }
        });
    }

    protected override forInitializer(
        initializer: ts.ForInitializer | undefined,
    ): string {
        let declared = "";
        if (initializer) {
            if (!ts.isVariableDeclarationList(initializer))
                return this.refuse(initializer, "Pinned for initializer.");
            const parts = initializer.declarations.map((declaration) => {
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !declaration.initializer
                )
                    return this.refuse(declaration, "Pinned for initializer.");
                const storage = this.model.shapeOf(
                    this.checker.getTypeAtLocation(declaration.name),
                    declaration,
                );
                if (storage.kind !== "number")
                    return this.refuse(
                        declaration,
                        "Pinned for loops count numbers.",
                    );
                const value = this.convert(declaration.initializer, storage);
                return `${this.declare(declaration.name, storage)} = ${value}`;
            });
            declared = `double ${parts.join(", ")}`;
        }
        return declared;
    }
    protected override loopIncrementor(expression: ts.Expression): string {
        return (
            this.effect(this.skipParentheses(expression)) ??
            this.refuse(
                expression,
                "Pinned loop incrementor without a native effect.",
            )
        );
    }

    /**
     * `for (const [key, value] of Object.entries(document))` over a dynamic
     * value: its own enumerable keys and values, listed before the loop.
     */
    private objectEntries(
        iterated: ts.Expression,
        binding: ts.BindingName,
    ): PinnedIteration | undefined {
        if (
            !ts.isCallExpression(iterated) ||
            !ts.isPropertyAccessExpression(iterated.expression) ||
            iterated.expression.name.text !== "entries" ||
            this.libraryName(iterated.expression.expression) !== "Object"
        )
            return undefined;
        const [source] = iterated.arguments;
        if (
            !source ||
            iterated.arguments.length !== 1 ||
            this.shapeAt(source).kind !== "json"
        )
            return this.refuse(
                iterated,
                "Pinned Object.entries of a non-dynamic value.",
            );
        const names: ts.Identifier[] = [];
        if (ts.isArrayBindingPattern(binding))
            for (const element of binding.elements)
                if (
                    ts.isBindingElement(element) &&
                    ts.isIdentifier(element.name) &&
                    !element.initializer &&
                    !element.dotDotDotToken
                )
                    names.push(element.name);
        const [key, value] = names;
        if (
            !ts.isArrayBindingPattern(binding) ||
            binding.elements.length !== 2 ||
            !key ||
            !value
        )
            return this.refuse(binding, "Pinned entry binding.");
        this.model.include("bblite/pinned_json.hpp");
        const range = this.temporary("range");
        const entry = this.temporary("entry");
        return {
            prefix: [
                `const auto ${range} = bbl::pinned::json_entries(${this.value(source)});`,
            ],
            header: `const auto& ${entry} : ${range}`,
            bindings: [
                `std::string ${this.declare(key, { kind: "string" })} = ${entry}.first;`,
                `bbl::js::JsonValue ${this.declare(value, { kind: "json" })} = ${entry}.second;`,
            ],
        };
    }

    protected override forOfIteration(
        statement: ts.ForOfStatement,
        binding: ts.BindingName,
    ): PinnedIteration {
        let iterated = this.skipParentheses(statement.expression);
        const entries = this.objectEntries(iterated, binding);
        if (entries) return entries;
        let view: "values" | "keys" | "entries" = "entries";
        if (
            ts.isCallExpression(iterated) &&
            ts.isPropertyAccessExpression(iterated.expression) &&
            iterated.arguments.length === 0 &&
            ["values", "keys", "entries"].includes(
                iterated.expression.name.text,
            ) &&
            ["map", "set"].includes(
                stripOptional(this.shapeAt(iterated.expression.expression))
                    .kind,
            )
        ) {
            const kind = iterated.expression.name.text;
            view =
                kind === "values"
                    ? "values"
                    : kind === "keys"
                      ? "keys"
                      : "entries";
            iterated = iterated.expression.expression;
        }
        const shape = this.ownerShape(iterated);
        // The elements of a dynamic value holding an array, read once.
        if (shape.kind === "json") {
            if (!ts.isIdentifier(binding))
                return this.refuse(
                    binding,
                    "Pinned dynamic iteration binds one name.",
                );
            this.model.include("bblite/pinned_json.hpp");
            const range = this.temporary("range");
            const element = this.temporary("element");
            return {
                prefix: [
                    `auto ${range} = bbl::pinned::json_array(${this.presentValue(iterated)}, "Symbol.iterator").array_value();`,
                ],
                header: `const auto& ${element} : ${range}`,
                bindings: [
                    `bbl::js::JsonValue ${this.declare(binding, { kind: "json" })} = ${element};`,
                ],
            };
        }
        const range = this.temporary("range");
        // The loop keeps the collection it started from, and each binding
        // its own element, as JavaScript's iteration does.
        const prefix = [
            `auto ${range} = ${this.ownedRead(iterated, this.presentValue(iterated), shape)};`,
        ];
        const bind = (name: ts.Identifier, value: string): string => {
            const storage = this.model.shapeOf(
                this.checker.getTypeAtLocation(name),
                name,
            );
            return `${this.cpp(storage)} ${this.declare(name, storage)} = ${this.model.representations.snapshot(value, storage)};`;
        };
        if (shape.kind === "array" && ts.isObjectBindingPattern(binding)) {
            // `for (const { count, blocks } of levels)`: each member of the
            // element read into its own binding, in pattern order.
            const element = stripOptional(shape.element);
            if (element.kind !== "record")
                return this.refuse(
                    binding,
                    "Pinned destructuring iteration over a non-record.",
                );
            const index = this.temporary("index");
            const item = this.temporary("item");
            return {
                prefix,
                header: `std::size_t ${index} = 0; ${index} < ${range}.size(); ++${index}`,
                bindings: [
                    `const auto ${item} = ${range}[${index}];`,
                    ...binding.elements.map((part) => {
                        const key = part.propertyName ?? part.name;
                        if (
                            part.initializer ||
                            part.dotDotDotToken ||
                            !ts.isIdentifier(part.name) ||
                            !ts.isIdentifier(key)
                        )
                            return this.refuse(
                                part,
                                "Pinned destructuring iteration binds plain member names.",
                            );
                        return bind(
                            part.name,
                            this.model.memberRead(item, element.name, key.text),
                        );
                    }),
                ],
            };
        }
        if (shape.kind === "array") {
            if (!ts.isIdentifier(binding))
                return this.refuse(
                    binding,
                    "Pinned array iteration binds one name.",
                );
            const index = this.temporary("index");
            return {
                prefix,
                header: `std::size_t ${index} = 0; ${index} < ${range}.size(); ++${index}`,
                bindings: [bind(binding, `${range}[${index}]`)],
            };
        }
        if (shape.kind !== "map" && shape.kind !== "set")
            return this.refuse(
                statement,
                "Pinned iteration of a non-collection.",
            );
        const entry = this.temporary("entry");
        let bindings: string[];
        if (shape.kind === "set" || view === "values" || view === "keys") {
            if (!ts.isIdentifier(binding))
                return this.refuse(
                    binding,
                    "Pinned value iteration binds one name.",
                );
            bindings = [
                bind(
                    binding,
                    entry +
                        (shape.kind === "map"
                            ? view === "keys"
                                ? ".first"
                                : ".second"
                            : ""),
                ),
            ];
        } else {
            if (
                !ts.isArrayBindingPattern(binding) ||
                binding.elements.length < 1 ||
                binding.elements.length > 2
            )
                return this.refuse(binding, "Pinned map entry binding.");
            // `[key]` binds the key alone; `[, value]` the value alone.
            bindings = binding.elements.flatMap((element, index) => {
                if (ts.isOmittedExpression(element)) return [];
                if (
                    !ts.isBindingElement(element) ||
                    !ts.isIdentifier(element.name) ||
                    element.initializer ||
                    element.dotDotDotToken
                )
                    return this.refuse(element, "Pinned map entry binding.");
                return bind(
                    element.name,
                    entry + (index === 0 ? ".first" : ".second"),
                );
            });
        }
        return { prefix, header: `auto& ${entry} : ${range}`, bindings };
    }
}
