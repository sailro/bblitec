import ts from "typescript";
import {
    ARGUMENT_HOLDING_METHODS,
    LIBRARY_CALL_FACTS,
} from "./library-call-facts.js";
import { isStoringDataCall, mutatingArrayMethods } from "./receiver-methods.js";
import { runsArgumentAfterReturn } from "./schedulers.js";
import {
    calledDeclaration,
    declarationInDefaultLibrary,
    libraryCallName,
    libraryGlobal,
    libraryName,
    namedMember,
} from "./symbols.js";
import type { KeyPath } from "./projections.js";
import {
    ANY_KEY,
    aliasKey,
    objectLiteralMembers,
    referenceBases,
    unwrapExpression,
    valueUse,
    type ValueUse,
} from "./syntax.js";
import {
    arrayShape,
    typeCanCarryReference,
    unionMembers,
} from "./type-facts.js";
import { TYPED_ARRAY_KINDS } from "./data-types/typed-arrays.js";
import { classChain, classMemberTable } from "./class-members.js";
import { someAnalysisNode } from "./analysis-walk.js";

/**
 * The values a literal holds, at any depth: an object literal's property
 * values and an array literal's elements, through nested literals. A
 * member of another object held there is that same object.
 */
export function literalHeldValues(
    expression: ts.Expression,
): readonly ts.Expression[] {
    return literalHeldValuesAt(expression).map(({ value }) => value);
}

/**
 * {@link literalHeldValues} with the key path each sits at below the
 * literal: a property under its key, an element under {@link ANY_KEY}.
 */
export function literalHeldValuesAt(
    expression: ts.Expression,
    at: KeyPath = [],
): readonly { readonly value: ts.Expression; readonly path: KeyPath }[] {
    const literal = unwrapExpression(expression);
    const values = ts.isObjectLiteralExpression(literal)
        ? objectLiteralMembers(literal).flatMap((member) =>
              member.value === undefined
                  ? []
                  : [
                        {
                            value: member.value,
                            path: [...at, aliasKey(member.key)],
                        },
                    ],
          )
        : ts.isArrayLiteralExpression(literal)
          ? literal.elements
                .filter(
                    (element) =>
                        !ts.isSpreadElement(element) &&
                        !ts.isOmittedExpression(element),
                )
                .map((value) => ({ value, path: [...at, ANY_KEY] }))
          : [];
    return values.flatMap((held) => [
        held,
        ...literalHeldValuesAt(held.value, held.path),
    ]);
}

/**
 * The expressions whose objects a value may be or hold: its reference bases
 * (through selections) and those of every reference a literal holds.
 */
export function heldReferenceBases(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): readonly ts.Expression[] {
    return [expression, ...literalHeldValues(expression)].flatMap((value) =>
        typeCanCarryReference(checker.getTypeAtLocation(value))
            ? referenceBases(value)
            : [],
    );
}

/**
 * Whether `new` builds an object that may keep its arguments for its
 * methods (a parameter property, a field): anything but a library global,
 * whose storing ones (`new Map(entries)`) keep through isStoringDataCall.
 */
function constructionKeepsArguments(
    checker: ts.TypeChecker,
    construction: ts.NewExpression,
): boolean {
    return libraryGlobal(checker, construction.expression) === undefined;
}

/**
 * The arguments a call or construction keeps past its return: a
 * construction for its methods, a storing data call (`push`, `splice`,
 * `fill`, `set`, `new Map(entries)`) in the container, a library
 * construction's callback it runs later (`new MutationObserver(cb)`).
 */
export function keptArguments(
    checker: ts.TypeChecker,
    node: ts.Node,
): readonly ts.Expression[] {
    if (
        (ts.isNewExpression(node) &&
            constructionKeepsArguments(checker, node)) ||
        isStoringDataCall(node, checker)
    )
        return node.arguments ?? [];
    if (ts.isNewExpression(node))
        return (node.arguments ?? []).filter((_, index) =>
            runsArgumentAfterReturn(checker, node, index),
        );
    return [];
}

/**
 * Whether a call's result can share identity with its callee's receiver
 * (`receiver.method(...)`). A library array whose elements carry no
 * reference hands out only itself, which only its mutating methods return;
 * any other receiver may return itself or a member.
 */
export function callResultCanHoldReceiver(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): boolean {
    const callee = namedMember(checker, unwrapExpression(call.expression));
    if (!callee) return true;
    const shape = arrayShape(
        checker,
        checker.getTypeAtLocation(callee.expression),
    );
    return (
        shape === undefined ||
        typeCanCarryReference(shape.element) ||
        mutatingArrayMethods.has(callee.name)
    );
}

/**
 * Where a value ends up: {@link valueUse} followed through the results that
 * can be or hold it (a call that can return its receiver, an argument
 * `follow.argument` keeps, an awaited value with `follow.await`) and
 * through reads out of a literal or result holding it.
 */
export function valueDestination(
    checker: ts.TypeChecker,
    value: ts.Expression,
    follow: {
        readonly argument?: (
            call: ts.CallExpression | ts.NewExpression,
            index: number,
        ) => boolean;
        readonly await?: boolean;
    } = {},
): ValueUse {
    let use = valueUse(value);
    let held = use.held;
    for (;;) {
        let next: ts.Expression | undefined;
        if (use.kind === "member") {
            const call = use.access.parent;
            if (ts.isCallExpression(call) && call.expression === use.access) {
                if (callResultCanHoldReceiver(checker, call)) {
                    next = call;
                    held = true;
                }
            } else if (held) next = use.access;
        } else if (
            use.kind === "argument" &&
            follow.argument?.(use.call, use.index)
        ) {
            next = use.call;
            held = true;
        } else if (use.kind === "awaited" && follow.await) next = use.await;
        if (!next || !typeCanCarryReference(checker.getTypeAtLocation(next)))
            return use;
        use = valueUse(next);
        held ||= use.held;
    }
}

/** @unjournaled Pure functions of the checked program, kept across replays. */
const handsOutThis = new WeakMap<ts.ClassLikeDeclaration, boolean>();

/**
 * Whether a class's code, or a base class's, hands out `this`: returns,
 * stores, binds or passes it rather than reading through, calling or
 * testing it ({@link valueDestination}).
 */
export function classHandsOutThis(
    checker: ts.TypeChecker,
    declaration: ts.ClassLikeDeclaration,
): boolean {
    const known = handsOutThis.get(declaration);
    if (known !== undefined) return known;
    const answer = classChain(classMemberTable(checker, declaration)).some(
        (link) =>
            someAnalysisNode(link.declaration, (node) => {
                if (
                    node.kind !== ts.SyntaxKind.ThisKeyword ||
                    !ts.isExpression(node)
                )
                    return false;
                const use = valueDestination(checker, node);
                return (
                    use.kind !== "member" &&
                    use.kind !== "read" &&
                    use.kind !== "discarded"
                );
            }),
    );
    handsOutThis.set(declaration, answer);
    return answer;
}

/** Typed-array and view constructors: a view of a buffer, a copy of anything else. */
const BINARY_VIEWS: ReadonlySet<string> = new Set([
    ...TYPED_ARRAY_KINDS.keys(),
    "DataView",
]);

/**
 * Which of its arguments a default-library call's result may be, or hold:
 * the one table every reader shares. A view holds the buffer it is over and
 * copies values; a library object's method holds an argument only when it
 * stores it (`set`, `concat`); a static or global holds one unless it only
 * computes (`Object.keys`, `JSON.stringify`, `Math`), so one the table
 * does not name may.
 */
function libraryHeldArguments(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
): "any" | "none" | "buffers" {
    const name = libraryCallName(checker, call);
    if (name === undefined) return "any";
    if (BINARY_VIEWS.has(name) || BINARY_VIEWS.has(name.split(".")[0]!))
        return "buffers";
    const callee = namedMember(checker, unwrapExpression(call.expression));
    // A method of a library object: only the storing ones hand it back.
    if (callee && libraryGlobal(checker, callee.expression) === undefined)
        return ARGUMENT_HOLDING_METHODS.has(callee.name) ? "any" : "none";
    return LIBRARY_CALL_FACTS.get(name)?.result === "computed" ||
        name.startsWith("Math.")
        ? "none"
        : "any";
}

/** Whether an argument a view is created over may be a buffer it shares. */
function mayBeBuffer(
    checker: ts.TypeChecker,
    argument: ts.Expression | undefined,
): boolean {
    const type =
        argument &&
        checker.getNonNullableType(checker.getTypeAtLocation(argument));
    return (
        type === undefined ||
        (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
        unionMembers(type).some((member) => {
            const name = libraryName(member);
            return name === "ArrayBuffer" || name === "SharedArrayBuffer";
        })
    );
}

/**
 * Whether a default-library call's result may be, or hold, the object it is
 * handed at `index` ({@link libraryHeldArguments}).
 */
export function libraryResultMayHold(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    index: number,
): boolean {
    const held = libraryHeldArguments(checker, call);
    return held === "buffers"
        ? mayBeBuffer(checker, call.arguments?.[index])
        : held === "any";
}

/**
 * Whether a default-library call's result can share identity with its
 * arguments or their members (`Object.values(record)[0]` is the record's
 * first value, `xs.concat(ys)` holds `ys`'s elements).
 */
export function callResultHoldsArguments(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): boolean {
    const declaration = calledDeclaration(checker, call);
    if (!declaration || !declarationInDefaultLibrary(declaration)) return false;
    const held = libraryHeldArguments(checker, call);
    return held === "buffers"
        ? call.arguments.some((argument) => mayBeBuffer(checker, argument))
        : held === "any" && call.arguments.length > 0;
}
