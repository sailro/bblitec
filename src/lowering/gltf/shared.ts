import ts from "typescript";
import { doubleLiteral, floatLiteral } from "../../cpp-literals.js";

export const laneMembers = ["x", "y", "z", "w"] as const;

export interface RenderedCpp {
    text: string;
    /** How tightly the text binds, for minimal re-parenthesization. */
    precedence: number;
}

export interface CppExpressionScope {
    /** The pinned symbol, for refusal messages. */
    symbol: string;
    file: ts.SourceFile;
    /** Pin identifier → C++ identifier. Unknown identifiers refuse. */
    names: ReadonlyMap<string, string>;
    /** Pin locals inlined at their use sites, pre-rendered per lane. */
    substitutions?: ReadonlyMap<string, RenderedCpp>;
    /** How a numeric literal prints: a JavaScript double or a C++ enum. */
    numeric: (literal: ts.NumericLiteral) => string;
    /** Resolves `buf[...]` element reads, e.g. to a vector member. */
    elementRead?: (expression: ts.ElementAccessExpression) => RenderedCpp;
    /** Resolves `s?.prop` optional reads (the sampler's enum locals). */
    chainRead?: (expression: ts.PropertyAccessChain) => RenderedCpp;
}

export function refuseNode(
    symbol: string,
    file: ts.SourceFile,
    node: ts.Node,
    reason: string,
): never {
    throw new Error(
        `Pinned ${symbol} ${reason}: ${node.getText(file)}.`,
    );
}

export function unwrapPin(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAsExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

interface PinnedBinding {
    name: string;
    initializer: ts.Expression;
    isConst: boolean;
    statement: ts.VariableStatement;
}

/** A `const x = …` / `let x = …` statement with exactly one binding. */
export function singleBinding(
    symbol: string,
    file: ts.SourceFile,
    statement: ts.Statement | undefined,
    anchor: ts.Node,
): PinnedBinding {
    if (!statement || !ts.isVariableStatement(statement)) {
        refuseNode(
            symbol,
            file,
            statement ?? anchor,
            "no longer declares the local this lowering expects",
        );
    }
    const declarations = statement.declarationList.declarations;
    const declaration = declarations.length === 1
        ? declarations[0]
        : undefined;
    if (
        !declaration ||
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer
    ) {
        refuseNode(
            symbol,
            file,
            statement,
            "declares a binding this lowering cannot carry",
        );
    }
    return {
        name: declaration.name.text,
        initializer: declaration.initializer,
        isConst:
            (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
        statement,
    };
}

export function identifierParameters(
    symbol: string,
    file: ts.SourceFile,
    declaration: ts.FunctionDeclaration,
): string[] {
    return declaration.parameters.map((parameter) => {
        if (!ts.isIdentifier(parameter.name)) {
            refuseNode(
                symbol,
                file,
                parameter,
                "takes a destructured parameter this lowering cannot carry",
            );
        }
        return parameter.name.text;
    });
}

export function topLevelFunction(
    file: ts.SourceFile,
    symbolName: string,
): ts.FunctionDeclaration & { body: ts.Block } {
    const declaration = file.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === symbolName &&
            statement.body !== undefined,
    );
    if (!declaration?.body) {
        throw new Error(
            `Pinned function '${symbolName}' with a body was not found ` +
                `in ${file.fileName}.`,
        );
    }
    return declaration as ts.FunctionDeclaration & { body: ts.Block };
}

/**
 * A run of `buf[base + lane] = …` stores covering lanes 0..count-1 in
 * order — the pin's Float32Array writes that become one vector build.
 */
export function collectLaneStores(
    scope: CppExpressionScope,
    statements: readonly ts.Statement[],
    start: number,
    count: number,
    laneOf: (target: ts.ElementAccessExpression) => number | undefined,
): { expressions: ts.Expression[]; next: number } {
    const expressions: ts.Expression[] = [];
    let index = start;
    for (let lane = 0; lane < count; lane += 1) {
        const statement = statements[index];
        const assignment = statement &&
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? statement.expression
            : undefined;
        if (
            !assignment ||
            !ts.isElementAccessExpression(assignment.left) ||
            laneOf(assignment.left) !== lane
        ) {
            refuseNode(
                scope.symbol,
                scope.file,
                statement ?? statements[start] ?? scope.file,
                `no longer stores lane ${lane} where this lowering expects it`,
            );
        }
        expressions.push(assignment.right);
        index += 1;
    }
    return { expressions, next: index };
}

export const pinnedDoubleLiteral = (literal: ts.NumericLiteral): string =>
    doubleLiteral(Number(literal.text));

/** Flattens a left-associated `a + b + c + …` chain into its terms. */
export function additiveTerms(expression: ts.Expression): ts.Expression[] {
    const node = unwrapPin(expression);
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
        return [...additiveTerms(node.left), node.right];
    }
    return [expression];
}

export function refuseModule(symbol: string, reason: string): never {
    throw new Error(`Pinned ${symbol} ${reason}.`);
}

/** A numeric literal, allowing one leading unary minus. */
export function signedNumericValue(
    symbol: string,
    file: ts.SourceFile,
    expression: ts.Expression,
): number {
    const node = unwrapPin(expression);
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken
    ) {
        const operand = unwrapPin(node.operand);
        if (ts.isNumericLiteral(operand)) {
            return -Number(operand.text);
        }
    }
    if (ts.isNumericLiteral(node)) {
        return Number(node.text);
    }
    refuseNode(
        symbol,
        file,
        expression,
        "uses a constant this lowering cannot evaluate",
    );
}

/** The `a.b.c` property path of an assignment target, or undefined. */
export function pinnedPropertyPath(
    expression: ts.Expression,
): string[] | undefined {
    const node = unwrapPin(expression);
    if (ts.isIdentifier(node)) {
        return [node.text];
    }
    if (ts.isPropertyAccessExpression(node)) {
        const owner = pinnedPropertyPath(node.expression);
        return owner ? [...owner, node.name.text] : undefined;
    }
    return undefined;
}

/** Every `path = …` assignment under `root`, matched by property path. */
export function pinnedAssignments(
    root: ts.Node,
    path: string,
): ts.BinaryExpression[] {
    const result: ts.BinaryExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            pinnedPropertyPath(node.left)?.join(".") === path
        ) {
            result.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return result;
}

/**
 * The single `memberName` handler of a pinned feature module — the
 * `applyMaterial` method on the module's exported feature literal.
 */
export function featureMethod(
    file: ts.SourceFile,
    symbol: string,
    memberName: string,
): ts.FunctionLikeDeclarationBase & { body: ts.Block } {
    const found: (ts.FunctionLikeDeclarationBase & { body: ts.Block })[] =
        [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isMethodDeclaration(node) ||
                ts.isPropertyAssignment(node)) &&
            node.name !== undefined &&
            ts.isIdentifier(node.name) &&
            node.name.text === memberName
        ) {
            const candidate = ts.isMethodDeclaration(node)
                ? node
                : ts.isFunctionExpression(node.initializer) ||
                        ts.isArrowFunction(node.initializer)
                    ? node.initializer
                    : undefined;
            if (candidate?.body && ts.isBlock(candidate.body)) {
                found.push(
                    candidate as ts.FunctionLikeDeclarationBase & {
                        body: ts.Block;
                    },
                );
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (found.length !== 1) {
        refuseModule(
            symbol,
            `no longer declares a single '${memberName}' handler`,
        );
    }
    return found[0]!;
}

export const pinnedFloatLiteral = (literal: ts.NumericLiteral): string =>
    floatLiteral(Number(literal.text));

export function identifierText(
    expression: ts.Expression,
): string | undefined {
    const node = unwrapPin(expression);
    return ts.isIdentifier(node) ? node.text : undefined;
}

export function collectNodes<T extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is T,
): T[] {
    const result: T[] = [];
    const visit = (node: ts.Node): void => {
        if (predicate(node)) result.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return result;
}

/** A left-associated `a (+|-) b (+|-) c` chain as parts and operators. */
export function additiveChainParts(expression: ts.Expression): {
    parts: ts.Expression[];
    operators: ("+" | "-")[];
} {
    const node = unwrapPin(expression);
    if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
            node.operatorToken.kind === ts.SyntaxKind.MinusToken)
    ) {
        const left = additiveChainParts(node.left);
        return {
            parts: [...left.parts, node.right],
            operators: [
                ...left.operators,
                node.operatorToken.kind === ts.SyntaxKind.PlusToken
                    ? "+"
                    : "-",
            ],
        };
    }
    return { parts: [expression], operators: [] };
}

/** `Math.<name>(...)` → the call, or undefined. */
export function mathCall(
    expression: ts.Expression,
    name: string,
): ts.CallExpression | undefined {
    const node = unwrapPin(expression);
    return ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            identifierText(node.expression.expression) === "Math" &&
            node.expression.name.text === name
        ? node
        : undefined;
}

export function isMathPi(expression: ts.Expression): boolean {
    const node = unwrapPin(expression);
    return ts.isPropertyAccessExpression(node) &&
        identifierText(node.expression) === "Math" &&
        node.name.text === "PI";
}

/**
 * Evaluates the constant subset the round-3 defaults use: literals, a
 * leading minus, `Math.PI`, and products/quotients of those. The spot
 * default `Math.PI / 4` evaluates here to the double the record bakes.
 */
export function pinnedConstantValue(
    symbol: string,
    file: ts.SourceFile,
    expression: ts.Expression,
): number {
    const node = unwrapPin(expression);
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken
    ) {
        return -pinnedConstantValue(symbol, file, node.operand);
    }
    if (isMathPi(node)) return Math.PI;
    if (ts.isBinaryExpression(node)) {
        const left = pinnedConstantValue(symbol, file, node.left);
        const right = pinnedConstantValue(symbol, file, node.right);
        if (node.operatorToken.kind === ts.SyntaxKind.SlashToken) {
            return left / right;
        }
        if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
            return left * right;
        }
    }
    refuseNode(
        symbol,
        file,
        expression,
        "uses a default this lowering cannot evaluate",
    );
}

/**
 * The pin's RH→LH root conversion (`gltf-parser.ts#RH_TO_LH_ROOT`): the
 * single sixteen-entry F32 literal, verified diagonal with exactly one
 * axis flipped by -1 and a unit homogeneous lane, and verified to be the
 * parent `computeNodeWorldMatrix` multiplies onto hierarchy roots. The
 * record folds this diagonal into its consumption sites instead of
 * multiplying it at the root — see the round-3 notes in
 * `matrix-leaves.ts`.
 */
export function pinnedRootFlip(
    file: ts.SourceFile,
): { lane: number; sign: number } {
    const symbol = "RH_TO_LH_ROOT";
    const candidates: { name: string; values: number[] }[] = [];
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of
            statement.declarationList.declarations) {
            if (
                !ts.isIdentifier(declaration.name) ||
                !declaration.initializer
            ) {
                continue;
            }
            const value = unwrapPin(declaration.initializer);
            if (
                !ts.isNewExpression(value) ||
                identifierText(value.expression) !== "F32" ||
                value.arguments?.length !== 1
            ) {
                continue;
            }
            const argument = unwrapPin(value.arguments[0]!);
            if (
                !ts.isArrayLiteralExpression(argument) ||
                argument.elements.length !== 16
            ) {
                continue;
            }
            candidates.push({
                name: declaration.name.text,
                values: argument.elements.map((element) =>
                    signedNumericValue(symbol, file, element)
                ),
            });
        }
    }
    if (candidates.length !== 1) {
        refuseModule(
            symbol,
            "is no longer the parser's single sixteen-entry F32 literal",
        );
    }
    const root = candidates[0]!;
    for (let index = 0; index < 16; index += 1) {
        if (index % 5 !== 0 && root.values[index] !== 0) {
            refuseModule(symbol, "is no longer a diagonal matrix");
        }
    }
    if (root.values[15] !== 1) {
        refuseModule(symbol, "no longer keeps a unit homogeneous lane");
    }
    const flips = [0, 1, 2].filter(
        (lane) => root.values[lane * 5] !== 1,
    );
    if (flips.length !== 1 || root.values[flips[0]! * 5] !== -1) {
        refuseModule(symbol, "no longer flips exactly one axis by -1");
    }
    const compute = topLevelFunction(file, "computeNodeWorldMatrix");
    const usedAsRoot = collectNodes(
        compute,
        (node): node is ts.ConditionalExpression =>
            ts.isConditionalExpression(node) &&
            identifierText(node.whenFalse) === root.name,
    ).length > 0;
    if (!usedAsRoot) {
        refuseNode(
            symbol,
            file,
            compute,
            "no longer parents hierarchy roots on the RH→LH conversion",
        );
    }
    return { lane: flips[0]!, sign: -1 };
}

/**
 * Resolves an identifier argument back to its `const` declaration
 * inside `root`, for tying a call argument to the binding whose
 * initializer carries the pinned default.
 */
export function declarationOf(
    root: ts.Node,
    name: string,
): ts.VariableDeclaration | undefined {
    return collectNodes(
        root,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name,
    )[0];
}

/**
 * Refuses unless `root` still reads every named property (as a property
 * access, a string literal, or a bare identifier — the spellings a JSON
 * walk uses). The anchor that keeps a lowered walk honest about the keys
 * it mirrors.
 */
export function requirePropertyReads(
    symbol: string,
    root: ts.Node,
    names: readonly string[],
): void {
    for (const name of names) {
        const carried = collectNodes(
            root,
            (node): node is ts.Node =>
                ((ts.isPropertyAccessExpression(node) ||
                    ts.isPropertyAccessChain(node)) &&
                    node.name.text === name) ||
                (ts.isStringLiteral(node) && node.text === name) ||
                (ts.isIdentifier(node) && node.text === name),
        ).length > 0;
        if (!carried) {
            refuseModule(
                symbol,
                `no longer reads the '${name}' property`,
            );
        }
    }
}

/** `<base>.<key> ?? <default>` → the key and the default expression. */
export function coalescedPropertyDefault(
    expression: ts.Expression,
): { key: string; fallback: ts.Expression; read: ts.Expression } | undefined {
    const node = unwrapPin(expression);
    if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
        return undefined;
    }
    const read = unwrapPin(node.left);
    if (
        !ts.isPropertyAccessExpression(read) &&
        !ts.isPropertyAccessChain(read)
    ) {
        return undefined;
    }
    return { key: read.name.text, fallback: node.right, read };
}
