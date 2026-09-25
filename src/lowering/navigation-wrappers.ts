import ts from "typescript";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
    unwrapExpression,
    variableInitializer,
    contractError,
} from "./context.js";

export const WRAPPER_CORE = "@recast-navigation/core/dist/index.mjs";
export const WRAPPER_GENERATORS =
    "@recast-navigation/generators/dist/index.mjs";
const wrapperModules = new Map<string, ts.SourceFile>();

/** One installed `@recast-navigation` module's syntax tree, parsed once. */
export function wrapperModule(moduleSpecifier: string): ts.SourceFile {
    const cached = wrapperModules.get(moduleSpecifier);
    if (cached) return cached;
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve(moduleSpecifier);
    const file = ts.createSourceFile(
        modulePath,
        readFileSync(modulePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    wrapperModules.set(moduleSpecifier, file);
    return file;
}

/** The installed version of one `@recast-navigation` package. */
export function wrapperPackageVersion(name: string): string {
    const require = createRequire(import.meta.url);
    const manifest: unknown = JSON.parse(
        readFileSync(require.resolve(`${name}/package.json`), "utf8"),
    );
    if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("version" in manifest) ||
        typeof manifest.version !== "string"
    ) {
        throw new Error(`${name}'s package.json names no version.`);
    }
    return manifest.version;
}

/** `a.b.c` as its names, or undefined for anything but a property path. */
export function propertyPath(expression: ts.Expression): string[] | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) return [unwrapped.text];
    if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
    if (ts.isPropertyAccessExpression(unwrapped)) {
        const owner = propertyPath(unwrapped.expression);
        return owner ? [...owner, unwrapped.name.text] : undefined;
    }
    return undefined;
}

export type BlockArrow = ts.ArrowFunction & { body: ts.Block };

function isBlockArrow(node: ts.Node): node is BlockArrow {
    return ts.isArrowFunction(node) && ts.isBlock(node.body);
}

/** A `const name = (...) => { ... }` under `scope`, refusing any other shape. */
export function blockArrow(
    scope: ts.Node,
    name: string,
    parameters: readonly string[],
): BlockArrow {
    const arrow = unwrapExpression(variableInitializer(scope, name));
    if (
        !isBlockArrow(arrow) ||
        arrow.parameters.length !== parameters.length ||
        arrow.parameters.some(
            (parameter, index) =>
                parameter.name.getText() !== parameters[index],
        )
    ) {
        return contractError(
            arrow,
            `Expected ${name} to stay an arrow function of ` +
                `(${parameters.join(", ")}) with a body.`,
        );
    }
    return arrow;
}

/** The one statement of `statements` declaring `name`, and its index. */
export function declarationOf(
    statements: readonly ts.Statement[],
    name: string,
    at: ts.Node,
): { index: number; declaration: ts.VariableDeclaration } {
    const found = statements.flatMap((statement, index) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1 &&
        ts.isIdentifier(statement.declarationList.declarations[0]!.name) &&
        statement.declarationList.declarations[0]!.name.text === name
            ? [
                  {
                      index,
                      declaration: statement.declarationList.declarations[0]!,
                  },
              ]
            : [],
    );
    if (found.length !== 1 || !found[0]!.declaration.initializer) {
        return contractError(
            at,
            `Expected one declaration of '${name}' with an initializer.`,
        );
    }
    return found[0]!;
}

/** Where a wrapper method's value comes from on its raw object. */
export type RawSource =
    | { kind: "field"; field: string }
    | { kind: "element"; field: string }
    | { kind: "call"; method: string };

/** What one wrapper method does to its raw object. */
export type RawAccess =
    | { kind: "read"; source: RawSource }
    | { kind: "store"; field: string; element: boolean }
    | { kind: "view"; className: string; source: RawSource }
    | { kind: "nullableView"; className: string; field: string };

/** `this.raw.f`, `this.raw.get_f(p)` or `this.raw.m(params)`, over `params`. */
function rawSource(
    expression: ts.Expression,
    parameters: readonly string[],
): RawSource | undefined {
    const node = unwrapExpression(expression);
    const path = propertyPath(node);
    if (path?.length === 3 && path[0] === "this" && path[1] === "raw") {
        return { kind: "field", field: path[2]! };
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = propertyPath(node.expression);
    const args = node.arguments.map((argument) => argument.getText());
    if (
        callee?.length !== 3 ||
        callee[0] !== "this" ||
        callee[1] !== "raw" ||
        args.join(",") !== parameters.join(",")
    ) {
        return undefined;
    }
    const method = callee[2]!;
    return method.startsWith("get_") && args.length === 1
        ? { kind: "element", field: method.slice("get_".length) }
        : { kind: "call", method };
}

/** One method of a core wrapper class, as the raw access it performs. */
export function methodAccess(
    method: ts.MethodDeclaration,
): RawAccess | undefined {
    const parameters = method.parameters.map((parameter) =>
        parameter.name.getText(),
    );
    const [only] = method.body?.statements ?? [];
    if (!only || method.body!.statements.length !== 1) return undefined;
    if (ts.isReturnStatement(only) && only.expression) {
        const returned = unwrapExpression(only.expression);
        // `!Raw.isNull(this.raw.f) ? new C(this.raw.f) : null`
        if (
            ts.isConditionalExpression(returned) &&
            unwrapExpression(returned.whenFalse).kind ===
                ts.SyntaxKind.NullKeyword
        ) {
            const test = unwrapExpression(returned.condition);
            const made = unwrapExpression(returned.whenTrue);
            const tested =
                ts.isPrefixUnaryExpression(test) &&
                test.operator === ts.SyntaxKind.ExclamationToken &&
                ts.isCallExpression(test.operand) &&
                test.operand.expression.getText() === "Raw.isNull" &&
                test.operand.arguments.length === 1
                    ? rawSource(test.operand.arguments[0]!, parameters)
                    : undefined;
            if (
                tested?.kind === "field" &&
                ts.isNewExpression(made) &&
                ts.isIdentifier(made.expression) &&
                made.arguments?.length === 1 &&
                made.arguments[0]!.getText() === `this.raw.${tested.field}`
            ) {
                return {
                    kind: "nullableView",
                    className: made.expression.text,
                    field: tested.field,
                };
            }
            return undefined;
        }
        // `new C(<raw source>)`
        if (
            ts.isNewExpression(returned) &&
            ts.isIdentifier(returned.expression) &&
            returned.arguments?.length === 1
        ) {
            const source = rawSource(returned.arguments[0]!, parameters);
            return source
                ? {
                      kind: "view",
                      className: returned.expression.text,
                      source,
                  }
                : undefined;
        }
        const source = rawSource(returned, parameters);
        return source ? { kind: "read", source } : undefined;
    }
    if (!ts.isExpressionStatement(only)) return undefined;
    const statement = unwrapExpression(only.expression);
    // `this.raw.f = value`
    if (
        ts.isBinaryExpression(statement) &&
        statement.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parameters.length === 1 &&
        statement.right.getText() === parameters[0]
    ) {
        const path = propertyPath(statement.left);
        return path?.length === 3 && path[0] === "this" && path[1] === "raw"
            ? { kind: "store", field: path[2]!, element: false }
            : undefined;
    }
    // `this.raw.set_f(index, value)`
    if (ts.isCallExpression(statement) && parameters.length === 2) {
        const callee = propertyPath(statement.expression);
        if (
            callee?.length === 3 &&
            callee[0] === "this" &&
            callee[1] === "raw" &&
            callee[2]!.startsWith("set_") &&
            statement.arguments
                .map((argument) => argument.getText())
                .join(",") === parameters.join(",")
        ) {
            return {
                kind: "store",
                field: callee[2]!.slice("set_".length),
                element: true,
            };
        }
    }
    return undefined;
}

export function provenance(
    pack: "core" | "generators",
    symbol: string,
): string {
    return (
        `\`${symbol}\` from @recast-navigation/${pack}@` +
        `${wrapperPackageVersion(`@recast-navigation/${pack}`)}, lowered from ` +
        "the installed package."
    );
}
