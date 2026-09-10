import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { lowerBabylonCamera } from "./babylon-camera.js";
import { lowerBabylonMaterialProperties } from "./babylon-material.js";
import { lowerBabylonTextureSlots } from "./babylon-textures.js";
import { lowerBabylonCubeTexture } from "./babylon-cube-texture.js";
import { lowerBabylonSubmeshDefaults } from "./babylon-submesh-indices.js";
import { lowerBabylonHierarchy } from "./babylon-hierarchy.js";
import { lowerBabylonMeshConstruction } from "./babylon-mesh-construction.js";
import { lowerBabylonSceneData } from "./babylon-scene-data.js";
import { lowerBabylonMaterialMaps } from "./babylon-material-maps.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { loadTexture2DUploadCpp } from "../pinned-address-modes.js";
import { babylonLoaderCpp } from "./templates/babylon-loader-cpp.js";

export class BabylonLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerLoaderAdapter(
        lightMeshLists = false,
        meshClones = false,
    ): LoweredSource {
        const modulePath = "src/loader-babylon/load-babylon.ts";
        const symbolName = "loadBabylon";
        const { declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        for (const call of [
            "createStandardMaterial",
            "parseBabylonCamera",
        ]) {
            if (!this.context.hasCall(declaration, call)) {
                this.context.contractError(
                    declaration,
                    `Expected loader call '${call}'.`,
                );
            }
        }
        if (
            !this.context.hasNode(
                declaration,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken &&
                    ts.isPropertyAccessExpression(node.left) &&
                    ts.isIdentifier(node.left.expression) &&
                    node.left.expression.text === "md" &&
                    node.left.name.text === "subMeshes",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected null-safe Babylon submesh handling.",
            );
        }
        const hasEntitySpread = (name: string): boolean =>
            this.context.hasNode(
                declaration,
                (node) =>
                    ts.isPropertyAssignment(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "entities" &&
                    ts.isArrayLiteralExpression(
                        node.initializer,
                    ) &&
                    node.initializer.elements.some(
                        (element) =>
                            ts.isSpreadElement(element) &&
                            ts.isIdentifier(
                                element.expression,
                            ) &&
                            element.expression.text === name,
                    ),
            );
        for (const name of ["lights", "rootMeshes"]) {
            if (!hasEntitySpread(name)) {
                this.context.contractError(
                    declaration,
                    `Expected '${name}' in returned entities.`,
                );
            }
        }
        const upload = loadTexture2DUploadCpp({}, message => this.context.contractError(declaration, message));
        return {
            modulePath,
            symbolName,
            header: "",
            source: babylonLoaderCpp(
                this.context.provenance(modulePath, symbolName),
                lowerBabylonCamera(this.context),
                { bakeLocalMatrix: this.lowerLocalMatrixBake(), materialProperties: lowerBabylonMaterialProperties(this.context),
                    textureSlots: lowerBabylonTextureSlots(this.context), cubeTexture: lowerBabylonCubeTexture(this.context),
                    submeshDefaults: lowerBabylonSubmeshDefaults(this.context),
                    hierarchy: lowerBabylonHierarchy(this.context),
                    meshConstruction: lowerBabylonMeshConstruction(this.context),
                    sceneData: lowerBabylonSceneData(this.context, lightMeshLists),
                    materialMaps: lowerBabylonMaterialMaps(this.context),
                    fileTextureLoad: `load_file_texture(engine, path, ${upload.sampler}, ${upload.invertY}, ${upload.srgb}, ${upload.premultiplyAlpha})` },
                lightMeshLists,
                meshClones,
            ),
        };
    }

    /**
     * `bakeLocalMatrix` translated whole: the pin's pivot bake over the
     * Float32Array attributes it is about to upload, at JavaScript-number
     * width with one rounding per store, and the normal renormalization
     * behind its own length guard. Mesh construction lowers its call site.
     */
    private lowerLocalMatrixBake(): string {
        return lowerPinnedFunction(
            this.context,
            "src/loader-babylon/bake-local-matrix.ts",
            "bakeLocalMatrix",
            [
                { pinned: "positions", kind: "f32Buffer", cpp: "positions" },
                { pinned: "normals", kind: "f32Buffer", cpp: "normals" },
                {
                    pinned: "lm",
                    kind: "numberList",
                    cpp: "lm",
                    cppType: "std::array<double, 16>",
                },
            ],
            {
                cppName: "bake_local_matrix",
                returns: "void",
                calls: pinnedNumericMathCalls(),
                booleanAnd: true,
            },
        );
    }

}
