import ts from "typescript";
import type { LoweringContext } from "./context.js";

const POOL_MODULE = "src/resource/texture-sampler-pool.ts";
const SAMPLER_MODULE = "src/resource/sampler-pool.ts";

/**
 * What `getOrCreateSampler` keys a pooled sampler by
 * (`resource/sampler-pool.ts` over `resource/texture-sampler-pool.ts`): the
 * comparison and LOD clamps the general boundary adds, then each
 * `textureSamplerDefaults` field. Two descriptors with one key are one
 * sampler.
 */
export interface PinnedSamplerKey {
    /**
     * Every descriptor member the key reads, with the default it reads for
     * an absent one; `compare` has none.
     */
    readonly members: ReadonlyMap<string, string | number | undefined>;
    /**
     * `samplerKey(descriptor)`: the general boundary's statements and the
     * pool's key loop unrolled over its defaults, returning the key.
     */
    readonly keyFunction: ts.FunctionDeclaration;
}

const keys = new WeakMap<LoweringContext, PinnedSamplerKey>();

/** The pool's key, read from the pin once per lowering context. */
export function pinnedSamplerKey(context: LoweringContext): PinnedSamplerKey {
    let key = keys.get(context);
    if (!key) keys.set(context, (key = readPinnedSamplerKey(context)));
    return key;
}

function readPinnedSamplerKey(context: LoweringContext): PinnedSamplerKey {
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
    const members = new Map<string, string | number | undefined>();
    // What the extra key reads: the contract spells each read as
    // `descriptor.<member>` or `descriptor.<member> ?? <default>`.
    for (const statement of general.body!.statements)
        for (const variable of ts.isVariableStatement(statement)
            ? statement.declarationList.declarations
            : []) {
            const initializer = context.unwrapExpression(variable.initializer!);
            const [read, fallback] = ts.isBinaryExpression(initializer)
                ? [initializer.left, initializer.right]
                : [initializer, undefined];
            if (
                ts.isPropertyAccessExpression(read) &&
                context.expressionMatchesShape(read.expression, "descriptor")
            )
                members.set(
                    read.name.text,
                    fallback &&
                        context.numericValue(fallback, general.getSourceFile()),
                );
        }

    const file = context.sourceFile(POOL_MODULE);
    const table = context.unwrapExpression(
        context.variableInitializer(file, "textureSamplerDefaults"),
    );
    if (!ts.isObjectLiteralExpression(table))
        return context.contractError(
            table,
            "Expected the sampler pool's defaults as an object literal.",
        );
    const literal = (expression: ts.Expression): ts.Expression => {
        const unwrapped = context.unwrapExpression(expression);
        return ts.isIdentifier(unwrapped)
            ? literal(context.variableInitializer(file, unwrapped.text))
            : unwrapped;
    };
    const defaults = table.properties.map((property) => {
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
        const value = literal(property.initializer);
        members.set(
            name,
            ts.isNumericLiteral(value)
                ? context.numericValue(value, file)
                : context.stringValue(value, file),
        );
        return { name, value };
    });

    // The pool's key: `let key = extraKey;`, then one `key += ...` per field.
    const pool = context.functionDeclaration(
        POOL_MODULE,
        "getOrCreateSampler",
    ).declaration;
    const loop = pool.body!.statements.find(ts.isForInStatement);
    if (!loop)
        return context.contractError(
            pool,
            "Expected sampler defaults key loop.",
        );
    context.assertExpressionShape(
        loop.expression,
        "textureSamplerDefaults",
        "Sampler key fields",
    );
    const keyStatement = pool.body!.statements.find(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
                (variable) =>
                    ts.isIdentifier(variable.name) &&
                    variable.name.text === "key",
            ),
    );
    if (!keyStatement)
        return context.contractError(
            pool,
            "Expected sampler key initialization.",
        );
    const loopStatements = ts.isBlock(loop.statement)
        ? loop.statement.statements
        : [loop.statement];
    const [alias, accumulation] = loopStatements;
    if (
        loopStatements.length !== 2 ||
        !alias ||
        !ts.isVariableStatement(alias) ||
        !accumulation
    )
        return context.contractError(
            loop,
            "Expected field alias and key accumulation.",
        );
    context.assertExpressionShape(
        alias.declarationList.declarations[0]!.initializer!,
        "property as keyof typeof textureSamplerDefaults",
        "Sampler key field alias",
    );
    const printed = [
        ...general
            .body!.statements.slice(0, -1)
            .map((statement) => statement.getText()),
        keyStatement.getText(),
    ];
    for (const { name, value } of defaults) {
        // `descriptor[field] ?? textureSamplerDefaults[field]` at this field.
        const result = ts.transform(accumulation, [
            (transformation) => (root) => {
                const visit: ts.Visitor = (node) => {
                    if (
                        ts.isElementAccessExpression(node) &&
                        context.expressionMatchesShape(
                            node.argumentExpression,
                            "field",
                        )
                    ) {
                        if (
                            context.expressionMatchesShape(
                                node.expression,
                                "textureSamplerDefaults",
                            )
                        )
                            return value;
                        if (
                            context.expressionMatchesShape(
                                node.expression,
                                "descriptor",
                            )
                        )
                            return ts.factory.updateElementAccessExpression(
                                node,
                                node.expression,
                                ts.factory.createStringLiteral(name),
                            );
                    }
                    return ts.visitEachChild(node, visit, transformation);
                };
                return ts.visitNode(root, visit, ts.isStatement)!;
            },
        ]);
        printed.push(
            ts
                .createPrinter()
                .printNode(
                    ts.EmitHint.Unspecified,
                    result.transformed[0]!,
                    file,
                ),
        );
        result.dispose();
    }
    const keyFile = ts.createSourceFile(
        SAMPLER_MODULE,
        `function samplerKey(descriptor) { ${printed.join("\n")} return key; }`,
        ts.ScriptTarget.Latest,
        true,
    );
    const keyFunction = keyFile.statements[0];
    if (!keyFunction || !ts.isFunctionDeclaration(keyFunction))
        throw new Error("Invalid specialized sampler key.");
    return { members, keyFunction };
}
