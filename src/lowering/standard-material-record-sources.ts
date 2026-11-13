/**
 * The MaterialRecord fields the pin's `StandardMaterialProps` reads map onto,
 * for every lowered derivation that reads them.
 */

/**
 * The render-texture half of the emissive slot.
 *
 * Two derivations read it — the slot's presence, and the depth arm the pin
 * selects from `_sampleType` — so the record field is spelled once.
 */
export const emissiveRenderTextureSource =
    "material.has_emissive_render_texture";

/**
 * How the pin's `StandardMaterialProps` reads map onto our MaterialRecord.
 *
 * A null source folds the pin's condition to false because the generated
 * loader never fills the input — each null names the loader fact that makes
 * it so, and the generation-side composition input builder must mirror the
 * same absences so the two derivations stay bit-identical.
 */
export const standardFeatureRecordSources: Readonly<
    Record<string, string | null>
> = {
    // babylon-loader-cpp.ts fills base_color_texture from diffuseTexture,
    // and a scene-code `material.diffuseTexture = <render target>` write
    // fills the render-texture pair instead: an image and an attachment
    // both light HAS_DIFFUSE_TEXTURE.
    diffuseTexture:
        "material.base_color_texture.has_image() || " +
        "material.has_diffuse_render_texture",
    diffuseCoordIndex: "material.diffuse_coord_index",
    // `enableMaterialUvTransform(material)` marks a hand-built material for
    // per-texture transforms; the flag is what `stdUvTransformExt`'s
    // `_meshFeatures` reads, and the only thing that sets it.
    _hasUvTx: "material.has_uv_transform",
    // `setStandardEmissiveTexture` is the only native source of a Standard
    // emissive texture (the .babylon loader loads none), and it takes both
    // of the pin's `Texture2D` sources: a depth render target, and a loaded
    // image. The presence bit is either; the depth arm is the render target
    // alone, which is the only one carrying `_sampleType`, so both sites
    // compose from the one spelling below rather than repeating it.
    _emissiveTexture:
        `${emissiveRenderTextureSource} || ` +
        "material.emissive_texture.has_image()",
    _bumpTexture: "material.bump_texture.has_image()",
    _specularTexture: "material.specular_texture.has_image()",
    specularCoordIndex: "material.specular_coord_index",
    _ambientTexture: "material.ambient_texture.has_image()",
    ambientCoordIndex: "material.ambient_coord_index",
    _lightmapTexture: "material.lightmap_texture.has_image()",
    lightmapCoordIndex: "material.lightmap_coord_index",
    useLightmapAsShadowmap: "material.lightmap_shadowmap",
    _opacityTexture: "material.opacity_texture.has_image()",
    // babylon-loader-cpp.ts reads opacityTexture.getAlphaFromRGB into the
    // record, mirroring the pin's own loader write (load-babylon.ts
    // TEX_SLOTS opacity extra: `if (t.getAlphaFromRGB) m.opacityFromRGB`).
    opacityFromRGB: "material.opacity_from_rgb",
    // babylon-loader-cpp.ts fills reflection_texture from the non-cube arm
    // of reflectionTexture (the pinned slot skips cube entries), the same
    // split the pin's loader makes (TEX_SLOTS `skipIf: isCube` vs the
    // separate cube branch).
    _reflectionTexture: "material.reflection_texture.has_image()",
    _reflectionCubeTexture: "material.reflection_cube != invalid_handle",
    backFaceCulling: "!material.double_sided",
    disableLighting: "material.disable_lighting",
    // Material-wide alpha is distinct from PBR's base-colour-factor alpha.
    alpha: "material.alpha",
};
