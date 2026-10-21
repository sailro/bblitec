import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

export const sourcePaths = readdirSync("src", { recursive: true })
    .map((name) => `src/${String(name).replaceAll("\\", "/")}`)
    .filter((path) => path.endsWith(".ts"));

interface SourceFacts {
    imports: Map<string, Set<string>>;
    declarations: Set<string>;
    members: Set<string>;
    calls: Set<string>;
    constructs: Set<string>;
    /** `parent.name === node`-style tests of the role a name plays in its parent. */
    nameRoleTests: number;
    /** `ts.isIdentifier(x) || ts.isStringLiteral(x)`-style rules for the key a name spells. */
    keyRuleTests: number;
    /** `x.propertyName ? ... : x.name` / `x.propertyName ?? x.name`: a destructuring or specifier name rule. */
    propertyNameRules: number;
    lockSetter: boolean;
    barrel: boolean;
}

const cache = new Map<string, SourceFacts>();

const literalTests = new Set([
    "isStringLiteral",
    "isStringLiteralLike",
    "isNumericLiteral",
    "isNoSubstitutionTemplateLiteral",
]);

/** The `||` operands of a chain, through parentheses. */
function disjuncts(node: ts.Expression): ts.Expression[] {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ? [...disjuncts(node.left), ...disjuncts(node.right)]
        : [node];
}

/** Whether a `||` is no operand of an enclosing `||`. */
function outermostDisjunction(node: ts.BinaryExpression): boolean {
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    return !(
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
    );
}

/** Whether a chain tests one operand for an identifier and for a literal. */
function keyRule(chain: ts.BinaryExpression): boolean {
    const tests = new Map<string, Set<string>>();
    for (const part of disjuncts(chain)) {
        if (
            !ts.isCallExpression(part) ||
            part.arguments.length !== 1 ||
            !ts.isPropertyAccessExpression(part.expression) ||
            expressionName(part.expression.expression) !== "ts"
        )
            continue;
        const operand = part.arguments[0]!.getText();
        const names = tests.get(operand) ?? new Set<string>();
        names.add(part.expression.name.text);
        tests.set(operand, names);
    }
    return [...tests.values()].some(
        (names) =>
            names.has("isIdentifier") &&
            [...names].some((name) => literalTests.has(name)),
    );
}

function expressionName(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) return node.text;
    if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
    if (ts.isPropertyAccessExpression(node)) {
        const owner = expressionName(node.expression);
        return owner && `${owner}.${node.name.text}`;
    }
    return undefined;
}

/** Structural dependency facts, independent of whitespace and comments. */
export function sourceFacts(path: string): SourceFacts {
    const previous = cache.get(path);
    if (previous) return previous;
    const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    const facts: SourceFacts = {
        imports: new Map(),
        declarations: new Set(),
        members: new Set(),
        calls: new Set(),
        constructs: new Set(),
        nameRoleTests: 0,
        keyRuleTests: 0,
        propertyNameRules: 0,
        lockSetter: false,
        barrel:
            file.statements.length > 0 &&
            file.statements.every(ts.isExportDeclaration),
    };
    const visit = (node: ts.Node): void => {
        if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            const names = new Set<string>();
            const clause = node.importClause;
            if (clause?.name) names.add(clause.name.text);
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements)
                    names.add((element.propertyName ?? element.name).text);
            }
            facts.imports.set(node.moduleSpecifier.text, names);
        }
        if (
            (ts.isFunctionDeclaration(node) ||
                ts.isClassDeclaration(node) ||
                ts.isInterfaceDeclaration(node) ||
                ts.isTypeAliasDeclaration(node) ||
                ts.isVariableDeclaration(node)) &&
            node.name &&
            ts.isIdentifier(node.name)
        ) {
            facts.declarations.add(node.name.text);
        }
        if (ts.isPropertyAccessExpression(node))
            facts.members.add(node.name.text);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const name = expressionName(node.expression);
            if (name)
                (ts.isCallExpression(node)
                    ? facts.calls
                    : facts.constructs
                ).add(name);
        }
        if (
            ts.isBinaryExpression(node) &&
            (node.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken ||
                node.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
            [node.left, node.right].some(
                (side, index, sides) =>
                    ts.isPropertyAccessExpression(side) &&
                    ["name", "propertyName", "label"].includes(
                        side.name.text,
                    ) &&
                    /(^|\.)parent$/.test(
                        expressionName(side.expression) ?? "",
                    ) &&
                    ts.isIdentifier(sides[1 - index]!),
            )
        )
            facts.nameRoleTests++;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
            outermostDisjunction(node) &&
            keyRule(node)
        )
            facts.keyRuleTests++;
        const chosen = ts.isConditionalExpression(node)
            ? node.condition
            : ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
              ? node.left
              : undefined;
        if (
            chosen &&
            ts.isPropertyAccessExpression(chosen) &&
            chosen.name.text === "propertyName"
        )
            facts.propertyNameRules++;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            expressionName(node.left) === "process.env.BBLITE_DIST_LOCK_HELD" &&
            ts.isStringLiteral(node.right) &&
            node.right.text === "1"
        )
            facts.lockSetter = true;
        if (
            ts.isPropertyAssignment(node) &&
            (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
            node.name.text === "BBLITE_DIST_LOCK_HELD" &&
            ts.isStringLiteral(node.initializer) &&
            node.initializer.text === "1"
        )
            facts.lockSetter = true;
        ts.forEachChild(node, visit);
    };
    visit(file);
    cache.set(path, facts);
    return facts;
}

export function declarationOwners(name: string): string[] {
    return sourcePaths.filter((path) =>
        sourceFacts(path).declarations.has(name),
    );
}
