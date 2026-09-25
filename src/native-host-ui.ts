/**
 * The host-UI companion loader: the audited page elements and bounded style
 * rules a scene's browser page carries beside its module, read from the
 * registry-relative JSON and validated key by key. Generation and both
 * capture harnesses load the companion through this one reader, so a rule
 * kind the projection does not know is refused before any of them uses it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
    CompileOptions,
    NativeHostUi,
    NativeHostUiElement,
} from "./compiler/types.js";
import type { SceneDefinition } from "./scene-registry.js";
import { isUiGeneratedPart } from "./ui-generated-content.js";
import {
    isUiStyleSelectorKind,
    isUiScrollbarPart,
    isUiRangePart,
    type NativeHostUiStyleRule,
} from "./ui-style-rule.js";

function refuseUnknownKeys(
    record: Record<string, unknown>,
    known: readonly string[],
    location: string,
): void {
    for (const key of Object.keys(record)) {
        if (!known.includes(key)) {
            throw new Error(`${location}: unknown key '${key}'.`);
        }
    }
}

function nativeHostUiElement(
    value: unknown,
    location: string,
): NativeHostUiElement {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${location} must be an object.`);
    }
    const record = value as Record<string, unknown>;
    refuseUnknownKeys(
        record,
        ["tag", "text", "attributes", "children"],
        location,
    );
    if (typeof record.tag !== "string") {
        throw new Error(`${location}.tag must be a string.`);
    }
    if (record.text !== undefined && typeof record.text !== "string") {
        throw new Error(`${location}.text must be a string.`);
    }
    let attributes: Record<string, string> | undefined;
    if (record.attributes !== undefined) {
        if (
            !record.attributes ||
            typeof record.attributes !== "object" ||
            Array.isArray(record.attributes)
        ) {
            throw new Error(`${location}.attributes must be an object.`);
        }
        attributes = {};
        for (const [name, attribute] of Object.entries(record.attributes)) {
            if (typeof attribute !== "string") {
                throw new Error(
                    `${location}.attributes.${name} must be a string.`,
                );
            }
            attributes[name] = attribute;
        }
    }
    if (record.children !== undefined && !Array.isArray(record.children)) {
        throw new Error(`${location}.children must be an array.`);
    }
    return {
        tag: record.tag,
        ...(record.text !== undefined ? { text: record.text } : {}),
        ...(attributes ? { attributes } : {}),
        ...(record.children
            ? {
                  children: record.children.map((child, index) =>
                      nativeHostUiElement(
                          child,
                          `${location}.children[${index}]`,
                      ),
                  ),
              }
            : {}),
    };
}

/** Registry generation options, including the runtime Window's live startup. */
export function registrySceneCompileOptions(
    scene: SceneDefinition,
): CompileOptions {
    return {
        fileName: resolve(scene.source),
        title: scene.title,
        search: scene.parity?.referenceSearch ?? "",
        initialSearch: "",
        ...(scene.nativeHostUi
            ? { nativeHostUi: readNativeHostUi(scene.nativeHostUi) }
            : {}),
    };
}

export function readNativeHostUi(path: string): NativeHostUi {
    const value: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Native host UI '${path}' must contain an object.`);
    }
    const record = value as Record<string, unknown>;
    refuseUnknownKeys(
        record,
        ["elements", "styleRules"],
        `Native host UI '${path}'`,
    );
    if (!Array.isArray(record.elements)) {
        throw new Error(`Native host UI '${path}' must contain elements[].`);
    }
    if (record.styleRules !== undefined && !Array.isArray(record.styleRules)) {
        throw new Error(
            `Native host UI '${path}' styleRules must be an array.`,
        );
    }
    const styleRules = (record.styleRules ?? []).map(
        (rule, index): NativeHostUiStyleRule => {
            const location = `Native host UI '${path}' styleRules[${index}]`;
            if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
                throw new Error(`${location} must be an object.`);
            }
            const item = rule as Record<string, unknown>;
            refuseUnknownKeys(
                item,
                [
                    "kind",
                    "primary",
                    "secondary",
                    "tag",
                    "hover",
                    "focusVisible",
                    "active",
                    "scrollbar",
                    "range",
                    "pseudo",
                    "maxWidth",
                    "containerMaxWidth",
                    "reducedMotion",
                    "style",
                ],
                location,
            );
            if (
                !isUiStyleSelectorKind(item.kind) ||
                typeof item.primary !== "string" ||
                typeof item.style !== "string"
            ) {
                throw new Error(
                    `${location} requires a supported kind plus string primary and style values.`,
                );
            }
            if (
                item.secondary !== undefined &&
                typeof item.secondary !== "string"
            ) {
                throw new Error(`${location}.secondary must be a string.`);
            }
            if (item.tag !== undefined && typeof item.tag !== "string") {
                throw new Error(`${location}.tag must be a string.`);
            }
            if (item.hover !== undefined && typeof item.hover !== "boolean") {
                throw new Error(`${location}.hover must be a boolean.`);
            }
            if (
                item.focusVisible !== undefined &&
                typeof item.focusVisible !== "boolean"
            ) {
                throw new Error(`${location}.focusVisible must be a boolean.`);
            }
            if (item.active !== undefined && typeof item.active !== "boolean") {
                throw new Error(`${location}.active must be a boolean.`);
            }
            if (
                item.scrollbar !== undefined &&
                !isUiScrollbarPart(item.scrollbar)
            ) {
                throw new Error(
                    `${location}.scrollbar must name a supported scrollbar part.`,
                );
            }
            if (item.range !== undefined && !isUiRangePart(item.range))
                throw new Error(
                    `${location}.range must name a thumb or track.`,
                );
            if (item.pseudo !== undefined && !isUiGeneratedPart(item.pseudo))
                throw new Error(
                    `${location}.pseudo must be before, after or placeholder.`,
                );
            if (
                item.maxWidth !== undefined &&
                typeof item.maxWidth !== "number"
            ) {
                throw new Error(`${location}.maxWidth must be a number.`);
            }
            if (
                item.containerMaxWidth !== undefined &&
                (typeof item.containerMaxWidth !== "number" ||
                    !Number.isFinite(item.containerMaxWidth) ||
                    item.containerMaxWidth < 0)
            )
                throw new Error(
                    `${location}.containerMaxWidth must be a non-negative finite number.`,
                );
            if (
                item.reducedMotion !== undefined &&
                typeof item.reducedMotion !== "boolean"
            ) {
                throw new Error(`${location}.reducedMotion must be a boolean.`);
            }
            return {
                kind: item.kind,
                primary: item.primary,
                style: item.style,
                ...(item.containerMaxWidth !== undefined
                    ? { containerMaxWidth: item.containerMaxWidth }
                    : {}),
                ...(item.secondary !== undefined
                    ? { secondary: item.secondary }
                    : {}),
                ...(item.tag !== undefined ? { tag: item.tag } : {}),
                ...(item.hover !== undefined ? { hover: item.hover } : {}),
                ...(item.focusVisible !== undefined
                    ? { focusVisible: item.focusVisible }
                    : {}),
                ...(item.active !== undefined ? { active: item.active } : {}),
                ...(item.reducedMotion !== undefined
                    ? { reducedMotion: item.reducedMotion }
                    : {}),
                ...(item.range !== undefined ? { range: item.range } : {}),
                ...(item.scrollbar !== undefined
                    ? { scrollbar: item.scrollbar }
                    : {}),
                ...(item.pseudo !== undefined ? { pseudo: item.pseudo } : {}),
                ...(item.maxWidth !== undefined
                    ? { maxWidth: item.maxWidth }
                    : {}),
            };
        },
    );
    return {
        // As given (registry-relative), so the recorded activation site is
        // machine-independent where an absolute resolution would not be.
        sourcePath: path,
        ...(styleRules.length > 0 ? { styleRules } : {}),
        elements: record.elements.map((element, index) =>
            nativeHostUiElement(
                element,
                `Native host UI '${path}' elements[${index}]`,
            ),
        ),
    };
}
