import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";
import {
    pinnedMathSpelling,
    pinnedNumericMathCallsWithHypot,
} from "./pinned-operators.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";
import { recordAt } from "../compiler/record-access.js";

interface HemisphericDefaults {
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    groundColor: [number, number, number];
}
interface PositionalLightDefaults {
    diffuseColor: [number, number, number];
    specularColor: [number, number, number];
    rangeIsUnbounded: boolean;
}

export class LightLowerer {
    public constructor(private readonly context: LoweringContext) {}
    public lowerSpotAngleSetter(): string {
        const { file, declaration } = this.context.functionDeclaration(
            "src/light/spot-light.ts",
            "createSpotLight",
        );
        const expression = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, "_cosHalfAngle"),
        );
        if (
            !ts.isCallExpression(expression) ||
            this.context.propertyPath(expression.expression)?.join(".") !==
                "Math.cos" ||
            expression.arguments.length !== 1
        )
            this.context.contractError(
                expression,
                "Expected source spot cone cosine.",
            );
        const product = this.context.unwrapExpression(expression.arguments[0]!);
        if (
            !ts.isBinaryExpression(product) ||
            product.operatorToken.kind !== ts.SyntaxKind.AsteriskToken ||
            !ts.isIdentifier(product.left) ||
            product.left.text !== "angle"
        )
            this.context.contractError(
                product,
                "Expected source spot cone angle scaling.",
            );
        return this.spotConeSetter(
            declaration,
            this.context.numericValue(product.right, file),
        );
    }

    private spotConeSetter(
        declaration: ts.FunctionDeclaration,
        coneHalfFactor: number,
    ): string {
        const install = this.context.callExpression(
            declaration,
            "defineProperty",
        );
        const name = install.arguments[1];
        if (!name || !ts.isStringLiteralLike(name) || name.text !== "angle") {
            this.context.contractError(
                name ?? install,
                "Expected the spot light to define an 'angle' accessor.",
            );
        }
        this.context.expectShapeCount(
            declaration,
            `_cosHalfAngle = Math.cos(v * ${coneHalfFactor})`,
            "spot angle setter cone cosine",
        );
        this.context.expectShapeCount(
            declaration,
            "_angle = v",
            "spot angle setter angle store",
        );
        return `
// The pinned cone pair, re-run on every angle write the same way the local
// matrix is re-run on every vector write: the factory computes the cosine
// while the angle is still a JavaScript number and only its UBO store
// rounds, so the product stays double up to the single narrowing here.
void refresh_spot_light_cone(LightRecord& light, double angle) {
    light.angle = angle;
    light.cos_half_angle = static_cast<float>(${pinnedMathSpelling("cos")}(
        angle * ${this.context.doubleLiteral(coneHalfFactor)}));
}
`;
    }

    /** Lights compose the same TRS as every other SceneNode. */
    public lowerMatrix(): LoweredSource {
        const modulePath = "src/light/light-base.ts";
        const symbolName = "writeWorldLightDirection";
        const base = this.context.functionDeclaration(
            modulePath,
            "createLightBase",
        ).declaration;
        this.context.assertExpressionShape(
            this.context.callExpression(base, "initSceneNodeTransform"),
            'initSceneNodeTransform({name: "", children: []}, position[0], position[1], position[2])',
            "Light SceneNode transform initialization",
        );
        const body = this.lowerDirectionBody(
            "data",
            "offset",
            "world",
            "direction",
        );
        const signature = `void write_world_light_direction(std::array<float, 3>& data,
    std::size_t offset, const std::array<float, 16>& world, const Vec3& direction)`;
        return {
            modulePath,
            symbolName,
            header: pinnedHeader(
                [
                    "<array>",
                    "<bblite/runtime.hpp>",
                    "<bblite/upstream/pinned_world_transform.hpp>",
                ],
                `
${signature};
`,
            ),
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/light_matrix.hpp>
#include <bblite/js_data.hpp>
#include <cmath>
namespace bbl::upstream {
${signature} {
${body}
}
} // namespace bbl::upstream
`,
        };
    }

    public lowerDirectionBody(
        data: string,
        offset: string,
        world: string,
        direction: string,
    ): string {
        const { file, declaration } = this.context.functionDeclaration(
            "src/light/light-base.ts",
            "writeWorldLightDirection",
        );
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: new Map<string, PinnedBinding>([
                ["data", { cpp: data, type: "f32" }],
                ["offset", { cpp: offset, type: "index" }],
                ["world", { cpp: world, type: "f32" }],
                ...["x", "y", "z"].map((axis): [string, PinnedBinding] => [
                    `direction.${axis}`,
                    {
                        cpp: `static_cast<double>(${direction}.${axis})`,
                        type: "scalar",
                    },
                ]),
            ]),
            calls: pinnedNumericMathCallsWithHypot(),
        });
    }

    public lowerFactory(): LoweredSource {
        return this.lowerLightFactory("hemispheric");
    }
    public lowerPointFactory(): LoweredSource {
        return this.lowerLightFactory("point");
    }
    public lowerDirectionalFactory(): LoweredSource {
        return this.lowerLightFactory("directional");
    }
    public lowerSpotFactory(): LoweredSource {
        return this.lowerLightFactory("spot");
    }

    private lowerLightFactory(
        kind: "hemispheric" | "point" | "directional" | "spot",
    ): LoweredSource {
        const modulePath = `src/light/${kind === "hemispheric" ? kind : kind + "-light"}.ts`;
        const symbolName = `create${kind[0]!.toUpperCase() + kind.slice(1)}Light`;
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const defaults =
            kind === "hemispheric"
                ? this.extractHemisphericDefaults(modulePath, symbolName)
                : this.extractPositionalLightDefaults(
                      modulePath,
                      symbolName,
                      kind,
                      kind !== "directional",
                  );
        const positional = kind === "point" || kind === "spot";
        const hasDirection = kind !== "point";
        const base = this.context.callExpression(
            declaration,
            "createLightBase",
        );
        this.context.assertExpressionShape(
            base,
            positional
                ? "createLightBase(position)"
                : "createLightBase([0, 0, 0])",
            "Light transform origin",
        );
        const position = positional
            ? "position"
            : `Vec3{${this.context
                  .numericTuple(base.arguments[0]!, file)
                  .map((value) => this.context.floatLiteral(value))
                  .join(", ")}}`;
        const object = this.context.callObjectArgument(
            declaration,
            "applyLightBase",
            1,
        );
        if (hasDirection)
            this.context.assertExpressionShape(
                this.context.propertyInitializer(object, "direction"),
                "new ObservableVec3(direction[0], direction[1], direction[2], lvs.b)",
                "Light direction changes only its light version",
            );
        const parameters = [
            "Engine& engine",
            ...(positional ? ["Vec3 position"] : []),
            ...(hasDirection ? ["Vec3 direction"] : []),
            ...(kind === "spot" ? ["double angle", "float exponent"] : []),
            "double intensity",
        ];
        const vectors = ["position", ...(hasDirection ? ["direction"] : [])];
        const setters = vectors
            .map(
                (vector) => `
void set_${kind}_light_${vector}(Engine& engine, LightHandle light, Vec3 value) {
    auto& record = ${recordAt("engine.lights", "light")};
    record.${vector} = value;
}`,
            )
            .join("\n");
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>
#include <cmath>
namespace bbl {
${
    kind === "spot"
        ? `namespace {
${this.lowerSpotAngleSetter()}
}`
        : ""
}
LightHandle create_${kind}_light(${parameters.join(", ")}) {
    LightRecord light;
    light.kind = LightKind::${kind};
    light.position = ${position};
    ${hasDirection ? "light.direction = direction;" : ""}
    light.intensity = intensity;
    light.diffuse_color = ${this.context.cppColor3(defaults.diffuseColor)};
    light.specular_color = ${this.context.cppColor3(defaults.specularColor)};
    ${"groundColor" in defaults ? `light.ground_color = ${this.context.cppColor3(defaults.groundColor)};` : "light.range = std::numeric_limits<float>::max();"}
    ${kind === "spot" ? "light.exponent = exponent; refresh_spot_light_cone(light, angle);" : ""}
    engine.lights.push_back(light);
    return LightHandle{static_cast<std::uint32_t>(engine.lights.size() - 1)};
}
${setters}
${
    kind === "spot"
        ? `void set_spot_light_angle(Engine& engine, LightHandle light, double angle) {
    refresh_spot_light_cone(${recordAt("engine.lights", "light")}, angle);
}`
        : ""
}
} // namespace bbl
`,
        };
    }

    private extractHemisphericDefaults(
        modulePath: string,
        symbolName: string,
    ): HemisphericDefaults {
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const lightObject = this.context.callObjectArgument(
            declaration,
            "applyLightBase",
            1,
        );
        return {
            diffuseColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "diffuseColor"),
                file,
            ),
            specularColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "specularColor"),
                file,
            ),
            groundColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "groundColor"),
                file,
            ),
        };
    }

    private extractPositionalLightDefaults(
        modulePath: string,
        symbolName: string,
        expectedType: "directional" | "point" | "spot",
        requireRange: boolean,
    ): PositionalLightDefaults {
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const lightObject = this.context.callObjectArgument(
            declaration,
            "applyLightBase",
            1,
        );
        const lightType = this.context.stringValue(
            this.context.propertyInitializer(lightObject, "lightType"),
            file,
        );
        if (lightType !== expectedType) {
            throw new Error(
                `Pinned ${expectedType} light type changed to '${lightType}'.`,
            );
        }
        const range = lightObject.properties.some(
            (property) =>
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                property.name.text === "range" &&
                this.context.isNumberMaxValue(property.initializer),
        );
        if (requireRange && !range) {
            throw new Error(`Pinned ${expectedType} light range is missing.`);
        }
        return {
            diffuseColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "diffuse"),
                file,
            ),
            specularColor: this.context.numericTuple(
                this.context.propertyInitializer(lightObject, "specular"),
                file,
            ),
            rangeIsUnbounded: range,
        };
    }
}
