// The native bindings of one compilation: the lexical scope stack -- the
// binding each source name has in the scope being lowered, how a
// declaration, parameter or rebind changes it, and the refusals a read of it
// can raise -- and the native homes a value takes when it must outlive the
// expression that produced it (pinned temporaries, materialized records).
import ts from "typescript";
import {
    cppIdentifierPattern,
    sanitizeCppIdentifier,
} from "../cpp-literals.js";
import { CPP_SCALAR } from "../lowering/cpp-types.js";
import type { SceneNodeTransformDescriptor } from "../scene-node-transform-descriptor.js";
import { syntaxKindName } from "../source-location.js";
import { findAnalysisNodeWithState } from "./analysis-walk.js";
import type { NativeCaptureBinding } from "./closure-captures.js";
import {
    isHandleKind,
    isOpaqueReference,
    isTypedArrayType,
    passesByReferenceKind,
    type DataType,
    type DataTypeRegistry,
} from "./data-types.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
    EmissionWeakSet,
} from "./emission-transaction.js";
import { isJsonValue } from "./json-bridge.js";
import type { LoweringServices } from "./lowering-services.js";
import { nativeReturnTsType } from "./native-return-type.js";
import { numberConstantValue } from "./number-intrinsics.js";
import { recordAt } from "./record-access.js";
import { retainTextValue } from "./text-surface.js";
import {
    isCompileTimeOnlyValue,
    isStringValue,
    valueForKind,
    type Value,
    type VariableBinding,
} from "./types.js";
import { isSupportedFunction, parameterIsReadOnly } from "./user-functions.js";

/** What the bindings ask of the compiler: symbols, values and native storage. */
interface BindingScopesContext extends Pick<
    LoweringServices,
    | "activeNativeReturnType"
    | "allocateBlockPrefix"
    | "allocateTemporaryCppName"
    | "captureRecordScopes"
    | "checker"
    | "classOf"
    | "cppString"
    | "dataLowerer"
    | "dataTypes"
    | "emit"
    | "fail"
    | "identifierIsRebound"
    | "isInFrameCallback"
    | "options"
    | "reachJsData"
    | "registerNativeBindingType"
    | "registerNativeConstBinding"
    | "symbols"
    | "takeNativeTemporary"
    | "unwrap"
    | "useNativeValue"
> {
    assignAudioMainBus(
        target: Value,
        value: Value | undefined,
        node: ts.Node,
    ): void;
    bindAudioMainBusStorage(value: Value): void;
    describeNativeValue(value: Value): void;
    hasStableNativeBinding(value: Value): boolean;
    isSharedClosureScalar(kind: string): boolean;
    markImmutableNativeStorage(value: Value, immutable: boolean): void;
    mutableCapturedParameter(identifier: ts.Identifier, value: Value): boolean;
    trackCollectionCardinality(identifier: ts.MemberName, value: Value): void;
    useNativeBinding(binding: NativeCaptureBinding): void;
}

/** The name lookups a static fold reads, which a fold may narrow. */
export type BindingLookup = Pick<BindingScopes, "lookup" | "lookupOptional">;

/** Whether a value, or any value it carries, is a borrowed platform event. */
export function valueContainsPlatformEvent(
    dataTypes: DataTypeRegistry,
    value: Value,
    seen = new EmissionSet<Value>(),
): boolean {
    if (seen.has(value)) return false;
    seen.add(value);
    if (
        value.kind === "platform-keyboard-event" ||
        value.kind === "platform-mouse-event" ||
        value.nativeErrorEvent
    ) {
        return true;
    }
    if (
        value.dataType &&
        dataTypes.carriesBorrowedPlatformEvent(value.dataType)
    ) {
        return true;
    }
    const nested: Value[] = [
        ...Object.values(value.recordProperties ?? {}),
        ...(value.tupleElements ?? []),
        ...(value.staticElements ?? []),
        ...(value.nativeCallbackStaticArguments ?? []).filter(
            (candidate): candidate is Value => candidate !== undefined,
        ),
    ];
    if (value.staticElementsOwner) nested.push(value.staticElementsOwner);
    if (value.callbackRecordOwner) nested.push(value.callbackRecordOwner);
    if (value.sceneCamera) nested.push(value.sceneCamera);
    for (const scope of value.recordScopes ?? []) {
        for (const binding of scope.values()) nested.push(binding.value);
    }
    return nested.some((candidate) =>
        valueContainsPlatformEvent(dataTypes, candidate, seen),
    );
}

export class BindingScopes {
    private readonly transparentRebindingScopes = new EmissionWeakSet<
        Map<ts.Symbol, VariableBinding>
    >();
    public readonly variableScopes: Array<Map<ts.Symbol, VariableBinding>> =
        emissionArray([new EmissionMap()]);
    private readonly cppNamePrefixes: string[] = emissionArray([""]);

    /**
     * The scope depth the outermost enclosing frame callback started at.
     *
     * Everything at or above it lives on that callback's own stack frame.
     * A deferred (`setTimeout`) callback runs AFTER that frame has
     * returned, so naming one of those locals would emit a reference to
     * dead storage -- which is why `deferredCaptureScopes` refuses it.
     */
    public frameCallbackScopeFloor: number | undefined;

    /** Expired frame scopes, tracked by identity across lexical scope restoration. */
    public deferredCaptureScopes:
        ReadonlySet<Map<ts.Symbol, VariableBinding>> | undefined;

    /**
     * Scope depth at which a nested persistent callback begins. Platform event
     * objects are borrowed from the dispatch stack, so only bindings introduced
     * at or below this callback may refer to one.
     */
    public escapingPlatformEventCaptureFloor: number | undefined;

    constructor(private readonly context: BindingScopesContext) {}

    public pushScope(cppPrefix: string, propagateRebindings = false): void {
        const scope = new EmissionMap<ts.Symbol, VariableBinding>();
        if (propagateRebindings) this.transparentRebindingScopes.add(scope);
        this.variableScopes.push(scope);
        this.cppNamePrefixes.push(cppPrefix);
    }

    public popScope(): void {
        if (this.variableScopes.length === 1) {
            throw new Error("Cannot pop the compiler root scope.");
        }
        this.variableScopes.pop();
        this.cppNamePrefixes.pop();
    }

    /** The C++ name prefix of the innermost scope. */
    public get cppNamePrefix(): string {
        return this.cppNamePrefixes.at(-1) ?? "";
    }

    public cppIdentifier(sourceName: string): string {
        return `v_${this.cppNamePrefix}${sanitizeCppIdentifier(sourceName)}`;
    }

    /**
     * Runs `work` with an inlined function's parameters bound in a scope of
     * its own -- the same binding the user-function inliner performs before
     * it lowers a body, exposed for the folds that read a body instead.
     *
     * A `MaterialPlugin` returned by a local factory closes over the
     * arguments, so folding its members means resolving the factory's
     * parameter names to what the call site passed; nothing else about the
     * body is entered.
     *
     * The scope takes an allocated prefix, exactly as every other inliner's
     * does. A binding still DECLARES a native local, so an empty prefix
     * spells one `v_<parameter>` per call: two calls of one factory would
     * redefine it, and a parameter sharing a name with a scene local would
     * collide with that local's own declaration.
     */
    public withBoundParameters<T>(
        parameters: readonly {
            name: ts.Identifier;
            value: Value;
            compileTime?: boolean;
        }[],
        work: () => T,
    ): T {
        if (parameters.length === 0) return work();
        this.pushScope(this.context.allocateBlockPrefix());
        try {
            for (const parameter of parameters) {
                if (parameter.compileTime)
                    this.bindCompileTimeValue(parameter.name, parameter.value);
                else this.bindParameterValue(parameter.name, parameter.value);
            }
            return work();
        } finally {
            this.popScope();
        }
    }

    /** The value symbol a name binds, or a failure naming it. */
    private requireValueSymbol(identifier: ts.MemberName): ts.Symbol {
        const symbol = this.context.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.context.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        return symbol;
    }

    /** The innermost scope that binds a symbol, walked as `lookup` walks. */
    private bindingScope(
        symbol: ts.Symbol,
    ): Map<ts.Symbol, VariableBinding> | undefined {
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const scope = this.variableScopes[index]!;
            if (scope.has(symbol)) return scope;
        }
        return undefined;
    }

    public lookup(identifier: ts.Identifier): Value {
        const symbol = this.context.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.context.fail(
                identifier,
                `Unknown or unsupported variable '${identifier.text}'.`,
            );
        }
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const binding = this.variableScopes[index]!.get(symbol);
            if (binding) {
                this.refuseDeadDeferredCapture(
                    identifier,
                    index,
                    binding.frameLocal === true,
                );
                this.refuseEscapingPlatformEventCapture(
                    identifier,
                    index,
                    binding.value,
                );
                this.refusePoisonedRebind(identifier, binding);
                this.context.useNativeValue(binding.value);
                return binding.value;
            }
        }
        this.context.fail(
            identifier,
            `Unknown or unsupported variable '${identifier.text}'.`,
        );
    }

    public lookupOptional(identifier: ts.MemberName): Value | undefined {
        const symbol = this.context.symbols.valueSymbol(identifier);
        if (!symbol) {
            return undefined;
        }
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const binding = this.variableScopes[index]!.get(symbol);
            if (binding) {
                // A deferred callback runs after the frame that created
                // it has returned, so a name bound inside that frame is
                // dead storage by then. The emitted lambda captures by
                // reference, so this would compile clean and read freed
                // memory; it refuses instead. Escaping captures of frame
                // locals are not supported in general, and this is the
                // one place the reached slice can walk into them.
                this.refuseDeadDeferredCapture(
                    identifier,
                    index,
                    binding.frameLocal === true,
                );
                this.refuseEscapingPlatformEventCapture(
                    identifier,
                    index,
                    binding.value,
                );
                this.refusePoisonedRebind(identifier, binding);
                this.context.useNativeValue(binding.value);
                return binding.value;
            }
        }
        return undefined;
    }

    /**
     * A read of a handle a nested callback pointed somewhere else.
     *
     * The storage the outer name reads is the one that callback wrote, but
     * whether it wrote is a run-time question -- so the identity this
     * binding still carries describes the value only on one of the two
     * paths. Composition is decided from that identity, so a wrong guess
     * would stamp a material onto the wrong mesh with nothing to show for
     * it; refusing is what makes the rebind safe to allow at all.
     */
    private refusePoisonedRebind(
        identifier: ts.MemberName,
        binding: VariableBinding,
    ): void {
        if (!binding.reboundInNestedScope) return;
        this.context.fail(
            identifier,
            `'${identifier.text}' is read after a nested callback pointed ` +
                "it at a different handle, so which one it names depends " +
                "on whether that callback ran. Read it inside the callback, " +
                "or keep the new handle in its own name.",
        );
    }

    private refuseDeadDeferredCapture(
        identifier: ts.MemberName,
        scopeIndex: number,
        frameLocal: boolean,
    ): void {
        // Worker-enabled callbacks own their captures, including shared cells
        // for mutable bindings. Borrowed platform-event checks still apply.
        if (this.context.options.workers) return;
        if (
            frameLocal &&
            this.deferredCaptureScopes?.has(this.variableScopes[scopeIndex]!)
        ) {
            this.context.fail(
                identifier,
                `A deferred callback cannot name '${identifier.text}': ` +
                    "it is bound inside the callback that queued the " +
                    "timer, and that frame has returned by the time " +
                    "the timer runs. Bind it outside the enclosing " +
                    "callback.",
            );
        }
    }

    private refuseEscapingPlatformEventCapture(
        identifier: ts.MemberName,
        scopeIndex: number,
        value: Value,
        floor = this.escapingPlatformEventCaptureFloor,
    ): void {
        if (
            floor !== undefined &&
            scopeIndex < floor &&
            valueContainsPlatformEvent(this.context.dataTypes, value)
        ) {
            this.context.fail(
                identifier,
                `An escaping callback cannot capture platform event value ` +
                    `'${identifier.text}': the event is borrowed only while ` +
                    "its current handler executes. Copy the specific owned " +
                    "field needed by the later callback instead.",
            );
        }
    }

    public refuseEscapingPlatformEventCapturesIn(
        node: ts.Node,
        floor = this.escapingPlatformEventCaptureFloor ??
            (this.context.activeNativeReturnType() !== undefined
                ? this.variableScopes.length
                : undefined),
    ): void {
        if (floor === undefined) return;
        const roots: ts.Node[] = [node];
        if (ts.isIdentifier(node)) {
            const declaration =
                this.context.symbols.valueSymbol(node)?.valueDeclaration;
            if (declaration && ts.isFunctionLike(declaration)) {
                roots.push(declaration);
            } else if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                (ts.isArrowFunction(declaration.initializer) ||
                    ts.isFunctionExpression(declaration.initializer))
            ) {
                roots.push(declaration.initializer);
            }
        }
        const visitedSymbols = new EmissionSet<ts.Symbol>();
        const visitedFunctions = new EmissionSet<ts.Node>();
        const containingFunction = (
            declaration: ts.Declaration | undefined,
        ): ts.SignatureDeclaration | undefined => {
            let current: ts.Node | undefined = declaration;
            while (current) {
                if (ts.isFunctionLike(current)) {
                    return current;
                }
                current = current.parent;
            }
            return undefined;
        };
        const visit = (root: ts.Node): void => {
            findAnalysisNodeWithState<ts.SignatureDeclaration | undefined>(
                root,
                undefined,
                (current, active) => {
                    const functionScope = ts.isFunctionLike(current)
                        ? current
                        : active;
                    if (ts.isIdentifier(current)) {
                        const symbol =
                            this.context.symbols.valueSymbol(current);
                        const declaration =
                            symbol?.valueDeclaration ??
                            symbol?.declarations?.[0];
                        if (
                            symbol &&
                            containingFunction(declaration) !== functionScope &&
                            !visitedSymbols.has(symbol)
                        ) {
                            visitedSymbols.add(symbol);
                            for (
                                let index = Math.min(
                                    floor - 1,
                                    this.variableScopes.length - 1,
                                );
                                index >= 0;
                                index -= 1
                            ) {
                                const binding =
                                    this.variableScopes[index]!.get(symbol);
                                if (!binding) continue;
                                this.refuseEscapingPlatformEventCapture(
                                    current,
                                    index,
                                    binding.value,
                                    floor,
                                );
                                break;
                            }
                        }
                    }
                    let calledDeclaration: ts.SignatureDeclaration | undefined;
                    if (ts.isCallExpression(current)) {
                        const declaration =
                            this.context.checker.getResolvedSignature(
                                current,
                            )?.declaration;
                        if (
                            isSupportedFunction(declaration) &&
                            declaration.body &&
                            !visitedFunctions.has(declaration)
                        ) {
                            visitedFunctions.add(declaration);
                            calledDeclaration = declaration;
                        }
                    }
                    if (calledDeclaration) visit(calledDeclaration);
                    return false;
                },
                (current, active) =>
                    ts.isFunctionLike(current) ? current : active,
            );
        };
        for (const root of roots) {
            if (ts.isFunctionLike(root)) {
                if (visitedFunctions.has(root)) continue;
                visitedFunctions.add(root);
            }
            visit(root);
        }
    }

    /**
     * The first assignment to a `let` declared without a type or an
     * initializer: it binds the name to a compile-time record, in the
     * scope that declared it.
     *
     * Only a record that exists at generation qualifies (`cpp` is empty),
     * because a native value would have needed storage at the declaration.
     * And only an assignment the declaring scope reaches unconditionally
     * on the way to the name's later reads -- through blocks and `try`
     * bodies, never a nested callback, branch or loop. A declaration inside
     * a statically expanded loop has its own binding on every iteration.
     */
    public bindPendingLet(identifier: ts.Identifier, value: Value): void {
        if (value.cpp !== "" || !isCompileTimeOnlyValue(value.kind)) {
            this.context.fail(
                identifier,
                `Variable '${identifier.text}' needs a native data type ` +
                    "before it can be assigned; only a compile-time record " +
                    `(received ${value.kind}) can bind an untyped 'let'.`,
            );
        }
        const symbol = this.requireValueSymbol(identifier);
        const declaration = symbol.valueDeclaration;
        const blockScoped =
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
        const declaringScope = declaration
            ? ts.findAncestor(
                  declaration,
                  (node) =>
                      ts.isSourceFile(node) ||
                      (blockScoped
                          ? ts.isBlock(node)
                          : ts.isFunctionLike(node)),
              )
            : undefined;
        for (
            let node: ts.Node | undefined = identifier.parent;
            node && node !== declaringScope;
            node = node.parent
        ) {
            if (
                ts.isBlock(node) ||
                ts.isTryStatement(node) ||
                ts.isExpressionStatement(node) ||
                ts.isBinaryExpression(node) ||
                ts.isParenthesizedExpression(node) ||
                ts.isSourceFile(node)
            ) {
                continue;
            }
            this.context.fail(
                identifier,
                `'${identifier.text}' is assigned inside a ${syntaxKindName(node.kind)}; ` +
                    "an untyped 'let' binds only where its declaring scope reaches " +
                    "the assignment unconditionally.",
            );
        }
        const owner = this.bindingScope(symbol);
        if (!owner) {
            this.context.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        this.context.describeNativeValue(value);
        owner.set(symbol, {
            ...owner.get(symbol)!,
            value: {
                ...value,
                // A successful generation-only binding is a present object,
                // including when its annotation still admits undefined.
                optionalFoundCpp:
                    value.optionalFoundCpp ??
                    (value.kind === "json-null" ? "false" : "true"),
            },
        });
    }

    /**
     * Point a handle variable at a different handle of the same kind.
     *
     * A handle's C++ storage is one number, so the assignment itself is a
     * copy -- but the value the compiler holds beside it carries generation
     * identity (which scene mesh a material stamps, which slot a variant
     * table is keyed by), and that identity moves with the assignment. So
     * the binding is replaced, not just the storage.
     *
     * A rebind inside a nested callback rebinds only for the rest of that
     * callback, because on the path where the callback never runs the outer
     * variable still names what it always did. The outer binding is left
     * POISONED rather than updated: its storage now holds a handle its
     * identity does not describe, so the next outer read fails by name
     * instead of stamping the wrong mesh.
     */
    public rebindVariable(identifier: ts.Identifier, value: Value): void {
        const symbol = this.requireValueSymbol(identifier);
        // The same innermost-first walk `lookup` takes, so a rebind and a
        // read cannot disagree about which scope owns the name.
        const owner = this.bindingScope(symbol);
        if (!owner) {
            this.context.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const innermost = this.variableScopes.at(-1)!;
        const binding = owner.get(symbol)!;
        const destination: Value = { ...value, cpp: binding.value.cpp };
        delete destination.ownedCpp;
        delete destination.stableOwnerCpp;
        delete destination.nativeOwnedRvalue;
        for (const property of [
            "sharedStorageCpp",
            "optionalStorageCpp",
        ] as const) {
            const storage = binding.value[property];
            if (storage === undefined) delete destination[property];
            else destination[property] = storage;
        }
        if (binding.value.kind === "audio-engine") {
            this.context.assignAudioMainBus(binding.value, value, identifier);
            for (const property of [
                "audioMainBusCpp",
                "audioMainBusOwnerCpp",
            ] as const) {
                const storage = binding.value[property];
                if (storage === undefined) delete destination[property];
                else destination[property] = storage;
            }
            destination.nativeCompanionCaptures = {
                ...destination.nativeCompanionCaptures,
                audioMainBusCpp:
                    binding.value.nativeCompanionCaptures?.audioMainBusCpp ??
                    [],
            };
        }
        this.context.describeNativeValue(destination);
        const rebound = {
            ...binding,
            value: destination,
        };
        // Selected static branches run in the surrounding execution path.
        // A callback, runtime branch or loop still separates handle metadata.
        if (
            owner === innermost ||
            this.variableScopes
                .slice(this.variableScopes.indexOf(owner) + 1)
                .every((scope) => this.transparentRebindingScopes.has(scope))
        ) {
            owner.set(symbol, rebound);
            return;
        }
        owner.set(symbol, {
            ...binding,
            reboundInNestedScope: true,
        });
        innermost.set(symbol, rebound);
    }

    public defineVariable(identifier: ts.MemberName, value: Value): void {
        const immutable = this.isImmutableVariable(identifier.parent);
        if (value.nativeOwnedRvalue) {
            value = { ...value };
            delete value.nativeOwnedRvalue;
        }
        if (
            (value.ownedCpp !== undefined ||
                value.stableOwnerCpp !== undefined) &&
            cppIdentifierPattern.test(value.cpp)
        ) {
            value = { ...value };
            delete value.ownedCpp;
            delete value.stableOwnerCpp;
        }
        if (
            immutable &&
            !value.sharedStorageCpp &&
            value.optionalStorageCpp !== undefined &&
            cppIdentifierPattern.test(value.optionalStorageCpp)
        ) {
            value = {
                ...value,
                stableOwnerCpp: value.optionalStorageCpp,
            };
        }
        if (
            this.context.options.workers &&
            value.kind === "engine" &&
            value.optionalStorageCpp &&
            !value.ownedEngineCpp
        ) {
            const ownedEngineCpp = value.cpp;
            value = {
                ...value,
                ownedEngineCpp,
                cpp: `(*${ownedEngineCpp})`,
                engineCpp: `(*${ownedEngineCpp})`,
            };
        }
        this.context.trackCollectionCardinality(identifier, value);
        this.context.bindAudioMainBusStorage(value);
        this.context.describeNativeValue(value);
        this.context.markImmutableNativeStorage(value, immutable);
        const symbol = this.requireValueSymbol(identifier);
        const scope = this.variableScopes.at(-1)!;
        if (scope.has(symbol)) {
            this.context.fail(
                identifier,
                `Variable shadowing is not supported for '${identifier.text}' in the same scope.`,
            );
        }
        scope.set(symbol, {
            name: identifier.text,
            value,
            ...(this.context.isInFrameCallback() ? { frameLocal: true } : {}),
        });
    }

    public isImmutableVariable(declaration: ts.Node | undefined): boolean {
        let name: ts.Identifier | undefined;
        if (declaration && ts.isBindingElement(declaration)) {
            if (!ts.isIdentifier(declaration.name)) return false;
            name = declaration.name;
            let parent: ts.Node = declaration.parent;
            while (
                ts.isArrayBindingPattern(parent) ||
                ts.isObjectBindingPattern(parent)
            ) {
                parent = parent.parent;
            }
            declaration = parent;
        } else if (
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            ts.isIdentifier(declaration.name)
        ) {
            name = declaration.name;
        }
        if (
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            ts.isCatchClause(declaration.parent) &&
            name !== undefined
        )
            return !this.context.identifierIsRebound(name);
        return (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            name !== undefined &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
            !this.context.identifierIsRebound(name)
        );
    }

    public bindLocalValue(identifier: ts.Identifier, value: Value): void {
        this.bindLocalOrParameterValue(identifier, value, false);
    }

    public bindCompileTimeValue(identifier: ts.Identifier, value: Value): void {
        this.defineVariable(identifier, value);
    }

    public rebindCompileTimeValue(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        this.context.describeNativeValue(value);
        const symbol = this.requireValueSymbol(identifier);
        const owner = this.bindingScope(symbol);
        if (!owner) {
            this.context.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const binding = owner.get(symbol)!;
        owner.set(symbol, { ...binding, value });
    }

    public bindParameterValue(identifier: ts.Identifier, value: Value): void {
        const narrowed =
            value.kind === "data"
                ? this.context.dataLowerer.narrowForDeclaration(
                      value,
                      identifier,
                  )
                : value;
        if (
            narrowed.dataType?.kind === "struct" &&
            this.context.identifierIsRebound(identifier)
        ) {
            this.context.dataTypes.markStoredObjectReferences(
                narrowed.dataType,
            );
        }
        this.bindLocalOrParameterValue(
            identifier,
            narrowed,
            true,
            undefined,
            this.context.mutableCapturedParameter(identifier, narrowed),
        );
    }

    public bindLocalOrParameterValue(
        identifier: ts.MemberName,
        value: Value,
        parameter: boolean,
        explicitCppName?: string,
        sharedStorage = false,
    ): void {
        this.context.useNativeValue(value);
        // A parameter the function never rebinds keeps its argument as the
        // binding; a private name is never a parameter.
        const readOnlyParameter =
            parameter &&
            ts.isIdentifier(identifier) &&
            ts.isParameter(identifier.parent) &&
            isSupportedFunction(identifier.parent.parent) &&
            parameterIsReadOnly(
                this.context.checker,
                identifier.parent.parent,
                identifier,
            );
        if (value.kind === "void") {
            this.context.fail(
                identifier,
                `Variable '${identifier.text}' cannot receive void.`,
            );
        }
        if (value.kind === "browser") {
            this.defineVariable(identifier, value);
            return;
        }
        if (value.kind === "engine" && value.ownedEngineCpp) {
            // Escaping callbacks copy their tuple storage. Retain the owner,
            // then dereference it at each use instead of copying an Engine& alias.
            this.defineVariable(
                identifier,
                this.pinValueToTemporary(value, "engine"),
            );
            return;
        }
        if (value.uiRoot) {
            // document.body is a compile-time mount sentinel. Its inlined
            // parameter must retain that identity rather than materializing
            // a nonexistent native DOM handle.
            this.defineVariable(identifier, value);
            return;
        }
        if (
            (value.kind === "string" && (!parameter || readOnlyParameter)) ||
            value.kind === "callback" ||
            isCompileTimeOnlyValue(value.kind)
        ) {
            this.defineVariable(identifier, value);
            return;
        }
        const cppName = explicitCppName ?? this.cppIdentifier(identifier.text);
        const reference = value.kind === "engine" || value.kind === "scene";
        const copiesHandle =
            parameter &&
            (this.context.dataLowerer.dataTypeAt(identifier)?.kind ===
                "handle" ||
                isHandleKind(value.kind));
        const reboundParameter =
            parameter &&
            ts.isIdentifier(identifier) &&
            (this.context.identifierIsRebound(identifier) ||
                (this.context.isSharedClosureScalar(
                    value.dataType?.kind ?? value.kind,
                ) &&
                    !readOnlyParameter));
        const referenceValue =
            value.kind !== "number" && value.kind !== "boolean";
        const stableNativeBinding =
            referenceValue && this.context.hasStableNativeBinding(value);
        const borrowsImmutableBinding =
            !sharedStorage &&
            stableNativeBinding &&
            (parameter
                ? !reboundParameter
                : this.isImmutableVariable(identifier.parent));
        if (!parameter && borrowsImmutableBinding && value.nativeError) {
            // Error properties already read the owned exception. An immutable
            // source name can share that binding without an unused native alias.
            this.defineVariable(identifier, value);
            return;
        }
        const platformEvent =
            value.kind === "platform-keyboard-event" ||
            value.kind === "platform-mouse-event";
        const nativeType = platformEvent
            ? "const auto&"
            : reference
              ? "auto&"
              : borrowsImmutableBinding
                ? "auto&"
                : value.kind === "number"
                  ? "double"
                  : value.kind === "boolean"
                    ? "bool"
                    : isStringValue(value)
                      ? "std::string"
                      : parameter && !copiesHandle && !reboundParameter
                        ? "auto&&"
                        : "auto";
        const ownsTemporaryArgument =
            parameter &&
            !sharedStorage &&
            !reboundParameter &&
            nativeType === "auto&&" &&
            value.nativeOwnedRvalue === true;
        let initializerCpp =
            value.kind === "number" && value.staticNumber !== undefined
                ? numberConstantValue(value.staticNumber).cpp
                : value.cpp;
        if (
            !sharedStorage &&
            !borrowsImmutableBinding &&
            referenceValue &&
            !reference &&
            (stableNativeBinding || (parameter && value.nativeLvalue))
        ) {
            this.context.reachJsData();
            initializerCpp = `bbl::js::snapshot_value(${initializerCpp})`;
        }
        if (sharedStorage) {
            if (isHandleKind(value.kind)) {
                const cppType = this.context.dataTypes.cppType({
                    kind: "handle",
                    handle: value.kind,
                });
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: `bbl::js::make_gc_shared<${cppType}>(${initializerCpp})`,
                    attributes: "[[maybe_unused]] ",
                });
            } else {
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: `bbl::js::make_gc_cell(${initializerCpp})`,
                    attributes: "[[maybe_unused]] ",
                });
            }
        } else {
            this.context.emit({
                kind: "declaration",
                type: nativeType,
                name: cppName,
                initializer: initializerCpp,
                attributes: "[[maybe_unused]] ",
            });
        }
        // A handle keeps its native type, so closures that capture it
        // have a concrete environment.
        if (
            isHandleKind(value.kind) &&
            (sharedStorage || nativeType === "auto")
        ) {
            const handleType = this.context.dataTypes.cppType({
                kind: "handle",
                handle: value.kind,
            });
            this.context.registerNativeBindingType(
                cppName,
                sharedStorage ? `std::shared_ptr<${handleType}>` : handleType,
            );
        }
        const storedCpp = sharedStorage ? `(*${cppName})` : cppName;
        const constantParameter =
            readOnlyParameter &&
            ((value.kind === "number" && value.staticNumber !== undefined) ||
                (value.kind === "string" && value.staticString !== undefined) ||
                (value.kind === "boolean" &&
                    value.staticBoolean !== undefined)) &&
            !value.parameterBinding;
        const stored: Value = {
            ...value,
            cpp: storedCpp,
            ...(sharedStorage ? { sharedStorageCpp: cppName } : {}),
            ...(parameter ? { parameterBinding: !constantParameter } : {}),
            ...(!parameter ? { nativeBinding: true } : {}),
            ...(parameter && value.staticElements
                ? {
                      staticElementsOwner: value.staticElementsOwner ?? value,
                  }
                : {}),
        };
        delete stored.nativeOwnedRvalue;
        if (!sharedStorage) delete stored.sharedStorageCpp;
        if (
            value.kind === "data" &&
            value.dataType?.kind === "struct" &&
            this.context.dataTypes.isReferenceStruct(value.dataType.name)
        ) {
            stored.objectIdentityCpp = `${storedCpp}.get()`;
            stored.optionalFoundCpp = `static_cast<bool>(${storedCpp})`;
            stored.truthinessCpp = stored.optionalFoundCpp;
        }
        if (value.kind === "animation-clip") {
            stored.animationFrameRate = `${storedCpp}.frame_rate`;
            stored.animationDuration = `${storedCpp}.duration`;
        }
        this.defineVariable(identifier, stored);
        if (
            parameter &&
            !sharedStorage &&
            !reboundParameter &&
            (borrowsImmutableBinding ||
                ownsTemporaryArgument ||
                (copiesHandle && !reference) ||
                nativeType === "std::string")
        ) {
            this.context.registerNativeConstBinding(cppName);
        }
    }

    /** Visit bindings and the generation facts nested inside their values. */
    public visitScopedValues(visitor: (value: Value) => void): void {
        const seen = new EmissionSet<Value>();
        const visit = (value: Value): void => {
            if (seen.has(value)) return;
            seen.add(value);
            const nested = [
                ...Object.values(value.recordProperties ?? {}),
                ...(value.staticElements ?? []),
                ...(value.tupleElements ?? []),
            ];
            visitor(value);
            for (const child of nested) visit(child);
        };
        for (const scope of this.variableScopes) {
            for (const binding of scope.values()) visit(binding.value);
        }
    }

    /** Invalidate one native array's complete snapshot through all aliases. */
    public invalidateStaticElements(
        value: Value,
        preserveCardinality = false,
    ): void {
        const owner = value.staticElementsOwner ?? value;
        const elements = owner.staticElements ?? value.staticElements;
        const cardinality =
            owner.collectionCardinality ?? value.collectionCardinality;
        if (cardinality && !preserveCardinality) {
            cardinality.count = undefined;
            delete cardinality.keys;
        }
        const invalidate = (candidate: Value): void => {
            if (
                candidate === value ||
                candidate === owner ||
                candidate.staticElementsOwner === owner ||
                (cardinality !== undefined &&
                    candidate.collectionCardinality === cardinality) ||
                (elements !== undefined &&
                    candidate.staticElements === elements)
            ) {
                if (owner.runtimeElementTemplate) {
                    candidate.runtimeElementTemplate =
                        owner.runtimeElementTemplate;
                }
                if (cardinality) candidate.collectionCardinality = cardinality;
                delete candidate.staticElements;
                delete candidate.staticElementsOwner;
            }
        };
        this.visitScopedValues(invalidate);
        invalidate(value);
        invalidate(owner);
    }

    /** Invalidate one native map/object snapshot through all shared aliases. */
    public invalidateRecordProperties(value: Value): void {
        const properties = value.recordProperties;
        if (!properties) return;
        const invalidate = (candidate: Value): void => {
            if (candidate.recordProperties === properties) {
                delete candidate.recordProperties;
            }
        };
        this.visitScopedValues(invalidate);
        invalidate(value);
    }

    /** Materialize mutable members when a compile-time value escapes. */
    public materializeEscapingValue(
        value: Value,
        label: string,
        node?: ts.Expression,
    ): Value {
        if (value.ownedCpp !== undefined) {
            return this.pinValueToTemporary(value, label, node);
        }
        if (value.kind === "callback") {
            const resolved =
                value.callbackDeclaration &&
                ts.isIdentifier(value.callbackDeclaration)
                    ? (this.lookupOptional(value.callbackDeclaration) ?? value)
                    : value;
            if (resolved.callbackDeclaration && !resolved.callbackRecordOwner) {
                return {
                    ...resolved,
                    callbackRecordOwner: {
                        kind: "record",
                        cpp: "",
                        ...this.context.captureRecordScopes(),
                    },
                };
            }
            return resolved;
        }
        if (value.kind === "record") {
            if (
                value.dataType?.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(value.dataType.name)
            ) {
                return value;
            }
            return this.materializeRecordScalars(value, label, true, node);
        }
        if (value.kind === "tuple" && value.tupleElements) {
            return {
                ...value,
                tupleElements: value.tupleElements.map((element, index) =>
                    this.materializeEscapingValue(element, `${label}_${index}`),
                ),
            };
        }
        return value;
    }

    /**
     * The stronger guarantee: bind every leaf of a value, bare scalars
     * included, so nothing emitted after this point can move it.
     *
     * **A lowering that emits statements while producing a value binds that
     * value; it does not splice it.** `enumMapLiteral`
     * (`src/compiler/data-lowering.ts`) states the same rule for the slots of a
     * reordered `Record` literal, and the inlined-call return is the other
     * place it has to hold: the caller decides which guarantee it needs by
     * calling this or `materializeEscapingValue`, rather than either policy
     * taking a mode flag.
     *
     * The leaf is deliberately not shared with `materializeRecordScalars`
     * below. That one gives a record member a native home, so it emits a
     * mutable local and folds a static value into a literal; this one refuses
     * a folded value outright and keeps an owning binding. One line each, and
     * the difference is the contract rather than an accident.
     */
    public pinValueToTemporary(
        value: Value,
        label: string,
        node?: ts.Expression,
    ): Value {
        if (value.parameterBinding) {
            // Writable parameters retain initial metadata for other lowering
            // decisions; a snapshot must read their current native value.
            value = { ...value };
            delete value.staticNumber;
            delete value.staticString;
            delete value.staticBoolean;
        }
        if (this.context.hasStableNativeBinding(value)) {
            this.context.useNativeValue(value);
            return value;
        }
        if (value.kind === "engine" && value.ownedEngineCpp) {
            const owner = this.context.allocateTemporaryCppName(
                `${label}_owner`,
            );
            this.context.reachJsData();
            this.context.emit({
                kind: "declaration",
                type: "const auto",
                name: owner,
                initializer: `bbl::js::snapshot_value(${value.ownedEngineCpp})`,
                attributes: "[[maybe_unused]] ",
            });
            const binding = this.context.registerNativeConstBinding(owner);
            const cpp = `(*${owner})`;
            const pinned: Value = {
                ...value,
                cpp,
                engineCpp: cpp,
                ownedEngineCpp: owner,
                stableOwnerCpp: owner,
                nativeBinding: true,
                nativeCaptures: [binding],
                nativeCompanionCaptures: {
                    ...value.nativeCompanionCaptures,
                    engineCpp: [binding],
                    ownedEngineCpp: [binding],
                },
            };
            this.context.describeNativeValue(pinned);
            return pinned;
        }
        if (
            ["text-data", "text-renderable", "text-vector"].includes(value.kind)
        ) {
            const retained = retainTextValue(this.context, value);
            this.context.registerNativeConstBinding(retained.cpp);
            this.context.describeNativeValue(retained);
            return retained;
        }
        if (value.kind === "callback") {
            return this.materializeEscapingValue(value, label);
        }
        const snapshotsData =
            value.kind === "data" &&
            value.dataType !== undefined &&
            (isOpaqueReference(value.dataType) ||
                isTypedArrayType(value.dataType) ||
                [
                    "arraybuffer",
                    "dataview",
                    "bufferview",
                    "json",
                    "optional",
                    "union",
                    "vector",
                    "map",
                    "set",
                    "iterator",
                    "tuple",
                    "product",
                    "enummap",
                ].includes(value.dataType.kind));
        if (isJsonValue(value) || snapshotsData) {
            const cpp = this.context.allocateTemporaryCppName(label);
            this.context.reachJsData();
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cpp,
                initializer:
                    value.ownedCpp ??
                    (value.nativeLvalue || cppIdentifierPattern.test(value.cpp)
                        ? `bbl::js::snapshot_value(${value.cpp})`
                        : value.cpp),
            });
            const pinned = { ...value, cpp, nativeBinding: true as const };
            delete pinned.ownedCpp;
            for (const key of [
                "objectIdentityCpp",
                "optionalFoundCpp",
                "truthinessCpp",
                "optionalStorageCpp",
            ] as const) {
                const spelling = pinned[key];
                if (spelling?.includes(value.cpp))
                    pinned[key] = spelling.replaceAll(value.cpp, cpp);
            }
            this.context.registerNativeConstBinding(cpp);
            this.context.describeNativeValue(pinned);
            return pinned;
        }
        if (isHandleKind(value.kind) && !value.nativeBinding) {
            const cpp = this.context.allocateTemporaryCppName(label);
            // A scene snapshot owns its selected shared state while remaining
            // writable through the native Scene& APIs after source rebinding.
            const type = value.kind === "engine" ? "auto&" : "auto";
            this.context.emit({
                kind: "declaration",
                type,
                name: cpp,
                initializer:
                    value.kind === "engine"
                        ? value.cpp
                        : value.nativeLvalue ||
                            cppIdentifierPattern.test(value.cpp)
                          ? `bbl::js::snapshot_value(${value.cpp})`
                          : value.cpp,
                attributes: "[[maybe_unused]] ",
            });
            const pinned = {
                ...value,
                cpp,
                ...(value.kind === "engine" ? { engineCpp: cpp } : {}),
                nativeBinding: true as const,
            };
            if (type === "auto") this.context.registerNativeConstBinding(cpp);
            this.context.describeNativeValue(pinned);
            return pinned;
        }
        if (value.kind === "data" && value.dataType?.kind === "struct") {
            // A struct held under a plain name or read from storage reads
            // twice for free. A computed one -- a call, an indexed read, a
            // member of a computed record -- is bound once, and the identity
            // and presence spellings derived from it follow the temporary; a
            // flag another source supplied (a search's own found variable)
            // stays as it is.
            const cpp = this.context.allocateTemporaryCppName(label);
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cpp,
                initializer:
                    value.ownedCpp ??
                    (value.nativeLvalue || cppIdentifierPattern.test(value.cpp)
                        ? `bbl::js::snapshot_value(${value.cpp})`
                        : value.cpp),
            });
            const derived = this.context.dataLowerer.leafValue(
                value.cpp,
                value.dataType,
            );
            const fresh = this.context.dataLowerer.leafValue(
                cpp,
                value.dataType,
            );
            const pinned: Value = {
                ...value,
                cpp,
                nativeBinding: true as const,
            };
            delete pinned.ownedCpp;
            for (const key of [
                "objectIdentityCpp",
                "optionalFoundCpp",
            ] as const) {
                const spelling = fresh[key];
                if (spelling !== undefined && pinned[key] === derived[key])
                    pinned[key] = spelling;
            }
            this.context.registerNativeConstBinding(cpp);
            this.context.describeNativeValue(pinned);
            return pinned;
        }
        if (value.kind === "record") {
            if (
                value.dataType?.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(value.dataType.name)
            ) {
                return value;
            }
            return this.materializeRecordScalars(value, label, true, node);
        }
        if (value.kind === "tuple" && value.tupleElements) {
            return {
                ...value,
                tupleElements: value.tupleElements.map((element, index) =>
                    this.pinValueToTemporary(element, `${label}_${index}`),
                ),
            };
        }
        // A folded value is already a constant, so it is left alone -- and has
        // to be, since its width belongs to the sink that consumes it
        // ([fidelity](../docs/fidelity.md#numeric-width)).
        const cppType =
            value.kind === "number" && value.staticNumber === undefined
                ? "double"
                : value.kind === "boolean" && value.staticBoolean === undefined
                  ? "bool"
                  : (value.kind === "string" ||
                          value.dataType?.kind === "string") &&
                      value.staticString === undefined
                    ? "std::string"
                    : undefined;
        if (!cppType) return value;
        const cppName = this.context.allocateTemporaryCppName(label);
        const snapshot =
            cppType === "std::string" &&
            (value.nativeLvalue || cppIdentifierPattern.test(value.cpp));
        if (snapshot) this.context.reachJsData();
        this.context.emit({
            kind: "declaration",
            type: `const ${cppType}`,
            name: cppName,
            initializer: snapshot
                ? `bbl::js::snapshot_value(${value.cpp})`
                : value.cpp,
            attributes: "[[maybe_unused]] ",
        });
        const binding = this.context.registerNativeConstBinding(cppName);
        this.context.registerNativeBindingType(cppName, `const ${cppType}`);
        return {
            ...value,
            cpp: cppName,
            nativeCaptures: [binding],
            nativeBinding: true,
        };
    }

    /**
     * A plain-data tuple given a native home, so its lanes can be indexed.
     *
     * `tupleComponents` reads its base once per lane, which is wrong for
     * any expression carrying an effect -- a scene-local call above all,
     * since the inliner emits its body where the call sits and evaluating
     * it three times would run that body three times. Every reader that
     * indexes a tuple whose expression is not free to repeat binds it
     * here, which is the tuple-shaped case of the rule
     * `pinValueToTemporary` above states.
     */
    public bindDataTuple(
        value: Value,
        arity: number,
        label = "tuple",
        initializerBoundary?: number,
    ): string {
        if (this.context.hasStableNativeBinding(value)) {
            this.context.useNativeValue(value);
            return value.cpp;
        }
        const cppName = this.context.allocateTemporaryCppName(label);
        const readOnly = value.readOnly === true;
        const initializer =
            initializerBoundary === undefined
                ? value.cpp
                : this.context.takeNativeTemporary(
                      value.cpp,
                      initializerBoundary,
                  );
        this.context.emit({
            kind: "declaration",
            type: readOnly
                ? "const auto&"
                : `const ${this.context.dataTypes.cppType({
                      kind: "tuple",
                      arity,
                  })}`,
            name: cppName,
            initializer:
                readOnly || initializer !== value.cpp
                    ? initializer
                    : `bbl::js::snapshot_value(${value.cpp})`,
        });
        this.context.useNativeBinding(
            this.context.registerNativeConstBinding(cppName, true),
        );
        return cppName;
    }

    /** Project a stored plain object once, preserving replacement of its members. */
    public referenceRecordValue(
        value: Value,
        node: ts.Expression,
    ): Value | undefined {
        if (
            value.kind !== "record" ||
            value.staticJson !== undefined ||
            this.context.classOf(value) !== undefined ||
            Object.keys(value.recordMethods ?? {}).length !== 0 ||
            Object.keys(value.recordGetters ?? {}).length !== 0 ||
            Object.keys(value.recordSetters ?? {}).length !== 0
        )
            return undefined;
        const mutableContainer = this.recordHasMutableContainer(value);
        if (
            !mutableContainer &&
            !Object.values(value.recordProperties ?? {}).some(
                (field) =>
                    field.kind === "tuple" && field.tupleElements?.length === 0,
            )
        )
            return undefined;
        const sourceType = nativeReturnTsType(
            this.context.checker,
            this.context.checker.getContextualType(node) ??
                this.context.checker.getTypeAtLocation(node),
        );
        if (!sourceType) return undefined;
        const stored = this.context.dataTypes.fromTsType(sourceType, node);
        // An empty callback list has no element values from which to infer
        // storage. Its declared element type still requires a shared container
        // when a returned record is captured and populated by another closure.
        const callbackContainer =
            stored?.kind === "struct" &&
            this.context.dataTypes
                .structFields(stored.name, node)
                .some(
                    (field) =>
                        field.type.kind === "vector" &&
                        field.type.element.kind === "function",
                );
        if (!mutableContainer && !callbackContainer) return undefined;
        if (callbackContainer)
            this.context.dataTypes.markStoredObjectReferences(stored);
        if (
            stored?.kind !== "struct" ||
            !this.context.dataTypes.isReferenceStruct(stored.name) ||
            (this.context.dataTypes.carriesFunction(stored) &&
                !callbackContainer)
        )
            return undefined;
        const projected = this.context.dataLowerer.leafValue(
            this.context.dataLowerer.compileKnownValueForSink(
                value,
                stored,
                node,
            ),
            stored,
        );
        // This expression constructs an object; it cannot be a missing
        // element. Do not snapshot a redundant presence bit at each binding.
        delete projected.optionalFoundCpp;
        return { ...projected, freshData: true };
    }

    private recordHasMutableContainer(
        value: Value,
        seen = new EmissionSet<Value>(),
    ): boolean {
        if (seen.has(value)) return false;
        seen.add(value);
        // Scalar/opaque-handle records already have shared field homes, and
        // retain generation metadata required by resource factories. Whole
        // object storage is needed when a replaceable container can escape.
        if (value.kind === "data" && value.dataType) {
            return this.isMutableRecordContainer(value.dataType);
        }
        return (
            value.kind === "record" &&
            Object.values(value.recordProperties ?? {}).some((property) =>
                this.recordHasMutableContainer(property, seen),
            )
        );
    }

    public bindCameraVector(value: Value): Value {
        const vector = value.cameraVector;
        if (!vector || vector.bound) return value;
        const cpp = this.context.allocateTemporaryCppName(
            "camera_vector_owner",
        );
        this.context.emit({
            kind: "declaration",
            type: "const auto",
            name: cpp,
            initializer: vector.owner.cpp,
            attributes: "[[maybe_unused]] ",
        });
        const owner = { ...vector.owner, cpp };
        this.context.describeNativeValue(owner);
        const cameraVector = { ...vector, owner, bound: true as const };
        return {
            ...value,
            cameraVector,
            recordProperties: cameraVectorProperties(cameraVector),
        };
    }

    /** Retain the handle, so vector aliases survive arena growth and source rebinding. */
    public bindSceneNodeVector(value: Value): Value {
        const vector = value.sceneNodeVector;
        if (!vector || vector.bound) return value;
        const cpp = this.context.allocateTemporaryCppName("vector_owner");
        this.context.emit({
            kind: "declaration",
            type: "const auto",
            name: cpp,
            initializer: vector.owner.cpp,
            attributes: "[[maybe_unused]] ",
        });
        const owner = { ...vector.owner, cpp };
        this.context.describeNativeValue(owner);
        return {
            ...value,
            sceneNodeVector: { ...vector, owner, bound: true },
            recordProperties: sceneNodeVectorProperties(
                owner,
                vector.transform,
            ),
        };
    }

    /** Materialize mutable members when a compile-time record escapes. */
    public materializeRecordScalars(
        record: Value,
        label: string,
        preserveIdentity = false,
        node?: ts.Expression,
    ): Value {
        if (record.retainedNativeRecord) return record;
        if (record.cameraVector) {
            return this.bindCameraVector(record);
        }
        if (record.sceneNodeVector) {
            return this.bindSceneNodeVector(record);
        }
        const stored = node && this.referenceRecordValue(record, node);
        if (stored) {
            // Choose the whole-object home before boxing individual fields.
            // Inlined calls bind it here so later sinks share this allocation.
            const cpp = this.context.allocateTemporaryCppName(label);
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cpp,
                initializer: stored.cpp,
            });
            return {
                ...stored,
                cpp: `std::move(${cpp})`,
                objectIdentityCpp: `${cpp}.get()`,
            };
        }
        const properties: Record<string, Value> = {};
        const classFields = this.context.classOf(record) !== undefined;
        const scalarFields = Object.entries(
            record.recordProperties ?? {},
        ).filter(
            ([, property]) =>
                !property.sharedRecordScalar &&
                !property.sharedRecordContainer &&
                !(property.readOnly && property.staticString !== undefined) &&
                !(
                    classFields &&
                    property.sharedStorageCpp &&
                    property.cpp === `(*${property.sharedStorageCpp})`
                ) &&
                (property.kind === "number" ||
                    property.kind === "boolean" ||
                    property.staticString !== undefined),
        );
        const packedScalars: Array<{
            name: string;
            cpp: string;
            type: string;
            value: Value;
        }> = [];
        for (const [name, property] of Object.entries(
            record.recordProperties ?? {},
        )) {
            if (property.readOnly && property.staticString !== undefined) {
                properties[name] = property;
                continue;
            }
            if (
                property.sharedRecordScalar ||
                (classFields &&
                    property.sharedStorageCpp &&
                    property.cpp === `(*${property.sharedStorageCpp})`)
            ) {
                properties[name] = property;
                continue;
            }
            if (property.sharedRecordContainer) {
                properties[name] = property;
                continue;
            }
            if (property.kind === "record") {
                properties[name] = this.materializeRecordScalars(
                    property,
                    `${label}_${name}`,
                    preserveIdentity,
                );
                continue;
            }
            if (
                property.kind === "data" &&
                property.dataType &&
                !property.nativeBinding &&
                this.isMutableRecordContainer(property.dataType)
            ) {
                const cppName = this.context.allocateTemporaryCppName(
                    `${label}_${name}`,
                );
                const cppType = this.context.dataTypes.cppType(
                    property.dataType,
                );
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: `bbl::js::make_gc_shared<${cppType}>(${property.cpp})`,
                    attributes: "[[maybe_unused]] ",
                });
                properties[name] = {
                    ...property,
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    sharedRecordContainer: true,
                };
                continue;
            }
            const cppName = this.context.allocateTemporaryCppName(
                `${label}_${name}`,
            );
            if (
                scalarFields.length > 1 &&
                (property.kind === "number" ||
                    property.kind === "boolean" ||
                    property.staticString !== undefined)
            ) {
                const {
                    staticNumber,
                    staticBoolean: _staticBoolean,
                    ...dynamicProperty
                } = property;
                const type =
                    property.kind === "number"
                        ? CPP_SCALAR.number
                        : property.kind === "boolean"
                          ? CPP_SCALAR.boolean
                          : CPP_SCALAR.string;
                const initial =
                    property.kind === "number"
                        ? staticNumber === undefined
                            ? property.cpp
                            : numberConstantValue(staticNumber).cpp
                        : property.kind === "boolean"
                          ? property.cpp
                          : this.context.cppString(property.staticString!);
                // Snapshot in property order; the shared allocation follows all initializers.
                this.context.emit({
                    kind: "declaration",
                    type: `const ${type}`,
                    name: cppName,
                    initializer: initial,
                });
                properties[name] = property;
                packedScalars.push({
                    name,
                    cpp: cppName,
                    type,
                    value:
                        property.staticString !== undefined
                            ? {
                                  kind: "data",
                                  cpp: cppName,
                                  dataType: { kind: "string" },
                              }
                            : dynamicProperty,
                });
                continue;
            }
            if (property.kind === "number") {
                const { staticNumber: _staticNumber, ...dynamicProperty } =
                    property;
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: `bbl::js::make_gc_shared<double>(${
                        property.staticNumber === undefined
                            ? property.cpp
                            : numberConstantValue(property.staticNumber).cpp
                    })`,
                    attributes: "[[maybe_unused]] ",
                });
                properties[name] = {
                    ...dynamicProperty,
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    sharedRecordScalar: true,
                };
                continue;
            }
            if (property.kind === "boolean") {
                const { staticBoolean: _staticBoolean, ...dynamicProperty } =
                    property;
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: `bbl::js::make_gc_shared<bool>(${property.cpp})`,
                    attributes: "[[maybe_unused]] ",
                });
                properties[name] = {
                    ...dynamicProperty,
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    sharedRecordScalar: true,
                };
                continue;
            }
            if (property.staticString !== undefined) {
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: `bbl::js::make_gc_shared<std::string>(${this.context.cppString(property.staticString)})`,
                    attributes: "[[maybe_unused]] ",
                });
                properties[name] = {
                    kind: "data",
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    dataType: { kind: "string" },
                    sharedRecordScalar: true,
                };
                continue;
            }
            properties[name] = property;
        }
        if (packedScalars.length) {
            const storage = this.context.allocateTemporaryCppName(
                `${label}_scalars`,
            );
            const type = `std::tuple<${packedScalars.map((field) => field.type).join(", ")}>`;
            this.context.emit({
                kind: "declaration",
                type: `std::shared_ptr<${type}>`,
                name: storage,
                initializer: `bbl::js::make_gc_shared<${type}>(std::tuple{${packedScalars.map((field) => field.cpp).join(", ")}})`,
            });
            packedScalars.forEach((field, index) => {
                properties[field.name] = {
                    ...field.value,
                    cpp: `std::get<${index}>(*${storage})`,
                    sharedStorageCpp: storage,
                    sharedRecordScalar: true,
                };
            });
        }
        for (const property of Object.values(properties))
            this.context.describeNativeValue(property);
        if (preserveIdentity) {
            // Aliases (including native proxy dispatchers) key runtime identity
            // by this table. Materializing its leaves must not replace it.
            Object.assign((record.recordProperties ??= {}), properties);
            return record;
        }
        return valueForKind(record.kind, {
            ...record,
            recordProperties: properties,
        });
    }

    private isMutableRecordContainer(dataType: DataType): boolean {
        if (dataType.kind === "optional") {
            return this.isMutableRecordContainer(dataType.inner);
        }
        return (
            passesByReferenceKind(dataType) &&
            dataType.kind !== "tuple" &&
            dataType.kind !== "enummap"
        );
    }
}

export function cameraVectorProperties(
    vector: NonNullable<Value["cameraVector"]>,
): Record<string, Value> {
    const record = `${recordAt(`${vector.owner.engineCpp}.cameras`, vector.owner.cpp)}.${vector.field}`;
    return Object.fromEntries(
        ["x", "y", "z"].map((axis) => [
            axis,
            {
                kind: "number",
                cpp: `${record}.${axis}`,
                dataType: { kind: "number" },
                engineCpp: vector.owner.engineCpp,
            } satisfies Value,
        ]),
    );
}

export function sceneNodeVectorProperties(
    owner: Value & { engineCpp: string },
    transform: SceneNodeTransformDescriptor,
    freshData = false,
): Record<string, Value> {
    const engine = owner.engineCpp;
    const vector =
        owner.kind === "asset-root"
            ? transform.nativeField === "rotation"
                ? `bbl::asset_root_rotation(${engine}, ${owner.cpp})`
                : `${recordAt(`${engine}.assets`, owner.cpp)}.root_${transform.nativeField}`
            : owner.kind === "scene-node"
              ? `bbl::scene_node_${transform.nativeField}(${engine}, ${owner.cpp})`
              : `${recordAt(`${engine}.${owner.kind === "mesh" ? "meshes" : "transform_nodes"}`, owner.cpp)}.${transform.nativeField}`;
    return Object.fromEntries(
        transform.components.map((name) => [
            name,
            {
                kind: "number",
                cpp: `${vector}.${name}`,
                dataType: { kind: "number" },
                engineCpp: engine,
                ...(freshData ? { freshData: true } : {}),
            } satisfies Value,
        ]),
    );
}
