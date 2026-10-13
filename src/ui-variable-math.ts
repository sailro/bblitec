import { uiCssFunctionEnd } from "./ui-css-syntax.js";

/** Units the native PAL resolves in CSS math once var() is substituted. */
const variableMathUnits = new Set([
    "px",
    "rem",
    "s",
    "ms",
    "deg",
    "rad",
    "turn",
    "grad",
    ...["vw", "vh", "vmin", "vmax"].flatMap((unit) => [
        unit,
        `s${unit}`,
        `l${unit}`,
        `d${unit}`,
    ]),
]);

/**
 * The first unit a static calc()/min()/max()/clamp() over var() uses that
 * the native math cannot resolve after substitution, or undefined.
 */
export function unresolvableUiVariableMathUnit(
    value: string,
): string | undefined {
    for (const match of value.matchAll(
        /(?<![\w-])(?:calc|min|max|clamp)\(/gi,
    )) {
        const end = uiCssFunctionEnd(value, match.index + match[0].length - 1);
        const body = value.slice(match.index, end);
        if (!/var\(/i.test(body)) continue;
        for (const [, unit] of body.matchAll(
            /(?<![\w-])(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?([a-z]+|%)/gi,
        ))
            if (!variableMathUnits.has(unit!.toLowerCase())) return unit;
    }
    return undefined;
}
