// The compressed-texture loader: a KTX1 container parsed at load, and the
// pinned GL-format table it resolves against.
//
// `.ktx` is the `.env` case rather than the `.hdr` case. The file already
// carries GPU blocks and its own mip chain, so there is no browser work to
// reproduce and nothing for generation to compute: what the pin does at
// page load — validate the header, slice the mip chain, look the format up
// — the generated loader does at startup, exactly as the environment
// container parser does. What generation DOES settle is which file to
// fetch, because `loadKtxTexture2D` picks its suffix from the device's
// compressed-format features and the native runtime has no network to fetch
// a second candidate with.
//
// The format table is the pin's own. `compressed-formats.ts` builds it with
// one `add(gl, gpuFormat, feature, blockW, blockH, blockBytes)` call per
// entry, and the rows this port emits are the block-compressed ones both
// backends bind — D3D12 is what a WebGPU adapter reports
// `texture-compression-bc` on, and ETC2/ASTC are absent there. Emitting
// only those rows is the same tree shaking the rest of generation performs,
// and it puts the refusal at the pin's own `if (!format) throw` rather than
// at an upload that cannot name what it was handed.
import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

const KTX_MODULE = "src/texture/ktx-loader.ts";
const FORMATS_MODULE = "src/texture/compressed-formats.ts";
const KTX2_MODULE = "src/texture/ktx2-loader.ts";

/**
 * The block formats both backends bind, by the pin's own WebGPU names.
 *
 * This is `CompressedBlockFormat` in `native/src/pal_gpu_shared.hpp`, which
 * is where each backend translates one of these into its own enumerator.
 * The emitted table carries these rows alone so the two ends agree: a
 * container the port cannot upload is refused where the pin refuses an
 * unknown format, rather than parsing cleanly and then failing at the
 * upload with a format nobody named.
 */
export const uploadableCompressedFormats: readonly string[] = [
    "bc1-rgba-unorm",
    "bc2-rgba-unorm",
    "bc3-rgba-unorm",
    "bc7-rgba-unorm",
    "bc7-rgba-unorm-srgb",
];

/** One row of the pinned GL-internal-format table. */
interface CompressedFormatRow {
    gl: number;
    gpuFormat: string;
    blockWidth: number;
    blockHeight: number;
    blockBytes: number;
}

/** One field the parser validates rather than binds: where, and against what. */
export interface KtxHeaderGuard {
    offset: number;
    expected: number;
}

/**
 * The KTX1 header as the pinned parser reads it.
 *
 * One derivation serves both ends of the container: the emitted parser
 * reads these offsets, and the packager that writes a transcode writes
 * them. A layout stated twice is a layout that can disagree with itself,
 * and the disagreement would surface as the generated parser misreading
 * its own generated file.
 */
export interface KtxHeaderLayout {
    endianness: KtxHeaderGuard;
    glType: KtxHeaderGuard;
    glFormat: KtxHeaderGuard;
    glInternalFormat: number;
    width: number;
    height: number;
    pixelDepth: number;
    arrayElements: number;
    faces: number;
    mipLevels: number;
    keyValueBytes: number;
    /** The fixed header the level data follows. */
    headerSize: number;
}

export class CompressedTextureLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /** Walked once: the pin does not change between compiles, and both the
     *  emitted table and the transcode packaging ask for the same rows. */
    private rows?: CompressedFormatRow[];

    /**
     * The block-compression rows of `compressed-formats.ts`'s own table.
     *
     * Read from the `add(...)` calls rather than by executing the module:
     * the ASTC half is built by a loop over computed enum values, and every
     * row this port keeps is literal, so the AST answers exactly the
     * question without the loop having to be folded.
     */
    private formatRows(): CompressedFormatRow[] {
        if (this.rows) return this.rows;
        const file = this.context.sourceFile(FORMATS_MODULE);
        const feature = this.context.stringValue(
            this.context.variableInitializer(file, "BC"),
            file,
        );
        if (feature !== "texture-compression-bc") {
            this.context.contractError(
                file,
                "Pinned compressed-format table no longer binds BC to " +
                    "'texture-compression-bc'.",
            );
        }
        const rows: CompressedFormatRow[] = [];
        for (const call of this.context.findNodes(
            file,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "add",
        )) {
            if (call.arguments.length !== 6) {
                this.context.contractError(
                    call,
                    "Pinned compressed-format `add` no longer takes " +
                        "(gl, gpuFormat, feature, blockW, blockH, blockBytes).",
                );
            }
            const [gl, format, featureArgument, blockW, blockH, blockBytes] =
                call.arguments;
            // The ETC2 and ASTC rows name their own feature constant, and
            // the ASTC ones build both the enum and the format name; both
            // are dropped here rather than read, because no D3D12 device
            // reports either feature.
            if (
                !ts.isIdentifier(featureArgument!) ||
                featureArgument.text !== "BC" ||
                !uploadableCompressedFormats.includes(
                    this.context.stringValue(format!, file),
                )
            ) {
                continue;
            }
            rows.push({
                gl: this.context.numericValue(gl!, file),
                gpuFormat: this.context.stringValue(format!, file),
                blockWidth: this.context.numericValue(blockW!, file),
                blockHeight: this.context.numericValue(blockH!, file),
                blockBytes: this.context.numericValue(blockBytes!, file),
            });
        }
        if (rows.length === 0) {
            this.context.contractError(
                file,
                "Pinned compressed-format table declares no " +
                    "block-compression rows.",
            );
        }
        this.rows = rows;
        return rows;
    }

    /**
     * `suffixToFeature`, folded from its own declaration.
     *
     * The pin writes it as a chain of `if (s.includes(<needle>)) return
     * <feature>` over the lowercased suffix, and the chain IS the contract
     * — the order decides which feature a suffix naming two of them takes
     * — so it is read as that chain rather than restated as a table. A body
     * shaped any other way refuses.
     */
    public suffixFeature(suffix: string): string | undefined {
        const { file, declaration } = this.context.functionDeclaration(
            FORMATS_MODULE,
            "suffixToFeature",
        );
        const lowered = suffix.toLowerCase();
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "s"),
            "suffix.toLowerCase()",
            "suffixToFeature lowercasing",
        );
        // One test is a disjunction — a BC container is spelled three ways
        // — so each guard is read as the set of needles any of which
        // selects it.
        const needles = (test: ts.Expression): string[] => {
            const unwrapped = this.context.unwrapExpression(test);
            if (
                ts.isBinaryExpression(unwrapped) &&
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.BarBarToken
            ) {
                return [
                    ...needles(unwrapped.left),
                    ...needles(unwrapped.right),
                ];
            }
            if (
                !ts.isCallExpression(unwrapped) ||
                !ts.isPropertyAccessExpression(unwrapped.expression) ||
                unwrapped.expression.name.text !== "includes" ||
                unwrapped.arguments.length !== 1
            ) {
                this.context.contractError(
                    unwrapped,
                    "Pinned suffixToFeature is no longer a chain of " +
                        "`includes` tests returning a feature.",
                );
            }
            return [this.context.stringValue(unwrapped.arguments[0]!, file)];
        };
        for (const statement of declaration.body!.statements) {
            if (!ts.isIfStatement(statement)) continue;
            const consequent = ts.isBlock(statement.thenStatement)
                ? statement.thenStatement.statements[0]
                : statement.thenStatement;
            if (
                !consequent ||
                !ts.isReturnStatement(consequent) ||
                !consequent.expression
            ) {
                this.context.contractError(
                    statement,
                    "Pinned suffixToFeature is no longer a chain of " +
                        "`includes` tests returning a feature.",
                );
            }
            if (
                needles(statement.expression).some((needle) =>
                    lowered.includes(needle),
                )
            ) {
                return this.context.stringValue(consequent.expression, file);
            }
        }
        return undefined;
    }

    /**
     * `rewriteUrl`, folded from its own declaration: the suffix replaces the
     * last extension of the path, and a query string rides along unchanged.
     */
    public rewriteUrl(baseUrl: string, suffix: string): string {
        const { declaration } = this.context.functionDeclaration(
            KTX_MODULE,
            "rewriteUrl",
        );
        const shapes: ReadonlyArray<[string, string]> = [
            ["qIdx", 'baseUrl.indexOf("?")'],
            ["base", "qIdx >= 0 ? baseUrl.substring(0, qIdx) : baseUrl"],
            ["query", 'qIdx >= 0 ? baseUrl.substring(qIdx) : ""'],
            ["dotIdx", 'base.lastIndexOf(".")'],
        ];
        for (const [name, shape] of shapes) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(declaration, name),
                shape,
                `rewriteUrl ${name}`,
            );
        }
        const returns = this.context.findNodes(
            declaration,
            (node): node is ts.ReturnStatement => ts.isReturnStatement(node),
        );
        const expected = [
            "base + suffix + query",
            "base.substring(0, dotIdx) + suffix + query",
        ];
        if (returns.length !== expected.length) {
            this.context.contractError(
                declaration,
                "Pinned rewriteUrl no longer replaces the last extension.",
            );
        }
        returns.forEach((statement, index) =>
            this.context.assertExpressionShape(
                statement.expression!,
                expected[index]!,
                `rewriteUrl return ${index}`,
            ),
        );
        const queryStart = baseUrl.indexOf("?");
        const base =
            queryStart >= 0 ? baseUrl.substring(0, queryStart) : baseUrl;
        const query = queryStart >= 0 ? baseUrl.substring(queryStart) : "";
        const dot = base.lastIndexOf(".");
        if (dot < 0) return base + suffix + query;
        return base.substring(0, dot) + suffix + query;
    }

    /**
     * The GL internal format a WebGPU format name is stored under.
     *
     * The pinned table maps one way — a KTX1 file states GL and the loader
     * resolves WebGPU — and packaging a transcode needs the other, because
     * what the transcoder produced is a WebGPU format and what it is
     * written into is a KTX1 header. Inverting the pin's own rows is what
     * keeps the two ends agreeing; the first row wins where two GL enums
     * decode to one format (BC1's RGB and RGBA spellings), because the
     * parser resolves both to the same row anyway.
     */
    public glInternalFormat(gpuFormat: string): number {
        const row = this.formatRows().find(
            (candidate) => candidate.gpuFormat === gpuFormat,
        );
        if (!row) {
            throw new Error(
                `The pinned compressed-format table has no KTX1 enum for ` +
                    `'${gpuFormat}', so a transcode to it cannot be ` +
                    "packaged.",
            );
        }
        return row.gl;
    }

    /**
     * `ktx2-loader.ts#srgbFormat`: the sRGB twin of a linear GPU format.
     *
     * The KTX2 decode is sRGB-agnostic — `uploadKtx2Texture2D` transcodes
     * the same blocks either way and uses its `sRGB` argument only to pick
     * this twin over the row `getCompressedFormat` returned — so a
     * transcode baked once is packaged under whichever of the two GL enums
     * the slot that reached the image asked for. The mapping is read off
     * the pin's own switch rather than restated, because a format whose
     * twin upstream renames would otherwise package as its linear self and
     * render one gamma step wrong.
     */
    public srgbGpuFormat(gpuFormat: string): string {
        if (!this.srgbTwins) {
            const { file, declaration } = this.context.functionDeclaration(
                KTX2_MODULE,
                "srgbFormat",
            );
            const twins = new Map<string, string>();
            for (const clause of this.context.findNodes(
                declaration,
                (node): node is ts.CaseClause => ts.isCaseClause(node),
            )) {
                const statement = clause.statements[0];
                if (
                    clause.statements.length !== 1 ||
                    !statement ||
                    !ts.isReturnStatement(statement) ||
                    !statement.expression
                ) {
                    this.context.contractError(
                        clause,
                        "Pinned srgbFormat case is no longer a single return.",
                    );
                }
                twins.set(
                    this.context.stringValue(clause.expression, file),
                    this.context.stringValue(statement.expression, file),
                );
            }
            if (twins.size === 0) {
                this.context.contractError(
                    declaration,
                    "Pinned srgbFormat no longer maps any format.",
                );
            }
            this.srgbTwins = twins;
        }
        const twin = this.srgbTwins.get(gpuFormat);
        if (!twin) {
            throw new Error(
                `The pinned sRGB format table has no twin for ` +
                    `'${gpuFormat}', so an sRGB slot cannot be packaged ` +
                    "from it.",
            );
        }
        return twin;
    }

    private srgbTwins?: Map<string, string>;

    /**
     * The block dimensions the pinned table gives a GPU format.
     *
     * `ktx-loader.ts` and `ktx2-loader.ts` both pad a level's copy extent
     * up to whole blocks before `writeTexture` — a 2x2 tail mip occupies
     * one 4x4 block — so packaging a capture of one of those uploads has to
     * know the block to check the chain it captured.
     */
    public blockSize(gpuFormat: string): { width: number; height: number } {
        const row = this.formatRows().find(
            (candidate) => candidate.gpuFormat === gpuFormat,
        );
        if (!row) {
            throw new Error(
                `The pinned compressed-format table has no block size for ` +
                    `'${gpuFormat}'.`,
            );
        }
        return { width: row.blockWidth, height: row.blockHeight };
    }

    /** The pinned KTX1 magic, as its own `U8([...])` literal states it. */
    public magicBytes(): number[] {
        const file = this.context.sourceFile(KTX_MODULE);
        const expression = this.context.unwrapExpression(
            this.context.variableInitializer(file, "KTX_MAGIC"),
        );
        if (
            !ts.isNewExpression(expression) ||
            !ts.isIdentifier(expression.expression) ||
            expression.expression.text !== "U8" ||
            expression.arguments?.length !== 1 ||
            !ts.isArrayLiteralExpression(expression.arguments[0]!)
        ) {
            this.context.contractError(
                expression,
                "Pinned KTX_MAGIC is no longer a U8 array literal.",
            );
        }
        return expression.arguments[0].elements.map((element) =>
            this.context.numericValue(element, file),
        );
    }

    /**
     * Each header field's byte offset, taken from the pinned parser's own
     * read of that field.
     *
     * A field the parser binds to a name is located by that name; the three
     * it validates inline — the endianness marker and the two "this is a
     * compressed texture" tests, which are all spelled `!== <constant>` —
     * are located by the message their throw carries, because two of them
     * compare against the same zero.
     */
    public headerLayout(): KtxHeaderLayout {
        const { file, declaration } = this.context.functionDeclaration(
            KTX_MODULE,
            "parseKtx1",
        );
        const offsetOf = (expression: ts.Expression): number => {
            const call = this.context.unwrapExpression(expression);
            if (
                !ts.isCallExpression(call) ||
                !ts.isPropertyAccessExpression(call.expression) ||
                call.expression.name.text !== "getUint32" ||
                call.arguments.length !== 2
            ) {
                this.context.contractError(
                    expression,
                    "Pinned KTX1 header field is no longer a getUint32 read.",
                );
            }
            return this.context.numericValue(call.arguments[0]!, file);
        };
        const named = (name: string): number =>
            offsetOf(this.context.variableInitializer(declaration, name));
        // The one field the parser folds as it reads it: a container
        // declaring no mip level still has its base level.
        const mipLevels = (): number => {
            const initializer = this.context.unwrapExpression(
                this.context.variableInitializer(
                    declaration,
                    "numberOfMipmapLevels",
                ),
            );
            if (
                !ts.isCallExpression(initializer) ||
                initializer.expression.getText(file) !== "Math.max" ||
                initializer.arguments.length !== 2 ||
                initializer.arguments[1]!.getText(file) !== "1"
            ) {
                this.context.contractError(
                    initializer,
                    "Pinned KTX1 mip count is no longer Math.max(read, 1).",
                );
            }
            return offsetOf(initializer.arguments[0]!);
        };
        // A guard carries both halves of its contract: where it reads, and
        // what it demands there. Reading the comparand off the pin is what
        // keeps the emitted `!= 0x04030201u` from being this port's own
        // claim about the format.
        const validated = (message: string): KtxHeaderGuard => {
            const guard = this.context.findNodes(
                declaration,
                (node): node is ts.IfStatement =>
                    ts.isIfStatement(node) &&
                    node.getText(file).includes(message),
            )[0];
            if (!guard || !ts.isBinaryExpression(guard.expression)) {
                this.context.contractError(
                    declaration,
                    `Pinned KTX1 parser no longer guards '${message}'.`,
                );
            }
            return {
                offset: offsetOf(guard.expression.left),
                expected: this.context.numericValue(
                    guard.expression.right,
                    file,
                ),
            };
        };
        // `let offset = 64 + bytesOfKeyValueData` — the fixed header the
        // level data follows, taken from the pin's own sum rather than
        // restated by both the parser and the packager.
        const headerSum = this.context.unwrapExpression(
            this.context.variableInitializer(declaration, "offset"),
        );
        if (
            !ts.isBinaryExpression(headerSum) ||
            headerSum.operatorToken.kind !== ts.SyntaxKind.PlusToken
        ) {
            this.context.contractError(
                headerSum,
                "Pinned KTX1 level data no longer follows a fixed header " +
                    "plus the key/value block.",
            );
        }
        const headerSize = this.context.numericValue(headerSum.left, file);
        return {
            endianness: validated("unsupported endianness"),
            glType: validated("glType != 0"),
            glFormat: validated("glFormat != 0"),
            glInternalFormat: named("glInternalFormat"),
            width: named("width"),
            height: named("height"),
            pixelDepth: named("pixelDepth"),
            arrayElements: named("numberOfArrayElements"),
            faces: named("numberOfFaces"),
            mipLevels: mipLevels(),
            keyValueBytes: named("bytesOfKeyValueData"),
            headerSize,
        };
    }

    public lower(): LoweredSource {
        const rows = this.formatRows();
        const magic = this.magicBytes();
        const header = this.headerLayout();
        // The pinned upload's own two sampler rules, asserted where it
        // states them: the mip filter follows the chain the container
        // carried, and anisotropy follows every filter in that chain being
        // linear — the same pair `loadTexture2D` states, so one loader
        // cannot silently diverge from the other.
        const { declaration: upload } = this.context.functionDeclaration(
            KTX_MODULE,
            "uploadCompressed",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(upload, "mipF"),
            'parsed.mips.length > 1 ? "linear" : "nearest"',
            "KTX sampler mip filter",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(upload, "allLinear"),
            'minF === "linear" && magF === "linear" && mipF === "linear"',
            "KTX sampler all-linear test",
        );
        // The pin writes its own constants in hex; an emitted `0x4030201`
        // is the same number and a worse quotation of it.
        const hex32 = (value: number): string =>
            `0x${value.toString(16).padStart(8, "0")}u`;
        const rowLiterals = rows
            .map(
                (row) =>
                    `    {0x${row.gl.toString(16)}u, "${row.gpuFormat}", ` +
                    `${row.blockWidth}u, ${row.blockHeight}u, ` +
                    `${row.blockBytes}u},`,
            )
            .join("\n");
        return {
            modulePath: KTX_MODULE,
            symbolName: "loadKtxTexture2D",
            header: `#pragma once

#include <bblite/runtime.hpp>

#include <array>
#include <cstdint>
#include <string_view>
#include <vector>

namespace bbl::upstream {

/**
 * One row of the pinned GL-internal-format table
 * (src/texture/compressed-formats.ts), block-compression rows only.
 */
struct CompressedFormatInfo {
    std::uint32_t gl_internal_format;
    std::string_view gpu_format;
    std::uint32_t block_width;
    std::uint32_t block_height;
    std::uint32_t block_bytes;
};

inline constexpr std::array<CompressedFormatInfo, ${rows.length}>
    compressed_formats{{
${rowLiterals}
}};

/** getCompressedFormat: the row a KTX1 glInternalFormat names, or null. */
const CompressedFormatInfo* compressed_format_for_gl(
    std::uint32_t gl_internal_format);

/** parseKtx1: the container's blocks, mip by mip. */
CompressedTexture parse_ktx1(const std::vector<std::uint8_t>& bytes);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(
                KTX_MODULE,
                "parseKtx1",
                `${FORMATS_MODULE}#getCompressedFormat`,
            )}
#include <bblite/upstream/compressed_texture.hpp>

#include <bblite/pal.hpp>

#include <algorithm>
#include <stdexcept>
#include <string>

namespace bbl::upstream {
namespace {

constexpr std::array<std::uint8_t, ${magic.length}> ktx_magic{
${magic
    .map((byte) => `    0x${byte.toString(16).padStart(2, "0")},`)
    .join("\n")}
};

std::uint32_t read_u32(
    const std::vector<std::uint8_t>& bytes,
    std::size_t offset) {
    if (offset + 4 > bytes.size()) {
        throw std::runtime_error("KTX: read past end of file");
    }
    return static_cast<std::uint32_t>(bytes[offset]) |
        (static_cast<std::uint32_t>(bytes[offset + 1]) << 8) |
        (static_cast<std::uint32_t>(bytes[offset + 2]) << 16) |
        (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

std::string hex(std::uint32_t value) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string text;
    do {
        text.insert(text.begin(), digits[value & 0xfu]);
        value >>= 4;
    } while (value != 0);
    return "0x" + text;
}

} // namespace

const CompressedFormatInfo* compressed_format_for_gl(
    std::uint32_t gl_internal_format) {
    for (const CompressedFormatInfo& row : compressed_formats) {
        if (row.gl_internal_format == gl_internal_format) return &row;
    }
    return nullptr;
}

CompressedTexture parse_ktx1(const std::vector<std::uint8_t>& bytes) {
    if (bytes.size() < ${header.headerSize}) {
        throw std::runtime_error("KTX: file too small");
    }
    for (std::size_t index = 0; index < ktx_magic.size(); ++index) {
        if (bytes[index] != ktx_magic[index]) {
            throw std::runtime_error("KTX: invalid magic");
        }
    }
    if (read_u32(bytes, ${header.endianness.offset}) != ${hex32(
      header.endianness.expected,
  )}) {
        throw std::runtime_error("KTX: unsupported endianness");
    }
    if (read_u32(bytes, ${header.glType.offset}) != ${header.glType.expected}u) {
        throw std::runtime_error(
            "KTX: not a compressed texture (glType != 0)");
    }
    if (read_u32(bytes, ${header.glFormat.offset}) != ${header.glFormat.expected}u) {
        throw std::runtime_error(
            "KTX: not a compressed texture (glFormat != 0)");
    }
    const std::uint32_t gl_internal_format =
        read_u32(bytes, ${header.glInternalFormat});
    const CompressedFormatInfo* format =
        compressed_format_for_gl(gl_internal_format);
    if (!format) {
        // The pin's own refusal, over the rows this build compiled: the
        // block-compression table, which is what a D3D12 device reports.
        throw std::runtime_error(
            "KTX: unknown glInternalFormat " + hex(gl_internal_format));
    }
    CompressedTexture texture;
    texture.format = format->gpu_format;
    texture.block_width = format->block_width;
    texture.block_height = format->block_height;
    texture.block_bytes = format->block_bytes;
    texture.width = read_u32(bytes, ${header.width});
    texture.height = read_u32(bytes, ${header.height});
    const std::uint32_t pixel_depth = read_u32(bytes, ${header.pixelDepth});
    const std::uint32_t array_elements =
        read_u32(bytes, ${header.arrayElements});
    const std::uint32_t faces = read_u32(bytes, ${header.faces});
    const std::uint32_t levels =
        std::max(read_u32(bytes, ${header.mipLevels}), 1u);
    const std::uint32_t key_value_bytes =
        read_u32(bytes, ${header.keyValueBytes});
    if (pixel_depth > 0) {
        throw std::runtime_error("KTX: 3D textures not supported");
    }
    if (array_elements > 0) {
        throw std::runtime_error("KTX: texture arrays not supported");
    }
    if (faces != 1) {
        throw std::runtime_error(
            "KTX: cubemaps not supported (use loadCubeTexture)");
    }
    std::size_t offset =
        ${header.headerSize} + static_cast<std::size_t>(key_value_bytes);
    if (offset > bytes.size()) {
        throw std::runtime_error("KTX: key/value data overflows buffer");
    }
    std::uint32_t mip_width = texture.width;
    std::uint32_t mip_height = texture.height;
    for (std::uint32_t level = 0; level < levels; ++level) {
        if (offset + 4 > bytes.size()) {
            throw std::runtime_error(
                "KTX: truncated at mip " + std::to_string(level) +
                " size field");
        }
        const std::uint32_t image_size = read_u32(bytes, offset);
        offset += 4;
        if (offset + image_size > bytes.size()) {
            throw std::runtime_error(
                "KTX: mip " + std::to_string(level) +
                " data overflows buffer");
        }
        CompressedMipLevel mip;
        mip.width = mip_width;
        mip.height = mip_height;
        mip.bytes.assign(
            bytes.begin() + static_cast<std::ptrdiff_t>(offset),
            bytes.begin() +
                static_cast<std::ptrdiff_t>(offset + image_size));
        texture.mips.push_back(std::move(mip));
        offset += image_size;
        // The pin's own four-byte alignment between levels.
        offset = (offset + 3) & ~static_cast<std::size_t>(3);
        mip_width = std::max(1u, mip_width >> 1);
        mip_height = std::max(1u, mip_height >> 1);
    }
    if (texture.mips.empty()) {
        throw std::runtime_error("KTX: no mip levels found");
    }
    return texture;
}

} // namespace bbl::upstream

namespace bbl {

// src/texture/ktx-loader.ts uploadCompressed, minus the upload itself: the
// sampler is the pin's, its mip filter following the chain the container
// carried and its anisotropy following every filter in that chain being
// linear. invert_y is the texture-OBJECT property, which this loader leaves
// unset and basis-loader.ts sets — it is what decides the Standard UV
// block's V flip, not an upload-time row swap.
FileTexture load_compressed_texture(
    Engine& engine,
    const std::string& path,
    bool invert_y) {
    FileTexture texture;
    texture.data.compressed =
        upstream::parse_ktx1(pal::read_binary_file(path));
    const bool chain = texture.data.compressed.mips.size() > 1;
    texture.data.sampler = TextureSamplerState{
        TextureFilter::linear,
        TextureFilter::linear,
        chain ? TextureMipmapMode::linear : TextureMipmapMode::nearest,
        TextureAddressMode::repeat,
        TextureAddressMode::repeat,
        chain ? 4.0f : 1.0f,
        1000.0f};
    texture.data.uv_invert_y = invert_y;
    texture.identity = engine.next_file_texture_identity++;
    return texture;
}

} // namespace bbl
`,
        };
    }
}
