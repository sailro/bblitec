import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
} from "./emission-transaction.js";
import ts from "typescript";
import { emitReachableStatements } from "./loop-control.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";
import { isDeclaredInside } from "./syntax.js";
import type {
    CapturedClosure,
    ClosureCaptures,
    NativeCaptureBinding,
} from "./closure-captures.js";
import type { PlatformCalls } from "./platform-calls.js";
import type {
    FrameCallbackSignature,
    Value,
    VariableBinding,
} from "./types.js";
import { frameCallbackParameterType } from "./types.js";
import {
    physicsEventInfoType,
    physicsEventInfoValue,
} from "./intrinsics/physics.js";
import type { LoweringServices } from "./lowering-services.js";

/** What callback lowering reads of the compiler. */
interface CallbackContext extends Pick<
    LoweringServices,
    | "allocateBlockPrefix"
    | "allocateTemporaryCppName"
    | "beginNativeFunctionBody"
    | "bindings"
    | "captureEmittedLines"
    | "captureManagedClosureLines"
    | "captureRecordScopes"
    | "checker"
    | "compileCallbackWithValues"
    | "compileValue"
    | "dataLowerer"
    | "dataTypes"
    | "declarations"
    | "emit"
    | "emitDiscardedValue"
    | "emitExpressionAsStatement"
    | "emitStatement"
    | "endNativeFunctionBody"
    | "engineLifecycle"
    | "fail"
    | "nativeEmission"
    | "options"
    | "probeEmission"
    | "reachJsData"
    | "registerNativeBinding"
    | "registerNativeBindingType"
    | "registerNativeConstBinding"
    | "statementTerminatesAfterLowering"
    | "symbols"
    | "unwrap"
    | "useNativeValue"
    | "withRecordScopes"
> {
    /** The emitted entry-body lines. */
    readonly body: string[];
    /** How many frame callbacks enclose the current emission. */
    frameCallbackDepth: number;
    readonly managedCaptures: ClosureCaptures[];
    readonly platform: Pick<PlatformCalls, "platformEventCallbackIdentity">;
    /** The document-hidden flag platform callbacks read, while one is lowered. */
    platformDocumentHiddenCpp: string | undefined;
    useNativeBinding(binding: NativeCaptureBinding): void;
}

/**
 * Native callbacks: frame callbacks and their named and typed-array forms, platform event
 * callbacks with forward-hoisted bindings, and the physics collision, trigger and character
 * callbacks deferred to the end of the entry.
 */
export class CallbackLowerer {
    constructor(private readonly context: CallbackContext) {}

    /**
     * Collision listeners are registered before every startup assignment has
     * necessarily run. Their native bodies are specialized only after the
     * entry walk is complete, while retaining registration-site scopes.
     */
    private readonly deferredPhysicsCallbacks: Array<{
        /** Which pinned event stream the handler is registered on. */
        event: "collision" | "trigger" | "character";
        callback: ts.Identifier | ts.ArrowFunction | ts.FunctionExpression;
        cppName: string;
        eventName: string;
        node: ts.Node;
        scopes: ReadonlyArray<Map<ts.Symbol, VariableBinding>>;
    }> = emissionArray([]);

    /**
     * An inline callback, as the lambda the caller's entry point takes.
     *
     * `signature` is what that entry point declares: a before-render or
     * after-step callback receives the frame delta, and a deferred
     * (`setTimeout`) one receives nothing, because a timeout is not a
     * frame. The body lowers identically either way -- only what the
     * lambda is allowed to name differs, and a deferred callback naming a
     * delta parameter has nowhere to get one, so it refuses.
     */
    public compileFrameCallback(
        expression: ts.Expression,
        signature: FrameCallbackSignature = "delta",
        retainCaptures = false,
    ): string {
        const unwrapped = this.context.unwrap(expression);
        const asyncType =
            this.context.dataLowerer.promiseCallbackType(unwrapped);
        if (asyncType) {
            const noArguments =
                signature === "void" || signature === "interval";
            if (asyncType.parameters.length > (noArguments ? 0 : 1))
                this.context.fail(
                    expression,
                    "Deferred async callback declares more parameters than its scheduler supplies.",
                );
            const callback = this.context.dataLowerer.prepareCallbackValue(
                unwrapped,
                "deferred_async",
            )!;
            const parameter = noArguments
                ? undefined
                : this.context.allocateTemporaryCppName("frame_delta");
            const compiled = this.context.captureManagedClosureLines(() => {
                const arguments_: Value[] = parameter
                    ? [
                          {
                              kind: "number",
                              cpp: parameter,
                              nativeCaptures: [
                                  this.context.registerNativeBinding(
                                      parameter,
                                      false,
                                      false,
                                      frameCallbackParameterType(signature),
                                  ),
                              ],
                          },
                      ]
                    : [];
                this.context.emitDiscardedValue(
                    this.context.dataLowerer.compileFunctionValueCall(
                        callback,
                        arguments_,
                        expression,
                    ),
                );
            });
            return this.context.nativeEmission.renderSharedClosure(
                compiled,
                "void",
                unwrapped,
                parameter
                    ? `[[maybe_unused]] ${frameCallbackParameterType(signature)} ${parameter}`
                    : "",
                parameter ? [parameter] : [],
            );
        }
        if (ts.isIdentifier(unwrapped)) {
            if (signature === "void") {
                const bound = this.context.bindings.lookupOptional(unwrapped);
                if (
                    bound?.kind === "callback" &&
                    bound.cpp.length > 0 &&
                    bound.nativeCallbackParameterTypes?.length === 0
                ) {
                    const captureByValue =
                        retainCaptures ||
                        !!this.context.options.workers ||
                        this.context.frameCallbackDepth > 0 ||
                        this.context.managedCaptures.length > 0;
                    const emitBody = () => {
                        this.context.useNativeValue(bound);
                        this.context.emit(`${bound.cpp}();`);
                    };
                    const compiled = this.context.captureManagedClosureLines(
                        emitBody,
                        captureByValue ? false : "entry",
                    );
                    return this.context.nativeEmission.renderSharedClosure(
                        compiled,
                        "void",
                        unwrapped,
                        "",
                        [],
                    );
                }
                if (
                    this.context.options.workers &&
                    (bound?.kind === "callback" || !bound)
                ) {
                    return this.compilePlatformCallback(
                        unwrapped,
                        undefined,
                        [],
                        undefined,
                        true,
                        false,
                    ).cpp;
                }
                this.context.fail(
                    unwrapped,
                    `A named deferred callback must resolve to a native zero-argument function (received ${bound?.kind ?? "unbound"}).`,
                );
            }
            return this.compileNamedFrameCallback(
                unwrapped,
                signature,
                retainCaptures,
            );
        }
        if (
            !ts.isArrowFunction(unwrapped) &&
            !ts.isFunctionExpression(unwrapped)
        ) {
            this.context.fail(
                unwrapped,
                "A frame, timer or listener callback must be an inline function or a named local function.",
            );
        }
        if (unwrapped.parameters.length > 1) {
            this.context.fail(
                unwrapped,
                "onBeforeRender callback supports at most one deltaMs parameter.",
            );
        }
        if (
            (signature === "void" || signature === "interval") &&
            unwrapped.parameters.length > 0
        ) {
            this.context.fail(
                unwrapped,
                "A timer callback takes no parameters.",
            );
        }

        const parameter = unwrapped.parameters[0];
        if (parameter && !ts.isIdentifier(parameter.name)) {
            this.context.fail(
                parameter.name,
                "onBeforeRender deltaMs parameter must be an identifier.",
            );
        }
        const parameterName =
            parameter && ts.isIdentifier(parameter.name)
                ? parameter.name.text
                : undefined;
        const parameterCppName = parameterName
            ? this.context.allocateTemporaryCppName("frame_delta")
            : undefined;

        // Everything the outermost frame callback pushes lives on its own
        // stack frame; a deferred body may not reach into it.
        const previousFrameFloor =
            this.context.bindings.frameCallbackScopeFloor;
        if (this.context.frameCallbackDepth === 0) {
            this.context.bindings.frameCallbackScopeFloor =
                this.context.bindings.variableScopes.length;
        }
        const previousDeferredScopes =
            this.context.bindings.deferredCaptureScopes;
        const previousPlatformEventCaptureFloor =
            this.context.bindings.escapingPlatformEventCaptureFloor;
        if (this.context.frameCallbackDepth > 0) {
            this.context.bindings.escapingPlatformEventCaptureFloor =
                this.context.bindings.variableScopes.length;
        }
        this.context.bindings.refuseEscapingPlatformEventCapturesIn(unwrapped);
        this.context.bindings.deferredCaptureScopes =
            (signature === "void" || signature === "interval") &&
            this.context.bindings.frameCallbackScopeFloor !== undefined
                ? new EmissionSet(
                      this.context.bindings.variableScopes.slice(
                          this.context.bindings.frameCallbackScopeFloor,
                      ),
                  )
                : undefined;
        this.context.bindings.pushScope(this.context.allocateBlockPrefix());
        // This body is emitted into a real native callback lambda. A source
        // `return` therefore leaves that lambda directly, including when it
        // guards statements later in the callback; it is not an inlined
        // function return that needs the breakable wrapper path.
        this.context.beginNativeFunctionBody(undefined, true);
        const captureByValue =
            retainCaptures ||
            !!this.context.options.workers ||
            this.context.frameCallbackDepth > 0 ||
            this.context.managedCaptures.length > 0;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                if (parameter && ts.isIdentifier(parameter.name)) {
                    this.context.registerNativeBindingType(
                        parameterCppName!,
                        frameCallbackParameterType(signature),
                    );
                    this.context.bindings.defineVariable(parameter.name, {
                        kind: "number",
                        cpp: parameterCppName!,
                    });
                }
                this.context.frameCallbackDepth += 1;
                try {
                    // A concise arrow body is one expression whose value the
                    // pinned callback contract discards, so it lowers as the
                    // statement it would have been written as.
                    if (ts.isBlock(unwrapped.body)) {
                        emitReachableStatements(
                            this.context,
                            unwrapped.body.statements,
                        );
                    } else {
                        this.context.emitExpressionAsStatement(unwrapped.body);
                    }
                } finally {
                    this.context.frameCallbackDepth -= 1;
                }
            };
            compiled = this.context.captureManagedClosureLines(
                emitBody,
                captureByValue ? false : "entry",
            );
        } finally {
            this.context.endNativeFunctionBody();
            this.context.bindings.popScope();
            this.context.bindings.deferredCaptureScopes =
                previousDeferredScopes;
            this.context.bindings.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
            this.context.bindings.frameCallbackScopeFloor = previousFrameFloor;
        }
        // A source callback may name its delta and then not reach it --
        // most often because a branch the scene's own query folds away was
        // the only reader, as `?freeze=1` does to a crowd step. The
        // parameter still has to be there, because the signature is the
        // pin's, so it is announced unused unconditionally, exactly as
        // `compileNamedFrameCallback` below does: the attribute is legal on
        // a parameter that IS read, and asking the question per callback
        // would be a second answer to it.
        const cppParameter = parameterName
            ? `[[maybe_unused]] ` +
              `${frameCallbackParameterType(signature)} ` +
              `${parameterCppName}`
            : frameCallbackParameterType(signature);
        const lambdaParameter =
            signature === "void" || signature === "interval"
                ? ""
                : cppParameter;
        return this.context.nativeEmission.renderSharedClosure(
            compiled,
            "void",
            unwrapped,
            lambdaParameter,
            parameterCppName ? [parameterCppName] : [],
        );
    }

    /** A retained zero-argument callback with the same capture checks as timers. */
    public compileVoidCallback(expression: ts.Expression): string {
        const node = this.context.unwrap(expression);
        if (
            ts.isCallExpression(node) ||
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node) ||
            (ts.isIdentifier(node) &&
                this.context.bindings.lookupOptional(node)?.dataType?.kind ===
                    "function")
        )
            return this.context.dataLowerer.compileForSink(expression, {
                kind: "function",
                parameters: [],
            });
        return this.compileFrameCallback(expression, "void");
    }

    /** A retained CSM receiver callback over the pin's 80-float payload. */
    public compileF32ArrayCallback(expression: ts.Expression): string {
        const callback = this.context.unwrap(expression);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            this.context.fail(
                callback,
                "A CSM receiver update requires a local function or function literal.",
            );
        }
        const dataName =
            this.context.allocateTemporaryCppName("csm_receiver_data");
        this.context.registerNativeBindingType(
            dataName,
            "const bbl::js::F32Array",
        );
        const previousDepth = this.context.frameCallbackDepth;
        this.context.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                const binding = this.context.registerNativeConstBinding(
                    dataName,
                    true,
                );
                const result = this.context.compileCallbackWithValues(
                    callback,
                    [
                        {
                            kind: "data",
                            cpp: dataName,
                            dataType: { kind: "f32array" },
                            borrowedData: true,
                            nativeCaptures: [binding],
                        },
                    ],
                    expression,
                );
                this.context.emitDiscardedValue(result);
            };
            compiled = this.context.captureManagedClosureLines(
                emitBody,
                previousDepth === 0 ? "entry" : false,
            );
        } finally {
            this.context.frameCallbackDepth = previousDepth;
        }
        return this.context.nativeEmission.renderSharedClosure(
            compiled,
            "void",
            expression,
            `[[maybe_unused]] const bbl::js::F32Array& ${dataName}`,
            [dataName],
        );
    }

    private compileNamedFrameCallback(
        identifier: ts.Identifier,
        signature: Exclude<FrameCallbackSignature, "void">,
        retainCaptures: boolean,
    ): string {
        const parameter =
            signature === "interval"
                ? undefined
                : this.context.allocateTemporaryCppName("frame_callback_value");
        const previousDeferredScopes =
            this.context.bindings.deferredCaptureScopes;
        const previousPlatformEventCaptureFloor =
            this.context.bindings.escapingPlatformEventCaptureFloor;
        if (this.context.frameCallbackDepth > 0) {
            this.context.bindings.escapingPlatformEventCaptureFloor =
                this.context.bindings.variableScopes.length;
        }
        this.context.bindings.refuseEscapingPlatformEventCapturesIn(identifier);
        if (signature === "interval") {
            this.context.bindings.deferredCaptureScopes =
                this.context.bindings.frameCallbackScopeFloor === undefined
                    ? undefined
                    : new EmissionSet(
                          this.context.bindings.variableScopes.slice(
                              this.context.bindings.frameCallbackScopeFloor,
                          ),
                      );
        }
        const captureByValue =
            retainCaptures ||
            !!this.context.options.workers ||
            this.context.frameCallbackDepth > 0 ||
            this.context.managedCaptures.length > 0;
        this.context.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                if (parameter)
                    this.context.registerNativeBinding(
                        parameter,
                        false,
                        false,
                        frameCallbackParameterType(signature),
                    );
                const stored = this.context.bindings.lookupOptional(identifier);
                const parameters = stored?.nativeCallbackParameterTypes;
                if (
                    stored?.kind === "callback" &&
                    stored.cpp.length > 0 &&
                    parameters &&
                    parameters.length <= 1 &&
                    parameters.every((type) => type?.kind === "number") &&
                    (parameters.length === 0 || parameter)
                ) {
                    this.context.useNativeValue(stored);
                    this.context.emit(
                        `${stored.cpp}(${parameters.length === 0 ? "" : parameter});`,
                    );
                    return;
                }
                const value = this.context.compileCallbackWithValues(
                    identifier,
                    parameter ? [{ kind: "number", cpp: parameter }] : [],
                    identifier,
                    false,
                    { frameDriven: true },
                );
                if (value.cpp.length > 0) {
                    this.context.emit(`${value.cpp};`);
                }
            };
            compiled = this.context.captureManagedClosureLines(
                emitBody,
                captureByValue ? false : "entry",
            );
        } finally {
            this.context.frameCallbackDepth -= 1;
            this.context.bindings.deferredCaptureScopes =
                previousDeferredScopes;
            this.context.bindings.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
        }
        const lambdaParameter = parameter
            ? `[[maybe_unused]] ${frameCallbackParameterType(signature)} ${parameter}`
            : "";
        return this.context.nativeEmission.renderSharedClosure(
            compiled,
            "void",
            identifier,
            lambdaParameter,
            parameter ? [parameter] : [],
        );
    }

    public platformEventCallbackIdentity(
        callback: Value,
        node: ts.Node,
    ): string {
        return this.context.platform.platformEventCallbackIdentity(
            callback,
            node,
        );
    }

    public readonly hoistedCallbackBindings = new EmissionSet<ts.Symbol>();

    /**
     * JavaScript closures may name a `const` declared later in the same
     * function. Native callback lambdas need that storage to exist before
     * registration, so materialize such locals just ahead of the listener
     * and skip their original declaration when the source walk reaches it.
     */
    public hoistForwardCallbackBindings(
        callback: ts.Expression,
        before: number,
    ): void {
        const candidates = new EmissionMap<ts.Symbol, ts.VariableDeclaration>();
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (ts.isIdentifier(node)) {
                    const symbol = this.context.symbols.valueSymbol(node);
                    const declaration = symbol?.valueDeclaration;
                    if (
                        symbol &&
                        declaration &&
                        ts.isVariableDeclaration(declaration) &&
                        declaration.initializer &&
                        declaration.pos > before &&
                        ts.isIdentifier(declaration.name) &&
                        !isDeclaredInside(declaration, callback) &&
                        !this.context.bindings.lookupOptional(declaration.name)
                    ) {
                        candidates.set(symbol, declaration);
                    }
                }
            });
        visit(callback);
        for (const [symbol, declaration] of candidates) {
            this.context.declarations.emitVariableDeclaration(declaration);
            this.hoistedCallbackBindings.add(symbol);
        }
    }

    /**
     * A platform event callback, with the pin's own parameter announced
     * unused: the signature belongs to the event, not to whether this
     * scene's handler happens to read it. Rendered here rather than at each
     * caller, because the one caller that spelled it by hand was the one that
     * forgot the attribute.
     */
    public compilePlatformCallback(
        callback: ts.Expression,
        parameter: { cppType: string; name: string } | undefined,
        values: readonly Value[],
        documentHiddenCpp?: string,
        captureByValue = true,
        assignIdentity = true,
    ): { cpp: string; identity: string } {
        const asynchronous = this.context.dataLowerer.promiseCallbackType(
            callback,
        )
            ? this.context.dataLowerer.prepareCallbackValue(
                  callback,
                  "platform_async",
              )
            : undefined;
        const stored =
            asynchronous ??
            this.context.probeEmission(() => {
                const value = this.context.compileValue(callback);
                return value.kind === "data" &&
                    value.dataType?.kind === "function"
                    ? value
                    : undefined;
            });
        if (stored) {
            this.context.bindings.refuseEscapingPlatformEventCapturesIn(
                callback,
            );
            const snapshot =
                this.context.allocateTemporaryCppName("platform_callback");
            this.context.emit({
                kind: "declaration",
                type: "const auto",
                name: snapshot,
                initializer: stored.cpp,
            });
            const binding = this.context.registerNativeBinding(
                snapshot,
                false,
                false,
                stored.dataType
                    ? `const ${this.context.dataTypes.cppType(stored.dataType)}`
                    : undefined,
            );
            const closure = this.context.captureManagedClosureLines(
                () => {
                    if (parameter) {
                        this.context.registerNativeBindingType(
                            parameter.name,
                            parameter.cppType.replace(/&+\s*$/, "").trim(),
                        );
                        this.context.registerNativeConstBinding(
                            parameter.name,
                            true,
                        );
                    }
                    this.context.useNativeBinding(binding);
                    this.context.emitDiscardedValue(
                        this.context.dataLowerer.compileFunctionValueCall(
                            { ...stored, cpp: snapshot },
                            values,
                            callback,
                        ),
                    );
                },
                captureByValue ? false : "entry",
            );
            return {
                identity: assignIdentity
                    ? this.platformEventCallbackIdentity(
                          { ...stored, cpp: snapshot },
                          callback,
                      )
                    : "0u",
                cpp: this.context.nativeEmission.renderSharedClosure(
                    closure,
                    "void",
                    callback,
                    parameter
                        ? `[[maybe_unused]] ${parameter.cppType} ${parameter.name}`
                        : "",
                    parameter ? [parameter.name] : [],
                ),
            };
        }
        const previousHidden = this.context.platformDocumentHiddenCpp;
        const previousFrameFloor =
            this.context.bindings.frameCallbackScopeFloor;
        const previousPlatformEventCaptureFloor =
            this.context.bindings.escapingPlatformEventCaptureFloor;
        if (this.context.frameCallbackDepth === 0) {
            this.context.bindings.frameCallbackScopeFloor =
                this.context.bindings.variableScopes.length;
        } else {
            this.context.bindings.escapingPlatformEventCaptureFloor =
                this.context.bindings.variableScopes.length;
        }
        this.context.bindings.refuseEscapingPlatformEventCapturesIn(callback);
        // The scan above compares against the enclosing handler's live scope
        // chain. Callback records may restore the scope chain they closed over
        // while their own body is compiled, so that numeric floor cannot stay
        // active across the restore. Any callback created by this body performs
        // its own scan against the restored chain before it escapes.
        this.context.bindings.escapingPlatformEventCaptureFloor =
            previousPlatformEventCaptureFloor;
        this.context.platformDocumentHiddenCpp = documentHiddenCpp;
        this.context.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        let identity: string | undefined;
        try {
            compiled = this.context.captureManagedClosureLines(
                () => {
                    if (parameter) {
                        this.context.registerNativeBindingType(
                            parameter.name,
                            parameter.cppType.replace(/&+\s*$/, "").trim(),
                        );
                        this.context.registerNativeConstBinding(
                            parameter.name,
                            true,
                        );
                    }
                    const unwrapped = this.context.unwrap(callback) as
                        | ts.Identifier
                        | ts.PropertyAccessExpression
                        | ts.ArrowFunction
                        | ts.FunctionExpression;
                    const bound = ts.isIdentifier(unwrapped)
                        ? (this.context.bindings.lookupOptional(unwrapped) ??
                          (() => {
                              const declaration = tryResolveFunctionDeclaration(
                                  this.context.checker,
                                  unwrapped,
                              );
                              return declaration
                                  ? ({
                                        kind: "callback",
                                        cpp: "",
                                        callbackDeclaration: declaration,
                                        callbackRecordOwner: {
                                            kind: "record",
                                            cpp: "",
                                            ...this.context.captureRecordScopes(),
                                        },
                                    } satisfies Value)
                                  : this.context.compileValue(unwrapped);
                          })())
                        : this.context.compileValue(unwrapped);
                    if (assignIdentity) {
                        identity = this.platformEventCallbackIdentity(
                            bound,
                            callback,
                        );
                    }
                    if (bound.nativePromiseSettlement) {
                        this.context.emitDiscardedValue(
                            this.context.dataLowerer.compilePromiseSettlement(
                                bound,
                                values,
                                callback,
                            ),
                        );
                        return;
                    }
                    if (
                        bound.kind === "callback" &&
                        !bound.callbackDeclaration &&
                        bound.cpp.length > 0
                    ) {
                        const parameterTypes =
                            bound.nativeCallbackParameterTypes;
                        if (
                            parameterTypes &&
                            parameterTypes.length > values.length
                        ) {
                            this.context.fail(
                                callback,
                                "Stored platform callback received the wrong number of arguments.",
                            );
                        }
                        const argumentsCpp = values
                            .slice(0, parameterTypes?.length ?? values.length)
                            .map((value, index) => {
                                const type = parameterTypes?.[index];
                                return type
                                    ? this.context.dataLowerer.compileKnownValueForSink(
                                          value,
                                          type,
                                          callback,
                                      )
                                    : value.cpp;
                            });
                        this.context.emit(
                            `${bound.cpp}(${argumentsCpp.join(", ")});`,
                        );
                        return;
                    }
                    const declaration =
                        bound.kind === "callback" &&
                        bound.callbackDeclaration &&
                        !ts.isMethodDeclaration(bound.callbackDeclaration)
                            ? bound.callbackDeclaration
                            : ts.isPropertyAccessExpression(unwrapped)
                              ? this.context.fail(
                                    unwrapped,
                                    "Platform callback property does not resolve to a function value.",
                                )
                              : unwrapped;
                    const compile = () =>
                        this.context.compileCallbackWithValues(
                            declaration,
                            values,
                            callback,
                        );
                    const result = bound.callbackRecordOwner
                        ? this.context.withRecordScopes(
                              bound.callbackRecordOwner,
                              compile,
                          )
                        : compile();
                    this.context.emitDiscardedValue(result);
                },
                captureByValue ? false : "entry",
            );
        } finally {
            this.context.frameCallbackDepth -= 1;
            this.context.platformDocumentHiddenCpp = previousHidden;
            this.context.bindings.frameCallbackScopeFloor = previousFrameFloor;
            this.context.bindings.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
        }
        const cppParameter = parameter
            ? `[[maybe_unused]] ${parameter.cppType} ${parameter.name}`
            : "";
        if (assignIdentity && identity === undefined) {
            this.context.fail(
                callback,
                "Platform event listener has no stable callback identity.",
            );
        }
        return {
            identity: identity ?? "0u",
            cpp: this.context.nativeEmission.renderSharedClosure(
                compiled,
                "void",
                callback,
                cppParameter,
                parameter ? [parameter.name] : [],
            ),
        };
    }

    /**
     * Register the callback shape emitted by the pinned collision-event walk.
     *
     * The body is specialized after startup lowering has seen later callback
     * assignments, then inserted before `startEngine`. Registration itself
     * stays at the source site through the forwarding lambda returned here.
     */
    public compilePhysicsCollisionCallback(expression: ts.Expression): string {
        return this.compilePhysicsEventCallback(expression, "collision");
    }

    public compilePhysicsTriggerCallback(expression: ts.Expression): string {
        return this.compilePhysicsEventCallback(expression, "trigger");
    }
    public compilePhysicsCharacterCallback(expression: ts.Expression): string {
        return this.compilePhysicsEventCallback(expression, "character");
    }

    /**
     * A handler on one of the two pinned physics event streams.
     *
     * Both are registered before every startup assignment has necessarily
     * run, so both defer their native body until the entry walk completes
     * while retaining the registration site's scopes. What differs is the
     * info record the pin hands the callback, which
     * `physicsEventInfoValue` builds.
     */
    private compilePhysicsEventCallback(
        expression: ts.Expression,
        event: "collision" | "trigger" | "character",
    ): string {
        const callback = this.context.unwrap(expression);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            this.context.fail(
                callback,
                `Physics ${event} callbacks must be a local function or function literal.`,
            );
        }
        const infoType = physicsEventInfoType(event);
        const eventName = this.context.allocateTemporaryCppName(
            `physics_${event}`,
        );
        const callbackName = this.context.allocateTemporaryCppName(
            `physics_${event}_callback`,
        );
        this.context.reachJsData();
        this.context.emit(
            `std::function<void(const ${infoType}&)> ${callbackName};`,
        );
        this.deferredPhysicsCallbacks.push({
            event,
            callback,
            cppName: callbackName,
            eventName,
            node: expression,
            scopes: this.context.bindings.variableScopes.map(
                (scope) => new EmissionMap(scope),
            ),
        });
        return (
            `[&](const ${infoType}& ${eventName}) { ` +
            `if (${callbackName}) { ${callbackName}(${eventName}); } }`
        );
    }

    /** Emit deferred physics event bodies immediately before the engine starts. */
    public emitDeferredPhysicsCallbacks(): void {
        if (this.deferredPhysicsCallbacks.length === 0) return;
        const emitted: string[] = [];
        for (const deferred of this.deferredPhysicsCallbacks) {
            const savedScopes = [...this.context.bindings.variableScopes];
            this.context.bindings.variableScopes.length = 0;
            this.context.bindings.variableScopes.push(...deferred.scopes);
            const event = deferred.eventName;
            const info = physicsEventInfoValue(deferred.event, event);
            const previousDepth = this.context.frameCallbackDepth;
            this.context.frameCallbackDepth += 1;
            try {
                const lines = this.context.captureEmittedLines(() => {
                    const result = this.context.compileCallbackWithValues(
                        deferred.callback,
                        [info],
                        deferred.node,
                    );
                    this.context.emitDiscardedValue(result);
                });
                const indent = "    ".repeat(2);
                // The signature is the pin's, so the parameter stays whether
                // the body reads it or not -- scene 100's collision handler
                // logs and writes a dataset flag, both of which erase, so it
                // reads nothing at all. Announced unused unconditionally, as
                // `compileFrameCallback` announces its delta.
                emitted.push(
                    `${indent}${deferred.cppName} = [&]([[maybe_unused]] const ${physicsEventInfoType(deferred.event)}& ${event}) {`,
                    ...lines.map((line) => `    ${line}`),
                    `${indent}};`,
                );
            } finally {
                this.context.frameCallbackDepth = previousDepth;
                this.context.bindings.variableScopes.length = 0;
                this.context.bindings.variableScopes.push(...savedScopes);
            }
        }
        const insertion =
            this.context.engineLifecycle.engineStartMark?.index ??
            this.context.body.length;
        this.context.body.splice(insertion, 0, ...emitted);
        this.deferredPhysicsCallbacks.length = 0;
    }
}
