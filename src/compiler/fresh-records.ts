import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { forEachReturn } from "./loop-control.js";
import {
    declaredInDefaultLibrary,
    libraryGlobal,
    isNullishLiteral,
    calledFunction,
    namedMember,
    accessedPropertySymbol,
    resolvedSymbol,
} from "./symbols.js";
import {
    isOperandSelection,
    unwrapExpression,
    valueOperands,
    variableKind,
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
        if (ts.isCallExpression(current) && current.arguments.length === 1) {
            const member = namedMember(
                checker,
                unwrapExpression(current.expression),
            );
            if (
                !member ||
                libraryGlobal(checker, member.expression) !== "Object" ||
                !["freeze", "seal", "preventExtensions"].includes(member.name)
            )
                return undefined;
            frozen ||= member.name === "freeze";
            current = unwrapExpression(current.arguments[0]!);
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
    return (
        yieldsFreshObject(checker, unwrapped) ||
        callsFreshArrayBuiltin(checker, unwrapped)
    );
}
