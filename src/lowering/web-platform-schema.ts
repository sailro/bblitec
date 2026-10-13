/**
 * The web platform a pinned library reaches, as native records over the
 * runtime's own objects (`bblite/web_platform.hpp`): a WHATWG URL is a
 * `js::Url`, an AbortController/AbortSignal the `js_abort.hpp` ones, a
 * DOMException `js_error.hpp`'s, a TextDecoder `js_text_codec.hpp`'s, a Blob
 * `js_file.hpp`'s, and an ImageBitmap `pal_image_bitmap.hpp`'s with its
 * texture upload. Only fetch (its response and body stream), image decoding
 * and the timers and task queue go through `web_platform.hpp`'s seam, which
 * `pal_web_platform.cpp` defines over the native services and a test may
 * define deterministically. A native record emits nothing until a lowered
 * body reaches it, so every library composes the whole table.
 */
import ts from "typescript";
import { stringLiteral } from "../cpp-literals.js";
import { isUtf8Label } from "../compiler/text-codecs.js";
import type {
    CallAdapter,
    MemberSpec,
    RecordShape,
    RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    arrayOf as array,
    descriptor,
    field,
    functionOf as fn,
    members,
    optionalOf as optional,
    promiseOf as promise,
    reads,
    recordOf as record,
    recordScalars,
    spelled,
} from "./record-shapes.js";

const PLATFORM = "bbl::web_platform";
const { number, boolean, string, void: none } = recordScalars;
const error: RecordShape = { kind: "error" };
const bytes: RecordShape = { kind: "typed", element: "u8" };

/** A runtime object the pin holds by identity, its members spelled over it. */
const object = (
    pinned: readonly string[],
    cpp: string,
    entries: readonly (readonly [string, MemberSpec])[],
): RecordSpec => ({
    pinned,
    cpp,
    handle: cpp,
    reference: true,
    native: true,
    members: members(entries),
});
/** A member read through a seam function of the receiver. */
const seamRead = (shape: RecordShape, native: string): MemberSpec =>
    reads(shape, (owner) => `${PLATFORM}::${native}(${owner})`);
/** A member call through a seam function of the receiver. */
const seamCall = (shape: RecordShape, native: string): MemberSpec =>
    spelled(shape, (owner) => `${PLATFORM}::${native}(${owner})`);

/** The only event a pinned AbortSignal listens to, checked at generation. */
function abortType(type: string | undefined): void {
    if (type !== stringLiteral("abort"))
        throw new Error(
            `A lowered AbortSignal listens to "abort" events only, not ${type ?? "nothing"}.`,
        );
}

/** `typeof fetch`: the platform's fetch function. */
const fetchFunction = fn(
    [string, optional(record("RequestInit"))],
    promise(record("Response")),
);

export const webPlatformRecords: readonly RecordSpec[] = [
    object(["URL"], "js::Url", [
        ["href", reads(string, (owner) => `${owner}.href()`)],
        ["protocol", reads(string, (owner) => `${owner}.protocol()`)],
        [
            "pathname",
            {
                shape: string,
                access: (owner) => `${owner}.pathname()`,
                assign: (owner, value) => `${owner}.set_pathname(${value})`,
            },
        ],
    ]),
    object(["AbortSignal"], "js::AbortSignal", [
        ["aborted", reads(boolean, (owner) => `${owner}.aborted()`)],
        [
            // `undefined` until aborted: the empty error.
            "reason",
            reads(
                error,
                (owner) => `${owner}.reason().value_or(bbl::js::Error{})`,
            ),
        ],
        [
            "addEventListener",
            spelled(
                fn(
                    [
                        string,
                        fn([], none),
                        optional(record("AddEventListenerOptions")),
                    ],
                    none,
                ),
                (owner, [type, listener, options]) => {
                    abortType(type);
                    return `${owner}.add_abort_listener(${listener}, ${options === undefined ? "false" : `${PLATFORM}::once(${options})`})`;
                },
            ),
        ],
        [
            "removeEventListener",
            spelled(
                fn([string, fn([], none)], none),
                (owner, [type, listener]) => {
                    abortType(type);
                    return `${owner}.remove_abort_listener(${listener})`;
                },
            ),
        ],
    ]),
    descriptor(
        "AddEventListenerOptions",
        "web_platform::AddEventListenerOptions",
        [["once", field(optional(boolean))]],
    ),
    object(["AbortController"], "js::AbortController", [
        [
            "signal",
            reads(record("AbortSignal"), (owner) => `${owner}.signal()`),
        ],
        [
            "abort",
            spelled(
                fn([optional(error)], none),
                (owner, [reason]) =>
                    `${PLATFORM}::abort(${owner}, ${reason ?? "bbl::js::Error{}"})`,
            ),
        ],
    ]),
    object(["TextDecoder"], "js::TextDecoder", [
        [
            // `decode()` ends a stream; `decode(input, { stream })` continues it.
            "decode",
            spelled(
                fn(
                    [optional(bytes), optional(record("TextDecodeOptions"))],
                    string,
                ),
                (owner, args) =>
                    args.length === 0
                        ? `bbl::js::text_decode(${owner})`
                        : args.length === 1
                          ? `bbl::js::text_decode(${owner}, *${args[0]})`
                          : `${PLATFORM}::text_decode(${owner}, *${args[0]}, ${args[1]})`,
            ),
        ],
    ]),
    descriptor("TextDecoderOptions", "web_platform::TextDecoderOptions", [
        ["fatal", field(optional(boolean))],
        ["ignoreBOM", field(optional(boolean), "ignore_bom")],
    ]),
    descriptor("TextDecodeOptions", "web_platform::TextDecodeOptions", [
        ["stream", field(optional(boolean))],
    ]),
    object(["Blob"], "js::Blob", [
        [
            "text",
            spelled(
                fn([], promise(string)),
                (owner) => `bbl::js::blob_text(${owner})`,
            ),
        ],
    ]),
    descriptor("BlobPropertyBag", "web_platform::BlobPropertyBag", [
        ["type", field(optional(string))],
    ]),
    object(["ImageBitmap"], "pal::ImageBitmap", [
        ["width", reads(number, (owner) => `${owner}.width()`)],
        ["height", reads(number, (owner) => `${owner}.height()`)],
        ["close", spelled(fn([], none), (owner) => `${owner}.close()`)],
    ]),
    // The dictionary's strings, which `pal::image_bitmap_options` accepts.
    descriptor("ImageBitmapOptions", "pal::ImageBitmapOptionsInit", [
        ["premultiplyAlpha", field(optional(string), "premultiply_alpha")],
        [
            "colorSpaceConversion",
            field(optional(string), "color_space_conversion"),
        ],
        ["imageOrientation", field(optional(string), "image_orientation")],
    ]),
    descriptor(
        "GPUCopyExternalImageSourceInfo",
        "web_platform::CopyExternalImageSource",
        [
            ["source", field(record("ImageBitmap"))],
            ["flipY", field(optional(boolean), "flip_y")],
        ],
    ),
    descriptor(
        "GPUCopyExternalImageDestInfo",
        "web_platform::CopyExternalImageDestination",
        [
            ["texture", field(record("GPUTexture"))],
            [
                "premultipliedAlpha",
                field(optional(boolean), "premultiplied_alpha"),
            ],
        ],
    ),
    // The fetch seam's objects.
    descriptor("RequestInit", "web_platform::RequestInit", [
        ["signal", field(optional(record("AbortSignal")))],
    ]),
    {
        pinned: ["Response"],
        cpp: "web_platform::ResponseState",
        handle: "web_platform::Response",
        reference: true,
        native: true,
        members: members([
            ["ok", seamRead(boolean, "response_ok")],
            ["status", seamRead(number, "response_status")],
            ["url", seamRead(string, "response_url")],
            // The headers are the response's own.
            ["headers", reads(record("Headers"), (owner) => owner)],
            [
                "body",
                seamRead(optional(record("ReadableStream")), "response_body"),
            ],
        ]),
    },
    {
        pinned: ["Headers"],
        cpp: "web_platform::ResponseState",
        handle: "web_platform::Response",
        reference: true,
        native: true,
        members: members([
            [
                "get",
                spelled(
                    fn([string], optional(string)),
                    (owner, [name]) =>
                        `${PLATFORM}::response_header(${owner}, ${name})`,
                ),
            ],
        ]),
    },
    {
        pinned: ["ReadableStream"],
        cpp: "web_platform::ReadableStreamState",
        handle: "web_platform::ReadableStream",
        reference: true,
        native: true,
        members: members([
            [
                "cancel",
                seamCall(fn([], promise(none)), "readable_stream_cancel"),
            ],
            [
                "getReader",
                seamCall(
                    fn([], record("ReadableStreamDefaultReader")),
                    "readable_stream_get_reader",
                ),
            ],
        ]),
    },
    {
        pinned: ["ReadableStreamDefaultReader"],
        cpp: "web_platform::ReaderState",
        handle: "web_platform::Reader",
        reference: true,
        native: true,
        members: members([
            [
                "read",
                seamCall(
                    fn([], promise(record("ReadableStreamReadResult"))),
                    "reader_read",
                ),
            ],
            ["cancel", seamCall(fn([], promise(none)), "reader_cancel")],
            ["releaseLock", seamCall(fn([], none), "reader_release_lock")],
        ]),
    },
    {
        // Either arm of `ReadableStreamReadResult<Uint8Array>`.
        pinned: [
            "ReadableStreamReadResult",
            "ReadableStreamReadDoneResult",
            "ReadableStreamReadValueResult",
        ],
        cpp: "web_platform::ReadResult",
        reference: false,
        native: true,
        members: members([
            ["done", field(boolean)],
            ["value", field(optional(bytes))],
        ]),
    },
];

/**
 * `queue.copyExternalImageToTexture(source, destination, size)`: the decoded
 * bitmap's rows written through the device (`web_platform.hpp`).
 */
export const copyExternalImageToTexture: readonly [string, MemberSpec] = [
    "copyExternalImageToTexture",
    spelled(
        fn(
            [
                record("GPUCopyExternalImageSourceInfo"),
                record("GPUCopyExternalImageDestInfo"),
                record("GPUExtent3DDict"),
            ],
            none,
        ),
        (owner, args) =>
            `${PLATFORM}::copy_external_image_to_texture(*${owner}, ${args.join(", ")})`,
    ),
];

/** `new TextDecoder(label?, options?)`: the label must name UTF-8 at generation. */
function textDecoderConstructor(): CallAdapter {
    return {
        cpp: (argument, call) => {
            const [label, options] = call.arguments ?? [];
            if (label !== undefined) {
                if (!ts.isStringLiteralLike(label) || !isUtf8Label(label.text))
                    throw new Error(
                        "A lowered TextDecoder decodes UTF-8: its label must be a UTF-8 literal.",
                    );
            }
            return options === undefined
                ? "bbl::js::make_text_decoder(false, false)"
                : `${PLATFORM}::text_decoder(${argument(1)})`;
        },
        parameters: [string, optional(record("TextDecoderOptions"))],
    };
}

export const webPlatformConstructors: ReadonlyMap<string, CallAdapter> =
    new Map<string, CallAdapter>([
        [
            "URL",
            {
                cpp: (argument, call) =>
                    (call.arguments?.length ?? 0) > 1
                        ? `bbl::js::Url(${argument(0)}, ${argument(1)})`
                        : `bbl::js::Url(${argument(0)})`,
                parameters: [string, string],
            },
        ],
        [
            "DOMException",
            {
                cpp: (argument) =>
                    `bbl::js::Error(std::make_exception_ptr(bbl::js::make_dom_exception(${argument(0)}, ${argument(1)})))`,
                parameters: [string, string],
            },
        ],
        [
            "AbortController",
            { cpp: () => "bbl::js::AbortController::create()" },
        ],
        [
            "Blob",
            {
                cpp: (argument) =>
                    `bbl::js::Blob::from_parts(${argument(0)}, (${argument(1)}).type.value_or(std::string()))`,
                parameters: [array(bytes), record("BlobPropertyBag")],
            },
        ],
        ["TextDecoder", textDecoderConstructor()],
    ]);

/** The seam's globals: timers, tasks, fetch and image decoding. */
export const webPlatformGlobals: ReadonlyMap<string, CallAdapter> = new Map<
    string,
    CallAdapter
>([
    [
        "setTimeout",
        {
            cpp: (argument) =>
                `${PLATFORM}::set_timeout(${argument(0)}, ${argument(1)})`,
            parameters: [fn([], none), number],
        },
    ],
    [
        "clearTimeout",
        {
            cpp: (argument) => `${PLATFORM}::clear_timeout(${argument(0)})`,
            parameters: [number],
        },
    ],
    [
        "queueMicrotask",
        {
            cpp: (argument) => `${PLATFORM}::queue_microtask(${argument(0)})`,
            parameters: [fn([], none)],
        },
    ],
    ["performance.now", { cpp: () => `${PLATFORM}::performance_now()` }],
    [
        // `fetch(url, init)` with a string or a URL object.
        "fetch",
        {
            cpp: (argument) =>
                `${PLATFORM}::fetch(${argument(0)}, ${argument(1)})`,
            parameters: [undefined, record("RequestInit")],
        },
    ],
    [
        // The options' strings pass through the one decode policy.
        "createImageBitmap",
        {
            cpp: (argument) =>
                `${PLATFORM}::create_image_bitmap(${argument(0)}, bbl::pal::image_bitmap_options(${argument(1)}))`,
            parameters: [record("Blob"), record("ImageBitmapOptions")],
        },
    ],
]);

/** `globalThis.fetch` read as a function value. */
export const webPlatformGlobalValues = new Map([
    [
        "fetch",
        {
            shape: fetchFunction,
            cpp: `bbl::js::Callback<bbl::js::Promise<${PLATFORM}::Response>(std::string, bbl::js::Nullable<${PLATFORM}::RequestInit>)>([](std::string url, bbl::js::Nullable<${PLATFORM}::RequestInit> init) { return ${PLATFORM}::fetch(url, init ? *init : ${PLATFORM}::RequestInit{}); })`,
        },
    ],
]);

/** Pinned type names a web-platform value represents. */
export const webPlatformValues: ReadonlyMap<string, RecordShape> = new Map([
    ["fetch", fetchFunction],
]);

/** `error instanceof DOMException`. */
export const webPlatformInstanceOf: ReadonlyMap<
    string,
    (value: string) => string
> = new Map([
    ["DOMException", (value: string) => `bbl::js::is_dom_exception(${value})`],
]);
