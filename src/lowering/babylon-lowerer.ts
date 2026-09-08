import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    lowerObjectComponents,
    lowerPinnedFunction,
} from "./pinned-function-lowerer.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { babylonLoaderCpp } from "./templates/babylon-loader-cpp.js";

export class BabylonLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerLoaderAdapter(
        lightMeshLists = false,
        diffuseUv2 = false,
        bumpTexture = false,
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
        const diffuseAssignment = this.context.findNodes(declaration,
            (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) &&
                this.context.expressionMatchesShape(node.left, "mat.diffuseColor"));
        if (diffuseAssignment.length !== 1) this.context.contractError(declaration, "Expected one Babylon diffuse-color assignment.");
        this.context.assertExpressionShape(diffuseAssignment[0]!,
            "mat.diffuseColor = [md.diffuse[0], md.diffuse[1], md.diffuse[2]]", "Babylon copies RGB into its own array");
        const diffuseGuard = diffuseAssignment[0]!.parent.parent.parent;
        if (!ts.isIfStatement(diffuseGuard)) this.context.contractError(diffuseAssignment[0]!, "Expected the optional Babylon diffuse-color guard.");
        this.context.assertExpressionShape(diffuseGuard.expression, "md.diffuse", "Babylon diffuse-color presence");
        const standard = this.context.functionDeclaration("src/material/standard/create-standard-material.ts", "createStandardMaterial").declaration;
        this.context.assertExpressionShape(this.context.propertyInitializer(this.context.returnObject(standard), "diffuseColor"),
            "[1, 1, 1]", "Standard factory RGB defaults");
        const textureLoads = this.context.findNodes(declaration, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.getText() === "texturePromises.push" && this.context.hasCall(node, "loadTexture2D"));
        if (textureLoads.length !== 1) this.context.contractError(declaration, "Expected one per-slot Texture2D publication path.");
        this.context.assertExpressionShape(textureLoads[0]!,
            "texturePromises.push(loadTexture2D(engine, texUrl).then((tex) => slot.set(mat, tex)))",
            "Babylon material retains each fresh texture factory result");
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
        // The record naming the template emits:
        // `md.name + (subMeshes.length > 1 ? \`_sub${sub.materialIndex}\` : "")`.
        // The suffix flows; the split condition and the interpolated
        // material index are asserted because the emitted C++ hardcodes
        // both.
        const nameAssignment = this.context
            .findNodes(
                declaration,
                (node): node is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "name" &&
                    ts.isBinaryExpression(node.initializer) &&
                    node.initializer.operatorToken.kind ===
                        ts.SyntaxKind.PlusToken &&
                    this.context
                        .propertyPath(node.initializer.left)
                        ?.join(".") === "md.name",
            )[0];
        if (!nameAssignment) {
            this.context.contractError(
                declaration,
                "Expected the pinned submesh naming off md.name.",
            );
        }
        const suffixSelect = this.context.unwrapExpression(
            (nameAssignment.initializer as ts.BinaryExpression).right,
        );
        if (!ts.isConditionalExpression(suffixSelect)) {
            this.context.contractError(
                nameAssignment,
                "Expected the submesh suffix behind a split test.",
            );
        }
        this.context.assertExpressionShape(
            suffixSelect.condition,
            "subMeshes.length > 1",
            "Babylon submesh-split condition",
        );
        const suffixTemplate = this.context.unwrapExpression(
            suffixSelect.whenTrue,
        );
        const suffixEmptyArm = this.context.unwrapExpression(
            suffixSelect.whenFalse,
        );
        if (
            !ts.isTemplateExpression(suffixTemplate) ||
            suffixTemplate.templateSpans.length !== 1 ||
            suffixTemplate.templateSpans[0]!.literal.text !== "" ||
            this.context
                .propertyPath(
                    suffixTemplate.templateSpans[0]!.expression,
                )
                ?.join(".") !== "sub.materialIndex" ||
            !ts.isStringLiteral(suffixEmptyArm) ||
            suffixEmptyArm.text !== ""
        ) {
            this.context.contractError(
                suffixSelect,
                "Expected the suffix to interpolate exactly sub.materialIndex after a literal prefix.",
            );
        }
        const submeshNameSuffix = suffixTemplate.head.text;
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
        this.assertMeshTransformArguments(declaration);
        return {
            modulePath,
            symbolName,
            header: "",
            source: babylonLoaderCpp(
                this.context.provenance(modulePath, symbolName),
                this.lowerCameraDerivation(),
                submeshNameSuffix,
                { bakeLocalMatrix: this.lowerLocalMatrixBake(declaration) },
                lightMeshLists,
                diffuseUv2,
                bumpTexture,
                meshClones,
            ),
        };
    }

    /**
     * The TRS the pinned loader hands `initMeshTransform` for every mesh
     * node -- position and rotation defaulting to zero, scaling to one --
     * which the template reads as `vec3_or(source, ..., <default>)` and
     * composes through the pinned `composeTrsLocalMatrix` walk.
     */
    private assertMeshTransformArguments(
        loader: ts.FunctionDeclaration,
    ): void {
        const call = this.context.callExpression(loader, "initMeshTransform");
        const expected = [
            "md.position?.[0] ?? 0",
            "md.position?.[1] ?? 0",
            "md.position?.[2] ?? 0",
            "md.rotation?.[0] ?? 0",
            "md.rotation?.[1] ?? 0",
            "md.rotation?.[2] ?? 0",
            "md.scaling?.[0] ?? 1",
            "md.scaling?.[1] ?? 1",
            "md.scaling?.[2] ?? 1",
        ];
        if (call.arguments.length !== expected.length + 1) {
            this.context.contractError(
                call,
                "Expected the pinned mesh TRS as nine arguments after the mesh.",
            );
        }
        expected.forEach((shape, index) =>
            this.context.assertExpressionShape(
                call.arguments[index + 1]!,
                shape,
                `Babylon mesh TRS argument ${index}`,
            ),
        );
    }

    /**
     * `bakeLocalMatrix` translated whole: the pin's pivot bake over the
     * Float32Array attributes it is about to upload, at JavaScript-number
     * width with one rounding per store, and the normal renormalization
     * behind its own length guard. The call site and its guard are asserted
     * against the pinned loader, so the bake cannot silently apply to a
     * node the pin leaves alone.
     */
    private lowerLocalMatrixBake(loader: ts.FunctionDeclaration): string {
        this.context.expectShapeCount(
            loader,
            "md.localMatrix && bakeLocalMatrix",
            "Babylon pivot-bake guard",
        );
        this.context.expectShapeCount(
            loader,
            "bakeLocalMatrix(positions, normals, md.localMatrix)",
            "Babylon pivot-bake call",
        );
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

    /**
     * The file camera's target derivation, translated from the pinned
     * `parseBabylonCamera` — the dynamically imported half of the loader.
     * The JSON reads are plumbing (`double_at` resolves the pin's own
     * `?? 0` and reads at the JavaScript-number width the pin reads at);
     * the pitch/yaw/cosine locals and every component of both factory
     * vectors come from the pinned declaration's own AST.
     */
    private lowerCameraDerivation(): string {
        const module = "src/loader-babylon/parse-camera.ts";
        const symbol = "parseBabylonCamera";
        const { file, declaration } = this.context.functionDeclaration(
            module,
            symbol,
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "p"),
            "cd.position",
            "Pinned camera position alias",
        );
        for (const [name, shape] of [
            ["pitch", "cd.rotation?.[0] ?? 0"],
            ["yaw", "cd.rotation?.[1] ?? 0"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(declaration, name),
                shape,
                `Pinned camera ${name}`,
            );
        }
        // The three guarded stores after the factory call, which the
        // template reads as `selected->value(<key>, <factory default>)`.
        for (const [key, member] of [
            ["fov", "fov"],
            ["minZ", "nearPlane"],
            ["maxZ", "farPlane"],
        ] as const) {
            this.context.expectShapeCount(
                declaration,
                `cd.${key} != null`,
                `Pinned camera ${key} guard`,
            );
            this.context.expectShapeCount(
                declaration,
                `cam.${member} = cd.${key}`,
                `Pinned camera ${key} store`,
            );
        }
        const lowerer = new PinnedNumericLowerer(file, {
            bindings: new Map<string, PinnedBinding>([
                ["pitch", { cpp: "pitch", type: "scalar" }],
                ["yaw", { cpp: "yaw", type: "scalar" }],
                ["cp", { cpp: "cp", type: "scalar" }],
                ["p[0]", { cpp: "p0", type: "scalar" }],
                ["p[1]", { cpp: "p1", type: "scalar" }],
                ["p[2]", { cpp: "p2", type: "scalar" }],
            ]),
            calls: pinnedNumericMathCalls(),
        });
        const cp = lowerer.expression(
            this.context.variableInitializer(declaration, "cp"),
        );
        const factory = this.context
            .findNodes(
                declaration,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "createFreeCamera",
            )[0];
        if (!factory || factory.arguments.length !== 2) {
            this.context.contractError(
                declaration,
                "Expected the pinned camera factory call with a position " +
                    "and a target.",
            );
        }
        const position = lowerObjectComponents(
            this.context,
            lowerer,
            factory.arguments[0]!,
            ["x", "y", "z"],
        );
        const target = lowerObjectComponents(
            this.context,
            lowerer,
            factory.arguments[1]!,
            ["x", "y", "z"],
        );
        return `        // ${this.context.provenance(module, symbol)}
        const double p0 = double_at(*selected, "position", 0, 0.0);
        const double p1 = double_at(*selected, "position", 1, 0.0);
        const double p2 = double_at(*selected, "position", 2, 0.0);
        const double pitch = double_at(*selected, "rotation", 0, 0.0);
        const double yaw = double_at(*selected, "rotation", 1, 0.0);
        const double cp = ${cp};
        asset.camera = create_free_camera(
            engine,
            Vec3d{${position.join(", ")}},
            Vec3d{
                ${target.join(",\n                ")}});`;
    }
}
