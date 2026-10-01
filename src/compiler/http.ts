import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { ApplicationRealmRequired } from "./worker-modules.js";

type HttpContext = Pick<LoweringServices, "unwrap" | "libraryGlobal">;

export function compileHttpFunction(
    context: HttpContext,
    expression: ts.Expression,
): Value | undefined {
    return context.libraryGlobal(expression) === "fetch"
        ? { kind: "callback", cpp: "", hostFunction: "fetch" }
        : undefined;
}

/**
 * The request cache modes native fetches honour. Native transport and
 * packaged responses keep no HTTP cache, so each of these reads the network
 * or the package, as with an empty browser cache; `only-if-cached` would
 * fail there and refuses.
 */
const CACHE_MODES: ReadonlySet<string> = new Set([
    "default",
    "no-store",
    "reload",
    "no-cache",
    "force-cache",
]);

function expectCacheMode(
    context: Pick<LoweringServices, "fail">,
    mode: string | undefined,
    site: ts.Node,
): void {
    if (mode === undefined || !CACHE_MODES.has(mode))
        context.fail(
            site,
            `fetch option 'cache' must be a static ${[...CACHE_MODES].join("/")} mode.`,
        );
}

/**
 * Whether request options carry only a cache mode, which a packaged
 * response answers as a one-argument fetch does. The mode is validated.
 */
export function cacheOnlyRequestOptions(
    context: Pick<
        LoweringServices,
        "unwrap" | "propertyName" | "compileValue" | "fail"
    >,
    options: ts.Expression | undefined,
): boolean {
    const object = options && context.unwrap(options);
    if (!object || !ts.isObjectLiteralExpression(object)) return false;
    const assignments = object.properties.filter(ts.isPropertyAssignment);
    if (
        assignments.length === 0 ||
        assignments.length !== object.properties.length ||
        !assignments.every(
            (property) => context.propertyName(property.name) === "cache",
        )
    )
        return false;
    for (const property of assignments)
        expectCacheMode(
            context,
            context.compileValue(property.initializer).staticString,
            property.initializer,
        );
    return true;
}

/** Calls with request options or a retained fetch function use runtime transport. */
export function compileHttpCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    hostFunction?: Value["hostFunction"],
): Value | undefined {
    const context = lowerer.context;
    const callee = context.unwrap(call.expression);
    const global = context.libraryGlobal(callee) === "fetch";
    if (!global && hostFunction !== "fetch") return undefined;
    if (
        global &&
        (call.arguments.length === 1 ||
            (call.arguments.length === 2 &&
                context.probeEmission(
                    () => cacheOnlyRequestOptions(context, call.arguments[1]),
                    () => false,
                )))
    )
        return undefined;
    // Runtime transport settles on the application realm's task queue.
    if (!context.options.workers) throw new ApplicationRealmRequired();
    context.expectArgumentCount(call, 1, 2);
    context.reachFeature("platform:http", call);
    context.reachJsData();
    const snapshot = (value: Value, site: ts.Node, name: string): string => {
        const cpp = context.allocateTemporaryCppName(name);
        context.emit({
            kind: "declaration",
            type: "std::string",
            name: cpp,
            initializer: lowerer.compileKnownValueForSink(
                value,
                { kind: "string" },
                site,
            ),
        });
        return `std::move(${cpp})`;
    };
    const url = snapshot(
        context.compileValue(call.arguments[0]!),
        call.arguments[0]!,
        "http_url",
    );
    const optionsNode = call.arguments[1];
    const options = optionsNode ? context.compileValue(optionsNode) : undefined;
    if (
        options &&
        options.kind !== "record" &&
        !(options.kind === "json-null" && options.cpp === "std::nullopt")
    )
        context.fail(
            optionsNode!,
            "fetch request options require a specialized record.",
        );
    const fields = options?.recordProperties ?? {};
    for (const name of Object.keys(fields))
        if (!["method", "headers", "body", "cache"].includes(name))
            context.fail(
                optionsNode!,
                `fetch option '${name}' is not lowered.`,
            );
    if (fields.cache)
        expectCacheMode(context, fields.cache.staticString, optionsNode!);
    const method = fields.method
        ? snapshot(fields.method, optionsNode!, "http_method")
        : '"GET"';
    const headers = fields.headers;
    if (
        headers &&
        (headers.kind !== "record" ||
            Object.keys(headers.recordGetters ?? {}).length ||
            Object.keys(headers.recordMethods ?? {}).length)
    )
        context.fail(
            optionsNode!,
            "fetch headers require a string-valued record.",
        );
    const entries = Object.entries(headers?.recordProperties ?? {}).map(
        ([name, value]) =>
            `{${context.cppString(name)}, ${snapshot(value, optionsNode!, "http_header")}}`,
    );
    const body =
        !fields.body || fields.body.kind === "json-null"
            ? "std::nullopt"
            : snapshot(fields.body, optionsNode!, "http_body");
    return lowerer.leafValue(
        `bbl::pal::fetch_http(${url}, bbl::pal::HttpRequest{${method}, {${entries.join(", ")}}, ${body}})`,
        { kind: "promise", result: { kind: "http-response" } },
    );
}

export function httpResponseProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    if (owner.dataType?.kind !== "http-response") return undefined;
    if (property === "ok")
        return lowerer.leafValue(`bbl::pal::http_response_ok(${owner.cpp})`, {
            kind: "boolean",
        });
    if (property === "status")
        return lowerer.leafValue(`(${owner.cpp})->status`, { kind: "number" });
    if (property === "url")
        return lowerer.leafValue(`(${owner.cpp})->url`, { kind: "string" });
    if (property === "bodyUsed")
        return lowerer.leafValue(`(${owner.cpp})->consumed`, {
            kind: "boolean",
        });
    return undefined;
}

export function compileHttpResponseMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    owner: Value,
    method: string,
): Value | undefined {
    if (owner.dataType?.kind !== "http-response") return undefined;
    lowerer.context.expectArgumentCount(call, 0, 0);
    if (method === "text") {
        const result = lowerer.leafValue(
            `bbl::pal::http_response_text(${owner.cpp})`,
            {
                kind: "promise",
                result: { kind: "string" },
            },
        );
        return owner.packagedBodySource &&
            result.kind === "promise" &&
            result.promiseResult
            ? {
                  ...result,
                  promiseResult: {
                      ...result.promiseResult,
                      packagedBodySource: owner.packagedBodySource,
                  },
              }
            : result;
    }
    if (method === "arrayBuffer")
        return lowerer.leafValue(
            `bbl::pal::http_response_buffer(${owner.cpp})`,
            { kind: "promise", result: { kind: "arraybuffer" } },
        );
    if (method === "json") {
        lowerer.context.reachFeature("data:json", call);
        return lowerer.leafValue(
            `bbl::pal::http_response_text(${owner.cpp}).then([](const std::string& text) { return bbl::js::json_parse(text); })`,
            { kind: "promise", result: { kind: "json" } },
        );
    }
    return lowerer.context.fail(
        call,
        `Runtime Response.${method} is not lowered.`,
    );
}
