/**
 * A `MeshRecord`'s local world matrix, emitted from the pin's own
 * writers: `src/math/quat-euler.ts`'s `eulerToQuat` and
 * `src/math/mat4-compose-into.ts`'s `mat4ComposeInto`, term for term.
 *
 * Four emissions consume it, and they are the places a record's transform
 * has to leave that record as a matrix: the thin-instance parent world the
 * vertex stage reads, the navmesh merge (which multiplies each caster's CPU
 * positions through `mesh.worldMatrix` the way the pinned `_mergeMeshes`
 * does), the shadow caster's AABB corners, and a Gaussian-splat cloud's own
 * world. One home so they cannot drift apart while all claim to be the
 * pin's composition -- which is also why the narrowing tail all four share
 * is emitted here rather than four times.
 *
 * The glTF loader emits a third composition of the same pinned writer
 * (`gltf/matrix-leaves.ts`'s `trs_matrix`), and it is deliberately not
 * this one: it takes a node's TRS as arguments rather than a
 * `MeshRecord`, and accumulates in float where these two accumulate in
 * JS-double width. Converging them would move the loader's bytes.
 */
import ts from "typescript";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

/**
 * The whole emitted body, from the quaternion locals through the last
 * matrix cell, leaving `std::array<double, 16> local` composed and named.
 *
 * It is one string rather than the four fragments it is built from
 * because the frame around them is not a caller's choice: the fragments
 * name `mesh.rotation.x`, `scale_x` and `local[N]` directly, so the
 * declarations and the Euler-versus-quaternion selection that give them
 * meaning only fit one shape. Handing out the fragments would leave that
 * shape written once per consumer — which is the drift this file exists
 * to prevent. A consumer supplies only its own signature and whatever it
 * does with `local` afterwards.
 */
export interface PinnedTrsComposition {
    composeLocalBody: string;
    /**
     * The same composition, narrowed to the `std::array<float, 16>` every
     * consumer actually wants: `composeLocalBody` leaves `local` at the
     * pin's own JS-double width, and each consumer used to write the same
     * sixteen-cell store loop after it.
     */
    composeWorldBody: string;
}

/**
 * Prints one pinned arithmetic expression as C++, renaming identifiers
 * through a required map: double operands, explicit parenthesization, and
 * an identifier or operator the map does not know fails generation
 * instead of drifting.
 */
function pinnedNumericExpression(
    file: ts.SourceFile,
    expression: ts.Expression,
    rename: ReadonlyMap<string, string>,
    calls: ReadonlyMap<
        string,
        (args: readonly string[]) => string
    > = new Map(),
): string {
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map(
            [...rename].map(
                ([name, cpp]): [string, PinnedBinding] => [
                    name,
                    { cpp, type: "scalar" },
                ],
            ),
        ),
        calls,
    });
    return lowerer.expression(expression);
}

function pinnedStoreOffset(
    context: LoweringContext,
    argument: ts.Expression,
    base: string,
): number {
    const unwrapped = context.unwrapExpression(argument);
    if (ts.isIdentifier(unwrapped) && unwrapped.text === base) {
        return 0;
    }
    if (
        ts.isBinaryExpression(unwrapped) &&
        unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        ts.isIdentifier(unwrapped.left) &&
        unwrapped.left.text === base &&
        ts.isNumericLiteral(unwrapped.right)
    ) {
        return Number(unwrapped.right.text);
    }
    return context.contractError(
        argument,
        `Expected a '${base}'-relative store offset.`,
    );
}

export function pinnedTrsComposition(
    context: LoweringContext,
    /**
     * The record the composition reads its TRS out of. A transform node
     * carries the same lanes a mesh does, because upstream they are one
     * type: `TransformNode` is a pure alias for `SceneNode`, and
     * `createTransformNode` delegates to `createSceneNode`.
     */
    record = "mesh",
): PinnedTrsComposition {
    const euler = context.functionDeclaration(
        "src/math/quat-euler.ts",
        "eulerToQuat",
    );
    // The half-angle locals, emitted from the pinned initializers with
    // the Euler parameters renamed to the record's rotation lanes. One
    // pair table serves this emission and the quaternion products'
    // rename below.
    const rotationRename = new Map<string, string>([
        ["rx", `static_cast<double>(${record}.rotation.x)`],
        ["ry", `static_cast<double>(${record}.rotation.y)`],
        ["rz", `static_cast<double>(${record}.rotation.z)`],
    ]);
    const eulerLocalNames: readonly (readonly [string, string])[] = [
        ["cx", "cx"],
        ["sx_", "sx"],
        ["cy", "cy"],
        ["sy_", "sy"],
        ["cz", "cz"],
        ["sz_", "sz"],
    ];
    const mathCalls = pinnedNumericMathCalls();
    const halfAngleLocals = eulerLocalNames
        .map(
            ([pinned, cpp]) =>
                `        const double ${cpp} = ${pinnedNumericExpression(
                    euler.file,
                    context.variableInitializer(
                        euler.declaration,
                        pinned,
                    ),
                    rotationRename,
                    mathCalls,
                )};\n`,
        )
        .join("");
    const eulerReturn = context.findNodes(
        euler.declaration,
        (node): node is ts.ReturnStatement => ts.isReturnStatement(node),
    )[0];
    const tuple = eulerReturn?.expression
        ? context.unwrapExpression(eulerReturn.expression)
        : undefined;
    if (
        !tuple ||
        !ts.isArrayLiteralExpression(tuple) ||
        tuple.elements.length !== 4
    ) {
        context.contractError(
            eulerReturn ?? euler.declaration,
            "Expected the pinned Euler quaternion tuple.",
        );
    }
    const eulerRename = new Map<string, string>(eulerLocalNames);
    const quaternionSlots = ["qx", "qy", "qz", "qw"];
    const quaternionProducts = tuple.elements
        .map(
            (component, index) =>
                `        ${quaternionSlots[index]} = ${pinnedNumericExpression(
                    euler.file,
                    component,
                    eulerRename,
                )};\n`,
        )
        .join("");

    const compose = context.functionDeclaration(
        "src/math/mat4-compose-into.ts",
        "mat4ComposeInto",
    );
    const productNames = [
        "xx",
        "yy",
        "zz",
        "xy",
        "xz",
        "yz",
        "wx",
        "wy",
        "wz",
    ];
    const quaternionRename = new Map<string, string>([
        ["qx", "qx"],
        ["qy", "qy"],
        ["qz", "qz"],
        ["qw", "qw"],
    ]);
    const basisLocals = productNames
        .map(
            (name) =>
                `    const double ${name} = ${pinnedNumericExpression(
                    compose.file,
                    context.variableInitializer(
                        compose.declaration,
                        name,
                    ),
                    quaternionRename,
                )};\n`,
        )
        .join("");
    const storeRename = new Map<string, string>([
        ...productNames.map((name) => [name, name] as [string, string]),
        ["sx", "scale_x"],
        ["sy", "scale_y"],
        ["sz", "scale_z"],
    ]);
    const translationStores = new Map<string, string>([
        ["tx", `${record}.position.x`],
        ["ty", `${record}.position.y`],
        ["tz", `${record}.position.z`],
    ]);
    const stores = context.pinnedElementStores(
        compose.declaration,
        "dst",
    );
    if (stores.length !== 16) {
        context.contractError(
            compose.declaration,
            `Pinned mat4ComposeInto gained or lost stores (${stores.length} of 16); the instance emission no longer covers it.`,
        );
    }
    let basisStores = "";
    for (const store of stores) {
        const offset = pinnedStoreOffset(
            context,
            store.left.argumentExpression,
            "off",
        );
        const rhs = context.unwrapExpression(store.right);
        if (ts.isNumericLiteral(rhs)) {
            const value = Number(rhs.text);
            if (value === 0) {
                // The zero cells stay the zero-initialized locals.
                continue;
            }
            basisStores += `    local[${offset}] = ${context.doubleLiteral(value)};\n`;
            continue;
        }
        if (ts.isIdentifier(rhs)) {
            const translation = translationStores.get(rhs.text);
            if (translation === undefined) {
                context.contractError(
                    rhs,
                    `Pinned mat4ComposeInto stores '${rhs.text}', which the instance emission does not map.`,
                );
            }
            basisStores += `    local[${offset}] = ${translation};\n`;
            continue;
        }
        basisStores += `    local[${offset}] = ${pinnedNumericExpression(
            compose.file,
            rhs,
            storeRename,
        )};\n`;
    }
    const composeLocalBody = `    double qx = 0.0;
    double qy = 0.0;
    double qz = 0.0;
    double qw = 1.0;
    if (${record}.has_rotation_quaternion) {
        qx = ${record}.rotation_quaternion.x;
        qy = ${record}.rotation_quaternion.y;
        qz = ${record}.rotation_quaternion.z;
        qw = ${record}.rotation_quaternion.w;
    } else if (
        ${record}.rotation.x != 0.0f ||
        ${record}.rotation.y != 0.0f ||
        ${record}.rotation.z != 0.0f) {
${halfAngleLocals}\
${quaternionProducts}\
    }
    const double scale_x = ${record}.scaling.x;
    const double scale_y = ${record}.scaling.y;
    const double scale_z = ${record}.scaling.z;
${basisLocals}\
    std::array<double, 16> local{};
${basisStores}`;
    return {
        composeLocalBody,
        composeWorldBody: `${composeLocalBody}    std::array<float, 16> world{};
    for (std::size_t cell = 0; cell < 16; ++cell) {
        world[cell] = static_cast<float>(local[cell]);
    }
`,
    };
}
