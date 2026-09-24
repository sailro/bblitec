import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { lowerObjectComponents } from "./pinned-function-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const boundsModule = "src/mesh/mesh-world-bounds.ts";

/**
 * The `WorldAabbAcc` keys in the pin's own order, read off the literal
 * `emptyWorldAabb` returns. The native accumulator stores them as lanes of
 * one double array, so a key is its lane index.
 */
function accumulatorLanes(context: LoweringContext): string[] {
    const { declaration } = context.functionDeclaration(
        boundsModule,
        "emptyWorldAabb",
    );
    return context
        .returnObject(declaration)
        .properties.map(
            (property) =>
                context.propertyName(property.name!) ??
                context.contractError(
                    property,
                    "Expected a named accumulator key.",
                ),
        );
}

/** The lane one accumulator key occupies among `lanes`. */
function accumulatorLane(
    context: LoweringContext,
    lanes: readonly string[],
    key: string,
): number {
    const lane = lanes.indexOf(key);
    if (lane < 0)
        context.contractError(
            context.functionDeclaration(boundsModule, "emptyWorldAabb")
                .declaration,
            `Expected the world accumulator to carry '${key}'.`,
        );
    return lane;
}

/**
 * Statements copying a caller's `minimum`/`maximum` x-y-z arrays into the
 * accumulator `acc` (`load`) and back (`store`).
 */
export function worldAabbArrayCopies(
    context: LoweringContext,
    minimum: string,
    maximum: string,
    indent = "    ",
): { load: string; store: string } {
    const keys = accumulatorLanes(context);
    const lanes = (["X", "Y", "Z"] as const).flatMap((axis, index) =>
        (
            [
                ["min", minimum],
                ["max", maximum],
            ] as const
        ).map(
            ([side, array]) =>
                [
                    accumulatorLane(context, keys, `${side}${axis}`),
                    `${array}[${index}]`,
                ] as const,
        ),
    );
    return {
        load: lanes
            .map(([lane, value]) => `${indent}acc[${lane}] = ${value};`)
            .join("\n"),
        store: lanes
            .map(([lane, value]) => `${indent}${value} = acc[${lane}];`)
            .join("\n"),
    };
}

/** The C++ lane read of one accumulator key, as a caller binds `acc.minX`. */
export function worldAabbLaneBindings(
    context: LoweringContext,
    accumulator: string,
    cpp: string,
): [string, PinnedBinding][] {
    return accumulatorLanes(context).map((key, lane) => [
        `${accumulator}.${key}`,
        { cpp: `${cpp}[${lane}]`, type: "scalar" },
    ]);
}

/**
 * `src/mesh/mesh-world-bounds.ts` lowered whole for a translation unit that
 * frames or sizes a scene: `emptyWorldAabb`, `addRange` and
 * `expandWorldAabbForMesh`, in JavaScript-number width over the pin's
 * Float32Array boxes and world matrix. `WorldAabbMesh` carries the three
 * `Mesh` members the expansion reads; each caller fills it from its native
 * record. Emitted into an anonymous namespace by every unit that needs it;
 * `emptyAccumulator` adds `emptyWorldAabb` for a unit that seeds its own.
 *
 * `mesh._expandWorldBounds` is the thin-instance hook
 * `enableThinInstanceWorldBounds` installs. No native record carries one:
 * the glTF GPU-instancing feature runs the pinned expansion at generation
 * and bakes the expanded world box into the loaded geometry, and scene code
 * cannot reach the public enabler.
 */
export function lowerWorldAabbHelpers(
    context: LoweringContext,
    options: { emptyAccumulator: boolean },
): string {
    const lanes = accumulatorLanes(context);
    const body = (
        symbol: string,
        bindings: ReadonlyMap<string, PinnedBinding>,
        extra: {
            calls?: ReadonlyMap<string, (args: readonly string[]) => string>;
            returns?: (
                node: ts.Expression | undefined,
                lowerer: PinnedNumericLowerer,
            ) => string;
            laneKeys?: true;
        } = {},
    ): string => {
        const { file, declaration } = context.functionDeclaration(
            boundsModule,
            symbol,
        );
        const parameters = declaration.parameters.map((parameter) =>
            parameter.name.getText(file),
        );
        const unbound = parameters.filter((name) => !bindings.has(name));
        if (unbound.length > 0)
            context.contractError(
                declaration,
                `Unbound pinned ${symbol} parameter(s): ${unbound.join(", ")}.`,
            );
        // `const center = [a, b, c]`: a fixed list of numbers the body only
        // indexes, held at the JavaScript-number width it was computed at.
        const scope = new Map(bindings);
        const fixedLists = new Map<string, ts.ArrayLiteralExpression>();
        for (const statement of declaration.body!.statements) {
            if (
                !ts.isVariableStatement(statement) ||
                (statement.declarationList.flags & ts.NodeFlags.Const) === 0
            )
                continue;
            for (const local of statement.declarationList.declarations) {
                const literal = local.initializer
                    ? context.unwrapExpression(local.initializer)
                    : undefined;
                if (
                    ts.isIdentifier(local.name) &&
                    literal &&
                    ts.isArrayLiteralExpression(literal) &&
                    literal.elements.length > 0
                ) {
                    fixedLists.set(local.name.text, literal);
                    scope.set(local.name.text, {
                        cpp: local.name.text,
                        type: "f64-buffer",
                    });
                }
            }
        }
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: scope,
            calls: extra.calls ?? new Map(),
            booleanOr: true,
            statement: (statement, lowerer, indent) => {
                if (
                    !ts.isVariableStatement(statement) ||
                    statement.declarationList.declarations.length !== 1
                )
                    return undefined;
                const [local] = statement.declarationList.declarations;
                const literal =
                    local && ts.isIdentifier(local.name)
                        ? fixedLists.get(local.name.text)
                        : undefined;
                if (!literal) return undefined;
                return [
                    `${indent}const std::array<double, ${literal.elements.length}> ${local!.name.getText(file)}{${literal.elements
                        .map((element) => lowerer.expression(element))
                        .join(", ")}};`,
                ];
            },
            ...(extra.returns ? { returnValue: extra.returns } : {}),
            ...(extra.laneKeys
                ? {
                      expression: (node: ts.Expression) => {
                          if (!ts.isStringLiteral(node)) return undefined;
                          const lane = lanes.indexOf(node.text);
                          if (lane < 0)
                              context.contractError(
                                  node,
                                  `Unknown accumulator key '${node.text}'.`,
                              );
                          return context.doubleLiteral(lane);
                      },
                  }
                : {}),
        });
    };
    const accumulator: [string, PinnedBinding] = [
        "acc",
        { cpp: "acc", type: "f64-buffer" },
    ];
    const scalar = (name: string): [string, PinnedBinding] => [
        name,
        { cpp: name, type: "scalar" },
    ];
    const bound = (member: string, cpp: string): [string, PinnedBinding] => [
        `mesh.${member}`,
        {
            cpp: `(*mesh.${cpp})`,
            type: "f32",
            absentCpp: `!mesh.${cpp}.has_value()`,
        },
    ];
    const empty = body("emptyWorldAabb", new Map(), {
        returns: (node, lowerer) =>
            `WorldAabb{${lowerObjectComponents(
                context,
                lowerer,
                node ??
                    context.contractError(
                        context.functionDeclaration(
                            boundsModule,
                            "emptyWorldAabb",
                        ).declaration,
                        "Expected emptyWorldAabb to return its accumulator.",
                    ),
                lanes,
            ).join(", ")}}`,
    });
    const addRange = body(
        "addRange",
        new Map([
            accumulator,
            scalar("axis"),
            scalar("center"),
            scalar("radius"),
        ]),
        { laneKeys: true },
    );
    const expand = body(
        "expandWorldAabbForMesh",
        new Map<string, PinnedBinding>([
            accumulator,
            ["mesh", { cpp: "mesh", type: "opaque" }],
            bound("boundMin", "bound_min"),
            bound("boundMax", "bound_max"),
            [
                "mesh._expandWorldBounds !== undefined",
                { cpp: "false", type: "bool", staticBoolean: false },
            ],
            ["mesh.worldMatrix", { cpp: "mesh.world_matrix", type: "f32" }],
        ]),
        {
            calls: new Map([
                ...pinnedNumericMathCalls(),
                [
                    "addRange",
                    (args: readonly string[]) =>
                        `world_aabb_add_range(${args.join(", ")})`,
                ],
            ]),
        },
    );
    const symbols = [
        ...(options.emptyAccumulator ? ["emptyWorldAabb"] : []),
        "addRange",
        "expandWorldAabbForMesh",
    ];
    return `// ${context.provenance(boundsModule, symbols.join(", "))}
// The accumulator's keys (${lanes.join(", ")}) are lanes of one array.
using WorldAabb = std::array<double, ${lanes.length}>;

// The Mesh members expandWorldAabbForMesh reads: its object-local
// Float32Array box, absent for a mesh without bounds, and its world matrix.
struct WorldAabbMesh {
    std::optional<std::array<float, 3>> bound_min;
    std::optional<std::array<float, 3>> bound_max;
    std::array<float, 16> world_matrix{};
};

${
    options.emptyAccumulator
        ? `WorldAabb empty_world_aabb() {
${empty}
}

`
        : ""
}void world_aabb_add_range(WorldAabb& acc, double axis, double center, double radius) {
${addRange}
}

void expand_world_aabb_for_mesh(WorldAabb& acc, const WorldAabbMesh& mesh) {
${expand}
}`;
}
