import ts from "typescript";
import { libraryGlobal } from "./symbols.js";
import { nullability } from "./type-facts.js";

interface NativeReturnTypeOptions {
    /** Leave promises opaque while still recognizing a declared Promise<void>. */
    unwrapPromise?: boolean;
}

/** The value a source function returns in the synchronous native model. */
export function nativeReturnTsType(
    checker: ts.TypeChecker,
    type: ts.Type,
    declaration?: ts.SignatureDeclaration | ts.JSDocSignature,
    options: NativeReturnTypeOptions = {},
): ts.Type | undefined {
    const declaredReturn = declaration?.type;
    if (
        declaredReturn &&
        ts.isTypeReferenceNode(declaredReturn) &&
        ts.isIdentifier(declaredReturn.typeName) &&
        libraryGlobal(checker, declaredReturn.typeName) === "Promise" &&
        declaredReturn.typeArguments?.length === 1 &&
        declaredReturn.typeArguments[0]!.kind === ts.SyntaxKind.VoidKeyword
    ) {
        return undefined;
    }
    if (
        (type.flags & ts.TypeFlags.Undefined) !== 0 &&
        declaration &&
        (ts.isArrowFunction(declaration) ||
            ts.isFunctionExpression(declaration))
    ) {
        // A pure undefined supplier still returns a value to an optional
        // callback sink. Keep that sink's storage instead of lowering it as void.
        const contextual = checker.getContextualType(declaration);
        const signatures = contextual
            ? checker.getNonNullableType(contextual).getCallSignatures()
            : [];
        const result =
            signatures.length === 1
                ? checker.getReturnTypeOfSignature(signatures[0]!)
                : undefined;
        if (result?.isUnion()) {
            const absent = nullability(result);
            if (absent.undefined && !absent.void) type = result;
        }
    }
    if ((type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0)
        return undefined;
    if (options.unwrapPromise === false) return type;
    const promiseChecker = checker as ts.TypeChecker & {
        getPromisedTypeOfPromise(candidate: ts.Type): ts.Type | undefined;
    };
    let resolved = type;
    const seen = new Set<ts.Type>();
    // Awaited<T> is a conditional type when T is still generic. Unwrap only
    // actual promise layers, leaving T for the active call substitution.
    while (!seen.has(resolved)) {
        seen.add(resolved);
        const promised = promiseChecker.getPromisedTypeOfPromise(resolved);
        if (!promised) break;
        resolved = promised;
    }
    resolved = settledUnion(promiseChecker, resolved);
    return (resolved.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
        ? undefined
        : resolved;
}

/**
 * The value a union settles to once awaited: `T | PromiseLike<T>` (what an
 * async function returns, what a resolver takes) settles to `T`, so a
 * promise-like member is dropped where the union already holds every type
 * it promises. Any other union stays as it is.
 */
function settledUnion(
    checker: ts.TypeChecker & {
        getPromisedTypeOfPromise(candidate: ts.Type): ts.Type | undefined;
    },
    type: ts.Type,
): ts.Type {
    if (!type.isUnion()) return type;
    const settled = type.types.filter(
        (member) => !checker.getPromisedTypeOfPromise(member),
    );
    if (
        settled.length === type.types.length ||
        settled.length === 0 ||
        !type.types.every((member) => {
            const promised = checker.getPromisedTypeOfPromise(member);
            return (
                !promised ||
                (promised.isUnion() ? promised.types : [promised]).every(
                    (each) => settled.includes(each),
                )
            );
        })
    )
        return type;
    if (settled.length === 1) return settled[0]!;
    // The awaited union of the remaining members is the checker's own.
    const awaited = checker.getAwaitedType(type);
    return awaited?.isUnion() &&
        awaited.types.length === settled.length &&
        awaited.types.every((member) => settled.includes(member))
        ? awaited
        : type;
}
