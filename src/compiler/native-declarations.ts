/** Native local storage facts supplied by the lowering operation. */
export interface NativeDeclaration {
    readonly kind: "declaration";
    readonly type: string;
    readonly name: string;
    readonly initializer: string;
    readonly attributes?: string;
    readonly initialization?: "default" | "direct";
    readonly dependencies?: readonly string[];
    /** A pure initializer and trivial lifetime allow this declaration to disappear when unread. */
    readonly discardIfUnused?: true;
}

/** Object storage facts from the emitter's type spelling, without storage specifiers. */
export function nativeDeclarationFacts(declaration: NativeDeclaration): {
    readonly type: string | undefined;
    readonly reference: boolean;
    readonly constant: boolean;
    readonly constantInitializer: boolean;
} {
    const spelling = declaration.type
        .replace(/\b(?:static|thread_local|constexpr|constinit|inline)\s+/g, "")
        .trim();
    const constant =
        /^const\b/.test(spelling) || /\bconstexpr\b/.test(declaration.type);
    const type = /\b(?:auto|decltype)\b/.test(spelling)
        ? undefined
        : spelling.replace(/&+\s*$/, "").trim();
    return {
        type:
            type !== undefined && constant && !type.startsWith("const ")
                ? `const ${type}`
                : type,
        reference: /&\s*$/.test(spelling),
        constant,
        constantInitializer: /\b(?:constexpr|constinit)\b/.test(
            declaration.type,
        ),
    };
}

/**
 * A declaration without a source initializer is value-initialized: a scalar
 * or record local the source assigns on every path before reading still
 * never holds an indeterminate value.
 */
export function renderNativeDeclaration(
    declaration: NativeDeclaration,
): string {
    const prefix = `${declaration.attributes ?? ""}${declaration.type} ${declaration.name}`;
    if (declaration.initialization === "default") return `${prefix}{};`;
    if (declaration.initialization === "direct")
        return `${prefix}{${declaration.initializer}};`;
    return `${prefix} = ${declaration.initializer};`;
}
