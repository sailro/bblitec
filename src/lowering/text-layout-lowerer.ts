import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding, type PinnedNumericScope } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const module = "src/text/layout.ts";
const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
const opaque = (cpp: string): PinnedBinding => ({ cpp, type: "opaque" });
const index = (cpp: string): string => `static_cast<std::size_t>(${cpp})`;

/** Container/library adapters around the complete pinned layout body. Layout
 * arithmetic, wrapping, paragraph batching and alignment remain AST derived. */
export class TextLayoutLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        const c: LoweringContext = this.context;
        const { file, declaration } = c.functionDeclaration(module, "layoutText");
        const bindings = new Map<string, PinnedBinding>([
            ["fontSizePx", scalar("font_size")], ["text", opaque("text")],
            ["rawFont", opaque("font")], ["rawFont.unitsPerEm", scalar("font.units_per_em")],
            ["input", opaque("input")], ["output", opaque("output")],
        ]);
        const records = new Map<string, readonly string[]>([
            ["LayoutGlyph", ["_glyphId", "_x", "_line", "_xAdvance", "_xOffset", "_yOffset"]],
            ["TextPlacedGlyph", ["glyphId", "x", "y"]],
        ]);
        const fields: Readonly<Record<string, string>> = {
            _glyphId: "glyph_id", _x: "x", _line: "line", _xAdvance: "x_advance", _xOffset: "x_offset", _yOffset: "y_offset",
            glyphId: "glyph_id", codepoint: "codepoint", cluster: "cluster", xAdvance: "x_advance", xOffset: "x_offset", yOffset: "y_offset",
        };
        const optionFields: Readonly<Record<string, string>> = { maxWidth: "max_width", lineHeight: "line_height", align: "align", letterSpacing: "letter_spacing", tabSize: "tab_size" };
        const optionDefaults: Readonly<Record<string, string>> = { maxWidth: "Infinity", lineHeight: "1.2", align: '"left"', letterSpacing: "0", tabSize: "4" };
        const containers = new Set(["input", "paragraphs", "lines", "currentLine", "line", "infos", "positions", "placed", "collapsed"]);
        const recordLiteral = (expression: ts.ObjectLiteralExpression, lowerer: PinnedNumericLowerer): string => {
            const names = expression.properties.map(property => property.name?.getText(file));
            const record = [...records].find(([, members]) => members.join() === names.join());
            if (!record) c.contractError(expression, "Text layout record fields changed.");
            return `${record[0]}{${expression.properties.map(property => {
                if (ts.isShorthandPropertyAssignment(property)) return lowerer.expression(property.name);
                if (!ts.isPropertyAssignment(property)) c.contractError(property, "Text layout requires ordinary record fields.");
                return lowerer.expression(property.initializer);
            }).join(", ")}}`;
        };
        const expr: NonNullable<PinnedNumericScope["expression"]> = (node, lowerer) => {
            if (ts.isStringLiteral(node)) return stringLiteral(node.text);
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isPropertyAccessExpression(node.left) && node.left.expression.getText(file) === "options") {
                const field = optionFields[node.left.name.text];
                if (!field) c.contractError(node, "Unrepresented text layout option.");
                c.assertExpressionShape(node.right, optionDefaults[node.left.name.text]!, "Text layout native option default");
                return `options.${field}`;
            }
            if (ts.isPropertyAccessExpression(node)) {
                const owner = c.unwrapExpression(node.expression);
                const name = node.name.text;
                if (name === "length" && ts.isIdentifier(owner) && containers.has(owner.text)) return `static_cast<double>(${lowerer.expression(owner)}.size())`;
                if (fields[name]) return `(${lowerer.expression(owner)})${ts.isIdentifier(owner) && owner.text === "last" ? "->" : "."}${fields[name]}`;
            }
            if (ts.isElementAccessExpression(node)) {
                const owner = c.unwrapExpression(node.expression);
                if (ts.isIdentifier(owner) && containers.has(owner.text)) return `${lowerer.expression(owner)}.at(${index(lowerer.expression(node.argumentExpression))})`;
            }
            if (ts.isObjectLiteralExpression(node)) return recordLiteral(node, lowerer);
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const owner = c.unwrapExpression(node.expression.expression);
                const name = node.expression.name.text;
                if (name === "trim" && node.arguments.length === 0) return `text_trim(${lowerer.expression(owner)})`;
                if (name === "charCodeAt" && ts.isIdentifier(owner) && owner.text === "collapsed" && node.arguments.length === 1)
                    return `static_cast<double>(collapsed.at(${index(lowerer.expression(node.arguments[0]!))}))`;
            }
            return undefined;
        };
        const calls = new Map([...pinnedNumericMathCalls(),
            ["rawFont.scaleForSize", (args: readonly string[]) => `(${args[0]} / font.units_per_em)`],
            ["rawFont.glyphId", (args: readonly string[]) => { if (args[0] !== "32.0") throw new Error("Text layout requested a new nominal glyph query."); return "font.space_glyph"; }],
            ["input.clear", () => "input.clear()"],
            ["input.addStr", (args: readonly string[]) => { if (args.length !== 2) throw new Error("Text shaping append arity changed."); return `input.append(${args[0]?.startsWith('"') ? "U" : ""}${args[0]})`; }],
            ["shapeInto", () => "pal::text_shape(font, input, output)"],
            ["currentLine.pop", () => "currentLine.pop_back()"],
        ]);
        const scope: PinnedNumericScope = {
            bindings, calls, expression: expr, booleanAnd: true, booleanOr: true,
            forOf: (range, name) => {
                if (range === "line") return { range: "line", bindings: new Map([[name, opaque(name)]]) };
                if (range === "lineWidths") return { range: "lineWidths", bindings: new Map([[name, scalar(name)]]) };
                return undefined;
            },
            statement: (statement, lowerer, indent) => {
                if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
                    const decl = statement.declarationList.declarations[0]!;
                    if (!ts.isIdentifier(decl.name) || !decl.initializer) return undefined;
                    const name = decl.name.text, init = c.unwrapExpression(decl.initializer);
                    const emit = (cpp: string, storage: PinnedBinding = opaque(name)): string[] => { bindings.set(name, storage); return [`${indent}${cpp}`]; };
                    if (name === "rawFont") { c.assertExpressionShape(init, "font._font", "Text raw font boundary"); return []; }
                    if (name === "collapsed") { c.assertExpressionShape(init, 'text.replace(/\\t/g, " ".repeat(tabSize)).replace(/ +/g, " ")', "Text whitespace preprocessing"); return emit(`const auto collapsed = text_collapse(text, ${lowerer.expression(ts.factory.createIdentifier("tabSize"))});`); }
                    if (name === "paragraphs") { c.assertExpressionShape(init, 'collapsed.split("\\n")', "Text paragraph delimiter"); return emit("const auto paragraphs = text_paragraphs(collapsed);"); }
                    if (name === "input") { c.assertExpressionShape(init, "scratchInput ??= new UnicodeBuffer()", "Text shaping input scratch"); return emit("thread_local std::u32string input;"); }
                    if (name === "output") { c.assertExpressionShape(init, "scratchOutput ??= new GlyphBuffer()", "Text shaping output scratch"); return emit("thread_local TextShapeOutput output;"); }
                    if (name === "ends") { c.assertExpressionShape(init, "scratchEnds ??= new Int32Array(BATCH_PARAGRAPHS)", "Text paragraph boundary scratch"); return emit(`std::vector<double> ends(${c.numericValue(c.variableInitializer(file, "BATCH_PARAGRAPHS"), file)});`, { cpp: "ends", type: "f64-buffer" }); }
                    if (name === "lines" || name === "currentLine" || name === "placed") {
                        if (!ts.isArrayLiteralExpression(init) || init.elements.length) c.contractError(init, "Text layout collection must start empty.");
                        const type = name === "lines" ? "std::vector<std::vector<LayoutGlyph>>" : name === "placed" ? "std::vector<TextPlacedGlyph>" : "std::vector<LayoutGlyph>";
                        return emit(`${type} ${name};`);
                    }
                    if (name === "infos" || name === "positions") { c.assertExpressionShape(init, `output.${name}`, "Shaping output view"); return emit(`const auto& ${name} = output.${name};`); }
                    if (name === "textAlign") return emit(`const auto textAlign = ${lowerer.expression(init)};`);
                    if (name === "pos" || name === "line") return emit(`const auto& ${name} = ${lowerer.expression(init)};`);
                    if (name === "last") {
                        c.assertExpressionShape(init, "currentLine[currentLine.length - 1]", "Text wrapping tail");
                        return emit("const auto* last = currentLine.empty() ? nullptr : &currentLine.back();", { cpp: "last", type: "opaque", absentCpp: "last == nullptr" });
                    }
                }
                if (ts.isExpressionStatement(statement)) {
                    const value = c.unwrapExpression(statement.expression);
                    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
                        const owner = value.expression.expression.getText(file), name = value.expression.name.text;
                        if (name === "push" && ["lines", "currentLine", "placed"].includes(owner) && value.arguments.length === 1) {
                            const arg = value.arguments[0]!;
                            return [`${indent}${owner}.push_back(${ts.isArrayLiteralExpression(arg) && arg.elements.length === 0 ? "{}" : lowerer.expression(arg)});`];
                        }
                        if (owner === "input" && name === "addStr") c.assertExpressionShape(value.arguments[1]!, "input.length", "Shaper append cluster origin");
                        if (owner === "currentLine" && name === "pop") return [`${indent}currentLine.pop_back();`];
                    }
                    if (ts.isBinaryExpression(value) && ts.isIdentifier(value.left) && value.left.text === "currentLine" && value.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(value.right) && !value.right.elements.length)
                        return [`${indent}currentLine.clear();`];
                }
                return undefined;
            },
            returnValue: expression => {
                if (!expression || !ts.isObjectLiteralExpression(expression)) c.contractError(declaration, "Text layout return record changed.");
                const names = ["_glyphs", "_pixelsPerFontUnit", "_width", "_height"];
                if (expression.properties.map(p => p.name?.getText(file)).join() !== names.join()) c.contractError(expression, "Text layout result fields changed.");
                return `{${names.map(name => lowerer.expression(c.propertyInitializer(expression, name))).join(", ")}}`;
            },
        };
        const lowerer = new PinnedNumericLowerer(file, scope);
        const body = declaration.body!.statements.flatMap(statement => lowerer.statement(statement, "    ")).join("\n");
        return `#pragma once
#include <bblite/text_layout.hpp>
#include <algorithm>
#include <cmath>
#include <limits>
namespace bbl {
namespace text_layout_detail {
struct LayoutGlyph { double glyph_id, x, line, x_advance, x_offset, y_offset; };
inline bool text_whitespace(char32_t cp) {
    return (cp >= 9 && cp <= 13) || cp == 32 || cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000 || cp == 0xfeff;
}
inline std::u32string text_trim(const std::u32string& source) {
    std::size_t start = 0, end = source.size();
    while (start < end && text_whitespace(source[start])) ++start;
    while (end > start && text_whitespace(source[end - 1])) --end;
    return source.substr(start, end - start);
}
inline std::u32string text_collapse(std::string_view source, double tabs) {
    if (!std::isfinite(tabs) || tabs < 0 || tabs > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) throw std::runtime_error("Text tab size is outside native string capacity.");
    std::u32string result;
    const auto append = [&](char32_t cp) { if (cp != 32 || result.empty() || result.back() != 32) result.push_back(cp); };
    for (const auto cp : pal::text_codepoints(source)) {
        if (cp == 9) { if (std::trunc(tabs) > 0) append(32); } else append(cp);
    }
    return result;
}
inline std::vector<std::u32string> text_paragraphs(const std::u32string& source) {
    std::vector<std::u32string> result(1);
    for (const auto cp : source) { if (cp == 10) result.emplace_back(); else result.back().push_back(cp); }
    return result;
}
// ${c.provenance(module, "layoutText", "HarfBuzz replaces the text-shaper library; the layout body is translated")}
inline TextLayoutResult layout(const TextLayoutFont& font, std::string_view text, double font_size, const TextLayoutOptions& options) {
${body}
}
} // namespace text_layout_detail
inline TextLayoutResult layout_text(const TextLayoutFont& font, std::string_view text, double font_size, const TextLayoutOptions& options = {}) {
    return text_layout_detail::layout(font, text, font_size, options);
}
} // namespace bbl
`;
    }
}
