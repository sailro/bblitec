/**
 * `clip-path` as RmlUi patch 0043 reads it: none, inset() with one to four
 * lengths, or polygon() with an optional nonzero/evenodd fill rule, over
 * px/% lengths, unitless zero and calc() of them with scalar factors (a
 * runtime substitution standing for a number). Other basic shapes, `round`,
 * reference boxes, url() and var() are not represented.
 */
export function supportedUiClipPath(value: string): boolean {
    const source = value.trim().toLowerCase();
    let offset = 0;
    const space = (): void => {
        while (/\s/.test(source[offset] ?? "")) offset++;
    };
    const take = (token: string): boolean => {
        space();
        if (!source.startsWith(token, offset)) return false;
        offset += token.length;
        return true;
    };
    const keyword = (word: string): boolean => {
        space();
        if (
            !source.startsWith(word, offset) ||
            /[-a-z0-9_]/.test(source[offset + word.length] ?? "")
        )
            return false;
        offset += word.length;
        return true;
    };
    type Term = "length" | "number";
    const number =
        /(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|__bblite_ui_style_\d+__)(px|%)?(?![-a-z0-9_])/y;
    const atom = (inCalc: boolean): Term | undefined => {
        space();
        if (inCalc && (take("(") || (keyword("calc") && take("(")))) {
            const term = sum();
            return term && take(")") ? term : undefined;
        }
        number.lastIndex = offset;
        const match = number.exec(source);
        if (!match) return undefined;
        offset = number.lastIndex;
        if (match[1]) return "length";
        return inCalc || Number(match[0]) === 0 ? "number" : undefined;
    };
    const product = (): Term | undefined => {
        let term = atom(true);
        for (;;) {
            if (!term) return undefined;
            const before = offset;
            space();
            const operator = source[offset];
            if (operator !== "*" && operator !== "/") {
                offset = before;
                return term;
            }
            offset++;
            const other = atom(true);
            if (
                !other ||
                (operator === "*"
                    ? term === "length" && other === "length"
                    : other !== "number")
            )
                return undefined;
            if (other === "length") term = "length";
        }
    };
    const sum = (): Term | undefined => {
        const term = product();
        if (!term) return undefined;
        for (;;) {
            const operator = /^\s+([+-])\s/.exec(source.slice(offset));
            if (!operator) return term;
            offset += operator[0].length;
            if (product() !== term) return undefined;
        }
    };
    const length = (): boolean => {
        space();
        if (keyword("calc")) {
            return take("(") && sum() === "length" && take(")");
        }
        return atom(false) !== undefined;
    };
    if (keyword("none")) return (space(), offset === source.length);
    if (keyword("inset")) {
        if (!take("(")) return false;
        let count = 0;
        while (!take(")")) {
            if (count === 4 || !length()) return false;
            count++;
        }
        if (count === 0) return false;
    } else if (keyword("polygon")) {
        if (!take("(")) return false;
        if ((keyword("nonzero") || keyword("evenodd")) && !take(","))
            return false;
        do if (!length() || !length()) return false;
        while (take(","));
        if (!take(")")) return false;
    } else return false;
    space();
    return offset === source.length;
}
