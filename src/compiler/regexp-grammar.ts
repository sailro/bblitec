/**
 * What lowering reads from a RegExp pattern's grammar, through one tokenizer:
 * an escape is one token with the unit it escapes, a class one token up to
 * its closing `]`, and a group opening says whether it captures.
 */

/** What generation knows of a RegExp value's flags and capture groups. */
export interface RegExpLayout {
    /** The `g` flag. */
    readonly global: boolean;
    /** The `u` flag; absent when unknown. */
    readonly unicode?: boolean;
    /** Capture groups; absent for a pattern only known at run time. */
    readonly captureCount?: number;
    /** Whether a match can leave a capture undefined; absent when unknown. */
    readonly optionalCaptures?: boolean;
}

export type RegExpToken =
    | { readonly kind: "escape" | "atom" | "anchor" | "alternative" }
    | { readonly kind: "class" }
    | {
          readonly kind: "open";
          readonly capturing: boolean;
          /** A negative lookaround: its captures never participate. */
          readonly negative: boolean;
      }
    | {
          readonly kind: "close";
          /** The pattern text after the `)`, where a quantifier follows. */
          readonly rest: string;
      };

/** Calls `visit` with each token of `pattern` in order. */
export function scanRegExpSource(
    pattern: string,
    visit: (token: RegExpToken) => void,
): void {
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index]!;
        if (character === "\\") {
            index++;
            visit({ kind: "escape" });
        } else if (character === "[") {
            for (
                index++;
                index < pattern.length && pattern[index] !== "]";
                index++
            )
                if (pattern[index] === "\\") index++;
            visit({ kind: "class" });
        } else if (character === "|") {
            visit({ kind: "alternative" });
        } else if (character === "(") {
            const head = pattern.slice(index + 1, index + 4);
            visit({
                kind: "open",
                capturing: !head.startsWith("?") || /^\?<[^=!]/.test(head),
                negative: head.startsWith("?!") || head.startsWith("?<!"),
            });
        } else if (character === ")") {
            visit({ kind: "close", rest: pattern.slice(index + 1) });
        } else if (character === "^" || character === "$") {
            visit({ kind: "anchor" });
        } else {
            visit({ kind: "atom" });
        }
    }
}

/** The number of capture groups. The empty first alternative exposes every capture without a matching input. */
export function regexpCaptureCount(pattern: string): number {
    return new RegExp(`|(?:${pattern})`).exec("")!.length - 1;
}

/**
 * Whether a match can leave a capture group unmatched (undefined): a capture
 * inside an alternative, under a quantifier that admits zero repetitions, or
 * inside a negative lookaround. A capture whose own content alternates still
 * participates.
 */
export function regexpCapturesMayBeUnmatched(pattern: string): boolean {
    interface Frame {
        capturing: boolean;
        negative: boolean;
        alternation: boolean;
        captures: number;
    }
    const stack: Frame[] = [
        { capturing: false, negative: false, alternation: false, captures: 0 },
    ];
    let unmatched = false;
    scanRegExpSource(pattern, (token) => {
        const frame = stack.at(-1)!;
        if (token.kind === "alternative") frame.alternation = true;
        else if (token.kind === "open")
            stack.push({
                capturing: token.capturing,
                negative: token.negative,
                alternation: false,
                captures: 0,
            });
        else if (token.kind === "close" && stack.length > 1) {
            const group = stack.pop()!;
            const optional = /^[?*]|^\{0+(?:,\d*)?\}/.test(token.rest);
            const inner = group.captures;
            const own = group.capturing ? 1 : 0;
            if (
                (group.alternation && inner > 0) ||
                ((optional || group.negative) && inner + own > 0)
            )
                unmatched = true;
            stack.at(-1)!.captures += inner + own;
        }
    });
    return unmatched || (stack[0]!.alternation && stack[0]!.captures > 0);
}

/** Whether a pattern has a `^` or `$` assertion (outside classes and escapes). */
export function regexpHasLineAnchor(pattern: string): boolean {
    let anchored = false;
    scanRegExpSource(pattern, (token) => {
        if (token.kind === "anchor") anchored = true;
    });
    return anchored;
}
