import ts from "typescript";
import {
    isAssignmentExpression,
    patternSlots,
    unwrapExpression,
} from "./syntax.js";
import { staticAccessKey, libraryStaticMember } from "./symbols.js";
import { unionMembers, valueKindOf } from "./type-facts.js";
import type { PatternRead } from "./syntax.js";
import { unlessRefused } from "./compile-error.js";
import type { LoweringServices } from "./lowering-services.js";

const reflectiveObjectMethods = new Set([
    "assign",
    "entries",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "keys",
    "values",
]);

/**
 * Where a program can observe a property by its name, gathered in one walk
 * over its sources: the names it reads, whether some read takes every name
 * (a rest or run-time key in a pattern), and the values whose types decide
 * for the rest (a run-time key, a spread, `for...in`, a reflective call).
 */
interface PropertyObservations {
    readonly names: ReadonlySet<string>;
    readonly everyName: boolean;
    readonly carriers: readonly {
        readonly parts: readonly ts.Type[];
        /** A run-time key of number type, which only reaches numeric names. */
        readonly numericKey: boolean;
    }[];
    /** Answers per name, as asked. */
    readonly answers: Map<string, boolean>;
}

const observationsCache = new WeakMap<ts.Program, PropertyObservations>();
const readObservationsCache = new WeakMap<ts.Program, PropertyObservations>();

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
    return unobserved(program, checker, name, observationsCache, false);
}

/**
 * {@link propertyNeverObserved}, where a plain write (`owner.name = value`)
 * is not an observation: no reached source reads the value back.
 */
export function propertyNeverRead(
    program: ts.Program,
    checker: ts.TypeChecker,
    name: string,
): boolean {
    return unobserved(program, checker, name, readObservationsCache, true);
}

function unobserved(
    program: ts.Program,
    checker: ts.TypeChecker,
    name: string,
    caches: WeakMap<ts.Program, PropertyObservations>,
    writesUnread: boolean,
): boolean {
    let observations = caches.get(program);
    if (!observations) {
        observations = observePropertyNames(program, checker, writesUnread);
        caches.set(program, observations);
    }
    const known = observations.answers.get(name);
    if (known !== undefined) return known;
    const numericName = String(Number(name)) === name;
    const unread =
        !observations.everyName &&
        !observations.names.has(name) &&
        !observations.carriers.some(
            ({ parts, numericKey }) =>
                !(numericKey && !numericName) &&
                parts.some(
                    (part) =>
                        (part.flags &
                            (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                            0 || part.getProperty(name) !== undefined,
                ),
        );
    observations.answers.set(name, unread);
    return unread;
}

function observePropertyNames(
    program: ts.Program,
    checker: ts.TypeChecker,
    writesUnread: boolean,
): PropertyObservations {
    const names = new Set<string>();
    let everyName = false;
    const carriers: { parts: readonly ts.Type[]; numericKey: boolean }[] = [];
    const carrier = (expression: ts.Expression, numericKey = false): void => {
        carriers.push({
            parts: unionMembers(checker.getTypeAtLocation(expression)),
            numericKey,
        });
    };
    // A destructuring reads the keys it names; a rest or a run-time key, any.
    const readSlots = (slots: readonly { read: PatternRead }[]): void => {
        for (const { read } of slots)
            if (read.kind !== "member" || read.key === undefined)
                everyName = true;
            else names.add(read.key);
    };
    const assignmentPattern = (pattern: ts.Expression): void => {
        const target = unwrapExpression(pattern);
        if (ts.isObjectLiteralExpression(target)) {
            const slots = patternSlots(target);
            readSlots(slots);
            for (const slot of slots) assignmentPattern(slot.target);
        } else if (ts.isArrayLiteralExpression(target))
            for (const slot of patternSlots(target))
                assignmentPattern(slot.target);
    };
    const visit = (node: ts.Node): void => {
        if (
            ts.isPropertyAccessExpression(node) &&
            !(
                writesUnread &&
                ts.isBinaryExpression(node.parent) &&
                node.parent.left === node &&
                node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
            )
        )
            names.add(node.name.text);
        if (ts.isElementAccessExpression(node)) {
            // A key only the run time knows may be any name, unless it is a
            // number and the name converts to no number.
            const key = staticAccessKey(checker, node);
            if (key === undefined)
                carrier(
                    node.expression,
                    valueKindOf(
                        checker.getTypeAtLocation(node.argumentExpression),
                    ) === "number",
                );
            else if (
                unionMembers(checker.getTypeAtLocation(node.expression)).some(
                    (part) =>
                        (part.flags &
                            (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
                            0 || part.getProperty(key) !== undefined,
                )
            )
                names.add(key);
        }
        if (ts.isObjectBindingPattern(node)) readSlots(patternSlots(node));
        if (
            isAssignmentExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
            assignmentPattern(node.left);
        if (
            (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
            !ts.isVariableDeclarationList(node.initializer)
        )
            assignmentPattern(node.initializer);
        if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node))
            carrier(node.expression);
        if (ts.isForInStatement(node)) carrier(node.expression);
        if (ts.isCallExpression(node)) {
            const callee = libraryStaticMember(checker, node.expression);
            const reflective =
                callee !== undefined &&
                ((callee.owner === "Object" &&
                    reflectiveObjectMethods.has(callee.name)) ||
                    (callee.owner === "JSON" && callee.name === "stringify") ||
                    (callee.owner === "Reflect" && callee.name !== "apply"));
            if (reflective)
                for (const argument of node.arguments) carrier(argument);
        }
        ts.forEachChild(node, visit);
    };
    for (const file of program.getSourceFiles())
        if (!file.isDeclarationFile) visit(file);
    return { names, everyName, carriers, answers: new Map() };
}

/**
 * What `compile` makes for a property named `name`, or undefined when that
 * compile refuses and {@link propertyNeverObserved}: nothing would read the
 * value back, so no storage needs it. A read property compiles unprobed.
 */
export function compiledUnlessUnobserved<T>(
    context: Pick<LoweringServices, "probeEmission" | "program" | "checker">,
    name: string,
    compile: () => T,
): T | undefined {
    if (!propertyNeverObserved(context.program, context.checker, name))
        return compile();
    return unlessRefused(() => context.probeEmission(compile, () => true));
}
