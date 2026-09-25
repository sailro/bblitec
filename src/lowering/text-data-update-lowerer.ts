import { doubleLiteral, stringLiteral } from "../cpp-literals.js";
import type { CompiledTextData } from "../pinned-text-data.js";
import { LoweringContext } from "./context.js";
import {
    lowerTextFunctions,
    TEXT_RECORDS,
    textRecordModel,
} from "./text-records.js";

/** The pin's text records and the bodies the static data path reaches. */
export function textRecordsHeader(context: LoweringContext): string {
    const { declarations, definitions } = lowerTextFunctions(
        context,
        "records",
        [],
    );
    return `#pragma once
#include <bblite/text.hpp>
#include <bblite/text_layout.hpp>
#include <bblite/text_renderer.hpp>
#include <bblite/js_data.hpp>
#include <bblite/pinned_records.hpp>
#include <array>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <variant>
namespace bbl {
${textRecordModel(context).structs(TEXT_RECORDS)}
${declarations}
${definitions}
} // namespace bbl
`;
}

/**
 * `upstream/src/text_data.cpp`: each source text construction, rebuilt from
 * what the pin built at generation. Static text is the pin's own
 * `DefaultTextData`; live text runs the lowered `createDefaultTextData`
 * over a font carrying its packaged repertoire.
 */
export function compiledTextDataSource(
    context: LoweringContext,
    rows: readonly CompiledTextData[],
    layout: boolean,
): string {
    const model = textRecordModel(context);
    const asset = (output: string): string =>
        `bbl::pal::read_binary_file(bbl::asset_path(${stringLiteral(output)}))`;
    const staticRows = rows.filter((row) => row.data);
    const liveRows = rows.filter((row) => row.repertoire);
    const compiled = staticRows.map(
        (row) =>
            `    case ${row.id}: return ${model
                .transportCpp(
                    row.data!,
                    { kind: "record", name: "DefaultTextData" },
                    (index) =>
                        `bbl::js::ArrayBuffer(${asset(row.buffers[index]!.assetOutput)})`,
                )
                .replaceAll("\n", "\n    ")};`,
    );
    const optionsCpp = (row: CompiledTextData): string => {
        const options = row.layout.options;
        if (!options) return "std::nullopt";
        // Designated initializers follow the record's declaration order.
        const given = Object.entries(options);
        const members = [
            ...model.record("TextLayoutOptions").members().values(),
        ].flatMap((member) => {
            const value = given.find(([name]) => name === member.name)?.[1];
            if (value === undefined) return [];
            return [
                `.${member.field} = ${typeof value === "string" ? `std::string(${stringLiteral(value)})` : doubleLiteral(value)}`,
            ];
        });
        return `bbl::TextLayoutOptions{${members.join(", ")}}`;
    };
    const live = liveRows.map((row) => {
        const repertoire = row.repertoire!;
        const buffers = row.buffers.map(
            (blob, index) =>
                `            static const bbl::js::ArrayBuffer buffer_${index}(${asset(blob.assetOutput)});`,
        );
        const storage = model
            .transportCpp(
                repertoire.storage,
                { kind: "record", name: "GlyphStorage" },
                (index) => `buffer_${index}`,
            )
            .replaceAll("\n", "\n            ");
        const color = row.layout.color
            ? `bbl::js::Tuple<4>{${row.layout.color.map(doubleLiteral).join(", ")}}`
            : undefined;
        return `    case ${row.id}: {
        auto font = bbl::pal::create_text_layout_font(${asset(row.font.assetOutput)});
        font->curve_set_id = ${stringLiteral(repertoire.curveSetId)};
        font->packaged_storage = [] {
${buffers.join("\n")}
            return ${storage};
        };
        return bbl::create_default_text_data(font, ${doubleLiteral(row.layout.fontSizePx)}, std::move(text), ${color ? `color ? std::move(color) : bbl::js::Nullable<bbl::js::Tuple<4>>(${color})` : "std::move(color)"}, ${optionsCpp(row)});
    }`;
    });
    return `#include <bblite/upstream_text.hpp>
#include <bblite/pal.hpp>
${layout ? "#include <bblite/upstream_text_update.hpp>\n" : ""}namespace bbl {
TextData create_compiled_text_data(std::uint32_t index) {
${
    compiled.length
        ? `    switch (index) {
${compiled.join("\n")}
    default: throw std::out_of_range("Compiled text data index");
    }`
        : `    static_cast<void>(index);
    throw std::out_of_range("Compiled text data index");`
}
}
${
    layout
        ? `TextData create_live_text_data(std::uint32_t index, std::string text,
    bbl::js::Nullable<bbl::js::Tuple<4>> color) {
${
    live.length
        ? `    switch (index) {
${live.join("\n")}
    default: throw std::out_of_range("Live text data index");
    }`
        : `    static_cast<void>(index);
    static_cast<void>(text);
    static_cast<void>(color);
    throw std::out_of_range("Live text data index");`
}
}
`
        : ""
}} // namespace bbl
`;
}

/** Text data creation and updates, lowered whole from the pin's modules. */
export class TextDataUpdateLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        const { declarations, definitions } = lowerTextFunctions(
            this.context,
            "update",
            ["records", "layout"],
        );
        return `#pragma once
#include <bblite/upstream_text_layout.hpp>
#include <bblite/upstream_text.hpp>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
namespace bbl {
${declarations}
${definitions}
TextData create_live_text_data(std::uint32_t index, std::string text,
    bbl::js::Nullable<bbl::js::Tuple<4>> color = std::nullopt);
} // namespace bbl
`;
    }
}
