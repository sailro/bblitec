import ts from "typescript";
import { audioContextPrototype } from "./audio-surface.js";
import type { LoweringServices } from "./lowering-services.js";
import { isJsonValue } from "./json-bridge.js";
import { programObservations } from "./program-observations.js";
import { isLibraryStatic } from "./symbols.js";
import { argumentAt } from "./syntax.js";
import { arrayShape, isNullable, valueKindOf } from "./type-facts.js";
import type { Value } from "./types.js";

type PrototypeContext = Pick<
    LoweringServices,
    | "checker"
    | "compileValue"
    | "dataTypes"
    | "emitDiscardedValue"
    | "evaluationOrder"
    | "expectArgumentCount"
    | "fail"
    | "libraryGlobal"
    | "program"
    | "reachJsData"
    | "reachJson"
>;

/**
 * The constructors whose prototype a represented value can have; the
 * native identity of each is its name in lower case.
 */
const PROTOTYPES: ReadonlySet<string> = new Set([
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
]);

/** The native spelling of an identity generation knows. */
const KNOWN = "bbl::js::Prototype::";

/** A prototype identity (`bbl::js::Prototype`): compared and stored, nothing else. */
function prototypeValue(
    context: Pick<PrototypeContext, "reachJsData">,
    cpp: string,
): Value {
    context.reachJsData();
    return { kind: "data", cpp, dataType: { kind: "prototype" } };
}

/** The identity a prototype read in place names at generation; undefined for a run-time one. */
export function knownPrototype(value: Value): string | undefined {
    return value.dataType?.kind === "prototype" && value.cpp.startsWith(KNOWN)
        ? value.cpp.slice(KNOWN.length)
        : undefined;
}

/** The identity `X.prototype` names, for a constructor whose prototype a value can have. */
function libraryPrototype(
    context: Pick<PrototypeContext, "libraryGlobal">,
    expression: ts.Expression,
): string | undefined {
    if (
        !ts.isPropertyAccessExpression(expression) ||
        expression.name.text !== "prototype"
    )
        return undefined;
    const owner = context.libraryGlobal(expression.expression);
    return owner !== undefined && PROTOTYPES.has(owner)
        ? owner.toLowerCase()
        : undefined;
}

/**
 * `<constructor>.prototype` read as a value: `Object.prototype` and its
 * like as the identity it names, the audio context's as the record of the
 * optional methods no host has; undefined for any other access.
 */
export function compileLibraryPrototype(
    context: Pick<PrototypeContext, "libraryGlobal" | "reachJsData">,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    if (expression.name.text !== "prototype") return undefined;
    if (context.libraryGlobal(expression.expression) === "AudioContext")
        return audioContextPrototype();
    const identity = libraryPrototype(context, expression);
    return identity === undefined
        ? undefined
        : prototypeValue(context, KNOWN + identity);
}

/** The argument of an `Object.getPrototypeOf(value)` call; undefined for any other expression. */
export function prototypeOfArgument(
    checker: ts.TypeChecker,
    node: ts.Expression,
): ts.Expression | undefined {
    return ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        isLibraryStatic(checker, node.expression, "Object", "getPrototypeOf")
        ? node.arguments[0]
        : undefined;
}

/** Whether `node` reads a prototype in place, which its comparison can settle at generation. */
export function readsPrototype(
    context: Pick<PrototypeContext, "checker" | "libraryGlobal">,
    node: ts.Expression,
): boolean {
    return (
        prototypeOfArgument(context.checker, node) !== undefined ||
        libraryPrototype(context, node) !== undefined
    );
}

/**
 * `Object.getPrototypeOf(value)`. An object literal's record, a record
 * struct, a dictionary and a document's object have `Object.prototype`, an
 * array or tuple `Array.prototype`, a string, number or boolean its
 * wrapper's; a document answers by its run-time kind and throws the
 * TypeError on null and undefined. That is exact only in a program that
 * gives no object another prototype (`foreignPrototype`): `Object.create(null)`
 * lowers to a dictionary no representation tells from a literal's. A class
 * instance's prototype is read by a comparison alone (`prototypeComparison`);
 * any other value refuses by its type.
 */
export function compileObjectGetPrototypeOf(
    context: PrototypeContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 1);
    const foreign = programObservations(context.program).foreignPrototype;
    if (foreign) {
        const source = foreign.getSourceFile();
        const { line } = source.getLineAndCharacterOfPosition(
            foreign.getStart(source),
        );
        return context.fail(
            call,
            "Object.getPrototypeOf answers exactly only in a program that gives no object another " +
                `prototype; ${source.fileName}:${line + 1} does.`,
        );
    }
    const argument = argumentAt(call, 0);
    const value = context.compileValue(argument);
    if (isJsonValue(value)) {
        context.reachJson();
        return prototypeValue(context, `(${value.cpp}).prototype()`);
    }
    const type = context.checker.getTypeAtLocation(argument);
    if (isNullable(type))
        return context.fail(
            argument,
            "Object.getPrototypeOf needs a value that cannot be null or undefined.",
        );
    const identity = (): string | undefined => {
        if (value.dataType?.kind === "prototype")
            return context.fail(
                argument,
                "Object.getPrototypeOf does not represent the prototype of a prototype.",
            );
        const kind = valueKindOf(type);
        if (kind === "string" || kind === "number" || kind === "boolean")
            return kind;
        if (arrayShape(context.checker, type)) return "array";
        const stored = value.kind === "data" ? value.dataType : undefined;
        if (
            value.kind === "record"
                ? value.classDeclaration
                : stored?.kind === "struct" &&
                  context.dataTypes.isClassStruct(stored.name)
        )
            return context.fail(
                argument,
                "Object.getPrototypeOf reads a class instance's prototype in a comparison with a class's prototype only.",
            );
        return value.kind === "record" ||
            stored?.kind === "struct" ||
            (stored?.kind === "map" && stored.dictionary)
            ? "object"
            : undefined;
    };
    const known = identity();
    if (known === undefined)
        return context.fail(
            argument,
            `Object.getPrototypeOf does not represent the prototype of '${context.checker.typeToString(type)}'.`,
        );
    if (!context.evaluationOrder.isPureExpression(argument))
        context.emitDiscardedValue(value);
    return prototypeValue(context, KNOWN + known);
}
