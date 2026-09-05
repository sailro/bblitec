import ts from "typescript";
import { doubleLiteral, floatLiteral } from "../../cpp-literals.js";
import { renderCppExpression } from "./animation-interpolation.js";
import {
    CppExpressionScope,
    coalescedPropertyDefault,
    collectNodes,
    identifierParameters,
    identifierText,
    laneMembers,
    pinnedDoubleLiteral,
    pinnedRootFlip,
    refuseModule,
    refuseNode,
    signedNumericValue,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

/*
 * ──────────────────── round-3 loader leaves ────────────────────
 *
 * Same contract again: the emitters own the translation, never the
 * formula. Round 3 lowers the matrix family, the EXT_lights_image_based
 * polynomial conversion and environment scalars, and the
 * KHR_lights_punctual record build. Round 3 left two members of the
 * matrix family hand-written as open decisions; round 4 resolved both:
 *
 *   - `local_matrix` used to transcribe the pinned `mat4ComposeInto` in
 *     float arithmetic over `float_array` inputs, where the pin
 *     composes raw JSON doubles and rounds once per entry at the
 *     (default-F32) scratch store — a last-ulp divergence (an exact
 *     90-degree quaternion yielded m[0] = 5.96e-8f against the pin's
 *     -2.2e-16f). The port rule (match the pin) resolves it: the raw
 *     doubles ARE reachable at that point (`local_matrix` receives the
 *     parsed JSON object, and `as_number()` is a double), so
 *     `lowerLocalMatrixCpp` now emits the function from
 *     `computeNodeWorldMatrix` + the same compose walk `trs_matrix`
 *     uses, reading the JSON as doubles and rounding once per lane at
 *     the store — the pin's own precision chain.
 *
 *   - `inverse_affine` had no call site in any emitted loader, and its
 *     3x3-cofactor formula (epsilon 1e-6, identity fallback) matched
 *     neither the pinned `mat4Invert` (full 4x4 cofactors in a different
 *     association, epsilon 1e-10, null fallback) nor any caller's
 *     convention. Dead and unpinnable; DELETED from the template.
 *
 * The translations round 3 does own, documented once here:
 *   - `native_matrix` is the record's convention, not a pinned formula:
 *     the pin left-multiplies `RH_TO_LH_ROOT` (diag(-1,1,1,1)) onto the
 *     hierarchy root, while the record keeps node worlds in glTF space
 *     and applies the equivalent diagonal change of basis D*M*D at the
 *     consumption sites (`native_matrix`, the light position/direction
 *     signs). Multiplying rows or columns by the diagonal's +-1 entries
 *     is exact in IEEE arithmetic, and the anonymous-namespace multiply
 *     forms `(-a)*b + (-c)*d = -(a*b + c*d)` exactly, so the folded form
 *     is bit-identical to the pin's root multiply for finite inputs.
 *     Only the flip axis and sign flow; they anchor to the pin's root
 *     literal, and the light segment derives its lane signs from the
 *     same diagonal.
 *   - `Number.MAX_VALUE` becomes `std::numeric_limits<float>::max()`:
 *     the record stores light ranges as float32, where the pin's double
 *     max would round to +inf. Both mean "unattenuated" to the shader;
 *     the substitution is fixed text gated on the pin actually reading
 *     `Number.MAX_VALUE`.
 *   - The punctual pin normalizes the fallback direction with
 *     `Math.hypot(...) || 1`; the record routes it through the loader's
 *     shared `normalize` (epsilon 1e-6, (0,1,0) fallback). They differ
 *     only for a zero-length forward, which a finite rotation matrix
 *     cannot produce; the emitter pins the pin's shape and keeps the
 *     record's plumbing.
 *   - The IBL polynomial segment, like the round-2 SH prescale beside
 *     it, keeps the loader's float arithmetic over `float_array` inputs
 *     as its fixed presentation of the pin's double math; the band
 *     constants, slot layout, and prescale structure all flow.
 */


/** `base[offset]` → 0, `base[offset + n]` → n, anything else undefined. */
function offsetElementIndex(
    expression: ts.Expression,
    baseName: string,
    offsetName: string,
): number | undefined {
    const read = unwrapPin(expression);
    if (
        !ts.isElementAccessExpression(read) ||
        identifierText(read.expression) !== baseName
    ) {
        return undefined;
    }
    const index = unwrapPin(read.argumentExpression);
    if (ts.isIdentifier(index)) {
        return index.text === offsetName ? 0 : undefined;
    }
    if (
        ts.isBinaryExpression(index) &&
        index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        identifierText(index.left) === offsetName &&
        ts.isNumericLiteral(unwrapPin(index.right))
    ) {
        return Number((unwrapPin(index.right) as ts.NumericLiteral).text);
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
            const product = unwrapPin(binding.initializer);
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
        const value = unwrapPin(assignment.right);
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
export function lowerMatrixComposeCpp(file: ts.SourceFile): string {
    const walk = composePinWalk(file);
    return [
        "Matrix trs_matrix(",
        "    Vec3 translation,",
        "    Vec4 rotation,",
        "    Vec3 scale) {",
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
        "    result[12] = translation.x;",
        "    result[13] = translation.y;",
        "    result[14] = translation.z;",
        "    return result;",
        "}",
    ].join("\n");
}

/** `node[index]` with a numeric literal index → the index, else undefined. */
function numericElementIndex(
    expression: ts.Expression,
    baseName: string,
): number | undefined {
    const read = unwrapPin(expression);
    if (
        !ts.isElementAccessExpression(read) ||
        identifierText(read.expression) !== baseName
    ) {
        return undefined;
    }
    const index = unwrapPin(read.argumentExpression);
    return ts.isNumericLiteral(index) ? Number(index.text) : undefined;
}

/** One TRS input of the pinned local compose: JSON key and defaults. */
interface LocalComposeInput {
    bindingName: string;
    key: string;
    defaults: number[];
}

/**
 * `computeNodeWorldMatrix` + `mat4ComposeInto` → `local_matrix`.
 *
 * The pin hands the compose the RAW JSON doubles
 * (`node.translation ?? [0, 0, 0]`, `node.rotation ?? [0, 0, 0, 1]`,
 * `node.scale ?? [1, 1, 1]`) and the F32-backed scratch store rounds
 * each lane exactly once, so the emitted function reads the JSON as
 * doubles, composes the same products, and applies one
 * `static_cast<float>` per lane — the camera-precision rule: round
 * where the pin's Float32Array stores are, never earlier. The record
 * used to round the inputs at a `float_array` read and compose in
 * float, which diverges from the pin in the last ulps (an exact
 * 90-degree yaw landed m[0] at 5.96e-8f where the pin stores
 * -2.22e-16f). The authored-matrix arm mirrors the pin's
 * `new F32(node.matrix)`: one float rounding per element at the copy.
 *
 * Everything flows: the three JSON keys and their whole-array defaults
 * from `computeNodeWorldMatrix`, the argument order from its
 * `mat4ComposeInto` call, and the product/store expressions from the
 * same walk `trs_matrix` emits from. The 16-length throw on the
 * authored-matrix arm is record plumbing (the pin copies whatever the
 * JSON carries; the record refuses a malformed file instead).
 */
export function lowerLocalMatrixCpp(
    parserFile: ts.SourceFile,
    composeFile: ts.SourceFile,
): string {
    const walk = composePinWalk(composeFile);
    const symbol = "computeNodeWorldMatrix";
    const declaration = topLevelFunction(parserFile, symbol);
    // The authored-matrix arm: `if (node.matrix) { … new F32(node.matrix) … }`.
    const matrixBranches = collectNodes(
        declaration,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            ts.isPropertyAccessExpression(unwrapPin(node.expression)) &&
            (unwrapPin(node.expression) as ts.PropertyAccessExpression)
                    .name.text === "matrix",
    );
    if (matrixBranches.length !== 1) {
        refuseModule(
            symbol,
            "no longer branches on the authored node matrix exactly once",
        );
    }
    const matrixBranch = matrixBranches[0]!;
    const matrixKey =
        (unwrapPin(matrixBranch.expression) as ts.PropertyAccessExpression)
            .name.text;
    const matrixCopies = collectNodes(
        matrixBranch.thenStatement,
        (node): node is ts.NewExpression =>
            ts.isNewExpression(node) &&
            identifierText(node.expression) === "F32" &&
            node.arguments?.length === 1 &&
            ts.isPropertyAccessExpression(unwrapPin(node.arguments[0]!)) &&
            (unwrapPin(node.arguments[0]!) as ts.PropertyAccessExpression)
                    .name.text === matrixKey,
    );
    if (matrixCopies.length !== 1) {
        refuseNode(
            symbol,
            parserFile,
            matrixBranch,
            "no longer copies the authored matrix into a fresh Float32Array",
        );
    }
    // The TRS arm's whole-array defaults, keyed by binding name.
    const inputs = new Map<string, LocalComposeInput>();
    for (const binding of collectNodes(
        declaration,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined,
    )) {
        const coalesced = coalescedPropertyDefault(binding.initializer!);
        if (!coalesced) continue;
        const fallback = unwrapPin(coalesced.fallback);
        if (!ts.isArrayLiteralExpression(fallback)) continue;
        inputs.set((binding.name as ts.Identifier).text, {
            bindingName: (binding.name as ts.Identifier).text,
            key: coalesced.key,
            defaults: fallback.elements.map((element) =>
                signedNumericValue(symbol, parserFile, element)
            ),
        });
    }
    // The compose call fixes which binding feeds which parameter block.
    const composeCalls = collectNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === "mat4ComposeInto",
    );
    if (
        composeCalls.length !== 1 ||
        composeCalls[0]!.arguments.length !== 12
    ) {
        refuseModule(
            symbol,
            "no longer composes the node TRS through one " +
                "mat4ComposeInto call",
        );
    }
    const composeArguments = composeCalls[0]!.arguments.slice(2);
    const blockOf = (
        start: number,
        count: number,
    ): LocalComposeInput => {
        let input: LocalComposeInput | undefined;
        for (let lane = 0; lane < count; lane += 1) {
            const argument = unwrapPin(composeArguments[start + lane]!);
            const read = ts.isElementAccessExpression(argument)
                ? argument
                : undefined;
            const base = read
                ? identifierText(read.expression)
                : undefined;
            const candidate = base !== undefined
                ? inputs.get(base)
                : undefined;
            if (
                !read ||
                !candidate ||
                numericElementIndex(read, candidate.bindingName) !== lane ||
                (input !== undefined && candidate !== input)
            ) {
                refuseNode(
                    symbol,
                    parserFile,
                    composeArguments[start + lane]!,
                    "no longer reads the raw JSON lanes in parameter order",
                );
            }
            input = candidate;
        }
        if (!input || input.defaults.length !== count) {
            refuseModule(
                symbol,
                "no longer defaults a TRS input to the lane count " +
                    "its parameter block consumes",
            );
        }
        return input;
    };
    const translation = blockOf(0, 3);
    const quaternion = blockOf(3, walk.quaternionNames.length);
    const scale = blockOf(3 + walk.quaternionNames.length, 3);
    const translationNames = ["tx", "ty", "tz"];
    const laneLine = (
        cppName: string,
        input: LocalComposeInput,
        lane: number,
        vector: string,
    ): string =>
        `    const double ${cppName} = ${vector}.size() == ` +
        `${input.defaults.length} ? ${vector}[${lane}] : ` +
        `${doubleLiteral(input.defaults[lane]!)};`;
    return [
        "Matrix local_matrix(const JsonObject& node) {",
        `    if (const ts::JsonValue* matrix_value = optional(node, "${matrixKey}")) {`,
        "        const std::vector<float> values = float_array(matrix_value);",
        '        if (values.size() != 16) throw std::runtime_error("glTF node matrix must have 16 values.");',
        "        Matrix result{};",
        "        std::copy(values.begin(), values.end(), result.begin());",
        "        return result;",
        "    }",
        "    // Pinned computeNodeWorldMatrix hands mat4ComposeInto the raw",
        "    // JSON doubles and the F32-backed scratch store rounds each lane",
        "    // exactly once. Camera-precision rule: round where the pin's",
        "    // Float32Array stores are, never earlier — floats rounded at the",
        "    // JSON read and composed in float diverge in the last ulps (an",
        "    // exact 90-degree yaw lands m[0] at 5.96e-8f where the pin",
        "    // stores -2.22e-16f).",
        "    const std::vector<double> translation = " +
        `double_array(optional(node, "${translation.key}"));`,
        "    const std::vector<double> rotation = " +
        `double_array(optional(node, "${quaternion.key}"));`,
        "    const std::vector<double> scale = " +
        `double_array(optional(node, "${scale.key}"));`,
        ...translationNames.map((name, lane) =>
            laneLine(name, translation, lane, "translation")
        ),
        ...walk.quaternionNames.map((_, lane) =>
            laneLine(laneMembers[lane]!, quaternion, lane, "rotation")
        ),
        ...walk.scaleNames.map((name, lane) =>
            laneLine(name, scale, lane, "scale")
        ),
        ...walk.productLines,
        "    Matrix result = identity_matrix();",
        ...walk.rotationStores.map(
            (store) =>
                `    result[${store.lane}] = ` +
                `static_cast<float>(${store.text});`,
        ),
        ...translationNames.map(
            (name, lane) =>
                `    result[${12 + lane}] = static_cast<float>(${name});`,
        ),
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
