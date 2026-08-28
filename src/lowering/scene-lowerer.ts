import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class SceneLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerCore(
        options: {
            fog?: boolean;
            managedAnimationGroups?: boolean;
        } = {},
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
        const transformNodeModulePath =
            "src/scene/transform-node.ts";
        const { declaration: cloneTransformNode } =
            this.context.functionDeclaration(
                transformNodeModulePath,
                "cloneTransformNode",
            );
        if (
            !this.context.hasNode(
                cloneTransformNode,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.InKeyword &&
                    ts.isStringLiteral(node.left) &&
                    node.left.text === "_gpu" &&
                    ts.isIdentifier(node.right) &&
                    node.right.text === "src",
            ) ||
            !this.context.hasNode(
                cloneTransformNode,
                (node) =>
                    ts.isForOfStatement(node) &&
                    this.context
                        .propertyPath(node.expression)
                        ?.join(".") === "src.children",
            ) ||
            !this.context.hasCall(
                cloneTransformNode,
                "cloneTransformNode",
            )
        ) {
            this.context.contractError(
                cloneTransformNode,
                "Expected cloneTransformNode to route meshes and recursively clone children.",
            );
        }
        const { declaration: cloneMeshNode } =
            this.context.functionDeclaration(
                transformNodeModulePath,
                "cloneMeshNode",
            );
        if (
            !this.context.hasNode(
                cloneMeshNode,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    this.context.propertyName(node.name) ===
                        "_gpu" &&
                    this.context
                        .propertyPath(node.initializer)
                        ?.join(".") === "mesh._gpu",
            ) ||
            !this.context.hasCall(cloneMeshNode, "retain")
        ) {
            this.context.contractError(
                cloneMeshNode,
                "Expected mesh clones to retain and share their GPU-backed resources.",
            );
        }
        // The pinned clone naming: `mesh.name + "_clone"`. The suffix
        // flows into the emitted record copy so a scene searching by name
        // never matches a clone under the source's own name.
        const cloneSuffixes = this.context
            .findNodes(
                cloneMeshNode,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.PlusToken &&
                    this.context
                        .propertyPath(node.left)
                        ?.join(".") === "mesh.name" &&
                    ts.isStringLiteral(
                        this.context.unwrapExpression(node.right),
                    ),
            )
            .map(
                (concat) =>
                    (
                        this.context.unwrapExpression(
                            concat.right,
                        ) as ts.StringLiteral
                    ).text,
            );
        if (cloneSuffixes.length !== 1) {
            this.context.contractError(
                cloneMeshNode,
                "Expected one pinned clone-name suffix.",
            );
        }
        const cloneSuffix = cloneSuffixes[0]!;
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
                    // 1.23 renamed this from `registerContributor`; the body
                    // is the same store-then-register pair.
                    "_registerSceneUboContributor",
                )
            ) {
                this.context.contractError(
                    setFog,
                    "Expected setFog to register the fog scene-uniform contributor.",
                );
            }
            // The fog UBO writer's field inventory, paired with the
            // emitted `set_scene_fog` stores: the generated Scene
            // carries exactly the fields the pinned writer consumes
            // (mode, start, end, density, color), so a pin that grows
            // the fog slice fails generation instead of rendering with a
            // silently missing term. The writer's float offsets (80-86
            // in the browser scene UBO) are deliberately NOT asserted:
            // nothing in the generated tree uses them — fog reaches the
            // native shaders through named uniform-struct fields packed
            // by the renderer lowerer, and the WGSL component reads come
            // from the pin's own WGSL_FOG, lifted verbatim by
            // shader-builtins-utility.ts fogFactorWgsl(), so they track
            // the pin without a copy here.
            const { declaration: writeFogUbo } =
                this.context.functionDeclaration(
                    fogModulePath,
                    "writeFogUbo",
                );
            const fogReads = new Set<string>();
            for (const access of this.context.findNodes(
                writeFogUbo,
                (
                    node,
                ): node is ts.PropertyAccessExpression =>
                    ts.isPropertyAccessExpression(node),
            )) {
                const path = this.context.propertyPath(access);
                if (
                    path &&
                    path.length === 2 &&
                    path[0] === "fog"
                ) {
                    fogReads.add(path[1]!);
                }
            }
            const expectedFogFields = [
                "mode",
                "start",
                "end",
                "density",
                "color",
            ];
            if (
                fogReads.size !== expectedFogFields.length ||
                expectedFogFields.some(
                    (name) => !fogReads.has(name),
                )
            ) {
                this.context.contractError(
                    writeFogUbo,
                    `Expected the fog UBO writer to consume exactly ` +
                        `{${expectedFogFields.join(", ")}}, found ` +
                        `{${[...fogReads].sort().join(", ")}}.`,
                );
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
        // The emitted removal is the pinned mesh arm — removeFromScene
        // dispatches a mesh to removeMeshFromScene, whose scene-list
        // splice plus mutation mark is what the native erase and
        // membership bump mirror. Anchored on the splice pair itself
        // rather than only on the dispatcher's existence, so a
        // restructured mesh arm refuses generation instead of leaving the
        // native erase mirroring a branch the pin no longer has.
        this.context.functionDeclaration(
            "src/scene/scene-remove.ts",
            "removeFromScene",
        );
        const { declaration: meshRemoval } =
            this.context.functionDeclaration(
                "src/scene/scene-remove.ts",
                "removeMeshFromScene",
            );
        const meshSplices = this.context.findNodes(
            meshRemoval,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                this.context.propertyPath(node.expression)?.join(".") ===
                    "scene.meshes.splice",
        );
        if (meshSplices.length !== 1) {
            this.context.contractError(
                meshRemoval,
                "Pinned removeMeshFromScene no longer splices " +
                    "scene.meshes exactly once.",
            );
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(meshRemoval, "mi2"),
            "scene.meshes.indexOf(mesh)",
            "Pinned mesh-removal index",
        );
        // A manager created with this engine owns animation time for the
        // groups attached to it, and a scene it drives has no other way to
        // reach them: the measured seek walks the scene's seekers, so a
        // registering scene contributes one per manager. Not a pinned
        // step -- upstream seeks by calling goToFrame on the groups
        // themselves, which is what this reproduces.
        const managerSeek = options.managedAnimationGroups
            ? `
    if (!scene.seeks_animation_managers) {
        scene.seeks_animation_managers = true;
        Engine* engine = scene.engine;
        scene.animation_seekers.push_back(
            [engine](float time) {
                // Walked when the seek fires, not when it is attached:
                // a manager created after this scene registered still
                // owns animation time for the groups on it.
                for (
                    const PropertyAnimationManager& manager :
                    engine->animation_managers) {
                    seek_animation_manager(manager, *engine, time);
                }
            });
    }`
            : "";
        return {
            modulePath,
            symbolName: `${createName},${addName},cloneTransformNode,removeFromScene,${beforeName},${registerName}${options.fog ? `,${fogName}` : ""}`,
            header: "",
            source: `// ${this.context.provenance(modulePath, `${createName}, ${addName}, ${beforeName}, ${registerName}`, `${transformNodeModulePath}#cloneTransformNode, cloneMeshNode`)}
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

// src/scene/scene-remove.ts removeFromScene: drop the mesh from the
// scene list and mark the topology dirty (the pinned helper is
// idempotent — removing a mesh the scene never held is a no-op). The
// material-family mask stays monotonic: it gates which pipelines the
// backend created, and a removal never invalidates one.
void remove_from_scene(Scene& scene, MeshHandle mesh) {
    require_scene_engine(scene);
    const auto found = std::find_if(
        scene.meshes.begin(),
        scene.meshes.end(),
        [mesh](const MeshHandle candidate) {
            return candidate.value == mesh.value;
        });
    if (found == scene.meshes.end()) return;
    scene.meshes.erase(found);
    ++scene.mesh_membership_version;
}

void add_to_scene(Scene& scene, LightHandle light) {
    require_scene_engine(scene);
    if (light.value >= scene.engine->lights.size()) throw std::runtime_error("Invalid light handle.");
    scene.lights.push_back(light);
}

namespace {

AssetRecord& asset_record(Engine& engine, std::uint32_t asset) {
    if (asset >= engine.assets.size()) {
        throw std::runtime_error("Invalid asset handle.");
    }
    return engine.assets[asset];
}

}  // namespace

/**
 * src/scene/transform-node.ts cloneTransformNode/cloneMeshNode over the
 * imported synthetic root. Native loading has flattened the hierarchy, so
 * the clone is a mesh-only AssetRecord: distinct mesh wrappers sharing the
 * source geometry/material state, without the container's animation groups,
 * tick, camera, lights or scene setup. The source runtime callback mirrors
 * the retained skeleton resource by registering each skinned wrapper against
 * the same pose evaluator.
 */
AssetHandle clone_asset_root(Engine& engine, AssetHandle asset) {
    const AssetRecord& source = asset_record(engine, asset.value);
    if (!source.lights.empty() || source.has_camera) {
        throw std::runtime_error(
            "Cloning an imported root with light or camera descendants is not supported.");
    }
    const std::vector<MeshHandle> source_meshes = source.meshes;
    const auto clone_animation = source.clone_mesh_animation;
    AssetRecord clone;
    clone.root_position = source.root_position;
    clone.clone_mesh_animation = clone_animation;
    clone.meshes.reserve(source_meshes.size());
    for (const MeshHandle source_mesh : source_meshes) {
        if (source_mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord record = engine.meshes[source_mesh.value];
        record.name += "${cloneSuffix}";
        record.feature_source_mesh =
            record.feature_source_mesh != invalid_handle
                ? record.feature_source_mesh
                : source_mesh.value;
        const MeshHandle cloned_mesh{
            static_cast<std::uint32_t>(engine.meshes.size())};
        engine.meshes.push_back(std::move(record));
        clone.meshes.push_back(cloned_mesh);
        if (clone_animation) {
            clone_animation(source_mesh, cloned_mesh);
        }
    }
    const AssetHandle cloned_asset{
        static_cast<std::uint32_t>(engine.assets.size())};
    engine.assets.push_back(std::move(clone));
    return cloned_asset;
}

void set_asset_root_position_component(
    Engine& engine,
    AssetHandle asset,
    std::size_t component,
    float value) {
    AssetRecord& root = asset_record(engine, asset.value);
    const auto component_ref = [component](Vec3& vector) -> float& {
        switch (component) {
            case 0: return vector.x;
            case 1: return vector.y;
            case 2: return vector.z;
            default:
                throw std::runtime_error(
                    "Imported root position component is out of range.");
        }
    };
    float& root_component = component_ref(root.root_position);
    const float delta = value - root_component;
    root_component = value;
    for (const MeshHandle mesh : root.meshes) {
        if (mesh.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle in imported root.");
        }
        MeshRecord& record = engine.meshes[mesh.value];
        component_ref(record.outer_position) += delta;
        ++record.transform_version;
    }
}

void add_to_scene(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    const AssetRecord& record =
        asset_record(*scene.engine, asset.value);
    for (const MeshHandle mesh : record.meshes) add_to_scene(scene, mesh);
    for (const LightHandle light : record.lights) add_to_scene(scene, light);
    // addToScene registers the file's animation groups with the scene, which
    // is what makes them reachable as scene.animationGroups.
    for (const AnimationGroupHandle group : record.animation_groups) {
        scene.animation_groups.push_back(group);
    }
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

/**
 * A container's entities, which is what a scene iterating entities and
 * calling addToScene per entity adds: the pinned container arm's own entity
 * recursion and nothing else. Its animation groups, their per-frame
 * tick, its camera and its clear colour are container-level wiring the
 * pin performs for the container itself, and a scene iterating entities
 * is usually avoiding exactly that — it drives those groups from its own
 * AnimationManager instead.
 *
 * The pin seeds a glTF container with its root node and lets each loader
 * feature append its own entities, so adding them one by one adds the
 * loader's meshes and its lights — which is what this adds in one step.
 * Generation refuses any other container.
 *
 * The animation seeker is not part of the pinned walk: it is this port's
 * deterministic-pose entry point (BBLITE_ANIMATION_SEEK_SECONDS),
 * standing for the goToFrame the browser harness calls on the same
 * groups, so it follows the asset rather than the way it was added.
 */
void add_asset_entities(Scene& scene, AssetHandle asset) {
    require_scene_engine(scene);
    const AssetRecord& record =
        asset_record(*scene.engine, asset.value);
    for (const MeshHandle mesh : record.meshes) add_to_scene(scene, mesh);
    for (const LightHandle light : record.lights) add_to_scene(scene, light);
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

void on_key_down(
    Engine& engine,
    std::function<void(const PlatformKeyboardEvent&)> callback) {
    engine.key_down_callbacks.push_back(std::move(callback));
}

void on_key_up(
    Engine& engine,
    std::function<void(const PlatformKeyboardEvent&)> callback) {
    engine.key_up_callbacks.push_back(std::move(callback));
}

void on_pointer_down(
    Engine& engine,
    std::function<void()> callback) {
    engine.pointer_down_callbacks.push_back(std::move(callback));
}

void on_mouse_down(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback) {
    engine.mouse_down_callbacks.push_back(std::move(callback));
}

void on_mouse_up(
    Engine& engine,
    std::function<void(const PlatformMouseEvent&)> callback) {
    engine.mouse_up_callbacks.push_back(std::move(callback));
}

void on_visibility_change(
    Engine& engine,
    std::function<void(bool)> callback) {
    engine.visibility_change_callbacks.push_back(std::move(callback));
}

void register_scene(Scene& scene) {
    require_scene_engine(scene);${managerSeek}
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
