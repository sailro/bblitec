import ts from "typescript";
import type { WebPlatformCallContext } from "./abort-signals.js";
import type { DataLowerer } from "./data-lowering.js";
import type { LoweringServices } from "./lowering-services.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import type { Value } from "./types.js";
import { argumentAt, propertyKey } from "./syntax.js";
import { holdsOnly } from "./type-facts.js";

/**
 * Run-time images (`bblite/pal_image_bitmap.hpp`): `createImageBitmap` over a
 * run-time Blob or a `new ImageData(rgba, width, height)`, the bitmap's size
 * and `close()`, its draws on an OffscreenCanvas 2D context, and the Blob
 * reads `text()`, `arrayBuffer()` and `bytes()`.
 */

/**
 * The `ImageBitmapOptions` string members, by `bbl::pal::ImageBitmapOptionsInit`
 * field: a Blob's decode passes them through `bbl::pal::image_bitmap_options`
 * (pal_image_bitmap.hpp), an ImageData's crop through its own policy.
 */
const OPTION_FIELDS: ReadonlyMap<string, number> = new Map([
    ["premultiplyAlpha", 0],
    ["colorSpaceConversion", 1],
    ["imageOrientation", 2],
]);

/** The resize members, by `bbl::pal::ImageBitmapResizeInit` field; only an ImageData source takes them. */
const RESIZE_FIELDS: ReadonlyMap<string, number> = new Map([
    ["resizeWidth", 0],
    ["resizeHeight", 1],
    ["resizeQuality", 2],
]);

/** The parts of `new ImageData(rgba, width, height)` a canvas call reads. */
export interface ImageDataSource {
    /** The RGBA bytes: a Uint8Array or a Uint8ClampedArray, compiled. */
    readonly pixels: Value;
    readonly width: ts.Expression;
    readonly height: ts.Expression;
}

/**
 * `new ImageData(rgba, width, height)` written as `subject`'s argument: its
 * pixels compiled (the argument of a `Uint8ClampedArray` or `Uint8Array`
 * constructor reads in place of its copy, which nothing else sees), its
 * dimensions for the caller to compile next. Other forms refuse.
 */
export function imageDataSource(
    context: Pick<
        LoweringServices,
        "compileValue" | "fail" | "libraryGlobal" | "unwrap"
    >,
    argument: ts.Expression,
    subject: string,
): ImageDataSource {
    const imageData = context.unwrap(argument);
    if (
        !ts.isNewExpression(imageData) ||
        context.libraryGlobal(imageData.expression) !== "ImageData" ||
        imageData.arguments?.length !== 3
    )
        return context.fail(
            argument,
            `${subject} requires new ImageData(rgba, width, height).`,
        );
    let pixelsExpression = argumentAt(imageData, 0);
    const pixelsConstructor = context.unwrap(pixelsExpression);
    if (
        ts.isNewExpression(pixelsConstructor) &&
        ts.isIdentifier(pixelsConstructor.expression) &&
        (pixelsConstructor.expression.text === "Uint8ClampedArray" ||
            pixelsConstructor.expression.text === "Uint8Array") &&
        pixelsConstructor.arguments?.length === 1
    )
        pixelsExpression = argumentAt(pixelsConstructor, 0);
    const pixels = context.compileValue(pixelsExpression);
    if (
        pixels.kind !== "data" ||
        (pixels.dataType?.kind !== "u8array" &&
            pixels.dataType?.kind !== "u8clampedarray")
    )
        return context.fail(
            pixelsExpression,
            `${subject}'s ImageData pixels must lower to a Uint8Array or a Uint8ClampedArray.`,
        );
    return {
        pixels,
        width: argumentAt(imageData, 1),
        height: argumentAt(imageData, 2),
    };
}

/**
 * A canvas encode's `type` as the native encoder's `std::optional` argument
 * (`pal::encode_image`). WebP, which the reference browser encodes, is not
 * linked natively, so a literal `image/webp` refuses; any other type the
 * encoder does not know is PNG, as the HTML standard says.
 */
export function canvasEncodeType(
    context: Pick<LoweringServices, "dataLowerer" | "fail" | "unwrap">,
    argument: ts.Expression | undefined,
    subject: string,
): string {
    if (!argument) return "std::nullopt";
    const literal = context.unwrap(argument);
    if (
        ts.isStringLiteralLike(literal) &&
        literal.text.toLowerCase() === "image/webp"
    )
        context.fail(
            argument,
            `${subject}('image/webp') is not encoded natively.`,
        );
    return `std::optional<std::string>{${context.dataLowerer.compileForSink(argument, { kind: "string" })}}`;
}

/** A canvas encode's `quality`, a number, as the native encoder's `std::optional` argument. */
export function canvasEncodeQuality(
    context: Pick<LoweringServices, "checker" | "compileNumber" | "fail">,
    argument: ts.Expression | undefined,
    subject: string,
): string {
    if (!argument) return "std::nullopt";
    if (!holdsOnly(context.checker.getTypeAtLocation(argument), ["number"]))
        context.fail(argument, `${subject} quality must be a number.`);
    return `std::optional<double>{${context.compileNumber(argument, "double")}}`;
}

/** Whether `expression` is written as `new ImageData(...)`. */
function isImageDataConstruction(
    context: Pick<WebPlatformCallContext, "libraryGlobal" | "unwrap">,
    expression: ts.Expression,
): boolean {
    const unwrapped = context.unwrap(expression);
    return (
        ts.isNewExpression(unwrapped) &&
        context.libraryGlobal(unwrapped.expression) === "ImageData"
    );
}

/**
 * An options literal's members as native initializers, in source order:
 * the string members (static), and with `resize` the resize members, whose
 * numbers `number` compiles. Another member refuses.
 */
function bitmapOptions(
    context: WebPlatformCallContext,
    argument: ts.Expression | undefined,
    resize: ((expression: ts.Expression) => string) | undefined,
): { strings: string[]; resize: string[] } {
    const strings = ["std::nullopt", "std::nullopt", "std::nullopt"];
    const resized = ["std::nullopt", "std::nullopt", "std::nullopt"];
    if (!argument) return { strings, resize: resized };
    const options = context.unwrap(argument);
    if (!ts.isObjectLiteralExpression(options))
        return context.fail(
            options,
            "createImageBitmap options require an object literal.",
        );
    for (const property of options.properties) {
        const name = ts.isPropertyAssignment(property)
            ? propertyKey(property.name)
            : undefined;
        const index = name ? OPTION_FIELDS.get(name) : undefined;
        const resizeIndex =
            name && resize ? RESIZE_FIELDS.get(name) : undefined;
        if (
            !name ||
            !ts.isPropertyAssignment(property) ||
            (index === undefined && resizeIndex === undefined)
        )
            return context.fail(
                property,
                `createImageBitmap option '${name || property.getText()}' is not lowered.`,
            );
        if (resize && (resizeIndex === 0 || resizeIndex === 1)) {
            resized[resizeIndex] = resize(property.initializer);
            continue;
        }
        if (!ts.isStringLiteralLike(property.initializer))
            return context.fail(
                property.initializer,
                `createImageBitmap ${name} requires a static string.`,
            );
        const value = `std::string(${context.cppString(property.initializer.text)})`;
        if (index !== undefined) strings[index] = value;
        else if (resizeIndex !== undefined) resized[resizeIndex] = value;
    }
    return { strings, resize: resized };
}

/**
 * `createImageBitmap(new ImageData(rgba, width, height)[, sx, sy, sw, sh][,
 * options])` in an application realm: each argument is held in source order
 * before the native call crops, scales and settles it.
 */
function compileImageDataBitmap(
    context: WebPlatformCallContext,
    call: ts.CallExpression,
): Value {
    if (!context.options.workers) throw new ApplicationRealmRequired();
    const count = call.arguments.length;
    if (![1, 2, 5, 6].includes(count))
        return context.fail(
            call,
            "createImageBitmap takes an image, an optional source rectangle (sx, sy, sw, sh) and optional options.",
        );
    const image = imageDataSource(
        context,
        argumentAt(call, 0),
        "createImageBitmap",
    );
    const pixels = context.bindings.pinValueToTemporary(
        image.pixels,
        "bitmap_pixels",
    );
    const number = (expression: ts.Expression): string =>
        context.bindings.pinValueToTemporary(
            {
                kind: "number",
                cpp: context.compileNumber(expression, "double"),
            },
            "bitmap_number",
        ).cpp;
    const width = number(image.width);
    const height = number(image.height);
    const source =
        count >= 5
            ? `bbl::pal::ImageBitmapSourceRect{${call.arguments
                  .slice(1, 5)
                  .map(number)
                  .join(", ")}}`
            : "std::nullopt";
    const options = bitmapOptions(
        context,
        count === 2 || count === 6 ? argumentAt(call, count - 1) : undefined,
        number,
    );
    context.reachJsData();
    return {
        ...context.dataLowerer.leafValue(
            `bbl::pal::create_image_bitmap(${pixels.cpp}, ${width}, ${height}, ${source}, ` +
                `bbl::pal::ImageBitmapOptionsInit{${options.strings.join(", ")}}, ` +
                `bbl::pal::ImageBitmapResizeInit{${options.resize.join(", ")}})`,
            { kind: "promise", result: { kind: "image-bitmap" } },
        ),
        impure: true,
    };
}

function isCreateImageBitmap(
    context: Pick<WebPlatformCallContext, "libraryGlobal" | "unwrap">,
    callee: ts.Expression,
): boolean {
    const target = context.unwrap(callee);
    if (ts.isIdentifier(target))
        return context.libraryGlobal(target) === "createImageBitmap";
    return (
        ts.isPropertyAccessExpression(target) &&
        target.name.text === "createImageBitmap" &&
        ["window", "globalThis", "self"].includes(
            context.libraryGlobal(target.expression) ?? "",
        )
    );
}

/**
 * `createImageBitmap(blob, options)` over a run-time Blob in an application
 * realm. Other sources keep their generation-time handling.
 */
export function compileImageBitmapCall(
    context: WebPlatformCallContext,
    call: ts.CallExpression,
): Value | undefined {
    if (!isCreateImageBitmap(context, call.expression)) return undefined;
    const source = call.arguments[0];
    if (!source) return undefined;
    if (isImageDataConstruction(context, source))
        return compileImageDataBitmap(context, call);
    const blob = context.probeEmission(() => {
        const value = context.compileValue(source);
        return value.kind === "data" && value.dataType?.kind === "blob"
            ? value
            : undefined;
    });
    if (!blob) return undefined;
    // The decode settles on the application realm's task queue.
    context.reachFeature("image:runtime-decode", call);
    context.expectArgumentCount(call, 2, 2);
    const held = context.bindings.pinValueToTemporary(
        context.compileValue(source),
        "bitmap_source",
    );
    const options = bitmapOptions(context, call.arguments[1], undefined);
    context.reachJsData();
    return {
        ...context.dataLowerer.leafValue(
            `bbl::pal::create_image_bitmap(${held.cpp}, bbl::pal::image_bitmap_options(bbl::pal::ImageBitmapOptionsInit{${options.strings.join(", ")}}))`,
            { kind: "promise", result: { kind: "image-bitmap" } },
        ),
        impure: true,
    };
}

/** `bitmap.width` and `bitmap.height`. */
export function imageBitmapProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    if (owner.dataType?.kind !== "image-bitmap") return undefined;
    return property === "width" || property === "height"
        ? lowerer.leafValue(`(${owner.cpp}).${property}()`, { kind: "number" })
        : undefined;
}

/**
 * `context.drawImage(bitmap, dx, dy)`, `(bitmap, dx, dy, dw, dh)` and
 * `(bitmap, sx, sy, sw, sh, dx, dy, dw, dh)` on an OffscreenCanvas 2D context
 * (`bbl::pal::offscreen_canvas_draw_image`); its other members are not lowered.
 */
export function compileOffscreenContextMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    const context = lowerer.context;
    if (method !== "drawImage")
        return context.fail(
            call,
            `OffscreenCanvasRenderingContext2D.${method} is not lowered.`,
        );
    if (![3, 5, 9].includes(call.arguments.length))
        return context.fail(
            call,
            "drawImage takes (image, dx, dy), (image, dx, dy, dw, dh) or (image, sx, sy, sw, sh, dx, dy, dw, dh).",
        );
    const image = context.compileValue(argumentAt(call, 0));
    if (image.dataType?.kind !== "image-bitmap")
        return context.fail(
            argumentAt(call, 0),
            "An OffscreenCanvas 2D context draws an ImageBitmap source.",
        );
    const numbers = call.arguments
        .slice(1)
        .map((argument) => context.compileNumber(argument, "double"));
    return {
        kind: "void",
        cpp: `bbl::pal::offscreen_canvas_draw_image(${owner.cpp}, ${image.cpp}, ${numbers.join(", ")})`,
    };
}

/** `bitmap.close()` and a Blob's `text()`, `arrayBuffer()` and `bytes()`. */
export function compileImageBitmapMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    const context = lowerer.context;
    if (owner.dataType?.kind === "image-bitmap") {
        if (method !== "close")
            return context.fail(call, `ImageBitmap.${method} is not lowered.`);
        context.expectArgumentCount(call, 0, 0);
        return { kind: "void", cpp: `(${owner.cpp}).close()` };
    }
    const reads: Readonly<
        Record<string, readonly [string, Value["dataType"]]>
    > = {
        text: ["blob_text", { kind: "string" }],
        arrayBuffer: ["blob_array_buffer", { kind: "arraybuffer" }],
        bytes: ["blob_bytes", { kind: "u8array" }],
    };
    const read = Object.hasOwn(reads, method) ? reads[method] : undefined;
    if (!read) return undefined;
    if (!context.options.workers) throw new ApplicationRealmRequired();
    context.expectArgumentCount(call, 0, 0);
    return lowerer.leafValue(`bbl::js::${read[0]}(${owner.cpp})`, {
        kind: "promise",
        ...(read[1] ? { result: read[1] } : {}),
    });
}
