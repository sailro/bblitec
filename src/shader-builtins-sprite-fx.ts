/**
 * The extra textures as the pin's own custom-shader builders read them: a
 * record per texture carrying the identifier it binds under. Both sprite
 * families pass them to their composer, which emits the `<name>Tex` /
 * `<name>Samp` pairs itself.
 */
export function extraTextureRecords(
    names: readonly string[],
): { name: string }[] {
    return names.map((name) => ({ name }));
}
