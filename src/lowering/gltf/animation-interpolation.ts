import ts from "typescript";
import { PINNED_MATH_FUNCTIONS } from "../pinned-operators.js";
import {
    CppExpressionScope,
    RenderedCpp,
    additiveTerms,
    collectLaneStores,
    collectNodes,
    identifierParameters,
    laneMembers,
    pinnedDoubleLiteral,
    refuseNode,
    singleBinding,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

/** C++ precedence for the expression subset the pinned leaves use. */
export const cppPrecedence = {
    logicalOr: 1,
    logicalAnd: 2,
    equality: 3,
    relational: 4,
    additive: 5,
    multiplicative: 6,
    unary: 7,
    primary: 8,
} as const;

const cppBinaryOperators: ReadonlyMap<
    ts.SyntaxKind,
    { text: string; level: number }
> = new Map([
    [ts.SyntaxKind.BarBarToken, { text: "||", level: cppPrecedence.logicalOr }],
    [
        ts.SyntaxKind.AmpersandAmpersandToken,
        { text: "&&", level: cppPrecedence.logicalAnd },
    ],
    [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        { text: "==", level: cppPrecedence.equality },
    ],
    [
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        { text: "!=", level: cppPrecedence.equality },
    ],
    [ts.SyntaxKind.LessThanToken, { text: "<", level: cppPrecedence.relational }],
    [
        ts.SyntaxKind.GreaterThanToken,
        { text: ">", level: cppPrecedence.relational },
    ],
    [ts.SyntaxKind.PlusToken, { text: "+", level: cppPrecedence.additive }],
    [ts.SyntaxKind.MinusToken, { text: "-", level: cppPrecedence.additive }],
    [
        ts.SyntaxKind.AsteriskToken,
        { text: "*", level: cppPrecedence.multiplicative },
    ],
    [
        ts.SyntaxKind.SlashToken,
        { text: "/", level: cppPrecedence.multiplicative },
    ],
    [
        ts.SyntaxKind.PercentToken,
        { text: "%", level: cppPrecedence.multiplicative },
    ],
]);

/**
 * Parenthesize a rendered operand exactly where C++ would re-associate
 * it. Right operands require strictly higher precedence because floating
 * point does not associate: the pin's `h10 * (tangent * dt)` must not
 * flatten into `(h10 * tangent) * dt`.
 */
function renderCppOperand(rendered: RenderedCpp, minimum: number): string {
    return rendered.precedence < minimum
        ? `(${rendered.text})`
        : rendered.text;
}

export function renderCppExpression(
    scope: CppExpressionScope,
    expression: ts.Expression,
): RenderedCpp {
    if (
        ts.isParenthesizedExpression(expression) ||
        ts.isNonNullExpression(expression)
    ) {
        return renderCppExpression(scope, expression.expression);
    }
    if (ts.isNumericLiteral(expression)) {
        return {
            text: scope.numeric(expression),
            precedence: cppPrecedence.primary,
        };
    }
    if (ts.isIdentifier(expression)) {
        const substituted = scope.substitutions?.get(expression.text);
        if (substituted) return substituted;
        const name = scope.names.get(expression.text);
        if (name !== undefined) {
            return { text: name, precedence: cppPrecedence.primary };
        }
        refuseNode(
            scope.symbol,
            scope.file,
            expression,
            "reads an identifier with no C++ correspondence",
        );
    }
    if (ts.isPrefixUnaryExpression(expression)) {
        const operator = expression.operator === ts.SyntaxKind.MinusToken
            ? "-"
            : expression.operator === ts.SyntaxKind.ExclamationToken
            ? "!"
            : undefined;
        if (operator === undefined) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "uses a unary operator this lowering cannot carry",
            );
        }
        const operand = renderCppExpression(scope, expression.operand);
        return {
            text: `${operator}${
                renderCppOperand(operand, cppPrecedence.unary)
            }`,
            precedence: cppPrecedence.unary,
        };
    }
    if (ts.isPropertyAccessChain(expression)) {
        if (!scope.chainRead) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "reads an optional property where none lowers",
            );
        }
        return scope.chainRead(expression);
    }
    if (ts.isElementAccessExpression(expression)) {
        if (!scope.elementRead) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "indexes a buffer where none lowers",
            );
        }
        return scope.elementRead(expression);
    }
    if (ts.isCallExpression(expression)) {
        const callee = expression.expression;
        if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Math"
        ) {
            const mapped = PINNED_MATH_FUNCTIONS[callee.name.text];
            if (!mapped) {
                refuseNode(
                    scope.symbol,
                    scope.file,
                    expression,
                    `calls Math.${callee.name.text}, which has no lowering`,
                );
            }
            const argumentTexts = expression.arguments.map(
                (argument) => renderCppExpression(scope, argument).text,
            );
            return {
                text: `${mapped}(${argumentTexts.join(", ")})`,
                precedence: cppPrecedence.primary,
            };
        }
        refuseNode(
            scope.symbol,
            scope.file,
            expression,
            "calls a function this lowering cannot carry",
        );
    }
    if (ts.isBinaryExpression(expression)) {
        const operator = cppBinaryOperators.get(
            expression.operatorToken.kind,
        );
        if (!operator) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "uses an operator this lowering cannot carry",
            );
        }
        const left = renderCppExpression(scope, expression.left);
        const right = renderCppExpression(scope, expression.right);
        return {
            text: `${renderCppOperand(left, operator.level)} ` +
                `${operator.text} ` +
                `${renderCppOperand(right, operator.level + 1)}`,
            precedence: operator.level,
        };
    }
    refuseNode(
        scope.symbol,
        scope.file,
        expression,
        "uses an expression this lowering cannot carry",
    );
}

/**
 * One declaration in the interpolation segment's layout: a single line
 * up to the segment's 60-column measure, wrapped after `=` beyond it.
 */
function interpolationDeclarationLines(
    indent: string,
    head: string,
    value: string,
): string[] {
    const single = `${indent}${head} ${value};`;
    if (single.length <= 60) return [single];
    return [`${indent}${head}`, `${indent}    ${value};`];
}

/**
 * One `static_cast<float>` component of a vector build — the pin's
 * Float32Array store, rounded exactly once. A long Hermite sum splits
 * its top-level terms greedily at the segment's 60-column measure.
 */
function castEntryLines(
    indent: string,
    terms: readonly string[],
): string[] {
    const joined = terms.join(" + ");
    if (joined.length <= 60) {
        return [`${indent}static_cast<float>(${joined}),`];
    }
    const continuation = `${indent}    `;
    const lines: string[] = [`${indent}static_cast<float>(`];
    let current = "";
    for (const term of terms) {
        if (current === "") {
            current = term;
            continue;
        }
        const extended = `${current} + ${term}`;
        if (`${continuation}${extended} +`.length <= 60) {
            current = extended;
            continue;
        }
        lines.push(`${continuation}${current} +`);
        current = term;
    }
    lines.push(`${continuation}${current}),`);
    return lines;
}

function vecBuildLines(
    indent: string,
    open: string,
    entries: readonly (readonly string[])[],
    close: string,
): string[] {
    return [
        `${indent}${open}`,
        ...entries.flatMap((terms) =>
            castEntryLines(`${indent}    `, terms)
        ),
        `${indent}${close}`,
    ];
}

/** The C++ name every lowered call site uses for the pinned normalize. */
const normalizeQuaternionCppName = "normalize_quaternion";

/**
 * `normalizeQuat4(buf, o)` → `normalize_quaternion(Vec4)`.
 *
 * The pin normalizes four consecutive Float32Array components in place;
 * the record side passes the quaternion by value, so the four lane reads
 * become member reads and the four stores become one rounded Vec4 build.
 * The void fall-through on zero length — the input kept verbatim — is
 * the trailing `return value;`.
 */
function emitNormalizeQuaternion(
    declaration: ts.FunctionDeclaration & { body: ts.Block },
    file: ts.SourceFile,
): string {
    const symbol = "normalizeQuat4";
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 2) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (buffer, offset)",
        );
    }
    const bufferName = parameters[0]!;
    const offsetName = parameters[1]!;
    const laneOf = (
        target: ts.ElementAccessExpression,
    ): number | undefined => {
        if (
            !ts.isIdentifier(target.expression) ||
            target.expression.text !== bufferName
        ) {
            return undefined;
        }
        const index = unwrapPin(target.argumentExpression);
        if (ts.isIdentifier(index)) {
            return index.text === offsetName ? 0 : undefined;
        }
        if (
            ts.isBinaryExpression(index) &&
            index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(index.left) &&
            index.left.text === offsetName &&
            ts.isNumericLiteral(index.right)
        ) {
            return Number.parseInt(index.right.text, 10);
        }
        return undefined;
    };
    const names = new Map<string, string>();
    const renames: Readonly<Record<string, string>> = {
        lenSq: "length_squared",
        inv: "inverse",
    };
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    const statements = declaration.body.statements;
    const lines: string[] = [
        "Vec4 normalize_quaternion(Vec4 value) {",
        "    // Pinned normalizeQuat4: double length over float32 components,",
        "    // a multiply by the inverse square root, one rounding at the",
        "    // Float32Array store, no epsilon, and the input kept verbatim on",
        "    // zero length.",
    ];
    let index = 0;
    // The four component bindings, ascending lanes, keeping the pin's
    // own local names.
    for (let lane = 0; lane < 4; lane += 1) {
        const binding = singleBinding(
            symbol,
            file,
            statements[index],
            declaration,
        );
        index += 1;
        const read = unwrapPin(binding.initializer);
        if (
            !ts.isElementAccessExpression(read) ||
            laneOf(read) !== lane
        ) {
            refuseNode(
                symbol,
                file,
                binding.statement,
                `no longer reads lane ${lane} into '${binding.name}'`,
            );
        }
        names.set(binding.name, binding.name);
        lines.push(
            `    const double ${binding.name} = ` +
                `value.${laneMembers[lane]!};`,
        );
    }
    // The squared length.
    const lengthBinding = singleBinding(
        symbol,
        file,
        statements[index],
        declaration,
    );
    index += 1;
    const lengthName = renames[lengthBinding.name] ?? lengthBinding.name;
    lines.push(
        ...interpolationDeclarationLines(
            "    ",
            `const double ${lengthName} =`,
            renderCppExpression(scope, lengthBinding.initializer).text,
        ),
    );
    names.set(lengthBinding.name, lengthName);
    // The positive-length guard with its normalize-in-place stores.
    const guard = statements[index];
    index += 1;
    if (!guard || !ts.isIfStatement(guard) || guard.elseStatement) {
        refuseNode(
            symbol,
            file,
            guard ?? declaration,
            "no longer guards the normalize on a positive squared length",
        );
    }
    lines.push(
        `    if (${renderCppExpression(scope, guard.expression).text}) {`,
    );
    if (!ts.isBlock(guard.thenStatement)) {
        refuseNode(
            symbol,
            file,
            guard,
            "no longer wraps the normalize stores in a block",
        );
    }
    const branch = guard.thenStatement.statements;
    const inverseBinding = singleBinding(symbol, file, branch[0], guard);
    const inverseName = renames[inverseBinding.name] ??
        inverseBinding.name;
    lines.push(
        ...interpolationDeclarationLines(
            "        ",
            `const double ${inverseName} =`,
            renderCppExpression(scope, inverseBinding.initializer).text,
        ),
    );
    names.set(inverseBinding.name, inverseName);
    const stores = collectLaneStores(scope, branch, 1, 4, laneOf);
    if (stores.next !== branch.length) {
        refuseNode(
            symbol,
            file,
            branch[stores.next] ?? guard,
            "carries statements after the normalize stores",
        );
    }
    lines.push(
        ...vecBuildLines(
            "        ",
            "return Vec4{",
            stores.expressions.map((expression) => [
                renderCppExpression(scope, expression).text,
            ]),
            "};",
        ),
        "    }",
    );
    if (index !== statements.length) {
        refuseNode(
            symbol,
            file,
            statements[index] ?? declaration,
            "carries statements after the length guard",
        );
    }
    lines.push("    return value;", "}");
    return lines.join("\n");
}

/**
 * `quatSlerp(out, ax..aw, bx..bw, t)` → `interpolate_quaternion`.
 *
 * The eight component parameters bind to the two quaternions' members —
 * `const` exactly where the pin never reassigns them — the near-parallel
 * branch's Float32Array scratch becomes the rounded `lerped` build, and
 * the general branch's four weighted stores become the returned Vec4.
 */
function emitInterpolateQuaternion(
    declaration: ts.FunctionDeclaration & { body: ts.Block },
    file: ts.SourceFile,
    normalizePinName: string,
): string {
    const symbol = "quatSlerp";
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 10) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (out, four left lanes, four right lanes, t)",
        );
    }
    const outName = parameters[0]!;
    // Which parameters the pin reassigns decides const-ness below.
    const reassigned = new Set<string>();
    const findReassignments = (node: ts.Node): void => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left)
        ) {
            reassigned.add(node.left.text);
        }
        ts.forEachChild(node, findReassignments);
    };
    findReassignments(declaration.body);
    const names = new Map<string, string>();
    const renames: Readonly<Record<string, string>> = {
        sinTheta: "sin_theta",
        wa: "left_weight",
        wb: "right_weight",
    };
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    const lines: string[] = [
        "Vec4 interpolate_quaternion(Vec4 left, Vec4 right, double amount) {",
        "    // Pinned sampler evaluation lifts float32 keyframes to JavaScript",
        "    // doubles and rounds once at the Float32Array store.",
    ];
    const sides = [
        { vec: "left", prefix: "l" },
        { vec: "right", prefix: "r" },
    ] as const;
    sides.forEach((side, sideIndex) => {
        for (let lane = 0; lane < 4; lane += 1) {
            const pinName = parameters[1 + sideIndex * 4 + lane]!;
            const cppName = `${side.prefix}${laneMembers[lane]!}`;
            names.set(pinName, cppName);
            const qualifier = reassigned.has(pinName) ? "" : "const ";
            lines.push(
                `    ${qualifier}double ${cppName} = ` +
                    `${side.vec}.${laneMembers[lane]!};`,
            );
        }
    });
    names.set(parameters[9]!, "amount");
    const literalLaneOf = (
        target: ts.ElementAccessExpression,
    ): number | undefined =>
        ts.isIdentifier(target.expression) &&
            target.expression.text === outName &&
            ts.isNumericLiteral(target.argumentExpression)
            ? Number.parseInt(target.argumentExpression.text, 10)
            : undefined;
    const emitLocal = (statement: ts.Statement | undefined): void => {
        const binding = singleBinding(symbol, file, statement, declaration);
        const rendered = renderCppExpression(
            scope,
            binding.initializer,
        ).text;
        const cppName = renames[binding.name] ?? binding.name;
        lines.push(
            ...interpolationDeclarationLines(
                "    ",
                `${binding.isConst ? "const " : ""}double ${cppName} =`,
                rendered,
            ),
        );
        names.set(binding.name, cppName);
    };
    const statements = declaration.body.statements;
    let index = 0;
    // `let dot = ax * bx + …`.
    emitLocal(statements[index]);
    index += 1;
    // The hemisphere flip: negate the right quaternion in place.
    const flip = statements[index];
    index += 1;
    if (
        !flip ||
        !ts.isIfStatement(flip) ||
        flip.elseStatement ||
        !ts.isBlock(flip.thenStatement)
    ) {
        refuseNode(
            symbol,
            file,
            flip ?? declaration,
            "no longer flips the right quaternion behind a guard",
        );
    }
    lines.push(
        `    if (${renderCppExpression(scope, flip.expression).text}) {`,
    );
    for (const inner of flip.thenStatement.statements) {
        const assignment = ts.isExpressionStatement(inner) &&
                ts.isBinaryExpression(inner.expression) &&
                inner.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(inner.expression.left)
            ? inner.expression
            : undefined;
        const target = assignment
            ? names.get((assignment.left as ts.Identifier).text)
            : undefined;
        if (!assignment || target === undefined) {
            refuseNode(
                symbol,
                file,
                inner,
                "no longer negates a lowered local inside the flip",
            );
        }
        lines.push(
            `        ${target} = ` +
                `${renderCppExpression(scope, assignment.right).text};`,
        );
    }
    lines.push("    }");
    // The near-parallel branch: lerp into the Float32Array scratch, then
    // normalize the rounded components in place.
    const nearParallel = statements[index];
    index += 1;
    if (
        !nearParallel ||
        !ts.isIfStatement(nearParallel) ||
        nearParallel.elseStatement ||
        !ts.isBlock(nearParallel.thenStatement)
    ) {
        refuseNode(
            symbol,
            file,
            nearParallel ?? declaration,
            "no longer guards the near-parallel lerp",
        );
    }
    lines.push(
        `    if (${
            renderCppExpression(scope, nearParallel.expression).text
        }) {`,
        "        // The pinned near-parallel path stores the double lerp into a",
        "        // Float32Array scratch before normalizing it in place, so the",
        "        // components round to float32 between the two steps.",
    );
    const branch = nearParallel.thenStatement.statements;
    const lerpStores = collectLaneStores(
        scope,
        branch,
        0,
        4,
        literalLaneOf,
    );
    const normalizeCall = branch[lerpStores.next];
    const callExpression = normalizeCall &&
            ts.isExpressionStatement(normalizeCall) &&
            ts.isCallExpression(normalizeCall.expression)
        ? normalizeCall.expression
        : undefined;
    const callTargetsScratch = callExpression !== undefined &&
        ts.isIdentifier(callExpression.expression) &&
        callExpression.expression.text === normalizePinName &&
        callExpression.arguments.length === 2 &&
        ts.isIdentifier(callExpression.arguments[0]!) &&
        (callExpression.arguments[0] as ts.Identifier).text === outName &&
        ts.isNumericLiteral(callExpression.arguments[1]!) &&
        Number(
            (callExpression.arguments[1] as ts.NumericLiteral).text,
        ) === 0;
    const trailingReturn = branch[lerpStores.next + 1];
    if (
        !callTargetsScratch ||
        !trailingReturn ||
        !ts.isReturnStatement(trailingReturn) ||
        trailingReturn.expression ||
        lerpStores.next + 2 !== branch.length
    ) {
        refuseNode(
            symbol,
            file,
            nearParallel,
            "no longer normalizes the scratch and returns after the lerp",
        );
    }
    lines.push(
        ...vecBuildLines(
            "        ",
            "const Vec4 lerped{",
            lerpStores.expressions.map((expression) => [
                renderCppExpression(scope, expression).text,
            ]),
            "};",
        ),
        `        return ${normalizeQuaternionCppName}(lerped);`,
        "    }",
    );
    // The general branch's angle, weights, and four weighted stores.
    while (
        index < statements.length &&
        ts.isVariableStatement(statements[index]!)
    ) {
        emitLocal(statements[index]);
        index += 1;
    }
    const tailStores = collectLaneStores(
        scope,
        statements,
        index,
        4,
        literalLaneOf,
    );
    if (tailStores.next !== statements.length) {
        refuseNode(
            symbol,
            file,
            statements[tailStores.next] ?? declaration,
            "carries statements after the weighted stores",
        );
    }
    lines.push(
        ...vecBuildLines(
            "    ",
            "return Vec4{",
            tailStores.expressions.map((expression) => [
                renderCppExpression(scope, expression).text,
            ]),
            "};",
        ),
        "}",
    );
    return lines.join("\n");
}

/**
 * How the pin's `[inTangent, value, outTangent]` triplet maps to the
 * C++ parameters. Only the slots the pinned evaluator reads are named;
 * a permuted layout upstream misses the map and refuses.
 */
const cubicTripletSlots: Readonly<
    Record<"left" | "right", Readonly<Record<number, string>>>
> = {
    left: { 1: "left", 2: "left_tangent" },
    right: { 0: "right_tangent", 1: "right" },
};

function hasLocalDeclaration(
    declaration: ts.FunctionDeclaration,
    name: string,
): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name
        ) {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    return found;
}

/**
 * The CUBICSPLINE branch of `evaluateSampler` → `cubic_quaternion` /
 * `cubic_vec3`.
 *
 * The Hermite basis lowers verbatim; the pin's `output[k + slot·stride
 * + c]` triplet reads resolve through `cubicTripletSlots` to the vector
 * parameters; the per-component loop unrolls over the lanes the C++
 * variant carries; and the trailing `isQuat` normalize folds to the arm
 * each variant statically takes.
 */
function emitCubicHermite(
    declaration: ts.FunctionDeclaration & { body: ts.Block },
    file: ts.SourceFile,
    normalizePinName: string,
    lanes: 3 | 4,
): string {
    const symbol = "evaluateSampler";
    const vecType = lanes === 4 ? "Vec4" : "Vec3";
    const cppName = lanes === 4 ? "cubic_quaternion" : "cubic_vec3";
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 6) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (sampler, t, stride, isQuat, dst, dstOffset)",
        );
    }
    const strideName = parameters[2]!;
    const isQuatName = parameters[3]!;
    const dstName = parameters[4]!;
    const dstOffsetName = parameters[5]!;
    // The destructured sampler fields the branch reads.
    let outputName: string | undefined;
    let interpolationName: string | undefined;
    for (const statement of declaration.body.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const binding of statement.declarationList.declarations) {
            if (!ts.isObjectBindingPattern(binding.name)) continue;
            for (const element of binding.name.elements) {
                if (!ts.isIdentifier(element.name)) continue;
                const property = element.propertyName &&
                        ts.isIdentifier(element.propertyName)
                    ? element.propertyName.text
                    : element.name.text;
                if (property === "output") {
                    outputName = element.name.text;
                }
                if (property === "interpolation") {
                    interpolationName = element.name.text;
                }
            }
        }
    }
    if (outputName === undefined || interpolationName === undefined) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer destructures the sampler's output and interpolation",
        );
    }
    const cubicIf = declaration.body.statements.find(
        (statement): statement is ts.IfStatement =>
            ts.isIfStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            statement.expression.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isIdentifier(statement.expression.left) &&
            statement.expression.left.text === interpolationName &&
            ts.isIdentifier(statement.expression.right) &&
            statement.expression.right.text === "INTERP_CUBICSPLINE",
    );
    if (!cubicIf || !ts.isBlock(cubicIf.thenStatement)) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer carries a CUBICSPLINE branch",
        );
    }
    const block = cubicIf.thenStatement.statements;
    const names = new Map<string, string>();
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    /** `k = base * stride * 3` — the pin's per-key triplet origin. */
    const keyBaseOf = (
        initializer: ts.Expression,
    ): ts.Expression | undefined => {
        const outer = unwrapPin(initializer);
        if (
            !ts.isBinaryExpression(outer) ||
            outer.operatorToken.kind !== ts.SyntaxKind.AsteriskToken ||
            !ts.isNumericLiteral(outer.right) ||
            Number(outer.right.text) !== 3
        ) {
            return undefined;
        }
        const inner = unwrapPin(outer.left);
        if (
            !ts.isBinaryExpression(inner) ||
            inner.operatorToken.kind !== ts.SyntaxKind.AsteriskToken ||
            !ts.isIdentifier(inner.right) ||
            inner.right.text !== strideName
        ) {
            return undefined;
        }
        return unwrapPin(inner.left);
    };
    const isKeyBase = (statement: ts.Statement): boolean =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1 &&
        statement.declarationList.declarations[0]!.initializer !==
            undefined &&
        keyBaseOf(
            statement.declarationList.declarations[0]!.initializer!,
        ) !== undefined;
    let index = 0;
    // The Hermite basis. The pin's fractional time is derived from the
    // first `f2 = f * f` binding, so an upstream rename cannot silently
    // detach the correspondence.
    const firstBinding = singleBinding(
        symbol,
        file,
        block[index],
        cubicIf,
    );
    const firstInitializer = unwrapPin(firstBinding.initializer);
    if (
        !ts.isBinaryExpression(firstInitializer) ||
        firstInitializer.operatorToken.kind !==
            ts.SyntaxKind.AsteriskToken ||
        !ts.isIdentifier(firstInitializer.left) ||
        !ts.isIdentifier(firstInitializer.right) ||
        firstInitializer.left.text !== firstInitializer.right.text
    ) {
        refuseNode(
            symbol,
            file,
            firstBinding.statement,
            "no longer squares the fractional time first",
        );
    }
    const fractionName = firstInitializer.left.text;
    if (!hasLocalDeclaration(declaration, fractionName)) {
        refuseNode(
            symbol,
            file,
            firstBinding.statement,
            `reads '${fractionName}', which the sampler no longer binds`,
        );
    }
    names.set(fractionName, "amount");
    const renames: Readonly<Record<string, string>> = {
        f2: "amount2",
        f3: "amount3",
    };
    const hermiteLines: string[] = [];
    while (
        index < block.length &&
        ts.isVariableStatement(block[index]!) &&
        !isKeyBase(block[index]!)
    ) {
        const binding = singleBinding(symbol, file, block[index], cubicIf);
        index += 1;
        const rendered = renderCppExpression(
            scope,
            binding.initializer,
        ).text;
        const cpp = renames[binding.name] ?? binding.name;
        hermiteLines.push(
            ...interpolationDeclarationLines(
                "    ",
                `const double ${cpp} =`,
                rendered,
            ),
        );
        names.set(binding.name, cpp);
    }
    // The two key origins: which key a `k` local addresses.
    const keySides = new Map<string, "left" | "right">();
    let idxName: string | undefined;
    for (let key = 0; key < 2; key += 1) {
        const binding = singleBinding(symbol, file, block[index], cubicIf);
        index += 1;
        const base = keyBaseOf(binding.initializer);
        if (base && ts.isIdentifier(base)) {
            idxName ??= base.text;
            if (base.text !== idxName) {
                refuseNode(
                    symbol,
                    file,
                    binding.statement,
                    "no longer derives both key origins from one index",
                );
            }
            keySides.set(binding.name, "left");
            continue;
        }
        if (
            base &&
            ts.isBinaryExpression(base) &&
            base.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(base.left) &&
            (idxName === undefined || base.left.text === idxName) &&
            ts.isNumericLiteral(base.right) &&
            Number(base.right.text) === 1
        ) {
            idxName ??= base.left.text;
            keySides.set(binding.name, "right");
            continue;
        }
        refuseNode(
            symbol,
            file,
            binding.statement,
            "no longer indexes the keyframe triplets the lowered way",
        );
    }
    if (
        [...keySides.values()].filter((side) => side === "left")
                .length !== 1 ||
        keySides.size !== 2
    ) {
        refuseNode(
            symbol,
            file,
            cubicIf,
            "no longer addresses one left and one right key",
        );
    }
    // The per-component loop, unrolled over this variant's lanes.
    const loop = block[index];
    index += 1;
    if (
        !loop ||
        !ts.isForStatement(loop) ||
        !loop.initializer ||
        !ts.isVariableDeclarationList(loop.initializer) ||
        loop.initializer.declarations.length !== 1 ||
        !ts.isIdentifier(loop.initializer.declarations[0]!.name) ||
        !loop.condition ||
        !ts.isBinaryExpression(loop.condition) ||
        loop.condition.operatorToken.kind !==
            ts.SyntaxKind.LessThanToken ||
        !ts.isIdentifier(loop.condition.right) ||
        loop.condition.right.text !== strideName ||
        !ts.isBlock(loop.statement)
    ) {
        refuseNode(
            symbol,
            file,
            loop ?? cubicIf,
            "no longer loops one component at a time over the stride",
        );
    }
    const componentName = (
        loop.initializer.declarations[0]!.name as ts.Identifier
    ).text;
    const loopBody = loop.statement.statements;
    /** `output[k…]`, `output[k + stride…]`, `output[k + n·stride…]`. */
    const tripletRead = (
        expression: ts.Expression,
        lane: number,
    ): string => {
        const read = unwrapPin(expression);
        if (
            !ts.isElementAccessExpression(read) ||
            !ts.isIdentifier(read.expression) ||
            read.expression.text !== outputName
        ) {
            refuseNode(
                symbol,
                file,
                expression,
                "no longer reads the sampler output the lowered way",
            );
        }
        const full = unwrapPin(read.argumentExpression);
        if (
            !ts.isBinaryExpression(full) ||
            full.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
            !ts.isIdentifier(full.right) ||
            full.right.text !== componentName
        ) {
            refuseNode(
                symbol,
                file,
                read,
                "no longer offsets the triplet read by the component",
            );
        }
        const offset = unwrapPin(full.left);
        let keyLocal: string | undefined;
        let slot: number | undefined;
        if (ts.isIdentifier(offset)) {
            keyLocal = offset.text;
            slot = 0;
        } else if (
            ts.isBinaryExpression(offset) &&
            offset.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(offset.left)
        ) {
            keyLocal = offset.left.text;
            const slotExpression = unwrapPin(offset.right);
            if (
                ts.isIdentifier(slotExpression) &&
                slotExpression.text === strideName
            ) {
                slot = 1;
            } else if (
                ts.isBinaryExpression(slotExpression) &&
                slotExpression.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                ts.isNumericLiteral(slotExpression.left) &&
                ts.isIdentifier(slotExpression.right) &&
                slotExpression.right.text === strideName
            ) {
                slot = Number(slotExpression.left.text);
            }
        }
        const side = keyLocal === undefined
            ? undefined
            : keySides.get(keyLocal);
        const vecName = side === undefined || slot === undefined
            ? undefined
            : cubicTripletSlots[side][slot];
        if (vecName === undefined) {
            refuseNode(
                symbol,
                file,
                read,
                "reads a triplet slot outside the pinned " +
                    "[inTangent, value, outTangent] layout",
            );
        }
        return `${vecName}.${laneMembers[lane]!}`;
    };
    let deltaName: string | undefined;
    const laneSubstitution = (
        initializer: ts.Expression,
        lane: number,
    ): RenderedCpp => {
        const value = unwrapPin(initializer);
        if (ts.isElementAccessExpression(value)) {
            return {
                text: tripletRead(value, lane),
                precedence: cppPrecedence.primary,
            };
        }
        if (
            ts.isBinaryExpression(value) &&
            value.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
            ts.isIdentifier(value.right)
        ) {
            if (deltaName === undefined) {
                deltaName = value.right.text;
                if (!hasLocalDeclaration(declaration, deltaName)) {
                    refuseNode(
                        symbol,
                        file,
                        value,
                        `scales by '${deltaName}', which the sampler ` +
                            "no longer binds",
                    );
                }
            }
            if (value.right.text !== deltaName) {
                refuseNode(
                    symbol,
                    file,
                    value,
                    "no longer scales every tangent by one key delta",
                );
            }
            return {
                text: `${tripletRead(value.left, lane)} * span`,
                precedence: cppPrecedence.multiplicative,
            };
        }
        refuseNode(
            symbol,
            file,
            initializer,
            "binds a loop local this lowering cannot carry",
        );
    };
    const entries: string[][] = [];
    for (let lane = 0; lane < lanes; lane += 1) {
        const substitutions = new Map<string, RenderedCpp>();
        const laneScope: CppExpressionScope = {
            symbol,
            file,
            names,
            substitutions,
            numeric: pinnedDoubleLiteral,
        };
        let bodyIndex = 0;
        while (bodyIndex < loopBody.length - 1) {
            const binding = singleBinding(
                symbol,
                file,
                loopBody[bodyIndex],
                loop,
            );
            bodyIndex += 1;
            substitutions.set(
                binding.name,
                laneSubstitution(binding.initializer, lane),
            );
        }
        const store = loopBody[loopBody.length - 1];
        const assignment = store &&
                ts.isExpressionStatement(store) &&
                ts.isBinaryExpression(store.expression) &&
                store.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? store.expression
            : undefined;
        const target = assignment
            ? unwrapPin(assignment.left)
            : undefined;
        const storesComponent = target !== undefined &&
            ts.isElementAccessExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === dstName &&
            ts.isBinaryExpression(target.argumentExpression) &&
            target.argumentExpression.operatorToken.kind ===
                ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(target.argumentExpression.left) &&
            target.argumentExpression.left.text === dstOffsetName &&
            ts.isIdentifier(target.argumentExpression.right) &&
            target.argumentExpression.right.text === componentName;
        if (!assignment || !storesComponent) {
            refuseNode(
                symbol,
                file,
                store ?? loop,
                "no longer stores the Hermite sum per component",
            );
        }
        entries.push(
            additiveTerms(assignment.right).map(
                (term) => renderCppExpression(laneScope, term).text,
            ),
        );
    }
    // `if (isQuat) normalizeQuat4(dst, dstOffset)` — statically taken by
    // the rotation variant, statically empty for vec3 — then `return`.
    const quatGuard = block[index];
    index += 1;
    const guardCall = quatGuard &&
            ts.isIfStatement(quatGuard) &&
            !quatGuard.elseStatement &&
            ts.isIdentifier(quatGuard.expression) &&
            quatGuard.expression.text === isQuatName &&
            ts.isBlock(quatGuard.thenStatement) &&
            quatGuard.thenStatement.statements.length === 1 &&
            ts.isExpressionStatement(
                quatGuard.thenStatement.statements[0]!,
            ) &&
            ts.isCallExpression(
                (
                    quatGuard.thenStatement
                        .statements[0] as ts.ExpressionStatement
                ).expression,
            )
        ? (
            quatGuard.thenStatement
                .statements[0] as ts.ExpressionStatement
        ).expression as ts.CallExpression
        : undefined;
    const guardNormalizes = guardCall !== undefined &&
        ts.isIdentifier(guardCall.expression) &&
        guardCall.expression.text === normalizePinName &&
        guardCall.arguments.length === 2 &&
        ts.isIdentifier(guardCall.arguments[0]!) &&
        (guardCall.arguments[0] as ts.Identifier).text === dstName &&
        ts.isIdentifier(guardCall.arguments[1]!) &&
        (guardCall.arguments[1] as ts.Identifier).text === dstOffsetName;
    const trailing = block[index];
    index += 1;
    if (
        !guardNormalizes ||
        !trailing ||
        !ts.isReturnStatement(trailing) ||
        trailing.expression ||
        index !== block.length
    ) {
        refuseNode(
            symbol,
            file,
            quatGuard ?? cubicIf,
            "no longer normalizes rotations and returns after the loop",
        );
    }
    const lines: string[] = [
        `${vecType} ${cppName}(`,
        `    ${vecType} left,`,
        `    ${vecType} left_tangent,`,
        `    ${vecType} right,`,
        `    ${vecType} right_tangent,`,
        "    double amount,",
        "    double span) {",
        "    // Pinned sampler evaluation lifts float32 keyframes to JavaScript",
        "    // doubles and rounds once at the Float32Array store.",
        ...hermiteLines,
    ];
    if (lanes === 4) {
        lines.push(
            "    // The pinned evaluator scales tangents by the key delta before",
            "    // weighting, stores the Hermite sum into a Float32Array, and then",
            "    // normalizes the rounded components in place.",
            ...vecBuildLines("    ", "const Vec4 combined{", entries, "};"),
            `    return ${normalizeQuaternionCppName}(combined);`,
        );
    } else {
        lines.push(
            "    // The pinned evaluator scales tangents by the key delta before",
            "    // weighting and rounds once at the Float32Array store.",
            ...vecBuildLines("    ", "return Vec3{", entries, "};"),
        );
    }
    lines.push("}");
    return lines.join("\n");
}

/**
 * The STEP branch of `evaluateSampler`, asserted rather than restated.
 *
 * Unlike the Hermite basis beside it, STEP carries no arithmetic to lower:
 * it selects one stored key and copies it. What can drift is *which* key --
 * the pin takes the later one at or past its time
 * (`srcOff = (t >= t1 ? idx + 1 : idx) * stride`) and the earlier one
 * inside the span -- so that selection is what this gate pins, and the
 * generated `sample_step_*` helpers mirror it against
 * `track_key_at`'s own pair. A branch that stops selecting that way refuses
 * generation instead of shipping an off-by-one-key pose.
 */
function assertPinnedStepSelection(
    declaration: ts.FunctionDeclaration & { body: ts.Block },
    file: ts.SourceFile,
): void {
    const symbol = "evaluateSampler";
    const parameters = identifierParameters(symbol, file, declaration);
    const timeName = parameters[1];
    const strideName = parameters[2];
    if (timeName === undefined || strideName === undefined) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (sampler, t, stride, ...)",
        );
    }
    const stepBranch = collectNodes(
        declaration.body,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            ts.isBinaryExpression(node.expression) &&
            node.expression.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isIdentifier(node.expression.right) &&
            node.expression.right.text === "INTERP_STEP",
    )[0];
    if (!stepBranch || !ts.isBlock(stepBranch.thenStatement)) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer carries a STEP branch",
        );
        return;
    }
    const first = stepBranch.thenStatement.statements[0];
    const initializer =
        first &&
        ts.isVariableStatement(first) &&
        first.declarationList.declarations.length === 1
            ? first.declarationList.declarations[0]!.initializer
            : undefined;
    // `(t >= t1 ? idx + 1 : idx) * stride`
    const product =
        initializer &&
        ts.isBinaryExpression(initializer) &&
        initializer.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
        ts.isIdentifier(initializer.right) &&
        initializer.right.text === strideName
            ? initializer.left
            : undefined;
    const conditional =
        product && ts.isParenthesizedExpression(product)
            ? product.expression
            : product;
    const refuse = (): never =>
        refuseNode(
            symbol,
            file,
            stepBranch!,
            "no longer selects the later key at or past its own time",
        );
    if (
        !conditional ||
        !ts.isConditionalExpression(conditional) ||
        !ts.isBinaryExpression(conditional.condition) ||
        conditional.condition.operatorToken.kind !==
            ts.SyntaxKind.GreaterThanEqualsToken ||
        !ts.isIdentifier(conditional.condition.left) ||
        conditional.condition.left.text !== timeName ||
        !ts.isBinaryExpression(conditional.whenTrue) ||
        conditional.whenTrue.operatorToken.kind !==
            ts.SyntaxKind.PlusToken ||
        !ts.isIdentifier(conditional.whenFalse) ||
        !ts.isIdentifier(conditional.whenTrue.left)
    ) {
        refuse();
    }
    const selection = conditional as ts.ConditionalExpression;
    const condition = selection.condition as ts.BinaryExpression;
    const later = selection.whenTrue as ts.BinaryExpression;
    const earlier = selection.whenFalse as ts.Identifier;
    // The later key is the earlier one plus exactly one...
    if (
        !ts.isNumericLiteral(later.right) ||
        later.right.text !== "1" ||
        (later.left as ts.Identifier).text !== earlier.text
    ) {
        refuse();
    }
    // ...and the time it is compared against is the span's END, which is the
    // whole of what "at or past its own time" means. `t0`/`t1` are the two
    // keyframe times the branch's enclosing scope binds; naming the wrong one
    // would shift every held key by a span.
    const spanEnd = declaration.body.statements
        .flatMap((statement) =>
            ts.isVariableStatement(statement)
                ? statement.declarationList.declarations
                : [],
        )
        .find((binding) => {
            if (!ts.isIdentifier(binding.name) || !binding.initializer) {
                return false;
            }
            // `const t1 = input[idx + 1]!` -- the pin's own non-null
            // assertion sits between the binding and the access.
            const access = unwrapPin(binding.initializer);
            return (
                ts.isElementAccessExpression(access) &&
                ts.isBinaryExpression(access.argumentExpression) &&
                access.argumentExpression.operatorToken.kind ===
                    ts.SyntaxKind.PlusToken
            );
        });
    if (
        !spanEnd ||
        !ts.isIdentifier(spanEnd.name) ||
        !ts.isIdentifier(condition.right) ||
        condition.right.text !== spanEnd.name.text
    ) {
        refuse();
    }
}

/**
 * The animation-interpolation segment of the generated glTF loader,
 * lowered from `src/animation/evaluate.ts`: `normalizeQuat4`,
 * `quatSlerp`, and the CUBICSPLINE branch of `evaluateSampler`, the
 * latter emitted once per stride the loader's tracks carry (quaternion
 * rotations and vec3 translations/scales). The STEP branch has no
 * arithmetic to lower, so what it contributes here is a gate on the key it
 * selects.
 */
export function lowerAnimationInterpolationCpp(
    file: ts.SourceFile,
): string {
    const normalize = topLevelFunction(file, "normalizeQuat4");
    const slerp = topLevelFunction(file, "quatSlerp");
    const evaluate = topLevelFunction(file, "evaluateSampler");
    assertPinnedStepSelection(evaluate, file);
    const normalizePinName = normalize.name!.text;
    return [
        emitNormalizeQuaternion(normalize, file),
        emitInterpolateQuaternion(slerp, file, normalizePinName),
        emitCubicHermite(evaluate, file, normalizePinName, 4),
        emitCubicHermite(evaluate, file, normalizePinName, 3),
    ].join("\n\n");
}
