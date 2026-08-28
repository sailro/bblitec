import ts from "typescript";
import { pinnedMathSpelling } from "../lowering/pinned-operators.js";
import {
    foldableMathUnary,
    staticNumberValue,
} from "./option-helpers.js";
import {
    DataTypeRegistry,
    dataTypesEqual,
    doubleLiteral,
    isTypedArrayType,
    type DataIterationElement,
    type DataType,
} from "./data-types.js";
import type { Value } from "./types.js";

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
 * `push`, `pop` and `splice` lower, and `shift`/`unshift` refuse by name
 * before they reach it. A method added to the lowerer that grows or shrinks
 * a container belongs here too, because this is the only guard the length
 * fold below has.
 */
const resizingArrayMethods: ReadonlySet<string> = new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
]);

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
            | ts.FunctionExpression,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value;
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

    public constructor(
        private readonly context: DataLoweringContext,
    ) {}

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
                if (state === "copy") {
                    this.context.fail(
                        unwrapped,
                        `'${unwrapped.text}' is a value copy of a data path; writes through aliases are outside the supported subset.`,
                    );
                }
                if (state === "escaped") {
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
                (ts.isElementAccessExpression(
                    this.context.unwrap(unwrapped.expression),
                )
                    ? this.context.compileValue(
                          unwrapped.expression,
                      )
                    : undefined) ??
                (unwrapped.questionDotToken
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
                (unwrapped.questionDotToken
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
            this.context.emit(
                `const auto ${temporary} = ${owner.cpp};`,
            );
            present = `${temporary}.has_value()`;
            presentOwner = {
                ...plainOwner,
                kind: "data",
                cpp: `(*${temporary})`,
                dataType: owner.dataType.inner,
            };
        } else if (optionalFoundCpp !== undefined) {
            present = optionalFoundCpp;
            presentOwner = plainOwner;
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
        if (!selected?.dataType) {
            this.context.fail(
                access,
                "Optional chaining currently requires a plain-data member or element.",
            );
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

    private materializeKnownTuple(
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
        const source = this.context.resolveStaticExpression(
            access.expression,
        );
        if (
            !ts.isNewExpression(source) ||
            !ts.isIdentifier(source.expression) ||
            ![
                "Float32Array",
                "Uint8Array",
                "Uint16Array",
                "Uint32Array",
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
            return this.leafValue(
                `(${temp}.has_value() ? (*${temp}) : ${fallback})`,
                inner,
            );
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
            return this.leafValue(
                this.context.dataTypes.isReferenceStruct(
                    dataType.name,
                )
                    ? `${owner.cpp}->${field.name}`
                    : `${owner.cpp}.${field.name}`,
                field.type,
            );
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
                `const auto ${keyTemporary} = ${key};`,
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
        const indexed =
            dataType.kind === "vector" && mode === "write"
                ? `bbl::js::array_index_write(${owner.cpp}, ${nativeIndex})`
                : `${owner.cpp}[${nativeIndex}]`;
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
                    dataStore:
                        dataType.kind === "f32array"
                            ? "f32"
                            : dataType.kind === "u8array"
                              ? "u8"
                            : dataType.kind === "u16array"
                              ? "u16"
                              : "u32",
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
                return this.leafValue(
                    indexed,
                    dataType.element,
                );
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
     * Reads an unasserted object element without touching invalid storage.
     * The value carries the separate existence predicate consumed when the
     * source tests the result for truthiness; a trailing `!` deliberately
     * takes the ordinary direct-index path instead.
     */
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
                "f32array",
                "u16array",
                "u32array",
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
            ? `std::addressof(${value.cpp})`
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
        const elements = literal
            ? literal.elements.map((entry) =>
                  this.compileForSink(entry, element),
              )
            : bound!.tupleElements!.map((entry) =>
                  element.kind === "enum"
                      ? entry.staticString !== undefined
                          ? this.context.dataTypes.enumMemberCpp(
                                element,
                                entry.staticString,
                                unwrapped,
                            )
                          : undefined
                      : element.kind === "number"
                        ? // A static lane only: `castNumber` writes it at
                          // this sink's own double width, and a runtime
                          // one rejects the whole materialization below.
                          entry.staticNumber !== undefined
                            ? this.context.castNumber(entry, "double")
                            : undefined
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
        const resolved =
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
        const unwrapped = this.context.unwrap(expression);
        if (ts.isNumericLiteral(unwrapped)) {
            return true;
        }
        return (
            ts.isPrefixUnaryExpression(unwrapped) &&
            (unwrapped.operator ===
                ts.SyntaxKind.MinusToken ||
                unwrapped.operator ===
                    ts.SyntaxKind.PlusToken) &&
            this.isStaticLeafNumber(unwrapped.operand)
        );
    }

    private staticLeafNumber(
        expression: ts.Expression,
    ): number {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isNumericLiteral(unwrapped)) {
            return Number(unwrapped.text);
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator ===
                ts.SyntaxKind.MinusToken
        ) {
            return -this.staticLeafNumber(
                unwrapped.operand,
            );
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator === ts.SyntaxKind.PlusToken
        ) {
            return this.staticLeafNumber(
                unwrapped.operand,
            );
        }
        this.context.fail(
            expression,
            "Static tables require numeric literal leaves.",
        );
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
    private compileTypedArraySet(
        call: ts.CallExpression,
        target: Value,
        kind: "u8array" | "f32array" | "u16array" | "u32array",
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
    private compileArraySearch(
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

    /**
     * Compiles data-container method calls (`push`, `pop`, `fill`) and the
     * `new Array(n).fill(v)` chain.
     */
    public compileDataMethodCall(
        call: ts.CallExpression,
    ): Value | undefined {
        const callee = this.context.unwrap(
            call.expression,
        );
        if (!ts.isPropertyAccessExpression(callee)) {
            return undefined;
        }
        const method = callee.name.text;
        const moduleMapGet =
            method === "get" &&
            ts.isIdentifier(callee.expression)
                ? this.compileModuleMapGet(
                      call,
                      callee.expression,
                  )
                : undefined;
        if (moduleMapGet) {
            return moduleMapGet;
        }
        const ownerExpression = this.context.unwrap(
            callee.expression,
        );
        if (
            ts.isNewExpression(ownerExpression) &&
            method === "fill"
        ) {
            const created = this.newArrayInfo(
                ownerExpression,
            );
            if (created) {
                if (call.arguments.length !== 1) {
                    this.context.fail(
                        call,
                        "Array.fill expects one argument.",
                    );
                }
                this.context.reachJsData();
                const value = this.compileForSink(
                    call.arguments[0]!,
                    created.element,
                );
                return {
                    kind: "data",
                    cpp: `bbl::js::array_filled<${this.context.dataTypes.cppType(created.element)}>(${created.count}, ${value})`,
                    dataType: {
                        kind: "vector",
                        element: created.element,
                    },
                };
            }
            const typed = this.compileTypedArrayNew(
                ownerExpression,
            );
            if (
                typed?.kind === "data" &&
                typed.dataType &&
                [
                    "u8array",
                    "u16array",
                    "u32array",
                    "f32array",
                ].includes(typed.dataType.kind)
            ) {
                if (call.arguments.length !== 1) {
                    this.context.fail(
                        call,
                        "TypedArray.fill expects one argument.",
                    );
                }
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "filled_array",
                    );
                const number = this.context.compileNumber(
                    call.arguments[0]!,
                    "double",
                );
                const value =
                    typed.dataType.kind === "u8array"
                        ? `bbl::js::to_uint8(${number})`
                        : typed.dataType.kind === "u16array"
                          ? `bbl::js::to_uint16(${number})`
                          : typed.dataType.kind === "u32array"
                            ? `bbl::js::to_uint32(${number})`
                            : `static_cast<float>(${number})`;
                this.context.emit(
                    `auto ${temporary} = ${typed.cpp};`,
                );
                this.context.emit(
                    `bbl::js::array_fill(${temporary}, ${value});`,
                );
                this.registerLocal(temporary, "owned");
                return {
                    kind: "data",
                    cpp: temporary,
                    dataType: typed.dataType,
                };
            }
        }
        const dynamicOwner =
            ts.isCallExpression(callee.expression)
                ? this.context.compileValue(callee.expression)
                : ts.isIdentifier(callee.expression)
                  ? (this.context.lookupIdentifierValue(callee.expression) ??
                    this.compileStaticContainer(callee.expression))
                  : undefined;
        const owner =
            this.compileDataPath(
                callee.expression,
                method === "pop" ||
                    method === "push" ||
                    method === "fill" ||
                    method === "splice" ||
                    method === "set" ||
                    method === "add" ||
                    method === "clear" ||
                    method === "delete"
                    ? "write"
                    : "read",
            ) ??
            (dynamicOwner?.kind === "data" ||
            dynamicOwner?.kind === "string"
                ? dynamicOwner
                : undefined) ??
            // A constant array is a compile-time tuple with nothing to
            // search, so searching one materializes it exactly as a
            // runtime index into it does.
            (method === "indexOf" || method === "includes"
                ? (this.materializeConstantArray(
                      callee.expression,
                  ) ??
                  this.materializeKnownTuple(
                      callee.expression,
                  ))
                : undefined);
        if (
            !owner ||
            (owner.kind !== "data" && owner.kind !== "string")
        ) {
            return undefined;
        }
        const narrowed = this.narrowOptional(
            owner,
            callee.expression,
        );
        const dataType =
            narrowed.dataType ??
            (narrowed.kind === "string"
                ? ({ kind: "string" } as const)
                : undefined);
        if (dataType?.kind === "map") {
            this.context.reachJsData();
            if (method === "has" || method === "get" || method === "delete") {
                if (call.arguments.length !== 1) {
                    this.context.fail(
                        call,
                        `Map.${method} expects exactly one key.`,
                    );
                }
                const key = this.compileForSink(
                    call.arguments[0]!,
                    dataType.key,
                );
                if (method === "has") {
                    return {
                        kind: "boolean",
                        cpp: `${narrowed.cpp}.has(${key})`,
                    };
                }
                if (method === "delete") {
                    return {
                        kind: "boolean",
                        cpp: `${narrowed.cpp}.erase(${key})`,
                        requiresExplicitDiscard: true,
                    };
                }
                if (
                    dataType.value.kind === "struct" &&
                    this.context.dataTypes.isReferenceStruct(
                        dataType.value.name,
                    )
                ) {
                    // Shared object handles carry absence themselves. Do
                    // not wrap and immediately dereference Map.get: a miss
                    // must remain an empty handle for the source guard.
                    return this.leafValue(
                        `${narrowed.cpp}.get(${key})`,
                        dataType.value,
                    );
                }
                return {
                    kind: "data",
                    cpp: `${narrowed.cpp}.get(${key})`,
                    // TypeScript flattens `(T | null) | undefined` to one
                    // nullable union. Preserve that shape so a single
                    // source guard narrows a Map whose value is nullable.
                    dataType:
                        dataType.value.kind === "optional"
                            ? dataType.value
                            : {
                                  kind: "optional",
                                  inner: dataType.value,
                              },
                };
            }
            if (method === "set") {
                if (call.arguments.length !== 2) {
                    this.context.fail(
                        call,
                        "Map.set expects exactly one key and one value.",
                    );
                }
                const key = this.compileForSink(
                    call.arguments[0]!,
                    dataType.key,
                );
                const value = this.compileForSink(
                    call.arguments[1]!,
                    dataType.value,
                );
                return {
                    kind: "data",
                    cpp: `${narrowed.cpp}.set(${key}, ${value})`,
                    dataType,
                };
            }
            this.context.fail(
                callee.name,
                `Map method '${method}' is not supported.`,
            );
        }
        if (dataType?.kind === "set") {
            this.context.reachJsData();
            if (method === "clear") {
                if (call.arguments.length !== 0) {
                    this.context.fail(
                        call,
                        "Set.clear expects no arguments.",
                    );
                }
                return {
                    kind: "void",
                    cpp: `${narrowed.cpp}.clear()`,
                };
            }
            if (method === "has" || method === "delete") {
                if (call.arguments.length !== 1) {
                    this.context.fail(
                        call,
                        `Set.${method} expects exactly one value.`,
                    );
                }
                const value = this.compileForSink(
                    call.arguments[0]!,
                    dataType.element,
                );
                return {
                    kind: "boolean",
                    cpp:
                        method === "has"
                            ? `${narrowed.cpp}.has(${value})`
                            : `${narrowed.cpp}.erase(${value})`,
                    ...(method === "delete"
                        ? { requiresExplicitDiscard: true }
                        : {}),
                };
            }
            if (method === "add") {
                if (call.arguments.length !== 1) {
                    this.context.fail(
                        call,
                        "Set.add expects exactly one value.",
                    );
                }
                const value = this.compileForSink(
                    call.arguments[0]!,
                    dataType.element,
                );
                return {
                    kind: "data",
                    cpp: `${narrowed.cpp}.add(${value})`,
                    dataType,
                };
            }
            this.context.fail(
                callee.name,
                `Set method '${method}' is not supported.`,
            );
        }
        if (dataType?.kind === "string") {
            this.context.reachJsData();
            if (method === "toUpperCase") {
                if (call.arguments.length !== 0) {
                    this.context.fail(call, "String.toUpperCase takes no arguments.");
                }
                return {
                    kind: "data",
                    cpp: `bbl::js::string_upper(${narrowed.cpp})`,
                    dataType: { kind: "string" },
                };
            }
            if (method === "slice") {
                if (call.arguments.length < 1 || call.arguments.length > 2) {
                    this.context.fail(call, "String.slice expects one or two arguments.");
                }
                const begin = this.context.compileNumber(call.arguments[0]!, "double");
                const end = call.arguments[1]
                    ? this.context.compileNumber(call.arguments[1], "double")
                    : `static_cast<double>(${narrowed.cpp}.size())`;
                return {
                    kind: "data",
                    cpp: `bbl::js::string_slice(${narrowed.cpp}, ${begin}, ${end})`,
                    dataType: { kind: "string" },
                };
            }
            if (method === "startsWith") {
                if (call.arguments.length !== 1) {
                    this.context.fail(call, "String.startsWith expects one argument.");
                }
                const prefix = this.compileForSink(
                    call.arguments[0]!,
                    { kind: "string" },
                );
                return {
                    kind: "boolean",
                    cpp: `bbl::js::string_starts_with(${narrowed.cpp}, ${prefix})`,
                };
            }
            if (method === "charCodeAt") {
                if (call.arguments.length !== 1) {
                    this.context.fail(call, "String.charCodeAt expects one argument.");
                }
                return {
                    kind: "number",
                    cpp: `bbl::js::string_char_code_at(${narrowed.cpp}, ${this.context.compileNumber(call.arguments[0]!, "double")})`,
                    dataType: { kind: "number" },
                };
            }
            if (method === "padStart") {
                if (call.arguments.length < 1 || call.arguments.length > 2) {
                    this.context.fail(call, "String.padStart expects one or two arguments.");
                }
                const fill = call.arguments[1]
                    ? this.compileForSink(call.arguments[1], { kind: "string" })
                    : this.context.cppString(" ");
                return {
                    kind: "data",
                    cpp: `bbl::js::string_pad_start(${narrowed.cpp}, ${this.context.compileNumber(call.arguments[0]!, "double")}, ${fill})`,
                    dataType: { kind: "string" },
                };
            }
        }
        if (method === "indexOf" || method === "includes") {
            // Readonly arrays and materialized constants reach this
            // too: the demo cycles its mode through a
            // a `readonly` array of tags, which is a span of them, and a
            // constant numeric array is a one-dimensional table.
            const element =
                dataType?.kind === "vector" ||
                dataType?.kind === "span"
                    ? dataType.element
                    : dataType?.kind === "table" &&
                        dataType.dimensions.length === 1
                      ? ({ kind: "number" } as DataType)
                      : undefined;
            if (element) {
                return this.compileArraySearch(
                    call,
                    narrowed,
                    element,
                    method,
                );
            }
        }
        if (
            isTypedArrayType(dataType) &&
            method === "fill"
        ) {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "TypedArray.fill expects one argument.",
                );
            }
            this.context.reachJsData();
            const number = this.context.compileNumber(
                call.arguments[0]!,
                "double",
            );
            const stored =
                dataType.kind === "f32array"
                    ? `static_cast<float>(${number})`
                    : dataType.kind === "u8array"
                      ? `bbl::js::to_uint8(${number})`
                    : dataType.kind === "u16array"
                      ? `bbl::js::to_uint16(${number})`
                      : `bbl::js::to_uint32(${number})`;
            return {
                kind: "void",
                cpp: `bbl::js::array_fill(${narrowed.cpp}, ${stored})`,
            };
        }
        if (
            isTypedArrayType(dataType) &&
            method === "set"
        ) {
            return this.compileTypedArraySet(
                call,
                narrowed,
                dataType.kind,
            );
        }
        if (
            dataType?.kind === "u8array" &&
            (method === "slice" || method === "subarray")
        ) {
            if (call.arguments.length < 1 || call.arguments.length > 2) {
                this.context.fail(
                    call,
                    `Uint8Array.${method} expects one or two arguments.`,
                );
            }
            const begin = this.context.compileNumber(
                call.arguments[0]!,
                "double",
            );
            const end = call.arguments[1]
                ? this.context.compileNumber(
                      call.arguments[1],
                      "double",
                  )
                : `static_cast<double>(${narrowed.cpp}.size())`;
            return {
                kind: "data",
                cpp:
                    `${narrowed.cpp}.${method}(` +
                    `bbl::js::array_index(${begin}), ` +
                    `bbl::js::array_index(${end}))`,
                dataType: { kind: "u8array" },
            };
        }
        if (
            dataType?.kind === "dataview" &&
            ["getInt16", "getUint16", "getInt32", "getUint32"].includes(method)
        ) {
            if (call.arguments.length < 1 || call.arguments.length > 2) {
                this.context.fail(
                    call,
                    `DataView.${method} expects one or two arguments.`,
                );
            }
            const offset = this.context.compileNumber(
                call.arguments[0]!,
                "double",
            );
            const littleEndian = call.arguments[1]
                ? this.context.compileCondition(call.arguments[1])
                : "false";
            const nativeMethod = method
                .replace(/^get/, "get_")
                .replace(/([a-z])([A-Z])/g, "$1_$2")
                .toLowerCase();
            return {
                kind: "number",
                cpp:
                    `static_cast<double>(${narrowed.cpp}.${nativeMethod}(` +
                    `bbl::js::array_index(${offset}), ${littleEndian}))`,
                dataType: { kind: "number" },
            };
        }
        if (dataType?.kind !== "vector") {
            return undefined;
        }
        this.context.reachJsData();
        if (method === "slice") {
            if (call.arguments.length > 2) {
                this.context.fail(
                    call,
                    "Array.slice expects zero, one, or two arguments.",
                );
            }
            const begin = call.arguments[0]
                ? this.context.compileNumber(call.arguments[0], "double")
                : "0.0";
            const end = call.arguments[1]
                ? this.context.compileNumber(call.arguments[1], "double")
                : `static_cast<double>(${narrowed.cpp}.size())`;
            return {
                kind: "data",
                cpp: `bbl::js::array_slice(${narrowed.cpp}, ${begin}, ${end})`,
                dataType,
            };
        }
        if (method === "sort") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Array.sort currently requires one comparator callback.",
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
                    "Array.sort requires a local function or function literal comparator.",
                );
            }
            const result = this.context.allocateTemporaryCppName(
                "sort_result",
            );
            const left = this.context.allocateTemporaryCppName("sort_left");
            const right = this.context.allocateTemporaryCppName("sort_right");
            this.context.emit(`auto ${result} = ${narrowed.cpp};`);
            this.context.emit(
                `std::sort(${result}.begin(), ${result}.end(), [&](const auto& ${left}, const auto& ${right}) {`,
            );
            this.context.increaseIndent();
            this.context.pushScope(this.context.allocateBlockPrefix());
            try {
                const compared = this.context.compileCallbackWithValues(
                    callback,
                    [
                        this.leafValue(left, dataType.element),
                        this.leafValue(right, dataType.element),
                    ],
                    call,
                );
                if (compared.kind !== "number") {
                    this.context.fail(
                        callback,
                        "Array.sort comparator must return a number.",
                    );
                }
                this.context.emit(`return ${compared.cpp} < 0.0;`);
            } finally {
                this.context.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("});");
            this.registerLocal(result, "owned");
            return { kind: "data", cpp: result, dataType };
        }
        if (method === "find") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Array.find requires exactly one callback and no thisArg.",
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
                    "Array.find requires a local function or function literal callback.",
                );
            }
            const resultType = this.dataTypeAt(call) ?? {
                kind: "optional" as const,
                inner: dataType.element,
            };
            const source = this.context.allocateTemporaryCppName(
                "find_source",
            );
            const result = this.context.allocateTemporaryCppName(
                "find_result",
            );
            const index = this.context.allocateTemporaryCppName(
                "find_index",
            );
            this.context.emit(`auto&& ${source} = ${narrowed.cpp};`);
            this.context.emit(
                `${this.context.dataTypes.cppType(resultType)} ${result}{};`,
            );
            this.context.emit(
                `for (std::size_t ${index} = 0; ${index} < ${source}.size(); ++${index}) {`,
            );
            this.context.increaseIndent();
            this.context.pushScope(this.context.allocateBlockPrefix());
            try {
                const matched = this.context.compileCallbackWithValues(
                    callback,
                    [
                        this.leafValue(
                            `${source}[${index}]`,
                            dataType.element,
                        ),
                        {
                            kind: "number",
                            cpp: `static_cast<double>(${index})`,
                            dataType: { kind: "number" },
                        },
                        {
                            kind: "data",
                            cpp: source,
                            dataType,
                        },
                    ],
                    call,
                );
                if (matched.kind !== "boolean") {
                    this.context.fail(
                        callback,
                        "Array.find callback must return a boolean value.",
                    );
                }
                this.context.emit(`if (${matched.cpp}) {`);
                this.context.increaseIndent();
                this.context.emit(
                    `${result} = ${source}[${index}];`,
                );
                this.context.emit("break;");
                this.context.decreaseIndent();
                this.context.emit("}");
            } finally {
                this.context.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("}");
            this.registerLocal(result, "owned");
            return this.leafValue(result, resultType);
        }
        if (method === "filter") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Array.filter requires exactly one callback and no thisArg.",
                );
            }
            const callback = this.context.unwrap(
                call.arguments[0]!,
            );
            if (
                !ts.isIdentifier(callback) &&
                !ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback)
            ) {
                this.context.fail(
                    callback,
                    "Array.filter requires a local function or function literal callback.",
                );
            }
            const source =
                this.context.allocateTemporaryCppName(
                    "filter_source",
                );
            const output =
                this.context.allocateTemporaryCppName(
                    "filter_result",
                );
            const index =
                this.context.allocateTemporaryCppName(
                    "filter_index",
                );
            this.context.emit(`auto&& ${source} = ${narrowed.cpp};`);
            this.context.emit(
                `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}> ${output};`,
            );
            this.context.emit(`${output}.reserve(${source}.size());`);
            this.context.emit(
                `for (std::size_t ${index} = 0; ${index} < ${source}.size(); ++${index}) {`,
            );
            this.context.increaseIndent();
            this.context.pushScope(
                this.context.allocateBlockPrefix(),
            );
            try {
                const matched =
                    this.context.compileCallbackWithValues(
                        callback,
                        [
                            this.leafValue(
                                `${source}[${index}]`,
                                dataType.element,
                            ),
                            {
                                kind: "number",
                                cpp: `static_cast<double>(${index})`,
                                dataType: { kind: "number" },
                            },
                            {
                                kind: "data",
                                cpp: source,
                                dataType,
                            },
                        ],
                        call,
                    );
                if (matched.kind !== "boolean") {
                    this.context.fail(
                        callback,
                        "Array.filter callback must return a boolean value.",
                    );
                }
                this.context.emit(
                    `if (${matched.cpp}) ${output}.push_back(${source}[${index}]);`,
                );
            } finally {
                this.context.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("}");
            this.registerLocal(output, "owned");
            return {
                kind: "data",
                cpp: output,
                dataType,
            };
        }
        if (method === "some") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Array.some requires exactly one callback and no thisArg.",
                );
            }
            const callback = this.context.unwrap(
                call.arguments[0]!,
            );
            if (
                !ts.isIdentifier(callback) &&
                !ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback)
            ) {
                this.context.fail(
                    callback,
                    "Array.some requires a local function or function literal callback.",
                );
            }
            const source =
                this.context.allocateTemporaryCppName(
                    "some_source",
                );
            const result =
                this.context.allocateTemporaryCppName(
                    "some_result",
                );
            const index =
                this.context.allocateTemporaryCppName(
                    "some_index",
                );
            this.context.emit(`auto&& ${source} = ${narrowed.cpp};`);
            this.context.emit(`bool ${result} = false;`);
            this.context.emit(
                `for (std::size_t ${index} = 0; ${index} < ${source}.size(); ++${index}) {`,
            );
            this.context.increaseIndent();
            this.context.pushScope(
                this.context.allocateBlockPrefix(),
            );
            try {
                const matched =
                    this.context.compileCallbackWithValues(
                        callback,
                        [
                            this.leafValue(
                                `${source}[${index}]`,
                                dataType.element,
                            ),
                            {
                                kind: "number",
                                cpp: `static_cast<double>(${index})`,
                                dataType: { kind: "number" },
                            },
                            {
                                kind: "data",
                                cpp: source,
                                dataType,
                            },
                        ],
                        call,
                    );
                if (matched.kind !== "boolean") {
                    this.context.fail(
                        callback,
                        "Array.some callback must return a boolean value.",
                    );
                }
                this.context.emit(`if (${matched.cpp}) {`);
                this.context.increaseIndent();
                this.context.emit(`${result} = true;`);
                this.context.emit("break;");
                this.context.decreaseIndent();
                this.context.emit("}");
            } finally {
                this.context.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("}");
            return {
                kind: "boolean",
                cpp: result,
                dataType: { kind: "boolean" },
            };
        }
        if (method === "map") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Array.map requires exactly one callback and no thisArg.",
                );
            }
            const callback = this.context.unwrap(
                call.arguments[0]!,
            );
            if (
                !ts.isIdentifier(callback) &&
                !ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback)
            ) {
                this.context.fail(
                    callback,
                    "Array.map requires a local function or function literal callback.",
                );
            }
            const mappedType = this.dataTypeAt(call);
            if (mappedType?.kind !== "vector") {
                this.context.fail(
                    call,
                    "Array.map callback results must belong to the native data model.",
                );
            }
            const source =
                this.context.allocateTemporaryCppName(
                    "map_source",
                );
            const output =
                this.context.allocateTemporaryCppName(
                    "map_result",
                );
            const index =
                this.context.allocateTemporaryCppName(
                    "map_index",
                );
            const count =
                this.context.allocateTemporaryCppName(
                    "map_count",
                );
            this.context.emit(`auto&& ${source} = ${narrowed.cpp};`);
            this.context.emit(
                `bbl::js::Array<${this.context.dataTypes.cppType(mappedType.element)}> ${output};`,
            );
            this.context.emit(`${output}.reserve(${source}.size());`);
            this.context.emit(
                `const std::size_t ${count} = ${source}.size();`,
            );
            this.context.emit(
                `for (std::size_t ${index} = 0; ${index} < ${count}; ++${index}) {`,
            );
            this.context.increaseIndent();
            this.context.pushScope(
                this.context.allocateBlockPrefix(),
            );
            try {
                const result =
                    this.context.compileCallbackWithValues(
                        callback,
                        [
                            this.leafValue(
                                `${source}[${index}]`,
                                dataType.element,
                            ),
                            {
                                kind: "number",
                                cpp: `static_cast<double>(${index})`,
                                dataType: { kind: "number" },
                            },
                            {
                                kind: "data",
                                cpp: source,
                                dataType,
                            },
                        ],
                        call,
                    );
                const value = this.compileKnownValueForSink(
                    result,
                    mappedType.element,
                    callback,
                );
                this.context.emit(
                    `${output}.push_back(${value});`,
                );
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
        if (method === "forEach") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Array.forEach requires exactly one callback and no thisArg.",
                );
            }
            const callback = this.context.unwrap(
                call.arguments[0]!,
            );
            if (
                !ts.isIdentifier(callback) &&
                !ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback)
            ) {
                this.context.fail(
                    callback,
                    "Array.forEach requires a local function or function literal callback.",
                );
            }
            const index =
                this.context.allocateTemporaryCppName(
                    "for_each_index",
                );
            const count =
                this.context.allocateTemporaryCppName(
                    "for_each_count",
                );
            this.context.emit(
                `const std::size_t ${count} = ${narrowed.cpp}.size();`,
            );
            this.context.emit(
                `for (std::size_t ${index} = 0; ${index} < ${count}; ++${index}) {`,
            );
            this.context.increaseIndent();
            this.context.pushScope(
                this.context.allocateBlockPrefix(),
            );
            try {
                const result =
                    this.context.compileCallbackWithValues(
                        callback,
                        [
                            this.leafValue(
                                `${narrowed.cpp}[${index}]`,
                                dataType.element,
                            ),
                            {
                                kind: "number",
                                cpp: `static_cast<double>(${index})`,
                                dataType: { kind: "number" },
                            },
                            narrowed,
                        ],
                        call,
                    );
                if (result.cpp.length > 0) {
                    this.context.emit(
                        result.requiresExplicitDiscard
                            ? `static_cast<void>(${result.cpp});`
                            : `${result.cpp};`,
                    );
                }
            } finally {
                this.context.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("}");
            return { kind: "void", cpp: "" };
        }
        if (method === "push") {
            if (call.arguments.length === 0) {
                this.context.fail(
                    call,
                    "Array push requires at least one element.",
                );
            }
            this.invalidateAliases(narrowed.cpp);
            const pushes = call.arguments.map(
                (argument) =>
                    `${narrowed.cpp}.push_back(${this.compileForSink(argument, dataType.element)})`,
            );
            return {
                kind: "void",
                cpp:
                    pushes.length === 1
                        ? pushes[0]!
                        : `(${pushes.join(", ")})`,
            };
        }
        if (method === "pop") {
            if (call.arguments.length !== 0) {
                this.context.fail(
                    call,
                    "Array.pop expects no arguments.",
                );
            }
            this.invalidateAliases(narrowed.cpp);
            const popped = `bbl::js::array_pop(${narrowed.cpp})`;
            return this.leafValue(
                popped,
                dataType.element,
            );
        }
        if (method === "fill") {
            if (call.arguments.length !== 1) {
                this.context.fail(
                    call,
                    "Array.fill expects one argument.",
                );
            }
            const value = this.compileForSink(
                call.arguments[0]!,
                dataType.element,
            );
            return {
                kind: "void",
                cpp: `bbl::js::array_fill(${narrowed.cpp}, ${value})`,
            };
        }
        if (method === "splice") {
            // The reached removal form: splice(index, 1). Insertions
            // and multi-element removals stay unreached.
            const removalCount =
                call.arguments.length === 2
                    ? this.context.resolveStaticExpression(
                          call.arguments[1]!,
                      )
                    : undefined;
            if (
                !removalCount ||
                !ts.isNumericLiteral(removalCount) ||
                Number(removalCount.text) !== 1
            ) {
                this.context.fail(
                    call,
                    "Array.splice supports removing exactly one element.",
                );
            }
            this.invalidateAliases(narrowed.cpp);
            return {
                kind: "void",
                cpp: `bbl::js::array_splice_one(${narrowed.cpp}, ${this.context.compileNumber(call.arguments[0]!, "double")})`,
            };
        }
        this.context.fail(
            callee.name,
            `Array method '${method}' is not supported.`,
        );
    }

    /**
     * A module `const` initialized with a literal Map/Set constructor is a
     * value even though it has no runtime local binding. Keep it lazy at the
     * use site, just like other module constants, so unused containers do not
     * enter the generated program.
     */
    private compileStaticContainer(
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
    private compileModuleMapGet(
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

    private newArrayInfo(
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
     * `new Float32Array`, `new Uint8Array`, `new Uint16Array`, and `new Uint32Array` (sized, from a numeric
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

    private compileTypedArrayNew(
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
            name !== "Float32Array" &&
            name !== "Uint8Array" &&
            name !== "Uint16Array" &&
            name !== "Uint32Array"
        ) {
            return undefined;
        }
        const prefix =
            name === "Float32Array"
                ? "f32"
                : name === "Uint8Array"
                  ? "u8"
                : name === "Uint16Array"
                  ? "u16"
                  : "u32";
        const dataType: DataType =
            name === "Float32Array"
                ? { kind: "f32array" }
                : name === "Uint8Array"
                  ? { kind: "u8array" }
                : name === "Uint16Array"
                  ? { kind: "u16array" }
                  : { kind: "u32array" };
        this.context.reachJsData();
        const argument = expression.arguments?.[0];
        if (!argument) {
            return {
                kind: "data",
                cpp: `${this.context.dataTypes.cppType(dataType)}{}`,
                dataType,
            };
        }
        if ((expression.arguments?.length ?? 0) > 1) {
            this.context.fail(
                expression,
                `new ${name} supports at most one argument.`,
            );
        }
        const unwrapped = this.context.unwrap(argument);
        if (name === "Uint8Array") {
            const source = this.compileDataPath(unwrapped, "read") ??
                this.context.compileValue(unwrapped);
            if (source.dataType?.kind === "arraybuffer") {
                return {
                    kind: "data",
                    cpp: `bbl::js::U8Array(${source.cpp})`,
                    dataType,
                };
            }
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            const elements = unwrapped.elements.map(
                (element) =>
                    this.context.compileNumber(
                        element,
                        "double",
                    ),
            );
            return {
                kind: "data",
                cpp: `bbl::js::${prefix}_array_from(bbl::js::Array<double>{${elements.join(", ")}})`,
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
                cpp: `bbl::js::${prefix}_array_from(bbl::js::Array<double>{${elements.join(", ")}})`,
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
            dataType.kind !== "number"
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
                    unwrapped,
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
                const rawValue = this.compileDataPath(
                    unwrapped,
                    "read",
                );
                const value = rawValue?.kind === "data"
                    ? this.narrowOptional(rawValue, unwrapped)
                    : rawValue;
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
                const rawValue = this.compileDataPath(
                    unwrapped,
                    "read",
                );
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
                return this.compileForSink(
                    unwrapped,
                    dataType.inner,
                );
            }
            case "struct": {
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
                    if (mapped.kind === "tuple") {
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
                    sourceType.element.kind === "struct" &&
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
                if (ts.isNewExpression(unwrapped)) {
                    const created =
                        this.compileMapOrSetNew(unwrapped);
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
                const rawValue =
                    this.context.compileValue(unwrapped);
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
                        (value.dataType?.kind === "handle" &&
                            value.dataType.handle === "texture")
                    )
                ) {
                    this.context.fail(
                        unwrapped,
                        "Texture2D data storage currently supports createTexture2DFromPixels values.",
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
            case "f32array":
            case "u16array":
            case "u32array": {
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
                if (
                    value.kind === "data" &&
                    value.dataType?.kind === "string"
                ) {
                    return value.cpp;
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
                if (value.kind === "record") {
                    const fields =
                        this.context.dataTypes.structFields(
                            dataType.name,
                            node,
                        );
                    const aggregate = `bblscene::${dataType.name}${this.context.dataTypes.isReferenceStruct(dataType.name) ? "Data" : ""}{${fields
                        .map((field) => {
                            const property =
                                value.recordProperties?.[
                                    field.name
                                ];
                            if (!property) {
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
                        ? `std::make_shared<bblscene::${dataType.name}Data>(${aggregate})`
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
                        ? `std::make_shared<bblscene::${dataType.name}Data>(${aggregate})`
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
                    value.dataType.element.kind === "struct" &&
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
            case "f32array":
            case "u16array":
            case "u32array":
            case "handle":
            case "map":
            case "set":
            case "enummap":
            case "span":
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
        const value =
            this.compileDataPath(expression, "read") ??
            this.materializeStaticTable(expression) ??
            this.context.compileValue(expression);
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
            ts.Expression
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
            this.context.fail(
                property,
                "Struct literals support plain property assignments.",
            );
        }
        const parts = fields.map((field) => {
            const initializer = provided.get(field.name);
            if (!initializer) {
                if (field.type.kind === "optional") {
                    return "std::nullopt";
                }
                this.context.fail(
                    literal,
                    `Struct literal is missing field '${field.name}'.`,
                );
            }
            provided.delete(field.name);
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
        if (
            this.context.dataTypes.isReferenceStruct(
                dataType.name,
            )
        ) {
            return `std::make_shared<bblscene::${dataType.name}Data>(bblscene::${dataType.name}Data{${parts.join(", ")}})`;
        }
        return `${this.context.dataTypes.cppType(dataType)}{${parts.join(", ")}}`;
    }

    /**
     * Emits a declaration for an object literal with spread parts:
     * `T name = <spread source>; name.field = override; ...`.
     */
    public emitSpreadStructDeclaration(
        cppName: string,
        literal: ts.ObjectLiteralExpression,
        dataType: DataType & { kind: "struct" },
    ): void {
        const spreadIndex =
            literal.properties.findIndex((property) =>
                ts.isSpreadAssignment(property),
            );
        const spread = literal.properties[spreadIndex];
        if (
            !spread ||
            !ts.isSpreadAssignment(spread) ||
            spreadIndex !== 0
        ) {
            this.context.fail(
                literal,
                "Object spread must be the first property.",
            );
        }
        if (
            literal.properties.filter((property) =>
                ts.isSpreadAssignment(property),
            ).length > 1
        ) {
            this.context.fail(
                literal,
                "Only one spread property is supported.",
            );
        }
        const source = this.compileForSink(
            spread.expression,
            dataType,
        );
        this.context.emit(
            `${this.context.dataTypes.cppType(dataType)} ${cppName} = ${source};`,
        );
        for (const property of literal.properties.slice(
            1,
        )) {
            if (ts.isPropertyAssignment(property)) {
                const field =
                    this.context.dataTypes.structField(
                        dataType.name,
                        property.name.getText(),
                        property,
                    );
                this.context.emit(
                    `${cppName}.${field.name} = ${this.compileForSink(property.initializer, field.type)};`,
                );
                continue;
            }
            if (
                ts.isShorthandPropertyAssignment(
                    property,
                )
            ) {
                const field =
                    this.context.dataTypes.structField(
                        dataType.name,
                        property.name.text,
                        property,
                    );
                this.context.emit(
                    `${cppName}.${field.name} = ${this.compileForSink(property.name, field.type)};`,
                );
                continue;
            }
            this.context.fail(
                property,
                "Spread struct literals support plain property overrides.",
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
     * Only the scalar data kinds are reachable this way. A tag or a
     * handle is a value in both languages, so a C++ assignment says
     * exactly what the JavaScript said. Rebinding a name that holds a
     * struct or an array does NOT: JavaScript would leave both names
     * pointing at one object while C++ would copy, so those keep their
     * rejection rather than compiling into a different program.
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
        const optionalRebind =
            target.dataType.kind === "optional" &&
            (target.dataType.inner.kind === "number" ||
                target.dataType.inner.kind === "boolean" ||
                target.dataType.inner.kind === "string" ||
                target.dataType.inner.kind === "enum" ||
                target.dataType.inner.kind === "handle" ||
                ts.isObjectLiteralExpression(
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
            kind !== "enum" &&
            kind !== "handle" &&
            !(
                kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    target.dataType.name,
                )
            ) &&
            !optionalRebind
        ) {
            this.context.fail(
                expression,
                `'${left.text}' holds a ${kind}; rebinding it would copy in native code where JavaScript would alias, so assign through a field or element instead.`,
            );
        }
        this.context.emit(
            `${target.cpp} = ${this.compileForSink(expression.right, target.dataType)};`,
        );
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
            left.name.text === "length"
        ) {
            const owner = this.compileDataPath(
                left.expression,
                "write",
            );
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
                    this.context.emit(
                        (this.invalidateAliases(narrowed.cpp), `bbl::js::array_truncate(${narrowed.cpp}, ${this.context.compileNumber(expression.right, "double")});`),
                    );
                    return true;
                }
            }
            return false;
        }
        const target = this.compileDataPath(
            left,
            "write",
        );
        if (!target) {
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
                    target.dataStore === "u32"
                        ? `${target.cpp} = bbl::js::to_uint32(${stored});`
                        : target.dataStore === "u16"
                          ? `${target.cpp} = bbl::js::to_uint16(${stored});`
                          : target.dataStore === "u8"
                            ? `${target.cpp} = bbl::js::to_uint8(${stored});`
                          : `${target.cpp} = static_cast<float>(${stored});`,
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
            const target = this.compileDataPath(
                element,
                "write",
            );
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
                    element.kind === "f32array" ||
                    element.kind === "u16array" ||
                    element.kind === "u32array" ||
                    element.kind === "handle" ||
                    element.kind === "number" ||
                    element.kind === "boolean" ||
                    element.kind === "string" ||
                    element.kind === "enum"
                ) {
                    const guarded =
                        this.compileGuardableElementAccess(
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
        if (value.kind === "boolean") {
            return value.cpp;
        }
        if (value.kind === "number") {
            this.context.reachJsData();
            return `bbl::js::number_truthy(${value.cpp})`;
        }
        if (
            value.kind === "string" ||
            (value.kind === "data" &&
                value.dataType?.kind === "string")
        ) {
            return `!${value.cpp}.empty()`;
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
        const leftType = this.dataTypeAt(left);
        const rightType = this.dataTypeAt(right);
        const bindOptional = (
            operand: ts.Expression,
            expected: Extract<DataType, { kind: "optional" }>,
        ): string => {
            this.context.reachJsData();
            const value =
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
            const leftCpp = bindOptional(left, leftType);
            const rightCpp = bindOptional(right, rightType);
            const equal =
                `(${leftCpp}.has_value() == ${rightCpp}.has_value() && ` +
                `(!${leftCpp}.has_value() || (*${leftCpp}) == (*${rightCpp})))`;
            return negated ? `!${equal}` : equal;
        }
        if (optionalScalar(leftType)) {
            const leftCpp = bindOptional(left, leftType);
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
            const rightCpp = bindOptional(right, rightType);
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
            const rightCpp = this.compileForSink(
                right,
                leftValue.dataType,
            );
            return `${leftValue.cpp} ${negated ? "!=" : "=="} ${rightCpp}`;
        }
        const rightValue = this.comparableOperand(right);
        if (rightValue) {
            const leftCpp = this.compileForSink(
                left,
                rightValue.dataType,
            );
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
        | { cpp: string; dataType: DataType }
        | undefined {
        const value =
            this.compileDataPath(expression, "read") ??
            this.context.compileValue(expression);
        if (value?.kind === "string") {
            return {
                cpp: value.cpp,
                dataType: { kind: "string" },
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
            this.compileDataPath(expression, "read") ??
            this.materializeStaticTable(expression) ??
            this.callSpanValue(expression) ??
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
            define(name, this.leafValue(itemCpp, element));
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
                    `${itemCpp}.${field.name}`,
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
