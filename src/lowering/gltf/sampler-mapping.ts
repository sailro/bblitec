import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import {
    addressModeByPin,
    mipmapModeByPin,
    textureFilterByPin,
} from "../../pinned-address-modes.js";
import {
    cppPrecedence,
    renderCppExpression,
} from "./animation-interpolation.js";
import {
    CppExpressionScope,
    refuseNode,
    singleBinding,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

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
