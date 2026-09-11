const magnitude = String.raw`(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const number = String.raw`\+?${magnitude}`;
const lengthUnit = "(?:px|em|rem|vw|vh|in|cm|mm|pt|pc|%)";
const length = String.raw`(?:${number}${lengthUnit}|[+]?0)`;
const signedLength = String.raw`(?:[+-]?${magnitude}${lengthUnit}|[+-]?0)`;
const basis = `(?:auto|${length})`;
const direction = "(?:row|row-reverse|column|column-reverse)";
const wrap = "(?:nowrap|wrap|wrap-reverse)";

/** Values whose layout is represented by the pinned flex and box formatters. */
const layoutValues: ReadonlyMap<string, RegExp> = new Map([
    ["align-content", /^(?:start|end|flex-start|flex-end|center|space-between|space-around|space-evenly|stretch)$/],
    ["align-self", /^(?:auto|start|end|flex-start|flex-end|center|baseline|stretch)$/],
    ["flex", new RegExp(`^(?:none|initial|auto|${number}(?:\\s+${number})?(?:\\s+${basis})?|${length})$`)],
    ["flex-basis", new RegExp(`^${basis}$`)],
    ["flex-grow", new RegExp(`^${number}$`)],
    ["flex-shrink", new RegExp(`^${number}$`)],
    ["flex-wrap", new RegExp(`^${wrap}$`)],
    ["flex-flow", new RegExp(`^(?:${direction}(?:\\s+${wrap})?|${wrap}(?:\\s+${direction})?)$`)],
    ...["row-gap", "column-gap", "padding-top", "padding-right", "padding-bottom", "padding-left"]
        .map((property): [string, RegExp] => [property, new RegExp(`^${length}$`)]),
    ...["margin-left", "margin-right"]
        .map((property): [string, RegExp] => [property, new RegExp(`^(?:auto|${signedLength})$`)]),
]);

/** Property membership is independent of value validation. */
export function isUiLayoutProperty(property: string): boolean {
    return layoutValues.has(property);
}

/** Undefined denotes properties reviewed elsewhere. */
export function supportedUiLayoutValue(property: string, value: string): boolean | undefined {
    const pattern = layoutValues.get(property);
    if (!pattern) return undefined;
    const text = value.trim().toLowerCase();
    return pattern.test(text) && [...text.matchAll(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/g)]
        .every(match => Number.isFinite(Math.fround(Number(match[0]))));
}
