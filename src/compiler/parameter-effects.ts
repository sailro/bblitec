import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { engineBodies, isEngineDeclaration } from "./engine-bodies.js";
import {
    callbackTakesReceiver,
    isStoringDataCall,
    lengthPreservingArrayMethods,
    readOnlyDataMethods,
    storingDataMethods,
} from "./receiver-methods.js";
import {
    declarationInDefaultLibrary,
    declaredSymbol,
    isNullishLiteral,
    libraryGlobal,
} from "./symbols.js";
import {
    assignmentTargets,
    isAssignmentExpression,
    isUpdateExpression,
    propertyNameText,
    unwrapExpression,
} from "./syntax.js";
import { TYPED_ARRAY_KINDS } from "./data-types/typed-arrays.js";
import { typeCanCarryReference } from "./type-facts.js";

/**
 * What a function does with the object one of its parameters holds, from
 * one walk of its body (`parameterEffects`): every write, method call,
 * hand-off, store, return, escape, identity and enumeration use of that
 * object or of an object reachable from it, through local aliases,
 * destructuring, containers built around it, loop variables and the
 * callbacks a library method hands its elements to. The per-parameter
 * questions -- does a call leave its argument unwritten, does it visibly
 * write it, does it keep an array's length, does it only read it -- are
 * predicates over that one summary, and every callee is resolved by one
 * policy (`callTarget`): a program body, the engine's pinned bodies, the
 * language library's table, or code the program does not hold.
 */

/** Property names from a parameter to an object; `*` is any key. */
export type EffectPath = readonly string[];

interface UseBase {
    readonly node: ts.Node;
    /**
     * The object the use reaches, from the parameter; for a write, the
     * slot written (the written object's path and the key).
     */
    readonly path: EffectPath;
    /**
     * The use may reach any object at or below `path`: a value a call
     * computed from the parameter's objects.
     */
    readonly derived: boolean;
    /** The use sits in a function nested in the analysed one. */
    readonly nested: boolean;
    /** That nested function runs only while the analysed one does. */
    readonly inPlace: boolean;
}

export type ParameterUse = UseBase &
    (
        | { readonly kind: "write" | "rebind" }
        | {
              readonly kind: "method";
              readonly call: ts.CallExpression;
              readonly method: string;
          }
        | {
              readonly kind: "argument";
              readonly call: ts.CallExpression | ts.NewExpression;
              readonly index: number;
              /** Handed as a spread: its elements are the arguments. */
              readonly spread: boolean;
              /**
               * Where the object sits inside the argument: empty when the
               * argument is the object, a key path inside a container
               * holding it otherwise.
               */
              readonly at: EffectPath;
          }
        | {
              readonly kind:
                  | "stored"
                  | "returned"
                  | "escaped"
                  | "identity"
                  | "enumerated"
                  | "called";
          }
    );

export interface ParameterEffects {
    /** False for a destructured or rest parameter, or a function without a body. */
    readonly analyzable: boolean;
    /** An async function or generator: its body runs on after the call returns. */
    readonly deferred: boolean;
    readonly uses: readonly ParameterUse[];
}

/** A function whose body an effect summary reads. */
export type EffectFunction =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration;

export function isEffectFunction(
    node: ts.Node | undefined,
): node is EffectFunction {
    return (
        node !== undefined &&
        (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isConstructorDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node))
    );
}

/**
 * What a value holds of the parameter's objects: the object at `from` sits
 * at `at` inside the value (`at` empty: the value is that object). A
 * `derived` value is computed from the object: it may be, or hold, any
 * object at or below `from`.
 */
interface Projection {
    readonly at: EffectPath;
    readonly from: EffectPath;
    readonly derived: boolean;
}

const MAXIMUM_PATH = 6;
const MAXIMUM_PROJECTIONS = 16;

function compatible(left: string, right: string): boolean {
    return left === right || left === "*" || right === "*";
}

function bounded(path: EffectPath): EffectPath {
    return path.length > MAXIMUM_PATH ? path.slice(0, MAXIMUM_PATH) : path;
}

/** The projections of the value read at `key` inside a value holding `values`. */
function project(
    values: readonly Projection[],
    key: string,
): readonly Projection[] {
    return values.flatMap((value) =>
        value.at.length > 0
            ? compatible(value.at[0]!, key)
                ? [{ ...value, at: value.at.slice(1) }]
                : []
            : [{ ...value, from: bounded([...value.from, key]) }],
    );
}

/** The projections of a container holding a value with `values` at `key`. */
function nest(
    values: readonly Projection[],
    key: string,
): readonly Projection[] {
    return values.map((value) => ({
        ...value,
        at: bounded([key, ...value.at]),
    }));
}

/** A value a call computed from one holding `values`. */
function derive(values: readonly Projection[]): readonly Projection[] {
    return values.map((value) => ({
        at: [],
        from: value.from,
        derived: true,
    }));
}

/** Whether a value of `type` can be or hold an object: not a primitive, nor an array of them. */
function canHoldObjects(checker: ts.TypeChecker, type: ts.Type): boolean {
    if (!typeCanCarryReference(type)) return false;
    if (!checker.isArrayLikeType(type) || type.isUnion()) return true;
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return element === undefined || typeCanCarryReference(element);
}

/** The outermost wrapper around an expression that keeps its value. */
function climb(node: ts.Expression): ts.Expression {
    let current = node;
    while (
        ts.isParenthesizedExpression(current.parent) ||
        ts.isNonNullExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent)
    )
        current = current.parent;
    return current;
}

function accessKey(
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string {
    if (ts.isPropertyAccessExpression(access))
        return ts.isPrivateIdentifier(access.name)
            ? `#${access.name.text}`
            : access.name.text;
    const key = unwrapExpression(access.argumentExpression);
    return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
        ? key.text
        : "*";
}

/** Library methods that call the function they are handed before returning. */
const SYNCHRONOUS_CALLBACK_METHODS: ReadonlySet<string> = new Set([
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flatMap",
    "forEach",
    "map",
    "reduce",
    "reduceRight",
    "replace",
    "replaceAll",
    "some",
    "sort",
    "toSorted",
]);

/**
 * Library methods whose result holds what their callback returns (`map`,
 * `flatMap`) or accumulates (`reduce`); a return there flows into the
 * call's result.
 */
const COLLECTING_CALLBACK_METHODS: ReadonlySet<string> = new Set([
    "flatMap",
    "map",
    "reduce",
    "reduceRight",
]);

/** Reading methods whose result is primitive or holds none of the receiver's objects. */
const SCALAR_RESULT_METHODS: ReadonlySet<string> = new Set([
    "every",
    "findIndex",
    "findLastIndex",
    "forEach",
    "has",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "some",
    ...COLLECTING_CALLBACK_METHODS,
]);

/** The parameter positions of an iterating method's callback: elements and receiver. */
function callbackPositions(method: string): {
    readonly elements: readonly number[];
    readonly receiver: number | undefined;
} {
    if (method === "reduce" || method === "reduceRight")
        return { elements: [0, 1], receiver: 3 };
    if (method === "sort" || method === "toSorted")
        return { elements: [0, 1], receiver: undefined };
    if (method === "replace" || method === "replaceAll")
        return { elements: [], receiver: undefined };
    return { elements: [0], receiver: 2 };
}

/** @unjournaled A pure function of the checked source, kept across replays. */
const summaries = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.Identifier, ParameterEffects>
>();

const OPAQUE: ParameterEffects = {
    analyzable: false,
    deferred: false,
    uses: [],
};

/**
 * The one effect summary of a parameter binding of `fn`, memoized: a
 * parameter's name, or a name its destructuring pattern binds.
 */
export function parameterEffects(
    checker: ts.TypeChecker,
    fn: EffectFunction,
    binding: ts.Identifier,
): ParameterEffects {
    let bindings = summaries.get(checker);
    if (!bindings) summaries.set(checker, (bindings = new WeakMap()));
    let effects = bindings.get(binding);
    if (!effects)
        bindings.set(binding, (effects = summarize(checker, fn, binding)));
    return effects;
}

/** Whether a binding is a rest parameter's name. */
function isRestBinding(binding: ts.Identifier): boolean {
    return (
        ts.isParameter(binding.parent) &&
        binding.parent.dotDotDotToken !== undefined
    );
}

/**
 * The binding a call's argument at `index` lands in: the parameter's name,
 * or a rest parameter's, which holds it as an element; none for a
 * destructured parameter.
 */
function argumentBinding(
    fn: EffectFunction,
    index: number,
): ts.Identifier | undefined {
    const rest = fn.parameters.findIndex(
        (parameter) => parameter.dotDotDotToken !== undefined,
    );
    const parameter = fn.parameters[rest >= 0 && index >= rest ? rest : index];
    return parameter && ts.isIdentifier(parameter.name)
        ? parameter.name
        : undefined;
}

function summarize(
    checker: ts.TypeChecker,
    fn: EffectFunction,
    binding: ts.Identifier,
): ParameterEffects {
    const symbol = fn.body ? declaredSymbol(checker, binding) : undefined;
    if (!symbol) return OPAQUE;
    const generator =
        (ts.isFunctionDeclaration(fn) ||
            ts.isFunctionExpression(fn) ||
            ts.isMethodDeclaration(fn)) &&
        fn.asteriskToken !== undefined;
    summarizing.add(fn);
    try {
        return {
            analyzable: true,
            deferred:
                generator ||
                (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) !==
                    0,
            // A rest parameter holds each argument as an element.
            uses: new EffectWalker(checker, fn).run(symbol, {
                at: isRestBinding(binding) ? ["*"] : [],
                from: [],
                derived: false,
            }),
        };
    } finally {
        summarizing.delete(fn);
    }
}

interface Scope {
    readonly nested: boolean;
    readonly inPlace: boolean;
}

/** One walk of a function's body for the uses of one parameter's objects. */
class EffectWalker {
    /** What each local binding may hold of the parameter's objects. */
    /** @unjournaled State of one analysis walk, discarded with the walker. */
    private readonly aliases = new Map<ts.Symbol, readonly Projection[]>();
    /** @unjournaled The binding names an alias declares, which are not references; one walk's state. */
    private readonly aliasNames = new Set<ts.Node>();
    /** @unjournaled State of one analysis walk, discarded with the walker. */
    private readonly inPlaceScopes = new Map<ts.Node, boolean>();
    private readonly writeTargets: ReadonlySet<ts.Node>;
    /** @unjournaled State of one analysis walk, discarded with the walker. */
    private changed = false;
    /** @unjournaled State of one analysis walk, discarded with the walker. */
    private uses: ParameterUse[] = [];

    public constructor(
        private readonly checker: ts.TypeChecker,
        private readonly fn: EffectFunction,
    ) {
        const targets = new Set<ts.Node>();
        const add = (target: ts.Expression): void => {
            targets.add(unwrapExpression(target));
        };
        for (const root of this.roots())
            forEachAnalysisNode(
                root,
                (node) => {
                    if (isAssignmentExpression(node))
                        assignmentTargets(node.left).forEach(add);
                    else if (isUpdateExpression(node)) add(node.operand);
                    else if (ts.isDeleteExpression(node)) add(node.expression);
                    else if (
                        (ts.isForOfStatement(node) ||
                            ts.isForInStatement(node)) &&
                        !ts.isVariableDeclarationList(node.initializer)
                    )
                        assignmentTargets(node.initializer).forEach(add);
                },
                { types: "skip" },
            );
        this.writeTargets = targets;
    }

    private roots(): readonly ts.Node[] {
        return [
            ...this.fn.parameters.flatMap((parameter) =>
                parameter.initializer ? [parameter.initializer] : [],
            ),
            ...(this.fn.body ? [this.fn.body] : []),
        ];
    }

    public run(
        parameter: ts.Symbol,
        holds: Projection,
    ): readonly ParameterUse[] {
        this.aliases.set(parameter, [holds]);
        // Each round can only add projections, bounded in length and number.
        for (let round = 0; round < 16; round++) {
            this.changed = false;
            this.uses = [];
            for (const root of this.roots())
                forEachAnalysisNode(
                    root,
                    (node) => {
                        if (!ts.isIdentifier(node) || this.aliasNames.has(node))
                            return;
                        const symbol = declaredSymbol(this.checker, node);
                        const values = symbol && this.aliases.get(symbol);
                        if (values) this.reference(node, values);
                    },
                    { types: "skip" },
                );
            if (!this.changed) break;
        }
        return this.uses;
    }

    private reference(
        identifier: ts.Identifier,
        values: readonly Projection[],
    ): void {
        const enclosing = ts.findAncestor(identifier.parent, ts.isFunctionLike);
        const nested = enclosing !== undefined && enclosing !== this.fn;
        this.consume(identifier, values, {
            nested,
            inPlace: !nested || this.inPlace(enclosing),
        });
    }

    private bindSymbol(
        name: ts.Identifier,
        values: readonly Projection[],
    ): void {
        this.aliasNames.add(name);
        const symbol = declaredSymbol(this.checker, name);
        if (!symbol || values.length === 0) return;
        const previous = this.aliases.get(symbol) ?? [];
        const keys = new Set(previous.map((value) => JSON.stringify(value)));
        const added = values.filter(
            (value) => !keys.has(JSON.stringify(value)),
        );
        if (added.length === 0) return;
        const widened =
            previous.length + added.length > MAXIMUM_PROJECTIONS
                ? [
                      ...previous,
                      ...derive([{ at: [], from: [], derived: true }]),
                  ]
                : [...previous, ...added];
        if (widened.length === previous.length) return;
        this.aliases.set(symbol, widened);
        this.changed = true;
    }

    private bindPattern(
        name: ts.BindingName,
        values: readonly Projection[],
        node: ts.Node,
        scope: Scope,
    ): void {
        if (ts.isIdentifier(name)) {
            this.bindSymbol(name, values);
            return;
        }
        name.elements.forEach((element, position) => {
            if (ts.isOmittedExpression(element)) return;
            if (element.dotDotDotToken) {
                // A rest is a new object or array of the remaining values.
                if (ts.isObjectBindingPattern(name))
                    this.emit("enumerated", node, values, scope);
                this.bindPattern(
                    element.name,
                    nest(project(values, "*"), "*"),
                    node,
                    scope,
                );
                return;
            }
            const key = ts.isArrayBindingPattern(name)
                ? String(position)
                : element.propertyName
                  ? (propertyNameText(element.propertyName) ?? "*")
                  : ts.isIdentifier(element.name)
                    ? element.name.text
                    : "*";
            this.bindPattern(element.name, project(values, key), node, scope);
        });
    }

    /** Whether code in `scope` runs only while the analysed function does. */
    private inPlace(scope: ts.Node): boolean {
        if (scope === this.fn) return true;
        const known = this.inPlaceScopes.get(scope);
        if (known !== undefined) return known;
        this.inPlaceScopes.set(scope, false);
        const enclosing = ts.findAncestor(scope.parent, ts.isFunctionLike);
        const runs =
            enclosing !== undefined &&
            this.inPlace(enclosing) &&
            (this.libraryCallbackCall(scope) !== undefined ||
                this.calledInPlace(scope, enclosing));
        this.inPlaceScopes.set(scope, runs);
        return runs;
    }

    /**
     * The synchronous library call an inline callback is handed to, which
     * calls it before returning.
     */
    private libraryCallbackCall(scope: ts.Node): ts.CallExpression | undefined {
        if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope))
            return undefined;
        const call = climb(scope).parent;
        if (!ts.isCallExpression(call) || call.expression === climb(scope))
            return undefined;
        const callee = unwrapExpression(call.expression);
        const declaration =
            this.checker.getResolvedSignature(call)?.declaration;
        return declaration !== undefined &&
            declarationInDefaultLibrary(declaration) &&
            ts.isPropertyAccessExpression(callee) &&
            (SYNCHRONOUS_CALLBACK_METHODS.has(callee.name.text) ||
                (callee.name.text === "from" &&
                    libraryGlobal(this.checker, callee.expression) === "Array"))
            ? call
            : undefined;
    }

    /**
     * A local function of `enclosing`, named by a declaration only ever
     * called directly from code of `enclosing` itself.
     */
    private calledInPlace(scope: ts.Node, enclosing: ts.Node): boolean {
        const name =
            ts.isFunctionDeclaration(scope) && scope.name
                ? scope.name
                : (ts.isArrowFunction(scope) ||
                        ts.isFunctionExpression(scope)) &&
                    ts.isVariableDeclaration(scope.parent) &&
                    scope.parent.initializer === scope &&
                    ts.isIdentifier(scope.parent.name) &&
                    (ts.getCombinedNodeFlags(scope.parent) &
                        ts.NodeFlags.Const) !==
                        0
                  ? scope.parent.name
                  : undefined;
        const symbol = name && declaredSymbol(this.checker, name);
        const body = isEffectFunction(enclosing) ? enclosing.body : undefined;
        if (!symbol || !body) return false;
        let called = true;
        forEachAnalysisNode(body, (node) => {
            if (!called) return "skip";
            if (
                ts.isIdentifier(node) &&
                node !== name &&
                declaredSymbol(this.checker, node) === symbol
            )
                called =
                    ts.isCallExpression(node.parent) &&
                    node.parent.expression === node &&
                    ts.findAncestor(node.parent, ts.isFunctionLike) ===
                        enclosing;
        });
        return called;
    }

    private emit(
        kind:
            | "stored"
            | "returned"
            | "escaped"
            | "identity"
            | "enumerated"
            | "called",
        node: ts.Node,
        values: readonly Projection[],
        scope: Scope,
    ): void {
        for (const value of values) {
            // A container holding the object is compared, enumerated or
            // called in its own right; what it holds can only leave with it.
            const own = value.at.length === 0;
            if (kind === "identity" && !own) continue;
            this.uses.push({
                kind:
                    own || kind === "stored" || kind === "returned"
                        ? kind
                        : "escaped",
                node,
                path: value.from,
                derived: value.derived,
                ...scope,
            });
        }
    }

    /**
     * The uses of a value holding `values`: its property reads, a write of
     * one of its slots, a method call on it, then whatever consumes it.
     */
    private consume(
        expression: ts.Expression,
        values: readonly Projection[],
        scope: Scope,
    ): void {
        let node = expression;
        let current = values;
        for (;;) {
            const outer = climb(node);
            const parent = outer.parent;
            if (!(
                (ts.isPropertyAccessExpression(parent) ||
                    ts.isElementAccessExpression(parent)) &&
                parent.expression === outer
            ))
                break;
            const key = accessKey(parent);
            if (this.writeTargets.has(parent)) {
                this.write(parent, current, key, scope);
                return;
            }
            const access = climb(parent);
            if (
                ts.isCallExpression(access.parent) &&
                access.parent.expression === access
            ) {
                this.method(access.parent, key, outer, current, scope);
                return;
            }
            current = project(current, key);
            if (current.length === 0) return;
            node = parent;
        }
        const top = climb(node);
        const parent = top.parent;
        if (this.writeTargets.has(unwrapExpression(top))) {
            // The binding itself is assigned.
            for (const value of current)
                if (value.at.length === 0)
                    this.uses.push({
                        kind: "rebind",
                        node: top,
                        path: value.from,
                        derived: value.derived,
                        ...scope,
                    });
            return;
        }
        if (ts.isCallExpression(parent) && parent.expression === top) {
            this.emit("called", parent, current, scope);
            this.result(parent, current, scope);
            return;
        }
        if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
            this.spread(parent, top, current, scope);
            return;
        }
        if (!typeCanCarryReference(this.checker.getTypeAtLocation(top))) return;
        this.flow(top, parent, current, scope);
    }

    private write(
        slot: ts.PropertyAccessExpression | ts.ElementAccessExpression,
        holder: readonly Projection[],
        key: string,
        scope: Scope,
    ): void {
        // A slot of the parameter's objects writes them; a slot of a
        // container holding one replaces that reference.
        for (const value of holder)
            if (value.at.length === 0)
                this.uses.push({
                    kind: "write",
                    node: slot,
                    path: bounded([...value.from, key]),
                    derived: value.derived,
                    ...scope,
                });
    }

    private method(
        call: ts.CallExpression,
        method: string,
        receiverNode: ts.Expression,
        receiver: readonly Projection[],
        scope: Scope,
    ): void {
        if (
            !typeCanCarryReference(this.checker.getTypeAtLocation(receiverNode))
        )
            return;
        for (const value of receiver)
            if (value.at.length === 0)
                this.uses.push({
                    kind: "method",
                    node: call,
                    call,
                    method,
                    path: value.from,
                    derived: value.derived,
                    ...scope,
                });
            else if (
                !readOnlyDataMethods.has(method) &&
                !storingDataMethods.has(method)
            )
                // A method of a container may hand on what it holds.
                this.uses.push({
                    kind: "escaped",
                    node: call,
                    path: value.from,
                    derived: value.derived,
                    ...scope,
                });
        // An iterating method hands its callback the elements and receiver.
        const elements = project(receiver, "*");
        const positions = callbackPositions(method);
        for (const argument of call.arguments) {
            const callback = unwrapExpression(argument);
            if (
                !ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback)
            )
                continue;
            for (const position of positions.elements) {
                const element = callback.parameters[position];
                if (element)
                    this.bindPattern(element.name, elements, call, scope);
            }
            const whole =
                positions.receiver === undefined
                    ? undefined
                    : callback.parameters[positions.receiver];
            if (whole) this.bindPattern(whole.name, receiver, call, scope);
        }
        if (!SCALAR_RESULT_METHODS.has(method))
            this.result(call, [...receiver, ...elements], scope);
    }

    /** A call's result may be or hold what its receiver or arguments reach. */
    private result(
        call: ts.CallExpression | ts.NewExpression,
        values: readonly Projection[],
        scope: Scope,
    ): void {
        if (
            values.length > 0 &&
            canHoldObjects(this.checker, this.checker.getTypeAtLocation(call))
        )
            this.consume(call, derive(values), scope);
    }

    /** `...value` in an argument list, an array literal or an object literal. */
    private spread(
        spread: ts.SpreadElement | ts.SpreadAssignment,
        top: ts.Expression,
        values: readonly Projection[],
        scope: Scope,
    ): void {
        const consumer = spread.parent;
        if (ts.isSpreadAssignment(spread)) {
            // An object spread reads every own property and copies its value.
            this.emit("enumerated", spread, values, scope);
            this.consume(consumer, nest(project(values, "*"), "*"), scope);
            return;
        }
        const element = this.checker.getIndexTypeOfType(
            this.checker.getTypeAtLocation(top),
            ts.IndexKind.Number,
        );
        const elements = project(values, "*");
        if (element && !typeCanCarryReference(element)) return;
        if (
            (ts.isCallExpression(consumer) || ts.isNewExpression(consumer)) &&
            consumer.arguments?.includes(spread)
        )
            this.argument(
                consumer,
                consumer.arguments.indexOf(spread),
                true,
                elements,
                scope,
            );
        else if (ts.isArrayLiteralExpression(consumer))
            this.consume(consumer, nest(elements, "*"), scope);
        else this.emit("escaped", spread, values, scope);
    }

    /** Where a value holding `values` goes once read. */
    private flow(
        top: ts.Expression,
        parent: ts.Node,
        values: readonly Projection[],
        scope: Scope,
    ): void {
        if (
            (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
            parent.arguments?.includes(top)
        ) {
            this.argument(
                parent,
                parent.arguments.indexOf(top),
                false,
                values,
                scope,
            );
            return;
        }
        if (ts.isVariableDeclaration(parent) && parent.initializer === top) {
            this.bindPattern(parent.name, values, parent, scope);
            return;
        }
        if (isAssignmentExpression(parent) && parent.right === top) {
            // The assignment's own value is the assigned one.
            this.assigned(parent.left, values, parent, scope);
            this.consume(parent, values, scope);
            return;
        }
        if (ts.isPropertyAssignment(parent) && parent.initializer === top) {
            this.consume(
                parent.parent,
                nest(values, propertyNameText(parent.name) ?? "*"),
                scope,
            );
            return;
        }
        if (ts.isShorthandPropertyAssignment(parent) && parent.name === top) {
            this.consume(parent.parent, nest(values, parent.name.text), scope);
            return;
        }
        if (ts.isArrayLiteralExpression(parent)) {
            const position = parent.elements.indexOf(top);
            const key = parent.elements
                .slice(0, position)
                .some(ts.isSpreadElement)
                ? "*"
                : String(position);
            this.consume(parent, nest(values, key), scope);
            return;
        }
        if (
            (ts.isConditionalExpression(parent) && parent.condition !== top) ||
            (ts.isBinaryExpression(parent) &&
                (parent.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken ||
                    parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                    parent.operatorToken.kind ===
                        ts.SyntaxKind.AmpersandAmpersandToken ||
                    (parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
                        parent.right === top)))
        ) {
            this.consume(parent, values, scope);
            return;
        }
        if (
            ts.isReturnStatement(parent) ||
            (ts.isArrowFunction(parent) && parent.body === top)
        ) {
            this.returned(parent, values, scope);
            return;
        }
        if (ts.isBinaryExpression(parent)) {
            const operator = parent.operatorToken.kind;
            if (
                operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                operator === ts.SyntaxKind.EqualsEqualsToken ||
                operator === ts.SyntaxKind.ExclamationEqualsToken
            ) {
                const other = parent.left === top ? parent.right : parent.left;
                if (!isNullishLiteral(this.checker, other))
                    this.emit("identity", parent, values, scope);
                return;
            }
            if (operator === ts.SyntaxKind.InKeyword) {
                if (parent.right === top)
                    this.emit("enumerated", parent, values, scope);
                return;
            }
            if (
                operator === ts.SyntaxKind.InstanceOfKeyword ||
                operator === ts.SyntaxKind.CommaToken ||
                operator === ts.SyntaxKind.PlusToken ||
                operator === ts.SyntaxKind.LessThanToken ||
                operator === ts.SyntaxKind.GreaterThanToken ||
                operator === ts.SyntaxKind.LessThanEqualsToken ||
                operator === ts.SyntaxKind.GreaterThanEqualsToken
            )
                return;
            this.emit("escaped", parent, values, scope);
            return;
        }
        if (ts.isSwitchStatement(parent) || ts.isCaseClause(parent)) {
            this.emit("identity", parent, values, scope);
            return;
        }
        if (ts.isForOfStatement(parent) && parent.expression === top) {
            const list = parent.initializer;
            if (ts.isVariableDeclarationList(list))
                for (const declaration of list.declarations)
                    this.bindPattern(
                        declaration.name,
                        project(values, "*"),
                        parent,
                        scope,
                    );
            else this.assigned(list, project(values, "*"), parent, scope);
            return;
        }
        if (ts.isForInStatement(parent) && parent.expression === top) {
            this.emit("enumerated", parent, values, scope);
            return;
        }
        if (
            ts.isTemplateSpan(parent) &&
            ts.isTaggedTemplateExpression(parent.parent.parent)
        ) {
            // A tag function is handed the substituted values.
            this.emit("escaped", parent, values, scope);
            return;
        }
        if (
            ts.isTypeOfExpression(parent) ||
            ts.isVoidExpression(parent) ||
            ts.isPrefixUnaryExpression(parent) ||
            ts.isExpressionStatement(parent) ||
            ts.isTemplateSpan(parent) ||
            ts.isIfStatement(parent) ||
            ts.isWhileStatement(parent) ||
            ts.isDoStatement(parent) ||
            ts.isForStatement(parent) ||
            (ts.isConditionalExpression(parent) && parent.condition === top) ||
            (ts.isElementAccessExpression(parent) &&
                parent.argumentExpression === top)
        )
            return;
        this.emit("escaped", parent, values, scope);
    }

    /**
     * A returned value: the analysed function's result, or what a nested
     * function hands back -- into a collecting library method's result, or
     * past this walk.
     */
    private returned(
        statement: ts.ReturnStatement | ts.ArrowFunction,
        values: readonly Projection[],
        scope: Scope,
    ): void {
        const owner = ts.isReturnStatement(statement)
            ? ts.findAncestor(statement, ts.isFunctionLike)
            : statement;
        if (owner === this.fn) {
            this.emit("returned", statement, values, scope);
            return;
        }
        const call = owner && this.libraryCallbackCall(owner);
        if (
            call &&
            owner &&
            (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))
        ) {
            const callee = unwrapExpression(call.expression);
            const method = ts.isPropertyAccessExpression(callee)
                ? callee.name.text
                : "";
            if (!COLLECTING_CALLBACK_METHODS.has(method)) return;
            // `reduce` hands its accumulator back to the callback.
            const accumulator =
                method === "reduce" || method === "reduceRight"
                    ? owner.parameters[0]
                    : undefined;
            if (accumulator)
                this.bindPattern(accumulator.name, values, call, scope);
            this.consume(
                call,
                method === "map" || method === "flatMap"
                    ? nest(values, "*")
                    : values,
                scope,
            );
            return;
        }
        this.emit("escaped", statement, values, scope);
    }

    /** A value holding `values` assigned to `target`. */
    private assigned(
        target: ts.Expression,
        values: readonly Projection[],
        node: ts.Node,
        scope: Scope,
    ): void {
        const unwrapped = unwrapExpression(target);
        if (ts.isIdentifier(unwrapped)) {
            const declaration = declaredSymbol(
                this.checker,
                unwrapped,
            )?.valueDeclaration;
            // A binding outside the function keeps the value past the call.
            if (
                declaration &&
                ts.findAncestor(declaration, (ancestor) => ancestor === this.fn)
            )
                this.bindSymbol(unwrapped, values);
            else this.emit("stored", node, values, scope);
            return;
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            unwrapped.elements.forEach((element, position) =>
                this.assigned(
                    ts.isSpreadElement(element) ? element.expression : element,
                    project(
                        values,
                        ts.isSpreadElement(element) ? "*" : String(position),
                    ),
                    node,
                    scope,
                ),
            );
            return;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            for (const property of unwrapped.properties)
                if (ts.isShorthandPropertyAssignment(property))
                    this.assigned(
                        property.name,
                        project(values, property.name.text),
                        node,
                        scope,
                    );
                else if (ts.isPropertyAssignment(property))
                    this.assigned(
                        property.initializer,
                        project(values, propertyNameText(property.name) ?? "*"),
                        node,
                        scope,
                    );
                else if (ts.isSpreadAssignment(property))
                    this.assigned(property.expression, values, node, scope);
            return;
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            this.assigned(unwrapped.left, values, node, scope);
            return;
        }
        this.emit("stored", node, values, scope);
    }

    private argument(
        call: ts.CallExpression | ts.NewExpression,
        index: number,
        spread: boolean,
        values: readonly Projection[],
        scope: Scope,
    ): void {
        for (const value of values)
            this.uses.push({
                kind: "argument",
                node: call,
                call,
                index,
                spread,
                at: value.at,
                path: value.from,
                derived: value.derived,
                ...scope,
            });
        if (spread || mayReturnArgument(this.checker, call, index))
            this.result(call, values, scope);
    }
}

/** Functions whose summary is being computed, which a cycle cannot read. */
const summarizing = new Set<EffectFunction>();

/**
 * Whether a call's result may be, or hold, the object it is handed at
 * `index`: a callee that returns it or lets it escape (a closure over it),
 * a library function other than a reading one, or code the program does
 * not hold.
 */
function mayReturnArgument(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    index: number,
): boolean {
    const target = callTarget(checker, call);
    if (target.kind === "library")
        return libraryMayHold(checker, call, index, target.name);
    if (target.kind === "unknown") return true;
    return target.bodies.some((body) => {
        const binding = argumentBinding(body, index);
        if (!binding || summarizing.has(body)) return true;
        const effects = parameterEffects(target.checker, body, binding);
        return (
            !effects.analyzable ||
            effects.uses.some(
                (use) =>
                    use.kind === "returned" ||
                    use.kind === "escaped" ||
                    use.kind === "stored",
            )
        );
    });
}

/** Typed-array and view constructors: a view of a buffer, a copy of anything else. */
const BINARY_VIEWS: ReadonlySet<string> = new Set([
    ...TYPED_ARRAY_KINDS.keys(),
    "DataView",
]);

/**
 * Library methods whose result holds an argument: a new array or
 * collection holding it, or the receiver it was stored into.
 */
const ARGUMENT_HOLDING_METHODS: ReadonlySet<string> = new Set([
    "add",
    "concat",
    "fill",
    "set",
    "toSpliced",
    "with",
]);

/** Library statics and globals whose result is computed, holding no argument. */
const COMPUTING_LIBRARY_CALLS: ReadonlySet<string> = new Set([
    "Array.isArray",
    "Boolean",
    "Number",
    "String",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "JSON.parse",
    "JSON.stringify",
    "Object.getOwnPropertyNames",
    "Object.hasOwn",
    "Object.is",
    "Object.keys",
    "structuredClone",
]);

/**
 * Whether a default-library call's result may be or hold the object it is
 * handed at `index`: a binary view over a buffer, a method storing its
 * argument into a result or receiver it returns, or a static or global
 * other than those computing a new value (`Math`, `JSON`, ...).
 */
function libraryMayHold(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    index: number,
    name: string | undefined,
): boolean {
    if (name === undefined) return true;
    if (BINARY_VIEWS.has(name) || BINARY_VIEWS.has(name.split(".")[0]!)) {
        // A view over a buffer shares it; one over values copies them.
        const argument = call.arguments?.[index];
        const type =
            argument &&
            checker.getNonNullableType(checker.getTypeAtLocation(argument));
        return (
            type === undefined ||
            (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
            (type.isUnion() ? type.types : [type]).some((member) =>
                ["ArrayBuffer", "SharedArrayBuffer"].includes(
                    member.getSymbol()?.name ?? "",
                ),
            )
        );
    }
    const callee = unwrapExpression(call.expression);
    // A method of a library object: only the storing ones hand it back.
    if (
        ts.isPropertyAccessExpression(callee) &&
        libraryGlobal(checker, callee.expression) === undefined
    )
        return ARGUMENT_HOLDING_METHODS.has(callee.name.text);
    return !(COMPUTING_LIBRARY_CALLS.has(name) || name.startsWith("Math."));
}

/**
 * The code a call or construction runs, by the one policy every
 * per-parameter question shares: the bodies of a program function, method
 * or constructor; the engine's pinned bodies behind its typing; the
 * language library's table for a declaration of the default library; and
 * code the program does not hold -- an ambient declaration, a function
 * value, an interface member -- otherwise.
 */
export type CallTarget =
    | {
          readonly kind: "bodies";
          readonly checker: ts.TypeChecker;
          readonly bodies: readonly EffectFunction[];
          readonly engine: boolean;
      }
    | { readonly kind: "library"; readonly name: string | undefined }
    | { readonly kind: "unknown" };

export function callTarget(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
): CallTarget {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration) return { kind: "unknown" };
    if (isEngineDeclaration(declaration)) {
        const engine = engineBodies();
        const bodies = engine.bodies(declaration);
        const first = bodies?.[0];
        return first && bodies.every(isEffectFunction)
            ? {
                  kind: "bodies",
                  checker: engine.checkerFor(first),
                  bodies,
                  engine: true,
              }
            : { kind: "unknown" };
    }
    if (declaration.getSourceFile().isDeclarationFile)
        return declarationInDefaultLibrary(declaration)
            ? { kind: "library", name: libraryCallName(checker, call) }
            : { kind: "unknown" };
    return isEffectFunction(declaration) && declaration.body
        ? { kind: "bodies", checker, bodies: [declaration], engine: false }
        : { kind: "unknown" };
}

/** `Object.assign`, `Math.max`, a global's name, or a method's bare name. */
function libraryCallName(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
): string | undefined {
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee)) return callee.text;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const owner = libraryGlobal(checker, callee.expression);
    return owner ? `${owner}.${callee.name.text}` : callee.name.text;
}

/** Default-library calls that write their first argument. */
const WRITING_LIBRARY_CALLS: ReadonlySet<string> = new Set([
    "Object.assign",
    "Object.defineProperty",
    "Object.defineProperties",
    "Object.setPrototypeOf",
    "Reflect.set",
    "Reflect.defineProperty",
    "Reflect.deleteProperty",
    "Reflect.setPrototypeOf",
]);

/** Default-library functions that only read what they are handed. */
const READING_LIBRARY_CALLS: ReadonlySet<string> = new Set([
    "Array.isArray",
    "Boolean",
    "Number",
    "String",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
]);

/** Whether a default-library call leaves its argument at `index` unwritten. */
export function libraryArgumentIsReadOnly(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
): boolean {
    const target = callTarget(checker, call);
    return (
        target.kind === "library" &&
        (index > 0 ||
            target.name === undefined ||
            !WRITING_LIBRARY_CALLS.has(target.name))
    );
}

/**
 * One predicate's answers per checker and parameter binding. A query that
 * reaches itself through recursion assumes `assumed` for the inner one (the
 * greatest answer a cycle holds); an answer that leaned on that assumption
 * is kept only once the query it assumed about has its own.
 */
class PredicateMemo<T> {
    /** @unjournaled Pure functions of the checked source, kept across replays. */
    private readonly answers = new WeakMap<
        ts.TypeChecker,
        WeakMap<ts.Identifier, T>
    >();
    /** @unjournaled The queries in progress, outermost first. */
    private readonly active: ts.Identifier[] = [];
    /**
     * @unjournaled Per query in progress, the lowest position of a query in
     * progress whose assumed answer it read.
     */
    private readonly assumptions: number[] = [];

    public constructor(private readonly assumed: T) {}

    public answer(
        checker: ts.TypeChecker,
        binding: ts.Identifier,
        compute: () => T,
    ): T {
        let bindings = this.answers.get(checker);
        if (!bindings) this.answers.set(checker, (bindings = new WeakMap()));
        if (bindings.has(binding)) return bindings.get(binding)!;
        const position = this.active.indexOf(binding);
        if (position >= 0) {
            for (let above = position + 1; above < this.active.length; above++)
                this.assumptions[above] = Math.min(
                    this.assumptions[above]!,
                    position,
                );
            return this.assumed;
        }
        this.active.push(binding);
        this.assumptions.push(Infinity);
        let result: T;
        let assumption: number;
        try {
            result = compute();
        } finally {
            this.active.pop();
            assumption = this.assumptions.pop()!;
        }
        const parent = this.active.length - 1;
        if (assumption < this.active.length) {
            if (assumption < parent)
                this.assumptions[parent] = Math.min(
                    this.assumptions[parent]!,
                    assumption,
                );
            return result;
        }
        bindings.set(binding, result);
        return result;
    }
}

/** Each body's answer for the binding a call's argument at `index` lands in. */
function everyArgumentBody(
    target: Extract<CallTarget, { kind: "bodies" }>,
    index: number,
    answer: (
        checker: ts.TypeChecker,
        body: EffectFunction,
        binding: ts.Identifier,
    ) => boolean,
): boolean {
    return target.bodies.every((body) => {
        const binding = argumentBinding(body, index);
        return binding !== undefined && answer(target.checker, body, binding);
    });
}

const writesNothingMemo = new PredicateMemo(true);

/**
 * Whether a call leaves a parameter binding's objects unwritten, so a
 * native reference parameter can be `const`: no write, deletion, rebinding
 * or mutating method reaches them, and every callee they are handed to is a
 * program function writing nothing through them (a C++ reference handed to
 * an engine or host function stays mutable), a construction, `Object.keys`
 * or a storing library method keeping them.
 */
export function parameterIsReadOnly(
    checker: ts.TypeChecker,
    fn: EffectFunction,
    binding: ts.Identifier,
): boolean {
    return writesNothingMemo.answer(checker, binding, () => {
        const effects = parameterEffects(checker, fn, binding);
        return (
            effects.analyzable &&
            effects.uses.every((use) => {
                switch (use.kind) {
                    case "write":
                    case "rebind":
                        return false;
                    case "method":
                        return readOnlyDataMethods.has(use.method);
                    case "argument":
                        return argumentWritesNothing(checker, use);
                    default:
                        return true;
                }
            })
        );
    });
}

function argumentWritesNothing(
    checker: ts.TypeChecker,
    use: Extract<ParameterUse, { kind: "argument" }>,
): boolean {
    const target = callTarget(checker, use.call);
    if (target.kind === "bodies" && !target.engine)
        return (
            !use.spread &&
            everyArgumentBody(target, use.index, parameterIsReadOnly)
        );
    if (ts.isNewExpression(use.call)) return true;
    return (
        target.kind === "library" &&
        ((use.index === 0 && target.name === "Object.keys") ||
            (isStoringDataCall(use.call, checker) &&
                !WRITING_LIBRARY_CALLS.has(target.name ?? "")))
    );
}

const visiblyWrittenMemo = new PredicateMemo(false);

/**
 * Whether a call writes through a parameter binding where the program can
 * see it: a write, deletion, rebinding or mutating method, a store of the
 * object into another one, or a hand-off to a callee doing the same (a
 * program function, the engine's pinned body, a writing or storing library
 * call). Code the program does not hold proves nothing.
 */
export function parameterIsMutated(
    checker: ts.TypeChecker,
    fn: EffectFunction,
    binding: ts.Identifier,
): boolean {
    return visiblyWrittenMemo.answer(checker, binding, () =>
        parameterEffects(checker, fn, binding).uses.some((use) => {
            switch (use.kind) {
                case "write":
                case "rebind":
                    return true;
                case "method":
                    return !readOnlyDataMethods.has(use.method);
                // What a callee does with a value an earlier call computed
                // from the parameter is that earlier callee's question.
                case "stored":
                    return !use.derived;
                case "argument":
                    return !use.derived && argumentVisiblyWritten(checker, use);
                default:
                    return false;
            }
        }),
    );
}

/**
 * Engine functions that retain an object and write it after the call
 * returns, by their typing's name and the argument they retain.
 */
const RETAINING_ENGINE_WRITERS: ReadonlyMap<string, number> = new Map([
    ["createPropertyAnimationGroup", 1],
]);

function argumentVisiblyWritten(
    checker: ts.TypeChecker,
    use: Extract<ParameterUse, { kind: "argument" }>,
): boolean {
    if (isStoringDataCall(use.call, checker)) return true;
    const declaration = checker.getResolvedSignature(use.call)?.declaration;
    if (
        declaration &&
        isEngineDeclaration(declaration) &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.name !== undefined &&
        RETAINING_ENGINE_WRITERS.get(declaration.name.text) === use.index
    )
        return true;
    const target = callTarget(checker, use.call);
    if (target.kind === "library")
        return (
            use.index === 0 &&
            target.name !== undefined &&
            WRITING_LIBRARY_CALLS.has(target.name)
        );
    return (
        target.kind === "bodies" &&
        !use.spread &&
        !everyArgumentBody(
            target,
            use.index,
            (bodyChecker, body, binding) =>
                !(use.at.length > 0
                    ? heldObjectWritten(
                          bodyChecker,
                          body,
                          binding,
                          use.at,
                          !target.engine,
                      )
                    : target.engine
                      ? engineBodyWrites(bodyChecker, body, binding)
                      : parameterIsMutated(bodyChecker, body, binding)),
        )
    );
}

/** Whether `path` begins with `prefix`, `*` matching any key. */
function startsWith(path: EffectPath, prefix: EffectPath): boolean {
    return (
        path.length >= prefix.length &&
        prefix.every(
            (key, index) =>
                key === path[index] || key === "*" || path[index] === "*",
        )
    );
}

/** @unjournaled Pure functions of the checked source, kept across replays. */
const heldAnswers = new WeakMap<ts.Identifier, Map<string, boolean>>();
/** @unjournaled The held-object queries in progress, by binding. */
const heldActive = new WeakMap<ts.Identifier, Set<string>>();
let heldDepth = 0;
/** A query in progress read the assumed answer of one that encloses it. */
let heldAssumed = false;

/**
 * Whether a callee handed, as its parameter `binding`, a container holding
 * an object at `at` visibly writes that object or one below it: a write,
 * mutating method or (`stores`) store reaching it, or a hand-off of it or
 * of a container holding it to a callee doing the same. What the callee
 * does with the container's other slots is no write of the object.
 */
function heldObjectWritten(
    checker: ts.TypeChecker,
    fn: EffectFunction,
    binding: ts.Identifier,
    at: EffectPath,
    stores: boolean,
): boolean {
    const key = `${stores}:${JSON.stringify(at)}`;
    let known = heldAnswers.get(binding);
    if (!known) heldAnswers.set(binding, (known = new Map<string, boolean>()));
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    let active = heldActive.get(binding);
    if (!active) heldActive.set(binding, (active = new Set<string>()));
    // A cycle holds no write it does not show elsewhere.
    if (active.has(key)) {
        heldAssumed = true;
        return false;
    }
    active.add(key);
    heldDepth++;
    let written: boolean;
    try {
        written = parameterEffects(checker, fn, binding).uses.some((use) => {
            const object =
                use.kind === "write" ? use.path.slice(0, -1) : use.path;
            const below = use.derived
                ? startsWith(at, object) || startsWith(object, at)
                : startsWith(object, at);
            const above = !below && startsWith(at, object);
            if (!below && !above) return false;
            switch (use.kind) {
                case "write":
                    return below;
                case "method":
                    return below
                        ? !readOnlyDataMethods.has(use.method)
                        : !readOnlyDataMethods.has(use.method) &&
                              !storingDataMethods.has(use.method);
                // Kept past the call -- the object, or a container holding
                // it the callee keeps or hands back -- it may be written later.
                case "stored":
                    return stores && !use.derived;
                case "returned":
                case "escaped":
                    return above && stores && !use.derived;
                case "argument": {
                    if (use.derived) return false;
                    if (isStoringDataCall(use.call, checker)) return stores;
                    const target = callTarget(checker, use.call);
                    if (target.kind === "library")
                        return (
                            use.index === 0 &&
                            target.name !== undefined &&
                            WRITING_LIBRARY_CALLS.has(target.name)
                        );
                    // The object itself, or a container holding it, handed on.
                    const held = below
                        ? use.at
                        : [...use.at, ...at.slice(object.length)];
                    return (
                        target.kind === "bodies" &&
                        !use.spread &&
                        !everyArgumentBody(
                            target,
                            use.index,
                            (bodyChecker, body, inner) =>
                                !heldObjectWritten(
                                    bodyChecker,
                                    body,
                                    inner,
                                    held,
                                    stores && !target.engine,
                                ),
                        )
                    );
                }
                default:
                    return false;
            }
        });
    } finally {
        heldDepth--;
        active.delete(key);
    }
    // An answer that read an assumption is final only for the outermost query.
    if (!heldAssumed || heldDepth === 0) known.set(key, written);
    if (heldDepth === 0) heldAssumed = false;
    return written;
}

/**
 * An engine body writes its argument when both answers allow it: one
 * follows every store the parameter reaches, the other proves a parameter
 * it only reads unchanged.
 */
function engineBodyWrites(
    checker: ts.TypeChecker,
    body: EffectFunction,
    binding: ts.Identifier,
): boolean {
    return (
        parameterIsMutated(checker, body, binding) &&
        !parameterIsReadOnly(checker, body, binding)
    );
}

/** Whether an engine call writes through the object it is handed at `index`. */
export function engineCallMutatesArgument(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
): boolean {
    const target = callTarget(checker, call);
    return (
        target.kind === "bodies" &&
        target.engine &&
        !everyArgumentBody(
            target,
            index,
            (bodyChecker, body, binding) =>
                !engineBodyWrites(bodyChecker, body, binding),
        )
    );
}

const fixedLengthMemo = new PredicateMemo<number | null>(0);

/** A non-negative integer key. */
function laneIndex(key: string | undefined): number | undefined {
    const value = Number(key);
    return key !== undefined &&
        key !== "" &&
        String(value) === key &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
}

/**
 * How many leading elements a call writes through an array parameter whose
 * length and identity it keeps to itself, or undefined when that is not
 * proven: inside the function's own body the array is read, written at
 * constant indices, searched, iterated, spread, compared, or handed to a
 * function keeping it the same way; it is never resized, rebound, stored,
 * returned or captured. A numeric tuple of at least that many elements can
 * then be passed as the parameter's array.
 */
export function fixedLengthParameterWrites(
    checker: ts.TypeChecker,
    fn: EffectFunction,
    binding: ts.Identifier,
): number | undefined {
    const written = fixedLengthMemo.answer(checker, binding, () => {
        const effects = parameterEffects(checker, fn, binding);
        if (!effects.analyzable || isRestBinding(binding)) return null;
        let lanes = 0;
        for (const use of effects.uses) {
            // A value computed from the array is another array, or an
            // element.
            if (use.derived && use.kind !== "write") continue;
            if (use.nested) return null;
            const own = use.path.length === 0;
            switch (use.kind) {
                case "write": {
                    const lane =
                        use.path.length === 1 && !use.derived
                            ? laneIndex(use.path[0])
                            : undefined;
                    if (lane === undefined) return null;
                    lanes = Math.max(lanes, lane + 1);
                    break;
                }
                case "method":
                    if (!own) break;
                    if (readOnlyDataMethods.has(use.method)) {
                        if (
                            callbackTakesReceiver(
                                checker,
                                use.method,
                                use.call.arguments[0],
                            )
                        )
                            return null;
                    } else if (
                        !lengthPreservingArrayMethods.has(use.method) ||
                        !ts.isExpressionStatement(climb(use.call).parent)
                    )
                        return null;
                    break;
                case "argument": {
                    if (!own || use.spread) break;
                    if (use.at.length > 0) return null;
                    const nested = argumentFixedLengthWrites(checker, use);
                    if (nested === undefined) return null;
                    lanes = Math.max(lanes, nested);
                    break;
                }
                case "identity":
                    break;
                default:
                    if (own) return null;
            }
        }
        return lanes;
    });
    return written ?? undefined;
}

function argumentFixedLengthWrites(
    checker: ts.TypeChecker,
    use: Extract<ParameterUse, { kind: "argument" }>,
): number | undefined {
    const target = callTarget(checker, use.call);
    if (target.kind === "library") {
        const callee = unwrapExpression(use.call.expression);
        return ts.isPropertyAccessExpression(callee) &&
            storingDataMethods.has(callee.name.text)
            ? undefined
            : 0;
    }
    if (target.kind !== "bodies" || target.engine) return undefined;
    let lanes = 0;
    for (const body of target.bodies) {
        const binding = argumentBinding(body, use.index);
        const nested =
            binding &&
            fixedLengthParameterWrites(target.checker, body, binding);
        if (nested === undefined) return undefined;
        lanes = Math.max(lanes, nested);
    }
    return lanes;
}

/** Array methods that read their receiver's elements and return none of them. */
const READING_ARRAY_METHODS: ReadonlySet<string> = new Set([
    "every",
    "findIndex",
    "findLastIndex",
    "forEach",
    "map",
    "some",
]);

const onlyReadMemo = new PredicateMemo(true);

/**
 * Whether a call only reads the object a parameter binding holds, so a
 * copy lent for the call cannot be told apart while nothing else writes the
 * original. The call's whole run is its own (not an async function or a
 * generator), and in it the object -- for an array, the array and each
 * element, an object of its own -- is never written, resized, rebound,
 * compared, enumerated, called, stored, returned or captured past the
 * call, and is handed only to callees reading it the same way (program and
 * engine bodies, the library's reading functions). A copy shares the
 * objects its fields hold, so what happens to those cannot tell it apart.
 */
function onlyRead(
    checker: ts.TypeChecker,
    fn: EffectFunction,
    binding: ts.Identifier,
): boolean {
    return onlyReadMemo.answer(checker, binding, () => {
        const effects = parameterEffects(checker, fn, binding);
        if (!effects.analyzable || effects.deferred || isRestBinding(binding))
            return false;
        const array = checker.isArrayLikeType(
            checker.getNonNullableType(checker.getTypeAtLocation(binding)),
        );
        // Whether the object at `path` is one a copy duplicates; a derived
        // use reaches the objects below it too, which a copy shares.
        const copied = (path: EffectPath): boolean =>
            path.length === 0 ||
            (array &&
                path.length === 1 &&
                (path[0] === "*" || laneIndex(path[0]) !== undefined));
        return effects.uses.every((use) => {
            const object =
                use.kind === "write" ? use.path.slice(0, -1) : use.path;
            if (!copied(object)) return true;
            if (use.nested && !use.inPlace) return false;
            switch (use.kind) {
                case "method":
                    return (
                        !use.derived &&
                        array &&
                        object.length === 0 &&
                        READING_ARRAY_METHODS.has(use.method)
                    );
                case "argument":
                    return (
                        !use.spread &&
                        use.at.length === 0 &&
                        !use.derived &&
                        argumentUseOnlyRead(checker, use)
                    );
                default:
                    return false;
            }
        });
    });
}

function argumentUseOnlyRead(
    checker: ts.TypeChecker,
    use: Extract<ParameterUse, { kind: "argument" }>,
): boolean {
    if (ts.isNewExpression(use.call)) return false;
    const target = callTarget(checker, use.call);
    if (target.kind === "library")
        return (
            target.name !== undefined && READING_LIBRARY_CALLS.has(target.name)
        );
    return (
        target.kind === "bodies" &&
        everyArgumentBody(target, use.index, onlyRead)
    );
}

/**
 * Whether one call provably leaves the argument at `index` unchanged: an
 * argument holding no object, `Object.keys`' argument, or a program
 * function's parameter it writes nothing through.
 */
export function callArgumentIsReadOnly(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
): boolean {
    const argument = call.arguments[index];
    // `Math.hypot(a[0] - b[0], ...)` mentions the composite and hands the
    // callee a number: there is nothing to write through.
    if (
        argument !== undefined &&
        !typeCanCarryReference(checker.getTypeAtLocation(argument))
    )
        return true;
    const target = callTarget(checker, call);
    if (target.kind === "library")
        return index === 0 && target.name === "Object.keys";
    return (
        target.kind === "bodies" &&
        !target.engine &&
        everyArgumentBody(target, index, parameterIsReadOnly)
    );
}

/**
 * Whether the callee a value is handed to as argument `index` of `call`
 * only reads it (`onlyRead`): a copy handed there lives for the call, and
 * cannot grow or outlive it through the callee.
 */
export function callOnlyReadsArgument(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    index: number,
): boolean {
    const target = callTarget(checker, call);
    return (
        target.kind === "bodies" && everyArgumentBody(target, index, onlyRead)
    );
}

/**
 * Whether an engine function may write or keep the object a call hands it
 * at `index`: its pinned bodies do more than read it (`onlyRead`), or the
 * typing names none.
 */
export function engineArgumentWritten(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    index: number,
): boolean {
    const target = callTarget(checker, call);
    return !(
        target.kind === "bodies" && everyArgumentBody(target, index, onlyRead)
    );
}
