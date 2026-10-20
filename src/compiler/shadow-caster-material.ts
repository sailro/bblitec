import type ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

type ShadowCasterMaterialContext = Pick<
    LoweringServices,
    "expectKind" | "expectSameEngine" | "requireEngine" | "sceneManifest"
>;

/** Share the material link and its shader composition reach across API and field writes. */
export function shadowCasterMaterialWrite(
    context: ShadowCasterMaterialContext,
    material: Value,
    caster: Value,
    at: ts.Node,
): string {
    context.expectKind(material, "material", at);
    context.expectKind(caster, "material", at);
    context.expectSameEngine(material, caster, at);
    context.sceneManifest.recordShadowCasterShaderVariant(
        material.sceneShaderVariant ?? material.shaderVariant,
        caster.sceneShaderVariant ?? caster.shaderVariant,
    );
    if (
        (material.sceneShaderVariant ?? material.shaderVariant) === undefined ||
        material.possibleSceneShaderVariants?.length
    ) {
        context.sceneManifest.recordSceneShaderMaterialDraw(undefined, caster);
    }
    return (
        `bbl::set_shadow_caster_material(` +
        `${context.requireEngine(material, at)}, ` +
        `${material.cpp}, ${caster.cpp})`
    );
}
