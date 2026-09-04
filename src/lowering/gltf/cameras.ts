import ts from "typescript";
import { doubleLiteral } from "../../cpp-literals.js";
import {
    coalescedPropertyDefault,
    collectNodes,
    declarationOf,
    featureMethod,
    identifierText,
    mathCall,
    pinnedConstantValue,
    pinnedRootFlip,
    refuseModule,
    refuseNode,
    requirePropertyReads,
    signedNumericValue,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

/** `<owner>.<name>` (plain or optional-chained) — the file's one
 *  property-read test, shared by every anchor that matches on a key. */
function readsProperty(node: ts.Node, name: string): boolean {
    return (
        (ts.isPropertyAccessExpression(node) ||
            ts.isPropertyAccessChain(node)) &&
        node.name.text === name
    );
}

/**
 * The glTF `camera` node property (`_camera` loader feature).
 *
 * Every imported camera is the pin's own parented FreeCamera: a
 * `<name>_fixup` TransformNode under the camera's glTF node carries scale
 * `(-1/s, 1/s, 1/s)`, and the camera itself is `createFreeCamera` at the
 * origin looking toward `(0, 0, -1)`. The record form keeps that split —
 * the free-camera look-at local stays on the record's position/target,
 * and `parent_world` carries the fixup node's composed world.
 *
 * Two folds turn the pin's node chain into the emitted element loop, both
 * exact under the pinned multiply's float stores:
 *
 * - The RH→LH root. The pinned `computeNodeWorldMatrix` parents hierarchy
 *   roots on `RH_TO_LH_ROOT`, and the live TransformNode chain hangs under
 *   the `__root__` node built with the same diagonal, so a pinned node
 *   world is the record's glTF-space `compute_world` with every element at
 *   flat index ≡ flip-lane (mod 4) negated. The sign flip commutes with
 *   each level's float store, so folding it once at the read is exact —
 *   the same translation the punctual-light record documents in
 *   `matrix-leaves.ts`.
 * - The fixup scale. `getWorldMatrix` composes
 *   `mat4MultiplyInto(out, 0, parentWorld, 0, fixupLocal, 0)`; a diagonal
 *   right operand reduces each output element `[4c + r]` to
 *   `parent[4c + r] * F_cc` — one product per element, computed in double
 *   from the float operands and stored float, which is what the emitted
 *   loop does.
 *
 * The reachability split is the pin's `_nodeMap`: `buildNodeHierarchy`
 * fills it by recursing the active scene's root list through `children`,
 * so a reachable node's camera follows the animated pose while an
 * unreachable one is baked once from the rest world — which the pin bakes
 * through `createSceneNodeFromMatrix(restWorld)`, whose matrix already
 * carries the root mirror, so both arms share one fold.
 */
export function lowerGltfCamerasCpp(
    cameraFile: ts.SourceFile,
    loadGltfFile: ts.SourceFile,
    parserFile: ts.SourceFile,
): {
    parentWriter: string;
    loading: string;
    poseRefresh: string;
} {
    const symbol = "_camera";
    const applyAsset = featureMethod(cameraFile, symbol, "applyAsset");

    // enableGltfCameras registers behind `!!json.cameras?.length`; the
    // compiled intrinsic mirrors that gate as "cameras load whenever the
    // asset carries any", so the predicate shape is load-bearing.
    const enable = topLevelFunction(cameraFile, "enableGltfCameras");
    const registration = collectNodes(
        enable,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) ===
                "_registerEnabledGltfFeature",
    )[0];
    if (!registration || registration.arguments.length !== 2) {
        refuseModule(
            symbol,
            "no longer registers through _registerEnabledGltfFeature",
        );
    }
    const predicate = unwrapPin(registration.arguments[0]!);
    const predicateReadsCameras = ts.isArrowFunction(predicate) &&
        collectNodes(
            predicate,
            (node): node is ts.Node => readsProperty(node, "cameras"),
        ).length > 0;
    if (!predicateReadsCameras) {
        refuseModule(
            symbol,
            "no longer gates on the asset's cameras array",
        );
    }

    // The walk: defs from `ctx._json.cameras`, one camera per node whose
    // `camera` property names a present definition.
    requirePropertyReads(symbol, applyAsset.body, [
        "cameras",
        "camera",
        "nodes",
    ]);

    // The projection dispatch: perspective checks [yfov, znear],
    // orthographic [xmag, ymag, znear, zfar], anything else throws. The
    // conditional chain is the anchor; its key lists flow into the
    // emitted reads and finiteness gate.
    const paramsConditional = collectNodes(
        applyAsset.body,
        (node): node is ts.ConditionalExpression =>
            ts.isConditionalExpression(node) &&
            ts.isBinaryExpression(unwrapPin(node.condition)) &&
            ts.isStringLiteral(
                unwrapPin(
                    (unwrapPin(node.condition) as ts.BinaryExpression)
                        .right,
                ),
            ) &&
            (
                unwrapPin(
                    (unwrapPin(node.condition) as ts.BinaryExpression)
                        .right,
                ) as ts.StringLiteral
            ).text === "perspective",
    )[0];
    if (!paramsConditional) {
        refuseModule(
            symbol,
            "no longer dispatches projection params on the type string",
        );
    }
    const tupleKeys = (expression: ts.Expression): string[] => {
        const tuple = unwrapPin(expression);
        if (!ts.isArrayLiteralExpression(tuple)) return [];
        return tuple.elements.map((element) => {
            const read = unwrapPin(element);
            return ts.isPropertyAccessExpression(read) ||
                    ts.isPropertyAccessChain(read)
                ? read.name.text
                : "";
        });
    };
    const perspectiveKeys = tupleKeys(paramsConditional.whenTrue);
    const innerConditional = unwrapPin(paramsConditional.whenFalse);
    const orthographicKeys = ts.isConditionalExpression(innerConditional)
        ? tupleKeys(innerConditional.whenTrue)
        : [];
    if (perspectiveKeys.join(",") !== "yfov,znear") {
        refuseModule(
            symbol,
            "no longer gates perspective cameras on [yfov, znear]",
        );
    }
    if (orthographicKeys.join(",") !== "xmag,ymag,znear,zfar") {
        refuseModule(
            symbol,
            "no longer gates orthographic cameras on [xmag, ymag, znear, zfar]",
        );
    }
    const projectionThrow = collectNodes(
        applyAsset.body,
        (node): node is ts.ThrowStatement => ts.isThrowStatement(node),
    ).find((statement) => {
        const thrown = unwrapPin(statement.expression);
        return ts.isNewExpression(thrown) &&
            identifierText(thrown.expression) === "Error" &&
            (thrown.arguments ?? []).some((argument) => {
                const text = unwrapPin(argument);
                return ts.isTemplateExpression(text) &&
                    text.templateSpans.some((span) =>
                        span.literal.text.includes(
                            "unsupported projection",
                        )
                    );
            });
    });
    if (!projectionThrow) {
        refuseModule(
            symbol,
            "no longer throws for an unsupported projection",
        );
    }

    // findChangingScaleAncestor: the animated-scale skip. The channel
    // match (path === "scale" on the ancestor, or the animation-pointer
    // spelling), the CUBICSPLINE bail, and the min/max-vs-rest tolerance
    // all flow into the emitted walk.
    const findChanging = topLevelFunction(
        cameraFile,
        "findChangingScaleAncestor",
    );
    const pathTest = collectNodes(
        findChanging,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isStringLiteral(unwrapPin(node.right)) &&
            (unwrapPin(node.right) as ts.StringLiteral).text === "scale",
    )[0];
    if (!pathTest) {
        refuseModule(
            symbol,
            "no longer matches scale channels by target path",
        );
    }
    const pointerTemplate = collectNodes(
        findChanging,
        (node): node is ts.TemplateExpression =>
            ts.isTemplateExpression(node),
    ).find(
        (template) =>
            template.head.text === "/nodes/" &&
            template.templateSpans.length === 1 &&
            template.templateSpans[0]!.literal.text === "/scale",
    );
    if (!pointerTemplate) {
        refuseModule(
            symbol,
            "no longer matches the animation-pointer scale spelling",
        );
    }
    const cubicSpline = collectNodes(
        findChanging,
        (node): node is ts.StringLiteral =>
            ts.isStringLiteral(node) && node.text === "CUBICSPLINE",
    )[0];
    if (!cubicSpline) {
        refuseModule(
            symbol,
            "no longer bails on CUBICSPLINE scale samplers",
        );
    }
    // |value - rest| / Math.max(0.01, |rest|) > 1e-5 — both constants flow.
    const toleranceCompare = collectNodes(
        findChanging,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.GreaterThanToken &&
            ts.isBinaryExpression(unwrapPin(node.left)) &&
            (unwrapPin(node.left) as ts.BinaryExpression)
                    .operatorToken.kind === ts.SyntaxKind.SlashToken,
    )[0];
    if (!toleranceCompare) {
        refuseModule(
            symbol,
            "no longer compares the relative scale drift to a tolerance",
        );
    }
    const scaleTolerance = pinnedConstantValue(
        symbol,
        cameraFile,
        toleranceCompare.right,
    );
    const denominatorCall = mathCall(
        (unwrapPin(toleranceCompare.left) as ts.BinaryExpression).right,
        "max",
    );
    if (!denominatorCall || denominatorCall.arguments.length !== 2) {
        refuseModule(
            symbol,
            "no longer floors the drift denominator with Math.max",
        );
    }
    const driftFloor = pinnedConstantValue(
        symbol,
        cameraFile,
        denominatorCall.arguments[0]!,
    );
    const restDefault = collectNodes(
        findChanging,
        (node): node is ts.BinaryExpression => ts.isBinaryExpression(node),
    )
        .map((node) => coalescedPropertyDefault(node))
        .find((candidate) => candidate?.key === "scale");
    const restFallbackTuple = restDefault
        ? unwrapPin(restDefault.fallback)
        : undefined;
    const restFallbackValues =
        restFallbackTuple && ts.isArrayLiteralExpression(restFallbackTuple)
            ? restFallbackTuple.elements.map((element) =>
                  signedNumericValue(symbol, cameraFile, element)
              )
            : [];
    if (restFallbackValues.join(",") !== "1,1,1") {
        refuseModule(
            symbol,
            "no longer defaults the rest scale to [1, 1, 1]",
        );
    }

    // The rest-world analysis: per-axis scale from hypot over the basis
    // columns at offsets 0/4/8, the mean, the zero floor and the
    // uniformity tolerance, and the thrown message.
    const worldCall = collectNodes(
        applyAsset.body,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) ===
                "computeNodeWorldMatrix",
    )[0];
    if (!worldCall) {
        refuseModule(
            symbol,
            "no longer bakes the rest world through computeNodeWorldMatrix",
        );
    }
    const measuresBasisColumns = collectNodes(
        applyAsset.body,
        (node): node is ts.ArrayLiteralExpression =>
            ts.isArrayLiteralExpression(node) &&
            node.elements.length === 3 &&
            node.elements.every((element) =>
                ts.isNumericLiteral(unwrapPin(element))
            ) &&
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name.text === "map",
    ).some(
        (literal) =>
            literal.elements
                .map((element) =>
                    Number((unwrapPin(element) as ts.NumericLiteral).text)
                )
                .join(",") === "0,4,8",
    );
    if (!measuresBasisColumns) {
        refuseModule(
            symbol,
            "no longer measures the basis columns at offsets 0/4/8",
        );
    }
    const hypotUse = collectNodes(
        applyAsset.body,
        (node): node is ts.CallExpression =>
            mathCall(node as ts.Expression, "hypot") !== undefined,
    )[0];
    if (!hypotUse || hypotUse.arguments.length !== 3) {
        refuseModule(
            symbol,
            "no longer takes the three-component column length",
        );
    }
    const meanDivide = collectNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.SlashToken &&
            ts.isNumericLiteral(unwrapPin(node.right)) &&
            ts.isParenthesizedExpression(node.left),
    )[0];
    if (
        !meanDivide ||
        Number((unwrapPin(meanDivide.right) as ts.NumericLiteral).text) !==
            3
    ) {
        refuseModule(
            symbol,
            "no longer averages the three axis scales",
        );
    }
    const uniformityCheck = collectNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
            ts.isBinaryExpression(unwrapPin(node.left)) &&
            (unwrapPin(node.left) as ts.BinaryExpression)
                    .operatorToken.kind === ts.SyntaxKind.LessThanToken,
    )[0];
    if (!uniformityCheck) {
        refuseModule(
            symbol,
            "no longer guards the scale floor and uniformity together",
        );
    }
    const scaleFloor = pinnedConstantValue(
        symbol,
        cameraFile,
        (unwrapPin(uniformityCheck.left) as ts.BinaryExpression).right,
    );
    const uniformityRight = unwrapPin(uniformityCheck.right);
    if (
        !ts.isBinaryExpression(uniformityRight) ||
        uniformityRight.operatorToken.kind !==
            ts.SyntaxKind.GreaterThanToken ||
        !ts.isBinaryExpression(unwrapPin(uniformityRight.right))
    ) {
        refuseModule(
            symbol,
            "no longer compares the scale spread to a scaled tolerance",
        );
    }
    const uniformityTolerance = pinnedConstantValue(
        symbol,
        cameraFile,
        (unwrapPin(uniformityRight.right) as ts.BinaryExpression).right,
    );
    const uniformThrow = collectNodes(
        applyAsset.body,
        (node): node is ts.StringLiteral =>
            ts.isStringLiteral(node) &&
            node.text.includes("non-zero uniform scale"),
    )[0];
    if (!uniformThrow) {
        refuseModule(
            symbol,
            "no longer throws for degenerate or non-uniform scale",
        );
    }
    const inverseInitializer = declarationOf(
        applyAsset.body,
        "inverseScale",
    )?.initializer;
    const inverseValue = inverseInitializer
        ? unwrapPin(inverseInitializer)
        : undefined;
    if (
        !inverseValue ||
        !ts.isBinaryExpression(inverseValue) ||
        inverseValue.operatorToken.kind !== ts.SyntaxKind.SlashToken ||
        signedNumericValue(symbol, cameraFile, inverseValue.left) !== 1
    ) {
        refuseModule(
            symbol,
            "no longer inverts the accumulated world scale",
        );
    }

    // The name default: def.name ?? `camera${camIdx}` — the prefix flows.
    const nameDefault = collectNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression => ts.isBinaryExpression(node),
    )
        .map((node) => coalescedPropertyDefault(node))
        .find(
            (candidate) =>
                candidate?.key === "name" &&
                ts.isTemplateExpression(unwrapPin(candidate.fallback)),
        );
    if (!nameDefault) {
        refuseModule(
            symbol,
            "no longer defaults the camera name from the definition",
        );
    }
    const namePrefix = (
        unwrapPin(nameDefault.fallback) as ts.TemplateExpression
    ).head.text;

    // The fixup transform: createTransformNode(name, 0,0,0, 0,0,0,1,
    // -inverseScale, inverseScale, inverseScale). The sign pattern of the
    // three scale arguments is the emitted lane table.
    const fixupCall = collectNodes(
        applyAsset.body,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === "createTransformNode",
    )[0];
    if (!fixupCall || fixupCall.arguments.length !== 11) {
        refuseModule(
            symbol,
            "no longer builds the fixup transform with the full TRS arity",
        );
    }
    const trsValues = fixupCall.arguments
        .slice(1, 8)
        .map((argument) =>
            signedNumericValue(symbol, cameraFile, argument)
        );
    if (trsValues.join(",") !== "0,0,0,0,0,0,1") {
        refuseModule(
            symbol,
            "no longer keeps the fixup at the origin with identity rotation",
        );
    }
    const fixupLaneSigns = fixupCall.arguments
        .slice(8)
        .map((argument) => {
            const value = unwrapPin(argument);
            const negative = ts.isPrefixUnaryExpression(value) &&
                value.operator === ts.SyntaxKind.MinusToken;
            const operand = negative
                ? unwrapPin(
                    (value as ts.PrefixUnaryExpression)
                        .operand as ts.Expression,
                )
                : value;
            if (identifierText(operand) !== "inverseScale") {
                refuseNode(
                    symbol,
                    cameraFile,
                    argument,
                    "no longer scales the fixup by the inverse world scale",
                );
            }
            return negative ? -1 : 1;
        });
    if (fixupLaneSigns.filter((sign) => sign === -1).length !== 1) {
        refuseModule(
            symbol,
            "no longer mirrors exactly one fixup lane",
        );
    }

    // The live-vs-baked parent: ctx._nodeMap?.[nodeIdx] ?? bakedNode.
    const parentAssignment = collectNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            readsProperty(unwrapPin(node.left), "parent") &&
            ts.isBinaryExpression(unwrapPin(node.right)) &&
            (unwrapPin(node.right) as ts.BinaryExpression)
                    .operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken,
    ).find((assignment) => {
        const fallback = unwrapPin(
            (unwrapPin(assignment.right) as ts.BinaryExpression).right,
        );
        return ts.isCallExpression(fallback) &&
            identifierText(fallback.expression) ===
                "createSceneNodeFromMatrix";
    });
    if (!parentAssignment) {
        refuseModule(
            symbol,
            "no longer parents live nodes with a baked rest-world fallback",
        );
    }

    // The camera itself: createFreeCamera at the origin toward (0,0,-1).
    const freeCameraCall = collectNodes(
        applyAsset.body,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === "createFreeCamera",
    )[0];
    if (!freeCameraCall || freeCameraCall.arguments.length !== 2) {
        refuseModule(
            symbol,
            "no longer instantiates the camera through createFreeCamera",
        );
    }
    const vectorComponents = (expression: ts.Expression): number[] => {
        const literal = unwrapPin(expression);
        if (!ts.isObjectLiteralExpression(literal)) return [];
        return ["x", "y", "z"].map((component) => {
            const property = literal.properties.find(
                (candidate) =>
                    ts.isPropertyAssignment(candidate) &&
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === component,
            ) as ts.PropertyAssignment | undefined;
            return property
                ? signedNumericValue(
                    symbol,
                    cameraFile,
                    property.initializer,
                )
                : Number.NaN;
        });
    };
    const eye = vectorComponents(freeCameraCall.arguments[0]!);
    const lookTarget = vectorComponents(freeCameraCall.arguments[1]!);
    if (eye.join(",") !== "0,0,0" || lookTarget.join(",") !== "0,0,-1") {
        refuseModule(
            symbol,
            "no longer looks down -Z from the origin",
        );
    }

    // The perspective projection writes: fov = yfov, nearPlane = znear,
    // farPlane = zfar ?? <default>; the default flows.
    const cameraWrites = collectNodes(
        applyAsset.body,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(unwrapPin(node.left)),
    );
    const cameraWrite = (property: string): ts.Expression | undefined =>
        cameraWrites.find(
            (assignment) =>
                (
                    unwrapPin(
                        assignment.left,
                    ) as ts.PropertyAccessExpression
                ).name.text === property,
        )?.right;
    const write = cameraWrite("fov");
    if (write === undefined || !readsProperty(unwrapPin(write), "yfov")) {
        refuseModule(symbol, "no longer maps yfov onto the camera fov");
    }
    const perspectiveFar = cameraWrites
        .filter(
            (assignment) =>
                (
                    unwrapPin(
                        assignment.left,
                    ) as ts.PropertyAccessExpression
                ).name.text === "farPlane",
        )
        .map((assignment) => coalescedPropertyDefault(assignment.right))
        .find((candidate) => candidate?.key === "zfar");
    if (!perspectiveFar) {
        refuseModule(
            symbol,
            "no longer defaults the perspective far plane from zfar",
        );
    }
    const farDefault = pinnedConstantValue(
        symbol,
        cameraFile,
        perspectiveFar.fallback,
    );

    // The orthographic arm reaches enableOrthographicCamera with explicit
    // bounds the camera record does not carry; its presence keeps the
    // emitted load-time refusal honest, and a pin that drops or reshapes
    // the arm regenerates this leaf.
    const orthoEnable = collectNodes(
        applyAsset.body,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) ===
                "enableOrthographicCamera",
    )[0];
    if (!orthoEnable || orthoEnable.arguments.length !== 2) {
        refuseModule(
            symbol,
            "no longer enables orthographic import through enableOrthographicCamera",
        );
    }
    const orthoBounds = unwrapPin(orthoEnable.arguments[1]!);
    const orthoBoundKeys = ts.isObjectLiteralExpression(orthoBounds)
        ? orthoBounds.properties
              .map((property) =>
                  ts.isPropertyAssignment(property) &&
                      ts.isIdentifier(property.name)
                      ? property.name.text
                      : ""
              )
              .sort()
              .join(",")
        : "";
    if (orthoBoundKeys !== "bottom,halfHeight,left,right,top") {
        refuseModule(
            symbol,
            "no longer passes the explicit orthographic bounds",
        );
    }

    // The exposure: node-encounter-ordered cameras on the container.
    const pushCall = collectNodes(
        applyAsset.body,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "push" &&
            identifierText(node.expression.expression) === "cameras",
    )[0];
    if (!pushCall) {
        refuseModule(
            symbol,
            "no longer collects cameras in encounter order",
        );
    }

    // The mirror the folds share. The parser's rest world carries it via
    // RH_TO_LH_ROOT; the live chain hangs under load-gltf's `__root__`
    // TransformNode. Both must name the same diagonal, or the two arms
    // would mirror differently.
    const flip = pinnedRootFlip(parserFile);
    const buildHierarchy = topLevelFunction(
        loadGltfFile,
        "buildNodeHierarchy",
    );
    const rootCall = collectNodes(
        buildHierarchy,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            identifierText(node.expression) === "createTransformNode" &&
            node.arguments.length === 11 &&
            ts.isStringLiteral(unwrapPin(node.arguments[0]!)) &&
            (unwrapPin(node.arguments[0]!) as ts.StringLiteral).text ===
                "__root__",
    )[0];
    if (!rootCall) {
        refuseModule(
            symbol,
            "load-gltf no longer builds the __root__ conversion node",
        );
    }
    const rootScales = rootCall.arguments
        .slice(8)
        .map((argument) =>
            signedNumericValue(symbol, loadGltfFile, argument)
        );
    const rootFlipLanes = [0, 1, 2].filter(
        (lane) => rootScales[lane] !== 1,
    );
    if (
        rootFlipLanes.length !== 1 ||
        rootScales[rootFlipLanes[0]!] !== -1 ||
        rootFlipLanes[0] !== flip.lane
    ) {
        refuseModule(
            symbol,
            "the __root__ scale no longer matches the parser's RH→LH diagonal",
        );
    }
    if (fixupLaneSigns[flip.lane] !== -1) {
        refuseModule(
            symbol,
            "the fixup mirror no longer cancels the RH→LH lane",
        );
    }

    // The reachability rule: buildNodeHierarchy recurses the active
    // scene's roots (`json.scenes?.[json.scene ?? 0]?.nodes ?? []`)
    // through `children`, filling nodeMap for exactly the visited nodes.
    requirePropertyReads(symbol, buildHierarchy, [
        "scenes",
        "scene",
        "children",
    ]);

    // The free camera's look-at local is the record's own position/target
    // path: `lowerFreeFactory` (camera-lowerer.ts) owns the createFreeCamera
    // record equivalence, and the intrinsic that reaches this feature
    // reaches `camera:free` with it, so that lowering always runs.

    const lane = flip.lane;
    const fixupSigns = fixupLaneSigns.map(
        (sign) => `${sign < 0 ? "-" : ""}inverse_scale`,
    );

    const parentWriter = [
        "// The fixup-node world an imported glTF camera hangs under:",
        "// fixup × node × RH→LH root, folded per the leaf notes in",
        "// src/lowering/gltf/cameras.ts. The root diagonal negates every",
        `// element at flat index ≡ ${lane} (mod 4); the fixup diagonal`,
        "// scales each element group by its lane. Every product is",
        "// computed in double from the float operands and stored float,",
        "// which is the pinned multiply's own arithmetic for a diagonal",
        "// operand.",
        "void write_gltf_camera_parent_world(",
        "    CameraRecord& camera,",
        "    const Matrix& node_world,",
        "    const std::array<float, 4>& fixup_lanes) {",
        "    for (std::size_t element = 0; element < 16; ++element) {",
        `        const double value = element % 4 == ${lane}`,
        "            ? -static_cast<double>(node_world[element])",
        "            : static_cast<double>(node_world[element]);",
        "        camera.parent_world[element] = static_cast<float>(",
        "            fixup_lanes[element / 4] * value);",
        "    }",
        "    camera.has_parent_world = true;",
        "}",
    ].join("\n");

    const loading = [
        "    if (const JsonArray& camera_definitions =",
        '            array_or_empty(document, "cameras");',
        "        !camera_definitions.empty()) {",
        "        // The `_camera` feature: one FreeCamera per node whose",
        "        // `camera` property names a present definition, in node",
        "        // order — entered only when the asset carries cameras,",
        "        // the pin's own registration predicate",
        "        // (`!!json.cameras?.length`). Reachability mirrors",
        "        // buildNodeHierarchy: the active scene's roots recursed",
        "        // through children.",
        "        std::vector<bool> node_reachable(node_json.size(), false);",
        "        {",
        "            std::function<void(std::size_t)> mark =",
        "                [&](std::size_t index) {",
        "                if (",
        "                    index >= node_json.size() ||",
        "                    node_reachable[index]) {",
        "                    return;",
        "                }",
        "                node_reachable[index] = true;",
        "                for (const ts::JsonValue& child : array_or_empty(",
        "                         node_json[index].as_object(),",
        '                         "children")) {',
        "                    mark(unsigned_value(child));",
        "                }",
        "            };",
        "            const JsonArray& scene_definitions =",
        '                array_or_empty(document, "scenes");',
        "            const std::size_t scene_index =",
        '                unsigned_or(document, "scene", 0);',
        "            if (scene_index < scene_definitions.size()) {",
        "                for (const ts::JsonValue& root_node : array_or_empty(",
        "                         scene_definitions[scene_index].as_object(),",
        '                         "nodes")) {',
        "                    mark(unsigned_value(root_node));",
        "                }",
        "            }",
        "        }",
        "        for (",
        "            std::size_t node_index = 0;",
        "            node_index < node_json.size();",
        "            ++node_index) {",
        "            const JsonObject& node =",
        "                node_json[node_index].as_object();",
        "            const ts::JsonValue* camera_value =",
        '                optional(node, "camera");',
        "            if (!camera_value) continue;",
        "            const std::size_t camera_index =",
        "                unsigned_value(*camera_value);",
        "            if (camera_index >= camera_definitions.size()) {",
        "                continue;",
        "            }",
        "            const JsonObject& definition =",
        "                camera_definitions[camera_index].as_object();",
        '            const std::string type = string_or(definition, "type");',
        "            const auto finite_or_nan =",
        "                [](const ts::JsonValue* value) {",
        "                return value",
        "                    ? value->as_number()",
        "                    : std::numeric_limits<double>::quiet_NaN();",
        "            };",
        "            const ts::JsonValue* perspective_value =",
        '                optional(definition, "perspective");',
        "            const ts::JsonValue* orthographic_value =",
        '                optional(definition, "orthographic");',
        "            const JsonObject empty_projection{};",
        '            const bool perspective = type == "perspective";',
        "            const JsonObject& projection =",
        "                perspective && perspective_value",
        "                    ? perspective_value->as_object()",
        '                    : type == "orthographic" && orthographic_value',
        "                        ? orthographic_value->as_object()",
        "                        : empty_projection;",
        "            const bool projection_finite = perspective",
        "                ? std::isfinite(",
        `                      finite_or_nan(optional(projection, "${perspectiveKeys[0]}"))) &&`,
        "                    std::isfinite(",
        `                        finite_or_nan(optional(projection, "${perspectiveKeys[1]}")))`,
        `                : type == "orthographic" &&`,
        orthographicKeys
            .map(
                (key, index) =>
                    `                    std::isfinite(finite_or_nan(optional(projection, "${key}")))${
                        index === 3 ? ";" : " &&"
                    }`,
            )
            .join("\n"),
        "            if (!projection_finite) {",
        "                throw std::runtime_error(",
        '                    "glTF camera " +',
        "                    std::to_string(camera_index) +",
        '                    ": unsupported projection");',
        "            }",
        "            // findChangingScaleAncestor: skip a camera under a",
        "            // scale that animation actually changes.",
        "            bool animated_scale = false;",
        "            for (",
        "                int ancestor = static_cast<int>(node_index);",
        "                ancestor >= 0 && !animated_scale;",
        "                ancestor = parents[ancestor]) {",
        "                const std::vector<double> rest_scale_values =",
        "                    double_array(optional(",
        "                        node_json[ancestor].as_object(),",
        '                        "scale"));',
        "                const std::array<double, 3> rest_scale =",
        "                    rest_scale_values.size() == 3",
        "                        ? std::array<double, 3>{",
        "                              rest_scale_values[0],",
        "                              rest_scale_values[1],",
        "                              rest_scale_values[2],",
        "                          }",
        `                        : std::array<double, 3>{${restFallbackValues
            .map((value) => doubleLiteral(value))
            .join(", ")}};`,
        "                for (const ts::JsonValue& animation_value :",
        "                     animation_json) {",
        "                    if (animated_scale) break;",
        "                    const JsonObject& animation =",
        "                        animation_value.as_object();",
        "                    const JsonArray& samplers =",
        '                        array_or_empty(animation, "samplers");',
        "                    for (const ts::JsonValue& channel_value :",
        '                         array_or_empty(animation, "channels")) {',
        "                        const JsonObject& channel =",
        "                            channel_value.as_object();",
        "                        const ts::JsonValue* target_value =",
        '                            optional(channel, "target");',
        "                        if (!target_value) continue;",
        "                        const JsonObject& target =",
        "                            target_value->as_object();",
        "                        bool targets_scale;",
        '                        if (string_or(target, "path") == "scale") {',
        "                            targets_scale =",
        "                                unsigned_or(",
        '                                    target, "node",',
        "                                    node_json.size()) ==",
        "                                static_cast<std::size_t>(ancestor);",
        "                        } else {",
        "                            const ts::JsonValue* target_extensions =",
        '                                optional(target, "extensions");',
        "                            const ts::JsonValue* pointer_extension =",
        "                                target_extensions",
        "                                    ? optional(",
        "                                          target_extensions",
        "                                              ->as_object(),",
        '                                          "KHR_animation_pointer")',
        "                                    : nullptr;",
        "                            targets_scale = pointer_extension &&",
        "                                string_or(",
        "                                    pointer_extension->as_object(),",
        '                                    "pointer") ==',
        '                                "/nodes/" +',
        "                                    std::to_string(ancestor) +",
        '                                    "/scale";',
        "                        }",
        "                        if (!targets_scale) continue;",
        "                        const std::size_t sampler_index =",
        "                            unsigned_or(",
        '                                channel, "sampler",',
        "                                std::numeric_limits<",
        "                                    std::size_t>::max());",
        "                        const JsonObject* sampler =",
        "                            sampler_index < samplers.size()",
        "                                ? &samplers[sampler_index]",
        "                                      .as_object()",
        "                                : nullptr;",
        "                        const std::size_t output_index = sampler",
        "                            ? unsigned_or(",
        '                                  *sampler, "output",',
        "                                  std::numeric_limits<",
        "                                      std::size_t>::max())",
        "                            : std::numeric_limits<",
        "                                  std::size_t>::max();",
        "                        const JsonObject* accessor =",
        "                            output_index <",
        "                                accessor_json.size()",
        "                                ? &accessor_json",
        "                                      [output_index]",
        "                                          .as_object()",
        "                                : nullptr;",
        "                        const std::vector<double> accessor_min =",
        "                            accessor",
        "                                ? double_array(optional(",
        '                                      *accessor, "min"))',
        "                                : std::vector<double>{};",
        "                        const std::vector<double> accessor_max =",
        "                            accessor",
        "                                ? double_array(optional(",
        '                                      *accessor, "max"))',
        "                                : std::vector<double>{};",
        "                        bool drifts = (sampler &&",
        "                            string_or(",
        '                                *sampler, "interpolation") ==',
        '                            "CUBICSPLINE") ||',
        "                            accessor_min.empty() ||",
        "                            accessor_max.empty();",
        "                        if (!drifts) {",
        "                            std::vector<double> extremes =",
        "                                accessor_min;",
        "                            extremes.insert(",
        "                                extremes.end(),",
        "                                accessor_max.begin(),",
        "                                accessor_max.end());",
        "                            for (",
        "                                std::size_t axis = 0;",
        "                                axis < extremes.size();",
        "                                ++axis) {",
        "                                const double rest =",
        "                                    rest_scale[axis % 3];",
        "                                if (",
        "                                    std::abs(",
        "                                        extremes[axis] - rest) /",
        "                                        std::max(",
        `                                            ${doubleLiteral(driftFloor)},`,
        "                                            std::abs(rest)) >",
        `                                    ${doubleLiteral(scaleTolerance)}) {`,
        "                                    drifts = true;",
        "                                    break;",
        "                                }",
        "                            }",
        "                        }",
        "                        if (drifts) {",
        "                            animated_scale = true;",
        "                            break;",
        "                        }",
        "                    }",
        "                }",
        "            }",
        "            if (animated_scale) {",
        "                // The pin warns and skips; the record just skips.",
        "                continue;",
        "            }",
        "            const Matrix& rest_world = compute_world(node_index);",
        "            const double scale_x = bbl::js::hypot_js({",
        "                static_cast<double>(rest_world[0]),",
        "                static_cast<double>(rest_world[1]),",
        "                static_cast<double>(rest_world[2])});",
        "            const double scale_y = bbl::js::hypot_js({",
        "                static_cast<double>(rest_world[4]),",
        "                static_cast<double>(rest_world[5]),",
        "                static_cast<double>(rest_world[6])});",
        "            const double scale_z = bbl::js::hypot_js({",
        "                static_cast<double>(rest_world[8]),",
        "                static_cast<double>(rest_world[9]),",
        "                static_cast<double>(rest_world[10])});",
        "            const double world_scale =",
        "                (scale_x + scale_y + scale_z) / 3.0;",
        "            if (",
        `                world_scale < ${doubleLiteral(scaleFloor)} ||`,
        "                std::max({scale_x, scale_y, scale_z}) -",
        "                        std::min({scale_x, scale_y, scale_z}) >",
        `                    world_scale * ${doubleLiteral(uniformityTolerance)}) {`,
        "                throw std::runtime_error(",
        `                    "${uniformThrow.text}");`,
        "            }",
        "            const double inverse_scale = 1.0 / world_scale;",
        "            const ts::JsonValue* name_value =",
        '                optional(definition, "name");',
        "            const std::string camera_name = name_value",
        "                ? name_value->as_string()",
        `                : "${namePrefix}" + std::to_string(camera_index);`,
        "            const CameraHandle camera_handle = create_free_camera(",
        "                engine,",
        `                Vec3d{${eye.map((value) => doubleLiteral(value)).join(", ")}},`,
        `                Vec3d{${lookTarget.map((value) => doubleLiteral(value)).join(", ")}});`,
        "            CameraRecord& camera =",
        "                engine.cameras[camera_handle.value];",
        "            camera.name = camera_name;",
        "            if (!perspective) {",
        "                // The pinned orthographic arm passes explicit",
        "                // left/right/bottom/top bounds; the camera record",
        "                // derives its planes from one half-extent and",
        "                // carries no explicit bounds to store.",
        "                throw std::runtime_error(",
        '                    "glTF orthographic cameras are not lowered: "',
        '                    "the camera record derives its clip planes "',
        '                    "from a single half-extent.");',
        "            }",
        `            camera.fov = finite_or_nan(optional(projection, "${perspectiveKeys[0]}"));`,
        `            camera.near_plane = finite_or_nan(optional(projection, "${perspectiveKeys[1]}"));`,
        "            const ts::JsonValue* far_value =",
        '                optional(projection, "zfar");',
        "            camera.far_plane = far_value",
        "                ? far_value->as_number()",
        `                : ${doubleLiteral(farDefault)};`,
        "            const std::array<float, 4> fixup_lanes{",
        fixupSigns
            .map(
                (sign) =>
                    `                static_cast<float>(${sign}),`,
            )
            .join("\n"),
        "                1.0f,",
        "            };",
        "            write_gltf_camera_parent_world(",
        "                camera, rest_world, fixup_lanes);",
        "            if (node_reachable[node_index]) {",
        "                camera_node_bindings.push_back(",
        "                    AnimatedCameraBinding{",
        "                        camera_handle,",
        "                        node_index,",
        "                        fixup_lanes,",
        "                    });",
        "            }",
        "            asset.cameras.push_back(camera_handle);",
        "        }",
        "    }",
    ].join("\n");

    const poseRefresh = [
        "            // Imported cameras follow their node's pose the way",
        "            // the pin's fixup TransformNode follows its parent.",
        "            for (const AnimatedCameraBinding& binding :",
        "                 animation_runtime->camera_nodes) {",
        "                if (",
        "                    binding.camera.value >=",
        "                        engine.cameras.size() ||",
        "                    binding.node >=",
        "                        animation_runtime->nodes.size()) {",
        "                    continue;",
        "                }",
        "                write_gltf_camera_parent_world(",
        "                    engine.cameras[binding.camera.value],",
        "                    compute_animated_world(binding.node),",
        "                    binding.fixup_lanes);",
        "            }",
    ].join("\n");

    return { parentWriter, loading, poseRefresh };
}
