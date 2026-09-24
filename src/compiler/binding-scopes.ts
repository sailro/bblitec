// The lexical scope stack of one compilation: the binding each source name
// has in the scope being lowered, how a declaration, parameter or rebind
// changes it, and the refusals a read of it can raise.
import ts from "typescript";
import {
    cppIdentifierPattern,
    sanitizeCppIdentifier,
} from "../cpp-literals.js";
import { syntaxKindName } from "../source-location.js";
import { findAnalysisNodeWithState } from "./analysis-walk.js";
import { isHandleKind, type DataTypeRegistry } from "./data-types.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
    EmissionWeakSet,
} from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { numberConstantValue } from "./number-intrinsics.js";
import {
    isCompileTimeOnlyValue,
    isStringValue,
    type Value,
    type VariableBinding,
} from "./types.js";
import { isSupportedFunction, parameterIsReadOnly } from "./user-functions.js";

/** What the scope stack asks of the compiler: symbols, values and native storage. */
interface BindingScopesContext extends Pick<
    LoweringServices,
    | "activeNativeReturnType"
    | "allocateBlockPrefix"
    | "checker"
    | "dataLowerer"
    | "dataTypes"
    | "emit"
    | "fail"
    | "identifierIsRebound"
    | "isInFrameCallback"
    | "options"
    | "pinValueToTemporary"
    | "reachJsData"
    | "registerNativeConstBinding"
    | "symbols"
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
                this.context.pinValueToTemporary(value, "engine"),
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
}
