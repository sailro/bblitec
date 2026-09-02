import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

const VAT_MODULE = "src/vat/vat-baker.ts";

/**
 * Vertex animation textures (`src/vat/vat-baker.ts`).
 *
 * The bake is the pin's own loop and is not re-derived: for each clip it
 * seeks the group frame by frame and copies the posed bone palette into one
 * texture row. Upstream reads that palette off the clip's `SkeletonBinding`
 * (`group._gltfMixer[2][0].boneMatrices`); here `go_to_frame` applies the
 * pose and `MeshRecord::bone_matrices` holds the identical product, because
 * the live skeleton path uploads exactly those floats as its own palette
 * texture. That is what makes VAT(frame N) the live pose at frame N.
 *
 * The playback half is the 32-byte settings block: `params` selects the row
 * range and the phase, `clock` accumulates seconds, and the vertex stage
 * wraps `params.z + clock.x * params.w` into `[fromRow, toRow]`. Both PALs
 * re-upload on the versions beside it.
 */
export class VatLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lower(options: { instances: boolean }): LoweredSource {
        const file = this.context.sourceFile(VAT_MODULE);
        const defaultFrameRate = this.pinnedDefaultFrameRate(file);
        // `clipFrameCount(group) = max(1, round(duration * fps) + 1)`, the
        // inclusive-of-frame-zero count that decides each clip's row block.
        // Asserted rather than transcribed blind: the row map and the
        // shader's wrap both depend on it, so a changed formula must fail
        // generation instead of shifting every baked pose by a frame.
        const clipFrameCount = this.context.functionDeclaration(
            VAT_MODULE,
            "clipFrameCount",
        ).declaration;
        const frameCountReturn = this.context
            .findNodes(
                clipFrameCount,
                (node): node is ts.ReturnStatement =>
                    ts.isReturnStatement(node),
            )[0]?.expression;
        if (!frameCountReturn) {
            this.context.contractError(
                clipFrameCount,
                "Expected clipFrameCount to return the baked frame count.",
            );
        }
        this.context.assertExpressionShape(
            frameCountReturn,
            "Math.max(1, Math.round(group.duration * fps) + 1)",
            "VAT clip frame count",
        );
        // The other half of the same formula. The port spells the rate as
        // `kVatDefaultFrameRate` unconditionally, which is only right while
        // `group.frameRate` is falsy for every clip this port can bake --
        // true today because animation-lowerer.ts separately fails
        // generation if a glTF clip carries a frameRate of its own. Pin the
        // initializer so that stops being an unstated dependency: were
        // upstream to write `?? DEFAULT_FRAME_RATE`, or read the rate from
        // somewhere else, the hardcoded constant would silently shift every
        // baked row by a frame instead of refusing.
        const fpsDeclaration = this.context.findNodes(
            clipFrameCount,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "fps",
        )[0];
        if (!fpsDeclaration?.initializer) {
            this.context.contractError(
                clipFrameCount,
                "Expected clipFrameCount to bind its frame rate to `fps`.",
            );
        }
        this.context.assertExpressionShape(
            fpsDeclaration.initializer,
            "group.frameRate || DEFAULT_FRAME_RATE",
            "VAT clip frame rate",
        );
        // `attachVat`'s own initial write and `play`'s: params = (fromRow,
        // fromRow + frameCount - 1, offset ?? 0, fps ?? clip.fps).
        this.context.functionDeclaration(VAT_MODULE, "attachVat");
        this.context.functionDeclaration(VAT_MODULE, "prepareVatMany");
        return {
            modulePath: VAT_MODULE,
            symbolName:
                "bakeVat,prepareVatMany,attachVat,VatHandle.play,VatHandle.update" +
                (options.instances ? ",VatHandle.setInstances" : ""),
            header: "",
            source: `// ${this.context.provenance(
                VAT_MODULE,
                "bakeVat, prepareVatMany, attachVat, and the VatHandle writers",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace bbl {
namespace {

constexpr float kVatDefaultFrameRate = ${
                this.context.floatLiteral(defaultFrameRate)
            };

MeshRecord& vat_mesh(Engine& engine, std::uint32_t mesh) {
    if (mesh >= engine.meshes.size()) {
        throw std::runtime_error("VAT names no such mesh.");
    }
    return engine.meshes[mesh];
}

VatData& vat_data(Engine& engine, VatHandle handle) {
    MeshRecord& record = vat_mesh(engine, handle.value);
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

// clipFrameCount: inclusive of frame zero, so a one-second 60fps clip
// bakes 61 rows.
std::uint32_t vat_clip_frames(float duration, float fps) {
    const double frames =
        bbl::js::round_js(static_cast<double>(duration) *
                   static_cast<double>(fps)) +
        1.0;
    return static_cast<std::uint32_t>(std::max(1.0, frames));
}

} // namespace

VatBake bake_vat(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<AnimationGroupHandle>& groups) {
    MeshRecord& record = vat_mesh(engine, mesh.value);
    if (!record.skinned) {
        throw std::runtime_error(
            "bakeVat: the mesh has no skeleton to bake.");
    }
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
            engine.animation_groups[group.value];
        if (clip_record.asset >= engine.assets.size()) {
            throw std::runtime_error("bakeVat clip has no asset.");
        }
        const AssetRecord& asset = engine.assets[clip_record.asset];
        const float duration = asset.clip_duration
            ? asset.clip_duration(clip_record.clip)
            : 0.0f;
        const std::uint32_t frames =
            vat_clip_frames(duration, kVatDefaultFrameRate);
        frames_per_clip.push_back(frames);
        bake.clips.push_back(VatClipRow{
            clip_record.name,
            static_cast<double>(total_frames),
            static_cast<double>(frames),
            static_cast<double>(kVatDefaultFrameRate)});
        total_frames += frames;
    }
    bake.frame_count = std::max(1u, total_frames);
    // The bone count is the palette the pose pass writes this record: the
    // live path uploads it as a (bones * 4) x 1 texture, and the bake
    // stacks the same row once per frame.
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
    go_to_frame(engine, groups[0], 0.0f, true);
    bake.bone_count =
        static_cast<std::uint32_t>(record.bone_matrices.size());
    if (bake.bone_count == 0) {
        throw std::runtime_error(
            "bakeVat: the mesh published no bone palette to bake.");
    }
    const std::size_t floats_per_frame =
        static_cast<std::size_t>(bake.bone_count) * 16u;
    bake.data.assign(
        static_cast<std::size_t>(bake.frame_count) * floats_per_frame,
        0.0f);
    std::size_t row = 0;
    for (std::size_t index = 0; index < groups.size(); ++index) {
        const std::uint32_t frames = frames_per_clip[index];
        for (std::uint32_t frame = 0; frame < frames; ++frame) {
            go_to_frame(
                engine,
                groups[index],
                static_cast<float>(frame),
                true);
            if (record.bone_matrices.size() != bake.bone_count) {
                throw std::runtime_error(
                    "bakeVat: the mesh has inconsistent bone counts "
                    "across the clips being baked.");
            }
            for (std::size_t bone = 0; bone < bake.bone_count; ++bone) {
                std::copy_n(
                    record.bone_matrices[bone].data(),
                    16,
                    bake.data.data() + row * floats_per_frame + bone * 16);
            }
            ++row;
        }
        // prepareVatMany refuses three things per clip. Two are
        // reproduced: no palette at all (above) and a palette whose size
        // disagrees with the first clip's, which is the pin's
        // "inconsistent bone counts". The third, bindingOf returning
        // nothing -- a clip that drives no bone of THIS skeleton -- has no
        // counterpart here, because go_to_frame leaves the palette holding
        // the previous clip's pose rather than reporting that it wrote
        // nothing, and a stale palette is indistinguishable from a
        // deliberate one at this seam. A file whose clips each drive a
        // different skeleton would bake the wrong pose rather than refuse.
        // stopAnimation after each clip: the bake replaces live playback.
        stop_animation(engine, groups[index]);
    }
    engine.vat_bakes.push_back(std::move(bake));
    return VatBake{
        static_cast<std::uint32_t>(engine.vat_bakes.size() - 1)};
}

VatHandle attach_vat(
    Engine& engine,
    MeshHandle mesh,
    VatBake baked,
    const std::string& clip) {
    if (baked.value >= engine.vat_bakes.size()) {
        throw std::runtime_error("attachVat names no such bake.");
    }
    MeshRecord& record = vat_mesh(engine, mesh.value);
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
    const VatHandle handle{mesh.value};
    const VatBakeRecord& bake = engine.vat_bakes[baked.value];
    const std::string selected = clip.empty() && !bake.clips.empty()
        ? bake.clips[0].name
        : clip;
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
${options.instances ? `
void vat_set_instances(
    Engine& engine,
    VatHandle handle,
    const std::vector<float>& params) {
    VatData& vat = vat_data(engine, handle);
    // Single clip per instance (4 floats: fromRow, toRow, offset, fps)
    // expanded to the dual-clip layout (clip B == A, blend 0), so the one
    // instanced shader variant renders it.
    const std::size_t instances = params.size() / 4u;
    vat.instance_params.assign(instances * 8u, 0.0f);
    for (std::size_t index = 0; index < instances; ++index) {
        const std::size_t source = index * 4u;
        const std::size_t target = index * 8u;
        vat.instance_params[target] = params[source];
        vat.instance_params[target + 1] = params[source + 1];
        vat.instance_params[target + 2] = params[source + 2];
        vat.instance_params[target + 3] = params[source + 3];
        vat.instance_params[target + 4] = params[source];
        vat.instance_params[target + 5] = params[source + 1];
        vat.instance_params[target + 6] = 0.0f;
        vat.instance_params[target + 7] = params[source + 3];
    }
    // Always two texels per instance, and never fewer than two overall --
    // the pin's own texture floor.
    vat.instance_texels = static_cast<std::uint32_t>(
        std::max<std::size_t>(2u, instances * 2u));
    vat.instance_params.resize(
        static_cast<std::size_t>(vat.instance_texels) * 4u, 0.0f);
    vat.instance_version += 1;
}
` : ""}
VatClipRow vat_clip_row(
    Engine& engine,
    VatBake baked,
    const std::string& clip) {
    if (baked.value >= engine.vat_bakes.size()) return VatClipRow{};
    const VatClipRow* row =
        vat_clip(engine.vat_bakes[baked.value], clip);
    return row ? *row : VatClipRow{};
}

void seek_vat(Engine& engine, float seconds) {
    // The frozen pose scene 218 renders under ?seekTime: the clip is
    // played at the exact baked frame round(t * 60) with fps 0, so the row
    // is static and the clock contributes nothing. VAT bakes that very
    // pose at full precision, which is what makes the frozen native frame
    // the frozen browser frame.
    const double frame = bbl::js::round_js(
        static_cast<double>(seconds) *
        static_cast<double>(kVatDefaultFrameRate));
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
