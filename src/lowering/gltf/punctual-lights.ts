import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import {
    findNodes,
    featureMethod,
    identifierParameters,
    identifierText,
    mathCall,
    pinnedNumericValue,
    pinnedRootFlip,
    refuseModule,
    refuseNode,
    topLevelFunction,
    unwrapExpression,
} from "./shared.js";

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
    return findNodes(
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
 * notes in `matrix-leaves.ts`). The spot arm's `std::cos(outer_cone_angle)` folds the pin's
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
        const carried = findNodes(
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
        findNodes(
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
    const chainHead = findNodes(
        applyAsset.body,
        (node): node is ts.IfStatement =>
            ts.isIfStatement(node) &&
            ts.isBinaryExpression(unwrapExpression(node.expression)) &&
            (unwrapExpression(node.expression) as ts.BinaryExpression)
                    .operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isStringLiteral(
                unwrapExpression(
                    (unwrapExpression(node.expression) as ts.BinaryExpression)
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
        const condition = unwrapExpression(current.expression);
        const read = ts.isBinaryExpression(condition) &&
                condition.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken
            ? unwrapExpression(condition.left)
            : undefined;
        const value = ts.isBinaryExpression(condition)
            ? unwrapExpression(condition.right)
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
        const found = findNodes(
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
        const read = unwrapExpression(expression);
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
            ts.isArrayLiteralExpression(unwrapExpression(node.whenTrue)),
        "no longer defaults the light color behind a presence test",
    );
    const colorKey = propertyKeyOn(colorConditional.condition)!;
    const colorTuple = unwrapExpression(
        colorConditional.whenTrue,
    ) as ts.ArrayLiteralExpression;
    const colorLanes = colorTuple.elements.map((element, laneIndex) => {
        const read = unwrapExpression(element);
        const lane = ts.isElementAccessExpression(read) &&
                propertyKeyOn(read.expression) === colorKey &&
                ts.isNumericLiteral(unwrapExpression(read.argumentExpression))
            ? Number(
                (
                    unwrapExpression(
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
    const colorFallbackValue = unwrapExpression(colorConditional.whenFalse);
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
            pinnedNumericValue(symbol, punctualFile, element),
        )
    );
    const colorName = (() => {
        const declaration = findNodes(
            applyAsset.body,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapExpression(node.initializer!) === colorConditional,
        )[0];
        return declaration && ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
    })();
    // intensity: def.intensity ?? 1, feeding every factory call.
    const intensityDefaults = findNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            propertyKeyOn(node.left) !== undefined &&
            propertyKeyOn(node.left) !== "spot" &&
            !ts.isPropertyAccessChain(unwrapExpression(node.left)),
    );
    if (intensityDefaults.length !== 1) {
        refuseModule(
            symbol,
            "no longer coalesces exactly the intensity default",
        );
    }
    const intensityKey = propertyKeyOn(intensityDefaults[0]!.left)!;
    const intensityValue = pinnedNumericValue(
        symbol,
        punctualFile,
        intensityDefaults[0]!.right,
    );
    const intensityName = (() => {
        const declaration = findNodes(
            applyAsset.body,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapExpression(node.initializer!) === intensityDefaults[0],
        )[0];
        return declaration && ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
    })();
    // range: def.range !== undefined ? def.range : Number.MAX_VALUE.
    const rangeConditional = defaultConditional(
        (node) => {
            const condition = unwrapExpression(node.condition);
            return ts.isBinaryExpression(condition) &&
                condition.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken &&
                propertyKeyOn(condition.left) !== undefined &&
                identifierText(condition.right) === "undefined";
        },
        "no longer defaults the light range behind a presence test",
    );
    const rangeKey = propertyKeyOn(
        (unwrapExpression(rangeConditional.condition) as ts.BinaryExpression)
            .left,
    )!;
    const rangeFallback = unwrapExpression(rangeConditional.whenFalse);
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
        const declaration = findNodes(
            applyAsset.body,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapExpression(node.initializer!) === rangeConditional,
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
                findNodes(
                    branch.block,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isPropertyAccessExpression(
                            unwrapExpression(node.left),
                        ) &&
                        (
                            unwrapExpression(
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
            findNodes(
                branch.block,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isPropertyAccessExpression(
                        unwrapExpression(node.left),
                    ) &&
                    (unwrapExpression(node.left) as ts.PropertyAccessExpression)
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
        const factoryCall = findNodes(
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
    const spotDefaults = findNodes(
        spotBranch.block,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            ts.isPropertyAccessChain(unwrapExpression(node.left)),
    );
    if (spotDefaults.length !== 1) {
        refuseModule(
            symbol,
            "no longer coalesces exactly the outer cone default",
        );
    }
    const outerRead = unwrapExpression(
        spotDefaults[0]!.left,
    ) as ts.PropertyAccessChain;
    const outerKey = outerRead.name.text;
    const spotRead = unwrapExpression(outerRead.expression);
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
    const outerValue = pinnedNumericValue(
        symbol,
        punctualFile,
        spotDefaults[0]!.right,
    );
    const outerName = (() => {
        const declaration = findNodes(
            spotBranch.block,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                node.initializer !== undefined &&
                unwrapExpression(node.initializer!) === spotDefaults[0],
        )[0];
        return declaration && ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
    })();
    const spotCall = findNodes(
        spotBranch.block,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === "createSpotLight",
    )[0]!;
    const angleArgument = spotCall.arguments.length === 5
        ? unwrapExpression(spotCall.arguments[2]!)
        : undefined;
    const outerScale = angleArgument !== undefined &&
            ts.isBinaryExpression(angleArgument) &&
            angleArgument.operatorToken.kind ===
                ts.SyntaxKind.AsteriskToken &&
            outerName !== undefined &&
            identifierText(angleArgument.left) === outerName &&
            ts.isNumericLiteral(unwrapExpression(angleArgument.right))
        ? Number(
            (unwrapExpression(angleArgument.right) as ts.NumericLiteral).text,
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
    const exponentArgument = unwrapExpression(spotCall.arguments[3]!);
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
    const halfFactors = findNodes(
        spotFactory,
        (node): node is ts.CallExpression =>
            mathCall(node as ts.Expression, "cos") !== undefined,
    )
        .map((call) => {
            const argument = call.arguments.length === 1
                ? unwrapExpression(call.arguments[0]!)
                : undefined;
            return argument !== undefined &&
                    ts.isBinaryExpression(argument) &&
                    argument.operatorToken.kind ===
                        ts.SyntaxKind.AsteriskToken &&
                    identifierText(argument.left) === angleName &&
                    ts.isNumericLiteral(unwrapExpression(argument.right))
                ? Number(
                    (
                        unwrapExpression(argument.right) as ts.NumericLiteral
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
    const worldDeclaration = findNodes(
        applyAsset.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            ts.isCallExpression(unwrapExpression(node.initializer!)) &&
            identifierText(
                (unwrapExpression(node.initializer!) as ts.CallExpression)
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
        const read = unwrapExpression(expression);
        return ts.isElementAccessExpression(read) &&
                identifierText(read.expression) === worldName &&
                ts.isNumericLiteral(unwrapExpression(read.argumentExpression))
            ? Number(
                (
                    unwrapExpression(
                        read.argumentExpression,
                    ) as ts.NumericLiteral
                ).text,
            )
            : undefined;
    };
    const positionLanes = findNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(unwrapExpression(node.left)) &&
            worldLane(node.right) !== undefined,
    ).map((assignment) => worldLane(assignment.right)!);
    const forwardDeclarations = findNodes(
        applyAsset.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            (() => {
                const value = unwrapExpression(node.initializer!);
                return ts.isPrefixUnaryExpression(value) &&
                    value.operator === ts.SyntaxKind.MinusToken &&
                    worldLane(value.operand) !== undefined;
            })(),
    );
    const forwardLanes = forwardDeclarations.map((declaration) =>
        worldLane(
            (
                unwrapExpression(
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
    const lengthDeclaration = findNodes(
        applyAsset.body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            (() => {
                const value = unwrapExpression(node.initializer!);
                return ts.isBinaryExpression(value) &&
                    value.operatorToken.kind ===
                        ts.SyntaxKind.BarBarToken &&
                    mathCall(value.left, "hypot") !== undefined;
            })(),
    )[0];
    const hypotArguments = lengthDeclaration
        ? mathCall(
            (
                unwrapExpression(
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
        // stays the one documented in the round-3 notes in
        // matrix-leaves.ts.
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
        "                    light.angle =",
        "                        static_cast<double>(outer_cone_angle) * 2.0;",
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
