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
    /** The scene reached `setAnimationAdditive` (the additive arm). */
    animationAdditive?: boolean;
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
        this.expectShapeCount(declaration, expected, 1, label);
    }

    /** Exactly `count` expressions under `declaration` have this shape. */
    private expectShapeCount(
        declaration: ts.Node,
        expected: string,
        count: number,
        label: string,
    ): void {
        const matches = this.context
            .findNodes(
                declaration,
                (node): node is ts.Expression =>
                    ts.isBinaryExpression(node) ||
                    ts.isPrefixUnaryExpression(node) ||
                    ts.isCallExpression(node),
            )
            .filter((expression) =>
                this.context.expressionMatchesShape(
                    expression,
                    expected,
                ),
            );
        if (matches.length !== count) {
            this.context.contractError(
                declaration,
                `Expected ${count === 1 ? "one" : count} ${label}.`,
            );
        }
    }

    /**
     * The additive arm of the same mixer, asserted against
     * `accumulateAdditiveGroup` and its helpers: each channel sampled at
     * the clip time AND at the additive reference time, weighted T/S
     * difference accumulation on top of the base pose, and the rotation
     * rule — reference⁻¹ × sample multiplied onto the base before the
     * weighted slerp. The two gates the pin states around it — the
     * qualifying skip's `(weight === 1 && !_additive)` half (asserted
     * with the base mixer above) and the third-loop condition — decide
     * when the arm runs at all.
     */
    private assertAdditiveMixer(): void {
        const mixerModule =
            "src/animation/weighted-gltf-mixer.ts";
        const { declaration: update } =
            this.context.functionDeclaration(
                mixerModule,
                "updateWeightedGltfAnimations",
            );
        // The additive pass runs AFTER every base group accumulated, over
        // exactly the groups this condition selects.
        this.expectOneShape(
            update,
            "!group._stopped && group._additive && mixer && keys.has(mixer[GLTF_NODES])",
            "additive accumulation condition",
        );
        // In the accumulation loop an additive group only advances its
        // time and marks the target active; its channels contribute in
        // the later pass.
        const additiveAdvances = this.context
            .findNodes(
                update,
                (node): node is ts.IfStatement =>
                    ts.isIfStatement(node) &&
                    this.context.expressionMatchesShape(
                        node.expression,
                        "group._additive",
                    ),
            );
        if (
            additiveAdvances.length !== 1 ||
            !this.context.hasNode(
                additiveAdvances[0]!,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text ===
                        "advanceGroupTime",
            )
        ) {
            this.context.contractError(
                update,
                "Expected the additive advance-only arm.",
            );
        }
        const { declaration: accumulate } =
            this.context.functionDeclaration(
                mixerModule,
                "accumulateAdditiveGroup",
            );
        this.expectOneShape(
            accumulate,
            "!additive || weight === 0",
            "additive zero-weight skip",
        );
        // Translation and scale add the weighted difference between the
        // clip-time and reference-time samples onto whatever the base
        // pass left — no zeroing and no weight accumulation.
        this.expectOneShape(
            accumulate,
            "target.trs[base + T_OFF] = target.trs[base + T_OFF] + (scratch.sample[0] - scratch.reference[0]) * weight",
            "additive translation difference",
        );
        this.expectOneShape(
            accumulate,
            "target.trs[base + S_OFF] = target.trs[base + S_OFF] + (scratch.sample[0] - scratch.reference[0]) * weight",
            "additive scale difference",
        );
        // Each vector channel samples the reference pose beside the clip
        // pose; rotation samples both as quaternions.
        this.expectShapeCount(
            accumulate,
            "evaluateSampler(sampler, additive.referenceTime, 3, false, scratch.reference, 0)",
            2,
            "additive vector reference samples",
        );
        this.expectOneShape(
            accumulate,
            "evaluateSampler(sampler, additive.referenceTime, 4, true, scratch.reference, 0)",
            "additive rotation reference sample",
        );
        this.expectOneShape(
            accumulate,
            "quatRefInverseTimesSample(scratch.delta, scratch.reference, scratch.sample)",
            "additive rotation delta",
        );
        this.expectOneShape(
            accumulate,
            "applyAdditiveQuaternion(target.trs, base + R_OFF, scratch.delta, weight)",
            "additive rotation application",
        );
        // reference⁻¹ × sample: the conjugated reference on the left of
        // the Hamilton product, normalized before it blends.
        const { declaration: refInverse } =
            this.context.functionDeclaration(
                mixerModule,
                "quatRefInverseTimesSample",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                refInverse,
                "ax",
            ),
            "-ref[0]",
            "Additive reference conjugation",
        );
        this.expectOneShape(
            refInverse,
            "out[0] = aw * bx + ax * bw + ay * bz - az * by",
            "additive delta x row",
        );
        this.expectOneShape(
            refInverse,
            "out[3] = aw * bw - ax * bx - ay * by - az * bz",
            "additive delta w row",
        );
        if (
            !this.context.hasCall(
                refInverse,
                "normalizeQuaternionAt",
            )
        ) {
            this.context.contractError(
                refInverse,
                "Expected the additive delta to normalize.",
            );
        }
        // base × delta slerped onto the base by the weight — the whole
        // call is the contract, product rows included.
        const { declaration: applyAdditive } =
            this.context.functionDeclaration(
                mixerModule,
                "applyAdditiveQuaternion",
            );
        this.expectOneShape(
            applyAdditive,
            "quatSlerpInto(base, offset, bx, by, bz, bw, " +
                "bw * dx + bx * dw + by * dz - bz * dy, " +
                "bw * dy - bx * dz + by * dw + bz * dx, " +
                "bw * dz + bx * dy - by * dx + bz * dw, " +
                "bw * dw - bx * dx - by * dy - bz * dz, weight)",
            "additive base product slerp",
        );
    }

    public lowerLoaderAdapter(
        options: GltfLoaderOptions = {},
    ): LoweredSource {
        if (options.animationBlending) {
            this.assertWeightedGltfMixer();
        }
        if (options.animationAdditive) {
            this.assertAdditiveMixer();
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
        const matrixMultiply = lowerMatrixMultiplyCpp(this.context);
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
