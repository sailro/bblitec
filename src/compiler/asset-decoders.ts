import ts from "typescript";
import { argumentAt, propertyKey } from "./syntax.js";
import type { LoweringServices } from "./lowering-services.js";
import { isGlobalUndefined } from "./symbols.js";
import type { Value } from "./types.js";

type Context = Pick<
    LoweringServices,
    | "expectArgumentCount"
    | "compileValue"
    | "emitDiscardedValue"
    | "unwrap"
    | "checker"
    | "assetRegistry"
    | "fail"
    | "runGenerationFunction"
>;

/** A decoder's URL and, for KTX2, its transcoders' overrides by format. */
interface DecoderUrls {
    url: string;
    overrides?: Record<string, Record<string, string>>;
}

/** Bootstrap decoder locations become inputs to the corresponding packaging pass. */
export function compileAssetDecoderConfiguration(
    context: Context,
    name: string,
    call: ts.CallExpression,
): Value {
    const { url, overrides } =
        spreadDecoderUrls(context, name, call) ??
        literalDecoderUrls(context, name, call);
    if (name === "setMeshoptBaseUrl") {
        const base = url.endsWith("/") ? url : `${url}/`;
        context.assetRegistry.setAssetDecoderConfiguration(
            {
                meshopt: {
                    javascript: context.assetRegistry.resolveBundledAsset(
                        `${base}meshopt_decoder.js`,
                    ),
                },
            },
            call,
        );
        return { kind: "void", cpp: "" };
    }
    if (name === "setDracoBaseUrl") {
        const base = url.endsWith("/") ? url : `${url}/`;
        context.assetRegistry.setAssetDecoderConfiguration(
            {
                draco: {
                    javascript: context.assetRegistry.resolveBundledAsset(
                        `${base}draco_decoder.js`,
                    ),
                    wasm: context.assetRegistry.resolveBundledAsset(
                        `${base}draco_decoder.wasm`,
                    ),
                },
            },
            call,
        );
        return { kind: "void", cpp: "" };
    }
    const wasmUrls =
        overrides &&
        Object.fromEntries(
            Object.entries(overrides).map(([format, fields]) => [
                format,
                Object.fromEntries(
                    Object.entries(fields).map(([field, value]) => [
                        field,
                        context.assetRegistry.resolveBundledAsset(value),
                    ]),
                ),
            ]),
        );
    context.assetRegistry.setAssetDecoderConfiguration(
        {
            ktx2: {
                javascript: context.assetRegistry.resolveBundledAsset(url),
                ...(wasmUrls ? { wasmUrls } : {}),
            },
        },
        call,
    );
    return { kind: "void", cpp: "" };
}

/** The decoder URLs a call spells as literal arguments, each known during generation. */
function literalDecoderUrls(
    context: Context,
    name: string,
    call: ts.CallExpression,
): DecoderUrls {
    context.expectArgumentCount(call, 1, name === "setKtx2DecoderUrl" ? 2 : 1);
    const constantUrl = (expression: ts.Expression): string => {
        const value = context.compileValue(expression);
        if (value.staticString === undefined)
            context.fail(
                expression,
                "Asset decoder URLs must be known during generation.",
            );
        context.emitDiscardedValue(value);
        return value.staticString;
    };
    const url = constantUrl(argumentAt(call, 0));
    const source = call.arguments[1] && context.unwrap(call.arguments[1]);
    if (
        name !== "setKtx2DecoderUrl" ||
        !source ||
        source.kind === ts.SyntaxKind.NullKeyword ||
        isGlobalUndefined(context.checker, source)
    )
        return { url };
    const read = (
        expression: ts.Expression,
    ): Array<[string, ts.Expression]> => {
        const node = context.unwrap(expression);
        if (!ts.isObjectLiteralExpression(node))
            context.fail(
                node,
                "Decoder URL overrides require fresh object literals with constant string values.",
            );
        return node.properties.map((property) => {
            const name = ts.isPropertyAssignment(property)
                ? propertyKey(property.name)
                : undefined;
            if (name === undefined || !ts.isPropertyAssignment(property))
                return context.fail(
                    property,
                    "Decoder URL overrides require named properties.",
                );
            return [name, property.initializer] as const;
        });
    };
    return {
        url,
        overrides: Object.fromEntries(
            read(source).map(([format, fields]) => [
                format,
                Object.fromEntries(
                    read(fields).map(([field, value]) => [
                        field,
                        constantUrl(value),
                    ]),
                ),
            ]),
        ),
    };
}

/**
 * The arguments a call spreads from a call generation runs
 * (`setKtx2DecoderUrl(...decoderUrls(base))`): the URLs must be known
 * during generation anyway, so the closed call's tuple is the arguments.
 */
function spreadDecoderUrls(
    context: Context,
    name: string,
    call: ts.CallExpression,
): DecoderUrls | undefined {
    const [argument, ...rest] = call.arguments;
    if (!argument || !ts.isSpreadElement(argument)) return undefined;
    const source = context.unwrap(argument.expression);
    if (rest.length > 0 || !ts.isCallExpression(source))
        return context.fail(
            argument,
            "Spread decoder URLs must be the only argument, from a call generation can run.",
        );
    const value = context.runGenerationFunction(
        source,
        [],
        `Decoder URLs '${source.expression.getText()}'`,
    );
    const record = (
        item: unknown,
        field: (member: unknown) => boolean,
    ): boolean =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        Object.values(item).every(field);
    const table = (
        item: unknown,
    ): item is Record<string, Record<string, string>> =>
        record(item, (fields) =>
            record(fields, (url) => typeof url === "string"),
        );
    const items: readonly unknown[] = Array.isArray(value) ? value : [];
    const [url, overrides, ...more] = items;
    const absent = overrides === undefined || overrides === null;
    if (
        typeof url !== "string" ||
        more.length > 0 ||
        (!absent && (name !== "setKtx2DecoderUrl" || !table(overrides)))
    )
        return context.fail(
            argument,
            `'${name}' spreads ${JSON.stringify(value)}, not ${name === "setKtx2DecoderUrl" ? "a URL and optional transcoder URLs by format" : "one URL"}.`,
        );
    return table(overrides) ? { url, overrides } : { url };
}
