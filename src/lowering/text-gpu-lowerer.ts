import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding, type PinnedNumericScope } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const RENDERABLE = "src/text/text-renderable.ts";
const TEXTURES = "src/text/_gpu/text-textures.ts";
const STYLES = "src/text/_gpu/text-style-gpu.ts";
const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
const extent = (cpp: string): PinnedBinding => scalar(`static_cast<double>(${cpp})`);
const opaque = (cpp: string): PinnedBinding => ({ cpp, type: "opaque" });
type StatementAdapter = NonNullable<PinnedNumericScope["statement"]>;

/** Numeric lifecycle stays in the pin's AST. Only device/resource objects are
 * replaced by synchronous native operations; no PAL repeats the version rules. */
export class TextGpuLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public header(): string {
        return `#pragma once
#include <bblite/text.hpp>
#include <bblite/js_data.hpp>
#include <algorithm>
#include <cmath>
#include <limits>
#include <span>
namespace bbl {
// Resource dimensions cross from JavaScript numbers to the native API here.
inline std::size_t text_resource_size(double value) {
    if (!std::isfinite(value) || value < 0 || std::trunc(value) != value ||
        value >= static_cast<double>(std::numeric_limits<std::size_t>::max()))
        throw std::runtime_error("Text resource extent is outside native integer storage.");
    return static_cast<std::size_t>(value);
}
inline std::span<const std::uint8_t> text_byte_range(const std::vector<std::uint8_t>& bytes,
    double offset, double length) {
    const auto start = text_resource_size(offset), count = text_resource_size(length);
    if (start > bytes.size() || count > bytes.size() - start)
        throw std::runtime_error("Text upload exceeds its retained payload.");
    return std::span<const std::uint8_t>(bytes).subspan(start, count);
}
${this.targetKey()}
${this.rows()}
${this.atlasFactories()}
${this.styleFactory()}
${this.styleSync()}
${this.instanceCapacity()}
${this.uploadAtlas()}
struct TextAtlasGpuResult { bool rebuilt; std::shared_ptr<TextAtlasGpuState> gpu; };
${this.atlas()}
${this.renderable()}
${this.resources()}
${this.draw()}
} // namespace bbl
`;
    }

    private numeric(module: string, name: string): number {
        const file = this.context.sourceFile(module);
        return this.context.numericValue(this.context.variableInitializer(file, name), file);
    }

    private constants(): Map<string, PinnedBinding> {
        return new Map([
            ["TEXT_INSTANCE_BYTES", scalar(String(this.numeric("src/text/text-data.ts", "TEXT_INSTANCE_BYTES")))],
            ["TEXT_STYLE_BYTES", scalar(String(this.numeric("src/text/text-data.ts", "TEXT_STYLE_BYTES")))],
            ["TEXT_UBO_BYTES", scalar(String(this.numeric(RENDERABLE, "TEXT_UBO_BYTES")))],
            ["GLYPH_METADATA_BYTES", scalar(String(this.numeric(TEXTURES, "GLYPH_METADATA_BYTES")))],
            ["TEX_WIDTH", scalar(String(this.numeric(TEXTURES, "TEX_WIDTH")))],
            ["BYTES_PER_ROW", scalar(String(this.numeric(TEXTURES, "BYTES_PER_ROW")))],
            ["NaN", scalar("std::numeric_limits<double>::quiet_NaN()")],
        ]);
    }

    private body(module: string, name: string, bindings: Map<string, PinnedBinding>,
        calls: Map<string, (args: readonly string[]) => string>, adapter?: StatementAdapter,
        returnValue?: PinnedNumericScope["returnValue"], statements?: readonly ts.Statement[]): string {
        const { file, declaration } = this.context.functionDeclaration(module, name);
        const scope: PinnedNumericScope = {
            bindings: new Map([...this.constants(), ...bindings]), calls: new Map([...pinnedNumericMathCalls(), ...calls]),
            booleanAnd: true, booleanOr: true,
            forOf: (range, element) => {
                if (!["data._groups", "r._data._groups"].includes(range)) return undefined;
                const owner = range === "data._groups" ? "data" : "(*r.data)";
                return { range: `${owner}.groups`, bindings: this.groupBindings(element, owner) };
            },
            ...(adapter ? { statement: (statement: ts.Statement, lowerer: PinnedNumericLowerer, indent: string) => {
                const result = adapter(statement, lowerer, indent);
                if (result !== undefined && ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1)
                    this.context.contractError(statement, "Text resource declaration gained additional bindings.");
                return result;
            } } : {}),
            returnValue: returnValue ?? ((expression) => expression ? lowerer.expression(expression) : ""),
        };
        const lowerer = new PinnedNumericLowerer(file, scope);
        return `    // ${this.context.provenance(module, name)}\n` +
            (statements ?? declaration.body!.statements).flatMap((statement) => lowerer.statement(statement, "    ")).join("\n");
    }

    private groupBindings(name: string, data: string): Map<string, PinnedBinding> {
        return new Map([
            [`${name}._slotCount`, extent(`${name}.slot_count`)],
            [`${name}._slotStart`, extent(`${name}.slot_start`)],
            [`${name}._bindGroup`, { ...opaque(`${name}.bind_group`), absentCpp: `!${name}.bind_group` }],
            [`${name}._bindGroupVersion`, scalar(`${name}.bind_group_version`)],
            [`${name}._curveSetId`, opaque(`${data}.payload->atlases.at(${name}.atlas_index).curve_set_id`)],
            [`${name}._groupKey`, opaque(`${name}.group_key`)],
        ]);
    }

    private targetKey(): string {
        const { declaration } = this.context.functionDeclaration(RENDERABLE, "targetSig");
        const statement = declaration.body!.statements[0];
        if (declaration.body!.statements.length !== 1 || !statement || !ts.isReturnStatement(statement) || !statement.expression)
            this.context.contractError(declaration, "Text target signature body changed.");
        const value = (node: ts.Expression): string => {
            node = this.context.unwrapExpression(node);
            if (ts.isStringLiteral(node)) return stringLiteral(node.text);
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
                return `${value(node.left)} + ${value(node.right)}`;
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                const path = this.context.propertyPath(node.left)?.join(".");
                if (path === "target._sampleCount" && ts.isNumericLiteral(node.right))
                    return `std::to_string(target.sample_count.value_or(${node.right.text}u))`;
                const field = path === "target._colorFormat" ? "color_format" : path === "target._depthStencilFormat" ? "depth_format" : undefined;
                if (field && ts.isStringLiteral(node.right)) return `target.${field}.value_or(${stringLiteral(node.right.text)})`;
            }
            return this.context.contractError(node, "Unrepresented text target signature component.");
        };
        return `inline std::string text_target_key(const TextTargetSignature& target) { return ${value(statement.expression)}; }`;
    }

    private rows(): string {
        return ["nextPow2Rows", "rowsForTexels"].map((name) => {
            const body = this.body(TEXTURES, name, new Map([[name === "nextPow2Rows" ? "rows" : "texels", scalar("value")]]), new Map(),
                (statement, lowerer, indent) => {
                    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
                        statement.expression.operatorToken.kind === ts.SyntaxKind.LessThanLessThanEqualsToken) {
                        const expression = statement.expression;
                        this.context.assertExpressionShape(expression.left, "r", "Text capacity shift target");
                        return [`${indent}${lowerer.expression(expression.left)} = bbl::js::shift_left(${lowerer.expression(expression.left)}, ${lowerer.expression(expression.right)});`];
                    }
                    return undefined;
                });
            return `inline double ${name === "nextPow2Rows" ? "text_power_of_two" : "text_rows_for_texels"}(double value) {
    if (!std::isfinite(value) || value > 1073741824.0) throw std::runtime_error("Text capacity exceeds the positive pinned 32-bit growth range.");
${body}\n}`;
        }).join("\n");
    }

    private bufferDescriptor(call: ts.Expression, label: string, usage: string, lowerer: PinnedNumericLowerer): string {
        if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0]!))
            this.context.contractError(call, "Text buffer creation descriptor changed.");
        this.context.assertExpressionShape(call.expression, "device.createBuffer", "Text buffer device boundary");
        const object = call.arguments[0] as ts.ObjectLiteralExpression;
        if (object.properties.map((property) => property.name?.getText()).join() !== "label,size,usage")
            this.context.contractError(object, "Text buffer descriptor fields changed.");
        this.context.assertExpressionShape(this.context.propertyInitializer(object, "label"), JSON.stringify(label), "Text buffer label");
        this.context.assertExpressionShape(this.context.propertyInitializer(object, "usage"), usage, "Text buffer usage");
        return lowerer.expression(this.context.propertyInitializer(object, "size"));
    }

    private styleFactory(): string {
        const { file, declaration } = this.context.functionDeclaration(STYLES, "createStyleBuffer");
        const statement = declaration.body!.statements[0];
        if (declaration.body!.statements.length !== 1 || !statement || !ts.isReturnStatement(statement) || !statement.expression)
            this.context.contractError(declaration, "Text style buffer factory changed.");
        const lowerer = new PinnedNumericLowerer(file, { bindings: new Map([...this.constants(), ["entries", scalar("entries")]]), calls: new Map() });
        const bytes = this.bufferDescriptor(statement.expression, "text-styles", "GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST", lowerer);
        return `template<class Ops> void create_text_style_buffer(TextGpuState& gpu, double entries, Ops& ops) {
    const auto bytes = text_resource_size(${bytes});
    ops.create_renderable_buffer(gpu, TextBufferKind::styles, bytes);
    gpu.style_buffer_bytes = static_cast<double>(bytes);
}`;
    }

    private gpuBindings(root = "gpu", cpp = "gpu."): Map<string, PinnedBinding> {
        return new Map([
            [`${root}._instanceCap`, scalar(`${cpp}instance_capacity`)],
            [`${root}._styleBuf.size`, scalar(`${cpp}style_buffer_bytes`)],
            [`${root}._uploadedDataVersion`, scalar(`${cpp}uploaded_data_version`)],
            [`${root}._uploadedStyleVersion`, scalar(`${cpp}uploaded_style_version`)],
            [`${root}._pipeline`, opaque(`${cpp}pipeline`)],
            [`${root}._variantPipeline`, opaque(`${cpp}variant_pipeline`)],
            [`${root}._targetKey`, opaque(`${cpp}target_key`)],
            [`${root}._device`, opaque(`${cpp}device_identity`)],
        ]);
    }

    private styleSync(): string {
        const c: LoweringContext = this.context;
        const bindings = new Map([...this.gpuBindings(),
            ["data._styleCount", extent("data.style_count")], ["data._styleVersion", scalar("data.style_version")],
            ["data._styles.byteLength", extent("data.payload->styles.capacity_bytes")],
            ["device", opaque("device_identity")], ["gpu", opaque("gpu")],
        ]);
        const body = this.body(STYLES, "ensureStyleGpu", bindings, new Map([
            ["gpu._styleBuf.destroy", () => "if (gpu.destroy_styles) gpu.destroy_styles()"],
        ]), (statement, lowerer, indent) => {
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations[0]?.name.getText() === "s") {
                c.assertExpressionShape(statement.declarationList.declarations[0]!.initializer!, "data._styles", "Text style upload source");
                return [];
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = statement.expression;
            if (ts.isBinaryExpression(expression) && c.propertyPath(expression.left)?.join(".") === "gpu._styleBuf") {
                c.assertExpressionShape(expression, "gpu._styleBuf = createStyleBuffer(device, data._styles.byteLength / TEXT_STYLE_BYTES)", "Text style capacity creation");
                const call = expression.right as ts.CallExpression;
                return [`${indent}create_text_style_buffer(gpu, ${lowerer.expression(call.arguments[1]!)}, ops);`];
            }
            if (ts.isCallExpression(expression) && c.propertyPath(expression.expression)?.join(".") === "device.queue.writeBuffer") {
                c.assertExpressionShape(expression, "device.queue.writeBuffer(gpu._styleBuf, 0, s.buffer as ArrayBuffer, s.byteOffset, data._styleCount * TEXT_STYLE_BYTES)", "Text style upload range");
                return [`${indent}ops.write_renderable_buffer(gpu, TextBufferKind::styles, 0, text_byte_range(data.payload->styles.bytes, 0, ${lowerer.expression(expression.arguments[4]!)}));`];
            }
            return undefined;
        });
        return `template<class Ops> bool ensure_text_style_gpu(const TextDataState& data, TextGpuState& gpu, Ops& ops) {\n${body}\n}`;
    }

    private instanceCapacity(): string {
        const c: LoweringContext = this.context;
        const body = this.body(RENDERABLE, "ensureInstanceCapacity", new Map([...this.gpuBindings(), ["needed", scalar("needed")]]),
            new Map([["gpu._instanceBuf.destroy", () => "if (gpu.destroy_instances) gpu.destroy_instances()"]]),
            (statement, lowerer, indent) => {
                if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && c.propertyPath(statement.expression.left)?.join(".") === "gpu._instanceBuf") {
                    const bytes = this.bufferDescriptor(statement.expression.right, "text-instance", "GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST", lowerer);
                    return [`${indent}ops.create_renderable_buffer(gpu, TextBufferKind::instances, text_resource_size(${bytes}));`];
                }
                return undefined;
            });
        return `template<class Ops> void ensure_text_instance_capacity(TextGpuState& gpu, double needed, Ops& ops) {\n${body}\n}`;
    }

    private uploadAtlas(): string {
        const body = this.body(TEXTURES, "uploadAll", new Map([["texelsUsed", scalar("used")]]),
            new Map([["rowsForTexels", (args) => `text_rows_for_texels(${args.join(", ")})`]]),
            (statement, lowerer, indent) => {
                if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
                this.context.assertExpressionShape(statement.expression, `device.queue.writeTexture({texture:tex},cpuData.buffer as ArrayBuffer,
                    {offset:cpuData.byteOffset,bytesPerRow:BYTES_PER_ROW,rowsPerImage:rows},{width:TEX_WIDTH,height:rows,depthOrArrayLayers:1})`, "Text atlas row upload");
                return [`${indent}ops.write_atlas_texture(gpu, kind, bytes, text_resource_size(${lowerer.expression(ts.factory.createIdentifier("BYTES_PER_ROW"))}), text_resource_size(${lowerer.expression(ts.factory.createIdentifier("TEX_WIDTH"))}), text_resource_size(rows));`];
            });
        return `template<class Ops> void upload_text_atlas_texture(TextAtlasGpuState& gpu, TextAtlasTextureKind kind,
    std::span<const std::uint8_t> bytes, double used, Ops& ops) {\n${body}\n}`;
    }

    private atlasFactories(): string {
        const c: LoweringContext = this.context;
        const texture = c.functionDeclaration(TEXTURES, "createAtlasTexture");
        const returned = texture.declaration.body!.statements[0];
        if (texture.declaration.body!.statements.length !== 1 || !returned || !ts.isReturnStatement(returned) || !returned.expression)
            c.contractError(texture.declaration, "Text atlas texture factory changed.");
        c.assertExpressionShape(returned.expression, `device.createTexture({label,format:"rgba32float",
            size:{width:TEX_WIDTH,height:rows,depthOrArrayLayers:1},usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC})`, "Text atlas texture descriptor");
        const metadata = c.functionDeclaration(TEXTURES, "createMetaBuffer");
        const result = metadata.declaration.body!.statements[0];
        if (metadata.declaration.body!.statements.length !== 1 || !result || !ts.isReturnStatement(result) || !result.expression)
            c.contractError(metadata.declaration, "Text atlas metadata factory changed.");
        const lowerer = new PinnedNumericLowerer(metadata.file, {bindings: new Map([...this.constants(), ["slots", scalar("slots")]]), calls: new Map()});
        const bytes = this.bufferDescriptor(result.expression, "text-glyph-metadata", "GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST", lowerer);
        return `template<class Ops> void create_text_atlas_texture(TextAtlasGpuState& gpu, TextAtlasTextureKind kind, double rows, Ops& ops) {
    ops.create_atlas_texture(gpu, kind, text_resource_size(${this.numeric(TEXTURES, "TEX_WIDTH")}), text_resource_size(rows));
}
template<class Ops> void create_text_atlas_metadata(TextAtlasGpuState& gpu, double slots, Ops& ops) {
    ops.create_atlas_metadata(gpu, text_resource_size(${bytes}));
}`;
    }

    private atlasBindings(prefix = "gpu", cpp = "gpu->"): Map<string, PinnedBinding> {
        return new Map([
            [`${prefix}._device`, opaque(`${cpp}device_identity`)],
            [`${prefix}._curveTexRows`, scalar(`${cpp}curve_rows`)],
            [`${prefix}._bandTexRows`, scalar(`${cpp}band_rows`)],
            [`${prefix}._metaCap`, scalar(`${cpp}metadata_capacity`)],
            [`${prefix}._uploadedVersion`, scalar(`${cpp}uploaded_version`)],
            [`${prefix}._curveTex`, opaque("TextAtlasTextureKind::curves")],
            [`${prefix}._bandTex`, opaque("TextAtlasTextureKind::bands")],
        ]);
    }

    private allocationObject(object: ts.ObjectLiteralExpression, atlas: boolean, lowerer: PinnedNumericLowerer, indent: string): string[] {
        const c: LoweringContext = this.context;
        const fields = atlas ? new Map([
            ["_device", "device_identity"], ["_curveTex", "curves"], ["_bandTex", "bands"],
            ["_curveTexRows", "curve_rows"], ["_bandTexRows", "band_rows"], ["_metaBuf", "metadata"],
            ["_metaCap", "metadata_capacity"], ["_uploadedVersion", "uploaded_version"],
        ]) : new Map([
            ["_device", "device_identity"], ["_textU", "uniform"], ["_instanceBuf", "instances"],
            ["_instanceCap", "instance_capacity"], ["_styleBuf", "styles"], ["_uploadedStyleVersion", "uploaded_style_version"],
            ["_pipeline", "pipeline"], ["_variantPipeline", "variant_pipeline"], ["_uploadedDataVersion", "uploaded_data_version"],
            ["_uploadedCameraVersion", "uploaded_camera_version"], ["_uploadedAspect", "uploaded_aspect"],
            ["_uploadedViewportW", "uploaded_viewport_w"], ["_uploadedViewportH", "uploaded_viewport_h"],
            ["_uploadedOpacity", "uploaded_opacity"], ["_targetKey", "target_key"],
        ]);
        if (object.properties.map((property) => property.name?.getText()).join() !== [...fields.keys()].join())
            c.contractError(object, "Text GPU state inventory changed; update the native resource owner.");
        const lines = [`${indent}{`, `${indent}    auto created = std::make_shared<${atlas ? "TextAtlasGpuState" : "TextGpuState"}>();`];
        for (const [source, target] of fields) {
            const expression = c.propertyInitializer(object, source);
            const at = `${indent}    `;
            if (source === "_curveTex" || source === "_bandTex") {
                const name = source === "_curveTex" ? "curveRows" : "bandRows";
                c.assertExpressionShape(expression, `createAtlasTexture(device, ${name}, "text-slug-${target}")`, "Text atlas allocation");
                lines.push(`${at}create_text_atlas_texture(*created, TextAtlasTextureKind::${target}, ${lowerer.expression((expression as ts.CallExpression).arguments[1]!)}, ops);`);
            } else if (source === "_metaBuf") {
                c.assertExpressionShape(expression, "createMetaBuffer(device, metaCap)", "Text metadata allocation");
                lines.push(`${at}create_text_atlas_metadata(*created, ${lowerer.expression((expression as ts.CallExpression).arguments[1]!)}, ops);`);
            } else if (source === "_textU") {
                c.assertExpressionShape(expression, 'createEmptyUniformBuffer(engine, TEXT_UBO_BYTES, "text-renderable-ubo")', "Text uniform allocation");
                lines.push(`${at}ops.create_renderable_buffer(*created, TextBufferKind::uniform, text_resource_size(${lowerer.expression((expression as ts.CallExpression).arguments[1]!)}));`);
            } else if (source === "_instanceBuf") {
                const bytes = this.bufferDescriptor(expression, "text-instance", "GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST", lowerer);
                lines.push(`${at}ops.create_renderable_buffer(*created, TextBufferKind::instances, text_resource_size(${bytes}));`);
            } else if (source === "_styleBuf") {
                c.assertExpressionShape(expression, "createStyleBuffer(device, 1)", "Text initial style allocation");
                lines.push(`${at}create_text_style_buffer(*created, ${lowerer.expression((expression as ts.CallExpression).arguments[1]!)}, ops);`);
            } else lines.push(`${at}created->${target} = ${lowerer.expression(expression)};`);
        }
        lines.push(`${indent}    gpu = std::move(created);`, `${indent}}`);
        return lines;
    }

    private atlas(): string {
        const c: LoweringContext = this.context;
        const bindings = new Map([...this.atlasBindings(),
            ["gpu", {...opaque("gpu"), absentCpp: "!gpu"}], ["device", opaque("device_identity")],
            ["atlas._curveTexelsUsed", extent("atlas.curves.used_texels")], ["atlas._bandTexelsUsed", extent("atlas.bands.used_texels")],
            ["atlas._slotCount", extent("atlas.metadata.count")], ["atlas._version", scalar("atlas.version")],
            ["atlas._gpu", opaque("state")], ["atlas._curveTexData", opaque("atlas.curves.bytes")],
            ["atlas._bandTexData", opaque("atlas.bands.bytes")],
        ]);
        const calls = new Map<string, (args: readonly string[]) => string>([
            ["rowsForTexels", (args) => `text_rows_for_texels(${args.join(", ")})`],
            ["nextPow2Rows", (args) => `text_power_of_two(${args.join(", ")})`],
            ["uploadAll", (args) => `upload_text_atlas_texture(*gpu, ${args.slice(1).join(", ")}, ops)`],
            ...[["_curveTex", "curves"], ["_bandTex", "bands"], ["_metaBuf", "metadata"]].map(([field, role]): [string, (args: readonly string[]) => string] =>
                [`gpu.${field}.destroy`, () => `if (gpu->destroy_${role}) gpu->destroy_${role}()`]),
        ]);
        const body = this.body(TEXTURES, "ensureSharedAtlasGpu", bindings, calls, (statement, lowerer, indent) => {
            if (ts.isVariableStatement(statement)) {
                const declaration = statement.declarationList.declarations[0]!;
                if (declaration.name.getText() === "gpu") {
                    c.assertExpressionShape(declaration.initializer!, "atlas._gpu", "Text atlas retained GPU alias");
                    return [`${indent}auto gpu = state;`];
                }
                if (declaration.name.getText() === "meta") {
                    c.assertExpressionShape(declaration.initializer!, "atlas._metaData", "Text metadata upload source");
                    return [];
                }
            }
            if (ts.isReturnStatement(statement) && statement.expression) {
                c.assertExpressionShape(statement.expression, "{_rebuilt:rebuilt,_gpu:gpu}", "Text atlas result");
                return [`${indent}return {rebuilt, gpu};`];
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = statement.expression;
            if (ts.isBinaryExpression(expression)) {
                if (ts.isIdentifier(expression.left) && expression.left.text === "gpu") {
                    if (expression.right.kind === ts.SyntaxKind.NullKeyword) return [`${indent}gpu.reset();`];
                    if (ts.isObjectLiteralExpression(expression.right)) return this.allocationObject(expression.right, true, lowerer, indent);
                }
                const path = c.propertyPath(expression.left)?.join(".");
                for (const [source, kind, rows] of [["gpu._curveTex", "curves", "gpu._curveTexRows"], ["gpu._bandTex", "bands", "gpu._bandTexRows"]]) {
                    if (path === source) {
                        c.assertExpressionShape(expression.right, `createAtlasTexture(device, ${rows}, "text-slug-${kind}")`, "Text atlas growth");
                        return [`${indent}create_text_atlas_texture(*gpu, TextAtlasTextureKind::${kind}, ${lowerer.expression((expression.right as ts.CallExpression).arguments[1]!)}, ops);`];
                    }
                }
                if (path === "gpu._metaBuf") {
                    c.assertExpressionShape(expression.right, "createMetaBuffer(device, gpu._metaCap)", "Text metadata growth");
                    return [`${indent}create_text_atlas_metadata(*gpu, ${lowerer.expression((expression.right as ts.CallExpression).arguments[1]!)}, ops);`];
                }
            }
            if (ts.isCallExpression(expression) && c.propertyPath(expression.expression)?.join(".") === "device.queue.writeBuffer") {
                c.assertExpressionShape(expression, "device.queue.writeBuffer(gpu._metaBuf,0,meta.buffer as ArrayBuffer,meta.byteOffset,atlas._slotCount*GLYPH_METADATA_BYTES)", "Text metadata upload range");
                return [`${indent}ops.write_atlas_metadata(*gpu, text_byte_range(atlas.metadata.bytes, 0, ${lowerer.expression(expression.arguments[4]!)}));`];
            }
            return undefined;
        });
        return `template<class Ops> TextAtlasGpuResult ensure_text_atlas(const TextAtlas& atlas,
    std::shared_ptr<TextAtlasGpuState>& state, const void* device_identity, Ops& ops) {\n${body}\n}`;
    }
    private renderable(): string {
        const c: LoweringContext = this.context;
        const bindings = new Map([...this.gpuBindings("gpu", "gpu->"),
            ["gpu", {...opaque("gpu"), absentCpp: "!gpu"}], ["device", opaque("device_identity")],
            ["key", opaque("key")], ["pipeline", opaque("pipelines.pipeline")], ["variantPipeline", opaque("pipelines.variant_pipeline")],
            ["r._gpu", opaque("r.gpu")], ["r._data._instanceCount", extent("r.data->instance_count")],
        ]);
        const calls = new Map<string, (args: readonly string[]) => string>(
            [["_textU", "uniform"], ["_instanceBuf", "instances"], ["_styleBuf", "styles"]].map(([field, role]) =>
                [`gpu.${field}.destroy`, () => `if (gpu->destroy_${role}) gpu->destroy_${role}()`]));
        const body = this.body(RENDERABLE, "ensureGpu", bindings, calls, (statement, lowerer, indent) => {
            if (ts.isVariableStatement(statement)) {
                const declaration = statement.declarationList.declarations[0]!;
                if (ts.isObjectBindingPattern(declaration.name)) {
                    c.assertExpressionShape(declaration.initializer!, "getOrCreateTextPipeline(engine, colorFormat, sampleCount, depthFormat, depthWrite, r)", "Text resolved pipeline boundary");
                    if (declaration.name.elements.map((element) => `${element.propertyName?.getText()}:${element.name.getText()}`).join() !== "_pipeline:pipeline,_variantPipeline:variantPipeline")
                        c.contractError(declaration, "Text pipeline destructuring changed.");
                    return [];
                }
                if (declaration.name.getText() === "device") {
                    c.assertExpressionShape(declaration.initializer!, "engine._device", "Text device identity");
                    return [];
                }
                if (declaration.name.getText() === "key") {
                    c.assertExpressionShape(declaration.initializer!, "targetSig(target)", "Text target cache key");
                    return [`${indent}const std::string key = text_target_key(target);`];
                }
                if (declaration.name.getText() === "gpu") {
                    c.assertExpressionShape(declaration.initializer!, "r._gpu", "Text retained renderable GPU alias");
                    return [`${indent}auto gpu = r.gpu;`];
                }
            }
            if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined;
            const expression = statement.expression;
            if (ts.isIdentifier(expression.left) && expression.left.text === "gpu") {
                if (expression.right.kind === ts.SyntaxKind.NullKeyword) return [`${indent}gpu.reset();`];
                if (ts.isObjectLiteralExpression(expression.right)) return this.allocationObject(expression.right, false, lowerer, indent);
            }
            if (c.propertyPath(expression.left)?.join(".") === "g._bindGroup") {
                c.assertExpressionShape(expression, "g._bindGroup = null", "Text pipeline cache invalidation");
                return [`${indent}g.bind_group.reset();`];
            }
            return undefined;
        });
        return `// Resolve the pin's pipeline descriptor first, then enter this allocation/cache body.
template<class Ops> std::shared_ptr<TextGpuState> ensure_text_gpu(TextRenderableState& r,
    const void* device_identity, const TextTargetSignature& target, const TextPipelineBinding& pipelines, Ops& ops) {\n${body}\n}`;
    }

    private resources(): string {
        const c: LoweringContext = this.context;
        const { declaration } = c.functionDeclaration(RENDERABLE, "updateTextRenderable");
        const statements = declaration.body!.statements;
        const boundary = statements.findIndex((statement) => ts.isVariableStatement(statement) &&
            statement.declarationList.declarations[0]?.name.getText() === "camera");
        if (boundary < 0) c.contractError(declaration, "Text resource/uniform update boundary changed.");
        const bindings = new Map([...this.gpuBindings(), ...this.atlasBindings("atlasGpu", "atlasGpu."),
            ["gpu", opaque("gpu")], ["data", opaque("data")], ["device", opaque("gpu.device_identity")],
            ["bindGroupLayout", opaque("layout")], ["rebuilt", {cpp:"atlas_result.rebuilt",type:"bool" as const}],
            ["data._instanceCount", extent("data.instance_count")], ["data._version", scalar("data.version")],
            ["data._dirtyStart", extent("data.dirty_start")], ["data._dirtyEnd", extent("data.dirty_end")],
            ["view.buffer", opaque("view")], ["view.byteOffset", scalar("0")], ["view.byteLength", scalar("view.size()")],
        ]);
        const body = this.body(RENDERABLE, "updateTextRenderable", bindings, new Map([
            ["ensureStyleGpu", () => "ensure_text_style_gpu(data, gpu, ops)"],
            ["ensureInstanceCapacity", (args: readonly string[]) => `ensure_text_instance_capacity(gpu, ${args[2]}, ops)`],
        ]), (statement, lowerer, indent) => {
            if (ts.isVariableStatement(statement)) {
                const variable = statement.declarationList.declarations[0]!;
                if (ts.isObjectBindingPattern(variable.name)) {
                    c.assertExpressionShape(variable.initializer!, "ensureSharedAtlasGpu(device, g._curveSet._atlas)", "Text group atlas synchronization");
                    if (variable.name.elements.map((element) => `${element.propertyName?.getText()}:${element.name.getText()}`).join() !== "_rebuilt:rebuilt,_gpu:atlasGpu")
                        c.contractError(variable, "Text atlas result destructuring changed.");
                    return [`${indent}auto atlas_result = ensure_text_atlas(data.payload->atlases.at(g.atlas_index), data.atlas_gpu.at(g.atlas_index), gpu.device_identity, ops);`,
                        `${indent}const auto& atlasGpu = *atlas_result.gpu;`];
                }
                const name = variable.name.getText();
                if (name === "styleRecreated")
                    c.assertExpressionShape(variable.initializer!, "ensureStyleGpu(device, data, gpu)", "Text style synchronization inputs");
                if (name === "device") {
                    c.assertExpressionShape(variable.initializer!, "engine._device", "Text update device"); return [];
                }
                if (name === "data") {
                    c.assertExpressionShape(variable.initializer!, "r._data", "Text update data identity");
                    return [`${indent}auto& data = *r.data;`];
                }
                if (name === "view") {
                    const call = variable.initializer;
                    if (!call || !ts.isCallExpression(call) || call.arguments.length !== 2)
                        c.contractError(variable, "Text instance upload view changed.");
                    c.assertExpressionShape(call.expression, "data._instances.subarray", "Text instance upload source");
                    const first = lowerer.expression(call.arguments[0]!), last = lowerer.expression(call.arguments[1]!);
                    return [`${indent}const auto view = text_byte_range(data.payload->instances.bytes, (${first}) * 4.0, ((${last}) - (${first})) * 4.0);`];
                }
            }
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = statement.expression;
            if (ts.isBinaryExpression(expression)) {
                const path = c.propertyPath(expression.left)?.join(".");
                if (path === "data._dirtyStart" || path === "data._dirtyEnd") {
                    c.assertExpressionShape(expression, `${path}=0`, "Text dirty range reset after upload");
                    return [`${indent}data.${path === "data._dirtyStart" ? "dirty_start" : "dirty_end"} = 0;`];
                }
            }
            if (ts.isBinaryExpression(expression) && c.propertyPath(expression.left)?.join(".") === "g._bindGroup") {
                c.assertExpressionShape(expression, `g._bindGroup=device.createBindGroup({label:"text-bg0-"+g._curveSetId,layout:bindGroupLayout,entries:[
                    {binding:0,resource:{buffer:gpu._textU}},{binding:1,resource:atlasGpu._curveTex.createView()},
                    {binding:2,resource:atlasGpu._bandTex.createView()},{binding:3,resource:{buffer:atlasGpu._metaBuf}},
                    {binding:4,resource:{buffer:gpu._styleBuf}}]})`, "Text group resource identities and binding order");
                return [`${indent}g.bind_group = ops.create_bind_group(gpu, atlasGpu, layout);`];
            }
            if (ts.isCallExpression(expression)) {
                if (c.propertyPath(expression.expression)?.join(".") === "device.queue.writeBuffer") {
                    if (expression.arguments.length !== 5) c.contractError(expression, "Text instance upload gained arguments.");
                    for (const [index, shape] of [[0,"gpu._instanceBuf"],[2,"view.buffer as ArrayBuffer"],[3,"view.byteOffset"],[4,"view.byteLength"]] as const)
                        c.assertExpressionShape(expression.arguments[index]!, shape, "Text instance byte range");
                    return [`${indent}ops.write_renderable_buffer(gpu, TextBufferKind::instances, text_resource_size(${lowerer.expression(expression.arguments[1]!)}), view);`];
                }
                if (expression.expression.getText() === "ensureInstanceCapacity")
                    c.assertExpressionShape(expression, "ensureInstanceCapacity(device, gpu, data._instanceCount)", "Text instance growth order");
            }
            return undefined;
        }, undefined, statements.slice(0, boundary));
        return `template<class Ops> void update_text_resources(TextRenderableState& r, TextGpuState& gpu,
    const std::shared_ptr<void>& layout, Ops& ops) {\n${body}\n}`;
    }

    private draw(): string {
        const c: LoweringContext = this.context;
        const bindings = new Map([...this.gpuBindings(), ["data._instanceCount", extent("data.instance_count")],
            ["base", opaque("base")], ["bound", opaque("bound")], ["p", opaque("p")]]);
        const body = this.body(RENDERABLE, "drawTextRenderable", bindings, new Map([
            ["pass.setPipeline", (args) => `ops.set_pipeline(${args.join(", ")})`],
            ["pass.draw", (args) => `ops.draw(${args.map((arg) => `text_resource_size(${arg})`).join(", ")})`],
        ]), (statement, lowerer, indent) => {
            if (ts.isVariableStatement(statement)) {
                const variable = statement.declarationList.declarations[0]!;
                const name = variable.name.getText();
                if (name === "base" || name === "bound" || name === "p") {
                    if (!variable.initializer) c.contractError(variable, "Text pipeline alias has no initializer.");
                    if (name === "base") c.assertExpressionShape(variable.initializer, "gpu._pipeline", "Text base pipeline snapshot");
                    if (name === "bound") c.assertExpressionShape(variable.initializer, "base", "Text bound pipeline snapshot");
                    if (name === "p") c.assertExpressionShape(variable.initializer, "g._groupKey === g._curveSetId ? base : gpu._variantPipeline", "Text group pipeline selection");
                    return [`${indent}${name === "bound" ? "auto" : "const auto"} ${name} = ${lowerer.expression(variable.initializer)};`];
                }
            }
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
                const expression = statement.expression;
                if (c.propertyPath(expression.expression)?.join(".") === "pass.draw")
                    c.assertExpressionShape(expression, "pass.draw(6, g._slotCount, 0, g._slotStart)", "Text instanced draw ranges");
                if (c.propertyPath(expression.expression)?.join(".") === "pass.setVertexBuffer") {
                    if (expression.arguments[0]?.getText() === "0") {
                        c.assertExpressionShape(expression, "pass.setVertexBuffer(0, quadVertex)", "Text quad vertex binding");
                        return [`${indent}ops.set_quad_vertex_buffer(quad);`];
                    }
                    c.assertExpressionShape(expression, "pass.setVertexBuffer(1, gpu._instanceBuf)", "Text instance vertex binding");
                    return [`${indent}ops.set_instance_vertex_buffer(gpu);`];
                }
                if (c.propertyPath(expression.expression)?.join(".") === "pass.setBindGroup") {
                    c.assertExpressionShape(expression, "pass.setBindGroup(0, g._bindGroup)", "Text group binding");
                    return [`${indent}ops.set_bind_group(g.bind_group);`];
                }
            }
            return undefined;
        });
        return `template<class Ops> double draw_text_renderable(const TextGpuState& gpu, const TextDataState& data,
    const std::shared_ptr<void>& quad, Ops& ops) {\n${body}\n}`;
    }
}
