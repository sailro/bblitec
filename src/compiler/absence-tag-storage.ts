import ts from "typescript";
import {
    declaredSymbol,
    isRetypableDeclaration,
    resolvedSymbol,
} from "./symbols.js";
import { contextualProperty } from "./type-facts.js";
import { unwrapExpression } from "./syntax.js";

/**
 * A source storage that can keep JavaScript's two absent values apart
 * (`DataType<"tagged">`): a variable, a parameter (of a function or of a
 * signature a function is stored as) or a record property.
 */
export type AbsenceTagDeclaration =
    | ts.VariableDeclaration
    | ts.ParameterDeclaration
    | ts.PropertySignature
    | ts.PropertyDeclaration;

/**
 * A strict comparison, spelling, `typeof` or default parameter observed
 * whether a value read from `declaration` is `null` or `undefined`, which its
 * one-state storage cannot answer: the compile replays with that storage
 * tagged.
 */
export class AbsenceTagStorageRequired extends Error {
    constructor(readonly declaration: AbsenceTagDeclaration) {
        super("A storage must tell null from undefined.");
    }
}

/** A program source's own storage ({@link isRetypableDeclaration}) that holds a value. */
function isAbsenceTagDeclaration(
    declaration: ts.Declaration | undefined,
): declaration is AbsenceTagDeclaration {
    return (
        isRetypableDeclaration(declaration) &&
        !ts.isMethodSignature(declaration)
    );
}

/**
 * The one storage `expression` reads its value from directly: a variable or
 * parameter it names, or the property a dotted read selects when a single
 * declaration declares it. Undefined for any other expression.
 */
export function absenceTagDeclaration(
    checker: ts.TypeChecker,
    expression: ts.Node,
): AbsenceTagDeclaration | undefined {
    const node = ts.isExpression(expression)
        ? unwrapExpression(expression)
        : expression;
    if (ts.isIdentifier(node)) {
        const declaration = resolvedSymbol(checker, node)?.valueDeclaration;
        return isAbsenceTagDeclaration(declaration) &&
            !ts.isPropertySignature(declaration) &&
            !ts.isPropertyDeclaration(declaration)
            ? declaration
            : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
        const declarations =
            declaredSymbol(checker, node.name)?.declarations ?? [];
        const [declaration] = declarations;
        return declarations.length === 1 &&
            isAbsenceTagDeclaration(declaration) &&
            (ts.isPropertySignature(declaration) ||
                ts.isPropertyDeclaration(declaration))
            ? declaration
            : undefined;
    }
    return undefined;
}

/**
 * Demands tagged storage for the storage `expression` reads, when it has one
 * not yet tagged; returns otherwise so the caller refuses.
 */
export function requireAbsenceTag(
    checker: ts.TypeChecker,
    tagged: ReadonlySet<ts.Declaration>,
    expression: ts.Node,
    value?: { readonly slotDeclarations?: readonly ts.Declaration[] },
): void {
    // A record slot names the declarations its layout stores, which may be
    // another type's than the one the reading expression is checked as.
    for (const declaration of value?.slotDeclarations ?? [])
        requireDeclarationAbsenceTag(tagged, declaration);
    requireDeclarationAbsenceTag(
        tagged,
        absenceTagDeclaration(checker, expression),
    );
}

/**
 * The parameter, at `index`, of the one signature a function stored at
 * `site` (an expression in a typed slot, a shorthand property included) is
 * called through: the storage its argument arrives in.
 */
export function storedSignatureParameter(
    checker: ts.TypeChecker,
    site: ts.Node,
    index: number,
): ts.ParameterDeclaration | undefined {
    if (!ts.isExpression(site)) return undefined;
    const parent = site.parent;
    let slot: ts.Type | undefined;
    if (
        parent !== undefined &&
        ts.isShorthandPropertyAssignment(parent) &&
        parent.name === site
    ) {
        const property = contextualProperty(
            checker,
            parent.parent,
            parent.name.text,
        );
        slot = property && checker.getTypeOfSymbolAtLocation(property, site);
    } else slot = checker.getContextualType(site);
    const signatures = slot
        ? checker.getNonNullableType(slot).getCallSignatures()
        : [];
    return signatures.length === 1
        ? signatures[0]!.getDeclaration()?.parameters[index]
        : undefined;
}

/** {@link requireAbsenceTag} for a storage named by its declaration. */
export function requireDeclarationAbsenceTag(
    tagged: ReadonlySet<ts.Declaration>,
    declaration: ts.Declaration | undefined,
): void {
    if (isAbsenceTagDeclaration(declaration) && !tagged.has(declaration))
        throw new AbsenceTagStorageRequired(declaration);
}
