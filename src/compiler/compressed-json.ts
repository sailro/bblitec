// Generation-time lowering for source-owned compressed JSON documents.
//
// Babylon Lite keeps large NME graphs out of its browser bundles by storing
// gzip/base64 text in a scene-adjacent module.  The module's decoder uses the
// browser Compression Streams surface, but its result is immutable input to a
// generated graph, not runtime scene state.  Recognize that source shape and
// carry the parsed JSON through the compiler's existing record/tuple values.
// The match is structural so this is a format capability rather than a scene
// or export-name special case.
import { gunzipSync } from "node:zlib";
import ts from "typescript";

import { doubleLiteral } from "../cpp-literals.js";
import type { Value } from "./types.js";

export interface CompressedJsonContext {
    readonly checker: ts.TypeChecker;
    compileStringLiteral(expression: ts.Expression): string;
    compileValue(expression: ts.Expression): Value;
    cppString(value: string): string;
    fail(node: ts.Node, message: string): never;
}

function functionDeclaration(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): ts.FunctionDeclaration | undefined {
    const symbol = checker.getSymbolAtLocation(identifier);
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return target?.declarations?.find(
        (candidate): candidate is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(candidate) && candidate.body !== undefined,
    );
}

/** Remove syntax that cannot change the value or operation being matched. */
function unwrap(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function identifierIs(
    expression: ts.Expression | undefined,
    expected: string,
): expression is ts.Identifier {
    return !!expression &&
        ts.isIdentifier(unwrap(expression)) &&
        (unwrap(expression) as ts.Identifier).text === expected;
}

/** A built-in rather than a same-spelled module binding. */
function globalIdentifierIs(
    checker: ts.TypeChecker,
    expression: ts.Expression,
    expected: string,
): expression is ts.Identifier {
    const unwrapped = unwrap(expression);
    if (!ts.isIdentifier(unwrapped) || unwrapped.text !== expected) {
        return false;
    }
    const symbol = checker.getSymbolAtLocation(unwrapped);
    return !!symbol?.declarations?.length &&
        symbol.declarations.every(
            (declaration) => declaration.getSourceFile().isDeclarationFile,
        );
}

function propertyCall(
    expression: ts.Expression,
    property: string,
): ts.CallExpression | undefined {
    const call = unwrap(expression);
    if (
        !ts.isCallExpression(call) ||
        call.questionDotToken ||
        (call.typeArguments?.length ?? 0) !== 0 ||
        !ts.isPropertyAccessExpression(call.expression) ||
        call.expression.questionDotToken ||
        call.expression.name.text !== property
    ) {
        return undefined;
    }
    return call;
}

function constBinding(
    statement: ts.Statement,
): { name: string; initializer: ts.Expression } | undefined {
    if (
        !ts.isVariableStatement(statement) ||
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
        statement.declarationList.declarations.length !== 1
    ) {
        return undefined;
    }
    const declaration = statement.declarationList.declarations[0]!;
    return ts.isIdentifier(declaration.name) && declaration.initializer
        ? {
              name: declaration.name.text,
              initializer: declaration.initializer,
          }
        : undefined;
}

function singleStatement(
    statement: ts.Statement,
): ts.Statement | undefined {
    return ts.isBlock(statement)
        ? statement.statements.length === 1
            ? statement.statements[0]
            : undefined
        : statement;
}

function isReturnOf(
    statement: ts.Statement,
    name: string,
): boolean {
    const only = singleStatement(statement);
    return !!only &&
        ts.isReturnStatement(only) &&
        identifierIs(only.expression, name);
}

function isContinue(statement: ts.Statement): boolean {
    const only = singleStatement(statement);
    return !!only && ts.isContinueStatement(only);
}

function isStringLiteral(
    expression: ts.Expression,
    expected: string,
): boolean {
    const unwrapped = unwrap(expression);
    return ts.isStringLiteralLike(unwrapped) && unwrapped.text === expected;
}

function isPropertyRead(
    expression: ts.Expression,
    owner: string,
    property: string,
): boolean {
    const unwrapped = unwrap(expression);
    return ts.isPropertyAccessExpression(unwrapped) &&
        !unwrapped.questionDotToken &&
        unwrapped.name.text === property &&
        identifierIs(unwrapped.expression, owner);
}

function plainIdentifierParameter(
    parameter: ts.ParameterDeclaration,
): parameter is ts.ParameterDeclaration & { name: ts.Identifier } {
    return ts.isIdentifier(parameter.name) &&
        !parameter.dotDotDotToken &&
        !parameter.questionToken &&
        !parameter.initializer;
}

function isArrayCheck(
    checker: ts.TypeChecker,
    expression: ts.Expression,
    value: string,
): boolean {
    const call = propertyCall(expression, "isArray");
    return !!call &&
        call.arguments.length === 1 &&
        ts.isPropertyAccessExpression(call.expression) &&
        globalIdentifierIs(checker, call.expression.expression, "Array") &&
        identifierIs(call.arguments[0], value);
}

function isNegated(
    expression: ts.Expression,
    predicate: (operand: ts.Expression) => boolean,
): boolean {
    const unwrapped = unwrap(expression);
    return ts.isPrefixUnaryExpression(unwrapped) &&
        unwrapped.operator === ts.SyntaxKind.ExclamationToken &&
        predicate(unwrapped.operand);
}

function isTypeOfComparison(
    expression: ts.Expression,
    owner: string,
    property: string | undefined,
    operator: ts.SyntaxKind.EqualsEqualsEqualsToken | ts.SyntaxKind.ExclamationEqualsEqualsToken,
    expected: string,
): boolean {
    const comparison = unwrap(expression);
    if (
        !ts.isBinaryExpression(comparison) ||
        comparison.operatorToken.kind !== operator ||
        !ts.isTypeOfExpression(unwrap(comparison.left)) ||
        !isStringLiteral(comparison.right, expected)
    ) {
        return false;
    }
    const operand = unwrap(
        (unwrap(comparison.left) as ts.TypeOfExpression).expression,
    );
    return property === undefined
        ? identifierIs(operand, owner)
        : isPropertyRead(operand, owner, property);
}

function isMissingOrNonObjectGuard(
    statement: ts.Statement,
    value: string,
): boolean {
    if (
        !ts.isIfStatement(statement) ||
        statement.elseStatement ||
        !isContinue(statement.thenStatement)
    ) {
        return false;
    }
    const condition = unwrap(statement.expression);
    return ts.isBinaryExpression(condition) &&
        condition.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        isNegated(condition.left, (operand) => identifierIs(operand, value)) &&
        isTypeOfComparison(
            condition.right,
            value,
            undefined,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            "object",
        );
}

function forOfBinding(
    statement: ts.Statement,
    collection: string,
): { name: string; statements: readonly ts.Statement[] } | undefined {
    if (
        !ts.isForOfStatement(statement) ||
        !ts.isVariableDeclarationList(statement.initializer) ||
        statement.awaitModifier ||
        (statement.initializer.flags & ts.NodeFlags.Const) === 0 ||
        statement.initializer.declarations.length !== 1 ||
        !identifierIs(statement.expression, collection) ||
        !ts.isBlock(statement.statement)
    ) {
        return undefined;
    }
    const declaration = statement.initializer.declarations[0]!;
    return ts.isIdentifier(declaration.name) && !declaration.initializer
        ? {
              name: declaration.name.text,
              statements: statement.statement.statements,
          }
        : undefined;
}

/** The browser decoder's exact observable operations, independent of names. */
function isGzipBase64JsonDecoder(
    checker: ts.TypeChecker,
    declaration: ts.FunctionDeclaration,
): boolean {
    if (
        !declaration.body ||
        !declaration.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        ) ||
        declaration.asteriskToken ||
        declaration.parameters.length !== 1 ||
        !plainIdentifierParameter(declaration.parameters[0]!) ||
        declaration.body.statements.length !== 3
    ) {
        return false;
    }
    const encoded = declaration.parameters[0]!.name.text;
    const bytes = constBinding(declaration.body.statements[0]!);
    const stream = constBinding(declaration.body.statements[1]!);
    const returned = declaration.body.statements[2]!;
    if (!bytes || !stream || !ts.isReturnStatement(returned) || !returned.expression) {
        return false;
    }

    const byteFactory = propertyCall(bytes.initializer, "from");
    if (
        !byteFactory ||
        byteFactory.arguments.length !== 2 ||
        !ts.isPropertyAccessExpression(byteFactory.expression) ||
        !globalIdentifierIs(
            checker,
            byteFactory.expression.expression,
            "Uint8Array",
        )
    ) {
        return false;
    }
    const decoded = unwrap(byteFactory.arguments[0]!);
    const mapper = unwrap(byteFactory.arguments[1]!);
    if (
        !ts.isCallExpression(decoded) ||
        decoded.questionDotToken ||
        (decoded.typeArguments?.length ?? 0) !== 0 ||
        !globalIdentifierIs(checker, decoded.expression, "atob") ||
        decoded.arguments.length !== 1 ||
        !identifierIs(decoded.arguments[0], encoded) ||
        !ts.isArrowFunction(mapper) ||
        mapper.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        ) ||
        mapper.parameters.length !== 1 ||
        !plainIdentifierParameter(mapper.parameters[0]!) ||
        ts.isBlock(mapper.body)
    ) {
        return false;
    }
    const char = mapper.parameters[0]!.name.text;
    const charCodeAt = propertyCall(mapper.body, "charCodeAt");
    if (
        !charCodeAt ||
        charCodeAt.arguments.length !== 1 ||
        !ts.isNumericLiteral(unwrap(charCodeAt.arguments[0]!)) ||
        Number((unwrap(charCodeAt.arguments[0]!) as ts.NumericLiteral).text) !== 0 ||
        !ts.isPropertyAccessExpression(charCodeAt.expression) ||
        !identifierIs(charCodeAt.expression.expression, char)
    ) {
        return false;
    }

    const pipeThrough = propertyCall(stream.initializer, "pipeThrough");
    if (!pipeThrough || pipeThrough.arguments.length !== 1) return false;
    const streamCall = ts.isPropertyAccessExpression(pipeThrough.expression)
        ? propertyCall(pipeThrough.expression.expression, "stream")
        : undefined;
    const decompressor = unwrap(pipeThrough.arguments[0]!);
    if (
        !streamCall ||
        streamCall.arguments.length !== 0 ||
        !ts.isPropertyAccessExpression(streamCall.expression) ||
        !ts.isNewExpression(unwrap(streamCall.expression.expression)) ||
        !ts.isNewExpression(decompressor)
    ) {
        return false;
    }
    const blob = unwrap(streamCall.expression.expression) as ts.NewExpression;
    if (
        !globalIdentifierIs(checker, blob.expression, "Blob") ||
        (blob.typeArguments?.length ?? 0) !== 0 ||
        blob.arguments?.length !== 1 ||
        !ts.isArrayLiteralExpression(unwrap(blob.arguments[0]!)) ||
        (unwrap(blob.arguments[0]!) as ts.ArrayLiteralExpression).elements.length !== 1 ||
        !identifierIs(
            (unwrap(blob.arguments[0]!) as ts.ArrayLiteralExpression)
                .elements[0] as ts.Expression,
            bytes.name,
        ) ||
        !globalIdentifierIs(
            checker,
            decompressor.expression,
            "DecompressionStream",
        ) ||
        (decompressor.typeArguments?.length ?? 0) !== 0 ||
        decompressor.arguments?.length !== 1 ||
        !isStringLiteral(decompressor.arguments[0]!, "gzip")
    ) {
        return false;
    }

    const awaited = unwrap(returned.expression);
    if (!ts.isAwaitExpression(awaited)) return false;
    const jsonCall = propertyCall(awaited.expression, "json");
    if (
        !jsonCall ||
        jsonCall.arguments.length !== 0 ||
        !ts.isPropertyAccessExpression(jsonCall.expression) ||
        !ts.isNewExpression(unwrap(jsonCall.expression.expression))
    ) {
        return false;
    }
    const response = unwrap(
        jsonCall.expression.expression,
    ) as ts.NewExpression;
    return globalIdentifierIs(checker, response.expression, "Response") &&
        (response.typeArguments?.length ?? 0) === 0 &&
        response.arguments?.length === 1 &&
        identifierIs(response.arguments[0], stream.name);
}

function isArrayGuard(
    checker: ts.TypeChecker,
    statement: ts.Statement,
    array: string,
    miss: (statement: ts.Statement) => boolean,
): boolean {
    return ts.isIfStatement(statement) &&
        !statement.elseStatement &&
        isNegated(statement.expression, (operand) =>
            isArrayCheck(checker, operand, array),
        ) &&
        miss(statement.thenStatement);
}

function isInputAliasLoop(
    statement: ts.Statement,
    inputs: string,
): boolean {
    const loop = forOfBinding(statement, inputs);
    if (!loop || loop.statements.length !== 3) return false;
    const [guard, entryStatement, assignmentGuard] = loop.statements;
    const entry = constBinding(entryStatement!);
    if (
        !isMissingOrNonObjectGuard(guard!, loop.name) ||
        !entry ||
        !identifierIs(entry.initializer, loop.name) ||
        !ts.isIfStatement(assignmentGuard!) ||
        assignmentGuard!.elseStatement
    ) {
        return false;
    }
    const condition = unwrap(assignmentGuard!.expression);
    if (
        !ts.isBinaryExpression(condition) ||
        condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
    ) {
        return false;
    }
    const missing = unwrap(condition.left);
    if (
        !ts.isBinaryExpression(missing) ||
        missing.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
        !isPropertyRead(missing.left, entry.name, "inputName") ||
        !identifierIs(missing.right, "undefined") ||
        !isTypeOfComparison(
            condition.right,
            entry.name,
            "name",
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            "string",
        )
    ) {
        return false;
    }
    const assignment = singleStatement(assignmentGuard!.thenStatement);
    if (!assignment || !ts.isExpressionStatement(assignment)) return false;
    const binary = unwrap(assignment.expression);
    return ts.isBinaryExpression(binary) &&
        binary.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isPropertyRead(binary.left, entry.name, "inputName") &&
        isPropertyRead(binary.right, entry.name, "name");
}

/** The compatibility pass the compressed NME modules apply after decoding. */
function isInputNameAliasRestorer(
    checker: ts.TypeChecker,
    declaration: ts.FunctionDeclaration,
): boolean {
    if (
        !declaration.body ||
        declaration.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        ) ||
        declaration.asteriskToken ||
        declaration.parameters.length !== 1 ||
        !plainIdentifierParameter(declaration.parameters[0]!) ||
        declaration.body.statements.length !== 4
    ) {
        return false;
    }
    const json = declaration.parameters[0]!.name.text;
    const [blocksStatement, blocksGuard, blockLoopStatement, returned] =
        declaration.body.statements;
    const blocks = constBinding(blocksStatement!);
    const blockLoop = blocks
        ? forOfBinding(blockLoopStatement!, blocks.name)
        : undefined;
    if (
        !blocks ||
        !isPropertyRead(blocks.initializer, json, "blocks") ||
        !isArrayGuard(
            checker,
            blocksGuard!,
            blocks.name,
            (statement) => isReturnOf(statement, json),
        ) ||
        !blockLoop ||
        blockLoop.statements.length !== 4 ||
        !isReturnOf(returned!, json)
    ) {
        return false;
    }
    const [blockGuard, inputsStatement, inputsGuard, inputLoop] =
        blockLoop.statements;
    const inputs = constBinding(inputsStatement!);
    return isMissingOrNonObjectGuard(blockGuard!, blockLoop.name) &&
        !!inputs &&
        isPropertyRead(inputs.initializer, blockLoop.name, "inputs") &&
        isArrayGuard(
            checker,
            inputsGuard!,
            inputs.name,
            isContinue,
        ) &&
        isInputAliasLoop(inputLoop!, inputs.name);
}

function jsonValue(
    context: CompressedJsonContext,
    json: unknown,
    node: ts.Node,
): Value {
    if (json === null) {
        return { kind: "json-null", cpp: "std::nullopt", staticJson: null };
    }
    if (typeof json === "string") {
        return {
            kind: "string",
            cpp: context.cppString(json),
            staticString: json,
            staticJson: json,
        };
    }
    if (typeof json === "number") {
        return {
            kind: "number",
            cpp: doubleLiteral(json),
            staticNumber: json,
            staticJson: json,
            dataType: { kind: "number" },
        };
    }
    if (typeof json === "boolean") {
        return {
            kind: "boolean",
            cpp: json ? "true" : "false",
            staticBoolean: json,
            staticJson: json,
            dataType: { kind: "boolean" },
        };
    }
    if (Array.isArray(json)) {
        return {
            kind: "tuple",
            cpp: "",
            tupleElements: json.map((element) =>
                jsonValue(context, element, node),
            ),
            staticJson: json,
        };
    }
    if (typeof json === "object") {
        return {
            kind: "record",
            cpp: "",
            recordProperties: Object.fromEntries(
                Object.entries(json).map(([name, value]) => [
                    name,
                    jsonValue(context, value, node),
                ]),
            ),
            staticJson: json,
        };
    }
    context.fail(
        node,
        "Compressed JSON contains a value JSON cannot represent.",
    );
}

function restoreInputNameAliases(json: unknown): unknown {
    const clone = structuredClone(json);
    if (!clone || typeof clone !== "object" || Array.isArray(clone)) {
        return clone;
    }
    const blocks = (clone as { blocks?: unknown }).blocks;
    if (!Array.isArray(blocks)) return clone;
    for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const inputs = (block as { inputs?: unknown }).inputs;
        if (!Array.isArray(inputs)) continue;
        for (const input of inputs) {
            if (!input || typeof input !== "object") continue;
            const entry = input as { name?: unknown; inputName?: unknown };
            if (entry.inputName === undefined && typeof entry.name === "string") {
                entry.inputName = entry.name;
            }
        }
    }
    return clone;
}

/** Decode one proven gzip/base64 JSON argument without building Value twice. */
function decodeCompressedJson(
    context: CompressedJsonContext,
    expression: ts.Expression,
): unknown {
    const encoded = context.compileStringLiteral(expression);
    try {
        return JSON.parse(
            gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"),
        );
    } catch (error) {
        context.fail(
            expression,
            `Unable to decode the static gzip/base64 JSON: ${String(error)}`,
        );
    }
}

/** Compile a reached compressed-JSON utility call, or decline another call. */
export function compileCompressedJsonCall(
    context: CompressedJsonContext,
    call: ts.CallExpression,
    callee: ts.Identifier,
): Value | undefined {
    const declaration = functionDeclaration(context.checker, callee);
    if (!declaration) return undefined;

    if (isGzipBase64JsonDecoder(context.checker, declaration)) {
        if (call.arguments.length !== 1) {
            context.fail(call, "A gzip/base64 JSON decoder takes one string.");
        }
        return jsonValue(
            context,
            decodeCompressedJson(context, call.arguments[0]!),
            call,
        );
    }

    if (isInputNameAliasRestorer(context.checker, declaration)) {
        if (call.arguments.length !== 1) {
            context.fail(call, "An input-name alias restorer takes one JSON value.");
        }
        const value = context.compileValue(call.arguments[0]!);
        if (value.staticJson === undefined) {
            context.fail(
                call.arguments[0]!,
                "Input-name aliases can be restored only on generation-known JSON.",
            );
        }
        return jsonValue(
            context,
            restoreInputNameAliases(value.staticJson),
            call,
        );
    }

    return undefined;
}

/**
 * Apply a named, structurally recognized JSON compatibility pass to the
 * immediate result of the static gzip decoder.
 *
 * The ordinary immediate-Promise lowerer deliberately accepts only inline
 * callbacks.  This narrower source-shape boundary proves both named
 * functions before evaluating either one, so arbitrary named callbacks keep
 * that refusal while compressed graph modules can share their pure restorer.
 */
export function compileCompressedJsonPromiseThen(
    context: CompressedJsonContext,
    call: ts.CallExpression,
): Value | undefined {
    const then = call.expression;
    const callback = call.arguments[0];
    if (
        !ts.isPropertyAccessExpression(then) ||
        then.name.text !== "then" ||
        call.arguments.length !== 1 ||
        !callback ||
        !ts.isIdentifier(callback) ||
        !ts.isCallExpression(then.expression) ||
        !ts.isIdentifier(then.expression.expression)
    ) {
        return undefined;
    }
    const decoder = functionDeclaration(
        context.checker,
        then.expression.expression,
    );
    const restorer = functionDeclaration(
        context.checker,
        callback,
    );
    if (
        !decoder ||
        !restorer ||
        !isGzipBase64JsonDecoder(context.checker, decoder) ||
        !isInputNameAliasRestorer(context.checker, restorer)
    ) {
        return undefined;
    }
    if (then.expression.arguments.length !== 1) {
        context.fail(
            then.expression,
            "A gzip/base64 JSON decoder takes one string.",
        );
    }
    return jsonValue(
        context,
        restoreInputNameAliases(
            decodeCompressedJson(
                context,
                then.expression.arguments[0]!,
            ),
        ),
        call,
    );
}
