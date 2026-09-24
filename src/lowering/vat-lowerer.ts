import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { lowerGltfVatBinding } from "./gltf/vat-binding.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { recordAt } from "../compiler/record-access.js";

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
        this.assertInventory(clipFrameCount, "clipFrameCount", [
            "variable statement",
            "return statement",
        ]);
        const frameCountReturn = this.context.findNodes(
            clipFrameCount,
            (node): node is ts.ReturnStatement => ts.isReturnStatement(node),
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
                (options.instances ? ",VatHandle.setInstances" : ""),
            header: "",
            source: `// ${this.context.provenance(
                VAT_MODULE,
                "bakeVat, prepareVatMany, attachVat, and the VatHandle writers",
            )}
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace bbl {
namespace {

constexpr float kVatDefaultFrameRate = ${this.context.floatLiteral(
                defaultFrameRate,
            )};

${lowerGltfVatBinding(this.context)}

MeshRecord& vat_mesh(Engine& engine, MeshHandle mesh) {
    return ${recordAt("engine.meshes", "mesh")};
}

VatData& vat_data(Engine& engine, VatHandle handle) {
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
    bake.data.assign(
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
                    bake.data.data() + row * floats_per_frame + bone * 16);
            }
            ++row;
        }
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
${options.instances ? this.lowerSetInstances() : ""}
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
            texels.declarationList.declarations[0]!.name.getText(file) !==
                "texels"
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
            calls: pinnedNumericMathCalls(),
        });
        const expand = lowerPinnedBody(file, setInstances.body.statements, {
            bindings: new Map(params),
            calls: new Map([
                ...pinnedNumericMathCalls(),
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
