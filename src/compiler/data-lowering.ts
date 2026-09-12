import { booleanValue, nativeDataMetadata, staticStringValue, valueForKind, withNativeMetadata } from "./types.js";
import { compileDataExpressionSink, compileDataValueSink } from "./data-sinks/operations.js";
import { someAnalysisNode, forEachAnalysisNode } from "./analysis-walk.js";
import { EmissionSet, EmissionMap, EmissionWeakMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { storageValue } from "./web-storage.js";
import { documentEngine, windowErrorEventValue } from "./window-events.js";
import { CompilerSymbols } from "./symbols.js";
import { compileMapInitializer } from "./collection-methods.js";
import { compileDateNew } from "./dates.js";
import { httpResponseProperty } from "./http.js";
import { cppIdentifierPattern } from "../cpp-literals.js";
import { sceneRelativeSourceLabel } from "../source-location.js";
import { staticNumberValue } from "./option-helpers.js";
import { numberConstantValue } from "./number-intrinsics.js";
import {
    describeMathArity,
    MATH_MEMBERS,
    mathMemberAccess,
    mathUnaryFold,
} from "./math-intrinsics.js";
import {
    dataTypesEqual,
    doubleLiteral,
    isTypedArrayType,
    isOpaqueReference,
    passesByReference,
    pinnedHandleKind,
    TYPED_ARRAY_KINDS,
    typedArrayStem,
    typedArrayStoreExpression,
    type DataIterationElement,
    type DataType,
    type TypedArrayKind,
} from "./data-types.js";
import { commonResourceValue, runtimeMeshValue, type Value } from "./types.js";
import {
    compileJsonStrictComparison,
    isJsonValue,
    isJsonRootedExpression,
} from "./json-bridge.js";
import {
    compileDataMethodCall,
    arrayCallbackReceiverPolicy,
    resizingArrayMethods,
} from "./data-methods.js";
import { isTrsVectorName } from "./assignments.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    iteratorMethodCall,
    rootExpression,
    rootIdentifier,
    argumentAt,
    identifierText,
    unwrapExpression,
} from "./syntax.js";


/** Container length mutations, isolated by checker and source file. */
const resizedSymbolsByChecker = new EmissionWeakMap<
    ts.TypeChecker,
    WeakMap<ts.SourceFile, ReadonlySet<ts.Symbol>>
>();

/**
 * Resizing methods, rebinding, length writes and call arguments invalidate a
 * binding's fixed length. Element writes preserve length. Symbols keep
 * unrelated same-named bindings independent.
 */
function resizedSymbols(checker: ts.TypeChecker, file: ts.SourceFile): ReadonlySet<ts.Symbol> {
    let byFile = resizedSymbolsByChecker.get(checker);
    const cached = byFile?.get(file);
    if (cached) return cached;
    const symbols = new CompilerSymbols(checker);
    const resized = new EmissionSet<ts.Symbol>();
    const addIdentifier = (node: ts.Node): void => {
        if (!ts.isIdentifier(node)) return;
        const symbol = symbols.valueSymbol(node);
        if (symbol) resized.add(symbol);
    };
    forEachAnalysisNode(file, node => {
        if (ts.isCallExpression(node)) {
            if (
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                (resizingArrayMethods.has(node.expression.name.text) ||
                    arrayCallbackReceiverPolicy(node.expression.name.text).invalidatesFacts)
            ) {
                addIdentifier(node.expression.expression);
            }
            for (const argument of node.arguments) {
                forEachAnalysisNode(argument, addIdentifier);
            }
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const left = node.left;
            if (ts.isIdentifier(left)) {
                addIdentifier(left);
            } else if (
                ts.isPropertyAccessExpression(left) &&
                ts.isIdentifier(left.expression) &&
                left.name.text === "length"
            ) {
                addIdentifier(left.expression);
            }
        }
    });
    byFile ??= new EmissionWeakMap();
    byFile.set(file, resized);
    resizedSymbolsByChecker.set(checker, byFile);
    return resized;
}

/** Whether nothing in the entry source can change `name`'s length. */
export function isNeverResized(checker: ts.TypeChecker, name: ts.Identifier): boolean {
    const symbol = checker.getSymbolAtLocation(name);
    return symbol !== undefined && !resizedSymbols(checker, name.getSourceFile()).has(symbol);
}

export interface DataLoweringContext
    extends Pick<LoweringServices,
        | "options"
        | "expectArgumentCount"
        | "sourceFile"
        | "noteCameraVectorCopy"
        | "isDefaultLibraryIdentifier"
        | "useNativeValue"
        | "registerNativeBinding"
        | "checker"
        | "lookup"
        | "lookupOptional"
        | "dataTypes"
        | "classLowerer"
        | "compileValue"
        | "pinValueToTemporary"
        | "emitDiscardedValue"
        | "compileNumber"
        | "castNumber"
        | "compileCondition"
        | "cppString"
        | "propertyName"
        | "recordDataAssignmentMetadata"
        | "recordDataLightSlot"
        | "declaredDataProperty"
        | "readResolvedProperty"
        | "resolveStaticExpression"
        | "unwrap"
        | "emit"
        | "probeEmission"
        | "captureEmittedLines"
        | "allocateTemporaryCppName"
        | "increaseIndent"
        | "decreaseIndent"
        | "pushScope"
        | "popScope"
        | "allocateBlockPrefix"
        | "compileCallbackWithValues"
        | "withRecordScopes"
        | "compilePredicateWithValues"
        | "compileStoredDataFunction"
        | "compileSpriteAtlasRecord"
        | "lookupIdentifierValue"
        | "resolveThisField"
        | "resolveRecordMember"
        | "resolveRecordValue"
        | "enterRuntimeControlFlow"
        | "leaveRuntimeControlFlow"
        | "isInRuntimeControlFlow"
        | "enterRuntimeIteration"
        | "leaveRuntimeIteration"
        | "invalidateStaticElements"
        | "recordArrayPush"
        | "knownCollectionCardinality"
        | "recordCollectionKey"
        | "recordCollectionClear"
        | "invalidateRecordProperties"
        | "reachJsData"
        | "reachFeature"
        | "reachJsRandom"
        | "defaultEngine"
        | "refuseBorrowedPlatformEventEscape"
        | "fail"
    >,
    Partial<Pick<LoweringServices,
        | "staticCanvasSize"
    >> {}

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
    private readonly evaluatedLiteralKeys = new EmissionWeakMap<ts.ObjectLiteralExpression, string[]>();
    private readonly ownership = new EmissionMap<
        string,
        LocalOwnership
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
        const assignable = target.dataType.kind === "optional" && (isTypedArrayType(target.dataType.inner) ||
            [
                "number",
                "vector",
                "map",
                "set",
            ].includes(target.dataType.inner.kind));
        if (!assignable) return undefined;
        const value = this.compileForSink(
            expression.right,
            target.dataType,
        );
        return this.narrowOptional(this.leafValue(
            `(${target.cpp} = ${value})`,
            target.dataType,
        ), expression, this.context.checker.getNonNullableType(
            this.context.checker.getTypeAtLocation(expression.right),
        ) === this.context.checker.getTypeAtLocation(expression.right));
    }

    /** Invoke an already evaluated callback with the values supplied by an API. */
    public compileFunctionValueCall(callback: Value, values: readonly Value[], node: ts.Node): Value {
        const type = callback.dataType;
        if (type?.kind !== "function") this.context.fail(node, "Callback requires a native function signature.");
        this.context.useNativeValue(callback);
        const erased = new Set(type.erasedParameters ?? []);
        const argumentsCpp: string[] = [];
        let runtimeIndex = 0;
        for (let sourceIndex = 0; runtimeIndex < type.parameters.length; sourceIndex++) {
            if (erased.has(sourceIndex)) continue;
            const parameter = type.parameters[runtimeIndex++]!;
            const value = values[sourceIndex];
            if (!value && parameter.kind !== "optional") this.context.fail(node, "Callback requires more arguments than the operation supplies.");
            argumentsCpp.push(value ? this.compileKnownValueForSink(value, parameter, node) : "std::nullopt");
        }
        const cpp = `${callback.cpp}(${argumentsCpp.join(", ")})`;
        return type.result ? { ...this.leafValue(cpp, type.result), impure: true } : {kind: "void", cpp};
    }

    /** Arguments for a stored std::function, including omitted TS optionals. */
    public compileFunctionArguments(
        call: ts.CallExpression,
        functionType: DataType & { kind: "function" },
        label = "Stored function",
    ): string[] {
        const erased = new EmissionSet(functionType.erasedParameters ?? []);
        const sourceParameterCount =
            functionType.parameters.length + erased.size;
        if (call.arguments.length > sourceParameterCount) {
            this.context.fail(
                call,
                `${label} expects at most ${sourceParameterCount} arguments.`,
            );
        }
        const argumentsCpp: string[] = [];
        let runtimeIndex = 0;
        for (let sourceIndex = 0; sourceIndex < sourceParameterCount; sourceIndex += 1) {
            const argument = call.arguments[sourceIndex];
            if (erased.has(sourceIndex)) {
                if (argument) {
                    const argumentType =
                        this.context.checker.getTypeAtLocation(argument);
                    const unwrapped = this.context.unwrap(argument);
                    if (
                        !(
                            ts.isIdentifier(unwrapped) &&
                            ((argumentType.flags &
                                (ts.TypeFlags.Never | ts.TypeFlags.Void)) !==
                                0 ||
                                (unwrapped.text === "undefined" &&
                                    !this.context.lookupIdentifierValue(
                                        unwrapped,
                                    )))
                        )
                    ) {
                        this.context.fail(
                            argument,
                            `${label} void/never payload must be an erased undefined or never value.`,
                        );
                    }
                }
                continue;
            }
            const parameter = functionType.parameters[runtimeIndex++]!;
            if (argument) {
                argumentsCpp.push(this.compileForSink(argument, parameter));
                continue;
            }
            if (parameter.kind !== "optional") {
                this.context.fail(
                    call,
                    `${label} expects ${sourceParameterCount} arguments.`,
                );
            }
            this.context.reachJsData();
            argumentsCpp.push("std::nullopt");
        }
        return argumentsCpp;
    }

    /** Container root each live alias refers into, for invalidation. */
    private readonly aliasRoots = new EmissionMap<string, string>();

    /** Container locals whose length generation knows; see below. */
    private readonly fixedLengths = new EmissionMap<string, number>();

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
        const snapshot = new EmissionMap<string, string>();
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

    public markEscaped(value: Value): void {
        if (
            value.kind !== "data" ||
            this.sharesObjectStorage(value.dataType)
        ) {
            return;
        }
        const root = this.rootName(value.cpp);
        if (this.ownership.get(root) === "owned") {
            this.ownership.set(root, "escaped");
        }
    }

    private sharesObjectStorage(type: DataType | undefined): boolean {
        if (!type) return false;
        if (type.kind === "optional") return this.sharesObjectStorage(type.inner);
        return ["vector", "map", "set", "tuple", "product"].includes(type.kind) ||
            isTypedArrayType(type) ||
            (type.kind === "struct" && this.context.dataTypes.isReferenceStruct(type.name));
    }

    /**
     * Stores one value into a container that can outlive the current dispatch.
     * Only event-bearing destination shapes pay the provenance/escape check, so
     * ordinary generated output remains byte-for-byte unchanged.
     */
    public compileForRetainedSink(
        expression: ts.Expression,
        dataType: DataType,
        destination: string,
    ): string {
        if (!this.context.dataTypes.carriesBorrowedPlatformEvent(dataType)) {
            return this.compileForSink(expression, dataType);
        }
        const value = this.context.compileValue(expression);
        this.context.refuseBorrowedPlatformEventEscape(
            value,
            expression,
            destination,
        );
        return this.compileKnownValueForSink(value, dataType, expression);
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
        const node = rootIdentifier(expression, (chain) =>
            this.context.unwrap(chain),
        );
        if (!node) return true;
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

    private usesNativeDataPath(expression: ts.Expression): boolean {
        let root = this.context.unwrap(expression);
        let thisField: ts.PropertyAccessExpression | undefined;
        while (
            ts.isPropertyAccessExpression(root) ||
            ts.isElementAccessExpression(root)
        ) {
            if (
                ts.isPropertyAccessExpression(root) &&
                this.context.unwrap(root.expression).kind ===
                    ts.SyntaxKind.ThisKeyword
            ) {
                thisField = root;
            }
            root = this.context.unwrap(root.expression);
        }
        const value = ts.isIdentifier(root)
            ? this.context.lookupIdentifierValue(root)
            : root.kind === ts.SyntaxKind.ThisKeyword && thisField
              ? this.context.resolveThisField(thisField.name.text)
              : undefined;
        return value?.kind === "data";
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
                const shared = this.sharesObjectStorage(bound.dataType);
                if (state === "copy" && !shared) {
                    this.context.fail(
                        unwrapped,
                        `'${unwrapped.text}' is a value copy of a data path; writes through aliases are outside the supported subset.`,
                    );
                }
                if (state === "escaped" && !shared) {
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
            // member it yields is data. Writes must keep following the
            // native path: a record member's static snapshot is a read fact,
            // not an assignable expression.
            if (!unwrapped.questionDotToken && !this.usesNativeDataPath(unwrapped)) {
                let resolvedMember = false;
                const member = this.context.probeEmission(() => {
                    const value = this.context.resolveRecordMember(unwrapped);
                    resolvedMember = value !== undefined;
                    return value?.kind === "data" || value?.kind === "number" || value?.kind === "boolean"
                        ? value : undefined;
                });
                if (resolvedMember) return member;
            }
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            // Optional chaining is the one data path whose owner may be a
            // value-producing call (`map.get(key)?.field`) rather than a
            // path itself. An unchecked object-array element also carries a
            // separate existence predicate, so ask for its guarded form
            // before the ordinary direct-index path loses that information.
            const receiver = this.context.unwrap(unwrapped.expression);
            const guardedOwner =
                unwrapped.questionDotToken &&
                ts.isElementAccessExpression(receiver)
                    ? this.compileGuardableElementAccess(receiver)
                    : undefined;
            let owner =
                guardedOwner ??
                this.compileDataPath(
                    unwrapped.expression,
                    mode,
                ) ??
                ((ts.isCallExpression(receiver) || ts.isElementAccessExpression(receiver) ||
                    (mode === "read" && (ts.isBinaryExpression(receiver) ||
                        ts.isConditionalExpression(receiver))))
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
            // A resource read can use both the value and its presence or
            // owning-engine expression. Preserve one evaluation of computed
            // receivers such as rows[index++].pickedMesh?.name.
            if (mode === "read" && owner.dataType?.kind === "handle" &&
                !cppIdentifierPattern.test(owner.cpp)) {
                const temporary = this.context.allocateTemporaryCppName("property_owner");
                this.context.emit({ kind: "declaration", type: "const auto", name: temporary, initializer: owner.cpp, attributes: "[[maybe_unused]] " });
                owner = withNativeMetadata(this.leafValue(temporary, owner.dataType), owner);
            }
            // A call can yield an intrinsic record or engine handle rather
            // than native data. Its owner has already been evaluated, so
            // continue through the shared property reader before declining
            // the path and causing the caller to evaluate it again.
            return this.compilePropertyFromValue(owner, unwrapped) ??
                (mode === "read"
                    ? this.context.readResolvedProperty(owner, unwrapped)
                    : undefined);
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
            if (mode === "write" && owner.dataType?.kind === "tuple") {
                this.invalidateStaticElements(owner);
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
        if (ts.isPropertyAccessChain(access)) {
            const optional = this.optionalPropertyRead(owner, access);
            if (optional) return optional;
        }
        return this.propertyRead(owner, access);
    }

    /** Index a data value produced by a call rather than by a named path. */
    public compileElementFromValue(
        owner: Value,
        index: ts.Expression,
    ): Value | undefined {
        if (owner.kind === "string") owner = { ...owner, dataType: { kind: "string" } };
        if ((owner.kind !== "data" && owner.kind !== "string") || !owner.dataType) {
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
    public optionalAccess(
        owner: Value,
        access: ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression,
        read: (presentOwner: Value) => Value | undefined,
    ): Value | undefined {
        const { optionalFoundCpp, optionalStorageCpp, ...plainOwner } =
            owner;
        let present: string;
        let presentOwner: Value;
        let snapshotPresentOwner = false;
        if (owner.dataType?.kind === "optional") {
            const temporary =
                this.context.allocateTemporaryCppName(
                    "optional_chain",
                );
            // Reads borrow container storage. Calls snapshot the receiver:
            // evaluating an argument can clear the original nullable slot.
            this.context.emit(
                { kind: "declaration", type: ts.isCallExpression(access) ? "const auto" : "const auto&", name: temporary, initializer: owner.cpp, attributes: "[[maybe_unused]] " },
            );
            present = `${temporary}.has_value()`;
            presentOwner = withNativeMetadata(this.leafValue(`(*${temporary})`, owner.dataType.inner), plainOwner);
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
                    { kind: "declaration", type: "const auto&", name: temporary, initializer: owner.cpp, attributes: "[[maybe_unused]] " },
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
                snapshotPresentOwner = ts.isCallExpression(access);
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

        let selected: Value | undefined;
        const selectedLines = this.context.captureEmittedLines(() => {
            if (snapshotPresentOwner) {
                const temporary = this.context.allocateTemporaryCppName("optional_receiver");
                this.context.emit({kind:"declaration", type:"const auto", name:temporary, initializer:presentOwner.cpp});
                presentOwner = {...presentOwner, cpp:temporary};
            }
            this.context.enterRuntimeControlFlow();
            try { selected = read(presentOwner); }
            finally { this.context.leaveRuntimeControlFlow(); }
        });
        if (!selected) {
            // The owner can also be an optional engine handle. Its declared
            // property surface, rather than the plain-data model, owns that
            // read and will retain the same presence predicate.
            return undefined;
        }
        if (selected.kind === "void") {
            return {kind:"void", cpp:`([&]() {\nif (${present}) {\n${selectedLines.join("\n")}\n${selected.cpp ? `${selected.cpp};` : ""}\n}\n}())`};
        }
        const checkerType = this.dataTypeAt(access);
        const checkedSelectedType =
            checkerType?.kind === "optional"
                ? checkerType.inner
                : checkerType;
        const selectedType =
            selected.dataType ??
            (checkedSelectedType?.kind === "handle" && selected.kind === checkedSelectedType.handle
                ? checkedSelectedType : undefined) ??
            (selected.kind === "number" &&
            checkedSelectedType?.kind === "number"
                ? checkedSelectedType
                : selected.kind === "boolean" &&
                    checkedSelectedType?.kind === "boolean"
                  ? checkedSelectedType
                  : selected.kind === "string" &&
                      (checkedSelectedType?.kind === "string" ||
                          checkedSelectedType?.kind === "enum")
                    ? checkedSelectedType
                    : selected.kind === "number"
                      ? ({ kind: "number" } as const)
                      : selected.kind === "boolean"
                        ? ({ kind: "boolean" } as const)
                        : selected.kind === "string"
                          ? ({ kind: "string" } as const)
                          : undefined);
        if (!selectedType) {
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
        const impure = selected.impure;
        const optionalResult = (type: DataType, selectedCpp: string, empty: string): Value => {
            const cppType = this.context.dataTypes.cppType(type);
            if (selectedLines.length === 0 && !impure) {
                return this.leafValue(`(${combinedPresent} ? ${selectedCpp} : ${empty})`, type);
            }
            // Getter lowering may emit an inlined method body. Both those
            // statements and the result expression belong to the present
            // branch, and the condition must not evaluate them twice.
            const result = this.context.allocateTemporaryCppName("optional_result");
            const resultCpp = selectedPresent
                ? `(${selectedPresent} ? ${selectedCpp} : ${empty})`
                : selectedCpp;
            this.context.emit(`const ${cppType} ${result} = ([&]() -> ${cppType} {\n` +
                `    if (!(${present})) return ${empty};\n` +
                selectedLines.map(line => `    ${line}\n`).join("") +
                `    return ${resultCpp};\n}());`);
            return this.leafValue(result, type);
        };
        if (
            selectedType.kind === "struct" &&
            this.context.dataTypes.isReferenceStruct(
                selectedType.name,
            )
        ) {
            const cppType = this.context.dataTypes.cppType(
                selectedType,
            );
            return optionalResult(
                selectedType,
                selected.cpp,
                `${cppType}{}`,
            );
        }
        const resultType: DataType =
            selectedType.kind === "optional"
                ? selectedType
                : checkerType?.kind === "optional"
                  ? checkerType
                  : {
                        kind: "optional",
                        inner: selectedType,
                    };
        const selectedCpp =
            selectedType.kind === "optional"
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
        return optionalResult(resultType, `${cppType}{${selectedCpp}}`, `${cppType}{std::nullopt}`);
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
        knownValue?: Value,
    ): Value | undefined {
        const known = knownValue ?? this.context.compileValue(expression);
        if (known.kind !== "tuple") {
            return undefined;
        }
        const container = this.dataTypeAt(expression);
        const sourceType = this.context.checker.getTypeAtLocation(expression);
        const tupleElement = this.context.checker.isTupleType(sourceType)
            ? this.context.checker.getIndexTypeOfType(sourceType, ts.IndexKind.Number)
            : undefined;
        const declaredElement =
            container?.kind === "vector" ||
            container?.kind === "span"
                ? container.element
                : tupleElement
                  ? this.context.dataTypes.fromTsType(tupleElement, expression)
                  : undefined;
        const inferred = (known.tupleElements ?? []).map(
            (entry): DataType | undefined => {
                if (entry.dataType) return entry.dataType;
                switch (entry.kind) {
                    case "number":
                        return { kind: "number" };
                    case "boolean":
                        return { kind: "boolean" };
                    case "string":
                        return { kind: "string" };
                    default:
                        return undefined;
                }
            },
        );
        const first = inferred[0];
        const inferredElement =
            first &&
            inferred.every(
                (candidate) =>
                    candidate !== undefined &&
                    dataTypesEqual(candidate, first),
            )
                ? first
                : undefined;
        const element = declaredElement ?? inferredElement;
        if (!element) {
            return undefined;
        }
        if (knownValue && !(known.tupleElements ?? []).every(
            (entry) => this.knownValueFitsSink(entry, element, expression, false),
        )) {
            return undefined;
        }
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
        if (local || !(known.tupleElements ?? []).every(entry => this.knownValueFitsSink(entry, element, expression, true))) {
            const values = (known.tupleElements ?? []).map(entry =>
                this.compileKnownValueForSink(entry, element, expression));
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
                (known.tupleElements ?? []).map(entry => this.compileKnownValueForSink(
                    this.constantInitializerValue(entry), element, expression)),
            );
        this.context.reachJsData();
        return {
            kind: "data",
            cpp: `bblscene::${name}`,
            dataType: { kind: "span", element },
        };
    }

    public knownValueFitsSink(
        value: Value,
        sink: DataType,
        node: ts.Node,
        staticOnly = false,
    ): boolean {
        if (staticOnly && value.impure) return false;
        if (!staticOnly && value.dataType && this.spanCompatible(value.dataType, sink)) return true;
        if (!staticOnly && sink.kind === "bufferview" && value.dataType &&
            (value.dataType.kind === "dataview" || isTypedArrayType(value.dataType))) return true;
        switch (sink.kind) {
            case "handle":
                return !staticOnly && value.kind === sink.handle;
            case "json":
                return value.kind === "json-null" || (!staticOnly && isJsonValue(value));
            case "union":
                return sink.members.some(member => this.knownValueFitsSink(value, member, node, staticOnly));
            case "number":
                return staticOnly ? value.staticNumber !== undefined : value.kind === "number";
            case "boolean":
                return staticOnly ? value.staticBoolean !== undefined : value.kind === "boolean";
            case "string":
                return staticOnly ? value.staticString !== undefined : value.kind === "string";
            case "enum":
                return value.staticString !== undefined;
            case "optional":
                return value.kind === "json-null" || this.knownValueFitsSink(value, sink.inner, node, staticOnly);
            case "tuple":
                return value.kind === "tuple" && value.tupleElements?.length === sink.arity &&
                    value.tupleElements.every((entry) =>
                        this.knownValueFitsSink(entry, { kind: "number" }, node, staticOnly));
            case "product":
                return value.kind === "tuple" && value.tupleElements?.length === sink.elements.length &&
                    value.tupleElements.every((entry, index) =>
                        this.knownValueFitsSink(entry, sink.elements[index]!, node, staticOnly));
            case "vector":
            case "span":
                return value.kind === "tuple" && (value.tupleElements ?? []).every((entry) =>
                    this.knownValueFitsSink(entry, sink.element, node, staticOnly));
            case "struct":
                if (value.kind === "json-null" && this.context.dataTypes.isReferenceStruct(sink.name)) return true;
                return value.kind === "record" && this.context.dataTypes.structFields(sink.name, node).every((field) => {
                    const property = value.recordProperties?.[field.sourceName];
                    return property
                        ? this.knownValueFitsSink(property, field.type, node, staticOnly)
                        : field.defaultWhenMissing === true || field.type.kind === "optional";
                });
            default:
                return false;
        }
    }

    /** After the static sink proof, discard local spellings from namespace initializers. */
    private constantInitializerValue(value: Value): Value {
        if (value.staticNumber !== undefined) return numberConstantValue(value.staticNumber);
        if (value.staticBoolean !== undefined) return booleanValue(value.staticBoolean ? "true" : "false");
        if (value.staticString !== undefined) return staticStringValue(value.staticString, text => this.context.cppString(text));
        if (value.kind === "tuple") return {
            kind: "tuple", cpp: "",
            tupleElements: (value.tupleElements ?? []).map(entry => this.constantInitializerValue(entry)),
        };
        if (value.kind === "record") return {
            kind: "record", cpp: "",
            recordProperties: Object.fromEntries(Object.entries(value.recordProperties ?? {}).map(
                ([key, entry]) => [key, this.constantInitializerValue(entry)])),
        };
        return value;
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
            !TYPED_ARRAY_KINDS.has(source.expression.text) ||
            this.context.lookupIdentifierValue(
                source.expression,
            ) ||
            source.arguments?.length !== 1
        ) {
            return undefined;
        }
        const argument = this.context.resolveStaticExpression(
            argumentAt(source, 0),
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
            return withNativeMetadata(this.leafValue(
                    `(*${value.cpp})`,
                    declared,
                ), value);
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
        assertedNonNull = false,
    ): Value {
        if (value.dataType?.kind === "json") {
            const narrowed = this.dataTypeAt(expression);
            if (narrowed && ["string", "number", "boolean", "enum"].includes(narrowed.kind)) {
                const cpp = compileDataValueSink(narrowed, this, value, expression);
                if (cpp !== undefined) return this.leafValue(cpp, narrowed);
            }
        }
        if (value.kind === "data" && value.dataType?.kind === "union") {
            const narrowed = this.dataTypeAt(expression);
            const index = this.narrowedUnionMemberIndex(value.dataType, narrowed);
            return index < 0 ? value : withNativeMetadata(this.leafValue(
                `std::get<${index}>(${value.cpp})`, value.dataType.members[index]!,
            ), value);
        }
        if (
            value.kind !== "data" ||
            value.dataType?.kind !== "optional"
        ) {
            return value;
        }
        const narrowed = this.dataTypeAt(expression);
        const inner = value.dataType.inner;
        if (
            assertedNonNull ||
            ((!value.preserveUncheckedLookup || inner.kind !== "number") && narrowed &&
                narrowed.kind !== "optional" &&
                (dataTypesEqual(narrowed, inner) ||
                    this.spanCompatible(inner, narrowed) ||
                    (["string", "enum"].includes(inner.kind) && ["string", "enum"].includes(narrowed.kind)) ||
                    (inner.kind === "union" && this.narrowedUnionMemberIndex(inner, narrowed) >= 0)))
        ) {
            return this.narrowOptional(withNativeMetadata(this.leafValue(
                    `(*${value.cpp})`,
                    inner,
                ), value), expression);
        }
        return value;
    }

    private narrowedUnionMemberIndex(type: DataType<"union">, narrowed: DataType | undefined): number {
        return type.members.findIndex(member => narrowed &&
            (dataTypesEqual(member, narrowed) || this.spanCompatible(member, narrowed) ||
                (member.kind === "string" && narrowed.kind === "enum")));
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
            // A scalar element a bounds check found (`xs[0] ?? fallback`
            // through a span) selects its value or the fallback.
            if (
                left.kind === "data" &&
                left.dataType !== undefined &&
                (left.dataType.kind === "number" ||
                    left.dataType.kind === "string" ||
                    left.dataType.kind === "boolean" ||
                    left.dataType.kind === "enum") &&
                fallback.kind !== "json-null"
            ) {
                const fallbackCpp = this.compileKnownValueForSink(fallback, left.dataType, expression.right);
                return this.leafValue(
                    `(${left.optionalFoundCpp} ? ${left.cpp} : ${fallbackCpp})`,
                    left.dataType,
                );
            }
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
            return valueForKind(left.kind, {
                cpp:
                    `(${left.optionalFoundCpp} ? ${left.cpp} : ` +
                    `${fallback.cpp})`,
                ...(left.dataType !== undefined
                    ? { dataType: left.dataType }
                    : {}),
                ...(left.engineCpp !== undefined && left.engineCpp === fallback.engineCpp
                    ? {
                        engineCpp: left.engineCpp,
                        ...(left.pickingEngineKnown && fallback.pickingEngineKnown
                            ? { pickingEngineKnown: true as const } : {}),
                    }
                    : {}),
                ...(composedFound !== undefined
                    ? { optionalFoundCpp: composedFound }
                    : {}),
            });
        }
        if (
            left.kind === "data" &&
            left.dataType?.kind === "optional"
        ) {
            const inner = left.dataType.inner;
            if (
                left.staticNumber !== undefined ||
                left.staticBoolean !== undefined ||
                left.staticString !== undefined
            ) {
                return {
                    ...this.leafValue(`(*${left.cpp})`, inner),
                    ...(left.staticNumber !== undefined
                        ? { staticNumber: left.staticNumber }
                        : {}),
                    ...(left.staticBoolean !== undefined
                        ? { staticBoolean: left.staticBoolean }
                        : {}),
                    ...(left.staticString !== undefined
                        ? { staticString: left.staticString }
                        : {}),
                };
            }
            const temp =
                this.context.allocateTemporaryCppName("nullish");
            this.context.emit({ kind: "declaration", type: "const auto", name: temp, initializer: left.cpp });
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
                    this.context.dataTypes.markStoredObjectReferences(rightType),
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

    /** String literal unions use enum storage, but expose ordinary string members. */
    public stringReceiver(value: Value, node: ts.Node): Value {
        return value.dataType?.kind === "enum"
            ? { ...this.leafValue(this.context.dataTypes.enumToStringCpp(value.dataType, value.cpp, node), { kind: "string" }),
                ...(value.staticString !== undefined ? { staticString: value.staticString } : {}) }
            : value;
    }

    private propertyRead(
        ownerValue: Value,
        access: ts.PropertyAccessExpression,
    ): Value | undefined {
        const property = access.name.text;
        const owner = this.stringReceiver(this.narrowOptional(
            ownerValue,
            access.expression,
        ), access);
        const http = httpResponseProperty(this, owner, property);
        if (http) return http;
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
        if (dataType.kind === "borrowed-platform-event") {
            // The DataType gets the event through record fields and callback
            // parameters. Its properties still belong to the existing
            // platform-event Value lowering, which knows the supported DOM
            // names and preventDefault semantics.
            return undefined;
        }
        if (dataType.kind === "json") {
            // A parsed document answers every property, because that is
            // what a document does: a key it does not carry reads as
            // `undefined` rather than failing here.
            return property === "length"
                ? {
                      kind: "number",
                      cpp: `${owner.cpp}.length()`,
                      dataType: { kind: "number" },
                  }
                : {
                      kind: "data",
                      cpp: `${owner.cpp}.get(${this.context.cppString(property)})`,
                      dataType: { kind: "json" },
                  };
        }
        if (dataType.kind === "optional") {
            this.context.fail(
                access,
                `'${access.expression.getText()}' may be null here; narrow it before member access.`,
            );
        }
        if (dataType.kind === "struct") {
            if (
                this.context.dataTypes.isClassStruct(dataType.name) &&
                !this.context.dataTypes.classStructField(
                    dataType.name,
                    property,
                )
            ) {
                // A getter, a method, or a field the layout hoisted: none of
                // them is a slot in the shared object, and the class lowerer
                // owns all three.
                return undefined;
            }
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
            if (field.uncheckedProperty) value.preserveUncheckedLookup = true;
            const staticField =
                !this.context.dataTypes.isReferenceStruct(dataType.name) ||
                field.readOnly
                    ? owner.recordProperties?.[property]
                    : undefined;
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
            const cardinality = owner.collectionCardinality ?? owner.staticElementsOwner?.collectionCardinality;
            const fixed = cardinality?.untrackedAliases
                ? undefined
                : this.fixedLengths.get(this.rootName(owner.cpp));
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
        if (dataType.kind === "u8array" || dataType.kind === "dataview" || dataType.kind === "bufferview") {
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
        if (isTypedArrayType(dataType) && dataType.kind !== "u8array") {
            if (property === "buffer") {
                return {
                    kind: "data",
                    cpp: `bbl::js::ArrayBuffer(${owner.cpp})`,
                    dataType: { kind: "arraybuffer" },
                };
            }
            if (property === "byteOffset") {
                return {
                    kind: "number",
                    cpp: `static_cast<double>(bbl::js::typed_array_byte_offset(${owner.cpp}))`,
                    dataType: { kind: "number" },
                };
            }
            if (property === "byteLength") {
                return {
                    kind: "number",
                    cpp:
                        `static_cast<double>(${owner.cpp}.size() * ` +
                        `sizeof(${this.context.dataTypes.cppType(dataType)}::value_type))`,
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
            dataType.kind === "string" &&
            property === "length"
        ) {
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `bbl::js::string_length(${owner.cpp})`,
                dataType: { kind: "number" },
            };
        }
        if (
            (dataType.kind === "tuple" || dataType.kind === "product") &&
            property === "length"
        ) {
            const length = dataType.kind === "tuple" ? dataType.arity : dataType.elements.length;
            return {
                kind: "number",
                cpp: `${length}.0`,
                staticNumber: length,
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
        if (dataType.kind === "enummap") {
            const enumType = {
                kind: "enum" as const,
                name: dataType.enumName,
            };
            const tag =
                this.context.dataTypes.enumMemberCpp(
                    enumType,
                    property,
                    access,
                );
            this.context.reachJsData();
            return this.leafValue(
                `bbl::js::enum_map_at(${owner.cpp}, ${tag})`,
                dataType.element,
            );
        }
        // A caught Error is its message string and carries `.message` and
        // `.name` beside it; nothing else in the data model carries
        // record properties past its own type.
        const carried = owner.nativeError
            ? owner.recordProperties?.[property]
            : undefined;
        if (carried) {
            return carried;
        }
        this.context.fail(
            access,
            `Unsupported data property '${property}' on ${dataType.kind}.`,
        );
    }

    /** Read a statically selected lane while retaining its declared type. */
    public fixedTupleElement(value: Value, index: number, node: ts.Node): Value | undefined {
        const type = value.dataType;
        if (type?.kind !== "tuple" && type?.kind !== "product") return undefined;
        const length = type.kind === "tuple" ? type.arity : type.elements.length;
        if (!Number.isInteger(index) || index < 0 || index >= length)
            this.context.fail(node, `Tuple index ${index} is out of range.`);
        return this.leafValue(type.kind === "product" ? `(${value.cpp}).template get<${index}>()` : `${value.cpp}[${index}]`,
            type.kind === "product" ? type.elements[index]! : { kind: "number" });
    }

    private indexRunsCode(expression: ts.Expression): boolean {
        return someAnalysisNode(expression, node =>
            ts.isCallExpression(node) || ts.isNewExpression(node) ||
            ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ||
            isUpdateExpression(node) || isAssignmentExpression(node));
    }

    private elementRead(
        ownerValue: Value,
        access: ts.ElementAccessExpression,
        mode: "read" | "write" = "read",
    ): Value | undefined {
        const owner = this.stringReceiver(this.narrowOptional(
            ownerValue,
            access.expression,
        ), access);
        const dataType = owner.dataType;
        if (!dataType) {
            return undefined;
        }
        if (dataType.kind === "product") {
            const receiver = this.context.allocateTemporaryCppName("indexed_tuple");
            this.context.emit(`const auto ${receiver} = ${owner.cpp};`);
            const index = this.context.compileValue(access.argumentExpression);
            if (index.staticNumber === undefined)
                this.context.fail(access, "Mixed tuple indexing requires a statically known lane.");
            return this.fixedTupleElement({ ...owner, cpp: receiver }, index.staticNumber, access);
        }
        if (dataType.kind === "numberindex") {
            const receiver = this.context.allocateTemporaryCppName("indexed_numbers");
            this.context.emit(`const auto ${receiver} = ${owner.cpp};`);
            const index = this.context.compileNumber(access.argumentExpression, "double");
            const site = this.context.cppString(this.indexSiteLabel(access));
            return { kind: "number", cpp: `${receiver}.${mode === "write" ? "slot" : "read"}(${index}, ${site})`,
                dataType: { kind: "number" }, ...(mode === "write" ? { dataStore: "numberindex" as const } : {}) };
        }
        if (dataType.kind === "string") {
            if (mode === "write") this.context.fail(access, "String element writes are not supported.");
            let source = owner.cpp;
            if (this.indexRunsCode(access.argumentExpression) &&
                (owner.staticString === undefined || source !== this.context.cppString(owner.staticString))) {
                source = this.context.allocateTemporaryCppName("indexed_string");
                this.context.emit(`const std::string ${source} = ${owner.cpp};`);
            }
            const index = this.context.compileValue(access.argumentExpression);
            if (owner.staticString !== undefined && index.staticNumber !== undefined) {
                const character = owner.staticString[index.staticNumber];
                return character === undefined ? { kind: "json-null", cpp: "std::nullopt" }
                    : { kind: "string", cpp: this.context.cppString(character), staticString: character, dataType: { kind: "string" } };
            }
            const indexCpp = this.compileKnownValueForSink(index, { kind: "number" }, access.argumentExpression);
            this.context.reachJsData();
            return { ...this.leafValue(`bbl::js::string_index(${source}, ${indexCpp})`, { kind: "optional", inner: { kind: "string" } }),
                preserveUncheckedLookup: true };
        }
        if (dataType.kind === "json") {
            // An index past the end, or into something that is not an
            // array, is `undefined` -- the document answers, it does not
            // fail.
            return {
                kind: "data",
                cpp: `${owner.cpp}.at(${this.context.compileNumber(access.argumentExpression, "double")})`,
                dataType: { kind: "json" },
            };
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
                    this.context.dataTypes.nullableType(dataType.value),
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
            const staticMember = this.context.probeEmission(() => {
                const key = this.context.compileValue(access.argumentExpression);
                const keyType = this.context.checker.getTypeAtLocation(access.argumentExpression);
                const name = key.staticString ?? (keyType.isStringLiteral() ? keyType.value : undefined);
                if (name === undefined) return undefined;
                this.context.emitDiscardedValue(key);
                const field = this.context.dataTypes.structField(dataType.name, name, access);
                const arrow = this.context.dataTypes.isReferenceStruct(dataType.name) ? "->" : ".";
                return withNativeMetadata(this.leafValue(`${owner.cpp}${arrow}${field.name}`, field.type),
                    mode === "read" && (field.readOnly || owner.recordOwnKeys || arrow === ".")
                        ? owner.recordProperties?.[name] : undefined);
            });
            if (staticMember) return staticMember;
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
            return {
                ...this.leafValue(
                `([&](const auto ${keyTemporary}) -> decltype(auto) { ` +
                    `return ${selected}; })(${key})`,
                fieldType,
                ),
                ...(fields.some(field => field.uncheckedProperty) ? { preserveUncheckedLookup: true as const } : {}),
            };
        }
        const ownedRead = owner.freshData && mode === "read";
        // Index calls, getters and mutations can replace the array binding.
        // Scalar arithmetic over locals cannot, so ordinary counted accesses
        // need no extra wrapper copy before their index is evaluated.
        const typedIndexRunsCode = isTypedArrayType(dataType) && this.indexRunsCode(access.argumentExpression);
        const retainedIndexOwner = ownedRead || typedIndexRunsCode;
        let index = "";
        const compileIndex = (): void => {
            index = this.context.compileNumber(access.argumentExpression, "double");
        };
        const indexLines = retainedIndexOwner
            ? this.context.captureEmittedLines(compileIndex)
            : (compileIndex(), []);
        const indexedOwner = retainedIndexOwner
            ? this.context.allocateTemporaryCppName("indexed_owner")
            : owner.cpp;
        this.context.reachJsData();
        const nativeIndex = `bbl::js::array_index(${index})`;
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
        const element =
            dataType.kind === "vector" && mode === "write"
                ? proven
                    ? `bbl::js::array_index_write(${owner.cpp}, ${nativeIndex})`
                    : `bbl::js::array_index_write_checked(${owner.cpp}, ${index}, ${site()})`
                : proven
                  ? isTypedArrayType(dataType)
                    ? `bbl::js::typed_array_${mode === "write" ? "slot" : "load"}(${indexedOwner}, ${nativeIndex})`
                    : `${indexedOwner}[${nativeIndex}]`
                  : mode === "write" &&
                      (isTypedArrayType(dataType) ||
                          dataType.kind === "tuple")
                    ? `bbl::js::array_store_checked(${indexedOwner}, ${index}, ${site()})`
                    : `bbl::js::array_index_checked(${indexedOwner}, ${index}, ${site()})`;
        // Keep fresh containers and retained typed-array owners alive until
        // the index finishes. Numeric writes return a slot that owns its view;
        // reads return values. This expression stays behind its source guard.
        const retainedOwner = typedIndexRunsCode
            ? `bbl::js::retain_typed_array_owner(${owner.cpp})` : owner.cpp;
        const indexed = retainedIndexOwner
            ? `([&]() { auto ${indexedOwner} = ${retainedOwner};\n` +
                indexLines.map(line => `    ${line}\n`).join("") +
                `    return ${element}; }())`
            : element;
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
            case "vector": {
                const value: Value = {
                    ...this.leafValue(
                        indexed,
                        dataType.element,
                    ),
                    ...(owner.readOnly
                        ? { readOnly: true as const }
                        : {}),
                    ...(ownedRead && passesByReference(this.context.dataTypes, dataType.element)
                        ? { freshData: true as const }
                        : {}),
                };
                const candidates = owner.staticElementsOwner?.staticElements ?? owner.staticElements ??
                    (owner.runtimeElementTemplate ? [owner.runtimeElementTemplate] : undefined);
                return mode === "read" && value.kind === "material" && candidates?.length
                    ? commonResourceValue(value, candidates)
                    : value;
            }
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
    private readonly canonicalLoopVerdicts = new EmissionMap<
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

        const safe = !someAnalysisNode(body, (node) => {
            if (ts.isNewExpression(node)) {
                return true;
            }
            if (
                ts.isCallExpression(node) &&
                !this.isGlobalMathCall(node)
            ) {
                return true;
            }
            if (
                isUpdateExpression(node) &&
                this.isSameSymbolIdentifier(
                    node.operand,
                    indexSymbol,
                )
            ) {
                return true;
            }
            if (isAssignmentExpression(node)) {
                const target = this.context.unwrap(node.left);
                if (
                    this.isSameSymbolIdentifier(
                        target,
                        indexSymbol,
                    ) ||
                    (ts.isPropertyAccessExpression(target) &&
                        target.name.text === "length")
                ) {
                    return true;
                }
            }
            return false;
        });

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
        // An array whose element type is already nullable has a native value
        // for JavaScript's out-of-range `undefined`: the empty optional. Read
        // it through the defaulting accessor and let the ordinary optional
        // path handle `??`, optional chaining, or truthiness. A separate
        // index-existence flag would incorrectly wrap `optional<T>` in a
        // second optional when the fallback is null.
        if (element.kind === "optional") {
            const index = this.context.compileNumber(
                access.argumentExpression,
                "double",
            );
            const indexTemporary =
                this.context.allocateTemporaryCppName(
                    "element_index",
                );
            this.context.emit(
                { kind: "declaration", type: "const double", name: indexTemporary, initializer: index, attributes: "[[maybe_unused]] " },
            );
            this.context.reachJsData();
            return {
                ...this.leafValue(`bbl::js::array_at_or_default(${owner.cpp}, ${indexTemporary})`, element),
                nativeCaptures: [...(owner.nativeCaptures ?? []), this.context.registerNativeBinding(indexTemporary)],
            };
        }
        if (
            ![
                "struct",
                "date",
                "date-time-format",
                "storage",
                "vector",
                "map",
                "set",
                "arraybuffer",
                "dataview",
                "bufferview",
                "numberindex",
                "handle",
                "number",
                "boolean",
                "string",
                "enum",
            ].includes(element.kind) && !isTypedArrayType(element)
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
            { kind: "declaration", type: "const double", name: indexTemporary, initializer: index, attributes: "[[maybe_unused]] " },
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
        const captures = [...(owner.nativeCaptures ?? []), this.context.registerNativeBinding(indexTemporary)];
        return {
            ...this.leafValue(indexed, element),
            nativeCaptures: captures,
            nativeCompanionCaptures: { optionalFoundCpp: captures, truthinessCpp: captures },
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
        if (dataType.kind === "promise") return {
            kind:"promise", cpp, dataType,
            promiseType: dataType.result ? this.context.dataTypes.cppType(dataType.result) : "bbl::js::PromiseVoid",
            promiseResult: dataType.result ? this.leafValue("", dataType.result) : {kind:"void", cpp:""},
        };
        if (dataType.kind === "storage") return storageValue(cpp);
        if (dataType.kind === "handle" && dataType.handle === "engine") {
            return { kind: "engine", cpp: `(*${cpp})`, engineCpp: `(*${cpp})`, dataType };
        }
        if (dataType.kind === "number") {
            // The dataType marker records that this number is a native
            // double lvalue, so float contexts insert an explicit cast.
            return { kind: "number", cpp, dataType };
        }
        if (dataType.kind === "boolean") {
            return { kind: "boolean", cpp, dataType };
        }
        if (dataType.kind === "borrowed-platform-event") {
            if (dataType.event === "error" || dataType.event === "rejection") {
                return {...windowErrorEventValue(this.context, `${cpp}.get()`, dataType.event === "rejection"), dataType};
            }
            return valueForKind(dataType.event === "keyboard"
                        ? "platform-keyboard-event"
                        : "platform-mouse-event", {

                cpp: `${cpp}.get()`,
                dataType,
                ...(dataType.event === "event"
                    ? { platformEventBase: true as const }
                    : {}),
            });
        }
        if (dataType.kind === "handle") {
            // Handle leaves surface as ordinary resource values, so
            // every mesh intrinsic and property assignment works on a
            // mesh read out of a struct or array exactly as it does on
            // a mesh local. The Window document has its own UI owner.
            const engineCpp = dataType.handle.startsWith("text-") || dataType.handle === "node-input"
                ? undefined
                : dataType.handle === "picking-info"
                ? `bbl::picking_engine(${cpp})`
                : dataType.handle === "ui-element"
                ? documentEngine(this.context, this.context.sourceFile)
                : this.context.defaultEngine();
            return valueForKind(dataType.handle ===
                    "property-animation-group"
                        ? "animation-group"
                        : dataType.handle, {

                cpp,
                dataType,
                ...(dataType.handle ===
                "property-animation-group"
                    ? {
                          animationGroupSource:
                              "property" as const,
                      }
                    : {}),
                ...(dataType.handle === "scene"
                    ? {
                          sceneEnvironmentState: {
                              rotationSet: false,
                              hasTexturedSkybox: false,
                          },
                      }
                    : {}),
                ...(engineCpp ? { engineCpp } : {}),
            });
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
            path ?? this.context.resolveRecordValue(unwrapped) ??
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
        return isOpaqueReference(value.dataType) ? `${value.cpp}.get()` : value.dataType?.kind === "struct"
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
        const elements = this.context.probeEmission(() => {
            let entries: readonly Value[] = [];
            const lines = this.context.captureEmittedLines(() => {
                entries = literal
                    ? literal.elements.map(entry => this.context.compileValue(entry))
                    : bound!.tupleElements!;
            });
            if (lines.length > 0 || !entries.every(entry => this.knownValueFitsSink(entry, element, unwrapped, true))) return undefined;
            return entries.map(entry => this.compileKnownValueForSink(
                this.constantInitializerValue(entry), element, unwrapped));
        }, result => result !== undefined);
        if (!elements) {
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
                elements,
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

    public isNumericTable(
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

    /** An element a range yields as a pair or an index rather than a value. */
    private pairedElement(
        element: DataIterationElement,
    ): element is Extract<DataIterationElement, { kind: "map-entry" | "array-entry" | "array-index" }> {
        return element.kind === "map-entry" || element.kind === "array-entry" || element.kind === "array-index";
    }

    /**
     * `Array.from(iterable, (value, index) => mapped)` over a native
     * range: one walk that appends each mapped value, evaluating the
     * mapper once per element in iteration order.
     */
    private compileArrayFromMapped(call: ts.CallExpression): Value | undefined {
        // `Array.from({ length: n }, ...)` is the allocation form below; an
        // object literal is never a range worth probing.
        if (ts.isObjectLiteralExpression(this.context.unwrap(argumentAt(call, 0)))) {
            return undefined;
        }
        const range = this.context.probeEmission(() =>
            this.iterationTarget(argumentAt(call, 0)),
        );
        if (!range || this.pairedElement(range.element)) {
            return undefined;
        }
        const resultType = this.dataTypeAt(call);
        if (resultType?.kind !== "vector") {
            this.context.fail(call, "Array.from with a mapper requires a concrete array result type.");
        }
        const mapper = this.context.unwrap(argumentAt(call, 1));
        if (!ts.isArrowFunction(mapper) && !ts.isFunctionExpression(mapper) && !ts.isIdentifier(mapper)) {
            this.context.fail(argumentAt(call, 1), "Array.from's mapper must be a function literal or a local function.");
        }
        this.context.reachJsData();
        const source = this.context.allocateTemporaryCppName("array_from_source");
        this.context.emit(`auto&& ${source} = ${range.container.cpp};`);
        const result = this.context.allocateTemporaryCppName("array_from_result");
        this.context.emit(`${this.context.dataTypes.cppType(resultType)} ${result};`);
        this.context.emit(`${result}.reserve(${source}.size());`);
        const index = this.context.allocateTemporaryCppName("array_from_index");
        this.context.emit(`std::size_t ${index} = 0;`);
        const item = this.context.allocateTemporaryCppName("array_from_item");
        const element = range.element;
        const lines = this.context.captureEmittedLines(() => {
            this.context.pushScope(this.context.allocateBlockPrefix());
            try {
                const value = this.context.compileCallbackWithValues(
                    mapper,
                    [
                        this.leafValue(item, element),
                        { kind: "number", cpp: `static_cast<double>(${index})`, dataType: { kind: "number" } },
                    ],
                    call,
                );
                this.context.emit(
                    `${result}.push_back(${this.compileKnownValueForSink(value, resultType.element, call)});`,
                );
                this.context.emit(`++${index};`);
            } finally {
                this.context.popScope();
            }
        });
        this.context.emit(`for (auto&& ${item} : ${source}) {`);
        this.context.increaseIndent();
        for (const line of lines) this.context.emit(line);
        this.context.decreaseIndent();
        this.context.emit("}");
        this.registerLocal(result, "owned");
        return { kind: "data", cpp: result, dataType: resultType };
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
            (callee.name.text !== "from" && callee.name.text !== "of") ||
            !this.context.isDefaultLibraryIdentifier(callee.expression)
        ) {
            return undefined;
        }
        if (callee.name.text === "of") {
            const type = this.dataTypeAt(call);
            if (type?.kind !== "vector") this.context.fail(call, "Array.of requires a concrete array element type.");
            this.context.reachJsData();
            const values = call.arguments.map(argument => {
                const value = this.compileForRetainedSink(argument, type.element, "Array.of");
                const name = this.context.allocateTemporaryCppName("array_of_value");
                this.context.emit({ kind: "declaration", type: "const auto", name: name, initializer: value });
                return name;
            });
            return { kind: "data", cpp: `${this.context.dataTypes.cppType(type)}{${values.join(", ")}}`, dataType: type };
        }
        if (call.arguments.length === 1) {
            const source = this.context.compileValue(argumentAt(call, 0));
            if (
                source.kind !== "data" ||
                (source.dataType?.kind !== "vector" && source.dataType?.kind !== "span" && source.dataType?.kind !== "set")
            ) {
                this.context.fail(
                    argumentAt(call, 0),
                    "Array.from with one argument requires a native array or Set value.",
                );
            }
            // The enclosing value path materializes the returned vector, so
            // this expression receives Array.from's shallow-copy identity
            // while preserving the source element order.
            return {
                kind: "data",
                cpp: `bbl::js::array_from_iterable<${this.context.dataTypes.cppType(source.dataType.element)}>(${source.cpp})`,
                dataType: { kind: "vector", element: source.dataType.element },
            };
        }
        if (call.arguments.length !== 2) {
            this.context.fail(
                call,
                "Array.from currently requires an array-like length object and one mapper callback.",
            );
        }
        const mapped = this.compileArrayFromMapped(call);
        if (mapped) {
            return mapped;
        }
        const source = this.context.unwrap(argumentAt(call, 0));
        if (!ts.isObjectLiteralExpression(source)) {
            this.context.fail(
                source,
                "Array.from with a mapper takes a native array, Set or Map values range, or an object literal with a length property.",
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
        if (source.properties.length !== 1) this.context.fail(source, "Array.from length objects cannot contain additional properties.");
        const callback = this.context.unwrap(argumentAt(call, 1));
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
            { kind: "declaration", type: "const std::size_t", name: count, initializer: `bbl::js::array_from_length(${this.context.compileNumber(lengthProperty.initializer, "double")})` },
        );
        this.context.emit(`bbl::js::Array<${cppType}> ${output};`);
        this.context.emit(`${output}.reserve(${count});`);
        this.context.emit(
            `for (std::size_t ${index} = 0; ${index} < ${count}; ++${index}) {`,
        );
        this.context.increaseIndent();
        this.context.pushScope(this.context.allocateBlockPrefix());
        this.context.enterRuntimeIteration();
        try {
            const result = this.context.compileCallbackWithValues(
                callback,
                [
                    { kind: "json-null", cpp: "std::nullopt" },
                    { kind: "number", cpp: `static_cast<double>(${index})`, dataType: { kind: "number" } },
                ],
                call,
            );
            const value = this.compileKnownValueForSink(
                result,
                mappedType.element,
                callback,
            );
            this.context.emit(`${output}.push_back(${value});`);
        } finally {
            this.context.leaveRuntimeIteration();
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
        // Resolved, not spelled: a scene's own binding named `Math` is not
        // the library object, however the compiler came to know it.
        const callee = mathMemberAccess(
            this.context.unwrap(call.expression),
            (identifier) => this.context.isDefaultLibraryIdentifier(identifier),
        );
        if (!callee) {
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
        // argument (the table says which): the result is exact in both
        // engines, so the folded value and the emitted call agree, and a
        // scene that hands one to generation-time state (a particle
        // column) needs the value rather than the expression.
        const fold = mathUnaryFold(method);
        if (fold && call.arguments.length === 1) {
            // Folded from the SOURCE, never from a compiled value: this arm
            // runs before the runtime path compiles the argument, and
            // compiling it speculatively would emit an inlined body twice
            // when the fold misses. A canvas size reaches the same evaluator
            // through `staticCanvasSize`, so it folds here too.
            const argument = staticNumberValue(
                this.context,
                argumentAt(call, 0),
            );
            const folded = argument === undefined ? undefined : fold(argument);
            if (folded !== undefined && Number.isFinite(folded)) {
                return {
                    kind: "number",
                    cpp: doubleLiteral(folded),
                    staticNumber: folded,
                    dataType: { kind: "number" },
                };
            }
        }
        const member = MATH_MEMBERS.get(method);
        if (member) {
            const count = call.arguments.length;
            if (member.variadic ? count < member.arity : count !== member.arity) {
                this.context.fail(
                    call,
                    `Math.${method} expects ${describeMathArity(member)}.`,
                );
            }
            const cpp = member.cpp(numbers());
            if (member.reach !== undefined) this.context.reachJsData();
            if (member.reach === "js-random") this.context.reachJsRandom();
            return {
                kind: "number",
                cpp,
                dataType: { kind: "number" },
                ...(member.impure ? { impure: true } : {}),
            };
        }
        if (method === "max" || method === "min") {
            const only =
                call.arguments.length === 1 ? argumentAt(call, 0) : undefined;
            if (only && ts.isSpreadElement(only)) {
                let spread = this.context.compileValue(only.expression);
                if (spread.kind === "tuple") {
                    const parts = (spread.tupleElements ?? []).map(element => element.staticNumber);
                    if (parts.every((part): part is number => part !== undefined)) {
                        this.context.emitDiscardedValue(spread);
                        return numberConstantValue(Math[method](...parts));
                    }
                    const type = {kind: "vector", element: {kind: "number"}} as const;
                    spread = this.leafValue(this.compileKnownValueForSink(spread, type, only.expression), type);
                }
                if (
                    spread.kind !== "data" ||
                    (spread.dataType?.kind !== "vector" &&
                        spread.dataType?.kind !== "span") ||
                    spread.dataType.element.kind !== "number"
                ) {
                    this.context.fail(
                        argumentAt(call, 0),
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
                this.context.emit({ kind: "declaration", type: "auto&&", name: source, initializer: spread.cpp });
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
        this.context.fail(
            callee.name,
            `Math.${method} is not supported.`,
        );
    }

    /**
     * Compiles `typedArray.set(source, offset)`.
     *
     * A source of the target's OWN kind is copied; any other numeric
     * sequence is converted first, element by element, through the
     * target's own store — the spec's `ToNumber` is the identity over
     * this data model's numbers, so the store is all that is left of it.
     * That conversion is `typedArrayFromSource`, the same one the
     * constructor applies to the same sequence, so a source this method
     * accepts is exactly a source `new Float32Array(...)` accepts and
     * anything else refuses by name. The offset argument is optional
     * upstream and defaults to zero.
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
        const source = this.typedArrayFromSource(
            typedArrayStem(kind),
            this.context.unwrap(argumentAt(call, 0)),
            kind,
        );
        if (source === undefined) {
            this.context.fail(
                argumentAt(call, 0),
                "TypedArray.set expects a numeric sequence: a typed array, " +
                    "a number array or a numeric tuple.",
            );
        }
        this.context.reachJsData();
        const offset =
            call.arguments.length === 2
                ? this.context.compileNumber(
                      argumentAt(call, 1),
                      "double",
                  )
                : "0.0";
        return {
            kind: "void",
            cpp: `bbl::js::typed_array_set(${target.cpp}, ${source}, ${offset})`,
        };
    }

    /**
     * Compiles `array.indexOf(value)`.
     *
     * Only element types JavaScript compares the way native code does
     * are reached: numbers, booleans, and tags compare by value in both,
     * a handle is an id, which is what makes two references the same
     * object, a function stored in an array carries its declaration identity,
     * and a reference struct is a `Ref` whose equality is its control block --
     * the same object identity JavaScript compares. A value-backed struct or
     * a nested container would compare by identity in JavaScript and field by
     * field here, so those are rejected rather than answered differently.
     */
    public compileArraySearch(
        call: ts.CallExpression,
        owner: Value,
        element: DataType,
        method: "indexOf" | "includes" | "lastIndexOf",
    ): Value {
        if (call.arguments.length !== 1 && !(method === "lastIndexOf" && call.arguments.length === 2)) {
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
            element.kind !== "handle" &&
            element.kind !== "function" &&
            !(
                element.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(element.name)
            )
        ) {
            this.context.fail(
                call,
                `Array.${method} is supported for numbers, booleans, strings, tags, handles, functions, and shared objects, not ${element.kind}: JavaScript would compare by identity here.`,
            );
        }
        this.context.reachJsData();
        const value = this.compileForSink(
            argumentAt(call, 0),
            element,
        );
        if (method === "lastIndexOf") {
            const needle = this.context.allocateTemporaryCppName("last_index_needle");
            this.context.emit({ kind: "declaration", type: "const auto", name: needle, initializer: value });
            const from = call.arguments[1]
                ? this.context.compileNumber(call.arguments[1], "double")
                : "std::numeric_limits<double>::infinity()";
            return this.leafValue(`bbl::js::array_last_index_of(${owner.cpp}, ${needle}, ${from})`, { kind: "number" });
        }
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

    /** Snapshot a numeric argument before compiling the next argument's effects. */
    public compileNumberArgument(argument: ts.Expression | undefined, fallback: string): string {
        if (!argument) return fallback;
        const value = this.context.compileNumber(argument, "double");
        const name = this.context.allocateTemporaryCppName("numeric_argument");
        this.context.emit({ kind: "declaration", type: "const double", name: name, initializer: value });
        return name;
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
            | "flatMap"
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
        const callback = this.context.unwrap(argumentAt(call, 0));
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
        const receiverPolicy = arrayCallbackReceiverPolicy(method);
        if (receiverPolicy.invalidatesFacts) this.invalidateStaticElements(narrowed);
        const source =
            this.context.allocateTemporaryCppName(`${label}_source`);
        const index =
            this.context.allocateTemporaryCppName(`${label}_index`);
        this.context.emit({ kind: "declaration", type: receiverPolicy.snapshotIdentity ? "auto" : "auto&&", name: source, initializer: narrowed.cpp });
        const sourceCapture = this.context.registerNativeBinding(source);
        const namedCallback = ts.isIdentifier(callback) ? this.context.lookupIdentifierValue(callback) : undefined;
        let storedCallback: Value | undefined;
        if (namedCallback?.dataType?.kind === "function") {
            this.context.useNativeValue(namedCallback);
            const name = this.context.allocateTemporaryCppName(`${label}_callback`);
            this.context.emit(`const auto ${name} = ${namedCallback.cpp};`);
            storedCallback = { ...namedCallback, cpp: name, nativeCaptures: [this.context.registerNativeBinding(name)] };
        }
        initialize(source);
        let bound = `${source}.size()`;
        if (snapshotLength) {
            const count =
                this.context.allocateTemporaryCppName(`${label}_count`);
            this.context.emit(
                { kind: "declaration", type: "const std::size_t", name: count, initializer: bound },
            );
            bound = count;
        }
        this.context.emit(
            `for (std::size_t ${index} = 0; ${index} < ${bound}; ++${index}) {`,
        );
        this.context.increaseIndent();
        this.context.pushScope(this.context.allocateBlockPrefix());
        const indexCapture = this.context.registerNativeBinding(index);
        try {
            this.context.enterRuntimeControlFlow();
            this.context.enterRuntimeIteration();
            try {
                if (receiverPolicy.skipRemoved) this.context.emit(`if (${index} >= ${source}.size()) continue;`);
                const elementValue = {
                    ...this.leafValue(`${source}[${index}]`, dataType.element),
                    nativeCaptures: [sourceCapture, indexCapture],
                };
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
                        nativeCaptures: [indexCapture],
                    },
                    {
                        ...nativeDataMetadata(narrowed),
                        kind: "data",
                        cpp: source,
                        dataType,
                        nativeCaptures: [sourceCapture],
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
                let result = storedCallback ? this.compileFunctionValueCall(storedCallback, callbackArguments, call) : booleanConstructor
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
                            method === "forEach",
                        );
                if (storedCallback && predicate) result = {kind: "boolean",
                    cpp: this.conditionFromValue(result) ?? this.context.fail(call, "Array predicate result has no native truthiness."),
                    dataType: {kind: "boolean"}};
                emitBody(result, callback, source, index);
            } finally {
                this.context.leaveRuntimeIteration();
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
    public invalidateStaticElements(value: Value, preserveCardinality = false): void {
        this.context.invalidateStaticElements(value, preserveCardinality);
    }

    /** A retained mutable alias can invalidate both an array snapshot and its length. */
    public invalidateEscapingCollection(value: Value): void {
        const cardinality = value.collectionCardinality ?? value.staticElementsOwner?.collectionCardinality;
        if (!cardinality && !value.staticElements && !value.staticElementsOwner) return;
        if (cardinality) cardinality.untrackedAliases = true;
        this.invalidateStaticElements(value);
    }

    /**
     * Compiles data-container method calls (`push`, `pop`, `fill`) and the
     * `new Array(n).fill(v)` chain. The dispatcher itself lives in
     * `data-methods.ts` beside the method-name sets it routes by; this
     * entry point keeps every caller on the lowerer.
     */
    public compileDataMethodCall(
        call: ts.CallExpression,
        expectedResult?: DataType<"vector">,
    ): Value | undefined {
        return compileDataMethodCall(this, call, expectedResult);
    }

    /** Invoke native function storage after resolving its receiver and callee. */
    public compileStoredCall(call: ts.CallExpression, callable: string, functionType: DataType<"function">, receiver?: string): Value {
        if (call.questionDotToken || (ts.isPropertyAccessExpression(call.expression) && call.expression.questionDotToken)) {
            return this.compileOptionalStoredCall(call, callable, functionType, receiver);
        }
        if (receiver) this.context.emit(`if (!(${receiver})) throw std::runtime_error("Cannot call a method on a nullish receiver.");`);
        const callback = this.context.allocateTemporaryCppName("stored_callback");
        this.context.emit({kind:"declaration", type:"const auto", name:callback, initializer:callable});
        const args = this.compileFunctionArguments(call, functionType);
        const cpp = `${callback}(${args.join(", ")})`;
        return functionType.result ? this.leafValue(cpp, functionType.result) : {kind:"void", cpp};
    }

    /** Snapshot a retained callback before evaluating its lazy arguments. */
    public compileOptionalStoredCall(
        call: ts.CallExpression,
        callable: string,
        functionType: DataType<"function">,
        receiver?: string,
    ): Value {
        // A called helper can clear the slot without invalidating TypeScript's
        // property narrowing. Optional invocation still observes that absence.
        const returned = functionType.result;
        const resultType = returned ? this.context.dataTypes.nullableType(returned) : undefined;
        const resultCpp = resultType ? this.context.dataTypes.cppType(resultType) : "void";
        const missing = resultType ? "return {};" : "return;";
        const callback = this.context.allocateTemporaryCppName("optional_callback");
        const lines = this.context.captureEmittedLines(() => {
            if (receiver) this.context.emit(`if (!(${receiver})) ${missing}`);
            this.context.emit(`const auto ${callback} = ${callable};`);
            if (call.questionDotToken) this.context.emit(`if (!${callback}) ${missing}`);
            this.context.enterRuntimeControlFlow();
            try {
                const args = this.compileFunctionArguments(call, functionType);
                const invocation = `${callback}(${args.join(", ")})`;
                this.context.emit(resultType ? `return ${resultCpp}(${invocation});` : `${invocation};`);
            } finally {
                this.context.leaveRuntimeControlFlow();
            }
        });
        const cpp = `([&]() -> ${resultCpp} {\n${lines.join("\n")}\n}())`;
        return resultType ? { ...this.leafValue(cpp, resultType), preserveUncheckedLookup: true } : { kind: "void", cpp };
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
            declaration.initializer.expression.text !== "Map" ||
            !this.context.isDefaultLibraryIdentifier(
                declaration.initializer.expression,
            )
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
            someAnalysisNode(statement.statement, (node) => {
                if (!ts.isCallExpression(node)) return false;
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
                    return false;
                }
                const key = this.context.unwrap(
                    argumentAt(node, 0),
                );
                const value = this.context.unwrap(
                    argumentAt(node, 1),
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
                    return true;
                }
                return "skip";
            });
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
            { kind: "declaration", type: "static const auto", name: source, initializer: sourceCpp },
        );
        const key = this.compileForSink(
            argumentAt(call, 0),
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
            argumentAt(expression, 0),
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
        if (created.element.kind === "borrowed-platform-event") {
            this.context.fail(
                expression,
                "A sized Array cannot create default DOM event values; platform events exist only inside their active callback.",
            );
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
            compileDateNew(this, expression) ??
            this.compileNewArray(expression) ??
            this.compileTypedArrayNew(expression) ??
            this.compileArrayBufferNew(expression) ??
            this.compileDataViewNew(expression) ??
            this.compileMapOrSetNew(expression)
        );
    }

    /** `new ArrayBuffer(byteLength)`: zero-filled shared bytes. */
    private compileArrayBufferNew(
        expression: ts.NewExpression,
    ): Value | undefined {
        if (
            !ts.isIdentifier(expression.expression) ||
            expression.expression.text !== "ArrayBuffer" ||
            !this.context.isDefaultLibraryIdentifier(expression.expression)
        ) {
            return undefined;
        }
        const arguments_ = expression.arguments ?? [];
        if (arguments_.length !== 1) {
            this.context.fail(expression, "new ArrayBuffer takes one byte length.");
        }
        this.context.reachJsData();
        const length = this.context.compileNumber(arguments_[0]!, "double");
        return {
            kind: "data",
            cpp: `bbl::js::ArrayBuffer(std::vector<std::uint8_t>(bbl::js::array_index(${length})))`,
            dataType: { kind: "arraybuffer" },
        };
    }

    public compileMapOrSetNew(
        expression: ts.NewExpression,
        expectedType?: DataType,
    ): Value | undefined {
        if (
            !ts.isIdentifier(expression.expression) ||
            !["Map", "Set", "WeakMap", "WeakSet"].includes(expression.expression.text) ||
            !this.context.isDefaultLibraryIdentifier(expression.expression)
        ) {
            return undefined;
        }
        // A weak collection is its strong twin (see the type mapping).
        const constructedKind = expression.expression.text.endsWith("Map") ? "map" : "set";
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
            expectedType?.kind === "map" || expectedType?.kind === "set"
                ? expectedType
                : contextual?.kind === "map" || contextual?.kind === "set"
                  ? contextual
                  : direct?.kind === "map" || direct?.kind === "set"
                    ? direct
                    : undefined;
        if (!dataType) {
            this.context.fail(
                expression,
                `new ${expression.expression.text} requires concrete data type arguments or a contextual container type.`,
            );
        }
        if (dataType.kind !== constructedKind) {
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
                return compileMapInitializer(this, expression, dataType);
            }
            return {
                kind: "data",
                cpp: `${cppType}{}`,
                dataType,
                recordProperties: {},
            };
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
                this.compileForRetainedSink(
                    element,
                    dataType.element,
                    "Set constructor",
                ),
            );
            return {
                kind: "data",
                cpp: `${cppType}{${values.join(", ")}}`,
                dataType,
            };
        }
        const source = this.context.compileValue(iterable);
        const values = this.compileKnownValueForSink(source, {
            kind: "vector",
            element: dataType.element,
        }, iterable);
        if (
            this.context.dataTypes.carriesBorrowedPlatformEvent(
                dataType.element,
            )
        ) {
            this.context.refuseBorrowedPlatformEventEscape(
                source,
                iterable,
                "Set constructor",
            );
        }
        return {
            kind: "data",
            cpp: `${cppType}(${values})`,
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
        const kind = TYPED_ARRAY_KINDS.get(name);
        if (!kind) {
            return undefined;
        }
        const dataType: DataType = { kind };
        const prefix = typedArrayStem(kind);
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
        }
        const sourceType = this.context.dataTypes.fromTsType(
            this.context.checker.getTypeAtLocation(unwrapped), unwrapped);
        // Generic typed-array parameters expose ArrayBufferLike in lib.d.ts,
        // while a reached native array carries only an ordinary ArrayBuffer.
        // Resolve that value before selecting the overload. A non-buffer
        // probe must discard emissions so length/sequence arguments run once.
        const source = this.context.probeEmission(() => {
            const value = this.compileDataPath(unwrapped, "read") ??
                (sourceType?.kind === "arraybuffer"
                    ? this.context.compileValue(unwrapped) : undefined);
            return value?.dataType?.kind === "arraybuffer" ? value : undefined;
        });
        if (source) {
            const arguments_ = expression.arguments ?? [];
            if (arguments_.length > 3) {
                this.context.fail(
                    expression,
                    `new ${name} over an ArrayBuffer expects an optional byte offset and length.`,
                );
            }
            // Constructor arguments evaluate left-to-right, including an
            // owner or numeric expression that changes another binding.
            const buffer = this.context.allocateTemporaryCppName("view_buffer");
            this.context.emit({ kind: "declaration", type: "const auto", name: buffer, initializer: source.cpp });
            const numericArgument = (argument: ts.Expression): string => {
                const value = this.context.compileNumber(argument, "double");
                const temporary = this.context.allocateTemporaryCppName("view_index");
                this.context.emit({ kind: "declaration", type: "const double", name: temporary, initializer: value });
                return name === "Uint8Array" ? `bbl::js::buffer_view_index(${temporary})` : temporary;
            };
            const offset = arguments_[1]
                ? `, ${numericArgument(arguments_[1])}`
                : "";
            const length = arguments_[2]
                ? `, ${numericArgument(arguments_[2])}`
                : "";
            return {
                kind: "data",
                cpp: `${this.context.dataTypes.cppType(dataType)}(${buffer}${offset}${length})`,
                dataType,
            };
        }
        if ((expression.arguments?.length ?? 0) > 1) {
            this.context.fail(
                expression,
                `new ${name} supports at most one argument unless it views an ArrayBuffer.`,
            );
        }
        const converted = this.context.probeEmission(() =>
            this.typedArrayFromSource(prefix, unwrapped));
        if (converted !== undefined) {
            return { kind: "data", cpp: converted, dataType };
        }
        return {
            kind: "data",
            cpp: `bbl::js::${prefix}_array_sized(${this.context.compileNumber(argument, "double")})`,
            dataType,
        };
    }

    /**
     * One numeric sequence converted into a typed array of `prefix`'s
     * kind, or undefined where the expression is not a sequence at all --
     * which is how the constructor tells a source from a length.
     *
     * Every conversion the spec performs when a typed array is BUILT from
     * a sequence is the conversion it performs when one is FILLED from the
     * same sequence, so this is the one rule and `compileTypedArraySet`
     * reads it too. `${prefix}_array_from` carries the target's own store
     * for each element, which is what a differing source kind, an ordinary
     * array and a plain-data tuple all pass through.
     *
     * `keepKind` is where the two callers part: a constructor must produce
     * a NEW array even from a source of its own kind, so it converts
     * unconditionally, while `set` copies such a source straight into the
     * target and names its kind here to say so.
     */
    private typedArrayFromSource(
        prefix: string,
        unwrapped: ts.Expression,
        keepKind?: TypedArrayKind,
    ): string | undefined {
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
            return this.typedArrayFromElements(
                prefix,
                elements,
                constant,
            );
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
            keepKind !== undefined &&
            staticSource?.kind === "data" &&
            staticSource.dataType?.kind === keepKind
        ) {
            return staticSource.cpp;
        }
        if (
            staticSource?.kind === "tuple" &&
            staticSource.tupleElements?.every(
                (entry) => entry.kind === "number",
            )
        ) {
            const elements = staticSource.tupleElements.map((entry) =>
                this.compileKnownValueForSink(entry, { kind: "number" }, unwrapped),
            );
            return this.typedArrayFromElements(
                prefix,
                elements,
                staticSource.tupleElements.every(entry => entry.staticNumber !== undefined),
            );
        }
        // A single argument that is itself an array is never the length
        // overload, so this precedes the sized fallback in the caller. Every
        // source converts element by element where the kinds differ -- what
        // `%TypedArray%(typedArray)` does, and what `${prefix}_array_from`
        // already applies to a `number[]` -- so one arm serves them all. A
        // runtime tuple joins them because its lanes are doubles too: the
        // three components of a colour a scene computed.
        if (
            staticSource?.kind === "data" &&
            (isTypedArrayType(staticSource.dataType) ||
                staticSource.dataType?.kind === "tuple" ||
                ((staticSource.dataType?.kind === "vector" ||
                    staticSource.dataType?.kind === "span") &&
                    staticSource.dataType.element.kind === "number"))
        ) {
            return `bbl::js::${prefix}_array_from(${staticSource.cpp})`;
        }
        return undefined;
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
     * expressions construct two arrays; only the immutable source is shared.
     * Float32 source tables apply the same narrowing as the destination store.
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
        const name = this.context.dataTypes.registerSharedConstantArray(
            `${prefix}_values`, prefix === "f32" ? "float" : "double",
            prefix === "f32" ? elements.map(element => typedArrayStoreExpression("f32array", element)) : [...elements],
        );
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
    /** Lowers selected branch preparation after the caller evaluates the condition once. */
    public compileConditionalForSink(
        unwrapped: ts.ConditionalExpression,
        dataType: DataType,
        condition: string,
        prepared?: Record<"whenTrue" | "whenFalse", { value: Value; lines: string[] }>,
    ): string {
        if (dataType.kind === "optional") {
            // The selected value is wrapped in `bbl::js::Nullable`
            // below, which is the data runtime's own type.
            this.context.reachJsData();
        }
        const compileBranch = (
            branch: ts.Expression,
            preparation?: { value: Value; lines: string[] },
        ): { cpp: string; lines: string[] } => {
            let compiled = "";
            const lines = this.context.captureEmittedLines(
                () => {
                    compiled = preparation
                        ? this.compileKnownValueForSink(preparation.value, dataType, branch)
                        : this.compileForSink(branch, dataType);
                },
            );
            return {
                cpp:
                    dataType.kind === "optional"
                        ? `${this.context.dataTypes.cppType(dataType)}{${compiled}}`
                        : compiled,
                lines: [...(preparation?.lines ?? []), ...lines],
            };
        };
        if (condition === "true" || condition === "false") {
            const selected = compileBranch(
                condition === "true"
                    ? unwrapped.whenTrue
                    : unwrapped.whenFalse,
                condition === "true" ? prepared?.whenTrue : prepared?.whenFalse,
            );
            for (const line of selected.lines) {
                this.context.emit(line);
            }
            return selected.cpp;
        }
        const whenTrue = compileBranch(unwrapped.whenTrue, prepared?.whenTrue);
        const whenFalse = compileBranch(unwrapped.whenFalse, prepared?.whenFalse);
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

    public compileForSink(
        expression: ts.Expression,
        dataType: DataType,
    ): string {
        if (this.context.options.workers && ts.isAwaitExpression(unwrapExpression(expression)))
            return this.compileKnownValueForSink(this.context.compileValue(expression), dataType, expression);
        const unwrapped = this.context.unwrap(expression);
        const nullableLogicalSink =
            dataType.kind === "optional" ||
            (dataType.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    dataType.name,
                ));
        if (
            nullableLogicalSink &&
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.BarBarToken &&
            (unwrapped.right.kind === ts.SyntaxKind.NullKeyword ||
                (ts.isIdentifier(unwrapped.right) &&
                    unwrapped.right.text === "undefined" &&
                    !this.context.lookupIdentifierValue(
                        unwrapped.right,
                    )))
        ) {
            const left = this.context.unwrap(unwrapped.left);
            if (
                ts.isBinaryExpression(left) &&
                left.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken
            ) {
                const condition = this.context.compileCondition(
                    left.left,
                );
                const dataCpp =
                    this.context.dataTypes.cppType(dataType);
                const empty =
                    dataType.kind === "optional"
                        ? `${dataCpp}{std::nullopt}`
                        : `${dataCpp}{}`;
                if (condition === "false") return empty;
                const selected = this.compileForSink(
                    left.right,
                    dataType,
                );
                if (condition === "true") return selected;
                return (
                    `(${condition} ? ${selected} : ` +
                    `${empty})`
                );
            }
        }
        // A conditional selects between two values of the sink's own
        // type, so each branch lowers for the same sink and the choice
        // stays where the source wrote it. Booleans keep their condition
        // compiler's surface. Numeric callers
        // use this same sink so branch preparation is guarded consistently.
        if (
            ts.isConditionalExpression(unwrapped) &&
            dataType.kind !== "boolean"
        ) {
            const condition = this.context.compileCondition(
                unwrapped.condition,
            );
            return this.compileConditionalForSink(unwrapped, dataType, condition);
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
        return compileDataExpressionSink(dataType, this, expression, unwrapped);
    }

    public compileKnownValueForSink(
        value: Value,
        dataType: DataType,
        node: ts.Node,
    ): string {
        if (dataType.kind === "handle" && dataType.handle === "engine" && value.kind === "engine") {
            this.context.useNativeValue(value);
            return `&(${value.cpp})`;
        }
        if (value.cameraVector) this.context.noteCameraVectorCopy(value, node);
        this.context.useNativeValue(value);
        // A stored tuple aliases its source. Once that alias leaves the local
        // binding graph, generation cannot retain a snapshot of its contents.
        if (value.dataType?.kind === "tuple") this.invalidateStaticElements(value);
        if (
            dataType.kind !== "optional" &&
            ts.isExpression(node)
        ) {
            value = this.narrowOptional(value, node);
        }
        if (
            dataType.kind !== "borrowed-platform-event" &&
            value.dataType &&
            this.spanCompatible(value.dataType, dataType)
        ) {
            return value.cpp;
        }
        // A parsed array reaching a fixed or growable numeric sink is the
        // lowering of the source's own assertion over it. Every lane is
        // `Number(element)`, so a lane the document does not carry is NaN
        // rather than a read past the end -- and the reached sources put
        // the assertion behind their own length/type guard.
        if (
            isJsonValue(value)
        ) {
            if (dataType.kind === "tuple") {
                this.context.reachJsData();
                return `bbl::js::json_tuple<${dataType.arity}>(${value.cpp})`;
            }
            if (
                (dataType.kind === "vector" || dataType.kind === "span") &&
                dataType.element.kind === "number"
            ) {
                this.context.reachJsData();
                return `bbl::js::json_number_array(${value.cpp})`;
            }
            if (
                (dataType.kind === "vector" || dataType.kind === "span") &&
                dataType.element.kind === "string"
            ) {
                this.context.reachJsData();
                return `bbl::js::json_string_array(${value.cpp})`;
            }
        }
        const compiled = compileDataValueSink(dataType, this, value, node);
        if (compiled !== undefined) return compiled;
        this.context.fail(
            node,
            `Compile-time ${value.kind} value does not match the expected data ${dataType.kind} ` +
                `(valueType=${JSON.stringify(value.dataType)}, nativeParameters=${JSON.stringify(value.nativeCallbackParameterTypes)}, nativeReturn=${JSON.stringify(value.nativeCallbackReturnType)}, cpp=${value.cpp.length > 0}).`,
        );
    }

    public spanLikeForSink(
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
                ? withNativeMetadata(this.leafValue(
                          `(*${rawValue.cpp})`,
                          rawValue.dataType.inner,
                      ), rawValue)
                : rawValue;
        if (value.dataType?.kind === "tuple") this.invalidateStaticElements(value);
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
            dataType.kind === "span" &&
            dataType.element.kind === "number" &&
            value.dataType.kind === "f32array"
        ) {
            // ArrayLike<number> observes Float32Array lanes as JavaScript
            // numbers. Materialize that widening in a named local: the native
            // callee takes span<const double>, and the local keeps its backing
            // storage alive for the complete call.
            const widened =
                this.context.allocateTemporaryCppName(
                    "array_like_numbers",
                );
            this.context.reachJsData();
            this.context.emit(
                `const bbl::js::F64Array ${widened}(` +
                    `${value.cpp}.begin(), ${value.cpp}.end());`,
            );
            this.registerLocal(widened, "owned");
            return widened;
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

    public requireDataValue(
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
    public enumMapLiteral(
        literal: ts.ObjectLiteralExpression,
        dataType: DataType & { kind: "enummap" },
    ): string {
        const members =
            this.context.dataTypes.enumMembers(
                dataType.enumName,
            );
        const compiled = new EmissionMap<string, string>();
        const written: string[] = [];
        const literalKeys = this.literalKeyOrder(literal);
        const reordered = members.some((member, index) => literalKeys[index] !== member) ||
            literal.properties.length !== members.length ||
            literal.properties.some(property => property.name && ts.isComputedPropertyName(property.name));
        for (const property of literal.properties) {
            if (!ts.isPropertyAssignment(property)) {
                this.context.fail(
                    property,
                    "Record literals support plain property assignments.",
                );
            }
            const name = this.context.propertyName(property.name);
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
            written.push(name);
            let slot = this.compileForSink(property.initializer, dataType.element);
            if (reordered) {
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "slot",
                    );
                this.context.emit(
                    { kind: "declaration", type: this.context.dataTypes.cppType(dataType.element), name: temporary, initializer: slot },
                );
                this.registerLocal(temporary, "owned");
                slot = temporary;
            }
            compiled.set(name, slot);
        }
        this.evaluatedLiteralKeys.set(literal, written);
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

    public openRecordLiteral(
        literal: ts.ObjectLiteralExpression,
        dataType: DataType & { kind: "map" },
    ): string {
        if (literal.properties.some(ts.isSpreadAssignment)) {
            const result = this.context.allocateTemporaryCppName("record_spread");
            this.context.reachJsData();
            this.context.emit(`${this.context.dataTypes.cppType(dataType)} ${result};`);
            for (const property of literal.properties) {
                if (ts.isSpreadAssignment(property)) {
                    const source = this.context.compileValue(property.expression);
                    if (source.kind === "json-null") continue;
                    const value = this.compileKnownValueForSink(source, dataType, property);
                    const entry = this.context.allocateTemporaryCppName("spread_entry");
                    this.context.emit(`for (const auto& ${entry} : ${value}) ${result}.set(${entry}.first, ${entry}.second);`);
                    continue;
                }
                if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
                    this.context.fail(property, "Dictionary literals support properties, shorthand properties, and spreads.");
                const name = property.name;
                const key = ts.isComputedPropertyName(name)
                    ? this.compileForSink(name.expression, dataType.key)
                    : dataType.key.kind === "string" ? this.context.cppString(name.text)
                        : doubleLiteral(Number(name.text));
                const keyName = this.context.allocateTemporaryCppName("record_key");
                this.context.emit(`const auto ${keyName} = ${key};`);
                const value = this.compileForRetainedSink(
                    ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
                    dataType.value, "Record entry");
                this.context.emit(`${result}.set(${keyName}, ${value});`);
            }
            this.registerLocal(result, "owned");
            return result;
        }
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
            return `{${key}, ${this.compileForRetainedSink(
                property.initializer,
                dataType.value,
                "Record entry",
            )}}`;
        });
        this.context.reachJsData();
        return `${this.context.dataTypes.cppType(dataType)}{${entries.join(", ")}}`;
    }

    /**
     * The keys of a literal, in the order they were written.
     */
    public literalKeyOrder(
        literal: ts.ObjectLiteralExpression,
    ): string[] {
        return this.evaluatedLiteralKeys.get(literal) ?? literal.properties.flatMap((property) =>
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
        const provided = new EmissionMap<
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
            const initializer = provided.get(field.sourceName);
            if (!initializer) {
                if (field.defaultWhenMissing) {
                    return "{}";
                }
                if (field.type.kind === "optional") {
                    return "std::nullopt";
                }
                this.context.fail(
                    literal,
                    `Struct literal is missing field '${field.sourceName}'.`,
                );
            }
            provided.delete(field.sourceName);
            if (ts.isMethodDeclaration(initializer)) {
                if (field.type.kind !== "function") {
                    this.context.fail(
                        initializer,
                        `Method '${field.sourceName}' requires a stored function field.`,
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
        const assigned = new EmissionSet<string>();
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
                    const targetFields = new EmissionMap(
                        this.context.dataTypes
                            .structFields(dataType.name, property)
                            .map((field) => [
                                field.sourceName,
                                field,
                            ]),
                    );
                    for (const sourceField of this.context.dataTypes.structFields(
                        spread.dataType.name,
                        property,
                    )) {
                        const targetField = targetFields.get(
                            sourceField.sourceName,
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
        if (
            this.context.dataTypes.carriesBorrowedPlatformEvent(
                target.dataType,
            )
        ) {
            const value = this.context.compileValue(expression.right);
            this.context.refuseBorrowedPlatformEventEscape(
                value,
                expression.right,
                "a reassigned local",
            );
        }
        const referenceRebind = isOpaqueReference(target.dataType) || ["vector", "tuple", "product"].includes(kind);
        // An array, map or set copies its reference, and a reference
        // struct its handle, so rebinding a nullable local to another one
        // aliases exactly as JavaScript does.
        const referenceInner =
            target.dataType.kind === "optional" &&
            (isOpaqueReference(target.dataType.inner) || ["vector", "tuple", "product"].includes(target.dataType.inner.kind) ||
                target.dataType.inner.kind === "map" ||
                target.dataType.inner.kind === "set" ||
                (target.dataType.inner.kind === "struct" &&
                    this.context.dataTypes.isReferenceStruct(target.dataType.inner.name)));
        const optionalRebind =
            referenceInner ||
            (target.dataType.kind === "optional" &&
            (target.dataType.inner.kind === "number" ||
                target.dataType.inner.kind === "boolean" ||
                target.dataType.inner.kind === "string" ||
                target.dataType.inner.kind === "enum" ||
                target.dataType.inner.kind === "handle" ||
                // Owned typed arrays and byte-backed views both copy shared
                // wrappers, including a view returned by a helper.
                isTypedArrayType(target.dataType.inner) ||
                ((target.dataType.inner.kind === "map" ||
                    target.dataType.inner.kind === "set") &&
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
                identifierText(this.context.unwrap(expression.right)) ===
                    "undefined"));
        if (
            kind !== "number" &&
            kind !== "boolean" &&
            kind !== "string" &&
            kind !== "enum" &&
            kind !== "handle" &&
            kind !== "function" &&
            !isTypedArrayType(target.dataType) &&
            // JsonValue copies its array/object storage by shared pointer, so
            // assigning a freshly parsed dynamic document preserves the
            // JavaScript object identity of that value rather than deep-copying
            // the graph.
            kind !== "json" &&
            !(
                kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    target.dataType.name,
                )
            ) &&
            !optionalRebind &&
            !referenceRebind
        ) {
            this.context.fail(
                expression,
                `'${left.text}' holds a ${kind}; rebinding it would copy in native code where JavaScript would alias, so assign through a field or element instead.`,
            );
        }
        const value = this.compileForSink(
            expression.right,
            target.dataType,
        );
        this.context.emit(`${target.cpp} = ${value};`);
        const rebound = this.context.recordDataAssignmentMetadata(
            target,
            expression.right,
            left,
        );
        if (!rebound) this.invalidateStaticElements(target);
        return true;
    }

    /**
     * `delete object[key]` removes a dictionary entry; `delete object.field`
     * clears an optional struct field or drops a compile-time record's
     * property. Anything else has no native removal to lower to.
     */
    public emitDelete(expression: ts.DeleteExpression): void {
        const target = this.context.unwrap(expression.expression);
        if (ts.isElementAccessExpression(target)) {
            const recordOwner = ts.isIdentifier(target.expression)
                ? this.context.lookupIdentifierValue(target.expression)
                : undefined;
            const key = this.context.compileValue(target.argumentExpression);
            if (recordOwner?.kind === "record") {
                if (recordOwner.moduleNamespace) this.context.fail(expression, "Module namespace properties are read-only.");
                if (key.staticString === undefined) {
                    this.context.fail(target.argumentExpression, "Deleting a compile-time record property requires a static key.");
                }
                if (this.context.isInRuntimeControlFlow()) {
                    this.context.fail(expression, "A compile-time record cannot be edited from runtime control flow.");
                }
                delete recordOwner.recordProperties?.[key.staticString];
                return;
            }
            const owner = this.compileDataPath(target.expression, "read");
            const narrowed = owner?.kind === "data"
                ? this.narrowOptional(owner, target.expression)
                : undefined;
            if (narrowed?.dataType?.kind === "map") {
                this.context.reachJsData();
                const keyCpp = this.compileKnownValueForSink(key, narrowed.dataType.key, target.argumentExpression);
                this.context.emit(`static_cast<void>(${narrowed.cpp}.erase(${keyCpp}));`);
                this.context.invalidateRecordProperties(narrowed);
                return;
            }
        }
        if (ts.isPropertyAccessExpression(target)) {
            const recordOwner = this.context.resolveRecordValue(target.expression);
            if (recordOwner?.kind === "record") {
                if (recordOwner.moduleNamespace) this.context.fail(expression, "Module namespace properties are read-only.");
                if (this.context.isInRuntimeControlFlow()) {
                    this.context.fail(expression, "A compile-time record cannot be edited from runtime control flow.");
                }
                delete recordOwner.recordProperties?.[target.name.text];
                return;
            }
            const field = this.compileDataPath(target, "write");
            if (field?.kind === "data" && field.dataType?.kind === "optional") {
                this.context.reachJsData();
                this.context.emit(`${field.cpp} = std::nullopt;`);
                this.invalidateStaticElements(field);
                return;
            }
            if (field) {
                this.context.fail(
                    target,
                    `'${target.name.text}' is a required field of its type; only an optional field can be deleted.`,
                );
            }
        }
        this.context.fail(
            expression,
            "delete is lowered for dictionary entries, optional struct fields and compile-time record properties.",
        );
    }

    /** `key in object` as a condition. */
    public compileInOperator(expression: ts.BinaryExpression): string {
        const key = this.context.compileValue(expression.left);
        const owner = this.context.compileValue(expression.right);
        return this.membershipCpp(owner, expression.right, key, expression.left, "in");
    }

    /**
     * Whether `owner` carries `key`, as a condition. A compile-time record
     * answers from its properties and a dictionary from its native
     * membership. `in` also asks a struct, which answers from its type: a
     * required field is always present and an optional one is present when
     * it holds a value. `Object.hasOwn` declines a struct, whose fields are
     * its type's rather than the object's own.
     */
    public membershipCpp(
        owner: Value,
        ownerNode: ts.Expression,
        key: Value,
        keyNode: ts.Expression,
        operator: "in" | "Object.hasOwn",
    ): string {
        const narrowed = owner.kind === "data"
            ? this.narrowOptional(owner, ownerNode)
            : owner;
        if (narrowed.kind === "record") {
            const keys = [...new Set([narrowed.recordProperties, narrowed.recordMethods,
                narrowed.recordGetters, narrowed.recordSetters].flatMap(fields => Object.keys(fields ?? {})))];
            if (key.staticString !== undefined) return keys.includes(key.staticString) ? "true" : "false";
            const name = this.context.allocateTemporaryCppName("property_key");
            this.context.emit(`[[maybe_unused]] const std::string ${name} = ${this.compileKnownValueForSink(key, {kind:"string"}, keyNode)};`);
            return keys.length ? `(${keys.map(key => `${name} == ${this.context.cppString(key)}`).join(" || ")})` : "false";
        }
        const dataType = narrowed.dataType;
        if (narrowed.kind === "data" && dataType?.kind === "map") {
            this.context.reachJsData();
            const keyCpp = this.compileKnownValueForSink(key, dataType.key, keyNode);
            return `${narrowed.cpp}.has(${keyCpp})`;
        }
        if (operator === "in" && narrowed.kind === "data" && dataType?.kind === "struct") {
            if (key.staticString === undefined) {
                this.context.fail(keyNode, "'in' over a struct requires a static key.");
            }
            const field = this.context.dataTypes
                .structFields(dataType.name, ownerNode)
                .find((candidate) => candidate.sourceName === key.staticString);
            if (!field) {
                return "false";
            }
            if (field.type.kind !== "optional") {
                return "true";
            }
            const access = this.context.dataTypes.isReferenceStruct(dataType.name) ? "->" : ".";
            return `${narrowed.cpp}${access}${field.name}.has_value()`;
        }
        return this.context.fail(
            ownerNode,
            operator === "in"
                ? "'in' is decided for compile-time records, dictionaries and structs."
                : "Object.hasOwn is decided for compile-time records and string-keyed dictionaries; a struct's fields are its type's.",
        );
    }

    /**
     * Whether the checker declares `expression` as a string-keyed
     * dictionary: a `Record<string, T>` alias or an object type carrying a
     * string index signature. Read off the type alone, so asking costs no
     * emission and allocates nothing.
     */
    public declaredAsDictionary(expression: ts.Expression): boolean {
        const type = this.context.checker.getNonNullableType(
            this.context.checker.getTypeAtLocation(expression),
        );
        if ((type.flags & ts.TypeFlags.Object) === 0) {
            return false;
        }
        if (type.aliasSymbol?.name === "Record") {
            const [key] = type.aliasTypeArguments ?? [];
            return key !== undefined && (key.flags & ts.TypeFlags.String) !== 0;
        }
        return this.context.checker.getIndexInfoOfType(type, ts.IndexKind.String) !== undefined;
    }

    /**
     * `dictionary[key]` or `dictionary.name` as an assignment target: the
     * map and the key expression, when the owner is a map. Asked of the
     * checker first, so a struct field store never pays for a probe that
     * resolves its owner and discards it.
     */
    private dictionaryEntryTarget(
        left: ts.Expression,
    ): { owner: Value; dataType: DataType & { kind: "map" }; keyCpp: string } | undefined {
        if (
            (!ts.isElementAccessExpression(left) && !ts.isPropertyAccessExpression(left)) ||
            !this.declaredAsDictionary(left.expression)
        ) {
            return undefined;
        }
        const owner = this.context.probeEmission(() => {
            const path = this.compileDataPath(left.expression, "read");
            const candidate = path?.kind === "data" ? this.narrowOptional(path, left.expression) : undefined;
            return candidate?.dataType?.kind === "map" ? candidate : undefined;
        });
        if (!owner || owner.dataType?.kind !== "map") {
            return undefined;
        }
        const dataType = owner.dataType;
        if (ts.isPropertyAccessExpression(left)) {
            if (dataType.key.kind !== "string") return undefined;
            return { owner, dataType, keyCpp: this.context.cppString(left.name.text) };
        }
        const key = this.context.compileValue(left.argumentExpression);
        return {
            owner,
            dataType,
            keyCpp: this.compileKnownValueForSink(key, dataType.key, left.argumentExpression),
        };
    }

    private emitLogicalEntryAssignment(
        expression: ts.BinaryExpression,
        entry: { owner: Value; dataType: DataType & { kind: "map" }; keyCpp: string },
    ): void {
        this.context.reachJsData();
        const key = this.context.allocateTemporaryCppName("entry_key");
        this.context.emit(`const auto ${key} = ${entry.keyCpp};`);
        const guard = this.logicalAssignmentGuard(expression, `!${entry.owner.cpp}.has(${key})`);
        this.emitGuardedStore(guard, () => {
            const value = this.compileForSink(expression.right, entry.dataType.value);
            this.context.emit(`${entry.owner.cpp}.set(${key}, ${value});`);
            this.context.invalidateRecordProperties(entry.owner);
        });
    }

    /**
     * The condition under which a logical assignment stores: `nullish`
     * spells the `??=` test, and the other two read the target's
     * truthiness. A condition the model settled folds to `true`/`false`.
     */
    private logicalAssignmentGuard(expression: ts.BinaryExpression, nullish: string): string {
        const kind = expression.operatorToken.kind;
        if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
            return nullish;
        }
        const truthy = this.context.compileCondition(expression.left);
        if (kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
            return truthy;
        }
        return truthy === "true" ? "false" : truthy === "false" ? "true" : `!(${truthy})`;
    }

    /**
     * Emits `store`'s lines under `guard`, as the runtime control flow the
     * plain assignment's bookkeeping treats as a conditional write. A guard
     * the model settled emits the lines bare (`true`) or nothing (`false`),
     * so a store that never happens compiles no right side either.
     */
    private emitGuardedStore(guard: string, store: () => void): void {
        if (guard === "false") {
            return;
        }
        this.context.enterRuntimeControlFlow();
        let lines: string[];
        try {
            lines = this.context.captureEmittedLines(store);
        } finally {
            this.context.leaveRuntimeControlFlow();
        }
        if (guard === "true") {
            for (const line of lines) this.context.emit(line);
            return;
        }
        this.context.emit(`if (${guard}) {`);
        this.context.increaseIndent();
        for (const line of lines) this.context.emit(line);
        this.context.decreaseIndent();
        this.context.emit("}");
    }

    /** String-valued logical operators keep the selected value and a lazy RHS. */
    public compileStringLogicalValue(expression: ts.BinaryExpression): Value {
        const left = this.context.pinValueToTemporary(this.context.compileValue(expression.left), "logical_left", expression.left);
        const condition = this.conditionFromValue(left);
        if (condition === undefined) this.context.fail(expression.left, "Logical string selection requires a truth-testable left operand.");
        const isAnd = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
        const result = this.context.allocateTemporaryCppName("logical_string");
        const selected = this.compileKnownValueForSink(this.narrowOptional(left, expression.left, true), { kind: "string" }, expression.left);
        this.context.emit(`std::string ${result} = ${condition} ? ${selected} : std::string{};`);
        this.emitGuardedStore(isAnd ? condition : `!(${condition})`, () => {
            const right = this.compileForSink(expression.right, { kind: "string" });
            this.context.emit(`${result} = ${right};`);
        });
        return { kind: "string", cpp: result };
    }

    /**
     * `a ??= b`, `a ||= b` and `a &&= b` over the data model.
     *
     * The target is read for the guard and written for the store, which is
     * JavaScript's own reference-then-assign order for a call-free target;
     * a target containing a call refuses rather than run it twice. The
     * right side compiles inside the guarded block, so it is evaluated
     * only when the store happens, and a target the model proves never
     * nullish (`??=` on a plain number) emits nothing at all, exactly as
     * JavaScript never evaluates that right side. The store runs as
     * runtime control flow, so the plain assignment's bookkeeping treats
     * it as the conditional write it is.
     */
    public emitLogicalAssignment(expression: ts.BinaryExpression): void {
        const left = this.context.unwrap(expression.left);
        if (
            someAnalysisNode(
                left,
                (node) => ts.isCallExpression(node) || ts.isNewExpression(node),
            )
        ) {
            this.context.fail(
                left,
                "A logical assignment target must not contain a call; bind the call's result to a local first.",
            );
        }
        // A dictionary entry has no native lvalue: its presence is the
        // guard and the store is `set`.
        const entry = this.dictionaryEntryTarget(left);
        if (entry) {
            this.emitLogicalEntryAssignment(expression, entry);
            return;
        }
        // A plain number, boolean or string local is a native scalar rather
        // than a data value; it stores the way its plain assignment does.
        const bound = ts.isIdentifier(left)
            ? this.context.lookupIdentifierValue(left)
            : undefined;
        const target =
            bound &&
            (bound.kind === "number" || bound.kind === "boolean" || bound.kind === "string")
                ? bound
                : this.compileDataPath(left, ts.isIdentifier(left) ? "read" : "write");
        const scalarKind =
            target && (target.kind === "number" || target.kind === "boolean" || target.kind === "string")
                ? target.kind
                : undefined;
        if (
            !target ||
            target.freshData ||
            (!scalarKind && (target.kind !== "data" || !target.dataType))
        ) {
            this.context.fail(
                expression.operatorToken,
                `'${expression.operatorToken.getText()}' requires a data-model target; ` +
                    "a compile-time record or an engine handle takes an explicit conditional assignment.",
            );
        }
        if (target.dataStore) {
            this.context.fail(
                left,
                "A logical assignment into a typed-array lane is not lowered; store the selected value explicitly.",
            );
        }
        const targetType = target.dataType;
        const nullish = expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
        if (nullish && (scalarKind || targetType?.kind !== "optional")) {
            // A non-nullable target never takes the right side.
            return;
        }
        if (nullish) {
            this.context.reachJsData();
        }
        const guard = this.logicalAssignmentGuard(expression, `!(${target.cpp}).has_value()`);
        this.emitGuardedStore(guard, () => {
            const value = scalarKind === "number"
                ? this.context.compileNumber(expression.right, "double")
                : scalarKind === "boolean"
                  ? this.context.compileCondition(expression.right)
                  : scalarKind === "string"
                    ? this.compileKnownValueForSink(
                          this.context.compileValue(expression.right),
                          { kind: "string" },
                          expression.right,
                      )
                    : this.compileForSink(expression.right, targetType!);
            this.context.emit(`${target.cpp} = ${value};`);
            if (scalarKind) {
                return;
            }
            if (ts.isIdentifier(left)) {
                const rebound = this.context.recordDataAssignmentMetadata(
                    target,
                    expression.right,
                    left,
                );
                if (!rebound) this.invalidateStaticElements(target);
            } else {
                this.invalidateStaticElements(target);
                const root = rootIdentifier(left, (chain) =>
                    this.context.unwrap(chain),
                );
                const rootValue = root
                    ? this.context.lookupIdentifierValue(root)
                    : undefined;
                if (rootValue) {
                    this.invalidateStaticElements(rootValue);
                    this.context.invalidateRecordProperties(rootValue);
                }
            }
        });
    }

    public emitAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        const operator = new EmissionMap<ts.SyntaxKind, string>([
            [ts.SyntaxKind.EqualsToken, "="],
            [ts.SyntaxKind.PlusEqualsToken, "+="],
            [ts.SyntaxKind.MinusEqualsToken, "-="],
            [ts.SyntaxKind.AsteriskEqualsToken, "*="],
            [ts.SyntaxKind.SlashEqualsToken, "/="],
            [ts.SyntaxKind.PercentEqualsToken, "%="],
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
            // The TRS trio plus camera `target` and light `direction`: the
            // engine vectors whose component writes carry side effects.
            (isTrsVectorName(left.expression.name.text) ||
                left.expression.name.text === "target" ||
                left.expression.name.text === "direction")
        ) {
            const ownerExpression = this.context.unwrap(
                left.expression.expression,
            );
            const boundOwner =
                ts.isIdentifier(ownerExpression)
                    ? this.context.lookupIdentifierValue(
                          ownerExpression,
                      )
                    : ts.isPropertyAccessExpression(
                            ownerExpression,
                        ) &&
                          ownerExpression.expression.kind ===
                              ts.SyntaxKind.ThisKeyword
                      ? this.context.resolveThisField(
                            ownerExpression.name.text,
                        )
                      : undefined;
            if (
                boundOwner &&
                (boundOwner.kind === "mesh" ||
                    boundOwner.kind === "transform-node" ||
                    boundOwner.kind === "camera" ||
                    boundOwner.kind === "light")
            ) {
                return false;
            }
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
            const root = rootIdentifier(node, (chain) =>
                this.context.unwrap(chain),
            );
            if (root) {
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
            const recordOwner = ts.isIdentifier(left.expression)
                ? this.context.lookupIdentifierValue(left.expression)
                : undefined;
            if (recordOwner?.kind === "record") {
                if (operator !== "=") {
                    this.context.fail(
                        expression,
                        "Compile-time record entries support plain assignment only.",
                    );
                }
                const key = this.context.compileValue(
                    left.argumentExpression,
                );
                if (key.staticString === undefined) {
                    this.context.fail(
                        left.argumentExpression,
                        "A compile-time record assignment requires a static string key.",
                    );
                }
                if (this.context.isInRuntimeControlFlow()) {
                    this.context.fail(
                        expression,
                        "A compile-time record cannot be populated from runtime control flow.",
                    );
                }
                const assigned = this.context.compileValue(
                    expression.right,
                );
                if (recordOwner.moduleNamespace) this.context.fail(expression, "Module namespace properties are read-only.");
                (recordOwner.recordProperties ??= {})[
                    key.staticString
                ] = assigned;
                return true;
            }
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
                if (
                    this.context.dataTypes.carriesBorrowedPlatformEvent(
                        narrowed.dataType.key,
                    )
                ) {
                    this.context.refuseBorrowedPlatformEventEscape(
                        keyValue,
                        left.argumentExpression,
                        "Map key assignment",
                    );
                }
                if (
                    this.context.dataTypes.carriesBorrowedPlatformEvent(
                        narrowed.dataType.value,
                    )
                ) {
                    this.context.refuseBorrowedPlatformEventEscape(
                        assignedValue,
                        expression.right,
                        "Map value assignment",
                    );
                }
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
        if (ts.isPropertyAccessExpression(left)) {
            // `dictionary.name = value`: the named member is an entry.
            const entry = this.dictionaryEntryTarget(left);
            if (entry) {
                if (operator !== "=") {
                    this.context.fail(expression, "Dictionary members support plain assignment only.");
                }
                const assigned = this.context.compileValue(expression.right);
                const value = this.compileKnownValueForSink(assigned, entry.dataType.value, expression.right);
                this.context.reachJsData();
                this.context.emit(`${entry.owner.cpp}.set(${entry.keyCpp}, ${value});`);
                this.context.invalidateRecordProperties(entry.owner);
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
        const targetRoot = rootExpression(left, (chain) =>
            this.context.unwrap(chain),
        );
        const invalidateRootRecordSnapshot = (): void => {
            if (
                !ts.isPropertyAccessExpression(left) ||
                !ts.isIdentifier(targetRoot) ||
                !ts.isIdentifier(this.context.unwrap(left.expression))
            ) {
                return;
            }
            const root = this.context.lookupIdentifierValue(targetRoot);
            if (
                root?.dataType?.kind === "struct" &&
                root.recordProperties
            ) {
                // A direct write invalidates that field's static fact, not
                // unrelated fields on the same object. The property snapshot
                // object is shared by aliases, so deleting in place updates
                // every view while preserving immutable dimensions/constants.
                delete root.recordProperties[left.name.text];
            }
        };
        if (
            target.dataType &&
            this.context.dataTypes.carriesBorrowedPlatformEvent(
                target.dataType,
            )
        ) {
            const value = this.context.compileValue(expression.right);
            this.context.refuseBorrowedPlatformEventEscape(
                value,
                expression.right,
                ts.isElementAccessExpression(left)
                    ? "container element assignment"
                    : targetRoot.kind === ts.SyntaxKind.ThisKeyword ||
                        target.classStoredField
                      ? "class field assignment"
                      : "data field assignment",
            );
        }
        // A declared engine property can expose a freshly materialized data
        // value for reads (mesh.boundMin is one). Assigning to that helper's
        // return value would only mutate a temporary; let the property layer
        // handle the owner's real setter instead.
        if (target.freshData) {
            return false;
        }
        if (target.kind === "number") {
            let targetCpp = target.cpp;
            let previous = target.cpp;
            if (target.dataStore) {
                targetCpp = this.context.allocateTemporaryCppName("typed_slot");
                this.context.emit({ kind: "declaration", type: "auto&&", name: targetCpp, initializer: target.cpp });
                if (operator !== "=") {
                    previous = this.context.allocateTemporaryCppName("typed_previous");
                    this.context.emit({ kind: "declaration", type: "const double", name: previous, initializer: `static_cast<double>(${targetCpp})` });
                }
            }
            const right = this.context.compileNumber(
                expression.right,
                "double",
            );
            const helper = new EmissionMap<string, string>([
                ["%=", "remainder_js"],
                ["&=", "bitwise_and"],
                ["|=", "bitwise_or"],
                ["^=", "bitwise_xor"],
                ["<<=", "shift_left"],
                [">>=", "shift_right"],
                [">>>=", "shift_right_unsigned"],
            ]).get(operator);
            const assigned = helper
                ? `bbl::js::${helper}(${previous}, ${right})`
                : undefined;
            if (helper) {
                this.context.reachJsData();
            }
            if (target.dataStore) {
                const arithmetic = new EmissionMap([["+=", "+"], ["-=", "-"], ["*=", "*"], ["/=", "/"]]).get(operator);
                if (operator !== "=" && !assigned && !arithmetic) {
                    this.context.fail(
                        expression,
                        "This typed-array compound assignment is not supported.",
                    );
                }
                const stored = assigned ?? (arithmetic ? `(${previous} ${arithmetic} ${right})` : right);
                this.context.emit(
                    `${targetCpp} = ${typedArrayStoreExpression(target.dataStore, stored)};`,
                );
                invalidateRootRecordSnapshot();
                return true;
            }
            this.context.emit(
                assigned
                    ? `${target.cpp} = ${assigned};`
                    : `${target.cpp} ${operator} ${right};`,
            );
            invalidateRootRecordSnapshot();
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
            invalidateRootRecordSnapshot();
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
                invalidateRootRecordSnapshot();
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
                invalidateRootRecordSnapshot();
                return true;
            }
            const value = this.compileForSink(
                expression.right,
                target.dataType,
            );
            this.context.emit(`${target.cpp} = ${value};`);
            this.context.recordDataAssignmentMetadata(
                target,
                expression.right,
                expression.left,
            );
            invalidateRootRecordSnapshot();
            return true;
        }
        return false;
    }

    private emitSwapAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        const left = this.context.unwrap(expression.left);
        const right = this.context.unwrap(expression.right);
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
                { kind: "declaration", type: "const double", name: name, initializer: source },
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
                    element.kind === "date" ||
                    element.kind === "date-time-format" ||
                    element.kind === "storage" ||
                    element.kind === "vector" ||
                    element.kind === "map" ||
                    element.kind === "set" ||
                    element.kind === "arraybuffer" ||
                    element.kind === "dataview" ||
                    element.kind === "bufferview" ||
                    element.kind === "numberindex" ||
                    isTypedArrayType(element) ||
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
        if (value.kind === "data" && isOpaqueReference(value.dataType)) {
            return value.truthinessCpp ?? value.optionalFoundCpp ?? `static_cast<bool>(${value.cpp})`;
        }
        if (value.kind === "data" && value.dataType?.kind === "product") {
            return value.truthinessCpp ?? value.optionalFoundCpp ?? "true";
        }
        if (value.kind === "data" && value.dataType?.kind === "union") {
            return `bbl::js::union_truthy(${value.cpp})`;
        }
        if (value.kind === "boolean" || (value.kind === "data" && value.dataType?.kind === "boolean")) {
            const boolean = value.staticBoolean === undefined
                ? value.cpp
                : value.staticBoolean
                  ? "true"
                  : "false";
            return value.optionalFoundCpp === undefined
                ? boolean
                : `(${value.optionalFoundCpp} && ${boolean})`;
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
            // Present arrays and objects are truthy even when empty.
            // Specialized records can also carry an optional-presence
            // guard instead of storing a native optional value.
            return value.truthinessCpp ?? value.optionalFoundCpp ?? "true";
        }
        if (
            value.kind === "data" &&
            value.dataType !== undefined &&
            (isTypedArrayType(value.dataType) || [
                "vector",
                "span",
                "tuple",
                "table",
                "map",
                "set",
                "arraybuffer",
                "dataview",
                "bufferview",
                "numberindex",
            ].includes(value.dataType.kind))
        ) {
            // JavaScript containers and typed arrays are objects and are
            // therefore truthy even when their native storage is empty.
            return "true";
        }
        if (
            isJsonValue(value)
        ) {
            // A parsed document is JavaScript-falsy exactly where the
            // browser says: `null`, an absent property, `false`, `0`, NaN
            // and the empty string.
            return `${value.cpp}.truthy()`;
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
        if (value.kind === "file") {
            // FileList index zero uses an empty opaque handle for absence.
            // A selected File is an object and therefore truthy regardless of
            // its contents; cancellation is the empty handle.
            return `static_cast<bool>(${value.cpp})`;
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
            if (["boolean", "string", "number"].includes(value.dataType.inner.kind)) {
                this.context.reachJsData();
                return `bbl::js::nullable_truthy(${value.cpp})`;
            }
            const inner = value.dataType.inner;
            if (inner.kind === "union") {
                return `([](const auto& value) { return value.has_value() && bbl::js::union_truthy(*value); }(${value.cpp}))`;
            }
            if (inner.kind === "enum" && this.context.dataTypes.enumMembers(inner.name).includes("")) {
                const empty = this.context.dataTypes.enumMemberCpp(inner, "", this.context.sourceFile);
                return `([](const auto& value) { return value.has_value() && *value != ${empty}; }(${value.cpp}))`;
            }
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

    public equalityComparison(
        expression: ts.BinaryExpression,
    ): string | undefined {
        const negated =
            expression.operatorToken.kind ===
                ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
        const loose = expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
            expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
        if (
            expression.operatorToken.kind !==
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            !negated && !loose
        ) {
            return undefined;
        }
        const left = this.context.options.workers ? unwrapExpression(expression.left) : this.context.unwrap(expression.left);
        const right = this.context.options.workers ? unwrapExpression(expression.right) : this.context.unwrap(expression.right);
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
        const isNullish = (candidate: ts.Expression): boolean => {
            if (candidate.kind === ts.SyntaxKind.NullKeyword) {
                return true;
            }
            if (!ts.isIdentifier(candidate)) {
                return false;
            }
            const bound = this.context.lookupOptional(candidate);
            return (
                bound?.kind === "json-null" ||
                (candidate.text === "undefined" && bound === undefined)
            );
        };
        if (loose && !isNullish(left) && !isNullish(right)) return undefined;
        // A parsed document compares strictly: it is equal to a scalar
        // only when it holds a value of that very type, and equal to
        // `null` or `undefined` only when it is that one. Nothing here
        // coerces, because `===` does not.
        const documentSide = isJsonRootedExpression(this.context, left)
            ? left
            : isJsonRootedExpression(this.context, right)
              ? right
              : undefined;
        if (documentSide) {
            const other = documentSide === left ? right : left;
            const document = this.context.compileValue(documentSide);
            if (isJsonValue(document)) {
                if (loose) {
                    const temporary = this.context.allocateTemporaryCppName("nullish_compare");
                    this.context.emit({ kind: "declaration", type: "const auto", name: temporary, initializer: document.cpp });
                    const equal = `(${temporary}.is_null() || ${temporary}.is_undefined())`;
                    return negated ? `!${equal}` : equal;
                }
                const compare = compileJsonStrictComparison(
                    this.context,
                    document.cpp,
                    other,
                    isNullish(other),
                    (value) =>
                        this.compileForSink(value, { kind: "string" }),
                );
                if (compare !== undefined) {
                    return negated ? `!(${compare})` : compare;
                }
            }
        }
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
            if (value?.dataType?.kind === "function") {
                return `${negated ? "" : "!"}static_cast<bool>(${value.cpp})`;
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
        const optionalComparable = (
            dataType: DataType | undefined,
        ): dataType is Extract<DataType, { kind: "optional" }> =>
            dataType?.kind === "optional" &&
            (["number", "boolean", "string", "enum", "handle", "date", "date-time-format", "storage", "arraybuffer", "dataview", "bufferview", "numberindex"].includes(
                dataType.inner.kind,
            ) || isTypedArrayType(dataType.inner));
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
            if (ts.isIdentifier(unwrapped)) {
                const bound = this.context.lookupIdentifierValue(unwrapped);
                return bound?.kind === "data" && optionalComparable(bound.dataType) ? bound : undefined;
            }
            // The input getter remains nullable after an earlier assignment:
            // a helper can change its retained slot without TypeScript
            // invalidating the caller's local property narrowing.
            if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === "texture" &&
                pinnedHandleKind(this.context.checker.getNonNullableType(this.context.checker.getTypeAtLocation(unwrapped.expression))) === "node-input") {
                return this.context.compileValue(unwrapped);
            }
            // A dictionary lookup (`counts[key] === 2`) is the same
            // nullable-or-value operand without the chain spelling. The
            // owner's declared type decides, so no probe runs for the
            // ordinary comparisons that are not one.
            const dictionaryLookup =
                !ts.isOptionalChain(unwrapped) &&
                (ts.isElementAccessExpression(unwrapped) || ts.isPropertyAccessExpression(unwrapped)) &&
                this.declaredAsDictionary(unwrapped.expression);
            if (!ts.isOptionalChain(unwrapped) && !dictionaryLookup) {
                if (!ts.isElementAccessExpression(unwrapped) && !ts.isPropertyAccessExpression(unwrapped)) return undefined;
                // Flow narrowing changes checker types, while nullable storage
                // keeps its declared element representation (including enums).
                return this.context.probeEmission(() => {
                    const value = this.compileDataPath(unwrapped, "read");
                    return value?.kind === "data" && optionalComparable(value.dataType)
                        ? value : undefined;
                });
            }
            const value = this.compileDataPath(
                unwrapped,
                "read",
            );
            return value?.kind === "data" &&
                optionalComparable(value.dataType)
                ? value
                : undefined;
        };
        const leftOptional = loweredOptional(left);
        const rightOptional = loweredOptional(right);
        const leftType =
            leftOptional?.dataType ?? this.dataTypeAt(left);
        const rightType =
            rightOptional?.dataType ?? this.dataTypeAt(right);
        const widenTag = (value: {cpp: string; dataType: DataType}, node: ts.Node): {cpp: string; dataType: DataType} =>
            value.dataType.kind === "enum"
                ? {cpp: this.context.dataTypes.enumToStringCpp(value.dataType, value.cpp, node), dataType: {kind: "string"}}
                : value;
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
            if (
                expected.inner.kind === "handle" &&
                value.kind === expected.inner.handle &&
                value.optionalStorageCpp !== undefined
            ) {
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "optional_compare",
                    );
                this.context.emit(
                    { kind: "declaration", type: "const auto", name: temporary, initializer: value.optionalStorageCpp },
                );
                return temporary;
            }
            const concreteType: DataType | undefined =
                value.dataType ??
                (value.kind === "number"
                    ? { kind: "number" }
                    : value.kind === "boolean"
                      ? { kind: "boolean" }
                      : value.kind === "string"
                        ? { kind: "string" }
                        : expected.inner.kind === "handle" &&
                            value.kind === expected.inner.handle
                          ? expected.inner
                        : undefined);
            if (value.kind === "json-null") {
                const temporary =
                    this.context.allocateTemporaryCppName(
                        "optional_compare",
                    );
                const cppType =
                    this.context.dataTypes.cppType(expected);
                this.context.emit(
                    `const ${cppType} ${temporary}{std::nullopt};`,
                );
                return temporary;
            }
            if (
                concreteType &&
                (dataTypesEqual(concreteType, expected.inner) ||
                    (["string", "enum"].includes(concreteType.kind) &&
                        ["string", "enum"].includes(expected.inner.kind)))
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
                    "Optional comparison did not lower to its declared data type.",
                );
            }
            const temporary =
                this.context.allocateTemporaryCppName(
                    "optional_compare",
                );
            this.context.emit(
                { kind: "declaration", type: "const auto", name: temporary, initializer: value.cpp },
            );
            return temporary;
        };
        if (
            optionalComparable(leftType) &&
            optionalComparable(rightType) &&
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
        if (optionalComparable(leftType)) {
            const leftCpp = bindOptional(
                left,
                leftType,
                leftOptional,
            );
            const present = widenTag({cpp: `(*${leftCpp})`, dataType: leftType.inner}, left);
            const rightCpp = this.compileForSink(right, present.dataType);
            const equal =
                `(${leftCpp}.has_value() && ` +
                `${present.cpp} == ${rightCpp})`;
            return negated ? `!${equal}` : equal;
        }
        if (optionalComparable(rightType)) {
            const rightCpp = bindOptional(
                right,
                rightType,
                rightOptional,
            );
            const present = widenTag({cpp: `(*${rightCpp})`, dataType: rightType.inner}, right);
            const leftCpp = this.compileForSink(left, present.dataType);
            const equal =
                `(${rightCpp}.has_value() && ` +
                `${leftCpp} == ${present.cpp})`;
            return negated ? `!${equal}` : equal;
        }
        const leftValue = this.comparableOperand(left);
        if (leftValue) {
            const rightValue = this.comparableOperand(right);
            if (rightValue && !dataTypesEqual(leftValue.dataType, rightValue.dataType) &&
                [leftValue.dataType, rightValue.dataType].every(type => type.kind === "string" || type.kind === "enum") &&
                !(leftValue.dataType.kind === "enum" && rightValue.staticString !== undefined &&
                    this.context.dataTypes.enumMembers(leftValue.dataType.name).includes(rightValue.staticString))) {
                // A string outside a closed tag set simply does not match;
                // converting that string into the tag enum would throw.
                return `std::string(${widenTag(leftValue, left).cpp}) ${negated ? "!=" : "=="} std::string(${widenTag(rightValue, right).cpp})`;
            }
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
            value?.kind === "data" && value.dataType !== undefined &&
            (isOpaqueReference(value.dataType) ||
                value.dataType?.kind === "enum" ||
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
        knownTuple?: Value,
    ):
        | {
              container: Value;
              element: DataIterationElement;
              template?: Value;
          }
        | undefined {
        const iterated = knownTuple ? undefined : this.iteratorMethodTarget(expression);
        if (iterated) {
            return iterated;
        }
        const rawValue = knownTuple && !ts.isIdentifier(this.context.unwrap(expression))
            ? this.materializeKnownTuple(expression, knownTuple)
            :
            this.materializeConstantArray(expression) ??
            this.compileDataPath(expression, "read") ??
            this.materializeStaticTable(expression) ??
            this.callSpanValue(expression) ??
            this.selectedIterationValue(expression) ??
            this.runtimeArrayLiteral(expression) ??
            (knownTuple ? this.materializeKnownTuple(expression, knownTuple) : undefined) ??
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
        if (dataType.kind === "json") {
            // `for (const entry of document)`: the array's own elements,
            // each another document. A non-array iterates zero times here,
            // where JavaScript would throw -- but every reached loop is
            // guarded by `Array.isArray` first, which is what the guard is
            // for, so nothing observes the difference.
            return {
                container: {
                    kind: "data",
                    cpp: `${value.cpp}.elements()`,
                    dataType: { kind: "span", element: { kind: "json" } },
                },
                element: { kind: "json" },
            };
        }
        if (
            dataType.kind === "vector" ||
            dataType.kind === "span" ||
            dataType.kind === "set"
        ) {
            return {
                container: value,
                element: dataType.element,
                ...(value.runtimeElementTemplate
                    ? { template: value.runtimeElementTemplate }
                    : {}),
            };
        }
        if (isTypedArrayType(dataType)) {
            // A typed array iterates its lanes as numbers; the native view
            // is a range over its element storage.
            return { container: value, element: { kind: "number" } };
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

    /**
     * `array.entries()`, `array.keys()` and `array.values()` as the range
     * of a for...of. JavaScript's iterator objects have no native
     * representation, so the loop iterates the container itself and binds
     * what the iterator would have yielded: the array walks by index, so
     * an entry's value is the element in place and a write through it
     * reaches the array, as the source's does. Map and Set iterator
     * methods return their container from the method call itself.
     */
    private iteratorMethodTarget(
        expression: ts.Expression,
    ):
        | { container: Value; element: DataIterationElement; template?: Value }
        | undefined {
        const iterator = iteratorMethodCall(
            expression,
            (identifier) => this.context.isDefaultLibraryIdentifier(identifier),
            (node) => this.context.unwrap(node),
        );
        if (!iterator) {
            return undefined;
        }
        const { call, method, receiver } = iterator;
        // The receiver resolves as a range the way the loop would resolve
        // it directly, so a constant array, a stored vector and a readonly
        // parameter all take the same walk. The whole classification runs
        // inside the probe, so a receiver whose iterator this walk does not
        // take leaves nothing behind.
        return this.context.probeEmission(() => {
            const range = this.iterationTarget(receiver);
            if (!range) {
                return undefined;
            }
            const container = range.container;
            const kind = container.dataType?.kind;
            if (kind === "map") {
                // The entry iterator yields the map's own [key, value] pairs;
                // keys() and values() are vectors the method call produces.
                return method === "entries" ? range : undefined;
            }
            if (kind === "set") {
                if (method === "entries") {
                    this.context.fail(
                        call,
                        "Set.entries() yields [value, value] pairs, which have no native representation; iterate the set itself.",
                    );
                }
                return range;
            }
            if ((kind !== "vector" && kind !== "span") || this.pairedElement(range.element)) {
                return undefined;
            }
            const element = range.element;
            const template = range.template ? { template: range.template } : {};
            if (method === "values") {
                return { container, element, ...template };
            }
            this.context.reachJsData();
            const indexCpp = this.context.allocateTemporaryCppName("index");
            return method === "entries"
                ? { container, element: { kind: "array-entry", element, indexCpp }, ...template }
                : { container, element: { kind: "array-index", indexCpp } };
        });
    }

    private runtimeArrayLiteral(
        expression: ts.Expression,
    ): Value | undefined {
        const literal = this.context.unwrap(expression);
        if (!ts.isArrayLiteralExpression(literal)) return undefined;
        const dataType = this.dataTypeAt(literal);
        if (dataType?.kind !== "vector") return undefined;
        this.context.reachJsData();
        return {
            kind: "data",
            // Route through the vector sink so a literal containing
            // `...iterable` takes the same ordered append path as one stored
            // in a local before iteration.
            cpp: this.compileForSink(literal, dataType),
            dataType,
            freshData: true,
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

    /** The value yielded by each native iterable's storage representation. */
    private iterationElementValue(itemCpp: string, element: DataIterationElement): Value {
        if (element.kind === "map-entry") return {kind:"tuple", cpp:"", tupleElements:[
            this.leafValue(`${itemCpp}.first`, element.key), this.leafValue(`${itemCpp}.second`, element.value),
        ]};
        if (element.kind === "array-index" || element.kind === "array-entry") {
            const index = this.leafValue(`static_cast<double>(${element.indexCpp})`, {kind:"number"});
            return element.kind === "array-index" ? index : {kind:"tuple", cpp:"", tupleElements:[index, this.leafValue(itemCpp, element.element)]};
        }
        return this.leafValue(itemCpp, element);
    }

    /**
     * Binds a for-of iteration variable (identifier, array pattern over
     * tuples, or object pattern over structs) to the range-for item.
     */
    public bindIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataIterationElement,
        template: Value | undefined,
        define: (
            identifier: ts.Identifier,
            value: Value,
        ) => void,
    ): void {
        const owner = this.context.registerNativeBinding(itemCpp, false, true);
        const defineItem = (identifier: ts.Identifier, value: Value): void =>
            define(identifier, { ...value, nativeCaptures: [owner] });
        if (element.kind === "array-index") {
            if (!ts.isIdentifier(name)) {
                this.context.fail(name, "Array keys iteration binds one identifier.");
            }
            defineItem(name, {
                kind: "number",
                cpp: `static_cast<double>(${element.indexCpp})`,
                dataType: { kind: "number" },
            });
            return;
        }
        if (element.kind === "array-entry") {
            if (!ts.isArrayBindingPattern(name)) {
                this.context.fail(
                    name,
                    "Array entries iteration requires an [index, value] binding.",
                );
            }
            if (name.elements.length > 2) {
                this.context.fail(
                    name,
                    "Array entry destructuring accepts at most two bindings.",
                );
            }
            const indexOwner = this.context.registerNativeBinding(element.indexCpp, false, true);
            name.elements.forEach((binding, position) => {
                if (ts.isOmittedExpression(binding)) return;
                if (
                    !ts.isIdentifier(binding.name) ||
                    binding.initializer ||
                    binding.dotDotDotToken
                ) {
                    this.context.fail(
                        binding,
                        "Array entry destructuring supports plain identifiers.",
                    );
                }
                if (position === 0) {
                    define(binding.name, {
                        kind: "number",
                        cpp: `static_cast<double>(${element.indexCpp})`,
                        dataType: { kind: "number" },
                        nativeCaptures: [indexOwner],
                    });
                    return;
                }
                const value: Value = {
                    ...withNativeMetadata(this.leafValue(itemCpp, element.element), template),
                    runtimeIteration: true,
                };
                defineItem(binding.name, runtimeMeshValue(value));
            });
            return;
        }
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
            const pair = this.iterationElementValue(itemCpp, element).tupleElements!;
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
                const value = pair[index]!;
                defineItem(binding.name, value);
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
            const value: Value = { ...withNativeMetadata(this.leafValue(itemCpp, element), template), runtimeIteration: true };
            defineItem(name, runtimeMeshValue(value));
            return;
        }
        if (ts.isArrayBindingPattern(name)) {
            const arity =
                element.kind === "tuple"
                    ? element.arity
                    : element.kind === "product" ? element.elements.length
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
                defineItem(element_.name, this.fixedTupleElement(this.leafValue(itemCpp, element), index, element_)!);
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
                defineItem(binding.name, value);
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

    public compileStringSink(unwrapped: ts.Expression, dataType: DataType & {
        kind: "string";
    }): string {
        const resolved = this.context.resolveStaticExpression(unwrapped);
        if (resolved !== unwrapped) {
            return this.compileForSink(resolved, dataType);
        }
        // A literal is the string itself; a name bound to a
        // compile-time string is too, the way the enum arm below
        // reads one. Anything else has to be a path already typed as
        // a string, so a number or handle reaching a string sink
        // fails by type rather than by concatenation.
        if (ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
            return this.context.cppString(unwrapped.text);
        }
        if (ts.isIdentifier(unwrapped)) {
            const bound = this.context.lookupIdentifierValue(unwrapped);
            if (bound?.staticString !== undefined) {
                return this.context.cppString(bound.staticString);
            }
            if (bound?.kind === "string") {
                return bound.cpp;
            }
            if (bound?.kind === "data") {
                const narrowed = this.narrowOptional(bound, unwrapped);
                if (narrowed.dataType?.kind === "string") {
                    return narrowed.cpp;
                }
            }
        }
        if (ts.isCallExpression(unwrapped) ||
            ts.isBinaryExpression(unwrapped) ||
            ts.isTemplateExpression(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)) {
            const computed = this.context.compileValue(unwrapped);
            if (computed.kind === "string" ||
                (computed.kind === "data" &&
                    computed.dataType?.kind === "string")) {
                return computed.cpp;
            }
        }
        const rawValue = this.compileDataPath(unwrapped, "read") ??
            (ts.isCallExpression(unwrapped) ||
                ts.isIdentifier(unwrapped) ||
                ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)
                ? this.context.compileValue(unwrapped)
                : undefined);
        const value = rawValue?.kind === "data"
            ? this.narrowOptional(rawValue, unwrapped)
            : rawValue;
        if (value?.kind === "data" &&
            value.dataType?.kind === "enum") {
            return this.context.dataTypes.enumToStringCpp(value.dataType, value.cpp, unwrapped);
        }
        if (isJsonValue(value)) {
            // `String(document)` at the sink, where JavaScript
            // coerces one.
            return `${value.cpp}.to_string()`;
        }
        if (value?.dataType === undefined ||
            !dataTypesEqual(value.dataType, dataType)) {
            this.context.fail(unwrapped, "Expected a string.");
        }
        return value.cpp;
    }

    public compileOptionalSink(expression: ts.Expression, dataType: DataType & {
        kind: "optional";
    }): string {
        const unwrapped = this.context.unwrap(expression);
        if (unwrapped.kind ===
            ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(unwrapped) &&
                unwrapped.text === "undefined" &&
                !this.context.lookupIdentifierValue(unwrapped))) {
            return "std::nullopt";
        }
        const optional = this.compileDataPath(unwrapped, "read") ??
            (ts.isCallExpression(unwrapped) ||
                ts.isIdentifier(unwrapped) ||
                ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)
                ? this.context.compileValue(unwrapped)
                : undefined);
        if (optional?.kind === "void") {
            return this.compileKnownValueForSink(optional, dataType, unwrapped);
        }
        if (optional?.kind === "json-null") {
            // A destructured optional tuple lane can bind a local to
            // JavaScript null/undefined. The binding is still the
            // empty optional when it reaches a typed sink; requiring
            // the null token to remain syntactically in place would
            // make destructuring observably different.
            return "std::nullopt";
        }
        if (optional?.kind === "data" &&
            optional.dataType &&
            dataTypesEqual(optional.dataType, dataType)) {
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
        if (optional &&
            dataType.inner.kind === "handle" &&
            optional.kind === dataType.inner.handle) {
            const inner = this.compileKnownValueForSink(optional, dataType.inner, unwrapped);
            if (optional.optionalFoundCpp === undefined) {
                return inner;
            }
            const cppType = this.context.dataTypes.cppType(dataType);
            this.context.reachJsData();
            return (`(${optional.optionalFoundCpp}` +
                ` ? ${cppType}{${inner}}` +
                ` : ${cppType}{std::nullopt})`);
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
        const inner = optional
            ? this.compileKnownValueForSink(optional, dataType.inner, expression)
            : this.compileForSink(expression, dataType.inner);
        if (dataType.inner.kind === "struct" &&
            this.context.dataTypes.isReferenceStruct(dataType.inner.name)) {
            return inner;
        }
        this.context.reachJsData();
        return `${this.context.dataTypes.cppType(dataType)}{${inner}}`;
    }

    public compileVectorSink(unwrapped: ts.Expression, dataType: DataType & {
        kind: "vector";
    }): string {
        if (ts.isArrayLiteralExpression(unwrapped)) {
            this.context.reachJsData();
            const spreads = unwrapped.elements.filter(ts.isSpreadElement);
            if (spreads.length > 0) {
                const spreadValue = (spread: ts.SpreadElement): Value & {freshSpread?: true} => {
                    const expression = this.context.unwrap(spread.expression);
                    if (ts.isConditionalExpression(expression)) {
                        // Fresh branches inherit the destination element type before
                        // their tuples choose narrower native storage independently.
                        return this.leafValue(this.compileForSink(expression, dataType), dataType);
                    }
                    const projected = ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
                        ["map", "flatMap"].includes(expression.expression.name.text)
                        ? this.compileDataMethodCall(expression, dataType) : undefined;
                    const mapRange = projected ? undefined : this.context.probeEmission(() => {
                        const range = this.iterationTarget(spread.expression);
                        return range?.element.kind === "map-entry" ? range : undefined;
                    });
                    if (mapRange?.element.kind === "map-entry") {
                        const source = this.context.allocateTemporaryCppName("spread_map");
                        const entry = this.context.allocateTemporaryCppName("spread_entry");
                        const result = this.context.allocateTemporaryCppName("spread_entries");
                        const pair = this.iterationElementValue(entry, mapRange.element);
                        this.context.emit(`const auto ${source} = ${mapRange.container.cpp};`);
                        this.context.emit(`${this.context.dataTypes.cppType(dataType)} ${result};`);
                        this.context.emit(`${result}.reserve(${source}.size());`);
                        const pairCpp = this.compileKnownValueForSink(pair, dataType.element, spread);
                        this.context.emit(`for (const auto& ${entry} : ${source}) ${result}.push_back(${pairCpp});`);
                        return { kind: "data", cpp: result, dataType, freshSpread: true };
                    }
                    const iterable = projected ?? this.compileDataPath(spread.expression, "read") ??
                        this.context.compileValue(spread.expression);
                    if (this.context.dataTypes.carriesBorrowedPlatformEvent(dataType.element)) {
                        this.context.refuseBorrowedPlatformEventEscape(iterable, spread, "Array spread");
                    }
                    if (iterable.kind === "tuple") {
                        return {
                            kind: "data",
                            freshSpread: true,
                            cpp: `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>{${(iterable.tupleElements ?? [])
                                .map((element) => this.compileKnownValueForSink(element, dataType.element, spread))
                                .join(", ")}}`,
                            dataType: {
                                kind: "vector",
                                element: dataType.element,
                            },
                        };
                    }
                    if (iterable.kind === "handle-collection" &&
                        iterable.handleCollection &&
                        dataType.element.kind === "handle" &&
                        iterable.handleCollection.elementKind ===
                            dataType.element.handle) {
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
                    const sourceElement = iterable.dataType?.kind === "set" ||
                        iterable.dataType?.kind === "vector" ||
                        iterable.dataType?.kind === "span"
                        ? iterable.dataType.element
                        : undefined;
                    if (iterable.kind === "data" && sourceElement &&
                        !dataTypesEqual(sourceElement, dataType.element) &&
                        ["string", "enum"].includes(sourceElement.kind) &&
                        ["string", "enum"].includes(dataType.element.kind)) {
                        const item = this.context.allocateTemporaryCppName("spread_item");
                        const converted = this.compileKnownValueForSink(this.leafValue(item, sourceElement), dataType.element, spread);
                        return {...this.leafValue(`bbl::js::array_from_iterable<${this.context.dataTypes.cppType(dataType.element)}>(` +
                            `${iterable.cpp}, [](const auto& ${item}) { return ${converted}; })`, dataType), freshSpread: true};
                    }
                    if (iterable.kind !== "data" ||
                        !sourceElement ||
                        !dataTypesEqual(sourceElement, dataType.element)) {
                        this.context.fail(spread, "Array spread requires a native Set, Array, or readonly array with the same element type.");
                    }
                    return projected?.freshData ? {...iterable, freshSpread: true} : iterable;
                };
                if (spreads.length === 1 &&
                    unwrapped.elements.length === 1) {
                    const iterable = spreadValue(spreads[0]!);
                    if (iterable.freshSpread) return iterable.cpp;
                    return `bbl::js::array_from_iterable<${this.context.dataTypes.cppType(dataType.element)}>(${iterable.cpp})`;
                }
                const cppType = this.context.dataTypes.cppType(dataType.element);
                const result = this.context.allocateTemporaryCppName("spread_array");
                const statements = unwrapped.elements.map((element) => {
                    if (ts.isSpreadElement(element)) {
                        const iterable = spreadValue(element);
                        return `bbl::js::array_append(${result}, ${iterable.cpp});`;
                    }
                    return `${result}.push_back(${this.compileForRetainedSink(element, dataType.element, "Array literal")});`;
                });
                return (`([&]() { bbl::js::Array<${cppType}> ${result}; ` +
                    `${statements.join(" ")} return ${result}; }())`);
            }
            const elements = unwrapped.elements.map((element) => this.compileForRetainedSink(element, dataType.element, "Array literal"));
            return `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>{${elements.join(", ")}}`;
        }
        if (ts.isNewExpression(unwrapped)) {
            const created = this.newArrayCount(unwrapped);
            if (created !== undefined) {
                this.context.reachJsData();
                return `bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>(static_cast<std::size_t>(${created}))`;
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const fillOwner = ts.isPropertyAccessExpression(unwrapped.expression) &&
                unwrapped.expression.name.text === "fill" &&
                ts.isNewExpression(this.context.unwrap(unwrapped.expression.expression))
                ? (this.context.unwrap(unwrapped.expression.expression) as ts.NewExpression)
                : undefined;
            const fillCount = fillOwner
                ? this.newArrayCount(fillOwner)
                : undefined;
            if (fillCount !== undefined) {
                if (unwrapped.arguments.length !== 1) {
                    this.context.fail(unwrapped, "Array.fill expects one argument.");
                }
                const value = this.compileForSink(argumentAt(unwrapped, 0), dataType.element);
                this.context.reachJsData();
                return (`bbl::js::Array<${this.context.dataTypes.cppType(dataType.element)}>` +
                    `(static_cast<std::size_t>(${fillCount}), ${value})`);
            }
            const chained = this.compileDataMethodCall(unwrapped, dataType);
            if (chained?.kind === "data" &&
                chained.dataType &&
                dataTypesEqual(chained.dataType, dataType)) {
                return chained.cpp;
            }
            const mapped = this.context.compileValue(unwrapped);
            if (mapped.kind === "tuple" ||
                mapped.kind === "data") {
                return this.compileKnownValueForSink(mapped, dataType, unwrapped);
            }
        }
        if (ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)) {
            const known = this.context.compileValue(unwrapped);
            if (known.kind === "tuple" ||
                (known.kind === "data" &&
                    known.dataType?.kind === "span" &&
                    dataTypesEqual(known.dataType.element, dataType.element))) {
                return this.compileKnownValueForSink(known, dataType, unwrapped);
            }
        }
        const sourceType = this.dataTypeAt(unwrapped);
        if (sourceType?.kind === "vector" &&
            (sourceType.element.kind === "struct" ||
                sourceType.element.kind === "map") &&
            dataType.element.kind === "struct" &&
            !dataTypesEqual(sourceType, dataType)) {
            return this.compileKnownValueForSink(this.context.compileValue(unwrapped), dataType, unwrapped);
        }
        const value = this.requireDataValue(unwrapped, dataType);
        this.markEscaped(value);
        return value.cpp;
    }

}
