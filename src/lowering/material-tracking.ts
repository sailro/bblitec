import type { LoweringContext } from "./context.js";

/**
 * `enableMaterialTracking`: the source selection, the family test and the
 * module hop come from the pin. Its accessors mark the source UBO dirty on a
 * changed write; native scalar properties are stored live, and the observable
 * array native storage keeps for later reads is the Standard `diffuseColor`,
 * which installation replaces and each frame re-reads while tracked.
 */
export function lowerMaterialTracking(
    context: LoweringContext,
    name: string,
): { prototype: string; lines: string[] } {
    const module = "src/material/observable-material.ts";
    const { declaration } = context.functionDeclaration(
        module,
        "enableMaterialTracking",
    );
    context.assertStatementShapes(
        declaration,
        declaration.body!.statements,
        'const source = getMaterialSource(material) as Material & { specularPower?: unknown }; if ("specularPower" in source) { const { installStdTracking } = await import("./tracking/std-tracking.js"); installStdTracking(source as any); } else { const { installPbrTracking } = await import("./tracking/pbr-tracking.js"); installPbrTracking(source as any); }',
        "Material tracking entry",
    );
    const { declaration: source } = context.functionDeclaration(
        "src/material/material-view.ts",
        "getMaterialSource",
    );
    context.assertStatementShapes(
        source,
        source.body!.statements,
        "return isMaterialView(material) ? material.source : material;",
        "Material view source",
    );
    const { declaration: standard } = context.functionDeclaration(
        "src/material/tracking/std-tracking.ts",
        "installStdTracking",
    );
    context.expectShapeCount(
        standard,
        "mat.diffuseColor = observableColor3(mat.diffuseColor[0], mat.diffuseColor[1], mat.diffuseColor[2], mat as any)",
        "Standard diffuse color observer",
    );
    const { declaration: pbr } = context.functionDeclaration(
        "src/material/tracking/pbr-tracking.ts",
        "installPbrTracking",
    );
    context.expectShapeCount(
        pbr,
        "mat.baseColorFactor",
        "PBR base color observer",
        0,
    );
    const prototype = `bbl::js::Promise<bbl::js::PromiseVoid> ${name}(bbl::Engine& engine, bbl::MaterialHandle material);`;
    return {
        prototype,
        lines: [
            `// ${context.provenance(module, "enableMaterialTracking")}`,
            `bbl::js::Promise<bbl::js::PromiseVoid> ${name}(bbl::Engine& engine, bbl::MaterialHandle material) {`,
            "    const auto& view = bbl::handle_at(engine.materials, material);",
            "    const auto source = view.source_material.value == bbl::invalid_handle ? material : view.source_material;",
            "    // An evaluated module's dynamic import settles with its namespace.",
            "    return bbl::js::Promise<bbl::js::PromiseVoid>::resolved(bbl::js::PromiseVoid{}).then(",
            "        [owner = bbl::StoredEngine(engine), source](const bbl::js::PromiseVoid&) {",
            "            auto& tracked_engine = *owner;",
            "            auto& record = bbl::handle_at(tracked_engine.materials, source);",
            "            if (record.standard_material) {",
            "                // observableColor3 installs a new array over the current channels.",
            "                record.source_diffuse_color = std::make_shared<std::vector<double>>(",
            "                    record.source_diffuse_color ? *record.source_diffuse_color",
            "                                                : std::vector<double>{record.diffuse_color.r, record.diffuse_color.g, record.diffuse_color.b});",
            "            }",
            "            auto& tracked = tracked_engine.tracked_materials;",
            "            if (std::find(tracked.begin(), tracked.end(), source) == tracked.end())",
            "                tracked.push_back(source);",
            "        });",
            "}",
        ],
    };
}
