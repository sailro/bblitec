// Tagged templates: `tag\`a${x}b\`` calls `tag` with the site's strings
// array -- frozen, created once per site and realm, its `raw` array beside
// it -- followed by the substitutions, evaluated left to right.
// `String.raw` is the concatenation of the raw strings and substitutions.
import ts from "typescript";
import { declaredInDefaultLibrary } from "./symbols.js";

/** Whether an expression is typed as a tagged template's strings array. */
export function isTemplateStringsArray(
    checker: ts.TypeChecker,
    expression: ts.Expression,
): boolean {
    const { symbol } = checker.getTypeAtLocation(expression);
    return (
        symbol?.name === "TemplateStringsArray" &&
        declaredInDefaultLibrary(symbol)
    );
}

/** One template's literal parts, cooked and raw, and its substitutions. */
export interface TemplateParts {
    readonly cooked: readonly string[];
    readonly raw: readonly string[];
    readonly substitutions: readonly ts.Expression[];
}

/** A literal part's source text between its delimiters, line ends as LF. */
function rawText(
    part: ts.TemplateLiteralLikeNode,
    opening: number,
    closing: number,
): string {
    const text = part.rawText ?? part.getText().slice(opening, -closing);
    return text.replace(/\r\n?/g, "\n");
}

/**
 * Whether a raw part holds an escape with no cooked value (`\1`, `\x4`,
 * `\u{110000}`): its cooked string is `undefined`.
 */
function hasInvalidEscape(raw: string): boolean {
    for (let index = 0; index < raw.length; index += 1) {
        if (raw[index] !== "\\") continue;
        const next = raw[index + 1] ?? "";
        const rest = raw.slice(index + 2);
        if (/[1-9]/.test(next) || (next === "0" && /^[0-9]/.test(rest)))
            return true;
        if (next === "x" && !/^[0-9a-fA-F]{2}/.test(rest)) return true;
        if (next === "u") {
            const braced = /^\{([0-9a-fA-F]+)\}/.exec(rest);
            if (braced) {
                if (Number.parseInt(braced[1]!, 16) > 0x10ffff) return true;
            } else if (!/^[0-9a-fA-F]{4}/.test(rest)) return true;
        }
        index += 1;
    }
    return false;
}

/**
 * The literal parts of a template. A part whose escape has no cooked value
 * answers `undefined`: the strings array would hold `undefined` there.
 */
export function templateParts(
    template: ts.TemplateLiteral,
): TemplateParts | undefined {
    const literals: { part: ts.TemplateLiteralLikeNode; closing: number }[] =
        ts.isNoSubstitutionTemplateLiteral(template)
            ? [{ part: template, closing: 1 }]
            : [
                  { part: template.head, closing: 2 },
                  ...template.templateSpans.map((span) => ({
                      part: span.literal,
                      closing: ts.isTemplateTail(span.literal) ? 1 : 2,
                  })),
              ];
    const raw = literals.map(({ part, closing }) => rawText(part, 1, closing));
    if (raw.some(hasInvalidEscape)) return undefined;
    return {
        cooked: literals.map(({ part }) => part.text),
        raw,
        substitutions: ts.isNoSubstitutionTemplateLiteral(template)
            ? []
            : template.templateSpans.map((span) => span.expression),
    };
}
