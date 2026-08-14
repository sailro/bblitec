import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { babylonLoaderCpp } from "./templates/babylon-loader-cpp.js";

export class BabylonLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerLoaderAdapter(
        lightMeshLists = false,
        diffuseUv2 = false,
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
        return {
            modulePath,
            symbolName,
            header: "",
            source: babylonLoaderCpp(
                this.context.provenance(modulePath, symbolName),
                lightMeshLists,
                diffuseUv2,
            ),
        };
    }
}
