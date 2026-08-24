import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

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

    /**
     * The `set_<kind>_light_<vector>` entry points for one light kind.
     *
     * A vector is an `ObservableVec3` upstream, so a write does two things:
     * it moves the field and it marks the light's local matrix dirty, which
     * the next read rebuilds. Each emitted setter is that pair, and it lives
     * in its own kind's translation unit so a scene reaching no light of a
     * kind links none of them.
     *
     * `vectors` is checked against the pinned factory's own object literal
     * before it is emitted, so a kind that stopped declaring one of them
     * fails generation instead of emitting a setter for a field the pin no
     * longer observes.
     */
    private lightVectorSetters(
        modulePath: string,
        symbolName: string,
        kind: string,
        vectors: readonly string[],
    ): string {
        const declared = this.observableVectors(modulePath, symbolName);
        for (const vector of vectors) {
            if (!declared.includes(vector)) {
                this.context.contractError(
                    this.context.functionDeclaration(modulePath, symbolName)
                        .declaration,
                    `Expected the ${kind} light to observe '${vector}'.`,
                );
            }
        }
        return vectors
            .map((vector) => `
void set_${kind}_light_${vector}(
    Engine& engine,
    LightHandle light,
    Vec3 ${vector}) {
    LightRecord& record = engine.lights[light.value];
    record.${vector} = ${vector};
    refresh_${kind}_light_matrix(record);
}
`)
            .join("");
    }

    /**
     * The `ObservableVec3` properties a pinned light factory declares on the
     * object it hands to `applyWorldMatrixAccessors` — which is the pin's own
     * statement of the vectors that kind carries.
     */
    private observableVectors(
        modulePath: string,
        symbolName: string,
    ): string[] {
        const { declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const lightObject = this.context.callObjectArgument(
            declaration,
            "applyWorldMatrixAccessors",
        );
        const observed: string[] = [];
        for (const property of lightObject.properties) {
            if (
                !ts.isPropertyAssignment(property) ||
                !ts.isIdentifier(property.name)
            ) {
                continue;
            }
            const initializer = this.context.unwrapExpression(
                property.initializer,
            );
            if (
                ts.isNewExpression(initializer) &&
                this.context
                    .propertyPath(initializer.expression)
                    ?.join(".") === "ObservableVec3"
            ) {
                observed.push(property.name.text);
            }
        }
        return observed;
    }

    public lowerMatrix(): LoweredSource {
        const modulePath = "src/light/light-matrix.ts";
        const symbolName = "localMatrixFromDirection";
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const body = declaration.body!.statements
            .flatMap((statement) => this.emitStatement(statement, file))
            .join("\n");
        return {
            modulePath,
            symbolName,
            header: `#pragma once

#include <array>

namespace bbl::upstream {

std::array<float, 16>& local_matrix_from_direction(
    float dx,
    float dy,
    float dz,
    float px,
    float py,
    float pz,
    std::array<float, 16>& out);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/upstream/light_matrix.hpp>

#include <cmath>

namespace bbl::upstream {
namespace {

float nonzero_or(float value, float fallback) {
    return value != 0.0f ? value : fallback;
}

} // namespace

std::array<float, 16>& local_matrix_from_direction(
    float dx,
    float dy,
    float dz,
    float px,
    float py,
    float pz,
    std::array<float, 16>& out) {
${body}
}

} // namespace bbl::upstream
`,
        };
    }

    public lowerFactory(): LoweredSource {
        const modulePath = "src/light/hemispheric.ts";
        const symbolName = "createHemisphericLight";
        const defaults = this.extractHemisphericDefaults(modulePath, symbolName);
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        // The pinned local-matrix call anchors the emitted argument
        // list: a hemispheric light has no position, so the pin passes a
        // literal origin, and those components flow into the emitted
        // zeros rather than being retyped beside the direction.
        const matrixCall = this.context.callExpression(
            declaration,
            "localMatrixFromDirection",
        );
        const directionArguments = [
            "light.direction.x",
            "light.direction.y",
            "light.direction.z",
        ];
        if (
            matrixCall.arguments.length !== 7 ||
            directionArguments.some(
                (expected, index) =>
                    this.context
                        .propertyPath(
                            matrixCall.arguments[index]!,
                        )
                        ?.join(".") !== expected,
            )
        ) {
            this.context.contractError(
                matrixCall,
                "Expected the hemispheric local matrix to be built from the direction.",
            );
        }
        const origin = [3, 4, 5].map((index) =>
            this.context.numericValue(
                matrixCall.arguments[index]!,
                file,
            ),
        );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>

namespace bbl {

LightHandle create_hemispheric_light(Engine& engine, Vec3 direction, float intensity) {
    LightRecord light;
    light.kind = LightKind::hemispheric;
    light.direction = direction;
    light.intensity = intensity;
    light.diffuse_color = ${this.context.cppColor3(defaults.diffuseColor)};
    light.specular_color = ${this.context.cppColor3(defaults.specularColor)};
    light.ground_color = ${this.context.cppColor3(defaults.groundColor)};
    upstream::local_matrix_from_direction(
        direction.x,
        direction.y,
        direction.z,
        ${this.context.floatLiteral(origin[0]!)},
        ${this.context.floatLiteral(origin[1]!)},
        ${this.context.floatLiteral(origin[2]!)},
        light.local_matrix);
    engine.lights.push_back(light);
    return LightHandle{static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerPointFactory(): LoweredSource {
        const modulePath = "src/light/point-light.ts";
        const symbolName = "createPointLight";
        const defaults = this.extractPositionalLightDefaults(
            modulePath,
            symbolName,
            "point",
            true,
        );
        if (!defaults.rangeIsUnbounded) {
            throw new Error(
                "Pinned point-light default range is no longer Number.MAX_VALUE.",
            );
        }
        // A point light is the one kind whose local matrix the pinned
        // factory builds by hand: it seeds the identity diagonal once at
        // creation (`m[0] = m[5] = m[10] = m[15] = 1`) and writes the
        // translation column inside its local-matrix builder
        // (`m[12..14] = light.position.*`). Both the indices and the
        // diagonal values flow from those pinned stores into the emitted
        // lines below; the size checks make an added or moved store fail
        // generation instead of leaving the emission stale.
        const localMatrix = this.extractPointLightLocalMatrix(
            modulePath,
            symbolName,
        );
        const identityStore = (index: number): string => {
            const value = localMatrix.identity.get(index);
            if (value === undefined) {
                throw new Error(
                    `Pinned point-light local matrix no longer seeds m[${index}].`,
                );
            }
            return this.context.floatLiteral(value);
        };
        const translationIndex = (axis: string): number => {
            const index = localMatrix.translation.get(axis);
            if (index === undefined) {
                throw new Error(
                    `Pinned point-light local matrix no longer stores position.${axis}.`,
                );
            }
            return index;
        };
        if (
            localMatrix.identity.size !== 4 ||
            localMatrix.translation.size !== 3
        ) {
            throw new Error(
                "Pinned point-light local matrix gained stores the emission does not carry.",
            );
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

namespace bbl {

namespace {

// The point-light pin keeps its identity basis and rebuilds only the
// translation column from the observable position. Creation and every
// reached position write share this helper so the cached local matrix is
// always the one the pin's closure would expose on its next read.
void refresh_point_light_matrix(LightRecord& light) {
    light.local_matrix[${translationIndex("x")}] = light.position.x;
    light.local_matrix[${translationIndex("y")}] = light.position.y;
    light.local_matrix[${translationIndex("z")}] = light.position.z;
}

} // namespace

LightHandle create_point_light(
    Engine& engine,
    Vec3 position,
    float intensity) {
    LightRecord light;
    light.kind = LightKind::point;
    light.position = position;
    light.intensity = intensity;
    light.diffuse_color = ${this.context.cppColor3(defaults.diffuseColor)};
    light.specular_color = ${this.context.cppColor3(defaults.specularColor)};
    light.range = std::numeric_limits<float>::max();
    light.local_matrix[0] = ${identityStore(0)};
    light.local_matrix[5] = ${identityStore(5)};
    light.local_matrix[10] = ${identityStore(10)};
    light.local_matrix[15] = ${identityStore(15)};
    refresh_point_light_matrix(light);
    engine.lights.push_back(light);
    return LightHandle{
        static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

${this.lightVectorSetters(modulePath, symbolName, "point", ["position"])}

} // namespace bbl
`,
        };
    }

    public lowerDirectionalFactory(): LoweredSource {
        const modulePath = "src/light/directional-light.ts";
        const symbolName = "createDirectionalLight";
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const defaults = this.extractPositionalLightDefaults(
            modulePath,
            symbolName,
            "directional",
            false,
        );
        // The pinned factory builds the local matrix from the direction
        // AND the light's position property (the same call shape a spot
        // uses). The pinned DEFAULT position (`new ObservableVec3(0, 0, 0,
        // ...)`) is extracted below and stored on the record, because the
        // record's position is settable: both the factory's rebuild and the
        // setter's read the same field, so the default has to be the pin's
        // there rather than a zero baked into one call.
        this.context.assertExpressionShape(
            this.context.callExpression(
                declaration,
                "localMatrixFromDirection",
            ),
            "localMatrixFromDirection(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z, _localMatrix)",
            "directional-light local matrix",
        );
        const lightObject = this.context.callObjectArgument(
            declaration,
            "applyWorldMatrixAccessors",
        );
        const positionInitializer =
            this.context.unwrapExpression(
                this.context.propertyInitializer(
                    lightObject,
                    "position",
                ),
            );
        if (
            !ts.isNewExpression(positionInitializer) ||
            this.context
                .propertyPath(positionInitializer.expression)
                ?.join(".") !== "ObservableVec3" ||
            (positionInitializer.arguments?.length ?? 0) < 3
        ) {
            this.context.contractError(
                positionInitializer,
                "Expected the directional default position to be an ObservableVec3.",
            );
        }
        const defaultPosition = [0, 1, 2].map((index) =>
            this.context.numericValue(
                positionInitializer.arguments![index]!,
                file,
            ),
        );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>

namespace bbl {

namespace {

// The pinned local-matrix closure, which the factory runs once and every
// ObservableVec3 write re-runs: the pin marks the matrix dirty on a set and
// rebuilds it from the light's current direction and position on the next
// read, so a setter that moved only the field would leave a stale matrix.
void refresh_directional_light_matrix(LightRecord& light) {
    upstream::local_matrix_from_direction(
        light.direction.x,
        light.direction.y,
        light.direction.z,
        light.position.x,
        light.position.y,
        light.position.z,
        light.local_matrix);
}

} // namespace

LightHandle create_directional_light(
    Engine& engine,
    Vec3 direction,
    float intensity) {
    LightRecord light;
    light.kind = LightKind::directional;
    light.direction = direction;
    // The pinned default position, from the factory's own ObservableVec3.
    light.position = Vec3{
        ${this.context.floatLiteral(defaultPosition[0]!)},
        ${this.context.floatLiteral(defaultPosition[1]!)},
        ${this.context.floatLiteral(defaultPosition[2]!)}};
    light.intensity = intensity;
    light.diffuse_color = ${this.context.cppColor3(defaults.diffuseColor)};
    light.specular_color = ${this.context.cppColor3(defaults.specularColor)};
    light.range = std::numeric_limits<float>::max();
    refresh_directional_light_matrix(light);
    engine.lights.push_back(light);
    return LightHandle{
        static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

${this.lightVectorSetters(modulePath, symbolName, "directional", ["position"])}
} // namespace bbl
`,
        };
    }

    public lowerSpotFactory(): LoweredSource {
        const modulePath = "src/light/spot-light.ts";
        const symbolName = "createSpotLight";
        const { file, declaration } = this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
        const defaults = this.extractPositionalLightDefaults(
            modulePath,
            symbolName,
            "spot",
            true,
        );
        // The cone is stored as the cosine of its half angle, computed once
        // at creation. `angle` is the FULL cone angle, so a scene passing
        // Math.PI / 2 lights a quarter turn in total. The formula is
        // anchored structurally (a Math.cos over `angle * <factor>`) and
        // the half-angle factor flows into the emitted
        // `std::cos(angle * ...)`, so a pin retune regenerates. `angle` and
        // the factor remain doubles through this expression, matching the
        // JavaScript-number calculation before the pinned Float32Array store
        // rounds the result once.
        const coneCosine = this.context.unwrapExpression(
            this.context.variableInitializer(
                declaration,
                "_cosHalfAngle",
            ),
        );
        if (
            !ts.isCallExpression(coneCosine) ||
            this.context
                .propertyPath(coneCosine.expression)
                ?.join(".") !== "Math.cos" ||
            coneCosine.arguments.length !== 1
        ) {
            this.context.contractError(
                coneCosine,
                "Expected the cone cosine to be a Math.cos call.",
            );
        }
        const coneProduct = this.context.unwrapExpression(
            coneCosine.arguments[0]!,
        );
        if (
            !ts.isBinaryExpression(coneProduct) ||
            coneProduct.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            !ts.isIdentifier(coneProduct.left) ||
            coneProduct.left.text !== "angle"
        ) {
            this.context.contractError(
                coneCosine,
                "Expected the cone cosine to scale the full angle.",
            );
        }
        const coneHalfFactor = this.context.numericValue(
            coneProduct.right,
            file,
        );
        // A spot is the one light kind whose local matrix carries both a
        // direction and a position; the other kinds pass one or the other.
        this.context.assertExpressionShape(
            this.context.callExpression(
                declaration,
                "localMatrixFromDirection",
            ),
            "localMatrixFromDirection(light.direction.x, light.direction.y, light.direction.z, light.position.x, light.position.y, light.position.z, _localMatrix)",
            "spot-light local matrix",
        );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>
#include <bblite/upstream/light_matrix.hpp>

#include <cmath>

namespace bbl {

namespace {

// The pinned local-matrix closure, re-run on every ObservableVec3 write the
// same way the directional one is: a spot carries both an orientation and a
// position, so either setter rebuilds the whole matrix.
void refresh_spot_light_matrix(LightRecord& light) {
    upstream::local_matrix_from_direction(
        light.direction.x,
        light.direction.y,
        light.direction.z,
        light.position.x,
        light.position.y,
        light.position.z,
        light.local_matrix);
}

} // namespace

LightHandle create_spot_light(
    Engine& engine,
    Vec3 position,
    Vec3 direction,
    double angle,
    float exponent,
    float intensity) {
    LightRecord light;
    light.kind = LightKind::spot;
    light.position = position;
    light.direction = direction;
    light.intensity = intensity;
    light.exponent = exponent;
    light.cos_half_angle = static_cast<float>(
        std::cos(angle * ${this.context.doubleLiteral(coneHalfFactor)}));
    light.diffuse_color = ${this.context.cppColor3(defaults.diffuseColor)};
    light.specular_color = ${this.context.cppColor3(defaults.specularColor)};
    light.range = std::numeric_limits<float>::max();
    refresh_spot_light_matrix(light);
    engine.lights.push_back(light);
    return LightHandle{
        static_cast<std::uint32_t>(engine.lights.size() - 1)};
}

${this.lightVectorSetters(modulePath, symbolName, "spot", ["position", "direction"])}
} // namespace bbl
`,
        };
    }

    /**
     * The pinned point-light local-matrix stores: the identity diagonal
     * the factory seeds at creation and the translation column its
     * local-matrix builder writes. Keyed by index and by axis so both
     * the indices and the values can flow into the emitted factory, and
     * so an unrecognized store fails loudly (`numericValue` rejects
     * anything that is neither a constant nor a position component).
     */
    private extractPointLightLocalMatrix(
        modulePath: string,
        symbolName: string,
    ): {
        identity: ReadonlyMap<number, number>;
        translation: ReadonlyMap<string, number>;
    } {
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const identity = new Map<number, number>();
        const translation = new Map<string, number>();
        const stores = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === "m",
        );
        for (const store of stores) {
            const target =
                store.left as ts.ElementAccessExpression;
            if (
                !ts.isNumericLiteral(
                    target.argumentExpression,
                )
            ) {
                this.context.contractError(
                    store,
                    "Expected a constant local-matrix index.",
                );
            }
            const index = Number(
                target.argumentExpression.text,
            );
            if (
                identity.has(index) ||
                [...translation.values()].includes(index)
            ) {
                this.context.contractError(
                    store,
                    `Local-matrix index ${index} is stored twice.`,
                );
            }
            const right = this.context.unwrapExpression(
                store.right,
            );
            const path = this.context
                .propertyPath(right)
                ?.join(".");
            if (
                path === "light.position.x" ||
                path === "light.position.y" ||
                path === "light.position.z"
            ) {
                const axis = path.slice(-1);
                if (translation.has(axis)) {
                    this.context.contractError(
                        store,
                        `position.${axis} is stored twice.`,
                    );
                }
                translation.set(axis, index);
                continue;
            }
            identity.set(
                index,
                this.context.numericValue(right, file),
            );
        }
        return { identity, translation };
    }

    private extractHemisphericDefaults(modulePath: string, symbolName: string): HemisphericDefaults {
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const lightObject =
            this.context.callObjectArgument(
                declaration,
                "applyWorldMatrixAccessors",
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
        const { file, declaration } =
            this.context.functionDeclaration(
                modulePath,
                symbolName,
            );
        const lightObject =
            this.context.callObjectArgument(
                declaration,
                "applyWorldMatrixAccessors",
            );
        const lightType = this.context.stringValue(
            this.context.propertyInitializer(
                lightObject,
                "lightType",
            ),
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
                this.context.isNumberMaxValue(
                    property.initializer,
                ),
        );
        if (requireRange && !range) {
            throw new Error(
                `Pinned ${expectedType} light range is missing.`,
            );
        }
        return {
            diffuseColor: this.context.numericTuple(
                this.context.propertyInitializer(
                    lightObject,
                    "diffuse",
                ),
                file,
            ),
            specularColor: this.context.numericTuple(
                this.context.propertyInitializer(
                    lightObject,
                    "specular",
                ),
                file,
            ),
            rangeIsUnbounded: range,
        };
    }

    private emitStatement(statement: ts.Statement, file: ts.SourceFile): string[] {
        if (ts.isVariableStatement(statement)) {
            const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
            const lines: string[] = [];
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
                    throw new Error(`Unsupported upstream declaration: ${declaration.getText(file)}.`);
                }
                if (declaration.name.text === "out4") continue;
                if (declaration.name.text === "m") {
                    lines.push("    auto& m = out;");
                    continue;
                }
                lines.push(
                    `    ${isConst ? "const " : ""}float ${declaration.name.text} = ` +
                        `${this.emitExpression(declaration.initializer, file)};`,
                );
            }
            return lines;
        }
        if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)) {
            const expression = statement.expression;
            const operators = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.EqualsToken, "="],
                [ts.SyntaxKind.SlashEqualsToken, "/="],
                [ts.SyntaxKind.AsteriskEqualsToken, "*="],
                [ts.SyntaxKind.PlusEqualsToken, "+="],
                [ts.SyntaxKind.MinusEqualsToken, "-="],
            ]);
            const operator = operators.get(expression.operatorToken.kind);
            if (!operator) throw new Error(`Unsupported upstream assignment: ${statement.getText(file)}.`);
            return [
                `    ${this.emitExpression(expression.left, file)} ${operator} ` +
                    `${this.emitExpression(expression.right, file)};`,
            ];
        }
        if (ts.isReturnStatement(statement) && statement.expression) {
            return [`    return ${this.emitExpression(statement.expression, file)};`];
        }
        throw new Error(`Unsupported upstream statement: ${statement.getText(file)}.`);
    }

    private emitExpression(expression: ts.Expression, file: ts.SourceFile): string {
        if (
            ts.isParenthesizedExpression(expression) ||
            ts.isAsExpression(expression) ||
            ts.isTypeAssertionExpression(expression) ||
            ts.isNonNullExpression(expression)
        ) {
            return this.emitExpression(expression.expression, file);
        }
        if (ts.isNumericLiteral(expression)) return this.context.floatLiteral(Number(expression.text));
        if (ts.isIdentifier(expression)) return expression.text === "out4" ? "out" : expression.text;
        if (ts.isPrefixUnaryExpression(expression)) {
            const operator = expression.operator === ts.SyntaxKind.MinusToken ? "-" : "+";
            return `(${operator}${this.emitExpression(expression.operand, file)})`;
        }
        if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
            const index = ts.isNumericLiteral(expression.argumentExpression)
                ? expression.argumentExpression.text
                : this.emitExpression(expression.argumentExpression, file);
            return `${this.emitExpression(expression.expression, file)}[${index}]`;
        }
        if (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression) &&
            ts.isIdentifier(expression.expression.expression) &&
            expression.expression.expression.text === "Math" &&
            expression.expression.name.text === "sqrt"
        ) {
            return `std::sqrt(${expression.arguments.map((argument) => this.emitExpression(argument, file)).join(", ")})`;
        }
        if (ts.isBinaryExpression(expression)) {
            if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                return `nonzero_or(${this.emitExpression(expression.left, file)}, ` +
                    `${this.emitExpression(expression.right, file)})`;
            }
            const operators = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.PlusToken, "+"],
                [ts.SyntaxKind.MinusToken, "-"],
                [ts.SyntaxKind.AsteriskToken, "*"],
                [ts.SyntaxKind.SlashToken, "/"],
            ]);
            const operator = operators.get(expression.operatorToken.kind);
            if (operator) {
                return `(${this.emitExpression(expression.left, file)} ${operator} ` +
                    `${this.emitExpression(expression.right, file)})`;
            }
        }
        throw new Error(`Unsupported upstream expression: ${expression.getText(file)}.`);
    }
}
