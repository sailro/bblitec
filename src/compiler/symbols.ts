import ts from "typescript";

const babylonPackages = ["babylon-lite", "@babylonjs/lite"];

/**
 * Whether an import specifier names the pinned package. A scene reaches a
 * pinned module either through the package entry point or through one of its
 * subpaths (`babylon-lite/material/tracking/pbr-tracking`), which the pin's
 * own scenes use for the modules its entry point does not re-export. Both
 * spellings name the same pinned code, so both dispatch by the imported name.
 */
function isBabylonModule(specifier: string): boolean {
    return babylonPackages.some(
        (packageName) =>
            specifier === packageName ||
            specifier.startsWith(`${packageName}/`),
    );
}

export class CompilerSymbols {
    public constructor(
        private readonly checker: ts.TypeChecker,
    ) {}

    public valueSymbol(
        identifier: ts.Identifier,
    ): ts.Symbol | undefined {
        const symbol =
            ts.isShorthandPropertyAssignment(
                identifier.parent,
            ) &&
            identifier.parent.name === identifier
                ? this.checker.getShorthandAssignmentValueSymbol(
                      identifier.parent,
                  )
                : this.checker.getSymbolAtLocation(identifier);
        if (!symbol) {
            return undefined;
        }
        return (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? this.checker.getAliasedSymbol(symbol)
            : symbol;
    }

    /**
     * The file a named import's declaration lives in. Used where a value's
     * *module* is the thing that matters rather than its name — a drawn
     * sprite atlas is materialized by running the module that draws it.
     */
    public declarationSourcePath(
        identifier: ts.Identifier,
    ): string | undefined {
        const declaration =
            this.valueSymbol(identifier)?.declarations?.[0];
        return declaration?.getSourceFile().fileName;
    }

    public importedName(
        identifier: ts.Identifier,
    ): string | undefined {
        const symbol = this.checker.getSymbolAtLocation(identifier);
        const declaration = symbol?.declarations?.find(
            ts.isImportSpecifier,
        );
        if (!symbol || !declaration) {
            return undefined;
        }
        const importDeclaration =
            declaration.parent.parent.parent;
        if (
            !ts.isImportDeclaration(importDeclaration) ||
            !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
            !isBabylonModule(importDeclaration.moduleSpecifier.text)
        ) {
            return undefined;
        }
        return declaration.propertyName?.text ??
            declaration.name.text;
    }
}
