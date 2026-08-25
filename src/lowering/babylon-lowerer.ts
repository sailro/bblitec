import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
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
        const vector = (argument: ts.Expression): string[] => {
            const literal = this.context.unwrapExpression(argument);
            if (!ts.isObjectLiteralExpression(literal)) {
                this.context.contractError(
                    argument,
                    "Expected a pinned camera vector literal.",
                );
            }
            return (["x", "y", "z"] as const).map((axis) =>
                lowerer.expression(
                    this.context.propertyInitializer(literal, axis),
                ),
            );
        };
        const position = vector(factory.arguments[0]!);
        const target = vector(factory.arguments[1]!);
        return `// ${this.context.provenance(module, symbol)}
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
