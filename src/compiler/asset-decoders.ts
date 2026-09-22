import ts from "typescript";
import { argumentAt } from "./syntax.js";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";

type Context = Pick<
    LoweringServices,
    | "expectArgumentCount"
    | "compileValue"
    | "emitDiscardedValue"
    | "unwrap"
    | "lookupIdentifierValue"
    | "resolveBundledAsset"
    | "setAssetDecoderConfiguration"
    | "fail"
>;

/** Bootstrap decoder locations become inputs to the corresponding packaging pass. */
export function compileAssetDecoderConfiguration(
    context: Context,
    name: string,
    call: ts.CallExpression,
): Value {
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
    if (name === "setMeshoptBaseUrl") {
        const base = url.endsWith("/") ? url : `${url}/`;
        context.setAssetDecoderConfiguration(
            {
                meshopt: {
                    javascript: context.resolveBundledAsset(
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
        context.setAssetDecoderConfiguration(
            {
                draco: {
                    javascript: context.resolveBundledAsset(
                        `${base}draco_decoder.js`,
                    ),
                    wasm: context.resolveBundledAsset(
                        `${base}draco_decoder.wasm`,
                    ),
                },
            },
            call,
        );
        return { kind: "void", cpp: "" };
    }
    const source = call.arguments[1] && context.unwrap(call.arguments[1]);
    let wasmUrls: Record<string, Record<string, string>> | undefined;
    if (
        source &&
        source.kind !== ts.SyntaxKind.NullKeyword &&
        !(
            ts.isIdentifier(source) &&
            source.text === "undefined" &&
            !context.lookupIdentifierValue(source)
        )
    ) {
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
                if (
                    !ts.isPropertyAssignment(property) ||
                    ts.isComputedPropertyName(property.name)
                )
                    context.fail(
                        property,
                        "Decoder URL overrides require named properties.",
                    );
                return [property.name.text, property.initializer];
            });
        };
        wasmUrls = Object.fromEntries(
            read(source).map(([name, fields]) => [
                name,
                Object.fromEntries(
                    read(fields).map(([field, value]) => [
                        field,
                        context.resolveBundledAsset(constantUrl(value)),
                    ]),
                ),
            ]),
        );
    }
    context.setAssetDecoderConfiguration(
        {
            ktx2: {
                javascript: context.resolveBundledAsset(url),
                ...(wasmUrls ? { wasmUrls } : {}),
            },
        },
        call,
    );
    return { kind: "void", cpp: "" };
}
