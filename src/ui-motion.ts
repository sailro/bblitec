/**
 * Why a static transition/animation value's easing functions are outside
 * what the RmlUi animation parser represents, or undefined. Arguments that
 * carry a runtime substitution are left to the native parser.
 */
export function unrepresentedUiEasing(value: string): string | undefined {
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    for (const [, name, body] of value.matchAll(
        /([a-z][a-z0-9-]*)\(([^()]*)\)/gi,
    )) {
        const fn = name!.toLowerCase();
        const args = body!.split(",").map((part) => part.trim().toLowerCase());
        if (fn === "linear")
            return "linear() easing functions are not represented";
        if (args.some((part) => part.includes("__bblite_ui_"))) continue;
        if (fn === "cubic-bezier") {
            const points = args.map(Number);
            if (
                args.length !== 4 ||
                !args.every((part) => number.test(part)) ||
                !points.every(Number.isFinite) ||
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

/** Split at a separator outside parentheses and quotes. */
function splitTopLevel(text: string, separator: RegExp): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let index = 0; index <= text.length; index++) {
        const character = text[index] ?? "";
        if (quote) {
            if (character === quote) quote = "";
        } else if (character === '"' || character === "'") quote = character;
        else if (character === "(") depth++;
        else if (character === ")") depth--;
        else if (
            index === text.length ||
            (depth === 0 && separator.test(character))
        ) {
            parts.push(text.slice(start, index).trim());
            start = index + 1;
        }
    }
    return parts.filter((part) => part.length > 0);
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
    for (const item of splitTopLevel(value, /,/)) {
        const tokens = splitTopLevel(item, /\s/);
        if (tokens.some((token) => /var\(|__bblite_ui_/i.test(token))) continue;
        const taken = new Set<string>();
        const times: number[] = [];
        let name: string | undefined;
        for (const token of tokens) {
            const lower = token.toLowerCase();
            const time =
                /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(m?s)$/i.exec(
                    lower,
                );
            if (lower.includes("(")) taken.add("easing");
            else if (time)
                times.push(Number(time[1]) / (time[2] === "ms" ? 1000 : 1));
            else if (
                /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(lower)
            ) {
                const count = Number(lower);
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
        if (name !== undefined && name !== "none" && !((times[0] ?? 0) > 0))
            return "only animations with a positive duration are represented";
    }
    return undefined;
}
