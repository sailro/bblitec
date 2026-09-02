import ts from "typescript";
import { pinnedMathSpelling } from "../lowering/pinned-operators.js";
import { sceneRelativeSourceLabel } from "../source-location.js";
import {
    foldableMathUnary,
    staticNumberValue,
} from "./option-helpers.js";
import {
    DataTypeRegistry,
    dataTypesEqual,
    doubleLiteral,
    isTypedArrayType,
    passesByReference,
    typedArrayStoreExpression,
    type DataIterationElement,
    type DataType,
    type TypedArrayKind,
} from "./data-types.js";
import type { Value } from "./types.js";
import {
    compileDataMethodCall,
    resizingArrayMethods,
} from "./data-methods.js";
import { isTrsVectorName } from "./assignments.js";

/**
 * The one-argument `Math` members scene code may call, each a `<cmath>`
 * function of the same arity over doubles. The members the pinned-body
 * layer also accepts spell through the shared pinned table, so the
 * scene-code compiler and the pinned-body translator cannot disagree about
 * what a shared member lowers to; the compiler-only extras follow the same
 * `std::` rule and stay here because no pinned body reaches them. Members
 * with different semantics (`Math.round`'s tie rule, the seeded
 * `Math.random`) are dispatched separately below and say why.
 */
const mathUnaryCalls: ReadonlyMap<string, string> = new Map([
    ...(["abs", "ceil", "cos", "floor", "sin", "sqrt", "tan"] as const).map(
        (name): [string, string] => [name, pinnedMathSpelling(name)],
    ),
    ["atan", "std::atan"],
    ["exp", "std::exp"],
    ["trunc", "std::trunc"],
]);

/**
 * The array methods that change a container's length.
 *
 * The same set `compileDataMethodCall` routes through `invalidateAliases`:
 * `push`, `pop`, `unshift` and `splice` lower, while `shift` still refuses by
 * name before it reaches here. A method added to the lowerer that grows or shrinks
 * a container belongs here too, because this is the only guard the length
 * fold below has.
 */
/** Names whose container can be resized, per entry source. */
const resizedNamesByFile = new WeakMap<
    ts.SourceFile,
    ReadonlySet<string>
>();

/**
 * Every binding name in one source whose container's LENGTH can change.
 *
 * Four spellings put a name here, and between them they are everything that
 * can move a count:
 *
 * - a resizing method call on the name;
 * - an assignment to the name, which reseats it on another container;
 * - a write to its `.length`, which truncates;
 * - the name appearing anywhere inside a CALL's arguments. That last one is
 *   the load-bearing case: this compiler inlines every reached function, and
 *   a container parameter is bound BY REFERENCE (`bbl::js::Array<double>&`),
 *   so `grow(offsets)` really does grow `offsets` while the callee's own
 *   `list.push` is spelled against the parameter. Nothing downstream can see
 *   that join, so a name handed to any call gives up its fold here.
 *
 * An element WRITE is absent on purpose: it moves no count.
 *
 * Keyed by TEXT rather than by symbol, which is the conservative direction —
 * two same-named locals in different functions decline each other's fold
 * rather than granting one. Computed once per file because the walk is the
 * whole tree and the answer cannot change during a generation.
 */
function resizedNames(file: ts.SourceFile): ReadonlySet<string> {
    const cached = resizedNamesByFile.get(file);
    if (cached) return cached;
    const resized = new Set<string>();
    const addIdentifiers = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) resized.add(node.text);
        ts.forEachChild(node, addIdentifiers);
    };
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            if (
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                resizingArrayMethods.has(node.expression.name.text)
            ) {
                resized.add(node.expression.expression.text);
            }
            for (const argument of node.arguments) {
                addIdentifiers(argument);
            }
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const left = node.left;
            if (ts.isIdentifier(left)) {
                resized.add(left.text);
            } else if (
                ts.isPropertyAccessExpression(left) &&
                ts.isIdentifier(left.expression) &&
                left.name.text === "length"
            ) {
                resized.add(left.expression.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    resizedNamesByFile.set(file, resized);
    return resized;
}

/** Whether nothing in the entry source can change `name`'s length. */
export function isNeverResized(name: ts.Identifier): boolean {
    return !resizedNames(name.getSourceFile()).has(name.text);
}

export interface DataLoweringContext {
    readonly checker: ts.TypeChecker;
    lookup(identifier: ts.Identifier): Value;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    /** A canvas size as the number generation configured; see the helper. */
    staticCanvasSize?(expression: ts.Expression): number | undefined;
    readonly dataTypes: DataTypeRegistry;
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    castNumber(
        value: Value,
        precision: "float" | "double",
    ): string;
    compileCondition(expression: ts.Expression): string;
    cppString(value: string): string;
    declaredDataProperty(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined;
    readResolvedProperty(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    unwrap(expression: ts.Expression): ts.Expression;
    emit(line: string): void;
    probeEmission<T>(
        probe: () => T,
        answered?: (result: T) => boolean,
    ): T;
    captureEmittedLines(emitBody: () => void): string[];
    allocateTemporaryCppName(label: string): string;
    increaseIndent(): void;
    decreaseIndent(): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateBlockPrefix(): string;
    compileCallbackWithValues(
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value;
    compilePredicateWithValues(
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value;
    compileStoredDataFunction(
        expression:
            | ts.Identifier
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        dataType: DataType & { kind: "function" },
        owner?: Value,
    ): string;
    compileSpriteAtlasRecord(
        value: Value,
        node: ts.Node,
    ): string | undefined;
    lookupIdentifierValue(
        identifier: ts.Identifier,
    ): Value | undefined;
    resolveThisField(name: string): Value | undefined;
    resolveRecordMember(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined;
    enterRuntimeControlFlow(): void;
    leaveRuntimeControlFlow(): void;
    /** Whether the current expression belongs to native, path-dependent control flow. */
    isInRuntimeControlFlow(): boolean;
    /** Clears an array snapshot from every compiler alias that shares it. */
    invalidateStaticElements(value: Value): void;
    /** Clears a map/object snapshot from every compiler alias that shares it. */
    invalidateRecordProperties(value: Value): void;
    reachJsData(): void;
    reachJsRandom(): void;
    defaultEngine(): string | undefined;
    fail(node: ts.Node, message: string): never;
}

/**
 * `owned` — the local holds a value it constructed.
 * `copy` — bound from a data path by value; writes are rejected.
 * `escaped` — an owned local that was copied into another data location.
 * `alias` — a const local bound to a data path as a native reference, so
 *   writes reach the container exactly like a JavaScript object binding.
 * `poisoned` — an alias whose container was structurally mutated; any
 *   later use would read through a dangling reference.
 */
type LocalOwnership =
    | "owned"
    | "copy"
    | "escaped"
    | "alias"
    | "poisoned";

/**
 * Lowers the plain-data subset: struct paths, dynamic arrays, static tables,
 * enum tags, JavaScript Math, and typed literals. Aliasing follows the
 * documented value-copy contract: locals bound from data paths are copies and
 * reject writes; owned locals reject writes after escaping by copy.
 */
export class DataLowerer {
    private readonly ownership = new Map<
        string,
        LocalOwnership
    >();

    /**
     * Namespace-scope tables already emitted for constant typed-array
     * literals, keyed on element type + the exact literal text. The
     * first emission owns the symbol; a later identical literal
     * references it instead of restating the bytes (tetris restated
     * fourteen 74-124 KB vertex literals twice each).
     */
    private readonly typedArrayLiteralTables = new Map<
        string,
        string
    >();

    public constructor(
        public readonly context: DataLoweringContext,
    ) {}

    public compileAssignmentValue(
        expression: ts.BinaryExpression,
    ): Value | undefined {
        if (
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        ) {
            return undefined;
        }
        const left = this.context.unwrap(expression.left);
        if (
            ts.isPropertyAccessExpression(left) ||
            ts.isElementAccessExpression(left)
        ) {
            const target = this.compileDataPath(left, "write");
            if (target?.kind === "number" && !target.dataStore) {
                return {
                    kind: "number",
                    cpp: `(${target.cpp} = ${this.context.compileNumber(expression.right, "double")})`,
                    dataType: { kind: "number" },
                };
            }
            if (target?.kind === "boolean" && !target.dataStore) {
                return {
                    kind: "boolean",
                    cpp: `(${target.cpp} = ${this.context.compileCondition(expression.right)})`,
                    dataType: { kind: "boolean" },
                    impure: true,
                };
            }
            return undefined;
        }
        if (!ts.isIdentifier(left)) {
            return undefined;
        }
        const scalar = this.context.lookupIdentifierValue(left);
        if (scalar?.kind === "number") {
            return {
                kind: "number",
                cpp: `(${scalar.cpp} = ${this.context.compileNumber(expression.right, "double")})`,
                dataType: { kind: "number" },
                impure: true,
            };
        }
        if (scalar?.kind === "boolean") {
            return {
                kind: "boolean",
                cpp: `(${scalar.cpp} = ${this.context.compileCondition(expression.right)})`,
                dataType: { kind: "boolean" },
                impure: true,
            };
        }
        const target = this.compileDataPath(expression.left, "read");
        if (target?.kind !== "data" || !target.dataType) {
            return undefined;
        }
        if (target.dataType.kind === "function") {
            const value = this.compileForSink(
                expression.right,
                target.dataType,
            );
            return this.leafValue(
                `(${target.cpp} = ${value})`,
                target.dataType,
            );
        }
        const assignable = target.dataType.kind === "optional" &&
            [
                "number",
                "vector",
                "map",
                "set",
                "f64array",
                "f32array",
                "u8array",
                "u16array",
                "i16array",
                "u32array",
                "i32array",
            ].includes(target.dataType.inner.kind);
        if (!assignable) return undefined;
        const value = this.compileForSink(
            expression.right,
            target.dataType,
        );
        return this.leafValue(
            `(${target.cpp} = ${value})`,
            target.dataType,
        );
    }

    /** Arguments for a stored std::function, including omitted TS optionals. */
    public compileFunctionArguments(
        call: ts.CallExpression,
        functionType: DataType & { kind: "function" },
        label = "Stored function",
    ): string[] {
        if (call.arguments.length > functionType.parameters.length) {
            this.context.fail(
                call,
                `${label} expects at most ${functionType.parameters.length} arguments.`,
            );
        }
        return functionType.parameters.map((parameter, index) => {
            const argument = call.arguments[index];
            if (argument) {
                return this.compileForSink(argument, parameter);
            }
            if (parameter.kind !== "optional") {
                this.context.fail(
                    call,
                    `${label} expects ${functionType.parameters.length} arguments.`,
                );
            }
            this.context.reachJsData();
            return "std::nullopt";
        });
    }

    /** Container root each live alias refers into, for invalidation. */
    private readonly aliasRoots = new Map<string, string>();

    /** Container locals whose length generation knows; see below. */
    private readonly fixedLengths = new Map<string, number>();

    /**
     * Records that `cppName` holds exactly `length` elements for as long
     * as it lives, so `.length` on it folds to a number.
     *
     * The caller establishes that from the declaration: a `const` bound
     * to an array literal, with no resizing method call, no whole-name
     * reassignment and no `.length` write against that name anywhere in
     * the entry source. That scan is what makes the fold independent of
     * the order statements compile in — a `while (i < a.length)` that
     * pushes inside its own body never registers at all, rather than
     * folding the bound before the push is reached.
     */
    public registerFixedLength(
        cppName: string,
        length: number,
    ): void {
        this.fixedLengths.set(cppName, length);
    }

    public registerLocal(
        cppName: string,
        ownership: "owned" | "copy",
    ): void {
        this.ownership.set(cppName, ownership);
    }

    /**
     * Registers a const local bound to a data path as a reference into
     * `containerCpp`. Writes through it reach the container; a later
     * structural mutation of that container poisons it.
     */
    public registerAlias(
        cppName: string,
        containerCpp: string,
    ): void {
        this.ownership.set(cppName, "alias");
        this.aliasRoots.set(
            cppName,
            this.rootName(containerCpp),
        );
    }

    /**
     * Marks every alias into `containerCpp` unusable: growing or
     * shrinking the backing vector can move its elements, so a
     * reference taken before the mutation no longer denotes the same
     * element (or any element at all).
     */
    public invalidateAliases(containerCpp: string): void {
        const root = this.rootName(containerCpp);
        for (const [name, aliasRoot] of this.aliasRoots) {
            if (
                aliasRoot === root &&
                this.ownership.get(name) === "alias"
            ) {
                this.ownership.set(name, "poisoned");
            }
        }
    }

    /** Captures alias states so a terminating branch can roll back. */
    public snapshotAliasState(): Map<string, string> {
        const snapshot = new Map<string, string>();
        for (const [name, state] of this.ownership) {
            snapshot.set(name, state);
        }
        return snapshot;
    }

    public restoreAliasState(
        snapshot: Map<string, string>,
    ): void {
        for (const [name, state] of snapshot) {
            this.ownership.set(
                name,
                state as LocalOwnership,
            );
        }
    }

    private rootName(cpp: string): string {
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(cpp);
        return match ? match[0] : cpp;
    }

    private markEscaped(value: Value): void {
        if (
            value.kind !== "data" ||
            value.dataType?.kind === "vector" ||
            (value.dataType?.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    value.dataType.name,
                ))
        ) {
            return;
        }
        const root = this.rootName(value.cpp);
        if (this.ownership.get(root) === "owned") {
            this.ownership.set(root, "escaped");
        }
    }

    /**
     * Maps the checker type at a node into the data model, or undefined for
     * non-data types.
     */
    /**
     * Whether a property or element chain can be a plain-data owner. A
     * chain rooted in a scene, engine or asset container -- `scene.lights`,
     * `container.meshes` -- names an engine handle collection that the
     * handle-collection arms own; compiling it as data would refuse it
     * before those arms are asked. Every other root (a record, an event, a
     * handle whose property rules expose data) is compiled and answered by
     * what comes back.
     */
    public plainDataOwnerChain(expression: ts.Expression): boolean {
        let node = this.context.unwrap(expression);
        while (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            node = this.context.unwrap(node.expression);
        }
        if (!ts.isIdentifier(node)) return true;
        const bound = this.context.lookupIdentifierValue(node);
        return (
            bound?.kind !== "scene" &&
            bound?.kind !== "engine" &&
            bound?.kind !== "asset"
        );
    }

    public dataTypeAt(node: ts.Node): DataType | undefined {
        return this.context.dataTypes.fromTsType(
            this.context.checker.getTypeAtLocation(node),
            node,
        );
    }

    /**
     * Compiles an identifier/property/element path rooted at a data local or
     * a static table. Returns undefined when the expression is not a data
     * path; fails only for definite data-model errors.
     */
    public compileDataPath(
        expression: ts.Expression,
        mode: "read" | "write",
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const bound =
                this.context.lookupIdentifierValue(
                    unwrapped,
                );
            if (bound?.kind !== "data") {
                // A module-level `const Record<Union, T> = { ... }` has no
                // runtime local binding. Materialize its typed literal at
                // the use site so a runtime enum index can select a slot;
                // compiling the object without this contextual type would
                // treat numeric members such as Math.PI as arbitrary record
                // values instead of number sinks.
                const type = this.dataTypeAt(unwrapped);
                const resolved =
                    type?.kind === "enummap"
                        ? this.context.resolveStaticExpression(unwrapped)
                        : unwrapped;
                if (
                    type?.kind === "enummap" &&
                    resolved !== unwrapped &&
                    ts.isObjectLiteralExpression(resolved)
                ) {
                    return this.leafValue(
                        `(${this.compileForSink(resolved, type)})`,
                        type,
                    );
                }
                return undefined;
            }
            const state = this.ownership.get(
                this.rootName(bound.cpp),
            );
            // A poisoned alias is unusable in either direction: its
            // container was structurally mutated after the binding, so
            // the reference no longer denotes the same element.
            if (state === "poisoned") {
                this.context.fail(
                    unwrapped,
                    `'${unwrapped.text}' refers into a container that was resized after the binding; re-read the element instead of using the stale reference.`,
                );
            }
            if (mode === "write") {
                const referenceStruct =
                    (bound.dataType?.kind === "struct" &&
                        this.context.dataTypes.isReferenceStruct(
                            bound.dataType.name,
                        )) ||
                    (bound.dataType?.kind === "optional" &&
                        bound.dataType.inner.kind === "struct" &&
                        this.context.dataTypes.isReferenceStruct(
                            bound.dataType.inner.name,
                        ));
                if (state === "copy" && !referenceStruct) {
                    this.context.fail(
                        unwrapped,
                        `'${unwrapped.text}' is a value copy of a data path; writes through aliases are outside the supported subset.`,
                    );
                }
                if (state === "escaped" && !referenceStruct) {
                    this.context.fail(
                        unwrapped,
                        `'${unwrapped.text}' was copied into another data location; later writes through it are outside the supported subset.`,
                    );
                }
            }
            return bound;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.expression.kind ===
                ts.SyntaxKind.ThisKeyword
        ) {
            // A class field resolves to the local it was bound to, so
            // container methods and alias tracking see the same
            // storage a field read outside the method sees.
            const field = this.context.resolveThisField(
                unwrapped.name.text,
            );
            return field &&
                (field.kind === "data" ||
                    field.kind === "number" ||
                    field.kind === "boolean")
                ? field
                : undefined;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const staticTypedArrayLength =
                this.staticTypedArrayLength(unwrapped);
            if (staticTypedArrayLength !== undefined) {
                return {
                    kind: "number",
                    cpp: doubleLiteral(
                        staticTypedArrayLength,
                    ),
                    staticNumber: staticTypedArrayLength,
                    dataType: { kind: "number" },
                };
            }
            // A declared property of an engine handle that the table types
            // as plain data — a name, an id — is a data path too, read
            // through the one table every other read site uses.
            const declared = unwrapped.questionDotToken
                ? undefined
                : this.context.declaredDataProperty(unwrapped);
            if (declared) {
                return declared;
            }
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            // A member of a compile-time record — including a getter,
            // which re-reads its state here — is a data path when the
            // member it yields is data.
            const member = unwrapped.questionDotToken
                ? undefined
                : this.context.resolveRecordMember(unwrapped);
            if (member) {
                return member.kind === "data" ||
                    member.kind === "number" ||
                    member.kind === "boolean"
                    ? member
                    : undefined;
            }
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            // Optional chaining is the one data path whose owner may be a
            // value-producing call (`map.get(key)?.field`) rather than a
            // path itself. An unchecked object-array element also carries a
            // separate existence predicate, so ask for its guarded form
            // before the ordinary direct-index path loses that information.
            const guardedOwner =
                unwrapped.questionDotToken &&
                ts.isElementAccessExpression(
                    this.context.unwrap(unwrapped.expression),
                )
                    ? this.compileGuardableElementAccess(
                          this.context.unwrap(
                              unwrapped.expression,
                          ) as ts.ElementAccessExpression,
                      )
                    : undefined;
            const owner =
                guardedOwner ??
                this.compileDataPath(
                    unwrapped.expression,
                    mode,
                ) ??
                (ts.isCallExpression(
                    this.context.unwrap(unwrapped.expression),
                )
                    ? this.context.compileValue(
                          unwrapped.expression,
                      )
                    : undefined) ??
                (ts.isElementAccessExpression(
                    this.context.unwrap(unwrapped.expression),
                )
                    ? this.context.compileValue(
                          unwrapped.expression,
                      )
                    : undefined) ??
                (unwrapped.questionDotToken &&
                !this.namesHandleCollection(unwrapped.expression)
                    ? this.context.compileValue(
                          unwrapped.expression,
                      )
                    : undefined);
            if (!owner) {
                return undefined;
            }
            if (unwrapped.questionDotToken) {
                const optional = this.optionalPropertyRead(
                    owner,
                    unwrapped,
                );
                if (optional) return optional;
            }
            return this.propertyRead(
                owner,
                unwrapped,
            );
        }
        if (ts.isElementAccessExpression(unwrapped)) {
            // Static tables materialize only under runtime indices; static
            // indices keep the legacy compile-time tuple folding so existing
            // generated scenes stay byte-identical.
            const owner =
                this.compileDataPath(
                    unwrapped.expression,
                    mode,
                ) ??
                (unwrapped.questionDotToken &&
                !this.namesHandleCollection(unwrapped.expression)
                    ? this.context.compileValue(
                          unwrapped.expression,
                      )
                    : undefined) ??
                (this.isStaticIndex(
                    unwrapped.argumentExpression,
                )
                    ? undefined
                    : (this.materializeStaticTable(
                          unwrapped.expression,
                      ) ??
                      this.materializeConstantArray(
                          unwrapped.expression,
                      )));
            if (!owner) {
                return undefined;
            }
            if (unwrapped.questionDotToken) {
                const optional = this.optionalElementRead(
                    owner,
                    unwrapped,
                );
                if (optional) return optional;
            }
            return this.elementRead(
                owner,
                unwrapped,
                mode,
            );
        }
        return undefined;
    }

    /**
     * Continues a data path whose owner was produced by another lowering
     * surface (for example, a dynamically indexed compile-time record).
     */
    public compilePropertyFromValue(
        owner: Value,
        access: ts.PropertyAccessExpression,
    ): Value | undefined {
        return this.propertyRead(owner, access);
    }

    /** Index a data value produced by a call rather than by a named path. */
    public compileElementFromValue(
        owner: Value,
        index: ts.Expression,
    ): Value | undefined {
        if (owner.kind !== "data" || !owner.dataType) {
            return undefined;
        }
        return this.elementRead(
            owner,
            ts.factory.createElementAccessExpression(
                ts.factory.createIdentifier("value"),
                index,
            ),
            "read",
        );
    }

    /**
     * Selects the non-null owner of an optional-chain access and preserves
     * the source's absence as one flattened `Nullable<T>` result.
     *
     * Data optionals use their native presence bit. Unchecked object-array
     * reads already carry `optionalFoundCpp` plus a safe default reference;
     * retaining that predicate here gives `rows[i]?.field` JavaScript's
     * missing-index behavior without touching invalid storage.
     */
    private optionalAccess(
        owner: Value,
        access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
        read: (presentOwner: Value) => Value | undefined,
    ): Value | undefined {
        const { optionalFoundCpp, optionalStorageCpp, ...plainOwner } =
            owner;
        let present: string;
        let presentOwner: Value;
        if (owner.dataType?.kind === "optional") {
            const temporary =
                this.context.allocateTemporaryCppName(
                    "optional_chain",
                );
            // A reference: the chain reads through the owner and drops it,
            // so a lookup that answers with a reference into its container
            // (a Map of objects) costs no copy, and a temporary lives to the
            // end of the chain either way.
            this.context.emit(
                `[[maybe_unused]] const auto& ${temporary} = ${owner.cpp};`,
            );
            present = `${temporary}.has_value()`;
            presentOwner = {
                ...plainOwner,
                kind: "data",
                cpp: `(*${temporary})`,
                dataType: owner.dataType.inner,
            };
        } else if (optionalFoundCpp !== undefined) {
            if (
                owner.dataType?.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    owner.dataType.name,
                )
            ) {
                // A nullable object lookup can spell the same call in both
                // its pointer and presence expressions. Optional chaining
                // evaluates that owner once, so bind the safe shared pointer
                // before reading either part.
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "optional_chain",
                    );
                this.context.emit(
                    `[[maybe_unused]] const auto& ${temporary} = ${owner.cpp};`,
                );
                const bound = this.leafValue(temporary, owner.dataType);
                present = bound.optionalFoundCpp!;
                presentOwner = {
                    ...plainOwner,
                    cpp: temporary,
                    objectIdentityCpp: bound.objectIdentityCpp!,
                };
            } else {
                present = optionalFoundCpp;
                presentOwner = plainOwner;
            }
        } else if (
            owner.dataType?.kind === "struct" &&
            this.context.dataTypes.isReferenceStruct(
                owner.dataType.name,
            )
        ) {
            // Stored objects encode absence as an empty shared pointer. A
            // parameter can acquire that representation after its binding
            // was first classified, so derive the presence test from the
            // representation here instead of relying solely on metadata
            // captured at the binding site.
            present = `static_cast<bool>(${owner.cpp})`;
            presentOwner = plainOwner;
        } else {
            return undefined;
        }

        const selected = read(presentOwner);
        if (!selected) {
            // The owner can also be an optional engine handle. Its declared
            // property surface, rather than the plain-data model, owns that
            // read and will retain the same presence predicate.
            return undefined;
        }
        if (!selected.dataType) {
            // Resolved engine properties can be discovered while probing a
            // condition as a data path, but their resource/value shape is
            // owned by the normal property compiler. Let that surface lower
            // the access so it can preserve both the owner's and property's
            // presence predicates.
            return undefined;
        }
        const selectedPresent = selected.optionalFoundCpp;
        const combinedPresent = selectedPresent
            ? `(${present} && ${selectedPresent})`
            : present;
        if (
            selected.dataType.kind === "struct" &&
            this.context.dataTypes.isReferenceStruct(
                selected.dataType.name,
            )
        ) {
            const cppType = this.context.dataTypes.cppType(
                selected.dataType,
            );
            return this.leafValue(
                `(${combinedPresent} ? ${selected.cpp} : ${cppType}{})`,
                selected.dataType,
            );
        }
        const checkerType = this.dataTypeAt(access);
        const resultType: DataType =
            checkerType?.kind === "optional"
                ? checkerType
                : selected.dataType.kind === "optional"
                  ? selected.dataType
                  : {
                        kind: "optional",
                        inner: selected.dataType,
                    };
        const selectedCpp =
            selected.dataType.kind === "optional"
                ? selected.cpp
                : this.compileKnownValueForSink(
                      selected,
                      resultType.kind === "optional"
                          ? resultType.inner
                          : resultType,
                      access,
                  );
        const cppType =
            this.context.dataTypes.cppType(resultType);
        this.context.reachJsData();
        return {
            kind: "data",
            cpp:
                `(${combinedPresent} ? ${cppType}{${selectedCpp}} : ` +
                `${cppType}{std::nullopt})`,
            dataType: resultType,
        };
    }

    private optionalPropertyRead(
        owner: Value,
        access: ts.PropertyAccessExpression,
    ): Value | undefined {
        return this.optionalAccess(
            owner,
            access,
            (presentOwner) =>
                this.propertyRead(presentOwner, access) ??
                this.context.readResolvedProperty(
                    presentOwner,
                    access,
                ),
        );
    }

    private optionalElementRead(
        owner: Value,
        access: ts.ElementAccessExpression,
    ): Value | undefined {
        return this.optionalAccess(
            owner,
            access,
            (presentOwner) =>
                this.guardableElementRead(
                    presentOwner,
                    access,
                ) ??
                this.elementRead(presentOwner, access, "read"),
        );
    }

    /**
     * Index a static table expression supplied by another lowering rewrite.
     * Keeping the original owner node matters: TypeScript's checker cannot
     * resolve symbols on a freshly synthesized element-access parent.
     */
    public compileMaterializedElementAccess(
        ownerExpression: ts.Expression,
        indexExpression: ts.Expression,
    ): Value | undefined {
        if (this.isStaticIndex(indexExpression)) {
            return undefined;
        }
        const owner =
            this.materializeStaticTable(ownerExpression) ??
            this.materializeConstantArray(ownerExpression) ??
            this.materializeKnownTuple(ownerExpression);
        if (!owner) {
            return undefined;
        }
        return this.elementRead(
            owner,
            ts.factory.createElementAccessExpression(
                ownerExpression,
                indexExpression,
            ),
        );
    }

    public materializeKnownTuple(
        expression: ts.Expression,
    ): Value | undefined {
        const known = this.context.compileValue(expression);
        if (known.kind !== "tuple") {
            return undefined;
        }
        const container = this.dataTypeAt(expression);
        const element =
            container?.kind === "vector" ||
            container?.kind === "span"
                ? container.element
                : undefined;
        if (!element) {
            return undefined;
        }
        const values = (known.tupleElements ?? []).map(
            (entry) =>
                this.compileKnownValueForSink(
                    entry,
                    element,
                    expression,
                ),
        );
        const unwrapped = this.context.unwrap(expression);
        const symbol = ts.isIdentifier(unwrapped)
            ? this.context.checker.getSymbolAtLocation(
                  unwrapped,
              )
            : undefined;
        const declaration =
            symbol?.declarations?.[0] ?? unwrapped;
        let local = false;
        for (
            let current: ts.Node | undefined = declaration.parent;
            current && !ts.isSourceFile(current);
            current = current.parent
        ) {
            if (ts.isFunctionLike(current)) {
                local = true;
                break;
            }
        }
        if (local) {
            this.context.reachJsData();
            return {
                kind: "data",
                cpp:
                    `bbl::js::Array<${this.context.dataTypes.cppType(element)}>{` +
                    `${values.join(", ")}}`,
                dataType: { kind: "vector", element },
                freshData: true,
            };
        }
        const name =
            this.context.dataTypes.registerConstantArray(
                declaration,
                ts.isIdentifier(unwrapped)
                    ? unwrapped.text
                    : "static_values",
                this.context.dataTypes.cppType(element),
                values,
            );
        this.context.reachJsData();
        return {
            kind: "data",
            cpp: `bblscene::${name}`,
            dataType: { kind: "span", element },
        };
    }

    private staticTypedArrayLength(
        access: ts.PropertyAccessExpression,
    ): number | undefined {
        if (access.name.text !== "length") {
            return undefined;
        }
        return this.staticTypedArrayLengthOf(access.expression);
    }

    /**
     * The length of a typed array whose construction is statically
     * resolvable — `new Float32Array(16)` or a literal-seeded
     * constructor. A typed array never resizes, so this length also
     * bounds every later element access.
     */
    private staticTypedArrayLengthOf(
        expression: ts.Expression,
    ): number | undefined {
        return this.typedArrayConstructionLength(
            this.context.resolveStaticExpression(expression),
        );
    }

    /**
     * The construction length of a `const`-bound typed array, read off
     * its declaration. Sound for the in-bounds proof alone: a typed
     * array never resizes and `const` bars rebinding, so element
     * writes through the binding cannot change its length. Kept off
     * the `.length` read path, which must keep emitting the live read.
     */
    private declaredConstTypedArrayLength(
        expression: ts.Expression,
    ): number | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) {
            return undefined;
        }
        const declarations =
            this.context.checker.getSymbolAtLocation(unwrapped)
                ?.declarations ?? [];
        if (declarations.length !== 1) {
            return undefined;
        }
        const declaration = declarations[0]!;
        if (
            !ts.isVariableDeclaration(declaration) ||
            !ts.isVariableDeclarationList(declaration.parent) ||
            (declaration.parent.flags & ts.NodeFlags.Const) ===
                0 ||
            declaration.initializer === undefined
        ) {
            return undefined;
        }
        return this.typedArrayConstructionLength(
            this.context.unwrap(declaration.initializer),
        );
    }

    private typedArrayConstructionLength(
        source: ts.Expression,
    ): number | undefined {
        if (
            !ts.isNewExpression(source) ||
            !ts.isIdentifier(source.expression) ||
            ![
                "Float32Array",
                "Float64Array",
                "Uint8Array",
                "Uint16Array",
                "Int16Array",
                "Uint32Array",
                "Int32Array",
            ].includes(
                source.expression.text,
            ) ||
            this.context.lookupIdentifierValue(
                source.expression,
            ) ||
            source.arguments?.length !== 1
        ) {
            return undefined;
        }
        const argument = this.context.resolveStaticExpression(
            source.arguments[0]!,
        );
        if (ts.isArrayLiteralExpression(argument)) {
            return argument.elements.length;
        }
        const count = staticNumberValue(
            this.context,
            argument,
        );
        return count !== undefined &&
            Number.isInteger(count) &&
            count >= 0
            ? count
            : undefined;
    }

    private isStaticIndex(
        expression: ts.Expression,
    ): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const bound =
                this.context.lookupIdentifierValue(
                    unwrapped,
                );
            if (bound) {
                return (
                    bound.kind === "number" &&
                    bound.staticNumber !== undefined
                );
            }
        }
        const resolved =
            this.context.resolveStaticExpression(
                unwrapped,
            );
        return this.isStaticLeafNumber(resolved);
    }

    /**
     * Applies the checker's null narrowing to a declaration initializer:
     * when the declared binding's type is the non-null inner type of an
     * optional storage value, the copy dereferences the optional.
     */
    public narrowForDeclaration(
        value: Value,
        bindingName: ts.Node,
    ): Value {
        if (
            value.kind !== "data" ||
            value.dataType?.kind !== "optional" ||
            value.preserveUncheckedLookup
        ) {
            return value;
        }
        const declared = this.context.dataTypes.fromTsType(
            this.context.checker.getTypeAtLocation(
                bindingName,
            ),
            bindingName,
        );
        if (
            declared &&
            declared.kind !== "optional" &&
            dataTypesEqual(declared, value.dataType.inner)
        ) {
            return {
                ...value,
                ...this.leafValue(
                    `(*${value.cpp})`,
                    declared,
                ),
            };
        }
        return value;
    }

    /**
     * A nullable the source has already guarded, as the value it was
     * narrowed to.
     *
     * The narrowing is the checker's, read through this repository's own
     * type mapping rather than a `TypeFlags` test, so it holds for any
     * inner type rather than for numbers alone. Shared with the static
     * evaluator, which needs the same answer where a guarded optional
     * reaches a numeric position -- `simulatedFrames >=
     * captureAfterFrames` after `captureAfterFrames !== null` is how
     * every physics scene compares its freeze counter.
     */
    public narrowOptional(
        value: Value,
        expression: ts.Expression,
    ): Value {
        if (
            value.kind !== "data" ||
            value.dataType?.kind !== "optional"
        ) {
            return value;
        }
        const narrowed = this.dataTypeAt(expression);
        if (
            narrowed &&
            narrowed.kind !== "optional" &&
            dataTypesEqual(narrowed, value.dataType.inner)
        ) {
            return {
                ...value,
                ...this.leafValue(
                    `(*${value.cpp})`,
                    value.dataType.inner,
                ),
            };
        }
        return value;
    }

    /**
     * `left ?? right` over the data model — the general operator, taken
     * after the handle-collection concept and the static-record fold have
     * both declined.
     *
     * Three arms, decided by the left operand's own shape:
     *
     *  - a handle a search produced (`optionalFoundCpp`) selects on its
     *    found flag — a generation-resolved find is the result outright,
     *    a loaded search emits the ternary, and a fallback that can
     *    itself miss composes its flag into the result's;
     *  - an `optional(T)` left evaluates once into a temporary and
     *    selects natively. The right side compiles for the inner type's
     *    own sink and stays inside the ternary, so it is evaluated only
     *    when the left is null — JavaScript's own laziness (its
     *    materialization prep, like a conditional branch's, is emitted
     *    unconditionally, which is the established stance for
     *    effect-free preparation);
     *  - a left the model already proves non-nullish (a number, boolean,
     *    string, or non-optional data value) IS the result, and the dead
     *    right side is discarded exactly as JavaScript never evaluates
     *    it.
     *
     * Anything else returns undefined and the caller's refusal names the
     * routes.
     */
    public compileNullishCoalesce(
        expression: ts.BinaryExpression,
    ): Value | undefined {
        const left = this.context.compileValue(expression.left);
        if (left.kind === "json-null") {
            return this.context.compileValue(
                expression.right,
            );
        }
        if (
            left.kind === "record" ||
            left.kind === "tuple"
        ) {
            return left;
        }
        if (left.optionalFoundCpp !== undefined) {
            // A handle a search produced: upstream's `find` yields
            // `undefined` on a miss, and `??` selects the fallback
            // exactly then. A generation-resolved find carries the
            // constant "true" and is the result outright; a loaded
            // search selects on its found flag. The fallback must be
            // the same handle kind; a fallback that can itself miss
            // composes its flag into the result's.
            if (left.optionalFoundCpp === "true") {
                return left;
            }
            const fallback = this.context.compileValue(
                expression.right,
            );
            if (
                fallback.kind === "json-null" &&
                left.dataType !== undefined
            ) {
                if (
                    left.dataType.kind === "struct" &&
                    this.context.dataTypes.isReferenceStruct(
                        left.dataType.name,
                    )
                ) {
                    const cppType =
                        this.context.dataTypes.cppType(
                            left.dataType,
                        );
                    return {
                        ...left,
                        cpp:
                            `(${left.optionalFoundCpp} ? ${left.cpp} : ` +
                            `${cppType}{})`,
                        objectIdentityCpp:
                            `(${left.optionalFoundCpp} ? ` +
                            `${left.objectIdentityCpp ?? `${left.cpp}.get()`} : nullptr)`,
                    };
                }
                const optionalType: DataType = {
                    kind: "optional",
                    inner: left.dataType,
                };
                const cppType =
                    this.context.dataTypes.cppType(optionalType);
                this.context.reachJsData();
                const objectIdentity =
                    left.dataType.kind === "struct"
                        ? `(${left.optionalFoundCpp} ? std::addressof(${left.cpp}) : nullptr)`
                        : undefined;
                return {
                    kind: "data",
                    cpp:
                        `(${left.optionalFoundCpp} ? ${cppType}{${left.cpp}} : ` +
                        `${cppType}{std::nullopt})`,
                    dataType: optionalType,
                    optionalFoundCpp: left.optionalFoundCpp,
                    ...(objectIdentity
                        ? { objectIdentityCpp: objectIdentity }
                        : {}),
                };
            }
            if (fallback.kind === "json-null") {
                // `optionalResource ?? undefined` remains the same optional
                // resource. Keep its presence flag so a later real fallback
                // can select without dereferencing empty storage.
                return left;
            }
            if (
                left.kind === "data" &&
                left.dataType?.kind === "struct" &&
                fallback.kind === "record"
            ) {
                return {
                    ...this.leafValue(
                        `(${left.optionalFoundCpp} ? ${left.cpp} : ` +
                            `${this.compileKnownValueForSink(fallback, left.dataType, expression.right)})`,
                        left.dataType,
                    ),
                    freshData: true,
                };
            }
            if (
                left.kind === "data" &&
                fallback.kind === "data" &&
                left.dataType?.kind === "struct" &&
                fallback.dataType?.kind === "struct"
            ) {
                const common =
                    this.context.dataTypes.commonStruct(
                        left.dataType,
                        fallback.dataType,
                    );
                if (common) {
                    return {
                        ...this.leafValue(
                            `(${left.optionalFoundCpp} ? ` +
                                `${this.compileKnownValueForSink(left, common, expression.left)} : ` +
                                `${this.compileKnownValueForSink(fallback, common, expression.right)})`,
                            common,
                        ),
                        freshData: true,
                    };
                }
            }
            if (fallback.kind !== left.kind) {
                this.context.fail(
                    expression.right,
                    `A missed search's fallback must be the same ` +
                        `handle kind; expected ${left.kind}, received ` +
                        `${fallback.kind}.`,
                );
            }
            // A fallback that can itself miss (an indexed element) keeps
            // the question open: the composed flag is what a scene's own
            // not-found guard then reads. Both operands are guarded
            // temporaries, so the select is safe either way.
            const composedFound =
                fallback.optionalFoundCpp !== undefined
                    ? `(${left.optionalFoundCpp} || ${fallback.optionalFoundCpp})`
                    : undefined;
            return {
                kind: left.kind,
                cpp:
                    `(${left.optionalFoundCpp} ? ${left.cpp} : ` +
                    `${fallback.cpp})`,
                ...(left.dataType !== undefined
                    ? { dataType: left.dataType }
                    : {}),
                ...(left.engineCpp !== undefined
                    ? { engineCpp: left.engineCpp }
                    : {}),
                ...(composedFound !== undefined
                    ? { optionalFoundCpp: composedFound }
                    : {}),
            };
        }
        if (
            left.kind === "data" &&
            left.dataType?.kind === "optional"
        ) {
            const inner = left.dataType.inner;
            const temp =
                this.context.allocateTemporaryCppName("nullish");
            this.context.emit(`const auto ${temp} = ${left.cpp};`);
            const right = this.context.unwrap(expression.right);
            if (
                right.kind === ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(right) &&
                    right.text === "undefined" &&
                    !this.context.lookupIdentifierValue(right))
            ) {
                return {
                    kind: "data",
                    cpp: temp,
                    dataType: left.dataType,
                };
            }
            if (
                inner.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(inner.name)
            ) {
                const fallback = this.compileForSink(
                    expression.right,
                    inner,
                );
                return this.leafValue(
                    `(${temp} ? ${temp} : ${fallback})`,
                    inner,
                );
            }
            const rightType = this.dataTypeAt(
                expression.right,
            );
            if (
                rightType &&
                dataTypesEqual(
                    rightType,
                    left.dataType,
                )
            ) {
                const fallbackOptional =
                    this.compileForSink(
                        expression.right,
                        left.dataType,
                    );
                return {
                    kind: "data",
                    cpp:
                        `(${temp}.has_value() ? ${temp} : ` +
                        `${fallbackOptional})`,
                    dataType: left.dataType,
                };
            }
            const fallback = this.compileForSink(
                expression.right,
                inner,
            );
            // Through `leafValue`, so the select carries the inner
            // type's own Value kind — an optional number selects as a
            // number, an optional handle keeps its engine spelling —
            // instead of a bare "data" every consumer would have to
            // special-case.
            const selected = this.leafValue(
                `(${temp}.has_value() ? (*${temp}) : ${fallback})`,
                inner,
            );
            // The conditional materializes either branch as a new C++ value.
            // Mark composite results as owned so a local can mutate that
            // materialization before explicitly storing it back (the common
            // Map.get(key) ?? [] / push / Map.set grouping idiom).
            return passesByReference(this.context.dataTypes, inner)
                ? { ...selected, freshData: true }
                : selected;
        }
        if (
            left.kind === "number" ||
            left.kind === "boolean" ||
            left.kind === "string" ||
            (left.kind === "data" && left.dataType !== undefined)
        ) {
            return left;
        }
        return undefined;
    }

    private propertyRead(
        ownerValue: Value,
        access: ts.PropertyAccessExpression,
    ): Value | undefined {
        const property = access.name.text;
        const owner = this.narrowOptional(
            ownerValue,
            access.expression,
        );
        const dataType =
            owner.dataType ??
            (owner.kind === "string"
                ? ({ kind: "string" } as const)
                : undefined);
        if (!dataType) {
            return undefined;
        }
        if (dataType.kind === "handle") {
            // The path left the data model at a resource handle; the
            // engine's own property lowering owns everything past it.
            return undefined;
        }
        if (dataType.kind === "optional") {
            this.context.fail(
                access,
                `'${access.expression.getText()}' may be null here; narrow it before member access.`,
            );
        }
        if (dataType.kind === "struct") {
            const field =
                this.context.dataTypes.structField(
                    dataType.name,
                    property,
                    access,
                );
            const value = this.leafValue(
                this.context.dataTypes.isReferenceStruct(
                    dataType.name,
                )
                    ? `${owner.cpp}->${field.name}`
                    : `${owner.cpp}.${field.name}`,
                field.type,
            );
            const staticField =
                owner.recordProperties?.[property];
            if (staticField?.staticNumber !== undefined) {
                value.staticNumber = staticField.staticNumber;
            }
            if (staticField?.staticString !== undefined) {
                value.staticString = staticField.staticString;
            }
            if (staticField?.staticBoolean !== undefined) {
                value.staticBoolean = staticField.staticBoolean;
            }
            return value;
        }
        if (
            (dataType.kind === "vector" ||
                dataType.kind === "span" ||
                isTypedArrayType(dataType)) &&
            property === "length"
        ) {
            this.context.reachJsData();
            // A container built from a literal and never resized has a
            // length generation knows, and knowing it is what lets a
            // counted `for` over it unroll — the difference between three
            // mesh records and one `createBox` run three times.
            const fixed = this.fixedLengths.get(
                this.rootName(owner.cpp),
            );
            return {
                kind: "number",
                cpp: `bbl::js::array_length(${owner.cpp})`,
                ...(fixed === undefined
                    ? {}
                    : { staticNumber: fixed }),
                dataType: { kind: "number" },
            };
        }
        if (
            (dataType.kind === "map" || dataType.kind === "set") &&
            property === "size"
        ) {
            return {
                kind: "number",
                cpp: `static_cast<double>(${owner.cpp}.size())`,
                dataType: { kind: "number" },
            };
        }
        if (
            dataType.kind === "map" &&
            dataType.key.kind === "string"
        ) {
            this.context.reachJsData();
            return {
                ...this.leafValue(
                    `${owner.cpp}.get(${this.context.cppString(property)})`,
                    { kind: "optional", inner: dataType.value },
                ),
                preserveUncheckedLookup: true,
            };
        }
        if (dataType.kind === "u8array") {
            if (property === "buffer") {
                return {
                    kind: "data",
                    cpp: `${owner.cpp}.buffer()`,
                    dataType: { kind: "arraybuffer" },
                };
            }
            if (property === "byteOffset") {
                return {
                    kind: "number",
                    cpp: `static_cast<double>(${owner.cpp}.byte_offset())`,
                    dataType: { kind: "number" },
                };
            }
            if (property === "byteLength") {
                return {
                    kind: "number",
                    cpp: `static_cast<double>(${owner.cpp}.byte_length())`,
                    dataType: { kind: "number" },
                };
            }
        }
        if (
            dataType.kind === "arraybuffer" &&
            property === "byteLength"
        ) {
            return {
                kind: "number",
                cpp: `static_cast<double>(${owner.cpp}.byte_length())`,
                dataType: { kind: "number" },
            };
        }
        if (
            dataType.kind === "dataview" &&
            property === "byteLength"
        ) {
            return {
                kind: "number",
                cpp: `static_cast<double>(${owner.cpp}.byte_length())`,
                dataType: { kind: "number" },
            };
        }
        if (
            dataType.kind === "string" &&
            property === "length"
        ) {
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `static_cast<double>(${owner.cpp}.size())`,
                dataType: { kind: "number" },
            };
        }
        if (
            dataType.kind === "tuple" &&
            property === "length"
        ) {
            return {
                kind: "number",
                cpp: `${dataType.arity}.0`,
                staticNumber: dataType.arity,
            };
        }
        if (
            dataType.kind === "table" &&
            property === "length"
        ) {
            const length = dataType.dimensions[0]!;
            return {
                kind: "number",
                cpp: `${length}.0`,
                staticNumber: length,
            };
        }
        this.context.fail(
            access,
            `Unsupported data property '${property}' on ${dataType.kind}.`,
        );
    }

    private elementRead(
        ownerValue: Value,
        access: ts.ElementAccessExpression,
        mode: "read" | "write" = "read",
    ): Value | undefined {
        const owner = this.narrowOptional(
            ownerValue,
            access.expression,
        );
        const dataType = owner.dataType;
        if (!dataType) {
            return undefined;
        }
        if (dataType.kind === "map") {
            const key = this.compileForSink(
                access.argumentExpression,
                dataType.key,
            );
            this.context.reachJsData();
            return {
                ...this.leafValue(
                    `${owner.cpp}.get(${key})`,
                    { kind: "optional", inner: dataType.value },
                ),
                preserveUncheckedLookup: true,
            };
        }
        if (dataType.kind === "enummap") {
            // A `Record` is keyed by the union's tag, not by a number,
            // so the index compiles as that enum and selects its slot.
            const tag = this.compileEnumIndex(
                access.argumentExpression,
                dataType.enumName,
            );
            this.context.reachJsData();
            return this.leafValue(
                `bbl::js::enum_map_at(${owner.cpp}, ${tag})`,
                dataType.element,
            );
        }
        if (dataType.kind === "struct") {
            const keyType = this.dataTypeAt(
                access.argumentExpression,
            );
            if (keyType?.kind !== "enum") {
                this.context.fail(
                    access.argumentExpression,
                    "Dynamic struct access requires a finite string-literal key union.",
                );
            }
            const members =
                this.context.dataTypes.enumMembers(
                    keyType.name,
                );
            if (members.length === 0) {
                this.context.fail(
                    access.argumentExpression,
                    "Dynamic struct access requires at least one key.",
                );
            }
            const fields = members.map((member) =>
                this.context.dataTypes.structField(
                    dataType.name,
                    member,
                    access,
                ),
            );
            const fieldType = fields[0]!.type;
            if (
                fields.some(
                    (field) =>
                        !dataTypesEqual(
                            field.type,
                            fieldType,
                        ),
                )
            ) {
                this.context.fail(
                    access,
                    "Dynamic struct keys must select fields with one common data type.",
                );
            }
            const key = this.compileEnumIndex(
                access.argumentExpression,
                keyType.name,
            );
            const keyTemporary =
                this.context.allocateTemporaryCppName(
                    "property_key",
                );
            this.context.emit(
                `[[maybe_unused]] const auto ${keyTemporary} = ${key};`,
            );
            const arrow =
                this.context.dataTypes.isReferenceStruct(
                    dataType.name,
                )
                    ? "->"
                    : ".";
            let selected =
                `${owner.cpp}${arrow}${fields.at(-1)!.name}`;
            for (let index = members.length - 2; index >= 0; --index) {
                const member = members[index]!;
                const memberCpp =
                    this.context.dataTypes.enumMemberCpp(
                        keyType,
                        member,
                        access,
                    );
                selected =
                    `(${keyTemporary} == ${memberCpp} ? ` +
                    `${owner.cpp}${arrow}${fields[index]!.name} : ${selected})`;
            }
            return this.leafValue(selected, fieldType);
        }
        const index = this.context.compileNumber(
            access.argumentExpression,
            "double",
        );
        this.context.reachJsData();
        const nativeIndex = `bbl::js::array_index(${index})`;
        if (dataType.kind === "string") {
            if (mode === "write") {
                this.context.fail(
                    access,
                    "String element writes are not supported.",
                );
            }
            return {
                kind: "string",
                cpp: `bbl::js::string_at(${owner.cpp}, ${nativeIndex})`,
                dataType: { kind: "string" },
            };
        }
        // Index provenance decides the emission arm. An index the
        // compiler proves in bounds — a static index against a
        // statically known length, or the induction variable of a
        // canonical `for (let i = 0; i < arr.length; i++)` over the
        // same array — keeps the raw fast path. Every other index
        // reads or writes through a checked accessor that refuses out
        // of bounds with this access's source location, in every build
        // configuration. JavaScript would yield `undefined` there; no
        // reached scene depends on that (a read whose result the
        // source tests already rides the `array_at_or_default`
        // found-flag path), so a reached out-of-bounds index is a
        // scene or compiler defect to surface, not a value to default.
        // A vector write stays on the JavaScript growth semantics
        // either way; the checked form only refuses an index no
        // JavaScript array element could have.
        const proven =
            this.indexProvenInBounds(owner, access, dataType) ||
            (dataType.kind === "vector" &&
                mode === "write" &&
                this.staticGrowthIndex(access));
        const site = (): string =>
            this.context.cppString(this.indexSiteLabel(access));
        const indexed =
            dataType.kind === "vector" && mode === "write"
                ? proven
                    ? `bbl::js::array_index_write(${owner.cpp}, ${nativeIndex})`
                    : `bbl::js::array_index_write_checked(${owner.cpp}, ${index}, ${site()})`
                : proven
                  ? `${owner.cpp}[${nativeIndex}]`
                  : mode === "write" &&
                      (isTypedArrayType(dataType) ||
                          dataType.kind === "tuple")
                    ? `bbl::js::array_store_checked(${owner.cpp}, ${index}, ${site()})`
                    : `bbl::js::array_index_checked(${owner.cpp}, ${index}, ${site()})`;
        if (
            isTypedArrayType(dataType)
        ) {
            // Reads widen to JavaScript numbers; writes keep the raw
            // element lvalue and record the storage so assignment inserts
            // the exact conversion (fround for f32, ToUint32 for u32).
            if (mode === "write") {
                return {
                    kind: "number",
                    cpp: indexed,
                    dataType: { kind: "number" },
                    dataStore: dataType.kind,
                };
            }
            return {
                kind: "number",
                cpp: `static_cast<double>(${indexed})`,
                dataType: { kind: "number" },
            };
        }
        switch (dataType.kind) {
            case "vector":
                return {
                    ...this.leafValue(
                        indexed,
                        dataType.element,
                    ),
                    ...(owner.readOnly
                        ? { readOnly: true as const }
                        : {}),
                };
            case "span":
                return {
                    ...this.leafValue(
                        indexed,
                        dataType.element,
                    ),
                    readOnly: true,
                };
            case "tuple":
                return {
                    kind: "number",
                    cpp: indexed,
                    dataType: { kind: "number" },
                };
            case "table": {
                const remaining =
                    dataType.dimensions.slice(1);
                if (remaining.length === 0) {
                    return {
                        kind: "number",
                        cpp: indexed,
                        dataType: { kind: "number" },
                    };
                }
                return {
                    kind: "data",
                    cpp: indexed,
                    dataType: {
                        kind: "table",
                        dimensions: remaining,
                    },
                };
            }
            default:
                this.context.fail(
                    access,
                    `Element access is not supported on data ${dataType.kind}.`,
                );
        }
    }

    /**
     * Whether this element access provably stays in bounds, so the raw
     * `values[array_index(i)]` fast path is sound. Two cheap proofs,
     * both over facts the emission site already holds:
     *
     *  - a static integer index against a statically known length — a
     *    tuple's arity, a constant table's leading dimension, a typed
     *    array's static construction length, or (outside runtime
     *    control flow, where the source walk is execution order) the
     *    exact element snapshot a generation-tracked array carries;
     *  - the induction variable of an enclosing canonical
     *    `for (let i = <static ≥ 0>; i < arr.length; i++)` over the
     *    same array, with a body that provably cannot shrink it.
     *
     * A static index a snapshot proves OUT of bounds is deliberately
     * not a generation-time refusal: an unrolled loop's dead-guarded
     * first iteration legitimately folds one (scene20 reads
     * `meshes[i - 1]` behind `level !== 0`), so it emits the checked
     * accessor and refuses only if reached.
     */
    private indexProvenInBounds(
        owner: Value,
        access: ts.ElementAccessExpression,
        dataType: DataType,
    ): boolean {
        const staticIndex = staticNumberValue(
            this.context,
            access.argumentExpression,
        );
        if (
            staticIndex !== undefined &&
            Number.isInteger(staticIndex) &&
            staticIndex >= 0
        ) {
            const bound = this.staticIndexBound(
                owner,
                access,
                dataType,
            );
            if (bound !== undefined && staticIndex < bound) {
                return true;
            }
        }
        return this.indexBoundByCanonicalLoop(access);
    }

    /**
     * Whether a growing Array write's index is statically a valid
     * JavaScript element index (an integer in `[0, 2^32-1)`). A vector
     * write can never read out of bounds — `array_index_write` extends
     * the array exactly as JavaScript does — so validity of the index
     * itself is the whole proof, with no length needed.
     */
    private staticGrowthIndex(
        access: ts.ElementAccessExpression,
    ): boolean {
        const staticIndex = staticNumberValue(
            this.context,
            access.argumentExpression,
        );
        return (
            staticIndex !== undefined &&
            Number.isInteger(staticIndex) &&
            staticIndex >= 0 &&
            staticIndex < 4294967295
        );
    }

    /** The statically known element count of `owner`, if it has one. */
    private staticIndexBound(
        owner: Value,
        access: ts.ElementAccessExpression,
        dataType: DataType,
    ): number | undefined {
        if (dataType.kind === "tuple") {
            return dataType.arity;
        }
        if (dataType.kind === "table") {
            return dataType.dimensions[0];
        }
        if (isTypedArrayType(dataType) && access.pos >= 0) {
            return (
                this.staticTypedArrayLengthOf(access.expression) ??
                this.declaredConstTypedArrayLength(
                    access.expression,
                )
            );
        }
        if (
            dataType.kind === "vector" &&
            !this.context.isInRuntimeControlFlow()
        ) {
            // The snapshot is exact at this point of the walk, and at
            // main scope the walk is execution order. Later writes only
            // grow the array (every shrinking route clears the
            // snapshot), so a static index below the snapshot length
            // stays in bounds. Inside runtime control flow emission
            // order is not execution order, so the snapshot proves
            // nothing there.
            return (owner.staticElementsOwner ?? owner)
                .staticElements?.length;
        }
        return undefined;
    }

    /**
     * Verdicts for `for` statements already examined by
     * `indexBoundByCanonicalLoop`, keyed on the loop node. `undefined`
     * records a loop that failed the canonical shape or the body scan.
     */
    private readonly canonicalLoopVerdicts = new Map<
        ts.ForStatement,
        | {
              indexSymbol: ts.Symbol;
              boundOwner: ts.Expression;
          }
        | undefined
    >();

    /**
     * Whether the access indexes with the induction variable of an
     * enclosing canonical length-bound `for` loop over the same array.
     * The emitted loop re-tests `i < arr.length` before every
     * iteration, so the read is in bounds as long as nothing between
     * the test and the read mutates `i` or shrinks the array — which
     * the body scan in `canonicalLoopFacts` rules out. The walk never
     * crosses a function boundary: a closure body does not run under
     * the loop's condition.
     */
    private indexBoundByCanonicalLoop(
        access: ts.ElementAccessExpression,
    ): boolean {
        const indexExpression = this.context.unwrap(
            access.argumentExpression,
        );
        if (!ts.isIdentifier(indexExpression)) {
            return false;
        }
        const indexSymbol =
            this.context.checker.getSymbolAtLocation(
                indexExpression,
            );
        if (!indexSymbol) {
            return false;
        }
        const ownerExpression = this.context.unwrap(
            access.expression,
        );
        if (!this.isSimplePath(ownerExpression)) {
            return false;
        }
        let child: ts.Node = access;
        for (
            let parent: ts.Node | undefined = access.parent;
            parent !== undefined && !ts.isSourceFile(parent);
            child = parent, parent = parent.parent
        ) {
            if (ts.isFunctionLike(parent)) {
                return false;
            }
            if (
                ts.isForStatement(parent) &&
                child === parent.statement
            ) {
                const facts = this.canonicalLoopFacts(parent);
                if (
                    facts !== undefined &&
                    facts.indexSymbol === indexSymbol &&
                    this.sameSimplePath(
                        facts.boundOwner,
                        ownerExpression,
                    )
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * The canonical-loop verdict for one `for` statement: its
     * induction symbol and the array its condition bounds, or
     * `undefined` when the loop is not `for (let i = <static ≥ 0>;
     * i < path.length; i++)` (also `++i` / `i += 1`) or its body could
     * mutate the induction variable or shrink an array. The body scan
     * is deliberately strict — any call other than through the global
     * `Math`, any `new`, any write to the induction variable, or any
     * `.length` assignment rejects — because a rejected loop merely
     * emits the checked accessor.
     */
    private canonicalLoopFacts(loop: ts.ForStatement):
        | {
              indexSymbol: ts.Symbol;
              boundOwner: ts.Expression;
          }
        | undefined {
        if (this.canonicalLoopVerdicts.has(loop)) {
            return this.canonicalLoopVerdicts.get(loop);
        }
        const facts = this.deriveCanonicalLoopFacts(loop);
        this.canonicalLoopVerdicts.set(loop, facts);
        return facts;
    }

    private deriveCanonicalLoopFacts(loop: ts.ForStatement):
        | {
              indexSymbol: ts.Symbol;
              boundOwner: ts.Expression;
          }
        | undefined {
        const initializer = loop.initializer;
        if (
            initializer === undefined ||
            !ts.isVariableDeclarationList(initializer) ||
            initializer.declarations.length !== 1
        ) {
            return undefined;
        }
        const declaration = initializer.declarations[0]!;
        if (
            !ts.isIdentifier(declaration.name) ||
            declaration.initializer === undefined
        ) {
            return undefined;
        }
        const start = staticNumberValue(
            this.context,
            declaration.initializer,
        );
        if (
            start === undefined ||
            !Number.isInteger(start) ||
            start < 0
        ) {
            return undefined;
        }
        const indexSymbol =
            this.context.checker.getSymbolAtLocation(
                declaration.name,
            );
        if (!indexSymbol) {
            return undefined;
        }
        const condition = loop.condition
            ? this.context.unwrap(loop.condition)
            : undefined;
        if (
            condition === undefined ||
            !ts.isBinaryExpression(condition) ||
            condition.operatorToken.kind !==
                ts.SyntaxKind.LessThanToken ||
            !this.isSameSymbolIdentifier(
                condition.left,
                indexSymbol,
            )
        ) {
            return undefined;
        }
        const bound = this.context.unwrap(condition.right);
        if (
            !ts.isPropertyAccessExpression(bound) ||
            bound.questionDotToken !== undefined ||
            bound.name.text !== "length" ||
            !this.isSimplePath(bound.expression)
        ) {
            return undefined;
        }
        if (!this.isCanonicalIncrement(loop.incrementor, indexSymbol)) {
            return undefined;
        }
        if (!this.loopBodyPreservesBounds(loop.statement, indexSymbol)) {
            return undefined;
        }
        return { indexSymbol, boundOwner: bound.expression };
    }

    private isSameSymbolIdentifier(
        expression: ts.Expression,
        symbol: ts.Symbol,
    ): boolean {
        const unwrapped = this.context.unwrap(expression);
        return (
            ts.isIdentifier(unwrapped) &&
            this.context.checker.getSymbolAtLocation(unwrapped) ===
                symbol
        );
    }

    private isCanonicalIncrement(
        incrementor: ts.Expression | undefined,
        indexSymbol: ts.Symbol,
    ): boolean {
        if (incrementor === undefined) {
            return false;
        }
        const unwrapped = this.context.unwrap(incrementor);
        if (
            (ts.isPostfixUnaryExpression(unwrapped) ||
                ts.isPrefixUnaryExpression(unwrapped)) &&
            unwrapped.operator === ts.SyntaxKind.PlusPlusToken
        ) {
            return this.isSameSymbolIdentifier(
                unwrapped.operand,
                indexSymbol,
            );
        }
        return (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.PlusEqualsToken &&
            this.isSameSymbolIdentifier(
                unwrapped.left,
                indexSymbol,
            ) &&
            staticNumberValue(this.context, unwrapped.right) === 1
        );
    }

    /**
     * Whether a canonical loop body provably leaves its own bounds
     * facts intact: no write to the induction variable, no `.length`
     * assignment, and no call or construction that could run scene
     * code (only reads through the global `Math` are pure by
     * declaration). With no calls, only statements directly in the
     * body can mutate anything, and the scan sees all of them —
     * including inside a nested closure, which without a call can
     * never run during the loop.
     */
    private loopBodyPreservesBounds(
        body: ts.Statement,
        indexSymbol: ts.Symbol,
    ): boolean {
        let safe = true;
        const visit = (node: ts.Node): void => {
            if (!safe) {
                return;
            }
            if (ts.isNewExpression(node)) {
                safe = false;
                return;
            }
            if (
                ts.isCallExpression(node) &&
                !this.isGlobalMathCall(node)
            ) {
                safe = false;
                return;
            }
            if (
                (ts.isPostfixUnaryExpression(node) ||
                    ts.isPrefixUnaryExpression(node)) &&
                (node.operator === ts.SyntaxKind.PlusPlusToken ||
                    node.operator ===
                        ts.SyntaxKind.MinusMinusToken) &&
                this.isSameSymbolIdentifier(
                    node.operand,
                    indexSymbol,
                )
            ) {
                safe = false;
                return;
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind >=
                    ts.SyntaxKind.FirstAssignment &&
                node.operatorToken.kind <=
                    ts.SyntaxKind.LastAssignment
            ) {
                const target = this.context.unwrap(node.left);
                if (
                    this.isSameSymbolIdentifier(
                        target,
                        indexSymbol,
                    ) ||
                    (ts.isPropertyAccessExpression(target) &&
                        target.name.text === "length")
                ) {
                    safe = false;
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(body);
        return safe;
    }

    /** A call through the global `Math` object, pure by declaration. */
    private isGlobalMathCall(call: ts.CallExpression): boolean {
        const callee = this.context.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            !ts.isIdentifier(callee.expression) ||
            callee.expression.text !== "Math"
        ) {
            return false;
        }
        const symbol = this.context.checker.getSymbolAtLocation(
            callee.expression,
        );
        const declarations = symbol?.declarations ?? [];
        return (
            declarations.length > 0 &&
            declarations.every((declaration) =>
                /(?:^|[\\/])lib\.[^\\/]*\.d\.ts$/i.test(
                    declaration.getSourceFile().fileName,
                ),
            )
        );
    }

    /**
     * A path of identifiers and plain property reads — the only owner
     * shape whose loop-condition spelling and body spelling are
     * guaranteed to denote the same array (a call could return a fresh
     * one each evaluation).
     */
    private isSimplePath(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (
            ts.isIdentifier(unwrapped) ||
            unwrapped.kind === ts.SyntaxKind.ThisKeyword
        ) {
            return true;
        }
        return (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.questionDotToken === undefined &&
            this.isSimplePath(unwrapped.expression)
        );
    }

    /**
     * Whether two simple paths denote the same storage: identical
     * member chains over the same root symbol (or `this`, which the
     * function-boundary stop in the ancestor walk keeps unambiguous).
     */
    private sameSimplePath(
        left: ts.Expression,
        right: ts.Expression,
    ): boolean {
        const a = this.context.unwrap(left);
        const b = this.context.unwrap(right);
        if (ts.isIdentifier(a) && ts.isIdentifier(b)) {
            const symbol =
                this.context.checker.getSymbolAtLocation(a);
            return (
                symbol !== undefined &&
                symbol ===
                    this.context.checker.getSymbolAtLocation(b)
            );
        }
        if (
            a.kind === ts.SyntaxKind.ThisKeyword &&
            b.kind === ts.SyntaxKind.ThisKeyword
        ) {
            return true;
        }
        return (
            ts.isPropertyAccessExpression(a) &&
            ts.isPropertyAccessExpression(b) &&
            a.name.text === b.name.text &&
            this.sameSimplePath(a.expression, b.expression)
        );
    }

    /**
     * The scene source location a checked accessor reports on an
     * out-of-bounds index, as a stable path relative to the corpus
     * root (falling back to the base name for a source outside it, and
     * to a fixed label for a synthesized access with no position).
     */
    private indexSiteLabel(access: ts.Node): string {
        const node =
            access.pos >= 0
                ? access
                : ts.isElementAccessExpression(access)
                  ? access.argumentExpression
                  : access;
        if (node.pos < 0) {
            return "generated";
        }
        return sceneRelativeSourceLabel(node);
    }

    /**
     * Reads an unasserted object element without touching invalid storage.
     * The value carries the separate existence predicate consumed when the
     * source tests the result for truthiness; a trailing `!` deliberately
     * takes the ordinary direct-index path instead.
     */
    /**
     * Whether an expression reads a collection of engine handles, which
     * belongs to the handle-collection path rather than to this one.
     *
     * Both optional forms -- `container.skeletons?.[0]` and the property
     * read one level up -- carry an escape hatch that compiles the owner
     * when the data path cannot; for a handle collection that asks the
     * data model for a value it has no type for, and throws before the
     * collection path is reached. The declared type is what answers:
     * `data-types.ts` already maps every pinned handle type, so a further
     * collection needs no row here.
     */
    public namesHandleCollection(
        expression: ts.Expression,
    ): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) &&
            !ts.isPropertyAccessChain(unwrapped)
        ) {
            return false;
        }
        const element = this.context.checker.getIndexTypeOfType(
            this.context.checker.getNonNullableType(
                this.context.checker.getTypeAtLocation(unwrapped),
            ),
            ts.IndexKind.Number,
        );
        return (
            element !== undefined &&
            this.context.dataTypes.fromTsType(element, unwrapped)
                ?.kind === "handle"
        );
    }

    public compileGuardableElementAccess(
        access: ts.ElementAccessExpression,
    ): Value | undefined {
        const owner = this.compileDataPath(
            access.expression,
            "read",
        );
        return owner
            ? this.guardableElementRead(owner, access)
            : undefined;
    }

    /**
     * Reads one binding from a native vector for an array destructuring
     * declaration. A concrete reached binding cannot represent JavaScript's
     * out-of-range `undefined`, so use the ordinary checked index path.
     */
    public readVectorBindingElement(
        vector: Value,
        index: number,
        node: ts.Node,
    ): Value {
        if (
            vector.kind !== "data" ||
            vector.dataType?.kind !== "vector"
        ) {
            this.context.fail(
                node,
                "Array vector destructuring requires a native vector value.",
            );
        }
        this.context.reachJsData();
        return this.leafValue(
            `bbl::js::array_index_checked(` +
                `${vector.cpp}, ${index}.0, ` +
                `${this.context.cppString(this.indexSiteLabel(node))})`,
            vector.dataType.element,
        );
    }

    private guardableElementRead(
        owner: Value,
        access: ts.ElementAccessExpression,
    ): Value | undefined {
        if (
            owner?.kind !== "data" ||
            (owner.dataType?.kind !== "vector" &&
                owner.dataType?.kind !== "span")
        ) {
            return undefined;
        }
        const element = owner.dataType.element;
        if (
            ![
                "struct",
                "vector",
                "map",
                "set",
                "arraybuffer",
                "dataview",
                "u8array",
                "f64array",
                "f32array",
                "u16array",
                "i16array",
                "u32array",
                "i32array",
                "handle",
                "number",
                "boolean",
                "string",
                "enum",
            ].includes(element.kind)
        ) {
            return undefined;
        }
        const index = this.context.compileNumber(
            access.argumentExpression,
            "double",
        );
        // Both the guarded read and its truthiness test consume the index.
        // Snapshot it once so an expression with side effects still has
        // JavaScript's single element-access evaluation.
        const indexTemporary =
            this.context.allocateTemporaryCppName(
                "element_index",
            );
        this.context.emit(
            `[[maybe_unused]] const double ${indexTemporary} = ${index};`,
        );
        this.context.reachJsData();
        const indexed =
            `bbl::js::array_at_or_default(${owner.cpp}, ${indexTemporary})`;
        const found =
            `bbl::js::array_has_index(${owner.cpp}, ${indexTemporary})`;
        const truthiness =
            element.kind === "boolean"
                  ? indexed
                : element.kind === "number"
                  ? `bbl::js::number_truthy(${indexed})`
                  : element.kind === "string"
                    ? `!${indexed}.empty()`
                    : found;
        return {
            ...this.leafValue(indexed, element),
            optionalFoundCpp: found,
            truthinessCpp: truthiness,
        };
    }

    /**
     * Compiles a `Record` index: the key is a member of the union the
     * map is keyed by, written either as a literal or as a value of
     * that union's type.
     */
    private compileEnumIndex(
        expression: ts.Expression,
        enumName: string,
    ): string {
        return this.compileForSink(expression, {
            kind: "enum",
            name: enumName,
        });
    }

    public leafValue(
        cpp: string,
        dataType: DataType,
    ): Value {
        if (dataType.kind === "number") {
            // The dataType marker records that this number is a native
            // double lvalue, so float contexts insert an explicit cast.
            return { kind: "number", cpp, dataType };
        }
        if (dataType.kind === "boolean") {
            return { kind: "boolean", cpp, dataType };
        }
        if (dataType.kind === "handle") {
            // Handle leaves surface as ordinary resource values, so
            // every mesh intrinsic and property assignment works on a
            // mesh read out of a struct or array exactly as it does on
            // a mesh local. The reached subset has one engine.
            return {
                kind: dataType.handle,
                cpp,
                dataType,
                ...(this.context.defaultEngine()
                    ? {
                          engineCpp:
                              this.context.defaultEngine()!,
                      }
                    : {}),
            };
        }
        return {
            kind: "data",
            cpp,
            dataType,
            ...(dataType.kind === "struct"
                ? this.context.dataTypes.isReferenceStruct(
                      dataType.name,
                  )
                    ? {
                          objectIdentityCpp: `${cpp}.get()`,
                          optionalFoundCpp: `static_cast<bool>(${cpp})`,
                      }
                    : { objectIdentityCpp: `std::addressof(${cpp})` }
                : {}),
        };
    }

    /**
     * Native identity token for a JavaScript plain-data object expression.
     *
     * Struct storage stays inline, but a binding that selects an existing
     * object (including a nullable conditional) must retain which object it
     * selected. A pointer to the existing lvalue is that token and also lets
     * later writes reach the original object instead of a value copy.
     */
    public objectIdentity(
        expression: ts.Expression,
    ): string | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (
            unwrapped.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(unwrapped) &&
                unwrapped.text === "undefined" &&
                !this.context.lookupIdentifierValue(unwrapped))
        ) {
            return "nullptr";
        }
        if (ts.isConditionalExpression(unwrapped)) {
            const whenTrue = this.objectIdentity(
                unwrapped.whenTrue,
            );
            const whenFalse = this.objectIdentity(
                unwrapped.whenFalse,
            );
            if (!whenTrue || !whenFalse) {
                return undefined;
            }
            const condition = this.context.compileCondition(
                unwrapped.condition,
            );
            return condition === "true"
                ? whenTrue
                : condition === "false"
                  ? whenFalse
                  : `(${condition} ? ${whenTrue} : ${whenFalse})`;
        }
        const path = this.compileDataPath(
            unwrapped,
            "read",
        );
        const computed =
            path ??
            (ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
                ? this.context.compileValue(unwrapped)
                : undefined);
        if (!computed) {
            return undefined;
        }
        const value = this.narrowOptional(
            computed,
            unwrapped,
        );
        if (value.objectIdentityCpp !== undefined) {
            return value.objectIdentityCpp;
        }
        return value.dataType?.kind === "struct"
            ? this.context.dataTypes.isReferenceStruct(
                  value.dataType.name,
              )
                ? `${value.cpp}.get()`
                : `std::addressof(${value.cpp})`
            : undefined;
    }

    /**
     * Materializes a static module-constant numeric table referenced by an
     * identifier, returning a table-typed value.
     */
    /**
     * Materializes a constant array as a namespace-scope constant so a
     * runtime index can read it (the demo cycles its block style
     * through one). Such an array folds to a compile-time tuple
     * otherwise, and a computed index cannot reach a tuple.
     */
    public materializeConstantArray(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) {
            return undefined;
        }
        // A local constant binds as a compile-time tuple; a module-level
        // one is not bound at all and resolves through its initializer.
        const bound =
            this.context.lookupIdentifierValue(unwrapped);
        if (bound && bound.kind !== "tuple") {
            return undefined;
        }
        const literal = bound
            ? undefined
            : (() => {
                  const resolved =
                      this.context.resolveStaticExpression(
                          unwrapped,
                      );
                  return resolved !== unwrapped &&
                      ts.isArrayLiteralExpression(resolved)
                      ? resolved
                      : undefined;
              })();
        if (!bound?.tupleElements && !literal) {
            return undefined;
        }
        const container =
            this.context.dataTypes.fromTsType(
                this.context.checker.getTypeAtLocation(
                    unwrapped,
                ),
                unwrapped,
            );
        const element =
            container?.kind === "vector" ||
            container?.kind === "span"
                ? container.element
                : undefined;
        if (!element) {
            return undefined;
        }
        const isStaticForSink = (
            value: Value,
            sink: DataType,
        ): boolean => {
            switch (sink.kind) {
                case "number":
                    return value.staticNumber !== undefined;
                case "boolean":
                    return value.staticBoolean !== undefined;
                case "string":
                case "enum":
                    return value.staticString !== undefined;
                case "optional":
                    return value.kind === "json-null" ||
                        isStaticForSink(value, sink.inner);
                case "tuple":
                    return value.kind === "tuple" &&
                        value.tupleElements?.length === sink.arity &&
                        value.tupleElements.every((entry) =>
                            isStaticForSink(entry, { kind: "number" }),
                        );
                case "vector":
                case "span":
                    return value.kind === "tuple" &&
                        (value.tupleElements ?? []).every((entry) =>
                            isStaticForSink(entry, sink.element),
                        );
                case "struct": {
                    if (value.kind !== "record") return false;
                    return this.context.dataTypes
                        .structFields(sink.name, unwrapped)
                        .every((field) => {
                            const property =
                                value.recordProperties?.[field.name];
                            return property
                                ? isStaticForSink(property, field.type)
                                : field.defaultWhenMissing === true ||
                                      field.type.kind === "optional";
                        });
                }
                default:
                    return false;
            }
        };
        const elements = literal
            ? literal.elements.map((entry) =>
                  this.compileForSink(entry, element),
              )
            : bound!.tupleElements!.map((entry) =>
                  isStaticForSink(entry, element)
                      ? this.compileKnownValueForSink(
                            entry,
                            element,
                            unwrapped,
                        )
                      : undefined,
              );
        if (elements.some((entry) => entry === undefined)) {
            return undefined;
        }
        // Keyed by the declaration so every use site shares one
        // constant rather than emitting a copy each time.
        const symbol =
            this.context.checker.getSymbolAtLocation(
                unwrapped,
            );
        const declaration =
            symbol?.declarations?.[0] ?? unwrapped;
        const name =
            this.context.dataTypes.registerConstantArray(
                declaration,
                unwrapped.text,
                this.context.dataTypes.cppType(element),
                elements as string[],
            );
        this.context.reachJsData();
        return {
            kind: "data",
            cpp: `bblscene::${name}`,
            dataType: { kind: "span", element },
        };
    }

    public materializeStaticTable(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) {
            return undefined;
        }
        // Entry-level static array constants are bound as compile-time
        // tuples; those still materialize. Any other binding is a runtime
        // local and never a static table.
        const bound =
            this.context.lookupIdentifierValue(unwrapped);
        if (bound && bound.kind !== "tuple") {
            return undefined;
        }
        const declaration =
            this.context.checker.getSymbolAtLocation(
                unwrapped,
            )?.valueDeclaration;
        const localLiteral =
            bound?.kind === "tuple" &&
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer
                ? this.context.unwrap(
                      declaration.initializer,
                  )
                : undefined;
        const resolved =
            localLiteral ??
            this.context.resolveStaticExpression(
                unwrapped,
            );
        if (
            resolved === unwrapped ||
            !ts.isArrayLiteralExpression(resolved)
        ) {
            return undefined;
        }
        if (!this.isNumericTable(resolved)) {
            return undefined;
        }
        const table = this.context.dataTypes.registerTable(
            resolved,
            unwrapped.text,
            resolved,
            (leaf) => this.staticLeafNumber(leaf),
        );
        this.context.reachJsData();
        return {
            kind: "data",
            cpp: `bblscene::${table.name}`,
            dataType: {
                kind: "table",
                dimensions: table.dimensions,
            },
        };
    }

    private isNumericTable(
        literal: ts.ArrayLiteralExpression,
    ): boolean {
        if (literal.elements.length === 0) {
            return false;
        }
        return literal.elements.every((element) => {
            const unwrapped =
                this.context.unwrap(element);
            if (
                ts.isArrayLiteralExpression(unwrapped)
            ) {
                return this.isNumericTable(unwrapped);
            }
            return this.isStaticLeafNumber(unwrapped);
        });
    }

    private isStaticLeafNumber(
        expression: ts.Expression,
    ): boolean {
        return staticNumberValue(this.context, expression) !== undefined;
    }

    private staticLeafNumber(
        expression: ts.Expression,
    ): number {
        return (
            staticNumberValue(this.context, expression) ??
            this.context.fail(
                expression,
                "Static tables require generation-known numeric leaves.",
            )
        );
    }

    /**
     * Compiles the reached array-allocation form
     * `Array.from({ length: n }, () => value)`.
     *
     * The array-like source has no indexed properties, so JavaScript supplies
     * `undefined` as the mapper's first argument. Undefined is not a native
     * data-model value, and the reached form does not consume either callback
     * argument; keep that boundary explicit instead of fabricating a value
     * whose native meaning would be wrong.
     */
    public compileArrayFrom(
        call: ts.CallExpression,
    ): Value | undefined {
        const callee = this.context.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            !ts.isIdentifier(callee.expression) ||
            callee.expression.text !== "Array" ||
            callee.name.text !== "from" ||
            this.context.lookupIdentifierValue(callee.expression)
        ) {
            return undefined;
        }
        if (call.arguments.length !== 2) {
            this.context.fail(
                call,
                "Array.from currently requires an array-like length object and one mapper callback.",
            );
        }
        const source = this.context.unwrap(call.arguments[0]!);
        if (!ts.isObjectLiteralExpression(source)) {
            this.context.fail(
                source,
                "Array.from currently requires an object literal with a length property.",
            );
        }
        const lengthProperty = source.properties.find(
            (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                property.name.text === "length",
        );
        if (!lengthProperty) {
            this.context.fail(
                source,
                "Array.from array-like object requires a length property.",
            );
        }
        const callback = this.context.unwrap(call.arguments[1]!);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            this.context.fail(
                callback,
                "Array.from requires a local function or function literal mapper.",
            );
        }
        const directType = this.dataTypeAt(call);
        const contextualTsType =
            this.context.checker.getContextualType(call);
        const contextualType = contextualTsType
            ? this.context.dataTypes.fromTsType(
                  contextualTsType,
                  call,
              )
            : undefined;
        // An empty mapper literal is inferred as `never[]`; the annotated
        // destination supplies its actual JavaScript array element type.
        const mappedType =
            directType?.kind === "vector"
                ? directType
                : contextualType;
        if (mappedType?.kind !== "vector") {
            this.context.fail(
                call,
                "Array.from mapper results must belong to the native data model.",
            );
        }
        const count = this.context.allocateTemporaryCppName(
            "array_from_count",
        );
        const index = this.context.allocateTemporaryCppName(
            "array_from_index",
        );
        const output = this.context.allocateTemporaryCppName(
            "array_from_result",
        );
        const cppType = this.context.dataTypes.cppType(mappedType.element);
        this.context.reachJsData();
        this.context.emit(
            `const std::size_t ${count} = static_cast<std::size_t>(${this.context.compileNumber(lengthProperty.initializer, "double")});`,
        );
        this.context.emit(`bbl::js::Array<${cppType}> ${output};`);
        this.context.emit(`${output}.reserve(${count});`);
        this.context.emit(
            `for (std::size_t ${index} = 0; ${index} < ${count}; ++${index}) {`,
        );
        this.context.increaseIndent();
        this.context.pushScope(this.context.allocateBlockPrefix());
        try {
            const result = this.context.compileCallbackWithValues(
                callback,
                [],
                call,
            );
            const value = this.compileKnownValueForSink(
                result,
                mappedType.element,
                callback,
            );
            this.context.emit(`${output}.push_back(${value});`);
        } finally {
            this.context.popScope();
            this.context.decreaseIndent();
        }
        this.context.emit("}");
        this.registerLocal(output, "owned");
        return {
            kind: "data",
            cpp: output,
            dataType: mappedType,
        };
    }

    /**
     * Compiles JavaScript Math member calls with runtime arguments.
     */
    public compileMathCall(
        call: ts.CallExpression,
    ): Value | undefined {
        const callee = this.context.unwrap(
            call.expression,
        );
        if (
            !ts.isPropertyAccessExpression(callee) ||
            !ts.isIdentifier(callee.expression) ||
            callee.expression.text !== "Math" ||
            this.context.lookupIdentifierValue(
                callee.expression,
            )
        ) {
            return undefined;
        }
        const method = callee.name.text;
        const numbers = (): string[] =>
            call.arguments.map((argument) =>
                this.context.compileNumber(
                    argument,
                    "double",
                ),
            );
        // The integer-valued one-argument functions fold over a static
        // argument: the result is exact in both engines, so the folded value
        // and the emitted call agree, and a scene that hands one to
        // generation-time state (a particle column) needs the value rather
        // than the expression. The transcendental ones deliberately do NOT
        // fold: V8 and a native maths library need not agree on them.
        if (foldableMathUnary[method] && call.arguments.length === 1) {
            // Folded from the SOURCE, never from a compiled value: this arm
            // runs before the runtime path compiles the argument, and
            // compiling it speculatively would emit an inlined body twice
            // when the fold misses. A canvas size reaches the same evaluator
            // through `staticCanvasSize`, so it folds here too.
            const argument = staticNumberValue(
                this.context,
                call.arguments[0]!,
            );
            if (argument !== undefined) {
                const folded = foldableMathUnary[method]!(argument);
                return {
                    kind: "number",
                    cpp: doubleLiteral(folded),
                    staticNumber: folded,
                    dataType: { kind: "number" },
                };
            }
        }
        const unary = mathUnaryCalls.get(method);
        if (unary) {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    `Math.${method} expects one argument.`,
                );
            }
            return {
                kind: "number",
                cpp: `${unary}(${numbers()[0]})`,
                dataType: { kind: "number" },
            };
        }
        if (method === "imul") {
            if (call.arguments.length !== 2) {
                this.context.fail(
                    call,
                    "Math.imul expects two arguments.",
                );
            }
            const [left, right] = numbers();
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `bbl::js::math_imul(${left}, ${right})`,
                dataType: { kind: "number" },
            };
        }
        if (method === "pow" || method === "atan2") {
            if (call.arguments.length !== 2) {
                this.context.fail(
                    call,
                    `Math.${method} expects two arguments.`,
                );
            }
            const [left, right] = numbers();
            // `pow` is a shared member, spelled through the pinned table;
            // `atan2` is compiler-only (no pinned body reaches it) and
            // follows the same std:: rule here.
            const spelling = method === "pow"
                ? pinnedMathSpelling(method)
                : `std::${method}`;
            return {
                kind: "number",
                cpp: `${spelling}(${left}, ${right})`,
                dataType: { kind: "number" },
            };
        }
        if (method === "hypot") {
            if (
                call.arguments.length < 2 ||
                call.arguments.length > 3
            ) {
                this.context.fail(
                    call,
                    "Math.hypot supports two or three arguments.",
                );
            }
            return {
                kind: "number",
                cpp: `std::hypot(${numbers().join(", ")})`,
                dataType: { kind: "number" },
            };
        }
        if (method === "max" || method === "min") {
            if (
                call.arguments.length === 1 &&
                ts.isSpreadElement(call.arguments[0]!)
            ) {
                const spread = this.context.compileValue(
                    call.arguments[0]!.expression,
                );
                if (
                    spread.kind !== "data" ||
                    (spread.dataType?.kind !== "vector" &&
                        spread.dataType?.kind !== "span") ||
                    spread.dataType.element.kind !== "number"
                ) {
                    this.context.fail(
                        call.arguments[0]!,
                        `Math.${method} spread requires an array of numbers.`,
                    );
                }
                const source =
                    this.context.allocateTemporaryCppName(
                        `math_${method}_source`,
                    );
                const result =
                    this.context.allocateTemporaryCppName(
                        `math_${method}_result`,
                    );
                const item =
                    this.context.allocateTemporaryCppName(
                        `math_${method}_item`,
                    );
                this.context.emit(`auto&& ${source} = ${spread.cpp};`);
                this.context.emit(
                    `double ${result} = ${method === "min" ? "" : "-"}` +
                        `std::numeric_limits<double>::infinity();`,
                );
                this.context.emit(
                    `for (const double ${item} : ${source}) ${result} = ` +
                        `std::${method}(${result}, ${item});`,
                );
                return {
                    kind: "number",
                    cpp: result,
                    dataType: { kind: "number" },
                };
            }
            if (call.arguments.length < 2) {
                this.context.fail(
                    call,
                    `Math.${method} expects at least two arguments.`,
                );
            }
            const staticParts = call.arguments.map((argument) =>
                staticNumberValue(this.context, argument),
            );
            if (
                staticParts.every(
                    (part): part is number =>
                        part !== undefined &&
                        Number.isFinite(part) &&
                        !Object.is(part, -0),
                )
            ) {
                const folded = Math[method](...staticParts);
                return {
                    kind: "number",
                    cpp: doubleLiteral(folded),
                    staticNumber: folded,
                    dataType: { kind: "number" },
                };
            }
            // Deliberately not the pinned table's `<double>`-pinned 2-arg
            // spelling: JS max/min are n-ary, so the compiler folds them
            // as a chain, and every operand it compiles is already a
            // double, which makes the bare std:: call unambiguous.
            const parts = numbers();
            let cpp = parts[0]!;
            for (const part of parts.slice(1)) {
                cpp = `std::${method}(${cpp}, ${part})`;
            }
            return {
                kind: "number",
                cpp,
                dataType: { kind: "number" },
            };
        }
        if (method === "round") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Math.round expects one argument.",
                );
            }
            // Not `std::round`: JavaScript rounds a tie toward +Infinity
            // and C rounds it away from zero, so the two disagree on every
            // negative half. `round_js` carries the spec's own rule.
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `bbl::js::round_js(${numbers()[0]})`,
                dataType: { kind: "number" },
            };
        }
        if (method === "sign") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Math.sign expects one argument.",
                );
            }
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `bbl::js::math_sign(${numbers()[0]})`,
                dataType: { kind: "number" },
            };
        }
        if (method === "random") {
            if (call.arguments.length !== 0) {
                this.context.fail(
                    call,
                    "Math.random expects no arguments.",
                );
            }
            this.context.reachJsData();
            this.context.reachJsRandom();
            return {
                kind: "number",
                cpp: "bbl::js::random_js()",
                dataType: { kind: "number" },
                impure: true,
            };
        }
        this.context.fail(
            callee.name,
            `Math.${method} is not supported.`,
        );
    }

    /**
     * Compiles `typedArray.set(source, offset)`.
     *
     * The spec's own conversion is what bounds the reached slice: a source
     * of a DIFFERENT typed-array kind converts each element through the
     * target's own store, and an ordinary array converts through
     * `ToNumber` — two more shapes, neither of which a reached scene
     * writes. So the two arrays must be the same kind, and anything else
     * refuses by name rather than copying bytes the spec would have
     * converted. The offset argument is optional upstream and defaults to
     * zero.
     */
    public compileTypedArraySet(
        call: ts.CallExpression,
        target: Value,
        kind: TypedArrayKind,
    ): Value {
        if (call.arguments.length < 1 || call.arguments.length > 2) {
            this.context.fail(
                call,
                "TypedArray.set expects a source and an optional offset.",
            );
        }
        const source = this.compileDataPath(
            call.arguments[0]!,
            "read",
        );
        if (
            !source ||
            source.kind !== "data" ||
            source.dataType?.kind !== kind
        ) {
            this.context.fail(
                call.arguments[0]!,
                `TypedArray.set is lowered for a source of the target's own kind (${kind}); ` +
                    "another typed array or a plain array converts each element " +
                    "through the target's store, which no reached scene needs.",
            );
        }
        this.context.reachJsData();
        const offset =
            call.arguments.length === 2
                ? this.context.compileNumber(
                      call.arguments[1]!,
                      "double",
                  )
                : "0.0";
        return {
            kind: "void",
            cpp: `bbl::js::typed_array_set(${target.cpp}, ${source.cpp}, ${offset})`,
        };
    }

    /**
     * Compiles `array.indexOf(value)`.
     *
     * Only element types JavaScript compares the way native code does
     * are reached: numbers, booleans, and tags compare by value in both,
     * and a handle is an id, which is what makes two references the same
     * object. A struct or a nested container would compare by identity
     * in JavaScript and field by field here, so those are rejected
     * rather than answered differently.
     */
    public compileArraySearch(
        call: ts.CallExpression,
        owner: Value,
        element: DataType,
        method: "indexOf" | "includes",
    ): Value {
        if (call.arguments.length !== 1) {
            this.context.fail(
                call,
                `Array.${method} expects one argument; the fromIndex form is outside the supported subset.`,
            );
        }
        if (
            element.kind !== "number" &&
            element.kind !== "boolean" &&
            element.kind !== "string" &&
            element.kind !== "enum" &&
            element.kind !== "handle"
        ) {
            this.context.fail(
                call,
                `Array.${method} is supported for numbers, booleans, strings, tags, and handles, not ${element.kind}: JavaScript would compare by identity here.`,
            );
        }
        this.context.reachJsData();
        const value = this.compileForSink(
            call.arguments[0]!,
            element,
        );
        const index = `bbl::js::array_index_of(${owner.cpp}, ${value})`;
        return method === "indexOf"
            ? {
                  kind: "number",
                  cpp: index,
                  dataType: { kind: "number" },
              }
            : {
                  kind: "boolean",
                  cpp: `${index} >= 0.0`,
                  dataType: { kind: "boolean" },
              };
    }

    /** Emit the shared callback protocol for reached JavaScript array methods. */
    public emitArrayCallbackLoop(
        call: ts.CallExpression,
        method:
            | "find"
            | "findIndex"
            | "filter"
            | "some"
            | "every"
            | "map"
            | "forEach",
        narrowed: Value,
        dataType: DataType & { kind: "vector" | "span" },
        snapshotLength: boolean,
        initialize: (source: string) => void,
        emitBody: (
            result: Value,
            callback:
                | ts.Identifier
                | ts.ArrowFunction
                | ts.FunctionExpression,
            source: string,
            index: string,
        ) => void,
    ): void {
        if (call.arguments.length !== 1) {
            this.context.fail(
                call,
                `Array.${method} requires exactly one callback and no thisArg.`,
            );
        }
        const callback = this.context.unwrap(call.arguments[0]!);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            this.context.fail(
                callback,
                `Array.${method} requires a local function or function literal callback.`,
            );
        }
        const label = method === "forEach" ? "for_each" : method;
        const source =
            this.context.allocateTemporaryCppName(`${label}_source`);
        const index =
            this.context.allocateTemporaryCppName(`${label}_index`);
        this.context.emit(`auto&& ${source} = ${narrowed.cpp};`);
        initialize(source);
        let bound = `${source}.size()`;
        if (snapshotLength) {
            const count =
                this.context.allocateTemporaryCppName(`${label}_count`);
            this.context.emit(
                `const std::size_t ${count} = ${bound};`,
            );
            bound = count;
        }
        this.context.emit(
            `for (std::size_t ${index} = 0; ${index} < ${bound}; ++${index}) {`,
        );
        this.context.increaseIndent();
        this.context.pushScope(this.context.allocateBlockPrefix());
        try {
            this.context.enterRuntimeControlFlow();
            try {
                const elementValue = this.leafValue(
                    `${source}[${index}]`,
                    dataType.element,
                );
                const booleanConstructor =
                    ts.isIdentifier(callback) &&
                    callback.text === "Boolean" &&
                    (this.context.checker.getSymbolAtLocation(callback)
                        ?.declarations ?? [])
                        .some((declaration) =>
                            /(?:^|[\\/])lib\.es5\.d\.ts$/i.test(
                                declaration.getSourceFile().fileName,
                            ),
                        );
                const callbackArguments: Value[] = [
                    elementValue,
                    {
                        kind: "number",
                        cpp: `static_cast<double>(${index})`,
                        dataType: { kind: "number" },
                    },
                    {
                        ...narrowed,
                        kind: "data",
                        cpp: source,
                        dataType,
                    },
                ];
                const predicate = [
                    "find",
                    "findIndex",
                    "filter",
                    "some",
                    "every",
                ].includes(method) &&
                    !this.callbackReturnsBoolean(callback);
                const result = booleanConstructor
                    ? dataType.element.kind === "boolean"
                        ? {
                              kind: "boolean" as const,
                              cpp: elementValue.cpp,
                              dataType: { kind: "boolean" as const },
                          }
                        : dataType.element.kind === "number"
                          ? (this.context.reachJsData(), {
                                kind: "boolean" as const,
                                cpp: `bbl::js::number_truthy(${elementValue.cpp})`,
                                dataType: { kind: "boolean" as const },
                            })
                          : dataType.element.kind === "string"
                            ? {
                                  kind: "boolean" as const,
                                  cpp: `!(${elementValue.cpp}).empty()`,
                                  dataType: { kind: "boolean" as const },
                              }
                            : this.context.fail(
                                  callback,
                                  `Boolean array callbacks support boolean, number, and string elements, not ${dataType.element.kind}.`,
                              )
                    : predicate
                      ? this.context.compilePredicateWithValues(
                            callback,
                            callbackArguments,
                            call,
                        )
                      : this.context.compileCallbackWithValues(
                            callback,
                            callbackArguments,
                            call,
                        );
                emitBody(result, callback, source, index);
            } finally {
                this.context.leaveRuntimeControlFlow();
            }
        } finally {
            this.context.popScope();
            this.context.decreaseIndent();
        }
        this.context.emit("}");
    }

    private callbackReturnsBoolean(
        callback:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression,
    ): boolean {
        const signature = ts.isIdentifier(callback)
            ? this.context.checker
                  .getTypeAtLocation(callback)
                  .getCallSignatures()[0]
            : this.context.checker.getSignatureFromDeclaration(callback);
        return (
            signature !== undefined &&
            (this.context.checker.getReturnTypeOfSignature(signature)
                .flags &
                ts.TypeFlags.BooleanLike) !==
                0
        );
    }

    /** Clear a complete element snapshot through every compiler alias. */
    public invalidateStaticElements(value: Value): void {
        this.context.invalidateStaticElements(value);
    }

    /**
     * Compiles data-container method calls (`push`, `pop`, `fill`) and the
     * `new Array(n).fill(v)` chain. The dispatcher itself lives in
     * `data-methods.ts` beside the method-name sets it routes by; this
     * entry point keeps every caller on the lowerer.
     */
    public compileDataMethodCall(
        call: ts.CallExpression,
    ): Value | undefined {
        return compileDataMethodCall(this, call);
    }


    /**
     * A module `const` initialized with a literal Map/Set constructor is a
     * value even though it has no runtime local binding. Keep it lazy at the
     * use site, just like other module constants, so unused containers do not
     * enter the generated program.
     */
    public compileStaticContainer(
        expression: ts.Identifier,
    ): Value | undefined {
        const resolved = this.context.resolveStaticExpression(expression);
        if (!ts.isNewExpression(resolved)) {
            return undefined;
        }
        const value = this.compileMapOrSetNew(resolved);
        if (!value) {
            return undefined;
        }
        return {
            ...value,
            cpp: `(${value.cpp})`,
        };
    }

    /**
     * Lazily materializes a module map populated by a top-level for-of over
     * a constant array. This is the AOT form of the common index-building
     * pattern `for (const value of VALUES) index.set(value.key, value)`.
     */
    public compileModuleMapGet(
        call: ts.CallExpression,
        owner: ts.Identifier,
    ): Value | undefined {
        if (this.context.lookupIdentifierValue(owner)) {
            return undefined;
        }
        const ownerSymbol =
            this.context.checker.getSymbolAtLocation(owner);
        const declaration = ownerSymbol?.valueDeclaration;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer ||
            !ts.isNewExpression(declaration.initializer) ||
            !ts.isIdentifier(
                declaration.initializer.expression,
            ) ||
            declaration.initializer.expression.text !== "Map"
        ) {
            return undefined;
        }
        const mapType = this.dataTypeAt(owner);
        if (mapType?.kind !== "map") {
            return undefined;
        }
        const sourceFile = declaration.getSourceFile();
        let iterable: ts.Expression | undefined;
        let keyField: string | undefined;
        for (const statement of sourceFile.statements) {
            if (
                !ts.isForOfStatement(statement) ||
                !ts.isVariableDeclarationList(
                    statement.initializer,
                ) ||
                statement.initializer.declarations.length !== 1
            ) {
                continue;
            }
            const loopDeclaration =
                statement.initializer.declarations[0]!;
            if (!ts.isIdentifier(loopDeclaration.name)) {
                continue;
            }
            const loopSymbol =
                this.context.checker.getSymbolAtLocation(
                    loopDeclaration.name,
                );
            let matchedField: string | undefined;
            const visit = (node: ts.Node): void => {
                if (matchedField || !ts.isCallExpression(node)) {
                    ts.forEachChild(node, visit);
                    return;
                }
                const target = node.expression;
                if (
                    !ts.isPropertyAccessExpression(target) ||
                    target.name.text !== "set" ||
                    !ts.isIdentifier(target.expression) ||
                    this.context.checker.getSymbolAtLocation(
                        target.expression,
                    ) !== ownerSymbol ||
                    node.arguments.length !== 2
                ) {
                    ts.forEachChild(node, visit);
                    return;
                }
                const key = this.context.unwrap(
                    node.arguments[0]!,
                );
                const value = this.context.unwrap(
                    node.arguments[1]!,
                );
                if (
                    ts.isPropertyAccessExpression(key) &&
                    ts.isIdentifier(key.expression) &&
                    this.context.checker.getSymbolAtLocation(
                        key.expression,
                    ) === loopSymbol &&
                    ts.isIdentifier(value) &&
                    this.context.checker.getSymbolAtLocation(
                        value,
                    ) === loopSymbol
                ) {
                    matchedField = key.name.text;
                }
            };
            visit(statement.statement);
            if (matchedField) {
                iterable = statement.expression;
                keyField = matchedField;
                break;
            }
        }
        if (!iterable || !keyField || call.arguments.length !== 1) {
            return undefined;
        }
        if (mapType.value.kind !== "struct") {
            return undefined;
        }
        const field = this.context.dataTypes.structField(
            mapType.value.name,
            keyField,
            call,
        );
        if (!dataTypesEqual(field.type, mapType.key)) {
            return undefined;
        }
        const resolvedIterable =
            this.context.resolveStaticExpression(iterable);
        if (!ts.isArrayLiteralExpression(resolvedIterable)) {
            return undefined;
        }
        const source =
            this.context.allocateTemporaryCppName(
                "module_map_source",
            );
        const sourceCpp = this.compileForSink(
            resolvedIterable,
            { kind: "vector", element: mapType.value },
        );
        this.context.emit(
            `static const auto ${source} = ${sourceCpp};`,
        );
        const key = this.compileForSink(
            call.arguments[0]!,
            mapType.key,
        );
        const resultType = this.dataTypeAt(call) ?? {
            kind: "optional" as const,
            inner: mapType.value,
        };
        const resultCpp =
            this.context.dataTypes.cppType(resultType);
        const fieldAccess =
            this.context.dataTypes.isReferenceStruct(
                mapType.value.name,
            )
                ? `item->${field.name}`
                : `item.${field.name}`;
        this.context.reachJsData();
        return {
            kind: "data",
            cpp:
                `([&]() -> ${resultCpp} { ` +
                `for (const auto& item : ${source}) { ` +
                `if (${fieldAccess} == ${key}) return ${resultCpp}{item}; ` +
                `} return ${resultCpp}{}; }())`,
            dataType: resultType,
        };
    }

    /**
     * Recognizes `new Array(n)` and compiles the length, or undefined when
     * the expression is not a global Array construction.
     */
    private newArrayCount(
        expression: ts.NewExpression,
    ): string | undefined {
        if (
            !ts.isIdentifier(expression.expression) ||
            expression.expression.text !== "Array" ||
            this.context.lookupIdentifierValue(
                expression.expression,
            )
        ) {
            return undefined;
        }
        if (expression.arguments?.length !== 1) {
            this.context.fail(
                expression,
                "new Array requires exactly one length argument.",
            );
        }
        return this.context.compileNumber(
            expression.arguments[0]!,
            "double",
        );
    }

    public newArrayInfo(
        expression: ts.NewExpression,
    ):
        | { count: string; element: DataType }
        | undefined {
        const count = this.newArrayCount(expression);
        if (count === undefined) {
            return undefined;
        }
        return {
            count,
            element: this.newArrayElementType(
                expression,
            ),
        };
    }

    private newArrayElementType(
        expression: ts.NewExpression,
    ): DataType {
        const type =
            this.context.checker.getTypeAtLocation(
                expression,
            );
        const mapped = this.context.dataTypes.fromTsType(
            type,
            expression,
        );
        if (mapped?.kind === "vector") {
            return mapped.element;
        }
        this.context.fail(
            expression,
            "new Array requires a data element type (annotate the receiving declaration).",
        );
    }

    /**
     * Compiles `new Array<T>(n)` without a fill chain: elements
     * zero-initialize (recorded as a fidelity adaptation).
     */
    public compileNewArray(
        expression: ts.NewExpression,
    ): Value | undefined {
        const created = this.newArrayInfo(expression);
        if (!created) {
            return undefined;
        }
        this.context.reachJsData();
        return {
            kind: "data",
            cpp: `bbl::js::Array<${this.context.dataTypes.cppType(created.element)}>(static_cast<std::size_t>(${created.count}))`,
            dataType: {
                kind: "vector",
                element: created.element,
            },
        };
    }

    /**
     * Compiles supported constructor expressions: `new Array`,
     * `new Float64Array`, `new Float32Array`, `new Uint8Array`, `new Uint16Array`, `new Int16Array`, `new Uint32Array`, and `new Int32Array` (sized, from a numeric
     * array literal, or from a number[] value).
     */
    public compileNewExpression(
        expression: ts.NewExpression,
    ): Value | undefined {
        return (
            this.compileNewArray(expression) ??
            this.compileTypedArrayNew(expression) ??
            this.compileDataViewNew(expression) ??
            this.compileMapOrSetNew(expression)
        );
    }

    private compileMapOrSetNew(
        expression: ts.NewExpression,
        expectedType?: DataType,
    ): Value | undefined {
        if (
            !ts.isIdentifier(expression.expression) ||
            !["Map", "Set"].includes(expression.expression.text) ||
            this.context.lookupIdentifierValue(expression.expression)
        ) {
            return undefined;
        }
        const direct = this.dataTypeAt(expression);
        const contextualType =
            this.context.checker.getContextualType(expression);
        const contextual = contextualType
            ? this.context.dataTypes.fromTsType(
                  contextualType,
                  expression,
              )
            : undefined;
        const dataType =
            direct?.kind === "map" || direct?.kind === "set"
                ? direct
                : contextual?.kind === "map" || contextual?.kind === "set"
                  ? contextual
                  : expectedType?.kind === "map" ||
                      expectedType?.kind === "set"
                    ? expectedType
                    : undefined;
        if (!dataType) {
            this.context.fail(
                expression,
                `new ${expression.expression.text} requires concrete data type arguments or a contextual container type.`,
            );
        }
        if (dataType.kind !== expression.expression.text.toLowerCase()) {
            this.context.fail(
                expression,
                `Constructor ${expression.expression.text} does not match its ${dataType.kind} data type.`,
            );
        }
        const arguments_ = expression.arguments ?? [];
        this.context.reachJsData();
        const cppType = this.context.dataTypes.cppType(dataType);
        if (dataType.kind === "map") {
            if (arguments_.length !== 0) {
                this.context.fail(
                    expression,
                    "new Map currently accepts the empty constructor; populate it with Map.set.",
                );
            }
            return { kind: "data", cpp: `${cppType}{}`, dataType };
        }
        if (arguments_.length === 0) {
            return { kind: "data", cpp: `${cppType}{}`, dataType };
        }
        if (arguments_.length !== 1) {
            this.context.fail(
                expression,
                "new Set expects zero or one iterable argument.",
            );
        }
        const iterable = this.context.unwrap(arguments_[0]!);
        if (ts.isArrayLiteralExpression(iterable)) {
            const values = iterable.elements.map((element) =>
                this.compileForSink(element, dataType.element),
            );
            return {
                kind: "data",
                cpp: `${cppType}{${values.join(", ")}}`,
                dataType,
            };
        }
        const source = this.requireDataValue(iterable, {
            kind: "vector",
            element: dataType.element,
        });
        return {
            kind: "data",
            cpp: `${cppType}(${source.cpp})`,
            dataType,
        };
    }

    public compileTypedArrayNew(
        expression: ts.NewExpression,
    ): Value | undefined {
        if (
            !ts.isIdentifier(expression.expression) ||
            this.context.lookupIdentifierValue(
                expression.expression,
            )
        ) {
            return undefined;
        }
        const name = expression.expression.text;
        if (
            name !== "Float64Array" &&
            name !== "Float32Array" &&
            name !== "Uint8Array" &&
            name !== "Uint16Array" &&
            name !== "Int16Array" &&
            name !== "Uint32Array" &&
            name !== "Int32Array"
        ) {
            return undefined;
        }
        const prefix =
            name === "Float64Array"
                ? "f64"
                : name === "Float32Array"
                  ? "f32"
                : name === "Uint8Array"
                  ? "u8"
                : name === "Uint16Array"
                  ? "u16"
                : name === "Int16Array"
                  ? "i16"
                : name === "Uint32Array"
                  ? "u32"
                  : "i32";
        const dataType: DataType =
            name === "Float64Array"
                ? { kind: "f64array" }
                : name === "Float32Array"
                  ? { kind: "f32array" }
                : name === "Uint8Array"
                  ? { kind: "u8array" }
                : name === "Uint16Array"
                  ? { kind: "u16array" }
                : name === "Int16Array"
                  ? { kind: "i16array" }
                : name === "Uint32Array"
                  ? { kind: "u32array" }
                  : { kind: "i32array" };
        this.context.reachJsData();
        const argument = expression.arguments?.[0];
        if (!argument) {
            return {
                kind: "data",
                cpp: `${this.context.dataTypes.cppType(dataType)}{}`,
                dataType,
            };
        }
        const unwrapped = this.context.unwrap(argument);
        if (name === "Uint8Array") {
            if (
                ts.isCallExpression(unwrapped) &&
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                unwrapped.expression.name.text === "slice" &&
                ts.isPropertyAccessExpression(unwrapped.expression.expression) &&
                unwrapped.expression.expression.name.text === "buffer" &&
                ts.isPropertyAccessExpression(
                    unwrapped.expression.expression.expression,
                ) &&
                unwrapped.expression.expression.expression.name.text === "data" &&
                ts.isIdentifier(
                    unwrapped.expression.expression.expression.expression,
                )
            ) {
                const imageData = this.context.lookupOptional(
                    unwrapped.expression.expression.expression.expression,
                );
                const pixels = imageData?.recordProperties?.data;
                if (
                    pixels?.kind === "data" &&
                    pixels.dataType?.kind === "u8array"
                ) {
                    return {
                        kind: "data",
                        cpp: `bbl::js::U8Array(${pixels.cpp}.buffer())`,
                        dataType,
                    };
                }
            }
            const source = this.compileDataPath(unwrapped, "read") ??
                this.context.compileValue(unwrapped);
            if (source.dataType?.kind === "arraybuffer") {
                const arguments_ = expression.arguments ?? [];
                if (arguments_.length > 3) {
                    this.context.fail(
                        expression,
                        "new Uint8Array over an ArrayBuffer expects an optional byte offset and length.",
                    );
                }
                const offset = arguments_[1]
                    ? `, bbl::js::array_index(${this.context.compileNumber(arguments_[1], "double")})`
                    : "";
                const length = arguments_[2]
                    ? `, bbl::js::array_index(${this.context.compileNumber(arguments_[2], "double")})`
                    : "";
                return {
                    kind: "data",
                    cpp: `bbl::js::U8Array(${source.cpp}${offset}${length})`,
                    dataType,
                };
            }
        }
        if ((expression.arguments?.length ?? 0) > 1) {
            this.context.fail(
                expression,
                `new ${name} supports at most one argument unless Uint8Array views an ArrayBuffer.`,
            );
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            const elements = unwrapped.elements.map(
                (element) =>
                    this.context.compileNumber(
                        element,
                        "double",
                    ),
            );
            // Constant-ness is a structural fact of the elements, not of
            // the emitted text: an element `staticNumberValue` folds is a
            // generation-known double, and one it cannot fold references
            // locals and must keep its expression at the use site.
            const constant = unwrapped.elements.every(
                (element) =>
                    staticNumberValue(
                        this.context,
                        element,
                    ) !== undefined,
            );
            return {
                kind: "data",
                cpp: this.typedArrayFromElements(
                    prefix,
                    elements,
                    constant,
                ),
                dataType,
            };
        }
        const source =
            this.compileDataPath(unwrapped, "read") ??
            (ts.isCallExpression(unwrapped)
                ? this.context.compileValue(unwrapped)
                : undefined);
        const staticSource = source ??
            (ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped)
                ? this.context.compileValue(unwrapped)
                : undefined);
        if (
            staticSource?.kind === "tuple" &&
            staticSource.tupleElements?.every(
                (entry) =>
                    entry.kind === "number" &&
                    entry.staticNumber !== undefined,
            )
        ) {
            const elements = staticSource.tupleElements.map((entry) =>
                doubleLiteral(entry.staticNumber!),
            );
            return {
                kind: "data",
                // Every lane just proved a static number, so the whole
                // tuple is generation-known by construction.
                cpp: this.typedArrayFromElements(
                    prefix,
                    elements,
                    true,
                ),
                dataType,
            };
        }
        if (
            staticSource?.kind === "data" &&
            staticSource.dataType?.kind === "vector" &&
            staticSource.dataType.element.kind === "number"
        ) {
            return {
                kind: "data",
                cpp: `bbl::js::${prefix}_array_from(${staticSource.cpp})`,
                dataType,
            };
        }
        return {
            kind: "data",
            cpp: `bbl::js::${prefix}_array_sized(${this.context.compileNumber(argument, "double")})`,
            dataType,
        };
    }

    /**
     * At or past this many elements a constant typed-array literal is
     * materialized as the namespace-scope `inline const std::array`
     * table `registerConstantArray` already gives runtime-indexed
     * constants, and the use site converts from the shared table. Two
     * things fall out: a literal several sites restate is emitted once,
     * and startup no longer constructs a heap `bbl::js::Array<double>`
     * only to convert it and throw it away. Below the threshold the
     * inline form is unchanged — a vector-sized literal reads best in
     * place.
     */
    private static readonly HOISTED_TYPED_ARRAY_MIN_ELEMENTS = 128;

    /**
     * The conversion expression for a typed-array constructor over
     * generation-known element text: inline below the hoisting
     * threshold, a shared namespace-scope table at or above it. Runtime
     * identity is untouched either way — every evaluation still
     * constructs its own typed array, exactly as two `new Float32Array`
     * expressions construct two arrays; only the immutable double
     * source is shared.
     *
     * `constant` is the caller's structural fact that every element is a
     * generation-known number; an element referencing locals must keep
     * its expression at the use site, so only a fully constant literal
     * hoists.
     */
    private typedArrayFromElements(
        prefix: string,
        elements: readonly string[],
        constant: boolean,
    ): string {
        if (
            elements.length <
                DataLowerer.HOISTED_TYPED_ARRAY_MIN_ELEMENTS ||
            !constant
        ) {
            return `bbl::js::${prefix}_array_from(bbl::js::Array<double>{${elements.join(", ")}})`;
        }
        const key = `double|${elements.join(", ")}`;
        let name = this.typedArrayLiteralTables.get(key);
        if (name === undefined) {
            // The registry keys tables by node, and one source node can
            // fold to different contents under an unrolled loop — a
            // fresh synthetic key node per registration keeps the
            // content map here the only authority.
            name = this.context.dataTypes.registerConstantArray(
                ts.factory.createNumericLiteral("0"),
                `${prefix}_values`,
                "double",
                [...elements],
            );
            this.typedArrayLiteralTables.set(key, name);
        }
        return `bbl::js::${prefix}_array_from(bblscene::${name})`;
    }

    private compileDataViewNew(
        expression: ts.NewExpression,
    ): Value | undefined {
        if (
            !ts.isIdentifier(expression.expression) ||
            expression.expression.text !== "DataView" ||
            this.context.lookupIdentifierValue(expression.expression)
        ) {
            return undefined;
        }
        const arguments_ = expression.arguments ?? [];
        if (arguments_.length < 1 || arguments_.length > 3) {
            this.context.fail(
                expression,
                "new DataView expects an ArrayBuffer and up to two offsets.",
            );
        }
        const buffer = this.compileForSink(
            arguments_[0]!,
            { kind: "arraybuffer" },
        );
        const offset = arguments_[1]
            ? `bbl::js::array_index(${this.context.compileNumber(arguments_[1], "double")})`
            : "0u";
        const length = arguments_[2]
            ? `, bbl::js::array_index(${this.context.compileNumber(arguments_[2], "double")})`
            : "";
        this.context.reachJsData();
        return {
            kind: "data",
            cpp: `bbl::js::DataView(${buffer}, ${offset}${length})`,
            dataType: { kind: "dataview" },
        };
    }

    /**
     * Compiles an expression against a known data sink type, producing a C++
     * expression string.
     */
    public compileForSink(
        expression: ts.Expression,
        dataType: DataType,
    ): string {
        const unwrapped = this.context.unwrap(expression);
        // A conditional selects between two values of the sink's own
        // type, so each branch lowers for the same sink and the choice
        // stays where the source wrote it. Numbers and booleans are left
        // alone: their own compilers already lower a conditional, and
        // routing them here would change what every existing scene emits.
        if (
            ts.isConditionalExpression(unwrapped) &&
            dataType.kind !== "number" &&
            dataType.kind !== "boolean"
        ) {
            const condition = this.context.compileCondition(
                unwrapped.condition,
            );
            if (dataType.kind === "optional") {
                // The selected value is wrapped in `bbl::js::Nullable`
                // below, which is the data runtime's own type.
                this.context.reachJsData();
            }
            const compileBranch = (
                branch: ts.Expression,
            ): { cpp: string; lines: string[] } => {
                let compiled = "";
                const lines = this.context.captureEmittedLines(
                    () => {
                        compiled = this.compileForSink(
                            branch,
                            dataType,
                        );
                    },
                );
                return {
                    cpp:
                        dataType.kind === "optional"
                            ? `${this.context.dataTypes.cppType(dataType)}{${compiled}}`
                            : compiled,
                    lines,
                };
            };
            if (condition === "true" || condition === "false") {
                const selected = compileBranch(
                    condition === "true"
                        ? unwrapped.whenTrue
                        : unwrapped.whenFalse,
                );
                for (const line of selected.lines) {
                    this.context.emit(line);
                }
                return selected.cpp;
            }
            const whenTrue = compileBranch(unwrapped.whenTrue);
            const whenFalse = compileBranch(unwrapped.whenFalse);
            if (
                whenTrue.lines.length === 0 &&
                whenFalse.lines.length === 0
            ) {
                return (
                    `(${condition}` +
                    ` ? ${whenTrue.cpp}` +
                    ` : ${whenFalse.cpp})`
                );
            }
            const returnType =
                this.context.dataTypes.cppType(dataType);
            const indented = (lines: string[]): string =>
                lines.map((line) => `        ${line}`).join("\n");
            const trueLines = indented(whenTrue.lines);
            const falseLines = indented(whenFalse.lines);
            return (
                `([&]() -> ${returnType} {\n` +
                `    if (${condition}) {\n` +
                (trueLines ? `${trueLines}\n` : "") +
                `        return ${whenTrue.cpp};\n` +
                `    }\n` +
                (falseLines ? `${falseLines}\n` : "") +
                `    return ${whenFalse.cpp};\n` +
                `}())`
            );
        }
        // `left ?? right` for a sink is a select the operator already
        // lowers: the general arm yields the selected value at the left's
        // inner type, and a sink of that same type takes it. One arm here
        // closes the string, enum, boolean and container sinks together,
        // instead of the operator reappearing per scalar compiler; the
        // number sink stays with its own compiler below, which owns the
        // float/double precision casts.
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            dataType.kind !== "number" &&
            dataType.kind !== "struct"
        ) {
            const folded =
                this.context.resolveStaticExpression(
                    unwrapped,
                );
            if (folded !== unwrapped) {
                return this.compileForSink(
                    folded,
                    dataType,
                );
            }
            const selected = this.compileNullishCoalesce(unwrapped);
            if (
                selected?.dataType &&
                dataTypesEqual(selected.dataType, dataType)
            ) {
                return selected.cpp;
            }
        }
        switch (dataType.kind) {
            case "number":
                return this.context.compileNumber(
                    expression,
                    "double",
                );
            case "boolean":
                return this.context.compileCondition(
                    unwrapped,
                );
            case "string": {
                const resolved =
                    this.context.resolveStaticExpression(
                        unwrapped,
                    );
                if (resolved !== unwrapped) {
                    return this.compileForSink(
                        resolved,
                        dataType,
                    );
                }
                // A literal is the string itself; a name bound to a
                // compile-time string is too, the way the enum arm below
                // reads one. Anything else has to be a path already typed as
                // a string, so a number or handle reaching a string sink
                // fails by type rather than by concatenation.
                if (
                    ts.isStringLiteral(unwrapped) ||
                    ts.isNoSubstitutionTemplateLiteral(unwrapped)
                ) {
                    return this.context.cppString(unwrapped.text);
                }
                if (ts.isIdentifier(unwrapped)) {
                    const bound =
                        this.context.lookupIdentifierValue(
                            unwrapped,
                        );
                    if (bound?.staticString !== undefined) {
                        return this.context.cppString(
                            bound.staticString,
                        );
                    }
                    if (bound?.kind === "string") {
                        return bound.cpp;
                    }
                    if (bound?.kind === "data") {
                        const narrowed = this.narrowOptional(
                            bound,
                            unwrapped,
                        );
                        if (
                            narrowed.dataType?.kind === "string"
                        ) {
                            return narrowed.cpp;
                        }
                    }
                }
                if (
                    ts.isCallExpression(unwrapped) ||
                    ts.isBinaryExpression(unwrapped) ||
                    ts.isTemplateExpression(unwrapped) ||
                    ts.isPropertyAccessExpression(unwrapped) ||
                    ts.isElementAccessExpression(unwrapped)
                ) {
                    const computed =
                        this.context.compileValue(unwrapped);
                    if (
                        computed.kind === "string" ||
                        (computed.kind === "data" &&
                            computed.dataType?.kind === "string")
                    ) {
                        return computed.cpp;
                    }
                }
                const rawValue =
                    this.compileDataPath(
                        unwrapped,
                        "read",
                    ) ??
                    (ts.isCallExpression(unwrapped) ||
                    ts.isIdentifier(unwrapped) ||
                    ts.isPropertyAccessExpression(unwrapped) ||
                    ts.isElementAccessExpression(unwrapped)
                        ? this.context.compileValue(unwrapped)
                        : undefined);
                const value = rawValue?.kind === "data"
                    ? this.narrowOptional(rawValue, unwrapped)
                    : rawValue;
                if (
                    value?.kind === "data" &&
                    value.dataType?.kind === "enum"
                ) {
                    return this.context.dataTypes.enumToStringCpp(
                        value.dataType,
                        value.cpp,
                        unwrapped,
                    );
                }
                if (
                    value?.dataType === undefined ||
                    !dataTypesEqual(value.dataType, dataType)
                ) {
                    this.context.fail(
                        unwrapped,
                        "Expected a string.",
                    );
                }
                return value.cpp;
            }
            case "function": {
                if (
                    unwrapped.kind === ts.SyntaxKind.NullKeyword ||
                    (ts.isIdentifier(unwrapped) &&
                        unwrapped.text === "undefined" &&
                        !this.context.lookupIdentifierValue(unwrapped))
                ) {
                    return `${this.context.dataTypes.cppType(dataType)}{}`;
                }
                if (ts.isIdentifier(unwrapped)) {
                    const bound =
                        this.context.lookupIdentifierValue(unwrapped);
                    if (
                        bound &&
                        (bound.kind === "callback" ||
                            bound.kind === "data" ||
                            bound.kind === "json-null")
                    ) {
                        return this.compileKnownValueForSink(
                            bound,
                            dataType,
                            unwrapped,
                        );
                    }
                }
                if (
                    ts.isArrowFunction(unwrapped) ||
                    ts.isFunctionExpression(unwrapped) ||
                    ts.isIdentifier(unwrapped)
                ) {
                    return this.context.compileStoredDataFunction(
                        unwrapped,
                        dataType,
                    );
                }
                const value = this.context.compileValue(unwrapped);
                if (
                    value.kind === "data" &&
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                this.context.fail(
                    unwrapped,
                    "Expected a local function with a native data signature.",
                );
            }
            case "enum": {
                const resolved =
                    this.context.resolveStaticExpression(
                        unwrapped,
                    );
                if (resolved !== unwrapped) {
                    return this.compileForSink(
                        resolved,
                        dataType,
                    );
                }
                if (
                    ts.isStringLiteral(unwrapped) ||
                    ts.isNoSubstitutionTemplateLiteral(
                        unwrapped,
                    )
                ) {
                    return this.context.dataTypes.enumMemberCpp(
                        dataType,
                        unwrapped.text,
                        unwrapped,
                    );
                }
                const rawValue =
                    this.compileDataPath(
                        unwrapped,
                        "read",
                    ) ??
                    (ts.isCallExpression(unwrapped) ||
                    ts.isIdentifier(unwrapped) ||
                    ts.isPropertyAccessExpression(unwrapped) ||
                    ts.isElementAccessExpression(unwrapped)
                        ? this.context.compileValue(unwrapped)
                        : undefined);
                const value =
                    rawValue?.kind === "data"
                        ? this.narrowOptional(rawValue, unwrapped)
                        : rawValue;
                if (
                    value?.kind === "data" &&
                    value.dataType &&
                    dataTypesEqual(
                        value.dataType,
                        dataType,
                    )
                ) {
                    return value.cpp;
                }
                if (
                    value?.kind === "string" ||
                    (value?.kind === "data" &&
                        value.dataType?.kind === "string")
                ) {
                    return this.context.dataTypes.enumFromStringCpp(
                        dataType,
                        value.cpp,
                        unwrapped,
                    );
                }
                if (
                    value?.kind === "data" &&
                    value.dataType?.kind === "enum"
                ) {
                    return this.context.dataTypes.enumFromStringCpp(
                        dataType,
                        this.context.dataTypes.enumToStringCpp(
                            value.dataType,
                            value.cpp,
                            unwrapped,
                        ),
                        unwrapped,
                    );
                }
                // An inlined function's tag parameter carries the
                // literal it was called with, so a name bound to a
                // known string names its member just as the literal
                // written in place would.
                if (ts.isIdentifier(unwrapped)) {
                    const bound =
                        this.context.lookupIdentifierValue(
                            unwrapped,
                        );
                    if (
                        bound?.staticString !== undefined
                    ) {
                        return this.context.dataTypes.enumMemberCpp(
                            dataType,
                            bound.staticString,
                            unwrapped,
                        );
                    }
                }
                this.context.fail(
                    unwrapped,
                    `Expected a ${dataType.name} literal or value.`,
                );
                break;
            }
            case "optional": {
                if (
                    unwrapped.kind ===
                        ts.SyntaxKind.NullKeyword ||
                    (ts.isIdentifier(unwrapped) &&
                        unwrapped.text === "undefined" &&
                        !this.context.lookupIdentifierValue(unwrapped))
                ) {
                    return "std::nullopt";
                }
                const optional =
                    this.compileDataPath(
                        unwrapped,
                        "read",
                    ) ??
                    (ts.isCallExpression(unwrapped) ||
                    ts.isIdentifier(unwrapped) ||
                    ts.isPropertyAccessExpression(
                        unwrapped,
                    ) ||
                    ts.isElementAccessExpression(unwrapped)
                        ? this.context.compileValue(
                              unwrapped,
                          )
                        : undefined);
                if (optional?.kind === "json-null") {
                    // A destructured optional tuple lane can bind a local to
                    // JavaScript null/undefined. The binding is still the
                    // empty optional when it reaches a typed sink; requiring
                    // the null token to remain syntactically in place would
                    // make destructuring observably different.
                    return "std::nullopt";
                }
                if (
                    optional?.kind === "data" &&
                    optional.dataType &&
                    dataTypesEqual(
                        optional.dataType,
                        dataType,
                    )
                ) {
                    return optional.cpp;
                }
                // A handle the expression already produced IS the value
                // the inner sink takes. Falling through would compile the
                // expression a second time, which for an intrinsic that
                // emits a temporary means calling it twice -- so the
                // already-compiled value is handed on instead.
                //
                // A handle that reports its own miss (a search, or a slot
                // nothing filled) carries that as its found flag, and the
                // optional is where a miss becomes absence: wrapping it
                // unconditionally would make `undefined` read as a present
                // invalid handle, which every guard downstream would then
                // answer the wrong way.
                if (
                    optional &&
                    dataType.inner.kind === "handle" &&
                    optional.kind === dataType.inner.handle
                ) {
                    if (optional.optionalFoundCpp === undefined) {
                        return optional.cpp;
                    }
                    const cppType =
                        this.context.dataTypes.cppType(dataType);
                    this.context.reachJsData();
                    return (
                        `(${optional.optionalFoundCpp}` +
                        ` ? ${cppType}{${optional.cpp}}` +
                        ` : ${cppType}{std::nullopt})`
                    );
                }
                // The same hazard the handle arm answers, for every other
                // inner type. The expression is already compiled, and for a
                // call whose body inlines, compiling it again emits that
                // body again: scene 173 binds a `WireMesh[] | null` from a
                // helper that builds twelve tubes, and before this arm the
                // native scene drew all twelve twice -- co-located, so the
                // capture matched the browser's while carrying 27% more
                // draws. A value whose own type is the inner one needs no
                // conversion, so it is handed on rather than recompiled.
                const inner = (
                    optional?.kind === "data" &&
                    optional.dataType &&
                    dataTypesEqual(
                        optional.dataType,
                        dataType.inner,
                    )
                )
                    ? optional.cpp
                    : this.compileForSink(
                          unwrapped,
                          dataType.inner,
                      );
                if (
                    dataType.inner.kind === "struct" &&
                    this.context.dataTypes.isReferenceStruct(
                        dataType.inner.name,
                    )
                ) {
                    return inner;
                }
                this.context.reachJsData();
                return `${this.context.dataTypes.cppType(dataType)}{${inner}}`;
            }
            case "struct": {
                if (
                    ts.isBinaryExpression(unwrapped) &&
                    unwrapped.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken
                ) {
                    const left = this.context.compileValue(
                        unwrapped.left,
                    );
                    if (left.optionalFoundCpp !== undefined) {
                        const right = this.context.compileValue(
                            unwrapped.right,
                        );
                        return (
                            `(${left.optionalFoundCpp} ? ` +
                            `${this.compileKnownValueForSink(left, dataType, unwrapped.left)} : ` +
                            `${this.compileKnownValueForSink(right, dataType, unwrapped.right)})`
                        );
                    }
                }
                if (
                    ts.isConditionalExpression(unwrapped) &&
                    this.context.dataTypes.isReferenceStruct(dataType.name)
                ) {
                    return (
                        `(${this.context.compileCondition(unwrapped.condition)} ? ` +
                        `${this.compileForSink(unwrapped.whenTrue, dataType)} : ` +
                        `${this.compileForSink(unwrapped.whenFalse, dataType)})`
                    );
                }
                if (
                    this.context.dataTypes.isReferenceStruct(
                        dataType.name,
                    ) &&
                    (unwrapped.kind ===
                        ts.SyntaxKind.NullKeyword ||
                        (ts.isIdentifier(unwrapped) &&
                            unwrapped.text === "undefined" &&
                            !this.context.lookupIdentifierValue(
                                unwrapped,
                            )))
                ) {
                    return `${this.context.dataTypes.cppType(dataType)}{}`;
                }
                if (
                    ts.isObjectLiteralExpression(
                        unwrapped,
                    )
                ) {
                    if (
                        unwrapped.properties.some((property) =>
                            ts.isSpreadAssignment(property),
                        )
                    ) {
                        const temporary =
                            this.context.allocateTemporaryCppName(
                                "spread",
                            );
                        this.emitSpreadStructDeclaration(
                            temporary,
                            unwrapped,
                            dataType,
                        );
                        this.registerLocal(temporary, "owned");
                        return temporary;
                    }
                    return this.structLiteral(
                        unwrapped,
                        dataType,
                    );
                }
                if (
                    ts.isCallExpression(unwrapped) ||
                    ts.isIdentifier(unwrapped) ||
                    ts.isPropertyAccessExpression(
                        unwrapped,
                    ) ||
                    ts.isElementAccessExpression(unwrapped)
                ) {
                    const known =
                        this.context.compileValue(
                            unwrapped,
                        );
                    if (known.kind === "record") {
                        return this.compileKnownValueForSink(
                            known,
                            dataType,
                            unwrapped,
                        );
                    }
                    if (
                        known.kind === "data" &&
                        known.dataType?.kind === "struct"
                    ) {
                        this.markEscaped(known);
                        return this.compileKnownValueForSink(
                            known,
                            dataType,
                            unwrapped,
                        );
                    }
                }
                const value = this.requireDataValue(
                    unwrapped,
                    dataType,
                );
                this.markEscaped(value);
                return value.cpp;
            }
            case "enummap": {
                if (
                    ts.isObjectLiteralExpression(unwrapped)
                ) {
                    return this.enumMapLiteral(
                        unwrapped,
                        dataType,
                    );
                }
                const value = this.requireDataValue(
                    unwrapped,
                    dataType,
                );
                this.markEscaped(value);
                return value.cpp;
            }
            case "vector": {
                if (
                    ts.isArrayLiteralExpression(
                        unwrapped,
                    )
                ) {
                    this.context.reachJsData();
                    const spreads = unwrapped.elements.filter(
                        ts.isSpreadElement,
                    );
                    if (spreads.length > 0) {
                        const spreadValue = (spread: ts.SpreadElement): Value => {
                            const iterable =
                                this.compileDataPath(spread.expression, "read") ??
                                this.context.compileValue(spread.expression);
                            if (iterable.kind === "tuple") {
                                return {
                                    kind: "data",
                                    cpp: `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>{${(
                                        iterable.tupleElements ?? []
                                    )
                                        .map((element) =>
                                            this.compileKnownValueForSink(
                                                element,
                                                dataType.element,
                                                spread,
                                            ),
                                        )
                                        .join(", ")}}`,
                                    dataType: {
                                        kind: "vector",
                                        element: dataType.element,
                                    },
                                };
                            }
                            if (
                                iterable.kind === "handle-collection" &&
                                iterable.handleCollection &&
                                dataType.element.kind === "handle" &&
                                iterable.handleCollection.elementKind ===
                                    dataType.element.handle
                            ) {
                                return {
                                    kind: "data",
                                    cpp: iterable.handleCollection.containerCpp,
                                    dataType: {
                                        kind: "span",
                                        element: dataType.element,
                                    },
                                    borrowedData: true,
                                };
                            }
                            const sourceElement =
                                iterable.dataType?.kind === "set" ||
                                iterable.dataType?.kind === "vector" ||
                                iterable.dataType?.kind === "span"
                                    ? iterable.dataType.element
                                    : undefined;
                            if (
                                iterable.kind !== "data" ||
                                !sourceElement ||
                                !dataTypesEqual(sourceElement, dataType.element)
                            ) {
                                this.context.fail(
                                    spread,
                                    "Array spread requires a native Set, Array, or readonly array with the same element type.",
                                );
                            }
                            return iterable;
                        };
                        if (
                            spreads.length === 1 &&
                            unwrapped.elements.length === 1
                        ) {
                            const iterable = spreadValue(spreads[0]!);
                            return `bbl::js::array_from_iterable<${this.context.dataTypes.cppType(dataType.element)}>(${iterable.cpp})`;
                        }
                        const cppType = this.context.dataTypes.cppType(
                            dataType.element,
                        );
                        const result = this.context.allocateTemporaryCppName(
                            "spread_array",
                        );
                        const statements = unwrapped.elements.map((element) => {
                            if (ts.isSpreadElement(element)) {
                                const iterable = spreadValue(element);
                                return `bbl::js::array_append(${result}, ${iterable.cpp});`;
                            }
                            return `${result}.push_back(${this.compileForSink(element, dataType.element)});`;
                        });
                        return (
                            `([&]() { bbl::js::Array<${cppType}> ${result}; ` +
                            `${statements.join(" ")} return ${result}; }())`
                        );
                    }
                    const elements =
                        unwrapped.elements.map(
                            (element) =>
                                this.compileForSink(
                                    element,
                                    dataType.element,
                                ),
                        );
                    return `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>{${elements.join(", ")}}`;
                }
                if (ts.isNewExpression(unwrapped)) {
                    const created =
                        this.newArrayCount(unwrapped);
                    if (created !== undefined) {
                        this.context.reachJsData();
                        return `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>(static_cast<std::size_t>(${created}))`;
                    }
                }
                if (
                    ts.isCallExpression(unwrapped)
                ) {
                    const fillOwner =
                        ts.isPropertyAccessExpression(
                            unwrapped.expression,
                        ) &&
                        unwrapped.expression.name.text === "fill" &&
                        ts.isNewExpression(
                            this.context.unwrap(
                                unwrapped.expression.expression,
                            ),
                        )
                            ? (this.context.unwrap(
                                  unwrapped.expression.expression,
                              ) as ts.NewExpression)
                            : undefined;
                    const fillCount = fillOwner
                        ? this.newArrayCount(fillOwner)
                        : undefined;
                    if (fillCount !== undefined) {
                        if (unwrapped.arguments.length !== 1) {
                            this.context.fail(
                                unwrapped,
                                "Array.fill expects one argument.",
                            );
                        }
                        const value = this.compileForSink(
                            unwrapped.arguments[0]!,
                            dataType.element,
                        );
                        this.context.reachJsData();
                        return (
                            `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>` +
                            `(static_cast<std::size_t>(${fillCount}), ${value})`
                        );
                    }
                    const chained =
                        this.compileDataMethodCall(
                            unwrapped,
                        );
                    if (
                        chained?.kind === "data" &&
                        chained.dataType &&
                        dataTypesEqual(
                            chained.dataType,
                            dataType,
                        )
                    ) {
                        return chained.cpp;
                    }
                    const mapped =
                        this.context.compileValue(
                            unwrapped,
                        );
                    if (
                        mapped.kind === "tuple" ||
                        mapped.kind === "data"
                    ) {
                        return this.compileKnownValueForSink(
                            mapped,
                            dataType,
                            unwrapped,
                        );
                    }
                }
                if (
                    ts.isIdentifier(unwrapped) ||
                    ts.isPropertyAccessExpression(
                        unwrapped,
                    ) ||
                    ts.isElementAccessExpression(unwrapped)
                ) {
                    const known =
                        this.context.compileValue(
                            unwrapped,
                        );
                    if (known.kind === "tuple") {
                        return this.compileKnownValueForSink(
                            known,
                            dataType,
                            unwrapped,
                        );
                    }
                }
                const sourceType = this.dataTypeAt(unwrapped);
                if (
                    sourceType?.kind === "vector" &&
                    (sourceType.element.kind === "struct" ||
                        sourceType.element.kind === "map") &&
                    dataType.element.kind === "struct" &&
                    !dataTypesEqual(sourceType, dataType)
                ) {
                    return this.compileKnownValueForSink(
                        this.context.compileValue(unwrapped),
                        dataType,
                        unwrapped,
                    );
                }
                const value = this.requireDataValue(
                    unwrapped,
                    dataType,
                );
                this.markEscaped(value);
                return value.cpp;
            }
            case "map":
            case "set": {
                if (
                    dataType.kind === "map" &&
                    ts.isObjectLiteralExpression(unwrapped)
                ) {
                    return this.openRecordLiteral(
                        unwrapped,
                        dataType,
                    );
                }
                if (
                    dataType.kind === "map" &&
                    (ts.isIdentifier(unwrapped) ||
                        ts.isPropertyAccessExpression(unwrapped))
                ) {
                    const known = this.context.compileValue(unwrapped);
                    if (known.kind === "record") {
                        return this.compileKnownValueForSink(
                            known,
                            dataType,
                            unwrapped,
                        );
                    }
                }
                if (ts.isNewExpression(unwrapped)) {
                    const created =
                        this.compileMapOrSetNew(
                            unwrapped,
                            dataType,
                        );
                    if (
                        created?.dataType &&
                        dataTypesEqual(created.dataType, dataType)
                    ) {
                        return created.cpp;
                    }
                }
                const value = this.requireDataValue(
                    unwrapped,
                    dataType,
                );
                this.markEscaped(value);
                return value.cpp;
            }
            case "handle": {
                // Storing a resource into plain data: the sink takes
                // the handle value produced by the intrinsic that
                // created it (or read back out of another container).
                let rawValue =
                    this.context.compileValue(unwrapped);
                if (
                    dataType.handle === "sprite-atlas" &&
                    rawValue.kind !== "record"
                ) {
                    const staticExpression =
                        this.context.resolveStaticExpression(
                            unwrapped,
                        );
                    const constInitializer =
                        ts.isIdentifier(unwrapped)
                            ? this.context.checker.getSymbolAtLocation(
                                  unwrapped,
                              )?.valueDeclaration
                            : undefined;
                    const atlasExpression =
                        staticExpression !== unwrapped
                            ? staticExpression
                            : constInitializer &&
                                ts.isVariableDeclaration(
                                    constInitializer,
                                ) &&
                                constInitializer.initializer &&
                                ts.isVariableDeclarationList(
                                    constInitializer.parent,
                                ) &&
                                (constInitializer.parent.flags &
                                    ts.NodeFlags.Const) !==
                                    0
                              ? constInitializer.initializer
                              : undefined;
                    if (atlasExpression) {
                        rawValue =
                            this.context.compileValue(
                                atlasExpression,
                            );
                    }
                }
                const value = rawValue.kind === "data"
                    ? this.narrowOptional(
                          rawValue,
                          unwrapped,
                      )
                    : rawValue;
                if (
                    dataType.handle === "sprite-atlas" &&
                    value.kind === "record"
                ) {
                    const atlas = this.context.compileSpriteAtlasRecord(
                        value,
                        unwrapped,
                    );
                    if (atlas) return atlas;
                }
                if (value.kind !== dataType.handle) {
                    this.context.fail(
                        unwrapped,
                        `Expected a ${dataType.handle} value, received ${value.kind}.`,
                    );
                }
                if (
                    dataType.handle === "texture" &&
                    !(
                        value.textureStorage === "pixels" ||
                        value.textureStorage === "file" ||
                        (value.dataType?.kind === "handle" &&
                            value.dataType.handle === "texture")
                    )
                ) {
                    this.context.fail(
                        unwrapped,
                        "Texture2D data storage supports loadTexture2D and createTexture2DFromPixels values.",
                    );
                }
                return value.cpp;
            }
            case "arraybuffer":
            case "dataview": {
                const value = this.requireDataValue(
                    unwrapped,
                    dataType,
                );
                this.markEscaped(value);
                return value.cpp;
            }
            case "u8array":
            case "f64array":
            case "f32array":
            case "u16array":
            case "i16array":
            case "u32array":
            case "i32array": {
                if (ts.isNewExpression(unwrapped)) {
                    const value =
                        this.compileTypedArrayNew(
                            unwrapped,
                        );
                    if (
                        value?.dataType &&
                        dataTypesEqual(
                            value.dataType,
                            dataType,
                        )
                    ) {
                        return value.cpp;
                    }
                }
                const value = this.requireDataValue(
                    unwrapped,
                    dataType,
                );
                this.markEscaped(value);
                return value.cpp;
            }
            case "span":
            case "tuple":
            case "table": {
                return this.spanLikeForSink(
                    unwrapped,
                    dataType,
                );
            }
        }
    }

    public compileKnownValueForSink(
        value: Value,
        dataType: DataType,
        node: ts.Node,
    ): string {
        if (
            value.dataType &&
            this.spanCompatible(value.dataType, dataType)
        ) {
            return value.cpp;
        }
        switch (dataType.kind) {
            case "number":
                if (value.kind !== "number") break;
                // A data-model number is a native double, which is the
                // width `castNumber` writes a static lane at.
                return this.context.castNumber(value, "double");
            case "boolean":
                if (value.kind === "boolean") return value.cpp;
                break;
            case "string":
                if (value.staticString !== undefined) {
                    return this.context.cppString(
                        value.staticString,
                    );
                }
                if (value.kind === "string") {
                    // Indexed string reads use the dedicated string Value
                    // kind even though their character is selected at run
                    // time. They are already native std::string expressions,
                    // just like a data-model string leaf below.
                    return value.cpp;
                }
                if (
                    value.kind === "data" &&
                    value.dataType?.kind === "string"
                ) {
                    return value.cpp;
                }
                if (
                    value.kind === "data" &&
                    value.dataType?.kind === "enum"
                ) {
                    return this.context.dataTypes.enumToStringCpp(
                        value.dataType,
                        value.cpp,
                        node,
                    );
                }
                break;
            case "enum":
                if (value.staticString !== undefined) {
                    return this.context.dataTypes.enumMemberCpp(
                        dataType,
                        value.staticString,
                        node,
                    );
                }
                if (
                    value.kind === "string" ||
                    (value.kind === "data" &&
                        value.dataType?.kind === "string")
                ) {
                    return this.context.dataTypes.enumFromStringCpp(
                        dataType,
                        value.cpp,
                        node,
                    );
                }
                if (
                    value.kind === "data" &&
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
            case "function":
                if (value.kind === "json-null") {
                    return `${this.context.dataTypes.cppType(dataType)}{}`;
                }
                if (
                    value.kind === "callback" &&
                    value.callbackDeclaration
                ) {
                    return this.context.compileStoredDataFunction(
                        value.callbackDeclaration,
                        dataType,
                    );
                }
                if (
                    value.kind === "data" &&
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
            case "optional":
                if (value.kind === "json-null") {
                    return "std::nullopt";
                }
                return this.compileKnownValueForSink(
                    value,
                    dataType.inner,
                    node,
                );
            case "struct":
                if (
                    value.kind === "json-null" &&
                    this.context.dataTypes.isReferenceStruct(
                        dataType.name,
                    )
                ) {
                    return `${this.context.dataTypes.cppType(dataType)}{}`;
                }
                if (value.kind === "record") {
                    this.context.dataTypes.cppType(dataType);
                    const fields =
                        this.context.dataTypes.structFields(
                            dataType.name,
                            node,
                        );
                    const aggregate = `bblscene::${dataType.name}${this.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
                        .map((field) => {
                            if (field.type.kind === "function") {
                                const method = value.recordMethods?.[field.name];
                                if (method) {
                                    return this.context.compileStoredDataFunction(
                                        method,
                                        field.type,
                                        value,
                                    );
                                }
                            }
                            const property =
                                value.recordProperties?.[
                                    field.name
                                ];
                            if (!property) {
                                if (field.defaultWhenMissing) {
                                    return "{}";
                                }
                                if (
                                    field.type.kind ===
                                    "optional"
                                ) {
                                    return "std::nullopt";
                                }
                                this.context.fail(
                                    node,
                                    `Compile-time record is missing required field '${field.name}'.`,
                                );
                            }
                            return this.compileKnownValueForSink(
                                property,
                                field.type,
                                node,
                            );
                        })
                        .join(", ")}}`;
                    return this.context.dataTypes.isReferenceStruct(
                        dataType.name,
                    )
                        ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
                        : aggregate;
                }
                if (
                    value.kind === "data" &&
                    value.dataType?.kind === "struct"
                ) {
                    const sourceType = value.dataType;
                    if (dataTypesEqual(sourceType, dataType)) {
                        return value.cpp;
                    }
                    const sourceFields = new Map(
                        this.context.dataTypes
                            .structFields(sourceType.name, node)
                            .map((field) => [field.name, field]),
                    );
                    const sourceArrow =
                        this.context.dataTypes.isReferenceStruct(
                            sourceType.name,
                        );
                    const fields = this.context.dataTypes.structFields(
                        dataType.name,
                        node,
                    );
                    const aggregate = `bblscene::${dataType.name}${this.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
                        .map((field) => {
                            const source = sourceFields.get(field.name);
                            if (!source) {
                                if (field.defaultWhenMissing) {
                                    return "{}";
                                }
                                if (field.type.kind === "optional") {
                                    return "std::nullopt";
                                }
                                this.context.fail(
                                    node,
                                    `Struct ${sourceType.name} is missing required destination field '${field.name}'.`,
                                );
                            }
                            return this.compileKnownValueForSink(
                                this.leafValue(
                                    `${value.cpp}${sourceArrow ? "->" : "."}${source.name}`,
                                    source.type,
                                ),
                                field.type,
                                node,
                            );
                        })
                        .join(", ")}}`;
                    return this.context.dataTypes.isReferenceStruct(
                        dataType.name,
                    )
                        ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
                        : aggregate;
                }
                if (
                    value.kind === "data" &&
                    value.dataType?.kind === "map" &&
                    value.dataType.key.kind === "string"
                ) {
                    const sourceMap = value.dataType;
                    const fields = this.context.dataTypes.structFields(
                        dataType.name,
                        node,
                    );
                    const aggregate = `bblscene::${dataType.name}${this.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
                        .map((field) => {
                            if (
                                field.type.kind !== "optional" ||
                                !dataTypesEqual(
                                    sourceMap.value,
                                    field.type.inner,
                                )
                            ) {
                                this.context.fail(
                                    node,
                                    `Open string record cannot project field '${field.name}' into ${dataType.name}; destination fields must be compatible optionals.`,
                                );
                            }
                            return `${value.cpp}.get(${this.context.cppString(field.name)})`;
                        })
                        .join(", ")}}`;
                    return this.context.dataTypes.isReferenceStruct(
                        dataType.name,
                    )
                        ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(${aggregate})`
                        : aggregate;
                }
                break;
            case "vector":
                if (value.kind === "tuple") {
                    this.context.reachJsData();
                    const elements =
                        value.tupleElements ?? [];
                    return `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>{${elements
                        .map((entry) =>
                            this.compileKnownValueForSink(
                                entry,
                                dataType.element,
                                node,
                            ),
                        )
                        .join(", ")}}`;
                }
                if (
                    value.kind === "data" &&
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                if (
                    value.kind === "data" &&
                    value.dataType?.kind === "vector" &&
                    (value.dataType.element.kind === "struct" ||
                        value.dataType.element.kind === "map") &&
                    dataType.element.kind === "struct"
                ) {
                    this.context.reachJsData();
                    const source = this.context.allocateTemporaryCppName(
                        "project_source",
                    );
                    const item = this.context.allocateTemporaryCppName(
                        "project_item",
                    );
                    const result = this.context.allocateTemporaryCppName(
                        "project_result",
                    );
                    const destinationCpp =
                        this.context.dataTypes.cppType(dataType);
                    const projected = this.compileKnownValueForSink(
                        this.leafValue(item, value.dataType.element),
                        dataType.element,
                        node,
                    );
                    return (
                        `[&]() { auto ${source} = ${value.cpp}; ` +
                        `${destinationCpp} ${result}; ` +
                        `${result}.reserve(${source}.size()); ` +
                        `for (const auto& ${item} : ${source}) ` +
                        `${result}.push_back(${projected}); ` +
                        `return ${result}; }()`
                    );
                }
                break;
            case "arraybuffer":
            case "dataview":
            case "u8array":
            case "f64array":
            case "f32array":
            case "u16array":
            case "i16array":
            case "u32array":
            case "i32array":
            case "handle":
                if (
                    dataType.kind === "handle" &&
                    value.kind === dataType.handle
                ) {
                    return value.cpp;
                }
                if (
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
            case "map":
                if (value.kind === "record") {
                    const entries = Object.entries(
                        value.recordProperties ?? {},
                    ).map(([name, entry]) => {
                        const key = dataType.key.kind === "string"
                            ? this.context.cppString(name)
                            : dataType.key.kind === "number"
                              ? doubleLiteral(Number(name))
                              : this.context.fail(
                                    node,
                                    "Compile-time open Records require string or number keys.",
                                );
                        return `{${key}, ${this.compileKnownValueForSink(entry, dataType.value, node)}}`;
                    });
                    this.context.reachJsData();
                    return `${this.context.dataTypes.cppType(dataType)}{${entries.join(", ")}}`;
                }
                if (
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
            case "span":
                if (value.kind === "tuple") {
                    this.context.reachJsData();
                    return `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>{${(
                        value.tupleElements ?? []
                    )
                        .map((entry) =>
                            this.compileKnownValueForSink(
                                entry,
                                dataType.element,
                                node,
                            ),
                        )
                        .join(", ")}}`;
                }
                if (
                    value.dataType &&
                    this.spanCompatible(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
            case "enummap":
                if (value.kind === "record") {
                    const members =
                        this.context.dataTypes.enumMembers(
                            dataType.enumName,
                        );
                    const properties =
                        value.recordProperties ?? {};
                    const written = Object.keys(properties);
                    const unknown = written.find(
                        (name) => !members.includes(name),
                    );
                    if (unknown) {
                        this.context.fail(
                            node,
                            `'${unknown}' is not a member of ${dataType.enumName}.`,
                        );
                    }
                    const compiled = new Map(
                        written.map((name) => [
                            name,
                            this.compileKnownValueForSink(
                                properties[name]!,
                                dataType.element,
                                node,
                            ),
                        ]),
                    );
                    const reordered = members.some(
                        (member, index) =>
                            written[index] !== member,
                    );
                    if (reordered) {
                        for (const key of written) {
                            const temporary =
                                this.context.allocateTemporaryCppName(
                                    "slot",
                                );
                            this.context.emit(
                                `${this.context.dataTypes.cppType(dataType.element)} ${temporary} = ${compiled.get(key)!};`,
                            );
                            this.registerLocal(
                                temporary,
                                "owned",
                            );
                            compiled.set(key, temporary);
                        }
                    }
                    const slots = members.map((member) => {
                        const slot = compiled.get(member);
                        if (slot === undefined) {
                            this.context.fail(
                                node,
                                `Compile-time record is missing the '${member}' slot.`,
                            );
                        }
                        return slot;
                    });
                    this.context.reachJsData();
                    return `${this.context.dataTypes.cppType(dataType)}{${slots.join(", ")}}`;
                }
                if (
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
            case "set":
            case "table":
                if (
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
            case "tuple":
                if (
                    value.kind === "tuple" &&
                    (value.tupleElements?.length ?? 0) ===
                        dataType.arity
                ) {
                    return `bbl::js::Tuple<${dataType.arity}>{${value
                        .tupleElements!.map((entry) =>
                            this.compileKnownValueForSink(
                                entry,
                                { kind: "number" },
                                node,
                            ),
                        )
                        .join(", ")}}`;
                }
                if (
                    value.dataType &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    return value.cpp;
                }
                break;
        }
        this.context.fail(
            node,
            `Compile-time ${value.kind} value does not match the expected data ${dataType.kind}.`,
        );
    }

    private spanLikeForSink(
        expression: ts.Expression,
        dataType: DataType,
    ): string {
        if (
            dataType.kind === "tuple" &&
            ts.isArrayLiteralExpression(expression)
        ) {
            if (
                expression.elements.length === 1 &&
                ts.isSpreadElement(expression.elements[0]!)
            ) {
                const spread = this.context.compileValue(
                    expression.elements[0]!.expression,
                );
                if (
                    spread.dataType &&
                    dataTypesEqual(spread.dataType, dataType)
                ) {
                    return `bbl::js::clone_tuple(${spread.cpp})`;
                }
                if (spread.kind === "tuple") {
                    return this.compileKnownValueForSink(
                        spread,
                        dataType,
                        expression,
                    );
                }
                this.context.fail(
                    expression.elements[0]!,
                    `Tuple spread requires a ${dataType.arity}-element numeric tuple.`,
                );
            }
            if (
                expression.elements.length !==
                dataType.arity
            ) {
                this.context.fail(
                    expression,
                    `Expected ${dataType.arity} tuple elements.`,
                );
            }
            this.context.reachJsData();
            return `bbl::js::Tuple<${dataType.arity}>{${expression.elements
                .map((element) =>
                    this.context.compileNumber(
                        element,
                        "double",
                    ),
                )
                .join(", ")}}`;
        }
        const rawValue =
            this.compileDataPath(expression, "read") ??
            this.materializeStaticTable(expression) ??
            this.context.compileValue(expression);
        const value =
            dataType.kind !== "optional" &&
            rawValue.kind === "data" &&
            rawValue.dataType?.kind === "optional" &&
            dataTypesEqual(rawValue.dataType.inner, dataType)
                ? {
                      ...rawValue,
                      ...this.leafValue(
                          `(*${rawValue.cpp})`,
                          rawValue.dataType.inner,
                      ),
                  }
                : rawValue;
        if (dataType.kind === "tuple" && value.kind === "tuple") {
            return this.compileKnownValueForSink(
                value,
                dataType,
                expression,
            );
        }
        if (dataType.kind === "span" && value.kind === "tuple") {
            return this.compileKnownValueForSink(
                value,
                dataType,
                expression,
            );
        }
        if (value.kind !== "data" || !value.dataType) {
            this.context.fail(
                expression,
                `Expected a data ${dataType.kind} value.`,
            );
        }
        if (
            this.spanCompatible(
                value.dataType,
                dataType,
            )
        ) {
            return value.cpp;
        }
        if (
            dataType.kind === "span" &&
            (value.dataType.kind === "vector" ||
                value.dataType.kind === "span") &&
            value.dataType.element.kind === "struct" &&
            dataType.element.kind === "struct"
        ) {
            const source =
                this.context.allocateTemporaryCppName(
                    "project_source",
                );
            const item =
                this.context.allocateTemporaryCppName(
                    "project_item",
                );
            const result =
                this.context.allocateTemporaryCppName(
                    "project_result",
                );
            const destinationCpp =
                this.context.dataTypes.cppType({
                    kind: "vector",
                    element: dataType.element,
                });
            const projected = this.compileKnownValueForSink(
                this.leafValue(
                    item,
                    value.dataType.element,
                ),
                dataType.element,
                expression,
            );
            return (
                `[&]() { auto&& ${source} = ${value.cpp}; ` +
                `${destinationCpp} ${result}; ` +
                `${result}.reserve(${source}.size()); ` +
                `for (const auto& ${item} : ${source}) ` +
                `${result}.push_back(${projected}); ` +
                `return ${result}; }()`
            );
        }
        this.context.fail(
            expression,
            `Data value of kind ${value.dataType.kind} does not match the expected ${dataType.kind}.`,
        );
    }

    /**
     * Structural compatibility for readonly views: spans accept vectors,
     * table rows, and same-element spans; tuples accept matching-arity
     * table rows.
     */
    public spanCompatible(
        source: DataType,
        sink: DataType,
    ): boolean {
        if (dataTypesEqual(source, sink)) {
            return true;
        }
        if (sink.kind === "span") {
            if (
                source.kind === "vector" ||
                source.kind === "span"
            ) {
                return dataTypesEqual(
                    source.element,
                    sink.element,
                );
            }
            if (source.kind === "table") {
                const remaining =
                    source.dimensions.slice(1);
                if (
                    remaining.length === 1 &&
                    sink.element.kind === "tuple"
                ) {
                    return (
                        sink.element.arity ===
                        remaining[0]
                    );
                }
                if (
                    remaining.length === 0 &&
                    sink.element.kind === "number"
                ) {
                    return true;
                }
            }
            return false;
        }
        if (sink.kind === "tuple") {
            return (
                source.kind === "table" &&
                source.dimensions.length === 1 &&
                source.dimensions[0] === sink.arity
            );
        }
        return false;
    }

    private requireDataValue(
        expression: ts.Expression,
        dataType: DataType,
    ): Value {
        const raw =
            this.compileDataPath(expression, "read") ??
            this.context.compileValue(expression);
        const value =
            raw.kind === "data"
                ? this.narrowOptional(raw, expression)
                : raw;
        if (
            value.kind === "data" &&
            value.dataType &&
            (dataTypesEqual(value.dataType, dataType) ||
                this.spanCompatible(
                    value.dataType,
                    dataType,
                ))
        ) {
            return value;
        }
        this.context.fail(
            expression,
            `Expression does not produce the expected data ${JSON.stringify(dataType)} value; received ${value.kind} ${value.dataType ? JSON.stringify(value.dataType) : "without a data type"}.`,
        );
    }

    /**
     * Compiles an object literal against a struct type as a positional
     * aggregate in field order. Spread properties are rejected here; the
     * statement-level helper handles them.
     */
    /**
     * Builds a `Record` literal.
     *
     * Slots are laid out in the union's tag order so an index by tag
     * lands on the value the source wrote under that key, but the
     * initializers are EVALUATED in the order they were written, which
     * is the order JavaScript runs them in. A slot initializer can
     * create meshes or call a helper that mutates what it is handed,
     * so the order is observable.
     *
     * Two things could reorder it. Compiling in tag order would move
     * the statements an inlined initializer emits, so the loop below
     * compiles in written order. Placing those expressions into the
     * braces in tag order would then move any evaluation that stayed
     * inside the expression -- a call to a native helper, say -- since
     * a braced initializer list evaluates left to right. So when the
     * two orders differ, each slot is pinned to a temporary first.
     */
    private enumMapLiteral(
        literal: ts.ObjectLiteralExpression,
        dataType: DataType & { kind: "enummap" },
    ): string {
        const members =
            this.context.dataTypes.enumMembers(
                dataType.enumName,
            );
        const compiled = new Map<string, string>();
        for (const property of literal.properties) {
            if (!ts.isPropertyAssignment(property)) {
                this.context.fail(
                    property,
                    "Record literals support plain property assignments.",
                );
            }
            const name =
                ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)
                    ? property.name.text
                    : undefined;
            if (name === undefined) {
                this.context.fail(
                    property.name,
                    "Record keys must be literal names.",
                );
            }
            if (!members.includes(name)) {
                this.context.fail(
                    property.name,
                    `'${name}' is not a member of ${dataType.enumName}.`,
                );
            }
            compiled.set(
                name,
                this.compileForSink(
                    property.initializer,
                    dataType.element,
                ),
            );
        }
        const written = this.literalKeyOrder(literal);
        const reordered = members.some(
            (member, index) => written[index] !== member,
        );
        if (reordered) {
            for (const key of written) {
                const slot = compiled.get(key);
                if (slot === undefined) {
                    continue;
                }
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "slot",
                    );
                this.context.emit(
                    `${this.context.dataTypes.cppType(dataType.element)} ${temporary} = ${slot};`,
                );
                this.registerLocal(temporary, "owned");
                compiled.set(key, temporary);
            }
        }
        const slots = members.map((member) => {
            const slot = compiled.get(member);
            if (slot === undefined) {
                this.context.fail(
                    literal,
                    `Record literal is missing the '${member}' slot.`,
                );
            }
            return slot;
        });
        this.context.reachJsData();
        return `${this.context.dataTypes.cppType(dataType)}{${slots.join(", ")}}`;
    }

    private openRecordLiteral(
        literal: ts.ObjectLiteralExpression,
        dataType: DataType & { kind: "map" },
    ): string {
        const entries = literal.properties.map((property) => {
            if (!ts.isPropertyAssignment(property)) {
                this.context.fail(
                    property,
                    "Open Record literals support plain property assignments.",
                );
            }
            const name =
                ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name) ||
                ts.isNumericLiteral(property.name)
                    ? property.name.text
                    : undefined;
            if (name === undefined) {
                this.context.fail(
                    property.name,
                    "Open Record keys must be literal names.",
                );
            }
            const key = dataType.key.kind === "string"
                ? this.context.cppString(name)
                : dataType.key.kind === "number"
                  ? doubleLiteral(Number(name))
                  : this.context.fail(
                        property.name,
                        "Open Record keys must be strings or numbers.",
                    );
            return `{${key}, ${this.compileForSink(property.initializer, dataType.value)}}`;
        });
        this.context.reachJsData();
        return `${this.context.dataTypes.cppType(dataType)}{${entries.join(", ")}}`;
    }

    /**
     * The keys of a literal, in the order they were written.
     */
    private literalKeyOrder(
        literal: ts.ObjectLiteralExpression,
    ): string[] {
        return literal.properties.flatMap((property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name))
                ? [property.name.text]
                : [],
        );
    }

    public structLiteral(
        literal: ts.ObjectLiteralExpression,
        dataType: DataType & { kind: "struct" },
    ): string {
        const fields = this.context.dataTypes.structFields(
            dataType.name,
            literal,
        );
        const provided = new Map<
            string,
            ts.Expression | ts.MethodDeclaration
        >();
        for (const property of literal.properties) {
            if (ts.isSpreadAssignment(property)) {
                this.context.fail(
                    property,
                    "Object spread is only supported in declarations and assignments.",
                );
            }
            if (ts.isPropertyAssignment(property)) {
                const name = property.name.getText();
                provided.set(
                    ts.isStringLiteral(property.name) ||
                        ts.isNumericLiteral(
                            property.name,
                        )
                        ? property.name.text
                        : name,
                    property.initializer,
                );
                continue;
            }
            if (
                ts.isShorthandPropertyAssignment(
                    property,
                )
            ) {
                provided.set(
                    property.name.text,
                    property.name,
                );
                continue;
            }
            if (
                ts.isMethodDeclaration(property) &&
                (ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name))
            ) {
                provided.set(
                    property.name.text,
                    property,
                );
                continue;
            }
            this.context.fail(
                property,
                "Struct literals support plain property assignments.",
            );
        }
        const parts = fields.map((field) => {
            const initializer = provided.get(field.name);
            if (!initializer) {
                if (field.defaultWhenMissing) {
                    return "{}";
                }
                if (field.type.kind === "optional") {
                    return "std::nullopt";
                }
                this.context.fail(
                    literal,
                    `Struct literal is missing field '${field.name}'.`,
                );
            }
            provided.delete(field.name);
            if (ts.isMethodDeclaration(initializer)) {
                if (field.type.kind !== "function") {
                    this.context.fail(
                        initializer,
                        `Method '${field.name}' requires a stored function field.`,
                    );
                }
                return this.context.compileStoredDataFunction(
                    initializer,
                    field.type,
                );
            }
            return this.compileForSink(
                initializer,
                field.type,
            );
        });
        if (provided.size > 0) {
            this.context.fail(
                literal,
                `Struct literal has unknown field '${[...provided.keys()][0]}'.`,
            );
        }
        return this.structAggregate(dataType, parts);
    }

    /**
     * One struct value from its fields, in declared order.
     *
     * The reference-vs-value fork is the whole of it, and it is stated
     * here alone: a reference struct is built through its `Data` shadow
     * and shared, a value struct is braced directly.
     */
    public structAggregate(
        dataType: DataType & { kind: "struct" },
        parts: readonly string[],
    ): string {
        // Besides yielding the spelling, cppType records the named type as
        // emitted so renderPreamble includes its definition. Reference
        // aggregates below spell the Data shadow directly and would
        // otherwise bypass that reachability bookkeeping.
        this.context.dataTypes.cppType(dataType);
        if (
            this.context.dataTypes.isReferenceStruct(
                dataType.name,
            )
        ) {
            return `bbl::js::make_ref<bblscene::${dataType.name}Data>(bblscene::${dataType.name}Data{${parts.join(", ")}})`;
        }
        return `${this.context.dataTypes.cppType(dataType)}{${parts.join(", ")}}`;
    }

    /**
     * Emits a declaration for an object literal with spread parts:
     * a default object followed by source-ordered field writes. Compile-time
     * records contribute only the keys they actually carry; a native struct
     * contributes every field. This preserves JavaScript's last-write-wins
     * spread semantics even when a partial record appears after explicit
     * properties.
     */
    public emitSpreadStructDeclaration(
        cppName: string,
        literal: ts.ObjectLiteralExpression,
        dataType: DataType & { kind: "struct" },
    ): void {
        const referenceStruct =
            this.context.dataTypes.isReferenceStruct(
                dataType.name,
            );
        let declared = false;
        const declareDefault = (): void => {
            if (declared) return;
            this.context.emit(
                referenceStruct
                    ? `${this.context.dataTypes.cppType(dataType)} ${cppName} = bbl::js::make_ref<bblscene::${dataType.name}Data>();`
                    : `${this.context.dataTypes.cppType(dataType)} ${cppName}{};`,
            );
            declared = true;
        };
        const member = referenceStruct ? "->" : ".";
        const assigned = new Set<string>();
        const assign = (
            sourceName: string,
            sourceValue: Value,
            node: ts.Node,
        ): void => {
            const field = this.context.dataTypes.structField(
                dataType.name,
                sourceName,
                node,
            );
            this.context.emit(
                `${cppName}${member}${field.name} = ${this.compileKnownValueForSink(sourceValue, field.type, node)};`,
            );
            assigned.add(field.name);
        };
        for (const property of literal.properties) {
            if (ts.isSpreadAssignment(property)) {
                const spread =
                    this.compileDataPath(
                        property.expression,
                        "read",
                    ) ??
                    this.context.compileValue(
                        property.expression,
                    );
                if (spread.kind === "record") {
                    declareDefault();
                    for (const [name, value] of Object.entries(
                        spread.recordProperties ?? {},
                    )) {
                        assign(name, value, property);
                    }
                    continue;
                }
                if (
                    spread.kind === "data" &&
                    spread.dataType?.kind === "struct" &&
                    dataTypesEqual(spread.dataType, dataType)
                ) {
                    if (!declared) {
                        this.context.emit(
                            `${this.context.dataTypes.cppType(dataType)} ${cppName} = ` +
                                (referenceStruct
                                    ? `bbl::js::make_ref<bblscene::${dataType.name}Data>(*(${spread.cpp}));`
                                    : `${spread.cpp};`),
                        );
                        declared = true;
                    } else {
                        this.context.emit(
                            referenceStruct
                                ? `*${cppName} = *(${spread.cpp});`
                                : `${cppName} = ${spread.cpp};`,
                        );
                    }
                    for (const field of this.context.dataTypes.structFields(
                        dataType.name,
                        property,
                    )) {
                        assigned.add(field.name);
                    }
                    continue;
                }
                if (
                    spread.kind === "data" &&
                    spread.dataType?.kind === "struct"
                ) {
                    declareDefault();
                    const sourceMember =
                        this.context.dataTypes.isReferenceStruct(
                            spread.dataType.name,
                        )
                            ? "->"
                            : ".";
                    const targetFields = new Map(
                        this.context.dataTypes
                            .structFields(dataType.name, property)
                            .map((field) => [field.name, field]),
                    );
                    for (const sourceField of this.context.dataTypes.structFields(
                        spread.dataType.name,
                        property,
                    )) {
                        const targetField = targetFields.get(
                            sourceField.name,
                        );
                        if (!targetField) continue;
                        const sourceCpp = `${spread.cpp}${sourceMember}${sourceField.name}`;
                        if (sourceField.type.kind === "optional") {
                            this.context.emit(
                                `if (${sourceCpp}.has_value()) {`,
                            );
                            this.context.increaseIndent();
                            this.context.emit(
                                `${cppName}${member}${targetField.name} = ${this.compileKnownValueForSink(this.leafValue(`*${sourceCpp}`, sourceField.type.inner), targetField.type, property)};`,
                            );
                            this.context.decreaseIndent();
                            this.context.emit("}");
                            // A possibly absent source property cannot by
                            // itself satisfy a required target field.
                            if (targetField.type.kind === "optional") {
                                assigned.add(targetField.name);
                            }
                            continue;
                        }
                        this.context.emit(
                            `${cppName}${member}${targetField.name} = ${this.compileKnownValueForSink(this.leafValue(sourceCpp, sourceField.type), targetField.type, property)};`,
                        );
                        assigned.add(targetField.name);
                    }
                    continue;
                }
                this.context.fail(
                    property,
                    "Object spread requires a compile-time record or native struct of the target type.",
                );
            }
            if (ts.isPropertyAssignment(property)) {
                declareDefault();
                const field =
                    this.context.dataTypes.structField(
                        dataType.name,
                        property.name.getText(),
                        property,
                );
                this.context.emit(
                    `${cppName}${member}${field.name} = ${this.compileForSink(property.initializer, field.type)};`,
                );
                assigned.add(field.name);
                continue;
            }
            if (
                ts.isShorthandPropertyAssignment(
                    property,
                )
            ) {
                declareDefault();
                const field =
                    this.context.dataTypes.structField(
                        dataType.name,
                        property.name.text,
                        property,
                );
                this.context.emit(
                    `${cppName}${member}${field.name} = ${this.compileForSink(property.name, field.type)};`,
                );
                assigned.add(field.name);
                continue;
            }
            this.context.fail(
                property,
                "Spread struct literals support plain property overrides.",
            );
        }
        declareDefault();
        const missing = this.context.dataTypes
            .structFields(dataType.name, literal)
            .find(
                (field) =>
                    field.type.kind !== "optional" &&
                    !assigned.has(field.name),
            );
        if (missing) {
            this.context.fail(
                literal,
                `Struct literal is missing field '${missing.name}'.`,
            );
        }
    }

    /**
     * Emits assignments whose target is a data path. Returns false when the
     * left side is not a data path.
     */
    /**
     * Assigns to a data-typed local by name (`currentMode = mode`).
     *
     * Scalars are native values. A vector is `js::Array`, whose copy
     * assignment copies its shared storage identity: aliases of the old
     * array keep the old object while the rebound name takes the right-hand
     * array, exactly like JavaScript. Value-backed structs still cannot be
     * rebound because their C++ assignment would copy fields instead. A
     * stored function is immutable after creation, so copying its
     * `std::function` target preserves JavaScript's observable semantics.
     */
    private emitLocalDataAssignment(
        expression: ts.BinaryExpression,
        left: ts.Identifier,
    ): boolean {
        // Resolved as a read: the write-mode ownership rules guard
        // against a write through a copy reaching its container, which
        // is a question only aggregates raise. A `let` holding a tag or
        // a handle is a plain copy in both languages, and the scalar
        // check below is what keeps aggregates out.
        const target = this.compileDataPath(left, "read");
        if (
            target?.kind !== "data" ||
            !target.dataType
        ) {
            return false;
        }
        const kind = target.dataType.kind;
        const vectorRebind = kind === "vector";
        const optionalRebind =
            target.dataType.kind === "optional" &&
            (target.dataType.inner.kind === "number" ||
                target.dataType.inner.kind === "boolean" ||
                target.dataType.inner.kind === "string" ||
                target.dataType.inner.kind === "enum" ||
                target.dataType.inner.kind === "handle" ||
                // U8Array is a shared ArrayBuffer view. Copying the wrapper
                // preserves JavaScript identity for constructor and helper
                // results alike.
                target.dataType.inner.kind === "u8array" ||
                ((target.dataType.inner.kind === "map" ||
                    target.dataType.inner.kind === "set") &&
                    ts.isNewExpression(
                        this.context.unwrap(expression.right),
                    )) ||
                (isTypedArrayType(target.dataType.inner) &&
                    ts.isNewExpression(
                        this.context.unwrap(expression.right),
                    )) ||
                ts.isObjectLiteralExpression(
                    this.context.unwrap(expression.right),
                ) ||
                ts.isArrayLiteralExpression(
                    this.context.unwrap(expression.right),
                ) ||
                this.context.unwrap(expression.right).kind ===
                    ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(
                    this.context.unwrap(expression.right),
                ) &&
                    (this.context.unwrap(
                        expression.right,
                    ) as ts.Identifier).text ===
                        "undefined"));
        if (
            kind !== "number" &&
            kind !== "boolean" &&
            kind !== "string" &&
            kind !== "enum" &&
            kind !== "handle" &&
            kind !== "function" &&
            !(
                kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    target.dataType.name,
                )
            ) &&
            !optionalRebind &&
            !vectorRebind
        ) {
            this.context.fail(
                expression,
                `'${left.text}' holds a ${kind}; rebinding it would copy in native code where JavaScript would alias, so assign through a field or element instead.`,
            );
        }
        this.context.emit(
            `${target.cpp} = ${this.compileForSink(expression.right, target.dataType)};`,
        );
        this.invalidateStaticElements(target);
        return true;
    }

    public emitAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        const operator = new Map<ts.SyntaxKind, string>([
            [ts.SyntaxKind.EqualsToken, "="],
            [ts.SyntaxKind.PlusEqualsToken, "+="],
            [ts.SyntaxKind.MinusEqualsToken, "-="],
            [ts.SyntaxKind.AsteriskEqualsToken, "*="],
            [ts.SyntaxKind.SlashEqualsToken, "/="],
            [ts.SyntaxKind.AmpersandEqualsToken, "&="],
            [ts.SyntaxKind.BarEqualsToken, "|="],
            [ts.SyntaxKind.CaretEqualsToken, "^="],
            [ts.SyntaxKind.LessThanLessThanEqualsToken, "<<="],
            [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ">>="],
            [
                ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
                ">>>=",
            ],
        ]).get(expression.operatorToken.kind);
        if (!operator) {
            return false;
        }
        const left = this.context.unwrap(expression.left);
        if (
            ts.isArrayLiteralExpression(left) &&
            operator === "="
        ) {
            return this.emitSwapAssignment(expression);
        }
        if (ts.isIdentifier(left) && operator === "=") {
            return this.emitLocalDataAssignment(
                expression,
                left,
            );
        }
        if (
            !ts.isPropertyAccessExpression(left) &&
            !ts.isElementAccessExpression(left)
        ) {
            return false;
        }
        if (
            ts.isPropertyAccessExpression(left) &&
            ts.isPropertyAccessExpression(left.expression) &&
            // The TRS trio plus the camera's `target` record: the engine
            // vectors whose component writes carry side effects.
            (isTrsVectorName(left.expression.name.text) ||
                left.expression.name.text === "target")
        ) {
            const ownerExpression = this.context.unwrap(
                left.expression.expression,
            );
            const ownerType = this.context.dataTypes.fromTsType(
                this.context.checker.getNonNullableType(
                    this.context.checker.getTypeAtLocation(ownerExpression),
                ),
                ownerExpression,
            );
            if (
                ownerType?.kind === "handle" &&
                (ownerType.handle === "mesh" ||
                    ownerType.handle === "camera")
            ) {
                // Engine transform components have observable side effects:
                // mesh writes dirty cached transforms and camera/light
                // vectors may call generated setters. Leave them to the
                // resource-property layer rather than treating their exposed
                // numeric lane as an ordinary plain-data field.
                return false;
            }
        }
        const clearStaticHandleSnapshot = (node: ts.Expression): void => {
            let root = this.context.unwrap(node);
            while (
                ts.isPropertyAccessExpression(root) ||
                ts.isElementAccessExpression(root)
            ) {
                root = this.context.unwrap(root.expression);
            }
            if (ts.isIdentifier(root)) {
                const value = this.context.lookupIdentifierValue(root);
                if (value) this.invalidateStaticElements(value);
            }
        };
        clearStaticHandleSnapshot(left);
        if (
            ts.isPropertyAccessExpression(left) &&
            left.name.text === "length"
        ) {
            const owner = this.compileDataPath(
                left.expression,
                "write",
            ) ?? (ts.isPropertyAccessExpression(left.expression) &&
                this.plainDataOwnerChain(left.expression)
                ? this.context.compileValue(left.expression)
                : undefined);
            if (owner?.kind === "data") {
                const narrowed = this.narrowOptional(
                    owner,
                    left.expression,
                );
                if (
                    narrowed.dataType?.kind === "vector"
                ) {
                    if (operator !== "=") {
                        this.context.fail(
                            expression,
                            "Array length supports plain assignment only.",
                        );
                    }
                    this.context.reachJsData();
                    // Truncation shrinks the array, so the exact
                    // element snapshot no longer describes it — and the
                    // static in-bounds proof over the snapshot's length
                    // must stop applying from here on.
                    this.invalidateStaticElements(narrowed);
                    this.context.emit(
                        (this.invalidateAliases(narrowed.cpp), `bbl::js::array_truncate(${narrowed.cpp}, ${this.context.compileNumber(expression.right, "double")});`),
                    );
                    return true;
                }
            }
            return false;
        }
        if (ts.isElementAccessExpression(left)) {
            // This first resolution only asks whether the target is a Map.
            // Resolving a call-shaped owner emits its call, so discard that
            // speculative emission when the answer is no and let the normal
            // element-target path below perform the source's one evaluation.
            const narrowed = this.context.probeEmission(
                () => {
                    const owner = this.compileDataPath(
                        left.expression,
                        "read",
                    );
                    const candidate = owner?.kind === "data"
                        ? this.narrowOptional(owner, left.expression)
                        : undefined;
                    return candidate?.dataType?.kind === "map"
                        ? {
                              ...candidate,
                              dataType: candidate.dataType,
                          }
                        : undefined;
                },
            );
            if (narrowed) {
                if (operator !== "=") {
                    this.context.fail(
                        expression,
                        "Indexed Record entries support plain assignment only.",
                    );
                }
                const keyValue = this.context.compileValue(
                    left.argumentExpression,
                );
                const assignedValue = this.context.compileValue(
                    expression.right,
                );
                const key = this.compileKnownValueForSink(
                    keyValue,
                    narrowed.dataType.key,
                    left.argumentExpression,
                );
                const value = this.compileKnownValueForSink(
                    assignedValue,
                    narrowed.dataType.value,
                    expression.right,
                );
                if (this.context.isInRuntimeControlFlow()) {
                    // This write may execute zero or many times. The source
                    // value still mutates natively, but its complete
                    // generation snapshot no longer exists on every path.
                    this.context.invalidateRecordProperties(narrowed);
                } else if (
                    keyValue.staticString !== undefined &&
                    narrowed.recordProperties !== undefined
                ) {
                    narrowed.recordProperties[keyValue.staticString] = {
                        ...assignedValue,
                        // Static consumers need the exact value this
                        // assignment stored, not a second evaluation of its
                        // source expression. The key snapshot proves the
                        // entry exists in every reached successful path.
                        cpp:
                            `${narrowed.cpp}.at(` +
                            `${this.context.cppString(keyValue.staticString)})`,
                    };
                } else if (keyValue.staticString === undefined) {
                    // A dynamic key means no finite property snapshot is
                    // complete enough for a generation-time consumer.
                    this.context.invalidateRecordProperties(narrowed);
                }
                this.context.emit(`${narrowed.cpp}.set(${key}, ${value});`);
                return true;
            }
        }
        const target = this.compileDataPath(
            left,
            "write",
        );
        if (!target) {
            return false;
        }
        // A declared engine property can expose a freshly materialized data
        // value for reads (mesh.boundMin is one). Assigning to that helper's
        // return value would only mutate a temporary; let the property layer
        // handle the owner's real setter instead.
        if (target.freshData) {
            return false;
        }
        if (target.kind === "number") {
            const right = this.context.compileNumber(
                expression.right,
                "double",
            );
            const helper = new Map<string, string>([
                ["&=", "bitwise_and"],
                ["|=", "bitwise_or"],
                ["^=", "bitwise_xor"],
                ["<<=", "shift_left"],
                [">>=", "shift_right"],
                [">>>=", "shift_right_unsigned"],
            ]).get(operator);
            const assigned = helper
                ? `bbl::js::${helper}(${target.cpp}, ${right})`
                : undefined;
            if (helper) {
                this.context.reachJsData();
            }
            if (target.dataStore) {
                if (operator !== "=" && !assigned) {
                    this.context.fail(
                        expression,
                        "Typed-array elements support plain and bitwise compound assignment only.",
                    );
                }
                const stored = assigned ?? right;
                this.context.emit(
                    `${target.cpp} = ${typedArrayStoreExpression(target.dataStore, stored)};`,
                );
                return true;
            }
            this.context.emit(
                assigned
                    ? `${target.cpp} = ${assigned};`
                    : `${target.cpp} ${operator} ${right};`,
            );
            return true;
        }
        if (target.kind === "boolean") {
            if (operator !== "=") {
                this.context.fail(
                    expression,
                    "Boolean fields support plain assignment only.",
                );
            }
            this.context.emit(
                `${target.cpp} = ${this.context.compileCondition(expression.right)};`,
            );
            return true;
        }
        if (
            target.kind === "data" &&
            target.dataType
        ) {
            if (operator !== "=") {
                this.context.fail(
                    expression,
                    `Compound assignment is not supported for data ${target.dataType.kind}.`,
                );
            }
            const right = this.context.unwrap(
                expression.right,
            );
            if (
                target.dataType.kind === "struct" &&
                ts.isObjectLiteralExpression(right) &&
                right.properties.some((property) =>
                    ts.isSpreadAssignment(property),
                )
            ) {
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "spread",
                    );
                this.emitSpreadStructDeclaration(
                    temporary,
                    right,
                    target.dataType,
                );
                this.context.emit(
                    `${target.cpp} = ${temporary};`,
                );
                return true;
            }
            if (
                target.dataType.kind === "optional" &&
                target.dataType.inner.kind ===
                    "struct" &&
                ts.isObjectLiteralExpression(right) &&
                right.properties.some((property) =>
                    ts.isSpreadAssignment(property),
                )
            ) {
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "spread",
                    );
                this.emitSpreadStructDeclaration(
                    temporary,
                    right,
                    target.dataType.inner,
                );
                this.context.emit(
                    `${target.cpp} = ${temporary};`,
                );
                return true;
            }
            this.context.emit(
                `${target.cpp} = ${this.compileForSink(expression.right, target.dataType)};`,
            );
            return true;
        }
        return false;
    }

    private emitSwapAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        const left = this.context.unwrap(
            expression.left,
        );
        const right = this.context.unwrap(
            expression.right,
        );
        if (
            !ts.isArrayLiteralExpression(left) ||
            !ts.isArrayLiteralExpression(right) ||
            left.elements.length !==
                right.elements.length ||
            left.elements.length !== 2
        ) {
            this.context.fail(
                expression,
                "Array destructuring assignment supports exactly two elements.",
            );
        }
        const targets = left.elements.map((element) => {
            const target =
                this.compileDataPath(element, "write") ??
                (ts.isIdentifier(element)
                    ? this.context.lookupIdentifierValue(element)
                    : undefined);
            if (
                !target ||
                target.kind !== "number"
            ) {
                this.context.fail(
                    element,
                    "Swap destructuring requires numeric data elements.",
                );
            }
            return target;
        });
        const sources = right.elements.map((element) =>
            this.context.compileNumber(
                element,
                "double",
            ),
        );
        const temporaries = sources.map((source) => {
            const name =
                this.context.allocateTemporaryCppName(
                    "swap",
                );
            this.context.emit(
                `const double ${name} = ${source};`,
            );
            return name;
        });
        targets.forEach((target, index) => {
            this.context.emit(
                `${target.cpp} = ${temporaries[index]};`,
            );
        });
        return true;
    }

    /**
     * Emits `path++` / `path--` for numeric data paths. Returns false when
     * the operand is not a data path.
     */
    public emitPostfixUnary(
        expression: ts.PostfixUnaryExpression,
    ): boolean {
        if (
            !ts.isPropertyAccessExpression(
                this.context.unwrap(expression.operand),
            ) &&
            !ts.isElementAccessExpression(
                this.context.unwrap(expression.operand),
            ) &&
            !ts.isIdentifier(
                this.context.unwrap(expression.operand),
            )
        ) {
            return false;
        }
        const operand = this.context.unwrap(
            expression.operand,
        );
        const target =
            this.compileDataPath(
                expression.operand,
                "write",
            ) ??
            (ts.isIdentifier(operand)
                ? this.context.lookupIdentifierValue(
                      operand,
                  )
                : undefined);
        if (target?.kind !== "number") {
            return false;
        }
        this.context.emit(
            `${target.cpp}${
                expression.operator ===
                ts.SyntaxKind.PlusPlusToken
                    ? "++"
                    : "--"
            };`,
        );
        return true;
    }

    /** Post-increment/decrement where the expression's old value is used. */
    public compilePostfixValue(
        expression: ts.PostfixUnaryExpression,
    ): Value | undefined {
        if (
            expression.operator !==
                ts.SyntaxKind.PlusPlusToken &&
            expression.operator !==
                ts.SyntaxKind.MinusMinusToken
        ) {
            return undefined;
        }
        const operand = this.context.unwrap(
            expression.operand,
        );
        const target =
            this.compileDataPath(
                expression.operand,
                "write",
            ) ??
            (ts.isIdentifier(operand)
                ? this.context.lookupIdentifierValue(
                      operand,
                  )
                : undefined);
        if (target?.kind !== "number") {
            return undefined;
        }
        const value: Value = {
            ...target,
            cpp: `(${target.cpp}${
                expression.operator ===
                ts.SyntaxKind.PlusPlusToken
                    ? "++"
                    : "--"
            })`,
            impure: true,
        };
        delete value.staticNumber;
        return value;
    }

    /** Pre-increment/decrement where the expression's new value is used. */
    public compilePrefixValue(
        expression: ts.PrefixUnaryExpression,
    ): Value | undefined {
        if (
            expression.operator !== ts.SyntaxKind.PlusPlusToken &&
            expression.operator !== ts.SyntaxKind.MinusMinusToken
        ) {
            return undefined;
        }
        const operand = this.context.unwrap(expression.operand);
        const target =
            this.compileDataPath(expression.operand, "write") ??
            (ts.isIdentifier(operand)
                ? this.context.lookupIdentifierValue(operand)
                : undefined);
        if (target?.kind !== "number") {
            return undefined;
        }
        const value: Value = {
            ...target,
            cpp: `(${expression.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--"}${target.cpp})`,
            impure: true,
        };
        delete value.staticNumber;
        return value;
    }

    /**
     * Produces a boolean C++ expression for a data condition operand, or
     * undefined when the expression is not data-typed.
     */
    public conditionOperand(
        expression: ts.Expression,
    ): string | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isElementAccessExpression(unwrapped)) {
            const owner = this.compileDataPath(
                unwrapped.expression,
                "read",
            );
            if (
                owner?.kind === "data" &&
                (owner.dataType?.kind === "vector" ||
                    owner.dataType?.kind === "span")
            ) {
                const element = owner.dataType.element;
                // Objects are truthy whenever the indexed element exists.
                // With noUncheckedIndexedAccess the source commonly writes
                // exactly this guard before dereferencing a dynamic index.
                if (
                    element.kind === "struct" ||
                    element.kind === "vector" ||
                    element.kind === "map" ||
                    element.kind === "set" ||
                    element.kind === "arraybuffer" ||
                    element.kind === "dataview" ||
                    element.kind === "u8array" ||
                    element.kind === "f64array" ||
                    element.kind === "f32array" ||
                    element.kind === "u16array" ||
                    element.kind === "i16array" ||
                    element.kind === "u32array" ||
                    element.kind === "i32array" ||
                    element.kind === "handle" ||
                    element.kind === "number" ||
                    element.kind === "boolean" ||
                    element.kind === "string" ||
                    element.kind === "enum"
                ) {
                    // The owner has already been resolved above. Reuse it:
                    // resolving it again would duplicate a call expression
                    // merely to derive the guard predicate.
                    const guarded = this.guardableElementRead(
                        owner,
                        unwrapped,
                    );
                    if (guarded?.truthinessCpp) {
                        return guarded.truthinessCpp;
                    }
                }
            }
        }
        const value =
            this.compileDataPath(unwrapped, "read") ??
            this.context.compileValue(unwrapped);
        if (!value) {
            return undefined;
        }
        return this.conditionFromValue(value);
    }

    /** JavaScript truthiness for a value the caller already compiled. */
    public conditionFromValue(value: Value): string | undefined {
        if (value.kind === "boolean") {
            return value.cpp;
        }
        if (value.kind === "number") {
            if (value.staticNumber !== undefined) {
                return value.staticNumber === 0 ||
                        Number.isNaN(value.staticNumber)
                    ? "false"
                    : "true";
            }
            this.context.reachJsData();
            return `bbl::js::number_truthy(${value.cpp})`;
        }
        if (value.kind === "tuple" || value.kind === "record") {
            // Arrays and plain objects are truthy even when empty. A
            // statically specialized callback can expose either shape
            // directly instead of first storing it as native data.
            return "true";
        }
        if (
            value.kind === "data" &&
            value.dataType !== undefined &&
            [
                "vector",
                "map",
                "set",
                "arraybuffer",
                "dataview",
                "u8array",
                "f64array",
                "f32array",
                "u16array",
                "i16array",
                "u32array",
                "i32array",
            ].includes(value.dataType.kind)
        ) {
            // JavaScript containers and typed arrays are objects and are
            // therefore truthy even when their native storage is empty.
            return "true";
        }
        if (
            value.kind === "string" ||
            (value.kind === "data" &&
                value.dataType?.kind === "string")
        ) {
            if (value.staticString !== undefined) {
                return value.staticString.length === 0 ? "false" : "true";
            }
            return value.kind === "string"
                ? `!std::string(${value.cpp}).empty()`
                : `!${value.cpp}.empty()`;
        }
        if (value.truthinessCpp !== undefined) {
            return value.truthinessCpp;
        }
        if (value.optionalFoundCpp !== undefined) {
            return value.optionalFoundCpp;
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "optional"
        ) {
            return `${value.cpp}.has_value()`;
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "struct" &&
            this.context.dataTypes.isReferenceStruct(value.dataType.name)
        ) {
            // An optional object stored in a Map/array uses the reference's
            // null state directly rather than wrapping it in std::optional.
            return `static_cast<bool>(${value.cpp})`;
        }
        if (value.kind === "json-null") {
            return "false";
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "function"
        ) {
            return `static_cast<bool>(${value.cpp})`;
        }
        return undefined;
    }

    /**
     * Compiles `===`/`!==` when either side is `null`, or both sides are
     * enum-typed data. Returns undefined for plain numeric comparisons.
     */
    public equalityComparison(
        expression: ts.BinaryExpression,
    ): string | undefined {
        const negated =
            expression.operatorToken.kind ===
            ts.SyntaxKind.ExclamationEqualsEqualsToken;
        if (
            expression.operatorToken.kind !==
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            !negated
        ) {
            return undefined;
        }
        const left = this.context.unwrap(
            expression.left,
        );
        const right = this.context.unwrap(
            expression.right,
        );
        if (
            ts.isTypeOfExpression(left) ||
            ts.isTypeOfExpression(right)
        ) {
            const leftValue = this.context.compileValue(left);
            const rightValue = this.context.compileValue(right);
            if (
                leftValue.staticString !== undefined &&
                rightValue.staticString !== undefined
            ) {
                const equal =
                    leftValue.staticString ===
                    rightValue.staticString;
                return equal !== negated ? "true" : "false";
            }
        }
        const isNullish = (candidate: ts.Expression): boolean =>
            candidate.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(candidate) &&
                candidate.text === "undefined" &&
                this.context.lookupOptional(candidate) === undefined);
        const nullSide =
            isNullish(left)
                ? right
                : isNullish(right)
                  ? left
                  : undefined;
        if (nullSide) {
            const value =
                this.compileDataPath(
                    nullSide,
                    "read",
                ) ??
                this.context.compileValue(nullSide);
            if (
                value?.kind === "data" &&
                value.dataType?.kind === "optional"
            ) {
                return negated
                    ? `${value.cpp}.has_value()`
                    : `!${value.cpp}.has_value()`;
            }
            if (value.optionalFoundCpp !== undefined) {
                return negated
                    ? value.optionalFoundCpp
                    : `!(${value.optionalFoundCpp})`;
            }
            if (value.kind === "json-null") {
                return negated ? "false" : "true";
            }
            // A value whose representation is already non-nullable has
            // either been flow-narrowed by TypeScript or was statically
            // non-nullish to begin with.
            if (
                value.kind !== "browser"
            ) {
                return negated ? "true" : "false";
            }
            return undefined;
        }
        // Optional chaining produces `T | undefined`. Strict equality with
        // a non-null scalar is therefore true only when the chain reached a
        // value and that value compares equal; strict inequality is the
        // exact negation. Bind each optional once so a call or indexed owner
        // keeps JavaScript's single-evaluation semantics.
        const optionalScalar = (
            dataType: DataType | undefined,
        ): dataType is Extract<DataType, { kind: "optional" }> =>
            dataType?.kind === "optional" &&
            ["number", "boolean", "string", "enum"].includes(
                dataType.inner.kind,
            );
        // TypeScript's index signatures describe `Record<K, V>[key]` as V,
        // even though a run-time lookup can miss. Our Map lowering preserves
        // that missing-key state and an optional chain over the lookup
        // therefore produces `Nullable<T>` even when the checker reports T.
        // Prefer that concrete lowered type for optional-chain operands so
        // `record[key]?.flag === true` compares the contained flag rather
        // than the nullable's presence bit.
        const loweredOptional = (
            operand: ts.Expression,
        ): Value | undefined => {
            const unwrapped = this.context.unwrap(operand);
            if (!ts.isOptionalChain(unwrapped)) {
                return undefined;
            }
            const value = this.compileDataPath(
                unwrapped,
                "read",
            );
            return value?.kind === "data" &&
                optionalScalar(value.dataType)
                ? value
                : undefined;
        };
        const leftOptional = loweredOptional(left);
        const rightOptional = loweredOptional(right);
        const leftType =
            leftOptional?.dataType ?? this.dataTypeAt(left);
        const rightType =
            rightOptional?.dataType ?? this.dataTypeAt(right);
        const bindOptional = (
            operand: ts.Expression,
            expected: Extract<DataType, { kind: "optional" }>,
            lowered?: Value,
        ): string => {
            this.context.reachJsData();
            const value =
                lowered ??
                this.compileDataPath(operand, "read") ??
                this.context.compileValue(operand);
            const concreteType: DataType | undefined =
                value.dataType ??
                (value.kind === "number"
                    ? { kind: "number" }
                    : value.kind === "boolean"
                      ? { kind: "boolean" }
                      : value.kind === "string"
                        ? { kind: "string" }
                        : undefined);
            if (
                concreteType &&
                dataTypesEqual(
                    concreteType,
                    expected.inner,
                )
            ) {
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "optional_compare",
                    );
                const cppType =
                    this.context.dataTypes.cppType(expected);
                const cpp = this.compileKnownValueForSink(
                    value,
                    expected.inner,
                    operand,
                );
                this.context.emit(
                    `const ${cppType} ${temporary}{${cpp}};`,
                );
                return temporary;
            }
            if (
                value.kind !== "data" ||
                !value.dataType ||
                !dataTypesEqual(value.dataType, expected)
            ) {
                this.context.fail(
                    operand,
                    "Optional scalar comparison did not lower to its declared data type.",
                );
            }
            const temporary =
                this.context.allocateTemporaryCppName(
                    "optional_compare",
                );
            this.context.emit(
                `const auto ${temporary} = ${value.cpp};`,
            );
            return temporary;
        };
        if (
            optionalScalar(leftType) &&
            optionalScalar(rightType) &&
            dataTypesEqual(leftType.inner, rightType.inner)
        ) {
            const leftCpp = bindOptional(
                left,
                leftType,
                leftOptional,
            );
            const rightCpp = bindOptional(
                right,
                rightType,
                rightOptional,
            );
            const equal =
                `(${leftCpp}.has_value() == ${rightCpp}.has_value() && ` +
                `(!${leftCpp}.has_value() || (*${leftCpp}) == (*${rightCpp})))`;
            return negated ? `!${equal}` : equal;
        }
        if (optionalScalar(leftType)) {
            const leftCpp = bindOptional(
                left,
                leftType,
                leftOptional,
            );
            const rightCpp = this.compileForSink(
                right,
                leftType.inner,
            );
            const equal =
                `(${leftCpp}.has_value() && ` +
                `(*${leftCpp}) == ${rightCpp})`;
            return negated ? `!${equal}` : equal;
        }
        if (optionalScalar(rightType)) {
            const rightCpp = bindOptional(
                right,
                rightType,
                rightOptional,
            );
            const leftCpp = this.compileForSink(
                left,
                rightType.inner,
            );
            const equal =
                `(${rightCpp}.has_value() && ` +
                `${leftCpp} == (*${rightCpp}))`;
            return negated ? `!${equal}` : equal;
        }
        const leftValue = this.comparableOperand(left);
        if (leftValue) {
            const rightValue = this.comparableOperand(right);
            const rightCpp = rightValue &&
                dataTypesEqual(rightValue.dataType, leftValue.dataType)
                ? rightValue.cpp
                : this.compileForSink(
                      right,
                      leftValue.dataType,
                  );
            if (leftValue.dataType.kind === "string") {
                if (
                    leftValue.staticString !== undefined &&
                    rightValue?.staticString !== undefined
                ) {
                    const equal =
                        leftValue.staticString === rightValue.staticString;
                    return equal !== negated ? "true" : "false";
                }
                return (
                    `std::string(${leftValue.cpp}) ` +
                    `${negated ? "!=" : "=="} std::string(${rightCpp})`
                );
            }
            return `${leftValue.cpp} ${negated ? "!=" : "=="} ${rightCpp}`;
        }
        const rightValue = this.comparableOperand(right);
        if (rightValue) {
            const leftCpp = this.compileForSink(
                left,
                rightValue.dataType,
            );
            if (rightValue.dataType.kind === "string") {
                return (
                    `std::string(${leftCpp}) ${negated ? "!=" : "=="} ` +
                    `std::string(${rightValue.cpp})`
                );
            }
            return `${leftCpp} ${negated ? "!=" : "=="} ${rightValue.cpp}`;
        }
        const leftObject = this.objectIdentity(left);
        const rightObject = this.objectIdentity(right);
        if (leftObject && rightObject) {
            return `${leftObject} ${negated ? "!=" : "=="} ${rightObject}`;
        }
        return undefined;
    }

    /**
     * An operand whose data type the native `==`/`!=` serve directly, so the
     * other side compiles against it through the ordinary sink path — an enum
     * tag or a string. Numbers keep the numeric comparison above, which
     * carries its own precision contract.
     */
    private comparableOperand(
        expression: ts.Expression,
    ):
        | { cpp: string; dataType: DataType; staticString?: string }
        | undefined {
        const value =
            this.compileDataPath(expression, "read") ??
            this.context.compileValue(expression);
        if (value?.kind === "string") {
            return {
                cpp: value.cpp,
                dataType: { kind: "string" },
                ...(value.staticString === undefined
                    ? {}
                    : { staticString: value.staticString }),
            };
        }
        if (value?.kind === "boolean") {
            return {
                cpp: value.cpp,
                dataType: { kind: "boolean" },
            };
        }
        if (
            value?.kind === "data" &&
            (value.dataType?.kind === "enum" ||
                value.dataType?.kind === "string" ||
                value.dataType?.kind === "boolean")
        ) {
            return {
                cpp: value.cpp,
                dataType: value.dataType,
                ...(value.staticString === undefined
                    ? {}
                    : { staticString: value.staticString }),
            };
        }
        return undefined;
    }

    /**
     * Resolves a runtime for-of iteration target: vectors, spans, and table
     * rows. Returns the container value plus its element data type.
     */
    public iterationTarget(
        expression: ts.Expression,
    ):
        | { container: Value; element: DataIterationElement }
        | undefined {
        const rawValue =
            this.materializeConstantArray(expression) ??
            this.compileDataPath(expression, "read") ??
            this.materializeStaticTable(expression) ??
            this.callSpanValue(expression) ??
            this.selectedIterationValue(expression) ??
            this.runtimeArrayLiteral(expression) ??
            (this.dataTypeAt(expression)?.kind === "string"
                ? this.context.compileValue(expression)
                : undefined);
        const value =
            rawValue?.kind === "data"
                ? this.narrowOptional(rawValue, expression)
                : rawValue;
        if (
            value?.kind === "string" ||
            (value?.kind === "data" &&
                value.dataType?.kind === "string")
        ) {
            const dataType: DataType = {
                kind: "vector",
                element: { kind: "string" },
            };
            this.context.reachJsData();
            return {
                container: {
                    kind: "data",
                    cpp: `bbl::js::string_characters(${value.cpp})`,
                    dataType,
                },
                element: dataType.element,
            };
        }
        if (value?.kind !== "data" || !value.dataType) {
            return undefined;
        }
        const dataType = value.dataType;
        if (
            dataType.kind === "vector" ||
            dataType.kind === "span" ||
            dataType.kind === "set"
        ) {
            return {
                container: value,
                element: dataType.element,
            };
        }
        if (dataType.kind === "map") {
            return {
                container: value,
                element: {
                    kind: "map-entry",
                    key: dataType.key,
                    value: dataType.value,
                },
            };
        }
        if (dataType.kind === "table") {
            const remaining =
                dataType.dimensions.slice(1);
            const element: DataType =
                remaining.length === 0
                    ? { kind: "number" }
                    : remaining.length === 1
                      ? {
                            kind: "tuple",
                            arity: remaining[0]!,
                        }
                      : {
                            kind: "table",
                            dimensions: remaining,
                        };
            return { container: value, element };
        }
        return undefined;
    }

    private runtimeArrayLiteral(
        expression: ts.Expression,
    ): Value | undefined {
        const literal = this.context.unwrap(expression);
        if (!ts.isArrayLiteralExpression(literal)) return undefined;
        const dataType = this.dataTypeAt(literal);
        if (dataType?.kind !== "vector") return undefined;
        this.context.reachJsData();
        const cppType = this.context.dataTypes.cppType(dataType.element);
        return {
            kind: "data",
            cpp:
                `bbl::js::Array<${cppType}>{` +
                literal.elements
                    .map((element) =>
                        this.compileForSink(element, dataType.element),
                    )
                    .join(", ") +
                `}`,
            dataType,
        };
    }

    /** A nullish/conditional container is materialized before range iteration. */
    private selectedIterationValue(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        const selected =
            ts.isConditionalExpression(unwrapped) ||
            (ts.isBinaryExpression(unwrapped) &&
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken);
        if (!selected) return undefined;
        const value = this.context.compileValue(unwrapped);
        return value.kind === "data" ? value : undefined;
    }

    private callSpanValue(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (!ts.isCallExpression(unwrapped)) {
            return undefined;
        }
        const value =
            this.context.compileValue(unwrapped);
        return value.kind === "data" ? value : undefined;
    }

    /**
     * Binds a for-of iteration variable (identifier, array pattern over
     * tuples, or object pattern over structs) to the range-for item.
     */
    public bindIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataIterationElement,
        define: (
            identifier: ts.Identifier,
            value: Value,
        ) => void,
    ): void {
        if (element.kind === "map-entry") {
            if (!ts.isArrayBindingPattern(name)) {
                this.context.fail(
                    name,
                    "Map iteration currently requires a [key, value] binding.",
                );
            }
            if (name.elements.length > 2) {
                this.context.fail(
                    name,
                    "Map entry destructuring accepts at most two bindings.",
                );
            }
            const pair = [
                { cpp: `${itemCpp}.first`, type: element.key },
                { cpp: `${itemCpp}.second`, type: element.value },
            ];
            name.elements.forEach((binding, index) => {
                if (ts.isOmittedExpression(binding)) return;
                if (
                    !ts.isIdentifier(binding.name) ||
                    binding.initializer ||
                    binding.dotDotDotToken
                ) {
                    this.context.fail(
                        binding,
                        "Map entry destructuring supports plain identifiers.",
                    );
                }
                const entry = pair[index]!;
                const value = this.leafValue(entry.cpp, entry.type);
                define(binding.name, value);
                if (value.kind === "data") {
                    this.registerLocal(
                        this.rootName(value.cpp),
                        "copy",
                    );
                }
            });
            return;
        }
        if (ts.isIdentifier(name)) {
            define(name, {
                ...this.leafValue(itemCpp, element),
                runtimeIteration: true,
            });
            return;
        }
        if (ts.isArrayBindingPattern(name)) {
            const arity =
                element.kind === "tuple"
                    ? element.arity
                    : undefined;
            if (arity === undefined) {
                this.context.fail(
                    name,
                    "Array destructuring in for...of requires tuple elements.",
                );
            }
            name.elements.forEach((element_, index) => {
                if (ts.isOmittedExpression(element_)) {
                    return;
                }
                if (
                    !ts.isIdentifier(element_.name) ||
                    element_.initializer ||
                    element_.dotDotDotToken
                ) {
                    this.context.fail(
                        element_,
                        "Tuple destructuring supports plain identifiers.",
                    );
                }
                if (index >= arity) {
                    this.context.fail(
                        element_,
                        `Tuple index ${index} is out of range.`,
                    );
                }
                define(element_.name, {
                    kind: "number",
                    cpp: `${itemCpp}[${index}]`,
                });
            });
            return;
        }
        if (ts.isObjectBindingPattern(name)) {
            if (element.kind !== "struct") {
                this.context.fail(
                    name,
                    "Object destructuring in for...of requires struct elements.",
                );
            }
            for (const binding of name.elements) {
                if (
                    !ts.isIdentifier(binding.name) ||
                    binding.initializer ||
                    binding.dotDotDotToken ||
                    binding.propertyName
                ) {
                    this.context.fail(
                        binding,
                        "Struct destructuring supports plain identifiers.",
                    );
                }
                const field =
                    this.context.dataTypes.structField(
                        element.name,
                        binding.name.text,
                        binding,
                    );
                const value = this.leafValue(
                    `${itemCpp}${
                        this.context.dataTypes.isReferenceStruct(
                            element.name,
                        )
                            ? "->"
                            : "."
                    }${field.name}`,
                    field.type,
                );
                define(binding.name, value);
                if (value.kind === "data") {
                    this.registerLocal(
                        this.rootName(value.cpp),
                        "copy",
                    );
                }
            }
            return;
        }
        this.context.fail(
            name,
            "Unsupported for...of binding.",
        );
    }
}
