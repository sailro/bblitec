import ts from "typescript";
import type { LoweringContext } from "./context.js";

const POOL_MODULE = "src/resource/texture-sampler-pool.ts";
const SAMPLER_MODULE = "src/resource/sampler-pool.ts";

/**
 * What `getOrCreateSampler` keys a pooled sampler by
 * (`resource/sampler-pool.ts` over `resource/texture-sampler-pool.ts`): each
 * descriptor field's default, and the comparison and LOD clamps the general
 * boundary adds. Two descriptors with one key are one sampler.
 */
export interface PinnedSamplerKey {
    /** `textureSamplerDefaults`, in the pool's key order. */
    readonly defaults: ReadonlyMap<string, string | number>;
    readonly lodMinClamp: number;
    readonly lodMaxClamp: number;
}

const keys = new WeakMap<LoweringContext, PinnedSamplerKey>();

/** The pool's key, read from the pin once per lowering context. */
export function pinnedSamplerKey(context: LoweringContext): PinnedSamplerKey {
    let key = keys.get(context);
    if (!key) keys.set(context, (key = readPinnedSamplerKey(context)));
    return key;
}

function readPinnedSamplerKey(context: LoweringContext): PinnedSamplerKey {
    const file = context.sourceFile(POOL_MODULE);
    const literal = context.unwrapExpression(
        context.variableInitializer(file, "textureSamplerDefaults"),
    );
    if (!ts.isObjectLiteralExpression(literal))
        return context.contractError(
            literal,
            "Expected the sampler pool's defaults as an object literal.",
        );
    const value = (expression: ts.Expression): string | number => {
        const unwrapped = context.unwrapExpression(expression);
        if (ts.isIdentifier(unwrapped))
            return value(context.variableInitializer(file, unwrapped.text));
        return ts.isNumericLiteral(unwrapped)
            ? context.numericValue(unwrapped, file)
            : context.stringValue(unwrapped, file);
    };
    const defaults = new Map<string, string | number>();
    for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property))
            return context.contractError(
                property,
                "Expected the sampler pool's defaults as plain properties.",
            );
        const name = context.propertyName(property.name);
        if (name === undefined)
            return context.contractError(
                property,
                "Expected the sampler pool's defaults under plain names.",
            );
        defaults.set(name, value(property.initializer));
    }
    // The general boundary's clamps: what it keys beyond the pool's fields.
    context.assertFunctionContract(
        SAMPLER_MODULE,
        "getOrCreateSampler",
        `
        export function getOrCreateSampler(engine: EngineContext, descriptor: GPUSamplerDescriptor = {}): GPUSampler {
            const compare = descriptor.compare;
            const minLod = descriptor.lodMinClamp ?? 0;
            const maxLod = descriptor.lodMaxClamp ?? 32;
            const extraKey = compare !== undefined || minLod !== 0 || maxLod !== 32 ? \`\${compare ?? ""}:\${minLod}:\${maxLod}\` : "";
            return getPooledSampler(engine, descriptor, extraKey);
        }
    `,
        "sampler pool key",
    );
    const general = context.functionDeclaration(
        SAMPLER_MODULE,
        "getOrCreateSampler",
    ).declaration;
    // `descriptor.lodXClamp ?? <default>`: the default the key compares to.
    const clamp = (name: string): number => {
        const initializer = context.unwrapExpression(
            context.variableInitializer(general, name),
        );
        return ts.isBinaryExpression(initializer)
            ? context.numericValue(initializer.right, general.getSourceFile())
            : context.contractError(
                  initializer,
                  `Expected the sampler key's ${name} default.`,
              );
    };
    return {
        defaults,
        lodMinClamp: clamp("minLod"),
        lodMaxClamp: clamp("maxLod"),
    };
}
