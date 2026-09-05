import ts from "typescript";

export interface NativeReturnTypeOptions {
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
        declaredReturn.typeName.text === "Promise" &&
        declaredReturn.typeArguments?.length === 1 &&
        declaredReturn.typeArguments[0]!.kind === ts.SyntaxKind.VoidKeyword
    ) {
        return undefined;
    }
    if ((type.flags & ts.TypeFlags.Void) !== 0) return undefined;
    if (options.unwrapPromise === false) return type;
    if (checker.typeToString(type) === "Promise<void>") return undefined;
    const promised = (
        checker as ts.TypeChecker & {
            getAwaitedType(candidate: ts.Type): ts.Type | undefined;
        }
    ).getAwaitedType(type);
    const resolved = promised && promised !== type ? promised : type;
    return (resolved.flags & ts.TypeFlags.Void) !== 0 ? undefined : resolved;
}
