import {
    uiSelectorSequenceIsConditional,
    uiSelectorSequenceTests,
    isUiSelectorState,
    type UiSelectorStep,
} from "./ui-selector.js";
import type { UiGeneratedPart } from "./ui-generated-content.js";

/** The bounded selector forms projection lowers, by their `UiStyleSelectorKind` spelling. */
const UI_STYLE_SELECTOR_KINDS = {
    sequence: "Sequence",
    class: "Class",
    id: "Id",
    "compound-class": "CompoundClass",
    "class-descendant-tag": "ClassDescendantTag",
    "tag-class": "TagClass",
    "tag-child-class": "TagChildClass",
    "id-descendant-class": "IdDescendantClass",
} as const;

export type UiStyleSelectorKind = keyof typeof UI_STYLE_SELECTOR_KINDS;

const UI_SCROLLBAR_PARTS = {
    scrollbar: "Scrollbar",
    thumb: "Thumb",
    track: "Track",
    button: "Button",
    corner: "Corner",
} as const;

type UiScrollbarPart = keyof typeof UI_SCROLLBAR_PARTS;

export function isUiScrollbarPart(value: unknown): value is UiScrollbarPart {
    return (
        typeof value === "string" && Object.hasOwn(UI_SCROLLBAR_PARTS, value)
    );
}

export function uiScrollbarPartCpp(part: UiScrollbarPart | undefined): string {
    return part === undefined ? "None" : UI_SCROLLBAR_PARTS[part];
}

const UI_RANGE_PARTS = { thumb: "Thumb", track: "Track" } as const;
type UiRangePart = keyof typeof UI_RANGE_PARTS;
export function uiRangePartCpp(part: UiRangePart | undefined): string {
    return part === undefined ? "None" : UI_RANGE_PARTS[part];
}

interface UiStyleSelectorParts {
    primary: string;
    secondary?: string;
    tag?: string;
    hover?: boolean;
    focusVisible?: boolean;
    active?: boolean;
    scrollbar?: UiScrollbarPart;
    range?: UiRangePart;
    pseudo?: UiGeneratedPart;
}

/** A rule's selector: a bounded form, or a sequence with its parsed steps. */
export type UiStyleSelectorShape = UiStyleSelectorParts &
    (
        | {
              kind: Exclude<UiStyleSelectorKind, "sequence">;
              sequence?: undefined;
          }
        | { kind: "sequence"; sequence: readonly UiSelectorStep[] }
    );

/** Interaction pseudo-classes contribute class specificity and depend on live input state. */
export function uiStyleInteractionStateCount(
    rule: UiStyleSelectorShape,
): number {
    return (
        Number(rule.hover === true) +
        Number(rule.focusVisible === true) +
        Number(rule.active === true) +
        (rule.kind === "sequence"
            ? [...uiSelectorSequenceTests(rule.sequence)].filter((test) =>
                  isUiSelectorState(test.kind),
              ).length
            : 0)
    );
}

export function uiStyleRuleNeedsRuntimeMatch(
    rule: UiStyleSelectorShape,
): boolean {
    return (
        uiStyleInteractionStateCount(rule) > 0 ||
        (rule.kind === "sequence" &&
            uiSelectorSequenceIsConditional(rule.sequence))
    );
}

/** The media features a retained sheet's `@media` query conjoins. */
export interface UiMediaConditions {
    maxWidth?: number;
    reducedMotion?: boolean;
    orientation?: "portrait" | "landscape";
    /** The primary pointing device's features, which the device answers at run time. */
    mediaHover?: boolean;
    mediaPointer?: "none" | "coarse" | "fine";
}

/** The value a bare device feature evaluates as (`(hover)` is `(hover: hover)`). */
const UI_BARE_MEDIA_FEATURES: ReadonlyMap<string, string> = new Map([
    ["prefers-reduced-motion", "reduce"],
    ["hover", "hover"],
]);

/**
 * An `@media` prelude's `and` conjunction of features, each named once;
 * undefined for any other query. The device features follow the grammar the
 * native `matchMedia` admits: `prefers-reduced-motion` and `hover` also bare.
 */
export function parseUiMediaQuery(
    prelude: string,
): UiMediaConditions | undefined {
    let rest = /^@media\s*(\(.*\))$/is.exec(prelude.trim())?.[1];
    const conditions: UiMediaConditions = {};
    const named = new Set<string>();
    while (rest !== undefined) {
        const feature = /^\(\s*([a-z-]+)\s*(?::\s*([^()]*?)\s*)?\)/i.exec(rest);
        if (!feature) return undefined;
        const name = feature[1]!.toLowerCase();
        const value =
            feature[2]?.toLowerCase() ?? UI_BARE_MEDIA_FEATURES.get(name);
        if (value === undefined) return undefined;
        if (named.has(name)) return undefined;
        named.add(name);
        const width = Number(/^([0-9]+(?:\.[0-9]*)?)px$/.exec(value)?.[1]);
        if (name === "max-width" && Number.isFinite(width))
            conditions.maxWidth = width;
        else if (
            name === "orientation" &&
            (value === "portrait" || value === "landscape")
        )
            conditions.orientation = value;
        else if (
            name === "prefers-reduced-motion" &&
            (value === "reduce" || value === "no-preference")
        )
            conditions.reducedMotion = value === "reduce";
        else if (name === "hover" && (value === "hover" || value === "none"))
            conditions.mediaHover = value === "hover";
        else if (
            name === "pointer" &&
            (value === "none" || value === "coarse" || value === "fine")
        )
            conditions.mediaPointer = value;
        else return undefined;
        rest = rest.slice(feature[0].length);
        if (!rest.trim()) return conditions;
        const and = /^\s+and\s+/i.exec(rest);
        rest = and ? rest.slice(and[0].length) : undefined;
    }
    return undefined;
}

/** What a retained rule applies under: its `@media` features and `@container` width. */
export interface UiRuleConditions extends UiMediaConditions {
    containerMaxWidth?: number;
}

/** Every condition key, which a condition added to `UiRuleConditions` must join. */
const UI_RULE_CONDITION_KEYS: {
    readonly [Key in keyof UiRuleConditions]-?: Key;
} = {
    maxWidth: "maxWidth",
    reducedMotion: "reducedMotion",
    orientation: "orientation",
    mediaHover: "mediaHover",
    mediaPointer: "mediaPointer",
    containerMaxWidth: "containerMaxWidth",
};

export function uiStyleRuleHasConditions(rule: UiRuleConditions): boolean {
    return Object.values(UI_RULE_CONDITION_KEYS).some(
        (key) => rule[key] !== undefined,
    );
}

const UI_POINTER_PRECISIONS = {
    none: "None",
    coarse: "Coarse",
    fine: "Fine",
} as const;
export function uiPointerPrecisionCpp(
    value: keyof typeof UI_POINTER_PRECISIONS,
): string {
    return UI_POINTER_PRECISIONS[value];
}

export function uiStyleSelectorCppKind(kind: UiStyleSelectorKind): string {
    return UI_STYLE_SELECTOR_KINDS[kind];
}
