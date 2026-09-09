/** Native local storage facts supplied by the lowering operation. */
export interface NativeDeclaration {
    readonly kind: "declaration";
    readonly type: string;
    readonly name: string;
    readonly initializer: string;
    readonly attributes?: string;
    readonly initialization?: "default" | "direct";
    readonly dependencies?: readonly string[];
}

export function renderNativeDeclaration(declaration: NativeDeclaration): string {
    const prefix = `${declaration.attributes ?? ""}${declaration.type} ${declaration.name}`;
    if (declaration.initialization === "default") return `${prefix};`;
    if (declaration.initialization === "direct") return `${prefix}{${declaration.initializer}};`;
    return `${prefix} = ${declaration.initializer};`;
}
