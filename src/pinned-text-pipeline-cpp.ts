import { stringLiteral as cppStringLiteral, doubleLiteral, floatLiteral } from "./cpp-literals.js";
import { variantBindings } from "./pinned-pbr-variant-cpp.js";
import { nativeDepthCompare } from "./lowering/pinned-depth-state.js";
import { composeTextPipeline, type ComposedTextPipeline } from "./pinned-text-pipeline.js";

/** The default pass can resize between the pin's supported sample counts. */
export async function composeDefaultTextPipelines(): Promise<ComposedTextPipeline[]> {
    const rows: ComposedTextPipeline[] = [];
    const seen = new Set<string>();
    for (const sampleCount of [1, 4]) for (const depthWrite of [false, true]) for (const alphaToCoverage of [false, true]) {
        const row = await composeTextPipeline({ format: "bgra8unorm", sampleCount,
            depthStencilFormat: "depth24plus-stencil8", depthWrite, alphaToCoverage });
        const key = JSON.stringify(row);
        if (!seen.has(key)) { seen.add(key); rows.push(row); }
    }
    return rows;
}

export async function composeStandaloneTextPipelines(weighted: boolean): Promise<ComposedTextPipeline[]> {
    const rows = [await composeTextPipeline({ format: "bgra8unorm", sampleCount: 1, depthWrite: false, alphaToCoverage: false })];
    if (weighted) rows.push(await composeTextPipeline({ format: "bgra8unorm", sampleCount: 1, depthWrite: false, alphaToCoverage: false, weighted: true }));
    return rows;
}

export function textPipelineStem(index: number, stage: "vertex" | "fragment"): string {
    return `text-${index}.${stage === "vertex" ? "vert" : "frag"}`;
}

/** The actual descriptor and reflected resource names are one PAL binding ABI. */
export function textPipelineHeader(rows: readonly ComposedTextPipeline[]): string {
    if (!rows.length) throw new Error("Text rendering requires composed pinned pipelines.");
    const first = rows[0]!;
    const d = first.descriptor;
    const bindings = variantBindings(d.vertex.module.code, d.fragment.module.code, 0);
    const layout = d.layout.bindGroupLayouts;
    if (layout.length !== 1 || bindings.length !== layout[0]!.entries.length) throw new Error("Pinned text binding group reflection differs from its descriptor.");
    const bindingRows = layout[0]!.entries.map((entry) => {
        const binding = bindings.find((row) => row.binding === entry.binding);
        const kind = "buffer" in entry ? entry.buffer.type : entry.texture.sampleType;
        const expected = kind === "uniform" ? "uniformBuffer" : kind === "read-only-storage" ? "storageBuffer" : "texture2dLoad";
        if (!binding || binding.kind !== expected || (Number(binding.vertex) | (Number(binding.fragment) << 1)) !== entry.visibility)
            throw new Error(`Pinned text binding ${entry.binding} reflection differs from its descriptor.`);
        return `    {${entry.binding}u, ${entry.visibility}u, ${cppStringLiteral(binding.name)}, ${cppStringLiteral(kind)}},`;
    });
    const shared = (row: ComposedTextPipeline) => JSON.stringify({ layout: row.descriptor.layout, vertex: row.descriptor.vertex.buffers, quad: row.quadCorners });
    if (rows.some((row) => shared(row) !== shared(first))) throw new Error("Text variants no longer share layout and quad data.");
    const declarations: string[] = [];
    const pipelineRows = rows.map((row, index) => {
        const descriptor = row.descriptor;
        const target = descriptor.fragment.targets;
        if (target.length !== 1 || target[0]!.format !== "bgra8unorm" || (descriptor.depthStencil && descriptor.depthStencil.format !== "depth24plus-stencil8"))
            throw new Error("Text activation requires the represented color/depth target signature.");
        const constants = (["vertex", "fragment"] as const).map((stage) => {
            const values = row[stage === "vertex" ? "vertexConstants" : "fragmentConstants"];
            const name = `text_${index}_${stage}_constants`;
            declarations.push(`inline constexpr std::array<ShaderStageConstant, ${values.length}> ${name}{{${values.map((v) => `{${v.id}u, ${doubleLiteral(v.value)}}`).join(", ")}}};`);
            return name;
        });
        const blend = target[0]!.blend;
        const factor = (value: string) => {
            if (!["one", "src-alpha", "one-minus-src-alpha"].includes(value)) throw new Error(`Unsupported text blend factor '${value}'.`);
            return `BlendFactor::${value.replaceAll("-", "_")}`;
        };
        if (blend && (blend.color.operation !== "add" || blend.alpha.operation !== "add")) throw new Error("Text blend operation requires an unrepresented equation.");
        return `    {${descriptor.multisample.count}u, ${!!descriptor.depthStencil}, ${!!descriptor.depthStencil?.depthWriteEnabled}, ${!!descriptor.multisample.alphaToCoverageEnabled}, ${!!row.weighted}, ` +
            `${cppStringLiteral(textPipelineStem(index, "vertex"))}, ${cppStringLiteral(textPipelineStem(index, "fragment"))}, ` +
            `${cppStringLiteral(descriptor.vertex.entryPoint)}, ${cppStringLiteral(descriptor.fragment.entryPoint)}, ${constants.join(", ")}, ` +
            `${cppStringLiteral(descriptor.primitive.topology)}, ${cppStringLiteral(descriptor.primitive.cullMode)}, ${cppStringLiteral(descriptor.primitive.frontFace)}, ` +
            `DepthCompare::${nativeDepthCompare(descriptor.depthStencil?.depthCompare ?? "greater-equal")}, ${!!blend}, ` +
            `{${blend ? [blend.color.srcFactor, blend.color.dstFactor, blend.alpha.srcFactor, blend.alpha.dstFactor].map(factor).join(", ") : ""}}},`;
    });
    const bufferRows = d.vertex.buffers.map((buffer, index) => {
        declarations.push(`inline constexpr std::array<TextVertexAttribute, ${buffer.attributes.length}> text_attributes_${index}{{${buffer.attributes.map((a) => `{${a.shaderLocation}u, ${a.offset}u, ${cppStringLiteral(a.format)}}`).join(", ")}}};`);
        return `    {${buffer.arrayStride}u, ${cppStringLiteral(buffer.stepMode)}, text_attributes_${index}},`;
    });
    return `#pragma once
#include <bblite/runtime.hpp>
#include <array>
#include <span>
namespace bbl::upstream {
struct ShaderStageConstant { std::uint32_t id; double value; };
struct TextBindingInfo { std::uint32_t binding, visibility; const char* name; const char* kind; };
struct TextVertexAttribute { std::uint32_t location, offset; const char* format; };
struct TextVertexBuffer { std::uint32_t stride; const char* step_mode; std::span<const TextVertexAttribute> attributes; };
struct TextPipelineInfo {
    std::uint32_t sample_count;
    bool has_depth, depth_write, alpha_to_coverage, weighted;
    const char *vertex_shader, *fragment_shader, *vertex_entry, *fragment_entry;
    std::span<const ShaderStageConstant> vertex_constants, fragment_constants;
    const char *topology, *cull_mode, *front_face;
    DepthCompare depth_compare;
    bool blend_enabled;
    BlendFactors blend;
};
${declarations.join("\n")}
inline constexpr std::array<TextPipelineInfo, ${rows.length}> text_pipeline_rows{{
${pipelineRows.join("\n")}
}};
inline constexpr std::array<float, ${first.quadCorners.length}> text_quad_corners{${first.quadCorners.map(floatLiteral).join(", ")}};
inline constexpr std::array<TextBindingInfo, ${bindingRows.length}> text_binding_layout{{
${bindingRows.join("\n")}
}};
inline constexpr std::array<TextVertexBuffer, ${bufferRows.length}> text_vertex_buffers{{
${bufferRows.join("\n")}
}};
}
`;
}
