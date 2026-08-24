import ts from "typescript";
import { floatLiteral } from "../../cpp-literals.js";
import {
    GltfExtensionDefaults,
    GltfLoweredDefault,
} from "../templates/gltf-loader-cpp.js";
import {
    featureMethod,
    refuseModule,
    refuseNode,
    signedNumericValue,
    unwrapPin,
} from "./shared.js";

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
