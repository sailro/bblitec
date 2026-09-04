import ts from "typescript";

/** The two names a scene spells the pinned package with. */
export const babylonPackages = [
    "babylon-lite",
    "@babylonjs/lite",
] as const;

/**
 * Whether an import specifier names the pinned package. A scene reaches a
 * pinned module either through the package entry point or through one of its
 * subpaths (`babylon-lite/material/tracking/pbr-tracking`), which the pin's
 * own scenes use for the modules its entry point does not re-export. Both
 * spellings name the same pinned code, so both dispatch by the imported name.
 *
 * The one answer to this question: module resolution
 * (`program.ts`) and the capture harness's specifier rewrite
 * (`capture-suite-reference.ts`) read it too, so a subpath cannot be pinned
 * for one of them and unknown to another.
 */
export function isBabylonModule(specifier: string): boolean {
    return babylonPackages.some(
        (packageName) =>
            specifier === packageName ||
            specifier.startsWith(`${packageName}/`),
    );
}

/**
 * The package a scene loads the physics solver's WASM module from.
 *
 * The pin takes that module as a parameter (`createHavokWorld(scene, hknp)`)
 * and calls only `HP_*` entry points on it, so what this package names is
 * the *browser's* back end. A native build reaches its own through the PAL
 * and links nothing from here — the package is a devDependency serving the
 * reference page alone, which is what lets a physics scene have a golden at
 * all (`docs/fidelity.md#physics-contract`).
 */
export const physicsEngineModulePackage = "@babylonjs/havok";

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
        const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? this.checker.getAliasedSymbol(symbol)
            : symbol;
        // A constructor parameter-property has one declaration but the
        // checker may expose its declaration-name symbol at the parameter
        // and its property-flavoured symbol at a use in the constructor
        // body. Canonicalize both through that shared parameter declaration
        // so lexical lookup does not depend on which view the checker gave
        // the particular identifier.
        const parameter = resolved.declarations?.find(
            ts.isParameter,
        );
        if (
            parameter &&
            ts.isIdentifier(parameter.name) &&
            ts.isParameterPropertyDeclaration(
                parameter,
                parameter.parent,
            )
        ) {
            return (
                this.checker.getSymbolAtLocation(
                    parameter.name,
                ) ?? resolved
            );
        }
        return resolved;
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

    /** Whether generation can reach this value through a module import. */
    public isModuleExport(identifier: ts.Identifier): boolean {
        const value = this.valueSymbol(identifier);
        const declaration = value?.declarations?.[0];
        if (!value || !declaration) return false;
        const sourceSymbol = this.checker.getSymbolAtLocation(
            declaration.getSourceFile(),
        );
        for (const exported of sourceSymbol?.exports?.values() ?? []) {
            const resolved =
                (exported.flags & ts.SymbolFlags.Alias) !== 0
                    ? this.checker.getAliasedSymbol(exported)
                    : exported;
            if (resolved === value) return true;
        }
        return false;
    }

    /**
     * The module an identifier was imported from, or undefined when it is
     * not an import. Both spellings resolve here: a NAMED import, whose
     * specifier nests three levels under the declaration, and a DEFAULT
     * import, whose clause is the declaration's direct child.
     */
    private importModuleSpecifier(
        identifier: ts.Identifier,
    ):
        | {
              specifier: string;
              named?: ts.ImportSpecifier;
              nonNamed?: true;
              typeOnly?: true;
          }
        | undefined {
        const declarations =
            this.checker.getSymbolAtLocation(identifier)?.declarations;
        const named = declarations?.find(ts.isImportSpecifier);
        const namespace = declarations?.find(ts.isNamespaceImport);
        const clause =
            declarations?.find(ts.isImportClause) ??
            namespace?.parent;
        const importDeclaration = named
            ? named.parent.parent.parent
            : clause?.parent;
        if (
            !importDeclaration ||
            !ts.isImportDeclaration(importDeclaration) ||
            !ts.isStringLiteral(importDeclaration.moduleSpecifier)
        ) {
            return undefined;
        }
        return {
            specifier: importDeclaration.moduleSpecifier.text,
            ...(named ? { named } : {}),
            ...(!named ? { nonNamed: true as const } : {}),
            ...(named?.isTypeOnly || clause?.isTypeOnly
                ? { typeOnly: true as const }
                : {}),
        };
    }

    /** See {@link physicsEngineModulePackage}. */
    public isPhysicsEngineModule(
        identifier: ts.Identifier,
    ): boolean {
        return (
            this.importModuleSpecifier(identifier)?.specifier ===
            physicsEngineModulePackage
        );
    }

    public importedName(
        identifier: ts.Identifier,
    ): string | undefined {
        const imported = this.importModuleSpecifier(identifier);
        if (
            !imported?.named ||
            !isBabylonModule(imported.specifier)
        ) {
            return undefined;
        }
        return imported.named.propertyName?.text ??
            imported.named.name.text;
    }

    /**
     * A pinned named import, or `*` when a default/namespace binding hides
     * which export is reached. Used by bounded executors that must reject the
     * latter rather than mistake it for a local value.
     */
    public babylonImportName(
        identifier: ts.Identifier,
    ): string | undefined {
        const imported = this.importModuleSpecifier(identifier);
        if (
            !imported ||
            imported.typeOnly ||
            !isBabylonModule(imported.specifier)
        ) {
            return undefined;
        }
        return imported.nonNamed
            ? "*"
            : imported.named?.propertyName?.text ??
                  imported.named?.name.text;
    }

    /**
     * The template a pinned `wgsl` tag wraps, or undefined for any other
     * expression. The helper is the identity over its template (asserted
     * once against its declaration when the source store first strips one
     * for a pinned module), so a scene's `wgsl\`...\`` is the plain literal
     * to every reader here -- and, since the reference harness transpiles
     * scene sources without the pin's bundler, the text the browser runs
     * too. Resolved by import symbol: a local tag that happens to be
     * spelled `wgsl` is not this.
     */
    public pinnedWgslTemplate(
        expression: ts.Expression,
    ): ts.TemplateLiteral | undefined {
        return ts.isTaggedTemplateExpression(expression) &&
            ts.isIdentifier(expression.tag) &&
            this.importedName(expression.tag) === "wgsl"
            ? expression.template
            : undefined;
    }
}
