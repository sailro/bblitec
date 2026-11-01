import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";
import { lightVersionBumpBody } from "./light-parameters.js";
import { recordAt } from "../compiler/record-access.js";
import { lightKindFacts, type LightKind } from "../compiler/types.js";

/**
 * What a light kind adds to the shared factory shape: its own includes, a
 * helper scope ahead of the factory, extra parameters and record fields, a
 * prologue run before the record exists, and entry points after it.
 */
export interface LightFactoryExtension {
    includes: string;
    before: string;
    parameters: readonly string[];
    prologue: string;
    fields: string;
    after: string;
}

interface HemisphericDefaults {
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}
interface PositionalLightDefaults {
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor?: never;
}

export class LightLowerer {
    /**
     * `childMeshes`: a mesh can sit under a light (`light:hierarchy`), so a
     * write that moves the light's world pushes the invalidation down
     * (`mark_light_children_dirty`).
     */
    public constructor(
        private readonly context: LoweringContext,
        private readonly childMeshes = false,
    ) {}
    public lowerSpotAngleSetter(): string {
        const { file, declaration } = this.context.functionDeclaration(
            "src/light/spot-light.ts",
            "createSpotLight",
        );
        const install = this.context.callExpression(
            declaration,
            "defineProperty",
        );
        const name = install.arguments[1];
        if (!name || !ts.isStringLiteralLike(name) || name.text !== "angle") {
            this.context.contractError(
                name ?? install,
                "Expected the spot light to define an 'angle' accessor.",
            );
        }
        const descriptor = install.arguments[2];
        if (!descriptor || !ts.isObjectLiteralExpression(descriptor))
            this.context.contractError(
                install,
                "Expected a spot angle descriptor.",
            );
        const setter = descriptor.properties.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                this.context.propertyName(member.name) === "set",
        );
        if (
            !setter?.body ||
            setter.parameters.length !== 1 ||
            !ts.isIdentifier(setter.parameters[0]!.name)
        )
            this.context.contractError(
                descriptor,
                "Expected the spot angle setter body.",
            );
        const initializers = ["_angle", "_cosHalfAngle"].map((name) => {
            const initializer = this.context.variableInitializer(
                declaration,
                name,
            );
            const owner = initializer.parent.parent.parent;
            if (
                !ts.isVariableStatement(owner) ||
                owner.declarationList.declarations.length !== 1
            )
                this.context.contractError(
                    initializer,
                    "Expected one spot state declaration.",
                );
            return owner;
        });
        const initialBody = lowerPinnedBody(file, initializers, {
            bindings: new Map([["angle", { cpp: "angle", type: "scalar" }]]),
            calls: new Map(),
        });
        const setterBody = lowerPinnedBody(file, setter.body.statements, {
            bindings: new Map<string, PinnedBinding>([
                [
                    setter.parameters[0]!.name.text,
                    { cpp: "angle", type: "scalar" },
                ],
                ["_angle", { cpp: "light.angle", type: "scalar" }],
                ["_cosHalfAngle", { cpp: "cos_half_angle", type: "scalar" }],
            ]),
            // Native light uniforms read live state every frame.
            calls: new Map([["lvs.b", () => "(void)0"]]),
        });
        return `
void initialize_spot_light_cone(LightRecord& light, double angle) {
${initialBody}
    light.angle = _angle;
    light.cos_half_angle = static_cast<float>(_cosHalfAngle);
}

void refresh_spot_light_cone(LightRecord& light, double angle) {
    double cos_half_angle = light.cos_half_angle;
${setterBody}
    light.cos_half_angle = static_cast<float>(cos_half_angle);
}
`;
    }

    /** Lights compose the same TRS as every other SceneNode. */
    public lowerMatrix(): LoweredSource {
        const modulePath = "src/light/light-base.ts";
        const symbolName = "writeWorldLightDirection";
        const base = this.context.functionDeclaration(
            modulePath,
            "createLightBase",
        ).declaration;
        this.context.assertExpressionShape(
            this.context.callExpression(base, "initSceneNodeTransform"),
            'initSceneNodeTransform({name: "", children: []}, position[0], position[1], position[2])',
            "Light SceneNode transform initialization",
        );
        const body = this.lowerDirectionBody(
            "data",
            "offset",
            "world",
            "direction",
        );
        const signature = `void write_world_light_direction(std::array<float, 3>& data,
    std::size_t offset, const std::array<float, 16>& world, const Vec3& direction)`;
        return {
            modulePath,
            symbolName,
            header: pinnedHeader(
                [
                    "<array>",
                    "<bblite/runtime.hpp>",
                    "<bblite/upstream/pinned_world_transform.hpp>",
                ],
                `
${signature};
`,
            ),
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/light_matrix.hpp>
#include <bblite/js_data.hpp>
#include <cmath>
namespace bbl::upstream {
${signature} {
${body}
}
} // namespace bbl::upstream
`,
        };
    }

    public lowerDirectionBody(
        data: string,
        offset: string,
        world: string,
        direction: string,
    ): string {
        const { file, declaration } = this.context.functionDeclaration(
            "src/light/light-base.ts",
            "writeWorldLightDirection",
        );
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: new Map<string, PinnedBinding>([
                ["data", { cpp: data, type: "f32" }],
                ["offset", { cpp: offset, type: "index" }],
                ["world", { cpp: world, type: "f32" }],
                ...["x", "y", "z"].map((axis): [string, PinnedBinding] => [
                    `direction.${axis}`,
                    {
                        cpp: `static_cast<double>(${direction}.${axis})`,
                        type: "scalar",
                    },
                ]),
            ]),
            calls: new Map(),
        });
    }

    public lowerFactory(): LoweredSource {
        return this.lowerLightFactory("hemispheric");
    }
    public lowerPointFactory(): LoweredSource {
        return this.lowerLightFactory("point");
    }
    public lowerDirectionalFactory(): LoweredSource {
        return this.lowerLightFactory("directional");
    }
    public lowerSpotFactory(): LoweredSource {
        return this.lowerLightFactory("spot");
    }
    /**
     * `upstream/src/light_validation.cpp`: `buildScene`'s
     * `light._validateLighting?.(scene._lighting)` over the scene's lights,
     * dispatched by kind to each reached kind's lowered hook
     * (`validate_<kind>_light_lighting`, emitted beside its factory). Which
     * kinds install the hook is `LightKindFacts.validatesLighting`, checked
     * here against each factory's own object.
     */
    public lowerLightingValidation(kinds: readonly LightKind[]): LoweredSource {
        const modulePath = "src/scene/scene-core.ts";
        const symbolName = "buildScene";
        this.context.expectShapeCount(
            this.context.functionDeclaration(modulePath, symbolName)
                .declaration,
            "light._validateLighting?.(scene._lighting)",
            "Per-light lighting validation",
        );
        const hooked = kinds.filter((kind) => {
            const facts = lightKindFacts[kind];
            const object = this.context.callObjectArgument(
                this.context.functionDeclaration(
                    facts.modulePath,
                    facts.factory,
                ).declaration,
                "applyLightBase",
                1,
            );
            const installs = object.properties.some(
                (property) =>
                    property.name !== undefined &&
                    this.context.propertyName(property.name) ===
                        "_validateLighting",
            );
            if (installs !== facts.validatesLighting)
                this.context.contractError(
                    object,
                    `Expected ${facts.factory} ${facts.validatesLighting ? "to" : "not to"} install _validateLighting.`,
                );
            return installs;
        });
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
namespace bbl {
void validate_scene_lighting(const Scene& scene) {
    for (const LightHandle handle : scene.lights) {
        const LightRecord* light = handle_find(scene.engine->lights, handle);
        if (!light) continue;
${hooked
    .map(
        (kind) =>
            `        if (light->kind == LightKind::${lightKindFacts[kind].native}) validate_${lightKindFacts[kind].native}_light_lighting(scene, *light);`,
    )
    .join("\n")}
    }
}
} // namespace bbl
`,
        };
    }

    /** The rectangular factory: the shared factory shape plus the pin's
     *  own extent, its validation and the scene opt-in beside it. */
    public lowerRectAreaFactory(
        extension: LightFactoryExtension,
    ): LoweredSource {
        return this.lowerLightFactory("rectArea", extension);
    }

    private lowerLightFactory(
        kind: LightKind,
        extension?: LightFactoryExtension,
    ): LoweredSource {
        const {
            modulePath,
            factory: symbolName,
            native,
            positional,
            direction: hasDirection,
        } = lightKindFacts[kind];
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const defaults =
            kind === "hemispheric"
                ? this.extractHemisphericDefaults(modulePath, symbolName)
                : this.extractPositionalLightDefaults(
                      modulePath,
                      symbolName,
                      kind,
                      kind === "point" || kind === "spot",
                  );
        const base = this.context.callExpression(
            declaration,
            "createLightBase",
        );
        this.context.assertExpressionShape(
            base,
            positional
                ? "createLightBase(position)"
                : "createLightBase([0, 0, 0])",
            "Light transform origin",
        );
        const position = positional
            ? "position"
            : `Vec3{${this.context
                  .numericTuple(base.arguments[0]!, file)
                  .map((value) => this.context.floatLiteral(value))
                  .join(", ")}}`;
        const object = this.context.callObjectArgument(
            declaration,
            "applyLightBase",
            1,
        );
        if (hasDirection)
            this.context.assertExpressionShape(
                this.context.propertyInitializer(object, "direction"),
                "new ObservableVec3(direction[0], direction[1], direction[2], lvs.b)",
                "Light direction changes only its light version",
            );
        const parameters = [
            "Engine& engine",
            ...(positional ? ["Vec3 position"] : []),
            ...(hasDirection ? ["Vec3 direction"] : []),
            ...(kind === "spot" ? ["double angle", "float exponent"] : []),
            ...(extension?.parameters ?? []),
            "double intensity",
        ];
        const vectors = ["position", ...(hasDirection ? ["direction"] : [])];
        const setters = vectors
            .map(
                (vector) => `
void set_${native}_light_${vector}(Engine& engine, LightHandle light, Vec3 value) {
    auto& record = ${recordAt("engine.lights", "light")};
    record.${vector} = value;
    ${lightVersionBumpBody(this.context, "record.parameter_version")}${
        this.childMeshes && vector === "position"
            ? "\n    mark_light_children_dirty(engine, record);"
            : ""
    }
}`,
            )
            .join("\n");
        // The positional writers pack an attenuation range the directional
        // record fills with Number.MAX_VALUE; the hemispheric one packs its
        // ground colour; a kind with its own extent (the rectangle) stores
        // that instead.
        const kindFields =
            defaults.groundColor !== undefined
                ? `light.ground_color = ${this.context.cppColor3(defaults.groundColor)};`
                : extension
                  ? extension.fields
                  : "light.range = std::numeric_limits<float>::max();";
        // The spot's cone is its own slice of the shared shape; every other
        // kind's additions arrive through the extension, after it.
        const spot = kind === "spot";
        const before = [
            spot
                ? `namespace {
${this.lowerSpotAngleSetter()}
}`
                : "",
            extension?.before ?? "",
        ]
            .filter(Boolean)
            .join("\n");
        const after = [
            spot
                ? `void set_spot_light_angle(Engine& engine, LightHandle light, double angle) {
    refresh_spot_light_cone(${recordAt("engine.lights", "light")}, angle);
}`
                : "",
            extension?.after ?? "",
        ]
            .filter(Boolean)
            .join("\n");
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>
#include <cmath>
${extension?.includes ?? ""}namespace bbl {
${before}
LightHandle create_${native}_light(${parameters.join(", ")}) {
${extension?.prologue ?? ""}    LightRecord light;
    light.kind = LightKind::${native};
    light.position = ${position};
    ${hasDirection ? "light.direction = direction;" : ""}
    light.intensity = intensity;
    light.diffuse_color = ${this.context.cppColor3(defaults.diffuseColor)};
    light.specular_color = ${this.context.cppColor3(defaults.specularColor)};
    ${kindFields}
    ${spot ? "light.exponent = exponent; initialize_spot_light_cone(light, angle);" : ""}
    engine.lights.push_back(light);
    return LightHandle{static_cast<std::uint32_t>(engine.lights.size() - 1)};
}
${setters}
${after}
} // namespace bbl
`,
        };
    }

    private extractHemisphericDefaults(
        modulePath: string,
        symbolName: string,
    ): HemisphericDefaults {
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const lightObject = this.context.callObjectArgument(
            declaration,
            "applyLightBase",
            1,
        );
        return {
            diffuseColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "diffuseColor"),
                file,
            ),
            specularColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "specularColor"),
                file,
            ),
            groundColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "groundColor"),
                file,
            ),
        };
    }

    private extractPositionalLightDefaults(
        modulePath: string,
        symbolName: string,
        expectedType: Exclude<LightKind, "hemispheric">,
        requireRange: boolean,
    ): PositionalLightDefaults {
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const lightObject = this.context.callObjectArgument(
            declaration,
            "applyLightBase",
            1,
        );
        const lightType = this.context.stringValue(
            this.context.propertyInitializer(lightObject, "lightType"),
            file,
        );
        if (lightType !== expectedType) {
            throw new Error(
                `Pinned ${expectedType} light type changed to '${lightType}'.`,
            );
        }
        const range = lightObject.properties.some(
            (property) =>
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                property.name.text === "range" &&
                this.context.isNumberMaxValue(property.initializer),
        );
        if (requireRange && !range) {
            throw new Error(`Pinned ${expectedType} light range is missing.`);
        }
        return {
            diffuseColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "diffuse"),
                file,
            ),
            specularColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "specular"),
                file,
            ),
        };
    }
}

/**
 * `upstream/src/light_hierarchy.cpp`: the SceneNode half every light shares
 * -- its parent, a mesh under it and its quaternion. A light is a tagged
 * host upstream: a mesh under it composes the light's world as it is now
 * (`mesh_world_matrix`'s light lane), and each write that moves the light's
 * world pushes the invalidation down (`mark_light_children_dirty`), as a
 * move of the node above it does through `parented_lights`.
 */
export function lowerLightHierarchy(context: LoweringContext): LoweredSource {
    const modulePath = "src/light/light-base.ts";
    context.assertExpressionShape(
        context.callExpression(
            context.functionDeclaration(modulePath, "createLightBase")
                .declaration,
            "initSceneNodeTransform",
        ),
        'initSceneNodeTransform({name: "", children: []}, position[0], position[1], position[2])',
        "Light SceneNode transform initialization",
    );
    const bump = lightVersionBumpBody(context, "record.parameter_version");
    const light = recordAt("engine.lights", "light");
    return {
        modulePath,
        symbolName: "createLightBase",
        header: "",
        source: `// ${context.provenance(modulePath, "createLightBase")}
// ${context.provenance("src/scene/world-matrix-state.ts", "createWorldMatrixState")}
#include <bblite/runtime.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/upstream/renderer_plan.hpp>
#include <algorithm>
#include <array>
#include <functional>
#include <variant>
namespace bbl {

namespace {
// The invalidation registry of the node a light is parented to.
std::vector<LightHandle>* light_parent_registry(Engine& engine, const SceneNodeHandle& node) {
    if (const MeshHandle* mesh = std::get_if<MeshHandle>(&node)) {
        return mesh->value == invalid_handle ? nullptr
                                             : &${recordAt("engine.meshes", "*mesh")}.parented_lights;
    }
    if (const TransformNodeHandle* transform = std::get_if<TransformNodeHandle>(&node)) {
        return transform->value == invalid_handle
                   ? nullptr
                   : &${recordAt("engine.transform_nodes", "*transform")}.parented_lights;
    }
    const AssetHandle asset = std::get<AssetHandle>(node);
    return asset.value == invalid_handle ? nullptr
                                         : &${recordAt("engine.assets", "asset")}.parented_lights;
}

// The node's world, read live the way light_world_matrix reads every parent.
std::function<std::array<float, 16>()> light_parent_world(Engine& engine,
                                                         const SceneNodeHandle& node) {
    if (const MeshHandle* mesh = std::get_if<MeshHandle>(&node)) {
        return [&engine, parent = *mesh] {
            return upstream::mesh_world_matrix(engine, ${recordAt("engine.meshes", "parent")});
        };
    }
    if (const TransformNodeHandle* transform = std::get_if<TransformNodeHandle>(&node)) {
        return [&engine, parent = *transform] {
            return upstream::transform_node_world(engine, parent);
        };
    }
    return [&engine, parent = std::get<AssetHandle>(node)] {
        return asset_root_world_matrix(engine, parent);
    };
}
} // namespace

// \`light.parent = node\`: a mesh, a transform node, an imported root, or
// none (an invalid handle). The node registers the light, so the node's own
// invalidation reaches the meshes under the light.
void set_light_parent(Engine& engine, LightHandle light, SceneNodeHandle parent) {
    auto& record = ${light};
    if (std::vector<LightHandle>* previous = light_parent_registry(engine, record.parent_node)) {
        std::erase_if(*previous,
                      [light](LightHandle entry) { return entry.value == light.value; });
    }
    std::vector<LightHandle>* registry = light_parent_registry(engine, parent);
    record.parent_node = parent;
    record.parent_world_matrix = registry ? light_parent_world(engine, parent)
                                          : std::function<std::array<float, 16>()>{};
    if (registry) registry->push_back(light);
    ${bump}
    mark_light_children_dirty(engine, record);
}

// \`mesh.parent = light\`: the mesh's light lane. The pin's setter returns on
// an unchanged parent before anything else.
void set_mesh_light_parent(Engine& engine, MeshHandle mesh, LightHandle light) {
    MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    auto& parent = ${light};
    if (record.light_parent.value == light.value) return;
    unregister_from_parents(engine, record, mesh);
    clear_mesh_world_matrix_provider(record);
    record.parent = MeshHandle{};
    record.transform_parent = TransformNodeHandle{};
    record.parent_world.reset();
    record.light_parent = light;
    if (std::find(parent.parented_meshes.begin(), parent.parented_meshes.end(), mesh) ==
        parent.parented_meshes.end()) {
        parent.parented_meshes.push_back(mesh);
    }
    mark_mesh_dirty(engine, mesh);
}

// The ObservableQuat write every SceneNode takes; light_world_matrix
// composes it with the rest of the TRS.
void set_light_rotation_quaternion(Engine& engine, LightHandle light, Vec4 rotation) {
    auto& record = ${light};
    record.rotation_quaternion = rotation;
    record.has_rotation_quaternion = true;
    ${bump}
    mark_light_children_dirty(engine, record);
}

} // namespace bbl
`,
    };
}
