import ts from "typescript";
import { doubleLiteral, floatLiteral } from "../cpp-literals.js";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    GltfExtensionDefaults,
    GltfFactorBake,
    GltfLoweredDefault,
    GltfMaterialDefaults,
    gltfLoaderCpp,
} from "./templates/gltf-loader-cpp.js";

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

    public lowerLoaderAdapter(
        nonTrianglePrimitives = false,
        nodeVisibility = false,
        animationPointer = false,
        animatedWorldBounds = false,
        animationPointerMaterials = false,
        assetTransmission = false,
        materialSpecular = false,
    ): LoweredSource {
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
                nonTrianglePrimitives,
                nodeVisibility,
                animationPointer,
                animatedWorldBounds,
                animationPointerMaterials,
                assetTransmission,
                materialSpecular,
            ),
        };
    }
}

/*
 * ──────────────────────── lowered loader leaves ────────────────────────
 *
 * The segments below used to live verbatim inside the loader template.
 * They are now emitted from the pinned declarations' own ASTs,
 * the way `pinned-ubo-writer-lowerer.ts` and `light-lowerer.ts`'s
 * `lowerMatrix` emit theirs: every constant, operator, and field name in
 * the output comes from the pin, and a construct the walk cannot carry
 * refuses generation instead of shipping a stale transcription.
 *
 * Round 1 lowered the animation interpolation and the sampler mapping;
 * round 2 adds the accessor normalization scales
 * (`gltf-ext-quantization.ts`), the COLOR_0 build
 * (`gltf-color-normalize.ts`), the dielectric/iridescence JSON defaults
 * (`gltf-ext-dielectric.ts`, `gltf-ext-iridescence.ts`), the SH prescale
 * (`ibl-env-assembly.ts`, proven identical to `load-env.ts`'s canonical),
 * and the image-processing defaults (`gltf-ext-lights-image-based.ts`).
 *
 * What these emitters own is the translation, never the formula:
 * JavaScript numbers become C++ doubles with one `static_cast<float>`
 * per Float32Array store, `Math.*` becomes `std::*`, the pin's
 * Float32Array lanes become vector members, an absent JSON sampler
 * property becomes a substituted glTF default the soundness check below
 * proves equivalent, and the line layout is the fixed presentation the
 * loader template has always carried. Byte-for-byte stability of the
 * output against the previously hand-written text is pinned by
 * `test/gltf-lowered-leaves.test.ts`.
 */

const laneMembers = ["x", "y", "z", "w"] as const;

/** C++ precedence for the expression subset the pinned leaves use. */
const cppPrecedence = {
    logicalOr: 1,
    logicalAnd: 2,
    equality: 3,
    relational: 4,
    additive: 5,
    multiplicative: 6,
    unary: 7,
    primary: 8,
} as const;

interface RenderedCpp {
    text: string;
    /** How tightly the text binds, for minimal re-parenthesization. */
    precedence: number;
}

interface CppExpressionScope {
    /** The pinned symbol, for refusal messages. */
    symbol: string;
    file: ts.SourceFile;
    /** Pin identifier → C++ identifier. Unknown identifiers refuse. */
    names: ReadonlyMap<string, string>;
    /** Pin locals inlined at their use sites, pre-rendered per lane. */
    substitutions?: ReadonlyMap<string, RenderedCpp>;
    /** How a numeric literal prints: a JavaScript double or a C++ enum. */
    numeric: (literal: ts.NumericLiteral) => string;
    /** Resolves `buf[...]` element reads, e.g. to a vector member. */
    elementRead?: (expression: ts.ElementAccessExpression) => RenderedCpp;
    /** Resolves `s?.prop` optional reads (the sampler's enum locals). */
    chainRead?: (expression: ts.PropertyAccessChain) => RenderedCpp;
}

const cppBinaryOperators: ReadonlyMap<
    ts.SyntaxKind,
    { text: string; level: number }
> = new Map([
    [ts.SyntaxKind.BarBarToken, { text: "||", level: cppPrecedence.logicalOr }],
    [
        ts.SyntaxKind.AmpersandAmpersandToken,
        { text: "&&", level: cppPrecedence.logicalAnd },
    ],
    [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        { text: "==", level: cppPrecedence.equality },
    ],
    [
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        { text: "!=", level: cppPrecedence.equality },
    ],
    [ts.SyntaxKind.LessThanToken, { text: "<", level: cppPrecedence.relational }],
    [
        ts.SyntaxKind.GreaterThanToken,
        { text: ">", level: cppPrecedence.relational },
    ],
    [ts.SyntaxKind.PlusToken, { text: "+", level: cppPrecedence.additive }],
    [ts.SyntaxKind.MinusToken, { text: "-", level: cppPrecedence.additive }],
    [
        ts.SyntaxKind.AsteriskToken,
        { text: "*", level: cppPrecedence.multiplicative },
    ],
    [
        ts.SyntaxKind.SlashToken,
        { text: "/", level: cppPrecedence.multiplicative },
    ],
    [
        ts.SyntaxKind.PercentToken,
        { text: "%", level: cppPrecedence.multiplicative },
    ],
]);

const pinnedMathFunctions: Readonly<Record<string, string>> = {
    sqrt: "std::sqrt",
    acos: "std::acos",
    sin: "std::sin",
};

function refuseNode(
    symbol: string,
    file: ts.SourceFile,
    node: ts.Node,
    reason: string,
): never {
    throw new Error(
        `Pinned ${symbol} ${reason}: ${node.getText(file)}.`,
    );
}

function unwrapPin(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isAsExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

/**
 * Parenthesize a rendered operand exactly where C++ would re-associate
 * it. Right operands require strictly higher precedence because floating
 * point does not associate: the pin's `h10 * (tangent * dt)` must not
 * flatten into `(h10 * tangent) * dt`.
 */
function renderCppOperand(rendered: RenderedCpp, minimum: number): string {
    return rendered.precedence < minimum
        ? `(${rendered.text})`
        : rendered.text;
}

function renderCppExpression(
    scope: CppExpressionScope,
    expression: ts.Expression,
): RenderedCpp {
    if (
        ts.isParenthesizedExpression(expression) ||
        ts.isNonNullExpression(expression)
    ) {
        return renderCppExpression(scope, expression.expression);
    }
    if (ts.isNumericLiteral(expression)) {
        return {
            text: scope.numeric(expression),
            precedence: cppPrecedence.primary,
        };
    }
    if (ts.isIdentifier(expression)) {
        const substituted = scope.substitutions?.get(expression.text);
        if (substituted) return substituted;
        const name = scope.names.get(expression.text);
        if (name !== undefined) {
            return { text: name, precedence: cppPrecedence.primary };
        }
        refuseNode(
            scope.symbol,
            scope.file,
            expression,
            "reads an identifier with no C++ correspondence",
        );
    }
    if (ts.isPrefixUnaryExpression(expression)) {
        const operator = expression.operator === ts.SyntaxKind.MinusToken
            ? "-"
            : expression.operator === ts.SyntaxKind.ExclamationToken
            ? "!"
            : undefined;
        if (operator === undefined) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "uses a unary operator this lowering cannot carry",
            );
        }
        const operand = renderCppExpression(scope, expression.operand);
        return {
            text: `${operator}${
                renderCppOperand(operand, cppPrecedence.unary)
            }`,
            precedence: cppPrecedence.unary,
        };
    }
    if (ts.isPropertyAccessChain(expression)) {
        if (!scope.chainRead) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "reads an optional property where none lowers",
            );
        }
        return scope.chainRead(expression);
    }
    if (ts.isElementAccessExpression(expression)) {
        if (!scope.elementRead) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "indexes a buffer where none lowers",
            );
        }
        return scope.elementRead(expression);
    }
    if (ts.isCallExpression(expression)) {
        const callee = expression.expression;
        if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Math"
        ) {
            const mapped = pinnedMathFunctions[callee.name.text];
            if (!mapped) {
                refuseNode(
                    scope.symbol,
                    scope.file,
                    expression,
                    `calls Math.${callee.name.text}, which has no lowering`,
                );
            }
            const argumentTexts = expression.arguments.map(
                (argument) => renderCppExpression(scope, argument).text,
            );
            return {
                text: `${mapped}(${argumentTexts.join(", ")})`,
                precedence: cppPrecedence.primary,
            };
        }
        refuseNode(
            scope.symbol,
            scope.file,
            expression,
            "calls a function this lowering cannot carry",
        );
    }
    if (ts.isBinaryExpression(expression)) {
        const operator = cppBinaryOperators.get(
            expression.operatorToken.kind,
        );
        if (!operator) {
            refuseNode(
                scope.symbol,
                scope.file,
                expression,
                "uses an operator this lowering cannot carry",
            );
        }
        const left = renderCppExpression(scope, expression.left);
        const right = renderCppExpression(scope, expression.right);
        return {
            text: `${renderCppOperand(left, operator.level)} ` +
                `${operator.text} ` +
                `${renderCppOperand(right, operator.level + 1)}`,
            precedence: operator.level,
        };
    }
    refuseNode(
        scope.symbol,
        scope.file,
        expression,
        "uses an expression this lowering cannot carry",
    );
}

/**
 * One declaration in the interpolation segment's layout: a single line
 * up to the segment's 60-column measure, wrapped after `=` beyond it.
 */
function interpolationDeclarationLines(
    indent: string,
    head: string,
    value: string,
): string[] {
    const single = `${indent}${head} ${value};`;
    if (single.length <= 60) return [single];
    return [`${indent}${head}`, `${indent}    ${value};`];
}

/**
 * One `static_cast<float>` component of a vector build — the pin's
 * Float32Array store, rounded exactly once. A long Hermite sum splits
 * its top-level terms greedily at the segment's 60-column measure.
 */
function castEntryLines(
    indent: string,
    terms: readonly string[],
): string[] {
    const joined = terms.join(" + ");
    if (joined.length <= 60) {
        return [`${indent}static_cast<float>(${joined}),`];
    }
    const continuation = `${indent}    `;
    const lines: string[] = [`${indent}static_cast<float>(`];
    let current = "";
    for (const term of terms) {
        if (current === "") {
            current = term;
            continue;
        }
        const extended = `${current} + ${term}`;
        if (`${continuation}${extended} +`.length <= 60) {
            current = extended;
            continue;
        }
        lines.push(`${continuation}${current} +`);
        current = term;
    }
    lines.push(`${continuation}${current}),`);
    return lines;
}

function vecBuildLines(
    indent: string,
    open: string,
    entries: readonly (readonly string[])[],
    close: string,
): string[] {
    return [
        `${indent}${open}`,
        ...entries.flatMap((terms) =>
            castEntryLines(`${indent}    `, terms)
        ),
        `${indent}${close}`,
    ];
}

interface PinnedBinding {
    name: string;
    initializer: ts.Expression;
    isConst: boolean;
    statement: ts.VariableStatement;
}

/** A `const x = …` / `let x = …` statement with exactly one binding. */
function singleBinding(
    symbol: string,
    file: ts.SourceFile,
    statement: ts.Statement | undefined,
    anchor: ts.Node,
): PinnedBinding {
    if (!statement || !ts.isVariableStatement(statement)) {
        refuseNode(
            symbol,
            file,
            statement ?? anchor,
            "no longer declares the local this lowering expects",
        );
    }
    const declarations = statement.declarationList.declarations;
    const declaration = declarations.length === 1
        ? declarations[0]
        : undefined;
    if (
        !declaration ||
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer
    ) {
        refuseNode(
            symbol,
            file,
            statement,
            "declares a binding this lowering cannot carry",
        );
    }
    return {
        name: declaration.name.text,
        initializer: declaration.initializer,
        isConst:
            (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
        statement,
    };
}

function identifierParameters(
    symbol: string,
    file: ts.SourceFile,
    declaration: ts.FunctionDeclaration,
): string[] {
    return declaration.parameters.map((parameter) => {
        if (!ts.isIdentifier(parameter.name)) {
            refuseNode(
                symbol,
                file,
                parameter,
                "takes a destructured parameter this lowering cannot carry",
            );
        }
        return parameter.name.text;
    });
}

function topLevelFunction(
    file: ts.SourceFile,
    symbolName: string,
): ts.FunctionDeclaration & { body: ts.Block } {
    const declaration = file.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === symbolName &&
            statement.body !== undefined,
    );
    if (!declaration?.body) {
        throw new Error(
            `Pinned function '${symbolName}' with a body was not found ` +
                `in ${file.fileName}.`,
        );
    }
    return declaration as ts.FunctionDeclaration & { body: ts.Block };
}

/**
 * A run of `buf[base + lane] = …` stores covering lanes 0..count-1 in
 * order — the pin's Float32Array writes that become one vector build.
 */
function collectLaneStores(
    scope: CppExpressionScope,
    statements: readonly ts.Statement[],
    start: number,
    count: number,
    laneOf: (target: ts.ElementAccessExpression) => number | undefined,
): { expressions: ts.Expression[]; next: number } {
    const expressions: ts.Expression[] = [];
    let index = start;
    for (let lane = 0; lane < count; lane += 1) {
        const statement = statements[index];
        const assignment = statement &&
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? statement.expression
            : undefined;
        if (
            !assignment ||
            !ts.isElementAccessExpression(assignment.left) ||
            laneOf(assignment.left) !== lane
        ) {
            refuseNode(
                scope.symbol,
                scope.file,
                statement ?? statements[start] ?? scope.file,
                `no longer stores lane ${lane} where this lowering expects it`,
            );
        }
        expressions.push(assignment.right);
        index += 1;
    }
    return { expressions, next: index };
}

/** The C++ name every lowered call site uses for the pinned normalize. */
const normalizeQuaternionCppName = "normalize_quaternion";

const pinnedDoubleLiteral = (literal: ts.NumericLiteral): string =>
    doubleLiteral(Number(literal.text));

/**
 * `normalizeQuat4(buf, o)` → `normalize_quaternion(Vec4)`.
 *
 * The pin normalizes four consecutive Float32Array components in place;
 * the record side passes the quaternion by value, so the four lane reads
 * become member reads and the four stores become one rounded Vec4 build.
 * The void fall-through on zero length — the input kept verbatim — is
 * the trailing `return value;`.
 */
function emitNormalizeQuaternion(
    declaration: ts.FunctionDeclaration & { body: ts.Block },
    file: ts.SourceFile,
): string {
    const symbol = "normalizeQuat4";
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 2) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (buffer, offset)",
        );
    }
    const bufferName = parameters[0]!;
    const offsetName = parameters[1]!;
    const laneOf = (
        target: ts.ElementAccessExpression,
    ): number | undefined => {
        if (
            !ts.isIdentifier(target.expression) ||
            target.expression.text !== bufferName
        ) {
            return undefined;
        }
        const index = unwrapPin(target.argumentExpression);
        if (ts.isIdentifier(index)) {
            return index.text === offsetName ? 0 : undefined;
        }
        if (
            ts.isBinaryExpression(index) &&
            index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(index.left) &&
            index.left.text === offsetName &&
            ts.isNumericLiteral(index.right)
        ) {
            return Number.parseInt(index.right.text, 10);
        }
        return undefined;
    };
    const names = new Map<string, string>();
    const renames: Readonly<Record<string, string>> = {
        lenSq: "length_squared",
        inv: "inverse",
    };
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    const statements = declaration.body.statements;
    const lines: string[] = [
        "Vec4 normalize_quaternion(Vec4 value) {",
        "    // Pinned normalizeQuat4: double length over float32 components,",
        "    // a multiply by the inverse square root, one rounding at the",
        "    // Float32Array store, no epsilon, and the input kept verbatim on",
        "    // zero length.",
    ];
    let index = 0;
    // The four component bindings, ascending lanes, keeping the pin's
    // own local names.
    for (let lane = 0; lane < 4; lane += 1) {
        const binding = singleBinding(
            symbol,
            file,
            statements[index],
            declaration,
        );
        index += 1;
        const read = unwrapPin(binding.initializer);
        if (
            !ts.isElementAccessExpression(read) ||
            laneOf(read) !== lane
        ) {
            refuseNode(
                symbol,
                file,
                binding.statement,
                `no longer reads lane ${lane} into '${binding.name}'`,
            );
        }
        names.set(binding.name, binding.name);
        lines.push(
            `    const double ${binding.name} = ` +
                `value.${laneMembers[lane]!};`,
        );
    }
    // The squared length.
    const lengthBinding = singleBinding(
        symbol,
        file,
        statements[index],
        declaration,
    );
    index += 1;
    const lengthName = renames[lengthBinding.name] ?? lengthBinding.name;
    lines.push(
        ...interpolationDeclarationLines(
            "    ",
            `const double ${lengthName} =`,
            renderCppExpression(scope, lengthBinding.initializer).text,
        ),
    );
    names.set(lengthBinding.name, lengthName);
    // The positive-length guard with its normalize-in-place stores.
    const guard = statements[index];
    index += 1;
    if (!guard || !ts.isIfStatement(guard) || guard.elseStatement) {
        refuseNode(
            symbol,
            file,
            guard ?? declaration,
            "no longer guards the normalize on a positive squared length",
        );
    }
    lines.push(
        `    if (${renderCppExpression(scope, guard.expression).text}) {`,
    );
    if (!ts.isBlock(guard.thenStatement)) {
        refuseNode(
            symbol,
            file,
            guard,
            "no longer wraps the normalize stores in a block",
        );
    }
    const branch = guard.thenStatement.statements;
    const inverseBinding = singleBinding(symbol, file, branch[0], guard);
    const inverseName = renames[inverseBinding.name] ??
        inverseBinding.name;
    lines.push(
        ...interpolationDeclarationLines(
            "        ",
            `const double ${inverseName} =`,
            renderCppExpression(scope, inverseBinding.initializer).text,
        ),
    );
    names.set(inverseBinding.name, inverseName);
    const stores = collectLaneStores(scope, branch, 1, 4, laneOf);
    if (stores.next !== branch.length) {
        refuseNode(
            symbol,
            file,
            branch[stores.next] ?? guard,
            "carries statements after the normalize stores",
        );
    }
    lines.push(
        ...vecBuildLines(
            "        ",
            "return Vec4{",
            stores.expressions.map((expression) => [
                renderCppExpression(scope, expression).text,
            ]),
            "};",
        ),
        "    }",
    );
    if (index !== statements.length) {
        refuseNode(
            symbol,
            file,
            statements[index] ?? declaration,
            "carries statements after the length guard",
        );
    }
    lines.push("    return value;", "}");
    return lines.join("\n");
}

/**
 * `quatSlerp(out, ax..aw, bx..bw, t)` → `interpolate_quaternion`.
 *
 * The eight component parameters bind to the two quaternions' members —
 * `const` exactly where the pin never reassigns them — the near-parallel
 * branch's Float32Array scratch becomes the rounded `lerped` build, and
 * the general branch's four weighted stores become the returned Vec4.
 */
function emitInterpolateQuaternion(
    declaration: ts.FunctionDeclaration & { body: ts.Block },
    file: ts.SourceFile,
    normalizePinName: string,
): string {
    const symbol = "quatSlerp";
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 10) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (out, four left lanes, four right lanes, t)",
        );
    }
    const outName = parameters[0]!;
    // Which parameters the pin reassigns decides const-ness below.
    const reassigned = new Set<string>();
    const findReassignments = (node: ts.Node): void => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left)
        ) {
            reassigned.add(node.left.text);
        }
        ts.forEachChild(node, findReassignments);
    };
    findReassignments(declaration.body);
    const names = new Map<string, string>();
    const renames: Readonly<Record<string, string>> = {
        sinTheta: "sin_theta",
        wa: "left_weight",
        wb: "right_weight",
    };
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    const lines: string[] = [
        "Vec4 interpolate_quaternion(Vec4 left, Vec4 right, double amount) {",
        "    // Pinned sampler evaluation lifts float32 keyframes to JavaScript",
        "    // doubles and rounds once at the Float32Array store.",
    ];
    const sides = [
        { vec: "left", prefix: "l" },
        { vec: "right", prefix: "r" },
    ] as const;
    sides.forEach((side, sideIndex) => {
        for (let lane = 0; lane < 4; lane += 1) {
            const pinName = parameters[1 + sideIndex * 4 + lane]!;
            const cppName = `${side.prefix}${laneMembers[lane]!}`;
            names.set(pinName, cppName);
            const qualifier = reassigned.has(pinName) ? "" : "const ";
            lines.push(
                `    ${qualifier}double ${cppName} = ` +
                    `${side.vec}.${laneMembers[lane]!};`,
            );
        }
    });
    names.set(parameters[9]!, "amount");
    const literalLaneOf = (
        target: ts.ElementAccessExpression,
    ): number | undefined =>
        ts.isIdentifier(target.expression) &&
            target.expression.text === outName &&
            ts.isNumericLiteral(target.argumentExpression)
            ? Number.parseInt(target.argumentExpression.text, 10)
            : undefined;
    const emitLocal = (statement: ts.Statement | undefined): void => {
        const binding = singleBinding(symbol, file, statement, declaration);
        const rendered = renderCppExpression(
            scope,
            binding.initializer,
        ).text;
        const cppName = renames[binding.name] ?? binding.name;
        lines.push(
            ...interpolationDeclarationLines(
                "    ",
                `${binding.isConst ? "const " : ""}double ${cppName} =`,
                rendered,
            ),
        );
        names.set(binding.name, cppName);
    };
    const statements = declaration.body.statements;
    let index = 0;
    // `let dot = ax * bx + …`.
    emitLocal(statements[index]);
    index += 1;
    // The hemisphere flip: negate the right quaternion in place.
    const flip = statements[index];
    index += 1;
    if (
        !flip ||
        !ts.isIfStatement(flip) ||
        flip.elseStatement ||
        !ts.isBlock(flip.thenStatement)
    ) {
        refuseNode(
            symbol,
            file,
            flip ?? declaration,
            "no longer flips the right quaternion behind a guard",
        );
    }
    lines.push(
        `    if (${renderCppExpression(scope, flip.expression).text}) {`,
    );
    for (const inner of flip.thenStatement.statements) {
        const assignment = ts.isExpressionStatement(inner) &&
                ts.isBinaryExpression(inner.expression) &&
                inner.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(inner.expression.left)
            ? inner.expression
            : undefined;
        const target = assignment
            ? names.get((assignment.left as ts.Identifier).text)
            : undefined;
        if (!assignment || target === undefined) {
            refuseNode(
                symbol,
                file,
                inner,
                "no longer negates a lowered local inside the flip",
            );
        }
        lines.push(
            `        ${target} = ` +
                `${renderCppExpression(scope, assignment.right).text};`,
        );
    }
    lines.push("    }");
    // The near-parallel branch: lerp into the Float32Array scratch, then
    // normalize the rounded components in place.
    const nearParallel = statements[index];
    index += 1;
    if (
        !nearParallel ||
        !ts.isIfStatement(nearParallel) ||
        nearParallel.elseStatement ||
        !ts.isBlock(nearParallel.thenStatement)
    ) {
        refuseNode(
            symbol,
            file,
            nearParallel ?? declaration,
            "no longer guards the near-parallel lerp",
        );
    }
    lines.push(
        `    if (${
            renderCppExpression(scope, nearParallel.expression).text
        }) {`,
        "        // The pinned near-parallel path stores the double lerp into a",
        "        // Float32Array scratch before normalizing it in place, so the",
        "        // components round to float32 between the two steps.",
    );
    const branch = nearParallel.thenStatement.statements;
    const lerpStores = collectLaneStores(
        scope,
        branch,
        0,
        4,
        literalLaneOf,
    );
    const normalizeCall = branch[lerpStores.next];
    const callExpression = normalizeCall &&
            ts.isExpressionStatement(normalizeCall) &&
            ts.isCallExpression(normalizeCall.expression)
        ? normalizeCall.expression
        : undefined;
    const callTargetsScratch = callExpression !== undefined &&
        ts.isIdentifier(callExpression.expression) &&
        callExpression.expression.text === normalizePinName &&
        callExpression.arguments.length === 2 &&
        ts.isIdentifier(callExpression.arguments[0]!) &&
        (callExpression.arguments[0] as ts.Identifier).text === outName &&
        ts.isNumericLiteral(callExpression.arguments[1]!) &&
        Number(
            (callExpression.arguments[1] as ts.NumericLiteral).text,
        ) === 0;
    const trailingReturn = branch[lerpStores.next + 1];
    if (
        !callTargetsScratch ||
        !trailingReturn ||
        !ts.isReturnStatement(trailingReturn) ||
        trailingReturn.expression ||
        lerpStores.next + 2 !== branch.length
    ) {
        refuseNode(
            symbol,
            file,
            nearParallel,
            "no longer normalizes the scratch and returns after the lerp",
        );
    }
    lines.push(
        ...vecBuildLines(
            "        ",
            "const Vec4 lerped{",
            lerpStores.expressions.map((expression) => [
                renderCppExpression(scope, expression).text,
            ]),
            "};",
        ),
        `        return ${normalizeQuaternionCppName}(lerped);`,
        "    }",
    );
    // The general branch's angle, weights, and four weighted stores.
    while (
        index < statements.length &&
        ts.isVariableStatement(statements[index]!)
    ) {
        emitLocal(statements[index]);
        index += 1;
    }
    const tailStores = collectLaneStores(
        scope,
        statements,
        index,
        4,
        literalLaneOf,
    );
    if (tailStores.next !== statements.length) {
        refuseNode(
            symbol,
            file,
            statements[tailStores.next] ?? declaration,
            "carries statements after the weighted stores",
        );
    }
    lines.push(
        ...vecBuildLines(
            "    ",
            "return Vec4{",
            tailStores.expressions.map((expression) => [
                renderCppExpression(scope, expression).text,
            ]),
            "};",
        ),
        "}",
    );
    return lines.join("\n");
}

/**
 * How the pin's `[inTangent, value, outTangent]` triplet maps to the
 * C++ parameters. Only the slots the pinned evaluator reads are named;
 * a permuted layout upstream misses the map and refuses.
 */
const cubicTripletSlots: Readonly<
    Record<"left" | "right", Readonly<Record<number, string>>>
> = {
    left: { 1: "left", 2: "left_tangent" },
    right: { 0: "right_tangent", 1: "right" },
};

function hasLocalDeclaration(
    declaration: ts.FunctionDeclaration,
    name: string,
): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name
        ) {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    return found;
}

/** Flattens a left-associated `a + b + c + …` chain into its terms. */
function additiveTerms(expression: ts.Expression): ts.Expression[] {
    const node = unwrapPin(expression);
    if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
        return [...additiveTerms(node.left), node.right];
    }
    return [expression];
}

/**
 * The CUBICSPLINE branch of `evaluateSampler` → `cubic_quaternion` /
 * `cubic_vec3`.
 *
 * The Hermite basis lowers verbatim; the pin's `output[k + slot·stride
 * + c]` triplet reads resolve through `cubicTripletSlots` to the vector
 * parameters; the per-component loop unrolls over the lanes the C++
 * variant carries; and the trailing `isQuat` normalize folds to the arm
 * each variant statically takes.
 */
function emitCubicHermite(
    declaration: ts.FunctionDeclaration & { body: ts.Block },
    file: ts.SourceFile,
    normalizePinName: string,
    lanes: 3 | 4,
): string {
    const symbol = "evaluateSampler";
    const vecType = lanes === 4 ? "Vec4" : "Vec3";
    const cppName = lanes === 4 ? "cubic_quaternion" : "cubic_vec3";
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 6) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (sampler, t, stride, isQuat, dst, dstOffset)",
        );
    }
    const strideName = parameters[2]!;
    const isQuatName = parameters[3]!;
    const dstName = parameters[4]!;
    const dstOffsetName = parameters[5]!;
    // The destructured sampler fields the branch reads.
    let outputName: string | undefined;
    let interpolationName: string | undefined;
    for (const statement of declaration.body.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const binding of statement.declarationList.declarations) {
            if (!ts.isObjectBindingPattern(binding.name)) continue;
            for (const element of binding.name.elements) {
                if (!ts.isIdentifier(element.name)) continue;
                const property = element.propertyName &&
                        ts.isIdentifier(element.propertyName)
                    ? element.propertyName.text
                    : element.name.text;
                if (property === "output") {
                    outputName = element.name.text;
                }
                if (property === "interpolation") {
                    interpolationName = element.name.text;
                }
            }
        }
    }
    if (outputName === undefined || interpolationName === undefined) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer destructures the sampler's output and interpolation",
        );
    }
    const cubicIf = declaration.body.statements.find(
        (statement): statement is ts.IfStatement =>
            ts.isIfStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            statement.expression.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isIdentifier(statement.expression.left) &&
            statement.expression.left.text === interpolationName &&
            ts.isIdentifier(statement.expression.right) &&
            statement.expression.right.text === "INTERP_CUBICSPLINE",
    );
    if (!cubicIf || !ts.isBlock(cubicIf.thenStatement)) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer carries a CUBICSPLINE branch",
        );
    }
    const block = cubicIf.thenStatement.statements;
    const names = new Map<string, string>();
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    /** `k = base * stride * 3` — the pin's per-key triplet origin. */
    const keyBaseOf = (
        initializer: ts.Expression,
    ): ts.Expression | undefined => {
        const outer = unwrapPin(initializer);
        if (
            !ts.isBinaryExpression(outer) ||
            outer.operatorToken.kind !== ts.SyntaxKind.AsteriskToken ||
            !ts.isNumericLiteral(outer.right) ||
            Number(outer.right.text) !== 3
        ) {
            return undefined;
        }
        const inner = unwrapPin(outer.left);
        if (
            !ts.isBinaryExpression(inner) ||
            inner.operatorToken.kind !== ts.SyntaxKind.AsteriskToken ||
            !ts.isIdentifier(inner.right) ||
            inner.right.text !== strideName
        ) {
            return undefined;
        }
        return unwrapPin(inner.left);
    };
    const isKeyBase = (statement: ts.Statement): boolean =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1 &&
        statement.declarationList.declarations[0]!.initializer !==
            undefined &&
        keyBaseOf(
            statement.declarationList.declarations[0]!.initializer!,
        ) !== undefined;
    let index = 0;
    // The Hermite basis. The pin's fractional time is derived from the
    // first `f2 = f * f` binding, so an upstream rename cannot silently
    // detach the correspondence.
    const firstBinding = singleBinding(
        symbol,
        file,
        block[index],
        cubicIf,
    );
    const firstInitializer = unwrapPin(firstBinding.initializer);
    if (
        !ts.isBinaryExpression(firstInitializer) ||
        firstInitializer.operatorToken.kind !==
            ts.SyntaxKind.AsteriskToken ||
        !ts.isIdentifier(firstInitializer.left) ||
        !ts.isIdentifier(firstInitializer.right) ||
        firstInitializer.left.text !== firstInitializer.right.text
    ) {
        refuseNode(
            symbol,
            file,
            firstBinding.statement,
            "no longer squares the fractional time first",
        );
    }
    const fractionName = firstInitializer.left.text;
    if (!hasLocalDeclaration(declaration, fractionName)) {
        refuseNode(
            symbol,
            file,
            firstBinding.statement,
            `reads '${fractionName}', which the sampler no longer binds`,
        );
    }
    names.set(fractionName, "amount");
    const renames: Readonly<Record<string, string>> = {
        f2: "amount2",
        f3: "amount3",
    };
    const hermiteLines: string[] = [];
    while (
        index < block.length &&
        ts.isVariableStatement(block[index]!) &&
        !isKeyBase(block[index]!)
    ) {
        const binding = singleBinding(symbol, file, block[index], cubicIf);
        index += 1;
        const rendered = renderCppExpression(
            scope,
            binding.initializer,
        ).text;
        const cpp = renames[binding.name] ?? binding.name;
        hermiteLines.push(
            ...interpolationDeclarationLines(
                "    ",
                `const double ${cpp} =`,
                rendered,
            ),
        );
        names.set(binding.name, cpp);
    }
    // The two key origins: which key a `k` local addresses.
    const keySides = new Map<string, "left" | "right">();
    let idxName: string | undefined;
    for (let key = 0; key < 2; key += 1) {
        const binding = singleBinding(symbol, file, block[index], cubicIf);
        index += 1;
        const base = keyBaseOf(binding.initializer);
        if (base && ts.isIdentifier(base)) {
            idxName ??= base.text;
            if (base.text !== idxName) {
                refuseNode(
                    symbol,
                    file,
                    binding.statement,
                    "no longer derives both key origins from one index",
                );
            }
            keySides.set(binding.name, "left");
            continue;
        }
        if (
            base &&
            ts.isBinaryExpression(base) &&
            base.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(base.left) &&
            (idxName === undefined || base.left.text === idxName) &&
            ts.isNumericLiteral(base.right) &&
            Number(base.right.text) === 1
        ) {
            idxName ??= base.left.text;
            keySides.set(binding.name, "right");
            continue;
        }
        refuseNode(
            symbol,
            file,
            binding.statement,
            "no longer indexes the keyframe triplets the lowered way",
        );
    }
    if (
        [...keySides.values()].filter((side) => side === "left")
                .length !== 1 ||
        keySides.size !== 2
    ) {
        refuseNode(
            symbol,
            file,
            cubicIf,
            "no longer addresses one left and one right key",
        );
    }
    // The per-component loop, unrolled over this variant's lanes.
    const loop = block[index];
    index += 1;
    if (
        !loop ||
        !ts.isForStatement(loop) ||
        !loop.initializer ||
        !ts.isVariableDeclarationList(loop.initializer) ||
        loop.initializer.declarations.length !== 1 ||
        !ts.isIdentifier(loop.initializer.declarations[0]!.name) ||
        !loop.condition ||
        !ts.isBinaryExpression(loop.condition) ||
        loop.condition.operatorToken.kind !==
            ts.SyntaxKind.LessThanToken ||
        !ts.isIdentifier(loop.condition.right) ||
        loop.condition.right.text !== strideName ||
        !ts.isBlock(loop.statement)
    ) {
        refuseNode(
            symbol,
            file,
            loop ?? cubicIf,
            "no longer loops one component at a time over the stride",
        );
    }
    const componentName = (
        loop.initializer.declarations[0]!.name as ts.Identifier
    ).text;
    const loopBody = loop.statement.statements;
    /** `output[k…]`, `output[k + stride…]`, `output[k + n·stride…]`. */
    const tripletRead = (
        expression: ts.Expression,
        lane: number,
    ): string => {
        const read = unwrapPin(expression);
        if (
            !ts.isElementAccessExpression(read) ||
            !ts.isIdentifier(read.expression) ||
            read.expression.text !== outputName
        ) {
            refuseNode(
                symbol,
                file,
                expression,
                "no longer reads the sampler output the lowered way",
            );
        }
        const full = unwrapPin(read.argumentExpression);
        if (
            !ts.isBinaryExpression(full) ||
            full.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
            !ts.isIdentifier(full.right) ||
            full.right.text !== componentName
        ) {
            refuseNode(
                symbol,
                file,
                read,
                "no longer offsets the triplet read by the component",
            );
        }
        const offset = unwrapPin(full.left);
        let keyLocal: string | undefined;
        let slot: number | undefined;
        if (ts.isIdentifier(offset)) {
            keyLocal = offset.text;
            slot = 0;
        } else if (
            ts.isBinaryExpression(offset) &&
            offset.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(offset.left)
        ) {
            keyLocal = offset.left.text;
            const slotExpression = unwrapPin(offset.right);
            if (
                ts.isIdentifier(slotExpression) &&
                slotExpression.text === strideName
            ) {
                slot = 1;
            } else if (
                ts.isBinaryExpression(slotExpression) &&
                slotExpression.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                ts.isNumericLiteral(slotExpression.left) &&
                ts.isIdentifier(slotExpression.right) &&
                slotExpression.right.text === strideName
            ) {
                slot = Number(slotExpression.left.text);
            }
        }
        const side = keyLocal === undefined
            ? undefined
            : keySides.get(keyLocal);
        const vecName = side === undefined || slot === undefined
            ? undefined
            : cubicTripletSlots[side][slot];
        if (vecName === undefined) {
            refuseNode(
                symbol,
                file,
                read,
                "reads a triplet slot outside the pinned " +
                    "[inTangent, value, outTangent] layout",
            );
        }
        return `${vecName}.${laneMembers[lane]!}`;
    };
    let deltaName: string | undefined;
    const laneSubstitution = (
        initializer: ts.Expression,
        lane: number,
    ): RenderedCpp => {
        const value = unwrapPin(initializer);
        if (ts.isElementAccessExpression(value)) {
            return {
                text: tripletRead(value, lane),
                precedence: cppPrecedence.primary,
            };
        }
        if (
            ts.isBinaryExpression(value) &&
            value.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
            ts.isIdentifier(value.right)
        ) {
            if (deltaName === undefined) {
                deltaName = value.right.text;
                if (!hasLocalDeclaration(declaration, deltaName)) {
                    refuseNode(
                        symbol,
                        file,
                        value,
                        `scales by '${deltaName}', which the sampler ` +
                            "no longer binds",
                    );
                }
            }
            if (value.right.text !== deltaName) {
                refuseNode(
                    symbol,
                    file,
                    value,
                    "no longer scales every tangent by one key delta",
                );
            }
            return {
                text: `${tripletRead(value.left, lane)} * span`,
                precedence: cppPrecedence.multiplicative,
            };
        }
        refuseNode(
            symbol,
            file,
            initializer,
            "binds a loop local this lowering cannot carry",
        );
    };
    const entries: string[][] = [];
    for (let lane = 0; lane < lanes; lane += 1) {
        const substitutions = new Map<string, RenderedCpp>();
        const laneScope: CppExpressionScope = {
            symbol,
            file,
            names,
            substitutions,
            numeric: pinnedDoubleLiteral,
        };
        let bodyIndex = 0;
        while (bodyIndex < loopBody.length - 1) {
            const binding = singleBinding(
                symbol,
                file,
                loopBody[bodyIndex],
                loop,
            );
            bodyIndex += 1;
            substitutions.set(
                binding.name,
                laneSubstitution(binding.initializer, lane),
            );
        }
        const store = loopBody[loopBody.length - 1];
        const assignment = store &&
                ts.isExpressionStatement(store) &&
                ts.isBinaryExpression(store.expression) &&
                store.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? store.expression
            : undefined;
        const target = assignment
            ? unwrapPin(assignment.left)
            : undefined;
        const storesComponent = target !== undefined &&
            ts.isElementAccessExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === dstName &&
            ts.isBinaryExpression(target.argumentExpression) &&
            target.argumentExpression.operatorToken.kind ===
                ts.SyntaxKind.PlusToken &&
            ts.isIdentifier(target.argumentExpression.left) &&
            target.argumentExpression.left.text === dstOffsetName &&
            ts.isIdentifier(target.argumentExpression.right) &&
            target.argumentExpression.right.text === componentName;
        if (!assignment || !storesComponent) {
            refuseNode(
                symbol,
                file,
                store ?? loop,
                "no longer stores the Hermite sum per component",
            );
        }
        entries.push(
            additiveTerms(assignment.right).map(
                (term) => renderCppExpression(laneScope, term).text,
            ),
        );
    }
    // `if (isQuat) normalizeQuat4(dst, dstOffset)` — statically taken by
    // the rotation variant, statically empty for vec3 — then `return`.
    const quatGuard = block[index];
    index += 1;
    const guardCall = quatGuard &&
            ts.isIfStatement(quatGuard) &&
            !quatGuard.elseStatement &&
            ts.isIdentifier(quatGuard.expression) &&
            quatGuard.expression.text === isQuatName &&
            ts.isBlock(quatGuard.thenStatement) &&
            quatGuard.thenStatement.statements.length === 1 &&
            ts.isExpressionStatement(
                quatGuard.thenStatement.statements[0]!,
            ) &&
            ts.isCallExpression(
                (
                    quatGuard.thenStatement
                        .statements[0] as ts.ExpressionStatement
                ).expression,
            )
        ? (
            quatGuard.thenStatement
                .statements[0] as ts.ExpressionStatement
        ).expression as ts.CallExpression
        : undefined;
    const guardNormalizes = guardCall !== undefined &&
        ts.isIdentifier(guardCall.expression) &&
        guardCall.expression.text === normalizePinName &&
        guardCall.arguments.length === 2 &&
        ts.isIdentifier(guardCall.arguments[0]!) &&
        (guardCall.arguments[0] as ts.Identifier).text === dstName &&
        ts.isIdentifier(guardCall.arguments[1]!) &&
        (guardCall.arguments[1] as ts.Identifier).text === dstOffsetName;
    const trailing = block[index];
    index += 1;
    if (
        !guardNormalizes ||
        !trailing ||
        !ts.isReturnStatement(trailing) ||
        trailing.expression ||
        index !== block.length
    ) {
        refuseNode(
            symbol,
            file,
            quatGuard ?? cubicIf,
            "no longer normalizes rotations and returns after the loop",
        );
    }
    const lines: string[] = [
        `${vecType} ${cppName}(`,
        `    ${vecType} left,`,
        `    ${vecType} left_tangent,`,
        `    ${vecType} right,`,
        `    ${vecType} right_tangent,`,
        "    double amount,",
        "    double span) {",
        "    // Pinned sampler evaluation lifts float32 keyframes to JavaScript",
        "    // doubles and rounds once at the Float32Array store.",
        ...hermiteLines,
    ];
    if (lanes === 4) {
        lines.push(
            "    // The pinned evaluator scales tangents by the key delta before",
            "    // weighting, stores the Hermite sum into a Float32Array, and then",
            "    // normalizes the rounded components in place.",
            ...vecBuildLines("    ", "const Vec4 combined{", entries, "};"),
            `    return ${normalizeQuaternionCppName}(combined);`,
        );
    } else {
        lines.push(
            "    // The pinned evaluator scales tangents by the key delta before",
            "    // weighting and rounds once at the Float32Array store.",
            ...vecBuildLines("    ", "return Vec3{", entries, "};"),
        );
    }
    lines.push("}");
    return lines.join("\n");
}

/**
 * The animation-interpolation segment of the generated glTF loader,
 * lowered from `src/animation/evaluate.ts`: `normalizeQuat4`,
 * `quatSlerp`, and the CUBICSPLINE branch of `evaluateSampler`, the
 * latter emitted once per stride the loader's tracks carry (quaternion
 * rotations and vec3 translations/scales).
 */
export function lowerAnimationInterpolationCpp(
    file: ts.SourceFile,
): string {
    const normalize = topLevelFunction(file, "normalizeQuat4");
    const slerp = topLevelFunction(file, "quatSlerp");
    const evaluate = topLevelFunction(file, "evaluateSampler");
    const normalizePinName = normalize.name!.text;
    return [
        emitNormalizeQuaternion(normalize, file),
        emitInterpolateQuaternion(slerp, file, normalizePinName),
        emitCubicHermite(evaluate, file, normalizePinName, 4),
        emitCubicHermite(evaluate, file, normalizePinName, 3),
    ].join("\n\n");
}

/**
 * The native locals that stand in for the pin's absent-capable sampler
 * reads, and the glTF default each one substitutes for an absent JSON
 * property. The pin leaves an absent `s?.minFilter` as `undefined` and
 * lets its predicates evaluate over that; the C++ locals are total, so
 * each absent read substitutes the spec default whose predicate results
 * `assertAbsentSubstitution` proves identical to the undefined case.
 */
const samplerEnumLocals: Readonly<
    Record<string, { cpp: string; absent: number }>
> = {
    minFilter: { cpp: "min_filter", absent: 9987 },
    magFilter: { cpp: "mag_filter", absent: 9729 },
};

/** glTF REPEAT, substituted where the pin passes an absent wrap mode. */
const samplerWrapAbsent = 10497;

const textureFilterByPin: Readonly<Record<string, string>> = {
    nearest: "TextureFilter::nearest",
    linear: "TextureFilter::linear",
};

const mipmapModeByPin: Readonly<Record<string, string>> = {
    nearest: "TextureMipmapMode::nearest",
    linear: "TextureMipmapMode::linear",
};

const addressModeByPin: Readonly<Record<string, string>> = {
    "clamp-to-edge": "TextureAddressMode::clamp",
    "mirror-repeat": "TextureAddressMode::mirror",
    repeat: "TextureAddressMode::repeat",
};

/**
 * How the pin's returned `GPUSamplerDescriptor` maps onto the loader's
 * sampler record: by property NAME, never positionally, in the record's
 * own emission order. Every property the pin returns must be consumed
 * by exactly one entry — a new descriptor field upstream refuses
 * generation instead of being silently dropped.
 */
const samplerFieldTable: readonly {
    property: string;
    field: string;
    kind: "filter" | "lodClamp" | "anisotropy" | "address";
    enums?: Readonly<Record<string, string>>;
}[] = [
    {
        property: "minFilter",
        field: "result.sampler.min_filter",
        kind: "filter",
        enums: textureFilterByPin,
    },
    {
        property: "mipmapFilter",
        field: "result.sampler.mipmap_mode",
        kind: "filter",
        enums: mipmapModeByPin,
    },
    {
        property: "magFilter",
        field: "result.sampler.mag_filter",
        kind: "filter",
        enums: textureFilterByPin,
    },
    {
        property: "lodMaxClamp",
        field: "result.sampler.max_lod",
        kind: "lodClamp",
    },
    {
        property: "maxAnisotropy",
        field: "result.sampler.max_anisotropy",
        kind: "anisotropy",
    },
    {
        property: "addressModeU",
        field: "result.sampler.address_u",
        kind: "address",
    },
    {
        property: "addressModeV",
        field: "result.sampler.address_v",
        kind: "address",
    },
];

type PinConstant = number | string | boolean | undefined;

function pinTruthy(value: PinConstant): boolean {
    return typeof value === "number"
        ? value !== 0 && !Number.isNaN(value)
        : typeof value === "string"
        ? value.length > 0
        : value === true;
}

/**
 * Evaluates a pinned predicate the way JavaScript would, over sampler
 * reads resolved by `resolve`. This is what proves an absent-property
 * default substitution sound: the predicate must yield the same result
 * for `undefined` as for the substituted enum.
 */
function evaluatePinExpression(
    symbol: string,
    file: ts.SourceFile,
    expression: ts.Expression,
    resolve: (name: string, node: ts.Node) => PinConstant,
): PinConstant {
    const node = unwrapPin(expression);
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) {
        if (node.text === "undefined") return undefined;
        return resolve(node.text, node);
    }
    if (ts.isPropertyAccessChain(node)) {
        return resolve(node.name.text, node);
    }
    if (ts.isPrefixUnaryExpression(node)) {
        if (node.operator !== ts.SyntaxKind.ExclamationToken) {
            refuseNode(
                symbol,
                file,
                node,
                "uses a unary operator the substitution check cannot run",
            );
        }
        return !pinTruthy(
            evaluatePinExpression(symbol, file, node.operand, resolve),
        );
    }
    if (ts.isConditionalExpression(node)) {
        const condition = evaluatePinExpression(
            symbol,
            file,
            node.condition,
            resolve,
        );
        return evaluatePinExpression(
            symbol,
            file,
            pinTruthy(condition) ? node.whenTrue : node.whenFalse,
            resolve,
        );
    }
    if (ts.isBinaryExpression(node)) {
        const kind = node.operatorToken.kind;
        if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            const left = evaluatePinExpression(
                symbol,
                file,
                node.left,
                resolve,
            );
            return pinTruthy(left)
                ? evaluatePinExpression(symbol, file, node.right, resolve)
                : left;
        }
        if (kind === ts.SyntaxKind.BarBarToken) {
            const left = evaluatePinExpression(
                symbol,
                file,
                node.left,
                resolve,
            );
            return pinTruthy(left)
                ? left
                : evaluatePinExpression(symbol, file, node.right, resolve);
        }
        const left = evaluatePinExpression(symbol, file, node.left, resolve);
        const right = evaluatePinExpression(
            symbol,
            file,
            node.right,
            resolve,
        );
        if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
            return left === right;
        }
        if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            return left !== right;
        }
        if (kind === ts.SyntaxKind.PercentToken) {
            return Number(left) % Number(right);
        }
        refuseNode(
            symbol,
            file,
            node,
            "uses an operator the substitution check cannot run",
        );
    }
    refuseNode(
        symbol,
        file,
        node,
        "uses an expression the substitution check cannot run",
    );
}

/**
 * The sampler-mapping segment of the generated glTF loader, lowered
 * from `gltfTexSamplerDesc`: the wrap-mode map, the min/mag/mip filter
 * derivation from the combined glTF enums, the no-mip LOD clamp, and
 * the anisotropy rule, each written into the loader's sampler record
 * through `samplerFieldTable`.
 */
export function lowerSamplerMappingCpp(file: ts.SourceFile): string {
    const symbol = "gltfTexSamplerDesc";
    const declaration = topLevelFunction(file, symbol);
    const statements = declaration.body.statements;
    let index = 0;
    // 1. The sampler resolution. The template's hand-written preamble
    //    still owns the JSON walk this round; the binding is required
    //    here because every read below resolves through it.
    const samplerBinding = singleBinding(
        symbol,
        file,
        statements[index],
        declaration,
    );
    index += 1;
    const samplerLocal = samplerBinding.name;
    if (!ts.isConditionalExpression(unwrapPin(samplerBinding.initializer))) {
        refuseNode(
            symbol,
            file,
            samplerBinding.statement,
            "no longer resolves the sampler behind a null test",
        );
    }
    // 2. The wrap-mode arrow, rendered later as the address_mode lambda.
    const wrapBinding = singleBinding(
        symbol,
        file,
        statements[index],
        declaration,
    );
    index += 1;
    const wrapArrow = unwrapPin(wrapBinding.initializer);
    const wrapParameter = ts.isArrowFunction(wrapArrow) &&
            wrapArrow.parameters.length === 1 &&
            ts.isIdentifier(wrapArrow.parameters[0]!.name)
        ? (wrapArrow.parameters[0]!.name as ts.Identifier).text
        : undefined;
    const wrapChain = wrapParameter !== undefined &&
            ts.isArrowFunction(wrapArrow) &&
            !ts.isBlock(wrapArrow.body)
        ? unwrapPin(wrapArrow.body)
        : undefined;
    if (
        wrapParameter === undefined ||
        wrapChain === undefined ||
        !ts.isConditionalExpression(wrapChain)
    ) {
        refuseNode(
            symbol,
            file,
            wrapBinding.statement,
            "no longer maps wrap modes through a conditional chain",
        );
    }
    // 3. The enum locals and the filter predicates, in the pin's order.
    const enumBindingOrder: {
        property: string;
        cpp: string;
        absent: number;
    }[] = [];
    const enumByPinLocal = new Map<string, string>();
    const registerEnumProperty = (
        property: string,
        node: ts.Node,
    ): { property: string; cpp: string; absent: number } => {
        const known = enumBindingOrder.find(
            (entry) => entry.property === property,
        );
        if (known) return known;
        const config = samplerEnumLocals[property];
        if (!config) {
            refuseNode(
                symbol,
                file,
                node,
                `reads sampler property '${property}' with no lowering entry`,
            );
        }
        const entry = { property, ...config };
        enumBindingOrder.push(entry);
        return entry;
    };
    const minBinding = singleBinding(
        symbol,
        file,
        statements[index],
        declaration,
    );
    index += 1;
    const minRead = unwrapPin(minBinding.initializer);
    if (
        !ts.isPropertyAccessChain(minRead) ||
        !ts.isIdentifier(minRead.expression) ||
        minRead.expression.text !== samplerLocal
    ) {
        refuseNode(
            symbol,
            file,
            minBinding.statement,
            "no longer binds the min filter from the sampler",
        );
    }
    const minEntry = registerEnumProperty(minRead.name.text, minRead);
    const names = new Map<string, string>();
    names.set(minBinding.name, minEntry.cpp);
    enumByPinLocal.set(minBinding.name, minEntry.property);
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        // The sampler segment compares C++ enum values verbatim.
        numeric: (literal) => literal.text,
        chainRead: (expression) => {
            if (
                !ts.isIdentifier(expression.expression) ||
                expression.expression.text !== samplerLocal
            ) {
                refuseNode(
                    symbol,
                    file,
                    expression,
                    "reads an optional chain off something other than " +
                        "the sampler",
                );
            }
            const entry = registerEnumProperty(
                expression.name.text,
                expression,
            );
            return { text: entry.cpp, precedence: cppPrecedence.primary };
        },
    };
    /** Resolves pin reads for the absent-substitution check. */
    const resolveOver = (
        environment: (property: string) => PinConstant,
    ) =>
    (name: string, node: ts.Node): PinConstant => {
        const property = enumByPinLocal.get(name) ??
            (samplerEnumLocals[name] ? name : undefined);
        if (property === undefined) {
            refuseNode(
                symbol,
                file,
                node,
                `reads '${name}', which the substitution check cannot ` +
                    "resolve",
            );
        }
        return environment(property);
    };
    const assertAbsentSubstitution = (
        expression: ts.Expression,
        anchor: ts.Node,
    ): void => {
        const absent = evaluatePinExpression(
            symbol,
            file,
            expression,
            resolveOver(() => undefined),
        );
        const substituted = evaluatePinExpression(
            symbol,
            file,
            expression,
            resolveOver(
                (property) => samplerEnumLocals[property]?.absent,
            ),
        );
        if (absent !== substituted) {
            refuseNode(
                symbol,
                file,
                anchor,
                "no longer evaluates the same for an absent sampler as " +
                    "for the substituted glTF default",
            );
        }
    };
    const predicateRenames: Readonly<Record<string, string>> = {
        minNearest: "min_nearest",
        mipNearest: "mip_nearest",
        noMip: "no_mip",
        magLinear: "mag_linear",
    };
    const predicateLines: string[] = [];
    while (
        index < statements.length &&
        ts.isVariableStatement(statements[index]!)
    ) {
        const binding = singleBinding(
            symbol,
            file,
            statements[index],
            declaration,
        );
        index += 1;
        const cpp = predicateRenames[binding.name];
        if (cpp === undefined) {
            refuseNode(
                symbol,
                file,
                binding.statement,
                `binds '${binding.name}', which has no lowering entry`,
            );
        }
        // `!!minF && …` guards only the absent JavaScript property; the
        // C++ local is total (the default above substitutes), and valid
        // glTF filter enums are nonzero, so the truthiness guard drops.
        // The substitution check below runs over the FULL pinned
        // expression, guard included.
        let body: ts.Expression = binding.initializer;
        const guarded = unwrapPin(body);
        if (
            ts.isBinaryExpression(guarded) &&
            guarded.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken
        ) {
            const left = unwrapPin(guarded.left);
            const doubleNegated = ts.isPrefixUnaryExpression(left) &&
                    left.operator === ts.SyntaxKind.ExclamationToken &&
                    ts.isPrefixUnaryExpression(unwrapPin(left.operand)) &&
                    (
                        unwrapPin(
                            left.operand,
                        ) as ts.PrefixUnaryExpression
                    ).operator === ts.SyntaxKind.ExclamationToken
                ? unwrapPin(
                    (
                        unwrapPin(
                            left.operand,
                        ) as ts.PrefixUnaryExpression
                    ).operand,
                )
                : undefined;
            if (
                doubleNegated !== undefined &&
                ts.isIdentifier(doubleNegated) &&
                enumByPinLocal.has(doubleNegated.text)
            ) {
                body = guarded.right;
            }
        }
        const rendered = renderCppExpression(scope, body).text;
        assertAbsentSubstitution(binding.initializer, binding.statement);
        names.set(binding.name, cpp);
        predicateLines.push(`    const bool ${cpp} = ${rendered};`);
    }
    // 4. The returned descriptor, consumed by name.
    const returnStatement = statements[index];
    index += 1;
    const returned = returnStatement &&
            ts.isReturnStatement(returnStatement) &&
            returnStatement.expression
        ? unwrapPin(returnStatement.expression)
        : undefined;
    if (
        !returned ||
        !ts.isObjectLiteralExpression(returned) ||
        index !== statements.length
    ) {
        refuseNode(
            symbol,
            file,
            returnStatement ?? declaration,
            "no longer ends by returning the descriptor object",
        );
    }
    const properties = new Map<string, ts.Expression>();
    let conditionalSpread:
        | { property: string; condition: ts.Expression; value: number }
        | undefined;
    for (const property of returned.properties) {
        if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name)
        ) {
            if (properties.has(property.name.text)) {
                refuseNode(
                    symbol,
                    file,
                    property,
                    "returns a duplicate descriptor property",
                );
            }
            properties.set(property.name.text, property.initializer);
            continue;
        }
        if (ts.isSpreadAssignment(property)) {
            const inner = unwrapPin(property.expression);
            const spreadObject = ts.isConditionalExpression(inner) &&
                    ts.isIdentifier(unwrapPin(inner.whenFalse)) &&
                    (
                        unwrapPin(inner.whenFalse) as ts.Identifier
                    ).text === "undefined"
                ? unwrapPin(inner.whenTrue)
                : undefined;
            const spreadField = spreadObject !== undefined &&
                    ts.isObjectLiteralExpression(spreadObject) &&
                    spreadObject.properties.length === 1 &&
                    ts.isPropertyAssignment(spreadObject.properties[0]!) &&
                    ts.isIdentifier(spreadObject.properties[0]!.name!)
                ? spreadObject.properties[0] as ts.PropertyAssignment
                : undefined;
            const spreadValue = spreadField !== undefined &&
                    ts.isNumericLiteral(
                        unwrapPin(spreadField.initializer),
                    )
                ? Number(
                    (
                        unwrapPin(
                            spreadField.initializer,
                        ) as ts.NumericLiteral
                    ).text,
                )
                : undefined;
            if (
                !spreadField ||
                spreadValue === undefined ||
                conditionalSpread !== undefined
            ) {
                refuseNode(
                    symbol,
                    file,
                    property,
                    "spreads a descriptor shape this lowering cannot carry",
                );
            }
            conditionalSpread = {
                property: (spreadField.name as ts.Identifier).text,
                condition: (inner as ts.ConditionalExpression).condition,
                value: spreadValue,
            };
            continue;
        }
        refuseNode(
            symbol,
            file,
            property,
            "returns a descriptor member this lowering cannot carry",
        );
    }
    // 5. Emission: the enum bindings in discovery order, the predicates
    //    in pin order, then the record fields in the table's order.
    const lines: string[] = [];
    for (const entry of enumBindingOrder) {
        lines.push(
            `    const std::size_t ${entry.cpp} =`,
            `        sampler ? unsigned_or(*sampler, "${entry.property}"` +
                `, ${entry.absent}) : ${entry.absent};`,
        );
    }
    lines.push(...predicateLines);
    const enumArm = (
        enums: Readonly<Record<string, string>>,
        expression: ts.Expression,
    ): string => {
        const literal = unwrapPin(expression);
        const mapped = ts.isStringLiteral(literal)
            ? enums[literal.text]
            : undefined;
        if (mapped === undefined) {
            refuseNode(
                symbol,
                file,
                expression,
                "returns a descriptor value with no native enum entry",
            );
        }
        return mapped;
    };
    const consumed = new Set<string>();
    let lambdaEmitted = false;
    for (const entry of samplerFieldTable) {
        if (entry.kind === "lodClamp") {
            if (
                conditionalSpread === undefined ||
                conditionalSpread.property !== entry.property
            ) {
                refuseNode(
                    symbol,
                    file,
                    returned,
                    `no longer guards '${entry.property}' on the no-mip rule`,
                );
            }
            const condition = renderCppExpression(
                scope,
                conditionalSpread.condition,
            ).text;
            // 1000 is the record's own no-clamp sentinel: the pin leaves
            // the property absent, which WebGPU treats as unclamped for
            // every mip chain this loader uploads.
            lines.push(
                `    ${entry.field} = ${condition} ? ` +
                    `${floatLiteral(conditionalSpread.value)} : 1000.0f;`,
            );
            consumed.add(entry.property);
            continue;
        }
        const initializer = properties.get(entry.property);
        if (!initializer) {
            refuseNode(
                symbol,
                file,
                returned,
                `no longer returns '${entry.property}'`,
            );
        }
        consumed.add(entry.property);
        if (entry.kind === "filter" || entry.kind === "anisotropy") {
            const conditional = unwrapPin(initializer);
            if (!ts.isConditionalExpression(conditional)) {
                refuseNode(
                    symbol,
                    file,
                    initializer,
                    `no longer derives '${entry.property}' from a predicate`,
                );
            }
            const condition = renderCppExpression(
                scope,
                conditional.condition,
            ).text;
            if (entry.kind === "filter") {
                lines.push(
                    `    ${entry.field} =`,
                    `        ${condition} ? ` +
                        `${enumArm(entry.enums!, conditional.whenTrue)} : ` +
                        `${enumArm(entry.enums!, conditional.whenFalse)};`,
                );
            } else {
                const whenTrue = unwrapPin(conditional.whenTrue);
                const whenFalse = unwrapPin(conditional.whenFalse);
                if (
                    !ts.isNumericLiteral(whenTrue) ||
                    !ts.isNumericLiteral(whenFalse)
                ) {
                    refuseNode(
                        symbol,
                        file,
                        conditional,
                        "no longer picks a literal anisotropy",
                    );
                }
                lines.push(
                    `    ${entry.field} =`,
                    `        ${condition}`,
                    `            ? ${floatLiteral(Number(whenTrue.text))}`,
                    `            : ${floatLiteral(Number(whenFalse.text))};`,
                );
            }
            continue;
        }
        // Address fields go through the pin's wrap map, emitted once as
        // the address_mode lambda before its first use.
        if (!lambdaEmitted) {
            lines.push(
                ...wrapLambdaLines(
                    symbol,
                    file,
                    wrapChain,
                    wrapParameter,
                ),
            );
            lambdaEmitted = true;
        }
        const call = unwrapPin(initializer);
        const argument = ts.isCallExpression(call) &&
                ts.isIdentifier(call.expression) &&
                call.expression.text === wrapBinding.name &&
                call.arguments.length === 1
            ? unwrapPin(call.arguments[0]!)
            : undefined;
        if (
            argument === undefined ||
            !ts.isPropertyAccessChain(argument) ||
            !ts.isIdentifier(argument.expression) ||
            argument.expression.text !== samplerLocal
        ) {
            refuseNode(
                symbol,
                file,
                initializer,
                `no longer wraps '${entry.property}' through the wrap map`,
            );
        }
        lines.push(
            `    ${entry.field} = address_mode(`,
            `        sampler ? unsigned_or(*sampler, ` +
                `"${argument.name.text}", ${samplerWrapAbsent}) : ` +
                `${samplerWrapAbsent});`,
        );
    }
    for (const name of properties.keys()) {
        if (!consumed.has(name)) {
            refuseNode(
                symbol,
                file,
                returned,
                `returns '${name}', which no lowering entry consumes`,
            );
        }
    }
    return lines.join("\n");
}

/**
 * The pin's wrap-mode conditional chain as the C++ `address_mode`
 * ladder, with the absent-wrap default proven equivalent to the pin's
 * undefined case before it is baked into the call sites.
 */
function wrapLambdaLines(
    symbol: string,
    file: ts.SourceFile,
    chain: ts.ConditionalExpression,
    parameterName: string,
): string[] {
    const resolve = (
        value: PinConstant,
    ): ((name: string, node: ts.Node) => PinConstant) =>
    (name, node) => {
        if (name !== parameterName) {
            refuseNode(
                symbol,
                file,
                node,
                "reads outside its parameter in the wrap map",
            );
        }
        return value;
    };
    const absent = evaluatePinExpression(
        symbol,
        file,
        chain,
        resolve(undefined),
    );
    const substituted = evaluatePinExpression(
        symbol,
        file,
        chain,
        resolve(samplerWrapAbsent),
    );
    if (absent !== substituted) {
        refuseNode(
            symbol,
            file,
            chain,
            "no longer maps an absent wrap mode to the substituted default",
        );
    }
    const scope: CppExpressionScope = {
        symbol,
        file,
        names: new Map([[parameterName, "mode"]]),
        numeric: (literal) => literal.text,
    };
    const arm = (expression: ts.Expression): string => {
        const literal = unwrapPin(expression);
        const mapped = ts.isStringLiteral(literal)
            ? addressModeByPin[literal.text]
            : undefined;
        if (mapped === undefined) {
            refuseNode(
                symbol,
                file,
                expression,
                "maps a wrap mode with no native enum entry",
            );
        }
        return mapped;
    };
    const lines: string[] = [
        "    const auto address_mode = [](std::size_t mode) {",
    ];
    let node: ts.Expression = chain;
    let level = 0;
    while (ts.isConditionalExpression(node)) {
        const test = renderCppExpression(scope, node.condition).text;
        lines.push(
            level === 0
                ? `        return ${test}`
                : `${"    ".repeat(level)}        : ${test}`,
        );
        lines.push(`${"    ".repeat(level + 1)}        ? ${arm(node.whenTrue)}`);
        node = unwrapPin(node.whenFalse);
        level += 1;
    }
    lines.push(`${"    ".repeat(level)}        : ${arm(node)};`, "    };");
    return lines;
}

/*
 * ──────────────────── round-2 loader leaves ────────────────────
 *
 * Same contract as above: the emitters own the translation, never the
 * formula. The specific rules they carry, documented once here:
 *   - A pinned `Math.max(x / N, L)` clamp emits `std::max(Lf, x / Nf)` —
 *     C++ names the clamp bound first; `max` is symmetric over the finite
 *     inputs an int8/int16 divide can produce.
 *   - The pinned color path multiplies by a precomputed reciprocal
 *     (`c * (1 / N)`) in JavaScript doubles where the C++ record path
 *     divides by `N` in float. The results are bit-identical for every
 *     representable input: N is 2^k - 1, so no quotient sits within the
 *     reciprocal's double error of a float rounding boundary. The
 *     equivalence is conditional on N matching between the two pinned
 *     modules, which `lowerVertexColorCpp` proves on every generation.
 *   - `refuseModule` refusals fire where the anchor is a whole module
 *     rather than one node (a missing assignment, a count that changed).
 */

function refuseModule(symbol: string, reason: string): never {
    throw new Error(`Pinned ${symbol} ${reason}.`);
}

/** A numeric literal, allowing one leading unary minus. */
function signedNumericValue(
    symbol: string,
    file: ts.SourceFile,
    expression: ts.Expression,
): number {
    const node = unwrapPin(expression);
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken
    ) {
        const operand = unwrapPin(node.operand);
        if (ts.isNumericLiteral(operand)) {
            return -Number(operand.text);
        }
    }
    if (ts.isNumericLiteral(node)) {
        return Number(node.text);
    }
    refuseNode(
        symbol,
        file,
        expression,
        "uses a constant this lowering cannot evaluate",
    );
}

/** The `a.b.c` property path of an assignment target, or undefined. */
function pinnedPropertyPath(
    expression: ts.Expression,
): string[] | undefined {
    const node = unwrapPin(expression);
    if (ts.isIdentifier(node)) {
        return [node.text];
    }
    if (ts.isPropertyAccessExpression(node)) {
        const owner = pinnedPropertyPath(node.expression);
        return owner ? [...owner, node.name.text] : undefined;
    }
    return undefined;
}

/** Every `path = …` assignment under `root`, matched by property path. */
function pinnedAssignments(
    root: ts.Node,
    path: string,
): ts.BinaryExpression[] {
    const result: ts.BinaryExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            pinnedPropertyPath(node.left)?.join(".") === path
        ) {
            result.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return result;
}

/**
 * DataView getter → the C++ read `read_component` performs for it. Only
 * the widths the pinned accessor normalization reads are named; a new
 * getter upstream misses the map and refuses.
 */
const accessorReadsByGetter: Readonly<
    Record<string, { cppType: string; littleEndian: boolean }>
> = {
    getInt8: { cppType: "std::int8_t", littleEndian: false },
    getUint8: { cppType: "std::uint8_t", littleEndian: false },
    getInt16: { cppType: "std::int16_t", littleEndian: true },
    getUint16: { cppType: "std::uint16_t", littleEndian: true },
    getFloat32: { cppType: "float", littleEndian: true },
};

interface PinnedAccessorClause {
    componentType: number;
    cppType: string;
    getter: string;
    divisor: number;
    /** The lower clamp bound of the signed arms; unsigned arms carry none. */
    clamp?: number;
}

/**
 * The componentType switch of the pinned `readComponent`
 * (`gltf-ext-quantization.ts`): four integer clauses that read one
 * component and normalize it behind the accessor's flag, then the raw
 * float clause, then a throwing default. Exactly that shape — a clause
 * added or removed on either side refuses generation.
 */
function pinnedAccessorClauses(
    file: ts.SourceFile,
): PinnedAccessorClause[] {
    const symbol = "readComponent";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 4) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (view, offset, componentType, normalized)",
        );
    }
    const viewName = parameters[0]!;
    const offsetName = parameters[1]!;
    const componentTypeName = parameters[2]!;
    const normalizedName = parameters[3]!;
    const only = declaration.body.statements.length === 1
        ? declaration.body.statements[0]
        : undefined;
    if (!only || !ts.isSwitchStatement(only)) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer dispatches through a single componentType switch",
        );
    }
    const dispatch = unwrapPin(only.expression);
    if (
        !ts.isIdentifier(dispatch) ||
        dispatch.text !== componentTypeName
    ) {
        refuseNode(
            symbol,
            file,
            only,
            "no longer switches on the component type",
        );
    }
    const caseConstant = (clause: ts.CaseClause): number => {
        const label = unwrapPin(clause.expression);
        if (ts.isNumericLiteral(label)) {
            return Number(label.text);
        }
        if (ts.isIdentifier(label)) {
            for (const statement of file.statements) {
                if (!ts.isVariableStatement(statement)) continue;
                for (const binding of
                    statement.declarationList.declarations) {
                    if (
                        ts.isIdentifier(binding.name) &&
                        binding.name.text === label.text &&
                        binding.initializer
                    ) {
                        const value = unwrapPin(binding.initializer);
                        if (ts.isNumericLiteral(value)) {
                            return Number(value.text);
                        }
                    }
                }
            }
        }
        refuseNode(
            symbol,
            file,
            clause,
            "labels a case this lowering cannot resolve to a component type",
        );
    };
    /** `view.getX(offset)` / `view.getX(offset, true)` → the getter. */
    const readGetter = (expression: ts.Expression): string => {
        const call = unwrapPin(expression);
        const getter = ts.isCallExpression(call) &&
                ts.isPropertyAccessExpression(call.expression) &&
                ts.isIdentifier(call.expression.expression) &&
                call.expression.expression.text === viewName
            ? call.expression.name.text
            : undefined;
        const config = getter !== undefined
            ? accessorReadsByGetter[getter]
            : undefined;
        if (getter === undefined || !ts.isCallExpression(call)) {
            refuseNode(
                symbol,
                file,
                expression,
                "no longer reads the component through the DataView",
            );
        }
        if (!config) {
            refuseNode(
                symbol,
                file,
                expression,
                `reads through DataView.${getter}, which has no ` +
                    "lowering entry",
            );
        }
        const first = call.arguments[0]
            ? unwrapPin(call.arguments[0])
            : undefined;
        const offsetOk = first !== undefined &&
            ts.isIdentifier(first) &&
            first.text === offsetName;
        const endianOk = config.littleEndian
            ? call.arguments.length === 2 &&
                call.arguments[1]!.kind === ts.SyntaxKind.TrueKeyword
            : call.arguments.length === 1;
        if (!offsetOk || !endianOk) {
            refuseNode(
                symbol,
                file,
                call,
                "no longer reads the little-endian component at the offset",
            );
        }
        return getter;
    };
    const clauses: PinnedAccessorClause[] = [];
    const caseList = only.caseBlock.clauses;
    let index = 0;
    while (index < caseList.length) {
        const clause = caseList[index]!;
        const body = ts.isCaseClause(clause) &&
                clause.statements.length === 1 &&
                ts.isBlock(clause.statements[0]!)
            ? (clause.statements[0] as ts.Block).statements
            : undefined;
        if (!ts.isCaseClause(clause) || !body) break;
        index += 1;
        const componentType = caseConstant(clause);
        const binding = singleBinding(symbol, file, body[0], clause);
        const getter = readGetter(binding.initializer);
        const config = accessorReadsByGetter[getter]!;
        const trailing = body[1];
        const conditional = body.length === 2 &&
                trailing !== undefined &&
                ts.isReturnStatement(trailing) &&
                trailing.expression
            ? unwrapPin(trailing.expression)
            : undefined;
        if (!conditional || !ts.isConditionalExpression(conditional)) {
            refuseNode(
                symbol,
                file,
                clause,
                "no longer normalizes behind the accessor's flag",
            );
        }
        const condition = unwrapPin(conditional.condition);
        const raw = unwrapPin(conditional.whenFalse);
        if (
            !ts.isIdentifier(condition) ||
            condition.text !== normalizedName ||
            !ts.isIdentifier(raw) ||
            raw.text !== binding.name
        ) {
            refuseNode(
                symbol,
                file,
                conditional,
                "no longer keeps the raw component when unnormalized",
            );
        }
        let scaled = unwrapPin(conditional.whenTrue);
        let clamp: number | undefined;
        if (ts.isCallExpression(scaled)) {
            const callee = scaled.expression;
            const isMathMax = ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "Math" &&
                callee.name.text === "max";
            if (!isMathMax || scaled.arguments.length !== 2) {
                refuseNode(
                    symbol,
                    file,
                    scaled,
                    "clamps through a call this lowering cannot carry",
                );
            }
            clamp = signedNumericValue(
                symbol,
                file,
                scaled.arguments[1]!,
            );
            scaled = unwrapPin(scaled.arguments[0]!);
        }
        const divisor = ts.isBinaryExpression(scaled) &&
                scaled.operatorToken.kind === ts.SyntaxKind.SlashToken &&
                ts.isIdentifier(unwrapPin(scaled.left)) &&
                (unwrapPin(scaled.left) as ts.Identifier).text ===
                    binding.name &&
                ts.isNumericLiteral(unwrapPin(scaled.right))
            ? Number((unwrapPin(scaled.right) as ts.NumericLiteral).text)
            : undefined;
        if (divisor === undefined) {
            refuseNode(
                symbol,
                file,
                conditional.whenTrue,
                "no longer normalizes by dividing the component",
            );
        }
        clauses.push({
            componentType,
            cppType: config.cppType,
            getter,
            divisor,
            ...(clamp === undefined ? {} : { clamp }),
        });
    }
    if (clauses.length !== 4) {
        refuseNode(
            symbol,
            file,
            only,
            "no longer carries exactly four integer component types",
        );
    }
    // The tail: the raw float clause the template's own 5126 case
    // mirrors, then the throwing default. Anything else — a fifth
    // integer width, a clause between them — refuses.
    const floatClause = caseList[index];
    index += 1;
    const floatReturn = floatClause !== undefined &&
            ts.isCaseClause(floatClause) &&
            floatClause.statements.length === 1 &&
            ts.isReturnStatement(floatClause.statements[0]!) &&
            (floatClause.statements[0] as ts.ReturnStatement).expression
        ? (floatClause.statements[0] as ts.ReturnStatement).expression
        : undefined;
    if (
        !floatClause ||
        !ts.isCaseClause(floatClause) ||
        caseConstant(floatClause) !== 5126 ||
        !floatReturn ||
        readGetter(floatReturn) !== "getFloat32"
    ) {
        refuseNode(
            symbol,
            file,
            floatClause ?? only,
            "no longer returns the raw float component for type 5126",
        );
    }
    const defaultClause = caseList[index];
    index += 1;
    const defaultThrows = defaultClause !== undefined &&
        ts.isDefaultClause(defaultClause) &&
        defaultClause.statements.length === 1 &&
        ts.isThrowStatement(defaultClause.statements[0]!);
    if (!defaultThrows || index !== caseList.length) {
        refuseNode(
            symbol,
            file,
            defaultClause ?? only,
            "no longer rejects every other component type",
        );
    }
    return clauses;
}

/**
 * The four integer componentType clauses of the loader's
 * `read_component`, emitted from the pinned `readComponent`
 * (`gltf-ext-quantization.ts`): each scale constant, each signed clamp,
 * and each read width comes from the pin.
 */
export function lowerAccessorNormalizationCpp(
    file: ts.SourceFile,
): string {
    const lines: string[] = [];
    for (const clause of pinnedAccessorClauses(file)) {
        const scaled = "static_cast<float>(value) / " +
            floatLiteral(clause.divisor);
        const normalized = clause.clamp === undefined
            ? scaled
            : `std::max(${floatLiteral(clause.clamp)}, ${scaled})`;
        lines.push(
            `        case ${clause.componentType}: {`,
            `            const ${clause.cppType} value = ` +
                `read_value<${clause.cppType}>(data);`,
            `            return accessor.normalized ? ${normalized} : value;`,
            "        }",
        );
    }
    return lines.join("\n");
}

interface PinnedColorBuild {
    /** Vec4 lane → the pin's source component, for the three colors. */
    components: [number, number, number];
    alphaComponent: number;
    alphaFallback: number;
    /** Typed-array constructor name → the branch's divisor. */
    divisors: ReadonlyMap<string, number>;
}

/** The integer branches `normalizeColorToVec4` carries, by array type. */
const colorDivisorGetters: Readonly<Record<string, string>> = {
    Uint8Array: "getUint8",
    Uint16Array: "getUint16",
};

/**
 * `normalizeColorToVec4` (`gltf-color-normalize.ts`): a float branch and
 * one branch per integer width, each storing the same four lanes. All
 * branches must agree on the lane order and the absent-alpha fallback —
 * a branch that drifts refuses rather than picking one.
 */
function pinnedColorBuild(file: ts.SourceFile): PinnedColorBuild {
    const symbol = "normalizeColorToVec4";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 3) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (data, count, comps)",
        );
    }
    const dataName = parameters[0]!;
    const countName = parameters[1]!;
    const compsName = parameters[2]!;
    const statements = declaration.body.statements;
    // `const out = new Float32Array(count * 4);` — the four-lane record.
    const outBinding = singleBinding(
        symbol,
        file,
        statements[0],
        declaration,
    );
    const outNew = unwrapPin(outBinding.initializer);
    const outStride = ts.isNewExpression(outNew) &&
            ts.isIdentifier(outNew.expression) &&
            outNew.expression.text === "Float32Array" &&
            outNew.arguments?.length === 1 &&
            ts.isBinaryExpression(unwrapPin(outNew.arguments[0]!)) &&
            (unwrapPin(outNew.arguments[0]!) as ts.BinaryExpression)
                    .operatorToken.kind === ts.SyntaxKind.AsteriskToken
        ? unwrapPin(
            (unwrapPin(outNew.arguments[0]!) as ts.BinaryExpression)
                .right,
        )
        : undefined;
    if (
        outStride === undefined ||
        !ts.isNumericLiteral(outStride) ||
        Number(outStride.text) !== 4
    ) {
        refuseNode(
            symbol,
            file,
            outBinding.statement,
            "no longer builds a four-lane color",
        );
    }
    // `const hasAlpha = comps >= 4;` — what makes the record's fixed
    // `colors->type == "VEC4"` test the pin's own predicate: among the
    // VEC3/VEC4 layouts glTF admits for COLOR_0, `comps >= 4` holds
    // exactly for VEC4.
    const alphaBinding = singleBinding(
        symbol,
        file,
        statements[1],
        declaration,
    );
    const alphaShape = unwrapPin(alphaBinding.initializer);
    const alphaShapeOk = ts.isBinaryExpression(alphaShape) &&
        alphaShape.operatorToken.kind ===
            ts.SyntaxKind.GreaterThanEqualsToken &&
        ts.isIdentifier(unwrapPin(alphaShape.left)) &&
        (unwrapPin(alphaShape.left) as ts.Identifier).text ===
            compsName &&
        ts.isNumericLiteral(unwrapPin(alphaShape.right)) &&
        Number(
            (unwrapPin(alphaShape.right) as ts.NumericLiteral).text,
        ) === 4;
    if (!alphaShapeOk) {
        refuseNode(
            symbol,
            file,
            alphaBinding.statement,
            "no longer keys the alpha lane on a four-component source",
        );
    }
    const hasAlphaName = alphaBinding.name;
    interface BranchBuild {
        components: [number, number, number];
        alphaComponent: number;
        alphaFallback: number;
        divisor?: number;
    }
    /** `data[v * comps]` / `data[v * comps + k]` → component k. */
    const componentOf = (
        expression: ts.Expression,
        loopName: string,
        scaleName: string | undefined,
    ): number => {
        let read = unwrapPin(expression);
        if (scaleName !== undefined) {
            const product = read;
            const scaledRead = ts.isBinaryExpression(product) &&
                    product.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskToken &&
                    ts.isIdentifier(unwrapPin(product.right)) &&
                    (unwrapPin(product.right) as ts.Identifier).text ===
                        scaleName
                ? unwrapPin(product.left)
                : undefined;
            if (scaledRead === undefined) {
                refuseNode(
                    symbol,
                    file,
                    expression,
                    "no longer scales the lane by the branch inverse",
                );
            }
            read = scaledRead;
        }
        if (
            !ts.isElementAccessExpression(read) ||
            !ts.isIdentifier(read.expression) ||
            read.expression.text !== dataName
        ) {
            refuseNode(
                symbol,
                file,
                expression,
                "no longer reads the source component the lowered way",
            );
        }
        const index = unwrapPin(read.argumentExpression);
        const base = (node: ts.Expression): boolean => {
            const product = unwrapPin(node);
            return ts.isBinaryExpression(product) &&
                product.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                ts.isIdentifier(unwrapPin(product.left)) &&
                (unwrapPin(product.left) as ts.Identifier).text ===
                    loopName &&
                ts.isIdentifier(unwrapPin(product.right)) &&
                (unwrapPin(product.right) as ts.Identifier).text ===
                    compsName;
        };
        if (base(index)) return 0;
        if (
            ts.isBinaryExpression(index) &&
            index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            base(index.left) &&
            ts.isNumericLiteral(unwrapPin(index.right))
        ) {
            return Number(
                (unwrapPin(index.right) as ts.NumericLiteral).text,
            );
        }
        refuseNode(
            symbol,
            file,
            read,
            "no longer offsets the component read from the vertex base",
        );
    };
    const analyzeBranch = (
        block: ts.Block,
        scaled: boolean,
        anchor: ts.Node,
    ): BranchBuild => {
        const branch = block.statements;
        let cursor = 0;
        let divisor: number | undefined;
        let scaleName: string | undefined;
        if (scaled) {
            const invBinding = singleBinding(
                symbol,
                file,
                branch[cursor],
                anchor,
            );
            cursor += 1;
            const inverse = unwrapPin(invBinding.initializer);
            const inverseDivisor = ts.isBinaryExpression(inverse) &&
                    inverse.operatorToken.kind ===
                        ts.SyntaxKind.SlashToken &&
                    ts.isNumericLiteral(unwrapPin(inverse.left)) &&
                    Number(
                        (unwrapPin(inverse.left) as ts.NumericLiteral)
                            .text,
                    ) === 1 &&
                    ts.isNumericLiteral(unwrapPin(inverse.right))
                ? Number(
                    (unwrapPin(inverse.right) as ts.NumericLiteral).text,
                )
                : undefined;
            if (inverseDivisor === undefined) {
                refuseNode(
                    symbol,
                    file,
                    invBinding.statement,
                    "no longer derives the inverse from one over the divisor",
                );
            }
            divisor = inverseDivisor;
            scaleName = invBinding.name;
        }
        const loop = branch[cursor];
        cursor += 1;
        if (
            !loop ||
            !ts.isForStatement(loop) ||
            !loop.initializer ||
            !ts.isVariableDeclarationList(loop.initializer) ||
            loop.initializer.declarations.length !== 1 ||
            !ts.isIdentifier(loop.initializer.declarations[0]!.name) ||
            !loop.condition ||
            !ts.isBinaryExpression(loop.condition) ||
            loop.condition.operatorToken.kind !==
                ts.SyntaxKind.LessThanToken ||
            !ts.isIdentifier(unwrapPin(loop.condition.right)) ||
            (unwrapPin(loop.condition.right) as ts.Identifier).text !==
                countName ||
            !ts.isBlock(loop.statement) ||
            cursor !== branch.length
        ) {
            refuseNode(
                symbol,
                file,
                loop ?? anchor,
                "no longer loops once over the vertices",
            );
        }
        const loopName = (
            loop.initializer.declarations[0]!.name as ts.Identifier
        ).text;
        const laneOf = (
            target: ts.ElementAccessExpression,
        ): number | undefined => {
            if (
                !ts.isIdentifier(target.expression) ||
                target.expression.text !== outBinding.name
            ) {
                return undefined;
            }
            const index = unwrapPin(target.argumentExpression);
            const stride = (node: ts.Expression): boolean => {
                const product = unwrapPin(node);
                return ts.isBinaryExpression(product) &&
                    product.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskToken &&
                    ts.isIdentifier(unwrapPin(product.left)) &&
                    (unwrapPin(product.left) as ts.Identifier).text ===
                        loopName &&
                    ts.isNumericLiteral(unwrapPin(product.right)) &&
                    Number(
                        (unwrapPin(product.right) as ts.NumericLiteral)
                            .text,
                    ) === 4;
            };
            if (stride(index)) return 0;
            if (
                ts.isBinaryExpression(index) &&
                index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                stride(index.left) &&
                ts.isNumericLiteral(unwrapPin(index.right))
            ) {
                return Number(
                    (unwrapPin(index.right) as ts.NumericLiteral).text,
                );
            }
            return undefined;
        };
        const stores = collectLaneStores(
            { symbol, file, names: new Map(), numeric: pinnedDoubleLiteral },
            loop.statement.statements,
            0,
            4,
            laneOf,
        );
        if (stores.next !== loop.statement.statements.length) {
            refuseNode(
                symbol,
                file,
                loop,
                "carries statements after the lane stores",
            );
        }
        const components = stores.expressions
            .slice(0, 3)
            .map((expression) =>
                componentOf(expression, loopName, scaleName)
            ) as [number, number, number];
        const alpha = unwrapPin(stores.expressions[3]!);
        const fallback = ts.isConditionalExpression(alpha) &&
                ts.isIdentifier(unwrapPin(alpha.condition)) &&
                (unwrapPin(alpha.condition) as ts.Identifier).text ===
                    hasAlphaName &&
                ts.isNumericLiteral(unwrapPin(alpha.whenFalse))
            ? Number(
                (unwrapPin(alpha.whenFalse) as ts.NumericLiteral).text,
            )
            : undefined;
        if (!ts.isConditionalExpression(alpha) || fallback === undefined) {
            refuseNode(
                symbol,
                file,
                stores.expressions[3]!,
                "no longer defaults the alpha lane behind the alpha test",
            );
        }
        return {
            components,
            alphaComponent: componentOf(
                alpha.whenTrue,
                loopName,
                scaleName,
            ),
            alphaFallback: fallback,
            ...(divisor === undefined ? {} : { divisor }),
        };
    };
    // The instanceof chain: Float32Array first, then the integer widths.
    const branches: { typeName: string; build: BranchBuild }[] = [];
    let chain: ts.Statement | undefined = statements[2];
    while (chain !== undefined) {
        if (!ts.isIfStatement(chain) || !ts.isBlock(chain.thenStatement)) {
            refuseNode(
                symbol,
                file,
                chain,
                "no longer selects the source layout by instanceof",
            );
        }
        const condition = unwrapPin(chain.expression);
        const typeName = ts.isBinaryExpression(condition) &&
                condition.operatorToken.kind ===
                    ts.SyntaxKind.InstanceOfKeyword &&
                ts.isIdentifier(unwrapPin(condition.left)) &&
                (unwrapPin(condition.left) as ts.Identifier).text ===
                    dataName &&
                ts.isIdentifier(unwrapPin(condition.right))
            ? (unwrapPin(condition.right) as ts.Identifier).text
            : undefined;
        if (typeName === undefined) {
            refuseNode(
                symbol,
                file,
                chain.expression,
                "no longer tests the source array type",
            );
        }
        const scaled = typeName !== "Float32Array";
        if (scaled && colorDivisorGetters[typeName] === undefined) {
            refuseNode(
                symbol,
                file,
                chain.expression,
                `normalizes ${typeName}, which has no lowering entry`,
            );
        }
        branches.push({
            typeName,
            build: analyzeBranch(chain.thenStatement, scaled, chain),
        });
        chain = chain.elseStatement;
    }
    const trailing = statements[3];
    if (
        branches.length !== 3 ||
        branches[0]!.typeName !== "Float32Array" ||
        statements.length !== 4 ||
        !trailing ||
        !ts.isReturnStatement(trailing) ||
        !trailing.expression ||
        !ts.isIdentifier(unwrapPin(trailing.expression)) ||
        (unwrapPin(trailing.expression) as ts.Identifier).text !==
            outBinding.name
    ) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer carries the float and two integer branches",
        );
    }
    const first = branches[0]!.build;
    const divisors = new Map<string, number>();
    for (const { typeName, build } of branches) {
        if (
            build.components.join(",") !== first.components.join(",") ||
            build.alphaComponent !== first.alphaComponent ||
            build.alphaFallback !== first.alphaFallback
        ) {
            refuseNode(
                symbol,
                file,
                declaration,
                `no longer stores the same lanes in the ${typeName} branch`,
            );
        }
        if (build.divisor !== undefined) {
            divisors.set(typeName, build.divisor);
        }
    }
    return {
        components: first.components,
        alphaComponent: first.alphaComponent,
        alphaFallback: first.alphaFallback,
        divisors,
    };
}

/**
 * The COLOR_0 → Vec4 build of the loader's vertex loop, emitted from the
 * pinned `normalizeColorToVec4`: the channel order and the VEC3 alpha
 * default come from the pin. The record path normalizes integer colors
 * inside `read_component` rather than here, so generation also proves
 * that the pin's per-width divisors are exactly the divisors the pinned
 * accessor normalization applies — a divergence between the two modules
 * refuses instead of shipping either.
 */
export function lowerVertexColorCpp(
    file: ts.SourceFile,
    quantizationFile: ts.SourceFile,
): string {
    const build = pinnedColorBuild(file);
    const clauses = pinnedAccessorClauses(quantizationFile);
    for (const [typeName, getter] of Object.entries(colorDivisorGetters)) {
        const colorDivisor = build.divisors.get(typeName);
        const accessor = clauses.find(
            (clause) => clause.getter === getter,
        );
        if (
            colorDivisor === undefined ||
            accessor === undefined ||
            accessor.divisor !== colorDivisor ||
            accessor.clamp !== undefined
        ) {
            throw new Error(
                `Pinned normalizeColorToVec4 scales ${typeName} by a ` +
                    "rule the pinned readComponent does not apply, so " +
                    "routing COLOR_0 through read_component would no " +
                    "longer reproduce the pin.",
            );
        }
    }
    const read = (component: number): string =>
        "read_component(buffer, container, views, *colors, index, " +
        `${component})`;
    return [
        "                if (colors) {",
        "                    vertex.color = Vec4{",
        `                        ${read(build.components[0])},`,
        `                        ${read(build.components[1])},`,
        `                        ${read(build.components[2])},`,
        '                        colors->type == "VEC4"',
        `                            ? ${read(build.alphaComponent)}`,
        `                            : ${floatLiteral(build.alphaFallback)},`,
        "                    };",
        "                }",
    ].join("\n");
}

/** Pin constant name → the C++ constexpr the prescale emits. */
const preScaleConstantRenames: Readonly<Record<string, string>> = {
    C00xy: "c00xy",
    C00z: "c00z",
    C1: "c1",
    C2: "c2",
    C20zz: "c20zz",
    C20xy: "c20xy",
    C22: "c22",
};

/**
 * One pinned `polynomialToPreScaledHarmonics` body →
 * `pre_scale_harmonics`. The seven band constants, the nine polynomial
 * reads, and the nine store expressions all come from the pin; the
 * stride-4 output offsets collapse to the record's nine Color3 slots.
 */
function emitPreScaleHarmonics(file: ts.SourceFile): string {
    const symbol = "polynomialToPreScaledHarmonics";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 1) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes the polynomial alone",
        );
    }
    const polyName = parameters[0]!;
    const statements = declaration.body.statements;
    const names = new Map<string, string>();
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: (literal) => floatLiteral(Number(literal.text)),
    };
    const lines: string[] = [
        "std::array<Color3, 9> pre_scale_harmonics(",
        "    const std::array<Color3, 9>& polynomial) {",
    ];
    let index = 0;
    let constants = 0;
    while (index < statements.length) {
        const statement = statements[index];
        if (!statement || !ts.isVariableStatement(statement)) break;
        const binding = singleBinding(symbol, file, statement, declaration);
        const value = unwrapPin(binding.initializer);
        if (!ts.isNumericLiteral(value)) break;
        index += 1;
        const cpp = preScaleConstantRenames[binding.name];
        if (cpp === undefined) {
            refuseNode(
                symbol,
                file,
                binding.statement,
                `binds '${binding.name}', which has no lowering entry`,
            );
        }
        names.set(binding.name, cpp);
        lines.push(
            `    constexpr float ${cpp} = ` +
                `${floatLiteral(Number(value.text))};`,
        );
        constants += 1;
    }
    if (constants !== Object.keys(preScaleConstantRenames).length) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer binds the seven band constants",
        );
    }
    // `const out = new F32(36);` — nine stride-4 float32 harmonics, the
    // rounding the C++ float math mirrors.
    const outBinding = singleBinding(
        symbol,
        file,
        statements[index],
        declaration,
    );
    index += 1;
    const outNew = unwrapPin(outBinding.initializer);
    const outSize = ts.isNewExpression(outNew) &&
            ts.isIdentifier(outNew.expression) &&
            (outNew.expression.text === "F32" ||
                outNew.expression.text === "Float32Array") &&
            outNew.arguments?.length === 1 &&
            ts.isNumericLiteral(unwrapPin(outNew.arguments[0]!))
        ? Number(
            (unwrapPin(outNew.arguments[0]!) as ts.NumericLiteral).text,
        )
        : undefined;
    if (outSize !== 36) {
        refuseNode(
            symbol,
            file,
            outBinding.statement,
            "no longer stores nine stride-four float32 harmonics",
        );
    }
    lines.push(
        "    std::array<Color3, 9> result{};",
        "    for (int channel = 0; channel < 3; ++channel) {",
    );
    const loop = statements[index];
    index += 1;
    if (
        !loop ||
        !ts.isForStatement(loop) ||
        !loop.initializer ||
        !ts.isVariableDeclarationList(loop.initializer) ||
        loop.initializer.declarations.length !== 1 ||
        !ts.isIdentifier(loop.initializer.declarations[0]!.name) ||
        !loop.condition ||
        !ts.isBinaryExpression(loop.condition) ||
        loop.condition.operatorToken.kind !==
            ts.SyntaxKind.LessThanToken ||
        !ts.isNumericLiteral(unwrapPin(loop.condition.right)) ||
        Number(
            (unwrapPin(loop.condition.right) as ts.NumericLiteral).text,
        ) !== 3 ||
        !ts.isBlock(loop.statement)
    ) {
        refuseNode(
            symbol,
            file,
            loop ?? declaration,
            "no longer loops once per color channel",
        );
    }
    const channelName = (
        loop.initializer.declarations[0]!.name as ts.Identifier
    ).text;
    const slotOf = (
        expression: ts.Expression,
        stride: number,
    ): number | undefined => {
        const node = unwrapPin(expression);
        if (ts.isIdentifier(node) && node.text === channelName) return 0;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isNumericLiteral(unwrapPin(node.left)) &&
            ts.isIdentifier(unwrapPin(node.right)) &&
            (unwrapPin(node.right) as ts.Identifier).text === channelName
        ) {
            const offset = Number(
                (unwrapPin(node.left) as ts.NumericLiteral).text,
            );
            return offset % stride === 0 ? offset / stride : undefined;
        }
        return undefined;
    };
    const body = loop.statement.statements;
    let bodyIndex = 0;
    for (let slot = 0; slot < 9; slot += 1) {
        const binding = singleBinding(symbol, file, body[bodyIndex], loop);
        bodyIndex += 1;
        const readValue = unwrapPin(binding.initializer);
        if (
            !ts.isElementAccessExpression(readValue) ||
            !ts.isIdentifier(readValue.expression) ||
            readValue.expression.text !== polyName ||
            slotOf(readValue.argumentExpression, 3) !== slot
        ) {
            refuseNode(
                symbol,
                file,
                binding.statement,
                `no longer reads polynomial slot ${slot}`,
            );
        }
        names.set(binding.name, binding.name);
        lines.push(
            `        const float ${binding.name} =`,
            `            color_channel(polynomial[${slot}], channel);`,
        );
    }
    for (let slot = 0; slot < 9; slot += 1) {
        const statement = body[bodyIndex];
        bodyIndex += 1;
        const assignment = statement !== undefined &&
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? statement.expression
            : undefined;
        const target = assignment
            ? unwrapPin(assignment.left)
            : undefined;
        if (
            !assignment ||
            target === undefined ||
            !ts.isElementAccessExpression(target) ||
            !ts.isIdentifier(target.expression) ||
            target.expression.text !== outBinding.name ||
            slotOf(target.argumentExpression, 4) !== slot
        ) {
            refuseNode(
                symbol,
                file,
                statement ?? loop,
                `no longer stores harmonic slot ${slot}`,
            );
        }
        const rendered = renderCppExpression(scope, assignment.right).text;
        // The segment's fixed layout: a bare product stays inline, any
        // composed expression splits one argument per line.
        if (rendered.includes("(")) {
            lines.push(
                "        set_color_channel(",
                `            result[${slot}],`,
                "            channel,",
                `            ${rendered});`,
            );
        } else {
            lines.push(
                "        set_color_channel(",
                `            result[${slot}], channel, ${rendered});`,
            );
        }
    }
    if (bodyIndex !== body.length) {
        refuseNode(
            symbol,
            file,
            body[bodyIndex] ?? loop,
            "carries statements after the harmonic stores",
        );
    }
    const trailing = statements[index];
    index += 1;
    if (
        !trailing ||
        !ts.isReturnStatement(trailing) ||
        !trailing.expression ||
        !ts.isIdentifier(unwrapPin(trailing.expression)) ||
        (unwrapPin(trailing.expression) as ts.Identifier).text !==
            outBinding.name ||
        index !== statements.length
    ) {
        refuseNode(
            symbol,
            file,
            trailing ?? declaration,
            "no longer ends by returning the harmonics",
        );
    }
    lines.push("    }", "    return result;", "}");
    return lines.join("\n");
}

/**
 * `pre_scale_harmonics` for the glTF loader, emitted from the private
 * `polynomialToPreScaledHarmonics` copy the pinned
 * EXT_lights_image_based feature executes (`ibl-env-assembly.ts`). The
 * pin keeps that copy byte-for-byte against `load-env.ts`'s canonical —
 * the one the .env path lowers — so both are emitted and compared: a
 * divergence is a pin defect to surface, not a value to pick.
 */
export function lowerShPrescaleCpp(
    assemblyFile: ts.SourceFile,
    canonicalFile: ts.SourceFile,
): string {
    const emitted = emitPreScaleHarmonics(assemblyFile);
    const canonical = emitPreScaleHarmonics(canonicalFile);
    if (emitted !== canonical) {
        throw new Error(
            "Pinned polynomialToPreScaledHarmonics diverged between " +
                `${assemblyFile.fileName} and ${canonicalFile.fileName}; ` +
                "the glTF loader executes the former and the .env path " +
                "the latter, so the divergence must be resolved upstream " +
                "rather than lowered from either copy.",
        );
    }
    return emitted;
}

/**
 * The image-processing defaults the pinned EXT_lights_image_based
 * `_sceneSetup` writes (`gltf-ext-lights-image-based.ts`): exposure and
 * contrast flow as constants, and tone mapping must be enabled — the
 * environment record has no arm for an IBL asset that leaves it off.
 */
export function lowerImageProcessingDefaultsCpp(
    file: ts.SourceFile,
): string {
    const symbol = "EXT_lights_image_based";
    const numericFor = (property: string): number => {
        const path = `scene.imageProcessing.${property}`;
        const found = pinnedAssignments(file, path);
        if (found.length !== 1) {
            refuseModule(
                symbol,
                `no longer writes ${path} exactly once`,
            );
        }
        const value = unwrapPin(found[0]!.right);
        if (!ts.isNumericLiteral(value)) {
            refuseNode(
                symbol,
                file,
                found[0]!,
                `no longer writes a constant ${property}`,
            );
        }
        return Number(value.text);
    };
    const exposure = numericFor("exposure");
    const contrast = numericFor("contrast");
    const toneMapping = pinnedAssignments(
        file,
        "scene.imageProcessing.toneMappingEnabled",
    );
    if (
        toneMapping.length !== 1 ||
        unwrapPin(toneMapping[0]!.right).kind !==
            ts.SyntaxKind.TrueKeyword
    ) {
        refuseModule(
            symbol,
            "no longer enables tone mapping exactly once",
        );
    }
    return [
        `    environment.exposure = ${floatLiteral(exposure)};`,
        `    environment.contrast = ${floatLiteral(contrast)};`,
        "    environment.tone_mapping_enabled = true;",
    ].join("\n");
}

/**
 * The single `memberName` handler of a pinned feature module — the
 * `applyMaterial` method on the module's exported feature literal.
 */
function featureMethod(
    file: ts.SourceFile,
    symbol: string,
    memberName: string,
): ts.FunctionLikeDeclarationBase & { body: ts.Block } {
    const found: (ts.FunctionLikeDeclarationBase & { body: ts.Block })[] =
        [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isMethodDeclaration(node) ||
                ts.isPropertyAssignment(node)) &&
            node.name !== undefined &&
            ts.isIdentifier(node.name) &&
            node.name.text === memberName
        ) {
            const candidate = ts.isMethodDeclaration(node)
                ? node
                : ts.isFunctionExpression(node.initializer) ||
                        ts.isArrowFunction(node.initializer)
                    ? node.initializer
                    : undefined;
            if (candidate?.body && ts.isBlock(candidate.body)) {
                found.push(
                    candidate as ts.FunctionLikeDeclarationBase & {
                        body: ts.Block;
                    },
                );
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (found.length !== 1) {
        refuseModule(
            symbol,
            `no longer declares a single '${memberName}' handler`,
        );
    }
    return found[0]!;
}

interface PinnedJsonDefault {
    key: string;
    bindingName: string;
    /** The substituted constant; undefined for a `: undefined` fallback. */
    value: number | undefined;
}

/**
 * Every `const x = typeof e?.key === "number" ? e.key : fallback`
 * binding under `root` — the shape the pinned dielectric loader uses for
 * each JSON default it substitutes.
 */
function pinnedTypeofDefaults(
    symbol: string,
    file: ts.SourceFile,
    root: ts.Node,
): PinnedJsonDefault[] {
    const result: PinnedJsonDefault[] = [];
    const visit = (node: ts.Node): void => {
        ts.forEachChild(node, visit);
        if (
            !ts.isVariableDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            !node.initializer
        ) {
            return;
        }
        const conditional = unwrapPin(node.initializer);
        if (!ts.isConditionalExpression(conditional)) return;
        const condition = unwrapPin(conditional.condition);
        const typeofRead = ts.isBinaryExpression(condition) &&
                condition.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken &&
                ts.isTypeOfExpression(unwrapPin(condition.left)) &&
                ts.isStringLiteral(unwrapPin(condition.right)) &&
                (unwrapPin(condition.right) as ts.StringLiteral).text ===
                    "number"
            ? unwrapPin(
                (unwrapPin(condition.left) as ts.TypeOfExpression)
                    .expression,
            )
            : undefined;
        const key = typeofRead !== undefined &&
                (ts.isPropertyAccessExpression(typeofRead) ||
                    ts.isPropertyAccessChain(typeofRead))
            ? typeofRead.name.text
            : undefined;
        if (key === undefined) return;
        const whenTrue = unwrapPin(conditional.whenTrue);
        const readsKey = (ts.isPropertyAccessExpression(whenTrue) ||
            ts.isPropertyAccessChain(whenTrue)) &&
            whenTrue.name.text === key;
        if (!readsKey) {
            refuseNode(
                symbol,
                file,
                conditional,
                `no longer substitutes '${key}' behind its own typeof test`,
            );
        }
        const whenFalse = unwrapPin(conditional.whenFalse);
        if (ts.isIdentifier(whenFalse) && whenFalse.text === "undefined") {
            result.push({
                key,
                bindingName: node.name.text,
                value: undefined,
            });
            return;
        }
        result.push({
            key,
            bindingName: node.name.text,
            value: signedNumericValue(symbol, file, whenFalse),
        });
    };
    visit(root);
    return result;
}

/**
 * The dielectric and iridescence JSON defaults the loader template used
 * to hand-type, extracted from the pinned extension handlers
 * (`gltf-ext-dielectric.ts`, `gltf-ext-iridescence.ts`). Both the JSON
 * key and the substituted constant flow; a default the pin adds that no
 * entry consumes refuses, as does an entry the pin no longer carries.
 */
export function lowerGltfExtensionDefaults(
    dielectricFile: ts.SourceFile,
    iridescenceFile: ts.SourceFile,
): GltfExtensionDefaults {
    const dielectricSymbol = "KHR_materials_dielectric";
    const applyMaterial = featureMethod(
        dielectricFile,
        dielectricSymbol,
        "applyMaterial",
    );
    const collected = pinnedTypeofDefaults(
        dielectricSymbol,
        dielectricFile,
        applyMaterial.body,
    );
    const byKey = new Map(collected.map((entry) => [entry.key, entry]));
    if (byKey.size !== collected.length) {
        refuseModule(dielectricSymbol, "substitutes a JSON default twice");
    }
    const consumed = new Set<string>();
    const numericDefault = (key: string): GltfLoweredDefault => {
        const entry = byKey.get(key);
        if (!entry || entry.value === undefined) {
            refuseModule(
                dielectricSymbol,
                `no longer defaults '${key}' to a constant`,
            );
        }
        consumed.add(key);
        return { key, literal: floatLiteral(entry.value) };
    };
    const ior = numericDefault("ior");
    const transmissionFactor = numericDefault("transmissionFactor");
    const thicknessFactor = numericDefault("thicknessFactor");
    const dispersion = numericDefault("dispersion");
    // attenuationDistance is authored-or-undefined at its read; the
    // constant the record carries is the white-tint fallback the pin
    // applies when a volume declares no attenuation at all.
    const attenuationRead = byKey.get("attenuationDistance");
    if (!attenuationRead || attenuationRead.value !== undefined) {
        refuseModule(
            dielectricSymbol,
            "no longer reads 'attenuationDistance' as authored-or-absent",
        );
    }
    consumed.add("attenuationDistance");
    for (const entry of collected) {
        if (!consumed.has(entry.key)) {
            refuseModule(
                dielectricSymbol,
                `defaults '${entry.key}', which no lowering entry consumes`,
            );
        }
    }
    // The white tint at unit distance. The record's attenuation_color
    // default is that same white, so only the distance is emitted — a
    // fallback tint that stops being white refuses.
    const fallbacks: { color: number[]; distance: number }[] = [];
    const findFallback = (node: ts.Node): void => {
        ts.forEachChild(node, findFallback);
        if (!ts.isObjectLiteralExpression(node)) return;
        if (node.properties.length !== 2) return;
        const entries = new Map<string, ts.Expression>();
        for (const property of node.properties) {
            if (
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name)
            ) {
                entries.set(property.name.text, property.initializer);
            }
        }
        const color = entries.get("color");
        const distance = entries.get("atDistance");
        if (!color || !distance) return;
        const colorValue = unwrapPin(color);
        const distanceValue = unwrapPin(distance);
        if (
            !ts.isArrayLiteralExpression(colorValue) ||
            !ts.isNumericLiteral(distanceValue)
        ) {
            return;
        }
        fallbacks.push({
            color: colorValue.elements.map((element) =>
                signedNumericValue(
                    dielectricSymbol,
                    dielectricFile,
                    element,
                )
            ),
            distance: Number(distanceValue.text),
        });
    };
    findFallback(applyMaterial.body);
    const fallback = fallbacks.length === 1 ? fallbacks[0]! : undefined;
    if (!fallback || fallback.color.join(",") !== "1,1,1") {
        refuseModule(
            dielectricSymbol,
            "no longer falls back to a white tint at a constant distance",
        );
    }
    const attenuationDistance: GltfLoweredDefault = {
        key: attenuationRead.key,
        literal: floatLiteral(fallback.distance),
    };
    // Babylon's fixed Abbe numerator: `setPbrDispersion(out, N / d)`.
    const dispersionEntry = byKey.get("dispersion")!;
    const dispersionCalls: ts.CallExpression[] = [];
    const findDispersion = (node: ts.Node): void => {
        ts.forEachChild(node, findDispersion);
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "setPbrDispersion"
        ) {
            dispersionCalls.push(node);
        }
    };
    findDispersion(applyMaterial.body);
    const strength = dispersionCalls.length === 1 &&
            dispersionCalls[0]!.arguments.length === 2
        ? unwrapPin(dispersionCalls[0]!.arguments[1]!)
        : undefined;
    const scale = strength !== undefined &&
            ts.isBinaryExpression(strength) &&
            strength.operatorToken.kind === ts.SyntaxKind.SlashToken &&
            ts.isNumericLiteral(unwrapPin(strength.left)) &&
            ts.isIdentifier(unwrapPin(strength.right)) &&
            (unwrapPin(strength.right) as ts.Identifier).text ===
                dispersionEntry.bindingName
        ? Number((unwrapPin(strength.left) as ts.NumericLiteral).text)
        : undefined;
    if (scale === undefined) {
        refuseModule(
            dielectricSymbol,
            "no longer derives the dispersion strength as a constant " +
                "over the authored dispersion",
        );
    }
    // Iridescence: the setter options object, keys and defaults by name.
    const iridescenceSymbol = "KHR_materials_iridescence";
    const iridescenceApply = featureMethod(
        iridescenceFile,
        iridescenceSymbol,
        "applyMaterial",
    );
    const setterCalls: ts.CallExpression[] = [];
    const findSetter = (node: ts.Node): void => {
        ts.forEachChild(node, findSetter);
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "setPbrIridescence"
        ) {
            setterCalls.push(node);
        }
    };
    findSetter(iridescenceApply.body);
    const options = setterCalls.length === 1 &&
            setterCalls[0]!.arguments.length === 2 &&
            ts.isObjectLiteralExpression(
                unwrapPin(setterCalls[0]!.arguments[1]!),
            )
        ? unwrapPin(
            setterCalls[0]!.arguments[1]!,
        ) as ts.ObjectLiteralExpression
        : undefined;
    if (!options) {
        refuseModule(
            iridescenceSymbol,
            "no longer passes setPbrIridescence one options object",
        );
    }
    /** Setter option → the template slot its `iri.key ?? value` fills. */
    const iridescenceSlots: Readonly<Record<string, string>> = {
        intensity: "iridescenceFactor",
        indexOfRefraction: "iridescenceIor",
        minimumThickness: "iridescenceThicknessMinimum",
        maximumThickness: "iridescenceThicknessMaximum",
    };
    const iridescenceDefaults = new Map<string, GltfLoweredDefault>();
    for (const property of options.properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
        ) {
            continue;
        }
        const coalesce = unwrapPin(property.initializer);
        if (
            !ts.isBinaryExpression(coalesce) ||
            coalesce.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken
        ) {
            continue;
        }
        const readValue = unwrapPin(coalesce.left);
        const key = (ts.isPropertyAccessExpression(readValue) ||
                ts.isPropertyAccessChain(readValue))
            ? readValue.name.text
            : undefined;
        const slot = iridescenceSlots[property.name.text];
        if (key === undefined || slot === undefined) {
            refuseNode(
                iridescenceSymbol,
                iridescenceFile,
                property,
                "defaults an option no lowering entry consumes",
            );
        }
        iridescenceDefaults.set(slot, {
            key,
            literal: floatLiteral(
                signedNumericValue(
                    iridescenceSymbol,
                    iridescenceFile,
                    coalesce.right,
                ),
            ),
        });
    }
    const iridescenceSlot = (slot: string): GltfLoweredDefault => {
        const entry = iridescenceDefaults.get(slot);
        if (!entry) {
            refuseModule(
                iridescenceSymbol,
                `no longer defaults the '${slot}' option`,
            );
        }
        return entry;
    };
    return {
        ior,
        transmissionFactor,
        thicknessFactor,
        attenuationDistance,
        dispersion,
        dispersionScale: floatLiteral(scale),
        iridescenceFactor: iridescenceSlot("iridescenceFactor"),
        iridescenceIor: iridescenceSlot("iridescenceIor"),
        iridescenceThicknessMinimum: iridescenceSlot(
            "iridescenceThicknessMinimum",
        ),
        iridescenceThicknessMaximum: iridescenceSlot(
            "iridescenceThicknessMaximum",
        ),
    };
}

/*
 * ──────────────────── round-3 loader leaves ────────────────────
 *
 * Same contract again: the emitters own the translation, never the
 * formula. Round 3 lowers the matrix family, the EXT_lights_image_based
 * polynomial conversion and environment scalars, and the
 * KHR_lights_punctual record build. Round 3 left two members of the
 * matrix family hand-written as open decisions; round 4 resolved both:
 *
 *   - `local_matrix` used to transcribe the pinned `mat4ComposeInto` in
 *     float arithmetic over `float_array` inputs, where the pin
 *     composes raw JSON doubles and rounds once per entry at the
 *     (default-F32) scratch store — a last-ulp divergence (an exact
 *     90-degree quaternion yielded m[0] = 5.96e-8f against the pin's
 *     -2.2e-16f). The port rule (match the pin) resolves it: the raw
 *     doubles ARE reachable at that point (`local_matrix` receives the
 *     parsed JSON object, and `as_number()` is a double), so
 *     `lowerLocalMatrixCpp` now emits the function from
 *     `computeNodeWorldMatrix` + the same compose walk `trs_matrix`
 *     uses, reading the JSON as doubles and rounding once per lane at
 *     the store — the pin's own precision chain.
 *
 *   - `inverse_affine` had no call site in any emitted loader, and its
 *     3x3-cofactor formula (epsilon 1e-6, identity fallback) matched
 *     neither the pinned `mat4Invert` (full 4x4 cofactors in a different
 *     association, epsilon 1e-10, null fallback) nor any caller's
 *     convention. Dead and unpinnable; DELETED from the template.
 *
 * The translations round 3 does own, documented once here:
 *   - `native_matrix` is the record's convention, not a pinned formula:
 *     the pin left-multiplies `RH_TO_LH_ROOT` (diag(-1,1,1,1)) onto the
 *     hierarchy root, while the record keeps node worlds in glTF space
 *     and applies the equivalent diagonal change of basis D*M*D at the
 *     consumption sites (`native_matrix`, the light position/direction
 *     signs). Multiplying rows or columns by the diagonal's +-1 entries
 *     is exact in IEEE arithmetic, and the anonymous-namespace multiply
 *     forms `(-a)*b + (-c)*d = -(a*b + c*d)` exactly, so the folded form
 *     is bit-identical to the pin's root multiply for finite inputs.
 *     Only the flip axis and sign flow; they anchor to the pin's root
 *     literal, and the light segment derives its lane signs from the
 *     same diagonal.
 *   - `Number.MAX_VALUE` becomes `std::numeric_limits<float>::max()`:
 *     the record stores light ranges as float32, where the pin's double
 *     max would round to +inf. Both mean "unattenuated" to the shader;
 *     the substitution is fixed text gated on the pin actually reading
 *     `Number.MAX_VALUE`.
 *   - The punctual pin normalizes the fallback direction with
 *     `Math.hypot(...) || 1`; the record routes it through the loader's
 *     shared `normalize` (epsilon 1e-6, (0,1,0) fallback). They differ
 *     only for a zero-length forward, which a finite rotation matrix
 *     cannot produce; the emitter pins the pin's shape and keeps the
 *     record's plumbing.
 *   - The IBL polynomial segment, like the round-2 SH prescale beside
 *     it, keeps the loader's float arithmetic over `float_array` inputs
 *     as its fixed presentation of the pin's double math; the band
 *     constants, slot layout, and prescale structure all flow.
 */

const pinnedFloatLiteral = (literal: ts.NumericLiteral): string =>
    floatLiteral(Number(literal.text));

function identifierText(
    expression: ts.Expression,
): string | undefined {
    const node = unwrapPin(expression);
    return ts.isIdentifier(node) ? node.text : undefined;
}

function collectNodes<T extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is T,
): T[] {
    const result: T[] = [];
    const visit = (node: ts.Node): void => {
        if (predicate(node)) result.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return result;
}

/** `base[offset]` → 0, `base[offset + n]` → n, anything else undefined. */
function offsetElementIndex(
    expression: ts.Expression,
    baseName: string,
    offsetName: string,
): number | undefined {
    const read = unwrapPin(expression);
    if (
        !ts.isElementAccessExpression(read) ||
        identifierText(read.expression) !== baseName
    ) {
        return undefined;
    }
    const index = unwrapPin(read.argumentExpression);
    if (ts.isIdentifier(index)) {
        return index.text === offsetName ? 0 : undefined;
    }
    if (
        ts.isBinaryExpression(index) &&
        index.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        identifierText(index.left) === offsetName &&
        ts.isNumericLiteral(unwrapPin(index.right))
    ) {
        return Number((unwrapPin(index.right) as ts.NumericLiteral).text);
    }
    return undefined;
}

/** A left-associated `a (+|-) b (+|-) c` chain as parts and operators. */
function additiveChainParts(expression: ts.Expression): {
    parts: ts.Expression[];
    operators: ("+" | "-")[];
} {
    const node = unwrapPin(expression);
    if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
            node.operatorToken.kind === ts.SyntaxKind.MinusToken)
    ) {
        const left = additiveChainParts(node.left);
        return {
            parts: [...left.parts, node.right],
            operators: [
                ...left.operators,
                node.operatorToken.kind === ts.SyntaxKind.PlusToken
                    ? "+"
                    : "-",
            ],
        };
    }
    return { parts: [expression], operators: [] };
}

/** `Math.<name>(...)` → the call, or undefined. */
function mathCall(
    expression: ts.Expression,
    name: string,
): ts.CallExpression | undefined {
    const node = unwrapPin(expression);
    return ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            identifierText(node.expression.expression) === "Math" &&
            node.expression.name.text === name
        ? node
        : undefined;
}

function isMathPi(expression: ts.Expression): boolean {
    const node = unwrapPin(expression);
    return ts.isPropertyAccessExpression(node) &&
        identifierText(node.expression) === "Math" &&
        node.name.text === "PI";
}

/**
 * Evaluates the constant subset the round-3 defaults use: literals, a
 * leading minus, `Math.PI`, and products/quotients of those. The spot
 * default `Math.PI / 4` evaluates here to the double the record bakes.
 */
function pinnedConstantValue(
    symbol: string,
    file: ts.SourceFile,
    expression: ts.Expression,
): number {
    const node = unwrapPin(expression);
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.MinusToken
    ) {
        return -pinnedConstantValue(symbol, file, node.operand);
    }
    if (isMathPi(node)) return Math.PI;
    if (ts.isBinaryExpression(node)) {
        const left = pinnedConstantValue(symbol, file, node.left);
        const right = pinnedConstantValue(symbol, file, node.right);
        if (node.operatorToken.kind === ts.SyntaxKind.SlashToken) {
            return left / right;
        }
        if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
            return left * right;
        }
    }
    refuseNode(
        symbol,
        file,
        expression,
        "uses a default this lowering cannot evaluate",
    );
}

/**
 * The pin's RH→LH root conversion (`gltf-parser.ts#RH_TO_LH_ROOT`): the
 * single sixteen-entry F32 literal, verified diagonal with exactly one
 * axis flipped by -1 and a unit homogeneous lane, and verified to be the
 * parent `computeNodeWorldMatrix` multiplies onto hierarchy roots. The
 * record folds this diagonal into its consumption sites instead of
 * multiplying it at the root — see the round-3 notes above.
 */
function pinnedRootFlip(
    file: ts.SourceFile,
): { lane: number; sign: number } {
    const symbol = "RH_TO_LH_ROOT";
    const candidates: { name: string; values: number[] }[] = [];
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of
            statement.declarationList.declarations) {
            if (
                !ts.isIdentifier(declaration.name) ||
                !declaration.initializer
            ) {
                continue;
            }
            const value = unwrapPin(declaration.initializer);
            if (
                !ts.isNewExpression(value) ||
                identifierText(value.expression) !== "F32" ||
                value.arguments?.length !== 1
            ) {
                continue;
            }
            const argument = unwrapPin(value.arguments[0]!);
            if (
                !ts.isArrayLiteralExpression(argument) ||
                argument.elements.length !== 16
            ) {
                continue;
            }
            candidates.push({
                name: declaration.name.text,
                values: argument.elements.map((element) =>
                    signedNumericValue(symbol, file, element)
                ),
            });
        }
    }
    if (candidates.length !== 1) {
        refuseModule(
            symbol,
            "is no longer the parser's single sixteen-entry F32 literal",
        );
    }
    const root = candidates[0]!;
    for (let index = 0; index < 16; index += 1) {
        if (index % 5 !== 0 && root.values[index] !== 0) {
            refuseModule(symbol, "is no longer a diagonal matrix");
        }
    }
    if (root.values[15] !== 1) {
        refuseModule(symbol, "no longer keeps a unit homogeneous lane");
    }
    const flips = [0, 1, 2].filter(
        (lane) => root.values[lane * 5] !== 1,
    );
    if (flips.length !== 1 || root.values[flips[0]! * 5] !== -1) {
        refuseModule(symbol, "no longer flips exactly one axis by -1");
    }
    const compute = topLevelFunction(file, "computeNodeWorldMatrix");
    const usedAsRoot = collectNodes(
        compute,
        (node): node is ts.ConditionalExpression =>
            ts.isConditionalExpression(node) &&
            identifierText(node.whenFalse) === root.name,
    ).length > 0;
    if (!usedAsRoot) {
        refuseNode(
            symbol,
            file,
            compute,
            "no longer parents hierarchy roots on the RH→LH conversion",
        );
    }
    return { lane: flips[0]!, sign: -1 };
}

/**
 * `mat4MultiplyInto` → `multiply_matrix`.
 *
 * The pin is fully unrolled: sixteen `dst[d + n] = a? * b? + …` stores
 * over four reloaded right-hand column windows. The walk resolves every
 * term back to its flat `a`/`b` element and requires exactly the
 * canonical column-major product — `a[row + 4k] * b[4·column + k]` with
 * k ascending in a left-associated plus chain — so a transposed or
 * re-associated pin refuses. The emission is the loop the loader has
 * always carried: the loop is presentation only, because `0.0 + x` is
 * exact and the running double sum adds the pin's exact products in the
 * pin's order before the one rounding at the float store.
 */
export function lowerMatrixMultiplyCpp(file: ts.SourceFile): string {
    const symbol = "mat4MultiplyInto";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 6) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (dst, d, a, i, b, j)",
        );
    }
    const dstName = parameters[0]!;
    const dstOffset = parameters[1]!;
    const leftName = parameters[2]!;
    const leftOffset = parameters[3]!;
    const rightName = parameters[4]!;
    const rightOffset = parameters[5]!;
    const leftFlat = new Map<string, number>();
    const rightFlat = new Map<string, number>();
    let next = 0;
    for (const statement of declaration.body.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const binding of
                statement.declarationList.declarations) {
                if (
                    !ts.isIdentifier(binding.name) ||
                    !binding.initializer
                ) {
                    refuseNode(
                        symbol,
                        file,
                        statement,
                        "binds a local this lowering cannot carry",
                    );
                }
                const leftIndex = offsetElementIndex(
                    binding.initializer,
                    leftName,
                    leftOffset,
                );
                const rightIndex = offsetElementIndex(
                    binding.initializer,
                    rightName,
                    rightOffset,
                );
                if (leftIndex !== undefined) {
                    leftFlat.set(binding.name.text, leftIndex);
                } else if (rightIndex !== undefined) {
                    rightFlat.set(binding.name.text, rightIndex);
                } else {
                    refuseNode(
                        symbol,
                        file,
                        binding,
                        "no longer binds a matrix element read",
                    );
                }
            }
            continue;
        }
        const assignment = ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? statement.expression
            : undefined;
        if (!assignment) {
            refuseNode(
                symbol,
                file,
                statement,
                "carries a statement this lowering cannot carry",
            );
        }
        const target = unwrapPin(assignment.left);
        if (
            ts.isIdentifier(target) &&
            rightFlat.has(target.text)
        ) {
            const reloaded = offsetElementIndex(
                assignment.right,
                rightName,
                rightOffset,
            );
            if (reloaded === undefined) {
                refuseNode(
                    symbol,
                    file,
                    assignment,
                    "no longer reloads the right-hand column window",
                );
            }
            rightFlat.set(target.text, reloaded);
            continue;
        }
        const component = offsetElementIndex(
            assignment.left,
            dstName,
            dstOffset,
        );
        if (component === undefined || component !== next) {
            refuseNode(
                symbol,
                file,
                assignment,
                `no longer stores component ${next} in order`,
            );
        }
        const terms = additiveTerms(assignment.right);
        const row = component % 4;
        const column = (component - row) / 4;
        if (terms.length !== 4) {
            refuseNode(
                symbol,
                file,
                assignment,
                `no longer sums four products for component ${component}`,
            );
        }
        terms.forEach((term, k) => {
            const product = unwrapPin(term);
            const canonical = ts.isBinaryExpression(product) &&
                product.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                leftFlat.get(identifierText(product.left) ?? "") ===
                    row + 4 * k &&
                rightFlat.get(identifierText(product.right) ?? "") ===
                    column * 4 + k;
            if (!canonical) {
                refuseNode(
                    symbol,
                    file,
                    term,
                    "no longer forms the canonical column-major product " +
                        `for component ${component}`,
                );
            }
        });
        next += 1;
    }
    if (next !== 16) {
        refuseModule(symbol, "no longer stores all sixteen components");
    }
    return [
        "Matrix multiply_matrix(const Matrix& left, const Matrix& right) {",
        "    // Pinned matrix multiplication runs in JavaScript double",
        "    // precision over float32 entries and rounds once per component",
        "    // at the Float32Array store; mirror that exactly.",
        "    Matrix result{};",
        "    for (int column = 0; column < 4; ++column) {",
        "        for (int row = 0; row < 4; ++row) {",
        "            double sum = 0.0;",
        "            for (int index = 0; index < 4; ++index) {",
        "                sum +=",
        "                    static_cast<double>(left[index * 4 + row]) *",
        "                    static_cast<double>(right[column * 4 + index]);",
        "            }",
        "            result[column * 4 + row] = static_cast<float>(sum);",
        "        }",
        "    }",
        "    return result;",
        "}",
    ].join("\n");
}

/** The pinned `mat4ComposeInto` body, walked once for both emitters. */
interface ComposePinWalk {
    /** The pin's quaternion parameter names, in lane order. */
    quaternionNames: string[];
    /** The pin's scale parameter names — the emitted local names. */
    scaleNames: string[];
    /** `const double xx = x * x;` … with lane-mapped names. */
    productLines: string[];
    /** The rendered double expression per non-identity rotation lane. */
    rotationStores: { lane: number; text: string }[];
}

/**
 * Walks `mat4ComposeInto`: the quaternion parameters lift to double
 * lanes named x..w, the product locals and every store expression
 * render from the pin (doubles, one `static_cast<float>` per
 * Float32Array store), the constant lanes 3/7/11/15 are verified 0/1
 * and folded into the identity seed, and the translation lanes must
 * store the raw parameters. `trs_matrix` and `local_matrix` both emit
 * from this one walk.
 */
function composePinWalk(file: ts.SourceFile): ComposePinWalk {
    const symbol = "mat4ComposeInto";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 12) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (dst, off, translation, quaternion, scale)",
        );
    }
    const dstName = parameters[0]!;
    const offName = parameters[1]!;
    const translationNames = parameters.slice(2, 5);
    const quaternionNames = parameters.slice(5, 9);
    const scaleNames = parameters.slice(9, 12);
    const names = new Map<string, string>();
    quaternionNames.forEach((name, lane) => {
        names.set(name, laneMembers[lane]!);
    });
    for (const name of scaleNames) names.set(name, name);
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedDoubleLiteral,
    };
    const quaternionSet = new Set(quaternionNames);
    const statements = declaration.body.statements;
    let index = 0;
    const productLines: string[] = [];
    while (
        index < statements.length &&
        ts.isVariableStatement(statements[index]!)
    ) {
        const statement = statements[index] as ts.VariableStatement;
        index += 1;
        for (const binding of statement.declarationList.declarations) {
            if (!ts.isIdentifier(binding.name) || !binding.initializer) {
                refuseNode(
                    symbol,
                    file,
                    statement,
                    "binds a local this lowering cannot carry",
                );
            }
            const product = unwrapPin(binding.initializer);
            const quaternionProduct = ts.isBinaryExpression(product) &&
                product.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                quaternionSet.has(identifierText(product.left) ?? "") &&
                quaternionSet.has(identifierText(product.right) ?? "");
            if (!quaternionProduct) {
                refuseNode(
                    symbol,
                    file,
                    binding,
                    "no longer binds a quaternion product",
                );
            }
            productLines.push(
                `    const double ${binding.name.text} = ` +
                    `${
                        renderCppExpression(scope, binding.initializer)
                            .text
                    };`,
            );
            names.set(binding.name.text, binding.name.text);
        }
    }
    const rotationStores: { lane: number; text: string }[] = [];
    let lane = 0;
    for (; index < statements.length; index += 1, lane += 1) {
        const statement = statements[index]!;
        const assignment = ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? statement.expression
            : undefined;
        const component = assignment
            ? offsetElementIndex(assignment.left, dstName, offName)
            : undefined;
        if (!assignment || component === undefined || component !== lane) {
            refuseNode(
                symbol,
                file,
                statement,
                `no longer stores component ${lane} in order`,
            );
        }
        const value = unwrapPin(assignment.right);
        if (lane === 3 || lane === 7 || lane === 11 || lane === 15) {
            const expected = lane === 15 ? 1 : 0;
            if (
                !ts.isNumericLiteral(value) ||
                Number(value.text) !== expected
            ) {
                refuseNode(
                    symbol,
                    file,
                    assignment,
                    `no longer keeps the identity value in lane ${lane}`,
                );
            }
            continue;
        }
        if (lane >= 12 && lane <= 14) {
            if (
                identifierText(value) !== translationNames[lane - 12]
            ) {
                refuseNode(
                    symbol,
                    file,
                    assignment,
                    `no longer stores the raw translation in lane ${lane}`,
                );
            }
            continue;
        }
        rotationStores.push({
            lane,
            text: renderCppExpression(scope, assignment.right).text,
        });
    }
    if (lane !== 16) {
        refuseModule(symbol, "no longer stores all sixteen components");
    }
    return { quaternionNames, scaleNames, productLines, rotationStores };
}

/** `mat4ComposeInto` → `trs_matrix` (float lanes lifted to double). */
export function lowerMatrixComposeCpp(file: ts.SourceFile): string {
    const walk = composePinWalk(file);
    return [
        "Matrix trs_matrix(",
        "    Vec3 translation,",
        "    Vec4 rotation,",
        "    Vec3 scale) {",
        "    // Pinned mat4ComposeInto runs in JavaScript double precision and",
        "    // rounds once at the Float32Array store; mirror its products and",
        "    // association exactly.",
        ...walk.quaternionNames.map(
            (_, quaternionLane) =>
                `    const double ${laneMembers[quaternionLane]!} = ` +
                `rotation.${laneMembers[quaternionLane]!};`,
        ),
        ...walk.productLines,
        ...walk.scaleNames.map(
            (name, scaleLane) =>
                `    const double ${name} = ` +
                `scale.${laneMembers[scaleLane]!};`,
        ),
        "    Matrix result = identity_matrix();",
        ...walk.rotationStores.map(
            (store) =>
                `    result[${store.lane}] = ` +
                `static_cast<float>(${store.text});`,
        ),
        "    result[12] = translation.x;",
        "    result[13] = translation.y;",
        "    result[14] = translation.z;",
        "    return result;",
        "}",
    ].join("\n");
}

/** `node[index]` with a numeric literal index → the index, else undefined. */
function numericElementIndex(
    expression: ts.Expression,
    baseName: string,
): number | undefined {
    const read = unwrapPin(expression);
    if (
        !ts.isElementAccessExpression(read) ||
        identifierText(read.expression) !== baseName
    ) {
        return undefined;
    }
    const index = unwrapPin(read.argumentExpression);
    return ts.isNumericLiteral(index) ? Number(index.text) : undefined;
}

/** One TRS input of the pinned local compose: JSON key and defaults. */
interface LocalComposeInput {
    bindingName: string;
    key: string;
    defaults: number[];
}

/**
 * `computeNodeWorldMatrix` + `mat4ComposeInto` → `local_matrix`.
 *
 * The pin hands the compose the RAW JSON doubles
 * (`node.translation ?? [0, 0, 0]`, `node.rotation ?? [0, 0, 0, 1]`,
 * `node.scale ?? [1, 1, 1]`) and the F32-backed scratch store rounds
 * each lane exactly once, so the emitted function reads the JSON as
 * doubles, composes the same products, and applies one
 * `static_cast<float>` per lane — the camera-precision rule: round
 * where the pin's Float32Array stores are, never earlier. The record
 * used to round the inputs at a `float_array` read and compose in
 * float, which diverges from the pin in the last ulps (an exact
 * 90-degree yaw landed m[0] at 5.96e-8f where the pin stores
 * -2.22e-16f). The authored-matrix arm mirrors the pin's
 * `new F32(node.matrix)`: one float rounding per element at the copy.
 *
 * Everything flows: the three JSON keys and their whole-array defaults
 * from `computeNodeWorldMatrix`, the argument order from its
 * `mat4ComposeInto` call, and the product/store expressions from the
 * same walk `trs_matrix` emits from. The 16-length throw on the
 * authored-matrix arm is record plumbing (the pin copies whatever the
 * JSON carries; the record refuses a malformed file instead).
 */
export function lowerLocalMatrixCpp(
    parserFile: ts.SourceFile,
    composeFile: ts.SourceFile,
): string {
    const walk = composePinWalk(composeFile);
    const symbol = "computeNodeWorldMatrix";
    const declaration = topLevelFunction(parserFile, symbol);
    // The authored-matrix arm: `if (node.matrix) { … new F32(node.matrix) … }`.
    const matrixBranches = collectNodes(
        declaration,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            ts.isPropertyAccessExpression(unwrapPin(node.expression)) &&
            (unwrapPin(node.expression) as ts.PropertyAccessExpression)
                    .name.text === "matrix",
    );
    if (matrixBranches.length !== 1) {
        refuseModule(
            symbol,
            "no longer branches on the authored node matrix exactly once",
        );
    }
    const matrixBranch = matrixBranches[0]!;
    const matrixKey =
        (unwrapPin(matrixBranch.expression) as ts.PropertyAccessExpression)
            .name.text;
    const matrixCopies = collectNodes(
        matrixBranch.thenStatement,
        (node): node is ts.NewExpression =>
            ts.isNewExpression(node) &&
            identifierText(node.expression) === "F32" &&
            node.arguments?.length === 1 &&
            ts.isPropertyAccessExpression(unwrapPin(node.arguments[0]!)) &&
            (unwrapPin(node.arguments[0]!) as ts.PropertyAccessExpression)
                    .name.text === matrixKey,
    );
    if (matrixCopies.length !== 1) {
        refuseNode(
            symbol,
            parserFile,
            matrixBranch,
            "no longer copies the authored matrix into a fresh Float32Array",
        );
    }
    // The TRS arm's whole-array defaults, keyed by binding name.
    const inputs = new Map<string, LocalComposeInput>();
    for (const binding of collectNodes(
        declaration,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined,
    )) {
        const coalesced = coalescedPropertyDefault(binding.initializer!);
        if (!coalesced) continue;
        const fallback = unwrapPin(coalesced.fallback);
        if (!ts.isArrayLiteralExpression(fallback)) continue;
        inputs.set((binding.name as ts.Identifier).text, {
            bindingName: (binding.name as ts.Identifier).text,
            key: coalesced.key,
            defaults: fallback.elements.map((element) =>
                signedNumericValue(symbol, parserFile, element)
            ),
        });
    }
    // The compose call fixes which binding feeds which parameter block.
    const composeCalls = collectNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === "mat4ComposeInto",
    );
    if (
        composeCalls.length !== 1 ||
        composeCalls[0]!.arguments.length !== 12
    ) {
        refuseModule(
            symbol,
            "no longer composes the node TRS through one " +
                "mat4ComposeInto call",
        );
    }
    const composeArguments = composeCalls[0]!.arguments.slice(2);
    const blockOf = (
        start: number,
        count: number,
    ): LocalComposeInput => {
        let input: LocalComposeInput | undefined;
        for (let lane = 0; lane < count; lane += 1) {
            const argument = unwrapPin(composeArguments[start + lane]!);
            const read = ts.isElementAccessExpression(argument)
                ? argument
                : undefined;
            const base = read
                ? identifierText(read.expression)
                : undefined;
            const candidate = base !== undefined
                ? inputs.get(base)
                : undefined;
            if (
                !read ||
                !candidate ||
                numericElementIndex(read, candidate.bindingName) !== lane ||
                (input !== undefined && candidate !== input)
            ) {
                refuseNode(
                    symbol,
                    parserFile,
                    composeArguments[start + lane]!,
                    "no longer reads the raw JSON lanes in parameter order",
                );
            }
            input = candidate;
        }
        if (!input || input.defaults.length !== count) {
            refuseModule(
                symbol,
                "no longer defaults a TRS input to the lane count " +
                    "its parameter block consumes",
            );
        }
        return input;
    };
    const translation = blockOf(0, 3);
    const quaternion = blockOf(3, walk.quaternionNames.length);
    const scale = blockOf(3 + walk.quaternionNames.length, 3);
    const translationNames = ["tx", "ty", "tz"];
    const laneLine = (
        cppName: string,
        input: LocalComposeInput,
        lane: number,
        vector: string,
    ): string =>
        `    const double ${cppName} = ${vector}.size() == ` +
        `${input.defaults.length} ? ${vector}[${lane}] : ` +
        `${doubleLiteral(input.defaults[lane]!)};`;
    return [
        "Matrix local_matrix(const JsonObject& node) {",
        `    if (const ts::JsonValue* matrix_value = optional(node, "${matrixKey}")) {`,
        "        const std::vector<float> values = float_array(matrix_value);",
        '        if (values.size() != 16) throw std::runtime_error("glTF node matrix must have 16 values.");',
        "        Matrix result{};",
        "        std::copy(values.begin(), values.end(), result.begin());",
        "        return result;",
        "    }",
        "    // Pinned computeNodeWorldMatrix hands mat4ComposeInto the raw",
        "    // JSON doubles and the F32-backed scratch store rounds each lane",
        "    // exactly once. Camera-precision rule: round where the pin's",
        "    // Float32Array stores are, never earlier — floats rounded at the",
        "    // JSON read and composed in float diverge in the last ulps (an",
        "    // exact 90-degree yaw lands m[0] at 5.96e-8f where the pin",
        "    // stores -2.22e-16f).",
        "    const std::vector<double> translation = " +
        `double_array(optional(node, "${translation.key}"));`,
        "    const std::vector<double> rotation = " +
        `double_array(optional(node, "${quaternion.key}"));`,
        "    const std::vector<double> scale = " +
        `double_array(optional(node, "${scale.key}"));`,
        ...translationNames.map((name, lane) =>
            laneLine(name, translation, lane, "translation")
        ),
        ...walk.quaternionNames.map((_, lane) =>
            laneLine(laneMembers[lane]!, quaternion, lane, "rotation")
        ),
        ...walk.scaleNames.map((name, lane) =>
            laneLine(name, scale, lane, "scale")
        ),
        ...walk.productLines,
        "    Matrix result = identity_matrix();",
        ...walk.rotationStores.map(
            (store) =>
                `    result[${store.lane}] = ` +
                `static_cast<float>(${store.text});`,
        ),
        ...translationNames.map(
            (name, lane) =>
                `    result[${12 + lane}] = static_cast<float>(${name});`,
        ),
        "    return result;",
        "}",
    ].join("\n");
}

/**
 * `native_matrix`, anchored to the pin's `RH_TO_LH_ROOT`.
 *
 * The function is the record's convention — the diagonal change of
 * basis D*M*D applied where a matrix enters a native record, instead of
 * the pin's left multiply at the hierarchy root — so only the flip axis
 * and its sign flow. See the round-3 notes for the exactness argument.
 */
export function lowerMatrixNativeCpp(file: ts.SourceFile): string {
    const { lane, sign } = pinnedRootFlip(file);
    const literal = floatLiteral(sign);
    return [
        "Matrix native_matrix(const Matrix& matrix) {",
        "    Matrix result{};",
        "    for (std::size_t column = 0; column < 4; ++column) {",
        "        for (std::size_t row = 0; row < 4; ++row) {",
        `            const float row_sign = row == ${lane} ? ` +
        `${literal} : 1.0f;`,
        "            const float column_sign =",
        `                column == ${lane} ? ${literal} : 1.0f;`,
        "            result[column * 4 + row] =",
        "                matrix[column * 4 + row] *",
        "                row_sign *",
        "                column_sign;",
        "        }",
        "    }",
        "    return result;",
        "}",
    ].join("\n");
}

/**
 * Resolves an identifier argument back to its `const` declaration
 * inside `root`, for tying a call argument to the binding whose
 * initializer carries the pinned default.
 */
function declarationOf(
    root: ts.Node,
    name: string,
): ts.VariableDeclaration | undefined {
    return collectNodes(
        root,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === name,
    )[0];
}

/** `<base>.<key> ?? <default>` → the key and the default expression. */
function coalescedPropertyDefault(
    expression: ts.Expression,
): { key: string; fallback: ts.Expression; read: ts.Expression } | undefined {
    const node = unwrapPin(expression);
    if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    ) {
        return undefined;
    }
    const read = unwrapPin(node.left);
    if (
        !ts.isPropertyAccessExpression(read) &&
        !ts.isPropertyAccessChain(read)
    ) {
        return undefined;
    }
    return { key: read.name.text, fallback: node.right, read };
}

/**
 * The EXT_lights_image_based SH9 → spherical-polynomial conversion →
 * the polynomial segment of `load_image_based_environment`.
 *
 * Everything numeric flows from `irradianceCoefficientsToPolynomial`:
 * the intensity/π prescale, the folded Lambertian 1/π, the nine band
 * expressions with their constants, and the slot layout (nine stride-3
 * coefficient reads into nine stride-3 polynomial stores). The
 * intensity default flows from the `applyAsset` binding that feeds the
 * conversion call. The record's nine-`Color3` layout is a fixed
 * contract (`pre_scale_harmonics` consumes exactly nine), so a pin
 * whose coefficient count or channel count moves refuses rather than
 * emitting a record the environment cannot carry.
 */
export function lowerIblPolynomialCpp(file: ts.SourceFile): string {
    const symbol = "irradianceCoefficientsToPolynomial";
    const declaration = topLevelFunction(file, symbol);
    const parameters = identifierParameters(symbol, file, declaration);
    if (parameters.length !== 2) {
        refuseNode(
            symbol,
            file,
            declaration,
            "no longer takes (coefficients, intensity)",
        );
    }
    const coefficientsName = parameters[0]!;
    const intensityName = parameters[1]!;
    const statements = declaration.body.statements;
    // `const s = intensity / Math.PI;` — the radiance prescale.
    const scaleBinding = singleBinding(
        symbol,
        file,
        statements[0],
        declaration,
    );
    const scaleValue = unwrapPin(scaleBinding.initializer);
    const scaleShape = ts.isBinaryExpression(scaleValue) &&
        scaleValue.operatorToken.kind === ts.SyntaxKind.SlashToken &&
        identifierText(scaleValue.left) === intensityName &&
        isMathPi(scaleValue.right);
    if (!scaleShape) {
        refuseNode(
            symbol,
            file,
            scaleBinding.statement,
            "no longer scales the harmonics by intensity over pi",
        );
    }
    // `const poly = new Float32Array(27);` — slots × channels.
    const polyBinding = singleBinding(
        symbol,
        file,
        statements[1],
        declaration,
    );
    const polyNew = unwrapPin(polyBinding.initializer);
    const polySize = ts.isNewExpression(polyNew) &&
            identifierText(polyNew.expression) === "Float32Array" &&
            polyNew.arguments?.length === 1 &&
            ts.isNumericLiteral(unwrapPin(polyNew.arguments[0]!))
        ? Number(
            (unwrapPin(polyNew.arguments[0]!) as ts.NumericLiteral).text,
        )
        : undefined;
    if (polySize === undefined) {
        refuseNode(
            symbol,
            file,
            polyBinding.statement,
            "no longer stores a fixed-size polynomial",
        );
    }
    // `for (let c = 0; c < 3; c++)` — one pass per color channel.
    const loop = statements[2];
    if (
        !loop ||
        !ts.isForStatement(loop) ||
        !loop.initializer ||
        !ts.isVariableDeclarationList(loop.initializer) ||
        loop.initializer.declarations.length !== 1 ||
        !ts.isIdentifier(loop.initializer.declarations[0]!.name) ||
        !loop.condition ||
        !ts.isBinaryExpression(loop.condition) ||
        loop.condition.operatorToken.kind !==
            ts.SyntaxKind.LessThanToken ||
        !ts.isNumericLiteral(unwrapPin(loop.condition.right)) ||
        !ts.isBlock(loop.statement)
    ) {
        refuseNode(
            symbol,
            file,
            loop ?? declaration,
            "no longer loops once per color channel",
        );
    }
    const channelName = (
        loop.initializer.declarations[0]!.name as ts.Identifier
    ).text;
    const channels = Number(
        (unwrapPin(loop.condition.right) as ts.NumericLiteral).text,
    );
    // The record's Color3 lanes and nine-harmonic environment are fixed
    // contracts; a pin that moves either cannot lower into them.
    if (channels !== 3) {
        refuseNode(
            symbol,
            file,
            loop,
            "no longer walks the three Color3 channels the record carries",
        );
    }
    const slots = polySize / channels;
    if (slots !== 9) {
        refuseNode(
            symbol,
            file,
            polyBinding.statement,
            "no longer stores the nine harmonics the record carries",
        );
    }
    const names = new Map<string, string>();
    const scope: CppExpressionScope = {
        symbol,
        file,
        names,
        numeric: pinnedFloatLiteral,
    };
    const body = loop.statement.statements;
    let cursor = 0;
    const bindingLines: string[] = [];
    for (let slot = 0; slot < slots; slot += 1) {
        const binding = singleBinding(symbol, file, body[cursor], loop);
        cursor += 1;
        const value = unwrapPin(binding.initializer);
        const scaled = ts.isBinaryExpression(value) &&
                value.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                identifierText(value.right) === scaleBinding.name
            ? unwrapPin(value.left)
            : undefined;
        if (scaled === undefined) {
            refuseNode(
                symbol,
                file,
                binding.statement,
                `no longer scales coefficient ${slot} by the prescale`,
            );
        }
        const channelRead = ts.isElementAccessExpression(scaled) &&
                identifierText(scaled.argumentExpression) === channelName
            ? unwrapPin(scaled.expression)
            : undefined;
        const slotOk = channelRead !== undefined &&
            ts.isElementAccessExpression(channelRead) &&
            identifierText(channelRead.expression) ===
                coefficientsName &&
            ts.isNumericLiteral(
                unwrapPin(channelRead.argumentExpression),
            ) &&
            Number(
                (
                    unwrapPin(
                        channelRead.argumentExpression,
                    ) as ts.NumericLiteral
                ).text,
            ) === slot;
        if (!slotOk) {
            refuseNode(
                symbol,
                file,
                binding.statement,
                `no longer reads coefficient ${slot} for the channel`,
            );
        }
        names.set(binding.name, binding.name);
        bindingLines.push(
            `        const float ${binding.name} =`,
            `            color_channel(source[${slot}], channel);`,
        );
    }
    // `const k = 1 / Math.PI;` — the folded Lambertian normalization.
    const inversePiBinding = singleBinding(
        symbol,
        file,
        body[cursor],
        loop,
    );
    cursor += 1;
    const inversePiValue = unwrapPin(inversePiBinding.initializer);
    const inversePiNumerator = ts.isBinaryExpression(inversePiValue) &&
            inversePiValue.operatorToken.kind ===
                ts.SyntaxKind.SlashToken &&
            ts.isNumericLiteral(unwrapPin(inversePiValue.left)) &&
            isMathPi(inversePiValue.right)
        ? Number(
            (unwrapPin(inversePiValue.left) as ts.NumericLiteral).text,
        )
        : undefined;
    if (inversePiNumerator === undefined) {
        refuseNode(
            symbol,
            file,
            inversePiBinding.statement,
            "no longer folds the Lambertian normalization over pi",
        );
    }
    /** `0 + c` / `3 + c` / … → the polynomial slot, stride `channels`. */
    const storeSlotOf = (
        expression: ts.Expression,
    ): number | undefined => {
        const node = unwrapPin(expression);
        if (ts.isIdentifier(node) && node.text === channelName) return 0;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isNumericLiteral(unwrapPin(node.left)) &&
            identifierText(node.right) === channelName
        ) {
            const offset = Number(
                (unwrapPin(node.left) as ts.NumericLiteral).text,
            );
            return offset % channels === 0
                ? offset / channels
                : undefined;
        }
        return undefined;
    };
    const storeLines: string[] = [];
    for (let slot = 0; slot < slots; slot += 1) {
        const statement = body[cursor];
        cursor += 1;
        const assignment = statement !== undefined &&
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                statement.expression.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken
            ? statement.expression
            : undefined;
        const target = assignment
            ? unwrapPin(assignment.left)
            : undefined;
        if (
            !assignment ||
            target === undefined ||
            !ts.isElementAccessExpression(target) ||
            identifierText(target.expression) !== polyBinding.name ||
            storeSlotOf(target.argumentExpression) !== slot
        ) {
            refuseNode(
                symbol,
                file,
                statement ?? loop,
                `no longer stores polynomial slot ${slot}`,
            );
        }
        const value = unwrapPin(assignment.right);
        const banded = ts.isBinaryExpression(value) &&
                value.operatorToken.kind ===
                    ts.SyntaxKind.AsteriskToken &&
                identifierText(value.right) === inversePiBinding.name
            ? value.left
            : undefined;
        if (banded === undefined) {
            refuseNode(
                symbol,
                file,
                assignment,
                `no longer scales polynomial slot ${slot} by the folded ` +
                    "normalization",
            );
        }
        storeLines.push(
            "        set_color_channel(",
            `            polynomial[${slot}],`,
            "            channel,",
        );
        const inner = unwrapPin(banded);
        if (
            ts.isBinaryExpression(inner) &&
            (inner.operatorToken.kind === ts.SyntaxKind.PlusToken ||
                inner.operatorToken.kind === ts.SyntaxKind.MinusToken)
        ) {
            // The pin parenthesizes the band sum; the segment's fixed
            // layout splits one additive term per line.
            const { parts, operators } = additiveChainParts(inner);
            parts.forEach((part, partIndex) => {
                const rendered = renderCppExpression(scope, part).text;
                if (partIndex === 0) storeLines.push("            (");
                storeLines.push(
                    partIndex < parts.length - 1
                        ? `                ${rendered} ` +
                            `${operators[partIndex]!}`
                        : `                ${rendered}) *`,
                );
            });
            storeLines.push("                inverse_pi);");
        } else {
            storeLines.push(
                `            ${
                    renderCppExpression(scope, banded).text
                } * inverse_pi);`,
            );
        }
    }
    if (cursor !== body.length) {
        refuseNode(
            symbol,
            file,
            body[cursor] ?? loop,
            "carries statements after the polynomial stores",
        );
    }
    const trailing = statements[3];
    if (
        !trailing ||
        !ts.isReturnStatement(trailing) ||
        !trailing.expression ||
        identifierText(trailing.expression) !== polyBinding.name ||
        statements.length !== 4
    ) {
        refuseNode(
            symbol,
            file,
            trailing ?? declaration,
            "no longer ends by returning the polynomial",
        );
    }
    // The applyAsset binding that feeds the conversion call carries the
    // intensity default the record substitutes for an absent property.
    const applyAsset = featureMethod(
        file,
        "EXT_lights_image_based",
        "applyAsset",
    );
    const conversionCall = collectNodes(
        applyAsset.body,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === symbol,
    )[0];
    if (!conversionCall || conversionCall.arguments.length !== 2) {
        refuseModule(
            symbol,
            "is no longer called with (coefficients, intensity)",
        );
    }
    const intensityArgument = identifierText(
        conversionCall.arguments[1]!,
    );
    const intensityDeclaration = intensityArgument !== undefined
        ? declarationOf(applyAsset.body, intensityArgument)
        : undefined;
    const intensityDefault = intensityDeclaration?.initializer
        ? coalescedPropertyDefault(intensityDeclaration.initializer)
        : undefined;
    if (!intensityDefault) {
        refuseModule(
            symbol,
            "no longer defaults the light intensity behind a coalesce",
        );
    }
    const intensityValue = pinnedConstantValue(
        symbol,
        file,
        intensityDefault.fallback,
    );
    const lines: string[] = [
        "    const float intensity =",
        `        float_or(light, "${intensityDefault.key}", ` +
        `${floatLiteral(intensityValue)});`,
        "    const float scale = intensity / pi;",
        `    const float inverse_pi = ` +
        `${floatLiteral(inversePiNumerator)} / pi;`,
        `    std::array<Color3, ${slots}> source{};`,
        "    for (",
        "        std::size_t coefficient = 0;",
        "        coefficient < source.size();",
        "        ++coefficient) {",
        "        const std::vector<float> values =",
        "            float_array(&coefficients[coefficient]);",
        `        if (values.size() != ${channels}) {`,
        "            throw std::runtime_error(",
        '                "Image-based light irradiance coefficient must be vec3.");',
        "        }",
        "        source[coefficient] = Color3{",
    ];
    for (let channel = 0; channel < channels; channel += 1) {
        lines.push(`            values[${channel}] * scale,`);
    }
    lines.push(
        "        };",
        "    }",
        `    std::array<Color3, ${slots}> polynomial{};`,
        `    for (int channel = 0; channel < ${channels}; ++channel) {`,
        ...bindingLines,
        ...storeLines,
        "    }",
    );
    return lines.join("\n");
}

/**
 * The environment scalars that follow the polynomial: the LOD
 * generation scale, the rotation yaw, and the BRDF LUT width.
 *
 * The LOD numerator's `- 1` and its guard bound flow from the pin's
 * `(mipCount - 1) / Math.log2(specularImageSize)` — the record guards
 * the quotient positive where the pin divides zero by a positive log —
 * with both operands verified to read the pinned specularImages length
 * and specularImageSize. The yaw factor and quaternion lanes flow from
 * `envYawFromQuaternion`, gated exactly as the pin gates it on an
 * authored rotation (the record's absent case leaves the zero default
 * the pin's `: 0` arm writes). The LUT width flows from the pinned
 * `generateBrdfLut`, whose `rgba16float` format anchors the record's
 * `brdf_lut_rgba16f` arm.
 */
export function lowerIblEnvironmentScalarsCpp(
    imageBasedFile: ts.SourceFile,
    assemblyFile: ts.SourceFile,
): string {
    const symbol = "EXT_lights_image_based";
    const applyAsset = featureMethod(
        imageBasedFile,
        symbol,
        "applyAsset",
    );
    // (mipCount - 1) / Math.log2(specularImageSize)
    const lodShapes = collectNodes(
        applyAsset.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            (() => {
                const value = unwrapPin(node.initializer!);
                return ts.isBinaryExpression(value) &&
                    value.operatorToken.kind ===
                        ts.SyntaxKind.SlashToken &&
                    mathCall(value.right, "log2") !== undefined;
            })(),
    );
    if (lodShapes.length !== 1) {
        refuseModule(
            symbol,
            "no longer derives one LOD scale from a log2 quotient",
        );
    }
    const lodValue = unwrapPin(
        lodShapes[0]!.initializer!,
    ) as ts.BinaryExpression;
    const numerator = unwrapPin(lodValue.left);
    const mipDrop = ts.isBinaryExpression(numerator) &&
            numerator.operatorToken.kind === ts.SyntaxKind.MinusToken &&
            ts.isNumericLiteral(unwrapPin(numerator.right))
        ? Number((unwrapPin(numerator.right) as ts.NumericLiteral).text)
        : undefined;
    const mipName = mipDrop !== undefined && ts.isBinaryExpression(numerator)
        ? identifierText(numerator.left)
        : undefined;
    const sizeName = identifierText(
        mathCall(lodValue.right, "log2")!.arguments[0] ??
            lodValue.right,
    );
    if (mipDrop === undefined || !mipName || !sizeName) {
        refuseNode(
            symbol,
            imageBasedFile,
            lodShapes[0]!,
            "no longer fits the LOD scale to the mip count",
        );
    }
    const readsProperty = (
        name: string,
        property: string,
        tail?: string,
    ): boolean => {
        const declaration = declarationOf(applyAsset.body, name);
        if (!declaration?.initializer) return false;
        let value = unwrapPin(declaration.initializer);
        if (tail !== undefined) {
            if (
                !ts.isPropertyAccessExpression(value) ||
                value.name.text !== tail
            ) {
                return false;
            }
            value = unwrapPin(value.expression);
        }
        return (
            ts.isPropertyAccessExpression(value) ||
            ts.isPropertyAccessChain(value)
        ) && value.name.text === property;
    };
    if (
        !readsProperty(mipName, "specularImages", "length") ||
        !readsProperty(sizeName, "specularImageSize")
    ) {
        refuseNode(
            symbol,
            imageBasedFile,
            lodShapes[0]!,
            "no longer derives the LOD scale from the pinned specular " +
                "image properties",
        );
    }
    // envYawFromQuaternion: -2 * Math.atan2(q[1], q[3]).
    const yaw = topLevelFunction(imageBasedFile, "envYawFromQuaternion");
    const yawParameters = identifierParameters(
        "envYawFromQuaternion",
        imageBasedFile,
        yaw,
    );
    const yawReturn = yaw.body.statements.length === 1 &&
            ts.isReturnStatement(yaw.body.statements[0]!) &&
            (yaw.body.statements[0] as ts.ReturnStatement).expression
        ? unwrapPin(
            (yaw.body.statements[0] as ts.ReturnStatement).expression!,
        )
        : undefined;
    const atan2 = yawReturn !== undefined &&
            ts.isBinaryExpression(yawReturn) &&
            yawReturn.operatorToken.kind === ts.SyntaxKind.AsteriskToken
        ? mathCall(yawReturn.right, "atan2")
        : undefined;
    const yawLane = (argument: ts.Expression | undefined): number => {
        const read = argument === undefined
            ? undefined
            : unwrapPin(argument);
        const lane = read !== undefined &&
                ts.isElementAccessExpression(read) &&
                yawParameters.length === 1 &&
                identifierText(read.expression) === yawParameters[0] &&
                ts.isNumericLiteral(unwrapPin(read.argumentExpression))
            ? Number(
                (
                    unwrapPin(
                        read.argumentExpression,
                    ) as ts.NumericLiteral
                ).text,
            )
            : undefined;
        if (lane === undefined || lane > 3) {
            refuseNode(
                "envYawFromQuaternion",
                imageBasedFile,
                read ?? yaw,
                "no longer reads a quaternion lane",
            );
        }
        return lane;
    };
    if (!atan2 || atan2.arguments.length !== 2) {
        refuseNode(
            "envYawFromQuaternion",
            imageBasedFile,
            yaw,
            "no longer derives the yaw from an atan2 product",
        );
    }
    const yawFactor = signedNumericValue(
        "envYawFromQuaternion",
        imageBasedFile,
        (yawReturn as ts.BinaryExpression).left,
    );
    const yawLaneA = yawLane(atan2.arguments[0]);
    const yawLaneB = yawLane(atan2.arguments[1]);
    // The gate: light.rotation ? envYawFromQuaternion(light.rotation) : 0.
    const gates = collectNodes(
        applyAsset.body,
        (node): node is ts.ConditionalExpression =>
            ts.isConditionalExpression(node) &&
            ts.isCallExpression(unwrapPin(node.whenTrue)) &&
            identifierText(
                (unwrapPin(node.whenTrue) as ts.CallExpression)
                    .expression,
            ) === yaw.name!.text,
    );
    const gate = gates.length === 1 ? gates[0]! : undefined;
    const gateRead = gate ? unwrapPin(gate.condition) : undefined;
    const rotationKey = gateRead !== undefined &&
            (ts.isPropertyAccessExpression(gateRead) ||
                ts.isPropertyAccessChain(gateRead))
        ? gateRead.name.text
        : undefined;
    const gateFalse = gate ? unwrapPin(gate.whenFalse) : undefined;
    if (
        !gate ||
        rotationKey === undefined ||
        gateFalse === undefined ||
        !ts.isNumericLiteral(gateFalse) ||
        Number(gateFalse.text) !== 0
    ) {
        refuseModule(
            symbol,
            "no longer gates the yaw on an authored rotation with a " +
                "zero fallback",
        );
    }
    // The BRDF LUT width and format from the pinned generator.
    const brdf = topLevelFunction(assemblyFile, "generateBrdfLut");
    const numericBindings = collectNodes(
        brdf,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            ts.isNumericLiteral(unwrapPin(node.initializer!)),
    );
    if (numericBindings.length !== 1) {
        refuseModule(
            "generateBrdfLut",
            "no longer binds the LUT size as its single numeric constant",
        );
    }
    const lutWidth = Number(
        (
            unwrapPin(
                numericBindings[0]!.initializer!,
            ) as ts.NumericLiteral
        ).text,
    );
    const lutFloat16 = collectNodes(
        brdf,
        (node): node is ts.StringLiteral =>
            ts.isStringLiteral(node) && node.text === "rgba16float",
    ).length > 0;
    if (!lutFloat16) {
        refuseModule(
            "generateBrdfLut",
            "no longer generates an rgba16float LUT",
        );
    }
    return [
        "    environment.lod_generation_scale =",
        `        specular_images.size() > ${mipDrop}`,
        "            ? static_cast<float>(",
        `                  specular_images.size() - ${mipDrop}) /`,
        "                  std::log2(",
        "                      static_cast<float>(",
        "                          environment.specular_width))",
        "            : 0.0f;",
        "    const std::vector<float> rotation =",
        `        float_array(optional(light, "${rotationKey}"));`,
        "    if (rotation.size() == 4) {",
        "        environment.rotation_y =",
        `            ${floatLiteral(yawFactor)} *`,
        `            std::atan2(rotation[${yawLaneA}], ` +
        `rotation[${yawLaneB}]);`,
        "    }",
        "    environment.brdf_lut.bytes =",
        "        pal::read_binary_file(",
        "            asset_path(",
        '                "gltf-ibl-brdf-lut.rgba16f"));',
        `    environment.brdf_lut_width = ${lutWidth};`,
        "    environment.brdf_lut_rgba16f = true;",
    ].join("\n");
}

/** Pinned light type string → the record's LightKind, by name only. */
const lightKindByPin: Readonly<Record<string, string>> = {
    point: "LightKind::point",
    directional: "LightKind::directional",
    spot: "LightKind::spot",
};

/** Pinned light type string → the factory its branch must invoke. */
const lightFactoryByPin: Readonly<Record<string, string>> = {
    point: "createPointLight",
    directional: "createDirectionalLight",
    spot: "createSpotLight",
};

function containsCall(root: ts.Node, calleeName: string): boolean {
    return collectNodes(
        root,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === calleeName,
    ).length > 0;
}

/**
 * The KHR_lights_punctual record build.
 *
 * The type strings and their order, the spot cone default (`Math.PI/4`
 * evaluated to the double the record bakes), the color/intensity
 * defaults, the JSON keys, and the world-matrix lanes all flow from the
 * pinned feature. The position/direction signs are derived, not typed:
 * the pin's fallback branch reads `world[12..14]` and `-world[8..10]`
 * from a world that includes the RH→LH root, while the record's
 * `compute_world` stays in glTF space — so each emitted sign is the
 * pin's sign times the root diagonal's lane sign (see the round-3
 * notes). The spot arm's `std::cos(outer_cone_angle)` folds the pin's
 * `outer * 2` against the light's `angle * 0.5`, verified to cancel
 * exactly; `Number.MAX_VALUE` becomes the float maximum per the
 * documented translation, and the pin must keep `range` off the
 * directional branch, `innerConeAngle` unread, and a unit spot falloff
 * exponent — record plumbing exists for none of them.
 */
export function lowerPunctualLightsCpp(
    punctualFile: ts.SourceFile,
    spotFile: ts.SourceFile,
    parserFile: ts.SourceFile,
): string {
    const symbol = "KHR_lights_punctual";
    const applyAsset = featureMethod(punctualFile, symbol, "applyAsset");
    // The extension keys the record's JSON walk mirrors.
    for (const property of [symbol, "lights", "light"]) {
        const carried = collectNodes(
            applyAsset.body,
            (node): node is ts.Node =>
                (ts.isPropertyAccessExpression(node) ||
                    ts.isPropertyAccessChain(node)) &&
                node.name.text === property,
        ).length > 0;
        if (!carried) {
            refuseModule(
                symbol,
                `no longer reads the '${property}' extension property`,
            );
        }
    }
    if (
        collectNodes(
            applyAsset.body,
            (node): node is ts.Node =>
                (ts.isIdentifier(node) ||
                    ts.isPropertyAccessExpression(node) ||
                    ts.isPropertyAccessChain(node)) &&
                (ts.isIdentifier(node)
                        ? node.text
                        : node.name.text) === "innerConeAngle",
        ).length > 0
    ) {
        refuseModule(
            symbol,
            "now reads innerConeAngle, which the record does not carry",
        );
    }
    // The type dispatch chain, in the pin's order.
    const chainHead = collectNodes(
        applyAsset.body,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            ts.isBinaryExpression(unwrapPin(node.expression)) &&
            (unwrapPin(node.expression) as ts.BinaryExpression)
                    .operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isStringLiteral(
                unwrapPin(
                    (unwrapPin(node.expression) as ts.BinaryExpression)
                        .right,
                ),
            ),
    )[0];
    let typeKey: string | undefined;
    let definitionName: string | undefined;
    const branches: { value: string; block: ts.Block }[] = [];
    let current: ts.Statement | undefined = chainHead;
    while (current !== undefined) {
        if (!ts.isIfStatement(current)) {
            refuseNode(
                symbol,
                punctualFile,
                current,
                "no longer dispatches light types through an if chain",
            );
        }
        const condition = unwrapPin(current.expression);
        const read = ts.isBinaryExpression(condition) &&
                condition.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken
            ? unwrapPin(condition.left)
            : undefined;
        const value = ts.isBinaryExpression(condition)
            ? unwrapPin(condition.right)
            : undefined;
        if (
            read === undefined ||
            value === undefined ||
            !ts.isPropertyAccessExpression(read) ||
            !ts.isStringLiteral(value) ||
            !ts.isBlock(current.thenStatement)
        ) {
            refuseNode(
                symbol,
                punctualFile,
                current,
                "no longer compares the definition type to a string",
            );
        }
        typeKey ??= read.name.text;
        definitionName ??= identifierText(read.expression);
        if (
            read.name.text !== typeKey ||
            identifierText(read.expression) !== definitionName
        ) {
            refuseNode(
                symbol,
                punctualFile,
                current,
                "no longer dispatches every branch on one definition type",
            );
        }
        branches.push({
            value: value.text,
            block: current.thenStatement,
        });
        current = current.elseStatement;
    }
    if (
        branches.length !== 3 ||
        typeKey === undefined ||
        definitionName === undefined
    ) {
        refuseModule(
            symbol,
            "no longer instantiates exactly three light types",
        );
    }
    const consumedKinds = new Set<string>();
    for (const branch of branches) {
        const kind = lightKindByPin[branch.value];
        const factory = lightFactoryByPin[branch.value];
        if (kind === undefined || factory === undefined) {
            refuseModule(
                symbol,
                `instantiates light type '${branch.value}', which has ` +
                    "no record kind",
            );
        }
        if (!containsCall(branch.block, factory)) {
            refuseModule(
                symbol,
                `no longer builds '${branch.value}' lights through ` +
                    `${factory}`,
            );
        }
        consumedKinds.add(branch.value);
    }
    for (const name of Object.keys(lightKindByPin)) {
        if (!consumedKinds.has(name)) {
            refuseModule(symbol, `no longer instantiates '${name}' lights`);
        }
    }
    const spotBranch = branches.find(
        (branch) => lightFactoryByPin[branch.value] === "createSpotLight",
    )!;
    // The shared defaults: color, intensity, range.
    const defaultConditional = (
        shape: (node: ts.ConditionalExpression) => boolean,
        reason: string,
    ): ts.ConditionalExpression => {
        const found = collectNodes(
            applyAsset.body,
            (node): node is ts.ConditionalExpression =>
                ts.isConditionalExpression(node) && shape(node),
        );
        if (found.length !== 1) refuseModule(symbol, reason);
        return found[0]!;
    };
    const propertyKeyOn = (
        expression: ts.Expression,
    ): string | undefined => {
        const read = unwrapPin(expression);
        return (ts.isPropertyAccessExpression(read) ||
                ts.isPropertyAccessChain(read)) &&
                identifierText(read.expression) === definitionName
            ? read.name.text
            : undefined;
    };
    // color: def.color ? [def.color[0], …] : [1, 1, 1]
    const colorConditional = defaultConditional(
        (node) =>
            propertyKeyOn(node.condition) !== undefined &&
            ts.isArrayLiteralExpression(unwrapPin(node.whenTrue)),
        "no longer defaults the light color behind a presence test",
    );
    const colorKey = propertyKeyOn(colorConditional.condition)!;
    const colorTuple = unwrapPin(
        colorConditional.whenTrue,
    ) as ts.ArrayLiteralExpression;
    const colorLanes = colorTuple.elements.map((element, laneIndex) => {
        const read = unwrapPin(element);
        const lane = ts.isElementAccessExpression(read) &&
                propertyKeyOn(read.expression) === colorKey &&
                ts.isNumericLiteral(unwrapPin(read.argumentExpression))
            ? Number(
                (
                    unwrapPin(
                        read.argumentExpression,
                    ) as ts.NumericLiteral
                ).text,
            )
            : undefined;
        if (lane === undefined || lane !== laneIndex) {
            refuseNode(
                symbol,
                punctualFile,
                element,
                "no longer copies the color channels in order",
            );
        }
        return lane;
    });
    const colorFallbackValue = unwrapPin(colorConditional.whenFalse);
    if (
        colorLanes.length !== 3 ||
        !ts.isArrayLiteralExpression(colorFallbackValue) ||
        colorFallbackValue.elements.length !== 3
    ) {
        refuseNode(
            symbol,
            punctualFile,
            colorConditional,
            "no longer carries a three-channel color default",
        );
    }
    const colorFallback = colorFallbackValue.elements.map((element) =>
        floatLiteral(
            signedNumericValue(symbol, punctualFile, element),
        )
    );
    const colorName = (() => {
        const declaration = collectNodes(
            applyAsset.body,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapPin(node.initializer!) === colorConditional,
        )[0];
        return declaration && ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
    })();
    // intensity: def.intensity ?? 1, feeding every factory call.
    const intensityDefaults = collectNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            propertyKeyOn(node.left) !== undefined &&
            propertyKeyOn(node.left) !== "spot" &&
            !ts.isPropertyAccessChain(unwrapPin(node.left)),
    );
    if (intensityDefaults.length !== 1) {
        refuseModule(
            symbol,
            "no longer coalesces exactly the intensity default",
        );
    }
    const intensityKey = propertyKeyOn(intensityDefaults[0]!.left)!;
    const intensityValue = pinnedConstantValue(
        symbol,
        punctualFile,
        intensityDefaults[0]!.right,
    );
    const intensityName = (() => {
        const declaration = collectNodes(
            applyAsset.body,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapPin(node.initializer!) === intensityDefaults[0],
        )[0];
        return declaration && ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
    })();
    // range: def.range !== undefined ? def.range : Number.MAX_VALUE.
    const rangeConditional = defaultConditional(
        (node) => {
            const condition = unwrapPin(node.condition);
            return ts.isBinaryExpression(condition) &&
                condition.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken &&
                propertyKeyOn(condition.left) !== undefined &&
                identifierText(condition.right) === "undefined";
        },
        "no longer defaults the light range behind a presence test",
    );
    const rangeKey = propertyKeyOn(
        (unwrapPin(rangeConditional.condition) as ts.BinaryExpression)
            .left,
    )!;
    const rangeFallback = unwrapPin(rangeConditional.whenFalse);
    const rangeIsDoubleMax = ts.isPropertyAccessExpression(rangeFallback) &&
        identifierText(rangeFallback.expression) === "Number" &&
        rangeFallback.name.text === "MAX_VALUE";
    if (
        propertyKeyOn(rangeConditional.whenTrue) !== rangeKey ||
        !rangeIsDoubleMax
    ) {
        refuseNode(
            symbol,
            punctualFile,
            rangeConditional,
            "no longer keeps the authored range with a MAX_VALUE default",
        );
    }
    const rangeName = (() => {
        const declaration = collectNodes(
            applyAsset.body,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapPin(node.initializer!) === rangeConditional,
        )[0];
        return declaration && ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
    })();
    // Every branch writes diffuse and specular from the color; range
    // reaches point and spot but must stay off the directional light,
    // and the intensity feeds every factory call.
    for (const branch of branches) {
        for (const property of ["diffuse", "specular"]) {
            const written = colorName !== undefined &&
                collectNodes(
                    branch.block,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isPropertyAccessExpression(
                            unwrapPin(node.left),
                        ) &&
                        (
                            unwrapPin(
                                node.left,
                            ) as ts.PropertyAccessExpression
                        ).name.text === property &&
                        identifierText(node.right) === colorName,
                ).length === 1;
            if (!written) {
                refuseModule(
                    symbol,
                    `no longer writes the ${property} color on ` +
                        `'${branch.value}' lights`,
                );
            }
        }
        const writesRange = rangeName !== undefined &&
            collectNodes(
                branch.block,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(
                        unwrapPin(node.left),
                    ) &&
                    (unwrapPin(node.left) as ts.PropertyAccessExpression)
                            .name.text === "range" &&
                    identifierText(node.right) === rangeName,
            ).length > 0;
        const directional =
            lightFactoryByPin[branch.value] === "createDirectionalLight";
        if (writesRange === directional) {
            refuseModule(
                symbol,
                directional
                    ? "now ranges directional lights, which the record " +
                        "does not carry"
                    : `no longer ranges '${branch.value}' lights`,
            );
        }
        const factoryCall = collectNodes(
            branch.block,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                identifierText(node.expression) ===
                    lightFactoryByPin[branch.value],
        )[0]!;
        const lastArgument =
            factoryCall.arguments[factoryCall.arguments.length - 1];
        if (
            intensityName === undefined ||
            lastArgument === undefined ||
            identifierText(lastArgument) !== intensityName
        ) {
            refuseModule(
                symbol,
                `no longer passes the defaulted intensity to ` +
                    `'${branch.value}' lights`,
            );
        }
    }
    // The spot cone: def.spot?.outerConeAngle ?? Math.PI / 4, doubled
    // into the factory and halved inside the pinned light's cosine.
    const spotDefaults = collectNodes(
        spotBranch.block,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            ts.isPropertyAccessChain(unwrapPin(node.left)),
    );
    if (spotDefaults.length !== 1) {
        refuseModule(
            symbol,
            "no longer coalesces exactly the outer cone default",
        );
    }
    const outerRead = unwrapPin(
        spotDefaults[0]!.left,
    ) as ts.PropertyAccessChain;
    const outerKey = outerRead.name.text;
    const spotRead = unwrapPin(outerRead.expression);
    const spotKey = (ts.isPropertyAccessExpression(spotRead) ||
            ts.isPropertyAccessChain(spotRead)) &&
            identifierText(spotRead.expression) === definitionName
        ? spotRead.name.text
        : undefined;
    if (spotKey === undefined) {
        refuseNode(
            symbol,
            punctualFile,
            spotDefaults[0]!,
            "no longer reads the outer cone through the spot object",
        );
    }
    const outerValue = pinnedConstantValue(
        symbol,
        punctualFile,
        spotDefaults[0]!.right,
    );
    const outerName = (() => {
        const declaration = collectNodes(
            spotBranch.block,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapPin(node.initializer!) === spotDefaults[0],
        )[0];
        return declaration && ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
    })();
    const spotCall = collectNodes(
        spotBranch.block,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === "createSpotLight",
    )[0]!;
    const angleArgument = spotCall.arguments.length === 5
        ? unwrapPin(spotCall.arguments[2]!)
        : undefined;
    const outerScale = angleArgument !== undefined &&
            ts.isBinaryExpression(angleArgument) &&
            angleArgument.operatorToken.kind ===
                ts.SyntaxKind.AsteriskToken &&
            outerName !== undefined &&
            identifierText(angleArgument.left) === outerName &&
            ts.isNumericLiteral(unwrapPin(angleArgument.right))
        ? Number(
            (unwrapPin(angleArgument.right) as ts.NumericLiteral).text,
        )
        : undefined;
    if (outerScale === undefined) {
        refuseNode(
            symbol,
            punctualFile,
            spotCall,
            "no longer passes the doubled outer cone to the spot factory",
        );
    }
    const exponentArgument = unwrapPin(spotCall.arguments[3]!);
    if (
        !ts.isNumericLiteral(exponentArgument) ||
        Number(exponentArgument.text) !== 1
    ) {
        refuseNode(
            symbol,
            punctualFile,
            spotCall,
            "no longer passes a unit falloff exponent, which the record " +
                "does not carry",
        );
    }
    // The pinned spot light stores Math.cos(angle * 0.5).
    const spotFactory = topLevelFunction(spotFile, "createSpotLight");
    const spotParameters = identifierParameters(
        "createSpotLight",
        spotFile,
        spotFactory,
    );
    if (spotParameters.length < 3) {
        refuseNode(
            "createSpotLight",
            spotFile,
            spotFactory,
            "no longer takes the full cone angle third",
        );
    }
    const angleName = spotParameters[2]!;
    const halfFactors = collectNodes(
        spotFactory,
        (node): node is ts.CallExpression =>
            mathCall(node as ts.Expression, "cos") !== undefined,
    )
        .map((call) => {
            const argument = call.arguments.length === 1
                ? unwrapPin(call.arguments[0]!)
                : undefined;
            return argument !== undefined &&
                    ts.isBinaryExpression(argument) &&
                    argument.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskToken &&
                    identifierText(argument.left) === angleName &&
                    ts.isNumericLiteral(unwrapPin(argument.right))
                ? Number(
                    (
                        unwrapPin(argument.right) as ts.NumericLiteral
                    ).text,
                )
                : undefined;
        })
        .filter((factor): factor is number => factor !== undefined);
    if (halfFactors.length === 0) {
        refuseNode(
            "createSpotLight",
            spotFile,
            spotFactory,
            "no longer stores the cosine of the scaled cone angle",
        );
    }
    if (halfFactors.some((factor) => outerScale * factor !== 1)) {
        refuseNode(
            "createSpotLight",
            spotFile,
            spotFactory,
            "no longer cancels the full-cone doubling against the " +
                "half-angle cosine",
        );
    }
    // The baked world-transform branch: position lanes 12..14 and the
    // negated forward lanes 8..10, in order.
    const worldDeclaration = collectNodes(
        applyAsset.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            ts.isCallExpression(unwrapPin(node.initializer!)) &&
            identifierText(
                (unwrapPin(node.initializer!) as ts.CallExpression)
                    .expression,
            ) === "computeNodeWorldMatrix",
    )[0];
    if (!worldDeclaration) {
        refuseModule(
            symbol,
            "no longer bakes the node world through computeNodeWorldMatrix",
        );
    }
    const worldName = (worldDeclaration.name as ts.Identifier).text;
    const worldLane = (expression: ts.Expression): number | undefined => {
        const read = unwrapPin(expression);
        return ts.isElementAccessExpression(read) &&
                identifierText(read.expression) === worldName &&
                ts.isNumericLiteral(unwrapPin(read.argumentExpression))
            ? Number(
                (
                    unwrapPin(
                        read.argumentExpression,
                    ) as ts.NumericLiteral
                ).text,
            )
            : undefined;
    };
    const positionLanes = collectNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(unwrapPin(node.left)) &&
            worldLane(node.right) !== undefined,
    ).map((assignment) => worldLane(assignment.right)!);
    const forwardDeclarations = collectNodes(
        applyAsset.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            (() => {
                const value = unwrapPin(node.initializer!);
                return ts.isPrefixUnaryExpression(value) &&
                    value.operator === ts.SyntaxKind.MinusToken &&
                    worldLane(value.operand) !== undefined;
            })(),
    );
    const forwardLanes = forwardDeclarations.map((declaration) =>
        worldLane(
            (
                unwrapPin(
                    declaration.initializer!,
                ) as ts.PrefixUnaryExpression
            ).operand,
        )!
    );
    if (
        positionLanes.join(",") !== "12,13,14" ||
        forwardLanes.join(",") !== "8,9,10"
    ) {
        refuseModule(
            symbol,
            "no longer bakes the position column and negated forward " +
                "the lowered way",
        );
    }
    const forwardNames = forwardDeclarations.map(
        (declaration) => (declaration.name as ts.Identifier).text,
    );
    const lengthDeclaration = collectNodes(
        applyAsset.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            (() => {
                const value = unwrapPin(node.initializer!);
                return ts.isBinaryExpression(value) &&
                    value.operatorToken.kind ===
                        ts.SyntaxKind.BarBarToken &&
                    mathCall(value.left, "hypot") !== undefined;
            })(),
    )[0];
    const hypotArguments = lengthDeclaration
        ? mathCall(
            (
                unwrapPin(
                    lengthDeclaration.initializer!,
                ) as ts.BinaryExpression
            ).left,
            "hypot",
        )!.arguments.map((argument) => identifierText(argument))
        : undefined;
    if (
        !hypotArguments ||
        hypotArguments.join(",") !== forwardNames.join(",")
    ) {
        // The record normalizes through the loader's shared helper; the
        // pin's defensive `|| 1` shape is required so the translation
        // stays the one documented in the round-3 notes.
        refuseModule(
            symbol,
            "no longer normalizes the baked forward defensively",
        );
    }
    // The emitted signs fold the pin's RH→LH root into the record's
    // glTF-space worlds: emitted = pin sign × root diagonal lane sign.
    const flip = pinnedRootFlip(parserFile);
    const laneSign = (row: number, pinSign: number): string => {
        const folded = pinSign * (row === flip.lane ? flip.sign : 1);
        return folded < 0 ? "-" : "";
    };
    const spotDefaultLiteral = floatLiteral(outerValue);
    const kindOf = (index: number): string =>
        lightKindByPin[branches[index]!.value]!;
    return [
        "                const std::string type =",
        `                    string_or(definition, "${typeKey}");`,
        "                if (",
        `                    type != "${branches[0]!.value}" &&`,
        `                    type != "${branches[1]!.value}" &&`,
        `                    type != "${branches[2]!.value}") {`,
        "                    continue;",
        "                }",
        "                const Matrix& light_world =",
        "                    compute_world(node_index);",
        "                LightRecord light;",
        `                light.kind = type == "${branches[0]!.value}"`,
        `                    ? ${kindOf(0)}`,
        `                    : type == "${branches[2]!.value}"`,
        `                        ? ${kindOf(2)}`,
        `                        : ${kindOf(1)};`,
        `                if (type == "${spotBranch.value}") {`,
        "                    // createSpotLight(position, direction, outer * 2, 1,",
        "                    // intensity): the pinned loader passes twice the outer",
        "                    // cone angle as the full cone, and the light stores",
        "                    // cos(angle / 2). innerConeAngle is read by neither the",
        "                    // pinned light nor its pointer handlers.",
        "                    const ts::JsonValue* spot_value =",
        `                        optional(definition, "${spotKey}");`,
        "                    const float outer_cone_angle = spot_value",
        "                        ? float_or(",
        "                              spot_value->as_object(),",
        `                              "${outerKey}",`,
        `                              ${spotDefaultLiteral})`,
        `                        : ${spotDefaultLiteral};`,
        "                    light.cos_half_angle =",
        "                        std::cos(outer_cone_angle);",
        "                }",
        "                light.position = Vec3{",
        `                    ${laneSign(0, 1)}light_world[` +
        `${positionLanes[0]}],`,
        `                    ${laneSign(1, 1)}light_world[` +
        `${positionLanes[1]}],`,
        `                    ${laneSign(2, 1)}light_world[` +
        `${positionLanes[2]}],`,
        "                };",
        "                const Vec3 forward{",
        `                    ${laneSign(0, -1)}light_world[` +
        `${forwardLanes[0]}],`,
        `                    ${laneSign(1, -1)}light_world[` +
        `${forwardLanes[1]}],`,
        `                    ${laneSign(2, -1)}light_world[` +
        `${forwardLanes[2]}],`,
        "                };",
        "                light.direction =",
        "                    normalize(forward);",
        "                const std::vector<float> color =",
        "                    float_array(",
        "                        optional(",
        "                            definition,",
        `                            "${colorKey}"));`,
        `                light.diffuse_color = color.size() == ` +
        `${colorLanes.length}`,
        "                    ? Color3{",
        `                          color[${colorLanes[0]}],`,
        `                          color[${colorLanes[1]}],`,
        `                          color[${colorLanes[2]}],`,
        "                      }",
        `                    : Color3{${colorFallback.join(", ")}};`,
        "                light.specular_color =",
        "                    light.diffuse_color;",
        "                light.intensity =",
        "                    float_or(",
        "                        definition,",
        `                        "${intensityKey}",`,
        `                        ${floatLiteral(intensityValue)});`,
        "                light.range =",
        "                    float_or(",
        "                        definition,",
        `                        "${rangeKey}",`,
        "                        std::numeric_limits<float>::max());",
    ].join("\n");
}

/*
 * ──────────────────── round-4 loader leaves ────────────────────
 *
 * The final float defaults of the material build, lowered from the
 * pinned modules that substitute them. Same contract: keys and
 * constants flow, shapes the walk cannot carry refuse, and a numeric
 * default the pin adds that no entry consumes refuses.
 *
 * Three absent-arm asymmetries, documented once here:
 *
 *   - `baseColorFactor`'s absent arm is the native record default
 *     (`runtime.hpp` `MaterialRecord.base_color_factor{1,1,1,1}`), which
 *     this emitter cannot regenerate — so the pinned `?? [1, 1, 1, 1]`
 *     is verified and a moved default refuses instead of flowing. The
 *     emissive seed, by contrast, is written by the template itself, so
 *     the pinned `?? [0, 0, 0]` flows into the emitted `Color3`.
 *
 *   - The KHR_texture_transform identity lives twice in the pin: the
 *     pinned `wrapTexture` patches only the declared fields (a truthy
 *     guard, so an authored rotation 0 and an absent rotation are the
 *     same value), and every pinned writer reads `tex?.uAng ?? 0`,
 *     `?? 1` for the scales. The record compresses both into load-time
 *     defaults: `float_or(transform, "rotation", 0)` here and the
 *     native `TextureTransform{1, 1, 0, 0, 0}` construction
 *     (`runtime.hpp`) for the wholly absent transform. The writer's
 *     five identity constants are therefore verified against that
 *     record identity, and any moved one refuses — flowing rotation
 *     alone would leave the native absent-arm silently wrong.
 *
 *   - `doubleSided`'s absent arm is the pin's `!!mat.doubleSided`
 *     (undefined coerces to false); the record's `bool_or(..., false)`
 *     is that same coercion, so only the key flows.
 */

/** `typeof e?.key === "number" ? e.key : fallback` → key and fallback. */
function typeofNumberDefault(
    expression: ts.Expression,
): { key: string; value: number } | undefined {
    const conditional = unwrapPin(expression);
    if (!ts.isConditionalExpression(conditional)) return undefined;
    const condition = unwrapPin(conditional.condition);
    if (
        !ts.isBinaryExpression(condition) ||
        condition.operatorToken.kind !==
            ts.SyntaxKind.EqualsEqualsEqualsToken ||
        !ts.isTypeOfExpression(unwrapPin(condition.left)) ||
        !ts.isStringLiteral(unwrapPin(condition.right)) ||
        (unwrapPin(condition.right) as ts.StringLiteral).text !== "number"
    ) {
        return undefined;
    }
    const typeofRead = unwrapPin(
        (unwrapPin(condition.left) as ts.TypeOfExpression).expression,
    );
    if (
        !ts.isPropertyAccessExpression(typeofRead) &&
        !ts.isPropertyAccessChain(typeofRead)
    ) {
        return undefined;
    }
    const whenTrue = unwrapPin(conditional.whenTrue);
    const readsKey = (ts.isPropertyAccessExpression(whenTrue) ||
        ts.isPropertyAccessChain(whenTrue)) &&
        whenTrue.name.text === typeofRead.name.text;
    const whenFalse = unwrapPin(conditional.whenFalse);
    if (!readsKey || !ts.isNumericLiteral(whenFalse)) return undefined;
    return {
        key: typeofRead.name.text,
        value: Number(whenFalse.text),
    };
}

/** Renders a pinned numeric array as the record's `Color3{…}` literal. */
function pinnedColor3(
    symbol: string,
    file: ts.SourceFile,
    elements: readonly ts.Expression[],
): string {
    if (elements.length !== 3) {
        refuseModule(symbol, "no longer defaults a three-lane color");
    }
    const lanes = elements.map((element) =>
        floatLiteral(signedNumericValue(symbol, file, element))
    );
    return `Color3{${lanes.join(", ")}}`;
}

/**
 * The core-material defaults of the pinned `assembleMaterial`
 * (`gltf-material.ts`): every numeric, array or string default in its
 * return object must be consumed by a named entry below, so a default
 * the pin adds refuses generation.
 */
function assembleMaterialDefaults(file: ts.SourceFile): {
    baseColorFactorKey: string;
    metallicFactor: GltfLoweredDefault;
    roughnessFactor: GltfLoweredDefault;
    emissiveFactor: { key: string; identity: string };
    normalScale: GltfLoweredDefault;
    occlusionTexCoord: GltfLoweredDefault;
    alphaMode: { key: string; literal: string };
    doubleSidedKey: string;
    alphaCutoff: GltfLoweredDefault;
} {
    const symbol = "assembleMaterial";
    const declaration = topLevelFunction(file, symbol);
    const returns = collectNodes(
        declaration,
        (node): node is ts.ReturnStatement =>
            ts.isReturnStatement(node) &&
            node.expression !== undefined &&
            ts.isObjectLiteralExpression(unwrapPin(node.expression)),
    );
    if (returns.length !== 1) {
        refuseModule(
            symbol,
            "no longer returns a single material-data object",
        );
    }
    const properties = new Map<string, ts.Expression>();
    for (const property of (
        unwrapPin(returns[0]!.expression!) as ts.ObjectLiteralExpression
    ).properties) {
        if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name)
        ) {
            properties.set(property.name.text, property.initializer);
        }
    }
    const consumed = new Set<string>();
    const initializerOf = (property: string): ts.Expression => {
        const initializer = properties.get(property);
        if (!initializer) {
            refuseModule(
                symbol,
                `no longer assembles '${property}'`,
            );
        }
        consumed.add(property);
        return initializer;
    };
    const numericCoalesce = (property: string): GltfLoweredDefault => {
        const coalesced = coalescedPropertyDefault(
            initializerOf(property),
        );
        const fallback = coalesced
            ? unwrapPin(coalesced.fallback)
            : undefined;
        if (!coalesced || !fallback || !ts.isNumericLiteral(fallback)) {
            refuseModule(
                symbol,
                `no longer defaults '${property}' to a constant`,
            );
        }
        return {
            key: coalesced.key,
            literal: floatLiteral(Number(fallback.text)),
        };
    };
    const arrayCoalesce = (
        property: string,
    ): { key: string; elements: readonly ts.Expression[] } => {
        const coalesced = coalescedPropertyDefault(
            initializerOf(property),
        );
        const fallback = coalesced
            ? unwrapPin(coalesced.fallback)
            : undefined;
        if (
            !coalesced ||
            !fallback ||
            !ts.isArrayLiteralExpression(fallback)
        ) {
            refuseModule(
                symbol,
                `no longer defaults '${property}' to an array constant`,
            );
        }
        return { key: coalesced.key, elements: fallback.elements };
    };
    // baseColor: the absent arm is the record's native Color4{1,1,1,1}.
    const baseColor = arrayCoalesce("_baseColorFactor");
    const baseColorValues = baseColor.elements.map((element) =>
        signedNumericValue(symbol, file, element)
    );
    if (baseColorValues.join(",") !== "1,1,1,1") {
        refuseModule(
            symbol,
            "no longer defaults the base color factor to the " +
                "record's native {1,1,1,1}",
        );
    }
    const emissive = arrayCoalesce("_emissiveFactor");
    const metallicFactor = numericCoalesce("_metallicFactor");
    const roughnessFactor = numericCoalesce("_roughnessFactor");
    const alphaCutoff = numericCoalesce("_alphaCutoff");
    // normalTexture.scale and occlusionTexture.texCoord use the pin's
    // typeof-number substitution instead of `??`.
    const typeofDefault = (
        property: string,
    ): { key: string; value: number } => {
        const parsed = typeofNumberDefault(initializerOf(property));
        if (!parsed) {
            refuseModule(
                symbol,
                `no longer substitutes '${property}' behind a ` +
                    "typeof-number test",
            );
        }
        return parsed;
    };
    const normalScale = typeofDefault("_normalScale");
    const occlusionTexCoord = typeofDefault("_occlusionTexCoord");
    if (
        !Number.isInteger(occlusionTexCoord.value) ||
        occlusionTexCoord.value < 0
    ) {
        refuseModule(
            symbol,
            "no longer defaults the occlusion texCoord to an " +
                "unsigned integer",
        );
    }
    // alphaMode: a string coalesce; the mode names it is compared to
    // stay template plumbing.
    const alphaModeCoalesced = coalescedPropertyDefault(
        initializerOf("_alphaMode"),
    );
    const alphaModeFallback = alphaModeCoalesced
        ? unwrapPin(alphaModeCoalesced.fallback)
        : undefined;
    if (
        !alphaModeCoalesced ||
        !alphaModeFallback ||
        !ts.isStringLiteral(alphaModeFallback)
    ) {
        refuseModule(
            symbol,
            "no longer defaults '_alphaMode' to a string constant",
        );
    }
    // doubleSided: `!!mat.doubleSided` — the bool_or(false) coercion.
    const doubleSided = unwrapPin(initializerOf("_doubleSided"));
    const doubleSidedInner = ts.isPrefixUnaryExpression(doubleSided) &&
            doubleSided.operator === ts.SyntaxKind.ExclamationToken
        ? unwrapPin(doubleSided.operand)
        : undefined;
    const doubleSidedRead = doubleSidedInner &&
            ts.isPrefixUnaryExpression(doubleSidedInner) &&
            doubleSidedInner.operator === ts.SyntaxKind.ExclamationToken
        ? unwrapPin(doubleSidedInner.operand)
        : undefined;
    if (
        !doubleSidedRead ||
        !(ts.isPropertyAccessExpression(doubleSidedRead) ||
            ts.isPropertyAccessChain(doubleSidedRead))
    ) {
        refuseModule(
            symbol,
            "no longer coerces '_doubleSided' from the JSON flag",
        );
    }
    // Any OTHER default the pin assembles must refuse.
    for (const [property, initializer] of properties) {
        if (consumed.has(property)) continue;
        const coalesced = coalescedPropertyDefault(initializer);
        const fallback = coalesced
            ? unwrapPin(coalesced.fallback)
            : undefined;
        const carriesDefault = (fallback !== undefined &&
            (ts.isNumericLiteral(fallback) ||
                ts.isArrayLiteralExpression(fallback) ||
                ts.isStringLiteral(fallback))) ||
            typeofNumberDefault(initializer) !== undefined;
        if (carriesDefault) {
            refuseModule(
                symbol,
                `defaults '${property}', which no lowering entry consumes`,
            );
        }
    }
    return {
        baseColorFactorKey: baseColor.key,
        metallicFactor,
        roughnessFactor,
        emissiveFactor: {
            key: emissive.key,
            identity: pinnedColor3(symbol, file, emissive.elements),
        },
        normalScale: {
            key: normalScale.key,
            literal: floatLiteral(normalScale.value),
        },
        occlusionTexCoord: {
            key: occlusionTexCoord.key,
            literal: String(occlusionTexCoord.value),
        },
        alphaMode: {
            key: alphaModeCoalesced.key,
            literal: alphaModeFallback.text,
        },
        doubleSidedKey: doubleSidedRead.name.text,
        alphaCutoff,
    };
}

/**
 * KHR_materials_specular's factor treatment
 * (`gltf-ext-dielectric.ts`): a declared factor within `epsilon` of
 * `clear` drops both reflectance options — the record clears the
 * folded IOR factor back to one on that same test.
 */
function dielectricSpecularDefault(file: ts.SourceFile): {
    key: string;
    clear: string;
    epsilon: string;
} {
    const symbol = "KHR_materials_dielectric";
    const applyMaterial = featureMethod(file, symbol, "applyMaterial");
    const key = "specularFactor";
    const comparisons: { clear: number; epsilon: number }[] = [];
    const visit = (node: ts.Node): void => {
        ts.forEachChild(node, visit);
        if (
            !ts.isBinaryExpression(node) ||
            node.operatorToken.kind !== ts.SyntaxKind.GreaterThanToken
        ) {
            return;
        }
        const call = unwrapPin(node.left);
        if (
            !ts.isCallExpression(call) ||
            !ts.isPropertyAccessExpression(call.expression) ||
            identifierText(call.expression.expression) !== "Math" ||
            call.expression.name.text !== "abs" ||
            call.arguments.length !== 1
        ) {
            return;
        }
        const difference = unwrapPin(call.arguments[0]!);
        if (
            !ts.isBinaryExpression(difference) ||
            difference.operatorToken.kind !== ts.SyntaxKind.MinusToken
        ) {
            return;
        }
        const read = unwrapPin(difference.left);
        const readKey = (ts.isPropertyAccessExpression(read) ||
                ts.isPropertyAccessChain(read))
            ? read.name.text
            : undefined;
        if (readKey !== key) return;
        const clear = unwrapPin(difference.right);
        const epsilon = unwrapPin(node.right);
        if (!ts.isNumericLiteral(clear) || !ts.isNumericLiteral(epsilon)) {
            refuseNode(
                symbol,
                file,
                node,
                "no longer compares the specular factor against constants",
            );
        }
        comparisons.push({
            clear: Number(clear.text),
            epsilon: Number(epsilon.text),
        });
    };
    visit(applyMaterial.body);
    const first = comparisons[0];
    if (!first) {
        refuseModule(
            symbol,
            "no longer tests the specular factor against its clearing value",
        );
    }
    for (const comparison of comparisons) {
        if (
            comparison.clear !== first.clear ||
            comparison.epsilon !== first.epsilon
        ) {
            refuseModule(
                symbol,
                "no longer agrees with itself on the specular clearing test",
            );
        }
    }
    // The paired arms: within epsilon both options drop (the record's
    // clear-to-one), beyond it the factor feeds f0Factor AND the weight.
    const pairedIfs = collectNodes(
        applyMaterial.body,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            node.elseStatement !== undefined &&
            ts.isBinaryExpression(unwrapPin(node.expression)) &&
            unwrapPin(node.expression).getText(file).includes(key),
    );
    const paired = pairedIfs.find((candidate) => {
        const assigns = collectNodes(
            candidate.thenStatement,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken,
        ).map((assignment) =>
            unwrapPin(assignment.left).getText(file).split(".").pop()
        );
        const deletes = collectNodes(
            candidate.elseStatement!,
            (node): node is ts.DeleteExpression =>
                ts.isDeleteExpression(node),
        ).map((expression) =>
            unwrapPin(expression.expression).getText(file).split(".").pop()
        );
        return assigns.includes("f0Factor") &&
            assigns.includes("specularWeight") &&
            deletes.includes("f0Factor") &&
            deletes.includes("specularWeight");
    });
    if (!paired) {
        refuseModule(
            symbol,
            "no longer pairs the factor assignment with the " +
                "within-epsilon drop",
        );
    }
    return {
        key,
        clear: floatLiteral(first.clear),
        epsilon: floatLiteral(first.epsilon),
    };
}

/**
 * The IOR-to-F0 fold (`gltf-ext-dielectric.ts`):
 * `reflOpts.f0Factor = ((ior - 1) / (ior + 1)) ** 2 / 0.04`. The
 * squaring is the template's `ratio * ratio` shape, so an exponent
 * that stops being two refuses; the unit and the base reflectance
 * flow into the emitted fold and its undo.
 */
function dielectricIorFold(file: ts.SourceFile): {
    one: string;
    baseReflectance: string;
} {
    const symbol = "KHR_materials_dielectric";
    const applyMaterial = featureMethod(file, symbol, "applyMaterial");
    const folds = collectNodes(
        applyMaterial.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            pinnedPropertyPath(node.left)?.join(".") ===
                "reflOpts.f0Factor" &&
            ts.isBinaryExpression(unwrapPin(node.right)) &&
            (unwrapPin(node.right) as ts.BinaryExpression)
                    .operatorToken.kind ===
                ts.SyntaxKind.SlashToken,
    );
    if (folds.length !== 1) {
        refuseModule(
            symbol,
            "no longer computes the IOR fold in a single assignment",
        );
    }
    const division = unwrapPin(folds[0]!.right) as ts.BinaryExpression;
    const base = unwrapPin(division.right);
    if (!ts.isNumericLiteral(base)) {
        refuseNode(
            symbol,
            file,
            division,
            "no longer divides the fold by a constant base reflectance",
        );
    }
    const power = unwrapPin(division.left);
    if (
        !ts.isBinaryExpression(power) ||
        power.operatorToken.kind !==
            ts.SyntaxKind.AsteriskAsteriskToken ||
        signedNumericValue(symbol, file, power.right) !== 2
    ) {
        refuseNode(
            symbol,
            file,
            division,
            "no longer squares the IOR ratio",
        );
    }
    const ratio = unwrapPin(power.left);
    if (
        !ts.isBinaryExpression(ratio) ||
        ratio.operatorToken.kind !== ts.SyntaxKind.SlashToken
    ) {
        refuseNode(symbol, file, power, "no longer folds an IOR ratio");
    }
    const numerator = unwrapPin(ratio.left);
    const denominator = unwrapPin(ratio.right);
    if (
        !ts.isBinaryExpression(numerator) ||
        numerator.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
        !ts.isBinaryExpression(denominator) ||
        denominator.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
        identifierText(numerator.left) === undefined ||
        identifierText(numerator.left) !==
            identifierText(denominator.left)
    ) {
        refuseNode(
            symbol,
            file,
            ratio,
            "no longer folds (ior - one) over (ior + one)",
        );
    }
    const one = signedNumericValue(symbol, file, numerator.right);
    if (one !== signedNumericValue(symbol, file, denominator.right)) {
        refuseModule(
            symbol,
            "no longer folds the IOR ratio around a single unit",
        );
    }
    return {
        one: floatLiteral(one),
        baseReflectance: floatLiteral(Number(base.text)),
    };
}

/**
 * The dielectric tint gate (`gltf-ext-dielectric.ts`): both pinned
 * sites test `specularColorFactor.length === 3` and compare lanes
 * 0..2 against one — the record's `!= 1.0f` triple. The unit and the
 * lane count flow; sites that disagree, a moved lane set, or a lane
 * count the record's three-lane `Color3` cannot store refuse.
 */
function dielectricSpecularColor(file: ts.SourceFile): {
    key: string;
    length: string;
    unit: string;
} {
    const symbol = "KHR_materials_dielectric";
    const applyMaterial = featureMethod(file, symbol, "applyMaterial");
    const key = "specularColorFactor";
    // Locals declared as reads of the factor (`specColFactor`).
    const aliases = new Set<string>();
    for (const binding of collectNodes(
        applyMaterial.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            ts.isIdentifier(node.name),
    )) {
        const read = unwrapPin(binding.initializer!);
        if (
            (ts.isPropertyAccessExpression(read) ||
                ts.isPropertyAccessChain(read)) &&
            read.name.text === key
        ) {
            aliases.add((binding.name as ts.Identifier).text);
        }
    }
    const readsFactor = (expression: ts.Expression): boolean => {
        const node = unwrapPin(expression);
        if (
            (ts.isPropertyAccessExpression(node) ||
                ts.isPropertyAccessChain(node)) &&
            node.name.text === key
        ) {
            return true;
        }
        return ts.isIdentifier(node) && aliases.has(node.text);
    };
    const laneCounts = new Map<number, number>();
    const units: number[] = [];
    const lengths: number[] = [];
    const visit = (node: ts.Node): void => {
        ts.forEachChild(node, visit);
        if (!ts.isBinaryExpression(node)) return;
        if (
            node.operatorToken.kind ===
                ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
            const lane = unwrapPin(node.left);
            if (
                !ts.isElementAccessExpression(lane) ||
                !readsFactor(lane.expression)
            ) {
                return;
            }
            const index = signedNumericValue(
                symbol,
                file,
                lane.argumentExpression,
            );
            laneCounts.set(index, (laneCounts.get(index) ?? 0) + 1);
            units.push(signedNumericValue(symbol, file, node.right));
            return;
        }
        if (
            node.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken
        ) {
            const read = unwrapPin(node.left);
            if (
                !(ts.isPropertyAccessExpression(read) ||
                    ts.isPropertyAccessChain(read)) ||
                read.name.text !== "length" ||
                !readsFactor(read.expression)
            ) {
                return;
            }
            lengths.push(signedNumericValue(symbol, file, node.right));
        }
    };
    visit(applyMaterial.body);
    const unit = units[0];
    const length = lengths[0];
    if (unit === undefined || length === undefined) {
        refuseModule(
            symbol,
            "no longer gates the dielectric tint on the factor lanes",
        );
    }
    if (units.some((value) => value !== unit)) {
        refuseModule(
            symbol,
            "no longer agrees with itself on the tint unit",
        );
    }
    if (lengths.some((value) => value !== length)) {
        refuseModule(
            symbol,
            "no longer agrees with itself on the tint lane count",
        );
    }
    // The emitted `Color3{[0], [1], [2]}` consumes exactly three lanes.
    if (length !== 3) {
        refuseModule(
            symbol,
            "no longer stores a three-lane tint the record's Color3 " +
                "can carry",
        );
    }
    const perLane = laneCounts.get(0);
    const indices = [...laneCounts.keys()].sort((a, b) => a - b);
    if (
        perLane === undefined ||
        indices.join(",") !== "0,1,2" ||
        [...laneCounts.values()].some((count) => count !== perLane)
    ) {
        refuseModule(
            symbol,
            "no longer compares exactly lanes 0..2 at every tint site",
        );
    }
    return {
        key,
        length: String(length),
        unit: floatLiteral(unit),
    };
}

/**
 * The KHR_texture_transform identity (`gltf-ext-uv-transform.ts` +
 * the pinned writer's `??` defaults in `uv-transform-fragment.ts`),
 * verified against the record's native `TextureTransform` identity —
 * see the round-4 notes above.
 */
function textureTransformDefaults(
    uvTransformFile: ts.SourceFile,
    writerFile: ts.SourceFile,
): { rotation: GltfLoweredDefault; scaleKey: string; offsetKey: string } {
    const symbol = "KHR_texture_transform";
    const wrapTexture = featureMethod(
        uvTransformFile,
        symbol,
        "wrapTexture",
    );
    // The patched fields, by their `patch.<field> = kt.<key>…` writes.
    const patches = new Map<string, ts.Expression>();
    for (const assignment of collectNodes(
        wrapTexture.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(unwrapPin(node.left)) &&
            identifierText(
                (unwrapPin(node.left) as ts.PropertyAccessExpression)
                    .expression,
            ) === "patch",
    )) {
        patches.set(
            (unwrapPin(assignment.left) as ts.PropertyAccessExpression)
                .name.text,
            assignment.right,
        );
    }
    const patchKey = (field: string): string => {
        const value = patches.get(field);
        const read = value ? unwrapPin(value) : undefined;
        // uAng reads `kt.rotation`; uScale reads `kt.scale[0]`.
        const property = read && ts.isElementAccessExpression(read)
            ? unwrapPin(read.expression)
            : read;
        if (
            !property ||
            !(ts.isPropertyAccessExpression(property) ||
                ts.isPropertyAccessChain(property))
        ) {
            refuseModule(
                symbol,
                `no longer patches '${field}' from a transform property`,
            );
        }
        return property.name.text;
    };
    const rotationKey = patchKey("uAng");
    const scaleKey = patchKey("uScale");
    const offsetKey = patchKey("uOffset");
    if (
        patchKey("vScale") !== scaleKey ||
        patchKey("vOffset") !== offsetKey
    ) {
        refuseModule(
            symbol,
            "no longer reads both lanes of scale and offset from " +
                "one transform property each",
        );
    }
    // The writer's identity defaults, against the record's native
    // TextureTransform{1, 1, 0, 0, 0} (runtime.hpp) — a moved identity
    // would leave the record's absent-transform arm silently wrong.
    const writer = topLevelFunction(writerFile, "writeOne");
    const identities = new Map<string, number>();
    for (const binding of collectNodes(
        writer,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined,
    )) {
        const coalesced = coalescedPropertyDefault(binding.initializer!);
        const fallback = coalesced
            ? unwrapPin(coalesced.fallback)
            : undefined;
        if (coalesced && fallback && ts.isNumericLiteral(fallback)) {
            identities.set(coalesced.key, Number(fallback.text));
        }
    }
    const recordIdentity: Readonly<Record<string, number>> = {
        uScale: 1,
        vScale: 1,
        uOffset: 0,
        vOffset: 0,
        uAng: 0,
    };
    for (const [field, expected] of Object.entries(recordIdentity)) {
        if (identities.get(field) !== expected) {
            refuseModule(
                symbol,
                `no longer defaults '${field}' to the record's ` +
                    `TextureTransform identity ${expected} (runtime.hpp)`,
            );
        }
    }
    return {
        rotation: {
            key: rotationKey,
            literal: floatLiteral(identities.get("uAng")!),
        },
        scaleKey,
        offsetKey,
    };
}

function optionInitializer(
    symbol: string,
    options: ts.ObjectLiteralExpression,
    optionName: string,
): ts.Expression {
    for (const property of options.properties) {
        if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === optionName
        ) {
            return property.initializer;
        }
    }
    refuseModule(symbol, `no longer passes the '${optionName}' option`);
}

/** One clearcoat texture-conditioned factor default. */
function clearcoatConditionalDefault(
    symbol: string,
    file: ts.SourceFile,
    options: ts.ObjectLiteralExpression,
    optionName: string,
    expectedTextureKey: string,
): { key: string; present: string; absent: string } {
    const coalesced = coalescedPropertyDefault(
        optionInitializer(symbol, options, optionName),
    );
    const fallback = coalesced ? unwrapPin(coalesced.fallback) : undefined;
    if (!coalesced || !fallback || !ts.isConditionalExpression(fallback)) {
        refuseModule(
            symbol,
            `no longer conditions the '${optionName}' fallback on a texture`,
        );
    }
    const condition = unwrapPin(fallback.condition);
    const textureKey = (ts.isPropertyAccessExpression(condition) ||
            ts.isPropertyAccessChain(condition))
        ? condition.name.text
        : undefined;
    if (textureKey !== expectedTextureKey) {
        refuseNode(
            symbol,
            file,
            fallback,
            `no longer conditions the '${optionName}' fallback on ` +
                `'${expectedTextureKey}'`,
        );
    }
    return {
        key: coalesced.key,
        present: floatLiteral(
            signedNumericValue(symbol, file, fallback.whenTrue),
        ),
        absent: floatLiteral(
            signedNumericValue(symbol, file, fallback.whenFalse),
        ),
    };
}

/** The single-options-object call `calleeName(out, {…})` under `root`. */
function setterOptionsObject(
    symbol: string,
    root: ts.Node,
    calleeName: string,
): ts.ObjectLiteralExpression {
    const calls = collectNodes(
        root,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === calleeName,
    );
    const options = calls.length === 1 && calls[0]!.arguments.length === 2
        ? unwrapPin(calls[0]!.arguments[1]!)
        : undefined;
    if (!options || !ts.isObjectLiteralExpression(options)) {
        refuseModule(
            symbol,
            `no longer passes ${calleeName} one options object`,
        );
    }
    return options;
}

/**
 * The remaining material float defaults, lowered from their pinned
 * modules — see the round-4 notes above for the absent-arm
 * asymmetries and the provenance of every entry.
 */
export function lowerGltfMaterialDefaults(files: {
    material: ts.SourceFile;
    dielectric: ts.SourceFile;
    uvTransform: ts.SourceFile;
    uvTransformWriter: ts.SourceFile;
    clearcoat: ts.SourceFile;
    sheen: ts.SourceFile;
    emissiveStrength: ts.SourceFile;
}): GltfMaterialDefaults {
    const core = assembleMaterialDefaults(files.material);
    const specularFactor = dielectricSpecularDefault(files.dielectric);
    const iorToF0 = dielectricIorFold(files.dielectric);
    const specularColor = dielectricSpecularColor(files.dielectric);
    const textureTransform = textureTransformDefaults(
        files.uvTransform,
        files.uvTransformWriter,
    );
    // Clearcoat: both factors default on their own texture's presence.
    const clearcoatSymbol = "KHR_materials_clearcoat";
    const clearcoatOptions = setterOptionsObject(
        clearcoatSymbol,
        featureMethod(
            files.clearcoat,
            clearcoatSymbol,
            "applyMaterial",
        ).body,
        "setPbrClearCoat",
    );
    const clearcoatIntensity = clearcoatConditionalDefault(
        clearcoatSymbol,
        files.clearcoat,
        clearcoatOptions,
        "intensity",
        "clearcoatTexture",
    );
    const clearcoatRoughness = clearcoatConditionalDefault(
        clearcoatSymbol,
        files.clearcoat,
        clearcoatOptions,
        "roughness",
        "clearcoatRoughnessTexture",
    );
    const bumpScale = coalescedPropertyDefault(
        optionInitializer(
            clearcoatSymbol,
            clearcoatOptions,
            "bumpTextureScale",
        ),
    );
    const bumpFallback = bumpScale
        ? unwrapPin(bumpScale.fallback)
        : undefined;
    if (!bumpScale || !bumpFallback || !ts.isNumericLiteral(bumpFallback)) {
        refuseModule(
            clearcoatSymbol,
            "no longer defaults the clearcoat normal scale to a constant",
        );
    }
    // Sheen: color and roughness defaults plus the fixed intensity.
    const sheenSymbol = "KHR_materials_sheen";
    const sheenOptions = setterOptionsObject(
        sheenSymbol,
        featureMethod(files.sheen, sheenSymbol, "applyMaterial").body,
        "setPbrSheen",
    );
    const sheenColor = coalescedPropertyDefault(
        optionInitializer(sheenSymbol, sheenOptions, "color"),
    );
    const sheenColorFallback = sheenColor
        ? unwrapPin(sheenColor.fallback)
        : undefined;
    if (
        !sheenColor ||
        !sheenColorFallback ||
        !ts.isArrayLiteralExpression(sheenColorFallback)
    ) {
        refuseModule(
            sheenSymbol,
            "no longer defaults the sheen color to an array constant",
        );
    }
    const sheenRoughness = coalescedPropertyDefault(
        optionInitializer(sheenSymbol, sheenOptions, "roughness"),
    );
    const sheenRoughnessFallback = sheenRoughness
        ? unwrapPin(sheenRoughness.fallback)
        : undefined;
    if (
        !sheenRoughness ||
        !sheenRoughnessFallback ||
        !ts.isNumericLiteral(sheenRoughnessFallback)
    ) {
        refuseModule(
            sheenSymbol,
            "no longer defaults the sheen roughness to a constant",
        );
    }
    const sheenIntensity = unwrapPin(
        optionInitializer(sheenSymbol, sheenOptions, "intensity"),
    );
    if (!ts.isNumericLiteral(sheenIntensity)) {
        refuseModule(
            sheenSymbol,
            "no longer fixes the sheen intensity to a constant",
        );
    }
    // Emissive strength: `e.emissiveStrength ?? 1.0`.
    const strengthSymbol = "KHR_materials_emissive_strength";
    const strengthBody = featureMethod(
        files.emissiveStrength,
        strengthSymbol,
        "applyMaterial",
    ).body;
    const strengthDefaults: GltfLoweredDefault[] = [];
    for (const binding of collectNodes(
        strengthBody,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined,
    )) {
        const coalesced = coalescedPropertyDefault(binding.initializer!);
        const fallback = coalesced
            ? unwrapPin(coalesced.fallback)
            : undefined;
        if (coalesced && fallback && ts.isNumericLiteral(fallback)) {
            strengthDefaults.push({
                key: coalesced.key,
                literal: floatLiteral(Number(fallback.text)),
            });
        }
    }
    if (
        strengthDefaults.length !== 1 ||
        strengthDefaults[0]!.key !== "emissiveStrength"
    ) {
        refuseModule(
            strengthSymbol,
            "no longer defaults 'emissiveStrength' exactly once",
        );
    }
    return {
        ...core,
        specularFactor,
        iorToF0,
        specularColor,
        textureTransform,
        clearcoatIntensity,
        clearcoatRoughness,
        clearcoatNormalScale: {
            key: bumpScale.key,
            literal: floatLiteral(Number(bumpFallback.text)),
        },
        sheenColor: {
            key: sheenColor.key,
            identity: pinnedColor3(
                sheenSymbol,
                files.sheen,
                sheenColorFallback.elements,
            ),
        },
        sheenRoughness: {
            key: sheenRoughness.key,
            literal: floatLiteral(Number(sheenRoughnessFallback.text)),
        },
        sheenIntensity: floatLiteral(Number(sheenIntensity.text)),
        emissiveStrength: strengthDefaults[0]!,
    };
}

/** `Math.round(Math.max(lo, Math.min(hi, v)) * scale)` → constants. */
function roundClampScale(
    symbol: string,
    file: ts.SourceFile,
    expression: ts.Expression,
): { lo: number; hi: number; scale: number; value: ts.Expression } {
    const round = mathCall(expression, "round");
    const product = round && round.arguments.length === 1
        ? unwrapPin(round.arguments[0]!)
        : undefined;
    if (
        !product ||
        !ts.isBinaryExpression(product) ||
        product.operatorToken.kind !== ts.SyntaxKind.AsteriskToken
    ) {
        refuseNode(
            symbol,
            file,
            expression,
            "no longer rounds a scaled clamp",
        );
    }
    const scale = signedNumericValue(symbol, file, product.right);
    const max = mathCall(product.left, "max");
    const lo = max && max.arguments.length === 2
        ? signedNumericValue(symbol, file, max.arguments[0]!)
        : undefined;
    const min = max && max.arguments.length === 2
        ? mathCall(max.arguments[1]!, "min")
        : undefined;
    const hi = min && min.arguments.length === 2
        ? signedNumericValue(symbol, file, min.arguments[0]!)
        : undefined;
    if (lo === undefined || hi === undefined) {
        refuseNode(
            symbol,
            file,
            expression,
            "no longer clamps through Math.max over Math.min",
        );
    }
    // `hi` proves the two-argument Math.min exists.
    return { lo, hi, scale, value: min!.arguments[1]! };
}

/** The single four-lane `new U8([…])` texel build under `root`. */
function pinnedTexelBuild(
    symbol: string,
    root: ts.Node,
): readonly ts.Expression[] {
    const builds = collectNodes(
        root,
        (node): node is ts.NewExpression =>
            ts.isNewExpression(node) &&
            identifierText(node.expression) === "U8",
    );
    const lanes = builds.length === 1 &&
            builds[0]!.arguments?.length === 1
        ? unwrapPin(builds[0]!.arguments[0]!)
        : undefined;
    if (
        !lanes ||
        !ts.isArrayLiteralExpression(lanes) ||
        lanes.elements.length !== 4
    ) {
        refuseModule(
            symbol,
            "no longer bakes a single four-lane factor texel",
        );
    }
    return lanes.elements;
}

/**
 * The factor bakes, lowered from the pinned factor-texture module and
 * the pinned sRGB curve: `uploadOrmFactorTexture`'s round-clamp-scale
 * closure and constant opaque lanes, `uploadBaseColorFactorTexture`'s
 * three `linearToSrgbByte` lanes plus the same unorm alpha rounding,
 * and `linearToSrgbByte`'s transfer-curve constants
 * (`src/loader-gltf/gltf-pbr-builder.ts`, `src/math/color.ts`). The
 * emitted helpers quantize record factors exactly as the pin bakes
 * texels — see the emitted comment for the record-side rationale.
 */
export function lowerGltfFactorBake(
    colorFile: ts.SourceFile,
    builderFile: ts.SourceFile,
): GltfFactorBake {
    const symbol = "gltf-pbr-builder";
    // uploadOrmFactorTexture: the clamp closure and the texel lanes.
    const ormUpload = topLevelFunction(
        builderFile,
        "uploadOrmFactorTexture",
    );
    const clampClosures = collectNodes(
        ormUpload.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            ts.isArrowFunction(unwrapPin(node.initializer)),
    );
    const closure = clampClosures.length === 1
        ? unwrapPin(clampClosures[0]!.initializer!) as ts.ArrowFunction
        : undefined;
    if (!closure || ts.isBlock(closure.body)) {
        refuseModule(
            symbol,
            "no longer clamps the ORM factors through one closure",
        );
    }
    const unorm = roundClampScale(symbol, builderFile, closure.body);
    const closureName = ts.isIdentifier(clampClosures[0]!.name)
        ? clampClosures[0]!.name.text
        : undefined;
    const ormLanes = pinnedTexelBuild(symbol, ormUpload.body);
    const opaqueLanes = [ormLanes[0]!, ormLanes[3]!].map((lane) =>
        signedNumericValue(symbol, builderFile, lane)
    );
    if (opaqueLanes[0] !== opaqueLanes[1]) {
        refuseModule(
            symbol,
            "no longer bakes one opaque byte into both ORM guard lanes",
        );
    }
    // Lane order: G is roughness, B is metallic — the record's
    // orm_fallback build maps them by name.
    for (const [lane, parameter] of [
        [ormLanes[1]!, "roughness"],
        [ormLanes[2]!, "metallic"],
    ] as const) {
        const call = unwrapPin(lane);
        if (
            !ts.isCallExpression(call) ||
            identifierText(call.expression) !== closureName ||
            call.arguments.length !== 1 ||
            identifierText(call.arguments[0]!) !== parameter
        ) {
            refuseModule(
                symbol,
                `no longer bakes '${parameter}' through the clamp in ` +
                    "its pinned lane",
            );
        }
    }
    // uploadBaseColorFactorTexture: three sRGB lanes + the unorm alpha.
    const baseUpload = topLevelFunction(
        builderFile,
        "uploadBaseColorFactorTexture",
    );
    const baseLanes = pinnedTexelBuild(symbol, baseUpload.body);
    baseLanes.slice(0, 3).forEach((lane, index) => {
        const call = unwrapPin(lane);
        const argument = ts.isCallExpression(call) &&
                call.arguments.length === 1
            ? unwrapPin(call.arguments[0]!)
            : undefined;
        if (
            !call ||
            !ts.isCallExpression(call) ||
            identifierText(call.expression) !== "linearToSrgbByte" ||
            !argument ||
            !ts.isElementAccessExpression(argument) ||
            signedNumericValue(
                    symbol,
                    builderFile,
                    argument.argumentExpression,
                ) !== index
        ) {
            refuseModule(
                symbol,
                `no longer encodes base-color lane ${index} through ` +
                    "linearToSrgbByte",
            );
        }
    });
    const alpha = roundClampScale(symbol, builderFile, baseLanes[3]!);
    if (
        alpha.lo !== unorm.lo ||
        alpha.hi !== unorm.hi ||
        alpha.scale !== unorm.scale
    ) {
        refuseModule(
            symbol,
            "no longer shares one unorm rounding between the ORM and " +
                "alpha lanes",
        );
    }
    const alphaRead = unwrapPin(alpha.value);
    if (
        !ts.isElementAccessExpression(alphaRead) ||
        signedNumericValue(
                symbol,
                builderFile,
                alphaRead.argumentExpression,
            ) !== 3
    ) {
        refuseModule(
            symbol,
            "no longer bakes the alpha lane from factor lane 3",
        );
    }
    // linearToSrgbByte: the clamp and the IEC transfer curve.
    const srgbSymbol = "linearToSrgbByte";
    const srgb = topLevelFunction(colorFile, srgbSymbol);
    const statements = srgb.body.statements;
    const clampBinding = statements[0] &&
            ts.isVariableStatement(statements[0])
        ? statements[0].declarationList.declarations[0]
        : undefined;
    const clampMax = clampBinding?.initializer
        ? mathCall(clampBinding.initializer, "max")
        : undefined;
    const clampMin = clampMax && clampMax.arguments.length === 2
        ? mathCall(clampMax.arguments[1]!, "min")
        : undefined;
    const clampedName = clampBinding && ts.isIdentifier(clampBinding.name)
        ? clampBinding.name.text
        : undefined;
    if (!clampMax || !clampMin || clampMin.arguments.length !== 2 ||
        clampedName === undefined) {
        refuseModule(
            srgbSymbol,
            "no longer clamps its input through Math.max over Math.min",
        );
    }
    const srgbLo = signedNumericValue(
        srgbSymbol,
        colorFile,
        clampMax.arguments[0]!,
    );
    const srgbHi = signedNumericValue(
        srgbSymbol,
        colorFile,
        clampMin.arguments[0]!,
    );
    const returnStatement = statements[1];
    const round = returnStatement &&
            ts.isReturnStatement(returnStatement) &&
            returnStatement.expression
        ? mathCall(returnStatement.expression, "round")
        : undefined;
    const scaled = round && round.arguments.length === 1
        ? unwrapPin(round.arguments[0]!)
        : undefined;
    if (
        !scaled ||
        !ts.isBinaryExpression(scaled) ||
        scaled.operatorToken.kind !== ts.SyntaxKind.AsteriskToken
    ) {
        refuseModule(
            srgbSymbol,
            "no longer rounds a scaled transfer curve",
        );
    }
    const byteScale = signedNumericValue(
        srgbSymbol,
        colorFile,
        scaled.right,
    );
    const curve = unwrapPin(scaled.left);
    if (!ts.isConditionalExpression(curve)) {
        refuseModule(
            srgbSymbol,
            "no longer forks the transfer curve on a threshold",
        );
    }
    const condition = unwrapPin(curve.condition);
    if (
        !ts.isBinaryExpression(condition) ||
        condition.operatorToken.kind !==
            ts.SyntaxKind.LessThanEqualsToken ||
        identifierText(condition.left) !== clampedName
    ) {
        refuseModule(
            srgbSymbol,
            "no longer tests the clamped value against the threshold",
        );
    }
    const threshold = signedNumericValue(
        srgbSymbol,
        colorFile,
        condition.right,
    );
    const linear = unwrapPin(curve.whenTrue);
    if (
        !ts.isBinaryExpression(linear) ||
        linear.operatorToken.kind !== ts.SyntaxKind.AsteriskToken ||
        identifierText(linear.left) !== clampedName
    ) {
        refuseModule(
            srgbSymbol,
            "no longer scales the linear segment from the clamped value",
        );
    }
    const linearScale = signedNumericValue(
        srgbSymbol,
        colorFile,
        linear.right,
    );
    const gamma = unwrapPin(curve.whenFalse);
    if (
        !ts.isBinaryExpression(gamma) ||
        gamma.operatorToken.kind !== ts.SyntaxKind.MinusToken
    ) {
        refuseModule(
            srgbSymbol,
            "no longer offsets the gamma segment",
        );
    }
    const gammaOffset = signedNumericValue(
        srgbSymbol,
        colorFile,
        gamma.right,
    );
    const gammaProduct = unwrapPin(gamma.left);
    const pow = ts.isBinaryExpression(gammaProduct) &&
            gammaProduct.operatorToken.kind ===
                ts.SyntaxKind.AsteriskToken
        ? mathCall(gammaProduct.right, "pow")
        : undefined;
    const exponent = pow && pow.arguments.length === 2 &&
            identifierText(pow.arguments[0]!) === clampedName
        ? unwrapPin(pow.arguments[1]!)
        : undefined;
    if (
        !pow ||
        !exponent ||
        !ts.isBinaryExpression(exponent) ||
        exponent.operatorToken.kind !== ts.SyntaxKind.SlashToken
    ) {
        refuseModule(
            srgbSymbol,
            "no longer raises the clamped value to a ratio exponent",
        );
    }
    const gammaScale = signedNumericValue(
        srgbSymbol,
        colorFile,
        (gammaProduct as ts.BinaryExpression).left,
    );
    const exponentNumerator = signedNumericValue(
        srgbSymbol,
        colorFile,
        exponent.left,
    );
    const exponentDenominator = signedNumericValue(
        srgbSymbol,
        colorFile,
        exponent.right,
    );
    const helpers = [
        "// Babylon Lite bakes texture-less PBR factors into 1x1 factor",
        "// textures (gltf-pbr-builder uploadBaseColorFactorTexture /",
        "// uploadOrmFactorTexture) and leaves the shader uniforms at their",
        "// defaults, so the browser shades with the 8-bit quantized values.",
        "// Quantize the record factors identically: the native white-fallback",
        "// texture times the quantized uniform reproduces the browser's",
        "// quantized texel times the default uniform bit for bit.",
        "float quantized_unorm_factor(float value) {",
        "    return std::round(",
        `               std::clamp(value, ${floatLiteral(unorm.lo)}, ${
            floatLiteral(unorm.hi)
        }) * ${floatLiteral(unorm.scale)}) /`,
        `        ${floatLiteral(unorm.scale)};`,
        "}",
        "",
        "// The same rounding as a byte, which is what the pinned factor texture holds.",
        "std::uint8_t unorm_byte(float value) {",
        "    return static_cast<std::uint8_t>(",
        `        std::round(std::clamp(value, ${floatLiteral(unorm.lo)}, ${
            floatLiteral(unorm.hi)
        }) * ${floatLiteral(unorm.scale)}));`,
        "}",
        "",
        "std::uint8_t linear_to_srgb_byte(float value) {",
        "    // Pinned linearToSrgbByte: the byte lands in an rgba8unorm-srgb",
        "    // texel whose hardware decode is the browser's effective value.",
        "    const double clamped = std::clamp(",
        "        static_cast<double>(value),",
        `        ${doubleLiteral(srgbLo)},`,
        `        ${doubleLiteral(srgbHi)});`,
        `    const double encoded = clamped <= ${doubleLiteral(threshold)}`,
        `        ? clamped * ${doubleLiteral(linearScale)}`,
        `        : ${doubleLiteral(gammaScale)} * std::pow(clamped, ${
            doubleLiteral(exponentNumerator)
        } / ${doubleLiteral(exponentDenominator)}) - ${
            doubleLiteral(gammaOffset)
        };`,
        "    return static_cast<std::uint8_t>(",
        `        std::round(encoded * ${doubleLiteral(byteScale)}));`,
        "}",
    ].join("\n");
    return {
        helpers,
        unormClampLo: floatLiteral(unorm.lo),
        unormClampHi: floatLiteral(unorm.hi),
        unormScale: floatLiteral(unorm.scale),
        opaqueByte: String(opaqueLanes[0]),
    };
}
