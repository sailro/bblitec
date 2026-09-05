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
    "id-descendant-class": {
        cpp: "IdDescendantClass",
        needsSecondary: true,
        needsTag: false,
        css: (rule: UiStyleSelectorShape) =>
            `#${rule.primary} .${rule.secondary ?? ""}`,
    },
} as const;

export type UiStyleSelectorKind = keyof typeof UI_STYLE_SELECTOR_DESCRIPTORS;

export interface UiStyleSelectorShape {
    kind: UiStyleSelectorKind;
    primary: string;
    secondary?: string;
    tag?: string;
    hover?: boolean;
    focusVisible?: boolean;
}

/** A bounded structural selector imported from the browser host page. */
export interface NativeHostUiStyleRule extends UiStyleSelectorShape {
    maxWidth?: number;
    style: string;
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
    const base = uiStyleSelectorDescriptor(rule.kind).css(rule);
    return (
        base +
        (rule.hover ? ":hover" : "") +
        (rule.focusVisible ? ":focus-visible" : "")
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
