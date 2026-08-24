import ts from "typescript";
import { LoweredSource, LoweringContext } from "../context.js";
import { gltfLoaderCpp } from "../templates/gltf-loader-cpp.js";
import {
    lowerAccessorNormalizationCpp,
    lowerVertexColorCpp,
} from "./accessor-normalization.js";
import {
    lowerAnimationInterpolationCpp,
} from "./animation-interpolation.js";
import { lowerGltfExtensionDefaults } from "./extension-defaults.js";
import { lowerGltfFactorBake } from "./factor-bake.js";
import {
    lowerIblEnvironmentScalarsCpp,
    lowerIblPolynomialCpp,
} from "./ibl.js";
import {
    lowerImageProcessingDefaultsCpp,
} from "./image-processing-defaults.js";
import { lowerGltfMaterialDefaults } from "./material-defaults.js";
import {
    lowerLocalMatrixCpp,
    lowerMatrixComposeCpp,
    lowerMatrixMultiplyCpp,
    lowerMatrixNativeCpp,
} from "./matrix-leaves.js";
import { lowerPunctualLightsCpp } from "./punctual-lights.js";
import { lowerSamplerMappingCpp } from "./sampler-mapping.js";
import { lowerShPrescaleCpp } from "./sh-prescale.js";

/**
 * What a scene's assets and reached features decide about the emitted
 * loader. Named rather than positional: the list grows with every asset
 * axis, and a caller that mis-counts booleans emits a loader for another
 * scene's shape.
 */
export interface GltfLoaderOptions {
    /** The scene reached `enableAnimationBlending` (the weighted mixer). */
    animationBlending?: boolean;
    /** The scene attaches this file's clips to its own manager. */
    managedGroups?: boolean;
    /** A composed skeleton variant carries the palette, lifting the
     *  transcribed 64-matrix cap. */
    pinnedSkeletonPalette?: boolean;
    nonTrianglePrimitives?: boolean;
    nodeVisibility?: boolean;
    animationPointer?: boolean;
    animatedWorldBounds?: boolean;
    animationPointerMaterials?: boolean;
    assetTransmission?: boolean;
    materialSpecular?: boolean;
    /** The `KHR_materials_variants` name a scene selected, or "". */
    selectedMaterialVariant?: string;
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
            header: `#pragma once

#include <bblite/ts_runtime.hpp>

#include <cstddef>

namespace bbl::upstream {

struct ParsedGlbContainer {
    ts::JsonValue json;
    std::size_t json_offset = 0;
    std::size_t json_length = 0;
    std::size_t bin_offset = 0;
    std::size_t bin_length = 0;
};

ParsedGlbContainer parse_glb_container(const ts::ArrayBuffer& buffer);

} // namespace bbl::upstream
`,
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

    /**
     * The weighted glTF skeleton mixer's own rules, asserted against the
     * pinned body the emitted C++ mirrors
     * (src/animation/weighted-gltf-mixer.ts). The emission lives in the
     * loader template because that is where the node array, the clips and
     * the skins are; what is pinned here is every decision it makes.
     */
    private assertWeightedGltfMixer(): void {
        const mixerModule =
            "src/animation/weighted-gltf-mixer.ts";
        const { declaration: update } =
            this.context.functionDeclaration(
                mixerModule,
                "updateWeightedGltfAnimations",
            );
        // Which groups make the mixer the handler for this tick, and the
        // early-out that hands an unqualified tick back.
        this.expectOneShape(
            update,
            "group._stopped || !mixer || (group.weight === 1 && !group._additive)",
            "weighted glTF qualifying skip",
        );
        this.expectOneShape(
            update,
            "keys.size === 0",
            "weighted glTF early-out",
        );
        const { declaration: accumulate } =
            this.context.functionDeclaration(
                mixerModule,
                "accumulateGroup",
            );
        // Translation and scale are weighted sums zeroed on the first
        // write to a node; rotation is an incremental slerp whose amount
        // is what makes the result independent of clip order.
        this.expectOneShape(
            accumulate,
            "target.tWeight[nodeIdx] === 0",
            "weighted glTF translation reset",
        );
        this.expectOneShape(
            accumulate,
            "target.sWeight[nodeIdx] === 0",
            "weighted glTF scale reset",
        );
        this.expectOneShape(
            accumulate,
            "target.trs[base + T_OFF] = target.trs[base + T_OFF] + scratch.sample[0] * weight",
            "weighted glTF translation sum",
        );
        this.expectOneShape(
            accumulate,
            "target.tWeight[nodeIdx] = target.tWeight[nodeIdx] + weight",
            "weighted glTF translation weight",
        );
        this.expectOneShape(
            accumulate,
            "weight / (accumulatedWeight + weight)",
            "weighted glTF rotation slerp amount",
        );
        this.expectOneShape(
            accumulate,
            "target.rWeight[nodeIdx] = accumulatedWeight + weight",
            "weighted glTF rotation weight",
        );
        // The mixer's own clip advance, which forks from the manager's
        // property one: it wraps only while the group plays.
        const { declaration: advance } =
            this.context.functionDeclaration(
                mixerModule,
                "advanceGroupTime",
            );
        this.expectOneShape(
            advance,
            "group.currentTime += (deltaMs / 1000) * group.speedRatio",
            "weighted glTF advance",
        );
        this.expectOneShape(
            advance,
            "group.loopAnimation && isPlaying",
            "weighted glTF loop guard",
        );
        this.expectOneShape(
            advance,
            "group.currentTime %= clip.duration",
            "weighted glTF loop wrap",
        );
        this.expectOneShape(
            advance,
            "group.currentTime = Math.min(Math.max(group.currentTime, 0), clip.duration)",
            "weighted glTF play-range clamp",
        );
        // A node the clips animate below full weight keeps the remainder
        // of its rest rotation.
        const { declaration: upload } =
            this.context.functionDeclaration(
                mixerModule,
                "uploadTarget",
            );
        // The fork itself: below one blends against the rest rotation,
        // at or above it renormalizes. The `else if` arm's own
        // `rotationWeight > 0` is the left half of this test, so pinning
        // the pair pins both branches.
        this.expectOneShape(
            upload,
            "rotationWeight > 0 && rotationWeight < 1",
            "weighted glTF partial-weight blend",
        );
    }

    /** Exactly one expression under `declaration` has this shape. */
    private expectOneShape(
        declaration: ts.Node,
        expected: string,
        label: string,
    ): void {
        const matches = this.context
            .findNodes(
                declaration,
                (node): node is ts.Expression =>
                    ts.isBinaryExpression(node) ||
                    ts.isPrefixUnaryExpression(node),
            )
            .filter((expression) =>
                this.context.expressionMatchesShape(
                    expression,
                    expected,
                ),
            );
        if (matches.length !== 1) {
            this.context.contractError(
                declaration,
                `Expected one ${label}.`,
            );
        }
    }

    public lowerLoaderAdapter(
        options: GltfLoaderOptions = {},
    ): LoweredSource {
        if (options.animationBlending) {
            this.assertWeightedGltfMixer();
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
        const dielectricModule =
            "src/loader-gltf/gltf-ext-dielectric.ts";
        const dielectric =
            this.context.sourceFile(dielectricModule);
        for (const property of [
            "KHR_materials_transmission",
            "KHR_materials_ior",
            "KHR_materials_volume",
            "attenuationDistance",
        ]) {
            if (
                !this.context.hasNode(
                    dielectric,
                    (node) =>
                        (ts.isIdentifier(node) ||
                            ts.isPropertyAccessExpression(node)) &&
                        (ts.isIdentifier(node)
                            ? node.text
                            : node.name.text) === property,
                )
            ) {
                this.context.contractError(
                    dielectric,
                    `Expected glTF dielectric property '${property}'.`,
                );
            }
        }
        // The sampler mapping and the keyframe interpolation used to pair
        // hand-written template C++ with assertions that never fed it — a
        // pin change failed the assertion while the stale text still
        // emitted. Both segments are now produced from the pinned ASTs, so
        // the assertion and the emission are the same walk: a changed
        // formula changes the emitted bytes, and a construct the lowering
        // cannot carry refuses generation.
        const samplerMapping = lowerSamplerMappingCpp(
            this.context.sourceFile(
                "src/loader-gltf/gltf-sampler-desc.ts",
            ),
        );
        const animationInterpolation =
            lowerAnimationInterpolationCpp(
                this.context.sourceFile(
                    "src/animation/evaluate.ts",
                ),
            );
        const quantization = this.context.sourceFile(
            "src/loader-gltf/gltf-ext-quantization.ts",
        );
        const accessorNormalization =
            lowerAccessorNormalizationCpp(quantization);
        const vertexColor = lowerVertexColorCpp(
            this.context.sourceFile(
                "src/loader-gltf/gltf-color-normalize.ts",
            ),
            quantization,
        );
        const assemblyFile = this.context.sourceFile(
            "src/loader-gltf/ibl-env-assembly.ts",
        );
        const imageBasedFile = this.context.sourceFile(
            "src/loader-gltf/gltf-ext-lights-image-based.ts",
        );
        const shPrescale = lowerShPrescaleCpp(
            assemblyFile,
            this.context.sourceFile(
                "src/loader-env/load-env.ts",
            ),
        );
        const imageProcessingDefaults =
            lowerImageProcessingDefaultsCpp(imageBasedFile);
        const extensionDefaults = lowerGltfExtensionDefaults(
            dielectric,
            this.context.sourceFile(
                "src/loader-gltf/gltf-ext-iridescence.ts",
            ),
        );
        const factorBake = lowerGltfFactorBake(
            this.context.sourceFile("src/math/color.ts"),
            this.context.sourceFile(
                "src/loader-gltf/gltf-pbr-builder.ts",
            ),
        );
        const materialDefaults = lowerGltfMaterialDefaults({
            material: this.context.sourceFile(
                "src/loader-gltf/gltf-material.ts",
            ),
            dielectric,
            uvTransform: this.context.sourceFile(
                "src/loader-gltf/gltf-ext-uv-transform.ts",
            ),
            uvTransformWriter: this.context.sourceFile(
                "src/material/pbr/fragments/uv-transform-fragment.ts",
            ),
            clearcoat: this.context.sourceFile(
                "src/loader-gltf/gltf-ext-clearcoat.ts",
            ),
            sheen: this.context.sourceFile(
                "src/loader-gltf/gltf-ext-sheen.ts",
            ),
            emissiveStrength: this.context.sourceFile(
                "src/loader-gltf/gltf-ext-emissive-strength.ts",
            ),
            specGloss: this.context.sourceFile(
                "src/loader-gltf/gltf-ext-spec-gloss.ts",
            ),
        });
        const parserFile = this.context.sourceFile(
            "src/loader-gltf/gltf-parser.ts",
        );
        const composeFile = this.context.sourceFile(
            "src/math/mat4-compose-into.ts",
        );
        const matrixMultiply = lowerMatrixMultiplyCpp(
            this.context.sourceFile(
                "src/math/mat4-multiply-into.ts",
            ),
        );
        const matrixLocal = lowerLocalMatrixCpp(
            parserFile,
            composeFile,
        );
        const matrixCompose = lowerMatrixComposeCpp(composeFile);
        const matrixNative = lowerMatrixNativeCpp(parserFile);
        const iblPolynomial = lowerIblPolynomialCpp(imageBasedFile);
        const iblEnvironmentScalars =
            lowerIblEnvironmentScalarsCpp(
                imageBasedFile,
                assemblyFile,
            );
        const punctualLightLoading = lowerPunctualLightsCpp(
            this.context.sourceFile(
                "src/loader-gltf/gltf-feature-lights-punctual.ts",
            ),
            this.context.sourceFile("src/light/spot-light.ts"),
            parserFile,
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
                    animationInterpolation,
                    samplerMapping,
                    accessorNormalization,
                    vertexColor,
                    shPrescale,
                    imageProcessingDefaults,
                    extensionDefaults,
                    materialDefaults,
                    factorBake,
                    matrixMultiply,
                    matrixLocal,
                    matrixCompose,
                    matrixNative,
                    iblPolynomial,
                    iblEnvironmentScalars,
                    punctualLightLoading,
                },
                options,
            ),
        };
    }
}
