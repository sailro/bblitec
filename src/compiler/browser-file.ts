import ts from "typescript";

import { browserGlobalNamed } from "./browser-erasure.js";
import type { Feature, Value, ValueKind } from "./types.js";

/**
 * The bounded browser file surface is a host service, like Web Storage.  This
 * module owns its value shapes so Blob/object-URL/File handling does not become
 * another branch in the Babylon intrinsic registry.
 */
export interface BrowserFileContext {
    readonly checker: ts.TypeChecker;
    unwrap(expression: ts.Expression): ts.Expression;
    resolveStaticExpression(expression: ts.Expression): ts.Expression;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    propertyName(name: ts.PropertyName): string | undefined;
    compileValue(expression: ts.Expression): Value;
    compileStringLiteral(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    cppString(value: string): string;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    expectKind(value: Value, kind: ValueKind, node: ts.Node): void;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    requireEngine(value: Value, node: ts.Node): string;
    requireDefaultEngine(node: ts.Node): string;
    reachFeature(feature: Feature, site?: ts.Node): void;
    reachJsData(): void;
    fail(node: ts.Node, message: string): never;
}

const knownAcceptMimeExtensions = new Map<string, readonly string[]>([
    ["application/json", ["json"]],
    ["text/json", ["json"]],
    ["text/plain", ["txt"]],
    ["text/csv", ["csv"]],
]);

type DefaultGlobalContext = Pick<
    BrowserFileContext,
    "isDefaultLibraryIdentifier" | "lookupOptional" | "unwrap"
>;

function isDefaultGlobal(
    context: DefaultGlobalContext,
    expression: ts.Expression,
    name: string,
): expression is ts.Identifier {
    return browserGlobalNamed(context, expression)?.text === name &&
        ts.isIdentifier(expression);
}

function staticPropertyName(
    context: BrowserFileContext,
    name: ts.PropertyName,
): string {
    return (
        context.propertyName(name) ??
        context.fail(
            name,
            "Blob options require statically named properties.",
        )
    );
}

function blobPartCpp(
    context: BrowserFileContext,
    expression: ts.Expression,
): string {
    const part = context.compileValue(expression);
    if (
        part.kind === "string" ||
        (part.kind === "data" && part.dataType?.kind === "string")
    ) {
        return `bbl::js::blob_part_string(${part.cpp})`;
    }
    if (part.kind === "data" && part.dataType?.kind === "u8array") {
        return `bbl::js::blob_part_bytes(${part.cpp})`;
    }
    if (part.kind === "data" && part.dataType?.kind === "arraybuffer") {
        return `bbl::js::blob_part_bytes(${part.cpp})`;
    }
    const checked = context.checker.getTypeAtLocation(expression);
    const typeName =
        checked.aliasSymbol?.getName() ??
        checked.getSymbol()?.getName() ??
        part.dataType?.kind ??
        part.kind;
    return context.fail(
        expression,
        `BlobPart type '${typeName}' is not lowered; supported parts are strings, Uint8Array, and ArrayBuffer.`,
    );
}

function blobType(
    context: BrowserFileContext,
    options: ts.Expression | undefined,
): string {
    if (!options) return "";
    const resolved = context.unwrap(
        context.resolveStaticExpression(options),
    );
    if (!ts.isObjectLiteralExpression(resolved)) {
        return context.fail(
            options,
            "Blob options require a static object literal.",
        );
    }
    let type = "";
    let sawType = false;
    for (const property of resolved.properties) {
        if (!ts.isPropertyAssignment(property)) {
            return context.fail(
                property,
                "Blob options support only the static 'type' property.",
            );
        }
        const name = staticPropertyName(context, property.name);
        if (name !== "type") {
            return context.fail(
                property.name,
                `Blob option '${name}' is not lowered; only 'type' is supported.`,
            );
        }
        if (sawType) {
            return context.fail(
                property.name,
                "Blob option 'type' may be declared only once.",
            );
        }
        sawType = true;
        type = context.compileStringLiteral(property.initializer);
    }
    // File API lower-cases a valid ASCII type. A non-ASCII/control type becomes
    // the empty string in browsers; refusing it keeps a malformed type from
    // reaching an OS filter under a success-shaped fallback.
    for (const character of type) {
        const code = character.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) {
            return context.fail(
                options,
                "Blob option 'type' must contain printable ASCII MIME text.",
            );
        }
    }
    return type.toLowerCase();
}

/** `new Blob(parts, options)` for the reached string/byte-part slice. */
export function compileBrowserFileConstructor(
    context: BrowserFileContext,
    expression: ts.NewExpression,
): Value | undefined {
    if (!isDefaultGlobal(context, expression.expression, "Blob")) {
        return undefined;
    }
    const arguments_ = expression.arguments ?? [];
    if (arguments_.length > 2) {
        context.fail(
            expression,
            "Blob expects an optional parts array and static options object.",
        );
    }
    const partsExpression = arguments_[0]
        ? context.unwrap(arguments_[0])
        : undefined;
    if (partsExpression && !ts.isArrayLiteralExpression(partsExpression)) {
        context.fail(
            arguments_[0]!,
            "Blob parts require an array literal of strings or bytes.",
        );
    }
    const parts: string[] = [];
    for (const element of partsExpression?.elements ?? []) {
        if (ts.isSpreadElement(element)) {
            context.fail(
                element,
                "Blob parts do not support a spread; list each string or byte part in order.",
            );
        }
        parts.push(blobPartCpp(context, element));
    }
    const type = blobType(context, arguments_[1]);
    context.reachFeature("browser:file", expression);
    context.reachJsData();
    return {
        kind: "blob",
        cpp:
            `bbl::js::Blob({${parts.join(", ")}}, ` +
            `${context.cppString(type)})`,
        truthinessCpp: "true",
    };
}

/** Calls on URL, File, and FileList owned by the browser file bridge. */
export function compileBrowserFileCall(
    context: BrowserFileContext,
    call: ts.CallExpression,
): Value | undefined {
    const callee = context.unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    if (
        isDefaultGlobal(context, callee.expression, "URL") &&
        (callee.name.text === "createObjectURL" ||
            callee.name.text === "revokeObjectURL")
    ) {
        context.expectArgumentCount(call, 1, 1);
        const argument = context.compileValue(call.arguments[0]!);
        const engine = context.requireDefaultEngine(call);
        context.reachFeature("browser:file", call);
        if (callee.name.text === "createObjectURL") {
            context.expectKind(argument, "blob", call.arguments[0]!);
            return {
                kind: "object-url",
                cpp: `bbl::js::create_object_url(${engine}, ${argument.cpp})`,
                engineCpp: engine,
                truthinessCpp: "true",
                impure: true,
            };
        }
        context.expectKind(argument, "object-url", call.arguments[0]!);
        return {
            kind: "void",
            cpp: `bbl::js::revoke_object_url(${engine}, ${argument.cpp})`,
        };
    }
    const receiver = context.unwrap(callee.expression);
    const boundReceiver = ts.isIdentifier(receiver)
        ? context.lookupOptional(receiver)
        : undefined;
    const receiverType = context.checker.getTypeAtLocation(receiver);
    const receiverMayBeFile =
        boundReceiver?.kind === "file" ||
        receiverType.getSymbol()?.getName() === "File" ||
        ((receiverType.flags & ts.TypeFlags.Union) !== 0 &&
            (receiverType as ts.UnionType).types.some(
                (member) => member.getSymbol()?.getName() === "File",
            ));
    if (!receiverMayBeFile) return undefined;
    const owner =
        ts.isIdentifier(receiver) ||
        ts.isPropertyAccessExpression(receiver) ||
        ts.isElementAccessExpression(receiver)
            ? context.compileValue(receiver)
            : undefined;
    if (owner?.kind !== "file") return undefined;
    if (callee.name.text !== "text") {
        context.fail(
            callee.name,
            `File method '${callee.name.text}' is not lowered; only text() is supported.`,
        );
    }
    context.expectArgumentCount(call, 0, 0);
    const engine = context.requireEngine(owner, call);
    context.reachFeature("browser:file", call);
    return {
        // The AOT promise layer consumes this string immediately when it
        // lowers `.then(text => ...)`.
        kind: "data",
        cpp: `bbl::js::file_text(${engine}, ${owner.cpp})`,
        dataType: { kind: "string" },
        engineCpp: engine,
        impure: true,
        freshData: true,
    };
}

/**
 * `input.files?.[0]`. The native FileList is a one-selection snapshot; only
 * index zero exists because `multiple` is outside the reached slice.
 */
export function compileBrowserFileElementAccess(
    context: BrowserFileContext,
    expression: ts.ElementAccessExpression,
): Value | undefined {
    const ownerExpression = context.unwrap(expression.expression);
    const ownerType = context.checker.getTypeAtLocation(
        expression.expression,
    );
    const propertyFiles =
        ts.isPropertyAccessExpression(ownerExpression) &&
        ownerExpression.name.text === "files";
    const propertyBase = propertyFiles
        ? context.unwrap(ownerExpression.expression)
        : undefined;
    const mayBeFileList =
        (ts.isIdentifier(ownerExpression) &&
            context.lookupOptional(ownerExpression)?.kind === "file-list") ||
        (propertyFiles &&
            ((propertyBase &&
                ts.isIdentifier(propertyBase) &&
                context.lookupOptional(propertyBase)?.kind ===
                    "ui-element") ||
                ownerType.getSymbol()?.getName() === "FileList"));
    if (!mayBeFileList) return undefined;
    const owner = context.compileValue(expression.expression);
    if (owner.kind !== "file-list") return undefined;
    const index = context.compileValue(expression.argumentExpression);
    if (index.kind !== "number" || index.staticNumber !== 0) {
        context.fail(
            expression.argumentExpression,
            "Native FileList supports only the single selected file at index 0.",
        );
    }
    const engine = context.requireEngine(owner, expression);
    context.reachFeature("browser:file", expression);
    return {
        kind: "file",
        cpp: `bbl::js::file_at(${owner.cpp}, 0u)`,
        engineCpp: engine,
        impure: true,
    };
}

/** Property reads on Blob/FileList values. */
export function compileBrowserFileProperty(
    context: BrowserFileContext,
    owner: Value,
    expression: ts.PropertyAccessExpression,
): Value | undefined {
    const property = expression.name.text;
    if (owner.kind === "ui-element" && property === "files") {
        if (owner.uiTag !== "input") {
            context.fail(
                expression,
                "The native files list exists only on a retained <input type=\"file\">.",
            );
        }
        if (!owner.uiFileInput) {
            context.fail(
                expression,
                "Reading input.files requires a preceding static assignment input.type = 'file'.",
            );
        }
        const engine = context.requireEngine(owner, expression);
        context.reachFeature("browser:file", expression);
        return {
            kind: "file-list",
            cpp: `bbl::js::input_files(${engine}, ${owner.cpp})`,
            engineCpp: engine,
            truthinessCpp: "true",
        };
    }
    if (owner.kind === "blob") {
        if (property === "type") {
            return {
                kind: "data",
                cpp: `${owner.cpp}.type()`,
                dataType: { kind: "string" },
                readOnly: true,
            };
        }
        if (property === "size") {
            return {
                kind: "number",
                cpp: `static_cast<double>(${owner.cpp}.size())`,
                dataType: { kind: "number" },
            };
        }
        context.fail(
            expression.name,
            `Blob property '${property}' is not lowered; supported properties are type and size.`,
        );
    }
    if (owner.kind === "file-list") {
        if (property === "length") {
            return {
                kind: "number",
                cpp: `static_cast<double>(${owner.cpp}.length())`,
                dataType: { kind: "number" },
            };
        }
        context.fail(
            expression.name,
            `FileList property '${property}' is not lowered; use length or index 0.`,
        );
    }
    return undefined;
}

/**
 * Validate and canonicalize the static `<input accept>` list. Exact MIME
 * tokens and safe extensions are supported; wildcards, parameters, empty
 * entries, and every unmappable MIME token refuse by name.
 */
export function validateFileAccept(
    context: Pick<BrowserFileContext, "fail">,
    value: string,
    node: ts.Node,
): string {
    if (value.length === 0) return "";
    const tokens = value.split(",").map((token) => token.trim());
    const canonical: string[] = [];
    const extensions = new Set<string>();
    for (const token of tokens) {
        if (token.length === 0) {
            context.fail(
                node,
                "File input accept contains an empty entry.",
            );
        }
        if (/^\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(token)) {
            const extension = token.toLowerCase();
            extensions.add(extension.slice(1));
            canonical.push(extension);
            continue;
        }
        if (
            !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(
                token,
            )
        ) {
            context.fail(
                node,
                `File input accept entry '${token}' is not supported; use an exact MIME type or a safe extension such as '.json'.`,
            );
        }
        const mime = token.toLowerCase();
        const inferred = knownAcceptMimeExtensions.get(mime);
        if (!inferred) {
            context.fail(
                node,
                `File input accept entry '${token}' cannot be mapped to a safe extension.`,
            );
        }
        for (const extension of inferred) extensions.add(extension);
        canonical.push(mime);
    }
    if (extensions.size === 0) {
        context.fail(
            node,
            "File input accept must contain a safe extension or a supported MIME type.",
        );
    }
    return [...new Set(canonical)].join(",");
}

/**
 * Browser-erasure carve-out. It is deliberately structural and default-global
 * based, so the compile-time object URLs inside executed texture producers are
 * still owned by that producer's Chromium path.
 */
export function isNativeBrowserFileExpression(
    context: Pick<
        BrowserFileContext,
        "isDefaultLibraryIdentifier" | "lookupOptional" | "unwrap"
    >,
    expression: ts.Expression,
): boolean {
    const value = context.unwrap(expression);
    if (
        ts.isNewExpression(value) &&
        isDefaultGlobal(context, value.expression, "Blob")
    ) {
        return true;
    }
    if (
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        isDefaultGlobal(context, value.expression.expression, "URL") &&
        (value.expression.name.text === "createObjectURL" ||
            value.expression.name.text === "revokeObjectURL")
    ) {
        return true;
    }
    let filesOwner: ts.Expression | undefined;
    if (ts.isElementAccessExpression(value)) {
        const list = context.unwrap(value.expression);
        if (
            ts.isPropertyAccessExpression(list) &&
            list.name.text === "files"
        ) {
            filesOwner = context.unwrap(list.expression);
        }
    } else if (
        ts.isPropertyAccessExpression(value) &&
        value.name.text === "files"
    ) {
        filesOwner = context.unwrap(value.expression);
    }
    if (
        filesOwner &&
        ts.isIdentifier(filesOwner) &&
        context.lookupOptional(filesOwner)?.kind === "ui-element"
    ) {
        return true;
    }
    return false;
}
