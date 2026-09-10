import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import { renderCppExpression } from "./animation-interpolation.js";
import {
    CppExpressionScope,
    identifierParameters,
    identifierText,
    laneMembers,
    pinnedDoubleLiteral,
    pinnedRootFlip,
    refuseModule,
    refuseNode,
    topLevelFunction,
    unwrapExpression,
} from "./shared.js";

/** Pinned TRS composition and the native matrix coordinate conversion. */


/** `base[offset]` → 0, `base[offset + n]` → n, anything else undefined. */
function offsetElementIndex(
    expression: ts.Expression,
    baseName: string,
    offsetName: string,
): number | undefined {
    const read = unwrapExpression(expression);
    if (
        !ts.isElementAccessExpression(read) ||
        identifierText(read.expression) !== baseName
    ) {
        return undefined;
    }
    const index = unwrapExpression(read.argumentExpression);
    if (ts.isIdentifier(index)) {
        return index.text === offsetName ? 0 : undefined;
    }
    if (
        ts.isBinaryExpression(index) &&
        index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        identifierText(index.left) === offsetName &&
        ts.isNumericLiteral(unwrapExpression(index.right))
    ) {
        return Number((unwrapExpression(index.right) as ts.NumericLiteral).text);
    }
    return undefined;
}

/** The pinned `mat4ComposeInto` body, walked once for both emitters. */
interface ComposePinWalk {
    /** The pin's quaternion parameter names, in lane order. */
    quaternionNames: string[];
    /** The pin's scale parameter names — the emitted local names. */
    scaleNames: string[];
    /** `const double xx = x * x;` … with lane-mapped names. */
    productLines: string[];
    /** The rendered double expression per non-identity rotation lane. */
    rotationStores: { lane: number; text: string }[];
}

/**
 * Walks `mat4ComposeInto`: the quaternion parameters lift to double
 * lanes named x..w, the product locals and every store expression
 * render from the pin (doubles, one `static_cast<float>` per
 * Float32Array store), the constant lanes 3/7/11/15 are verified 0/1
 * and folded into the identity seed, and the translation lanes must
 * store the raw parameters. `trs_matrix` and `local_matrix` both emit
 * from this one walk.
 */
function composePinWalk(file: ts.SourceFile): ComposePinWalk {
    const symbol = "mat4ComposeInto";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 12) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (dst, off, translation, quaternion, scale)",
        );
    }
    const dstName = parameters[0]!;
    const offName = parameters[1]!;
    const translationNames = parameters.slice(2, 5);
    const quaternionNames = parameters.slice(5, 9);
    const scaleNames = parameters.slice(9, 12);
    const names = new Map<string, string>();
    quaternionNames.forEach((name, lane) => {
        names.set(name, laneMembers[lane]!);
    });
    for (const name of scaleNames) names.set(name, name);
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    const quaternionSet = new Set(quaternionNames);
    const statements = declaration.body.statements;
    let index = 0;
    const productLines: string[] = [];
    while (
        index < statements.length &&
        ts.isVariableStatement(statements[index]!)
    ) {
        const statement = statements[index] as ts.VariableStatement;
        index += 1;
        for (const binding of statement.declarationList.declarations) {
            if (!ts.isIdentifier(binding.name) || !binding.initializer) {
                refuseNode(
                    symbol,
                    file,
                    statement,
                    "binds a local this lowering cannot carry",
                );
            }
            const product = unwrapExpression(binding.initializer);
            const quaternionProduct = ts.isBinaryExpression(product) &&
                product.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                quaternionSet.has(identifierText(product.left) ?? "") &&
                quaternionSet.has(identifierText(product.right) ?? "");
            if (!quaternionProduct) {
                refuseNode(
                    symbol,
                    file,
                    binding,
                    "no longer binds a quaternion product",
                );
            }
            productLines.push(
                `    const double ${binding.name.text} = ` +
                    `${
                        renderCppExpression(scope, binding.initializer)
                            .text
                    };`,
            );
            names.set(binding.name.text, binding.name.text);
        }
    }
    const rotationStores: { lane: number; text: string }[] = [];
    let lane = 0;
    for (; index < statements.length; index += 1, lane += 1) {
        const statement = statements[index]!;
        const assignment = ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? statement.expression
            : undefined;
        const component = assignment
            ? offsetElementIndex(assignment.left, dstName, offName)
            : undefined;
        if (!assignment || component === undefined || component !== lane) {
            refuseNode(
                symbol,
                file,
                statement,
                `no longer stores component ${lane} in order`,
            );
        }
        const value = unwrapExpression(assignment.right);
        if (lane === 3 || lane === 7 || lane === 11 || lane === 15) {
            const expected = lane === 15 ? 1 : 0;
            if (
                !ts.isNumericLiteral(value) ||
                Number(value.text) !== expected
            ) {
                refuseNode(
                    symbol,
                    file,
                    assignment,
                    `no longer keeps the identity value in lane ${lane}`,
                );
            }
            continue;
        }
        if (lane >= 12 && lane <= 14) {
            if (
                identifierText(value) !== translationNames[lane - 12]
            ) {
                refuseNode(
                    symbol,
                    file,
                    assignment,
                    `no longer stores the raw translation in lane ${lane}`,
                );
            }
            continue;
        }
        rotationStores.push({
            lane,
            text: renderCppExpression(scope, assignment.right).text,
        });
    }
    if (lane !== 16) {
        refuseModule(symbol, "no longer stores all sixteen components");
    }
    return { quaternionNames, scaleNames, productLines, rotationStores };
}

/** `mat4ComposeInto` → `trs_matrix` (float lanes lifted to double). */
export function lowerMatrixComposeCpp(file: ts.SourceFile, doubleInputs = false): string {
    const walk = composePinWalk(file);
    return [
        "Matrix trs_matrix(",
        `    ${doubleInputs ? "Vec3d" : "Vec3"} translation,`,
        `    ${doubleInputs ? "Vec4d" : "Vec4"} rotation,`,
        `    ${doubleInputs ? "Vec3d" : "Vec3"} scale) {`,
        "    // Pinned mat4ComposeInto runs in JavaScript double precision and",
        "    // rounds once at the Float32Array store; mirror its products and",
        "    // association exactly.",
        ...walk.quaternionNames.map(
            (_, quaternionLane) =>
                `    const double ${laneMembers[quaternionLane]!} = ` +
                `rotation.${laneMembers[quaternionLane]!};`,
        ),
        ...walk.productLines,
        ...walk.scaleNames.map(
            (name, scaleLane) =>
                `    const double ${name} = ` +
                `scale.${laneMembers[scaleLane]!};`,
        ),
        "    Matrix result = identity_matrix();",
        ...walk.rotationStores.map(
            (store) =>
                `    result[${store.lane}] = ` +
                `static_cast<float>(${store.text});`,
        ),
        "    result[12] = static_cast<float>(translation.x);",
        "    result[13] = static_cast<float>(translation.y);",
        "    result[14] = static_cast<float>(translation.z);",
        "    return result;",
        "}",
    ].join("\n");
}

/**
 * `native_matrix`, anchored to the pin's `RH_TO_LH_ROOT`.
 *
 * The function is the record's convention — the diagonal change of
 * basis D*M*D applied where a matrix enters a native record, instead of
 * the pin's left multiply at the hierarchy root — so only the flip axis
 * and its sign flow. See the round-3 notes for the exactness argument.
 */
export function lowerMatrixNativeCpp(file: ts.SourceFile): string {
    const { lane, sign } = pinnedRootFlip(file);
    const literal = floatLiteral(sign);
    return [
        "Matrix native_matrix(const Matrix& matrix) {",
        "    Matrix result{};",
        "    for (std::size_t column = 0; column < 4; ++column) {",
        "        for (std::size_t row = 0; row < 4; ++row) {",
        `            const float row_sign = row == ${lane} ? ` +
        `${literal} : 1.0f;`,
        "            const float column_sign =",
        `                column == ${lane} ? ${literal} : 1.0f;`,
        "            result[column * 4 + row] =",
        "                matrix[column * 4 + row] *",
        "                row_sign *",
        "                column_sign;",
        "        }",
        "    }",
        "    return result;",
        "}",
    ].join("\n");
}
