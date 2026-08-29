import ts from "typescript";
import {
    collectNodes,
    identifierText,
    refuseModule,
    requirePropertyReads,
    signedNumericValue,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

/** The three lanes a bone override may replace, in the pin's own order. */
type OverrideLane = "translation" | "rotation" | "scale";

const SYMBOL = "bone-control";

/** `<identifier> & <literal>`, as the literal it tests. */
function maskBit(
    file: ts.SourceFile,
    expression: ts.Expression,
): number | undefined {
    const node = unwrapPin(expression);
    if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.AmpersandToken ||
        identifierText(node.left) === undefined
    ) {
        return undefined;
    }
    return signedNumericValue(SYMBOL, file, node.right);
}

/**
 * The flat-TRS lane offsets `skeleton-pose.ts` publishes, which is what
 * says which lane each `if (m & N)` guard writes.
 */
function laneOffsets(pose: ts.SourceFile): Record<OverrideLane, number> {
    const constant = (name: string): number => {
        const declaration = collectNodes(
            pose,
            (node): node is ts.VariableDeclaration =>
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name,
        )[0];
        if (!declaration?.initializer) {
            refuseModule(SYMBOL, `no longer declares '${name}'`);
        }
        return signedNumericValue(
            SYMBOL,
            pose,
            declaration.initializer,
        );
    };
    return {
        translation: constant("T_OFF"),
        rotation: constant("R_OFF"),
        scale: constant("S_OFF"),
    };
}

/** Which lane a `currentTRS[off + <offset>] = …` run writes. */
function writtenLane(
    statements: readonly ts.Statement[],
    offsets: Record<OverrideLane, number>,
): OverrideLane | undefined {
    const written = new Set<number>();
    for (const statement of statements) {
        if (
            !ts.isExpressionStatement(statement) ||
            !ts.isBinaryExpression(statement.expression) ||
            statement.expression.operatorToken.kind !==
                ts.SyntaxKind.EqualsToken
        ) {
            continue;
        }
        const target = unwrapPin(statement.expression.left);
        if (!ts.isElementAccessExpression(target)) continue;
        const index = unwrapPin(target.argumentExpression);
        // `off + T_OFF` and `off + T_OFF + 1` both name the same lane;
        // the base identifier is what the offsets table answers for.
        const base = collectNodes(
            index,
            (node): node is ts.Identifier => ts.isIdentifier(node),
        ).map((node) => node.text);
        for (const [lane, offset] of Object.entries(offsets)) {
            if (base.includes(laneConstantName(lane as OverrideLane))) {
                written.add(offset);
            }
        }
    }
    if (written.size !== 1) return undefined;
    const offset = [...written][0]!;
    return (Object.keys(offsets) as OverrideLane[]).find(
        (lane) => offsets[lane] === offset,
    );
}

function laneConstantName(lane: OverrideLane): string {
    return lane === "translation"
        ? "T_OFF"
        : lane === "rotation"
          ? "R_OFF"
          : "S_OFF";
}

/**
 * The four mask bits, read from `applyOverridesToTRS`'s own guards.
 *
 * The applier has two phases and the split is the whole point of the
 * feature: the transform bits are written *before* channel evaluation so
 * a clip that animates the same bone wins, and the hidden bit is written
 * *after* it so `setBoneVisible` survives a rig that bakes a constant
 * scale track onto every bone. Reading the bits from the guards rather
 * than restating them is what makes a renumbering fail here.
 */
function maskBits(
    boneControl: ts.SourceFile,
    pose: ts.SourceFile,
): { translation: number; rotation: number; scale: number; hidden: number } {
    const applier = topLevelFunction(
        boneControl,
        "applyOverridesToTRS",
    );
    const offsets = laneOffsets(pose);
    const guards = collectNodes(
        applier,
        (node): node is ts.IfStatement => ts.isIfStatement(node),
    );
    const lanes: Partial<Record<OverrideLane, number>> = {};
    let hidden: number | undefined;
    for (const guard of guards) {
        const bit = maskBit(boneControl, guard.expression);
        if (bit === undefined) continue;
        const body = ts.isBlock(guard.thenStatement)
            ? guard.thenStatement.statements
            : [guard.thenStatement];
        const lane = writtenLane(body, offsets);
        if (lane === undefined) continue;
        // The hidden guard is the one nested inside the `hiddenOnly`
        // branch, and it zeroes the scale lane rather than copying an
        // override component.
        const zeroed = body.every(
            (statement) =>
                ts.isExpressionStatement(statement) &&
                ts.isBinaryExpression(statement.expression) &&
                ts.isNumericLiteral(
                    unwrapPin(statement.expression.right),
                ) &&
                Number(
                    (
                        unwrapPin(
                            statement.expression.right,
                        ) as ts.NumericLiteral
                    ).text,
                ) === 0,
        );
        if (zeroed && lane === "scale") {
            hidden = bit;
            continue;
        }
        lanes[lane] = bit;
    }
    if (
        lanes.translation === undefined ||
        lanes.rotation === undefined ||
        lanes.scale === undefined ||
        hidden === undefined
    ) {
        refuseModule(
            SYMBOL,
            "no longer applies translation, rotation, scale and hidden " +
                "overrides through four distinguishable mask bits",
        );
    }
    return {
        translation: lanes.translation,
        rotation: lanes.rotation,
        scale: lanes.scale,
        hidden,
    };
}

/**
 * `setBoneVisible`'s two arms, asserted rather than emitted from the
 * body: hiding sets the bit and bakes, showing clears it, drops an
 * override the clear emptied, and bakes only when there was one.
 */
function assertVisibilityArms(
    boneControl: ts.SourceFile,
    hidden: number,
): void {
    const declaration = topLevelFunction(
        boneControl,
        "setBoneVisible",
    );
    const setsBit = collectNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.BarEqualsToken &&
            signedNumericValue(SYMBOL, boneControl, node.right) ===
                hidden,
    ).length > 0;
    const clearsBit = collectNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.AmpersandEqualsToken,
    ).length > 0;
    const deletes = collectNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "delete",
    ).length > 0;
    const bakes = collectNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "_bake",
    ).length;
    if (!setsBit || !clearsBit || !deletes || bakes !== 2) {
        refuseModule(
            SYMBOL,
            "setBoneVisible no longer sets the hidden bit and bakes on " +
                "one arm and clears, deletes an emptied override and " +
                "bakes on the other",
        );
    }
}

/**
 * `getBoneByName` is the skeleton's own name map, and the map keeps the
 * FIRST bone carrying a name. Both halves are asserted, because the
 * emitted lookup is a linear search in joint order and the two agree only
 * while that rule holds.
 */
function assertNameLookup(boneControl: ts.SourceFile): string {
    const declaration = topLevelFunction(
        boneControl,
        "getBoneByName",
    );
    requirePropertyReads(SYMBOL, declaration, ["_byName", "get"]);
    const builder = topLevelFunction(boneControl, "buildSkeletons");
    const firstWins = collectNodes(
        builder,
        (node): node is ts.PrefixUnaryExpression =>
            ts.isPrefixUnaryExpression(node) &&
            node.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isCallExpression(unwrapPin(node.operand)) &&
            ts.isPropertyAccessExpression(
                (unwrapPin(node.operand) as ts.CallExpression)
                    .expression,
            ) &&
            (
                (unwrapPin(node.operand) as ts.CallExpression)
                    .expression as ts.PropertyAccessExpression
            ).name.text === "has",
    ).length > 0;
    if (!firstWins) {
        refuseModule(
            SYMBOL,
            "buildSkeletons no longer keeps the first bone of a repeated " +
                "name",
        );
    }
    // The unnamed-joint fallback, read from the template literal that
    // builds it rather than retyped.
    const template = collectNodes(
        builder,
        (node): node is ts.TemplateExpression =>
            ts.isTemplateExpression(node),
    )[0];
    if (!template || template.templateSpans.length !== 1) {
        refuseModule(
            SYMBOL,
            "buildSkeletons no longer names an unnamed joint through one " +
                "interpolated fallback",
        );
    }
    return template.head.text;
}

/**
 * The bake's own statement order, which is the contract this port mirrors
 * with a working pose of its own: reset to rest, apply the transform
 * overrides, apply the hidden ones, compose the node worlds, write the
 * palettes.
 */
function assertBakeOrder(boneControl: ts.SourceFile): void {
    const builder = topLevelFunction(boneControl, "buildSkeletons");
    const bake = collectNodes(
        builder,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "bake",
    )[0];
    const body =
        bake?.initializer &&
        ts.isArrowFunction(bake.initializer) &&
        ts.isBlock(bake.initializer.body)
            ? bake.initializer.body
            : undefined;
    if (!body) {
        refuseModule(
            SYMBOL,
            "buildSkeletons no longer builds its eager bake as one arrow",
        );
    }
    const calls = collectNodes(
        body,
        (node): node is ts.CallExpression => ts.isCallExpression(node),
    ).map((node) => identifierText(node.expression));
    const expected = [
        "resetTRS",
        "applyOverridesToTRS",
        "applyOverridesToTRS",
        "computeNodeWorldMatrices",
        "writeBoneTextures",
    ];
    const named = calls.filter(
        (name): name is string =>
            name !== undefined && expected.includes(name),
    );
    if (named.join(",") !== expected.join(",")) {
        refuseModule(
            SYMBOL,
            "the eager bake no longer resets to rest, applies both " +
                "override phases, composes the node worlds and writes the " +
                "palettes in that order",
        );
    }
    // The pin skips both override phases when the map is empty; the
    // emitted bake keeps that gate, so it is read rather than assumed.
    const gate = collectNodes(
        body,
        (node): node is ts.IfStatement => ts.isIfStatement(node),
    ).some((node) =>
        collectNodes(
            node.expression,
            (inner): inner is ts.PropertyAccessExpression =>
                ts.isPropertyAccessExpression(inner) &&
                inner.name.text === "size",
        ).length > 0,
    );
    if (!gate) {
        refuseModule(
            SYMBOL,
            "the eager bake no longer skips the override phases for an " +
                "empty map",
        );
    }
}

/**
 * `extractSkinGroups` builds one group per NODE that carries both a skin
 * and mesh primitives, which is what makes a skin instanced twice two
 * skeletons and a mesh split into primitives one.
 */
function assertSkinGrouping(boneControl: ts.SourceFile): void {
    const extract = topLevelFunction(
        boneControl,
        "extractSkinGroups",
    );
    requirePropertyReads(SYMBOL, extract, [
        "skin",
        "skins",
        "joints",
        "nodes",
    ]);
    const resolve = topLevelFunction(boneControl, "resolveIBMs");
    // The identity fallback for a skin declaring no inverse bind
    // matrices, which the port's own skin runtime already fills.
    const identity = collectNodes(
        resolve,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken,
    ).length > 0;
    if (!identity) {
        refuseModule(
            SYMBOL,
            "resolveIBMs no longer falls back to identity matrices",
        );
    }
}

export interface LoweredBoneControl {
    /** The mask bit each override lane and the hidden state carry. */
    maskTranslation: number;
    maskRotation: number;
    maskScale: number;
    maskHidden: number;
    /** The `bone_` prefix an unnamed joint is named with. */
    unnamedBonePrefix: string;
}

/**
 * The opt-in bone-control chunk (`src/skeleton/bone-control.ts` plus its
 * own `src/skeleton/skeleton-pose.ts`), as the facts the generated loader
 * needs.
 *
 * Nothing here emits arithmetic: the bake is the node-world composition
 * and palette product the loader already owns, run over a working pose
 * this feature supplies. Upstream draws exactly that line too —
 * `skeleton-pose.ts` says it "mirrors the per-frame math the animation
 * tick runs" and exists only so the always-fetched tick stays byte
 * identical without bone control. So what this lowering owes is the
 * facts the two copies must agree on, each read from the declaration
 * that states it.
 */
export function lowerBoneControl(
    boneControlFile: ts.SourceFile,
    poseFile: ts.SourceFile,
): LoweredBoneControl {
    const bits = maskBits(boneControlFile, poseFile);
    assertVisibilityArms(boneControlFile, bits.hidden);
    assertBakeOrder(boneControlFile);
    assertSkinGrouping(boneControlFile);
    const unnamedBonePrefix = assertNameLookup(boneControlFile);
    return {
        maskTranslation: bits.translation,
        maskRotation: bits.rotation,
        maskScale: bits.scale,
        maskHidden: bits.hidden,
        unnamedBonePrefix,
    };
}
