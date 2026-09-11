import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { browserGlobalNamed } from "./browser-erasure.js";

type HttpContext = Pick<LoweringServices, "unwrap" | "lookupOptional" | "isDefaultLibraryIdentifier">;

export function compileHttpFunction(context: HttpContext, expression: ts.Expression): Value | undefined {
    return browserGlobalNamed(context, expression)?.text === "fetch" ? {kind:"callback", cpp:"", hostFunction:"fetch"} : undefined;
}

/** Calls with request options or a retained fetch function use runtime transport. */
export function compileHttpCall(lowerer: DataLowerer, call: ts.CallExpression, hostFunction?: Value["hostFunction"]): Value | undefined {
    const context = lowerer.context;
    const callee = context.unwrap(call.expression);
    const global = browserGlobalNamed(context, callee)?.text === "fetch";
    if (!global && hostFunction !== "fetch") return undefined;
    if (global && call.arguments.length === 1) return undefined;
    if (!context.options.workers) context.fail(call, "Runtime fetch requires an asynchronous application realm.");
    context.expectArgumentCount(call, 1, 2);
    context.reachFeature("platform:http", call);
    context.reachJsData();
    const snapshot = (value: Value, site: ts.Node, name: string): string => {
        const cpp = context.allocateTemporaryCppName(name);
        context.emit(`std::string ${cpp} = ${lowerer.compileKnownValueForSink(value, {kind:"string"}, site)};`);
        return `std::move(${cpp})`;
    };
    const url = snapshot(context.compileValue(call.arguments[0]!), call.arguments[0]!, "http_url");
    const optionsNode = call.arguments[1];
    const options = optionsNode ? context.compileValue(optionsNode) : undefined;
    if (options && options.kind !== "record" && !(options.kind === "json-null" && options.cpp === "std::nullopt"))
        context.fail(optionsNode!, "fetch request options require a specialized record.");
    const fields = options?.recordProperties ?? {};
    for (const name of Object.keys(fields)) if (!["method", "headers", "body"].includes(name))
        context.fail(optionsNode!, `fetch option '${name}' is not lowered.`);
    const method = fields.method ? snapshot(fields.method, optionsNode!, "http_method") : '"GET"';
    const headers = fields.headers;
    if (headers && (headers.kind !== "record" || Object.keys(headers.recordGetters ?? {}).length || Object.keys(headers.recordMethods ?? {}).length))
        context.fail(optionsNode!, "fetch headers require a string-valued record.");
    const entries = Object.entries(headers?.recordProperties ?? {}).map(([name, value]) =>
        `{${context.cppString(name)}, ${snapshot(value, optionsNode!, "http_header")}}`);
    const body = !fields.body || fields.body.kind === "json-null" ? "std::nullopt" : snapshot(fields.body, optionsNode!, "http_body");
    return lowerer.leafValue(`bbl::pal::fetch_http(${url}, bbl::pal::HttpRequest{${method}, {${entries.join(", ")}}, ${body}})`,
        {kind:"promise", result:{kind:"http-response"}});
}

export function httpResponseProperty(lowerer: DataLowerer, owner: Value, property: string): Value | undefined {
    if (owner.dataType?.kind !== "http-response") return undefined;
    if (property === "ok") return lowerer.leafValue(`bbl::pal::http_response_ok(${owner.cpp})`, {kind:"boolean"});
    if (property === "status") return lowerer.leafValue(`(${owner.cpp})->status`, {kind:"number"});
    if (property === "url") return lowerer.leafValue(`(${owner.cpp})->url`, {kind:"string"});
    if (property === "bodyUsed") return lowerer.leafValue(`(${owner.cpp})->consumed`, {kind:"boolean"});
    return undefined;
}

export function compileHttpResponseMethod(lowerer: DataLowerer, call: ts.CallExpression, owner: Value, method: string): Value | undefined {
    if (owner.dataType?.kind !== "http-response") return undefined;
    lowerer.context.expectArgumentCount(call, 0, 0);
    if (method === "text") return lowerer.leafValue(`bbl::pal::http_response_text(${owner.cpp})`, {kind:"promise", result:{kind:"string"}});
    if (method === "arrayBuffer") return lowerer.leafValue(`bbl::pal::http_response_buffer(${owner.cpp})`, {kind:"promise", result:{kind:"arraybuffer"}});
    if (method === "json") {
        lowerer.context.reachFeature("data:json", call);
        return lowerer.leafValue(`bbl::pal::http_response_text(${owner.cpp}).then([](const std::string& text) { return bbl::js::json_parse(text); })`, {kind:"promise", result:{kind:"json"}});
    }
    return lowerer.context.fail(call, `Runtime Response.${method} is not lowered.`);
}
