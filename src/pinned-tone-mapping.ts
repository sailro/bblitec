/**
 * The tone-mapping curve a scene selects, taken from the pin that owns it.
 *
 * Upstream models a tone mapping as a *value* rather than a closed union:
 * `material/pbr/tone-mapping.ts` declares `{ id, helpersWGSL, callWGSL }` and
 * each algorithm is one exported record, so `pbr-renderable.ts` composes
 * `scene.imageProcessing.toneMapping ?? StandardToneMapping` straight into the
 * fragment. That makes the curve pure data, and this port reads the same
 * records rather than restating a single one: the scene names an export, and
 * the WGSL that reaches the composer is whatever that export carries.
 *
 * The three the package exports live in three modules, because each is
 * tree-shaken independently — a bundle carries only the algorithm it
 * references. So the module is part of the record here too, and an export the
 * pin renames or moves fails at the import rather than composing the default.
 */
import ts from "typescript";
import {
    sharedPinnedContext,
    unwrapExpression,
    type LoweringContext,
} from "./lowering/context.js";

/**
 * A pinned `ToneMapping`, carried whole because the composer takes it whole.
 *
 * `id` reaches no composed text today -- the pin keys its own pipeline cache
 * by it -- but the record is the pin's unit, and splitting it was what let
 * the composer's dependency key move here without anything noticing.
 */
export interface PinnedToneMapping {
    id: string;
    helpersWGSL: string;
    callWGSL: string;
}

/**
 * Each exported curve and the module it is tree-shaken into, by the name a
 * scene imports it under.
 */
const toneMappingModules: Readonly<Record<string, string>> = {
    StandardToneMapping: "material/pbr/tone-mapping.js",
    AcesToneMapping: "material/pbr/pbr-aces-wgsl.js",
    NeutralToneMapping: "material/pbr/pbr-neutral-wgsl.js",
};

/** The pin's own default, which an unset `toneMapping` resolves to. */
export const defaultToneMappingName = "StandardToneMapping";

/** Whether an imported name is one of the pin's tone-mapping records. */
export function isToneMappingExport(importedName: string): boolean {
    return Object.hasOwn(toneMappingModules, importedName);
}

/** The names a scene may select, for a refusal that lists them. */
export function toneMappingExportNames(): readonly string[] {
    return Object.keys(toneMappingModules);
}

/**
 * The record one named export carries, read whole off the pinned module's
 * own declaration: each member the literal states, a string constant or a
 * module constant naming one.
 */
export function pinnedToneMapping(
    importedName: string,
    context: LoweringContext = sharedPinnedContext(),
): PinnedToneMapping {
    const packaged = toneMappingModules[importedName];
    if (!packaged) {
        throw new Error(
            `'${importedName}' is not a pinned tone mapping; the package ` +
                `exports ${toneMappingExportNames().join(", ")}.`,
        );
    }
    const module = `src/${packaged.slice(0, -".js".length)}.ts`;
    const constant = context.pinnedConstant(module, importedName);
    const literal = constant && unwrapExpression(constant.initializer);
    if (!constant || !literal || !ts.isObjectLiteralExpression(literal)) {
        throw new Error(
            `The pinned module ${module} no longer declares '${importedName}' as a record literal.`,
        );
    }
    const record: Record<string, string> = {};
    for (const property of literal.properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
        )
            return context.contractError(
                property,
                `Expected ${importedName} to state named string members.`,
            );
        const value = unwrapExpression(property.initializer);
        record[property.name.text] = ts.isIdentifier(value)
            ? context.pinnedString(module, value.text)
            : context.stringValue(value, constant.file);
    }
    const { id, helpersWGSL, callWGSL } = record;
    if (id === undefined || helpersWGSL === undefined || callWGSL === undefined)
        return context.contractError(
            literal,
            `Expected ${importedName} to state id, helpersWGSL and callWGSL.`,
        );
    return { ...record, id, helpersWGSL, callWGSL };
}
