import ts from "typescript";
import type { LoweringContext } from "./context.js";

/**
 * A pinned blend descriptor, as the native factory emitted for it.
 *
 * `enabled` is false for a descriptor that names no `_descriptor`, which
 * upstream documents as "no colour blend". That alone does not say what the
 * mode means: for the 2D family it is the opaque replacement, and for the
 * billboard family it is the alpha-test cutout that ALSO writes depth. The
 * pin distinguishes them with `_depthMode`, a required field on
 * `BillboardBlendDescriptor` that `SpriteBlendDescriptor` does not have —
 * so the row carries it and the caller refuses on the pin's own field rather
 * than on a descriptor's name.
 */
export interface PinnedBlendRow {
    exportName: string;
    enabled: boolean;
    /** The pin's `_depthMode`, where the family declares one. */
    depthMode?: string;
    /** Absent when the descriptor names no colour blend. */
    color?: readonly [string, string];
    alpha?: readonly [string, string];
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
            const depthMode = optionalProperty(
                context,
                literal,
                "_depthMode",
            );
            rows.push({
                exportName: binding.name.text,
                enabled: state !== undefined,
                ...(depthMode
                    ? {
                          depthMode: context.stringValue(
                              depthMode,
                              file,
                          ),
                      }
                    : {}),
                ...(state
                    ? {
                          color: blendSide(context, state, "color", key),
                          alpha: blendSide(context, state, "alpha", key),
                      }
                    : {}),
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
 * The pinned blend modes, as the C++ factories scene code reaches when it
 * names a descriptor at a call site.
 *
 * Emitted once for both families: a factory that differs by family is a
 * factory that drifts, and the two templates had already disagreed on
 * whether `enabled` was written from the row or hard-coded.
 */
export function blendFactoriesCpp(
    rows: readonly PinnedBlendRow[],
    family: string,
    moduleName: string,
): string {
    return rows
        .map(
            (row) => `inline SpriteBlendDescriptor ${blendFactorySymbol(
                family,
                row.exportName,
            )}() {
    // ${moduleName}#${row.exportName}.
    SpriteBlendDescriptor blend;
    blend.enabled = ${row.enabled};${
        row.depthMode
            ? `
    blend.depth_mode = BillboardDepthMode::${row.depthMode.replace("-", "_")};`
            : ""
    }${
        row.color && row.alpha
            ? `
    blend.color.src = SpriteBlendFactor::${nativeBlendFactor(row.color[0])};
    blend.color.dst = SpriteBlendFactor::${nativeBlendFactor(row.color[1])};
    blend.alpha.src = SpriteBlendFactor::${nativeBlendFactor(row.alpha[0])};
    blend.alpha.dst = SpriteBlendFactor::${nativeBlendFactor(row.alpha[1])};`
            : ""
    }
    blend.premultiplied_opacity = ${row.premultipliedOpacity};
    return blend;
}
`,
        )
        .join("\n");
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
export function blendFactorySymbol(
    family: string,
    exportName: string,
): string {
    const suffix = exportName.slice(`${family}Blend`.length);
    return `${family}_blend_${suffix.toLowerCase()}`;
}

/**
 * The family and native symbol an imported descriptor names, or undefined
 * when the name is not one. The family is returned rather than re-tested at
 * each call site, because a 2D descriptor passed to a billboard system (or
 * the reverse) is a real mistake that no call site was checking for.
 */
export function parseBlendExport(
    importedName: string,
): { family: string; mode: string; symbol: string } | undefined {
    const match = /^([a-z]+)Blend([A-Z].*)$/.exec(importedName);
    if (!match) {
        return undefined;
    }
    const family = match[1]!;
    return {
        family,
        mode: match[2]!.toLowerCase(),
        symbol: blendFactorySymbol(family, importedName),
    };
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

