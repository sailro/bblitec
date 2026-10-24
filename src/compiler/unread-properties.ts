import ts from "typescript";
import {
    isAssignmentExpression,
    patternSlots,
    unwrapExpression,
} from "./syntax.js";
import { staticAccessKey, libraryStaticMember } from "./symbols.js";
import { unionMembers } from "./type-facts.js";
import type { PatternRead } from "./syntax.js";

const reflectiveObjectMethods = new Set([
    "assign",
    "entries",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "keys",
    "values",
]);

const cache = new WeakMap<ts.Program, Map<string, boolean>>();

/**
 * Whether no reached source can observe a property named `name`: nothing
 * reads it by name (a property or literal element access, a binding or an
 * assignment pattern), and no reflective operation -- a spread, an
 * `Object.*` enumeration, `JSON.stringify`, `for...in` -- takes a value
 * whose type carries it. Such a field can be left out of native storage,
 * since nothing would ever read it back.
 */
export function propertyNeverObserved(
    program: ts.Program,
    checker: ts.TypeChecker,
    name: string,
): boolean {
    let names = cache.get(program);
    if (!names) {
        names = new Map();
        cache.set(program, names);
    }
    const known = names.get(name);
    if (known !== undefined) return known;
    const carries = (expression: ts.Expression): boolean => {
        const type = checker.getTypeAtLocation(expression);
        const parts = unionMembers(type);
        return parts.some(
            (part) =>
                (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                    0 || part.getProperty(name) !== undefined,
        );
    };
    // A destructuring reads the keys it names; a rest or a run-time key, any.
    const readsName = (slots: readonly { read: PatternRead }[]): boolean =>
        slots.some(
            ({ read }) =>
                read.kind !== "member" ||
                read.key === undefined ||
                read.key === name,
        );
    const assignmentPatternReads = (pattern: ts.Expression): boolean => {
        const target = unwrapExpression(pattern);
        if (ts.isObjectLiteralExpression(target)) {
            const slots = patternSlots(target);
            return (
                readsName(slots) ||
                slots.some((slot) => assignmentPatternReads(slot.target))
            );
        }
        return (
            ts.isArrayLiteralExpression(target) &&
            patternSlots(target).some((slot) =>
                assignmentPatternReads(slot.target),
            )
        );
    };
    const observes = (node: ts.Node): boolean => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === name)
            return true;
        if (ts.isElementAccessExpression(node)) {
            // A key only the run time knows may be this one.
            const key = staticAccessKey(checker, node);
            if ((key === undefined || key === name) && carries(node.expression))
                return true;
        }
        if (ts.isObjectBindingPattern(node) && readsName(patternSlots(node)))
            return true;
        if (
            (isAssignmentExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                assignmentPatternReads(node.left)) ||
            ((ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
                !ts.isVariableDeclarationList(node.initializer) &&
                assignmentPatternReads(node.initializer))
        )
            return true;
        if (
            (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) &&
            carries(node.expression)
        )
            return true;
        if (ts.isForInStatement(node) && carries(node.expression)) return true;
        if (ts.isCallExpression(node)) {
            const callee = libraryStaticMember(checker, node.expression);
            const reflective =
                callee !== undefined &&
                ((callee.owner === "Object" &&
                    reflectiveObjectMethods.has(callee.name)) ||
                    (callee.owner === "JSON" && callee.name === "stringify") ||
                    (callee.owner === "Reflect" && callee.name !== "apply"));
            if (reflective && node.arguments.some(carries)) return true;
        }
        return (
            ts.forEachChild(node, (child) =>
                observes(child) ? true : undefined,
            ) === true
        );
    };
    const unread = program
        .getSourceFiles()
        .filter((file) => !file.isDeclarationFile)
        .every((file) => !observes(file));
    names.set(name, unread);
    return unread;
}
