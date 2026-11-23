import ts from "typescript";
import { conditionalExpression, selectionArms } from "../compiler/syntax.js";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

const modulePath = "src/shadow/thin-instance-shadow-bounds.ts";

/** Lower the shared cache predicate, active-row fit and cache publication. The
 * native mesh owns its WeakMap entry; the collector consumes a valid result
 * once, before either directional fitter walks the prepared casters. */
export function lowerShadowCasterBounds(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        "getShadowCasterWorldBounds",
    );
    const statements = [...declaration.body!.statements];
    const [
        ti,
        matrices,
        version,
        count,
        worldVersion,
        min,
        max,
        cacheInit,
        lookup,
        hit,
        allocate,
        bounds,
        ...kernel
    ] = statements;
    context.assertStatementShapes(
        declaration,
        [ti!, matrices!, version!],
        "const ti = mesh.thinInstances; const matrices = ti?.matrices; const version = ti?._version ?? 0;",
        "Shadow instance inputs",
    );
    context.assertStatementShapes(
        declaration,
        [worldVersion!, min!, max!, cacheInit!, lookup!],
        "const worldVersion = mesh.worldMatrixVersion; const min = mesh.boundMin ?? DEFAULT_MIN; const max = mesh.boundMax ?? DEFAULT_MAX; cache ??= new WeakMap(); let entry = cache.get(mesh);",
        "Shadow cache lookup",
    );
    // A new native cache is value-initialized. None of its lanes are
    // observable before the first miss fills the bounds and publishes the key.
    context.assertStatementShapes(
        declaration,
        [allocate!, bounds!],
        `
        if (!entry) {
            entry = { _version: version, _worldVersion: worldVersion, _matrices: matrices, _count: count,
                _localBounds: [0, 0, 0, 0, 0, 0], _bounds: {min:[0,0,0], max:[0,0,0]} };
            cache.set(mesh, entry);
        } const bounds = entry._bounds;`,
        "Shadow cache entry",
    );
    const proxy = context.functionDeclaration(
        modulePath,
        "getDirectionalShadowCaster",
    ).declaration;
    context.assertStatementShapes(
        proxy,
        proxy.body!.statements,
        `
        if (!mesh.thinInstances) {return mesh;}
        const bounds = getShadowCasterWorldBounds(mesh);
        return bounds ? (bounds._fitCaster ??= {worldMatrix: IDENTITY_WORLD, boundMin: bounds.min, boundMax: bounds.max}) : null;`,
        "Directional fit proxy",
    );
    const fitter = context.functionDeclaration(
        "src/shadow/shadow-base.ts",
        "computeDirectionalLightMatrix",
    ).declaration;
    for (const [name, fallback] of [
        ["boundMin", "DEFAULT_MIN"],
        ["boundMax", "DEFAULT_MAX"],
    ] as const) {
        const fit = context.variableInitializer(fitter, name);
        if (!ts.isBinaryExpression(fit))
            return context.contractError(
                fit,
                "Expected a directional mesh bound fallback.",
            );
        context.assertExpressionShape(
            fit,
            `caster.${name} ?? ${context.unwrapExpression(context.variableInitializer(file, fallback)).getText()}`,
            "Shared shadow bound fallback",
        );
    }
    const identity = context.variableInitializer(file, "IDENTITY_WORLD");
    if (
        !ts.isNewExpression(identity) ||
        !identity.arguments?.[0] ||
        !ts.isArrayLiteralExpression(identity.arguments[0]) ||
        identity.arguments[0].elements.length !== 16
    )
        return context.contractError(
            identity,
            "Expected the directional caster's identity matrix.",
        );
    const identityLanes = identity.arguments[0].elements.map((lane) =>
        context.doubleLiteral(context.numericValue(lane, file)),
    );
    const bindings = new Map<string, PinnedBinding>([
        ["ti", { cpp: "pool != nullptr", type: "bool" }],
        ["ti.count", { cpp: "pool->count", type: "scalar" }],
        [
            "matrices",
            {
                cpp: "matrices",
                type: "f64-buffer",
                absentCpp: "pool == nullptr",
                indexedRead: (owner, index) =>
                    `${owner}.load(static_cast<std::size_t>(${index}))`,
            },
        ],
        ["version", { cpp: "version", type: "scalar" }],
        ["worldVersion", { cpp: "world_version", type: "scalar" }],
        ["min", { cpp: "caster.bounds_min", type: "f64-buffer" }],
        ["max", { cpp: "caster.bounds_max", type: "f64-buffer" }],
        ["mesh.worldMatrix", { cpp: "caster.world", type: "f64-buffer" }],
        ["entry", { cpp: "cache.valid", type: "bool" }],
        ["entry._version", { cpp: "cache.version", type: "scalar" }],
        ["entry._worldVersion", { cpp: "cache.world_version", type: "scalar" }],
        ["entry._count", { cpp: "cache.count", type: "scalar" }],
        ["entry._matrices", { cpp: "cache.matrices", type: "f64-buffer" }],
        [
            "entry._localBounds",
            { cpp: "cache.local_bounds", type: "f64-buffer" },
        ],
        ...["min", "max"].flatMap((lane): [string, PinnedBinding][] =>
            ["bounds", "entry._bounds"].map((prefix) => [
                `${prefix}.${lane}`,
                { cpp: `cache.${lane}`, type: "f64-buffer" },
            ]),
        ),
    ]);
    const body = lowerPinnedBody(
        file,
        [count!, hit!, ...kernel],
        {
            bindings,
            calls: new Map([
                ["bounds.min.fill", ([v]) => `cache.min.fill(${v})`],
                ["bounds.max.fill", ([v]) => `cache.max.fill(${v})`],
            ]),
            expression(node) {
                if (
                    ts.isBinaryExpression(node) &&
                    context.expressionMatchesShape(
                        node,
                        "entry._matrices === matrices",
                    )
                )
                    return "(cache.matrices.identity() == matrices.identity())";
                return undefined;
            },
            statement(stmt, lowerer, indent) {
                if (
                    ts.isExpressionStatement(stmt) &&
                    context.expressionMatchesShape(
                        stmt.expression,
                        "entry._matrices = matrices",
                    )
                )
                    return [
                        `${indent}cache.matrices = js::NumericArrayView(matrices);`,
                    ];
                if (!ts.isReturnStatement(stmt)) return undefined;
                const selection =
                    stmt.expression && conditionalExpression(stmt.expression);
                const arms = selection && selectionArms(selection);
                if (
                    !selection ||
                    !arms ||
                    !(
                        context.expressionMatchesShape(
                            arms[0],
                            "entry._bounds",
                        ) || context.expressionMatchesShape(arms[0], "bounds")
                    ) ||
                    arms[1].kind !== ts.SyntaxKind.NullKeyword
                )
                    return context.contractError(
                        stmt,
                        "Expected valid shadow bounds or null.",
                    );
                return [
                    `${indent}return ${lowerer.expression(selection.condition)};`,
                ];
            },
        },
        "        ",
    );
    return `// ${context.provenance(modulePath, "getShadowCasterWorldBounds")}
struct ShadowBoundsCache {
    MeshHandle owner{};
    bool valid = false;
    double version{}, world_version{}, count{};
    js::NumericArrayView matrices;
    std::array<double, 6> local_bounds{};
    std::array<double, 3> min{}, max{};
};

inline bool fit_shadow_caster_world_bounds(ShadowCaster& caster, const ThinInstancePoolData* pool,
                                           double world_version, ShadowBoundsCache& cache) {
    const double version = pool ? pool->version : 0.0;
    const auto update = [&](const auto& matrices) {
${body}
    };
    const bool finite = pool ? std::visit(update, pool->matrices) : update(js::NumericArrayView{});
    cache.valid = true;
    if (!finite) return false;
    // ${context.provenance(modulePath, "getDirectionalShadowCaster")}
    caster.world = {${identityLanes.join(", ")}};
    caster.bounds_min = cache.min;
    caster.bounds_max = cache.max;
    return true;
}`;
}
