import {
    fieldOffsets,
    layoutOf,
    roundUp,
    type WgslTypeShape,
} from "./wgsl-layout.js";
import {
    shaderSamplerDeclarations,
    type ShaderMaterialProgramSource,
} from "./shader-material-programs.js";
import type {
    CompiledShaderSampler,
    CompiledShaderStorageBuffer,
} from "./compiler/types.js";

export type ShaderStage = "vertex" | "fragment";
/** A pipeline's value for a numeric WGSL override ID, distinct from its declaration. */
export interface ShaderStageConstant {
    id: number;
    value: number;
}

type ShaderType =
    "f32" | "mat4x4<f32>" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>";

const shaderTypeShorthands: Readonly<Record<string, ShaderType>> = {
    vec2f: "vec2<f32>",
    vec3f: "vec3<f32>",
    vec4f: "vec4<f32>",
    mat4x4f: "mat4x4<f32>",
};

interface ShaderAttribute {
    kind: "builtin" | "location";
    value: string | number;
}

interface ShaderStructMember {
    name: string;
    type: string;
    attribute?: ShaderAttribute | undefined;
}

export interface ShaderStruct {
    name: string;
    members: ShaderStructMember[];
}

type ShaderBinaryOperator =
    | "+"
    | "-"
    | "*"
    | "/"
    | "%"
    | "<"
    | ">"
    | "<="
    | ">="
    | "=="
    | "!="
    | "&&"
    | "||"
    | "&"
    | "|"
    | "^"
    | "<<"
    | ">>";

type ShaderUnaryOperator = "-" | "!" | "~" | "&" | "*";

type ShaderCompoundOperator =
    "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=";

export type ShaderExpression =
    | {
          kind: "binary";
          operator: ShaderBinaryOperator;
          left: ShaderExpression;
          right: ShaderExpression;
      }
    | {
          kind: "unary";
          operator: ShaderUnaryOperator;
          operand: ShaderExpression;
      }
    | { kind: "call"; name: string; arguments: ShaderExpression[] }
    | { kind: "construct"; type: ShaderType; arguments: ShaderExpression[] }
    | { kind: "index"; expression: ShaderExpression; index: ShaderExpression }
    | { kind: "member"; expression: ShaderExpression; member: string }
    | { kind: "number"; value: string }
    | { kind: "path"; parts: string[] };

/** One arm of a `switch`: its case selectors (`default` among them) and body. */
interface ShaderSwitchClause {
    selectors: Array<ShaderExpression | "default">;
    statements: ShaderStatement[];
}

export type ShaderStatement =
    | {
          kind: "assign";
          target: ShaderExpression;
          value: ShaderExpression;
          /** A compound assignment's operator; absent for plain `=`. */
          operator?: ShaderCompoundOperator;
      }
    | { kind: "increment"; target: ShaderExpression; operator: "++" | "--" }
    | { kind: "discard" }
    | { kind: "break" }
    | { kind: "continue" }
    | { kind: "expression"; value: ShaderExpression }
    | { kind: "block"; statements: ShaderStatement[] }
    | {
          kind: "for";
          initializer?: ShaderStatement;
          condition?: ShaderExpression;
          update?: ShaderStatement;
          statements: ShaderStatement[];
      }
    | {
          kind: "while";
          condition: ShaderExpression;
          statements: ShaderStatement[];
      }
    | {
          kind: "loop";
          statements: ShaderStatement[];
          continuing?: ShaderStatement[];
          breakIf?: ShaderExpression;
      }
    | {
          kind: "switch";
          selector: ShaderExpression;
          clauses: ShaderSwitchClause[];
      }
    | {
          kind: "if";
          condition: ShaderExpression;
          statements: ShaderStatement[];
          /** The `else` arm; an `else if` is one nested `if` statement. */
          alternative?: ShaderStatement[];
      }
    | { kind: "let"; name: string; type?: string; value: ShaderExpression }
    | { kind: "const"; name: string; type?: string; value: ShaderExpression }
    | { kind: "return"; value?: ShaderExpression }
    | { kind: "var"; name: string; type?: string; value?: ShaderExpression }
    | { kind: "assert"; value: ShaderExpression };

interface ShaderParameter {
    name: string;
    type: string;
    attribute?: ShaderAttribute;
}

interface ShaderBinding {
    name: string;
    type: string;
    group: number;
    binding: number;
    addressSpace?: "uniform" | "storage, read";
}

export interface ShaderFunction {
    name: string;
    parameters: ShaderParameter[];
    /** Absent for a function that returns nothing. */
    returnType?: string;
    statements: ShaderStatement[];
}

export interface ShaderEntryPoint extends ShaderFunction {
    stage: ShaderStage;
    returnType: string;
    returnAttribute?: ShaderAttribute | undefined;
}

/** A module-scope `const`. */
export interface ShaderConstant {
    name: string;
    type?: string;
    value: ShaderExpression;
}

export interface ShaderModule {
    structs: ShaderStruct[];
    entryPoint: ShaderEntryPoint;
    bindings?: ShaderBinding[];
    /** Module-scope constants, in declaration order. */
    constants?: ShaderConstant[];
    /** The helper functions the module declares, in declaration order. */
    functions?: ShaderFunction[];
}

interface ShaderComputeModule {
    bindings: ShaderBinding[];
    overrides: Array<{
        name: string;
        type: string;
        id: number;
        value: ShaderExpression;
    }>;
    name: string;
    parameters: ShaderParameter[];
    workgroupSize: number[];
    statements: ShaderStatement[];
}

interface ShaderUniformMemberReflection {
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
    samplerDeclarations: CompiledShaderSampler[];
    storageBuffers: Array<
        CompiledShaderStorageBuffer & {
            vertex: boolean;
            fragment: boolean;
        }
    >;
}

export interface ShaderIrProgram {
    name: string;
    vertex: ShaderModule;
    fragment: ShaderModule;
    reflection: ShaderProgramReflection;
}

// ---------------------------------------------------------------------------
// The WGSL front end: one lexer and one parser for every WGSL text this
// repository reads -- an application's shader-material stages, the pin's
// composed variants and its packaged utility shaders. What is read out of a
// module is read from this syntax tree, never from its spelling.
// ---------------------------------------------------------------------------

/** A WGSL attribute: `@location(0)`, `@builtin(position)`, `@vertex`, ... */
interface WgslAttribute {
    name: string;
    arguments: ShaderExpression[];
}

/** A type as declared: normalized, as spelled in the source, and structured. */
interface WgslTypeReference {
    /** Whitespace-free, float shorthands expanded (`vec3f` -> `vec3<f32>`). */
    text: string;
    /** The declaration's own spelling, whitespace included. */
    source: string;
    shape: WgslTypeShape;
}

/** A struct member or a function parameter. */
export interface WgslMemberSyntax {
    attributes: WgslAttribute[];
    name: string;
    type: WgslTypeReference;
}

/** Source offsets of a declaration, for splicing a module by position. */
interface WgslSpan {
    start: number;
    end: number;
}

export interface WgslStructDeclaration extends WgslSpan {
    kind: "struct";
    name: string;
    members: WgslMemberSyntax[];
}

export interface WgslVariableDeclaration extends WgslSpan {
    kind: "var";
    attributes: WgslAttribute[];
    /** `uniform`, `storage`, `private`, `workgroup`, or absent for a handle. */
    addressSpace?: string;
    accessMode?: string;
    name: string;
    type?: WgslTypeReference;
    value?: ShaderExpression;
    /** The declaration's `var<...> name:` head, from `var` through its `:`. */
    head: WgslSpan;
}

interface WgslValueDeclaration extends WgslSpan {
    kind: "const" | "override";
    attributes: WgslAttribute[];
    name: string;
    type?: WgslTypeReference;
    value?: ShaderExpression;
}

interface WgslAliasDeclaration extends WgslSpan {
    kind: "alias";
    name: string;
    type: WgslTypeReference;
}

interface WgslFunctionDeclaration extends WgslSpan {
    kind: "fn";
    attributes: WgslAttribute[];
    name: string;
    parameters: WgslMemberSyntax[];
    returnAttributes: WgslAttribute[];
    returnType?: WgslTypeReference;
    statements: ShaderStatement[];
    /** The source between the body's braces. */
    body: WgslSpan;
}

interface WgslDirective extends WgslSpan {
    kind: "enable" | "requires" | "diagnostic";
    arguments: string[];
}

interface WgslAssertDeclaration extends WgslSpan {
    kind: "assert";
    value: ShaderExpression;
}

type WgslDeclaration =
    | WgslStructDeclaration
    | WgslVariableDeclaration
    | WgslValueDeclaration
    | WgslAliasDeclaration
    | WgslFunctionDeclaration
    | WgslDirective
    | WgslAssertDeclaration;

interface WgslModuleSyntax {
    declarations: WgslDeclaration[];
}

interface Token {
    kind: "identifier" | "number" | "symbol" | "eof";
    text: string;
    start: number;
    end: number;
    /** Set by template-list discovery on the `<` and `>` delimiting one. */
    template?: "open" | "close";
}

const shaderTypes = new Set<ShaderType>([
    "f32",
    "mat4x4<f32>",
    "vec2<f32>",
    "vec3<f32>",
    "vec4<f32>",
]);

/** Multi-character WGSL symbols, longest first. */
const operatorTokens = [
    ">>=",
    "<<=",
    "->",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "++",
    "--",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "<<",
    ">>",
] as const;

const punctuationTokens = "@{}[]():;,<>.+-*/%=!&|^~";

const compoundOperators = new Set<string>([
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "<<=",
    ">>=",
]);

const unaryOperators = new Set<string>(["-", "!", "~", "&", "*"]);

/** C-style binding strength; valid WGSL never relies on a mixed chain. */
const binaryPrecedence: Readonly<Record<string, number>> = {
    "||": 1,
    "&&": 2,
    "|": 3,
    "^": 4,
    "&": 5,
    "==": 6,
    "!=": 6,
    "<": 7,
    ">": 7,
    "<=": 7,
    ">=": 7,
    "<<": 8,
    ">>": 8,
    "+": 9,
    "-": 9,
    "*": 10,
    "/": 10,
    "%": 10,
};

/** WGSL blankspace (the spec's `_blankspace` set). */
function isBlank(code: number): boolean {
    return (
        code === 0x20 ||
        (code >= 0x09 && code <= 0x0d) ||
        code === 0x85 ||
        code === 0x200e ||
        code === 0x200f ||
        code === 0x2028 ||
        code === 0x2029
    );
}

function isLineBreak(code: number): boolean {
    return (
        (code >= 0x0a && code <= 0x0d) ||
        code === 0x85 ||
        code === 0x2028 ||
        code === 0x2029
    );
}

function isDigit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
    return (
        isDigit(code) ||
        (code >= 0x41 && code <= 0x46) ||
        (code >= 0x61 && code <= 0x66)
    );
}

function isIdentifierStart(code: number): boolean {
    return (
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code === 0x5f
    );
}

function isIdentifierPart(code: number): boolean {
    return isIdentifierStart(code) || isDigit(code);
}

/** The first offset after a WGSL block comment, including nested comments. */
function blockCommentEnd(source: string, start: number): number {
    let index = start + 2;
    let depth = 1;
    while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
            ++depth;
            index += 2;
        } else if (source.startsWith("*/", index)) {
            --depth;
            index += 2;
        } else {
            ++index;
        }
    }
    if (depth) throw new Error("Unclosed WGSL block comment.");
    return index;
}

/** The end of the numeric literal starting at `start`. */
function numberEnd(source: string, start: number): number {
    let index = start;
    const suffix = (letters: string): void => {
        if (index < source.length && letters.includes(source[index]!)) ++index;
    };
    if (
        source[index] === "0" &&
        (source[index + 1] === "x" || source[index + 1] === "X")
    ) {
        index += 2;
        const digits = index;
        while (isHexDigit(source.charCodeAt(index))) ++index;
        if (source[index] === ".") {
            ++index;
            while (isHexDigit(source.charCodeAt(index))) ++index;
        }
        if (index === digits)
            throw new Error(
                `Malformed WGSL hexadecimal literal at offset ${start}.`,
            );
        if (source[index] === "p" || source[index] === "P") {
            ++index;
            if (source[index] === "+" || source[index] === "-") ++index;
            while (isDigit(source.charCodeAt(index))) ++index;
            suffix("fh");
        } else {
            suffix("fhiu");
        }
        return index;
    }
    while (isDigit(source.charCodeAt(index))) ++index;
    if (source[index] === ".") {
        ++index;
        while (isDigit(source.charCodeAt(index))) ++index;
    }
    if (source[index] === "e" || source[index] === "E") {
        let exponent = index + 1;
        if (source[exponent] === "+" || source[exponent] === "-") ++exponent;
        if (isDigit(source.charCodeAt(exponent))) {
            index = exponent;
            while (isDigit(source.charCodeAt(index))) ++index;
        }
    }
    suffix("fhiu");
    return index;
}

function lexWgsl(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < source.length) {
        const code = source.charCodeAt(index);
        if (isBlank(code)) {
            ++index;
            continue;
        }
        if (source.startsWith("//", index)) {
            index += 2;
            while (
                index < source.length &&
                !isLineBreak(source.charCodeAt(index))
            ) {
                ++index;
            }
            continue;
        }
        if (source.startsWith("/*", index)) {
            index = blockCommentEnd(source, index);
            continue;
        }
        const start = index;
        if (isIdentifierStart(code)) {
            ++index;
            while (
                index < source.length &&
                isIdentifierPart(source.charCodeAt(index))
            ) {
                ++index;
            }
            tokens.push({
                kind: "identifier",
                text: source.slice(start, index),
                start,
                end: index,
            });
            continue;
        }
        if (
            isDigit(code) ||
            (source[index] === "." && isDigit(source.charCodeAt(index + 1)))
        ) {
            index = numberEnd(source, index);
            tokens.push({
                kind: "number",
                text: source.slice(start, index),
                start,
                end: index,
            });
            continue;
        }
        const operator = operatorTokens.find((candidate) =>
            source.startsWith(candidate, index),
        );
        const text =
            operator ??
            (punctuationTokens.includes(source[index]!)
                ? source[index]!
                : undefined);
        if (text === undefined) {
            throw new Error(
                `Unsupported WGSL token '${source[index]}' at offset ${index}.`,
            );
        }
        index += text.length;
        tokens.push({ kind: "symbol", text, start, end: index });
    }
    tokens.push({
        kind: "eof",
        text: "",
        start: source.length,
        end: source.length,
    });
    return tokens;
}

/**
 * WGSL template-list discovery (the spec's own algorithm, over tokens): marks
 * the `<` and `>` that delimit `array<vec4<u32>, 4>` apart from the ones that
 * compare, splitting a `>>` or `>=` whose first `>` closes a list.
 */
function discoverTemplateLists(tokens: readonly Token[]): Token[] {
    const discovered: Token[] = [];
    const pending: Array<{ index: number; depth: number }> = [];
    let depth = 0;
    const clear = (): void => {
        pending.length = 0;
        depth = 0;
    };
    const popTo = (limit: number): void => {
        while (pending.length > 0 && pending.at(-1)!.depth >= limit)
            pending.pop();
    };
    const work = [...tokens].reverse();
    while (work.length > 0) {
        const token = work.pop()!;
        if (token.kind === "symbol") {
            switch (token.text) {
                case "<":
                    if (discovered.at(-1)?.kind === "identifier")
                        pending.push({ index: discovered.length, depth });
                    break;
                case ">":
                case ">>":
                case ">=":
                case ">>=": {
                    const open = pending.at(-1);
                    if (open && open.depth === depth) {
                        pending.pop();
                        discovered[open.index] = {
                            ...discovered[open.index]!,
                            template: "open",
                        };
                        discovered.push({
                            kind: "symbol",
                            text: ">",
                            start: token.start,
                            end: token.start + 1,
                            template: "close",
                        });
                        if (token.text.length > 1) {
                            work.push({
                                kind: "symbol",
                                text: token.text.slice(1),
                                start: token.start + 1,
                                end: token.end,
                            });
                        }
                        continue;
                    }
                    if (token.text === ">>=") clear();
                    break;
                }
                case "(":
                case "[":
                    ++depth;
                    break;
                case ")":
                case "]":
                    popTo(depth);
                    depth = Math.max(0, depth - 1);
                    break;
                case "&&":
                case "||":
                    popTo(depth);
                    break;
                case ";":
                case "{":
                case ":":
                case "=":
                    clear();
                    break;
                default:
                    if (compoundOperators.has(token.text)) clear();
            }
        }
        discovered.push(token);
    }
    return discovered;
}

function tokenize(source: string): Token[] {
    return discoverTemplateLists(lexWgsl(source));
}

/** The value of a WGSL integer literal (`4`, `4u`, `0x10i`), or undefined. */
function integerLiteral(spelling: string): number | undefined {
    const last = spelling.at(-1);
    const digits =
        last === "i" || last === "u" ? spelling.slice(0, -1) : spelling;
    const hex = digits.startsWith("0x") || digits.startsWith("0X");
    const body = hex ? digits.slice(2) : digits;
    if (
        body.length === 0 ||
        [...body].some((character) => {
            const code = character.charCodeAt(0);
            return hex ? !isHexDigit(code) : !isDigit(code);
        })
    ) {
        return undefined;
    }
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : undefined;
}

class WgslParser {
    private index = 0;

    public constructor(
        private readonly source: string,
        private readonly tokens: Token[],
    ) {}

    public module(): WgslModuleSyntax {
        const declarations: WgslDeclaration[] = [];
        while (this.peek().kind !== "eof") {
            if (this.accept(";")) continue;
            declarations.push(this.parseDeclaration());
        }
        return { declarations };
    }

    public expression(): ShaderExpression {
        const expression = this.parseExpression();
        this.expectEof();
        return expression;
    }

    public statements(): ShaderStatement[] {
        const statements: ShaderStatement[] = [];
        while (this.peek().kind !== "eof") {
            if (this.accept(";")) continue;
            statements.push(this.parseStatement());
        }
        return statements;
    }

    public structMembers(): WgslMemberSyntax[] {
        const members = this.parseMembers("eof");
        this.expectEof();
        return members;
    }

    public type(): WgslTypeReference {
        const type = this.parseType();
        this.expectEof();
        return type;
    }

    private parseDeclaration(): WgslDeclaration {
        const start = this.peek().start;
        const keyword = this.peek().text;
        if (keyword === "enable" || keyword === "requires") {
            this.index += 1;
            const values: string[] = [];
            do {
                if (this.peek().text === ";") break;
                values.push(this.expectIdentifier());
            } while (this.accept(","));
            this.expect(";");
            return { kind: keyword, arguments: values, ...this.span(start) };
        }
        if (keyword === "diagnostic") {
            this.index += 1;
            const values = this.parseDiagnosticControl();
            this.expect(";");
            return {
                kind: "diagnostic",
                arguments: values,
                ...this.span(start),
            };
        }
        const attributes = this.parseAttributes();
        const head = this.peek().text;
        switch (head) {
            case "struct":
                this.refuseAttributes(attributes, "struct");
                return this.parseStruct(start);
            case "var":
                return this.parseVariable(start, attributes);
            case "const":
            case "override": {
                if (head === "const")
                    this.refuseAttributes(attributes, "const");
                this.index += 1;
                const name = this.expectIdentifier();
                const type = this.accept(":") ? this.parseType() : undefined;
                const value = this.accept("=")
                    ? this.parseExpression()
                    : undefined;
                if (head === "const" && !value)
                    throw new Error(`WGSL const '${name}' needs a value.`);
                this.expect(";");
                return {
                    kind: head,
                    attributes,
                    name,
                    ...(type ? { type } : {}),
                    ...(value ? { value } : {}),
                    ...this.span(start),
                };
            }
            case "alias": {
                this.refuseAttributes(attributes, "alias");
                this.index += 1;
                const name = this.expectIdentifier();
                this.expect("=");
                const type = this.parseType();
                this.expect(";");
                return { kind: "alias", name, type, ...this.span(start) };
            }
            case "fn":
                return this.parseFunction(start, attributes);
            case "const_assert": {
                this.refuseAttributes(attributes, "const_assert");
                this.index += 1;
                const value = this.parseExpression();
                this.expect(";");
                return { kind: "assert", value, ...this.span(start) };
            }
        }
        throw new Error(`Unsupported WGSL declaration '${head}'.`);
    }

    private span(start: number): WgslSpan {
        return { start, end: this.tokens[this.index - 1]!.end };
    }

    private refuseAttributes(
        attributes: readonly WgslAttribute[],
        what: string,
    ): void {
        if (attributes.length > 0) {
            throw new Error(
                `Unsupported WGSL attribute '@${attributes[0]!.name}' on ${what}.`,
            );
        }
    }

    private parseDiagnosticControl(): string[] {
        this.expect("(");
        const values: string[] = [];
        while (this.peek().text !== ")") {
            const parts = [this.expectIdentifier()];
            while (this.accept(".")) parts.push(this.expectIdentifier());
            values.push(parts.join("."));
            if (!this.accept(",")) break;
        }
        this.expect(")");
        return values;
    }

    private parseAttributes(): WgslAttribute[] {
        const attributes: WgslAttribute[] = [];
        while (this.accept("@")) {
            const name = this.expectIdentifier();
            if (name === "diagnostic") {
                attributes.push({
                    name,
                    arguments: this.parseDiagnosticControl().map((value) => ({
                        kind: "path",
                        parts: value.split("."),
                    })),
                });
                continue;
            }
            attributes.push({
                name,
                arguments:
                    this.peek().text === "(" ? this.parseArguments() : [],
            });
        }
        return attributes;
    }

    private parseStruct(start: number): WgslStructDeclaration {
        this.expect("struct");
        const name = this.expectIdentifier();
        this.expect("{");
        const members = this.parseMembers("}");
        this.expect("}");
        return { kind: "struct", name, members, ...this.span(start) };
    }

    private parseMembers(terminator: "}" | "eof"): WgslMemberSyntax[] {
        const members: WgslMemberSyntax[] = [];
        const done = (): boolean =>
            terminator === "eof"
                ? this.peek().kind === "eof"
                : this.peek().text === terminator;
        while (!done()) {
            const attributes = this.parseAttributes();
            const name = this.expectIdentifier();
            this.expect(":");
            members.push({ attributes, name, type: this.parseType() });
            if (!this.accept(",")) break;
        }
        return members;
    }

    private parseVariable(
        start: number,
        attributes: WgslAttribute[],
    ): WgslVariableDeclaration {
        const keyword = this.peek().start;
        this.expect("var");
        let addressSpace: string | undefined;
        let accessMode: string | undefined;
        if (this.acceptTemplateOpen()) {
            addressSpace = this.expectIdentifier();
            if (this.accept(",") && !this.peekTemplateClose())
                accessMode = this.expectIdentifier();
            this.accept(",");
            this.expectTemplateClose();
        }
        const name = this.expectIdentifier();
        const head = { start: keyword, end: this.tokens[this.index - 1]!.end };
        let type: WgslTypeReference | undefined;
        if (this.accept(":")) {
            head.end = this.tokens[this.index - 1]!.end;
            type = this.parseType();
        }
        const value = this.accept("=") ? this.parseExpression() : undefined;
        this.expect(";");
        return {
            kind: "var",
            attributes,
            ...(addressSpace ? { addressSpace } : {}),
            ...(accessMode ? { accessMode } : {}),
            name,
            ...(type ? { type } : {}),
            ...(value ? { value } : {}),
            head,
            ...this.span(start),
        };
    }

    private parseFunction(
        start: number,
        attributes: WgslAttribute[],
    ): WgslFunctionDeclaration {
        this.expect("fn");
        const name = this.expectIdentifier();
        this.expect("(");
        const parameters: WgslMemberSyntax[] = [];
        while (this.peek().text !== ")") {
            const parameterAttributes = this.parseAttributes();
            const parameterName = this.expectIdentifier();
            this.expect(":");
            parameters.push({
                attributes: parameterAttributes,
                name: parameterName,
                type: this.parseType(),
            });
            if (!this.accept(",")) break;
        }
        this.expect(")");
        let returnAttributes: WgslAttribute[] = [];
        let returnType: WgslTypeReference | undefined;
        if (this.accept("->")) {
            returnAttributes = this.parseAttributes();
            returnType = this.parseType();
        }
        const open = this.peek().end;
        const statements = this.parseBlock();
        return {
            kind: "fn",
            attributes,
            name,
            parameters,
            returnAttributes,
            ...(returnType ? { returnType } : {}),
            statements,
            body: { start: open, end: this.tokens[this.index - 1]!.start },
            ...this.span(start),
        };
    }

    private parseType(): WgslTypeReference {
        const first = this.peek();
        const { text, shape } = this.parseTypeParts();
        return {
            text,
            source: this.source.slice(
                first.start,
                this.tokens[this.index - 1]!.end,
            ),
            shape,
        };
    }

    private parseTypeParts(): { text: string; shape: WgslTypeShape } {
        const name = this.expectIdentifier();
        if (!this.acceptTemplateOpen()) {
            return {
                text: shaderTypeShorthands[name] ?? name,
                shape: { name, arguments: [] },
            };
        }
        const texts: string[] = [];
        const shapes: Array<WgslTypeShape | number> = [];
        while (!this.peekTemplateClose()) {
            if (this.peek().kind === "number") {
                const spelling = this.expectNumber();
                const value = integerLiteral(spelling);
                if (value === undefined) {
                    throw new Error(
                        `Unsupported WGSL template argument '${spelling}'.`,
                    );
                }
                texts.push(spelling);
                shapes.push(value);
            } else if (this.peek().kind === "identifier") {
                const nested = this.parseTypeParts();
                texts.push(nested.text);
                shapes.push(nested.shape);
            } else {
                throw new Error(
                    `Unsupported WGSL template argument '${this.peek().text}' in '${name}'.`,
                );
            }
            if (!this.accept(",")) break;
        }
        this.expectTemplateClose();
        return {
            text: `${name}<${texts.join(",")}>`,
            shape: { name, arguments: shapes },
        };
    }

    private parseBlock(): ShaderStatement[] {
        this.expect("{");
        const statements: ShaderStatement[] = [];
        while (!this.accept("}")) {
            if (this.accept(";")) continue;
            statements.push(this.parseStatement());
        }
        return statements;
    }

    private parseStatement(): ShaderStatement {
        const keyword =
            this.peek().kind === "identifier" ? this.peek().text : "";
        if (this.peek().text === "@") {
            throw new Error(
                `Unsupported WGSL statement attribute at offset ${this.peek().start}.`,
            );
        }
        switch (keyword) {
            case "if":
                return this.parseIf();
            case "for": {
                this.index += 1;
                this.expect("(");
                const initializer =
                    this.peek().text === ";"
                        ? undefined
                        : this.parseSimpleStatement();
                this.expect(";");
                const condition =
                    this.peek().text === ";"
                        ? undefined
                        : this.parseExpression();
                this.expect(";");
                const update =
                    this.peek().text === ")"
                        ? undefined
                        : this.parseSimpleStatement();
                this.expect(")");
                return {
                    kind: "for",
                    ...(initializer ? { initializer } : {}),
                    ...(condition ? { condition } : {}),
                    ...(update ? { update } : {}),
                    statements: this.parseBlock(),
                };
            }
            case "while": {
                this.index += 1;
                const condition = this.parseExpression();
                return {
                    kind: "while",
                    condition,
                    statements: this.parseBlock(),
                };
            }
            case "loop":
                return this.parseLoop();
            case "switch":
                return this.parseSwitch();
            case "break":
                this.index += 1;
                this.expect(";");
                return { kind: "break" };
            case "continue":
                this.index += 1;
                this.expect(";");
                return { kind: "continue" };
            case "discard":
                this.index += 1;
                this.expect(";");
                return { kind: "discard" };
            case "return": {
                this.index += 1;
                if (this.accept(";")) return { kind: "return" };
                const value = this.parseExpression();
                this.expect(";");
                return { kind: "return", value };
            }
            case "const_assert": {
                this.index += 1;
                const value = this.parseExpression();
                this.expect(";");
                return { kind: "assert", value };
            }
        }
        if (this.peek().text === "{")
            return { kind: "block", statements: this.parseBlock() };
        const statement = this.parseSimpleStatement();
        this.expect(";");
        return statement;
    }

    /** A declaration, assignment, increment or call: a statement without its `;`. */
    private parseSimpleStatement(): ShaderStatement {
        const keyword =
            this.peek().kind === "identifier" ? this.peek().text : "";
        if (keyword === "let" || keyword === "const") {
            this.index += 1;
            const name = this.expectIdentifier();
            const type = this.accept(":") ? this.parseType().text : undefined;
            this.expect("=");
            const value = this.parseExpression();
            return { kind: keyword, name, ...(type ? { type } : {}), value };
        }
        if (keyword === "var") {
            this.index += 1;
            if (this.peekTemplateOpen()) {
                throw new Error(
                    "Unsupported WGSL function-scope variable address space.",
                );
            }
            const name = this.expectIdentifier();
            const type = this.accept(":") ? this.parseType().text : undefined;
            const value = this.accept("=") ? this.parseExpression() : undefined;
            if (!type && !value)
                throw new Error("WGSL var needs a type or initializer.");
            return {
                kind: "var",
                name,
                ...(type ? { type } : {}),
                ...(value ? { value } : {}),
            };
        }
        const target = this.parseExpression();
        if (
            target.kind === "call" &&
            (this.peek().text === ";" || this.peek().text === ")")
        ) {
            return { kind: "expression", value: target };
        }
        const operator = this.peek().text;
        if (operator === "++" || operator === "--") {
            this.index += 1;
            return { kind: "increment", target, operator };
        }
        if (compoundOperators.has(operator)) {
            this.index += 1;
            return {
                kind: "assign",
                target,
                value: this.parseExpression(),
                operator: operator as ShaderCompoundOperator,
            };
        }
        this.expect("=");
        return { kind: "assign", target, value: this.parseExpression() };
    }

    private parseIf(): ShaderStatement {
        this.expect("if");
        const condition = this.parseExpression();
        const statements = this.parseBlock();
        if (!this.accept("else")) return { kind: "if", condition, statements };
        const alternative =
            this.peek().text === "if" ? [this.parseIf()] : this.parseBlock();
        return { kind: "if", condition, statements, alternative };
    }

    private parseLoop(): ShaderStatement {
        this.expect("loop");
        this.expect("{");
        const statements: ShaderStatement[] = [];
        let continuing: ShaderStatement[] | undefined;
        let breakIf: ShaderExpression | undefined;
        while (!this.accept("}")) {
            if (this.accept(";")) continue;
            if (this.accept("continuing")) {
                this.expect("{");
                continuing = [];
                while (!this.accept("}")) {
                    if (this.accept(";")) continue;
                    if (
                        this.peek().text === "break" &&
                        this.tokens[this.index + 1]?.text === "if"
                    ) {
                        this.index += 2;
                        breakIf = this.parseExpression();
                        this.expect(";");
                        this.expect("}");
                        break;
                    }
                    continuing.push(this.parseStatement());
                }
                this.expect("}");
                break;
            }
            statements.push(this.parseStatement());
        }
        return {
            kind: "loop",
            statements,
            ...(continuing ? { continuing } : {}),
            ...(breakIf ? { breakIf } : {}),
        };
    }

    private parseSwitch(): ShaderStatement {
        this.expect("switch");
        const selector = this.parseExpression();
        this.expect("{");
        const clauses: ShaderSwitchClause[] = [];
        while (!this.accept("}")) {
            const selectors: ShaderSwitchClause["selectors"] = [];
            if (this.accept("default")) {
                selectors.push("default");
            } else {
                this.expect("case");
                while (this.peek().text !== ":" && this.peek().text !== "{") {
                    selectors.push(
                        this.accept("default")
                            ? "default"
                            : this.parseExpression(),
                    );
                    if (!this.accept(",")) break;
                }
            }
            this.accept(":");
            clauses.push({ selectors, statements: this.parseBlock() });
        }
        return { kind: "switch", selector, clauses };
    }

    private parseExpression(minimumPrecedence = 0): ShaderExpression {
        let expression = this.parseUnary();
        while (true) {
            const token = this.peek();
            const precedence =
                token.kind === "symbol" && token.template === undefined
                    ? binaryPrecedence[token.text]
                    : undefined;
            if (precedence === undefined || precedence < minimumPrecedence)
                break;
            this.index += 1;
            const right = this.parseExpression(precedence + 1);
            expression = {
                kind: "binary",
                operator: token.text as ShaderBinaryOperator,
                left: expression,
                right,
            };
        }
        return expression;
    }

    private parseUnary(): ShaderExpression {
        const token = this.peek();
        if (token.kind === "symbol" && unaryOperators.has(token.text)) {
            this.index += 1;
            return {
                kind: "unary",
                operator: token.text as ShaderUnaryOperator,
                operand: this.parseUnary(),
            };
        }
        let expression = this.parsePrimaryExpression();
        while (true) {
            if (this.accept(".")) {
                expression = {
                    kind: "member",
                    expression,
                    member: this.expectIdentifier(),
                };
            } else if (this.accept("[")) {
                const index = this.parseExpression();
                this.expect("]");
                expression = { kind: "index", expression, index };
            } else break;
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
        if (this.tokens[this.index + 1]?.template === "open") {
            const type = this.parseTypeParts();
            if (this.peek().text !== "(") {
                throw new Error(
                    `Unsupported WGSL template expression '${type.text}'.`,
                );
            }
            const arguments_ = this.parseArguments();
            return shaderTypes.has(type.text as ShaderType)
                ? {
                      kind: "construct",
                      type: type.text as ShaderType,
                      arguments: arguments_,
                  }
                : { kind: "call", name: type.text, arguments: arguments_ };
        }
        const name = this.expectIdentifier();
        const shorthand = shaderTypeShorthands[name];
        if (shorthand)
            return {
                kind: "construct",
                type: shorthand,
                arguments: this.parseArguments(),
            };
        if (this.peek().text === "(") {
            return {
                kind: "call",
                name,
                arguments: this.parseArguments(),
            };
        }
        const parts = [name];
        while (
            this.peek().text === "." &&
            this.tokens[this.index + 1]?.kind === "identifier"
        ) {
            this.index += 1;
            parts.push(this.expectIdentifier());
        }
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

    private acceptTemplateOpen(): boolean {
        if (this.peek().template !== "open") return false;
        this.index += 1;
        return true;
    }

    private peekTemplateOpen(): boolean {
        return this.tokens[this.index + 1]?.template === "open";
    }

    private peekTemplateClose(): boolean {
        return this.peek().template === "close";
    }

    private expectTemplateClose(): void {
        if (!this.peekTemplateClose()) {
            throw new Error(
                `Expected WGSL template list end, received '${this.peek().text}'.`,
            );
        }
        this.index += 1;
    }

    private accept(text: string): boolean {
        if (this.peek().text !== text || this.peek().template) return false;
        this.index += 1;
        return true;
    }

    private expect(text: string): void {
        const token = this.peek();
        if (token.text !== text || token.template) {
            throw new Error(
                `Expected WGSL token '${text}', received '${token.text}'.`,
            );
        }
        this.index += 1;
    }

    private expectIdentifier(): string {
        const token = this.peek();
        if (token.kind !== "identifier") {
            throw new Error(
                `Expected WGSL identifier, received '${token.text}'.`,
            );
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

function parser(source: string): WgslParser {
    return new WgslParser(source, tokenize(source));
}

/**
 * Parsed modules by text. Generation reflects the same composed variant from
 * several tables (its bindings, its attributes, its colour targets), so a
 * text is parsed once. The syntax tree is treated as immutable.
 */
const reflectedModules = new Map<string, WgslModuleSyntax>();

/** Every declaration of a WGSL module, as its own syntax states it. */
export function reflectWgslModule(source: string): WgslModuleSyntax {
    const cached = reflectedModules.get(source);
    if (cached) return cached;
    const module = parser(source).module();
    reflectedModules.set(source, module);
    return module;
}

/** A struct a module declares, by name; minified modules included. */
export function reflectWgslStruct(
    source: string,
    name: string,
): WgslStructDeclaration | undefined {
    return reflectWgslModule(source).declarations.find(
        (declaration): declaration is WgslStructDeclaration =>
            declaration.kind === "struct" && declaration.name === name,
    );
}

/** The `@group(g) @binding(b)` numbers of a resource variable. */
function wgslBindingPoint(
    declaration: WgslVariableDeclaration,
): { group: number; binding: number } | undefined {
    const number = (name: string): number | undefined => {
        const attribute = declaration.attributes.find(
            (candidate) => candidate.name === name,
        );
        const argument = attribute?.arguments[0];
        return attribute?.arguments.length === 1 && argument?.kind === "number"
            ? integerLiteral(argument.value)
            : undefined;
    };
    const group = number("group");
    const binding = number("binding");
    return group === undefined || binding === undefined
        ? undefined
        : { group, binding };
}

/** The resource variables a module binds, with their binding points. */
export function reflectWgslBindings(
    source: string,
): Array<WgslVariableDeclaration & { group: number; binding: number }> {
    return reflectWgslModule(source).declarations.flatMap((declaration) => {
        if (declaration.kind !== "var") return [];
        const point = wgslBindingPoint(declaration);
        return point ? [{ ...declaration, ...point }] : [];
    });
}

/**
 * The struct a resource binding declares its block with. A minified module
 * mangles struct names, so the binding -- which keeps the pin's own variable
 * name -- is what identifies the block.
 */
export function reflectWgslBindingStruct(
    source: string,
    binding: { group: number; binding: number; name: string },
): WgslStructDeclaration | undefined {
    const variable = reflectWgslBindings(source).find(
        (candidate) =>
            candidate.group === binding.group &&
            candidate.binding === binding.binding &&
            candidate.name === binding.name,
    );
    return variable?.type
        ? reflectWgslStruct(source, variable.type.text)
        : undefined;
}

/** The functions a module declares whose attributes name `stage`. */
export function wgslEntryPoints(
    module: WgslModuleSyntax,
    stage: ShaderStage | "compute",
): WgslFunctionDeclaration[] {
    return module.declarations.filter(
        (declaration): declaration is WgslFunctionDeclaration =>
            declaration.kind === "fn" &&
            declaration.attributes.some(({ name }) => name === stage),
    );
}

/** An attribute's lone integer argument, e.g. `@location(3)` -> 3. */
export function wgslAttributeInteger(
    attributes: readonly WgslAttribute[],
    name: string,
): number | undefined {
    const attribute = attributes.find((candidate) => candidate.name === name);
    const argument = attribute?.arguments[0];
    return attribute?.arguments.length === 1 && argument?.kind === "number"
        ? integerLiteral(argument.value)
        : undefined;
}

/** Every function body's statements, entry points and helpers alike. */
function wgslFunctionStatements(module: WgslModuleSyntax): ShaderStatement[][] {
    return module.declarations.flatMap((declaration) =>
        declaration.kind === "fn" ? [declaration.statements] : [],
    );
}

/**
 * Whether any function of a module passes `texture` to a `textureSample*`
 * builtin -- the filterable read, as opposed to a `textureLoad`.
 */
export function wgslSamplesTexture(
    module: WgslModuleSyntax,
    texture: string,
): boolean {
    return wgslFunctionStatements(module).some((statements) =>
        statements.some((statement) =>
            statementSome(statement, (expression) => {
                const first =
                    expression.kind === "call"
                        ? expression.arguments[0]
                        : undefined;
                return (
                    expression.kind === "call" &&
                    expression.name.startsWith("textureSample") &&
                    first?.kind === "path" &&
                    first.parts[0] === texture
                );
            }),
        ),
    );
}

/** Whether two member lists declare the same names, types and attributes. */
export function sameWgslMembers(
    left: readonly WgslMemberSyntax[],
    right: readonly WgslMemberSyntax[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (member, index) =>
                member.name === right[index]!.name &&
                member.type.text === right[index]!.type.text &&
                JSON.stringify(member.attributes) ===
                    JSON.stringify(right[index]!.attributes),
        )
    );
}

/** A WGSL type, parsed; `vec3f` and `vec3<f32>` read alike. */
export function parseWgslType(source: string): WgslTypeReference {
    return parser(source).type();
}

/** The members of a struct body written without its `struct Name { }`. */
export function parseWgslStructMembers(source: string): WgslMemberSyntax[] {
    return parser(source).structMembers();
}

/**
 * A struct's members laid out under the uniform rules: each member's offset
 * and the extent past the last one. Undefined when a member's layout is not
 * one the rule knows.
 */
export function wgslStructLayout(
    members: readonly WgslMemberSyntax[],
): { offsets: number[]; size: number; extent: number } | undefined {
    return fieldOffsets(members.map(({ type }) => ({ type: type.shape })));
}

/**
 * Lifts a module-scope `const NAME: f32 = <placeholder>;` into a uniform read.
 *
 * The declaration's line is removed and every reference to NAME is replaced
 * by `replacement(NAME)`, positioned by the module's own tokens, so the rest
 * of the text keeps its spelling. Undefined when no such declaration stands on
 * a line of its own.
 */
export function liftWgslModuleConstant(
    source: string,
    placeholder: string,
    replacement: (name: string) => string,
): { source: string; name: string } | undefined {
    const declaration = reflectWgslModule(source).declarations.find(
        (candidate): candidate is WgslValueDeclaration =>
            candidate.kind === "const" &&
            candidate.type?.text === "f32" &&
            candidate.value?.kind === "path" &&
            candidate.value.parts.length === 1 &&
            candidate.value.parts[0] === placeholder,
    );
    if (!declaration) return undefined;
    const lineStart = source.lastIndexOf("\n", declaration.start - 1) + 1;
    let lineEnd = declaration.end;
    while (source[lineEnd] === " " || source[lineEnd] === "\t") ++lineEnd;
    const indentation = source.slice(lineStart, declaration.start);
    if (
        [...indentation].some(
            (character) => character !== " " && character !== "\t",
        ) ||
        (lineEnd < source.length && source[lineEnd] !== "\n")
    ) {
        return undefined;
    }
    const references = lexWgsl(source).filter(
        (token) =>
            token.kind === "identifier" &&
            token.text === declaration.name &&
            (token.start < lineStart || token.start >= lineEnd),
    );
    let lifted = source.slice(0, lineStart) + source.slice(lineEnd);
    for (const reference of references.reverse()) {
        const shift = reference.start >= lineEnd ? lineEnd - lineStart : 0;
        lifted =
            lifted.slice(0, reference.start - shift) +
            replacement(declaration.name) +
            lifted.slice(reference.end - shift);
    }
    return { source: lifted, name: declaration.name };
}

// ---------------------------------------------------------------------------
// The typed shader IR: modules as transformations and the shader-material
// lowering consume them. Each reader refuses a declaration it does not model.
// ---------------------------------------------------------------------------

function shaderAttribute(attribute: WgslAttribute): ShaderAttribute {
    const [argument, ...rest] = attribute.arguments;
    if (rest.length === 0 && argument) {
        if (
            attribute.name === "builtin" &&
            argument.kind === "path" &&
            argument.parts.length === 1
        ) {
            return { kind: "builtin", value: argument.parts[0]! };
        }
        if (attribute.name === "location" && argument.kind === "number") {
            return {
                kind: "location",
                value: Number.parseInt(argument.value, 10),
            };
        }
    }
    throw new Error(`Unsupported WGSL attribute '@${attribute.name}'.`);
}

function singleShaderAttribute(
    attributes: readonly WgslAttribute[],
): ShaderAttribute | undefined {
    if (attributes.length > 1) {
        throw new Error(
            `Unsupported WGSL attribute '@${attributes[1]!.name}' beside '@${attributes[0]!.name}'.`,
        );
    }
    return attributes[0] ? shaderAttribute(attributes[0]) : undefined;
}

function shaderMember(member: WgslMemberSyntax): ShaderStructMember {
    const attribute = singleShaderAttribute(member.attributes);
    return {
        name: member.name,
        type: member.type.text,
        ...(attribute ? { attribute } : {}),
    };
}

function shaderParameter(member: WgslMemberSyntax): ShaderParameter {
    const attribute = singleShaderAttribute(member.attributes);
    return {
        name: member.name,
        type: member.type.text,
        ...(attribute ? { attribute } : {}),
    };
}

function shaderStruct(declaration: WgslStructDeclaration): ShaderStruct {
    return {
        name: declaration.name,
        members: declaration.members.map(shaderMember),
    };
}

function shaderBinding(declaration: WgslVariableDeclaration): ShaderBinding {
    const point = wgslBindingPoint(declaration);
    const unknown = declaration.attributes.find(
        ({ name }) => name !== "group" && name !== "binding",
    );
    if (!point || unknown || declaration.attributes.length !== 2) {
        throw new Error(
            unknown
                ? `Unsupported or duplicate WGSL binding attribute '${unknown.name}'.`
                : "WGSL resource needs group and binding.",
        );
    }
    const addressSpace =
        declaration.addressSpace === undefined
            ? undefined
            : declaration.addressSpace === "uniform" &&
                declaration.accessMode === undefined
              ? "uniform"
              : declaration.addressSpace === "storage" &&
                  declaration.accessMode === "read"
                ? "storage, read"
                : undefined;
    if (declaration.addressSpace !== undefined && addressSpace === undefined) {
        throw new Error(
            `Unsupported WGSL address space '${declaration.addressSpace}' for '${declaration.name}'.`,
        );
    }
    if (!declaration.type || declaration.value) {
        throw new Error(
            `WGSL resource '${declaration.name}' needs a type and no initializer.`,
        );
    }
    return {
        name: declaration.name,
        type: declaration.type.text,
        group: point.group,
        binding: point.binding,
        ...(addressSpace ? { addressSpace } : {}),
    };
}

function shaderFunction(declaration: WgslFunctionDeclaration): ShaderFunction {
    if (
        declaration.attributes.length > 0 ||
        declaration.returnAttributes.length > 0
    ) {
        throw new Error(
            `Unsupported WGSL attribute on helper function '${declaration.name}'.`,
        );
    }
    return {
        name: declaration.name,
        parameters: declaration.parameters.map(shaderParameter),
        ...(declaration.returnType
            ? { returnType: declaration.returnType.text }
            : {}),
        statements: declaration.statements,
    };
}

function shaderStageOf(
    declaration: WgslFunctionDeclaration,
): ShaderStage | "compute" | undefined {
    const stages = declaration.attributes.filter(({ name }) =>
        ["vertex", "fragment", "compute"].includes(name),
    );
    if (stages.length > 1)
        throw new Error(
            `WGSL function '${declaration.name}' names two stages.`,
        );
    return stages[0]?.name as ShaderStage | "compute" | undefined;
}

function shaderEntryPoint(
    declaration: WgslFunctionDeclaration,
    stage: ShaderStage,
): ShaderEntryPoint {
    if (declaration.attributes.length !== 1) {
        throw new Error(
            `Unsupported WGSL attribute on entry point '${declaration.name}'.`,
        );
    }
    if (!declaration.returnType) {
        throw new Error(
            `Expected one @${stage} WGSL entry point with an explicit return type.`,
        );
    }
    return {
        stage,
        name: declaration.name,
        parameters: declaration.parameters.map(shaderParameter),
        returnType: declaration.returnType.text,
        returnAttribute: singleShaderAttribute(declaration.returnAttributes),
        statements: declaration.statements,
    };
}

function describeDeclaration(declaration: WgslDeclaration): string {
    switch (declaration.kind) {
        case "fn":
            return `helper function '${declaration.name}'`;
        case "struct":
        case "var":
        case "const":
        case "override":
        case "alias":
            return `${declaration.kind} '${declaration.name}'`;
        case "enable":
        case "requires":
        case "diagnostic":
            return `${declaration.kind} directive`;
        case "assert":
            return "const_assert";
    }
}

interface ShaderModuleOptions {
    /** Accept module-scope constants and helper functions. */
    helpers?: boolean;
}

function shaderModules(
    syntax: WgslModuleSyntax,
    stages: readonly ShaderStage[],
    options: ShaderModuleOptions,
): ShaderModule[] {
    const structs: ShaderStruct[] = [];
    const bindings: ShaderBinding[] = [];
    const constants: ShaderConstant[] = [];
    const functions: ShaderFunction[] = [];
    const entryPoints: ShaderEntryPoint[] = [];
    for (const declaration of syntax.declarations) {
        switch (declaration.kind) {
            case "struct":
                structs.push(shaderStruct(declaration));
                continue;
            case "var":
                bindings.push(shaderBinding(declaration));
                continue;
            case "const":
                if (!options.helpers || !declaration.value) break;
                constants.push({
                    name: declaration.name,
                    ...(declaration.type
                        ? { type: declaration.type.text }
                        : {}),
                    value: declaration.value,
                });
                continue;
            case "fn": {
                const stage = shaderStageOf(declaration);
                if (stage === undefined) {
                    if (!options.helpers) break;
                    functions.push(shaderFunction(declaration));
                    continue;
                }
                if (stage === "compute" || !stages.includes(stage)) {
                    throw new Error(
                        `Expected ${stages.map((value) => `@${value}`).join(" or ")} WGSL entry point.`,
                    );
                }
                if (entryPoints.some((entry) => entry.stage === stage))
                    throw new Error(`Duplicate @${stage} WGSL entry point.`);
                entryPoints.push(shaderEntryPoint(declaration, stage));
                continue;
            }
            default:
                break;
        }
        throw new Error(
            `Unsupported WGSL module-scope ${describeDeclaration(declaration)}.`,
        );
    }
    return entryPoints.map((entryPoint) => ({
        structs,
        ...(bindings.length ? { bindings } : {}),
        ...(constants.length ? { constants } : {}),
        ...(functions.length ? { functions } : {}),
        entryPoint,
    }));
}

/**
 * Strict typed parsing for transformations: structs, bindings and one entry
 * point. With `helpers`, module-scope constants and helper functions too --
 * the application shader-material surface.
 */
export function parseWgslModule(
    source: string,
    stage: ShaderStage,
    options: ShaderModuleOptions = {},
): ShaderModule {
    const [module] = shaderModules(parser(source).module(), [stage], options);
    if (!module) throw new Error(`Expected @${stage} WGSL entry point.`);
    return module;
}

/** Strict parsing of a module sharing bindings across vertex and fragment entry points. */
export function parseWgslStages(source: string): ShaderModule[] {
    return shaderModules(parser(source).module(), ["vertex", "fragment"], {});
}

export function parseWgslExpression(source: string): ShaderExpression {
    return parser(source).expression();
}

export function parseWgslStatements(source: string): ShaderStatement[] {
    return parser(source).statements();
}

export function parseWgslStructDeclarations(source: string): ShaderStruct[] {
    return parser(source)
        .module()
        .declarations.map((declaration) => {
            if (declaration.kind !== "struct")
                throw new Error(
                    `Expected only WGSL struct declarations, received ${declaration.kind}.`,
                );
            return shaderStruct(declaration);
        });
}

export function parseWgslFunction(source: string): ShaderFunction {
    const declarations = parser(source).module().declarations;
    const [declaration] = declarations;
    if (
        declarations.length !== 1 ||
        declaration?.kind !== "fn" ||
        declaration.attributes.length > 0 ||
        !declaration.returnType
    ) {
        throw new Error("Expected one WGSL function with a return type.");
    }
    return {
        name: declaration.name,
        parameters: declaration.parameters.map(shaderParameter),
        returnType: declaration.returnType.text,
        statements: declaration.statements,
    };
}

export function parseWgslComputeModule(source: string): ShaderComputeModule {
    const overrides: ShaderComputeModule["overrides"] = [];
    const bindings: ShaderBinding[] = [];
    let entry: WgslFunctionDeclaration | undefined;
    for (const declaration of parser(source).module().declarations) {
        if (declaration.kind === "var") {
            bindings.push(shaderBinding(declaration));
        } else if (declaration.kind === "override") {
            const id = wgslAttributeInteger(declaration.attributes, "id");
            if (
                id === undefined ||
                declaration.attributes.length !== 1 ||
                !declaration.type ||
                !declaration.value
            ) {
                throw new Error(
                    `WGSL override '${declaration.name}' needs @id, a type and a value.`,
                );
            }
            overrides.push({
                name: declaration.name,
                type: declaration.type.text,
                id,
                value: declaration.value,
            });
        } else if (
            declaration.kind === "fn" &&
            shaderStageOf(declaration) === "compute" &&
            !entry
        ) {
            entry = declaration;
        } else {
            throw new Error(
                `Unsupported WGSL compute-module declaration '${declaration.kind}'.`,
            );
        }
    }
    const workgroupSize = entry?.attributes.find(
        ({ name }) => name === "workgroup_size",
    );
    if (
        !entry ||
        !workgroupSize ||
        entry.attributes.length !== 2 ||
        entry.returnType
    ) {
        throw new Error(
            "Expected one @compute @workgroup_size WGSL entry point.",
        );
    }
    return {
        bindings,
        overrides,
        name: entry.name,
        parameters: entry.parameters.map(shaderParameter),
        workgroupSize: workgroupSize.arguments.map((argument) => {
            const value =
                argument.kind === "number"
                    ? integerLiteral(argument.value)
                    : undefined;
            if (value === undefined)
                throw new Error(
                    "WGSL workgroup size must be integer literals.",
                );
            return value;
        }),
        statements: entry.statements,
    };
}

/** Bottom-up expression rewrite, shared by typed shader specializations. */
export function mapShaderExpression(
    expression: ShaderExpression,
    rewrite: (expression: ShaderExpression) => ShaderExpression,
): ShaderExpression {
    const map = (child: ShaderExpression): ShaderExpression =>
        mapShaderExpression(child, rewrite);
    switch (expression.kind) {
        case "binary":
            return rewrite({
                ...expression,
                left: map(expression.left),
                right: map(expression.right),
            });
        case "unary":
            return rewrite({
                ...expression,
                operand: map(expression.operand),
            });
        case "call":
        case "construct":
            return rewrite({
                ...expression,
                arguments: expression.arguments.map(map),
            });
        case "index":
            return rewrite({
                ...expression,
                expression: map(expression.expression),
                index: map(expression.index),
            });
        case "member":
            return rewrite({
                ...expression,
                expression: map(expression.expression),
            });
        case "number":
        case "path":
            return rewrite(expression);
    }
}

function mapShaderStatement(
    statement: ShaderStatement,
    rewrite: (expression: ShaderExpression) => ShaderExpression,
): ShaderStatement {
    const map = (expression: ShaderExpression): ShaderExpression =>
        mapShaderExpression(expression, rewrite);
    const mapAll = (
        statements: readonly ShaderStatement[],
    ): ShaderStatement[] => mapShaderStatements(statements, rewrite);
    switch (statement.kind) {
        case "assign":
            return {
                ...statement,
                target: map(statement.target),
                value: map(statement.value),
            };
        case "increment":
            return { ...statement, target: map(statement.target) };
        case "if":
            return {
                ...statement,
                condition: map(statement.condition),
                statements: mapAll(statement.statements),
                ...(statement.alternative
                    ? { alternative: mapAll(statement.alternative) }
                    : {}),
            };
        case "for":
            return {
                ...statement,
                ...(statement.initializer
                    ? {
                          initializer: mapShaderStatement(
                              statement.initializer,
                              rewrite,
                          ),
                      }
                    : {}),
                ...(statement.condition
                    ? { condition: map(statement.condition) }
                    : {}),
                ...(statement.update
                    ? { update: mapShaderStatement(statement.update, rewrite) }
                    : {}),
                statements: mapAll(statement.statements),
            };
        case "while":
            return {
                ...statement,
                condition: map(statement.condition),
                statements: mapAll(statement.statements),
            };
        case "loop":
            return {
                ...statement,
                statements: mapAll(statement.statements),
                ...(statement.continuing
                    ? { continuing: mapAll(statement.continuing) }
                    : {}),
                ...(statement.breakIf
                    ? { breakIf: map(statement.breakIf) }
                    : {}),
            };
        case "switch":
            return {
                ...statement,
                selector: map(statement.selector),
                clauses: statement.clauses.map((clause) => ({
                    selectors: clause.selectors.map((selector) =>
                        selector === "default" ? selector : map(selector),
                    ),
                    statements: mapAll(clause.statements),
                })),
            };
        case "block":
            return { ...statement, statements: mapAll(statement.statements) };
        case "let":
        case "const":
        case "expression":
        case "assert":
            return { ...statement, value: map(statement.value) };
        case "return":
        case "var":
            return statement.value
                ? { ...statement, value: map(statement.value) }
                : statement;
        case "discard":
        case "break":
        case "continue":
            return statement;
    }
}

export function mapShaderStatements(
    statements: readonly ShaderStatement[],
    rewrite: (expression: ShaderExpression) => ShaderExpression,
): ShaderStatement[] {
    return statements.map((statement) =>
        mapShaderStatement(statement, rewrite),
    );
}

/** The same rewrite over every expression a module states. */
export function mapShaderModule(
    module: ShaderModule,
    rewrite: (expression: ShaderExpression) => ShaderExpression,
): ShaderModule {
    return {
        ...module,
        ...(module.constants
            ? {
                  constants: module.constants.map((constant) => ({
                      ...constant,
                      value: mapShaderExpression(constant.value, rewrite),
                  })),
              }
            : {}),
        ...(module.functions
            ? {
                  functions: module.functions.map((fn) => ({
                      ...fn,
                      statements: mapShaderStatements(fn.statements, rewrite),
                  })),
              }
            : {}),
        entryPoint: {
            ...module.entryPoint,
            statements: mapShaderStatements(
                module.entryPoint.statements,
                rewrite,
            ),
        },
    };
}

/** Whether any sub-expression, the expression itself included, satisfies `test`. */
function expressionSome(
    expression: ShaderExpression,
    test: (expression: ShaderExpression) => boolean,
): boolean {
    if (test(expression)) return true;
    switch (expression.kind) {
        case "binary":
            return (
                expressionSome(expression.left, test) ||
                expressionSome(expression.right, test)
            );
        case "unary":
            return expressionSome(expression.operand, test);
        case "call":
        case "construct":
            return expression.arguments.some((argument) =>
                expressionSome(argument, test),
            );
        case "member":
            return expressionSome(expression.expression, test);
        case "index":
            return (
                expressionSome(expression.expression, test) ||
                expressionSome(expression.index, test)
            );
        case "path":
        case "number":
            return false;
    }
}

/** Every statement, nested bodies included, in source order. */
function forEachShaderStatement(
    statements: readonly ShaderStatement[],
    visit: (statement: ShaderStatement) => void,
): void {
    for (const statement of statements) {
        visit(statement);
        switch (statement.kind) {
            case "if":
                forEachShaderStatement(statement.statements, visit);
                if (statement.alternative)
                    forEachShaderStatement(statement.alternative, visit);
                break;
            case "for":
                if (statement.initializer)
                    forEachShaderStatement([statement.initializer], visit);
                if (statement.update)
                    forEachShaderStatement([statement.update], visit);
                forEachShaderStatement(statement.statements, visit);
                break;
            case "while":
            case "block":
                forEachShaderStatement(statement.statements, visit);
                break;
            case "loop":
                forEachShaderStatement(statement.statements, visit);
                if (statement.continuing)
                    forEachShaderStatement(statement.continuing, visit);
                break;
            case "switch":
                for (const clause of statement.clauses)
                    forEachShaderStatement(clause.statements, visit);
                break;
            default:
                break;
        }
    }
}

/** The expressions one statement states directly (not its nested bodies). */
function statementExpressions(statement: ShaderStatement): ShaderExpression[] {
    switch (statement.kind) {
        case "assign":
            return [statement.target, statement.value];
        case "increment":
            return [statement.target];
        case "if":
        case "while":
            return [statement.condition];
        case "for":
            return statement.condition ? [statement.condition] : [];
        case "loop":
            return statement.breakIf ? [statement.breakIf] : [];
        case "switch":
            return [
                statement.selector,
                ...statement.clauses.flatMap((clause) =>
                    clause.selectors.filter(
                        (selector): selector is ShaderExpression =>
                            selector !== "default",
                    ),
                ),
            ];
        case "let":
        case "const":
        case "expression":
        case "assert":
            return [statement.value];
        case "return":
        case "var":
            return statement.value ? [statement.value] : [];
        case "block":
        case "discard":
        case "break":
        case "continue":
            return [];
    }
}

/** Whether any expression a statement states, nested bodies included, satisfies `test`. */
export function statementSome(
    statement: ShaderStatement,
    test: (expression: ShaderExpression) => boolean,
): boolean {
    let found = false;
    forEachShaderStatement([statement], (nested) => {
        found ||= statementExpressions(nested).some((expression) =>
            expressionSome(expression, test),
        );
    });
    return found;
}

/**
 * Whether any path the expression reads satisfies `matches`.
 *
 * The two questions this answers are the same walk over the same node
 * kinds: a uniform read is `shaderSystem.x` / `shaderUniforms.x` (two
 * parts), and a sampler read is the bare `<name>` / `<name>Sampler` the
 * caller's `textureSample` names (one part).
 */
export function expressionUsesPath(
    expression: ShaderExpression,
    matches: (parts: readonly string[]) => boolean,
): boolean {
    return expressionSome(
        expression,
        (node) => node.kind === "path" && matches(node.parts),
    );
}

export function statementUsesPath(
    statement: ShaderStatement,
    matches: (parts: readonly string[]) => boolean,
): boolean {
    return statementSome(
        statement,
        (node) => node.kind === "path" && matches(node.parts),
    );
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
    {
        name: "worldView",
        enumerator: "world_view",
        type: "mat4x4<f32>",
        floatSize: 16,
    },
    { name: "view", enumerator: "view", type: "mat4x4<f32>", floatSize: 16 },
    {
        name: "projection",
        enumerator: "projection",
        type: "mat4x4<f32>",
        floatSize: 16,
    },
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

export function isShaderSystemMatrix(name: string): name is ShaderSystemMatrix {
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
export function shaderSystemMatrixEnumerator(name: ShaderSystemMatrix): string {
    return shaderSystemUniformRow(name).enumerator;
}

export function shaderSystemUniformType(name: ShaderSystemMatrix): ShaderType {
    return shaderSystemUniformRow(name).type;
}

function shaderSystemUniformFloatSize(name: ShaderSystemMatrix): number {
    return shaderSystemUniformRow(name).floatSize;
}

function parseUniformSignature(signature: string): {
    name: string;
    type: ShaderType;
} {
    if (isShaderSystemMatrix(signature)) {
        return {
            name: signature,
            type: shaderSystemUniformType(signature),
        };
    }
    const separator = signature.indexOf(":");
    if (separator < 1)
        throw new Error(`Invalid shader uniform '${signature}'.`);
    const name = signature.slice(0, separator);
    const type = signature.slice(separator + 1);
    if (!shaderTypes.has(type as ShaderType)) {
        throw new Error(`Unsupported shader uniform type '${type}'.`);
    }
    return { name, type: type as ShaderType };
}

/** Every statement list a module's functions state, entry point included. */
function moduleStatements(module: ShaderModule): ShaderStatement[][] {
    return [
        ...(module.functions ?? []).map(({ statements }) => statements),
        module.entryPoint.statements,
    ];
}

/** Whether a module's functions or constants read a path `matches` accepts. */
function moduleUsesPath(
    module: ShaderModule,
    matches: (parts: readonly string[]) => boolean,
): boolean {
    return (
        (module.constants ?? []).some(({ value }) =>
            expressionUsesPath(value, matches),
        ) ||
        moduleStatements(module).some((statements) =>
            statements.some((statement) =>
                statementUsesPath(statement, matches),
            ),
        )
    );
}

/** Whether a stage reads the uniform block member `root.member`. */
function stageReadsUniform(
    module: ShaderModule,
    root: string,
    member: string,
): boolean {
    return moduleUsesPath(
        module,
        (parts) => parts[0] === root && parts[1] === member,
    );
}

/**
 * Whether a stage samples the declared sampler `name`.
 *
 * Both halves of the pin's generated pair count: a body naming only the
 * `<name>Sampler` companion still needs the binding, and the two are
 * declared and bound together either way.
 */
function stageReadsSampler(module: ShaderModule, name: string): boolean {
    return moduleUsesPath(
        module,
        (parts) => parts[0] === name || parts[0] === `${name}Sampler`,
    );
}

function stageReadsStorageBuffer(module: ShaderModule, name: string): boolean {
    return moduleUsesPath(module, (parts) => parts[0] === name);
}

/** How many floats a custom uniform type spans; the one such table. */
export function typeComponents(type: ShaderType): number {
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

/**
 * A custom uniform's alignment, from the layout rule the capture decoder
 * reads browser buffers through -- the same rule on both sides of a
 * `scene -- diff`, so a stride fix reaches generation and diagnosis at once.
 */
function uniformTypeAlignment(type: ShaderType): number {
    const layout = layoutOf(parseWgslType(type).shape);
    if (!layout) {
        throw new Error(`Custom uniform type '${type}' has no uniform layout.`);
    }
    return layout.align;
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
    // four vec4 slots at the head of the block. Custom members then follow
    // WGSL host-shareable alignment (not merely component packing): notably,
    // a vec3 starts on a 16-byte boundary even after a scalar.
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

    let byteOffset = systemMatrices.reduce(
        (sum, name) => sum + shaderSystemUniformFloatSize(name) * 4,
        0,
    );
    const members: ShaderUniformMemberReflection[] = [];
    for (const uniform of custom) {
        const count = typeComponents(uniform.type);
        if (count > 4) {
            throw new Error(
                `Custom matrix uniform '${uniform.name}' is not supported.`,
            );
        }
        byteOffset = roundUp(uniformTypeAlignment(uniform.type), byteOffset);
        const slot = Math.floor(byteOffset / 16);
        const component = (byteOffset % 16) / 4;
        members.push({
            name: uniform.name,
            type: uniform.type,
            offset: slot * 16 + component * 4,
            size: count * 4,
            slot,
            components: componentSwizzle(component, count),
        });
        byteOffset += count * 4;
    }
    return {
        stage,
        binding: 0,
        space: stage === "vertex" ? 1 : 3,
        size: roundUp(16, byteOffset),
        systemMatrices,
        members,
    };
}

export function lowerWgslShaderProgram(
    source: ShaderMaterialProgramSource,
): ShaderIrProgram {
    const lowerModule = (text: string, stage: ShaderStage): ShaderModule => {
        const module = parseWgslModule(text, stage, { helpers: true });
        for (const structure of module.structs) {
            for (const member of structure.members) {
                if (!shaderTypes.has(member.type as ShaderType)) {
                    throw new Error(
                        `Unsupported WGSL shader type '${member.type}' in struct '${structure.name}'.`,
                    );
                }
            }
        }
        return module;
    };
    const vertex = lowerModule(source.vertexSource, "vertex");
    const fragment = lowerModule(source.fragmentSource, "fragment");
    const attributes = source.attributes.map((name) => {
        const attribute = attributeTypes[name];
        if (!attribute)
            throw new Error(`Unsupported vertex attribute '${name}'.`);
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
    const samplerDeclarations = shaderSamplerDeclarations(source);
    for (const { name } of samplerDeclarations) {
        if (stageReadsSampler(vertex, name)) {
            throw new Error(
                `Shader material sampler '${name}' is read by the vertex stage, which is not lowered.`,
            );
        }
    }
    const samplers = samplerDeclarations.map(({ name }) => name);
    const storageBuffers = (source.storageBuffers ?? []).map((buffer) => ({
        ...buffer,
        vertex: stageReadsStorageBuffer(vertex, buffer.name),
        fragment: stageReadsStorageBuffer(fragment, buffer.name),
    }));
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
            samplerDeclarations,
            storageBuffers,
        },
    };
}

// Native attribute locations follow the shared material stage's
// `VertexInput`, which both render backends bind from GpuVertex; the
// browser-composed twin assigns locations by declaration order against its
// own buffers, so only the native map has to match the native vertex table.
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
