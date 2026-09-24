/**
 * A pinned factory's own option defaults, read from the `??` that resolves
 * each option.
 *
 * Every pinned factory that takes an options bag resolves it the same way —
 * one `const x = options.x ?? <default>` per option — and a lowerer that
 * needs the default reads it from that operator rather than restating the
 * number beside itself, so a pin that retunes one regenerates and a pin that
 * stops defaulting it fails naming the option.
 *
 * Three placements reach this, and each caller names the one its factory
 * uses (`PinnedOptionSite`). The value readers then take the right operand
 * as the pin wrote it: a number, a three-component colour or a flag.
 * `pinnedDefaultValue` is the decoder every reader of a pinned
 * `?? <default>` that may state any of the three shares (the flag reader
 * here, the material, UBO-writer and post-process defaults).
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** Where one option's `??` sits in a pinned body. */
export type PinnedOptionSite =
    /** `const <local> = <read> ?? <default>`: the initializer IS the `??`. */
    | { readonly local: string }
    /**
     * `const <wrapped> = wrap(<read> ?? <default>)`: the `??` inside a
     * wrapper the lowered body keeps — `| 0` for an integer,
     * `Math.max(3, ...)` for a floor, a guard ternary. None of those is the
     * DEFAULT, which is what the read falls back to when the option is
     * absent. `a ?? b ?? c` parses as `(a ?? b) ?? c`, so the option's own
     * read sits at the bottom of the left spine and the default is the
     * OUTERMOST right operand: the first `??` in pre-order.
     */
    | { readonly wrapped: string }
    /** `<record>.<member> ?? <default>`: the first such read in the scope. */
    | { readonly member: string };

/** A default as the pin states it: a number, a flag, or a list of numbers. */
export type PinnedDefaultValue = number | boolean | readonly number[];

/**
 * The constant a pinned `?? <default>` right side states: `true`/`false` as
 * the flag, an array literal lane by lane, anything else folded to a number.
 * A right side that is itself a `??` chain folds to its all-absent ground
 * state, the constant the chain ends in. Undefined where the right side
 * reads another value instead of stating one -- the reflectance chain's
 * `_metallicF0Factor`, or a local -- which each caller answers in its own
 * terms.
 */
export function pinnedDefaultValue(
    context: LoweringContext,
    expression: ts.Expression,
    file: ts.SourceFile,
): PinnedDefaultValue | undefined {
    const node = context.unwrapExpression(expression);
    const chained = context.nullishDefault(node);
    if (chained) return pinnedDefaultValue(context, chained.right, file);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.map((element) =>
            context.numericValue(element, file),
        );
    }
    // A read of the global `Math` (`Math.PI`) is a constant like any literal;
    // any other member read, or a name no pinned `const` declares, is a value.
    const readsValue = ts.isPropertyAccessExpression(node)
        ? context.propertyPath(node)?.[0] !== "Math"
        : ts.isIdentifier(node) && !context.constantOf(node);
    return readsValue ? undefined : context.numericValue(node, file);
}

/** Whether two pinned defaults are the same value, lane by lane for a list. */
export function samePinnedDefault(
    left: PinnedDefaultValue,
    right: PinnedDefaultValue,
): boolean {
    return Array.isArray(left) && Array.isArray(right)
        ? left.length === right.length &&
              left.every((lane, index) => lane === right[index])
        : left === right;
}

/** The right operand of an initializer that is itself one `??`. */
export function nullishFallback(
    context: LoweringContext,
    initializer: ts.Expression,
    label: string,
): ts.Expression {
    const nullish = context.nullishDefault(initializer);
    if (!nullish) {
        return context.contractError(
            initializer,
            `Expected pinned '${label}' to resolve through '??'.`,
        );
    }
    return context.unwrapExpression(nullish.right);
}

/** The first node in pre-order that `select` answers for. */
function firstInPreOrder<T>(
    root: ts.Node,
    select: (node: ts.Node) => T | undefined,
): T | undefined {
    let found: T | undefined;
    const visit = (node: ts.Node): void => {
        if (found !== undefined) return;
        found = select(node);
        if (found === undefined) ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
}

/** The right operand of the `??` that resolves one option. */
export function pinnedOptionFallback(
    context: LoweringContext,
    scope: ts.Node,
    site: PinnedOptionSite,
): ts.Expression {
    if ("local" in site) {
        return nullishFallback(
            context,
            context.variableInitializer(scope, site.local),
            site.local,
        );
    }
    const root =
        "wrapped" in site
            ? context.variableInitializer(scope, site.wrapped)
            : scope;
    const found = firstInPreOrder(root, (node) => {
        const nullish = ts.isExpression(node)
            ? context.nullishDefault(node)
            : undefined;
        if (!nullish) return undefined;
        if ("wrapped" in site) return nullish.right;
        const read = context.unwrapExpression(nullish.left);
        return ts.isPropertyAccessExpression(read) &&
            read.name.text === site.member
            ? nullish.right
            : undefined;
    });
    const label = "wrapped" in site ? site.wrapped : site.member;
    return found
        ? context.unwrapExpression(found)
        : context.contractError(
              root,
              `Expected pinned '${label}' to resolve through '??'.`,
          );
}

/** A numeric default. */
export function pinnedOptionNumber(
    context: LoweringContext,
    scope: ts.Node,
    site: PinnedOptionSite,
    file: ts.SourceFile,
): number {
    return context.numericValue(
        pinnedOptionFallback(context, scope, site),
        file,
    );
}

/** A three-component colour default (`?? [r, g, b]`). */
export function pinnedOptionTuple(
    context: LoweringContext,
    scope: ts.Node,
    site: PinnedOptionSite,
    file: ts.SourceFile,
): [number, number, number] {
    return context.numericTuple(
        pinnedOptionFallback(context, scope, site),
        file,
    );
}

/** A flag default (`?? true` / `?? false`). */
export function pinnedOptionFlag(
    context: LoweringContext,
    scope: ts.Node,
    site: PinnedOptionSite,
): boolean {
    const fallback = pinnedOptionFallback(context, scope, site);
    const value = pinnedDefaultValue(
        context,
        fallback,
        fallback.getSourceFile(),
    );
    if (typeof value === "boolean") return value;
    return context.contractError(
        fallback,
        "Expected a pinned option to default to a boolean literal.",
    );
}

/**
 * Every named local's numeric `??` fallback in one pinned factory: the
 * `{ local }` placement, for a family that resolves a list of options.
 */
export function pinnedOptionDefaults<Name extends string>(
    context: LoweringContext,
    module: string,
    factory: string,
    names: readonly Name[],
): Record<Name, number> {
    const { file, declaration } = context.functionDeclaration(module, factory);
    return Object.fromEntries(
        names.map((name) => [
            name,
            pinnedOptionNumber(context, declaration, { local: name }, file),
        ]),
    ) as Record<Name, number>;
}
