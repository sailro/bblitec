// A `u`-flag pattern, rewritten for the runtime's UTF-16 ECMAScript engine
// (`bbl::js::RegExp` over std::wregex). Every atom becomes an alternation
// over UTF-16 units that consumes whole code points: an astral code point is
// its surrogate pair, a lone lead surrogate one not followed by a trail. The
// runtime starts matches only at code point boundaries, so a trail surrogate
// an atom meets is a lone one. The set of code points an atom matches is
// read from the JavaScript engine itself (`codePointRanges`), so classes,
// property escapes and case folding under `iu` are the language's own.

type Range = readonly [first: number, last: number];

const LAST_CODE_POINT = 0x10ffff;
const ranges = new Map<string, readonly Range[]>();
let codePoints: readonly string[] | undefined;

/** The code points an atom matches, as sorted inclusive ranges. */
function codePointRanges(atom: string, ignoreCase: boolean): readonly Range[] {
    const key = `${ignoreCase ? "i" : "-"}${atom}`;
    const cached = ranges.get(key);
    if (cached) return cached;
    codePoints ??= Array.from({ length: LAST_CODE_POINT + 1 }, (_, point) =>
        String.fromCodePoint(point),
    );
    const matcher = new RegExp(`^(?:${atom})$`, ignoreCase ? "iu" : "u");
    const found: Range[] = [];
    let first = -1;
    codePoints.forEach((text, point) => {
        if (matcher.test(text)) {
            if (first < 0) first = point;
        } else if (first >= 0) {
            found.push([first, point - 1]);
            first = -1;
        }
    });
    if (first >= 0) found.push([first, LAST_CODE_POINT]);
    ranges.set(key, found);
    return found;
}

const hex = (unit: number): string =>
    `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;

/** A UTF-16 unit as a pattern character: ASCII letters and digits as themselves. */
function unitText(unit: number): string {
    return /^[A-Za-z0-9]$/.test(String.fromCharCode(unit))
        ? String.fromCharCode(unit)
        : hex(unit);
}

function unitClass(units: readonly Range[]): string {
    return `[${units.map(([first, last]) => (first === last ? hex(first) : `${hex(first)}-${hex(last)}`)).join("")}]`;
}

function clip(set: readonly Range[], low: number, high: number): Range[] {
    return set.flatMap(([first, last]): Range[] =>
        last < low || first > high
            ? []
            : [[Math.max(first, low), Math.min(last, high)]],
    );
}

const TRAILS = "[\\uDC00-\\uDFFF]";

/** One alternation over UTF-16 units matching exactly the code points of `set`. */
function codePointAlternation(set: readonly Range[]): string {
    const alternatives: string[] = [];
    const basic = [...clip(set, 0, 0xd7ff), ...clip(set, 0xe000, 0xffff)];
    if (basic.length) alternatives.push(unitClass(basic));
    const leads = clip(set, 0xd800, 0xdbff);
    if (leads.length) alternatives.push(`${unitClass(leads)}(?!${TRAILS})`);
    const trails = clip(set, 0xdc00, 0xdfff);
    if (trails.length) alternatives.push(unitClass(trails));
    // Astral code points by lead surrogate; leads sharing one trail range join.
    const pairs: { leads: [number, number]; trails: Range }[] = [];
    for (const [first, last] of clip(set, 0x10000, LAST_CODE_POINT)) {
        const lead = (point: number): number =>
            0xd800 + ((point - 0x10000) >> 10);
        const trail = (point: number): number =>
            0xdc00 + ((point - 0x10000) & 0x3ff);
        const add = (from: number, to: number, units: Range): void => {
            const previous = pairs.at(-1);
            if (
                previous &&
                previous.leads[1] + 1 === from &&
                previous.trails[0] === units[0] &&
                previous.trails[1] === units[1]
            )
                previous.leads[1] = to;
            else pairs.push({ leads: [from, to], trails: units });
        };
        if (lead(first) === lead(last)) {
            add(lead(first), lead(first), [trail(first), trail(last)]);
            continue;
        }
        add(lead(first), lead(first), [trail(first), 0xdfff]);
        if (lead(first) + 1 < lead(last))
            add(lead(first) + 1, lead(last) - 1, [0xdc00, 0xdfff]);
        add(lead(last), lead(last), [0xdc00, trail(last)]);
    }
    for (const { leads: pairLeads, trails: pairTrails } of pairs)
        alternatives.push(
            `${pairLeads[0] === pairLeads[1] ? hex(pairLeads[0]) : unitClass([pairLeads])}${unitClass([pairTrails])}`,
        );
    if (alternatives.length === 0) return "(?!)";
    return alternatives.length === 1 && /^\[[^\]]*\]$/.test(alternatives[0]!)
        ? alternatives[0]!
        : `(?:${alternatives.join("|")})`;
}

/** One code point outside case folding: itself, as whole units. */
function codePointText(point: number): string {
    if (point >= 0x10000)
        return `(?:${hex(0xd800 + ((point - 0x10000) >> 10))}${hex(0xdc00 + ((point - 0x10000) & 0x3ff))})`;
    if (point >= 0xd800 && point <= 0xdbff)
        return `(?:${hex(point)}(?!${TRAILS}))`;
    return unitText(point);
}

const CONTROL_ESCAPES: Readonly<Record<string, number>> = {
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
};

/** A character escape at `index`: its code point and source length. */
function characterEscape(pattern: string, index: number): [number, number] {
    const letter = pattern[index + 1]!;
    const control = CONTROL_ESCAPES[letter];
    if (control !== undefined) return [control, 2];
    if (letter === "0") return [0, 2];
    if (letter === "c") return [pattern.charCodeAt(index + 2) % 32, 3];
    if (letter === "x")
        return [parseInt(pattern.slice(index + 2, index + 4), 16), 4];
    if (letter === "u") {
        if (pattern[index + 2] === "{") {
            const close = pattern.indexOf("}", index);
            return [
                parseInt(pattern.slice(index + 3, close), 16),
                close + 1 - index,
            ];
        }
        const unit = parseInt(pattern.slice(index + 2, index + 6), 16);
        const pair = /^\\u([0-9A-Fa-f]{4})/.exec(pattern.slice(index + 6));
        const trail = pair ? parseInt(pair[1]!, 16) : -1;
        if (
            unit >= 0xd800 &&
            unit <= 0xdbff &&
            trail >= 0xdc00 &&
            trail <= 0xdfff
        )
            return [0x10000 + ((unit - 0xd800) << 10) + (trail - 0xdc00), 12];
        return [unit, 6];
    }
    return [pattern.codePointAt(index + 1)!, 2];
}

/** The index just past the character class opening at `index`. */
function classEnd(pattern: string, index: number): number {
    for (let at = index + 1; at < pattern.length; at++) {
        if (pattern[at] === "\\") at++;
        else if (pattern[at] === "]") return at + 1;
    }
    return pattern.length;
}

/**
 * The UTF-16 pattern of a valid `u`-flag `pattern` (flags `g`, `i`, `u`), or
 * the refusal of a construct the runtime engine cannot express.
 */
export function unicodeUnitPattern(
    pattern: string,
    ignoreCase: boolean,
): { pattern: string } | { refusal: string } {
    try {
        new RegExp(pattern, ignoreCase ? "iu" : "u");
    } catch (error) {
        return {
            refusal: `Invalid u-flag RegExp pattern: ${(error as Error).message}`,
        };
    }
    const set = (atom: string): string =>
        codePointAlternation(codePointRanges(atom, ignoreCase));
    let output = "";
    for (let index = 0; index < pattern.length;) {
        const character = pattern[index]!;
        if (character === "\\") {
            const letter = pattern[index + 1]!;
            if ("dDwWsS".includes(letter)) {
                output += set(pattern.slice(index, index + 2));
                index += 2;
            } else if (letter === "p" || letter === "P") {
                const close = pattern.indexOf("}", index) + 1;
                output += set(pattern.slice(index, close));
                index = close;
            } else if (letter === "b" || letter === "B") {
                if (ignoreCase)
                    return {
                        refusal:
                            "A word boundary under the i and u flags reads case-folded word characters, which the runtime engine does not.",
                    };
                output += `\\${letter}`;
                index += 2;
            } else if (/[1-9]/.test(letter)) {
                if (ignoreCase)
                    return {
                        refusal:
                            "A backreference under the i and u flags compares case-folded code points, which the runtime engine does not.",
                    };
                const digits = /^\d+/.exec(pattern.slice(index + 1))![0];
                output += `\\${digits}`;
                index += 1 + digits.length;
            } else if (letter === "k") {
                return {
                    refusal:
                        "Named backreferences are not lowered in u-flag RegExp patterns.",
                };
            } else {
                const [point, length] = characterEscape(pattern, index);
                output += ignoreCase
                    ? set(pattern.slice(index, index + length))
                    : codePointText(point);
                index += length;
            }
        } else if (character === "[") {
            const end = classEnd(pattern, index);
            output += set(pattern.slice(index, end));
            index = end;
        } else if (character === ".") {
            output += set(".");
            index += 1;
        } else if (character === "(") {
            if (
                pattern.startsWith("(?<=", index) ||
                pattern.startsWith("(?<!", index)
            )
                return {
                    refusal:
                        "Lookbehind assertions are not lowered in u-flag RegExp patterns.",
                };
            if (pattern.startsWith("(?<", index))
                return {
                    refusal:
                        "Named groups are not lowered in u-flag RegExp patterns.",
                };
            const group = /^\(\?[:=!]/.test(pattern.slice(index)) ? 3 : 1;
            output += pattern.slice(index, index + group);
            index += group;
        } else if (character === "{") {
            // A quantifier: a u-flag pattern has no literal brace.
            const close = pattern.indexOf("}", index) + 1;
            output += pattern.slice(index, close);
            index = close;
        } else if (")|^$*+?".includes(character)) {
            output += character;
            index += 1;
        } else {
            const point = pattern.codePointAt(index)!;
            const length = point > 0xffff ? 2 : 1;
            output += ignoreCase
                ? set(pattern.slice(index, index + length))
                : codePointText(point);
            index += length;
        }
    }
    return { pattern: output };
}
