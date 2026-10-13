import ts from "typescript";
import type { WebPlatformCallContext } from "./abort-signals.js";
import type { DataLowerer } from "./data-lowering.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import type { Value } from "./types.js";

/**
 * Run-time image decoding (`bblite/pal_image_bitmap.hpp`): `createImageBitmap`
 * over a run-time Blob, the bitmap's size and `close()`, and the Blob reads
 * `text()`, `arrayBuffer()` and `bytes()`.
 */

/**
 * The `ImageBitmapOptions` members, by native field: their values are
 * `bbl::pal::image_bitmap_options`'s to accept (pal_image_bitmap.hpp), the
 * one decode policy every lowering passes them through.
 */
const OPTION_FIELDS: ReadonlyMap<string, number> = new Map([
    ["premultiplyAlpha", 0],
    ["colorSpaceConversion", 1],
    ["imageOrientation", 2],
]);

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
    const blob = context.probeEmission(() => {
        const value = context.compileValue(source);
        return value.kind === "data" && value.dataType?.kind === "blob"
            ? value
            : undefined;
    });
    if (!blob) return undefined;
    // The decode settles on the application realm's task queue.
    if (!context.options.workers) throw new ApplicationRealmRequired();
    context.expectArgumentCount(call, 2, 2);
    const held = context.bindings.pinValueToTemporary(
        context.compileValue(source),
        "bitmap_source",
    );
    const options = context.unwrap(call.arguments[1]!);
    if (!ts.isObjectLiteralExpression(options))
        return context.fail(
            options,
            "createImageBitmap options require an object literal of static strings.",
        );
    const values: string[] = ["std::nullopt", "std::nullopt", "std::nullopt"];
    for (const property of options.properties) {
        const name =
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name))
                ? property.name.text
                : undefined;
        const index = name ? OPTION_FIELDS.get(name) : undefined;
        if (!name || index === undefined || !ts.isPropertyAssignment(property))
            return context.fail(
                property,
                `createImageBitmap option '${name || property.getText()}' is not lowered.`,
            );
        if (!ts.isStringLiteralLike(property.initializer))
            return context.fail(
                property.initializer,
                `createImageBitmap ${name} requires a static string.`,
            );
        values[index] =
            `std::string(${context.cppString(property.initializer.text)})`;
    }
    context.reachFeature("image:runtime-decode", call);
    context.reachJsData();
    return {
        ...context.dataLowerer.leafValue(
            `bbl::pal::create_image_bitmap(${held.cpp}, bbl::pal::image_bitmap_options(bbl::pal::ImageBitmapOptionsInit{${values.join(", ")}}))`,
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
