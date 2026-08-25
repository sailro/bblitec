import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import { renderCppExpression } from "./animation-interpolation.js";
import {
    CppExpressionScope,
    identifierParameters,
    refuseNode,
    singleBinding,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

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
 * The two Color3 channel helpers the emitted `pre_scale_harmonics` calls,
 * shared verbatim by every template that interpolates the emission so the
 * helpers and the emission's call sites cannot drift apart.
 */
export const COLOR_CHANNEL_HELPERS_CPP = `float color_channel(
    const Color3& color,
    int channel) {
    return channel == 0
        ? color.r
        : channel == 1
            ? color.g
            : color.b;
}

void set_color_channel(
    Color3& color,
    int channel,
    float value) {
    if (channel == 0) color.r = value;
    else if (channel == 1) color.g = value;
    else color.b = value;
}`;

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
