import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { gltfLoaderCpp } from "./templates/gltf-loader-cpp.js";

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

    public lowerLoaderAdapter(): LoweredSource {
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
        const reflectance = this.context.findNodes(
            dielectric,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                this.context
                    .propertyPath(node.left)
                    ?.join(".") ===
                    "reflOpts.f0Factor",
        )[0];
        if (!reflectance) {
            this.context.contractError(
                dielectric,
                "Expected dielectric reflectance assignment.",
            );
        }
        this.context.assertExpressionShape(
            reflectance.right,
            "((ior - 1) / (ior + 1)) ** 2 / 0.04",
            "glTF dielectric reflectance",
        );

        const samplerModule =
            "src/loader-gltf/gltf-sampler-desc.ts";
        const { declaration: sampler } =
            this.context.functionDeclaration(
                samplerModule,
                "gltfTexSamplerDesc",
            );
        for (const [name, expected] of [
            [
                "minNearest",
                "!!minF && minF % 2 === 0",
            ],
            [
                "mipNearest",
                "minF === 9984 || minF === 9985",
            ],
            [
                "noMip",
                "minF === 9728 || minF === 9729",
            ],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(
                    sampler,
                    name,
                ),
                expected,
                `glTF sampler '${name}'`,
            );
        }
        const samplerResult =
            this.context.returnObject(sampler);
        const maxAnisotropy =
            this.context.propertyInitializer(
                samplerResult,
                "maxAnisotropy",
            );
        this.context.assertExpressionShape(
            maxAnisotropy,
            "magLinear && !minNearest && !mipNearest && !noMip ? 4 : 1",
            "glTF sampler anisotropy",
        );
        if (
            !this.context.hasNode(
                sampler,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    this.context.propertyName(node.name) ===
                        "lodMaxClamp" &&
                    ts.isNumericLiteral(node.initializer) &&
                    Number(node.initializer.text) === 0,
            )
        ) {
            this.context.contractError(
                sampler,
                "Expected non-mipmap LOD clamping.",
            );
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: gltfLoaderCpp(
                this.context.provenance(
                    modulePath,
                    symbolName,
                ),
            ),
        };
    }
}
