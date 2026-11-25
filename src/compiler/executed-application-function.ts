/**
 * An application function whose result generation needs, executed.
 *
 * A scene writes some of what the pin consumes as code rather than data: a
 * shader builder returning the WGSL a `createShaderMaterial` compiles
 * (`vertexSource(mode)`), a material plugin's `getCustomCode(shaderType)`
 * returning the WGSL it injects. The pin calls each once with values
 * generation already knows, so running the function IS the result -- the
 * text the browser compiles -- with no second reading of its branches.
 *
 * What runs is the function and exactly the declarations it reaches: the
 * module-scope `const`s and functions of its own file and of the repository
 * modules it imports, in source order, each file in a scope of its own;
 * bindings of an enclosing function the compiler folds to a value; and the
 * pin's `wgsl` tag, the executed pinned function. The rest of a scene module
 * (its imports of the engine, its `main()`) is never evaluated. It runs in a
 * fresh ECMAScript realm holding the language's own globals and nothing of
 * the host, so a function reaching a browser or engine API throws, and so
 * does any other reach this closure does not carry: every refusal names the
 * node that made it. The deployment constants generation folds (the page
 * URL's parts, `import.meta.env`) run as their literals, as does a text the
 * caller stands in for an expression (`standInText`); an argument number the
 * caller marks unread throws when the run reads it (`unreadNumbers`).
 *
 * The result must be plain data, compared through a JSON round trip, for
 * the reason the in-process module passes give: anything else is a value two
 * engines need not agree on.
 */
import { types } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    aliasTarget,
    CompilerSymbols,
    declarationOrigin,
    declaredSymbol,
    isAbsentTypeofIdentifier,
    libraryGlobal,
    namedMember,
} from "./symbols.js";
import {
    rootIdentifier,
    statementDeclaredNames,
    isValueReference,
    propertyKey,
    variableKind,
    hasDeclareModifier,
} from "./syntax.js";
import { typeCanCarryReference, unionMembers } from "./type-facts.js";
import { writesThroughTrackedRoot } from "./user-functions.js";
import { writtenOnlyInDeadFunctions } from "./string-domain.js";
import { pinnedModuleBinding } from "../lowering/pinned-shader-builders.js";
import { syntaxKindName } from "../source-location.js";
import { transpileCommonJs } from "../typescript-transpile.js";
import { sharedUpstreamStore } from "../upstream-source.js";
import { mathMemberAccess, mathMemberIsImpure } from "./math-intrinsics.js";
import { GenerationBlob } from "./generation-blob.js";
import { isStaticMember } from "./class-members.js";

/** A value generation hands the function or binds to a name it closes over. */
export type ExecutedScalar = string | number | boolean;

/** Fresh literal data passed into the closed generation realm. */
export type ExecutedArgument =
    | ExecutedScalar
    | null
    | readonly ExecutedArgument[]
    | { readonly [name: string]: ExecutedArgument };

export interface ExecutedFunctionContext {
    readonly checker: ts.TypeChecker;
    readonly sourceFiles?: readonly ts.SourceFile[];
    fail(node: ts.Node, message: string): never;
    /**
     * The generation-known value of a binding the function closes over from
     * an enclosing function, or undefined when the compiler cannot fold it.
     */
    foldEnclosing(identifier: ts.Identifier): ExecutedArgument | undefined;
    /**
     * Whether the program writes through a module constant the run reads,
     * for a run that must describe the constant as its module builds it (a
     * module constant run at generation); unchecked when absent.
     */
    writtenThrough?(name: ts.Identifier): boolean;
    /**
     * The deployment constant an expression folds to (`location.origin`,
     * `import.meta.env.BASE_URL`), which the run reads as that literal.
     */
    deploymentValue?(
        expression: ts.Expression,
    ): string | boolean | null | undefined;
    /**
     * The text of the packaged file a URL the run fetches serves, or
     * undefined where the package holds none (that fetch rejects, as it
     * does natively). A packaged file is part of the build, so a run that
     * reads one describes every run.
     */
    packagedText?(url: string): string | undefined;
    /**
     * The value a pinned import is bound to for this run instead of being
     * refused: the caller's own model of that export (a loader recording
     * what it is handed), or undefined to refuse it.
     */
    pinnedStandIn?(name: string): unknown;
    /**
     * The text an expression of the run evaluates to instead of running,
     * or undefined to run it.
     */
    standInText?(expression: ts.Expression): string | undefined;
    /**
     * The numbers of each argument, by argument index, that generation does
     * not know: each lane, a key path into that argument, reads as an
     * accessor that throws `message`.
     */
    /**
     * A model run: module state starts as its declarations initialize it and
     * the run's writes to it stay its own, so the run describes the
     * program's first evaluation of the target rather than every one; the
     * caller checks what it reads against the program's own values. Each of
     * the pin's functions it reaches runs as an opaque call (`opaqueValue`).
     */
    readonly model?: boolean;
    /**
     * Whether a binding a model run's target closes over holds an engine or
     * platform value (`holdsEngineValue`), which the run binds to an opaque
     * value instead of evaluating it.
     */
    opaque?(identifier: ts.Identifier): boolean;
    readonly unreadNumbers?: ReadonlyMap<
        number,
        {
            readonly lanes: readonly (readonly string[])[];
            readonly message: string;
        }
    >;
}

/**
 * Host globals a generation run may read, none of which reads host state:
 * WHATWG URL parsing and base64, which the realm receives from Node, and
 * Blob construction (`generation-blob.ts`).
 */
const GENERATION_HOST_GLOBALS: ReadonlyMap<string, unknown> = new Map<
    string,
    unknown
>([
    ["URL", URL],
    ["URLSearchParams", URLSearchParams],
    ["Blob", GenerationBlob],
    ["btoa", btoa],
    ["atob", atob],
]);

/**
 * Host globals the realm builds itself, given the host's `read` of a
 * packaged file: `fetch` of the packaged files, whose responses read their
 * file's text, and a `console` whose output the program's own run of the
 * same call writes.
 */
const GENERATION_REALM_GLOBALS = `({ read }) => ({
    fetch: (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url);
        const body = read(url);
        if (body === undefined) return Promise.reject(new TypeError("Failed to fetch " + url));
        return Promise.resolve(Object.freeze({
            ok: true,
            status: 200,
            statusText: "",
            url,
            text: async () => body,
            json: async () => JSON.parse(body),
        }));
    },
    console: Object.freeze(Object.fromEntries(
        ["debug", "error", "info", "log", "warn"].map((name) => [name, () => undefined]),
    )),
})`;

/** The names `GENERATION_REALM_GLOBALS` binds. */
const GENERATION_REALM_NAMES: ReadonlySet<string> = new Set([
    "fetch",
    "console",
]);

/** The pinned imports an executed closure may reach, by imported name. */
const pinnedTags: ReadonlySet<string> = new Set(["wgsl"]);

/** Where a name one file part imports is bound from. */
type ImportSource =
    | { kind: "pinned"; name: string }
    | { kind: "sibling"; file: ts.SourceFile; name: string };

/** The declarations one file contributes to the executed closure. */
interface FilePart {
    index: number;
    statements: Set<ts.Statement>;
    imports: Map<string, ImportSource>;
    /** The module-scope bindings a model run holds opaque instead of running. */
    opaque: Set<string>;
}

/**
 * A function-like node the closure can call as a value, or a module-scope
 * `const` or a closed call whose value the closure evaluates.
 */
export type ExecutedTarget =
    ts.FunctionLikeDeclaration | ts.VariableDeclaration | ts.CallExpression;

/** What a run settled with, as its realm holds it. */
export interface ExecutedResult {
    readonly value: unknown;
    /**
     * Whether `value` is an array or a record with no class behind it: an
     * object of the run's realm whose members a reader may walk.
     */
    isPlain(value: unknown): boolean;
}

/**
 * Execute `target` with `args` and return what it settles with, unchecked:
 * a function's return value (an async one's settled value), or a constant
 * or call's value (no arguments), with the realm's own JSON parser.
 * `label` names the target in refusals.
 */
export function runApplicationFunction(
    context: ExecutedFunctionContext,
    target: ExecutedTarget,
    args: readonly (ExecutedArgument | undefined)[],
    label: string,
): ExecutedResult & { readonly parse: (text: string) => unknown } {
    const closure = new ExecutedClosure(context, target, label);
    // The first pinned function the run uses, and the first module-scope
    // write it makes, which a catch in the run cannot hide: the run then
    // describes no run.
    let pinnedUse: string | undefined;
    let moduleWrite: string | undefined;
    const program = closure.program(
        (name) => {
            pinnedUse ??= name;
        },
        (where) => {
            moduleWrite ??= where;
        },
    );
    const refuseEffect = (): never | undefined =>
        pinnedUse !== undefined
            ? context.fail(
                  target,
                  `${label} uses pinned '${pinnedUse}', which generation does not run; only the ${[...pinnedTags].join(", ")} tag executes with it.`,
              )
            : moduleWrite !== undefined
              ? context.fail(
                    target,
                    `${label} writes a module-scope binding at ${moduleWrite}, so one execution would not describe every call.`,
                )
              : undefined;
    // The realm's global object is this fresh record (`vm.createContext`
    // contextifies it in place), which the realm's own globals extend.
    const globals: Record<string, unknown> = {
        ...Object.fromEntries(GENERATION_HOST_GLOBALS),
    };
    const realm = vm.createContext(globals, {
        name: `generation function ${label}`,
        microtaskMode: "afterEvaluate",
    });
    const realmGlobals: unknown = vm.runInContext(
        GENERATION_REALM_GLOBALS,
        realm,
    );
    if (typeof realmGlobals !== "function")
        throw new Error("A generation function realm has no host globals.");
    // A fetch the package does not serve rejects natively, but its outcome
    // is the deployment's, not the build's: the run then describes no run.
    let unpackaged: string | undefined;
    Object.assign(
        globals,
        Reflect.apply(realmGlobals, undefined, [
            {
                read: (url: string): string | undefined => {
                    const text = context.packagedText?.(url);
                    if (text === undefined) unpackaged ??= url;
                    return text;
                },
            },
        ]),
    );
    const parse: unknown = vm.runInContext("JSON.parse", realm);
    const plain: unknown = vm.runInContext(
        "(value) => Array.isArray(value) || (typeof value === 'object' && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value)))",
        realm,
    );
    const unread: unknown = vm.runInContext(
        "(value, lane, message) => { let owner = value; for (const key of lane.slice(0, -1)) owner = owner[key]; Object.defineProperty(owner, lane[lane.length - 1], { get() { throw new Error(message); }, enumerable: true }); }",
        realm,
    );
    if (
        typeof parse !== "function" ||
        typeof plain !== "function" ||
        typeof unread !== "function"
    ) {
        throw new Error("A generation function realm has no JSON.parse.");
    }
    // Data crosses into the realm as objects of the realm.
    const inRealm = (value: ExecutedArgument | undefined): unknown =>
        value !== null && typeof value === "object"
            ? Reflect.apply(parse, undefined, [JSON.stringify(value)])
            : value;
    const argumentInRealm = (
        value: ExecutedArgument | undefined,
        index: number,
    ): unknown => {
        const crossed = inRealm(value);
        const numbers = context.unreadNumbers?.get(index);
        if (numbers)
            for (const lane of numbers.lanes)
                Reflect.apply(unread, undefined, [
                    crossed,
                    lane,
                    numbers.message,
                ]);
        return crossed;
    };
    let result: unknown;
    try {
        const build: unknown = vm.runInContext(program.javascript, realm, {
            filename: target.getSourceFile().fileName,
        });
        if (typeof build !== "function") {
            throw new Error(
                "The executed closure did not compile to a function.",
            );
        }
        const executed: unknown = Reflect.apply(build, undefined, [
            {
                pinned: program.bindings.pinned,
                opaque: program.bindings.opaque,
                written: program.bindings.written,
                enclosing: Object.fromEntries(
                    Object.entries(program.bindings.enclosing).map(
                        ([name, value]) => [name, inRealm(value)],
                    ),
                ),
            },
        ]);
        if (ts.isVariableDeclaration(target) || ts.isCallExpression(target)) {
            if (args.length > 0) {
                throw new Error(`${label} is a value, not a function.`);
            }
            result = executed;
        } else {
            if (typeof executed !== "function") {
                throw new Error(`${label} is not a function once executed.`);
            }
            result = Reflect.apply(
                executed,
                undefined,
                args.map(argumentInRealm),
            );
        }
        result = settledResult(realm, result);
    } catch (error: unknown) {
        refuseEffect();
        return context.fail(
            target,
            `${label} threw at generation: ${errorMessage(error)}`,
        );
    }
    refuseEffect();
    if (unpackaged !== undefined)
        return context.fail(
            target,
            `${label} fetches '${unpackaged}', which the package does not hold.`,
        );
    return {
        value: result,
        isPlain: (value) => Reflect.apply(plain, undefined, [value]) === true,
        parse: (text): unknown => Reflect.apply(parse, undefined, [text]),
    };
}

/**
 * `runApplicationFunction`'s result as plain data, which it must be: the
 * value generation carries. With `keys`, the value a read takes through the
 * result's plain records and arrays, as JavaScript reads it, so only that
 * value must be plain: its siblings (a function a record also holds) are
 * never read. Undefined where a key reaches no own data member or a step
 * holds no object.
 */
export function executeApplicationFunction(
    context: ExecutedFunctionContext,
    target: ExecutedTarget,
    args: readonly (ExecutedArgument | undefined)[],
    label: string,
    keys: readonly string[] = [],
): unknown {
    const run = runApplicationFunction(context, target, args, label);
    const isPlain = (held: unknown): boolean => run.isPlain(held);
    let read: unknown = run.value;
    for (const key of keys) {
        if (read === null || typeof read !== "object") return undefined;
        if (!isPlain(read))
            return context.fail(
                target,
                `${label} returned a value whose '${keys.join(".")}' is not ` +
                    "read through plain data, which generation cannot carry.",
            );
        read = Object.getOwnPropertyDescriptor(read, key)?.value;
        if (read === undefined) return undefined;
    }
    const value = plainCopy(read, isPlain);
    if (value === notPlain) {
        return context.fail(
            target,
            keys.length > 0
                ? `${label} returned a value whose '${keys.join(".")}' is ` +
                      "not plain data, which generation cannot carry."
                : `${label} returned a value that is not plain data, which ` +
                      "generation cannot carry.",
        );
    }
    return value;
}

const notPlain: unique symbol = Symbol("not plain data");

/**
 * A run's value as plain data of this realm, in its key order: null,
 * strings, booleans, finite numbers other than -0, arrays of them without
 * holes or undefined, and plain records of them, whose own members may
 * also hold undefined. Anything else is `notPlain`.
 */
function plainCopy(
    value: unknown,
    isPlain: (value: unknown) => boolean,
): unknown {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return value;
    if (typeof value === "number")
        return Number.isFinite(value) && !Object.is(value, -0)
            ? value
            : notPlain;
    if (typeof value !== "object" || !isPlain(value)) return notPlain;
    if (Array.isArray(value)) {
        const elements: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
            if (!(index in value)) return notPlain;
            const element: unknown = value[index];
            const copied =
                element === undefined ? notPlain : plainCopy(element, isPlain);
            if (copied === notPlain) return notPlain;
            elements.push(copied);
        }
        return elements;
    }
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        const member = Object.getOwnPropertyDescriptor(value, key);
        if (!member || !("value" in member)) return notPlain;
        const held: unknown = member.value;
        const copied =
            held === undefined ? undefined : plainCopy(held, isPlain);
        if (copied === notPlain) return notPlain;
        // An own `["__proto__"]` key is data; `=` would set the prototype.
        Object.defineProperty(record, key, {
            value: copied,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return record;
}

/**
 * An async function's result: the value its promise settles to by the
 * realm's microtask checkpoint, which holds no timer or I/O to wait on. One
 * still pending there never settles; a rejection is the run's throw.
 */
function settledResult(realm: vm.Context, result: unknown): unknown {
    if (!types.isPromise(result)) return result;
    const settlement: { settled?: boolean; value?: unknown } = {};
    const observe: unknown = vm.runInContext(
        "(promise, settlement) => promise.then((value) => { settlement.settled = true; settlement.value = value; }, (error) => { settlement.settled = false; settlement.value = error; })",
        realm,
    );
    if (typeof observe !== "function") {
        throw new Error(
            "A generation function realm cannot observe a promise.",
        );
    }
    Reflect.apply(observe, undefined, [result, settlement]);
    // The checkpoint after this evaluation drains the realm's microtasks.
    vm.runInContext("undefined", realm);
    if (settlement.settled === undefined) {
        throw new Error(
            "its promise is still pending after its microtasks ran",
        );
    }
    if (!settlement.settled) throw settlement.value;
    return settlement.value;
}

function errorMessage(error: unknown): string {
    return typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
        ? error.message
        : String(error);
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
    return (
        outer.getSourceFile() === inner.getSourceFile() &&
        inner.pos >= outer.pos &&
        inner.end <= outer.end
    );
}

/** The class whose instance a `this` reads, through arrow functions. */
function thisClass(node: ts.Node): ts.ClassDeclaration | undefined {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isArrowFunction(current)) continue;
        if (ts.isFunctionLike(current) || ts.isPropertyDeclaration(current))
            return ts.isClassDeclaration(current.parent)
                ? current.parent
                : undefined;
    }
    return undefined;
}

/** A module-scope class a closure carries: no base class, decorator or static member. */
function carriedClass(declaration: ts.ClassDeclaration): boolean {
    return (
        !declaration.heritageClauses?.some(
            (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
        ) &&
        !ts.getDecorators(declaration)?.length &&
        !declaration.members.some(
            (member) =>
                ts.isClassStaticBlockDeclaration(member) ||
                isStaticMember(member),
        )
    );
}

/** The top-level statement declaring `declaration`, when it is module scope. */
function moduleScopeStatement(
    declaration: ts.Declaration,
): ts.Statement | undefined {
    if (ts.isFunctionDeclaration(declaration)) {
        return ts.isSourceFile(declaration.parent) ? declaration : undefined;
    }
    let node: ts.Node = declaration;
    while (
        ts.isBindingElement(node) ||
        ts.isArrayBindingPattern(node) ||
        ts.isObjectBindingPattern(node)
    ) {
        node = node.parent;
    }
    if (
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        ts.isVariableStatement(node.parent.parent) &&
        ts.isSourceFile(node.parent.parent.parent)
    ) {
        return node.parent.parent;
    }
    if (
        (ts.isClassDeclaration(declaration) ||
            ts.isEnumDeclaration(declaration)) &&
        ts.isSourceFile(declaration.parent)
    ) {
        return declaration;
    }
    return undefined;
}

/** Whether `statement` declares `declaration` alone, as one name a file scope can bind. */
function soleBinding(
    statement: ts.Statement,
    declaration: ts.Declaration,
): boolean {
    return (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1 &&
        statement.declarationList.declarations[0] === declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name)
    );
}

/** The names a closure statement binds in its file's scope. */
function declaredNames(statement: ts.Statement): string[] {
    return statementDeclaredNames(statement).map((name) => name.text);
}

/** The analysis of one execution: what runs, and the text that runs it. */
class ExecutedClosure {
    private readonly symbols: CompilerSymbols;
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly parts = new Map<ts.SourceFile, FilePart>();
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly enclosing = new Map<
        string,
        { declaration: ts.Declaration; value: ExecutedArgument }
    >();
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly opaque = new Map<string, ts.Declaration>();
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly opaquePinned = new Set<string>();
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly heldPinned = new Set<string>();
    /**
     * @unjournaled Scratch of one execution's analysis, discarded with it:
     * the expressions writing module-scope state, each run after reporting
     * where it writes (`program`'s `written`), which refuses the run.
     */
    private readonly guardedWrites = new Set<ts.Node>();
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly queue: Array<{ root: ts.Node; file: ts.SourceFile }> = [];
    /**
     * @unjournaled Scratch of one execution's analysis, discarded with it:
     * the deployment constants it reads, which run as their literals.
     */
    private readonly deployed = new Map<ts.Node, string | boolean | null>();

    public constructor(
        private readonly context: ExecutedFunctionContext,
        private readonly target: ExecutedTarget,
        private readonly label: string,
    ) {
        this.symbols = new CompilerSymbols(context.checker);
    }

    public program(
        used: (name: string) => void,
        written: (where: string) => void,
    ): {
        javascript: string;
        bindings: {
            pinned: Record<string, unknown>;
            opaque: Record<string, unknown>;
            enclosing: Record<string, ExecutedArgument>;
            written: (where: string) => void;
        };
    } {
        const targetFile = this.target.getSourceFile();
        const targetStatement = this.targetStatement();
        this.part(targetFile);
        if (targetStatement) {
            this.include(targetStatement.statement);
        } else {
            this.queue.push({ root: this.target, file: targetFile });
        }
        for (let next = this.queue.shift(); next; next = this.queue.shift()) {
            this.walk(next.root, next.file);
        }
        const pinned: Record<string, unknown> = {};
        const enclosing: Record<string, ExecutedArgument> = {};
        for (const [name, { value }] of this.enclosing) enclosing[name] = value;
        const opaque: Record<string, unknown> = {};
        for (const name of this.opaque.keys()) opaque[name] = opaqueValue(name);
        for (const part of this.parts.values())
            for (const name of part.opaque)
                opaque[`${part.index}:${name}`] = opaqueValue(name);
        const files: string[] = [];
        for (const [file, part] of this.parts) {
            const prologue: string[] = [];
            for (const [local, source] of part.imports) {
                if (source.kind === "pinned") {
                    pinned[source.name] =
                        this.context.pinnedStandIn?.(source.name) ??
                        (this.opaquePinned.has(source.name)
                            ? opaqueValue(source.name)
                            : this.heldPinned.has(source.name)
                              ? unusedPinned(source.name, used)
                              : pinnedExport(source.name));
                    prologue.push(
                        `const ${local} = __bblBindings.pinned[${JSON.stringify(source.name)}];`,
                    );
                } else {
                    const sibling = this.parts.get(source.file)!;
                    prologue.push(
                        `const ${local} = __bblScope(${sibling.index})[${JSON.stringify(source.name)}];`,
                    );
                }
            }
            for (const name of part.opaque)
                prologue.push(
                    `const ${name} = __bblBindings.opaque[${JSON.stringify(`${part.index}:${name}`)}];`,
                );
            const statements = [...part.statements].sort(
                (left, right) => left.pos - right.pos,
            );
            const names = [
                ...part.opaque,
                ...statements.flatMap(declaredNames),
            ];
            const body = statements.map((statement) =>
                this.statementText(statement),
            );
            if (file === targetFile && !targetStatement) {
                const bound = [
                    ...[...this.enclosing.keys()].map(
                        (name) =>
                            [
                                name,
                                `__bblBindings.enclosing[${JSON.stringify(name)}]`,
                            ] as const,
                    ),
                    ...[...this.opaque.keys()].map(
                        (name) =>
                            [
                                name,
                                `__bblBindings.opaque[${JSON.stringify(name)}]`,
                            ] as const,
                    ),
                ];
                body.push(
                    `const __bblTarget = ((${bound.map(([name]) => name).join(", ")}) => (${this.targetExpression()}))(${bound
                        .map(([, value]) => value)
                        .join(", ")});`,
                );
                names.push("__bblTarget");
            }
            files[part.index] =
                `function __bblFile${part.index}() {\n${[...prologue, ...body].join("\n")}\nreturn { ${names.join(", ")} };\n}`;
        }
        const root = JSON.stringify(targetStatement?.name ?? "__bblTarget");
        const source = `(function (__bblBindings) {
"use strict";
const __bblFiles = [${files.map((_file, index) => `__bblFile${index}`).join(", ")}];
const __bblScopes = [];
function __bblScope(index) {
    if (__bblScopes[index] === null) throw new Error("A generation closure's modules import each other in a cycle.");
    if (__bblScopes[index] === undefined) {
        __bblScopes[index] = null;
        __bblScopes[index] = __bblFiles[index]();
    }
    return __bblScopes[index];
}
${files.join("\n")}
return __bblScope(${this.parts.get(targetFile)!.index})[${root}];
})`;
        return {
            javascript: transpileCommonJs(
                source,
                `${targetFile.fileName}.executed.ts`,
            ),
            bindings: { pinned, opaque, enclosing, written },
        };
    }

    /**
     * The module-scope statement declaring the target, with the name its
     * file scope binds: a function declaration, or a `const` declaring the
     * constant alone. Undefined for a function expression or method, which
     * the closure evaluates in place.
     */
    private targetStatement():
        { statement: ts.Statement; name: string } | undefined {
        const target = this.target;
        if (ts.isFunctionDeclaration(target)) {
            return ts.isSourceFile(target.parent) && target.name
                ? { statement: target, name: target.name.text }
                : undefined;
        }
        if (!ts.isVariableDeclaration(target)) return undefined;
        const statement = moduleScopeStatement(target);
        if (
            !statement ||
            !ts.isIdentifier(target.name) ||
            !ts.isVariableStatement(statement) ||
            variableKind(statement.declarationList) !== "const"
        ) {
            return this.context.fail(
                target,
                `${this.label} is not a module-scope 'const' binding one name.`,
            );
        }
        return { statement, name: target.name.text };
    }

    private part(file: ts.SourceFile): FilePart {
        let part = this.parts.get(file);
        if (!part) {
            part = {
                index: this.parts.size,
                statements: new Set(),
                imports: new Map(),
                opaque: new Set(),
            };
            this.parts.set(file, part);
        }
        return part;
    }

    private include(statement: ts.Statement): void {
        const part = this.part(statement.getSourceFile());
        if (part.statements.has(statement)) return;
        // An enum is an object of read-only members its statement creates
        // (a const enum's too, as the closure's transpile preserves it), and
        // a class with no static members is a constructor no module state
        // rides on, so the closure runs either statement as the module does.
        if (ts.isClassDeclaration(statement) && !carriedClass(statement)) {
            this.context.fail(
                statement,
                `${this.label} reaches a module-scope class with static members or a base class, which a generation closure does not carry.`,
            );
        }
        if (
            !this.context.model &&
            ts.isVariableStatement(statement) &&
            variableKind(statement.declarationList) !== "const" &&
            // A `let` only never-run functions assign keeps its initializer.
            !(
                this.context.sourceFiles &&
                statementDeclaredNames(statement).every((name) => {
                    const symbol = declaredSymbol(this.context.checker, name);
                    return (
                        symbol !== undefined &&
                        writtenOnlyInDeadFunctions(
                            this.context.checker,
                            this.context.sourceFiles!,
                            symbol,
                        )
                    );
                })
            )
        ) {
            this.context.fail(
                statement,
                `${this.label} reads a module-scope 'let' or 'var', which the scene may reassign after generation ran it.`,
            );
        }
        if (
            !this.context.model &&
            ts.isVariableStatement(statement) &&
            this.context.writtenThrough
        )
            for (const name of statementDeclaredNames(statement))
                if (
                    typeCanCarryReference(
                        this.context.checker.getTypeAtLocation(name),
                    ) &&
                    this.context.writtenThrough(name)
                )
                    this.context.fail(
                        name,
                        `${this.label} reads '${name.text}', which the program writes through.`,
                    );
        part.statements.add(statement);
        this.queue.push({ root: statement, file: statement.getSourceFile() });
    }

    /** Every binding `root` reaches, resolved into the closure or refused. */
    private walk(root: ts.Node, file: ts.SourceFile): void {
        const isTargetWalk = root === this.target;
        forEachAnalysisNode(
            root,
            (node) => {
                const deployed = ts.isExpression(node)
                    ? (this.context.standInText?.(node) ??
                      this.context.deploymentValue?.(node))
                    : undefined;
                if (deployed !== undefined) {
                    this.deployed.set(node, deployed);
                    return "skip";
                }
                // A carried class's own members read their instance.
                const owner =
                    node.kind === ts.SyntaxKind.ThisKeyword
                        ? thisClass(node)
                        : undefined;
                if (
                    (node.kind === ts.SyntaxKind.ThisKeyword ||
                        node.kind === ts.SyntaxKind.SuperKeyword) &&
                    !(
                        owner &&
                        carriedClass(owner) &&
                        !contains(this.target, node)
                    )
                ) {
                    this.context.fail(
                        node,
                        `${this.label} reads '${node.getText()}', which a function executed alone does not have.`,
                    );
                }
                if (
                    !this.context.model &&
                    writesThroughTrackedRoot(
                        node,
                        (expression) => {
                            const identifier = rootIdentifier(expression);
                            return (
                                identifier !== undefined &&
                                this.namesClosureBinding(identifier, root)
                            );
                        },
                        {
                            checker: this.context.checker,
                            typed: true,
                            ...(this.context.sourceFiles
                                ? { sourceFiles: this.context.sourceFiles }
                                : {}),
                        },
                    )
                )
                    // A write in a function the run only holds is never
                    // made: each runs behind a guard (`guardedWrites`).
                    this.guardedWrites.add(
                        ts.isForOfStatement(node) || ts.isForInStatement(node)
                            ? node.expression
                            : node,
                    );
                const varying = this.varyingRead(node);
                if (varying) {
                    this.context.fail(
                        node,
                        `${this.label} reads ${varying}, so a run at generation would not describe the run the program makes.`,
                    );
                }
                if (ts.isIdentifier(node) && isValueReference(node)) {
                    this.resolve(node, root, file, isTargetWalk);
                }
            },
            { types: "skip", skip: ts.isTypeAliasDeclaration },
        );
    }

    /**
     * The language global a node reads whose answer is not a function of
     * the program (the clock, `Math.random`, the host locale), or undefined.
     */
    private varyingRead(node: ts.Node): string | undefined {
        const checker = this.context.checker;
        if (ts.isIdentifier(node) && isValueReference(node)) {
            return libraryGlobal(checker, node) === "Date"
                ? "the clock ('Date')"
                : undefined;
        }
        const access = namedMember(checker, node);
        if (!access) return undefined;
        const member = access.name;
        if (
            mathMemberIsImpure(member) &&
            mathMemberAccess(
                node,
                (owner) => libraryGlobal(checker, owner),
                (read) => namedMember(checker, read),
            )
        ) {
            return "'Math.random'";
        }
        return member.startsWith("toLocale") || member === "localeCompare"
            ? `the host locale ('${member}')`
            : undefined;
    }

    /**
     * Whether an identifier names a binding outside `root` (module scope or
     * an enclosing function), or one the module-scope statement `root`
     * declares (`names.count++` in a method of the `names` record), that a
     * write could reach: a primitive has no state a method call could change.
     */
    private namesClosureBinding(
        identifier: ts.Identifier,
        root: ts.Node,
    ): boolean {
        const checker = this.context.checker;
        // The binding in scope where the write is: its declaration, an
        // import's own specifier included, is what lies outside `root`.
        const symbol = declaredSymbol(checker, identifier);
        const declaration = symbol?.declarations?.[0];
        return (
            declaration !== undefined &&
            (!contains(root, declaration) ||
                moduleScopeStatement(declaration) === root) &&
            declarationOrigin(declaration) === "program" &&
            typeCanCarryReference(checker.getTypeAtLocation(identifier))
        );
    }

    /** Whether a model run binds the name to an opaque value (`opaque`). */
    private opaqueBinding(identifier: ts.Identifier): boolean {
        return (
            this.context.model === true &&
            this.context.opaque?.(identifier) === true
        );
    }

    private resolve(
        identifier: ts.Identifier,
        root: ts.Node,
        file: ts.SourceFile,
        isTargetWalk: boolean,
    ): void {
        const checker = this.context.checker;
        const symbol = declaredSymbol(checker, identifier);
        if (!symbol) {
            if (identifier.text === "undefined") return;
            this.context.fail(
                identifier,
                `${this.label} reads '${identifier.text}', which resolves to no declaration.`,
            );
        }
        if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            this.resolveImport(identifier, symbol, file);
            return;
        }
        // A binding only ambient declarations name is absent in the realm, as
        // it is natively: bare `typeof` reads "undefined" and a read throws.
        if (isAbsentTypeofIdentifier(checker, identifier)) return;
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (!declaration && identifier.text === "undefined") return;
        if (!declaration) {
            this.context.fail(
                identifier,
                `${this.label} reads '${identifier.text}', which has no value declaration.`,
            );
        }
        const origin = declarationOrigin(declaration);
        if (origin === "default-lib") return;
        if (
            origin === "dom" &&
            (GENERATION_HOST_GLOBALS.has(identifier.text) ||
                GENERATION_REALM_NAMES.has(identifier.text)) &&
            (ts.isVariableDeclaration(declaration) ||
                ts.isFunctionDeclaration(declaration)) &&
            declaration.getSourceFile().isDeclarationFile
        )
            return;
        if (
            origin !== "program" ||
            declaration.getSourceFile().isDeclarationFile
        ) {
            this.context.fail(
                identifier,
                `${this.label} reads '${identifier.text}' from the ${origin === "babylon" ? "pinned engine" : "host"}, which generation does not run.`,
            );
        }
        if (contains(root, declaration)) return;
        const opaque = this.opaqueBinding(identifier);
        const statement = moduleScopeStatement(declaration);
        if (statement) {
            if (statement.getSourceFile() !== file) {
                this.context.fail(
                    identifier,
                    `${this.label} reads '${identifier.text}' from another module without importing it.`,
                );
            }
            if (opaque && soleBinding(statement, declaration))
                this.part(file).opaque.add(identifier.text);
            else this.include(statement);
            return;
        }
        if (isTargetWalk && opaque) {
            const known = this.opaque.get(identifier.text);
            if (known && known !== declaration)
                this.context.fail(
                    identifier,
                    `${this.label} closes over two bindings named '${identifier.text}'.`,
                );
            this.opaque.set(identifier.text, declaration);
            return;
        }
        if (!isTargetWalk) {
            this.context.fail(
                identifier,
                `${this.label} reaches '${identifier.text}', a binding no module scope carries.`,
            );
        }
        const known = this.enclosing.get(identifier.text);
        if (known) {
            if (known.declaration !== declaration) {
                this.context.fail(
                    identifier,
                    `${this.label} closes over two bindings named '${identifier.text}'.`,
                );
            }
            return;
        }
        const value = this.context.foldEnclosing(identifier);
        if (value === undefined) {
            this.context.fail(
                identifier,
                `${this.label} closes over '${identifier.text}', whose value generation does not know.`,
            );
        }
        this.enclosing.set(identifier.text, { declaration, value });
    }

    private resolveImport(
        identifier: ts.Identifier,
        symbol: ts.Symbol,
        file: ts.SourceFile,
    ): void {
        const part = this.part(file);
        if (part.imports.has(identifier.text)) return;
        const pinned = this.symbols.babylonImportName(identifier);
        if (pinned !== undefined) {
            const pinnedFunction =
                !pinnedTags.has(pinned) &&
                aliasTarget(this.context.checker, symbol).declarations?.some(
                    ts.isFunctionDeclaration,
                ) === true;
            if (this.context.model && pinnedFunction)
                this.opaquePinned.add(pinned);
            else if (
                pinnedFunction &&
                this.context.pinnedStandIn?.(pinned) === undefined
            )
                // A run may hold the pin's function (a record's callback)
                // without calling it; a use refuses the run (`unusedPinned`).
                this.heldPinned.add(pinned);
            else if (
                !pinnedTags.has(pinned) &&
                this.context.pinnedStandIn?.(pinned) === undefined
            ) {
                this.context.fail(
                    identifier,
                    `${this.label} reaches pinned '${pinned}', which generation does not run; only the ${[...pinnedTags].join(", ")} tag executes with it.`,
                );
            }
            part.imports.set(identifier.text, { kind: "pinned", name: pinned });
            return;
        }
        const imported = aliasTarget(this.context.checker, symbol);
        const declaration =
            imported.valueDeclaration ?? imported.declarations?.[0];
        const statement = declaration && moduleScopeStatement(declaration);
        if (!declaration || !statement) {
            this.context.fail(
                identifier,
                `${this.label} imports '${identifier.text}' in a form a generation closure does not carry (a module-scope const or named function).`,
            );
        }
        if (declarationOrigin(declaration) !== "program") {
            this.context.fail(
                identifier,
                `${this.label} imports '${identifier.text}' from outside the repository.`,
            );
        }
        const sibling = statement.getSourceFile();
        const name = statementDeclaredNames(statement).find(
            (candidate) =>
                declaredSymbol(this.context.checker, candidate) === imported,
        );
        if (name === undefined) {
            this.context.fail(
                identifier,
                `${this.label} imports '${identifier.text}' without a named module-scope binding.`,
            );
        }
        const siblingPart = this.part(sibling);
        if (
            this.opaqueBinding(identifier) &&
            soleBinding(statement, declaration)
        )
            siblingPart.opaque.add(name.text);
        else this.include(statement);
        part.imports.set(identifier.text, {
            kind: "sibling",
            file: sibling,
            name: name.text,
        });
    }

    /** A module-scope statement's own text, without its export modifiers. */
    private statementText(statement: ts.Statement): string {
        const file = statement.getSourceFile();
        const modifiers = ts.canHaveModifiers(statement)
            ? ts.getModifiers(statement)
            : undefined;
        if (hasDeclareModifier(statement)) {
            return this.context.fail(
                statement,
                `${this.label} reaches an ambient declaration, which a generation closure does not carry.`,
            );
        }
        const exported = modifiers
            ?.filter(
                (modifier) =>
                    modifier.kind === ts.SyntaxKind.ExportKeyword ||
                    modifier.kind === ts.SyntaxKind.DefaultKeyword,
            )
            .at(-1);
        return this.sourceText(
            file,
            exported ? exported.end : statement.getStart(file),
            statement.end,
        );
    }

    /**
     * A range of `file` as it runs: each deployment constant as its literal,
     * each guarded write (`guardedWrites`) reporting where it writes first.
     */
    private sourceText(
        file: ts.SourceFile,
        start: number,
        end: number,
    ): string {
        const within = (node: ts.Node): boolean =>
            node.getSourceFile() === file &&
            node.getStart(file) >= start &&
            node.end <= end;
        // Edits by position; at one position, a guard's closing comes first,
        // then the openings, outer first, then a literal's replacement.
        const edits: Array<{
            from: number;
            to: number;
            text: string;
            rank: number;
            order: number;
        }> = [];
        for (const [node, value] of this.deployed)
            if (within(node))
                edits.push({
                    from: node.getStart(file),
                    to: node.end,
                    text: `(${JSON.stringify(value)})`,
                    rank: 2,
                    order: 0,
                });
        for (const node of this.guardedWrites) {
            if (!within(node)) continue;
            const from = node.getStart(file);
            const { line, character } =
                file.getLineAndCharacterOfPosition(from);
            const where = `${file.fileName}:${line + 1}:${character + 1}`;
            edits.push(
                {
                    from,
                    to: from,
                    text: `(__bblBindings.written(${JSON.stringify(where)}), `,
                    rank: 1,
                    order: -node.end,
                },
                // An inner guard (the later start) closes first.
                {
                    from: node.end,
                    to: node.end,
                    text: ")",
                    rank: 0,
                    order: -from,
                },
            );
        }
        edits.sort(
            (left, right) =>
                left.from - right.from ||
                left.rank - right.rank ||
                left.order - right.order,
        );
        let text = "";
        let at = start;
        for (const edit of edits) {
            text += file.text.slice(at, edit.from) + edit.text;
            at = edit.to;
        }
        return text + file.text.slice(at, end);
    }

    /** The target as an expression of its own file's scope. */
    private targetExpression(): string {
        const target = this.target;
        const file = target.getSourceFile();
        const text = this.sourceText(file, target.getStart(file), target.end);
        if (
            ts.isArrowFunction(target) ||
            ts.isFunctionExpression(target) ||
            ts.isCallExpression(target)
        ) {
            return text;
        }
        if (ts.isFunctionDeclaration(target)) return `(${text})`;
        const key =
            ts.isMethodDeclaration(target) &&
            ts.isObjectLiteralExpression(target.parent)
                ? propertyKey(target.name)
                : undefined;
        if (key !== undefined) return `({ ${text} })[${JSON.stringify(key)}]`;
        return this.context.fail(
            target,
            `${this.label} is a ${syntaxKindName(target.kind)}, which generation does not execute alone.`,
        );
    }
}

/**
 * A pinned function a generation run holds without running: passing,
 * storing and comparing it run as in JavaScript; any other use (a call, a
 * member read) reports `name` to `used` and throws.
 */
function unusedPinned(name: string, used: (name: string) => void): unknown {
    const refuse = (): never => {
        used(name);
        throw new Error(
            `it uses pinned '${name}', which generation does not run`,
        );
    };
    return new Proxy(function pinned() {}, {
        get: refuse,
        set: refuse,
        has: refuse,
        deleteProperty: refuse,
        defineProperty: refuse,
        ownKeys: refuse,
        getOwnPropertyDescriptor: refuse,
        getPrototypeOf: refuse,
        setPrototypeOf: refuse,
        apply: refuse,
        construct: refuse,
    });
}

/**
 * A value a model run holds only the identity of: an engine or platform
 * binding, or what one of the pin's functions returns. Calling or
 * constructing one returns another; reading, writing, enumerating or
 * converting one throws, naming it.
 */
function opaqueValue(name: string): unknown {
    const refuse = (use: string): never => {
        throw new Error(
            `it ${use} '${name}', an engine value generation does not run`,
        );
    };
    return new Proxy(function opaque() {}, {
        get: (_target, key) => refuse(`reads '${String(key)}' of`),
        set: (_target, key) => refuse(`writes '${String(key)}' of`),
        has: () => refuse("tests a member of"),
        deleteProperty: () => refuse("deletes a member of"),
        defineProperty: () => refuse("defines a member of"),
        ownKeys: () => refuse("enumerates"),
        getOwnPropertyDescriptor: () => refuse("inspects"),
        getPrototypeOf: () => refuse("inspects"),
        setPrototypeOf: () => refuse("changes"),
        apply: () => opaqueValue(`${name}()`),
        construct: () => opaqueValue(`new ${name}`) as object,
    });
}

/**
 * Whether every value a name's type admits is an object the engine or the
 * host platform declares (a context, a mesh, a canvas): what a model run
 * holds opaque.
 */
export function holdsEngineValue(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): boolean {
    const type = checker.getNonNullableType(
        checker.getTypeAtLocation(identifier),
    );
    const members = unionMembers(type);
    return members.every((member) => {
        const declaration = (member.aliasSymbol ?? member.getSymbol())
            ?.declarations?.[0];
        const origin = declaration && declarationOrigin(declaration);
        return origin === "babylon" || origin === "dom" || origin === "webgpu";
    });
}

/** A pinned public export, loaded from the packaged module that declares it. */
function pinnedExport(name: string): unknown {
    const exported = sharedUpstreamStore().resolvePublicExport(name);
    return pinnedModuleBinding(exported.modulePath, exported.importedName);
}
