import { resolve } from "node:path";
import ts from "typescript";
import { apiHash, declarationKey, type ApiSurface } from "./api-surface.js";
import { repositoryRelativePath } from "./upstream-source.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    propertyNameText,
} from "./compiler/syntax.js";
import { sourceLocation } from "./source-location.js";
import { declaredSymbol, resolvedSymbol } from "./compiler/symbols.js";

export interface ApiUse {
    id: string;
    file: string;
    line: number;
    column: number;
    operation:
        | "call"
        | "construct"
        | "read"
        | "write"
        | "read-write"
        | "provide"
        | "reference";
    shape: string;
}

export interface ApiUsage {
    scope: string;
    files: { path: string; sha256: string }[];
    diagnostics: { file: string; line: number; message: string }[];
    /** Names imported from the surface's entry that it does not export (discovery scans only). */
    unresolved: string[];
    uses: ApiUse[];
}

const surfaceKinds = new WeakMap<ApiSurface, ReadonlyMap<string, string>>();

/** Discovery only: dead branches and unused bodies deliberately remain visible. */
export function scanApiUsage(
    program: ts.Program,
    surface: ApiSurface,
    root: string,
    reached?: ReadonlySet<ts.Node>,
): ApiUsage {
    const checker = program.getTypeChecker();
    const uses = new Map<string, ApiUse>();
    const files = program
        .getSourceFiles()
        .filter(
            (file) =>
                !file.isDeclarationFile &&
                !program.isSourceFileFromExternalLibrary(file),
        );
    const localFiles = new Set(files);
    /** The surface entries a resolved symbol's declarations belong to. */
    const ids = (symbol: ts.Symbol | undefined): string[] => {
        if (!symbol) return [];
        return [
            ...new Set(
                (symbol.declarations ?? []).flatMap(
                    (declaration) =>
                        surface.byDeclaration.get(
                            declarationKey(declaration),
                        ) ?? [],
                ),
            ),
        ];
    };
    let kinds = surfaceKinds.get(surface);
    if (!kinds) {
        kinds = new Map(
            surface.snapshot.items.map((item) => [item.id, item.kind]),
        );
        surfaceKinds.set(surface, kinds);
    }
    const add = (
        targets: readonly string[],
        node: ts.Node,
        operation: ApiUse["operation"],
        shape: () => string,
    ): void => {
        const selected = targets.filter(
            (id) =>
                !(operation === "read" && kinds.get(id) === "set") &&
                !(operation === "write" && kinds.get(id) === "get"),
        );
        if (!selected.length) return;
        const { file, line, character } = sourceLocation(node);
        const description = shape();
        for (const id of selected) {
            const use: ApiUse = {
                id,
                file: repositoryRelativePath(root, file.fileName),
                line,
                column: character,
                operation,
                shape: description,
            };
            uses.set(JSON.stringify(use), use);
        }
    };
    const properties = (type: ts.Type, name: string): string[] => [
        ...new Set(
            (type.isUnionOrIntersection() ? type.types : [type]).flatMap(
                (part) => ids(checker.getPropertyOfType(part, name)),
            ),
        ),
    ];
    const operation = (node: ts.Node): ApiUse["operation"] => {
        const parent = node.parent;
        if (isAssignmentExpression(parent) && parent.left === node) {
            return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ? "write"
                : "read-write";
        }
        if (isUpdateExpression(parent)) return "read-write";
        return "read";
    };
    const shape = (node: ts.Expression): string =>
        checker.typeToString(
            checker.getTypeAtLocation(node),
            node,
            ts.TypeFormatFlags.NoTruncation,
        );
    // The checker retains declaration provenance through aliases, spreads and
    // inferred option bags. Match those declarations to the parameter contract;
    // source evaluation and branch selection remain the lowerer's responsibility.
    const provided = (
        actual: ts.Type,
        expected: ts.Type,
        seen = new Map<ts.Type, Set<ts.Type>>(),
    ): void => {
        if (seen.get(actual)?.has(expected)) return;
        const targets = seen.get(actual) ?? new Set<ts.Type>();
        targets.add(expected);
        seen.set(actual, targets);
        for (const part of actual.isUnion() ? actual.types : [actual])
            for (const member of checker.getPropertiesOfType(part)) {
                for (const declaration of member.declarations ?? []) {
                    if (
                        (!ts.isPropertyAssignment(declaration) &&
                            !ts.isShorthandPropertyAssignment(declaration)) ||
                        !localFiles.has(declaration.getSourceFile())
                    )
                        continue;
                    const value = ts.isPropertyAssignment(declaration)
                        ? declaration.initializer
                        : declaration.name;
                    if (!reached || reached.has(declaration))
                        add(
                            properties(expected, member.name),
                            declaration,
                            "provide",
                            () => shape(value),
                        );
                    for (const contract of expected.isUnionOrIntersection()
                        ? expected.types
                        : [expected]) {
                        const target = checker.getPropertyOfType(
                            contract,
                            member.name,
                        );
                        if (target)
                            provided(
                                checker.getTypeOfSymbolAtLocation(
                                    member,
                                    declaration,
                                ),
                                checker.getTypeOfSymbolAtLocation(
                                    target,
                                    declaration,
                                ),
                                seen,
                            );
                    }
                }
            }
    };
    const unresolved = new Set<string>();
    const importsSurface = (specifier: ts.Expression): boolean => {
        const file = declaredSymbol(checker, specifier)?.declarations?.find(
            ts.isSourceFile,
        );
        return file !== undefined && resolve(file.fileName) === surface.entry;
    };
    const visit = (node: ts.Node): void => {
        if (
            ts.isImportDeclaration(node) &&
            node.importClause?.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            importsSurface(node.moduleSpecifier)
        ) {
            for (const element of node.importClause.namedBindings.elements) {
                const name = (element.propertyName ?? element.name).text;
                if (!Object.hasOwn(surface.snapshot.exports, name))
                    unresolved.add(name);
            }
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const signature = checker.getResolvedSignature(node);
            const declaration = signature?.declaration;
            if (declaration)
                add(
                    surface.byDeclaration.get(declarationKey(declaration)) ??
                        [],
                    node,
                    ts.isNewExpression(node) ? "construct" : "call",
                    () => `(${(node.arguments ?? []).map(shape).join(", ")})`,
                );
            for (const [index, argument] of (node.arguments ?? []).entries()) {
                const parameter = signature?.parameters[index];
                if (parameter)
                    provided(
                        checker.getTypeAtLocation(argument),
                        checker.getTypeOfSymbolAtLocation(parameter, node),
                    );
            }
        } else if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            if (!(
                (ts.isCallExpression(node.parent) ||
                    ts.isNewExpression(node.parent)) &&
                node.parent.expression === node
            )) {
                const name = ts.isPropertyAccessExpression(node)
                    ? node.name
                    : node.argumentExpression;
                add(
                    ids(resolvedSymbol(checker, name)),
                    node,
                    operation(node),
                    () => shape(node),
                );
            }
        } else if (
            (ts.isPropertyAssignment(node) ||
                ts.isShorthandPropertyAssignment(node) ||
                ts.isMethodDeclaration(node)) &&
            ts.isObjectLiteralExpression(node.parent)
        ) {
            const context = checker.getContextualType(node.parent);
            const name = propertyNameText(node.name);
            if (context && name !== undefined) {
                add(properties(context, name), node, "provide", () =>
                    ts.isPropertyAssignment(node)
                        ? shape(node.initializer)
                        : name,
                );
            }
        } else if (
            ts.isBindingElement(node) &&
            ts.isObjectBindingPattern(node.parent)
        ) {
            const name = node.propertyName ?? node.name;
            if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
                add(
                    properties(
                        checker.getTypeAtLocation(node.parent),
                        name.text,
                    ),
                    node,
                    "read",
                    () => name.text,
                );
            }
        } else if (ts.isIdentifier(node)) {
            const targets = ids(resolvedSymbol(checker, node));
            const constants = targets.filter(
                (id) =>
                    kinds.get(id) === "variable" ||
                    kinds.get(id) === "enum-member",
            );
            if (constants.length)
                add(constants, node, "read", () => shape(node));
            else if (
                ts.isExpressionStatement(node.parent) ||
                (ts.isVariableDeclaration(node.parent) &&
                    node.parent.initializer === node)
            ) {
                add(targets, node, "reference", () => node.getText());
            }
        }
        if (!reached) ts.forEachChild(node, visit);
    };
    if (reached) {
        for (const node of reached)
            if (localFiles.has(node.getSourceFile())) visit(node);
    } else files.forEach(visit);
    const diagnostics = reached
        ? []
        : files.flatMap((file) =>
              [
                  ...program.getSyntacticDiagnostics(file),
                  ...program.getSemanticDiagnostics(file),
              ].map((diagnostic) => ({
                  file: repositoryRelativePath(root, file.fileName),
                  line:
                      file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
                          .line + 1,
                  message: ts.flattenDiagnosticMessageText(
                      diagnostic.messageText,
                      " ",
                  ),
              })),
          );
    return {
        scope: reached
            ? "Sites visited during successful lowering; evidence is limited to these source forms."
            : "Static source references, including unused bodies. Resolution and contextual fields are candidates, not proof of native support.",
        files: files
            .map((file) => ({
                path: repositoryRelativePath(root, file.fileName),
                sha256: apiHash(file.text),
            }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        diagnostics,
        unresolved: [...unresolved].sort(),
        uses: [...uses.values()].sort(
            (a, b) =>
                a.id.localeCompare(b.id) ||
                a.file.localeCompare(b.file) ||
                a.line - b.line ||
                a.column - b.column,
        ),
    };
}
