import ts from "typescript";
import { doubleLiteral, floatLiteral } from "../../cpp-literals.js";
import { GltfFactorBake } from "../templates/gltf-loader-cpp.js";
import {
    collectNodes,
    identifierText,
    mathCall,
    refuseModule,
    refuseNode,
    signedNumericValue,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

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
        "// Bake the record factors to the same rounded byte, which is what",
        "// the pinned factor texture holds.",
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
