import { splitUiCssList, uiCssValueTokens } from "./ui-css-syntax.js";

/** A finite CSS `<number>` token's value, else undefined. */
function cssNumber(token: string): number | undefined {
    if (!/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(token)) return undefined;
    const number = Number(token);
    return Number.isFinite(number) ? number : undefined;
}

/** A CSS `<time>` token's seconds (`s` or `ms`), else undefined. */
function cssTime(token: string): number | undefined {
    const unit = /^(.*?)(m?s)$/i.exec(token);
    const number = unit ? cssNumber(unit[1]!) : undefined;
    return number === undefined
        ? undefined
        : number / (unit![2]!.toLowerCase() === "ms" ? 1000 : 1);
}

/**
 * Why a duration token is not represented, or undefined. CSS durations are
 * times that are not negative (RmlUi patch 0046 parses the same), and RmlUi
 * runs a zero-length animation wrongly (an infinite one never ends).
 */
function unrepresentedUiDuration(
    token: string,
    animation: boolean,
): string | undefined {
    const seconds = cssTime(token);
    if (seconds === undefined || seconds < 0)
        return "a duration is a time that is not negative";
    return animation && seconds === 0
        ? "zero-duration animations are not represented"
        : undefined;
}

/**
 * Why a static transition/animation value's easing functions are outside
 * what the RmlUi animation parser represents, or undefined. Arguments that
 * carry a runtime substitution are left to the native parser.
 */
export function unrepresentedUiEasing(value: string): string | undefined {
    for (const [, name, body] of value.matchAll(
        /([a-z][a-z0-9-]*)\(([^()]*)\)/gi,
    )) {
        const fn = name!.toLowerCase();
        const args = body!.split(",").map((part) => part.trim().toLowerCase());
        if (fn === "linear")
            return "linear() easing functions are not represented";
        if (args.some((part) => part.includes("__bblite_ui_"))) continue;
        if (fn === "cubic-bezier") {
            const points = args.map(cssNumber);
            if (
                points.length !== 4 ||
                !points.every((point) => point !== undefined) ||
                points[0]! < 0 ||
                points[0]! > 1 ||
                points[2]! < 0 ||
                points[2]! > 1
            )
                return "cubic-bezier() takes four numbers with x1 and x2 in [0, 1]";
        } else if (fn === "steps") {
            const position = args[1] ?? "end";
            const count = Number(args[0]);
            if (
                args.length > 2 ||
                !/^\+?\d+$/.test(args[0] ?? "") ||
                count > 1e6 ||
                ![
                    "start",
                    "end",
                    "jump-start",
                    "jump-end",
                    "jump-none",
                    "jump-both",
                ].includes(position) ||
                count < (position === "jump-none" ? 2 : 1)
            )
                return "steps() takes a positive integer count (at least 2 for jump-none) and a step position";
        }
    }
    return undefined;
}

/**
 * Why a static `transition-duration` or `animation-duration` list is outside
 * what the RmlUi duration longhands represent, or undefined: `auto` or
 * durations. A runtime substitution is left to the native parser.
 */
export function unrepresentedUiDurations(
    value: string,
    animation: boolean,
): string | undefined {
    if (/^auto$/i.test(value.trim())) return undefined;
    for (const item of splitUiCssList(value)) {
        if (/var\(|__bblite_ui_/i.test(item)) continue;
        const reason = unrepresentedUiDuration(item.trim(), animation);
        if (reason) return reason;
    }
    return undefined;
}

/**
 * Why a static animation shorthand is outside what the RmlUi animation
 * parser represents, or undefined. Each keyword fills the first longhand it
 * is valid for that is still unset, else names the animation (CSS).
 */
export function unrepresentedUiAnimation(value: string): string | undefined {
    const categories: readonly (readonly [string, readonly string[]])[] = [
        [
            "easing",
            [
                "linear",
                "ease",
                "ease-in",
                "ease-out",
                "ease-in-out",
                "step-start",
                "step-end",
            ],
        ],
        ["iterations", ["infinite"]],
        ["direction", ["normal", "reverse", "alternate", "alternate-reverse"]],
        ["fill", ["none", "forwards", "backwards", "both"]],
        ["state", ["running", "paused"]],
    ];
    for (const item of splitUiCssList(value)) {
        const tokens = uiCssValueTokens(item) ?? [];
        if (tokens.some((token) => /var\(|__bblite_ui_/i.test(token))) continue;
        const taken = new Set<string>();
        const times: string[] = [];
        let name: string | undefined;
        for (const token of tokens) {
            const lower = token.toLowerCase();
            const count = cssNumber(lower);
            if (lower.includes("(")) taken.add("easing");
            else if (cssTime(lower) !== undefined) times.push(lower);
            else if (count !== undefined) {
                if (!Number.isInteger(count) || count < 1)
                    return "only whole iteration counts of at least 1 are represented";
                taken.add("iterations");
            } else {
                const category = categories.find(
                    ([key, words]) => !taken.has(key) && words.includes(lower),
                )?.[0];
                if (category) taken.add(category);
                else name = lower;
                if (category === "state" && lower === "paused")
                    return "paused animations are not represented";
            }
        }
        if (name !== undefined && name !== "none") {
            const reason = unrepresentedUiDuration(times[0] ?? "0s", true);
            if (reason) return reason;
        }
    }
    return undefined;
}
