import ts from "typescript";

const babylonModules = new Set([
    "babylon-lite",
    "@babylonjs/lite",
]);

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
            !babylonModules.has(importDeclaration.moduleSpecifier.text)
        ) {
            return undefined;
        }
        return declaration.propertyName?.text ??
            declaration.name.text;
    }
}
