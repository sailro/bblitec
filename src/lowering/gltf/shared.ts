import type { RenderedCpp } from "../pinned-numeric-expression.js";
import ts from "typescript";
import { doubleLiteral } from "../../cpp-literals.js";
import {
    findNodes,
    nullishDefault,
    numericValue,
    topLevelFunctionDeclaration,
    unwrapExpression,
} from "../context.js";

// The AST reads the leaves share with every other lowering come from the
// context module; the leaves import them here beside the family's own
// helpers.
export { findNodes, unwrapExpression };

export const laneMembers = ["x", "y", "z", "w"] as const;

export type { RenderedCpp } from "../pinned-numeric-expression.js";

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
    /** Resolves a pinned record field through its native storage mapping. */
    propertyRead?: (expression: ts.PropertyAccessExpression) => RenderedCpp;
    /** Resolves a non-Math call whose host operation has a correspondence. */
    callRead?: (expression: ts.CallExpression) => RenderedCpp;
}

export function refuseNode(
    symbol: string,
    file: ts.SourceFile,
    node: ts.Node,
    reason: string,
): never {
    throw new Error(`Pinned ${symbol} ${reason}: ${node.getText(file)}.`);
}

interface PinnedBinding {
    name: string;
    initializer: ts.Expression;
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
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
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
        statement,
    };
}

export function identifierParameters(
    symbol: string,
    file: ts.SourceFile,
    declaration: ts.FunctionDeclaration | ts.ArrowFunction,
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
    const declaration = topLevelFunctionDeclaration(file, symbolName);
    if (!declaration) {
        throw new Error(
            `Pinned function '${symbolName}' with a body was not found ` +
                `in ${file.fileName}.`,
        );
    }
    return declaration;
}

export const pinnedDoubleLiteral = (literal: ts.NumericLiteral): string =>
    doubleLiteral(Number(literal.text));

export function refuseModule(symbol: string, reason: string): never {
    throw new Error(`Pinned ${symbol} ${reason}.`);
}

/**
 * A number the pin states as a constant -- a literal, its negation,
 * `Math.PI`, arithmetic over those (the spot default `Math.PI / 4`) or a
 * module constant -- refused in this family's voice.
 */
function pinnedNumericValue(
    symbol: string,
    file: ts.SourceFile,
    expression: ts.Expression,
): number {
    return numericValue(expression, file, {
        refuse: (node, at) =>
            refuseNode(
                symbol,
                at,
                node,
                "uses a constant this lowering cannot evaluate",
            ),
    });
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
    const found: (ts.FunctionLikeDeclarationBase & { body: ts.Block })[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
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

export function identifierText(expression: ts.Expression): string | undefined {
    const node = unwrapExpression(expression);
    return ts.isIdentifier(node) ? node.text : undefined;
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
export function pinnedRootFlip(file: ts.SourceFile): {
    lane: number;
    sign: number;
} {
    const symbol = "RH_TO_LH_ROOT";
    const candidates: { name: string; values: number[] }[] = [];
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (
                !ts.isIdentifier(declaration.name) ||
                !declaration.initializer
            ) {
                continue;
            }
            const value = unwrapExpression(declaration.initializer);
            if (
                !ts.isNewExpression(value) ||
                identifierText(value.expression) !== "F32" ||
                value.arguments?.length !== 1
            ) {
                continue;
            }
            const argument = unwrapExpression(value.arguments[0]!);
            if (
                !ts.isArrayLiteralExpression(argument) ||
                argument.elements.length !== 16
            ) {
                continue;
            }
            candidates.push({
                name: declaration.name.text,
                values: argument.elements.map((element) =>
                    pinnedNumericValue(symbol, file, element),
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
    const flips = [0, 1, 2].filter((lane) => root.values[lane * 5] !== 1);
    if (flips.length !== 1 || root.values[flips[0]! * 5] !== -1) {
        refuseModule(symbol, "no longer flips exactly one axis by -1");
    }
    const compute = topLevelFunction(file, "computeNodeWorldMatrix");
    const usedAsRoot =
        findNodes(
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
        const carried =
            findNodes(
                root,
                (node): node is ts.Node =>
                    ((ts.isPropertyAccessExpression(node) ||
                        ts.isPropertyAccessChain(node)) &&
                        node.name.text === name) ||
                    (ts.isStringLiteral(node) && node.text === name) ||
                    (ts.isIdentifier(node) && node.text === name),
            ).length > 0;
        if (!carried) {
            refuseModule(symbol, `no longer reads the '${name}' property`);
        }
    }
}

/**
 * `<base>.<key> ?? <default>` → the key and the default expression. The
 * operator defaults to `??`; a caller anchoring a pinned `||` default
 * (the falsy-name fallbacks) passes `BarBarToken`.
 */
export function coalescedPropertyDefault(
    expression: ts.Expression,
    operator: ts.SyntaxKind = ts.SyntaxKind.QuestionQuestionToken,
): { key: string; fallback: ts.Expression; read: ts.Expression } | undefined {
    const split = nullishDefault(expression, operator);
    if (!split) return undefined;
    const read = unwrapExpression(split.left);
    if (
        !ts.isPropertyAccessExpression(read) &&
        !ts.isPropertyAccessChain(read)
    ) {
        return undefined;
    }
    return { key: read.name.text, fallback: split.right, read };
}
