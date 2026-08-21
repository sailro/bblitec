// Shared option-lowering helpers.
//
// The option compilers agree on three small contracts: an options
// object may only carry the properties the reached lowering reads, a
// count lowers to a positive integer literal (or the engine's own
// msaaSamples), and an optional flag folds to a static boolean. They
// are declared once here so every per-domain option module states the
// same rule instead of carrying its own copy.
import ts from "typescript";
import type { Value } from "./types.js";

/**
 * The one-argument `Math` functions that fold at generation.
 *
 * All five are integer-valued, so the folded result and the emitted call
 * agree exactly. The transcendental ones are deliberately absent: V8 and a
 * native maths library need not agree on them, and a value folded here can
 * end up in generation-time state a native call could not reproduce.
 * `round` is JavaScript's own rule, which ties toward +Infinity where C
 * ties away from zero.
 */
export const foldableMathUnary: Readonly<
    Record<string, (value: number) => number>
> = {
    abs: Math.abs,
    ceil: Math.ceil,
    floor: Math.floor,
    round: Math.round,
    trunc: Math.trunc,
};

export interface ObjectValidationContext {
    propertyName(
        name: ts.PropertyName,
    ): string | undefined;
    fail(node: ts.Node, message: string): never;
}

export function validateObjectProperties(
    context: ObjectValidationContext,
    object: ts.ObjectLiteralExpression,
    supported: readonly string[],
    message: string,
): void {
    const supportedNames = new Set(supported);
    for (const property of object.properties) {
        const name =
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
                ? context.propertyName(property.name)
                : undefined;
        if (!name || !supportedNames.has(name)) {
            context.fail(property, message);
        }
    }
}

export interface PositiveIntegerContext {
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    /**
     * `canvas.width` / `canvas.height` as the number generation
     * configured, or undefined for anything else. Read only by
     * `staticNumberValue`; see the note there.
     */
    staticCanvasSize?(expression: ts.Expression): number | undefined;
    lookup(identifier: ts.Identifier): Value;
    /** The binding, or undefined where this scope has none. */
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    fail(node: ts.Node, message: string): never;
}

export function compilePositiveInteger(
    context: PositiveIntegerContext,
    expression: ts.Expression,
): string {
    const unwrapped = context.resolveStaticExpression(
        expression,
    );
    if (
        ts.isPropertyAccessExpression(unwrapped) &&
        ts.isIdentifier(unwrapped.expression) &&
        unwrapped.name.text === "msaaSamples" &&
        context.lookup(unwrapped.expression).kind ===
            "engine"
    ) {
        const engine = context.lookup(
            unwrapped.expression,
        );
        return `${engine.msaaSamples ?? 4}u`;
    }
    const value = compileStaticNumber(
        context,
        unwrapped,
        "A count",
    );
    if (!Number.isInteger(value) || value <= 0) {
        context.fail(unwrapped, "Expected a positive integer literal.");
    }
    return `${value}u`;
}

export interface StaticBooleanContext {
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    compileBoolean(expression: ts.Expression): string;
    fail(node: ts.Node, message: string): never;
}

/**
 * A boolean option as the value it settles to, or the fallback when unset.
 *
 * Every caller spends this on a generation-time decision -- which fragment
 * the pin composes, which arm the generated loader carries, whether a
 * registrar starts its systems -- so an expression that does not settle is
 * refused. Reading it as `false` would compile a scene to a picture nobody
 * asked for, which is the failure this is here to prevent.
 */
export function compileOptionalStaticBoolean(
    context: StaticBooleanContext,
    expression: ts.Expression | undefined,
    fallback: boolean,
    what = "This option",
): boolean {
    if (!expression) return fallback;
    const compiled = context.compileBoolean(
        context.resolveStaticExpression(expression),
    );
    if (compiled !== "true" && compiled !== "false") {
        context.fail(
            expression,
            `${what} must be a static boolean: generation decides on it.`,
        );
    }
    return compiled === "true";
}

/**
 * A number an option carries as a value rather than as an expression.
 *
 * Most options lower to a native expression, but some have to be *known* at
 * generation: a shader the pin composes from an option's value, and the
 * effect parameter table a post-process record carries, are both settled
 * before any native code exists. Anything `staticNumberValue` cannot fold is
 * refused rather than defaulted.
 */
export function compileStaticNumber(
    context: PositiveIntegerContext,
    expression: ts.Expression,
    label: string,
): number {
    const value = staticNumberValue(context, expression);
    if (value === undefined) {
        context.fail(
            context.resolveStaticExpression(expression),
            `${label} must be a static number.`,
        );
    }
    return value;
}

/**
 * "Not a JSON literal", distinct from every value one can hold.
 *
 * `null` is a value the graphs carry (`tags: null`), so it cannot double as
 * the miss signal — and a signal the caller has to re-test for `object`,
 * `null` and `Array` is a signal that leaks.
 */
export const notJson = Symbol("not a JSON literal");

/** What reading a JSON literal out of the source needs. */
export interface StaticJsonContext {
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
}

/**
 * One JSON value out of the source, or `notJson`.
 *
 * Two families read a document straight out of the scene's own text — a node
 * material's graph and a node particle's — and both draw the same line: a
 * literal is data and cannot drift, so it is folded, while anything the
 * source computes is a module generation runs instead.
 */
export function staticJsonValue(
    context: StaticJsonContext,
    expression: ts.Expression,
): unknown {
    const node = context.resolveStaticExpression(expression);
    if (ts.isObjectLiteralExpression(node)) {
        const value: Record<string, unknown> = {};
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property)) return notJson;
            const name = ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name) ||
                    ts.isNumericLiteral(property.name)
                ? property.name.text
                : undefined;
            if (name === undefined) return notJson;
            const member = staticJsonValue(context, property.initializer);
            if (member === notJson) return notJson;
            value[name] = member;
        }
        return value;
    }
    if (ts.isArrayLiteralExpression(node)) {
        const values: unknown[] = [];
        for (const element of node.elements) {
            if (
                ts.isSpreadElement(element) ||
                ts.isOmittedExpression(element)
            ) {
                return notJson;
            }
            const member = staticJsonValue(context, element);
            if (member === notJson) return notJson;
            values.push(member);
        }
        return values;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.operand)
    ) {
        return -Number(node.operand.text);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    return notJson;
}

/**
 * A number the source computes from constants, evaluated here.
 *
 * `compileStaticNumber` folds a literal and a named constant; this folds the
 * arithmetic between them, which is how the corpus writes a camera angle
 * (`-Math.PI / 2`). The evaluation is JavaScript's own on doubles, so a
 * value that travels back out as a literal is the value the source had.
 * Returns undefined for anything that is not constant, so a caller can
 * refuse by name rather than substituting.
 */
export function staticNumberValue(
    context: PositiveIntegerContext,
    expression: ts.Expression,
): number | undefined {
    const node = context.resolveStaticExpression(expression);
    if (ts.isNumericLiteral(node)) {
        const value = Number(node.text);
        return Number.isFinite(value) ? value : undefined;
    }
    if (ts.isParenthesizedExpression(node)) {
        return staticNumberValue(context, node.expression);
    }
    if (ts.isPrefixUnaryExpression(node)) {
        const operand = staticNumberValue(context, node.operand);
        if (operand === undefined) return undefined;
        if (node.operator === ts.SyntaxKind.MinusToken) return -operand;
        if (node.operator === ts.SyntaxKind.PlusToken) return operand;
        return undefined;
    }
    if (ts.isBinaryExpression(node)) {
        const left = staticNumberValue(context, node.left);
        const right = staticNumberValue(context, node.right);
        if (left === undefined || right === undefined) return undefined;
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.PlusToken:
                return left + right;
            case ts.SyntaxKind.MinusToken:
                return left - right;
            case ts.SyntaxKind.AsteriskToken:
                return left * right;
            case ts.SyntaxKind.SlashToken:
                return left / right;
            case ts.SyntaxKind.PercentToken:
                return left % right;
            default:
                return undefined;
        }
    }
    // A canvas size is a compile-time constant to every caller of THIS
    // helper, and only to them: `staticNumberValue` never emits, so a
    // consumer that reaches it has already decided it needs the number at
    // generation. The live read stays `Compiler.canvasSizeValue`, which
    // emits `engine.options.width` and carries no static value at all, so a
    // scene that resizes still sees the new size everywhere it is drawn.
    const canvas = context.staticCanvasSize?.(node);
    if (canvas !== undefined) return canvas;
    if (ts.isElementAccessExpression(node)) {
        // A constant tuple indexed by a constant -- the corpus writes its
        // colours that way (`PARTICLE_TINT[0]`).
        const target = context.resolveStaticExpression(node.expression);
        const index = staticNumberValue(
            context,
            node.argumentExpression,
        );
        if (
            !ts.isArrayLiteralExpression(target) ||
            index === undefined ||
            !Number.isInteger(index)
        ) {
            return undefined;
        }
        const element = target.elements[index];
        return element ? staticNumberValue(context, element) : undefined;
    }
    if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Math"
    ) {
        // The constants `StaticEvaluator.compileNumber` folds when it emits
        // one of these as text; a Math CALL is folded by the arm above.
        if (node.name.text === "PI") return Math.PI;
        if (node.name.text === "E") return Math.E;
        if (node.name.text === "SQRT1_2") return Math.SQRT1_2;
        return undefined;
    }
    if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Math" &&
        node.arguments.length === 1
    ) {
        const fold = foldableMathUnary[node.expression.name.text];
        if (!fold) return undefined;
        const argument = staticNumberValue(context, node.arguments[0]!);
        return argument === undefined ? undefined : fold(argument);
    }
    if (ts.isIdentifier(node)) {
        // A miss, not a failure: one caller is an optional probe, and an
        // identifier this scope has no binding for is simply not a constant.
        return context.lookupOptional(node)?.staticNumber;
    }
    return undefined;
}

/**
 * A static `{ x, y, z }` record, or undefined when any component is not a
 * constant.
 *
 * Two compile-time records read a vector this way -- a camera's target and a
 * node-particle emitter -- and both need the VALUE rather than the native
 * expression `compileVec3` emits.
 */
export function staticVec3Value(
    context: PositiveIntegerContext,
    expression: ts.Expression,
): readonly [number, number, number] | undefined {
    const node = context.resolveStaticExpression(expression);
    if (!ts.isObjectLiteralExpression(node)) return undefined;
    const axis = (name: "x" | "y" | "z"): number | undefined => {
        const property = node.properties.find(
            (candidate) =>
                candidate.name !== undefined &&
                (ts.isIdentifier(candidate.name) ||
                    ts.isStringLiteral(candidate.name)) &&
                candidate.name.text === name,
        );
        if (!property) return 0;
        if (!ts.isPropertyAssignment(property)) return undefined;
        return staticNumberValue(context, property.initializer);
    };
    const x = axis("x");
    const y = axis("y");
    const z = axis("z");
    return x === undefined || y === undefined || z === undefined
        ? undefined
        : [x, y, z];
}
