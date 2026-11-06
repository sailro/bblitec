import {
    uiSelectorSequenceIsConditional,
    uiSelectorSequenceTests,
    isUiSelectorState,
    type UiSelectorStep,
} from "./ui-selector.js";
import type { UiGeneratedPart } from "./ui-generated-content.js";
import { parseMediaQuery, type UiMediaConditions } from "./media-query.js";
export type { UiMediaConditions } from "./media-query.js";

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

/**
 * An `@media` prelude's `and` conjunction of features, each named once;
 * undefined for any other query. The device features follow the grammar the
 * native `matchMedia` admits: `prefers-reduced-motion` and `hover` also bare.
 */
export function parseUiMediaQuery(
    prelude: string,
): UiMediaConditions | undefined {
    const query = /^[\t\n\f\r ]*@media[\t\n\f\r ]*(\(.*\))[\t\n\f\r ]*$/is.exec(
        prelude,
    )?.[1];
    return query === undefined ? undefined : parseMediaQuery(query, "sheet");
}

/** What a retained rule applies under: its `@media` features and `@container` width. */
export interface UiRuleConditions extends UiMediaConditions {
    containerMaxWidth?: number;
}

/** Every condition key, which a condition added to `UiRuleConditions` must join. */
const UI_RULE_CONDITION_KEYS: {
    readonly [Key in keyof UiRuleConditions]-?: Key;
} = {
    minWidth: "minWidth",
    maxWidth: "maxWidth",
    minHeight: "minHeight",
    maxHeight: "maxHeight",
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
