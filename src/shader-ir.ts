import type { ShaderMaterialProgramSource } from "./shader-material-programs.js";

export type ShaderStage = "vertex" | "fragment";
export type ShaderType =
    | "f32"
    | "mat4x4<f32>"
    | "vec2<f32>"
    | "vec3<f32>"
    | "vec4<f32>";

export interface ShaderAttribute {
    kind: "builtin" | "location";
    value: string | number;
}

export interface ShaderStructMember {
    name: string;
    type: ShaderType;
    attribute?: ShaderAttribute | undefined;
}

export interface ShaderStruct {
    name: string;
    members: ShaderStructMember[];
}

export type ShaderExpression =
    | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "<"; left: ShaderExpression; right: ShaderExpression }
    | { kind: "call"; name: string; arguments: ShaderExpression[] }
    | { kind: "construct"; type: ShaderType; arguments: ShaderExpression[] }
    | { kind: "member"; expression: ShaderExpression; member: string }
    | { kind: "number"; value: string }
    | { kind: "path"; parts: string[] };

export type ShaderStatement =
    | { kind: "assign"; target: ShaderExpression; value: ShaderExpression }
    | { kind: "discard" }
    | { kind: "if"; condition: ShaderExpression; statements: ShaderStatement[] }
    | { kind: "let"; name: string; value: ShaderExpression }
    | { kind: "return"; value: ShaderExpression }
    | { kind: "var"; name: string; type: string };

export interface ShaderParameter {
    name: string;
    type: string;
}

export interface ShaderEntryPoint {
    stage: ShaderStage;
    name: string;
    parameters: ShaderParameter[];
    returnType: string;
    returnAttribute?: ShaderAttribute | undefined;
    statements: ShaderStatement[];
}

export interface ShaderModule {
    structs: ShaderStruct[];
    entryPoint: ShaderEntryPoint;
    /** Source retained verbatim when it uses WGSL beyond the typed subset. */
    rawSource?: string;
}

export interface ShaderUniformMemberReflection {
    name: string;
    type: ShaderType;
    offset: number;
    size: number;
    slot: number;
    components: string;
}

export interface ShaderUniformBlockReflection {
    stage: ShaderStage;
    binding: 0;
    space: 1 | 3;
    size: number;
    /** The system matrices this stage reads, in declaration order. */
    systemMatrices: ShaderSystemMatrix[];
    members: ShaderUniformMemberReflection[];
}

export interface ShaderProgramReflection {
    name: string;
    entryPoints: Array<{ stage: ShaderStage; name: string }>;
    attributes: Array<{ name: string; location: number; type: ShaderType }>;
    varyings: ShaderStructMember[];
    uniformBlocks: ShaderUniformBlockReflection[];
    /**
     * The declared samplers, in declaration order — which is the order
     * `setShaderTexture` indexes and the order the emitted pairs take
     * (`@binding(2n)` / `@binding(2n + 1)`).
     *
     * Every declared pair is emitted, as the pin's own prelude emits it. A
     * pair the compiled stage drops is the shader compiler's decision, and
     * the `.slots` sidecar it publishes is what the PAL binds by.
     */
    samplers: string[];
}

export interface ShaderIrProgram {
    name: string;
    vertex: ShaderModule;
    fragment: ShaderModule;
    reflection: ShaderProgramReflection;
}

interface Token {
    kind: "identifier" | "number" | "symbol" | "eof";
    text: string;
}

const shaderTypes = new Set<ShaderType>([
    "f32",
    "mat4x4<f32>",
    "vec2<f32>",
    "vec3<f32>",
    "vec4<f32>",
]);

// Native attribute locations follow the GpuVertex layout shared by both
// render backends (position, normal, tangent, uv, local_position, uv2,
// color, local_normal); the browser-composed twin assigns locations by
// declaration order against its own buffers, so only the native map has
// to match the native vertex table.
const attributeTypes: Record<string, { location: number; type: ShaderType }> = {
    position: { location: 0, type: "vec3<f32>" },
    normal: { location: 1, type: "vec3<f32>" },
    tangent: { location: 2, type: "vec4<f32>" },
    uv: { location: 3, type: "vec2<f32>" },
    uv2: { location: 5, type: "vec2<f32>" },
    color: { location: 6, type: "vec4<f32>" },
};

/**
 * The instance lanes the pin's own thin-instance module appends to a
 * material's `VertexInput`, at this port's locations rather than at the
 * declaration-order ones the pin uses: the matrix columns ride the shared
 * instance vertex buffer both backends already bind at 16-19, and the
 * per-instance colour a material that declares it takes the lane after.
 * The same numbers are stated once natively as
 * `instance_matrix_first_location` / `instance_color_location`
 * (`native/src/pal_gpu_shared.hpp`), which is what the specialized WGSL
 * these produce is bound against.
 */
const instanceAttributes: ReadonlyArray<{
    name: string;
    location: number;
    type: ShaderType;
}> = [
    { name: "world0", location: 16, type: "vec4<f32>" },
    { name: "world1", location: 17, type: "vec4<f32>" },
    { name: "world2", location: 18, type: "vec4<f32>" },
    { name: "world3", location: 19, type: "vec4<f32>" },
];

const instanceColorAttribute: {
    name: string;
    location: number;
    type: ShaderType;
} = { name: "instanceColor", location: 20, type: "vec4<f32>" };

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < source.length) {
        const character = source[index]!;
        if (/\s/.test(character)) {
            index += 1;
            continue;
        }
        if (source.startsWith("//", index)) {
            const end = source.indexOf("\n", index + 2);
            index = end < 0 ? source.length : end + 1;
            continue;
        }
        const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (identifier) {
            tokens.push({ kind: "identifier", text: identifier[0] });
            index += identifier[0].length;
            continue;
        }
        const number = source.slice(index).match(/^(?:\d+\.\d+|\d+|\.\d+)/);
        if (number) {
            tokens.push({ kind: "number", text: number[0] });
            index += number[0].length;
            continue;
        }
        if (source.startsWith("->", index)) {
            tokens.push({ kind: "symbol", text: "->" });
            index += 2;
            continue;
        }
        if ("@{}():;,<>.+-*/=".includes(character)) {
            tokens.push({ kind: "symbol", text: character });
            index += 1;
            continue;
        }
        throw new Error(`Unsupported WGSL token '${character}' at offset ${index}.`);
    }
    tokens.push({ kind: "eof", text: "" });
    return tokens;
}

class WgslSubsetParser {
    private index = 0;

    public constructor(
        private readonly tokens: Token[],
        private readonly expectedStage: ShaderStage,
    ) {}

    public parse(): ShaderModule {
        const structs: ShaderStruct[] = [];
        while (this.peek().text === "struct") {
            structs.push(this.parseStruct());
        }
        const stageAttribute = this.parseAttribute();
        if (
            stageAttribute.kind !== "builtin" ||
            stageAttribute.value !== this.expectedStage
        ) {
            throw new Error(`Expected @${this.expectedStage} WGSL entry point.`);
        }
        this.expect("fn");
        const name = this.expectIdentifier();
        this.expect("(");
        const parameters: ShaderParameter[] = [];
        while (this.peek().text !== ")") {
            const parameterName = this.expectIdentifier();
            this.expect(":");
            parameters.push({
                name: parameterName,
                type: this.parseNamedType(),
            });
            if (!this.accept(",")) break;
        }
        this.expect(")");
        this.expect("->");
        const returnAttribute = this.peek().text === "@"
            ? this.parseAttribute()
            : undefined;
        const returnType = this.parseNamedType();
        const statements = this.parseBlock();
        this.expectEof();
        return {
            structs,
            entryPoint: {
                stage: this.expectedStage,
                name,
                parameters,
                returnType,
                returnAttribute,
                statements,
            },
        };
    }

    private parseStruct(): ShaderStruct {
        this.expect("struct");
        const name = this.expectIdentifier();
        this.expect("{");
        const members: ShaderStructMember[] = [];
        while (!this.accept("}")) {
            const attribute = this.peek().text === "@"
                ? this.parseAttribute()
                : undefined;
            const memberName = this.expectIdentifier();
            this.expect(":");
            members.push({
                name: memberName,
                type: this.parseShaderType(),
                attribute,
            });
            this.accept(",");
        }
        this.accept(";");
        return { name, members };
    }

    private parseAttribute(): ShaderAttribute {
        this.expect("@");
        const name = this.expectIdentifier();
        if (name === "vertex" || name === "fragment") {
            return { kind: "builtin", value: name };
        }
        this.expect("(");
        if (name === "builtin") {
            const value = this.expectIdentifier();
            this.expect(")");
            return { kind: "builtin", value };
        }
        if (name === "location") {
            const value = Number.parseInt(this.expectNumber(), 10);
            this.expect(")");
            return { kind: "location", value };
        }
        throw new Error(`Unsupported WGSL attribute '@${name}'.`);
    }

    private parseBlock(): ShaderStatement[] {
        this.expect("{");
        const statements: ShaderStatement[] = [];
        while (!this.accept("}")) {
            statements.push(this.parseStatement());
        }
        return statements;
    }

    private parseStatement(): ShaderStatement {
        if (this.accept("let")) {
            const name = this.expectIdentifier();
            this.expect("=");
            const value = this.parseExpression();
            this.expect(";");
            return { kind: "let", name, value };
        }
        if (this.accept("var")) {
            const name = this.expectIdentifier();
            this.expect(":");
            const type = this.parseNamedType();
            this.expect(";");
            return { kind: "var", name, type };
        }
        if (this.accept("if")) {
            this.expect("(");
            const condition = this.parseExpression();
            this.expect(")");
            return {
                kind: "if",
                condition,
                statements: this.parseBlock(),
            };
        }
        if (this.accept("discard")) {
            this.expect(";");
            return { kind: "discard" };
        }
        if (this.accept("return")) {
            const value = this.parseExpression();
            this.expect(";");
            return { kind: "return", value };
        }
        const target = this.parseExpression();
        this.expect("=");
        const value = this.parseExpression();
        this.expect(";");
        return { kind: "assign", target, value };
    }

    private parseExpression(minimumPrecedence = 0): ShaderExpression {
        let expression = this.parsePrimaryExpression();
        while (this.accept(".")) {
            expression = {
                kind: "member",
                expression,
                member: this.expectIdentifier(),
            };
        }
        const precedences: Record<string, number | undefined> = {
            "<": 1,
            "+": 2,
            "-": 2,
            "*": 3,
            "/": 3,
        };
        while (true) {
            const operator = this.peek().text;
            const precedence = precedences[operator];
            if (precedence === undefined || precedence < minimumPrecedence) break;
            this.index += 1;
            const right = this.parseExpression(precedence + 1);
            expression = {
                kind: "binary",
                operator: operator as "+" | "-" | "*" | "/" | "<",
                left: expression,
                right,
            };
        }
        return expression;
    }

    private parsePrimaryExpression(): ShaderExpression {
        if (this.peek().kind === "number") {
            return { kind: "number", value: this.expectNumber() };
        }
        if (this.accept("(")) {
            const expression = this.parseExpression();
            this.expect(")");
            return expression;
        }
        const name = this.expectIdentifier();
        if (this.accept("<")) {
            const component = this.expectIdentifier();
            this.expect(">");
            const type = `${name}<${component}>`;
            if (!shaderTypes.has(type as ShaderType)) {
                throw new Error(`Unsupported WGSL constructor '${type}'.`);
            }
            return {
                kind: "construct",
                type: type as ShaderType,
                arguments: this.parseArguments(),
            };
        }
        if (this.peek().text === "(") {
            return {
                kind: "call",
                name,
                arguments: this.parseArguments(),
            };
        }
        const parts = [name];
        while (this.accept(".")) parts.push(this.expectIdentifier());
        return { kind: "path", parts };
    }

    private parseArguments(): ShaderExpression[] {
        this.expect("(");
        const arguments_: ShaderExpression[] = [];
        while (this.peek().text !== ")") {
            arguments_.push(this.parseExpression());
            if (!this.accept(",")) break;
        }
        this.expect(")");
        return arguments_;
    }

    private parseShaderType(): ShaderType {
        const type = this.parseNamedType();
        if (!shaderTypes.has(type as ShaderType)) {
            throw new Error(`Unsupported WGSL shader type '${type}'.`);
        }
        return type as ShaderType;
    }

    private parseNamedType(): string {
        const name = this.expectIdentifier();
        if (!this.accept("<")) return name;
        const component = this.expectIdentifier();
        this.expect(">");
        return `${name}<${component}>`;
    }

    private accept(text: string): boolean {
        if (this.peek().text !== text) return false;
        this.index += 1;
        return true;
    }

    private expect(text: string): void {
        const token = this.peek();
        if (token.text !== text) {
            throw new Error(`Expected WGSL token '${text}', received '${token.text}'.`);
        }
        this.index += 1;
    }

    private expectIdentifier(): string {
        const token = this.peek();
        if (token.kind !== "identifier") {
            throw new Error(`Expected WGSL identifier, received '${token.text}'.`);
        }
        this.index += 1;
        return token.text;
    }

    private expectNumber(): string {
        const token = this.peek();
        if (token.kind !== "number") {
            throw new Error(`Expected WGSL number, received '${token.text}'.`);
        }
        this.index += 1;
        return token.text;
    }

    private expectEof(): void {
        if (this.peek().kind !== "eof") {
            throw new Error(`Unexpected WGSL token '${this.peek().text}'.`);
        }
    }

    private peek(): Token {
        return this.tokens[this.index]!;
    }
}

function validateBalancedWgsl(source: string): void {
    const stack: string[] = [];
    const pairs: Record<string, string> = {
        "(": ")",
        "{": "}",
        "[": "]",
    };
    let index = 0;
    while (index < source.length) {
        if (source.startsWith("//", index)) {
            const end = source.indexOf("\n", index + 2);
            index = end < 0 ? source.length : end + 1;
            continue;
        }
        const character = source[index]!;
        if (pairs[character]) {
            stack.push(pairs[character]!);
        } else if ([")", "}", "]"].includes(character)) {
            const expected = stack.pop();
            if (expected !== character) {
                throw new Error(
                    `Unbalanced WGSL delimiter '${character}' at offset ${index}.`,
                );
            }
        }
        index += 1;
    }
    if (stack.length > 0) {
        throw new Error(
            `Unclosed WGSL delimiter; expected '${stack.at(-1)}'.`,
        );
    }
}

/** Removes comments and normalizes token spacing for raw-module identity. */
function canonicalRawWgsl(source: string): string {
    const tokens: string[] = [];
    let index = 0;
    while (index < source.length) {
        if (/\s/.test(source[index]!)) {
            index += 1;
            continue;
        }
        if (source.startsWith("//", index)) {
            const end = source.indexOf("\n", index + 2);
            index = end < 0 ? source.length : end + 1;
            continue;
        }
        if (source.startsWith("/*", index)) {
            let depth = 1;
            index += 2;
            while (index < source.length && depth > 0) {
                if (source.startsWith("/*", index)) {
                    depth += 1;
                    index += 2;
                } else if (source.startsWith("*/", index)) {
                    depth -= 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            if (depth > 0) {
                throw new Error("Unclosed WGSL block comment.");
            }
            continue;
        }
        const identifier = source
            .slice(index)
            .match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
        if (identifier) {
            tokens.push(identifier);
            index += identifier.length;
            continue;
        }
        const number = source
            .slice(index)
            .match(
                /^(?:0[xX][0-9A-Fa-f]+[iu]?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fhiu]?)/,
            )?.[0];
        if (number) {
            tokens.push(number);
            index += number.length;
            continue;
        }
        const operator = [
            ">>=",
            "<<=",
            "->",
            "==",
            "!=",
            "<=",
            ">=",
            "&&",
            "||",
            "+=",
            "-=",
            "*=",
            "/=",
            "%=",
            "&=",
            "|=",
            "^=",
            ">>",
            "<<",
        ].find((candidate) =>
            source.startsWith(candidate, index),
        );
        if (operator) {
            tokens.push(operator);
            index += operator.length;
            continue;
        }
        tokens.push(source[index]!);
        index += 1;
    }
    return tokens
        .join(" ")
        .replace(/\s+([,;:()\[\]{}<>.])/g, "$1")
        .replace(/([@({\[<.])\s+/g, "$1")
        .trim();
}

function parseRawModule(
    source: string,
    stage: ShaderStage,
): ShaderModule {
    const canonicalSource = canonicalRawWgsl(source);
    validateBalancedWgsl(canonicalSource);
    const entry = new RegExp(
        `@${stage}\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*` +
            `\\(([^)]*)\\)\\s*->\\s*` +
            `(?:@location\\((\\d+)\\)\\s*)?` +
            `([A-Za-z_][A-Za-z0-9_]*(?:<[^>]+>)?)\\s*\\{`,
    ).exec(canonicalSource);
    if (!entry) {
        throw new Error(
            `Expected one @${stage} WGSL entry point with an explicit return type.`,
        );
    }
    const parameters: ShaderParameter[] = [];
    const parameterText = entry[2]!.trim();
    if (parameterText.length > 0) {
        for (const part of parameterText.split(",")) {
            const match =
                /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*(?:<[^>]+>)?)\s*$/.exec(
                    part,
                );
            if (!match) {
                throw new Error(
                    `Unsupported @${stage} entry parameter '${part.trim()}'.`,
                );
            }
            parameters.push({ name: match[1]!, type: match[2]! });
        }
    }
    const structs: ShaderStruct[] = [];
    const structPattern =
        /struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}\s*;?/g;
    for (const match of canonicalSource.matchAll(structPattern)) {
        const members: ShaderStructMember[] = [];
        const memberPattern =
            /\s*(?:@(builtin|location)\(([^)]+)\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*(?:<[^>]+>)?)\s*,?/gy;
        const body = match[2]!;
        let offset = 0;
        while (offset < body.length) {
            memberPattern.lastIndex = offset;
            const member = memberPattern.exec(body);
            if (!member || member.index !== offset) {
                if (/^\s*$/.test(body.slice(offset))) break;
                throw new Error(
                    `Unsupported shader struct member near '${body.slice(offset).trim().slice(0, 40)}'.`,
                );
            }
            const type = member[4]!.replace(/\s+/g, "");
            if (!shaderTypes.has(type as ShaderType)) {
                throw new Error(
                    `Unsupported WGSL shader type '${type}' in struct '${match[1]}'.`,
                );
            }
            const attribute = member[1]
                ? {
                      kind: member[1] as "builtin" | "location",
                      value:
                          member[1] === "location"
                              ? Number.parseInt(member[2]!, 10)
                              : member[2]!,
                  }
                : undefined;
            members.push({
                name: member[3]!,
                type: type as ShaderType,
                ...(attribute ? { attribute } : {}),
            });
            offset = memberPattern.lastIndex;
        }
        structs.push({ name: match[1]!, members });
    }
    return {
        structs,
        entryPoint: {
            stage,
            name: entry[1]!,
            parameters,
            returnType: entry[4]!,
            ...(entry[3]
                ? {
                      returnAttribute: {
                          kind: "location" as const,
                          value: Number.parseInt(entry[3], 10),
                      },
                  }
                : {}),
            statements: [],
        },
        rawSource: canonicalSource,
    };
}

/**
 * The system uniforms this port fills, each with the C++ enumerator the
 * generated variant table names it by. Declaration order here IS the
 * emitted `enum class ShaderSystemMatrix` order, so the two cannot drift.
 *
 * `shader-material.ts#isSystemUniform` names nine; these are the five a
 * reached program declares, in the pin's own declaration order. The other
 * four refuse at generation -- not because they are underivable
 * (`worldView` is one multiply away) but because nothing measures them,
 * and an unreached arm is one this port would be guessing at.
 */
export const shaderSystemMatrixTable = [
    { name: "world", enumerator: "world", type: "mat4x4<f32>", floatSize: 16 },
    { name: "worldView", enumerator: "world_view", type: "mat4x4<f32>", floatSize: 16 },
    { name: "view", enumerator: "view", type: "mat4x4<f32>", floatSize: 16 },
    { name: "projection", enumerator: "projection", type: "mat4x4<f32>", floatSize: 16 },
    {
        name: "viewProjection",
        enumerator: "view_projection",
        type: "mat4x4<f32>",
        floatSize: 16,
    },
    {
        name: "worldViewProjection",
        enumerator: "world_view_projection",
        type: "mat4x4<f32>",
        floatSize: 16,
    },
    // WGSL uniform vec3 values occupy one aligned vec4 slot.
    {
        name: "cameraPosition",
        enumerator: "camera_position",
        type: "vec3<f32>",
        floatSize: 4,
    },
] as const;

export type ShaderSystemMatrix =
    (typeof shaderSystemMatrixTable)[number]["name"];

export const shaderSystemMatrices = shaderSystemMatrixTable.map(
    ({ name }) => name,
) as readonly ShaderSystemMatrix[];

export function isShaderSystemMatrix(
    name: string,
): name is ShaderSystemMatrix {
    return (shaderSystemMatrices as readonly string[]).includes(name);
}

function shaderSystemUniformRow(
    name: ShaderSystemMatrix,
): (typeof shaderSystemMatrixTable)[number] {
    const row = shaderSystemMatrixTable.find(
        (candidate) => candidate.name === name,
    );
    if (!row) throw new Error(`Unknown shader system uniform '${name}'.`);
    return row;
}

/** The C++ enumerator for a system matrix; total over the table. */
export function shaderSystemMatrixEnumerator(
    name: ShaderSystemMatrix,
): string {
    return shaderSystemUniformRow(name).enumerator;
}

export function shaderSystemUniformType(
    name: ShaderSystemMatrix,
): ShaderType {
    return shaderSystemUniformRow(name).type;
}

export function shaderSystemUniformFloatSize(
    name: ShaderSystemMatrix,
): number {
    return shaderSystemUniformRow(name).floatSize;
}

function parseUniformSignature(signature: string): { name: string; type: ShaderType } {
    if (isShaderSystemMatrix(signature)) {
        return {
            name: signature,
            type: shaderSystemUniformType(signature),
        };
    }
    const separator = signature.indexOf(":");
    if (separator < 1) throw new Error(`Invalid shader uniform '${signature}'.`);
    const name = signature.slice(0, separator);
    const type = signature.slice(separator + 1);
    if (!shaderTypes.has(type as ShaderType)) {
        throw new Error(`Unsupported shader uniform type '${type}'.`);
    }
    return { name, type: type as ShaderType };
}

/**
 * Whether any path the expression reads satisfies `matches`.
 *
 * The two questions this answers are the same walk over the same node
 * kinds: a uniform read is `shaderSystem.x` / `shaderUniforms.x` (two
 * parts), and a sampler read is the bare `<name>` / `<name>Sampler` the
 * caller's `textureSample` names (one part). Parameterizing the leaf test
 * keeps one exhaustive switch per node type, so a new IR kind is one edit
 * rather than four.
 */
function expressionUsesPath(
    expression: ShaderExpression,
    matches: (parts: readonly string[]) => boolean,
): boolean {
    switch (expression.kind) {
        case "binary":
            return expressionUsesPath(expression.left, matches) ||
                expressionUsesPath(expression.right, matches);
        case "call":
        case "construct":
            return expression.arguments.some((argument) =>
                expressionUsesPath(argument, matches));
        case "member":
            return expressionUsesPath(
                expression.expression,
                matches,
            );
        case "path":
            return matches(expression.parts);
        case "number":
            return false;
    }
}

function statementUsesPath(
    statement: ShaderStatement,
    matches: (parts: readonly string[]) => boolean,
): boolean {
    switch (statement.kind) {
        case "assign":
            return expressionUsesPath(statement.target, matches) ||
                expressionUsesPath(statement.value, matches);
        case "if":
            return expressionUsesPath(statement.condition, matches) ||
                statement.statements.some((nested) =>
                    statementUsesPath(nested, matches));
        case "let":
        case "return":
            return expressionUsesPath(statement.value, matches);
        case "discard":
        case "var":
            return false;
    }
}

/** Whether a stage reads the uniform block member `root.member`. */
function stageReadsUniform(
    module: ShaderModule,
    root: string,
    member: string,
): boolean {
    if (module.rawSource !== undefined) {
        return new RegExp(
            `\\b${root}\\s*\\.\\s*${member}\\b`,
        ).test(module.rawSource);
    }
    return module.entryPoint.statements.some((statement) =>
        statementUsesPath(
            statement,
            (parts) => parts[0] === root && parts[1] === member,
        ));
}

/**
 * Whether a stage samples the declared sampler `name`.
 *
 * Both halves of the pin's generated pair count: a body naming only the
 * `<name>Sampler` companion still needs the binding, and the two are
 * declared and bound together either way.
 */
function stageReadsSampler(
    module: ShaderModule,
    name: string,
): boolean {
    if (module.rawSource !== undefined) {
        return new RegExp(
            `\\b(?:${name}|${name}Sampler)\\b`,
        ).test(module.rawSource);
    }
    return module.entryPoint.statements.some((statement) =>
        statementUsesPath(
            statement,
            (parts) => parts[0] === name || parts[0] === `${name}Sampler`,
        ));
}

function typeComponents(type: ShaderType): number {
    switch (type) {
        case "f32":
            return 1;
        case "vec2<f32>":
            return 2;
        case "vec3<f32>":
            return 3;
        case "vec4<f32>":
            return 4;
        case "mat4x4<f32>":
            return 16;
    }
}

function componentSwizzle(start: number, count: number): string {
    return "xyzw".slice(start, start + count);
}

function reflectUniformBlock(
    stage: ShaderStage,
    module: ShaderModule,
    uniforms: Array<{ name: string; type: ShaderType }>,
): ShaderUniformBlockReflection | undefined {
    // Declaration order is the layout: each matrix the stage reads takes
    // four vec4 slots at the head of the block, and the custom floats pack
    // after them.
    const systemMatrices = uniforms
        .filter(
            ({ name }) =>
                isShaderSystemMatrix(name) &&
                stageReadsUniform(module, "shaderSystem", name),
        )
        .map(({ name }) => name as ShaderSystemMatrix);
    const custom = uniforms.filter(
        ({ name }) =>
            !isShaderSystemMatrix(name) &&
            stageReadsUniform(module, "shaderUniforms", name),
    );
    if (systemMatrices.length === 0 && custom.length === 0) return undefined;

    let slot = systemMatrices.reduce(
        (sum, name) =>
            sum + shaderSystemUniformFloatSize(name) / 4,
        0,
    );
    let component = 0;
    const members: ShaderUniformMemberReflection[] = [];
    for (const uniform of custom) {
        const count = typeComponents(uniform.type);
        if (count > 4) {
            throw new Error(`Custom matrix uniform '${uniform.name}' is not supported.`);
        }
        if (component + count > 4) {
            slot += 1;
            component = 0;
        }
        members.push({
            name: uniform.name,
            type: uniform.type,
            offset: slot * 16 + component * 4,
            size: count * 4,
            slot,
            components: componentSwizzle(component, count),
        });
        component += count;
        if (component === 4) {
            slot += 1;
            component = 0;
        }
    }
    const slotCount = slot + (component > 0 ? 1 : 0);
    return {
        stage,
        binding: 0,
        space: stage === "vertex" ? 1 : 3,
        size: slotCount * 16,
        systemMatrices,
        members,
    };
}

export function lowerWgslShaderProgram(
    source: ShaderMaterialProgramSource,
): ShaderIrProgram {
    const complexModule = (text: string): boolean =>
        /(^|\n)\s*(?:const\s+|fn\s+)/.test(text) ||
        /\bfor\s*\(/.test(text) ||
        /\bvar\s+[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text);
    const lowerModule = (
        text: string,
        stage: ShaderStage,
    ): ShaderModule => {
        try {
            return new WgslSubsetParser(
                tokenize(text),
                stage,
            ).parse();
        } catch (error: unknown) {
            // The raw module path carries reached WGSL constructs that the
            // typed subset has not learned yet (helper functions, constants,
            // and loops). Always try the typed parser first: formatting a
            // simple entry point with `fn` at the start of a line must not
            // change its semantic identity or make two equivalent programs
            // compare as raw source text.
            if (!complexModule(text)) throw error;
            return parseRawModule(text, stage);
        }
    };
    const vertex = lowerModule(source.vertexSource, "vertex");
    const fragment = lowerModule(source.fragmentSource, "fragment");
    const attributes = source.attributes.map((name) => {
        const attribute = attributeTypes[name];
        if (!attribute) throw new Error(`Unsupported vertex attribute '${name}'.`);
        return { name, ...attribute };
    });
    if (source.useThinInstances) {
        attributes.push(...instanceAttributes);
        if (source.useThinInstanceColors) {
            attributes.push(instanceColorAttribute);
        }
    }
    const uniforms = source.uniforms.map(parseUniformSignature);
    // A sampler pair binds in the fragment stage alone here. The pin
    // declares both stages' visibility, but SDL_GPU gives a vertex texture
    // its own register space, and no reached scene samples in a vertex
    // stage, so one that does refuses rather than binding at the fragment
    // stage's registers.
    for (const name of source.samplers ?? []) {
        if (stageReadsSampler(vertex, name)) {
            throw new Error(
                `Shader material sampler '${name}' is read by the vertex stage, which is not lowered.`,
            );
        }
    }
    const samplers = [...(source.samplers ?? [])];
    const vertexBlock = reflectUniformBlock("vertex", vertex, uniforms);
    const fragmentBlock = reflectUniformBlock("fragment", fragment, uniforms);
    const vertexOutput = vertex.structs.find(
        ({ name }) => name === vertex.entryPoint.returnType,
    );
    if (!vertexOutput) {
        throw new Error(
            `Vertex entry point returns unknown struct '${vertex.entryPoint.returnType}'.`,
        );
    }
    return {
        name: source.name,
        vertex,
        fragment,
        reflection: {
            name: source.name,
            entryPoints: [
                { stage: "vertex", name: vertex.entryPoint.name },
                { stage: "fragment", name: fragment.entryPoint.name },
            ],
            attributes,
            varyings: vertexOutput.members,
            uniformBlocks: [vertexBlock, fragmentBlock].filter(
                (block): block is ShaderUniformBlockReflection => !!block,
            ),
            samplers,
        },
    };
}
