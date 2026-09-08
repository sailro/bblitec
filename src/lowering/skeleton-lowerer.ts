import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

const CREATE_MODULE = "src/skeleton/create-skeleton.ts";
const UPDATE_MODULE = "src/skeleton/update-skeleton-bone-matrices.ts";

/**
 * The scene-authored skeleton (`src/skeleton/create-skeleton.ts` and
 * `src/skeleton/update-skeleton-bone-matrices.ts`).
 *
 * Upstream this pair is pure resource plumbing: `createSkeleton` allocates
 * the rgba32float bone-palette texture (four texels per bone, one mat4
 * column each), uploads the caller's matrices into it, widens the joint
 * indices to u32 and maps the two per-vertex buffers the skinning fragment
 * declares; `updateSkeletonBoneMatrices` mirrors a new pose into the
 * skeleton's own array and re-uploads the same row. There is no arithmetic
 * to port beyond the texture's shape, and that shape is already stated once
 * natively by `bone_palette_layout`, which both backends size their palette
 * from.
 *
 * What this lowerer emits is therefore the OWNERSHIP half: the per-vertex
 * joint/weight streams folded into the mesh's own vertex records, the
 * palette copied onto every mesh record the skeleton was assigned to, and
 * the two mesh-record marks (`gpu_deformation`, `pinned_bone_palette`) that
 * put the draw on the pin's own skinned arm. The upload itself is the
 * PAL's, unchanged: both backends already stream `MeshRecord::bone_matrices`
 * into the palette texture every frame, which is what makes an update as
 * live here as the pin's own `writeTexture` is there.
 *
 * The contract assertions below are what keeps that reading honest: if the
 * pin stops taking the palette from its caller, stops widening joints to
 * u32, or stops refusing a mismatched update, generation fails instead of
 * shipping a skeleton whose semantics moved.
 */
export class SkeletonLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lower(): LoweredSource {
        this.assertCreateContract();
        this.assertUpdateContract();
        return {
            modulePath: CREATE_MODULE,
            symbolName: "createSkeleton,updateSkeletonBoneMatrices",
            header: "",
            source: `// ${this.context.provenance(
                CREATE_MODULE,
                "createSkeleton",
                `${UPDATE_MODULE}#updateSkeletonBoneMatrices`,
            )}
#include <bblite/runtime.hpp>

#include <cstddef>
#include <stdexcept>

namespace bbl {
namespace {

SceneSkeletonRecord& scene_skeleton_record(
    Engine& engine,
    SceneSkeletonHandle skeleton) {
    if (skeleton.value >= engine.scene_skeletons.size()) {
        throw std::runtime_error(
            "SceneSkeletonHandle names no such skeleton.");
    }
    return engine.scene_skeletons[skeleton.value];
}

// The pin stores the caller's Float32Array as skeleton.boneMatrices and
// uploads it as one rgba32float row of boneCount*4 texels, so the array it
// was handed IS the palette. Reading it as mat4 rows here is the same
// bytes; bone_palette_layout states the row shape for both backends.
// Both callers check the length first, each with its own refusal: the pin
// has one message for a bad creation and another for a bad pose.
std::vector<std::array<float, 16>> scene_bone_palette(
    const std::vector<float>& bone_data,
    std::size_t bone_count) {
    std::vector<std::array<float, 16>> palette(bone_count);
    for (std::size_t bone = 0; bone < bone_count; ++bone) {
        for (std::size_t lane = 0; lane < 16; ++lane) {
            palette[bone][lane] = bone_data[bone * 16 + lane];
        }
    }
    return palette;
}

void publish_scene_palette(
    Engine& engine,
    const SceneSkeletonRecord& skeleton) {
    for (const MeshHandle mesh : skeleton.meshes) {
        if (mesh.value >= engine.meshes.size()) continue;
        engine.meshes[mesh.value].bone_matrices = skeleton.bone_matrices;
        ++engine.meshes[mesh.value].bone_matrices_version;
    }
}

}  // namespace

SceneSkeletonHandle create_scene_skeleton(
    Engine& engine,
    const std::vector<std::uint16_t>& joints,
    const std::vector<float>& weights,
    double bone_count,
    const std::vector<float>& bone_data) {
    // The palette is one texture row of boneCount*4 rgba32float texels, so
    // the count is bounded by what a row can hold as well as by being a
    // whole positive number. The upper bound is what makes the cast below
    // defined for every double a scene can pass.
    if (
        !(bone_count >= 1.0 && bone_count <= 65536.0) ||
        bone_count != static_cast<double>(
            static_cast<std::uint32_t>(bone_count))) {
        throw std::runtime_error(
            "createSkeleton needs a whole bone count between 1 and 65536.");
    }
    const std::uint32_t bones =
        static_cast<std::uint32_t>(bone_count);
    if (joints.size() != weights.size()) {
        throw std::runtime_error(
            "createSkeleton takes four joint indices and four weights "
            "per vertex, so the two streams have one length.");
    }
    if (joints.size() % 4 != 0) {
        throw std::runtime_error(
            "createSkeleton takes four joint indices per vertex.");
    }
    if (bone_data.size() != static_cast<std::size_t>(bones) * 16) {
        throw std::runtime_error(
            "A scene skeleton's bone matrices must hold 16 floats per "
            "bone: the palette row the pinned skinning stage samples is "
            "boneCount*4 rgba32float texels wide.");
    }
    SceneSkeletonRecord record;
    record.joints = joints;
    record.weights = weights;
    record.bone_count = bones;
    record.bone_matrices = scene_bone_palette(bone_data, bones);
    engine.scene_skeletons.push_back(std::move(record));
    return SceneSkeletonHandle{
        static_cast<std::uint32_t>(engine.scene_skeletons.size() - 1)};
}

void attach_scene_skeleton(
    Engine& engine,
    MeshHandle mesh,
    SceneSkeletonHandle skeleton) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error(
            "mesh.skeleton names no such mesh.");
    }
    SceneSkeletonRecord& record =
        scene_skeleton_record(engine, skeleton);
    MeshRecord& mesh_record = engine.meshes[mesh.value];
    if (
        mesh_record.geometry == invalid_handle ||
        mesh_record.geometry >= engine.geometries.size()) {
        throw std::runtime_error(
            "A scene skeleton needs mesh geometry to skin.");
    }
    ModelGeometry& geometry =
        engine.geometries[mesh_record.geometry];
    if (record.joints.size() != geometry.vertices.size() * 4) {
        throw std::runtime_error(
            "A scene skeleton's joint and weight streams must carry "
            "four entries per mesh vertex.");
    }
    for (
        std::size_t vertex = 0;
        vertex < geometry.vertices.size();
        ++vertex) {
        ModelVertex& target = geometry.vertices[vertex];
        for (std::size_t lane = 0; lane < 4; ++lane) {
            target.joints[lane] = record.joints[vertex * 4 + lane];
        }
        target.weights = Vec4{
            record.weights[vertex * 4],
            record.weights[vertex * 4 + 1],
            record.weights[vertex * 4 + 2],
            record.weights[vertex * 4 + 3],
        };
    }
    // The pin's own mesh.skeleton assignment reaches three things at once:
    // the mesh composes under MSH_HAS_SKELETON (generation's half), its
    // draw binds the skeleton's palette texture, and its vertex stage
    // reads the joint and weight streams above. These three marks are
    // this port's spelling of that: deformation on, the palette carried
    // by the pin's own per-bone texture rather than the transcribed
    // 64-matrix block, and the world composed at the draw rather than
    // baked into the vertices.
    mesh_record.gpu_deformation = true;
    mesh_record.pinned_bone_palette = true;
    mesh_record.skinned = true;
    mesh_record.scene_skeleton = true;
    mesh_record.bone_matrices = record.bone_matrices;
    ++mesh_record.bone_matrices_version;
    ++mesh_record.transform_version;
    record.meshes.push_back(mesh);
}

void update_scene_skeleton_bone_matrices(
    Engine& engine,
    SceneSkeletonHandle skeleton,
    const std::vector<float>& bone_data) {
    SceneSkeletonRecord& record =
        scene_skeleton_record(engine, skeleton);
    // The pin refuses a pose of a different length rather than uploading
    // a short row, and its own palette length is boneCount*16.
    if (bone_data.size() != record.bone_matrices.size() * 16) {
        throw std::runtime_error(
            "updateSkeletonBoneMatrices was given a pose of a different "
            "length than the skeleton was created with.");
    }
    record.bone_matrices =
        scene_bone_palette(bone_data, record.bone_count);
    publish_scene_palette(engine, record);
}

}  // namespace bbl
`,
        };
    }

    /**
     * `createSkeleton` still takes its palette from the caller and still
     * widens the joint indices for the uint32x4 vertex format.
     *
     * Both are load-bearing here. The palette is what this port copies onto
     * the mesh record instead of into a texture of its own, and the u32
     * widening is why `GpuVertex::joint_indices` exists beside the float
     * lane the transcribed stage reads.
     */
    private assertCreateContract(): void {
        const { declaration } = this.context.functionDeclaration(
            CREATE_MODULE,
            "createSkeleton",
        );
        const parameters = declaration.parameters.map((parameter) =>
            ts.isIdentifier(parameter.name) ? parameter.name.text : "",
        );
        const expected = [
            "engine",
            "joints",
            "weights",
            "boneCount",
            "boneData",
        ];
        for (let index = 0; index < expected.length; index += 1) {
            if (parameters[index] !== expected[index]) {
                this.context.contractError(
                    declaration,
                    `Expected createSkeleton parameter ${index} to be ` +
                        `'${expected[index]}', found ` +
                        `'${parameters[index] ?? "none"}'.`,
                );
            }
        }
        const returned = this.context.returnObject(declaration);
        this.context.assertExpressionShape(
            this.context.propertyInitializer(returned, "boneMatrices"),
            "boneData",
            "createSkeleton bone palette",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "texWidth"),
            "boneCount * 4",
            "createSkeleton bone texture width",
        );
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isNewExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "U32",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected createSkeleton to widen its joint indices to " +
                    "u32 for the uint32x4 vertex format.",
            );
        }
    }

    /**
     * `updateSkeletonBoneMatrices` still refuses a differently sized pose
     * and still mirrors the caller's array into the skeleton's own before
     * uploading, which is why copying here loses nothing: nothing reaches
     * the GPU between the mirror and the upload.
     */
    private assertUpdateContract(): void {
        const { declaration } = this.context.functionDeclaration(
            UPDATE_MODULE,
            "updateSkeletonBoneMatrices",
        );
        const lengthCheck = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement => ts.isIfStatement(node),
        );
        if (lengthCheck.length < 2) {
            this.context.contractError(
                declaration,
                "Expected updateSkeletonBoneMatrices to keep its disposed " +
                    "and length guards.",
            );
        }
        this.context.assertExpressionShape(
            lengthCheck[1]!.expression,
            "boneMatrices.length !== skeleton.boneMatrices.length",
            "updateSkeletonBoneMatrices pose length guard",
        );
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "set",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected updateSkeletonBoneMatrices to mirror the pose " +
                    "into the skeleton's own array.",
            );
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "textureWidth"),
            "skeleton.boneMatrices.length / 4",
            "updateSkeletonBoneMatrices palette width",
        );
    }
}
