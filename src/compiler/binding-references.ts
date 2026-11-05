import ts from "typescript";
import { resolvedSymbol } from "./symbols.js";
import { referenceSite, specifierSourceName } from "./syntax.js";

/** @unjournaled Pure functions of the checked program, kept across replays. */
const namedIdentifiers = new WeakMap<
    ts.SourceFile,
    ReadonlyMap<string, readonly ts.Identifier[]>
>();

/** A file's identifiers outside type positions, by name. */
function identifiersByName(
    file: ts.SourceFile,
): ReadonlyMap<string, readonly ts.Identifier[]> {
    let known = namedIdentifiers.get(file);
    if (!known) {
        const names = new Map<string, ts.Identifier[]>();
        const visit = (node: ts.Node): void => {
            if (ts.isTypeNode(node)) return;
            if (ts.isIdentifier(node)) {
                const list = names.get(node.text);
                if (list) list.push(node);
                else names.set(node.text, [node]);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
        namedIdentifiers.set(file, (known = names));
    }
    return known;
}

/** Whether a declaration binds a name of its module's top level. */
function declaresModuleBinding(declaration: ts.Declaration): boolean {
    return (
        (ts.isVariableDeclaration(declaration) &&
            ts.isVariableStatement(declaration.parent.parent) &&
            ts.isSourceFile(declaration.parent.parent.parent)) ||
        (ts.isFunctionDeclaration(declaration) &&
            ts.isSourceFile(declaration.parent))
    );
}

/**
 * The names a file may read a binding by: its own, and the local names
 * imports or exports in the file give it.
 */
function localNames(
    byName: ReadonlyMap<string, readonly ts.Identifier[]>,
    name: string,
): Set<string> {
    const names = new Set([name]);
    for (const identifier of byName.get(name) ?? []) {
        const specifier = identifier.parent;
        if (
            (ts.isImportSpecifier(specifier) ||
                ts.isExportSpecifier(specifier)) &&
            specifier.propertyName === identifier
        )
            names.add(specifier.name.text);
    }
    return names;
}

/**
 * The expressions reading a binding: in its own file, and for a module
 * binding (a top-level variable or function) in every file of the program,
 * by its name or the local name an import gives it.
 */
export function bindingReferences(
    program: ts.Program,
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
): ts.Expression[] {
    const declaration = symbol.valueDeclaration;
    if (!declaration) return [];
    const moduleBinding = declaresModuleBinding(declaration);
    const files = moduleBinding
        ? program.getSourceFiles().filter((file) => !file.isDeclarationFile)
        : [declaration.getSourceFile()];
    const declared = ts.getNameOfDeclaration(declaration);
    return files.flatMap((file) => {
        const byName = identifiersByName(file);
        return [...localNames(byName, symbol.name)].flatMap((name) =>
            (byName.get(name) ?? []).flatMap((identifier) => {
                const site = referenceSite(identifier);
                // A namespace import reads a module binding as `m.name`.
                return site &&
                    identifier !== declared &&
                    !ts.isExportSpecifier(identifier.parent) &&
                    (site === identifier || moduleBinding) &&
                    resolvedSymbol(checker, identifier) === symbol
                    ? [site]
                    : [];
            }),
        );
    });
}

/**
 * Whether a module binding leaves a module under a name other than its
 * own: a default export, or an export of one of its local names under
 * another, whose importers read it by a name {@link bindingReferences}
 * does not follow.
 */
export function exportedUnderAnotherName(
    program: ts.Program,
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
): boolean {
    const declaration = symbol.valueDeclaration;
    if (
        declaration &&
        (ts.getCombinedModifierFlags(declaration) &
            ts.ModifierFlags.Default) !==
            0
    )
        return true;
    return program.getSourceFiles().some((file) => {
        if (file.isDeclarationFile) return false;
        const byName = identifiersByName(file);
        return [...localNames(byName, symbol.name)].some((name) =>
            (byName.get(name) ?? []).some((identifier) => {
                const parent = identifier.parent;
                const exported = ts.isExportSpecifier(parent)
                    ? specifierSourceName(parent) === identifier.text &&
                      parent.name.text !== symbol.name
                    : ts.isExportAssignment(parent) &&
                      parent.expression === identifier;
                return (
                    exported && resolvedSymbol(checker, identifier) === symbol
                );
            }),
        );
    });
}
