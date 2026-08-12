import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class SceneLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerCore(
        options: { fog?: boolean } = {},
    ): LoweredSource {
        const modulePath = "src/scene/scene-core.ts";
        const createName = "createSceneContext";
        const addName = "addToScene";
        const beforeName = "onBeforeRender";
        const registerName = "registerScene";
        const fogModulePath = "src/scene/scene-ubo-extras.ts";
        const fogName = "setFog";
        const { file, declaration } = this.context.functionDeclaration(modulePath, createName);
        const scene = this.context.objectInitializer(declaration, "ctxLocal");
        const clearExpression = this.context.propertyInitializer(scene, "clearColor");
        if (!ts.isObjectLiteralExpression(clearExpression)) {
            throw new Error("Upstream scene clearColor is not an object literal.");
        }
        const clear = (name: string): number =>
            this.context.numericValue(this.context.propertyInitializer(clearExpression, name), file);
        const { declaration: addToScene } =
            this.context.functionDeclaration(
                modulePath,
                addName,
            );
        for (const property of [
            "entities",
            "_gpu",
            "material",
            "lightType",
        ]) {
            if (
                !this.context.hasNode(
                    addToScene,
                    (node) =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.InKeyword &&
                        ts.isStringLiteral(node.left) &&
                        node.left.text === property &&
                        ts.isIdentifier(node.right) &&
                        node.right.text === "entity",
                )
            ) {
                this.context.contractError(
                    addToScene,
                    `Expected '${property}' entity routing.`,
                );
            }
        }
        const { declaration: onBeforeRender } =
            this.context.functionDeclaration(
                modulePath,
                beforeName,
            );
        if (
            !this.context.hasNode(
                onBeforeRender,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                    node.expression.name.text === "unshift" &&
                    ts.isPropertyAccessExpression(
                        node.expression.expression,
                    ) &&
                    node.expression.expression.name.text ===
                        "_beforeRender" &&
                    node.arguments.length === 1 &&
                    ts.isIdentifier(node.arguments[0]!) &&
                    node.arguments[0].text === "cb",
            )
        ) {
            this.context.contractError(
                onBeforeRender,
                "Expected before-render callbacks to be prepended.",
            );
        }
        const { declaration: registerScene } =
            this.context.functionDeclaration(
                modulePath,
                registerName,
            );
        if (
            !this.context.hasCall(
                registerScene,
                "isRenderingContextRegistered",
            )
        ) {
            this.context.contractError(
                registerScene,
                "Expected idempotent rendering-context registration.",
            );
        }
        if (options.fog) {
            const { declaration: setFog } =
                this.context.functionDeclaration(
                    fogModulePath,
                    fogName,
                );
            if (
                !this.context.hasNode(
                    setFog,
                    (node) =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        this.context
                            .propertyPath(node.left)
                            ?.join(".") === "scene.fog" &&
                        ts.isIdentifier(node.right) &&
                        node.right.text === "config",
                )
            ) {
                this.context.contractError(
                    setFog,
                    "Expected setFog to store the fog config on the scene.",
                );
            }
            if (
                !this.context.hasCall(
                    setFog,
                    "registerContributor",
                )
            ) {
                this.context.contractError(
                    setFog,
                    "Expected setFog to register the fog scene-uniform contributor.",
                );
            }
            const { declaration: writeFogUbo } =
                this.context.functionDeclaration(
                    fogModulePath,
                    "writeFogUbo",
                );
            const fogUboWrites: readonly (readonly [
                number,
                string,
            ])[] = [
                [80, "fog.mode"],
                [81, "fog.start"],
                [82, "fog.end"],
                [83, "fog.density"],
            ];
            for (const [offset, path] of fogUboWrites) {
                if (
                    !this.context.hasNode(
                        writeFogUbo,
                        (node) =>
                            ts.isBinaryExpression(node) &&
                            node.operatorToken.kind ===
                                ts.SyntaxKind.EqualsToken &&
                            ts.isElementAccessExpression(
                                node.left,
                            ) &&
                            ts.isNumericLiteral(
                                node.left.argumentExpression,
                            ) &&
                            Number(
                                node.left.argumentExpression
                                    .text,
                            ) === offset &&
                            this.context
                                .propertyPath(node.right)
                                ?.join(".") === path,
                    )
                ) {
                    this.context.contractError(
                        writeFogUbo,
                        `Expected fog UBO write data[${offset}] = ${path}.`,
                    );
                }
            }
            for (const channel of [0, 1, 2]) {
                if (
                    !this.context.hasNode(
                        writeFogUbo,
                        (node) => {
                            if (
                                !ts.isBinaryExpression(node) ||
                                node.operatorToken.kind !==
                                    ts.SyntaxKind.EqualsToken ||
                                !ts.isElementAccessExpression(
                                    node.left,
                                ) ||
                                !ts.isNumericLiteral(
                                    node.left
                                        .argumentExpression,
                                ) ||
                                Number(
                                    node.left
                                        .argumentExpression
                                        .text,
                                ) !== 84 + channel
                            ) {
                                return false;
                            }
                            const right =
                                this.context.unwrapExpression(
                                    node.right,
                                );
                            return (
                                ts.isElementAccessExpression(
                                    right,
                                ) &&
                                ts.isNumericLiteral(
                                    right.argumentExpression,
                                ) &&
                                Number(
                                    right.argumentExpression
                                        .text,
                                ) === channel &&
                                this.context
                                    .propertyPath(
                                        right.expression,
                                    )
                                    ?.join(".") === "fog.color"
                            );
                        },
                    )
                ) {
                    this.context.contractError(
                        writeFogUbo,
                        `Expected fog UBO color write data[${84 + channel}].`,
                    );
                }
            }
        }
        const value = (input: number): string => this.context.floatLiteral(input);
        const fogSource = options.fog
            ? `
// ${this.context.provenance(fogModulePath, `${fogName}, writeFogUbo`)}
void set_scene_fog(
    Scene& scene,
    float mode,
    float density,
    float start,
    float end,
    Color3 color) {
    require_scene_engine(scene);
    scene.fog_mode = mode;
    scene.fog_density = density;
    scene.fog_start = start;
    scene.fog_end = end;
    scene.fog_color = color;
}
`
            : "";
        return {
            modulePath,
            symbolName: `${createName},${addName},${beforeName},${registerName}${options.fog ? `,${fogName}` : ""}`,
            header: "",
            source: `// ${this.context.provenance(modulePath, `${createName}, ${addName}, ${beforeName}, ${registerName}`)}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace bbl {
namespace {

void require_scene_engine(const Scene& scene) {
    if (!scene.engine) throw std::runtime_error("Scene is not associated with an engine.");
}

std::uint32_t material_family_bit(
    const Engine& engine,
    MeshHandle mesh) {
    if (mesh.value >= engine.meshes.size()) return 0;
    const MaterialHandle material = engine.meshes[mesh.value].material;
    if (material.value >= engine.materials.size()) return 0;
    const MaterialRecord& record = engine.materials[material.value];
    if (record.grid_material) return material_family_grid;
    if (record.shader_material) return material_family_shader;
    if (record.standard_material) return material_family_standard;
    return material_family_pbr;
}

std::uint32_t scene_material_families(const Scene& scene) {
    std::uint32_t result = 0;
    for (const MeshHandle mesh : scene.meshes) {
        result |= material_family_bit(*scene.engine, mesh);
    }
    return result;
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
    ++scene.mesh_membership_version;
    scene.material_family_mask |=
        material_family_bit(*scene.engine, mesh);
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
    if (record.scene_setup) record.scene_setup(scene);
    if (record.has_camera) scene.camera = record.camera;
    if (record.has_clear_color) scene.clear_color = record.clear_color;
    if (record.animation_tick) {
        scene.before_render.push_back(record.animation_tick);
    }
    if (record.animation_seek) {
        scene.animation_seekers.push_back(record.animation_seek);
    }
}

void on_before_render(
    Scene& scene,
    std::function<void(float)> callback) {
    scene.before_render.insert(
        scene.before_render.begin(),
        std::move(callback));
}

void register_scene(Scene& scene) {
    require_scene_engine(scene);
    for (const auto& builder : scene.deferred_builders) {
        builder();
    }
    scene.deferred_builders.clear();
    scene.material_family_mask = scene_material_families(scene);
    const auto found = std::find(
        scene.engine->registered_scenes.begin(),
        scene.engine->registered_scenes.end(),
        &scene);
    if (found == scene.engine->registered_scenes.end()) {
        scene.engine->registered_scenes.push_back(&scene);
    }
}

void enable_scene_transmission(Scene& scene) {
    require_scene_engine(scene);
    scene.transmission_enabled = true;
}
${fogSource}
} // namespace bbl
`,
        };
    }
}
