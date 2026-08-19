import ts from "typescript";
import type { LoweringContext } from "./context.js";

/**
 * A pinned blend descriptor, as the native factory emitted for it.
 *
 * `enabled` is false for a descriptor that names no `_descriptor`: upstream
 * documents that as "no colour blend", which is the 2D family's opaque mode
 * and the billboard family's alpha-test cutout. The two mean different things
 * downstream — cutout also drives a depth-write path — so the caller decides
 * which of its own modes it can actually render.
 */
export interface PinnedBlendRow {
    key: string;
    exportName: string;
    enabled: boolean;
    color: readonly [string, string];
    alpha: readonly [string, string];
    premultipliedOpacity: boolean;
}

/** The blend states the two families share, by the pin's own module. */
const sharedStateModule = "src/sprite/blend-descriptors.ts";

/**
 * Reads a pinned blend module as the pure data it is.
 *
 * Upstream keeps each mode as its own exported const rather than a lookup
 * table, precisely so a scene pays only for what it imports; both sprite
 * families use that shape, and `BillboardBlendDescriptor` extends the 2D
 * one. Walking the module means a mode the pin adds needs no compiler change
 * and a factor the pin edits changes what we emit — where a table typed here
 * would agree only until the next bump.
 */
export function readPinnedBlendTable(
    context: LoweringContext,
    modulePath: string,
    exportPrefix: string,
): PinnedBlendRow[] {
    const file = context.sourceFile(modulePath);
    const rows: PinnedBlendRow[] = [];
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const binding of statement.declarationList.declarations) {
            if (
                !ts.isIdentifier(binding.name) ||
                !binding.name.text.startsWith(exportPrefix) ||
                !binding.initializer
            ) {
                continue;
            }
            const literal = objectLiteral(
                context,
                binding.initializer,
                binding.name.text,
            );
            const key = context.stringValue(
                context.propertyInitializer(literal, "_key"),
                file,
            );
            const descriptor = optionalProperty(
                context,
                literal,
                "_descriptor",
            );
            const state = descriptor
                ? blendState(context, descriptor, key)
                : undefined;
            rows.push({
                key,
                exportName: binding.name.text,
                enabled: state !== undefined,
                color: state
                    ? blendSide(context, state, "color", key)
                    : ["one", "zero"],
                alpha: state
                    ? blendSide(context, state, "alpha", key)
                    : ["one", "zero"],
                premultipliedOpacity: Boolean(
                    optionalProperty(
                        context,
                        literal,
                        "_premultipliedOpacity",
                    ),
                ),
            });
        }
    }
    if (rows.length === 0) {
        context.contractError(
            file,
            `Pinned ${modulePath} exports no '${exportPrefix}*' descriptors.`,
        );
    }
    return rows;
}

/**
 * The `GPUBlendState` a descriptor names, whether it writes one inline or
 * names one of the states `blend-descriptors.ts` shares between the
 * families. A shared state is RESOLVED out of that module rather than
 * transcribed, so an upstream edit to a factor reaches both families.
 */
function blendState(
    context: LoweringContext,
    descriptor: ts.Expression,
    key: string,
): ts.ObjectLiteralExpression {
    const unwrapped = context.unwrapExpression(descriptor);
    if (ts.isIdentifier(unwrapped)) {
        return objectLiteral(
            context,
            context.variableInitializer(
                context.sourceFile(sharedStateModule),
                unwrapped.text,
            ),
            `shared blend state '${unwrapped.text}'`,
        );
    }
    return objectLiteral(context, unwrapped, `blend '${key}'`);
}

/** One side of a blend state, which the pin always writes as an add. */
function blendSide(
    context: LoweringContext,
    state: ts.ObjectLiteralExpression,
    side: "color" | "alpha",
    key: string,
): readonly [string, string] {
    const file = state.getSourceFile();
    const value = objectLiteral(
        context,
        context.propertyInitializer(state, side),
        `blend '${key}' ${side}`,
    );
    const factor = (field: string): string =>
        context.stringValue(
            context.propertyInitializer(value, field),
            file,
        );
    if (factor("operation") !== "add") {
        context.contractError(
            value,
            `Pinned blend '${key}' ${side} is not an add.`,
        );
    }
    return [factor("srcFactor"), factor("dstFactor")];
}

function objectLiteral(
    context: LoweringContext,
    expression: ts.Expression,
    what: string,
): ts.ObjectLiteralExpression {
    const unwrapped = context.unwrapExpression(expression);
    if (!ts.isObjectLiteralExpression(unwrapped)) {
        context.contractError(
            unwrapped,
            `Expected ${what} to be an object literal.`,
        );
    }
    return unwrapped;
}

/** A property the pin may legitimately omit. */
function optionalProperty(
    context: LoweringContext,
    literal: ts.ObjectLiteralExpression,
    name: string,
): ts.Expression | undefined {
    return literal.properties.find(
        (member): member is ts.PropertyAssignment =>
            ts.isPropertyAssignment(member) &&
            context.propertyName(member.name) === name,
    )?.initializer;
}

/**
 * The C++ factory a descriptor is emitted as, from the EXPORT name.
 *
 * Both the compiler (resolving `spriteBlendMultiply` at a call site) and the
 * lowerer (emitting its factory) need this name, and they run in different
 * phases. Deriving both from the export rather than from the pin's internal
 * `_key` — which upstream documents as a pipeline-cache discriminator, free
 * to change on its own — is what keeps them from agreeing by coincidence.
 */
export function blendFactorySymbol(exportName: string): string {
    const match = /^(sprite|billboard)Blend([A-Z].*)$/.exec(exportName);
    if (!match) {
        throw new Error(
            `'${exportName}' is not a pinned blend descriptor export.`,
        );
    }
    return `${match[1]}_blend_${match[2]!.toLowerCase()}`;
}

/**
 * A WebGPU blend factor, as this runtime's own enumerator. The pin writes
 * the WebGPU spelling; the record carries an enum, and a factor the pin
 * starts using that has no enumerator here fails generation rather than
 * silently picking a neighbour.
 */
export function nativeBlendFactor(factor: string): string {
    const known: Record<string, string> = {
        zero: "zero",
        one: "one",
        "src-alpha": "src_alpha",
        "one-minus-src-alpha": "one_minus_src_alpha",
        dst: "dst",
        "dst-alpha": "dst_alpha",
    };
    const mapped = known[factor];
    if (!mapped) {
        throw new Error(
            `Pinned blend uses factor '${factor}', which this runtime has no enumerator for.`,
        );
    }
    return mapped;
}

/** Whether an imported name is one of the pin's blend descriptors. */
export function isBlendExport(importedName: string): boolean {
    return /^(sprite|billboard)Blend[A-Z]/.test(importedName);
}
