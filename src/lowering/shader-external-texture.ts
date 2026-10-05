/**
 * `externalTextures` on a ShaderMaterial: a caller-owned video bound into
 * the material's resource group.
 *
 * Upstream each bind imports the video as a WebGPU `texture_external` with a
 * default sampler. The video is a closed scene producer's (executed at
 * generation), so its frame is baked: the texels the browser's import
 * yielded. Here the slot binds those texels like any sampler slot binds its
 * texture, and the pin's bind-time checks -- a declared slot with no source,
 * a video without current data, a pipeline prepared before any binding API
 * installed the resolvers -- run wherever the pin binds: when the plan is
 * built and on every frame a packet refreshes.
 */
import ts from "typescript";
import { recordAt } from "../compiler/record-access.js";
import { stringLiteral as cppStringLiteral } from "../cpp-literals.js";
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    pinnedErrorCode,
    pinnedErrorMessage,
    pinnedErrorMessageCpp,
} from "./pinned-error.js";

const textureModule = "src/texture/external-texture.ts";
const bindingModule = "src/material/shader/shader-external-texture.ts";
const pipelineModule = "src/material/shader/shader-pipeline.ts";

/** The pinned bodies the native module restates, whole. */
const restatedBodies: readonly (readonly [string, string, string])[] = [
    [
        textureModule,
        "createExternalTexture",
        `{
    return { video };
}`,
    ],
    [
        textureModule,
        "isExternalTextureReady",
        `{
    const video = texture.video;
    return video.readyState >= video.HAVE_CURRENT_DATA;
}`,
    ],
    [
        bindingModule,
        "getExternalTextureSampler",
        `{
    const samplers = (externalTextureSamplers ??= new WeakMap());
    let sampler = samplers.get(device);
    if (!sampler) {
        samplers.set(device, (sampler = device.createSampler({})));
    }
    return sampler;
}`,
    ],
    [
        bindingModule,
        "getExternalTextureSlots",
        `{
    material = getMaterialSource(material) as ShaderMaterial;
    let slots = material._externalTextureSlots;
    if (!slots) {
        const usedNames = new Set<string>();
        for (const decl of material.uniformDecls) {
            usedNames.add(decl.name);
        }
        for (const decl of material.samplerDecls) {
            usedNames.add(decl.name);
            usedNames.add(\`\${decl.name}Sampler\`);
        }
        for (const decl of material.storageBufferDecls) {
            usedNames.add(decl.name);
        }
        for (const define of material.defines) {
            usedNames.add(define.name);
        }
        material._externalTextureSlots = slots = createExternalTextureSlots(material._externalTextureDecls ?? [], usedNames);
    }
    installExternalTextureResolvers();
    return slots;
}`,
    ],
    [
        bindingModule,
        "appendExternalTextureBindings",
        `{
    const slots = getExternalTextureSlots(material);
    for (const name of material._externalTextureDecls ?? []) {
        const texture = slots.get(name)?.current;
        if (!texture) {
            throw new Error(\`ShaderMaterial: external texture "\${name}" has no source. Call setShaderExternalTexture() before rendering.\`);
        }
        if (texture.video.readyState < texture.video.HAVE_CURRENT_DATA) {
            throw new Error(\`ShaderMaterial: external texture "\${name}" is not ready.\`);
        }
        entries.push(
            { binding: nextBinding++, resource: engine._device.importExternalTexture({ source: texture.video }) },
            { binding: nextBinding++, resource: getExternalTextureSampler(engine._device) }
        );
    }
    return nextBinding;
}`,
    ],
    [
        bindingModule,
        "setShaderExternalTexture",
        `{
    material = getMaterialSource(material) as ShaderMaterial;
    const slot = getExternalTextureSlots(material).get(name);
    if (!slot) {
        throw new Error(\`ShaderMaterial: external texture "\${name}" was not declared.\`);
    }
    if (slot.current !== texture) {
        slot.current = texture;
        material._resourceVersion++;
        bumpVisibilityEpoch();
    }
}`,
    ],
    [
        bindingModule,
        "installExternalTextureResolvers",
        `{
    if (resolversInstalled) {
        return;
    }
    _installShaderExternalTexturePipelineResolver({ layout: appendExternalTextureLayout, prelude: appendExternalTexturePrelude });
    _installShaderExternalTextureBindingResolver({
        active: (material) => !!material._externalTextureDecls?.length,
        bind: appendExternalTextureBindings,
        refresh(engine, material, packet, createBindGroup) {
            if (material._externalTextureDecls?.length) {
                packet._bindGroup = createBindGroup(engine, material, packet.systemUBO);
            }
        },
    });
    resolversInstalled = true;
}`,
    ],
];

/** `material_shader_external.cpp`: the video records, the slot setters and the bind checks. */
export function lowerShaderExternalTextures(
    context: LoweringContext,
): LoweredSource {
    for (const [module, name, body] of restatedBodies) {
        context.assertFunctionBodyShape(
            context.functionDeclaration(module, name).declaration,
            body,
            `Pinned ${name}`,
        );
    }
    /** The one `if` in a pinned function whose condition has this shape. */
    const guard = (
        module: string,
        name: string,
        condition: string,
    ): ts.IfStatement => {
        const { declaration } = context.functionDeclaration(module, name);
        const found = context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                context.expressionMatchesShape(node.expression, condition),
        );
        return found.length === 1
            ? found[0]!
            : context.contractError(
                  declaration,
                  `Expected one pinned ${name} guard ${condition}, found ${found.length}.`,
              );
    };
    // The pipeline refuses a declaring material until a binding API ran:
    // the resolvers are installed by `getExternalTextureSlots`, which only
    // the two binding APIs and the installed resolvers themselves reach.
    const uninstalled = pinnedErrorMessage(
        context,
        pinnedErrorCode(
            context,
            guard(
                pipelineModule,
                "getOrCreateShaderPipelineBindings",
                "material._externalTextureDecls?.length && !_externalTextureResolver",
            ),
        ),
    );
    const [noSource, notReady] = [
        "!texture",
        "texture.video.readyState < texture.video.HAVE_CURRENT_DATA",
    ].map((condition) =>
        pinnedErrorMessageCpp(
            context,
            pinnedErrorCode(
                context,
                guard(
                    bindingModule,
                    "appendExternalTextureBindings",
                    condition,
                ),
            ),
            [{ cpp: "name" }],
        ),
    );
    return {
        modulePath: bindingModule,
        symbolName: "setShaderExternalTexture",
        header: "",
        source: `// ${context.provenance(textureModule, "createExternalTexture")}
// ${context.provenance(bindingModule, "setShaderExternalTexture")}
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl {

namespace {

// The pin installs its external-texture resolvers, once per realm, on the
// first binding API call; setShaderExternalTexture is the reached one.
bool external_texture_resolvers_installed = false;

// getExternalTextureSampler: \`device.createSampler({})\`, WebGPU's default
// descriptor -- nearest filtering, clamped to the edge, one level. Only an
// external binding samples a video's frame, so the frame carries it.
TextureSamplerState external_texture_sampler() {
    TextureSamplerState sampler;
    sampler.min_filter = TextureFilter::nearest;
    sampler.mag_filter = TextureFilter::nearest;
    sampler.mipmap_mode = TextureMipmapMode::nearest;
    sampler.address_u = TextureAddressMode::clamp;
    sampler.address_v = TextureAddressMode::clamp;
    sampler.max_anisotropy = 1.0f;
    sampler.max_lod = 0.0f;
    return sampler;
}

} // namespace

VideoHandle create_baked_video(int ready_state) {
    auto video = std::make_shared<VideoElement>();
    video->ready_state = ready_state;
    return video;
}

VideoHandle create_baked_video(
    const std::string& path,
    std::uint32_t width,
    std::uint32_t height,
    int ready_state) {
    std::vector<std::uint8_t> frame = pal::read_binary_file(path);
    if (frame.size() != static_cast<std::size_t>(width) * height * 4u) {
        throw std::runtime_error("Baked video frame '" + path + "' is not " +
                                 std::to_string(width) + "x" + std::to_string(height) +
                                 " RGBA8.");
    }
    VideoHandle video = create_baked_video(ready_state);
    video->frame.rgba = std::move(frame);
    video->frame.width = width;
    video->frame.height = height;
    video->frame.sampler = external_texture_sampler();
    return video;
}

ExternalTextureHandle create_external_texture(VideoHandle video) {
    return std::make_shared<const ExternalTexture>(ExternalTexture{std::move(video)});
}

bool is_external_texture_ready(const ExternalTextureHandle& texture) {
    const VideoElement& video = *texture->video;
    return video.ready_state >= video_have_current_data;
}

void set_shader_external_texture(
    Engine& engine,
    MaterialHandle material,
    std::uint32_t slot,
    ExternalTextureHandle texture) {
    MaterialRecord& record = shader_material(engine, material);
    external_texture_resolvers_installed = true;
    if (record.shader_external_textures.size() <= slot) {
        record.shader_external_textures.resize(slot + 1);
    }
    if (record.shader_external_textures[slot] == texture) {
        return;
    }
    record.shader_external_textures[slot] = texture;
    // The slot binds the video's frame as any sampler slot binds its texture.
    if (texture && !texture->video->frame.rgba.empty())
        set_shader_pixels_texture(engine, material, slot, texture->video->frame);
    else
        set_shader_texture(engine, material, slot, FileTexture{});
}

namespace upstream {

void require_shader_external_textures(const Engine& engine, const RenderPlan& plan) {
    for (const RenderItem& item : plan.items) {
        if (item.material_kind != RenderMaterialKind::shader ||
            item.material.value >= engine.materials.size()) {
            continue;
        }
        const ShaderVariantInfo& info = shader_variant_info(item.shader_variant);
        if (info.external_textures == 0) {
            continue;
        }
        if (!external_texture_resolvers_installed) {
            throw std::runtime_error(${cppStringLiteral(uninstalled)});
        }
        const MaterialRecord& material = ${recordAt("engine.materials", "item.material")};
        for (std::size_t slot = info.samplers.size() - info.external_textures;
             slot < info.samplers.size(); ++slot) {
            const char* name = info.samplers[slot];
            const ExternalTexture* texture =
                slot < material.shader_external_textures.size()
                    ? material.shader_external_textures[slot].get()
                    : nullptr;
            if (!texture) {
                throw std::runtime_error(${noSource});
            }
            if (texture->video->ready_state < video_have_current_data) {
                throw std::runtime_error(${notReady});
            }
        }
    }
}

} // namespace upstream

} // namespace bbl
`,
    };
}
