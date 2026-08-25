import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import {
    GltfLoweredDefault,
    GltfMaterialDefaults,
} from "../templates/gltf-loader-cpp.js";
import {
    coalescedPropertyDefault,
    collectNodes,
    declarationOf,
    featureMethod,
    identifierText,
    mathCall,
    pinnedPropertyPath,
    refuseModule,
    refuseNode,
    signedNumericValue,
    topLevelFunction,
    unwrapPin,
} from "./shared.js";

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
 * KHR_materials_pbrSpecularGlossiness, lowered from the extension's own
 * `out` literal and its two texture reads.
 *
 * This extension is the one that does not *default* into the core
 * workflow but replaces it: metallic goes to a constant, roughness is the
 * glossiness complement, and reflectance takes the specular factor's
 * largest channel. All three are pinned formulas, so the loader emits
 * them from here rather than restating them.
 *
 * Two shapes refuse rather than emit. Both `ctx._texture` calls pass the
 * sRGB flag, which is what the slot table in `pinned-pbr-variant-cpp.ts`
 * states for the spec-gloss slot; a pin that fetched either map through a
 * linear view would shade against a table that still says otherwise. And
 * the maximum is over exactly three channels, which is what the emitted
 * `std::max` initializer list carries.
 */
function specGlossDefaults(
    file: ts.SourceFile,
): GltfMaterialDefaults["specGloss"] {
    const symbol = "KHR_materials_pbrSpecularGlossiness";
    const body = featureMethod(file, symbol, "applyMaterial").body;
    // The two fetches, tied to the record fields they land on through the
    // destructure that names them: a pin that swapped the two calls would
    // otherwise silently feed the specular map to base colour.
    const fetched = collectNodes(
        body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            ts.isArrayBindingPattern(node.name) &&
            node.initializer !== undefined,
    )[0];
    const awaited = fetched ? unwrapPin(fetched.initializer!) : undefined;
    const all = awaited && ts.isAwaitExpression(awaited)
        ? unwrapPin(awaited.expression)
        : undefined;
    const fetches = all && ts.isCallExpression(all) &&
            all.arguments.length === 1
        ? unwrapPin(all.arguments[0]!)
        : undefined;
    if (!fetched || !fetches || !ts.isArrayLiteralExpression(fetches)) {
        refuseModule(
            symbol,
            "no longer fetches its textures through one awaited array",
        );
    }
    const bindings = (fetched.name as ts.ArrayBindingPattern).elements;
    const fetchedKeys = new Map<string, string>();
    fetches.elements.forEach((element, index) => {
        const call = unwrapPin(element);
        if (!ts.isCallExpression(call) || call.arguments.length !== 2) {
            refuseNode(symbol, file, element, "no longer fetches a texture");
        }
        const info = unwrapPin(call.arguments[0]!);
        if (
            !ts.isPropertyAccessExpression(info) &&
            !ts.isPropertyAccessChain(info)
        ) {
            refuseNode(symbol, file, info, "no longer names the texture it fetches");
        }
        if (unwrapPin(call.arguments[1]!).kind !== ts.SyntaxKind.TrueKeyword) {
            refuseNode(
                symbol,
                file,
                call.arguments[1]!,
                "no longer fetches this map through an sRGB view (the slot " +
                    "table in src/pinned-pbr-variant-cpp.ts states srgb)",
            );
        }
        const binding = bindings[index];
        if (
            !binding ||
            !ts.isBindingElement(binding) ||
            !ts.isIdentifier(binding.name)
        ) {
            refuseNode(symbol, file, element, "no longer binds this fetch to a name");
        }
        fetchedKeys.set(binding.name.text, info.name.text);
    });
    const out = declarationOf(body, "out");
    const literal = out?.initializer ? unwrapPin(out.initializer) : undefined;
    if (!literal || !ts.isObjectLiteralExpression(literal)) {
        refuseModule(symbol, "no longer returns one options literal");
    }
    // `out.<field> = <binding>` ties each fetch to the record slot it fills.
    const textureKey = (field: string): string => {
        for (const assignment of collectNodes(
            body,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken,
        )) {
            const target = unwrapPin(assignment.left);
            if (
                ts.isPropertyAccessExpression(target) &&
                target.name.text === field
            ) {
                const key = fetchedKeys.get(
                    identifierText(assignment.right) ?? "",
                );
                if (key !== undefined) return key;
            }
        }
        refuseModule(symbol, `no longer fills '${field}' from a fetched texture`);
    };
    // `roughnessFactor: complement - (glossinessFactor ?? fallback)`.
    const complement = unwrapPin(
        optionInitializer(symbol, literal, "roughnessFactor"),
    );
    if (
        !ts.isBinaryExpression(complement) ||
        complement.operatorToken.kind !== ts.SyntaxKind.MinusToken
    ) {
        refuseModule(symbol, "no longer takes roughness as a glossiness complement");
    }
    const glossiness = coalescedPropertyDefault(complement.right);
    if (!glossiness) {
        refuseNode(
            symbol,
            file,
            complement.right,
            "no longer defaults the glossiness factor",
        );
    }
    // `reflectance: sf ? Math.max(sf[0], sf[1], sf[2]) : absent`, where `sf`
    // is the binding the specular factor was read into.
    const reflectance = unwrapPin(
        optionInitializer(symbol, literal, "reflectance"),
    );
    if (!ts.isConditionalExpression(reflectance)) {
        refuseModule(symbol, "no longer conditions reflectance on a specular factor");
    }
    const factorName = identifierText(reflectance.condition);
    const factor = factorName
        ? declarationOf(body, factorName)?.initializer
        : undefined;
    const read = factor ? unwrapPin(factor) : undefined;
    if (
        !read ||
        (!ts.isPropertyAccessExpression(read) && !ts.isPropertyAccessChain(read))
    ) {
        refuseNode(
            symbol,
            file,
            reflectance.condition,
            "no longer conditions reflectance on a named property read",
        );
    }
    const largest = mathCall(reflectance.whenTrue, "max");
    const channels = largest?.arguments ?? [];
    const indexed = channels.every((argument, index) => {
        const element = unwrapPin(argument);
        if (!ts.isElementAccessExpression(element)) return false;
        const channel = unwrapPin(element.argumentExpression);
        return identifierText(element.expression) === factorName &&
            ts.isNumericLiteral(channel) && Number(channel.text) === index;
    });
    if (!largest || channels.length !== 3 || !indexed) {
        refuseNode(
            symbol,
            file,
            reflectance.whenTrue,
            "no longer takes the maximum of the specular factor's first " +
                "three channels",
        );
    }
    return {
        diffuseTextureKey: textureKey("baseColorTexture"),
        specGlossTextureKey: textureKey("specGlossTexture"),
        metallicFactor: floatLiteral(
            signedNumericValue(
                symbol,
                file,
                optionInitializer(symbol, literal, "metallicFactor"),
            ),
        ),
        glossiness: {
            key: glossiness.key,
            literal: floatLiteral(
                signedNumericValue(symbol, file, glossiness.fallback),
            ),
            complement: floatLiteral(
                signedNumericValue(symbol, file, complement.left),
            ),
        },
        reflectance: {
            key: read.name.text,
            channels: String(channels.length),
            absent: floatLiteral(
                signedNumericValue(symbol, file, reflectance.whenFalse),
            ),
        },
    };
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
    specGloss: ts.SourceFile;
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
        specGloss: specGlossDefaults(files.specGloss),
    };
}
