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
