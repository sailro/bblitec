// Browser-only expression erasure.
//
// A pinned scene reaches browser objects -- console, document, window,
// performance, URLSearchParams -- that have no native counterpart, so
// the compiler erases those expressions instead of lowering them. This
// module answers the three questions that erasure turns on: whether an
// expression is browser-only, what value it evaluates to at compile
// time (window.location.search is always empty, so a query flag reads
// as unset and a condition over it folds to the branch the native
// scene keeps), and whether a call is browser instrumentation that is
// erased outright.
import ts from "typescript";
import type { Value } from "./types.js";

const NATIVE_DOM_BRIDGE_KINDS = new Set<Value["kind"]>([
    "audio-engine",
    "audio-buffer",
    "audio-context",
    "audio-node",
    "audio-param",
    "data",
    "static-fetch-response",
    "platform-keyboard-event",
    "platform-mouse-event",
]);

export interface BrowserErasureContext {
    unwrap(expression: ts.Expression): ts.Expression;
    canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined;
    lookupOptional(
        identifier: ts.Identifier,
    ): Value | undefined;
    resolveThisField(name: string): Value | undefined;
    isDefaultLibraryIdentifier(
        identifier: ts.Identifier,
    ): boolean;
    isBrowserDomValue(expression: ts.Expression): boolean;
    isBrowserOnlyLocalCall(call: ts.CallExpression): boolean;
    /** Runtime visibility callback parameter, while compiling its body. */
    platformDocumentHidden(): string | undefined;
    /** The query string the reference pose is captured at. */
    referenceSearch(): string;
}

export class BrowserErasure {
    public constructor(
        private readonly context: BrowserErasureContext,
    ) {}

    /**
     * TypeScript models `globalThis` as an intrinsic symbol with no source
     * declaration, so `Program.isSourceFileDefaultLibrary` cannot identify it
     * the way it identifies `window` or `document`. An existing compiler
     * binding still wins, preserving ordinary lexical shadowing.
     */
    private isDefaultBrowserGlobal(identifier: ts.Identifier): boolean {
        return identifier.text === "globalThis"
            ? this.context.lookupOptional(identifier) === undefined
            : this.context.isDefaultLibraryIdentifier(identifier);
    }

    /**
     * The browser global this expression names, written any of the ways that
     * reach the same object: bare (`setTimeout`, `location`), or as a member
     * of `window` or `globalThis`. A scene that picks one spelling must fold
     * the same as one that picks another -- an unrecognized `location.search`
     * would read as an empty query and silently take the scene's
     * unparameterised branch.
     *
     * Returns the identifier naming the global, so a caller compares its
     * text. `isDefaultBrowserGlobal` is what keeps a lexical shadow from
     * being mistaken for the global, and `globalThis` an accepted host.
     */
    private browserGlobalNamed(
        expression: ts.Expression,
    ): ts.MemberName | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            return this.isDefaultBrowserGlobal(unwrapped)
                ? unwrapped
                : undefined;
        }
        return ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            (unwrapped.expression.text === "window" ||
                unwrapped.expression.text === "globalThis") &&
            this.isDefaultBrowserGlobal(unwrapped.expression)
            ? unwrapped.name
            : undefined;
    }

    /**
     * `setTimeout(callback, 0)` -- bare or through `window`.
     *
     * Every other `window.*` call erases, because the browser service
     * behind it has no native counterpart. This one has: a zero-delay
     * timeout is "run this once, after the current turn", and the frame
     * conductor already has that boundary. So it is recognized here and
     * lowered rather than erased -- which is what lets a scene's own
     * freeze (`setTimeout(() => stopEngine(engine), 0)`) reach the native
     * loop instead of being silently dropped.
     *
     * The reached slice is a zero delay. Seventeen of the corpus's
     * twenty-one call sites pass exactly 0; the four that do not (scenes
     * 44, 48, 156 and 173 -- a drop, a kick and two fades, all real
     * waits) are a timer this runtime does not carry, and they refuse at
     * the call rather than being rounded to the next frame, which would
     * be a different scene.
     */
    public isDeferredCallbackCall(
        call: ts.CallExpression,
    ): boolean {
        return (
            this.browserGlobalNamed(call.expression)?.text === "setTimeout"
        );
    }

    public isBrowserOnlyExpression(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        // `import.meta.url` is the browser module's deployment URL. Native
        // asset sinks fold the reached `new URL(path, import.meta.url)`
        // helper before this erasure gate; every remaining use is browser
        // setup (for example, selecting decoder script base URLs) and has no
        // run-time representation in an AOT package with no network loader.
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "url" &&
            ts.isMetaProperty(unwrapped.expression) &&
            unwrapped.expression.keywordToken ===
                ts.SyntaxKind.ImportKeyword &&
            unwrapped.expression.name.text === "meta"
        ) {
            return true;
        }
        // Two browser-shaped values have direct platform counterparts. Keep
        // them out of the erasure flow so ordinary expression lowering owns
        // their native representation.
        if (this.isPlatformTimeCall(unwrapped)) {
            return false;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "hidden" &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "document" &&
            this.context.isDefaultLibraryIdentifier(
                unwrapped.expression,
            ) &&
            this.context.platformDocumentHidden() !== undefined
        ) {
            return false;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            this.isDeferredCallbackCall(unwrapped)
        ) {
            return false;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            this.context.isBrowserOnlyLocalCall(unwrapped)
        ) {
            return true;
        }
        if (this.context.canvasSizeProperty(unwrapped)) {
            return false;
        }
        if (ts.isIdentifier(unwrapped)) {
            if (
                [
                    "console",
                    "devicePixelRatio",
                    "document",
                    "globalThis",
                    "performance",
                    "window",
                ].includes(unwrapped.text) &&
                this.isDefaultBrowserGlobal(unwrapped)
            ) {
                return true;
            }
            const bound =
                this.context.lookupOptional(unwrapped)?.kind;
            // A pure-2D particle binding has no native counterpart and the
            // corpus only reports it, so a read of one erases exactly as a
            // browser value does.
            return (
                bound === "browser" ||
                bound === "node-particle-2d-binding" ||
                (bound === undefined &&
                    this.context.isBrowserDomValue(unwrapped))
            );
        }
        if (
            (ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)) &&
            !this.isNativeDomBridge(unwrapped) &&
            this.context.isBrowserDomValue(unwrapped)
        ) {
            return true;
        }
        if (
            ts.isNewExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "URLSearchParams" &&
            this.context.isDefaultLibraryIdentifier(
                unwrapped.expression,
            )
        ) {
            return true;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            return this.isBrowserOnlyExpression(
                unwrapped.expression,
            );
        }
        if (ts.isBinaryExpression(unwrapped)) {
            return (
                this.isBrowserOnlyExpression(
                    unwrapped.left,
                ) ||
                this.isBrowserOnlyExpression(
                    unwrapped.right,
                )
            );
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            return this.isBrowserOnlyExpression(
                unwrapped.operand,
            );
        }
        if (ts.isCallExpression(unwrapped)) {
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                this.isBrowserOnlyExpression(
                    unwrapped.expression.expression,
                )
            ) {
                return true;
            }
            const browserArgument =
                unwrapped.arguments.some((argument) =>
                    this.isBrowserOnlyExpression(argument),
                );
            // `Number(x)` joins `isNaN` and `parseFloat` as a conversion
            // over a browser-derived value: it is how every physics scene
            // reads the step its capture is pinned at
            // (`Number(params.get("captureFrame"))`).
            if (
                ts.isIdentifier(unwrapped.expression) &&
                ["isNaN", "Number", "parseFloat"].includes(
                    unwrapped.expression.text,
                ) &&
                this.context.isDefaultLibraryIdentifier(
                    unwrapped.expression,
                )
            ) {
                return browserArgument;
            }
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                ) &&
                unwrapped.expression.expression.text ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite" &&
                this.context.isDefaultLibraryIdentifier(
                    unwrapped.expression.expression,
                )
            ) {
                return browserArgument;
            }
            // Standard-library transforms cannot make a browser-only value
            // native. Keep the taint through Math calls so a diagnostic
            // transform erases with its browser source -- but only while
            // the browser value is UNRESOLVED. A physics scene reads the
            // step its capture is pinned at as `Math.round(frame)` over a
            // query the reference fixes, and tainting that would refuse a
            // value the query already answered rather than erasing
            // anything. The conversions above need no such test: each
            // folds in `evaluateBrowserValue`, so a resolved one never
            // reaches a consumer as a browser value in the first place.
            if (
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                ts.isIdentifier(unwrapped.expression.expression) &&
                unwrapped.expression.expression.text === "Math" &&
                this.context.isDefaultLibraryIdentifier(
                    unwrapped.expression.expression,
                )
            ) {
                return (
                    browserArgument &&
                    unwrapped.arguments.some(
                        (argument) =>
                            this.isBrowserOnlyExpression(argument) &&
                            this.evaluateBrowserValue(argument) ===
                                undefined,
                    )
                );
            }
            return false;
        }
        return false;
    }

    private isNativeDomBridge(
        expression: ts.Expression,
    ): boolean {
        const owner = (node: ts.Expression): Value | undefined => {
            const unwrapped = this.context.unwrap(node);
            if (ts.isIdentifier(unwrapped)) {
                return this.context.lookupOptional(unwrapped);
            }
            if (
                ts.isPropertyAccessExpression(unwrapped) &&
                unwrapped.expression.kind ===
                    ts.SyntaxKind.ThisKeyword
            ) {
                return this.context.resolveThisField(
                    unwrapped.name.text,
                );
            }
            if (ts.isPropertyAccessExpression(unwrapped)) {
                return owner(unwrapped.expression);
            }
            if (
                ts.isCallExpression(unwrapped) &&
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                )
            ) {
                return owner(
                    unwrapped.expression.expression,
                );
            }
            return undefined;
        };
        const value = owner(expression);
        return (
            value !== undefined &&
            NATIVE_DOM_BRIDGE_KINDS.has(value.kind)
        );
    }

    private isPlatformTimeCall(
        expression: ts.Expression,
    ): expression is ts.CallExpression {
        return (
            ts.isCallExpression(expression) &&
            expression.arguments.length === 0 &&
            ts.isPropertyAccessExpression(expression.expression) &&
            expression.expression.name.text === "now" &&
            ts.isIdentifier(expression.expression.expression) &&
            expression.expression.expression.text === "performance" &&
            this.context.isDefaultLibraryIdentifier(
                expression.expression.expression,
            )
        );
    }

    public evaluateBrowserCondition(
        expression: ts.Expression,
    ): boolean | undefined {
        const value =
            this.evaluateBrowserValue(expression);
        return this.browserTruthy(value);
    }

    public evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) {
            return { kind: "boolean", value: true };
        }
        if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) {
            return { kind: "boolean", value: false };
        }
        if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
            return { kind: "null" };
        }
        if (ts.isStringLiteral(unwrapped)) {
            return {
                kind: "string",
                value: unwrapped.text,
            };
        }
        if (ts.isNumericLiteral(unwrapped)) {
            return {
                kind: "number",
                value: Number(unwrapped.text),
            };
        }
        if (ts.isIdentifier(unwrapped)) {
            if (
                unwrapped.text === "devicePixelRatio" &&
                this.isDefaultBrowserGlobal(unwrapped)
            ) {
                // Native has no CSS/backing-store split. Its single surface
                // corresponds to the browser reference at DPR 1.
                return { kind: "number", value: 1 };
            }
            return this.context.lookupOptional(unwrapped)
                ?.browserValue;
        }
        if (
            ts.isNewExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "URLSearchParams" &&
            this.context.isDefaultLibraryIdentifier(
                unwrapped.expression,
            )
        ) {
            const argument = unwrapped.arguments?.[0];
            const over = argument
                ? this.evaluateBrowserValue(argument)
                : undefined;
            return {
                kind: "search-params",
                search: over?.kind === "string" ? over.value : "",
            };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "search" &&
            this.browserGlobalNamed(unwrapped.expression)?.text === "location"
        ) {
            return {
                kind: "string",
                value: this.context.referenceSearch(),
            };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "tabIndex" &&
            this.context.isBrowserDomValue(unwrapped.expression)
        ) {
            // Native keyboard events target the SDL surface directly. Treat
            // that surface as the focusable canvas the entry page establishes.
            return { kind: "number", value: 0 };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "matches" &&
            ts.isCallExpression(unwrapped.expression) &&
            ts.isPropertyAccessExpression(unwrapped.expression.expression) &&
            unwrapped.expression.expression.name.text === "matchMedia" &&
            this.browserGlobalNamed(
                unwrapped.expression.expression.expression,
            )?.text === "window" &&
            unwrapped.expression.arguments.length === 1 &&
            this.evaluateBrowserValue(
                unwrapped.expression.arguments[0]!,
            )?.kind === "string"
        ) {
            // The native executable is an SDL desktop surface with mouse
            // hover and a fine pointer. A coarse/no-hover media query is the
            // source's touch-layout fork, so its native value is false.
            return { kind: "boolean", value: false };
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            const operand = this.evaluateBrowserValue(
                unwrapped.operand,
            );
            if (
                (unwrapped.operator === ts.SyntaxKind.PlusToken ||
                    unwrapped.operator === ts.SyntaxKind.MinusToken) &&
                operand?.kind === "number"
            ) {
                return {
                    kind: "number",
                    value:
                        unwrapped.operator === ts.SyntaxKind.MinusToken
                            ? -operand.value
                            : operand.value,
                };
            }
            if (
                unwrapped.operator !==
                ts.SyntaxKind.ExclamationToken
            ) {
                return undefined;
            }
            const truthy = this.browserTruthy(operand);
            return truthy === undefined
                ? undefined
                : { kind: "boolean", value: !truthy };
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const left = this.evaluateBrowserValue(
                unwrapped.left,
            );
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken
            ) {
                const truthy = this.browserTruthy(left);
                if (truthy === false) {
                    // JavaScript's value-selecting `&&` returns its left
                    // operand unchanged when that operand is falsy.
                    return left;
                }
                return truthy
                    ? this.evaluateBrowserValue(
                          unwrapped.right,
                      )
                    : undefined;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.BarBarToken
            ) {
                const truthy = this.browserTruthy(left);
                if (truthy === true) {
                    return left;
                }
                return truthy === false
                    ? this.evaluateBrowserValue(
                          unwrapped.right,
                      )
                    : undefined;
            }
            const numeric = new Map<
                ts.SyntaxKind,
                (a: number, b: number) => number
            >([
                [ts.SyntaxKind.PlusToken, (a, b) => a + b],
                [ts.SyntaxKind.MinusToken, (a, b) => a - b],
                [ts.SyntaxKind.AsteriskToken, (a, b) => a * b],
                [ts.SyntaxKind.SlashToken, (a, b) => a / b],
                [ts.SyntaxKind.PercentToken, (a, b) => a % b],
            ]).get(unwrapped.operatorToken.kind);
            if (numeric) {
                const right = this.evaluateBrowserValue(
                    unwrapped.right,
                );
                if (left?.kind !== "number" || right?.kind !== "number") {
                    return undefined;
                }
                return {
                    kind: "number",
                    value: numeric(left.value, right.value),
                };
            }
            // A browser-derived value compared against a literal is how the
            // corpus reads an opt-out switch: `params.get("noise") !== "off"`
            // is `null !== "off"` once the query string is known empty. Only
            // the strict forms fold, because loose equality coerces and this
            // evaluator carries no `undefined` to coerce against.
            if (
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken
            ) {
                const right = this.evaluateBrowserValue(
                    unwrapped.right,
                );
                const equal = strictlyEqualBrowserValues(left, right);
                if (equal === undefined) return undefined;
                return {
                    kind: "boolean",
                    value:
                        unwrapped.operatorToken.kind ===
                        ts.SyntaxKind.EqualsEqualsEqualsToken
                            ? equal
                            : !equal,
                };
            }
            // `seekTimeParam > 0` -- how the corpus separates a query that
            // names a pose from one that only asks to freeze. Both sides
            // are numbers by the time the query has folded, so the
            // comparison is the ordinary numeric one.
            const relational = relationalOperator(
                unwrapped.operatorToken.kind,
            );
            if (relational) {
                const right = this.evaluateBrowserValue(
                    unwrapped.right,
                );
                if (left?.kind !== "number" || right?.kind !== "number") {
                    return undefined;
                }
                return {
                    kind: "boolean",
                    value: relational(left.value, right.value),
                };
            }
            return undefined;
        }
        if (ts.isCallExpression(unwrapped)) {
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                )
            ) {
                if (
                    ts.isIdentifier(
                        unwrapped.expression.expression,
                    ) &&
                    unwrapped.expression.expression.text ===
                        "document" &&
                    unwrapped.expression.name.text ===
                        "getElementById" &&
                    this.context.isDefaultLibraryIdentifier(
                        unwrapped.expression.expression,
                    ) &&
                    unwrapped.arguments.length === 1
                ) {
                    const elementId =
                        this.evaluateBrowserValue(
                            unwrapped.arguments[0]!,
                        );
                    if (
                        elementId?.kind !== "string" ||
                        elementId.value !== "renderCanvas"
                    ) {
                        return undefined;
                    }
                    // The generated native executable is launched with the
                    // canvas its scene entry point expects. The browser page's
                    // auto-run guard therefore selects the same branch in the
                    // native reference environment; keep it as an object so
                    // truthiness folds without pretending it equals `true`.
                    return { kind: "object" };
                }
                // The receiver is evaluated rather than looked up, because
                // the corpus writes the query read both ways: bound to a
                // local first, and read straight off the constructor.
                const owner = this.evaluateBrowserValue(
                    unwrapped.expression.expression,
                );
                const method = unwrapped.expression.name.text;
                if (
                    method === "getBoundingClientRect" &&
                    unwrapped.arguments.length === 0 &&
                    this.context.isBrowserDomValue(
                        unwrapped.expression.expression,
                    )
                ) {
                    // Native's drawing surface is its client box: there is
                    // no CSS page offset between an SDL pointer coordinate
                    // and the backing surface coordinate the picker reads.
                    return { kind: "dom-rect" };
                }
                if (
                    owner?.kind === "search-params" &&
                    (method === "get" || method === "has")
                ) {
                    // The pin's own parser answers the pin's own query, so
                    // the read folds to exactly what the reference page
                    // sees. A scene captured bare has an empty query and
                    // every parameter reads as absent, as before.
                    const argument = unwrapped.arguments[0];
                    const key = argument
                        ? this.evaluateBrowserValue(argument)
                        : undefined;
                    if (key?.kind !== "string") return undefined;
                    const parameters = new URLSearchParams(owner.search);
                    if (method === "has") {
                        return {
                            kind: "boolean",
                            value: parameters.has(key.value),
                        };
                    }
                    const found = parameters.get(key.value);
                    return found === null
                        ? { kind: "null" }
                        : { kind: "string", value: found };
                }
            }
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "parseFloat" &&
                this.context.isDefaultLibraryIdentifier(
                    unwrapped.expression,
                )
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                const text =
                    argument?.kind === "string"
                        ? argument.value
                        : "";
                return {
                    kind: "number",
                    value: Number.parseFloat(text),
                };
            }
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "Number" &&
                unwrapped.arguments.length === 1 &&
                this.context.isDefaultLibraryIdentifier(
                    unwrapped.expression,
                )
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                // Only the kinds JavaScript converts to a NUMBER fold; an
                // opaque browser object or the search-params record does
                // not, and is listed by what it IS rather than by what it
                // is not so a kind added later does not silently join.
                if (
                    argument === undefined ||
                    !["boolean", "null", "number", "string"].includes(
                        argument.kind,
                    )
                ) {
                    return undefined;
                }
                // The conversion is the language's own, not a table
                // restated here: `Number(null)` is 0, `Number("")` is 0
                // and `Number("abc")` is NaN, which is exactly what the
                // `Number.isFinite` guard beside it then reads.
                return {
                    kind: "number",
                    value: Number(
                        argument.kind === "null"
                            ? null
                            : (argument as { value: unknown }).value,
                    ),
                };
            }
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "isNaN" &&
                this.context.isDefaultLibraryIdentifier(
                    unwrapped.expression,
                )
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isNaN(
                              argument.value,
                          ),
                      }
                    : undefined;
            }
            if (
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                ) &&
                unwrapped.expression.expression.text ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite" &&
                this.context.isDefaultLibraryIdentifier(
                    unwrapped.expression.expression,
                )
            ) {
                const argument =
                    this.evaluateBrowserValue(
                        unwrapped.arguments[0]!,
                    );
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isFinite(
                              argument.value,
                          ),
                      }
                    : undefined;
            }
        }
        return undefined;
    }

    private browserTruthy(
        value: Value["browserValue"] | undefined,
    ): boolean | undefined {
        if (!value) {
            return undefined;
        }
        switch (value.kind) {
            case "boolean":
                return value.value;
            case "null":
                return false;
            case "number":
                return (
                    value.value !== 0 &&
                    !Number.isNaN(value.value)
                );
            case "object":
            case "dom-rect":
            case "search-params":
                return true;
            case "string":
                return value.value.length > 0;
        }
    }

    /**
     * `await new Promise<void>((r) => requestAnimationFrame(() => r()))` --
     * the single-frame yield a pinned scene uses to let one more frame draw
     * before it flags the canvas ready.
     *
     * `requestAnimationFrame` is a browser API with no native counterpart,
     * and what the wait buys in the browser is that the work scheduled
     * before it has landed by the time the capture happens. This runtime
     * has no queue to drain: the frame's own thread does that work before
     * the draw that reads it. So the yield is erased -- but only in exactly
     * this shape, matched structurally rather than by counting `new
     * Promise`, because a multi-frame wait or one that resolves on some
     * other condition is NOT this and must keep refusing.
     */
    /**
     * The `new Promise((resolve) => ...)` head both frame waits share.
     *
     * Their shapes diverge only after it -- one is a bare
     * `requestAnimationFrame` call, the other a block that re-arms until a
     * condition holds -- so the executor test lives here and a pin that
     * moved the Promise form moves one place.
     */
    private promiseExecutor(
        expression: ts.Expression,
    ): { resolveName: string; body: ts.ConciseBody } | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (
            !ts.isNewExpression(unwrapped) ||
            !ts.isIdentifier(unwrapped.expression) ||
            unwrapped.expression.text !== "Promise" ||
            unwrapped.arguments?.length !== 1
        ) {
            return undefined;
        }
        const executor = unwrapped.arguments[0]!;
        if (
            !ts.isArrowFunction(executor) ||
            executor.parameters.length !== 1 ||
            !ts.isIdentifier(executor.parameters[0]!.name)
        ) {
            return undefined;
        }
        return {
            resolveName: executor.parameters[0]!.name.text,
            body: executor.body,
        };
    }

    public isFrameYield(expression: ts.Expression): boolean {
        const executor = this.promiseExecutor(expression);
        if (!executor) return false;
        const resolveName = executor.resolveName;
        const raf = this.context.unwrap(
            executor.body as ts.Expression,
        );
        if (
            !ts.isCallExpression(raf) ||
            !ts.isIdentifier(raf.expression) ||
            raf.expression.text !== "requestAnimationFrame" ||
            raf.arguments.length !== 1
        ) {
            return false;
        }
        const callback = raf.arguments[0]!;
        if (
            !ts.isArrowFunction(callback) ||
            callback.parameters.length !== 0
        ) {
            return false;
        }
        const resolveCall = this.context.unwrap(
            callback.body as ts.Expression,
        );
        return (
            ts.isCallExpression(resolveCall) &&
            ts.isIdentifier(resolveCall.expression) &&
            resolveCall.expression.text === resolveName &&
            resolveCall.arguments.length === 0
        );
    }

    /**
     * The bounded multi-frame drain a scene uses to let its own pipeline
     * rebuilds settle before it flags the canvas ready:
     *
     * ```
     * await new Promise<void>((resolve) => {
     *     const wait = (): void =>
     *         (cond ? resolve() : void requestAnimationFrame(wait));
     *     wait();
     * });
     * ```
     *
     * This is NOT the single-frame yield above and must not be erased: the
     * condition is the scene's own, and what the wait buys is that the
     * frames it names have actually drawn. The port keeps the condition
     * and defers the capture behind it, which is the native reading of
     * "set `dataset.ready` after this resolves" -- the harness waits on
     * that flag, so a capture taken earlier is a different frame.
     *
     * Returns the condition, or undefined when the shape is anything else.
     */
    public frameDrainCondition(
        expression: ts.Expression,
    ): ts.Expression | undefined {
        const executor = this.promiseExecutor(expression);
        if (
            !executor ||
            !ts.isBlock(executor.body) ||
            executor.body.statements.length !== 2
        ) {
            return undefined;
        }
        const resolveName = executor.resolveName;
        const [declaration, invocation] = executor.body.statements;
        if (
            !declaration ||
            !ts.isVariableStatement(declaration) ||
            declaration.declarationList.declarations.length !== 1
        ) {
            return undefined;
        }
        const declared = declaration.declarationList.declarations[0]!;
        if (
            !ts.isIdentifier(declared.name) ||
            !declared.initializer ||
            !ts.isArrowFunction(declared.initializer) ||
            declared.initializer.parameters.length !== 0
        ) {
            return undefined;
        }
        const waitName = declared.name.text;
        // The body is `cond ? resolve() : void requestAnimationFrame(wait)`.
        const body = this.context.unwrap(
            declared.initializer.body as ts.Expression,
        );
        if (!ts.isConditionalExpression(body)) return undefined;
        const resolved = this.context.unwrap(body.whenTrue);
        if (
            !ts.isCallExpression(resolved) ||
            !ts.isIdentifier(resolved.expression) ||
            resolved.expression.text !== resolveName ||
            resolved.arguments.length !== 0
        ) {
            return undefined;
        }
        // `void f()` is how both drain scenes discard the scheduling
        // call's result inside a conditional expression, and the only way
        // any corpus scene spells it. Another spelling falls through to
        // the refusal, which is what a matcher whose whole justification
        // is refusing to over-match should do.
        let scheduled = this.context.unwrap(body.whenFalse);
        if (ts.isVoidExpression(scheduled)) {
            scheduled = this.context.unwrap(scheduled.expression);
        }
        if (
            !ts.isCallExpression(scheduled) ||
            !ts.isIdentifier(scheduled.expression) ||
            scheduled.expression.text !== "requestAnimationFrame" ||
            scheduled.arguments.length !== 1 ||
            !ts.isIdentifier(scheduled.arguments[0]!) ||
            (scheduled.arguments[0] as ts.Identifier).text !== waitName
        ) {
            return undefined;
        }
        // The executor's second statement primes the loop with `wait()`.
        const primed =
            invocation && ts.isExpressionStatement(invocation)
                ? this.context.unwrap(invocation.expression)
                : undefined;
        if (
            !primed ||
            !ts.isCallExpression(primed) ||
            !ts.isIdentifier(primed.expression) ||
            primed.expression.text !== waitName ||
            primed.arguments.length !== 0
        ) {
            return undefined;
        }
        return body.condition;
    }

    public isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        const objectInstrumentation =
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            (call.expression.name.text === "assign" ||
                (call.expression.name.text === "defineProperty" &&
                    call.arguments[0] !== undefined &&
                    this.isBrowserOnlyExpression(call.arguments[0])));
        const deviceEvent =
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text ===
                "addEventListener" &&
            ts.isPropertyAccessExpression(
                call.expression.expression,
            ) &&
            call.expression.expression.name.text ===
                "_device";
        return objectInstrumentation || deviceEvent;
    }
}

/** The comparison a relational token performs, if it is one. */
function relationalOperator(
    kind: ts.SyntaxKind,
): ((left: number, right: number) => boolean) | undefined {
    switch (kind) {
        case ts.SyntaxKind.GreaterThanToken:
            return (left, right) => left > right;
        case ts.SyntaxKind.GreaterThanEqualsToken:
            return (left, right) => left >= right;
        case ts.SyntaxKind.LessThanToken:
            return (left, right) => left < right;
        case ts.SyntaxKind.LessThanEqualsToken:
            return (left, right) => left <= right;
        default:
            return undefined;
    }
}

/**
 * `===` over two folded browser values, or undefined when either side is
 * unknown or is an object (which compares by identity).
 */
function strictlyEqualBrowserValues(
    left: Value["browserValue"] | undefined,
    right: Value["browserValue"] | undefined,
): boolean | undefined {
    if (!left || !right) return undefined;
    if (left.kind !== right.kind) return false;
    if (
        left.kind === "object" ||
        right.kind === "object" ||
        left.kind === "dom-rect" ||
        right.kind === "dom-rect" ||
        left.kind === "search-params" ||
        right.kind === "search-params"
    ) {
        return undefined;
    }
    if (left.kind === "null" || right.kind === "null") return true;
    if (left.kind === "boolean" && right.kind === "boolean") {
        return left.value === right.value;
    }
    if (left.kind === "number" && right.kind === "number") {
        return left.value === right.value;
    }
    if (left.kind === "string" && right.kind === "string") {
        return left.value === right.value;
    }
    return undefined;
}
