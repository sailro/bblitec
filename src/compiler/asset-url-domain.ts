import { readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { resolveBundledAsset } from "./assets.js";
import { deploymentUrl } from "./deployment.js";
import { CompileError } from "./compile-error.js";
import type { LoweringServices } from "./lowering-services.js";
import { declaredInDefaultLibrary, resolvedSymbol } from "./symbols.js";
import { receiverWritingMethods } from "./receiver-methods.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    regularExpressionParts,
    rootIdentifier,
    unwrapExpression,
} from "./syntax.js";
import {
    functionOfDeclaration,
    type SupportedFunction,
} from "./user-functions.js";

type Context = Pick<
    LoweringServices,
    | "checker"
    | "options"
    | "sourceFiles"
    | "compileStringLiteral"
    | "probeEmission"
    | "libraryGlobal"
    | "propertyName"
    | "fail"
>;
const element = Symbol("array element");
type Projection = readonly (string | typeof element)[];
interface Origin {
    expression: ts.Expression;
    projection: Projection;
    environment: Environment;
}
type Environment = ReadonlyMap<ts.Symbol, Origin>;
type Domain = readonly string[] | undefined;
const candidateLimit = 256;

/**
 * Fetch-local discovery follows the selected value's declarations and calls.
 * Unknown filename fragments can select only existing files matching an
 * authored pattern in one fixed, non-root local directory. This is a package
 * inventory, not a constant value: the original expression still runs and the
 * response lookup rejects every key outside that inventory.
 */
export function assetUrlDomain(
    context: Context,
    expression: ts.Expression,
): Domain {
    const domain = new AssetUrlDomain(context, expression).read(
        expression,
        [],
        new Map(),
    );
    const base = deploymentUrl(context.options);
    const safe = domain?.every((source) => {
        if (/%2f|%5c|\\/i.test(source)) return false;
        const path = source.split(/[?#]/, 1)[0]!;
        let decoded: string;
        try {
            decoded = decodeURIComponent(path);
        } catch {
            return false;
        }
        if (decoded.split("/").some((part) => part === "." || part === ".."))
            return false;
        let url: URL;
        try {
            url = new URL(source, base);
        } catch {
            return false;
        }
        return (
            url.origin === base.origin &&
            !url.username &&
            !url.password &&
            !url.pathname.endsWith("/")
        );
    });
    if (domain && !safe)
        context.fail(
            expression,
            "Packaged URL provenance requires local URLs without traversal or encoded separators.",
        );
    return domain;
}

class AssetUrlDomain {
    private readonly active = new Set<ts.Node>();
    private readonly calls = new Map<SupportedFunction, ts.CallExpression[]>();
    private readonly writes = new Map<ts.Symbol, ts.Expression[]>();
    private readonly mutated = new Set<ts.Symbol>();
    private remaining = 4096;

    constructor(
        private readonly context: Context,
        private readonly site: ts.Node,
    ) {
        const aliases: [ts.Symbol, ts.Symbol][] = [];
        const alias = (target: ts.Node, source: ts.Expression): void => {
            const type = context.checker.getNonNullableType(
                context.checker.getTypeAtLocation(target),
            );
            if (
                !(
                    type.flags &
                    (ts.TypeFlags.Object | ts.TypeFlags.TypeParameter)
                )
            )
                return;
            const from = resolvedSymbol(context.checker, target);
            const root = rootIdentifier(source);
            const to = root && resolvedSymbol(context.checker, root);
            if (from && to) aliases.push([from, to]);
        };
        const mutate = (expression: ts.Expression): void => {
            const root = rootIdentifier(expression);
            const symbol = root && resolvedSymbol(context.checker, root);
            if (symbol) this.mutated.add(symbol);
        };
        for (const source of context.sourceFiles()) {
            forEachAnalysisNode(
                source,
                (node) => {
                    if (
                        ts.isVariableDeclaration(node) &&
                        ts.isIdentifier(node.name) &&
                        node.initializer
                    )
                        alias(node.name, node.initializer);
                    if (ts.isCallExpression(node)) {
                        const declaration = this.function(node);
                        if (declaration) {
                            const calls = this.calls.get(declaration) ?? [];
                            calls.push(node);
                            this.calls.set(declaration, calls);
                            declaration.parameters.forEach(
                                (parameter, index) => {
                                    if (
                                        ts.isIdentifier(parameter.name) &&
                                        node.arguments[index]
                                    )
                                        alias(
                                            parameter.name,
                                            node.arguments[index],
                                        );
                                },
                            );
                        }
                        const callee = unwrapExpression(node.expression);
                        if (
                            ts.isPropertyAccessExpression(callee) &&
                            receiverWritingMethods.has(callee.name.text)
                        )
                            mutate(callee.expression);
                    }
                    if (isUpdateExpression(node)) mutate(node.operand);
                    if (!isAssignmentExpression(node)) return;
                    const target = unwrapExpression(node.left);
                    if (ts.isIdentifier(target)) {
                        const symbol = resolvedSymbol(context.checker, target);
                        if (!symbol) return;
                        if (
                            node.operatorToken.kind !==
                            ts.SyntaxKind.EqualsToken
                        ) {
                            this.mutated.add(symbol);
                        } else {
                            const writes = this.writes.get(symbol) ?? [];
                            writes.push(node.right);
                            this.writes.set(symbol, writes);
                        }
                    } else {
                        mutate(target);
                    }
                },
                { types: "skip" },
            );
        }
        let changed: boolean;
        do {
            changed = false;
            for (const [from, to] of aliases) {
                if (this.mutated.has(from) && !this.mutated.has(to)) {
                    this.mutated.add(to);
                    changed = true;
                }
            }
        } while (changed);
    }

    private bounded(values: readonly string[]): readonly string[] {
        const result = [...new Set(values)];
        if (result.length > candidateLimit)
            this.context.fail(
                this.site,
                `Packaged URL domain exceeds ${candidateLimit} candidates.`,
            );
        return result;
    }

    private union(values: readonly Domain[]): Domain {
        if (values.some((value) => value?.length === 0)) return [];
        return values.length &&
            values.every(
                (value): value is readonly string[] =>
                    value !== undefined && value.length > 0,
            )
            ? this.bounded(values.flat())
            : undefined;
    }

    public read(
        expression: ts.Expression,
        projection: Projection,
        environment: Environment,
    ): Domain {
        if (--this.remaining < 0)
            this.context.fail(
                this.site,
                "Packaged URL provenance exceeds the analysis budget.",
            );
        const node = unwrapExpression(expression);
        if (this.active.has(node)) return undefined;
        this.active.add(node);
        try {
            return this.value(node, projection, environment);
        } finally {
            this.active.delete(node);
        }
    }

    private value(
        node: ts.Expression,
        projection: Projection,
        environment: Environment,
    ): Domain {
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(this.context.checker, node);
            if (!symbol) return undefined;
            if (this.mutated.has(symbol)) {
                const type = this.context.checker.getTypeAtLocation(node);
                // Native browser objects (including the existing module URL
                // helper's URL) retain their separate admission mechanism.
                return declaredInDefaultLibrary(type.symbol) &&
                    !this.context.checker.isArrayType(type) &&
                    !this.context.checker.isTupleType(type)
                    ? undefined
                    : [];
            }
            const origin = environment.get(symbol);
            if (origin)
                return this.read(
                    origin.expression,
                    [...origin.projection, ...projection],
                    origin.environment,
                );
            const declaration =
                symbol.valueDeclaration ?? symbol.declarations?.[0];
            if (declaration && ts.isVariableDeclaration(declaration)) {
                if (
                    declaration.getSourceFile() !== node.getSourceFile() &&
                    !(declaration.parent.flags & ts.NodeFlags.Const)
                )
                    return [];
                if (declaration.initializer) {
                    const writes = this.writes.get(symbol) ?? [];
                    return this.union(
                        [declaration.initializer, ...writes].map((value) =>
                            this.read(value, projection, environment),
                        ),
                    );
                }
                const loop = declaration.parent.parent;
                if (ts.isForOfStatement(loop))
                    return this.read(
                        loop.expression,
                        [element, ...projection],
                        environment,
                    );
            }
            if (declaration && ts.isParameter(declaration)) {
                const owner =
                    ts.isArrowFunction(declaration.parent) ||
                    ts.isFunctionExpression(declaration.parent)
                        ? declaration.parent
                        : functionOfDeclaration(declaration.parent);
                if (!owner) return undefined;
                const index = owner.parameters.indexOf(declaration);
                return this.union(
                    (this.calls.get(owner) ?? []).map((call) => {
                        const argument =
                            call.arguments[index] ?? declaration.initializer;
                        return argument
                            ? this.read(argument, projection, environment)
                            : undefined;
                    }),
                );
            }
        }
        if (ts.isConditionalExpression(node))
            return this.union(
                [node.whenTrue, node.whenFalse].map((value) =>
                    this.read(value, projection, environment),
                ),
            );
        if (ts.isPropertyAccessExpression(node)) {
            const domain = this.read(
                node.expression,
                [node.name.text, ...projection],
                environment,
            );
            if (domain) return domain;
        }
        if (ts.isElementAccessExpression(node)) {
            const key = unwrapExpression(node.argumentExpression);
            return this.read(
                node.expression,
                [
                    ts.isStringLiteralLike(key) ? key.text : element,
                    ...projection,
                ],
                environment,
            );
        }
        if (
            ts.isObjectLiteralExpression(node) &&
            typeof projection[0] === "string"
        ) {
            const key = projection[0];
            for (const property of [...node.properties].reverse()) {
                if (ts.isSpreadAssignment(property)) return undefined;
                if (this.context.propertyName(property.name) !== key) continue;
                if (ts.isPropertyAssignment(property))
                    return this.read(
                        property.initializer,
                        projection.slice(1),
                        environment,
                    );
                if (ts.isShorthandPropertyAssignment(property))
                    return this.read(
                        property.name,
                        projection.slice(1),
                        environment,
                    );
                return undefined;
            }
            return undefined;
        }
        if (ts.isArrayLiteralExpression(node) && projection[0] === element)
            return this.union(
                node.elements.map((value) =>
                    ts.isSpreadElement(value)
                        ? this.read(value.expression, projection, environment)
                        : this.read(value, projection.slice(1), environment),
                ),
            );
        if (ts.isCallExpression(node))
            return this.call(node, projection, environment);
        if (projection.length) return undefined;
        if (ts.isStringLiteralLike(node)) return [node.text];
        if (ts.isTemplateExpression(node)) {
            const parts: Domain[] = [[node.head.text]];
            for (const span of node.templateSpans)
                parts.push(this.read(span.expression, [], environment), [
                    span.literal.text,
                ]);
            return this.concatenate(parts);
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            this.context.checker.getTypeAtLocation(node).flags &
                ts.TypeFlags.StringLike
        ) {
            const parts: Domain[] = [];
            const collect = (value: ts.Expression): void => {
                const operand = unwrapExpression(value);
                if (
                    ts.isBinaryExpression(operand) &&
                    operand.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                    this.context.checker.getTypeAtLocation(operand).flags &
                        ts.TypeFlags.StringLike
                ) {
                    collect(operand.left);
                    collect(operand.right);
                } else parts.push(this.read(operand, [], environment));
            };
            collect(node);
            return this.concatenate(parts);
        }
        try {
            return this.context.probeEmission(
                () => [this.context.compileStringLiteral(node)],
                () => false,
            );
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            return undefined;
        }
    }

    private function(call: ts.CallExpression): SupportedFunction | undefined {
        const declaration =
            this.context.checker.getResolvedSignature(call)?.declaration;
        return (
            declaration &&
            (ts.isArrowFunction(declaration) ||
            ts.isFunctionExpression(declaration)
                ? declaration
                : functionOfDeclaration(declaration))
        );
    }

    private returned(
        declaration: SupportedFunction,
        projection: Projection,
        environment: Environment,
    ): Domain {
        if (!declaration.body) return undefined;
        if (!ts.isBlock(declaration.body))
            return this.read(declaration.body, projection, environment);
        const values: Domain[] = [];
        forEachAnalysisNode(
            declaration.body,
            (node) => {
                if (ts.isReturnStatement(node))
                    values.push(
                        node.expression
                            ? this.read(
                                  node.expression,
                                  projection,
                                  environment,
                              )
                            : undefined,
                    );
            },
            { functions: "skip", types: "skip" },
        );
        return this.union(values);
    }

    private call(
        call: ts.CallExpression,
        projection: Projection,
        environment: Environment,
    ): Domain {
        const declaration = this.function(call);
        if (declaration?.body) {
            const nested = new Map(environment);
            for (const [index, parameter] of declaration.parameters.entries()) {
                if (!ts.isIdentifier(parameter.name)) return undefined;
                const symbol = resolvedSymbol(
                    this.context.checker,
                    parameter.name,
                );
                const argument = call.arguments[index] ?? parameter.initializer;
                if (symbol && argument)
                    nested.set(symbol, {
                        expression: argument,
                        projection: [],
                        environment,
                    });
            }
            return this.returned(declaration, projection, nested);
        }
        const callee = unwrapExpression(call.expression);
        if (!ts.isPropertyAccessExpression(callee)) return undefined;
        const method = callee.name.text;
        const receiverType = this.context.checker.getTypeAtLocation(
            callee.expression,
        );
        const array =
            this.context.checker.isArrayType(receiverType) ||
            this.context.checker.isTupleType(receiverType);
        if (array && ["find", "at"].includes(method))
            return this.read(
                callee.expression,
                [element, ...projection],
                environment,
            );
        if (array && ["slice", "filter"].includes(method))
            return this.read(callee.expression, projection, environment);
        const from =
            method === "from" &&
            this.context.libraryGlobal(callee.expression) === "Array";
        if (
            (from || (array && method === "map")) &&
            projection[0] === element
        ) {
            const callback = call.arguments[from ? 1 : 0];
            if (
                !callback ||
                !(
                    ts.isArrowFunction(callback) ||
                    ts.isFunctionExpression(callback)
                )
            )
                return undefined;
            const nested = new Map(environment);
            const parameter = callback.parameters[0];
            const iterable = from ? call.arguments[0] : callee.expression;
            if (parameter && ts.isIdentifier(parameter.name) && iterable) {
                const symbol = resolvedSymbol(
                    this.context.checker,
                    parameter.name,
                );
                if (symbol)
                    nested.set(symbol, {
                        expression: iterable,
                        projection: [element],
                        environment,
                    });
            }
            return this.returned(callback, projection.slice(1), nested);
        }
        if (
            projection.length ||
            !(receiverType.flags & ts.TypeFlags.StringLike)
        )
            return undefined;
        const source = this.read(callee.expression, [], environment);
        if (!source) return undefined;
        if (
            (method === "replace" || method === "replaceAll") &&
            call.arguments.length === 2
        ) {
            const replacement = this.read(call.arguments[1]!, [], environment);
            const patternNode = unwrapExpression(call.arguments[0]!);
            const regex = ts.isRegularExpressionLiteral(patternNode)
                ? regularExpressionParts(patternNode)
                : undefined;
            const patterns = regex
                ? [new RegExp(regex.pattern, regex.flags)]
                : this.read(patternNode, [], environment);
            if (!replacement || !patterns) return [];
            return this.bounded(
                source.flatMap((value) =>
                    patterns.flatMap((pattern) =>
                        replacement.map((text) =>
                            method === "replace"
                                ? value.replace(pattern, text)
                                : value.replaceAll(pattern, text),
                        ),
                    ),
                ),
            );
        }
        return [];
    }

    private concatenate(parts: readonly Domain[]): Domain {
        if (parts.some((part) => part?.length === 0)) return [];
        let patterns: (string | undefined)[][] = [[]];
        for (const part of parts) {
            if (patterns.length * (part?.length ?? 1) > candidateLimit)
                this.context.fail(
                    this.site,
                    `Packaged URL domain exceeds ${candidateLimit} candidates.`,
                );
            patterns = patterns.flatMap((prefix) =>
                (part ?? [undefined]).map((value) => [...prefix, value]),
            );
        }
        return this.union(
            patterns.map((pattern) =>
                pattern.every((part) => part !== undefined)
                    ? [pattern.join("")]
                    : this.files(pattern),
            ),
        );
    }

    private files(parts: readonly (string | undefined)[]): Domain {
        const first = parts.indexOf(undefined);
        const prefix = parts.slice(0, first).join("");
        const slash = prefix.lastIndexOf("/");
        if (slash < 1 || prefix.includes("?") || prefix.includes("#"))
            return undefined;
        const logicalDirectory = prefix.slice(0, slash + 1);
        const base = deploymentUrl(this.context.options);
        const logicalUrl = new URL(logicalDirectory, base);
        if (
            logicalUrl.origin !== base.origin ||
            logicalUrl.pathname === base.pathname ||
            /%2f|%5c|\\/i.test(
                parts.filter((part) => part !== undefined).join(""),
            )
        )
            return undefined;
        let decoded: string;
        try {
            decoded = decodeURIComponent(logicalDirectory);
        } catch {
            return undefined;
        }
        if (decoded.split("/").some((part) => part === "." || part === ".."))
            return undefined;
        let source: string;
        // Root-path arguments may be prefixed by the deployment base in a
        // helper. Discovery is provisional; final keys resolve through the
        // normal deployment resolver after the helper's transformations.
        const discovery =
            logicalDirectory.startsWith("/") && this.context.options.publicDir
                ? { ...this.context.options, siteUrl: base.origin + "/" }
                : this.context.options;
        try {
            source = resolveBundledAsset(
                logicalDirectory,
                this.context.options.fileName,
                discovery,
            );
        } catch {
            return undefined;
        }
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) return undefined;
        const directory = resolve(
            dirname(resolve(this.context.options.fileName)),
            source,
        );
        // The authored directory must stay below its deployment or entry root.
        const root = resolve(
            this.context.options.publicDir ??
                dirname(resolve(this.context.options.fileName)),
        );
        const path = relative(root, directory);
        if (
            !path ||
            isAbsolute(path) ||
            path === ".." ||
            path.startsWith("..\\") ||
            path.startsWith("../")
        )
            return undefined;
        const pattern = parts
            .map((part) =>
                part === undefined
                    ? "[^/?#\\\\]*"
                    : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("");
        const query =
            parts
                .slice(first + 1)
                .join("")
                .match(/[?#].*$/)?.[0] ?? "";
        // A dynamic query is not a finite packaged URL domain.
        let inQuery = false;
        for (const part of parts) {
            if (part === undefined && inQuery) return [];
            if (part !== undefined && /[?#]/.test(part)) inQuery = true;
        }
        const match = new RegExp(`^${pattern}$`);
        let files;
        try {
            files = readdirSync(directory, { withFileTypes: true });
        } catch {
            return undefined;
        }
        if (files.length > 4096)
            this.context.fail(
                this.site,
                "Packaged URL directory exceeds the discovery budget.",
            );
        return this.bounded(
            files
                .filter((file) => file.isFile())
                .flatMap((file) =>
                    [
                        logicalDirectory + file.name + query,
                        logicalDirectory +
                            encodeURIComponent(file.name) +
                            query,
                    ].filter((value) => match.test(value)),
                ),
        );
    }
}
