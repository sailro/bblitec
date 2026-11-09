import ts from "typescript";
import { pinnedErrorCode, pinnedErrorCodeOf } from "./pinned-error.js";
import { LoweredSource, LoweringContext } from "./context.js";
import { lowerGltfVatBinding } from "./gltf/vat-binding.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { absentBinding } from "./pinned-numeric-lowerer.js";
import { lowerPreparedVatValidation } from "./vat-prepared.js";

import { recordAt } from "../compiler/record-access.js";
import { sameSource } from "../compiler/syntax.js";

const VAT_MODULE = "src/vat/vat-baker.ts";

/**
 * Vertex animation textures (`src/vat/vat-baker.ts`).
 *
 * Each clip is sought through source goToFrameCpu and its shared skeleton
 * binding's CPU palette is folded into native mesh coordinates for VAT.
 * CPU evaluation leaves the live uploaded bone palette unchanged.
 *
 * The playback half is the 32-byte settings block: `params` selects the row
 * range and the phase, `clock` accumulates seconds, and the vertex stage
 * wraps `params.z + clock.x * params.w` into `[fromRow, toRow]`. Both PALs
 * re-upload on the versions beside it.
 */
export class VatLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lower(options: {
        instances: boolean;
        /** `bakeVat` reached: it stops each clip through the group module. */
        baked?: boolean;
        time?: boolean;
        instanceStorage?: boolean;
        prepared?: boolean;
    }): LoweredSource {
        const file = this.context.sourceFile(VAT_MODULE);
        const defaultFrameRate = this.pinnedDefaultFrameRate(file);
        // `attachVat`'s own initial write and `play`'s: params = (fromRow,
        // fromRow + frameCount - 1, offset ?? 0, fps ?? clip.fps).
        this.assertInventory(
            this.context.functionDeclaration(VAT_MODULE, "attachVat")
                .declaration,
            "attachVat",
            [
                "variable statement",
                "if statement",
                "expression statement",
                "variable statement",
                "variable statement",
                "variable statement",
                "expression statement",
                "expression statement",
                "variable statement",
                "expression statement",
                "if statement",
                "expression statement",
                "variable statement",
                "variable statement",
                "variable statement",
                "variable statement",
                "variable statement",
                "variable statement",
                "expression statement",
                "return statement",
            ],
        );
        // The per-clip bake loop `bake_vat` restates: the empty-clip refusal,
        // the palette read, the row block per clip, and the rows themselves.
        this.assertInventory(
            this.context.functionDeclaration(VAT_MODULE, "prepareVatMany")
                .declaration,
            "prepareVatMany",
            [
                "if statement",
                "variable statement",
                "other statement",
                "expression statement",
                "variable statement",
                "variable statement",
                "variable statement",
                "for statement",
                "return statement",
            ],
        );
        this.assertInventory(
            this.context.functionDeclaration(VAT_MODULE, "bakeVat").declaration,
            "bakeVat",
            ["return statement"],
        );
        return {
            modulePath: VAT_MODULE,
            symbolName:
                "bakeVat,prepareVatMany,attachVat,VatHandle.play,VatHandle.update" +
                (options.instances ? ",VatHandle.setInstances" : "") +
                (options.prepared ? ",createVatBakeResults" : ""),
            header: "",
            source: `// ${this.context.provenance(
                VAT_MODULE,
                "bakeVat, prepareVatMany, attachVat, and the VatHandle writers",
            )}
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_json.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
${options.prepared ? "#include <cstring>\n" : ""}#include <stdexcept>

namespace bbl {
namespace {

constexpr double kVatDefaultFrameRate = ${this.context.doubleLiteral(
                defaultFrameRate,
            )};

MeshRecord& vat_mesh(Engine& engine, MeshHandle mesh) {
    return ${recordAt("engine.meshes", "mesh")};
}

${
    options.baked || options.prepared
        ? `// A new bake's handle is its slot in the engine's list.
VatBake vat_store_bake(Engine& engine, VatBakeRecord bake) {
    engine.vat_bakes.push_back(std::move(bake));
    return VatBake{
        static_cast<std::uint32_t>(engine.vat_bakes.size() - 1)};
}

`
        : ""
}VatData& vat_data(Engine& engine, VatHandle handle) {
    MeshRecord& record = vat_mesh(engine, handle.mesh);
    if (!record.has_vat) {
        throw std::runtime_error("VatHandle names a mesh with no VAT.");
    }
    return record.vat;
}

const VatClipRow* vat_clip(
    const VatBakeRecord& bake,
    const std::string& name) {
    for (const VatClipRow& clip : bake.clips) {
        if (clip.name == name) return &clip;
    }
    return nullptr;
}

} // namespace

${options.baked ? this.lowerBake() : ""}VatHandle attach_vat(
    Engine& engine,
    MeshHandle mesh,
    VatBake baked,
    const js::Nullable<std::string>& clip) {
    if (baked.value >= engine.vat_bakes.size()) {
        throw std::runtime_error("attachVat names no such bake.");
    }
    MeshRecord& record = vat_mesh(engine, mesh);
    if (!record.skinned) {
        throw std::runtime_error(
            "attachVat: mesh has no skeleton (bake first, attach before clearing it).");
    }
    record.has_vat = true;
    record.vat = VatData{};
    record.vat.bake = baked.value;
    // mesh.skeleton = null: baked, so no live skinning and no per-frame
    // palette upload. The pose pass skips the record from here.
    record.skinned = false;
    record.bone_matrices.clear();
    const VatHandle handle{mesh};
    const VatBakeRecord& bake = ${recordAt("engine.vat_bakes", "baked")};
    // \`clip ?? Object.keys(baked.clips)[0] ?? ""\`: the first name in
    // property order, an array index before the other names.
    const auto first = std::min_element(bake.clips.begin(), bake.clips.end(),
        [](const VatClipRow& left, const VatClipRow& right) {
            return bbl::js::json_property_key_less(left.name, right.name);
        });
    const std::string selected = clip
        ? *clip
        : first != bake.clips.end() ? first->name : std::string{};
    vat_play(engine, handle, selected, std::optional<double>{},
        std::optional<double>{});
    return handle;
}

void vat_play(
    Engine& engine,
    VatHandle handle,
    const std::string& clip,
    std::optional<double> offset,
    std::optional<double> fps) {
    VatData& vat = vat_data(engine, handle);
    if (vat.bake >= engine.vat_bakes.size()) return;
    const VatBakeRecord& bake = engine.vat_bakes[vat.bake];
    const VatClipRow* row = vat_clip(bake, clip);
    // The pin returns without writing for a clip the bake does not carry.
    if (!row) return;
    vat.settings[0] = static_cast<float>(row->from_row);
    vat.settings[1] =
        static_cast<float>(row->from_row + row->frame_count - 1.0);
    vat.settings[2] = static_cast<float>(offset.value_or(0.0));
    vat.settings[3] = static_cast<float>(fps ? *fps : row->fps);
${
    options.time
        ? `    // writeUbo uploads the whole block, whose clock lane is the handle's
    // own clock: a setVatTime write does not survive it.
    vat.settings[4] = vat.time;
`
        : ""
}\
    vat.settings_version += 1;
}

void vat_update(
    Engine& engine,
    VatHandle handle,
    double delta_seconds) {
    VatData& vat = vat_data(engine, handle);
    vat.time += static_cast<float>(delta_seconds);
    vat.settings[4] = vat.time;
    vat.settings_version += 1;
}
${options.instances ? this.lowerSetInstances() : ""}${options.time ? this.lowerSetTime() : ""}${options.instanceStorage ? this.lowerSetInstanceStorage() : ""}${options.prepared ? this.lowerPrepared() : ""}
VatClipRow vat_clip_row(
    Engine& engine,
    VatBake baked,
    const std::string& clip) {
    if (baked.value >= engine.vat_bakes.size()) return VatClipRow{};
    const VatClipRow* row =
        vat_clip(${recordAt("engine.vat_bakes", "baked")}, clip);
    return row ? *row : VatClipRow{};
}

void seek_vat(Engine& engine, double seconds) {
    // The frozen pose scene 218 renders under ?seekTime: the clip is
    // played at the exact baked frame round(t * 60) with fps 0, so the row
    // is static and the clock contributes nothing. VAT bakes that very
    // pose at full precision, which is what makes the frozen native frame
    // the frozen browser frame.
    const double frame = bbl::js::round_js(
        seconds * static_cast<double>(kVatDefaultFrameRate));
    for (std::size_t mesh = 0; mesh < engine.meshes.size(); ++mesh) {
        MeshRecord& record = engine.meshes[mesh];
        if (!record.has_vat) continue;
        record.vat.settings[2] = static_cast<float>(frame);
        record.vat.settings[3] = 0.0f;
        record.vat.time = 0.0f;
        record.vat.settings[4] = 0.0f;
        record.vat.settings_version += 1;${
            options.instances
                ? `
        // The per-instance arm of the same freeze: each instance's own
        // offset becomes the seeked frame and its rate zero, so the
        // instanced variant reads the same static row the shared one
        // does. Texel 2i is clip A (fromRow, toRow, offset, fps) and
        // 2i+1 clip B (fromRow, toRow, blend, fps), which reuses A's
        // offset -- so only A's offset moves.
        for (
            std::size_t texel = 0;
            texel * 4u + 7u < record.vat.instance_params.size();
            texel += 2u) {
            record.vat.instance_params[texel * 4u + 2u] =
                static_cast<float>(frame);
            record.vat.instance_params[texel * 4u + 3u] = 0.0f;
            record.vat.instance_params[texel * 4u + 7u] = 0.0f;
        }
        if (!record.vat.instance_params.empty()) {
            record.vat.instance_version += 1;
        }`
                : ""
        }
    }
}

} // namespace bbl
`,
        };
    }

    /**
     * `createVatBakeResults`: the pin's checks on each offline-prepared
     * payload, in its order, then one bake per payload. The record and
     * typed-array tests (`typeof`, `Array.isArray`, `instanceof`) are
     * settled by storage: the compiler hands over numbers, a typed array
     * and maps. A missing payload or clip arrives as NaN fields, which the
     * pin's own integer checks refuse with the codes `undefined` gets.
     * Sibling payloads with byte-identical data share one GPU texture, as
     * upstream.
     */
    /** The pinned error code whose message the table spells so. */
    private errorCode(message: string): number {
        return pinnedErrorCodeOf(this.context, message);
    }

    private lowerPrepared(): string {
        // The result keeps every validated field but the data, which only
        // the texture holds; the sharing is the GPU's alone.
        const upload = this.context.functionDeclaration(
            VAT_MODULE,
            "uploadPreparedMany",
        ).declaration;
        this.context.assertStatementShapes(
            upload.body!,
            upload.body!.statements,
            `
            const uniqueTextures: UniqueVatTexture[] = [];
            try {
                return prepared.map((entry) => {
                    let shared = uniqueTextures.find(
                        (candidate) => candidate.boneCount === entry.boneCount && (candidate.data === entry.data || equalFloatBits(candidate.data, entry.data))
                    );
                    if (!shared) {
                        const resource = createVatTextureResource(engine, entry.data, entry.boneCount, entry.frameCount);
                        shared = { data: entry.data, boneCount: entry.boneCount, resource };
                        uniqueTextures.push(shared);
                    }
                    const { data: _data, ...result } = entry;
                    return Object.assign(result, {
                        texture: shared.resource.texture,
                        _textureResource: shared.resource,
                    });
                });
            } catch (error) {
                for (const entry of uniqueTextures) {
                    entry.resource.texture.destroy();
                }
                throw error;
            }
        `,
            "VAT prepared upload",
        );
        return `
namespace {
${lowerPreparedVatValidation(this.context)}
} // namespace

js::Array<VatBake> create_vat_bakes(
    Engine& engine,
    const std::vector<PreparedVatPayload>& prepared) {
    std::vector<VatBakeRecord> validated;
    validated.reserve(prepared.size());
    for (const PreparedVatPayload& source : prepared)
        validated.push_back(vat_validate_prepared(source));
    // uploadPreparedMany: payloads of one bone count and bit-equal data
    // share one texture, whose texels are the first one's.
    struct UniqueTexture {
        GpuTextureIdentity texture;
        std::span<std::uint8_t> bytes;
    };
    std::vector<UniqueTexture> unique;
    js::Array<VatBake> results;
    for (std::size_t index = 0; index < validated.size(); ++index) {
        VatBakeRecord& bake = validated[index];
        const auto bytes = bbl::js::typed_array_bytes(prepared[index].data);
        const std::uint32_t width = bake.bone_count * 4u;
        const auto shared = std::find_if(unique.begin(), unique.end(),
            [&](const UniqueTexture& candidate) {
                return candidate.texture.texels->width == width &&
                       candidate.bytes.size() == bytes.size() &&
                       std::memcmp(candidate.bytes.data(), bytes.data(), bytes.size()) == 0;
            });
        if (shared != unique.end()) {
            bake.texture = shared->texture;
        } else {
            // A payload is usually a view of a fetched bundle, so its bytes
            // are copied from the buffer rather than iterated.
            auto texels = std::make_shared<GpuTextureTexels>();
            texels->width = width;
            texels->height = bake.frame_count;
            texels->rgba.resize(prepared[index].data.size());
            std::memcpy(texels->rgba.data(), bytes.data(), bytes.size());
            auto texture = publish_gpu_texture_identity(engine);
            texture.texels = std::move(texels);
            bake.texture = unique.emplace_back(UniqueTexture{std::move(texture), bytes}).texture;
        }
        results.push_back(vat_store_bake(engine, std::move(bake)));
    }
    return results;
}
`;
    }

    /** `bakeVat`: the clip-by-clip pose bake into a new texture. */
    private lowerBake(): string {
        const clipFrames = lowerPinnedFunction(
            this.context,
            VAT_MODULE,
            "clipFrameCount",
            [
                {
                    pinned: "group",
                    kind: "record",
                    cpp: "group",
                    annotation: "AnimationGroup",
                    specialized: true,
                    binding: { cpp: "group", type: "opaque" },
                },
            ],
            {
                cppName: "vat_clip_frames",
                returns: "double",
                leadingParameters: ["double duration"],
                memberBindings: new Map([
                    ["group.duration", { cpp: "duration", type: "scalar" }],
                    // The glTF animation lowering refuses groups with an own frameRate.
                    ["group.frameRate", absentBinding("undefined")],
                    [
                        "DEFAULT_FRAME_RATE",
                        { cpp: "kVatDefaultFrameRate", type: "scalar" },
                    ],
                ]),
            },
        );
        return `namespace {

${lowerGltfVatBinding(this.context)}

${clipFrames}

} // namespace

VatBake bake_vat(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<AnimationGroupHandle>& groups) {
    MeshRecord& record = vat_mesh(engine, mesh);
    gltf_vat_require_skeleton(record.skinned && !record.has_vat, record.name);
    VatBakeRecord bake;
    // Every clip contributes a contiguous row block, clip 0 first, in the
    // order the container hands them over -- the pin's own layout, which
    // the clip row map then indexes.
    std::uint32_t total_frames = 0;
    std::vector<std::uint32_t> frames_per_clip;
    frames_per_clip.reserve(groups.size());
    for (const AnimationGroupHandle group : groups) {
        if (group.value >= engine.animation_groups.size()) {
            throw std::runtime_error("bakeVat names no such clip.");
        }
        const AnimationGroupRecord& clip_record =
            ${recordAt("engine.animation_groups", "group")};
        if (clip_record.asset >= engine.assets.size()) {
            throw std::runtime_error("bakeVat clip has no asset.");
        }
        const AssetRecord& asset = engine.assets[clip_record.asset];
        const bool has_binding = gltf_vat_binding_of(
            record.skinned && !record.has_vat,
            static_cast<bool>(asset.animation_has_skeleton),
            [&]() { return asset.animation_has_skeleton(mesh); });
        const auto palette = has_binding && asset.animation_bone_palette
            ? asset.animation_bone_palette(mesh)
            : std::vector<std::array<float, 16>>{};
        gltf_vat_require_binding(has_binding,
            static_cast<double>(palette.size()),
            static_cast<double>(record.bone_matrices.size()), record.name, clip_record.name);
        if (!asset.animation_cpu_go_to_frame || !asset.animation_bone_palette) {
            throw std::runtime_error("CPU-only animation evaluation is unavailable for this animation controller");
        }
        const float duration = asset.clip_duration
            ? asset.clip_duration(clip_record.clip)
            : 0.0f;
        const double frame_count = vat_clip_frames(static_cast<double>(duration));
        if (!std::isfinite(frame_count) || frame_count < 0.0 ||
            frame_count > static_cast<double>(
                std::numeric_limits<std::uint32_t>::max() - total_frames))
            throw std::runtime_error("VAT frame count exceeds native texture storage.");
        const auto frames = static_cast<std::uint32_t>(frame_count);
        frames_per_clip.push_back(frames);
        bake.clips.push_back(VatClipRow{
            clip_record.name,
            static_cast<double>(total_frames),
            static_cast<double>(frames),
            static_cast<double>(kVatDefaultFrameRate)});
        total_frames += frames;
    }
    bake.frame_count = std::max(1u, total_frames);
    // Refused before the seek, not after: a default-constructed handle is
    // index 0, so seeking one would either throw group_record's own
    // "Invalid animation group handle" -- naming the wrong thing -- or,
    // when the engine holds groups from another asset, silently pose the
    // mesh from an unrelated clip.
    if (groups.empty()) {
        throw std::runtime_error(
            "bakeVat: the container published no animation groups, so "
            "there is no clip to bake.");
    }
    bake.bone_count =
        static_cast<std::uint32_t>(record.bone_matrices.size());
    if (bake.bone_count == 0) {
        throw std::runtime_error(
            "bakeVat: the mesh published no bone palette to bake.");
    }
    const std::size_t floats_per_frame =
        static_cast<std::size_t>(bake.bone_count) * 16u;
    auto texels = std::make_shared<GpuTextureTexels>();
    texels->width = bake.bone_count * 4u;
    texels->height = bake.frame_count;
    texels->rgba.assign(
        static_cast<std::size_t>(bake.frame_count) * floats_per_frame,
        0.0f);
    std::size_t row = 0;
    for (std::size_t index = 0; index < groups.size(); ++index) {
        const AnimationGroupRecord& clip_record = ${recordAt("engine.animation_groups", "groups[index]")};
        const AssetRecord& asset = engine.assets[clip_record.asset];
        const std::uint32_t frames = frames_per_clip[index];
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            asset.animation_cpu_go_to_frame(clip_record.clip, static_cast<double>(frame));
            const auto matrices = asset.animation_bone_palette(mesh);
            for (std::size_t bone = 0; bone < bake.bone_count; ++bone) {
                std::copy_n(
                    matrices.at(bone).data(),
                    16,
                    texels->rgba.data() + row * floats_per_frame + bone * 16);
            }
            ++row;
        }
        // stopAnimation after each clip: the bake replaces live playback.
        stop_animation(engine, groups[index]);
    }
    bake.texture = publish_gpu_texture_identity(engine);
    bake.texture.texels = std::move(texels);
    return vat_store_bake(engine, std::move(bake));
}

`;
    }

    /**
     * `setVatTime`: one Float32 write at byte 16 of the settings block, the
     * lane the handle's update fills from its own clock, which stays as it
     * was. The handle's whole-block writes put that clock back.
     */
    private lowerSetTime(): string {
        const declaration = this.context.functionDeclaration(
            VAT_MODULE,
            "setVatTime",
        ).declaration;
        this.context.assertStatementShapes(
            declaration.body!,
            declaration.body!.statements,
            `
            const vat = mesh.vat;
            if (!vat) {
                ThrowLiteError(${this.errorCode("setVatTime: mesh has no VAT data.")});
            }
            const time = (_vatTime ??= new Float32Array(1));
            time[0] = seconds;
            engine._device.queue.writeBuffer(vat.settingsBuffer, 16, time);
        `,
            "VAT clock write",
        );
        const attach = this.context.functionDeclaration(
            VAT_MODULE,
            "attachVat",
        ).declaration;
        for (const shape of [
            "device.queue.writeBuffer(settingsBuffer, 0, ubo.buffer, ubo.byteOffset, 32)",
            "ubo[4] = time",
        ])
            this.context.expectShapeCount(
                attach,
                shape,
                "VAT settings block write",
            );
        const code = pinnedErrorCode(this.context, declaration);
        return `
// ${this.context.provenance(VAT_MODULE, "setVatTime")}
void set_vat_time(Engine& engine, MeshHandle mesh, double seconds) {
    MeshRecord& record = vat_mesh(engine, mesh);
    if (!record.has_vat) throw std::runtime_error("#${code}");
    record.vat.settings[4] = static_cast<float>(seconds);
    record.vat.settings_version += 1;
}
`;
    }

    /**
     * \`setVatInstanceStorage\`: the pin's checks, then the buffer the VAT
     * picking projection binds for thin instances.
     */
    private lowerSetInstanceStorage(): string {
        const declaration = this.context.functionDeclaration(
            VAT_MODULE,
            "setVatInstanceStorage",
        ).declaration;
        this.context.assertStatementShapes(
            declaration.body!,
            declaration.body!.statements,
            `
            const vat = mesh.vat;
            if (!vat) {
                ThrowLiteError(${this.errorCode("setVatInstanceStorage: mesh has no VAT data.")});
            }
            if (buffer && (buffer._destroyed || buffer._engine !== engine || !engine._storageBuffers?.has(buffer))) {
                ThrowLiteError(${this.errorCode("setVatInstanceStorage requires a live StorageBuffer from the same engine.")});
            }
            vat._instanceStorage = buffer;
        `,
            "VAT instance storage",
        );
        const [, missing, invalid] = declaration.body!.statements;
        return `
// ${this.context.provenance(VAT_MODULE, "setVatInstanceStorage")}
void set_vat_instance_storage(Engine& engine, MeshHandle mesh,
                              std::optional<StorageBufferHandle> buffer) {
    MeshRecord& record = vat_mesh(engine, mesh);
    if (!record.has_vat) throw std::runtime_error("#${pinnedErrorCode(this.context, missing!)}");
    // \`buffer._engine !== engine\` is settled at generation.
    if (buffer && (buffer->value >= engine.storage_buffers.size() ||
                   engine.storage_buffers[buffer->value].disposed ||
                   !engine.storage_buffers[buffer->value].registered))
        throw std::runtime_error("#${pinnedErrorCode(this.context, invalid!)}");
    record.vat.instance_storage = buffer;
}
`;
    }

    /**
     * `VatHandle.setInstances`, lowered from `attachVat`'s own handle
     * literal: the single-clip rows expanded to the dual-clip layout, then
     * `uploadInstances`' texel count. The texture write is the PAL's, so the
     * record carries the rows, that count and a version the backends upload
     * on.
     */
    private lowerSetInstances(): string {
        const { file, declaration } = this.context.functionDeclaration(
            VAT_MODULE,
            "attachVat",
        );
        const handle = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, "handle"),
        );
        const setInstances = ts.isObjectLiteralExpression(handle)
            ? handle.properties.find(
                  (property): property is ts.MethodDeclaration =>
                      ts.isMethodDeclaration(property) &&
                      this.context.propertyName(property.name) ===
                          "setInstances",
              )
            : undefined;
        if (!setInstances?.body) {
            return this.context.contractError(
                handle,
                "Expected the VatHandle literal to carry setInstances.",
            );
        }
        const upload = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, "uploadInstances"),
        );
        const texels =
            ts.isArrowFunction(upload) && ts.isBlock(upload.body)
                ? upload.body.statements[0]
                : undefined;
        if (
            !texels ||
            !ts.isVariableStatement(texels) ||
            texels.declarationList.declarations.length !== 1 ||
            !sameSource(texels.declarationList.declarations[0]!.name, "texels")
        ) {
            return this.context.contractError(
                upload,
                "Expected uploadInstances to open with its texel count.",
            );
        }
        const params = new Map([
            ["params", { cpp: "params", type: "f32" as const }],
        ]);
        const texelCount = lowerPinnedBody(file, [texels], {
            bindings: params,
            calls: new Map(),
        });
        const expand = lowerPinnedBody(file, setInstances.body.statements, {
            bindings: new Map(params),
            calls: new Map([
                [
                    "uploadInstances",
                    (args: readonly string[]) =>
                        `vat_upload_instances(vat, ${args.join(", ")})`,
                ],
            ]),
        });
        return `
namespace {

// ${this.context.provenance(VAT_MODULE, "attachVat.uploadInstances")}
void vat_upload_instances(
    VatData& vat,
    const std::vector<float>& params) {
${texelCount}
    vat.instance_texels = static_cast<std::uint32_t>(texels);
    vat.instance_params.assign(params.begin(), params.end());
    vat.instance_params.resize(
        static_cast<std::size_t>(vat.instance_texels) * 4u, 0.0f);
    vat.instance_version += 1;
}

} // namespace

// ${this.context.provenance(VAT_MODULE, "attachVat.setInstances")}
void vat_set_instances(
    Engine& engine,
    VatHandle handle,
    const std::vector<float>& params) {
    VatData& vat = vat_data(engine, handle);
${expand}
}
`;
    }

    /**
     * The statement inventory of a pinned body the emitted VAT functions
     * restate: the shape checks above say each asserted statement is
     * present, and only the inventory notices one the pin adds between them.
     */
    private assertInventory(
        declaration: ts.FunctionDeclaration,
        symbolName: string,
        expected: readonly string[],
    ): void {
        this.context.assertStatementInventory(
            declaration,
            declaration.body!.statements,
            symbolName,
            "the emitted VAT bake restates a body",
            expected,
        );
    }

    private pinnedDefaultFrameRate(file: ts.SourceFile): number {
        const declaration = this.context.findNodes(
            file,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "DEFAULT_FRAME_RATE",
        )[0];
        if (!declaration?.initializer) {
            this.context.contractError(
                file,
                "Expected DEFAULT_FRAME_RATE in the VAT baker.",
            );
        }
        return this.context.numericValue(declaration.initializer, file);
    }
}
