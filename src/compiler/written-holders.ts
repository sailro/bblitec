import ts from "typescript";
import {
    bindingReferences,
    exportedUnderAnotherName,
} from "./binding-references.js";
import { bindingRebinds } from "./binding-rebinds.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
import { literalKey, unwrapExpression, variableKind } from "./syntax.js";
import { determinedTypeArguments } from "./type-arguments.js";
import { unionMembers } from "./type-facts.js";

/** A static type a written object has, and the property a keyed write names. */
export interface WrittenHolder {
    readonly type: ts.Type;
    readonly property?: string;
}

/** Holder types that can hold every record (`holdsRecord`). */
export const OPEN_HOLDER_FLAGS =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.TypeParameter |
    ts.TypeFlags.Index |
    ts.TypeFlags.IndexedAccess |
    ts.TypeFlags.Conditional |
    ts.TypeFlags.Substitution |
    ts.TypeFlags.NonPrimitive;

function openHolder(type: ts.Type): boolean {
    return unionMembers(type).some(
        (member) =>
            (member.flags & OPEN_HOLDER_FLAGS) !== 0 ||
            (member.isIntersection() &&
                member.types.some(
                    (part) => (part.flags & OPEN_HOLDER_FLAGS) !== 0,
                )),
    );
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const callsOf = new WeakMap<
    ts.Program,
    WeakMap<ts.Node, readonly ts.CallExpression[] | null>
>();

/**
 * The calls of a function the program only calls directly: a function
 * declaration, or an anonymous function expression a `const` holds, whose
 * every reference is a call's callee. Undefined where a reference lets the
 * function go (stored, passed, called through `call`), or it leaves its
 * module under another name.
 */
function directCalls(
    program: ts.Program,
    checker: ts.TypeChecker,
    fn: ts.SignatureDeclaration,
): readonly ts.CallExpression[] | undefined {
    let byFunction = callsOf.get(program);
    if (!byFunction) callsOf.set(program, (byFunction = new WeakMap()));
    const known = byFunction.get(fn);
    if (known !== undefined) return known ?? undefined;
    const held =
        (ts.isArrowFunction(fn) ||
            (ts.isFunctionExpression(fn) && fn.name === undefined)) &&
        ts.isVariableDeclaration(fn.parent) &&
        fn.parent.initializer === fn &&
        ts.isVariableDeclarationList(fn.parent.parent) &&
        variableKind(fn.parent.parent) === "const"
            ? fn.parent.name
            : undefined;
    const name = ts.isFunctionDeclaration(fn) && fn.body ? fn.name : held;
    const symbol =
        name && ts.isIdentifier(name)
            ? declaredSymbol(checker, name)
            : undefined;
    let calls: ts.CallExpression[] | undefined;
    if (symbol && !exportedUnderAnotherName(program, checker, symbol)) {
        calls = [];
        for (const reference of bindingReferences(program, checker, symbol)) {
            const call = reference.parent;
            if (!ts.isCallExpression(call) || call.expression !== reference) {
                calls = undefined;
                break;
            }
            calls.push(call);
        }
    }
    byFunction.set(fn, calls ?? null);
    return calls;
}

/**
 * What a parameter of a function the program only calls directly holds:
 * the arguments its calls pass in its position, and its default. Undefined
 * for a rest or destructured parameter, one the function rebinds, or calls
 * spreading arguments up to its position.
 */
function passedArguments(
    program: ts.Program,
    checker: ts.TypeChecker,
    parameter: ts.ParameterDeclaration,
): readonly ts.Expression[] | undefined {
    const fn = parameter.parent;
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken)
        return undefined;
    const symbol = declaredSymbol(checker, parameter.name);
    if (
        !symbol ||
        bindingRebinds(checker, program.getSourceFiles(), symbol).length > 0
    )
        return undefined;
    const calls = directCalls(program, checker, fn);
    if (!calls) return undefined;
    // A `this` parameter takes no argument position.
    const positional = fn.parameters.filter(
        (candidate) =>
            !ts.isIdentifier(candidate.name) || candidate.name.text !== "this",
    );
    const index = positional.indexOf(parameter);
    if (index < 0) return undefined;
    const passed = parameter.initializer ? [parameter.initializer] : [];
    for (const call of calls) {
        if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement))
            return undefined;
        const argument = call.arguments[index];
        if (argument) passed.push(argument);
    }
    return passed;
}

/** The parameter an expression reads, through wrappers that keep its object. */
function readParameter(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): ts.ParameterDeclaration | undefined {
    const root = unwrapExpression(expression);
    const declaration = ts.isIdentifier(root)
        ? resolvedSymbol(checker, root)?.valueDeclaration
        : undefined;
    return declaration && ts.isParameter(declaration) ? declaration : undefined;
}

/**
 * A type's members, each type parameter of a function the program only
 * calls directly read as the type arguments its calls instantiate it with.
 * `active` holds the declarations being read: one reached again adds
 * nothing its other sources do not.
 */
function instantiatedTypes(
    program: ts.Program,
    checker: ts.TypeChecker,
    type: ts.Type,
    active: Set<ts.Node>,
): readonly ts.Type[] {
    return unionMembers(type).flatMap((member) => {
        if ((member.flags & ts.TypeFlags.TypeParameter) === 0) return [member];
        const declaration = member.symbol?.declarations?.find(
            ts.isTypeParameterDeclaration,
        );
        const fn = declaration?.parent;
        if (
            !declaration ||
            !fn ||
            !(
                ts.isFunctionDeclaration(fn) ||
                ts.isArrowFunction(fn) ||
                ts.isFunctionExpression(fn)
            )
        )
            return [member];
        if (active.has(declaration)) return [];
        const calls = directCalls(program, checker, fn);
        const instantiations = calls?.map((call) =>
            determinedTypeArguments(checker, call, fn).get(member.symbol),
        );
        if (
            !instantiations ||
            instantiations.some((argument) => argument === undefined)
        )
            return [member];
        active.add(declaration);
        try {
            return instantiations.flatMap((argument) =>
                instantiatedTypes(program, checker, argument!, active),
            );
        } finally {
            active.delete(declaration);
        }
    });
}

/**
 * The static types of the objects an expression evaluates to: a parameter
 * of a function the program only calls directly holds what its calls pass,
 * and a type parameter of such a function is what its calls instantiate.
 */
function heldTypes(
    program: ts.Program,
    checker: ts.TypeChecker,
    object: ts.Expression,
    active: Set<ts.Node>,
): readonly ts.Type[] {
    const type = checker.getTypeAtLocation(object);
    if (!openHolder(type)) return [type];
    const parameter = readParameter(checker, object);
    const passed = parameter && passedArguments(program, checker, parameter);
    if (parameter && passed) {
        if (active.has(parameter)) return [];
        active.add(parameter);
        try {
            return passed.flatMap((argument) =>
                heldTypes(program, checker, argument, active),
            );
        } finally {
            active.delete(parameter);
        }
    }
    return instantiatedTypes(program, checker, type, active);
}

/**
 * The property names a key can be, read through parameters and type
 * parameters as {@link heldTypes} reads objects; undefined where one of
 * them is not a literal.
 */
function keyNames(
    program: ts.Program,
    checker: ts.TypeChecker,
    key: ts.Expression,
    active: Set<ts.Node>,
): readonly string[] | undefined {
    const literal = literalKey(key);
    if (literal !== undefined) return [literal];
    const parameter = readParameter(checker, key);
    const passed = parameter && passedArguments(program, checker, parameter);
    if (parameter && passed) {
        if (active.has(parameter)) return [];
        active.add(parameter);
        try {
            const names: string[] = [];
            for (const argument of passed) {
                const named = keyNames(program, checker, argument, active);
                if (!named) return undefined;
                names.push(...named);
            }
            return names;
        } finally {
            active.delete(parameter);
        }
    }
    const names: string[] = [];
    for (const member of instantiatedTypes(
        program,
        checker,
        checker.getTypeAtLocation(key),
        active,
    )) {
        if (!member.isStringLiteral() && !member.isNumberLiteral())
            return undefined;
        names.push(String(member.value));
    }
    return names;
}

/**
 * Where a write through `object` lands, when the parameters and type
 * parameters it is read through narrow its open static type (or a `key`
 * the write does not name): the static types of the objects it can write,
 * each with every property the key can name. Undefined where neither
 * narrows. Values reach a parameter only through the calls of its
 * function, so a function no call reaches writes nothing.
 */
export function writtenHolders(
    program: ts.Program,
    checker: ts.TypeChecker,
    object: ts.Expression,
    key?: ts.Expression,
): readonly WrittenHolder[] | undefined {
    const type = checker.getTypeAtLocation(object);
    const own = unionMembers(type);
    const held = openHolder(type)
        ? heldTypes(program, checker, object, new Set())
        : undefined;
    const types =
        held &&
        (held.length !== own.length ||
            held.some((member, index) => member !== own[index]))
            ? held
            : undefined;
    const names = key && keyNames(program, checker, key, new Set());
    if (!types && !names) return undefined;
    return (types ?? [type]).flatMap((held) =>
        names
            ? names.map((property) => ({ type: held, property }))
            : [{ type: held }],
    );
}
