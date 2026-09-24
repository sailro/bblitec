import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findRepositoryRoot } from "../repository-root.js";
import { stringLiteralText, unwrapExpression } from "./syntax.js";

/** The two names a scene spells the pinned package with. */
export const babylonPackages = ["babylon-lite", "@babylonjs/lite"] as const;

/** The declaration files every compiler program reads a package's API from. */
export interface CompilerPackageTypings {
    /**
     * The pinned package's rolled-up `index.d.ts`: every Babylon specifier
     * (`babylonPackages`, either spelling, any subpath) resolves to it.
     */
    readonly babylon: string;
    /** The pin's WebGPU peer typings, a root of every program. */
    readonly webGpu: string;
}

let packageTypings: CompilerPackageTypings | undefined;

/**
 * The typings files `program.ts` builds every program from, as absolute
 * paths under this checkout's `node_modules`. One answer for the program's
 * module resolution and for {@link declarationOrigin}: the file a
 * declaration lives in is then which package declared it, wherever the
 * scene's own sources are.
 */
export function compilerPackageTypings(): CompilerPackageTypings {
    if (!packageTypings) {
        const root = findRepositoryRoot(
            dirname(fileURLToPath(import.meta.url)),
        );
        const modules = resolve(root, "node_modules");
        packageTypings = {
            babylon: resolve(modules, "@babylonjs", "lite", "index.d.ts"),
            webGpu: resolve(modules, "@webgpu", "types", "dist", "index.d.ts"),
        };
    }
    return packageTypings;
}

/**
 * Who declared a name: TypeScript's own library (`default-lib`), the part of
 * it that declares the browser document (`dom`), the pin's WebGPU peer
 * typings (`webgpu`), the pinned Babylon Lite typings (`babylon`), or the
 * program itself (`program`, including any other declaration file it
 * reads). A symbol named like an engine or browser type is that type only
 * when its declaration comes from there.
 */
export type DeclarationOrigin =
    "default-lib" | "dom" | "webgpu" | "babylon" | "program";

/**
 * TypeScript's library files that declare the browser document, including
 * the two that add its iteration protocols to the same interfaces.
 */
const DOM_LIBRARY_FILES: ReadonlySet<string> = new Set([
    "lib.dom.d.ts",
    "lib.dom.iterable.d.ts",
    "lib.dom.asynciterable.d.ts",
]);

const sourceFileOrigins = new WeakMap<ts.SourceFile, DeclarationOrigin>();

function sourceFileOrigin(file: ts.SourceFile): DeclarationOrigin {
    // Every `lib.*.d.ts` the compiler ships carries the `no-default-lib`
    // directive, which is the marker `Program.isSourceFileDefaultLibrary`
    // itself reads for a declaration file; asking the file directly lets a
    // reader that holds only a checker give the same answer as the compiler.
    if (file.isDeclarationFile && file.hasNoDefaultLib)
        return DOM_LIBRARY_FILES.has(basename(file.fileName))
            ? "dom"
            : "default-lib";
    if (!file.isDeclarationFile) return "program";
    const path = resolve(file.fileName);
    const typings = compilerPackageTypings();
    return path === typings.babylon
        ? "babylon"
        : path === typings.webGpu
          ? "webgpu"
          : "program";
}

/** See {@link DeclarationOrigin}. */
export function declarationOrigin(declaration: ts.Node): DeclarationOrigin {
    const file = declaration.getSourceFile();
    let origin = sourceFileOrigins.get(file);
    if (origin === undefined) {
        origin = sourceFileOrigin(file);
        sourceFileOrigins.set(file, origin);
    }
    return origin;
}

/**
 * Whether any declaration of a symbol has one of `origins`. Any, because a
 * program may reopen a library interface (`interface Window { ... }`) and
 * the merged symbol is still the library's.
 */
export function declaredIn(
    symbol: ts.Symbol | undefined,
    ...origins: readonly DeclarationOrigin[]
): boolean {
    return (symbol?.declarations ?? []).some((declaration) =>
        origins.includes(declarationOrigin(declaration)),
    );
}

/** Whether a symbol is declared by the browser document's library files. */
export function declaredInDomLibrary(symbol: ts.Symbol | undefined): boolean {
    return declaredIn(symbol, "dom");
}

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

/**
 * Whether a symbol is declared in one of TypeScript's own library files,
 * the browser document's included.
 */
export function declaredInDefaultLibrary(
    symbol: ts.Symbol | undefined,
): boolean {
    return declaredIn(symbol, "default-lib", "dom");
}

/** Whether one declaration lives in a library file — see {@link declaredInDefaultLibrary}. */
export function declarationInDefaultLibrary(declaration: ts.Node): boolean {
    const origin = declarationOrigin(declaration);
    return origin === "default-lib" || origin === "dom";
}

/** An erased ambient declaration does not provide a native runtime binding.
 * Bare typeof may observe that absence; ordinary reads and imports still need
 * their actual implementation. Library globals retain their own lowering. */
export function isAbsentTypeofIdentifier(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): boolean {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return true;
    if (
        (symbol.flags & ts.SymbolFlags.Alias) !== 0 ||
        declaredInDefaultLibrary(symbol)
    )
        return false;
    if (
        declaredInDefaultLibrary(
            checker.resolveName(
                identifier.text,
                undefined,
                ts.SymbolFlags.Value,
                false,
            ),
        )
    )
        return false;
    return (
        Boolean(symbol.declarations?.length) &&
        symbol.declarations!.every(
            (declaration) =>
                declaration.getSourceFile().isDeclarationFile ||
                (ts.getCombinedModifierFlags(declaration) &
                    ts.ModifierFlags.Ambient) !==
                    0,
        )
    );
}

/** The binding an import alias stands for; any other symbol is itself. */
export function aliasTarget(
    checker: ts.TypeChecker,
    symbol: ts.Symbol,
): ts.Symbol {
    return (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;
}

/**
 * The symbol a name resolves to: an import alias to the binding it imports,
 * a shorthand property (`{ canvas }`) to the value it names rather than the
 * property it declares, and a property access to its member. The one
 * resolver for a checker-only reader; `CompilerSymbols.valueSymbol` builds
 * on it.
 */
export function resolvedSymbol(
    checker: ts.TypeChecker,
    node: ts.Node,
): ts.Symbol | undefined {
    const name = ts.isPropertyAccessExpression(node) ? node.name : node;
    const symbol =
        ts.isShorthandPropertyAssignment(name.parent) &&
        name.parent.name === name
            ? checker.getShorthandAssignmentValueSymbol(name.parent)
            : checker.getSymbolAtLocation(name);
    return symbol && aliasTarget(checker, symbol);
}

/** The names the library binds the global object itself to. */
const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set([
    "globalThis",
    "window",
    "self",
]);

/**
 * Whether an identifier resolves to the checker's own global binding of its
 * name, the one a program reaches when nothing it declares shadows that
 * name. The checker models `globalThis` and `undefined` as intrinsics with
 * no declaration, so this, not a declaration's origin, is what tells the
 * library's binding of them from a program's own.
 */
function isCheckerGlobal(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): boolean {
    return (
        checker.getSymbolAtLocation(identifier) ===
        checker.resolveName(
            identifier.text,
            undefined,
            ts.SymbolFlags.Value,
            false,
        )
    );
}

/**
 * Whether an expression is the global `undefined`, grouping and type-only
 * wrappers seen through. The one answer to "is this the absent value": a
 * local, parameter or import a program names `undefined` is not.
 */
export function isGlobalUndefined(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const node = unwrapExpression(expression);
    return (
        ts.isIdentifier(node) &&
        node.text === "undefined" &&
        isCheckerGlobal(checker, node)
    );
}

/** Whether an expression is a literal `null` or the global `undefined`. */
export function isNullishLiteral(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    return (
        unwrapExpression(expression).kind === ts.SyntaxKind.NullKeyword ||
        isGlobalUndefined(checker, expression)
    );
}

/**
 * The default-library global an expression names, or undefined.
 *
 * An identifier names one when it resolves to a declaration of
 * TypeScript's own library (`Math`, `fetch`, `document`, the `Promise`
 * type), and `globalThis` names the global object itself — the checker
 * models it as an intrinsic with no declaration, so it is recognized as the
 * checker's own global binding of that name. A member of the global object
 * read through the library's `globalThis`, `window` or `self`
 * (`window.innerWidth`) names that member when the member is the
 * library's own. Grouping and type-only wrappers are seen through.
 *
 * The one answer to "is this the library's `X`": a program's own `Math`,
 * `function Number() {}` or local `class Map`, however it came to be
 * bound, is not.
 */
export function libraryGlobal(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): string | undefined {
    const node = unwrapExpression(expression);
    if (ts.isIdentifier(node)) {
        return declaredInDefaultLibrary(resolvedSymbol(checker, node)) ||
            (node.text === "globalThis" && isCheckerGlobal(checker, node))
            ? node.text
            : undefined;
    }
    if (!ts.isPropertyAccessExpression(node)) return undefined;
    const owner = unwrapExpression(node.expression);
    return ts.isIdentifier(owner) &&
        GLOBAL_OBJECT_NAMES.has(owner.text) &&
        libraryGlobal(checker, owner) === owner.text &&
        declaredInDefaultLibrary(resolvedSymbol(checker, node))
        ? node.name.text
        : undefined;
}

/** A reader's view of {@link libraryGlobal}, bound to its program. */
export type LibraryGlobal = (expression: ts.Expression) => string | undefined;

export class CompilerSymbols {
    public constructor(private readonly checker: ts.TypeChecker) {}

    /** See {@link libraryGlobal}. */
    public libraryGlobal(expression: ts.Expression): string | undefined {
        return libraryGlobal(this.checker, expression);
    }

    /** See {@link isGlobalUndefined}. */
    public isGlobalUndefined(expression: ts.Expression): boolean {
        return isGlobalUndefined(this.checker, expression);
    }

    /** See {@link isNullishLiteral}. */
    public isNullishLiteral(expression: ts.Expression): boolean {
        return isNullishLiteral(this.checker, expression);
    }

    /** Resolve a generation-known enum value through its pinned declaration,
     * including a property whose flow type has narrowed away the alias name. */
    public pinnedEnumMemberForValue(
        expression: ts.Expression,
        enumName: string,
        value: number,
    ): string | undefined {
        const declaration = resolvedSymbol(
            this.checker,
            expression,
        )?.valueDeclaration;
        const type = declaration
            ? this.checker.getTypeAtLocation(declaration)
            : this.checker.getTypeAtLocation(expression);
        const owner = type.aliasSymbol;
        if (owner?.name !== enumName || !declaredIn(owner, "babylon"))
            return undefined;
        const bag = this.checker.getTypeOfSymbolAtLocation(owner, expression);
        return bag.getProperties().find((property) => {
            const member = this.checker.getTypeOfSymbolAtLocation(
                property,
                expression,
            );
            return member.isNumberLiteral() && member.value === value;
        })?.name;
    }

    /** Literal-valued readonly exports include the pin's `as const` enum bags. */
    public pinnedConstantProperty(
        expression: ts.PropertyAccessExpression,
    ): number | string | undefined {
        const owner = expression.expression;
        const ownerDeclaration = ts.isIdentifier(owner)
            ? this.valueSymbol(owner)?.declarations?.[0]
            : undefined;
        if (
            !ownerDeclaration ||
            declarationOrigin(ownerDeclaration) !== "babylon"
        ) {
            return undefined;
        }
        const declaration = this.checker
            .getSymbolAtLocation(expression.name)
            ?.declarations?.find(ts.isPropertySignature);
        if (
            !declaration?.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            )
        )
            return undefined;
        const type = this.checker.getTypeAtLocation(expression);
        return type.isNumberLiteral() || type.isStringLiteral()
            ? type.value
            : undefined;
    }

    public valueSymbol(identifier: ts.MemberName): ts.Symbol | undefined {
        const resolved = resolvedSymbol(this.checker, identifier);
        if (!resolved) {
            return undefined;
        }
        // A constructor parameter-property has one declaration but the
        // checker may expose its declaration-name symbol at the parameter
        // and its property-flavoured symbol at a use in the constructor
        // body. Canonicalize both through that shared parameter declaration
        // so lexical lookup does not depend on which view the checker gave
        // the particular identifier.
        const parameter = resolved.declarations?.find(ts.isParameter);
        if (
            parameter &&
            ts.isIdentifier(parameter.name) &&
            ts.isParameterPropertyDeclaration(parameter, parameter.parent)
        ) {
            return this.checker.getSymbolAtLocation(parameter.name) ?? resolved;
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
        const declaration = this.valueSymbol(identifier)?.declarations?.[0];
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
            if (aliasTarget(this.checker, exported) === value) return true;
        }
        return false;
    }

    /**
     * The module an identifier was imported from, or undefined when it is
     * not an import. Both spellings resolve here: a NAMED import, whose
     * specifier nests three levels under the declaration, and a DEFAULT
     * import, whose clause is the declaration's direct child.
     */
    private importModuleSpecifier(identifier: ts.Identifier):
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
            named?.parent.parent ??
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
    public isPhysicsEngineModule(identifier: ts.Identifier): boolean {
        return (
            this.importModuleSpecifier(identifier)?.specifier ===
            physicsEngineModulePackage
        );
    }

    public importedName(
        expression: ts.Expression,
        active?: Set<ts.Symbol>,
    ): string | undefined {
        const identifier = unwrapExpression(expression);
        if (
            ts.isPropertyAccessExpression(identifier) ||
            ts.isElementAccessExpression(identifier)
        ) {
            const owner = unwrapExpression(identifier.expression);
            if (!ts.isIdentifier(owner)) return undefined;
            const imported = this.importModuleSpecifier(owner);
            if (
                !imported?.nonNamed ||
                imported.typeOnly ||
                !isBabylonModule(imported.specifier)
            )
                return undefined;
            const name = ts.isPropertyAccessExpression(identifier)
                ? identifier.name.text
                : stringLiteralText(
                      unwrapExpression(identifier.argumentExpression),
                  );
            return name &&
                this.checker.getPropertyOfType(
                    this.checker.getTypeAtLocation(owner),
                    name,
                )
                ? name
                : undefined;
        }
        if (!ts.isIdentifier(identifier)) return undefined;
        const imported = this.importModuleSpecifier(identifier);
        if (!imported?.named || !isBabylonModule(imported.specifier)) {
            const symbol = this.valueSymbol(identifier);
            if (!symbol || active?.has(symbol)) return undefined;
            active ??= new Set();
            active.add(symbol);
            const declaration = symbol.valueDeclaration;
            return declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                ts.isVariableDeclarationList(declaration.parent) &&
                (declaration.parent.flags & ts.NodeFlags.Const) !== 0
                ? this.importedName(declaration.initializer, active)
                : undefined;
        }
        return imported.named.propertyName?.text ?? imported.named.name.text;
    }

    /**
     * A pinned named import, or `*` when a default/namespace binding hides
     * which export is reached. Used by bounded executors that must reject the
     * latter rather than mistake it for a local value.
     */
    public babylonImportName(identifier: ts.Identifier): string | undefined {
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
            : (imported.named?.propertyName?.text ?? imported.named?.name.text);
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
