/**
 * `rebuildMaterial` after the engine started, from the pin's own module
 * (`src/material/material-rebuild.ts`).
 *
 * The pin drops the source's cached features and rebuilds the renderable of
 * every scene mesh drawing the material (its views too, unless
 * `rebuildViews: false`): each takes a new bind group and its old resources
 * retire. Natively a draw row is the renderable: the material's
 * `build_generation` advances, every render item carries the generation it
 * was planned under, and the next frame's plan rebuild releases each row
 * planned under an older one and uploads it afresh, which reads the record
 * as it now is. The completion the pin returns is a promise exactly when a
 * PBR mesh rebuilds through the scene's runtime build.
 */
import ts from "typescript";
import { recordAt } from "../compiler/record-access.js";
import type { LoweredSource, LoweringContext } from "./context.js";

const MODULE = "src/material/material-rebuild.ts";

export function lowerMaterialRebuild(context: LoweringContext): LoweredSource {
    const { declaration: renderables } = context.functionDeclaration(
        MODULE,
        "rebuildMaterialRenderables",
    );
    context.assertStatementShapes(
        renderables,
        renderables.body!.statements.slice(0, 3),
        "const source = getMaterialSource(materialOrView); " +
            "source._renderFeatures = undefined; " +
            "const rebuildViews = options?.rebuildViews !== false;",
        "Material rebuild source and feature reset",
    );
    const { declaration: matches } = context.functionDeclaration(
        MODULE,
        "matchesMaterial",
    );
    context.assertStatementShapes(
        matches,
        matches.body!.statements,
        "if (!meshMaterial) { return false; } " +
            "if (!rebuildViews) { return meshMaterial === materialOrView; } " +
            "return meshMaterial === source || (isMaterialView(meshMaterial) && meshMaterial.source === source);",
        "Material rebuild target match",
    );
    const { declaration: each } = context.functionDeclaration(
        MODULE,
        "rebuildSceneMesh",
    );
    // A PBR mesh of a built scene rebuilds through the runtime build, whose
    // promise the completion collects.
    if (
        !context.findNodes(
            each,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                context.expressionMatchesShape(
                    node,
                    'builder._materialFamily === "pbr" && (ctx._built || group?.r)',
                ),
        ).length
    )
        context.contractError(
            each,
            "Expected a PBR mesh of a built scene to rebuild asynchronously.",
        );
    const record = (handle: string) => recordAt("engine.materials", handle);
    return {
        modulePath: MODULE,
        symbolName: "rebuildMaterial",
        header: "",
        source: `// ${context.provenance(MODULE, "rebuildMaterial", "rebuildMaterialRenderables, matchesMaterial and rebuildEach")}
#include <bblite/material_rebuild.hpp>

#include <algorithm>
#include <memory>

namespace bbl {

js::Nullable<js::Promise<js::PromiseVoid>> rebuild_material(Engine& engine, Scene& scene,
                                                            MaterialHandle material,
                                                            bool rebuild_views) {
    // getMaterialSource
    const MaterialHandle source = ${record("material")}.source_material.value != invalid_handle
                                      ? ${record("material")}.source_material
                                      : material;
    // source._renderFeatures = undefined
    ${record("source")}.composed_pbr_row = invalid_handle;
    const auto matches = [&](MaterialHandle drawn) {
        if (drawn.value == invalid_handle) return false;
        if (!rebuild_views) return drawn.value == material.value;
        return drawn.value == source.value ||
               ${record("drawn")}.source_material.value == source.value;
    };
    bool pbr = false;
    bool changed = false;
    for (const MeshHandle mesh : scene.meshes) {
        const MaterialHandle drawn = handle_at(engine.meshes, mesh).material;
        if (!matches(drawn)) continue;
        MaterialRecord& target = ${record("drawn")};
        ++target.build_generation;
        changed = true;
        pbr = pbr || material_family_name(target) == "pbr";
    }
    // \`_renderableVersion++\`: the next frame plans the scene again.
    if (changed) ++scene.render_topology_version;
    // A PBR mesh of a built (registered) scene rebuilds asynchronously.
    const auto& registered = engine.scenes();
    const bool built = std::any_of(registered.begin(), registered.end(),
                                   [&](const std::shared_ptr<Scene>& entry) {
                                       return entry && entry->shares_identity(scene);
                                   });
    return pbr && built
               ? js::Nullable<js::Promise<js::PromiseVoid>>{js::Promise<js::PromiseVoid>::resolved({})}
               : js::Nullable<js::Promise<js::PromiseVoid>>{};
}

} // namespace bbl
`,
    };
}
