/**
 * `src/math/compute-aabb.ts`, translated from its own declaration.
 *
 * The pinned `computeAabb` folds XYZ min/max over one flat positions
 * buffer, in JavaScript doubles, and guards its two arms on whether a
 * world matrix was supplied: the transforming arm the bounding-box cage
 * reaches, and the local arm every mesh-data fold reaches (a created
 * mesh's bounds, a line system's rewritten bounds, a morph target's delta
 * range). Both arms come out of the same pinned body here, so no consumer
 * carries a float restatement of the fold beside the lowered one.
 *
 * Numeric width is the pin's: the locals are doubles and the result is a
 * double pair. Each consumer rounds once where its own store rounds --
 * `geometry.bounds_min` is a float record, so a consumer casts at that
 * store and nowhere earlier -- which for a min/max over float inputs is
 * the same float the pin's `Float32Array`-fed fold would hand back.
 *
 * The positions container is the caller's: the pin walks
 * `positions[i]`/`positions.length`, so anything with `operator[]` and
 * `size()` over three lanes per point serves -- a `std::span<const float>`
 * over a flat buffer, or a view over records kept as `Vec3` (see
 * `positionsView`). A consumer that names a concrete type gets a plain
 * function; one that leaves it open gets a template over it.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";

export const COMPUTE_AABB_MODULE = "src/math/compute-aabb.ts";

/** The pin's `Aabb` return, as the double pair every consumer reads. */
export const COMPUTE_AABB_RESULT = "std::array<std::array<double, 3>, 2>";

export interface ComputeAabbLowering {
    /** Which of the pinned guard's two arms the emitted function is. */
    arm: "world" | "local";
    cppName: string;
    /**
     * The positions container's C++ type. Omitted, the function is a
     * template over it, which is what a header shared by every consumer
     * emits.
     */
    positionsType?: string;
    /** Emit `inline` -- for a function landing in a generated header. */
    inline?: boolean;
}

/**
 * One arm of the pinned `computeAabb`, as a C++ function.
 *
 * The guard is located and asserted rather than assumed, and the arm the
 * caller named is spliced in place of the whole `if`, so a pin that stops
 * guarding on the world matrix -- or that grows a third arm -- fails
 * generation instead of leaving this port describing a fold upstream no
 * longer performs. The statements around the guard (the infinities the
 * fold starts from, the pair it returns) translate as they are.
 */
export function lowerComputeAabb(
    context: LoweringContext,
    options: ComputeAabbLowering,
): string {
    const at = context.functionDeclaration(COMPUTE_AABB_MODULE, "computeAabb").declaration;
    return lowerPinnedFunction(context, COMPUTE_AABB_MODULE, "computeAabb", [
        { pinned: "positions", kind: "f32Buffer", cpp: "positions",
            cppType: options.positionsType ?? "Positions", binding: { cpp: "positions", type: "scalar" } },
        { pinned: "world", kind: "mat4Const", cpp: "world", optional: true,
            ...(options.arm === "local" ? { absent: true } : {}),
            binding: { cpp: "world", type: "scalar" } },
    ], {
        cppName: options.cppName,
        ...(options.inline ? { inline: true } : {}),
        ...(!options.positionsType ? { templateParameters: ["typename Positions"] } : {}),
        armOf: { condition: "world", arm: options.arm === "world" ? "then" : "else" },
        memberBindings: new Map([["positions.length",
            { cpp: "static_cast<std::int64_t>(positions.size())", type: "scalar" }]]),
        returns: {
            type: COMPUTE_AABB_RESULT,
            value: (lowerer, expression) => {
                const returned = expression ? context.unwrapExpression(expression) : undefined;
                if (!returned || !ts.isArrayLiteralExpression(returned) || returned.elements.length !== 2) {
                    return context.contractError(at, "Expected pinned computeAabb to return a min/max pair.");
                }
                const rows = returned.elements.map(row => {
                    const literal = context.unwrapExpression(row);
                    if (!ts.isArrayLiteralExpression(literal) || literal.elements.length !== 3) {
                        return context.contractError(at, "Expected each pinned AABB corner to have three components.");
                    }
                    return "{" + literal.elements.map(element => lowerer.expression(element)).join(", ") + "}";
                });
                return COMPUTE_AABB_RESULT + "{{" + rows.join(", ") + "}}";
            },
        },
    });
}

/**
 * The pin's flat `Float32Array` walk over records this port keeps whole.
 *
 * Upstream a mesh's positions -- and a morph target's deltas -- are one
 * flat buffer the fold reads three lanes at a time; here they are model
 * vertices or `Vec3`s, so the same walk reads through a view rather than
 * through a copy built per fold. `position` spells the record's XYZ lanes
 * off `local`, the name one element takes inside the view.
 */
export function positionsView(view: {
    name: string;
    element: string;
    member: string;
    local: string;
    position: string;
}): string {
    return `struct ${view.name} {
    const std::vector<${view.element}>* ${view.member} = nullptr;
    double operator[](std::size_t index) const {
        const ${view.element}& ${view.local} = (*${view.member})[index / 3u];
        const std::size_t lane = index % 3u;
        return lane == 0u
            ? static_cast<double>(${view.position}.x)
            : lane == 1u
                ? static_cast<double>(${view.position}.y)
                : static_cast<double>(${view.position}.z);
    }
    std::size_t size() const { return ${view.member}->size() * 3u; }
};`;
}

/**
 * Both arms of the pinned fold as one header, for the tree to carry once
 * beside the other `pinned_*.hpp` translations: `compute_aabb(positions)`
 * and `compute_aabb(positions, world)`, each a template over the
 * positions container.
 */
export function pinnedComputeAabbHeader(context: LoweringContext): string {
    const local = lowerComputeAabb(context, {
        arm: "local",
        cppName: "compute_aabb",
        inline: true,
    });
    const world = lowerComputeAabb(context, {
        arm: "world",
        cppName: "compute_aabb",
        inline: true,
    });
    return pinnedHeader(["<array>","<cstddef>","<cstdint>","<limits>"], `
${local}

${world}
`);
}
