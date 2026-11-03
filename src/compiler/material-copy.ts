import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { isNullishLiteral, namedMember, sameReference } from "./symbols.js";
import {
    conditionalExpression,
    objectLiteralMembers,
    yieldedOperands,
} from "./syntax.js";
import type { Value } from "./types.js";
import { isPbrMaterialValue } from "./values/model.js";

type MaterialCopyContext = Pick<
    LoweringServices,
    | "compileValue"
    | "probeEmission"
    | "checker"
    | "unwrap"
    | "fail"
    | "requireEngine"
    | "allocateTemporaryCppName"
    | "emit"
    | "sceneManifest"
>;

/**
 * Whether `expression` restates the source's own `key`: `source.key`, a fresh
 * array of it, or that array guarded by the key's presence. The copy already
 * holds that value, and an array of it holds the same members.
 */
function restatesSourceMember(
    context: Pick<MaterialCopyContext, "checker" | "unwrap">,
    source: ts.Expression,
    key: string,
    expression: ts.Expression,
): boolean {
    const value = context.unwrap(expression);
    const reads = (candidate: ts.Expression): boolean => {
        const read = namedMember(context.checker, context.unwrap(candidate));
        return (
            read?.name === key &&
            sameReference(context.checker, read.expression, source)
        );
    };
    const array = (candidate: ts.Expression): boolean => {
        const literal = context.unwrap(candidate);
        return (
            ts.isArrayLiteralExpression(literal) &&
            literal.elements.length === 1 &&
            ts.isSpreadElement(literal.elements[0]!) &&
            reads(literal.elements[0].expression)
        );
    };
    if (reads(value) || array(value)) return true;
    const guarded = conditionalExpression(value);
    if (!guarded || !reads(guarded.condition)) return false;
    const [present, absent, ...more] = yieldedOperands(
        guarded,
        context.unwrap,
    ).map(({ operand }) => operand);
    return (
        more.length === 0 &&
        present !== undefined &&
        array(present) &&
        absent !== undefined &&
        isNullishLiteral(context.checker, absent)
    );
}

/**
 * `{ ...material, ...members }`, the copy an object literal spreading a
 * material first makes, or undefined for another literal. The pin's
 * materials are plain props objects, so the spread is a shallow copy with
 * its own identity. Natively it is a new material record holding the
 * source's values and composed as the source (`bbl::clone_material`);
 * writes to the copy then go through its handle as any material property
 * write does.
 */
export function compileMaterialCopy(
    context: MaterialCopyContext,
    literal: ts.ObjectLiteralExpression,
): Value | undefined {
    const [spread, ...members] = objectLiteralMembers(literal);
    if (spread?.kind !== "spread") return undefined;
    // Kept only for a material: another spread source is compiled once, by
    // the literal's own lowering.
    const source = context.probeEmission(() => {
        const value = context.compileValue(spread.node.expression);
        return value.kind === "material" ? value : undefined;
    });
    if (!source) return undefined;
    for (const member of members)
        if (
            member.kind !== "property" ||
            member.key === undefined ||
            !restatesSourceMember(
                context,
                spread.node.expression,
                member.key,
                member.value,
            )
        )
            context.fail(
                member.node,
                "A material copy restates its source's members only; write the copy's own values after it is made.",
            );
    if (!isPbrMaterialValue(source))
        return context.fail(
            spread.node,
            "A material copy is lowered for a PBR material, which composes as its source; a Standard, shader or node material has no copy lane.",
        );
    const engine = context.requireEngine(source, spread.node);
    const copy = context.allocateTemporaryCppName("material_copy");
    context.emit({
        kind: "declaration",
        type: "const bbl::MaterialHandle",
        name: copy,
        initializer: `bbl::clone_material(${engine}, ${source.cpp})`,
    });
    // A copy takes the next material handle at run time, so a later
    // container's materials name their composed slots by profile.
    context.sceneManifest.recordProfiledGltfLoads();
    return {
        kind: "material",
        cpp: copy,
        engineCpp: engine,
        ...(source.scenePbrMaterialIndex !== undefined
            ? { scenePbrMaterialIndex: source.scenePbrMaterialIndex }
            : {}),
        ...(source.assetPbrMaterial ? { assetPbrMaterial: true as const } : {}),
        ...(source.assetWholeMeshList
            ? { assetWholeMeshList: source.assetWholeMeshList }
            : {}),
    };
}
