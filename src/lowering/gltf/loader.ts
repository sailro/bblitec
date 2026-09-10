import ts from "typescript";
import { LoweredSource, LoweringContext } from "../context.js";
import { gltfLoaderCpp } from "../templates/gltf-loader-cpp.js";
import { lowerGltfAccessorShape } from "./accessor-shape.js";
import { lowerGltfHierarchy } from "./hierarchy.js";
import { lowerGltfParserJson } from "./parser-json.js";
import { lowerGltfMaterialAssembly } from "./material-assembly.js";
import { lowerGltfMaterialTextures } from "./material-textures.js";
import { lowerGltfMaterialProperties } from "./material-properties.js";
import { lowerGltfInverseBindMatrices } from "./skin-data.js";
import { lowerGltfAnimationNodeRest } from "./animation-node-rest.js";
import {gltfAnimationPoseStorageCpp} from "./animation-pose-storage.js";
import {lowerGltfAnimationPlayback} from "./animation-playback.js";
import {lowerGltfAnimationPose,lowerGltfAnimationRootFlip} from "./animation-pose.js";
import {lowerGltfAnimationEvaluator} from "./animation-evaluator.js";
import {lowerGltfAnimationBoneOverrides} from "./animation-bone-overrides.js";
import {lowerGltfAnimationGroupFactory} from "./animation-group-factory.js";
import {lowerGltfSkeletonPose} from "./skeleton-pose.js";
import {lowerGltfWeightedAnimationPasses} from "./weighted-animation-passes.js";
import {lowerGltfWeightedAnimationRuntime} from "./weighted-animation-runtime.js";
import {lowerGltfWeightedAnimationTargets} from "./weighted-animation-targets.js";
import {lowerGltfAnimationPointerWriters} from "./animation-pointer-writers.js";
import {gltfWeightedAnimationTransportCpp} from "./weighted-animation-transport.js";
import {lowerGltfAnimationMask} from "./animation-mask.js";
import {gltfAnimationPointerRuntimeCpp} from "./animation-pointer-runtime.js";
import {gltfAnimationPointerOwnersCpp} from "./animation-pointer-owners.js";
import {LightLowerer} from "../light-lowerer.js";
import {lowerGltfVatPlayback} from "./vat-playback.js";
import { gltfDeformationStateCpp } from "./deformation-state.js";
import {gltfAnimationBindingsCpp} from "./animation-bindings.js";
import {
    lowerAccessorNormalizationCpp,
} from "./accessor-normalization.js";

import { lowerGltfFactorBake } from "./factor-bake.js";
import {gltfIblLoadingCpp} from "./ibl.js";
import {lowerGltfAssetSceneSetup, gltfAssetSceneSetupOrder} from "./asset-scene-setup.js";
import {lowerGltfGaussianSplatSetup} from "./gaussian-splat-setup.js";
import {
    lowerMatrixComposeCpp,
    lowerMatrixNativeCpp,
} from "./matrix-leaves.js";
import { gltfMatrixReaderCpp } from "./local-matrix.js";
import { lowerBoneControl } from "./bone-control.js";
import { lowerGltfCamerasCpp } from "./cameras.js";
import { pinnedHeader } from "../pinned-header.js";

/**
 * What a scene's assets and reached features decide about the emitted
 * loader. Named rather than positional: the list grows with every asset
 * axis, and a caller that mis-counts booleans emits a loader for another
 * scene's shape.
 */
export interface GltfLoaderOptions {
    /** The scene reached `enableAnimationBlending` (the weighted mixer). */
    animationBlending?: boolean;
    /** The scene reached `setAnimationAdditive` (the additive arm). */
    animationAdditive?: boolean;
    /** The scene bakes a mesh's animation into a texture. Three writes in
     *  this loader exist only for the bake -- the per-record `skinned`
     *  flag the first-skinned search reads, the pose pass's skip for an
     *  already-baked mesh, and the clip duration `bakeVat` sizes rows
     *  from -- and none of the other scenes carrying this loader read
     *  any of them. */
    vat?: boolean;
    /**
     * A detailed pick draws this file's meshes through the pin's deform
     * vertex projection, which is the SKINNED arm alone: an animated
     * mesh with no skin carries its own world in `bone_matrices[0]` and
     * a zero weight quad, so the pin's blend would collapse it. That is
     * the second reader of the per-record `skinned` flag, and the reason
     * this widens the `vat`-only write above rather than replacing it.
     */
    deformPicking?: boolean;
    /** A composed skeleton variant carries the palette, lifting the
     *  transcribed 64-matrix cap. */
    pinnedSkeletonPalette?: boolean;
    /** Scene code can attach a thin-instance pool after a static glTF
     *  primitive was loaded, so retain that primitive's local vertices for
     *  the instanced draw path instead of reusing its baked world vertices. */
    dynamicThinInstances?: boolean;
    /** Detached mesh clones retain the source local attributes. */
    meshClones?: boolean;
    /** Node geometry views bind the source NORMAL attribute beside a real
     * world matrix, so retain it before the native bake/mirror/normalize. */
    retainLocalNormals?: boolean;
    /** Scene code reads the original public albedo Texture2D producer. */
    sourceTextureReads?: boolean;
    /** Hydrate source collector permutations observed on the pinned hierarchy. */
    sourceMeshWalks?: boolean;
    nonTrianglePrimitives?: boolean;
    /**
     * The asset carries Gaussian-splat clouds: packaging ran the pinned
     * `KHR_gaussian_splatting` hooks, so the document names row buffers
     * instead of the POINTS primitives they came from.
     */
    gaussianSplats?: boolean;
    /** The scene assigns an AnimationGroupMask to one of this file's groups. */
    animationMask?: boolean;
    nodeVisibility?: boolean;
    /**
     * An asset carries `KHR_interactivity` graphs, so the loader records
     * the per-node tables the generated flow graph's accessors and pointer
     * bridge read, and chains the container's flow-graph attach onto its
     * scene setup.
     */
    interactivity?: boolean;
    animationPointer?: boolean;
    animatedWorldBounds?: boolean;
    animationPointerMaterials?: boolean;
    /**
     * Any reached asset carries images the packager transcoded to a KTX1
     * container (`KHR_texture_basisu`). The loader then parses them through
     * the pin's own `parseKtx1` instead of handing bytes to an image codec.
     */
    compressedImages?: boolean;
    /** The `KHR_materials_variants` name a scene selected, or "". */
    selectedMaterialVariant?: string;
    /** The scene reached `enableGltfCameras` (the `_camera` feature). */
    gltfCameras?: boolean;
    /**
     * The scene reached `enableBoneControl`, so the loader builds the
     * skeletons the pin's own opt-in chunk builds and carries its eager
     * bake. Every other scene emits a loader with none of it.
     */
    boneControl?: boolean;
}

export class GltfLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerGlbParser(): LoweredSource {
        const modulePath = "src/loader-gltf/gltf-glb-parser.ts";
        const symbolName = "parseGlbContainer";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const inequalityConstant = (
            identifier: string,
        ): number => {
            const expression = this.context.findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.ExclamationEqualsEqualsToken &&
                    ts.isIdentifier(node.left) &&
                    node.left.text === identifier &&
                    ts.isNumericLiteral(node.right),
            )[0];
            if (!expression) {
                this.context.contractError(
                    declaration,
                    `Expected GLB '${identifier}' validation.`,
                );
            }
            return this.context.numericValue(
                expression.right,
                file,
            );
        };
        const magic = inequalityConstant("magic");
        const jsonType = inequalityConstant("jsonType");
        const binType = inequalityConstant("binType");
        const headerSize = this.context.numericValue(
            this.context.variableInitializer(
                declaration,
                "offset",
            ),
            file,
        );
        const hex = (value: number): string => `0x${value.toString(16)}`;
        return {
            modulePath,
            symbolName,
            header: pinnedHeader(["<bblite/ts_runtime.hpp>","","<cstddef>"], `
struct ParsedGlbContainer {
    ts::JsonValue json;
    std::size_t json_offset = 0;
    std::size_t json_length = 0;
    std::size_t bin_offset = 0;
    std::size_t bin_length = 0;
};

ParsedGlbContainer parse_glb_container(const ts::ArrayBuffer& buffer);
`),
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/gltf_glb_parser.hpp>

#include <stdexcept>
#include <string>

namespace bbl::upstream {

ParsedGlbContainer parse_glb_container(const ts::ArrayBuffer& buffer) {
    const ts::DataView view(buffer);
    if (view.get_uint32(0, true) != ${hex(magic)}) {
        throw std::runtime_error("Not a valid GLB file");
    }
    std::size_t offset = ${headerSize};
    const std::size_t json_length = view.get_uint32(offset, true);
    if (view.get_uint32(offset + 4, true) != ${hex(jsonType)}) {
        throw std::runtime_error("First GLB chunk is not JSON");
    }
    const std::size_t json_offset = offset + 8;
    ts::Uint8Array json_bytes(buffer, json_offset, json_length);
    std::string json_string = ts::TextDecoder{}.decode(json_bytes);
    while (!json_string.empty() && (json_string.back() == '\\0' || json_string.back() == ' ')) {
        json_string.pop_back();
    }
    ts::JsonValue json = ts::json_parse(json_string);
    offset += 8 + json_length;
    const std::size_t bin_length = view.get_uint32(offset, true);
    if (view.get_uint32(offset + 4, true) != ${hex(binType)}) {
        throw std::runtime_error("Second GLB chunk is not BIN");
    }
    const std::size_t bin_offset = offset + 8;
    if (json_offset + json_length > buffer.byte_length() || bin_offset + bin_length > buffer.byte_length()) {
        throw std::runtime_error("Truncated GLB chunk.");
    }
    return ParsedGlbContainer{std::move(json), json_offset, json_length, bin_offset, bin_length};
}

} // namespace bbl::upstream
`,
        };
    }

    /** Source loader bodies and their native storage adapters. */
    public lowerLoaderAdapter(
        options: GltfLoaderOptions = {},
    ): LoweredSource {
        if (options.retainLocalNormals) {
            const { declaration } = this.context.functionDeclaration(
                "src/loader-gltf/load-gltf.ts", "buildTightGltfMesh");
            const data = declaration.parameters[1]?.name;
            if (!data || !ts.isIdentifier(data) || !this.context.hasNode(
                declaration,
                node => {
                    if (!ts.isPropertyAssignment(node) ||
                        !ts.isIdentifier(node.name) || node.name.text !== "normalBuffer") return false;
                    const call = this.context.unwrapExpression(node.initializer);
                    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) ||
                        call.expression.text !== "createMappedBuffer") return false;
                    const argument = call.arguments[1];
                    if (!argument) return false;
                    const values = this.context.unwrapExpression(argument);
                    return ts.isPropertyAccessExpression(values) &&
                        ts.isIdentifier(values.expression) && values.expression.text === data.text &&
                        values.name.text === "_normals";
                },
            )) {
                this.context.contractError(declaration,
                    "Expected the glTF normal buffer to upload source _normals without transformation.");
            }
        }
        const modulePath = "src/loader-gltf/load-gltf.ts";
        const symbolName = "loadGltf";
        const { declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        for (const call of [
            "fetchGltfAsset",
            "loadGltfFeatures",
        ]) {
            if (!this.context.hasCall(declaration, call)) {
                this.context.contractError(
                    declaration,
                    `Expected glTF loader call '${call}'.`,
                );
            }
        }
        const animationModule =
            "src/loader-gltf/gltf-animation.ts";
        for (const importedName of [
            "INTERP_CUBICSPLINE",
            "PATH_TRANSLATION",
            "PATH_ROTATION",
            "PATH_WEIGHTS",
        ]) {
            if (
                !this.context.hasNamedImport(
                    animationModule,
                    importedName,
                )
            ) {
                this.context.contractError(
                    this.context.sourceFile(animationModule),
                    `Expected glTF animation import '${importedName}'.`,
                );
            }
        }
        const { declaration: extractSkin } =
            this.context.functionDeclaration(
                animationModule,
                "extractSkin",
            );
        if (
            !this.context.hasNode(
                extractSkin,
                (node) =>
                    ts.isIdentifier(node) &&
                    node.text === "inverseBindMatrices",
            )
        ) {
            this.context.contractError(
                extractSkin,
                "Expected inverse-bind-matrix extraction.",
            );
        }
        this.context.functionDeclaration(
            animationModule,
            "computeBoneTextureData",
        );

        const skeletonModule =
            "src/loader-gltf/gltf-feature-skeleton.ts";
        const skeletonFile =
            this.context.sourceFile(skeletonModule);
        for (const call of [
            "computeBoneTextureData",
            "createSkeleton",
        ]) {
            if (
                !this.context.hasNode(
                    skeletonFile,
                    (node) =>
                        ts.isCallExpression(node) &&
                        ((ts.isIdentifier(node.expression) &&
                            node.expression.text === call) ||
                            (ts.isPropertyAccessExpression(
                                node.expression,
                            ) &&
                                node.expression.name.text ===
                                    call)),
                )
            ) {
                this.context.contractError(
                    skeletonFile,
                    `Expected glTF skeleton call '${call}'.`,
                );
            }
        }
        const quantization = this.context.sourceFile(
            "src/loader-gltf/gltf-ext-quantization.ts",
        );
        const accessorNormalization =
            lowerAccessorNormalizationCpp(quantization);
        const accessorShape = lowerGltfAccessorShape(this.context);
        const factorBake = lowerGltfFactorBake(this.context.sourceFile("src/math/color.ts"));
        const parserFile = this.context.sourceFile(
            "src/loader-gltf/gltf-parser.ts",
        );
        const composeFile = this.context.sourceFile(
            "src/math/mat4-compose-into.ts",
        );
        const matrixLocal = gltfMatrixReaderCpp();
        const matrixCompose = lowerMatrixComposeCpp(composeFile,true);
        const matrixNative = lowerMatrixNativeCpp(parserFile);
        const gltfCameras = options.gltfCameras
            ? lowerGltfCamerasCpp(parserFile)
            : { parentWriter: "", loading: "", poseRefresh: "" };
        const boneControl = options.boneControl
            ? lowerBoneControl(this.context)
            : { loading: "", entryPoints: "" };
        // The refraction fragment's thickness scale the loader pre-bakes
        // into record.baked_world_scale (gltf-loader-cpp.ts): the pinned
        // read must stay the mesh world's longest basis column.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.functionDeclaration(
                    "src/material/pbr/fragments/refraction-rtt-fragment.ts",
                    "makeRefractionMod",
                ).declaration,
                "thicknessScaleLine",
            ),
            "hasVolume || hasThicknessMap ? `let ts=max(length(mesh.world[0].xyz),max(length(mesh.world[1].xyz),length(mesh.world[2].xyz)));` : ``",
            "Pinned refraction thickness scale",
        );
        return {
            modulePath,
            symbolName,
            header: "",
            source: gltfLoaderCpp(
                this.context.provenance(
                    modulePath,
                    symbolName,
                ),
                {
                    animationStorage: gltfAnimationPoseStorageCpp(),
                    animationMask: options.animationMask ? lowerGltfAnimationMask(this.context) : "",
                    animationPlayback: lowerGltfAnimationPlayback(this.context,options.animationBlending===true)+(options.vat?lowerGltfVatPlayback(this.context):""),
                    animationPose: lowerGltfAnimationPose(this.context),
                    animationEvaluator: lowerGltfAnimationEvaluator(this.context),
                    animationRootFlip: lowerGltfAnimationRootFlip(this.context),
                    animationBoneOverrides: lowerGltfAnimationBoneOverrides(this.context,{visibilityOnly:true}),
                    animationFactory: lowerGltfAnimationGroupFactory(this.context)+(options.boneControl?lowerGltfSkeletonPose(this.context):""),
                    animationWeighted: options.animationBlending ? lowerGltfWeightedAnimationRuntime(this.context)+lowerGltfWeightedAnimationPasses(this.context)+lowerGltfWeightedAnimationTargets(this.context):"",
                    animationWeightedTransport: options.animationBlending ? gltfWeightedAnimationTransportCpp(lowerGltfAnimationRootFlip(this.context,"src/animation/weighted-gltf-mixer.ts")) : {types:"",dispatcher:"bool update_weighted_gltf_animation_groups(Engine&,PropertyAnimationManagerRecord&,double){return false;}"},
                    animationPointers: options.animationPointer ? lowerGltfAnimationPointerWriters(this.context).source+gltfAnimationPointerOwnersCpp+gltfAnimationPointerRuntimeCpp()+new LightLowerer(this.context).lowerSpotAngleSetter() : "",
                    accessorNormalization,
                    accessorShape,
                    hierarchy: lowerGltfHierarchy(this.context),
                    parserJson: lowerGltfParserJson(this.context),
                    inverseBindMatrices: lowerGltfInverseBindMatrices(this.context),
                    animationNodeRest: lowerGltfAnimationNodeRest(this.context),
                    deformationState: gltfDeformationStateCpp(options.deformPicking === true),
                    animationBindings: gltfAnimationBindingsCpp(),
                    materialAssembly: lowerGltfMaterialAssembly(this.context),
                    materialTextures: lowerGltfMaterialTextures(this.context),
                    materialProperties: lowerGltfMaterialProperties(this.context).source,
                    iblLoading: gltfIblLoadingCpp(),
                    assetSceneSetup: lowerGltfAssetSceneSetup(this.context),
                    gaussianSplatSetup: options.gaussianSplats ? lowerGltfGaussianSplatSetup(this.context) : "",
                    assetSceneSetupOrder: gltfAssetSceneSetupOrder(this.context, options.gaussianSplats === true, options.interactivity === true),
                    factorBake,
                    matrixLocal,
                    matrixCompose,
                    matrixNative,
                    gltfCameraParentWriter: gltfCameras.parentWriter,
                    gltfCameraLoading: gltfCameras.loading,
                    gltfCameraPoseRefresh: gltfCameras.poseRefresh,
                    boneControlLoading: boneControl.loading,
                    boneControlEntryPoints: boneControl.entryPoints,
                },
                options,
            ),
        };
    }
}
