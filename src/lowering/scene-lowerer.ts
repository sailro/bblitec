import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class SceneLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerCore(): LoweredSource {
        const modulePath = "src/scene/scene-core.ts";
        const createName = "createSceneContext";
        const addName = "addToScene";
        const registerName = "registerScene";
        const { file, declaration } = this.context.functionDeclaration(modulePath, createName);
        const scene = this.context.objectInitializer(declaration, "ctxLocal");
        const clearExpression = this.context.propertyInitializer(scene, "clearColor");
        if (!ts.isObjectLiteralExpression(clearExpression)) {
            throw new Error("Upstream scene clearColor is not an object literal.");
        }
        const clear = (name: string): number =>
            this.context.numericValue(this.context.propertyInitializer(clearExpression, name), file);
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            '"entities" in entity',
            '"_gpu" in entity && "material" in entity',
            '"lightType" in entity',
            "isRenderingContextRegistered(surface, ctx)",
        ]) {
            if (!source.includes(marker)) throw new Error(`Upstream scene routing changed: ${marker}.`);
        }
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName: `${createName},${addName},${registerName}`,
            header: "",
            source: `// ${this.context.provenance(modulePath, `${createName}, ${addName}, ${registerName}`)}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <stdexcept>

namespace bbl {
namespace {

void require_scene_engine(const Scene& scene) {
    if (!scene.engine) throw std::runtime_error("Scene is not associated with an engine.");
}

} // namespace

Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    scene.clear_color = Color4{
        ${value(clear("r"))},
        ${value(clear("g"))},
        ${value(clear("b"))},
        ${value(clear("a"))},
    };
    return scene;
}

void add_to_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    if (mesh.value >= scene.engine->meshes.size()) throw std::runtime_error("Invalid mesh handle.");
    scene.meshes.push_back(mesh);
}

void add_to_scene(Scene& scene, LightHandle light) {
    require_scene_engine(scene);
    if (light.value >= scene.engine->lights.size()) throw std::runtime_error("Invalid light handle.");
    scene.lights.push_back(light);
}

void add_to_scene(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    if (asset.value >= scene.engine->assets.size()) throw std::runtime_error("Invalid asset handle.");
    const AssetRecord& record = scene.engine->assets[asset.value];
    for (const MeshHandle mesh : record.meshes) add_to_scene(scene, mesh);
    for (const LightHandle light : record.lights) add_to_scene(scene, light);
    if (record.has_clear_color) scene.clear_color = record.clear_color;
    if (record.has_camera && scene.camera.value == invalid_handle) scene.camera = record.camera;
}

void register_scene(Scene& scene) {
    require_scene_engine(scene);
    const auto found = std::find(
        scene.engine->registered_scenes.begin(),
        scene.engine->registered_scenes.end(),
        &scene);
    if (found == scene.engine->registered_scenes.end()) {
        scene.engine->registered_scenes.push_back(&scene);
    }
}

} // namespace bbl
`,
        };
    }
}
