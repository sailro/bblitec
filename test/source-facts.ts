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
    lockSetter: boolean;
    barrel: boolean;
}

const cache = new Map<string, SourceFacts>();

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
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false);
    const facts: SourceFacts = {
        imports: new Map(), declarations: new Set(), members: new Set(),
        calls: new Set(), constructs: new Set(), lockSetter: false,
        barrel: file.statements.length > 0 && file.statements.every(ts.isExportDeclaration),
    };
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const names = new Set<string>();
            const clause = node.importClause;
            if (clause?.name) names.add(clause.name.text);
            const bindings = clause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
            }
            facts.imports.set(node.moduleSpecifier.text, names);
        }
        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
            ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
            facts.declarations.add(node.name.text);
        }
        if (ts.isPropertyAccessExpression(node)) facts.members.add(node.name.text);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const name = expressionName(node.expression);
            if (name) (ts.isCallExpression(node) ? facts.calls : facts.constructs).add(name);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            expressionName(node.left) === "process.env.BBLITE_DIST_LOCK_HELD" &&
            ts.isStringLiteral(node.right) && node.right.text === "1") facts.lockSetter = true;
        if (ts.isPropertyAssignment(node) &&
            (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "BBLITE_DIST_LOCK_HELD" &&
            ts.isStringLiteral(node.initializer) && node.initializer.text === "1") facts.lockSetter = true;
        ts.forEachChild(node, visit);
    };
    visit(file);
    cache.set(path, facts);
    return facts;
}

export function declarationOwners(name: string): string[] {
    return sourcePaths.filter((path) => sourceFacts(path).declarations.has(name));
}
