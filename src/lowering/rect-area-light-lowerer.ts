/**
 * The rectangular area light's native half, lowered from
 * `src/light/rect-area-light.ts` and `src/light/enable-rect-area-lights.ts`.
 *
 * The factory, its `validateSize` checks and the three validating accessors
 * are asserted against the pinned AST and re-emitted over `LightRecord`; the
 * UBO writer is the pinned `_writeLightUbo`, lowered with every other light's
 * (`lightUniformsBlock`). What `enableRectAreaLights` does past composition
 * -- the disposed-scene refusal and the LTC tables' load -- runs natively
 * here, and `buildScene`'s `_validateLighting` call is `validate_scene_lighting`.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { lightVersionBumpBody } from "./light-parameters.js";
import { LightLowerer } from "./light-lowerer.js";
import {
    pinnedErrorCode,
    pinnedErrorMessage,
    pinnedErrorMessageCpp,
} from "./pinned-error.js";
import { recordAt } from "../compiler/record-access.js";
import { lightKindFacts } from "../compiler/types.js";
import { stringLiteral } from "../cpp-literals.js";
import {
    pinnedAreaLightImageShape,
    pinnedAreaLightLtcShape,
} from "../pinned-rect-area-lights.js";
import { pinnedMaxLights } from "./pinned-max-lights.js";

const { modulePath: lightModule, factory: lightFactory } =
    lightKindFacts.rectArea;
const enableModule = "src/light/enable-rect-area-lights.ts";

/**
 * The decoded LTC tables generation packages (`decodedAreaLightLtc`), as
 * `enableRectAreaLights` registers them: LTC1, then LTC2.
 */
export const areaLightLtcSources = [
    "generated:pinned-area-light-ltc1",
    "generated:pinned-area-light-ltc2",
] as const;

/**
 * `createRectAreaLight`'s own `intensity = <default>`: the parameter after
 * the position and the extent (`lightKindFacts.rectArea.accessors`).
 */
export function rectAreaLightDefaultIntensity(
    context: LoweringContext,
): number {
    const facts = lightKindFacts.rectArea;
    return context.numericParameterDefault(
        context.functionDeclaration(lightModule, lightFactory).declaration,
        (facts.positional ? 1 : 0) + facts.accessors.indexOf("intensity"),
        "intensity",
    );
}

/**
 * The pin's refusal of an `emissionTexture` that is not a processed image.
 * Without any `processAreaLightTexture` call no emission seam is installed,
 * so `enableRectAreaLights` throws for the packed light; with one, the
 * scene snapshot's `validateAreaLightImage` throws for the unprocessed
 * texture.
 */
export function rectAreaEmissionRefusalMessage(
    context: LoweringContext,
    processed: boolean,
): string {
    if (processed) {
        const { declaration: validate } = context.functionDeclaration(
            "src/light/area-light-image.ts",
            "validateAreaLightImage",
        );
        const guard = validate.body?.statements.find(
            (statement): statement is ts.IfStatement =>
                ts.isIfStatement(statement) &&
                context.expressionMatchesShape(
                    statement.expression,
                    "!image || image.texture !== source.texture",
                ),
        );
        if (!guard)
            return context.contractError(
                validate,
                "Expected validateAreaLightImage to refuse a texture " +
                    "processAreaLightTexture did not produce.",
            );
        return pinnedErrorMessage(context, pinnedErrorCode(context, guard));
    }
    const { declaration } = context.functionDeclaration(
        enableModule,
        "enableRectAreaLights",
    );
    const guard = declaration.body?.statements.find(
        (statement): statement is ts.IfStatement =>
            ts.isIfStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "!prepareEmission",
            ),
    );
    if (!guard)
        return context.contractError(
            declaration,
            "Expected enableRectAreaLights to refuse an unprocessed " +
                "emissionTexture under `if (!prepareEmission)`.",
        );
    context.expectShapeCount(
        guard,
        "(light as RectAreaLight).emissionTexture !== null",
        "Textured emission predicate",
    );
    return pinnedErrorMessage(context, pinnedErrorCode(context, guard));
}

/**
 * The pin's Node-lighting refusal: the area extension's `_validateNode`
 * rejects a node graph reading the lights block in a scene holding an
 * area light, rather than shading type 4 as a point light.
 */
export function rectAreaNodeLightingRefusalMessage(
    context: LoweringContext,
): string {
    const { declaration } = context.functionDeclaration(
        enableModule,
        "enableRectAreaLights",
    );
    const hook = context.findNodes(
        declaration,
        (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) &&
            context.propertyName(node.name) === "_validateNode",
    )[0];
    if (!hook)
        return context.contractError(
            declaration,
            "Expected enableRectAreaLights to install `_validateNode`.",
        );
    context.expectShapeCount(
        hook,
        'usesLights && scene.lights.some((light) => light.lightType === "rectArea")',
        "Area-light Node lighting predicate",
    );
    return pinnedErrorMessage(context, pinnedErrorCode(context, hook));
}

export class RectAreaLightLowerer {
    /**
     * `emission`: the program calls `processAreaLightTexture`, so the
     * processed images, the scene snapshot and its refresh at registration
     * are emitted.
     */
    public constructor(
        private readonly context: LoweringContext,
        private readonly emission = false,
        /** `light:hierarchy`: see `LightLowerer`'s `childMeshes`. */
        private readonly childMeshes = false,
        /**
         * Per node variant, in reach order, whether its graph reads the
         * lights block (`_state.usesLightsUbo`), which the area extension's
         * `_validateNode` refuses in a scene holding an area light.
         */
        private readonly nodeLighting: readonly boolean[] = [],
    ) {}

    /**
     * `upstream/src/light_rect_area.cpp`: the shared light factory shape
     * (`LightLowerer`, which also reads the pin's lightType, transform
     * origin and colour defaults) with the rectangle's own extent, its
     * validating accessors and the scene opt-in.
     */
    public lower(): LoweredSource {
        const context = this.context;
        const { declaration } = context.functionDeclaration(
            lightModule,
            lightFactory,
        );
        const statements = declaration.body!.statements;
        // The kind's accessors (`lightKindFacts`): each one is a factory
        // parameter, validated in the pin's order before the light base
        // exists, then installed as a validating accessor. Every field but
        // the intensity the shared factory shape stores is the extent.
        const fields = lightKindFacts.rectArea.accessors;
        const extent = fields.filter((field) => field !== "intensity");
        context.assertStatementShapes(
            declaration,
            statements.slice(0, fields.length),
            fields
                .map((field) => `validateSize(${field}, "${field}");`)
                .join(" "),
            "Rect area light construction checks",
        );
        const object = context.callObjectArgument(
            declaration,
            "applyLightBase",
            1,
        );
        for (const field of fields)
            context.assertExpressionShape(
                context.propertyInitializer(object, field),
                field,
                `Rect area ${field} initializer`,
            );
        context.assertExpressionShape(
            context.propertyInitializer(object, "emissionTexture"),
            "null",
            "Rect area emission default",
        );
        // Validate, then store and bump only on a change.
        const list = `[${fields.map((field) => JSON.stringify(field)).join(", ")}] as const`;
        const accessors = statements.find(
            (statement): statement is ts.ForOfStatement =>
                ts.isForOfStatement(statement) &&
                context.expressionMatchesShape(statement.expression, list),
        );
        if (!accessors)
            return context.contractError(
                declaration,
                `Expected the ${fields.join("/")} accessor loop.`,
            );
        context.assertStatementShapes(
            declaration,
            [accessors],
            `for (const key of ${list}) {
    let value = light[key];
    Object.defineProperty(light, key, {
        enumerable: true,
        get: () => value,
        set: (next: number) => {
            validateSize(next, key);
            if (value !== next) {
                value = next;
                lvs.b();
            }
        },
    });
}`,
            "Rect area validating accessors",
        );
        const validate = this.lowerValidateSize();
        const bump = lightVersionBumpBody(context, "record.parameter_version");
        // The accessor works on the record, which the generic
        // `setLightIntensity` store reaches too; the handle form is the
        // `light.<field> = value` write.
        const setters = fields
            .map(
                (field) => `
void set_rect_area_light_${field}(LightRecord& record, double value) {
    validate_rect_area_size(value, "${field}");
    if (record.${field} != value) {
        record.${field} = value;
        ${bump}
    }
}
void set_rect_area_light_${field}(Engine& engine, LightHandle light, double value) {
    set_rect_area_light_${field}(${recordAt("engine.lights", "light")}, value);
}`,
            )
            .join("\n");
        return new LightLowerer(context, this.childMeshes).lowerRectAreaFactory(
            {
                includes: `// ${context.provenance(enableModule, "enableRectAreaLights")}
#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>
#include <stdexcept>
#include <string>
`,
                before: `namespace {
${validate}
} // namespace`,
                parameters: extent.map((field) => `double ${field}`),
                prologue: fields
                    .map(
                        (field) =>
                            `    validate_rect_area_size(${field}, "${field}");\n`,
                    )
                    .join(""),
                fields: extent
                    .map((field) => `light.${field} = ${field};`)
                    .join(" "),
                after: `${setters}

${this.lowerEmissionAccessor(bump)}
${this.emission ? this.lowerEmission() : ""}
${this.lowerEnable()}

${this.lowerValidateLighting()}`,
            },
        );
    }

    /**
     * The `emissionTexture` accessor: store, and bump the light version on
     * a change. Its non-object refusal has no native counterpart, because
     * the compiler hands it only a processed image or null.
     */
    private lowerEmissionAccessor(bump: string): string {
        const context = this.context;
        const { declaration } = context.functionDeclaration(
            lightModule,
            lightFactory,
        );
        const statements = declaration.body!.statements;
        const start = statements.findIndex(
            (statement) =>
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.some(
                    (variable) =>
                        ts.isIdentifier(variable.name) &&
                        variable.name.text === "emission",
                ),
        );
        if (start < 0)
            return context.contractError(
                declaration,
                "Expected createRectAreaLight to keep `let emission` behind " +
                    "its emissionTexture accessor.",
            );
        context.assertStatementShapes(
            declaration,
            statements.slice(start, start + 2),
            `let emission: Texture2D | null = null;
Object.defineProperty(light, "emissionTexture", {
    enumerable: true,
    get: () => emission,
    set: (next: Texture2D | null) => {
        if (next !== null && typeof next !== "object") {
            throw new Error("RectAreaLight: emissionTexture must be a Texture2D or null");
        }
        if (emission !== next) {
            emission = next;
            lvs.b();
        }
    },
});`,
            "Rect area emissionTexture accessor",
        );
        return `
void set_rect_area_light_emission(Engine& engine, LightHandle light,
                                  std::shared_ptr<const AreaLightImage> image) {
    auto& record = ${recordAt("engine.lights", "light")};
    if (record.emission_texture != image) {
        record.emission_texture = std::move(image);
        ${bump}
    }
}

// A texture processAreaLightTexture did not produce: accepted by the
// accessor, refused when a scene snapshot packs it.
std::shared_ptr<const AreaLightImage> unprocessed_area_light_image() {
    return std::make_shared<const AreaLightImage>();
}
`;
    }

    /**
     * The processed image's native half and the scene snapshot
     * `prepareAreaLightEmission` takes before material composition: one
     * layer per distinct image among the packed lights (the pin keys them
     * by GPU texture, here by image identity), and per packed slot its layer
     * plus one. The packing walk is `snapshot`'s, which is the lights
     * block's own (`for_each_packed_light`).
     */
    private lowerEmission(): string {
        const context = this.context;
        const emissionModule = "src/light/area-light-emission.ts";
        const { declaration: snapshot } = context.functionDeclaration(
            emissionModule,
            "snapshot",
        );
        context.assertFunctionBodyShape(
            snapshot,
            `{ const capacity = MAX_LIGHTS; const lights: LightBase[] = []; const images: (Texture2D | null)[] = []; for (const light of scene.lights) { if (lights.length === capacity) { break; } if (light._writeLightUbo) { lights.push(light); images.push(light.lightType === "rectArea" ? (light as RectAreaLight).emissionTexture : null); } } return { capacity, lights, images }; }`,
            "Area emission scene snapshot",
        );
        const { declaration: prepare } = context.functionDeclaration(
            emissionModule,
            "prepareAreaLightEmission",
        );
        for (const [shape, label] of [
            ["!selected.images.some(Boolean)", "Solid snapshot clears"],
            [
                "new Uint32Array(Math.ceil(selected.capacity / 4) * 4)",
                "Emission slot table",
            ],
            ["validateAreaLightImage(image, device)", "Packed image check"],
            ["layers.get(image.texture)", "Emission layer identity"],
            ["slots[i] = layer + 1", "Emission slot layer"],
            [
                "same(state.allocation.snapshot, selected)",
                "An unchanged selection keeps its allocation",
            ],
        ] as const)
            context.expectShapeCount(prepare, shape, label);
        const unprocessed = stringLiteral(
            rectAreaEmissionRefusalMessage(context, true),
        );
        const shape = pinnedAreaLightImageShape();
        const capacity = pinnedMaxLights(context);
        return `
// ${context.provenance("src/light/process-area-light-texture.ts", "processAreaLightTexture")}
// The packaged chain is read by the backend that uploads it; installing the
// emission seam is what lets enableRectAreaLights accept a texture.
std::shared_ptr<const AreaLightImage> process_area_light_texture(Engine& engine,
                                                                const std::string& path) {
    engine.area_light_emission_installed = true;
    auto image = std::make_shared<AreaLightImage>();
    image->size = ${shape.size}u;
    image->levels = ${shape.levels}u;
    image->path = path;
    return image;
}

namespace {
// ${context.provenance(emissionModule, "prepareAreaLightEmission")}
// A snapshot with no image leaves the scene solid, and one equal to the
// scene's current snapshot -- the same images in the same slots, the pin's
// \`same(state.allocation.snapshot, selected)\` -- keeps it, so each backend
// keeps the allocation built over it. The pin's array-layer limit check is
// unreachable: at most MAX_LIGHTS layers, far below any device's limit.
void prepare_area_light_emission(Scene& scene) {
    auto emission = std::make_shared<AreaLightEmission>();
    emission->slots.assign((${capacity}u + 3u) / 4u * 4u, 0u);
    for_each_packed_light(scene, *scene.engine, ${capacity}u,
                          [&emission](const LightRecord& light, std::size_t slot) {
        if (light.kind != LightKind::rect_area || !light.emission_texture) return;
        // validateAreaLightImage: only processor-produced images.
        if (light.emission_texture->path.empty()) {
            throw std::runtime_error(${unprocessed});
        }
        std::uint32_t layer = 0;
        while (layer < emission->layers.size() &&
               emission->layers[layer] != light.emission_texture) {
            ++layer;
        }
        if (layer == emission->layers.size()) emission->layers.push_back(light.emission_texture);
        emission->slots[slot] = layer + 1u;
    });
    const std::shared_ptr<const AreaLightEmission>& current = scene.state->area_light_emission;
    if (emission->layers.empty()) {
        scene.state->area_light_emission = nullptr;
    } else if (!current || current->layers != emission->layers || current->slots != emission->slots) {
        scene.state->area_light_emission = std::move(emission);
    }
}
} // namespace
`;
    }

    /** `validateSize`, asserted whole and emitted over the pinned message. */
    private lowerValidateSize(): string {
        const { declaration } = this.context.functionDeclaration(
            lightModule,
            "validateSize",
        );
        this.context.assertFunctionBodyShape(
            declaration,
            "{ if (!Number.isFinite(value) || value < 0) { throw new Error(`RectAreaLight: ${name} must be finite and nonnegative, got ${value}`); } }",
            "Rect area size validation",
        );
        const message = pinnedErrorMessageCpp(
            this.context,
            pinnedErrorCode(this.context, declaration),
            [
                { cpp: "std::string(name)" },
                { cpp: "js::number_to_string(value)" },
            ],
        );
        return `void validate_rect_area_size(double value, const char* name) {
    if (!std::isfinite(value) || value < 0) {
        throw std::runtime_error(${message});
    }
}`;
    }

    /**
     * `enableRectAreaLights`'s native half, which its group builders'
     * `_lighting._prepare()` re-runs at every build
     * (`refresh_rect_area_lighting`): the disposed-scene refusal, the
     * unprocessed-texture refusal while no `processAreaLightTexture` has
     * installed the emission seam, the emission snapshot `prepareEmission`
     * takes, and the scene's `_lighting` install. The extension
     * registration and the LTC decode ran at generation; the decoded tables
     * load here.
     */
    private lowerEnable(): string {
        const context = this.context;
        const { declaration } = context.functionDeclaration(
            enableModule,
            "enableRectAreaLights",
        );
        const first = declaration.body?.statements[0];
        if (
            !first ||
            !ts.isIfStatement(first) ||
            !context.expressionMatchesShape(first.expression, "scene._z")
        )
            return context.contractError(
                declaration,
                "Expected enableRectAreaLights to refuse a disposed scene first.",
            );
        const disposed = stringLiteral(
            pinnedErrorMessage(context, pinnedErrorCode(context, first)),
        );
        context.expectShapeCount(
            declaration,
            "scene._lighting = lighting",
            "Scene lighting extension install",
        );
        context.expectShapeCount(
            declaration,
            "current._lighting?._prepare()",
            "Group builders re-run the lighting preparation",
        );
        const unseamed = stringLiteral(
            rectAreaEmissionRefusalMessage(context, false),
        );
        const ltc = pinnedAreaLightLtcShape();
        const capacity = pinnedMaxLights(context);
        const emission = this.emission
            ? "\n    prepare_area_light_emission(scene);"
            : "";
        const nodeLighting = this.nodeLighting.some(Boolean);
        const nodeCheck = nodeLighting
            ? `
// The area extension's \`_validateNode\`, which the pin runs as each node
// group builds: a graph reading the lights block in a scene holding an area
// light refuses rather than shading type 4 as a point light. Indexed by
// node variant (MaterialRecord::shader_variant).
constexpr std::array<bool, ${this.nodeLighting.length}> node_variant_reads_lights{${this.nodeLighting.join(", ")}};

void validate_rect_area_node_lighting(const Scene& scene) {
    const Engine& engine = *scene.engine;
    if (std::none_of(scene.lights.begin(), scene.lights.end(), [&engine](LightHandle handle) {
            const LightRecord* light = handle_find(engine.lights, handle);
            return light && light->kind == LightKind::rect_area;
        })) {
        return;
    }
    for (const MeshHandle handle : scene.meshes) {
        const MeshRecord* mesh = handle_find(engine.meshes, handle);
        const MaterialRecord* material = mesh ? handle_find(engine.materials, mesh->material) : nullptr;
        if (material && material->node_material &&
            material->shader_variant < node_variant_reads_lights.size() &&
            node_variant_reads_lights[material->shader_variant]) {
            throw std::runtime_error(${stringLiteral(rectAreaNodeLightingRefusalMessage(context))});
        }
    }
}
`
            : "";
        return `namespace {
// src/light/area-light-ltc.ts decodeAreaLightLtc output, packaged by
// generation from the pin's own decode of its LTC_URL payload.
std::vector<std::uint8_t> read_area_light_ltc(const std::string& path) {
    std::vector<std::uint8_t> bytes = pal::read_binary_file(path);
    if (bytes.size() != ${ltc.size * ltc.rowBytes}u) {
        throw std::runtime_error("Packaged LTC table '" + path +
            "' is not ${ltc.size}x${ltc.size} at ${ltc.rowBytes} bytes per row.");
    }
    return bytes;
}

void check_rect_area_scene(const Scene& scene) {
    if (scene.disposed) {
        throw std::runtime_error(${disposed});
    }
    // \`if (!prepareEmission)\`: no processAreaLightTexture has run, so a
    // packed light carrying a texture refuses.
    if (!scene.engine->area_light_emission_installed) {
        for_each_packed_light(scene, *scene.engine, ${capacity}u, [](const LightRecord& light, std::size_t) {
            if (light.kind == LightKind::rect_area && light.emission_texture) {
                throw std::runtime_error(${unseamed});
            }
        });
    }
}
${nodeCheck}} // namespace

void enable_rect_area_lights(Scene& scene, const std::string& ltc1, const std::string& ltc2) {
    check_rect_area_scene(scene);
    Engine& engine = *scene.engine;
    if (!engine.area_light_ltc) {
        auto tables = std::make_shared<AreaLightLtcTables>();
        tables->size = ${ltc.size}u;
        tables->row_bytes = ${ltc.rowBytes}u;
        tables->ltc1 = read_area_light_ltc(ltc1);
        tables->ltc2 = read_area_light_ltc(ltc2);
        engine.area_light_ltc = std::move(tables);
    }${emission}
    scene.state->rect_area_lighting = true;
}

void refresh_rect_area_lighting(Scene& scene) {
    if (!scene.state->rect_area_lighting) return;
    check_rect_area_scene(scene);${emission}${nodeLighting ? "\n    validate_rect_area_node_lighting(scene);" : ""}
}`;
    }

    /**
     * The rectangle's `_validateLighting` hook, which `buildScene` runs per
     * light (`validate_scene_lighting`): a shadow generator refuses first,
     * then a scene with no area extension.
     */
    private lowerValidateLighting(): string {
        const context = this.context;
        const hook = context.propertyFunction(
            lightModule,
            lightFactory,
            "_validateLighting",
        ).declaration;
        const body = hook.body;
        if (!body || !ts.isBlock(body))
            return context.contractError(
                hook,
                "Expected the rect area _validateLighting hook to have a block body.",
            );
        context.assertStatementShapes(
            hook,
            body.statements,
            'if (light.shadowGenerator) { throw new Error("RectAreaLight: area-light shadows are not supported yet"); } if (!extension?._single?.("rectArea")) { throw new Error("RectAreaLight: await enableRectAreaLights(scene) before registering this scene"); }',
            "Rect area lighting validation",
        );
        // The shape above fixes the two guards, in this order.
        const [shadow, enabled] = [0, 1].map((index) =>
            stringLiteral(
                pinnedErrorMessage(
                    context,
                    pinnedErrorCode(context, body.statements[index]!),
                ),
            ),
        );
        return `void validate_rect_area_light_lighting(const Scene& scene, const LightRecord& light) {
    if (light.shadow_generator.value != invalid_handle) {
        throw std::runtime_error(${shadow});
    }
    if (!scene.state->rect_area_lighting) {
        throw std::runtime_error(${enabled});
    }
}`;
    }
}
