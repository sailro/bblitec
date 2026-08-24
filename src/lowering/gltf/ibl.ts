import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import { renderCppExpression } from "./animation-interpolation.js";
import {
    CppExpressionScope,
    additiveChainParts,
    coalescedPropertyDefault,
    collectNodes,
    declarationOf,
    featureMethod,
    identifierParameters,
    identifierText,
    isMathPi,
    mathCall,
    pinnedConstantValue,
    pinnedFloatLiteral,
    refuseModule,
    refuseNode,
    signedNumericValue,
    singleBinding,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

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
