import ts from "typescript";
import { libraryGlobal } from "./symbols.js";

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
    return (resolved.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !== 0
        ? undefined
        : resolved;
}
