import {
    emissionArray,
    EmissionSet,
    EmissionMap,
} from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { deploymentUrl } from "./deployment.js";
// Browser environment recognition and bounded erasure. Platform-backed
// values stay on the native lowering path; deployment queries fold against
// the configured search string. Unrepresented browser instrumentation is
// handled separately from observable platform operations.
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    argumentAt,
    identifierText,
    isAssignmentExpression,
} from "./syntax.js";
import { promiseExecutor } from "./promise-executor.js";
import { isNativeBrowserFileExpression } from "./browser-file.js";
import { writesUnobservedCanvasMetadata } from "./canvas-instrumentation.js";
import { staticClassMember } from "./class-members.js";
import { platformHandleKind } from "./data-types.js";
import { declaredInDomLibrary } from "./symbols.js";
import { mathUnaryFold } from "./math-intrinsics.js";
import type { Value } from "./types.js";
import { staticStringValue } from "./types.js";
import { stringLiteral } from "../cpp-literals.js";

/**
 * The global `parseFloat`, in either of the two spellings a scene writes.
 *
 * ES2015 put the SAME function object on `Number` -- `Number.parseFloat ===
 * parseFloat` is true by specification -- so a scene naming the qualified
 * form is naming this function, not a second one, and the two must lower
 * identically. Both spellings are proved against the default library, so a
 * scene's own local `parseFloat`, or its own `Number`, still lowers as
 * itself.
 */
export function isParseFloatCallee(
    callee: ts.Expression,
    context: Pick<LoweringServices, "libraryGlobal">,
): boolean {
    return isNumberParserCallee(callee, context, "parseFloat");
}

export function isNumberParserCallee(
    callee: ts.Expression,
    context: Pick<LoweringServices, "libraryGlobal">,
    method: "parseFloat" | "parseInt",
): boolean {
    return (
        context.libraryGlobal(callee) === method ||
        (ts.isPropertyAccessExpression(callee) &&
            callee.name.text === method &&
            context.libraryGlobal(callee.expression) === "Number")
    );
}

/** The library timer functions `platform-calls.ts` and `compileDeferredCallback` lower. */
const PLATFORM_TIMER_FUNCTIONS: ReadonlySet<string> = new Set([
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
]);

const NATIVE_DOM_BRIDGE_KINDS = new EmissionSet<Value["kind"]>([
    "record",
    "audio-engine",
    "audio-buffer",
    "audio-context",
    "audio-node",
    "audio-param",
    "media-stream",
    "media-stream-track",
    "blob",
    "data",
    "file",
    "file-list",
    "file-reader",
    "object-url",
    "static-fetch-response",
    "platform-keyboard-event",
    "platform-mouse-event",
    "ui-element",
    "worker",
    "worker-scope",
    "worker-message-event",
    "worker-error-event",
    "worker-media-query",
    "offscreen-canvas",
]);

/** A browser value the fold spells as a literal: a number, string, boolean, null or undefined. */
export function isPrimitiveBrowserValue(
    value: NonNullable<Value["browserValue"]>,
): boolean {
    return ["number", "boolean", "string", "null", "undefined"].includes(
        value.kind,
    );
}

/** The names the library binds the global object itself to. */
const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set([
    "globalThis",
    "self",
    "window",
]);

/**
 * Members of the browser's global object the native realm does not have. A
 * feature test reads each as a browser without that feature does, as
 * `undefined`, so the program takes its own fallback: the File System
 * Access pickers fall back to the download anchor and file input the
 * browser-file bridge lowers.
 */
const ABSENT_GLOBAL_MEMBERS: ReadonlySet<string> = new Set([
    "showDirectoryPicker",
    "showOpenFilePicker",
    "showSaveFilePicker",
]);

/**
 * A browser value with a native spelling: a primitive, or the deployment
 * query bag, which a read the fold cannot answer parses natively
 * (`deploymentSearchParamsValue`). A rect or the primary canvas has none.
 */
function hasNativeSpelling(value: NonNullable<Value["browserValue"]>): boolean {
    return isPrimitiveBrowserValue(value) || value.kind === "search-params";
}

interface BrowserErasureContext extends Pick<
    LoweringServices,
    | "isNativeWorkerExpression"
    | "unwrap"
    | "canvasSizeProperty"
    | "isCanvasElement"
    | "bindings"
    | "resolveThisField"
    | "libraryGlobal"
    | "checker"
    | "dataTypes"
    | "erasedBrowserExpressions"
    | "isNativeHostUiLookup"
    | "isNativeUiValueExpression"
    | "platformDocumentHidden"
    | "referenceSearch"
    | "options"
    | "constantInitializer"
    | "moduleFunctionDeclaration"
    | "sourceFiles"
    | "sourceFile"
    | "symbols"
> {}

/**
 * The id the host page gives its primary canvas, and so the one a program
 * finds it by when its engine canvas is not looked up by an id of its own.
 */
const HOST_PRIMARY_CANVAS_ID = "renderCanvas";

/**
 * Each program's primary canvas ids, keyed by its entry: a fact of the
 * parsed program, so a replay or a declined probe keeps it.
 */
const primaryCanvasIdsByEntry = new WeakMap<
    ts.SourceFile,
    ReadonlySet<string>
>();

type PrimaryCanvasContext = Pick<
    LoweringServices,
    "sourceFile" | "sourceFiles" | "symbols" | "unwrap" | "libraryGlobal"
>;

/**
 * The ids `document.getElementById` finds the native primary canvas by:
 * the ids the program looks up the canvas it hands `createEngine` by,
 * followed through constant bindings and through the parameters of the
 * local functions that pass the canvas on. A program whose engine canvas
 * comes from anywhere else finds the primary canvas by the host page's
 * own id.
 */
export function primaryCanvasIds(
    context: PrimaryCanvasContext,
): ReadonlySet<string> {
    const cached = primaryCanvasIdsByEntry.get(context.sourceFile);
    if (cached) return cached;
    const calls: ts.CallExpression[] = [];
    for (const file of context.sourceFiles()) {
        if (file.isDeclarationFile) continue;
        forEachAnalysisNode(file, (node) => {
            if (ts.isCallExpression(node)) calls.push(node);
        });
    }
    const ids = new Set<string>();
    const seen = new Set<ts.Node>();
    const collect = (expression: ts.Expression): void => {
        const value = context.unwrap(expression);
        if (seen.has(value)) return;
        seen.add(value);
        const id = elementIdLookup(context, value);
        if (id !== undefined) {
            ids.add(id);
            return;
        }
        if (!ts.isIdentifier(value)) return;
        const bound = constInitializer(context, value);
        if (bound) {
            collect(bound);
            return;
        }
        const parameter = context.symbols.valueSymbol(value)?.valueDeclaration;
        if (!parameter || !ts.isParameter(parameter)) return;
        const owner = parameter.parent;
        const index = owner.parameters.indexOf(parameter);
        const name = ts.isFunctionDeclaration(owner)
            ? owner.name
            : (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
                ts.isVariableDeclaration(owner.parent) &&
                ts.isIdentifier(owner.parent.name)
              ? owner.parent.name
              : undefined;
        const target = name && context.symbols.valueSymbol(name);
        if (!target) return;
        for (const call of calls) {
            const callee = context.unwrap(call.expression);
            const argument = call.arguments[index];
            if (
                argument &&
                ts.isIdentifier(callee) &&
                context.symbols.valueSymbol(callee) === target
            )
                collect(argument);
        }
    };
    for (const call of calls) {
        const canvas = call.arguments[0];
        if (
            canvas &&
            context.symbols.importedName(call.expression) === "createEngine"
        )
            collect(canvas);
    }
    const primary: ReadonlySet<string> =
        ids.size > 0 ? ids : new Set([HOST_PRIMARY_CANVAS_ID]);
    primaryCanvasIdsByEntry.set(context.sourceFile, primary);
    return primary;
}

/** The id a library `document.getElementById(id)` call looks up. */
function elementIdLookup(
    context: PrimaryCanvasContext,
    expression: ts.Expression,
): string | undefined {
    if (!ts.isCallExpression(expression) || expression.arguments.length !== 1)
        return undefined;
    const callee = context.unwrap(expression.expression);
    if (
        !ts.isPropertyAccessExpression(callee) ||
        callee.name.text !== "getElementById" ||
        context.libraryGlobal(callee.expression) !== "document"
    )
        return undefined;
    const argument = context.unwrap(argumentAt(expression, 0));
    const id = ts.isIdentifier(argument)
        ? constInitializer(context, argument)
        : argument;
    return id && ts.isStringLiteralLike(id) ? id.text : undefined;
}

/**
 * The initializer a `const` binding was declared with, read from its
 * declaration alone: the program scan above runs outside any scope.
 */
function constInitializer(
    context: PrimaryCanvasContext,
    identifier: ts.Identifier,
): ts.Expression | undefined {
    const declaration =
        context.symbols.valueSymbol(identifier)?.valueDeclaration;
    return declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
        declaration.initializer
        ? context.unwrap(declaration.initializer)
        : undefined;
}

/**
 * What walking a helper body produced: a value it returned, or the fact
 * that control ran off the end without returning one.
 *
 * The two are different answers and the caller acts on them differently --
 * a taken `if` that falls through continues to the statements after it --
 * so they are separated here rather than both spelled `undefined`, which
 * this evaluator reserves for "cannot fold".
 */
type HelperOutcome =
    | { returned: true; value: NonNullable<Value["browserValue"]> }
    | { returned: false };

export type BrowserGlobalContext = Pick<
    BrowserErasureContext,
    "unwrap" | "libraryGlobal"
>;

export function browserEnvironmentPropertyValue(
    context: BrowserGlobalContext & Pick<LoweringServices, "options">,
    expression: ts.Expression,
): Value | undefined {
    const unwrapped = context.unwrap(expression);
    if (!ts.isPropertyAccessExpression(unwrapped)) return undefined;
    const owner = browserEnvironmentValue(context, unwrapped.expression);
    return owner?.recordProperties?.[unwrapped.name.text];
}

function nativeNavigatorProperties(realm: boolean): Record<string, Value> {
    const graphics = "bbl::pal::WorkerRealm::current().graphics_identity()";
    return {
        language: { kind: "string", cpp: "bbl::preferred_language()" },
        userAgent: staticStringValue("bblitec/native", stringLiteral),
        platform: { kind: "string", cpp: "bbl::native_platform()" },
        hardwareConcurrency: {
            kind: "number",
            cpp: "bbl::logical_processor_count()",
        },
        onLine: { kind: "boolean", cpp: "true", staticBoolean: true },
        userAgentData: { kind: "json-null", cpp: "std::nullopt" },
        deviceMemory: { kind: "json-null", cpp: "std::nullopt" },
        gpu: realm
            ? {
                  kind: "record",
                  cpp: graphics,
                  objectIdentityCpp: graphics,
                  optionalFoundCpp: `(${graphics} != nullptr)`,
                  truthinessCpp: `(${graphics} != nullptr)`,
                  recordProperties: {},
              }
            : { kind: "json-null", cpp: "std::nullopt" },
        clipboard: {
            kind: "record",
            cpp: "",
            truthinessCpp: "true",
            recordProperties: {
                writeText: {
                    kind: "callback",
                    cpp: "",
                    hostFunction: "clipboard-write",
                },
            },
        },
    };
}

/** Native environment properties can travel through an aliased host object. */
export function browserEnvironmentValue(
    context: BrowserGlobalContext & Pick<LoweringServices, "options">,
    expression: ts.Expression,
): Value | undefined {
    const global = context.libraryGlobal(expression);
    if (global === "performance")
        return {
            kind: "record",
            cpp: "",
            truthinessCpp: "true",
            objectIdentityCpp: "bbl::native_performance_identity()",
            recordProperties: {
                memory: { kind: "json-null", cpp: "std::nullopt" },
                now: {
                    kind: "data",
                    cpp: "bbl::pal::performance_milliseconds",
                    dataType: {
                        kind: "function",
                        parameters: [],
                        result: { kind: "number" },
                    },
                },
            },
        };
    if (global !== "navigator") return undefined;
    return {
        kind: "record",
        cpp: "",
        truthinessCpp: "true",
        objectIdentityCpp: "bbl::native_navigator_identity()",
        recordProperties: nativeNavigatorProperties(!!context.options.workers),
    };
}

export function browserDeploymentValue(
    context: BrowserGlobalContext & Pick<LoweringServices, "options">,
    expression: ts.Expression,
): string | boolean | null | undefined {
    const unwrapped = context.unwrap(expression);
    if (!ts.isPropertyAccessExpression(unwrapped)) return undefined;
    if (
        context.libraryGlobal(unwrapped.expression) === "location" &&
        [
            "origin",
            "href",
            "pathname",
            "search",
            "hash",
            "host",
            "hostname",
            "port",
            "protocol",
        ].includes(unwrapped.name.text)
    ) {
        if (
            context.options.runtimeLocationSearch &&
            ["search", "href"].includes(unwrapped.name.text)
        )
            return undefined;
        const url = deploymentUrl(context.options);
        url.search = context.options.search;
        return url[
            unwrapped.name.text as
                | "origin"
                | "href"
                | "pathname"
                | "search"
                | "hash"
                | "host"
                | "hostname"
                | "port"
                | "protocol"
        ];
    }
    const env = unwrapped.expression;
    if (
        ts.isPropertyAccessExpression(env) &&
        env.name.text === "env" &&
        ts.isMetaProperty(env.expression) &&
        env.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        env.expression.name.text === "meta"
    ) {
        switch (unwrapped.name.text) {
            case "BASE_URL":
                return deploymentUrl(context.options).pathname;
            case "MODE":
                return "production";
            case "PROD":
                return true;
            case "DEV":
            case "SSR":
                return false;
        }
        const values = context.options.environment;
        return values && Object.hasOwn(values, unwrapped.name.text)
            ? values[unwrapped.name.text]!
            : null;
    }
    return undefined;
}

export class BrowserErasure {
    public constructor(private readonly context: BrowserErasureContext) {}

    /**
     * Helper bodies currently being evaluated, innermost last, each with
     * the `const` bindings its own statements have made so far.
     *
     * A body on this stack is also the recursion guard: a helper that
     * calls itself, directly or through another, finds its own body here
     * and answers nothing rather than running forever.
     */
    private readonly helperBodies: {
        body: ts.Block;
        bindings: Map<string, NonNullable<Value["browserValue"]>>;
    }[] = emissionArray([]);

    /**
     * What each helper body answered, once. A zero-argument module helper
     * over the fixed reference query has one answer per generation, and
     * `isBrowserOnlyExpression` asks about the same call many times while
     * an expression is lowered.
     */
    private readonly helperResults = new EmissionMap<
        ts.FunctionDeclaration,
        Value["browserValue"] | undefined
    >();

    private readonly browserUtilitySources = new EmissionMap<
        ts.SourceFile,
        boolean
    >();

    /**
     * Whether a callback only reports: its body observes or mutates browser
     * state and nothing else.
     *
     * The entry reporter and `setTimeout`'s browser-only arm ask this of the
     * same shapes, so it is one question with one answer.
     *
     * NOT `statementIsBrowserOnly`, which looks deeper but answers a
     * different question: it is what decides whether a statement inside a
     * RETAINED function may be erased, and it deliberately excludes console
     * and document so an unresolved guard stays a refusal rather than
     * swallowing a nested call. Reporting is exactly what those globals do.
     */
    public isBrowserOnlyHandler(handler: ts.Expression): boolean {
        const body =
            ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)
                ? handler.body
                : undefined;
        if (body && ts.isBlock(body)) {
            return body.statements.every(
                (statement) =>
                    ts.isExpressionStatement(statement) &&
                    this.isBrowserOnlyExpression(statement.expression),
            );
        }
        // A concise body is the expression itself; anything that is not a
        // function literal is asked directly, which lets a bare
        // `console.error` pass and a named recovery routine not.
        return this.isBrowserOnlyExpression(body ?? handler);
    }

    /**
     * An imported helper with no route to Babylon and no native input can
     * only observe or mutate browser state. Erasing the call as one unit is
     * both safer and more faithful than trying to lower implementation
     * details such as fetch wrappers, streams, timers, and DOM progress UI.
     *
     * The two guards are deliberately conservative: every explicit argument
     * must be a browser value or literal configuration, and the declaration's
     * entire module must reach no Babylon import. A helper receiving an engine,
     * mesh, runtime data, or callback therefore stays on the ordinary inliner.
     */
    public isBrowserOnlyLocalCall(call: ts.CallExpression): boolean {
        // A helper receiving retained controls has native effects even when
        // its returned interface consists entirely of void methods (focus,
        // navigation, click). Do not erase that interface as browser chrome.
        if (
            call.arguments.some((argument, index) => {
                if (
                    this.context.isCanvasElement(argument) &&
                    writesUnobservedCanvasMetadata(
                        this.context.checker,
                        this.context.sourceFiles(),
                        call,
                        index,
                        this.context.options.nativeHostUi,
                    )
                )
                    return false;
                if (this.context.isNativeUiValueExpression(argument))
                    return true;
                const value = this.context.unwrap(argument);
                const type = ts.isIdentifier(value)
                    ? this.context.bindings.lookupOptional(value)?.dataType
                    : undefined;
                return (
                    type?.kind === "vector" &&
                    type.element.kind === "handle" &&
                    type.element.handle === "ui-element"
                );
            })
        )
            return false;
        const callee = this.context.unwrap(call.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            this.isBrowserOnlyNullableClassFactoryCall(call)
        ) {
            return true;
        }
        if (!ts.isIdentifier(callee)) return false;
        const declaration = this.context.symbols
            .valueSymbol(callee)
            ?.declarations?.find(ts.isFunctionDeclaration);
        if (!declaration?.body) return false;
        const resultType = this.context.checker.getTypeAtLocation(call);
        // An async browser setup helper exposes `Promise<void>` at the call
        // site, but its observable result after the surrounding `await` is
        // still void. Inspect the promised value rather than rejecting the
        // Promise object's own `then`/`catch` surface as native application
        // data.
        const observableResult =
            this.context.checker.getAwaitedType(resultType) ?? resultType;
        let writeOnlyObjectResult = false;
        if ((observableResult.flags & ts.TypeFlags.Object) !== 0) {
            const directlyDom =
                declaredInDomLibrary(observableResult.symbol) ||
                declaredInDomLibrary(observableResult.aliasSymbol);
            if (!directlyDom) {
                writeOnlyObjectResult =
                    observableResult.getProperties().length > 0 &&
                    observableResult.getProperties().every((property) => {
                        const propertyDeclaration =
                            property.valueDeclaration ??
                            property.declarations?.[0];
                        if (!propertyDeclaration) return false;
                        const propertyType =
                            this.context.checker.getTypeOfSymbolAtLocation(
                                property,
                                propertyDeclaration,
                            );
                        const signatures = propertyType.getCallSignatures();
                        return (
                            signatures.length > 0 &&
                            signatures.every(
                                (signature) =>
                                    (this.context.checker.getReturnTypeOfSignature(
                                        signature,
                                    ).flags &
                                        ts.TypeFlags.Void) !==
                                    0,
                            )
                        );
                    });
                const carriesNativeData = observableResult
                    .getProperties()
                    .some((property) => {
                        const declaration =
                            property.valueDeclaration ??
                            property.declarations?.[0];
                        if (!declaration) return false;
                        const propertyType =
                            this.context.checker.getTypeOfSymbolAtLocation(
                                property,
                                declaration,
                            );
                        return (
                            propertyType.getCallSignatures().length === 0 &&
                            this.context.dataTypes.fromTsType(
                                propertyType,
                                declaration,
                            ) !== undefined
                        );
                    });
                if (carriesNativeData) {
                    // A DOM-using helper may still return an application
                    // record whose native fields are polled later (the
                    // platformer input controller). Erase its DOM statements
                    // individually rather than tainting the whole object.
                    return false;
                }
            }
        }
        if (writeOnlyObjectResult) {
            let reachesBrowser = false;
            let reachesBabylon = false;
            const visit = (root: ts.Node): void =>
                forEachAnalysisNode(root, (node) => {
                    if (ts.isTypeNode(node)) {
                        return "skip";
                    }
                    if (ts.isIdentifier(node)) {
                        if (
                            this.context.symbols.importedName(node) !==
                            undefined
                        ) {
                            reachesBabylon = true;
                        }
                        if (
                            ["document", "window", "globalThis"].includes(
                                node.text,
                            ) &&
                            this.context.libraryGlobal(node) !== undefined
                        ) {
                            reachesBrowser = true;
                        }
                    }
                });
            visit(declaration.body);
            if (reachesBrowser && !reachesBabylon) {
                return true;
            }
        }
        const hasBrowserInput = call.arguments.some((argument) => {
            if (!this.isBrowserOnlyExpression(argument)) return false;
            const value = this.evaluateBrowserValue(argument);
            // A query-resolved primitive is ordinary input to a helper,
            // including helpers in modules with no Babylon imports.
            return (
                !value ||
                (!isPrimitiveBrowserValue(value) &&
                    value.kind !== "search-params")
            );
        });
        const returnsVoid = (observableResult.flags & ts.TypeFlags.Void) !== 0;
        if (
            !hasBrowserInput ||
            (!returnsVoid &&
                !call.arguments.every((argument) =>
                    this.isBrowserHelperArgument(argument),
                ))
        ) {
            return false;
        }
        const source = declaration.getSourceFile();
        return this.isBrowserUtilitySource(source);
    }

    /**
     * A static factory for a nullable DOM-only class has no native object to
     * construct. This recognizes the deliberately narrow shape used by
     * optional browser overlays: the class lives in a module with no Babylon
     * imports, owns at least one DOM field, and exposes no native-readable
     * public state (only void methods).
     */
    public isBrowserOnlyNullableClassFactoryCall(
        call: ts.CallExpression,
    ): boolean {
        const callee = this.context.unwrap(call.expression);
        if (!ts.isPropertyAccessExpression(callee)) return false;
        const found = staticClassMember(
            this.context.checker,
            this.context.unwrap(callee.expression),
            callee.name,
        );
        const method = found?.table.staticMethods.get(found.name);
        if (!found || !method?.body) return false;
        const { declaration } = found.table;

        const result = this.context.checker.getAwaitedType(
            this.context.checker.getTypeAtLocation(call),
        );
        if (!result || (result.flags & ts.TypeFlags.Union) === 0) {
            return false;
        }
        const resultMembers = (result as ts.UnionType).types;
        const nullable = resultMembers.some(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !==
                0,
        );
        const concrete = resultMembers.filter(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) ===
                0,
        );
        if (
            !nullable ||
            concrete.length !== 1 ||
            !(concrete[0]!.symbol?.declarations ?? []).includes(declaration)
        ) {
            return false;
        }

        const isPrivateOrProtected = (member: ts.ClassElement): boolean =>
            (ts.getCombinedModifierFlags(member) &
                (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
            0;
        const isStatic = (member: ts.ClassElement): boolean =>
            (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !==
            0;
        const domOwned = declaration.members.some(
            (member) =>
                ts.isPropertyDeclaration(member) &&
                this.typeComesFromDom(
                    this.context.checker.getTypeAtLocation(member),
                ),
        );
        if (!domOwned) return false;

        // Retained canvases are part of the native UI surface. Do not classify
        // a helper which owns one as a browser-only decoration merely because
        // its public API happens to be write-only. Such helpers (for example a
        // decoded pixel-art HUD) must pass through ordinary class lowering so
        // their bounded Canvas2D calls can be rewritten onto the PAL.
        const ownsRetainedCanvas = declaration.members.some((member) => {
            if (!ts.isPropertyDeclaration(member)) return false;
            const type = this.context.checker.getTypeAtLocation(member);
            const members =
                (type.flags & ts.TypeFlags.Union) !== 0
                    ? (type as ts.UnionType).types
                    : [type];
            return members.some((candidate) => {
                const name = candidate.getSymbol()?.getName();
                return (
                    name === "HTMLCanvasElement" ||
                    name === "OffscreenCanvas" ||
                    name === "CanvasRenderingContext2D"
                );
            });
        });
        if (ownsRetainedCanvas) return false;

        const publicSurfaceIsWriteOnly = declaration.members.every((member) => {
            if (
                isStatic(member) ||
                isPrivateOrProtected(member) ||
                ts.isConstructorDeclaration(member)
            ) {
                return true;
            }
            if (!ts.isMethodDeclaration(member)) return false;
            const signature =
                this.context.checker.getSignatureFromDeclaration(member);
            return (
                signature !== undefined &&
                (this.context.checker.getReturnTypeOfSignature(signature)
                    .flags &
                    ts.TypeFlags.Void) !==
                    0
            );
        });
        return (
            publicSurfaceIsWriteOnly &&
            this.isBrowserUtilitySource(declaration.getSourceFile())
        );
    }

    private typeComesFromDom(type: ts.Type): boolean {
        const members =
            (type.flags & ts.TypeFlags.Union) !== 0
                ? (type as ts.UnionType).types
                : [type];
        return members.some((member) => declaredInDomLibrary(member.symbol));
    }

    private isBrowserUtilitySource(source: ts.SourceFile): boolean {
        const cached = this.browserUtilitySources.get(source);
        if (cached !== undefined) return cached;
        let reachesBabylon = false;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (reachesBabylon) return "skip";
                if (
                    ts.isIdentifier(node) &&
                    this.context.symbols.importedName(node) !== undefined
                ) {
                    reachesBabylon = true;
                    return "skip";
                }
            });
        visit(source);
        const browserOnly = !reachesBabylon;
        this.browserUtilitySources.set(source, browserOnly);
        return browserOnly;
    }

    private isBrowserHelperArgument(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (this.isBrowserOnlyExpression(unwrapped)) return true;
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNumericLiteral(unwrapped) ||
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
            unwrapped.kind === ts.SyntaxKind.NullKeyword
        ) {
            return true;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return unwrapped.properties.every(
                (property) =>
                    ts.isPropertyAssignment(property) &&
                    this.isBrowserHelperArgument(property.initializer),
            );
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            return unwrapped.elements.every(
                (element) =>
                    ts.isExpression(element) &&
                    this.isBrowserHelperArgument(element),
            );
        }
        return false;
    }

    public isBrowserOnlyExpression(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        const candidate =
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
                ? this.context.unwrap(unwrapped.left)
                : unwrapped;
        if (ts.isCallExpression(candidate)) {
            const callee = this.context.unwrap(candidate.expression);
            if (
                ts.isPropertyAccessExpression(callee) &&
                callee.name.text === "getGamepads" &&
                this.context.libraryGlobal(callee.expression) === "navigator"
            ) {
                return false;
            }
        }
        return this.isBrowserOnlyNode(expression);
    }

    public isBrowserDomValue(expression: ts.Expression): boolean {
        const type = this.context.checker.getTypeAtLocation(expression);
        const members =
            (type.flags & ts.TypeFlags.Union) !== 0
                ? (type as ts.UnionType).types
                : [type];
        // Gamepads are platform handles the native input model reads.
        if (
            members.some((member) => {
                const handle = platformHandleKind(member);
                return handle === "gamepad" || handle === "gamepad-button";
            })
        ) {
            return false;
        }
        const directlyDom = members.some((member) =>
            declaredInDomLibrary(member.symbol),
        );
        if (directlyDom) return true;
        const unwrapped = this.context.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const bound = this.context.bindings.lookupOptional(unwrapped);
            if (
                bound &&
                bound.kind !== "browser" &&
                (bound.kind !== "node-particle-2d-binding" ||
                    bound.nodeParticleLive)
            ) {
                // A local function can bridge DOM setup and return an ordinary
                // native record. Once that record is bound, its data fields do
                // not become browser-only merely because the initializer also
                // registered DOM listeners.
                return false;
            }
            const declaration =
                this.context.symbols.valueSymbol(unwrapped)?.valueDeclaration;
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                declaration.initializer !== unwrapped &&
                this.isBrowserOnlyExpression(declaration.initializer)
            ) {
                return true;
            }
        }
        return (
            (ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)) &&
            this.isBrowserDomValue(unwrapped.expression)
        );
    }

    public evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined {
        const value = this.browserValueOf(expression);
        this.recordBrowserExpression(expression);
        return value;
    }

    private recordBrowserExpression(expression: ts.Expression): void {
        this.context.erasedBrowserExpressions.add(
            this.context.unwrap(expression).pos,
        );
    }

    /** Platform-backed browser APIs that remain ordinary expression values. */
    public isPrimaryCanvas2DContextCall(call: ts.CallExpression): boolean {
        return this.isPrimaryCanvas2DContext(call, (expression) =>
            this.evaluateBrowserValue(expression),
        );
    }

    /** A real DOM RAF call, preserving ordinary lexical shadowing. */
    public isDefaultRequestAnimationFrameCall(
        call: ts.CallExpression,
    ): boolean {
        return (
            this.context.libraryGlobal(call.expression) ===
            "requestAnimationFrame"
        );
    }

    /**
     * The `localStorage` global, or a read or call on it. Spelled through
     * the same global recognizer as every other host object, so
     * `window.localStorage` and a lexical shadow answer correctly.
     */
    private isWebStorageExpression(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (this.context.libraryGlobal(unwrapped) === "localStorage") {
            return true;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            return this.isWebStorageExpression(unwrapped.expression);
        }
        if (ts.isCallExpression(unwrapped)) {
            return this.isWebStorageExpression(unwrapped.expression);
        }
        return false;
    }

    /**
     * `setTimeout(callback, delay)` -- bare or through `window`. The frame
     * conductor implements it (`compileDeferredCallback`), which is what
     * lets a scene's own freeze (`setTimeout(() => stopEngine(engine), 0)`)
     * reach the native loop instead of being silently dropped.
     */
    public isDeferredCallbackCall(call: ts.CallExpression): boolean {
        return this.context.libraryGlobal(call.expression) === "setTimeout";
    }

    /**
     * A call of one of the timer functions the frame conductor implements,
     * bare or through the global object. Every other `window.*` call
     * erases, because the browser service behind it has no native
     * counterpart; these have one, so `window.clearTimeout(id)` cancels
     * exactly as `clearTimeout(id)` does.
     */
    private isPlatformTimerCall(call: ts.CallExpression): boolean {
        return PLATFORM_TIMER_FUNCTIONS.has(
            this.context.libraryGlobal(call.expression) ?? "",
        );
    }

    private isBrowserOnlyNode(expression: ts.Expression): boolean {
        if (this.context.isNativeWorkerExpression(expression)) return false;
        const unwrapped = this.context.unwrap(expression);
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            ["set", "toString"].includes(unwrapped.expression.name.text) &&
            this.browserValueOf(unwrapped.expression.expression)?.kind ===
                "search-params"
        )
            return false;
        if (this.context.isNativeUiValueExpression(unwrapped)) return false;
        if (browserDeploymentValue(this.context, unwrapped) !== undefined)
            return false;
        // Scene-created DOM is not a browser object in the native program: it
        // is the input syntax for the retained UI IR. Keep this deliberately
        // narrower than general DOM support. Host-page lookups and arbitrary
        // document calls continue down the browser-erasure path.
        // Helper calls returning retained UI were answered by
        // isNativeUiValueExpression above.
        if (ts.isCallExpression(unwrapped) && this.isNativeUiCall(unwrapped)) {
            return false;
        }
        if (isNativeBrowserFileExpression(this.context, unwrapped)) {
            return false;
        }
        // `import.meta.url` is the browser module's deployment URL. Native
        // asset sinks fold the reached `new URL(path, import.meta.url)`
        // helper before this erasure gate; every remaining use is browser
        // setup (for example, selecting decoder script base URLs) and has no
        // run-time representation in an AOT package with no network loader.
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "url" &&
            ts.isMetaProperty(unwrapped.expression) &&
            unwrapped.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
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
        if (this.isPlatformPointerLockCall(unwrapped)) {
            return false;
        }
        // Web Storage is the third: `localStorage` is durable per-user
        // data, which the PAL owns outright, so a read of it is a platform
        // value rather than browser state with nothing behind it. Erasing
        // it would turn every load into "no save" and every save into a
        // silent no-op.
        if (this.isWebStorageExpression(unwrapped)) {
            return false;
        }
        if (
            browserEnvironmentPropertyValue(this.context, unwrapped) ||
            browserEnvironmentValue(this.context, unwrapped)
        )
            return false;
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "hidden" &&
            this.context.libraryGlobal(unwrapped.expression) === "document" &&
            this.context.platformDocumentHidden() !== undefined
        ) {
            return false;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            this.isPlatformTimerCall(unwrapped)
        )
            return false;
        if (
            ts.isCallExpression(unwrapped) &&
            unwrapped.arguments.length === 0 &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            unwrapped.expression.name.text === "focus" &&
            this.context.isCanvasElement(unwrapped.expression.expression)
        ) {
            return false;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            this.isBrowserOnlyLocalCall(unwrapped)
        ) {
            return true;
        }
        if (this.context.canvasSizeProperty(unwrapped)) {
            return false;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            (unwrapped.name.text === "innerWidth" ||
                unwrapped.name.text === "innerHeight") &&
            this.context.libraryGlobal(unwrapped.expression) === "window"
        ) {
            return false;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            this.context.bindings.lookupOptional(unwrapped.expression)
                ?.recordProperties?.[unwrapped.name.text]
        ) {
            // A native record may retain a DOM-declared structural type at
            // the TypeScript site. Its lowered fields win over that source
            // declaration, including the UiClientRect projected by RmlUi.
            return false;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            (unwrapped.name.text === "left" ||
                unwrapped.name.text === "top" ||
                unwrapped.name.text === "width" ||
                unwrapped.name.text === "height") &&
            this.browserValueOf(unwrapped.expression)?.kind === "dom-rect"
        ) {
            // Native has no CSS offset around its render surface; its size is
            // the live engine surface. All four reached DOMRect coordinates
            // therefore have platform-backed numeric representations.
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
                ].includes(this.context.libraryGlobal(unwrapped) ?? "")
            ) {
                return true;
            }
            const value = this.context.bindings.lookupOptional(unwrapped);
            const bound = value?.kind;
            // A FROZEN pure-2D particle binding has no native counterpart
            // and the corpus only reports it, so a read of one erases
            // exactly as a browser value does. A live one names the mapping
            // the generated registrar keeps, which scene code moves.
            return (
                bound === "browser" ||
                (bound === "node-particle-2d-binding" &&
                    !value?.nodeParticleLive) ||
                (bound === undefined && this.isBrowserDomValue(unwrapped))
            );
        }
        if (
            (ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)) &&
            !this.isNativeDomBridge(unwrapped) &&
            this.isBrowserDomValue(unwrapped)
        ) {
            return true;
        }
        if (
            ts.isNewExpression(unwrapped) &&
            this.context.libraryGlobal(unwrapped.expression) ===
                "URLSearchParams"
        ) {
            return this.browserValueOf(unwrapped) !== undefined;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            return this.browserReceiverTaint(unwrapped.expression, unwrapped);
        }
        if (ts.isBinaryExpression(unwrapped)) {
            // `devicePixelRatio` alone has a native lowering of its own.
            const operands = [unwrapped.left, unwrapped.right].filter(
                (operand) =>
                    !(
                        ts.isIdentifier(operand) &&
                        this.context.libraryGlobal(operand) ===
                            "devicePixelRatio"
                    ),
            );
            // An assignment to browser state stays browser state whatever
            // the deployment answers about it: a folded value is not a
            // place to write.
            return isAssignmentExpression(unwrapped)
                ? operands.some((operand) => this.isBrowserOnlyNode(operand))
                : this.browserOperandsTaint(operands, unwrapped);
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            return this.isBrowserOnlyNode(unwrapped.operand);
        }
        if (ts.isCallExpression(unwrapped)) {
            if (this.isBrowserOnlyNullableClassFactoryCall(unwrapped)) {
                return true;
            }
            if (
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                this.browserReceiverTaint(
                    unwrapped.expression.expression,
                    unwrapped,
                )
            ) {
                return true;
            }
            const browserArgument = unwrapped.arguments.some((argument) =>
                this.isBrowserOnlyNode(argument),
            );
            // `Number(x)` joins `isNaN` and `parseFloat` as a conversion
            // over a browser-derived value: it is how every physics scene
            // reads the step its capture is pinned at
            // (`Number(params.get("captureFrame"))`).
            if (
                ["isNaN", "Number"].includes(
                    this.context.libraryGlobal(unwrapped.expression) ?? "",
                ) ||
                // `Number.parseFloat` is the same function object as the
                // bare global, so which spelling a scene wrote cannot
                // decide whether the query value it reads stays browser
                // state.
                isParseFloatCallee(unwrapped.expression, this.context)
            ) {
                return browserArgument;
            }
            if (
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                this.context.libraryGlobal(unwrapped.expression.expression) ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite"
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
                this.context.libraryGlobal(unwrapped.expression.expression) ===
                    "Math"
            ) {
                return (
                    browserArgument &&
                    unwrapped.arguments.some(
                        (argument) =>
                            this.isBrowserOnlyNode(argument) &&
                            this.browserValueOf(argument) === undefined,
                    )
                );
            }
            // Last, because it is the only arm that reads a body rather
            // than a shape: a module helper whose whole body the query
            // answers is that answer, wherever the scene calls it.
            return this.evaluateBrowserHelperCall(unwrapped) !== undefined;
        }
        return false;
    }

    private isPrimaryCanvas2DContext(
        call: ts.CallExpression,
        evaluate = (expression: ts.Expression) =>
            this.browserValueOf(expression),
    ): boolean {
        const callee = this.context.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            callee.name.text !== "getContext" ||
            call.arguments.length !== 1
        )
            return false;
        const canvas = evaluate(callee.expression);
        const context = evaluate(argumentAt(call, 0));
        return (
            canvas?.kind === "object" &&
            !!canvas.primaryCanvas &&
            context?.kind === "string" &&
            context.value === "2d"
        );
    }

    private isNativeUiCall(call: ts.CallExpression): boolean {
        if (
            this.context.isNativeHostUiLookup(call) ||
            this.isPrimaryCanvas2DContext(call)
        )
            return true;
        const callee = this.context.unwrap(call.expression);
        if (!ts.isPropertyAccessExpression(callee)) return false;

        if (
            callee.name.text === "createElement" &&
            this.context.libraryGlobal(callee.expression) === "document"
        ) {
            return true;
        }

        if (this.isNativeDomBridge(callee.expression)) return true;

        return (
            (callee.name.text === "append" ||
                (callee.name.text === "appendChild" &&
                    call.arguments.length === 1 &&
                    this.isNativeDomBridge(argumentAt(call, 0)))) &&
            ts.isPropertyAccessExpression(callee.expression) &&
            (callee.expression.name.text === "body" ||
                callee.expression.name.text === "head") &&
            this.context.libraryGlobal(callee.expression.expression) ===
                "document"
        );
    }

    private isNativeDomBridge(expression: ts.Expression): boolean {
        const owner = (node: ts.Expression): Value | undefined => {
            const unwrapped = this.context.unwrap(node);
            if (
                ts.isCallExpression(unwrapped) &&
                this.context.isNativeHostUiLookup(unwrapped)
            ) {
                return { kind: "ui-element", cpp: "" };
            }
            if (
                (ts.isElementAccessExpression(unwrapped) ||
                    ts.isPropertyAccessExpression(unwrapped)) &&
                this.context.isNativeUiValueExpression(unwrapped)
            ) {
                return { kind: "ui-element", cpp: "" };
            }
            if (ts.isIdentifier(unwrapped)) {
                return this.context.bindings.lookupOptional(unwrapped);
            }
            if (
                ts.isPropertyAccessExpression(unwrapped) &&
                unwrapped.expression.kind === ts.SyntaxKind.ThisKeyword
            ) {
                return this.context.resolveThisField(unwrapped.name.text);
            }
            if (
                ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)
            ) {
                return owner(unwrapped.expression);
            }
            if (
                ts.isCallExpression(unwrapped) &&
                ts.isPropertyAccessExpression(unwrapped.expression)
            ) {
                return owner(unwrapped.expression.expression);
            }
            return undefined;
        };
        const value = owner(expression);
        return value !== undefined && NATIVE_DOM_BRIDGE_KINDS.has(value.kind);
    }

    private isPlatformTimeCall(
        expression: ts.Expression,
    ): expression is ts.CallExpression {
        return (
            ts.isCallExpression(expression) &&
            expression.arguments.length === 0 &&
            ts.isPropertyAccessExpression(expression.expression) &&
            expression.expression.name.text === "now" &&
            this.context.libraryGlobal(expression.expression.expression) ===
                "performance"
        );
    }

    /** Browser pointer-lock requests backed by SDL relative mouse mode. */
    private isPlatformPointerLockCall(
        expression: ts.Expression,
    ): expression is ts.CallExpression {
        if (
            !ts.isCallExpression(expression) ||
            expression.arguments.length !== 0 ||
            !ts.isPropertyAccessExpression(expression.expression)
        ) {
            return false;
        }
        const receiver = expression.expression.expression;
        const method = expression.expression.name.text;
        return (
            (method === "requestPointerLock" &&
                this.isBrowserDomValue(receiver)) ||
            (method === "exitPointerLock" &&
                this.context.libraryGlobal(receiver) === "document")
        );
    }

    /**
     * Whether an expression over `operands` is browser state.
     *
     * An operand the deployment does not answer keeps the whole expression
     * browser state. Answered operands are constants with a native
     * spelling, so the expression around them stays browser state only
     * while it folds as a whole; once a native operand keeps it from
     * folding, the expression is native and the constants lower beside
     * that operand. A mixed `labTest || save === null` therefore neither
     * refuses at its use nor, bound to a name, erases the native half of a
     * later `live && bump()`, while a short-circuit the query decides
     * stays folded.
     */
    private browserOperandsTaint(
        operands: readonly ts.Expression[],
        whole: ts.Expression,
    ): boolean {
        let answered = false;
        for (const operand of operands) {
            if (!this.isBrowserOnlyNode(operand)) continue;
            if (this.browserValueOf(operand) === undefined) return true;
            answered = true;
        }
        return answered && this.browserValueOf(whole) !== undefined;
    }

    /**
     * Whether a member read or call on `receiver` is browser state: the
     * operand rule, narrowed to receivers the deployment answers with a
     * value that has a native spelling, whose members lower natively
     * unless the whole use folds. Members of an answered value without one
     * stay browser state.
     */
    private browserReceiverTaint(
        receiver: ts.Expression,
        whole: ts.Expression,
    ): boolean {
        if (!this.isBrowserOnlyNode(receiver)) return false;
        const answered = this.browserValueOf(receiver);
        return (
            !(answered && hasNativeSpelling(answered)) ||
            this.browserValueOf(whole) !== undefined
        );
    }

    public evaluateBrowserCondition(
        expression: ts.Expression,
    ): boolean | undefined {
        const value = this.browserValueOf(expression);
        const condition = this.browserTruthy(value);
        this.recordBrowserExpression(expression);
        return condition;
    }

    private browserValueOf(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined {
        const unwrapped = this.context.unwrap(expression);
        const deployed = browserDeploymentValue(this.context, unwrapped);
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "url" &&
            ts.isMetaProperty(unwrapped.expression) &&
            unwrapped.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
            unwrapped.expression.name.text === "meta"
        )
            return { kind: "object", moduleUrl: true };
        if (deployed === null) return { kind: "null" };
        if (typeof deployed === "boolean")
            return { kind: "boolean", value: deployed };
        if (deployed !== undefined) return { kind: "string", value: deployed };
        if (this.isAbsentGlobalMember(unwrapped)) return { kind: "undefined" };
        if (ts.isTypeOfExpression(unwrapped)) {
            if (this.isAbsentGlobalMember(unwrapped.expression))
                return { kind: "string", value: "undefined" };
            const global = this.context.libraryGlobal(unwrapped.expression);
            // Native has no browser recording pipeline; authored capability
            // guards can select their own unavailable-recording path.
            if (global === "MediaRecorder")
                return { kind: "string", value: "undefined" };
            if (
                global &&
                [
                    "location",
                    "window",
                    "globalThis",
                    "document",
                    "localStorage",
                    "navigator",
                ].includes(global)
            ) {
                return { kind: "string", value: "object" };
            }
        }
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
            // A helper body's own `const` first: it is the innermost
            // scope, and nothing below can see it.
            const local = this.helperBinding(unwrapped);
            if (local !== undefined) return local;
            if (this.context.libraryGlobal(unwrapped) === "devicePixelRatio") {
                // Native has no CSS/backing-store split. Its single surface
                // corresponds to the browser reference at DPR 1.
                return { kind: "number", value: 1 };
            }
            const bound = this.context.bindings.lookupOptional(unwrapped);
            if (bound !== undefined) {
                if (bound.browserValue !== undefined) return bound.browserValue;
                if (bound.kind === "json-null") return { kind: "null" };
                // Inlining can bind a module constant before a browser
                // helper evaluates it. Its native binding still carries
                // the same immutable value; mutable parameters do not.
                if (
                    !bound.parameterBinding &&
                    bound.staticNumber !== undefined
                ) {
                    return { kind: "number", value: bound.staticNumber };
                }
                if (
                    !bound.parameterBinding &&
                    bound.staticString !== undefined
                ) {
                    return { kind: "string", value: bound.staticString };
                }
                if (
                    !bound.parameterBinding &&
                    bound.staticBoolean !== undefined
                ) {
                    return { kind: "boolean", value: bound.staticBoolean };
                }
                return undefined;
            }
            // Not a name this scope binds. A module-level `const` is
            // generation-known and answers here too: a physics scene reads
            // the step its capture is pinned at as
            // `Math.round(seconds * PHYSICS_FPS)`, where the seconds come
            // from the query the reference fixes and the rate is one of
            // these, so refusing the constant refuses a product the query
            // has already answered.
            //
            // Only a `const`. A mutable top-level binding has an initializer
            // too, and folding a read of it to that initializer would answer
            // with a value the program has already reassigned. Resolution
            // itself is the compiler's own, and only what THIS evaluator
            // folds comes back -- a constant naming a handle or a factory
            // call still answers nothing.
            const resolved = this.context.constantInitializer(unwrapped);
            return resolved === undefined || resolved === unwrapped
                ? undefined
                : this.browserValueOf(resolved);
        }
        if (
            ts.isNewExpression(unwrapped) &&
            this.context.libraryGlobal(unwrapped.expression) ===
                "URLSearchParams"
        ) {
            if (this.context.options.runtimeSearchParams) return undefined;
            const argument = unwrapped.arguments?.[0];
            const over = argument ? this.browserValueOf(argument) : undefined;
            if (argument && over?.kind !== "string") return undefined;
            return {
                kind: "search-params",
                search: over?.kind === "string" ? over.value : "",
            };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "search" &&
            this.context.libraryGlobal(unwrapped.expression) === "location"
        ) {
            if (this.context.options.runtimeLocationSearch) return undefined;
            return {
                kind: "string",
                value: this.context.referenceSearch(),
            };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            unwrapped.expression.name.text === "style" &&
            this.isBrowserDomValue(unwrapped)
        ) {
            // CSS state has no native object. Treat a read as absent so a
            // HUD's own idempotence guard (style.display === "flex") folds
            // away while its DOM writes erase through the ordinary path.
            return { kind: "null" };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "tabIndex" &&
            this.isBrowserDomValue(unwrapped.expression)
        ) {
            // Native keyboard events target the SDL surface directly. Treat
            // that surface as the focusable canvas the entry page establishes.
            return { kind: "number", value: 0 };
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "matches" &&
            !this.context.options.workers &&
            ts.isCallExpression(unwrapped.expression) &&
            ts.isPropertyAccessExpression(unwrapped.expression.expression) &&
            unwrapped.expression.expression.name.text === "matchMedia" &&
            this.context.libraryGlobal(
                unwrapped.expression.expression.expression,
            ) === "window" &&
            unwrapped.expression.arguments.length === 1 &&
            this.browserValueOf(argumentAt(unwrapped.expression, 0))?.kind ===
                "string"
        ) {
            // The native executable is an SDL desktop surface with mouse
            // hover and a fine pointer. A coarse/no-hover media query is the
            // source's touch-layout fork, so its native value is false.
            return { kind: "boolean", value: false };
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            const operand = this.browserValueOf(unwrapped.operand);
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
            if (unwrapped.operator !== ts.SyntaxKind.ExclamationToken) {
                return undefined;
            }
            const truthy = this.browserTruthy(operand);
            return truthy === undefined
                ? undefined
                : { kind: "boolean", value: !truthy };
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const left = this.browserValueOf(unwrapped.left);
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
                    ? this.browserValueOf(unwrapped.right)
                    : undefined;
            }
            if (unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                const truthy = this.browserTruthy(left);
                if (truthy === true) {
                    return left;
                }
                return truthy === false
                    ? this.browserValueOf(unwrapped.right)
                    : undefined;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
            ) {
                // `??` selects on NULLISHNESS, not truthiness: `"" ?? x` is
                // the empty string and `0 ?? x` is zero, where `||` would
                // take the right operand for both, so the test is the
                // nullish kinds rather than `browserTruthy`. An unfoldable
                // left stays unfoldable.
                if (left === undefined) {
                    return undefined;
                }
                return isNullishBrowserValue(left)
                    ? this.browserValueOf(unwrapped.right)
                    : left;
            }
            const numeric = new EmissionMap<
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
                const right = this.browserValueOf(unwrapped.right);
                if (left?.kind !== "number" || right?.kind !== "number") {
                    return undefined;
                }
                return {
                    kind: "number",
                    value: numeric(left.value, right.value),
                };
            }
            if (
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsToken
            ) {
                const right = this.browserValueOf(unwrapped.right);
                if (
                    !left ||
                    !right ||
                    (!isNullishBrowserValue(left) &&
                        !isNullishBrowserValue(right))
                )
                    return undefined;
                const equal =
                    isNullishBrowserValue(left) && isNullishBrowserValue(right);
                return {
                    kind: "boolean",
                    value:
                        unwrapped.operatorToken.kind ===
                        ts.SyntaxKind.EqualsEqualsToken
                            ? equal
                            : !equal,
                };
            }
            // A browser-derived value compared against a literal is how the
            // corpus reads an opt-out switch: `params.get("noise") !== "off"`
            // is `null !== "off"` once the query string is known empty. Only
            // the strict forms fold here: loose equality coerces, and only its
            // nullish case folds, above.
            if (
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken
            ) {
                const right = this.browserValueOf(unwrapped.right);
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
            const relational = relationalOperator(unwrapped.operatorToken.kind);
            if (relational) {
                const right = this.browserValueOf(unwrapped.right);
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
            if (this.isBrowserOnlyNullableClassFactoryCall(unwrapped)) {
                // A native build has no instance of a DOM-only class. Model
                // the erased nullable factory as its absent branch so guards
                // over the result remain deterministic.
                return { kind: "null" };
            }
            if (ts.isPropertyAccessExpression(unwrapped.expression)) {
                if (
                    this.context.libraryGlobal(
                        unwrapped.expression.expression,
                    ) === "document" &&
                    unwrapped.expression.name.text === "getElementById" &&
                    unwrapped.arguments.length === 1
                ) {
                    const elementId = this.browserValueOf(
                        argumentAt(unwrapped, 0),
                    );
                    if (
                        elementId?.kind !== "string" ||
                        !primaryCanvasIds(this.context).has(elementId.value)
                    ) {
                        return undefined;
                    }
                    // The generated native executable is launched with the
                    // canvas its scene entry point expects. The browser page's
                    // auto-run guard therefore selects the same branch in the
                    // native reference environment; keep it as an object so
                    // truthiness folds without pretending it equals `true`.
                    return { kind: "object", primaryCanvas: true };
                }
                // The receiver is evaluated rather than looked up, because
                // the corpus writes the query read both ways: bound to a
                // local first, and read straight off the constructor.
                const owner = this.browserValueOf(
                    unwrapped.expression.expression,
                );
                const method = unwrapped.expression.name.text;
                if (
                    method === "getBoundingClientRect" &&
                    unwrapped.arguments.length === 0 &&
                    this.isBrowserDomValue(unwrapped.expression.expression)
                ) {
                    // The primary canvas starts at the client origin. Its
                    // CSS extent is independent of its backing resolution.
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
                        ? this.browserValueOf(argument)
                        : undefined;
                    if (key?.kind !== "string") return undefined;
                    const parameters = new URLSearchParams(owner.search);
                    if (method === "has") {
                        const valueArgument = unwrapped.arguments[1];
                        const value = valueArgument
                            ? this.browserValueOf(valueArgument)
                            : undefined;
                        if (valueArgument && value?.kind !== "string")
                            return undefined;
                        return {
                            kind: "boolean",
                            value:
                                value?.kind === "string"
                                    ? parameters.has(key.value, value.value)
                                    : parameters.has(key.value),
                        };
                    }
                    const found = parameters.get(key.value);
                    return found === null
                        ? { kind: "null" }
                        : { kind: "string", value: found };
                }
            }
            if (
                isParseFloatCallee(unwrapped.expression, this.context) &&
                unwrapped.arguments.length === 1
            ) {
                const argument = this.browserValueOf(argumentAt(unwrapped, 0));
                const text = argument?.kind === "string" ? argument.value : "";
                return {
                    kind: "number",
                    value: Number.parseFloat(text),
                };
            }
            if (
                this.context.libraryGlobal(unwrapped.expression) === "Number" &&
                unwrapped.arguments.length === 1
            ) {
                const argument = this.browserValueOf(argumentAt(unwrapped, 0));
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
            if (this.context.libraryGlobal(unwrapped.expression) === "isNaN") {
                const argument = this.browserValueOf(argumentAt(unwrapped, 0));
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isNaN(argument.value),
                      }
                    : undefined;
            }
            if (
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                this.context.libraryGlobal(unwrapped.expression.expression) ===
                    "Number" &&
                unwrapped.expression.name.text === "isFinite"
            ) {
                const argument = this.browserValueOf(argumentAt(unwrapped, 0));
                return argument?.kind === "number"
                    ? {
                          kind: "boolean",
                          value: Number.isFinite(argument.value),
                      }
                    : undefined;
            }
            // `Math.round(frame)` -- how the capture-pose family turns the
            // query's text into the frame index it names. The neighbouring
            // taint rule in `isBrowserOnlyExpression` already documents
            // this call as one whose argument the query answers; folding
            // it here is what lets the helper around it answer too.
            if (
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                this.context.libraryGlobal(unwrapped.expression.expression) ===
                    "Math" &&
                unwrapped.arguments.length === 1
            ) {
                // The names read off the table `staticNumberValue` folds
                // through rather than one spelled here, so this rule and
                // the taint rule above -- which treats every Math call over
                // a resolved value alike -- cannot disagree about which
                // ones resolve. A transcendental is deliberately absent
                // from that table, and stays unfoldable here too.
                const fold = mathUnaryFold(unwrapped.expression.name.text);
                if (fold === undefined) return undefined;
                const argument = this.browserValueOf(argumentAt(unwrapped, 0));
                return argument?.kind === "number"
                    ? { kind: "number", value: fold(argument.value) }
                    : undefined;
            }
            const helper = this.evaluateBrowserHelperCall(unwrapped);
            if (helper !== undefined) return helper;
        }
        // A conditional selects between two values the same way `&&` and
        // `||` above do, and the family that reads a capture pose ends on
        // one (`Number.isFinite(frame) && frame >= 0 ? frame : null`).
        // Only the SELECTED arm is evaluated, so an unfoldable arm the
        // query does not reach costs nothing.
        if (ts.isConditionalExpression(unwrapped)) {
            const taken = this.browserTruthy(
                this.browserValueOf(unwrapped.condition),
            );
            return taken === undefined
                ? undefined
                : this.browserValueOf(
                      taken ? unwrapped.whenTrue : unwrapped.whenFalse,
                  );
        }
        return undefined;
    }

    /** A read of an {@link ABSENT_GLOBAL_MEMBERS} member off the global object. */
    private isAbsentGlobalMember(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        return (
            ts.isPropertyAccessExpression(unwrapped) &&
            ABSENT_GLOBAL_MEMBERS.has(unwrapped.name.text) &&
            this.isGlobalObject(unwrapped.expression)
        );
    }

    /**
     * The global object: the library's `window`, `self` or `globalThis`,
     * seen through type assertions and `const` aliases, which is how a
     * program types a member the library does not declare
     * (`const w = window as unknown as PickerWindow`).
     */
    private isGlobalObject(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        const global = this.context.libraryGlobal(unwrapped);
        if (global !== undefined) return GLOBAL_OBJECT_NAMES.has(global);
        if (!ts.isIdentifier(unwrapped)) return false;
        const initializer = constInitializer(this.context, unwrapped);
        return initializer !== undefined && this.isGlobalObject(initializer);
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
            case "undefined":
                return false;
            case "number":
                return value.value !== 0 && !Number.isNaN(value.value);
            case "object":
            case "dom-rect":
            case "search-params":
                return true;
            case "string":
                return value.value.length > 0;
        }
    }

    /**
     * A module-level helper whose body is a read of
     * the query the reference pose fixes -- the corpus's
     * `readCaptureFrame()` / `readCaptureAfterFrames()` / `readSeekTime()`
     * family, which thirteen pinned scenes define and call exactly once.
     *
     * The body is EVALUATED rather than lowered because the query already
     * answers it: the same three steps that fold when a scene writes them
     * inline (`new URLSearchParams(location.search)`, `params.get(...)`,
     * and a guard over the result) do not stop folding because the scene
     * put a name around them. Without this the call lowers to a native
     * function whose body IS the folded constant while the call site
     * stays dynamic, so every branch over the result remains live and a
     * scene's interactive arm has to compile at a pose the pin never
     * serves it at.
     *
     * Narrow on five counts, each of them a way the answer could be WRONG
     * rather than merely unavailable:
     *   - the body must READ browser state. A helper returning the
     *     program's own constants is ordinary code that this compiler
     *     lowers as a function, and calling it browser-only would erase a
     *     call the scene means to make;
     *   - module level and synchronous, so the body closes over nothing
     *     whose value depends on when the call is asked about and its
     *     result is a value rather than a promise;
     *   - each argument must fold and bind a plain parameter;
     *   - not already on the stack, so recursion refuses;
     *   - and every statement and expression must fold, so a helper
     *     reaching anything this evaluator does not model answers nothing
     *     and lowers exactly as it does today.
     */
    private evaluateBrowserHelperCall(
        call: ts.CallExpression,
    ): Value["browserValue"] | undefined {
        const callee = this.context.unwrap(call.expression);
        if (!ts.isIdentifier(callee)) return undefined;
        const declaration = this.context.moduleFunctionDeclaration(callee);
        const body = declaration?.body;
        if (
            !body ||
            declaration.parameters.length !== call.arguments.length ||
            declaration.parameters.some(
                (parameter) =>
                    !ts.isIdentifier(parameter.name) ||
                    parameter.initializer !== undefined ||
                    parameter.dotDotDotToken !== undefined,
            ) ||
            declaration.asteriskToken !== undefined ||
            declaration.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            ) ||
            this.helperBodies.some((frame) => frame.body === body)
        ) {
            return undefined;
        }
        const cacheable = declaration.parameters.length === 0;
        if (cacheable && this.helperResults.has(declaration)) {
            return this.helperResults.get(declaration);
        }
        const bindings = new EmissionMap<
            string,
            NonNullable<Value["browserValue"]>
        >();
        let browserArgument = false;
        for (const [index, parameter] of declaration.parameters.entries()) {
            const value = this.browserValueOf(call.arguments[index]!);
            if (value === undefined || !ts.isIdentifier(parameter.name))
                return undefined;
            bindings.set(parameter.name.text, value);
            browserArgument ||=
                !isPrimitiveBrowserValue(value) &&
                this.isBrowserOnlyNode(call.arguments[index]!);
        }
        this.helperBodies.push({ body, bindings });
        let result: Value["browserValue"] | undefined;
        try {
            if (browserArgument || this.readsBrowserState(body)) {
                const outcome = this.evaluateBrowserStatements(body.statements);
                result = outcome?.returned ? outcome.value : undefined;
            }
        } finally {
            this.helperBodies.pop();
        }
        if (cacheable) this.helperResults.set(declaration, result);
        return result;
    }

    /**
     * Whether a helper body reads browser state at all.
     *
     * This is the gate that separates a query read from ordinary code:
     * `function count() { return 4; }` folds under every other rule here,
     * and answering for it would erase a native call the scene means to
     * make. Browser state always enters through a name -- `location`,
     * `window`, `document`, `devicePixelRatio` -- or a member of one, so
     * those are the nodes asked, and the existing predicate decides.
     */
    private readsBrowserState(body: ts.Node): boolean {
        let reads = false;
        const visit = (node: ts.Node): void => {
            if (reads) return;
            if (
                (ts.isIdentifier(node) ||
                    ts.isPropertyAccessExpression(node)) &&
                this.isBrowserOnlyNode(node)
            ) {
                reads = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(body);
        return reads;
    }

    /**
     * One straight-line slice of a helper body: `const` bindings, an `if`
     * over a folded condition, and `return`.
     *
     * A folded `if` walks only the branch the query selects, which is what
     * lets the family's second guard read a parameter its first guard has
     * already proved absent. Running off the end without returning is a
     * distinct answer from refusing -- a taken `if` whose branch falls
     * through continues with the statements after it -- so the two are
     * separate outcomes. Anything else (a loop, a `let`, an assignment, a
     * call this evaluator cannot answer) refuses, and the helper then
     * lowers as it does today.
     */
    private evaluateBrowserStatements(
        statements: readonly ts.Statement[],
    ): HelperOutcome | undefined {
        for (const statement of statements) {
            if (ts.isVariableStatement(statement)) {
                if (
                    (statement.declarationList.flags & ts.NodeFlags.Const) ===
                    0
                ) {
                    return undefined;
                }
                for (const declaration of statement.declarationList
                    .declarations) {
                    if (
                        !ts.isIdentifier(declaration.name) ||
                        !declaration.initializer
                    ) {
                        return undefined;
                    }
                    const value = this.browserValueOf(declaration.initializer);
                    if (value === undefined) return undefined;
                    this.helperBodies
                        .at(-1)
                        ?.bindings.set(declaration.name.text, value);
                }
                continue;
            }
            if (ts.isIfStatement(statement)) {
                const taken = this.browserTruthy(
                    this.browserValueOf(statement.expression),
                );
                if (taken === undefined) return undefined;
                const branch = taken
                    ? statement.thenStatement
                    : statement.elseStatement;
                if (!branch) continue;
                const outcome = this.evaluateBrowserStatements(
                    ts.isBlock(branch) ? branch.statements : [branch],
                );
                if (outcome === undefined || outcome.returned) {
                    return outcome;
                }
                continue;
            }
            if (ts.isReturnStatement(statement)) {
                const value = statement.expression
                    ? this.browserValueOf(statement.expression)
                    : undefined;
                return value === undefined
                    ? undefined
                    : { returned: true, value };
            }
            return undefined;
        }
        return { returned: false };
    }

    /**
     * A `const` bound by the helper body under evaluation.
     *
     * Keyed by NAME within one body rather than by symbol, because this
     * compiler's neighbouring const fold records that the checker hands
     * back distinct symbol instances for a declaration name and a use of
     * it, so an identity map misses. A name is unambiguous here: a frame
     * holds only what its own body declared. What keeps it from answering
     * for a same-named identifier somewhere else is the containment test
     * -- resolving a module constant's initializer re-enters this
     * evaluator with nodes from outside every open body.
     */
    private helperBinding(
        identifier: ts.Identifier,
    ): Value["browserValue"] | undefined {
        for (let index = this.helperBodies.length - 1; index >= 0; index--) {
            const frame = this.helperBodies[index]!;
            if (
                identifier.getSourceFile() === frame.body.getSourceFile() &&
                identifier.pos >= frame.body.pos &&
                identifier.end <= frame.body.end
            ) {
                return frame.bindings.get(identifier.text);
            }
        }
        return undefined;
    }

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
        const head = promiseExecutor(
            this.context.unwrap(expression),
            (callee) => this.context.libraryGlobal(callee),
        );
        if (!head) return undefined;
        return {
            resolveName: head.resolve.text,
            body: head.executor.body,
        };
    }

    /**
     * `await new Promise<void>((r) => requestAnimationFrame(() => r()))` --
     * the single-frame yield a pinned scene uses to let one more frame draw
     * before it flags the canvas ready.
     *
     * `requestAnimationFrame` is a browser API with no native counterpart,
     * and what the wait buys in the browser is that the work scheduled
     * before it has landed by the time the capture happens. Before the
     * frame loop exists this runtime satisfies that by construction -- the
     * frame's own thread does that work before the draw that reads it --
     * so the yield is erased there. Inside the hoisted `startEngine`
     * continuation the statements around it already run at a frame
     * boundary, so the yield instead re-queues the rest of the
     * continuation to the NEXT boundary (`emitFrameYieldRequeue`), which
     * is what keeps "one more frame has drawn" true. Either way the shape
     * is matched structurally rather than by counting `new Promise`,
     * because a multi-frame wait or one that resolves on some other
     * condition is NOT this and must keep refusing.
     */
    public isFrameYield(expression: ts.Expression): boolean {
        const executor = this.promiseExecutor(expression);
        if (!executor) return false;
        const resolveName = executor.resolveName;
        const raf = this.context.unwrap(executor.body as ts.Expression);
        if (
            !ts.isCallExpression(raf) ||
            !this.isDefaultRequestAnimationFrameCall(raf) ||
            raf.arguments.length !== 1
        ) {
            return false;
        }
        const callback = argumentAt(raf, 0);
        if (!ts.isArrowFunction(callback) || callback.parameters.length !== 0) {
            return false;
        }
        const resolveCall = this.context.unwrap(callback.body as ts.Expression);
        return (
            ts.isCallExpression(resolveCall) &&
            ts.isIdentifier(resolveCall.expression) &&
            resolveCall.expression.text === resolveName &&
            resolveCall.arguments.length === 0
        );
    }

    /**
     * The one bounded two-frame wait the pin gives Scene 117:
     *
     * ```ts
     * new Promise((resolve) =>
     *     requestAnimationFrame(() => requestAnimationFrame(resolve)))
     * ```
     *
     * This is deliberately not a recursive/counting matcher. The initial
     * Scene 117 PR used a loop around single-frame promises; review replaced
     * it with this closed two-RAF expression before the pinned commit. Native
     * runs the post-start continuation on the frame conductor, after the
     * initial draw, and applies its CPU sprite mutation before the following
     * draw, so these two settling turns have no additional state to drain.
     * Any third callback, callback body, argument, or different Promise
     * executor remains outside the contract and keeps refusing.
     */
    public isBoundedNestedFrameYield(expression: ts.Expression): boolean {
        const executor = this.promiseExecutor(expression);
        if (!executor) return false;
        const outer = this.context.unwrap(executor.body as ts.Expression);
        if (
            !ts.isCallExpression(outer) ||
            !this.isDefaultRequestAnimationFrameCall(outer) ||
            outer.arguments.length !== 1
        ) {
            return false;
        }
        const callback = argumentAt(outer, 0);
        if (!ts.isArrowFunction(callback) || callback.parameters.length !== 0) {
            return false;
        }
        const inner = this.context.unwrap(callback.body as ts.Expression);
        return (
            ts.isCallExpression(inner) &&
            this.isDefaultRequestAnimationFrameCall(inner) &&
            inner.arguments.length === 1 &&
            identifierText(argumentAt(inner, 0)) === executor.resolveName
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
            !this.isDefaultRequestAnimationFrameCall(scheduled) ||
            scheduled.arguments.length !== 1 ||
            identifierText(argumentAt(scheduled, 0)) !== waitName
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

    /**
     * The escaping-continuation Promise: an executor whose whole body
     * stores `resolve` in a binding declared outside it, so what completes
     * the wait is a callback the scene installs rather than a frame count.
     *
     * ```ts
     * let resolveFrozen!: () => void;
     * const frozen = new Promise<void>((resolve) => {
     *     resolveFrozen = resolve;
     * });
     * ```
     *
     * It is the fourth shape over the shared `promiseExecutor` head and it
     * is deliberately the narrowest: the body must be that one assignment
     * and nothing else, and the assigned value must be `resolve` itself.
     * An executor that also schedules, calls `resolve`, or stores a wrapper
     * around it is a different claim about WHEN the wait ends, and falls
     * through to the refusal the other three leave in place.
     *
     * Returns the binding `resolve` escapes into, so the caller can bind it
     * to the latch the await waits on.
     */
    public escapingResolveTarget(
        expression: ts.Expression,
    ): ts.Identifier | undefined {
        const executor = this.promiseExecutor(expression);
        if (!executor) return undefined;
        // A block body must be that one statement and nothing else; a
        // concise body IS the expression. Narrowed rather than cast, so a
        // two-statement block cannot reach the expression path at all.
        const body = executor.body;
        const statement = ts.isBlock(body)
            ? body.statements.length === 1
                ? body.statements[0]
                : undefined
            : undefined;
        const assignment = ts.isBlock(body)
            ? statement && ts.isExpressionStatement(statement)
                ? this.context.unwrap(statement.expression)
                : undefined
            : this.context.unwrap(body);
        if (
            !assignment ||
            !ts.isBinaryExpression(assignment) ||
            assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isIdentifier(assignment.left)
        ) {
            return undefined;
        }
        const assigned = this.context.unwrap(assignment.right);
        return ts.isIdentifier(assigned) &&
            assigned.text === executor.resolveName
            ? assignment.left
            : undefined;
    }

    public isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        const objectInstrumentation =
            ts.isPropertyAccessExpression(call.expression) &&
            this.context.libraryGlobal(call.expression.expression) ===
                "Object" &&
            // Writing into a browser object instruments the page; writing
            // into the scene's own data is an ordinary store.
            (call.expression.name.text === "assign" ||
                call.expression.name.text === "defineProperty") &&
            call.arguments[0] !== undefined &&
            this.isBrowserOnlyNode(call.arguments[0]);
        const deviceEvent =
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "addEventListener" &&
            ts.isPropertyAccessExpression(call.expression.expression) &&
            call.expression.expression.name.text === "_device";
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

/** `null` or `undefined`: the two values `??` and `== null` select alike. */
function isNullishBrowserValue(
    value: NonNullable<Value["browserValue"]>,
): boolean {
    return value.kind === "null" || value.kind === "undefined";
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
    if (isNullishBrowserValue(left)) return true;
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
