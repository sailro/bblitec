import ts from "typescript";
import {
    DataTypeRegistry,
    dataTypesEqual,
    doubleLiteral,
    type DataType,
} from "./data-types.js";
import type { Value } from "./types.js";

export interface DataLoweringContext {
    readonly checker: ts.TypeChecker;
    readonly dataTypes: DataTypeRegistry;
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileCondition(expression: ts.Expression): string;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    unwrap(expression: ts.Expression): ts.Expression;
    emit(line: string): void;
    allocateTemporaryCppName(label: string): string;
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
        for (const name of this.aliasRoots.keys()) {
            const state = this.ownership.get(name);
            if (state) {
                snapshot.set(name, state);
            }
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
        if (value.kind !== "data") {
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
            // A member of a compile-time record — including a getter,
            // which re-reads its state here — is a data path when the
            // member it yields is data.
            const member =
                this.context.resolveRecordMember(unwrapped);
            if (member) {
                return member.kind === "data" ||
                    member.kind === "number" ||
                    member.kind === "boolean"
                    ? member
                    : undefined;
            }
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const owner = this.compileDataPath(
                unwrapped.expression,
                mode,
            );
            if (!owner) {
                return undefined;
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
            return this.elementRead(
                owner,
                unwrapped,
                mode,
            );
        }
        return undefined;
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
            value.dataType?.kind !== "optional"
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
                kind: "data",
                cpp: `(*${value.cpp})`,
                dataType: declared,
            };
        }
        return value;
    }

    private narrowOptional(
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
                kind: "data",
                cpp: `(*${value.cpp})`,
                dataType: value.dataType.inner,
            };
        }
        return value;
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
        const dataType = owner.dataType;
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
                `${owner.cpp}.${field.name}`,
                field.type,
            );
        }
        if (
            (dataType.kind === "vector" ||
                dataType.kind === "span" ||
                dataType.kind === "f32array" ||
                dataType.kind === "u32array") &&
            property === "length"
        ) {
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `bbl::js::array_length(${owner.cpp})`,
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
        const index = this.context.compileNumber(
            access.argumentExpression,
            "double",
        );
        this.context.reachJsData();
        const indexed = `${owner.cpp}[bbl::js::array_index(${index})]`;
        if (
            dataType.kind === "f32array" ||
            dataType.kind === "u32array"
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

    private leafValue(
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
        return { kind: "data", cpp, dataType };
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
                        ? entry.staticNumber !== undefined
                            ? // Re-formatted as a double: the
                              // element's own text is a float
                              // literal, and widening one back does
                              // not always give the same value.
                              doubleLiteral(
                                  entry.staticNumber,
                              )
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
        const unary = new Map<string, string>([
            ["abs", "std::abs"],
            ["atan", "std::atan"],
            ["ceil", "std::ceil"],
            ["cos", "std::cos"],
            ["exp", "std::exp"],
            ["floor", "std::floor"],
            ["sin", "std::sin"],
            ["sqrt", "std::sqrt"],
            ["tan", "std::tan"],
            ["trunc", "std::trunc"],
        ]).get(method);
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
            return {
                kind: "number",
                cpp: `std::${method}(${left}, ${right})`,
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
     * Compiles `array.indexOf(value)`.
     *
     * Only element types JavaScript compares the way native code does
     * are reached: numbers, booleans, and tags compare by value in both,
     * and a handle is an id, which is what makes two references the same
     * object. A struct or a nested container would compare by identity
     * in JavaScript and field by field here, so those are rejected
     * rather than answered differently.
     */
    private compileIndexOf(
        call: ts.CallExpression,
        owner: Value,
        element: DataType,
    ): Value {
        if (call.arguments.length !== 1) {
            this.context.fail(
                call,
                "Array.indexOf expects one argument; the fromIndex form is outside the supported subset.",
            );
        }
        if (
            element.kind !== "number" &&
            element.kind !== "boolean" &&
            element.kind !== "enum" &&
            element.kind !== "handle"
        ) {
            this.context.fail(
                call,
                `Array.indexOf is supported for numbers, booleans, tags, and handles, not ${element.kind}: JavaScript would compare by identity here.`,
            );
        }
        this.context.reachJsData();
        const value = this.compileForSink(
            call.arguments[0]!,
            element,
        );
        return {
            kind: "number",
            cpp: `bbl::js::array_index_of(${owner.cpp}, ${value})`,
            dataType: { kind: "number" },
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
        }
        const owner =
            this.compileDataPath(
                callee.expression,
                method === "pop" ||
                    method === "push" ||
                    method === "fill" ||
                    method === "splice"
                    ? "write"
                    : "read",
            ) ??
            // A constant array is a compile-time tuple with nothing to
            // search, so searching one materializes it exactly as a
            // runtime index into it does.
            (method === "indexOf"
                ? this.materializeConstantArray(
                      callee.expression,
                  )
                : undefined);
        if (!owner || owner.kind !== "data") {
            return undefined;
        }
        const narrowed = this.narrowOptional(
            owner,
            callee.expression,
        );
        const dataType = narrowed.dataType;
        if (method === "indexOf") {
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
                return this.compileIndexOf(
                    call,
                    narrowed,
                    element,
                );
            }
        }
        if (dataType?.kind !== "vector") {
            return undefined;
        }
        this.context.reachJsData();
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
     * `new Float32Array`, and `new Uint32Array` (sized, from a numeric
     * array literal, or from a number[] value).
     */
    public compileNewExpression(
        expression: ts.NewExpression,
    ): Value | undefined {
        return (
            this.compileNewArray(expression) ??
            this.compileTypedArrayNew(expression)
        );
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
            name !== "Uint32Array"
        ) {
            return undefined;
        }
        const prefix =
            name === "Float32Array" ? "f32" : "u32";
        const dataType: DataType =
            name === "Float32Array"
                ? { kind: "f32array" }
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
        if (
            source?.kind === "data" &&
            source.dataType?.kind === "vector" &&
            source.dataType.element.kind === "number"
        ) {
            return {
                kind: "data",
                cpp: `bbl::js::${prefix}_array_from(${source.cpp})`,
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
            return (
                `(${this.context.compileCondition(unwrapped.condition)}` +
                ` ? ${this.compileForSink(unwrapped.whenTrue, dataType)}` +
                ` : ${this.compileForSink(unwrapped.whenFalse, dataType)})`
            );
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
            case "enum": {
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
                const value = this.compileDataPath(
                    unwrapped,
                    "read",
                );
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
                    ts.SyntaxKind.NullKeyword
                ) {
                    return "std::nullopt";
                }
                return this.compileForSink(
                    unwrapped,
                    dataType.inner,
                );
            }
            case "struct": {
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
                const value =
                    this.context.compileValue(unwrapped);
                if (value.kind !== dataType.handle) {
                    this.context.fail(
                        unwrapped,
                        `Expected a ${dataType.handle} value, received ${value.kind}.`,
                    );
                }
                return value.cpp;
            }
            case "f32array":
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
            `Expression does not produce the expected data ${dataType.kind} value.`,
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
        if (kind !== "enum" && kind !== "handle") {
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
            if (target.dataStore) {
                if (operator !== "=") {
                    this.context.fail(
                        expression,
                        "Typed-array elements support plain assignment only.",
                    );
                }
                this.context.emit(
                    target.dataStore === "u32"
                        ? `${target.cpp} = bbl::js::to_uint32(${right});`
                        : `${target.cpp} = static_cast<float>(${right});`,
                );
                return true;
            }
            this.context.emit(
                `${target.cpp} ${operator} ${right};`,
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
            )
        ) {
            return false;
        }
        const target = this.compileDataPath(
            expression.operand,
            "write",
        );
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

    /**
     * Produces a boolean C++ expression for a data condition operand, or
     * undefined when the expression is not data-typed.
     */
    public conditionOperand(
        expression: ts.Expression,
    ): string | undefined {
        const value = this.compileDataPath(
            expression,
            "read",
        );
        if (!value) {
            return undefined;
        }
        if (value.kind === "boolean") {
            return value.cpp;
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
        const nullSide =
            left.kind === ts.SyntaxKind.NullKeyword
                ? right
                : right.kind === ts.SyntaxKind.NullKeyword
                  ? left
                  : undefined;
        if (nullSide) {
            const value = this.compileDataPath(
                nullSide,
                "read",
            );
            if (
                value?.kind === "data" &&
                value.dataType?.kind === "optional"
            ) {
                return negated
                    ? `${value.cpp}.has_value()`
                    : `!${value.cpp}.has_value()`;
            }
            return undefined;
        }
        const leftValue = this.enumOperand(left);
        if (leftValue) {
            const rightCpp = this.compileForSink(
                right,
                leftValue.dataType,
            );
            return `(${leftValue.cpp} ${negated ? "!=" : "=="} ${rightCpp})`;
        }
        const rightValue = this.enumOperand(right);
        if (rightValue) {
            const leftCpp = this.compileForSink(
                left,
                rightValue.dataType,
            );
            return `(${leftCpp} ${negated ? "!=" : "=="} ${rightValue.cpp})`;
        }
        return undefined;
    }

    private enumOperand(
        expression: ts.Expression,
    ):
        | { cpp: string; dataType: DataType & { kind: "enum" } }
        | undefined {
        const value = this.compileDataPath(
            expression,
            "read",
        );
        if (
            value?.kind === "data" &&
            value.dataType?.kind === "enum"
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
        | { container: Value; element: DataType }
        | undefined {
        const value =
            this.compileDataPath(expression, "read") ??
            this.materializeStaticTable(expression) ??
            this.callSpanValue(expression);
        if (value?.kind !== "data" || !value.dataType) {
            return undefined;
        }
        const dataType = value.dataType;
        if (
            dataType.kind === "vector" ||
            dataType.kind === "span"
        ) {
            return {
                container: value,
                element: dataType.element,
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
        element: DataType,
        define: (
            identifier: ts.Identifier,
            value: Value,
        ) => void,
    ): void {
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
