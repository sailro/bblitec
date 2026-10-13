import ts from "typescript";
import {
    parseUiSelectorSequence,
    parseUiSelectorTemplate,
    splitUiSelectorList,
    uiSelectorSequenceCpp,
    type UiSelectorStep,
    type UiSelectorTemplateValue,
} from "../ui-selector.js";
import { stringConcatPart } from "./expressions.js";
import type { LoweringServices } from "./lowering-services.js";
import type { UiProjection } from "./ui-projection.js";

type Context = Pick<
    LoweringServices,
    | "absenceTags"
    | "allocateTemporaryCppName"
    | "checker"
    | "compileValue"
    | "cppString"
    | "dataTypes"
    | "emit"
    | "evaluator"
    | "fail"
    | "probeEmission"
    | "reachJsData"
    | "unwrap"
>;

/** Literal selectors one runtime choice may name (`a ? ".x" : ".y"`). */
const UI_SELECTOR_CHOICES = 32;

/**
 * A retained query's selector argument, parsed at generation by the
 * grammar literal selectors use: a literal; a template whose runtime texts
 * fill quoted attribute values (checked by `bbl::ui_selector_value`); or a
 * union of literal selectors chosen at runtime (`bbl::ui_selector_choice`).
 */
export type UiQuerySelector =
    | { kind: "literal"; sequences: UiSelectorStep[][] }
    | {
          kind: "template";
          holes: ts.Expression[];
          sequences: UiSelectorStep[][];
          values: UiSelectorTemplateValue[];
      }
    | { kind: "choice"; candidates: string[]; lists: UiSelectorStep[][][] };

function literalSequences(
    context: Pick<Context, "fail">,
    site: ts.Node,
    source: string,
): UiSelectorStep[][] {
    const sequences = splitUiSelectorList(source).map(
        (part) =>
            parseUiSelectorSequence(part, { preserveNames: true }) ??
            context.fail(
                site,
                `Retained DOM query selector '${part}' is not lowered.`,
            ),
    );
    if (!sequences.length)
        context.fail(site, "Retained DOM query requires a selector.");
    return sequences;
}

/** Static texts and runtime operands of a template or string concatenation. */
function selectorTemplateParts(
    context: Pick<
        Context,
        "checker" | "evaluator" | "probeEmission" | "unwrap"
    >,
    expression: ts.Expression,
): { texts: string[]; holes: ts.Expression[] } | undefined {
    const texts = [""];
    const holes: ts.Expression[] = [];
    const operand = (node: ts.Expression): void => {
        const text = context.probeEmission(() =>
            context.evaluator.staticTextValue(node),
        );
        if (text !== undefined) texts[texts.length - 1] += text;
        else if (!collect(node)) {
            holes.push(node);
            texts.push("");
        }
    };
    const collect = (node: ts.Expression): boolean => {
        const current = context.unwrap(node);
        if (ts.isTemplateExpression(current)) {
            texts[texts.length - 1] += current.head.text;
            for (const span of current.templateSpans) {
                operand(span.expression);
                texts[texts.length - 1] += span.literal.text;
            }
            return true;
        }
        // A nested `+` joins the text only when its own result is a string.
        if (
            ts.isBinaryExpression(current) &&
            current.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            (context.checker.getTypeAtLocation(current).flags &
                ts.TypeFlags.StringLike) !==
                0
        ) {
            operand(current.left);
            operand(current.right);
            return true;
        }
        return false;
    };
    return collect(expression) ? { texts, holes } : undefined;
}

export function classifyUiQuerySelector(
    context: Context,
    ui: Pick<UiProjection, "tryUiStaticString">,
    argument: ts.Expression,
    site: ts.Node,
): UiQuerySelector {
    const literal = ui.tryUiStaticString(argument);
    if (literal !== undefined)
        return {
            kind: "literal",
            sequences: literalSequences(context, site, literal),
        };
    const template = selectorTemplateParts(context, argument);
    if (template && !template.holes.length)
        return {
            kind: "literal",
            sequences: literalSequences(context, site, template.texts[0]!),
        };
    if (template) {
        const parsed = parseUiSelectorTemplate(template.texts);
        if (typeof parsed === "string")
            context.fail(
                site,
                `Retained DOM query selector template '${template.texts.join("${…}")}' is not lowered: ${parsed}.`,
            );
        return { kind: "template", holes: template.holes, ...parsed };
    }
    const type = context.checker.getTypeAtLocation(argument);
    const members = type.isUnion() ? type.types : [type];
    const literals = members.filter((member) => member.isStringLiteral());
    if (
        literals.length === members.length &&
        literals.length <= UI_SELECTOR_CHOICES
    ) {
        const candidates = literals.map((member) => member.value);
        return {
            kind: "choice",
            candidates,
            lists: candidates.map((candidate) =>
                literalSequences(context, site, candidate),
            ),
        };
    }
    return context.fail(
        site,
        "Retained DOM query selectors must be literal, a template whose runtime text fills quoted attribute values, or a union of at most 32 literal selectors.",
    );
}

/**
 * The selector list as C++. A template evaluates its runtime texts in
 * order, then checks each attribute value they fill; a choice evaluates
 * the selector text once and selects its literal list.
 */
export function uiQuerySelectorCpp(
    context: Context,
    ui: Pick<UiProjection, "uiStringCpp">,
    selector: UiQuerySelector,
    argument: ts.Expression,
): string {
    const quote = (text: string): string => context.cppString(text);
    const list = (
        sequences: readonly UiSelectorStep[][],
        value = quote,
        capturing = false,
    ): string =>
        `{${sequences.map((sequence) => uiSelectorSequenceCpp(sequence, value, capturing)).join(", ")}}`;
    if (selector.kind === "literal") return list(selector.sequences);
    context.reachJsData();
    if (selector.kind === "choice") {
        const choice = context.allocateTemporaryCppName("selector_choice");
        context.emit({
            kind: "declaration",
            type: "const std::size_t",
            name: choice,
            initializer: `bbl::ui_selector_choice(${ui.uiStringCpp(argument, "DOM selector")}, {${selector.candidates.map(quote).join(", ")}})`,
        });
        return `(${selector.lists
            .map((sequences, index) => {
                const terms = `std::vector<std::vector<bbl::UiSelectorStep>>${list(sequences)}`;
                return index + 1 === selector.lists.length
                    ? terms
                    : `${choice} == ${index} ? ${terms} : `;
            })
            .join("")})`;
    }
    const texts = selector.holes.map((hole) => {
        const name = context.allocateTemporaryCppName("selector_text");
        context.emit({
            kind: "declaration",
            type: "const std::string",
            name,
            initializer: `bbl::js::concat(${stringConcatPart(context, context.compileValue(hole), hole)})`,
        });
        return name;
    });
    const values = new Map<string, string>();
    for (const value of selector.values) {
        const name = context.allocateTemporaryCppName("selector_value");
        const parts = value.parts.map((part) =>
            typeof part === "number" ? texts[part]! : quote(part),
        );
        context.emit({
            kind: "declaration",
            type: "const std::string",
            name,
            initializer: `bbl::ui_selector_value(bbl::js::concat(${parts.join(", ")}), '${value.quote === "'" ? "\\'" : '"'}')`,
        });
        values.set(value.marked, name);
    }
    return list(
        selector.sequences,
        (text) => values.get(text) ?? quote(text),
        true,
    );
}
