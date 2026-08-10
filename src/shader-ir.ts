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
    systemMatrix: boolean;
    members: ShaderUniformMemberReflection[];
}

export interface ShaderProgramReflection {
    name: string;
    entryPoints: Array<{ stage: ShaderStage; name: string }>;
    attributes: Array<{ name: string; location: number; type: ShaderType }>;
    varyings: ShaderStructMember[];
    uniformBlocks: ShaderUniformBlockReflection[];
}

export interface ShaderIrProgram {
    name: string;
    vertex: ShaderModule;
    fragment: ShaderModule;
    clipDepth: ShaderMaterialProgramSource["clipDepth"];
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

const attributeTypes: Record<string, { location: number; type: ShaderType }> = {
    position: { location: 0, type: "vec3<f32>" },
    normal: { location: 1, type: "vec3<f32>" },
    tangent: { location: 2, type: "vec4<f32>" },
    uv: { location: 3, type: "vec2<f32>" },
    color: { location: 4, type: "vec4<f32>" },
};

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

function parseUniformSignature(signature: string): { name: string; type: ShaderType } {
    if (signature === "worldViewProjection") {
        return { name: signature, type: "mat4x4<f32>" };
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

function expressionUsesPath(
    expression: ShaderExpression,
    root: string,
    member: string,
): boolean {
    switch (expression.kind) {
        case "binary":
            return expressionUsesPath(expression.left, root, member) ||
                expressionUsesPath(expression.right, root, member);
        case "call":
        case "construct":
            return expression.arguments.some((argument) =>
                expressionUsesPath(argument, root, member));
        case "path":
            return expression.parts[0] === root && expression.parts[1] === member;
        case "number":
            return false;
    }
}

function statementUsesPath(
    statement: ShaderStatement,
    root: string,
    member: string,
): boolean {
    switch (statement.kind) {
        case "assign":
            return expressionUsesPath(statement.target, root, member) ||
                expressionUsesPath(statement.value, root, member);
        case "if":
            return expressionUsesPath(statement.condition, root, member) ||
                statement.statements.some((nested) =>
                    statementUsesPath(nested, root, member));
        case "let":
        case "return":
            return expressionUsesPath(statement.value, root, member);
        case "discard":
        case "var":
            return false;
    }
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
    const statements = module.entryPoint.statements;
    const systemMatrix = uniforms.some(
        ({ name }) =>
            name === "worldViewProjection" &&
            statements.some((statement) =>
                statementUsesPath(statement, "shaderSystem", name)),
    );
    const custom = uniforms.filter(
        ({ name }) =>
            name !== "worldViewProjection" &&
            statements.some((statement) =>
                statementUsesPath(statement, "shaderUniforms", name)),
    );
    if (!systemMatrix && custom.length === 0) return undefined;

    let slot = systemMatrix ? 4 : 0;
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
        systemMatrix,
        members,
    };
}

export function lowerWgslShaderProgram(
    source: ShaderMaterialProgramSource,
): ShaderIrProgram {
    const vertex = new WgslSubsetParser(
        tokenize(source.vertexSource),
        "vertex",
    ).parse();
    const fragment = new WgslSubsetParser(
        tokenize(source.fragmentSource),
        "fragment",
    ).parse();
    const attributes = source.attributes.map((name) => {
        const attribute = attributeTypes[name];
        if (!attribute) throw new Error(`Unsupported vertex attribute '${name}'.`);
        return { name, ...attribute };
    });
    const uniforms = source.uniforms.map(parseUniformSignature);
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
        clipDepth: source.clipDepth,
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
        },
    };
}
