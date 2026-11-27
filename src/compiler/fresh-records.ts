import ts from "typescript";
import { forEachAnalysisNode, identifiersByName } from "./analysis-walk.js";
import { forEachReturn } from "./loop-control.js";
import { lengthPreservingArrayMethods } from "./receiver-methods.js";
import {
    declaredInDefaultLibrary,
    declaredSymbol,
    libraryGlobal,
    isNullishLiteral,
    calledFunction,
    namedMember,
    accessedPropertySymbol,
    resolvedSymbol,
    valueSymbolOf,
} from "./symbols.js";
import {
    isOperandSelection,
    isUnexportedConstDeclaration,
    objectProperty,
    unwrapExpression,
    valueOperands,
    variableKind,
    writeSiteOf,
    type ConstDeclaration,
} from "./syntax.js";

/**
 * The object or array literal whose object `node` names through `const`
 * aliases (`const x = { ... }`, also wrapped in `Object.freeze`, `seal` or
 * `preventExtensions`, which return their argument), and whether it is
 * frozen. A `const` names only objects its literal creates: a write through
 * it reaches no object another literal creates.
 */
export function constObjectLiteral(
    checker: ts.TypeChecker,
    node: ts.Node,
):
    | {
          readonly literal:
              ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
          readonly frozen: boolean;
      }
    | undefined {
    const seen = new Set<ts.Declaration>();
    let frozen = false;
    for (
        let current = ts.isExpression(node) ? unwrapExpression(node) : node;
        ;
    ) {
        if (
            ts.isObjectLiteralExpression(current) ||
            ts.isArrayLiteralExpression(current)
        )
            return { literal: current, frozen };
        if (ts.isCallExpression(current)) {
            const returned = returnedArgument(checker, current);
            if (!returned) return undefined;
            frozen ||= returned.frozen;
            current = unwrapExpression(returned.argument);
            continue;
        }
        if (!ts.isIdentifier(current)) return undefined;
        const declaration = resolvedSymbol(checker, current)?.valueDeclaration;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer ||
            seen.has(declaration) ||
            variableKind(declaration) !== "const"
        )
            return undefined;
        seen.add(declaration);
        current = unwrapExpression(declaration.initializer);
    }
}

/**
 * The argument `Object.freeze`, `seal` or `preventExtensions` returns,
 * which is that object itself, and whether the call freezes it.
 */
export function returnedArgument(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): { readonly argument: ts.Expression; readonly frozen: boolean } | undefined {
    const member = namedMember(checker, unwrapExpression(call.expression));
    return call.arguments.length === 1 &&
        member &&
        libraryGlobal(checker, member.expression) === "Object" &&
        ["freeze", "seal", "preventExtensions"].includes(member.name)
        ? { argument: call.arguments[0]!, frozen: member.name === "freeze" }
        : undefined;
}

/**
 * Whether evaluating an expression yields an object no other reference can
 * hold: an object or array literal or a construction, a selection among such
 * objects and nullish literals, or a call whose callee returns only such
 * objects. Storing that object in another representation (a record as
 * another record type, a tuple as a growable array) copies or adopts an
 * object nothing else can write, read or compare, so the change is
 * unobservable. Anything else may name an object the program still reaches.
 */
export function yieldsFreshObject(
    checker: ts.TypeChecker,
    node: ts.Node,
): boolean {
    return fresh(checker, node, new Set());
}

/**
 * The object literal `literal` stores at `key` (through `const` aliases):
 * its last writer's value (`objectProperty`), where no later spread or
 * computed member may replace it.
 */
export function literalFieldObject(
    checker: ts.TypeChecker,
    literal: ts.ObjectLiteralExpression,
    key: string,
): ts.ObjectLiteralExpression | undefined {
    const stored = objectProperty(literal, key);
    const created = stored && constObjectLiteral(checker, stored);
    return created && ts.isObjectLiteralExpression(created.literal)
        ? created.literal
        : undefined;
}

/** The unexported `const` local `read` names (`isUnexportedConstDeclaration`). */
function constLocal(
    checker: ts.TypeChecker,
    read: ts.Expression,
): ConstDeclaration | undefined {
    const unwrapped = unwrapExpression(read);
    const declaration = ts.isIdentifier(unwrapped)
        ? declaredSymbol(checker, unwrapped)?.valueDeclaration
        : undefined;
    return isUnexportedConstDeclaration(declaration) ? declaration : undefined;
}

/** The unexported `const` local `read` names, initialized with a fresh object (`fresh`). */
export function freshConstLocal(
    checker: ts.TypeChecker,
    read: ts.Expression,
    fresh: (initializer: ts.Expression) => boolean,
): ts.VariableDeclaration | undefined {
    const declaration = constLocal(checker, read);
    return declaration && fresh(declaration.initializer)
        ? declaration
        : undefined;
}

/** @unjournaled Pure functions of the checked program: `readOnlyFreshConst` by declaration. */
const readOnlyConsts = new WeakMap<
    ts.TypeChecker,
    WeakMap<ts.VariableDeclaration, boolean>
>();

/**
 * Whether `name` reads a `freshConstLocal` whose initializer yields a fresh
 * object ({@link yieldsFreshObject}) that only reads of its properties
 * reference: no other reference holds that object, so no write in the
 * program reaches its fields.
 */
export function readOnlyFreshConst(
    checker: ts.TypeChecker,
    name: ts.Node,
): boolean {
    const declaration = ts.isIdentifier(name)
        ? constLocal(checker, name)
        : undefined;
    if (!declaration) return false;
    let known = readOnlyConsts.get(checker);
    if (!known) readOnlyConsts.set(checker, (known = new WeakMap()));
    let answer = known.get(declaration);
    if (answer === undefined) {
        answer =
            yieldsFreshObject(checker, declaration.initializer) &&
            onlyPropertyReads(checker, declaration);
        known.set(declaration, answer);
    }
    return answer;
}

/** Whether every reference to a declaration's binding reads one of its properties. */
function onlyPropertyReads(
    checker: ts.TypeChecker,
    declaration: ConstDeclaration,
): boolean {
    return otherReferences(checker, declaration).every((reference) => {
        const read = reference.parent;
        return (
            ts.isPropertyAccessExpression(read) &&
            read.expression === reference &&
            writeSiteOf(read) === undefined &&
            !(
                ts.isCallExpression(read.parent) &&
                read.parent.expression === read
            )
        );
    });
}

/** The references to a `const` local's binding but its declaration's name. */
function otherReferences(
    checker: ts.TypeChecker,
    declaration: ConstDeclaration,
): ts.Identifier[] {
    const symbol = declaredSymbol(checker, declaration.name);
    return (
        identifiersByName(declaration.getSourceFile()).get(
            declaration.name.text,
        ) ?? []
    ).filter(
        (reference) =>
            reference !== declaration.name &&
            valueSymbolOf(checker, reference) === symbol,
    );
}

/**
 * Whether `read` names an unexported `const` local holding a new array
 * ({@link yieldsNewArray}) that only `read` hands on: every other reference
 * reads it in place in the activation declaring it -- its elements, a
 * property, a method called on it whose result is not the array kept
 * elsewhere -- so nothing else holds the array, and no other code can
 * change it.
 */
export function arrayHeldOnlyByItsLocal(
    checker: ts.TypeChecker,
    read: ts.Expression,
): boolean {
    const lent = unwrapExpression(read);
    const declaration = constLocal(checker, lent);
    if (!declaration || !yieldsNewArray(checker, declaration.initializer))
        return false;
    const owner = ts.findAncestor(declaration.parent, ts.isFunctionLike);
    return otherReferences(checker, declaration).every((reference) => {
        if (reference === lent) return true;
        if (ts.findAncestor(reference.parent, ts.isFunctionLike) !== owner)
            return false;
        const use = reference.parent;
        if (
            ts.isElementAccessExpression(use) &&
            use.expression === reference &&
            writeSiteOf(use) === undefined
        )
            return true;
        if (
            !ts.isPropertyAccessExpression(use) ||
            use.expression !== reference ||
            writeSiteOf(use) !== undefined
        )
            return false;
        const call = use.parent;
        if (
            !ts.isCallExpression(call) ||
            call.expression !== use ||
            !lengthPreservingArrayMethods.has(use.name.text)
        )
            return true;
        // A method returning the array: its result is dropped, or read in
        // place again.
        const result = call.parent;
        return (
            ts.isExpressionStatement(result) ||
            (ts.isPropertyAccessExpression(result) &&
                result.expression === call &&
                !(
                    ts.isCallExpression(result.parent) &&
                    result.parent.expression === result &&
                    lengthPreservingArrayMethods.has(result.name.text)
                ))
        );
    });
}

/**
 * Whether every element of an array expression is a fresh record: an array
 * literal of them, or an array `map` whose callback returns only them.
 */
export function yieldsFreshRecordElements(
    checker: ts.TypeChecker,
    node: ts.Node,
): boolean {
    if (!ts.isExpression(node)) return false;
    const expression = unwrapExpression(node);
    if (ts.isArrayLiteralExpression(expression))
        return expression.elements.every(
            (element) =>
                !ts.isSpreadElement(element) &&
                fresh(checker, element, new Set()),
        );
    if (
        ts.isCallExpression(expression) &&
        namedMember(checker, expression.expression)?.name === "map"
    ) {
        const callback = expression.arguments[0];
        return (
            callback !== undefined &&
            (ts.isArrowFunction(callback) ||
                ts.isFunctionExpression(callback)) &&
            returnsOnlyFresh(checker, callback, new Set())
        );
    }
    return false;
}

/**
 * Whether `callback` returns only arrays of fresh records
 * (`yieldsFreshRecordElements`), or a selection among them: what an array
 * `flatMap` over it collects are fresh records.
 */
export function returnsFreshRecordArrays(
    checker: ts.TypeChecker,
    callback: ts.FunctionLikeDeclaration,
): boolean {
    return returnsOnly(callback, new Set(), (returned) => {
        const expression = unwrapExpression(returned);
        return (
            isOperandSelection(expression)
                ? valueOperands(expression)
                : [expression]
        ).every((operand) => yieldsFreshRecordElements(checker, operand));
    });
}

/**
 * The one expression every element of an array expression evaluates: the
 * single returned expression of an array `map` callback, evaluated once per
 * element. Undefined for any other array.
 */
export function mappedElement(
    checker: ts.TypeChecker,
    node: ts.Expression,
): ts.Expression | undefined {
    const call = unwrapExpression(node);
    if (!ts.isCallExpression(call)) return undefined;
    const map = namedMember(checker, call.expression);
    if (
        map?.name !== "map" ||
        !checker.isArrayLikeType(checker.getTypeAtLocation(map.expression))
    )
        return undefined;
    const callback = call.arguments[0] && unwrapExpression(call.arguments[0]);
    if (
        !callback ||
        !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    )
        return undefined;
    if (!ts.isBlock(callback.body)) return callback.body;
    const returned: ts.Expression[] = [];
    let bare = false;
    forEachAnalysisNode(
        callback.body,
        (node) => {
            if (!ts.isReturnStatement(node)) return;
            if (node.expression) returned.push(node.expression);
            else bare = true;
        },
        { functions: "skip", types: "skip" },
    );
    return returned.length === 1 && !bare ? returned[0] : undefined;
}

function fresh(
    checker: ts.TypeChecker,
    node: ts.Node,
    active: Set<ts.Node>,
): boolean {
    if (!ts.isExpression(node)) return false;
    const expression = unwrapExpression(node);
    if (
        ts.isObjectLiteralExpression(expression) ||
        ts.isArrayLiteralExpression(expression) ||
        ts.isNewExpression(expression)
    )
        return true;
    if (isNullishLiteral(checker, expression)) return true;
    if (isOperandSelection(expression))
        return valueOperands(expression).every((operand) =>
            fresh(checker, operand, active),
        );
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
        return returnsOnlyFresh(checker, expression, active);
    if (ts.isCallExpression(expression)) {
        // `Object.fromEntries` builds a new object of the entries.
        const callee = namedMember(
            checker,
            unwrapExpression(expression.expression),
        );
        if (
            callee?.name === "fromEntries" &&
            libraryGlobal(checker, callee.expression) === "Object"
        )
            return true;
        const declaration = calledFunction(checker, expression);
        return (
            declaration !== undefined &&
            returnsOnlyFresh(checker, declaration, active)
        );
    }
    return false;
}

/**
 * Whether `declaration` completes only with values `produces` accepts: its
 * expression body, or at least one `return`, each accepted. A declaration
 * already being followed (`active`), or followed eight deep, proves nothing.
 */
export function returnsOnly(
    declaration: ts.FunctionLikeDeclaration,
    active: Set<ts.Node>,
    produces: (expression: ts.Expression) => boolean,
): boolean {
    const body = declaration.body;
    if (!body || active.has(declaration) || active.size > 8) return false;
    active.add(declaration);
    try {
        if (!ts.isBlock(body)) return produces(body);
        let returns = 0;
        let only = true;
        forEachReturn([body], (node) => {
            returns++;
            if (only && (!node.expression || !produces(node.expression)))
                only = false;
        });
        return only && returns > 0;
    } finally {
        active.delete(declaration);
    }
}

/** Every value the function can return is a fresh object or nullish. */
function returnsOnlyFresh(
    checker: ts.TypeChecker,
    declaration: ts.FunctionLikeDeclaration,
    active: Set<ts.Node>,
): boolean {
    return returnsOnly(declaration, active, (expression) =>
        fresh(checker, expression, active),
    );
}

/** Array methods whose result is a new array, never their receiver. */
const FRESH_ARRAY_METHODS: ReadonlySet<string> = new Set([
    "concat",
    "filter",
    "flat",
    "flatMap",
    "map",
    "slice",
    "toReversed",
    "toSorted",
    "toSpliced",
    "with",
]);

/** The `Array` and `Object` statics that return a new array. */
const FRESH_ARRAY_STATICS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["Array", new Set(["from", "of"])],
    ["Object", new Set(["keys", "values", "entries"])],
]);

/**
 * Whether `expression` calls a built-in that returns a new array it
 * created: an Array method above, `Array.from`/`Array.of`, or
 * `Object.keys`/`values`/`entries`. A method a user type declares under
 * the same name can return an array it keeps, so only the library's own
 * declaration counts.
 */
export function callsFreshArrayBuiltin(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const call = unwrapExpression(expression);
    if (!ts.isCallExpression(call)) return false;
    const callee = namedMember(checker, unwrapExpression(call.expression));
    if (!callee) return false;
    const name = callee.name;
    const statics = FRESH_ARRAY_STATICS.get(
        libraryGlobal(checker, callee.expression) ?? "",
    );
    if (statics) return statics.has(name);
    const symbol = accessedPropertySymbol(checker, callee.access);
    return (
        FRESH_ARRAY_METHODS.has(name) &&
        declaredInDefaultLibrary(symbol) &&
        (symbol?.declarations ?? []).some(
            (declaration) =>
                ts.isInterfaceDeclaration(declaration.parent) &&
                (declaration.parent.name.text === "Array" ||
                    declaration.parent.name.text === "ReadonlyArray"),
        )
    );
}

/** Whether every value `declaration` returns is an array {@link yieldsNewArray} proves new. */
export function returnsOnlyNewArrays(
    checker: ts.TypeChecker,
    declaration: ts.FunctionLikeDeclaration,
): boolean {
    return returnsOnly(declaration, new Set(), (expression) =>
        yieldsNewArray(checker, expression),
    );
}

/**
 * Whether an array expression evaluates to an array no other reference
 * holds: a fresh object, or one {@link callsFreshArrayBuiltin} builds (whose
 * elements may still be shared).
 */
export function yieldsNewArray(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const unwrapped = unwrapExpression(expression);
    // A selection (`c ? a.map(f) : []`) yields one of its operands.
    if (isOperandSelection(unwrapped))
        return valueOperands(unwrapped).every((operand) =>
            yieldsNewArray(checker, operand),
        );
    // `Object.freeze(array)` returns the array it is given.
    const returned =
        ts.isCallExpression(unwrapped) && returnedArgument(checker, unwrapped);
    if (returned) return yieldsNewArray(checker, returned.argument);
    return (
        yieldsFreshObject(checker, unwrapped) ||
        callsFreshArrayBuiltin(checker, unwrapped)
    );
}
