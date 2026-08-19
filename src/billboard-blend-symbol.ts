/**
 * The native symbol a pinned billboard blend descriptor is emitted as.
 *
 * Two sides need this name and they run in different phases: the compiler
 * resolves `billboardBlendAdditive` at a call site into a C++ expression,
 * and the billboard lowerer emits the factory that expression calls. They
 * agreed before only because the pin's `_key` happened to equal the export
 * name's suffix lowercased — and `_key` is documented upstream as an
 * internal pipeline-cache discriminator, free to change without touching
 * the export. Deriving both from the EXPORT name, here, removes the
 * coincidence: a pin that renames a descriptor changes the two together, and
 * one that only edits a `_key` changes neither.
 */
const prefix = "billboardBlend";

/** Whether an imported name is one of the pin's blend descriptors. */
export function isBillboardBlendExport(importedName: string): boolean {
    return (
        importedName.startsWith(prefix) &&
        importedName.length > prefix.length &&
        importedName[prefix.length] ===
            importedName[prefix.length]!.toUpperCase()
    );
}

/** `billboardBlendAdditive` becomes `billboard_blend_additive`. */
export function billboardBlendSymbol(exportName: string): string {
    return `billboard_blend_${exportName
        .slice(prefix.length)
        .toLowerCase()}`;
}
