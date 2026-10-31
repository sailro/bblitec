import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedStatements } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

const pixelsTextureModule = "src/texture/pixels-texture.ts";

/** The region parameters, whose `undefined` arguments take the pin's defaults. */
const regionParameters = ["x", "y", "width", "height"] as const;

/**
 * The texture's two writes, as the pin spells them, and the PAL call each
 * one is: the queue write schedules the region's upload, and the recovery
 * record's write moves the bytes into the texels every upload reads.
 */
const writes: readonly (readonly [string, string])[] = [
    [
        "engine._device.queue.writeTexture({ texture: tex.texture, origin: { x, y } }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height })",
        "pal::queue_pixels_texture_write(tex, x, y, width, height)",
    ],
    [
        "engine._dlr?.w(tex, data, x, y, width, height)",
        "pal::record_pixels_texture_write(tex, data, x, y, width, height)",
    ],
];

/**
 * `updateTexture2DFromPixels` (pixels-texture.ts): the pin's defaults and
 * validation lowered; PAL moves the region's bytes.
 */
export function lowerPixelsTextureWrites(context: LoweringContext): string {
    const name = "updateTexture2DFromPixels";
    const { file, declaration } = context.functionDeclaration(
        pixelsTextureModule,
        name,
    );
    context.assertParameterNames(
        declaration,
        [
            "engine",
            "tex",
            "data",
            ...regionParameters.map((parameter) => `${parameter}=`),
        ],
        name,
    );
    const bindings = new Map<string, PinnedBinding>([
        ["engine", { cpp: "engine", type: "opaque" }],
        ["tex", { cpp: "tex", type: "opaque" }],
        ["data", { cpp: "data", type: "opaque" }],
        [
            "data.length",
            { cpp: "static_cast<double>(data.size())", type: "scalar" },
        ],
        [
            "tex.width",
            { cpp: "static_cast<double>(tex.width)", type: "scalar" },
        ],
        [
            "tex.height",
            { cpp: "static_cast<double>(tex.height)", type: "scalar" },
        ],
        ...regionParameters.map((parameter): [string, PinnedBinding] => [
            parameter,
            { cpp: parameter, type: "scalar" },
        ]),
    ]);
    const lowered = new Set<string>();
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map(),
        foldConditions: false,
        statement(statement, _lowerer, indent) {
            if (
                !ts.isExpressionStatement(statement) ||
                !ts.isCallExpression(statement.expression)
            )
                return undefined;
            for (const [shape, cpp] of writes) {
                if (
                    !context.expressionMatchesShape(statement.expression, shape)
                )
                    continue;
                lowered.add(shape);
                return [`${indent}${cpp};`];
            }
            return undefined;
        },
    });
    const defaults = regionParameters.map((parameter, index) => {
        const initializer = declaration.parameters[index + 3]!.initializer;
        if (!initializer)
            context.contractError(
                declaration.parameters[index + 3]!,
                `Expected a default for ${name} ${parameter}.`,
            );
        return `    const double ${parameter} = ${parameter}_argument.has_value() ? *${parameter}_argument : ${lowerer.expression(initializer)};`;
    });
    const body = lowerPinnedStatements(lowerer, declaration.body!.statements);
    for (const [shape] of writes)
        if (!lowered.has(shape))
            context.contractError(
                declaration,
                `${name} no longer makes the write '${shape}'.`,
            );
    const signature = (texture: string): string =>
        `void update_texture_2d_from_pixels([[maybe_unused]] Engine& engine, ${texture} tex, const js::U8Array& data, ${regionParameters
            .map((parameter) => `std::optional<double> ${parameter}_argument`)
            .join(", ")})`;
    return `// ${context.provenance(pixelsTextureModule, name)}
${signature("const PixelsTexture&")} {
${defaults.join("\n")}
${body}
}

// Typed Texture2D storage: the pixels arm is the one this API writes.
${signature("const StoredTexture&")} {
    const auto* pixels = std::get_if<PixelsTexture>(&tex);
    if (!pixels)
        throw std::runtime_error("updateTexture2DFromPixels writes createTexture2DFromPixels textures; loadTexture2D, solid and render textures are not represented.");
    update_texture_2d_from_pixels(engine, *pixels, data, ${regionParameters
        .map((parameter) => `${parameter}_argument`)
        .join(", ")});
}`;
}
