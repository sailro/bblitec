import { StorageDemand } from "./storage-demand.js";
import type { StorageRequest } from "./replay-storage.js";
import ts from "typescript";
import {
    calledFunction,
    declaredSymbol,
    isRetypableDeclaration,
    resolvedSymbol,
} from "./symbols.js";
import { contextualProperty, callSignatures } from "./type-facts.js";
import { unwrapExpression } from "./syntax.js";

/**
 * A source storage that can keep JavaScript's two absent values apart
 * (`DataType<"tagged">`): a variable, a parameter (of a function or of a
 * signature a function is stored as), a record property, or the return of
 * a function ({@link ReturningFunction}).
 */
export type AbsenceTagDeclaration =
    | ts.VariableDeclaration
    | ts.ParameterDeclaration
    | ts.PropertySignature
    | ts.PropertyDeclaration
    | ReturningFunction;

/**
 * A function whose returns are the storage of its calls' results: a
 * function declaration, or a function literal a `const` binding holds.
 */
type ReturningFunction =
    ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function isReturningFunction(
    declaration: ts.Node | undefined,
): declaration is ReturningFunction {
    return (
        declaration !== undefined &&
        (ts.isFunctionDeclaration(declaration) ||
            ts.isArrowFunction(declaration) ||
            ts.isFunctionExpression(declaration))
    );
}

/**
 * The function whose returns a call's result is, when the call runs one
 * authored function through its one signature (`calledFunction`): an
 * unresolved callee, an overload or a callee typed with several
 * signatures has none, so an observation of its result refuses.
 */
function returningFunctionOf(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): ReturningFunction | undefined {
    const called = calledFunction(checker, call);
    return isReturningFunction(called) &&
        callSignatures(
            checker,
            checker.getTypeAtLocation(call.expression),
            "present",
        ).length === 1
        ? called
        : undefined;
}

/**
 * A strict comparison, spelling, `typeof` or default parameter observed
 * whether a value read from `declaration` is `null` or `undefined`, which its
 * one-state storage cannot answer: the compile replays with that storage
 * tagged.
 */
export class AbsenceTagStorageRequired extends StorageDemand {
    constructor(readonly declaration: AbsenceTagDeclaration) {
        super("A storage must tell null from undefined.");
    }

    get request(): StorageRequest {
        return { kind: "absence-tag", declaration: this.declaration };
    }
}

/**
 * A program source's own storage ({@link isRetypableDeclaration}) that
 * holds a value, or a function's return.
 */
function isAbsenceTagDeclaration(
    declaration: ts.Declaration | undefined,
): declaration is AbsenceTagDeclaration {
    return (
        isReturningFunction(declaration) ||
        (isRetypableDeclaration(declaration) &&
            !ts.isMethodSignature(declaration))
    );
}

/**
 * The one storage `expression` reads its value from directly: a variable or
 * parameter it names, the property a dotted read selects when a single
 * declaration declares it, or the returns of the function a call runs.
 * Undefined for any other expression.
 */
function absenceTagDeclaration(
    checker: ts.TypeChecker,
    expression: ts.Node,
): AbsenceTagDeclaration | undefined {
    const node = ts.isExpression(expression)
        ? unwrapExpression(expression)
        : expression;
    if (ts.isIdentifier(node)) {
        const declaration = resolvedSymbol(checker, node)?.valueDeclaration;
        return isAbsenceTagDeclaration(declaration) &&
            !isReturningFunction(declaration) &&
            !ts.isPropertySignature(declaration) &&
            !ts.isPropertyDeclaration(declaration)
            ? declaration
            : undefined;
    }
    if (ts.isCallExpression(node)) return returningFunctionOf(checker, node);
    // An element read keeps the tags of the array the storage holds.
    if (ts.isElementAccessExpression(node))
        return checker.isArrayType(
            checker.getNonNullableType(
                checker.getTypeAtLocation(node.expression),
            ),
        )
            ? absenceTagDeclaration(checker, node.expression)
            : undefined;
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
    requireRecordSlotAbsenceTag(tagged, value?.slotDeclarations ?? []);
    requireDeclarationAbsenceTag(
        tagged,
        absenceTagDeclaration(checker, expression),
    );
}

/**
 * Refuses an observation of which absent value `expression` holds when it
 * may be either: demands tagged storage for the storage it reads first
 * ({@link requireAbsenceTag}), so only an untaggable one refuses with
 * `message`.
 */
export function refuseEitherAbsence(
    context: {
        readonly checker: ts.TypeChecker;
        readonly absenceTags: ReadonlySet<ts.Declaration>;
        fail(node: ts.Node, message: string): never;
    },
    expression: ts.Node,
    value:
        { readonly slotDeclarations?: readonly ts.Declaration[] } | undefined,
    message: string,
): never {
    requireAbsenceTag(context.checker, context.absenceTags, expression, value);
    return context.fail(expression, message);
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
    const signatures = slot ? callSignatures(checker, slot, "present") : [];
    return signatures.length === 1
        ? signatures[0]!.getDeclaration()?.parameters[index]
        : undefined;
}

/**
 * Demands tagged storage for a record slot stored for `declarations`: the
 * record's layout is the program's storage, a library-declared property
 * included (an `IteratorResult`'s `value`, an init dictionary's
 * `relatedTarget`).
 */
export function requireRecordSlotAbsenceTag(
    tagged: ReadonlySet<ts.Declaration>,
    declarations: readonly ts.Declaration[],
): void {
    for (const declaration of declarations)
        if (
            (ts.isPropertySignature(declaration) ||
                ts.isPropertyDeclaration(declaration)) &&
            !tagged.has(declaration)
        )
            throw new AbsenceTagStorageRequired(declaration);
}

/** {@link requireAbsenceTag} for a storage named by its declaration. */
export function requireDeclarationAbsenceTag(
    tagged: ReadonlySet<ts.Declaration>,
    declaration: ts.Declaration | undefined,
): void {
    if (isAbsenceTagDeclaration(declaration) && !tagged.has(declaration))
        throw new AbsenceTagStorageRequired(declaration);
}
