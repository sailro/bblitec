import ts from "typescript";
import {
    addressModeByPin,
    textureFilterByPin,
} from "../../pinned-address-modes.js";
import { LoweredSource } from "../context.js";
import { MeshBuilderLowerer } from "./mesh-builders.js";

/**
 * Which arms of the Standard material's texture slots a scene reached.
 *
 * One slot takes several sources — `diffuseTexture` alone is written from a
 * colour render target, a pixels texture and a loaded image — so the setters
 * are emitted per reached source rather than per slot, and the flags travel
 * named because six positional booleans read as an accident.
 */
export interface StandardTextureSetters {
    diffuse: boolean;
    emissive: boolean;
    pixels: boolean;
    diffuseFile: boolean;
    emissiveFile: boolean;
    uvTransform: boolean;
}


/**
 * The material/texture half of the factory unit, completing the class:
 * node, shader, PBR, grid and Standard material factories plus the
 * pixels/file texture factories and the Standard texture setters.
 */
export class FactoryLowerer extends MeshBuilderLowerer {
    public lowerNodeMaterialFactory(): LoweredSource {
        const modulePath = "src/material/node/node-material.ts";
        const { declaration } = this.context.functionDeclaration(
            modulePath,
            "parseNodeMaterialFromSnippet",
        );
        // The record the pin returns. Everything on it except the family tag
        // and the alpha-blending flag is compiled away — the WGSL, the UBO
        // layout and the bindings are composition's output, and the `inputs`
        // handles that would mutate the block are not lowered — so the two
        // that survive are the two asserted here.
        const material = this.context.objectInitializer(
            declaration,
            "material",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(material, "_needsAlphaBlending"),
            "graph.needsAlphaBlending",
            "NodeMaterial alpha blending",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(material, "_buildGroup"),
            "_buildGroup",
            "NodeMaterial mesh group builder",
        );
        return {
            modulePath,
            symbolName: "parseNodeMaterialFromSnippet",
            header: "",
            source: `// ${
                this.context.provenance(
                    modulePath,
                    "parseNodeMaterialFromSnippet",
                )
            }
#include <bblite/runtime.hpp>
#include <bblite/upstream/node_variants.hpp>

#include <algorithm>
#include <stdexcept>
#include <string>
#include <utility>

namespace bbl {

// The graph was compiled at generation by the pin's own emitter and
// pipeline builder; what remains at run time is which composed program a
// draw uses, and the fixed-function state that program was built with.
MaterialHandle create_node_material(
    Engine& engine,
    std::uint32_t variant,
    std::vector<NodeMaterialTexture> textures) {
    const upstream::NodeVariantEntry& entry =
        upstream::node_variants.at(variant);
    MaterialRecord material;
    material.node_material = true;
    material.shader_variant = variant;
    material.double_sided = !entry.back_face_culling;
    // The graph's declared bindings, in the pin's own allocation order,
    // resolved by name against what the scene supplied -- the join
    // parseNodeMaterialFromSnippet performs when it fills _textureSlots.
    // A binding the record omits is the pin's own render-time error, raised
    // here at material creation instead.
    for (std::size_t index = 0; index < entry.texture_count; ++index) {
        const upstream::NodeVariantTexture& binding =
            upstream::node_variant_textures.at(entry.first_texture + index);
        const auto supplied = std::find_if(
            textures.begin(),
            textures.end(),
            [&](const NodeMaterialTexture& candidate) {
                return candidate.name == binding.name;
            });
        if (supplied == textures.end()) {
            throw std::runtime_error(
                "NodeMaterial: texture binding '" +
                std::string(binding.name) +
                "' not set. Provide it via options.textures.");
        }
        material.shader_textures.push_back(std::move(supplied->texture));
    }
    engine.materials.push_back(std::move(material));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerShaderMaterialFactory(): LoweredSource {
        const modulePath = "src/material/shader/shader-material.ts";
        const { declaration } =
            this.context.functionDeclaration(
                modulePath,
                "createShaderMaterial",
            );
        const isNullishDefault = (
            expression: ts.Expression,
            leftPath: string,
            fallback: (value: ts.Expression) => boolean,
        ): boolean => {
            const unwrapped =
                this.context.unwrapExpression(expression);
            return (
                ts.isBinaryExpression(unwrapped) &&
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                this.context
                    .propertyPath(unwrapped.left)
                    ?.join(".") === leftPath &&
                fallback(unwrapped.right)
            );
        };
        const needAlphaBlending =
            this.context.variableInitializer(
                declaration,
                "needAlphaBlending",
            );
        if (
            !isNullishDefault(
                needAlphaBlending,
                "options.needAlphaBlending",
                (fallback) =>
                    ts.isPrefixUnaryExpression(fallback) &&
                    fallback.operator ===
                        ts.SyntaxKind.ExclamationToken &&
                    ts.isPrefixUnaryExpression(
                        fallback.operand,
                    ) &&
                    fallback.operand.operator ===
                        ts.SyntaxKind.ExclamationToken &&
                    this.context
                        .propertyPath(
                            fallback.operand.operand,
                        )
                        ?.join(".") === "options.blend",
            )
        ) {
            this.context.contractError(
                needAlphaBlending,
                "Expected alpha blending to fall back to the blend state.",
            );
        }
        const returned = this.context.returnObject(declaration);
        for (const contract of [
            {
                property: "needAlphaTesting",
                path: "options.needAlphaTesting",
                fallback: (value: ts.Expression): boolean =>
                    value.kind ===
                    ts.SyntaxKind.FalseKeyword,
            },
            {
                property: "backFaceCulling",
                path: "options.backFaceCulling",
                fallback: (value: ts.Expression): boolean =>
                    value.kind === ts.SyntaxKind.TrueKeyword,
            },
            {
                property: "depthWrite",
                path: "options.depthWrite",
                fallback: (value: ts.Expression): boolean =>
                    ts.isPrefixUnaryExpression(value) &&
                    value.operator ===
                        ts.SyntaxKind.ExclamationToken &&
                    ts.isIdentifier(value.operand) &&
                    value.operand.text ===
                        "needAlphaBlending",
            },
        ]) {
            const expression =
                this.context.propertyInitializer(
                    returned,
                    contract.property,
                );
            if (
                !isNullishDefault(
                    expression,
                    contract.path,
                    contract.fallback,
                )
            ) {
                this.context.contractError(
                    expression,
                    `Unexpected '${contract.property}' default.`,
                );
            }
        }
        return {
            modulePath,
            symbolName:
                "createShaderMaterial,setShaderUniform,setShaderFloat,setShaderVector3,setShaderTexture,setAlphaToCoverage",
            header: "",
            source: `// ${this.context.provenance(modulePath, "createShaderMaterial")}
#include <bblite/runtime.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <algorithm>
#include <stdexcept>

namespace bbl {

// The generated shader-variant table carries the pinned fixed-function
// mapping (needAlphaBlending -> blend alpha mode, backFaceCulling ->
// double-sided, needAlphaTesting, depthWrite) and the reflected uniform
// layout with the createShaderMaterial defaultValue floats.
MaterialHandle create_shader_material(
    Engine& engine,
    std::uint32_t variant) {
    const upstream::ShaderVariantInfo& info =
        upstream::shader_variant_info(variant);
    MaterialRecord material;
    material.shader_material = true;
    material.shader_variant = variant;
    material.double_sided = !info.back_face_culling;
    material.shader_alpha_testing = info.alpha_testing;
    material.shader_depth_write = info.depth_write;
    if (info.alpha_blending) {
        material.alpha_mode = MaterialAlphaMode::blend;
    }
    material.shader_uniform_values = info.defaults;
    material.shader_uniform_values.resize(info.value_count, 0.0f);
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

MaterialRecord& shader_material(Engine& engine, MaterialHandle handle) {
    if (handle.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid shader material handle.");
    }
    MaterialRecord& material = engine.materials[handle.value];
    if (!material.shader_material) {
        throw std::runtime_error("Material is not a shader material.");
    }
    return material;
}

// Offset setter shared by setShaderUniform/setShaderFloat/
// setShaderVector3: the compiler resolves (variant, uniform name) to the
// flat value offset through the reflected layout at compile time.
void set_shader_uniform_values(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    std::uint32_t count,
    const float* values) {
    MaterialRecord& record = shader_material(engine, material);
    if (offset + count > record.shader_uniform_values.size()) {
        throw std::runtime_error("Shader uniform write out of range.");
    }
    std::copy_n(
        values,
        count,
        record.shader_uniform_values.begin() + offset);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0) {
    const float values[1] = {v0};
    set_shader_uniform_values(engine, material, offset, 1u, values);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1) {
    const float values[2] = {v0, v1};
    set_shader_uniform_values(engine, material, offset, 2u, values);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2) {
    const float values[3] = {v0, v1, v2};
    set_shader_uniform_values(engine, material, offset, 3u, values);
}

void set_shader_uniform_value(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t offset,
    float v0,
    float v1,
    float v2,
    float v3) {
    const float values[4] = {v0, v1, v2, v3};
    set_shader_uniform_values(engine, material, offset, 4u, values);
}

// setShaderTexture: the pin stores the Texture2D on the slot the sampler
// name owns and bumps _resourceVersion so the group-1 bind group rebuilds.
// The compiler resolved the name to that slot; the version has no native
// counterpart because a reached scene binds before registration, so the
// bind group is built once from what the record holds.
void set_shader_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    FileTexture texture) {
    MaterialRecord& record = shader_material(engine, material);
    if (record.shader_textures.size() <= slot) {
        record.shader_textures.resize(slot + 1);
    }
    record.shader_textures[slot] = std::move(texture);
}

void set_alpha_to_coverage(
    Engine& engine,
    MaterialHandle material,
    bool enabled) {
    shader_material(engine, material).alpha_to_coverage = enabled;
}

} // namespace bbl
`,
        };
    }

    /**
     * `pixels-texture.ts`: a texture the caller hands its own RGBA bytes.
     *
     * The bytes are baked, so what is lowered is the rest of the pin's
     * factory — the two size checks and the sampler, whose four fields the
     * caller may override and whose defaults are read off the pin's own
     * `?? "…"` rather than restated. A call naming none of them emits the
     * same text it always did, because the defaults ride the signature.
     */
    public lowerPixelsTextureFactory(): LoweredSource {
        const module = "src/texture/pixels-texture.ts";
        const { declaration } =
            this.context.functionDeclaration(
                module,
                "createTexture2DFromPixels",
            );
        // The sampler the pin settles when the caller overrides nothing,
        // which is every reached call. Each field is checked as the pin
        // writes it and then emitted through the shared name-to-enumerator
        // tables, so the default and the enumerator cannot drift apart and a
        // mode with no row fails generation naming it.
        const sampler = this.context.variableInitializer(
            declaration,
            "samplerDesc",
        );
        if (!ts.isObjectLiteralExpression(sampler)) {
            this.context.contractError(
                sampler,
                "Expected the pinned pixels-texture sampler literal.",
            );
        }
        const samplerDefault = (
            name: string,
            fallback: string,
            table: Readonly<Record<string, string>>,
        ): string => {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(sampler, name),
                `options.${name} ?? "${fallback}"`,
                `createTexture2DFromPixels ${name}`,
            );
            const enumerator = table[fallback];
            if (!enumerator) {
                this.context.contractError(
                    sampler,
                    `Pinned createTexture2DFromPixels defaults ${name} to '${fallback}', which has no runtime enumerator.`,
                );
            }
            return enumerator;
        };
        const addressU = samplerDefault(
            "addressModeU",
            "clamp-to-edge",
            addressModeByPin,
        );
        const addressV = samplerDefault(
            "addressModeV",
            "clamp-to-edge",
            addressModeByPin,
        );
        const minFilter = samplerDefault(
            "minFilter",
            "nearest",
            textureFilterByPin,
        );
        const magFilter = samplerDefault(
            "magFilter",
            "nearest",
            textureFilterByPin,
        );
        // The byte count the pin requires, which the baked buffer has to
        // meet for the same reason it does upstream.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "expected",
            ),
            "width * height * 4",
            "createTexture2DFromPixels expected byte count",
        );
        return {
            modulePath: module,
            symbolName: "createTexture2DFromPixels",
            header: "",
            source: `// ${this.context.provenance(module, "createTexture2DFromPixels")}
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>

#include <stdexcept>
#include <string>

namespace bbl {

PixelsTexture create_texture_2d_from_pixels(
    Engine&,
    const std::string& path,
    double width,
    double height,
    PixelsTextureOptions options) {
    if (width < 1.0 || height < 1.0) {
        throw std::runtime_error(
            "createTexture2DFromPixels: width/height must be >= 1");
    }
    PixelsTexture texture;
    texture.rgba = pal::read_binary_file(path);
    texture.width = static_cast<std::uint32_t>(width);
    texture.height = static_cast<std::uint32_t>(height);
    const std::size_t expected =
        static_cast<std::size_t>(texture.width) *
        static_cast<std::size_t>(texture.height) * 4u;
    if (texture.rgba.size() < expected) {
        throw std::runtime_error(
            "createTexture2DFromPixels: data too short for " +
            std::to_string(texture.width) + "x" +
            std::to_string(texture.height) + " RGBA");
    }
    // The pin resolves each override against its own default here, in the
    // factory, which is why the defaults are read above rather than restated
    // and why the caller passes only what it named. It creates no mip chain,
    // so mip sampling clamps to the base level.
    texture.sampler.min_filter =
        options.has_min_filter ? options.min_filter : ${minFilter};
    texture.sampler.mag_filter =
        options.has_mag_filter ? options.mag_filter : ${magFilter};
    texture.sampler.mipmap_mode = TextureMipmapMode::nearest;
    texture.sampler.address_u =
        options.has_address_u ? options.address_u : ${addressU};
    texture.sampler.address_v =
        options.has_address_v ? options.address_v : ${addressV};
    texture.sampler.max_anisotropy = 1.0f;
    texture.sampler.max_lod = 0.0f;
    return texture;
}

} // namespace bbl
`,
        };
    }

    /**
     * The two scene-code Texture2D sources, in a translation unit of their
     * own.
     *
     * They live in the pin's own `src/texture/` rather than in any material
     * module, and a scene can reach them without reaching PBR at all -- a
     * custom shader material binding a loaded image is the case. Bundling
     * them into the PBR factory made `loadTexture2D` an undefined symbol
     * for such a scene, which is upstream's boundary expressed wrongly
     * here; `texture_pixels.cpp` already carries the third source this way.
     */
    public lowerFileTextureFactory(): LoweredSource {
        const solidModule = "src/texture/solid-texture.ts";
        const textureModule = "src/texture/texture-2d.ts";
        const { declaration: createSolidTexture } =
            this.context.functionDeclaration(
                solidModule,
                "createSolidTexture2D",
            );
        const quantizedChannels = this.context.countNodes(
            createSolidTexture,
            (node) =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                ts.isIdentifier(
                    node.expression.expression,
                ) &&
                node.expression.expression.text === "Math" &&
                node.expression.name.text === "round" &&
                node.arguments.length === 1 &&
                ts.isBinaryExpression(node.arguments[0]!) &&
                node.arguments[0].operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                ts.isNumericLiteral(
                    node.arguments[0].right,
                ) &&
                Number(node.arguments[0].right.text) === 255,
        );
        if (quantizedChannels !== 4) {
            this.context.contractError(
                createSolidTexture,
                `Expected four 8-bit quantized channels, found ${quantizedChannels}.`,
            );
        }
        if (
            !this.context.hasNode(
                createSolidTexture,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    this.context.propertyName(node.name) ===
                        "format" &&
                    ts.isStringLiteral(node.initializer) &&
                    node.initializer.text === "rgba8unorm",
            )
        ) {
            this.context.contractError(
                createSolidTexture,
                "Expected rgba8unorm solid textures.",
            );
        }
        this.context.functionDeclaration(textureModule, "loadTexture2D");
        // `loadTexture2D` is the memoizing wrapper; the upload and the
        // sampler it builds live in the impl it defers to.
        const loadTexture = this.context.functionDeclaration(
            textureModule,
            "loadTexture2DImpl",
        ).declaration;
        // The sampler's anisotropy is the one pinned default that is a rule
        // rather than a constant: the intrinsic restates it beside the other
        // defaults, so the shape it restates is asserted here. A pin that
        // changes either arm, or the condition it forks on, refuses
        // generation instead of shading through a different filter.
        const anisotropy = this.context.findNodes(
            loadTexture,
            (node): node is ts.PropertyAssignment =>
                ts.isPropertyAssignment(node) &&
                this.context.propertyName(node.name) === "maxAnisotropy",
        )[0];
        if (!anisotropy) {
            this.context.contractError(
                loadTexture,
                "Pinned loadTexture2DImpl no longer sets maxAnisotropy.",
            );
        }
        this.context.assertExpressionShape(
            anisotropy.initializer,
            "allLinear ? 4 : 1",
            "loadTexture2D sampler anisotropy",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(loadTexture, "allLinear"),
            'minF === "linear" && magF === "linear" && mipF === "linear"',
            "loadTexture2D all-linear test",
        );
        return {
            modulePath: textureModule,
            symbolName: "loadTexture2D,createSolidTexture2D",
            header: "",
            source: `// ${this.context.provenance(
                textureModule,
                "loadTexture2D",
                `${solidModule}#createSolidTexture2D`,
            )}
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>

#include <algorithm>
#include <cmath>

namespace bbl {

// src/texture/texture-2d.ts loadTexture2D: the encoded image bytes load at
// startup (the compiler materialized the asset), and the sampler mirrors the
// pinned defaults (linear filters, repeat addressing, invertY true, srgb
// false; mip sampling clamps to the base level when mipMaps is false).
FileTexture load_file_texture(
    Engine&,
    const std::string& path,
    TextureSamplerState sampler,
    bool invert_y,
    bool srgb) {
    FileTexture texture;
    texture.data.bytes = pal::read_binary_file(path);
    texture.data.sampler = sampler;
    texture.data.invert_y = invert_y;
    texture.srgb = srgb;
    return texture;
}

SolidTexture create_solid_texture(
    Engine&,
    float r,
    float g,
    float b,
    float a) {
    // The pin's own rounding, performed once. The texel is what reaches the
    // GPU; the float view is that same byte over 255, because a slot that
    // bakes the texture into a fallback and a slot that uploads it must not
    // disagree about the value.
    const auto quantize = [](float value) {
        return static_cast<std::uint8_t>(
            std::lround(std::clamp(value, 0.0f, 1.0f) * 255.0f));
    };
    SolidTexture texture;
    texture.texel = {quantize(r), quantize(g), quantize(b), quantize(a)};
    texture.color = Color4{
        static_cast<float>(texture.texel[0]) / 255.0f,
        static_cast<float>(texture.texel[1]) / 255.0f,
        static_cast<float>(texture.texel[2]) / 255.0f,
        static_cast<float>(texture.texel[3]) / 255.0f,
    };
    return texture;
}

} // namespace bbl
`,
        };
    }

    public lowerPbrMaterialFactory(): LoweredSource {
        const pbrModule = "src/material/pbr/pbr-material.ts";
        // The opt-in setters replaced the unlit/skyboxMode options. Each is
        // one stamp plus an unconditional extension registration, and the
        // stamped field name is what `composeScenePbrVariants` hands the
        // pinned composer: a renamed one would compose a fragment missing
        // that arm rather than failing, so every stamp is pinned by shape.
        // The `isEnabled` guards stay where the pin keeps them, in the UBO
        // writers.
        for (const [module, symbol, stamp] of [
            ["set-unlit.ts", "setPbrUnlit", "mat._unlit = true"],
            ["set-skybox.ts", "setPbrSkybox", "mat._skyboxMode = true"],
            ["set-emissive.ts", "setPbrEmissive", "mat._emissiveColor = color"],
            ["set-sheen.ts", "setPbrSheen", "mat._sheen = sheen"],
            [
                "set-clearcoat.ts",
                "setPbrClearCoat",
                "mat._clearCoat = clearCoat",
            ],
            [
                "set-iridescence.ts",
                "setPbrIridescence",
                "mat._iridescence = iridescence",
            ],
        ] as const) {
            const { declaration } = this.context.functionDeclaration(
                `src/material/pbr/${module}`,
                symbol,
            );
            // `setPbrUnlit`'s optional tint is a second assignment, so the
            // stamp is located by its own left-hand path rather than by
            // being the only one.
            const target = stamp.slice(0, stamp.indexOf(" "));
            const stamps = this.context
                .findNodes(
                    declaration,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken,
                )
                .filter(
                    (node) =>
                        this.context
                            .propertyPath(node.left)
                            ?.join(".") === target,
                );
            if (stamps.length !== 1) {
                this.context.contractError(
                    declaration,
                    `Expected ${symbol} to stamp ${stamp}.`,
                );
            }
            this.context.assertExpressionShape(stamps[0]!, stamp, symbol);
        }
        const { declaration: createPbrMaterial } =
            this.context.functionDeclaration(
                pbrModule,
                "createPbrMaterial",
            );
        const returned =
            this.context.returnObject(createPbrMaterial);
        if (
            !returned.properties.some(
                (property) =>
                    ts.isSpreadAssignment(property) &&
                    ts.isIdentifier(property.expression) &&
                    property.expression.text === "props",
            )
        ) {
            this.context.contractError(
                returned,
                "Expected PBR props to be preserved.",
            );
        }
        const uboVersion = this.context.propertyInitializer(
            returned,
            "_uboVersion",
        );
        if (
            !ts.isNumericLiteral(uboVersion) ||
            Number(uboVersion.text) !== 0
        ) {
            this.context.contractError(
                uboVersion,
                "Expected initial PBR UBO version 0.",
            );
        }
        return {
            modulePath: pbrModule,
            symbolName: "createPbrMaterial,setPbrUnlit,setPbrSkybox,setPbrEmissive,setPbrIridescence,setPbrMetallicReflectance,setPbrSubsurface",
            header: "",
            source: `// ${this.context.provenance(pbrModule, "createPbrMaterial")}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <utility>

namespace bbl {

// Attaches a loaded base-color image to a created PBR material. The slot's
// encoding travels with the image, because upstream keeps the format on the
// Texture2D its caller loaded: loadTexture2D's own srgb option picked
// rgba8unorm-srgb or plain rgba8unorm, and a material that decodes the
// albedo in its own fragment (setPbrGammaAlbedo) loads the second.
void set_material_base_color_file(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture) {
    MaterialRecord& record = engine.materials[material.value];
    record.base_color_srgb = texture.srgb;
    record.base_color_texture = std::move(texture.data);
}

// src/material/pbr/set-unlit.ts and set-skybox.ts: the optional PBR
// features are opt-in setters that flag an existing material and
// register their fragment extension.
void set_pbr_unlit(Engine& engine, MaterialHandle material) {
    engine.materials[material.value].unlit = true;
}

void set_pbr_emissive(
    Engine& engine,
    MaterialHandle material,
    Color3 color) {
    engine.materials[material.value].emissive_factor = color;
}

// set-metallic-reflectance.ts conditionally copies the supplied fields and
// always registers the reflectance fragment. Registration is represented in
// the scene-material manifest; the native record holds the fields its pinned
// UBO writer and texture bindings read.
void set_pbr_metallic_reflectance(
    Engine& engine,
    MaterialHandle material,
    bool has_color,
    Color3 color,
    FileTexture metallic_texture,
    FileTexture reflectance_texture) {
    MaterialRecord& record = engine.materials[material.value];
    record.has_metallic_reflectance = true;
    if (has_color) {
        record.metallic_reflectance_color = color;
    }
    if (metallic_texture.data.has_image()) {
        record.metallic_reflectance_texture =
            std::move(metallic_texture.data);
    }
    if (reflectance_texture.data.has_image()) {
        record.reflectance_texture =
            std::move(reflectance_texture.data);
    }
}

// set-subsurface.ts assigns the nested record and registers its fragment.
// This reached slice carries the scalar translucency inputs and the one
// linear thickness map Scene 26 supplies.
void set_pbr_subsurface(
    Engine& engine,
    MaterialHandle material,
    float intensity,
    Color3 color,
    Color3 diffusion_distance,
    float minimum_thickness,
    float maximum_thickness,
    FileTexture thickness_texture) {
    MaterialRecord& record = engine.materials[material.value];
    record.has_subsurface = true;
    record.subsurface_intensity = intensity;
    record.subsurface_color = color;
    record.subsurface_diffusion_distance = diffusion_distance;
    record.subsurface_minimum_thickness = minimum_thickness;
    record.subsurface_maximum_thickness = maximum_thickness;
    if (thickness_texture.data.has_image()) {
        record.thickness_texture = std::move(thickness_texture.data);
    }
}

void set_pbr_skybox(Engine& engine, MaterialHandle material) {
    engine.materials[material.value].skybox_mode = true;
}

// src/material/pbr/fragments/clearcoat-fragment.ts#writeClearcoatUBO leaves
// the whole clearcoat slice at zero unless isEnabled is set, so a disabled
// coat keeps the record's zero intensity and shades as no coat at all.
// The pinned defaults live in the same writer: intensity 1, roughness 0,
// index of refraction 1.5, normal scale 1.
// src/material/pbr/fragments/sheen-fragment.ts#writeSheenUBO: a disabled
// sheen writes no slice, and the record's zero sheen color shades as none.
// The pinned defaults are colour [1,1,1], roughness 0, intensity 1.
void set_pbr_sheen(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    Color3 color,
    float roughness,
    float intensity) {
    if (!enabled) {
        return;
    }
    MaterialRecord& record = engine.materials[material.value];
    record.sheen_color = color;
    record.sheen_roughness = roughness;
    record.sheen_intensity = intensity;
}

// The sheen tint texture modulates the colour. It is applied whether or not
// the layer is enabled, matching the pin, where the props object carries the
// texture and the UBO writer is what consults isEnabled.
void set_pbr_sheen_texture(
    Engine& engine,
    MaterialHandle material,
    FileTexture texture) {
    engine.materials[material.value].sheen_color_texture =
        std::move(texture.data);
}

void set_pbr_clearcoat(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float roughness,
    float index_of_refraction,
    float normal_scale) {
    if (!enabled) {
        return;
    }
    MaterialRecord& record = engine.materials[material.value];
    record.clearcoat_intensity = intensity;
    record.clearcoat_roughness = roughness;
    record.clearcoat_index_of_refraction = index_of_refraction;
    record.clearcoat_normal_scale = normal_scale;
}

// src/material/pbr/fragments/iridescence-fragment.ts#writeIridescenceUBO:
// a disabled layer writes no slice, and the record's zero intensity shades
// as none. The pinned defaults are in the same writer -- intensity 1, index
// of refraction 1.3, thickness 100..400 nm -- and the compiler resolved
// them at the call site, so the values arrive already defaulted.
void set_pbr_iridescence(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    float index_of_refraction,
    float minimum_thickness,
    float maximum_thickness) {
    if (!enabled) {
        return;
    }
    MaterialRecord& record = engine.materials[material.value];
    record.iridescence_intensity = intensity;
    record.iridescence_index_of_refraction = index_of_refraction;
    record.iridescence_minimum_thickness = minimum_thickness;
    record.iridescence_maximum_thickness = maximum_thickness;
}

// src/material/pbr/fragments/anisotropy-fragment.ts#pbrExt.writeUbo: the
// isEnabled guard is the writer's own, so a disabled layer writes no slice
// and the record keeps the pin's defaults. Those defaults -- an intensity
// of one and a [1, 0] direction -- are that same writer's own nullish
// arms, resolved at the call site.
void set_pbr_anisotropy(
    Engine& engine,
    MaterialHandle material,
    bool enabled,
    float intensity,
    Vec2 direction) {
    if (!enabled) {
        return;
    }
    MaterialRecord& record = engine.materials[material.value];
    record.has_anisotropy = true;
    record.anisotropy_intensity = intensity;
    record.anisotropy_direction = direction;
}

MaterialHandle create_pbr_material(
    Engine& engine,
    PbrMaterialOptions options) {
    MaterialRecord material;
    // The pin's createPbrMaterial is {...props}: a solid texture IS the
    // texture -- createSolidTexture2D writes the rounded texel into a 1x1
    // rgba8unorm sampled without decode -- and the factors stay the options'
    // values. The texels ride the slots' fallback bytes; folding them into
    // the factors would double-apply against the composed fragment, which
    // samples the slot and declares no factor field for them.
    material.base_color_fallback = options.base_color.texel;
    material.base_color_srgb = false;
    material.orm_fallback = options.orm.texel;
    material.base_color_factor = {1.0f, 1.0f, 1.0f, 1.0f};
    material.roughness_factor = options.roughness_factor;
    material.metallic_factor = options.metallic_factor;
    material.direct_intensity = options.direct_intensity;
    material.environment_intensity = options.environment_intensity;
    material.base_color_factor.a = options.alpha;
    material.reflectance = options.reflectance;
    material.unlit = options.unlit;
    material.double_sided = options.double_sided;
    material.specular_aa = options.specular_aa;
    material.skybox_mode = options.skybox_mode;
    material.transmission_factor = options.transmission_factor;
    material.index_of_refraction = options.index_of_refraction;
    material.thickness = options.thickness;
    material.use_thickness_as_depth = options.use_thickness_as_depth;
    material.attenuation_color = options.attenuation_color;
    material.attenuation_distance = options.attenuation_distance;
    material.occlusion_strength = options.occlusion_strength;
    material.use_physical_light_falloff = options.use_physical_light_falloff;
    material.metallic_f0_factor = options.metallic_f0_factor;
    material.specular_weight = options.metallic_f0_factor;
    material.has_ior = false;
    material.has_volume = options.has_volume;
    derive_material_alpha_mode(material);
    material.has_occlusion_texture = true;
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerGridMaterialFactory(): LoweredSource {
        const modulePath = "src/material/grid/grid-material.ts";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                "createGridMaterial",
            );
        for (const [name, path, expected] of [
            [
                "mainColor",
                "options.mainColor",
                [0, 0, 0],
            ],
            [
                "lineColor",
                "options.lineColor",
                [0, 0.5, 0.5],
            ],
        ] as const) {
            const initializer =
                this.context.unwrapExpression(
                    this.context.variableInitializer(
                        declaration,
                        name,
                    ),
                );
            if (
                !ts.isBinaryExpression(initializer) ||
                initializer.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken ||
                this.context
                    .propertyPath(initializer.left)
                    ?.join(".") !== path
            ) {
                this.context.contractError(
                    initializer,
                    `Unexpected '${name}' default expression.`,
                );
            }
            const values = this.context.numericTuple(
                initializer.right,
                file,
            );
            if (
                values.some(
                    (value, index) =>
                        value !== expected[index],
                )
            ) {
                this.context.contractError(
                    initializer.right,
                    `Unexpected '${name}' default value.`,
                );
            }
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "gridControl",
            ),
            "[gridRatio, Math.round(majorUnitFrequency), minorUnitVisibility, opacity]",
            "GridMaterial control vector",
        );
        const transparent = this.context.unwrapExpression(
            this.context.variableInitializer(
                declaration,
                "transparent",
            ),
        );
        if (
            !ts.isBinaryExpression(transparent) ||
            transparent.operatorToken.kind !==
                ts.SyntaxKind.LessThanToken ||
            !ts.isIdentifier(transparent.left) ||
            transparent.left.text !== "opacity" ||
            !ts.isNumericLiteral(transparent.right) ||
            Number(transparent.right.text) !== 1
        ) {
            this.context.contractError(
                transparent,
                "Expected opacity below one to select transparency.",
            );
        }
        const shaderOptions =
            this.context.callObjectArgument(
                declaration,
                "createShaderMaterial",
            );
        const alphaBlending =
            this.context.propertyInitializer(
                shaderOptions,
                "needAlphaBlending",
            );
        if (
            !ts.isBinaryExpression(alphaBlending) ||
            alphaBlending.operatorToken.kind !==
                ts.SyntaxKind.BarBarToken ||
            !ts.isIdentifier(alphaBlending.left) ||
            alphaBlending.left.text !== "transparent" ||
            !ts.isIdentifier(alphaBlending.right) ||
            alphaBlending.right.text !== "hasOpacity"
        ) {
            this.context.contractError(
                alphaBlending,
                "Expected opacity state to control alpha blending.",
            );
        }
        const backFaceCulling =
            this.context.propertyInitializer(
                shaderOptions,
                "backFaceCulling",
            );
        if (
            !ts.isIdentifier(backFaceCulling) ||
            backFaceCulling.text !== "backFaceCulling"
        ) {
            this.context.contractError(
                backFaceCulling,
                "Expected GridMaterial culling passthrough.",
            );
        }
        return {
            modulePath,
            symbolName: "createGridMaterial",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createGridMaterial",
            )}
#include <bblite/runtime.hpp>

#include <cmath>

namespace bbl {

MaterialHandle create_grid_material(
    Engine& engine,
    GridMaterialOptions options) {
    MaterialRecord material;
    material.grid_material = true;
    material.grid_main_color = options.main_color;
    material.grid_line_color = options.line_color;
    material.grid_control = Vec4{
        options.grid_ratio,
        std::round(options.major_unit_frequency),
        options.minor_unit_visibility,
        options.opacity,
    };
    material.grid_offset = options.grid_offset;
    material.grid_visibility = options.visibility;
    material.grid_antialias = options.antialias;
    material.grid_pre_multiply_alpha =
        options.pre_multiply_alpha;
    material.grid_use_max_line = options.use_max_line;
    material.alpha_mode =
        options.opacity < 1.0f
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
    material.double_sided = !options.back_face_culling;
    engine.materials.push_back(material);
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    /**
     * The two Standard texture slots a frame-graph attachment can fill.
     *
     * They are one lowering because they are one shape: store the
     * reference, raise the flag. Each is gated on the feature named after
     * it, so a scene reaching neither compiles neither -- which is what
     * kept them apart before, in the Standard factory and the no-colour
     * view TU, neither of which is named for them.
     */
    public lowerStandardTextureSetters(
        reached: StandardTextureSetters,
    ): LoweredSource {
        const {
            diffuse,
            emissive,
            pixels,
            diffuseFile,
            emissiveFile,
            uvTransform,
        } = reached;
        // The material module that owns `diffuseTexture` -- the property
        // every arm below writes. `rtt.ts` is where only ONE of the sources
        // comes from, so naming it here attributed the pixels setter and the
        // enabler to a module that contains neither.
        const materialModule = "src/material/standard/standard-material.ts";
        if (uvTransform) {
            // The pin's enabler is a mark plus a lazy module preload; the
            // preload has no native counterpart, so the assignment is the
            // whole of it and its shape is asserted before it is restated
            // as a record write.
            const marks = this.context
                .functionDeclaration(
                    "src/material/enable-material-uv-transform.ts",
                    "enableMaterialUvTransform",
                )
                .declaration.body!.statements.filter((statement) =>
                    ts.isExpressionStatement(statement),
                );
            if (marks.length !== 1) {
                throw new Error(
                    "Pinned enableMaterialUvTransform no longer marks the " +
                        "material with exactly one statement.",
                );
            }
            this.context.assertExpressionShape(
                marks[0]!.expression,
                "std._hasUvTx = true",
                "enableMaterialUvTransform mark",
            );
        }
        return {
            modulePath: materialModule,
            symbolName: [
                ...(diffuse ? ["material.diffuseTexture"] : []),
                ...(emissive ? ["setStandardEmissiveTexture"] : []),
                ...(pixels ? ["material.diffuseTexture#pixels"] : []),
                ...(diffuseFile ? ["material.diffuseTexture#file"] : []),
                ...(emissiveFile
                    ? ["setStandardEmissiveTexture#file"]
                    : []),
                ...(uvTransform ? ["enableMaterialUvTransform"] : []),
            ].join(","),
            header: "",
            source: `// ${this.context.provenance(
                materialModule,
                "diffuseTexture",
                [
                    ...(diffuse || emissive
                        ? ["src/texture/rtt.ts#createRenderTargetTexture"]
                        : []),
                    ...(emissive
                        ? [
                            "src/material/standard/set-std-emissive.ts" +
                            "#setStandardEmissiveTexture",
                        ]
                        : []),
                    ...(pixels
                        ? ["src/texture/pixels-texture.ts"]
                        : []),
                    ...(diffuseFile || emissiveFile
                        ? ["src/texture/texture-2d.ts"]
                        : []),
                    ...(uvTransform
                        ? [
                            "src/material/enable-material-uv-transform.ts" +
                            "#enableMaterialUvTransform",
                        ]
                        : []),
                ].join(" and "),
            )}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {

namespace {

MaterialRecord& standard_slot_material(
    Engine& engine,
    MaterialHandle material) {
    if (material.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid material handle.");
    }
    return engine.materials[material.value];
}

} // namespace
${diffuse ? `
// The plain material.diffuseTexture write, for the one source the reached
// slice gives it: a colour render target.
//
// rtt.ts hands that attachment back as a Texture2D carrying invertY: true,
// and isStandardUvInverted reads exactly that property off the diffuse
// texture, so the material's UV block flips V. A loaded image carries no
// such property -- loadTexture2D flips at upload instead -- which is why
// the record's uv_invert_y and invert_y are separate fields.
void set_standard_diffuse_render_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture) {
    MaterialRecord& record = standard_slot_material(engine, material);
    record.diffuse_render_texture = texture;
    record.has_diffuse_render_texture = true;
    record.base_color_texture.uv_invert_y = true;
}
` : ""}${emissive ? `
// The pinned setter stores the texture and registers the emissive
// extension; registration is a bundling concern with no native
// counterpart, because generation composes against every Standard
// extension the pin ships.
void set_standard_emissive_texture(
    Engine& engine,
    MaterialHandle material,
    RenderTextureRef texture) {
    MaterialRecord& record = standard_slot_material(engine, material);
    record.emissive_render_texture = texture;
    record.has_emissive_render_texture = true;
}
` : ""}${pixels ? `
// The same slot, filled by a createTexture2DFromPixels texture. Upstream
// has one Texture2D whatever built it and the assignment is a plain field
// write, so the record takes the texels, the sampler, and the texture-object
// properties a marked material's UV transform reads back. rgba_width/height
// are what tell the shared upload these bytes are already texels rather than
// an encoded file.
void set_standard_diffuse_pixels_texture(
    Engine& engine,
    MaterialHandle material,
    const PixelsTexture& texture) {
    MaterialRecord& record = standard_slot_material(engine, material);
    TextureData& slot = record.base_color_texture;
    slot.bytes = texture.rgba;
    slot.rgba_width = texture.width;
    slot.rgba_height = texture.height;
    slot.sampler = texture.sampler;
    slot.uv_transform = texture.uv_transform;
    slot.uv_invert_y = texture.uv_invert_y;
}
` : ""}${diffuseFile ? `
// The same slot, filled by a loaded image -- the third source it takes, and
// the one the .babylon loader already fills for a material it builds. The
// texture object travels whole because the pin has one Texture2D whatever
// loaded it: the upload flip, the sampler and the texture-object invertY
// the Standard UV block reads are all properties of the texture rather than
// of the slot.
void set_standard_diffuse_file_texture(
    Engine& engine,
    MaterialHandle material,
    const FileTexture& texture) {
    standard_slot_material(engine, material).base_color_texture =
        texture.data;
}
` : ""}${emissiveFile ? `
// setStandardEmissiveTexture over a loaded image. The render-texture arm
// beside it writes its own pair because a render target is bound as a view
// rather than uploaded; an image fills the record slot the .babylon loader
// fills, and the composed variant takes the non-depth arm of the pin's own
// emissive extension because only a depth render target carries
// _sampleType === "depth".
void set_standard_emissive_file_texture(
    Engine& engine,
    MaterialHandle material,
    const FileTexture& texture) {
    standard_slot_material(engine, material).emissive_texture = texture.data;
}
` : ""}${uvTransform ? `
// src/material/enable-material-uv-transform.ts enableMaterialUvTransform
//
// Upstream this marks the material and preloads the extension's fragment
// module so the group builder can compose it. Generation composes against
// the extension either way, so the mark is the whole native contract: it is
// what stdUvTransformExt._meshFeatures reads back, and therefore what
// standard_material_features ORs into the variant key.
void enable_material_uv_transform(
    Engine& engine,
    MaterialHandle material) {
    standard_slot_material(engine, material).has_uv_transform = true;
}
` : ""}
} // namespace bbl
`,
        };
    }

    public lowerStandardMaterialFactory(): LoweredSource {
        const modulePath = "src/material/standard/create-standard-material.ts";
        const symbolName = "createStandardMaterial";
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const returnStatement = declaration.body!.statements.find(
            (statement): statement is ts.ReturnStatement =>
                ts.isReturnStatement(statement) && statement.expression !== undefined,
        );
        if (!returnStatement?.expression) throw new Error("Upstream standard material return was not found.");
        let object = returnStatement.expression;
        while (ts.isAsExpression(object) || ts.isParenthesizedExpression(object)) object = object.expression;
        if (!ts.isObjectLiteralExpression(object)) throw new Error("Upstream standard material defaults changed.");
        const tuple = (name: string): string =>
            this.context.cppColor3(
                this.context.numericTuple(this.context.propertyInitializer(object, name), file),
            );
        const scalar = (name: string): string =>
            this.context.floatLiteral(
                this.context.numericValue(
                    this.context.propertyInitializer(object, name),
                    file,
                ),
            );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

namespace bbl {

MaterialHandle create_standard_material(Engine& engine) {
    MaterialRecord material;
    material.standard_material = true;
    material.diffuse_color = ${tuple("diffuseColor")};
    material.base_color_factor.a = ${scalar("alpha")};
    material.specular_color = ${tuple("specularColor")};
    material.specular_power = ${scalar("specularPower")};
    material.emissive_factor = ${tuple("emissiveColor")};
    material.ambient_color = ${tuple("ambientColor")};
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerNoColorMaterialViews(
        esmShadows = false,
        nodeEsmCasters = false,
    ): LoweredSource {
        const standardModule = "src/material/standard/no-color-view.ts";
        const esmModule = "src/material/standard/esm-shadow-view.ts";
        const pbrModule = "src/material/pbr/no-color-view.ts";
        const viewModule = "src/material/material-view.ts";
        const dirtyModule = "src/material/material-dirty.ts";
        for (const [modulePath, functionName, flag] of [
            [
                standardModule,
                "createStandardNoColorMaterialView",
                "NO_COLOR_OUTPUT",
            ],
            [
                pbrModule,
                "createPbrNoColorMaterialView",
                "PBR2_NO_COLOR_OUTPUT",
            ],
            ...(esmShadows
                ? ([[
                    esmModule,
                    "createStandardEsmShadowMaterialView",
                    "ESM_SHADOW_OUTPUT",
                ]] as const)
                : []),
        ] as const) {
            const { declaration } =
                this.context.functionDeclaration(
                    modulePath,
                    functionName,
                );
            if (
                !this.context.hasNode(
                    declaration,
                    (node) =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.BarToken &&
                        ts.isIdentifier(node.right) &&
                        node.right.text === flag,
                )
            ) {
                this.context.contractError(
                    declaration,
                    `Expected no-color feature flag '${flag}'.`,
                );
            }
        }
        const { declaration: createMaterialView } =
            this.context.functionDeclaration(
                viewModule,
                "createMaterialView",
            );
        if (
            !this.context.hasNode(
                createMaterialView,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                    ts.isIdentifier(
                        node.expression.expression,
                    ) &&
                    node.expression.expression.text === "Object" &&
                    node.expression.name.text === "create" &&
                    node.arguments.length >= 1 &&
                    ts.isIdentifier(node.arguments[0]!) &&
                    node.arguments[0].text === "src",
            )
        ) {
            this.context.contractError(
                createMaterialView,
                "Expected material views to inherit from their source.",
            );
        }
        const { declaration: markMaterialUboDirty } =
            this.context.functionDeclaration(
                dirtyModule,
                "markMaterialUboDirty",
            );
        if (
            !this.context.hasNode(
                markMaterialUboDirty,
                (node) =>
                    ts.isPostfixUnaryExpression(node) &&
                    node.operator ===
                        ts.SyntaxKind.PlusPlusToken &&
                    ts.isPropertyAccessExpression(node.operand) &&
                    ts.isIdentifier(
                        node.operand.expression,
                    ) &&
                    node.operand.expression.text === "source" &&
                    node.operand.name.text === "_uboVersion",
            )
        ) {
            this.context.contractError(
                markMaterialUboDirty,
                "Expected source UBO version invalidation.",
            );
        }
        return {
            modulePath: viewModule,
            symbolName:
                "createStandardNoColorMaterialView,createPbrNoColorMaterialView,markMaterialUboDirty" +
                (esmShadows
                    ? ",createStandardEsmShadowMaterialView," +
                        "createPbrEsmShadowMaterialView"
                    : "") +
                (nodeEsmCasters
                    ? ",createNodeEsmShadowMaterialView"
                    : ""),
            header: "",
            source: `// ${this.context.provenance(
                viewModule,
                "createMaterialView",
                `${standardModule}#createStandardNoColorMaterialView, ${pbrModule}#createPbrNoColorMaterialView, and ${dirtyModule}#markMaterialUboDirty`,
            )}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {
namespace {

MaterialHandle create_no_color_material_view(
    Engine& engine,
    MaterialHandle source,
    bool standard) {
    if (source.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid source material handle.");
    }
    const MaterialRecord& source_record = engine.materials[source.value];
    if (source_record.standard_material != standard) {
        throw std::runtime_error(
            "No-color material view family does not match its source.");
    }
    MaterialRecord view = source_record;
    view.no_color = true;
    engine.materials.push_back(std::move(view));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace

MaterialHandle create_standard_no_color_material_view(
    Engine& engine,
    MaterialHandle source) {
    return create_no_color_material_view(engine, source, true);
}

MaterialHandle create_pbr_no_color_material_view(
    Engine& engine,
    MaterialHandle source) {
    return create_no_color_material_view(engine, source, false);
}
${!esmShadows ? "" : `
// The ESM caster's view. Same inheritance, a different pass bit: the
// selector clears the blend flag and ORs ESM_SHADOW_OUTPUT, which is what
// \`createStandardEsmShadowMaterialView\` does to the feature word.
MaterialHandle create_standard_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator) {
    if (source.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid source material handle.");
    }
    const MaterialRecord& source_record = engine.materials[source.value];
    if (!source_record.standard_material) {
        throw std::runtime_error(
            "An ESM shadow material view requires a Standard source.");
    }
    MaterialRecord view = source_record;
    view.esm_shadow = true;
    view.esm_shadow_generator = generator;
    engine.materials.push_back(std::move(view));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

// The PBR sibling. \`createPbrEsmShadowMaterialView\` is the same view over
// the other family's flag word -- \`PBR2_ESM_SHADOW_OUTPUT\` in place of the
// no-colour bit -- and the variant it resolves was composed under this
// handle, so the record carries only the bit and its generator.
MaterialHandle create_pbr_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator) {
    if (source.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid source material handle.");
    }
    const MaterialRecord& source_record = engine.materials[source.value];
    if (source_record.standard_material) {
        throw std::runtime_error(
            "A PBR ESM shadow material view requires a PBR source.");
    }
    MaterialRecord view = source_record;
    view.esm_shadow = true;
    view.esm_shadow_generator = generator;
    engine.materials.push_back(std::move(view));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}
`}${!nodeEsmCasters ? "" : `
// The node family's ESM caster view. \`createNodeEsmShadowMaterialView\`
// keeps the source's own graph and flips one bit; the module that bit
// selects was compiled beside the receiver's and rides the same variant
// row, so nothing here names a second variant.
MaterialHandle create_node_esm_shadow_material_view(
    Engine& engine,
    MaterialHandle source,
    ShadowGeneratorHandle generator) {
    if (source.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid source material handle.");
    }
    const MaterialRecord& source_record = engine.materials[source.value];
    if (!source_record.node_material) {
        throw std::runtime_error(
            "A node ESM shadow material view requires a node source.");
    }
    MaterialRecord view = source_record;
    view.esm_shadow = true;
    view.esm_shadow_generator = generator;
    engine.materials.push_back(std::move(view));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}
`}

void mark_material_ubo_dirty(
    Engine& engine,
    MaterialHandle material) {
    if (material.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid material handle.");
    }
}

} // namespace bbl
`,
        };
    }
}
