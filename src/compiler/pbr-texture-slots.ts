/**
 * The texture props a PBR material holds, `createPbrMaterial`'s and their
 * assignments: each fills the native slot it names through
 * `bbl::set_pbr_texture`, from a texture of any storage.
 */
import type ts from "typescript";
import type { Value } from "./types.js";

/** The `bbl::MaterialTextureSlot` a PBR texture prop fills. */
export type PbrTextureSlot =
    "base_color" | "orm" | "normal" | "occlusion" | "bent_normal";

interface SlotTextureContext {
    fail(node: ts.Node, message: string): never;
    /** Textures a record copied, which a later texel write cannot reach. */
    readonly boundPixelsTextures: Set<string>;
}

/** Whether a texture is a stored handle, whose C++ is a `bbl::StoredTexture`. */
export function isStoredTextureHandle(texture: Value): boolean {
    return (
        texture.dataType?.kind === "handle" &&
        texture.dataType.handle === "texture"
    );
}

/** The `bbl::StoredTexture` a texture of any storage is. */
export function storedTextureCpp(
    context: SlotTextureContext,
    texture: Value,
    node: ts.Node,
    property: string,
): string {
    if (isStoredTextureHandle(texture)) return texture.cpp;
    if (texture.textureStorage === "solid")
        return `bbl::solid_texture_file(${texture.cpp})`;
    if (texture.textureStorage === "pixels") {
        context.boundPixelsTextures.add(texture.cpp);
        return texture.cpp;
    }
    if (texture.textureFile || texture.textureStorage === "file")
        return texture.cpp;
    return context.fail(
        node,
        `PBR ${property} takes a loaded, solid, pixels or stored texture; received ${texture.textureStorage ?? "an unknown"} storage.`,
    );
}

/** The statement filling `slot` of `material` with a `StoredTexture`. */
export function setPbrTextureCpp(
    engine: string,
    material: string,
    slot: PbrTextureSlot,
    texture: string,
): string {
    return `bbl::set_pbr_texture(${engine}, ${material}, bbl::MaterialTextureSlot::${slot}, ${texture});`;
}
