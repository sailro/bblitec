import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { lowerObjectComponents } from "./pinned-function-lowerer.js";
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
        return {
            modulePath,
            symbolName,
            header: "",
            source: babylonLoaderCpp(
                this.context.provenance(modulePath, symbolName),
                this.lowerCameraDerivation(),
                submeshNameSuffix,
                lightMeshLists,
                diffuseUv2,
                bumpTexture,
            ),
        };
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
