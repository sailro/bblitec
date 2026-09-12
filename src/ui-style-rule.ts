/** The bounded selector forms shared by host-UI validation and projection. */
const UI_STYLE_SELECTOR_DESCRIPTORS = {
    class: {
        cpp: "Class",
        needsSecondary: false,
        needsTag: false,
        css: (rule: UiStyleSelectorShape) => `.${rule.primary}`,
    },
    id: {
        cpp: "Id",
        needsSecondary: false,
        needsTag: false,
        css: (rule: UiStyleSelectorShape) => `#${rule.primary}`,
    },
    "compound-class": {
        cpp: "CompoundClass",
        needsSecondary: true,
        needsTag: false,
        css: (rule: UiStyleSelectorShape) =>
            `.${rule.primary}.${rule.secondary ?? ""}`,
    },
    "class-descendant-tag": {
        cpp: "ClassDescendantTag",
        needsSecondary: false,
        needsTag: true,
        css: (rule: UiStyleSelectorShape) =>
            `.${rule.primary} ${rule.tag ?? ""}`,
    },
    "tag-class": {
        cpp: "TagClass",
        needsSecondary: false,
        needsTag: true,
        css: (rule: UiStyleSelectorShape) =>
            `${rule.tag ?? ""}.${rule.primary}`,
    },
    "tag-child-class": {
        cpp: "TagChildClass",
        needsSecondary: false,
        needsTag: true,
        css: (rule: UiStyleSelectorShape) => `${rule.tag ?? ""} > .${rule.primary}${rule.secondary ? `.${rule.secondary}` : ""}`,
    },
    "tag-attribute": {
        cpp: "TagAttribute",
        needsSecondary: true,
        needsTag: true,
        css: (rule: UiStyleSelectorShape) =>
            `${rule.tag ?? ""}[${rule.primary}="${rule.secondary ?? ""}"]`,
    },
    "id-descendant-class": {
        cpp: "IdDescendantClass",
        needsSecondary: true,
        needsTag: false,
        css: (rule: UiStyleSelectorShape) =>
            `#${rule.primary} .${rule.secondary ?? ""}`,
    },
} as const;

export type UiStyleSelectorKind = keyof typeof UI_STYLE_SELECTOR_DESCRIPTORS;

const UI_SCROLLBAR_PARTS = {
    scrollbar: "Scrollbar",
    thumb: "Thumb",
    track: "Track",
    button: "Button",
    corner: "Corner",
} as const;

export type UiScrollbarPart = keyof typeof UI_SCROLLBAR_PARTS;

export function isUiScrollbarPart(value: unknown): value is UiScrollbarPart {
    return typeof value === "string" && Object.hasOwn(UI_SCROLLBAR_PARTS, value);
}

export function uiScrollbarPartCpp(part: UiScrollbarPart | undefined): string {
    return part === undefined ? "None" : UI_SCROLLBAR_PARTS[part];
}

export interface UiStyleSelectorShape {
    kind: UiStyleSelectorKind;
    primary: string;
    secondary?: string;
    tag?: string;
    hover?: boolean;
    focusVisible?: boolean;
    active?: boolean;
    scrollbar?: UiScrollbarPart;
}

/** Interaction pseudo-classes contribute class specificity and depend on live input state. */
export function uiStyleInteractionStateCount(rule: UiStyleSelectorShape): number {
    return Number(rule.hover === true) + Number(rule.focusVisible === true) + Number(rule.active === true);
}

/** A bounded structural selector imported from the browser host page. */
export interface NativeHostUiStyleRule extends UiStyleSelectorShape {
    maxWidth?: number;
    reducedMotion?: boolean;
    style: string;
}

export function uiStyleRuleHasMedia(rule: { maxWidth?: number; reducedMotion?: boolean }): boolean {
    return rule.maxWidth !== undefined || rule.reducedMotion !== undefined;
}

export function uiMotionPreferenceCpp(value: boolean | undefined): string {
    return value === undefined ? "Any" : value ? "Reduce" : "NoPreference";
}

/** Legacy input spelling; normalized to a generic class rule immediately. */
export interface NativeHostUiClassStyle {
    className: string;
    style: string;
}

export interface NativeHostUiStyleSource {
    classStyles?: NativeHostUiClassStyle[];
    styleRules?: NativeHostUiStyleRule[];
}

export function isUiStyleSelectorKind(
    value: unknown,
): value is UiStyleSelectorKind {
    return (
        typeof value === "string" &&
        Object.hasOwn(UI_STYLE_SELECTOR_DESCRIPTORS, value)
    );
}

export function uiStyleSelectorDescriptor(kind: UiStyleSelectorKind) {
    return UI_STYLE_SELECTOR_DESCRIPTORS[kind];
}

export function uiStyleSelectorCppKind(kind: UiStyleSelectorKind): string {
    return uiStyleSelectorDescriptor(kind).cpp;
}

export function uiStyleSelector(rule: UiStyleSelectorShape): string {
    const base = uiStyleSelectorDescriptor(rule.kind).css(rule) +
        (rule.scrollbar ? `::-webkit-scrollbar${rule.scrollbar === "scrollbar" ? "" : `-${rule.scrollbar}`}` : "");
    return (
        base +
        (rule.hover ? ":hover" : "") +
        (rule.focusVisible ? ":focus-visible" : "") +
        (rule.active ? ":active" : "")
    );
}

/** Preserve legacy public inputs while giving every consumer one rule shape. */
export function nativeHostUiStyleRules(
    source: NativeHostUiStyleSource,
): NativeHostUiStyleRule[] {
    return [
        ...(source.classStyles ?? []).map(
            ({ className, style }): NativeHostUiStyleRule => ({
                kind: "class",
                primary: className,
                style,
            }),
        ),
        ...(source.styleRules ?? []),
    ];
}
