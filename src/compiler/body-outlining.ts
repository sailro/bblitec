import { cppTokens, type CppToken } from "./cpp-identifiers.js";
import {
    cppStatementShape,
    parseCppLocalDeclaration,
    qualifiedNameEnd,
    spellCppTokens,
    splitCppStatements,
    transfersControlOut,
    unqualifiedIdentifiers,
    type CppStatement,
} from "./cpp-statements.js";

/** A local the outlined statements may read, and its native type. */
interface OutlineFrameLocal {
    readonly name: string;
    /** The object type (never a reference); undefined when it has no spelling. */
    readonly type: string | undefined;
}

/** A namespace-level function holding statements moved out of a body. */
export interface OutlinedSegment {
    readonly name: string;
    readonly prototype: string;
    readonly lines: readonly string[];
}

interface OutlinedBody {
    readonly lines: readonly string[];
    readonly segments: readonly OutlinedSegment[];
}

/**
 * Bodies below this size compile quickly enough in one function; above it,
 * their statements move to functions other translation units can hold.
 */
export const outlinedBodyMinimumBytes = 24 * 1024;
/** One outlined function holds at most this much, so each stays cheap to optimize. */
const segmentMaximumBytes = 16 * 1024;
/** A run of statements smaller than this stays where it is. */
const segmentMinimumBytes = 256;
/** An initializer smaller than this stays in its declaration. */
const initializerMinimumBytes = 1024;

/** The locals visible at a statement: every one the enclosing scopes declare. */
type Frame = Map<string, string | undefined>;

interface Outliner {
    readonly bindingType: (name: string) => string | undefined;
    readonly allocateName: () => string;
    readonly segments: OutlinedSegment[];
}

/**
 * Moves the statements of one large emitted function body into namespace-level
 * functions, so a translation unit other than the body's own can compile them.
 *
 * Only statements that introduce no name used after them move: compound and
 * expression statements, and the initializers of declarations whose type has
 * a spelling. Each outlined function takes the locals it reads by reference,
 * so every read and write reaches the same object as before, in the same
 * order; a statement that returns from the body, or that reads a local
 * without a native type, stays. Declarations stay where they are, so every
 * name keeps its scope and lifetime. A compound statement too large for one
 * function keeps its structure and outlines the statements of its blocks.
 *
 * `parameters` must name every local of the enclosing function the body can
 * read: an unqualified name outside the frame is taken as declared inside the
 * statement that names it.
 */
export function outlineFunctionBody(options: {
    lines: readonly string[];
    parameters: readonly OutlineFrameLocal[];
    bindingType: (name: string) => string | undefined;
    allocateName: () => string;
}): OutlinedBody {
    const text = options.lines.join("\n");
    if (text.length < outlinedBodyMinimumBytes)
        return { lines: options.lines, segments: [] };
    const indent = /^\s*/.exec(
        options.lines.find((line) => line.trim()) ?? "",
    )![0];
    const outliner: Outliner = {
        bindingType: options.bindingType,
        allocateName: options.allocateName,
        segments: [],
    };
    const lines = outlineBlock(
        outliner,
        text,
        new Map(options.parameters.map((local) => [local.name, local.type])),
        indent,
    );
    return outliner.segments.length > 0
        ? { lines, segments: outliner.segments }
        : { lines: options.lines, segments: [] };
}

/**
 * Outlines the body of one large emitted namespace-level function definition
 * (`R name(parameters) { ... }`), its parameters being the frame. A
 * definition of any other shape, a template among them, is returned as is.
 */
export function outlineFunctionDefinition(options: {
    lines: readonly string[];
    bindingType: (name: string) => string | undefined;
    allocateName: () => string;
}): OutlinedBody {
    const unchanged = { lines: options.lines, segments: [] };
    const text = options.lines.join("\n");
    if (text.length < outlinedBodyMinimumBytes) return unchanged;
    const tokens = [...cppTokens(text)];
    const open = tokens.findIndex((token) => token.text === "{");
    if (
        open < 0 ||
        closingIndex(tokens, open, "{") !== tokens.length - 1 ||
        tokens.some(
            (token, index) =>
                index < open &&
                token.kind === "identifier" &&
                (token.text === "template" || token.text === "decltype"),
        ) ||
        tokens[open - 1]?.text !== ")"
    )
        return unchanged;
    let parametersStart = open - 1;
    for (let depth = 0; parametersStart >= 0; parametersStart--) {
        const token = tokens[parametersStart]!.text;
        if (token === ")") depth++;
        else if (token === "(" && --depth === 0) break;
    }
    const parameters: OutlineFrameLocal[] = [];
    let first = parametersStart + 1;
    for (let index = first, depth = 0; index < open; index++) {
        const token = tokens[index]!;
        if (["(", "[", "{", "<"].includes(token.text)) depth++;
        else if ([")", "]", "}", ">"].includes(token.text) && depth > 0)
            depth--;
        if (!(depth === 0 && (token.text === "," || index === open - 1)))
            continue;
        const parameter = tokens.slice(first, index);
        first = index + 1;
        if (parameter.length === 0) continue;
        const declaration = parseCppLocalDeclaration([
            ...parameter,
            { ...parameter.at(-1)!, kind: "punctuation", text: ";" },
        ]);
        if (!declaration) return unchanged;
        parameters.push({
            name: declaration.name,
            type:
                declaration.spelledType === undefined
                    ? undefined
                    : declaration.constant
                      ? `const ${declaration.spelledType}`
                      : declaration.spelledType,
        });
    }
    const interior = text.slice(tokens[open]!.end, tokens.at(-1)!.start);
    const outliner: Outliner = {
        bindingType: options.bindingType,
        allocateName: options.allocateName,
        segments: [],
    };
    const lines = outlineBlock(
        outliner,
        interior,
        new Map(parameters.map((local) => [local.name, local.type])),
        "    ",
    );
    if (outliner.segments.length === 0) return unchanged;
    return {
        lines: [text.slice(0, tokens[open]!.end), ...lines, "}"],
        segments: outliner.segments,
    };
}

/** Outlines the statements of one block's interior; returns its new lines. */
function outlineBlock(
    outliner: Outliner,
    text: string,
    frame: Frame,
    indent: string,
): string[] {
    type Row =
        | { kind: "keep"; text: string }
        | { kind: "move"; text: string; free: readonly string[] };
    const rows: Row[] = [];
    let frameComplete = true;
    const freeLocals = (tokens: readonly CppToken[]): string[] | undefined => {
        const free = unqualifiedIdentifiers(tokens).filter((name) =>
            frame.has(name),
        );
        return free.every((name) => frame.get(name) !== undefined)
            ? free
            : undefined;
    };
    const parameterList = (names: readonly string[]): string =>
        names
            .map((name) => `[[maybe_unused]] ${frame.get(name)!}& ${name}`)
            .join(", ");
    for (const statement of splitCppStatements(text)) {
        const shape = cppStatementShape(statement.tokens);
        if (shape === "declaration") {
            const declaration = parseCppLocalDeclaration(statement.tokens);
            if (!declaration) {
                // An unread declaration may introduce a name a later
                // statement reads; nothing after it can move.
                frameComplete = false;
                rows.push({ kind: "keep", text: statement.text });
                continue;
            }
            const type = localType(
                declaration,
                outliner.bindingType,
                frame,
                statement,
            );
            const outlined =
                frameComplete && type !== undefined && !declaration.reference
                    ? outlineInitializer(
                          statement,
                          type.replace(/^const /, ""),
                          declaration.initializerIndex,
                          freeLocals,
                          parameterList,
                          outliner.allocateName,
                      )
                    : undefined;
            if (outlined) outliner.segments.push(outlined.segment);
            rows.push({ kind: "keep", text: outlined?.text ?? statement.text });
            frame.set(declaration.name, type);
            continue;
        }
        // A compound statement too large for one function first outlines
        // the statements of its blocks.
        const rewritten =
            frameComplete &&
            shape === "compound" &&
            statement.text.length > segmentMaximumBytes
                ? outlineCompoundBlocks(outliner, statement, frame)
                : statement;
        const movable =
            frameComplete &&
            (shape === "compound" || shape === "expression") &&
            !transfersControlOut(rewritten.tokens);
        const free = movable ? freeLocals(rewritten.tokens) : undefined;
        rows.push(
            free
                ? { kind: "move", text: rewritten.text, free }
                : { kind: "keep", text: rewritten.text },
        );
    }
    const lines: string[] = [];
    let run: { text: string; free: readonly string[] }[] = [];
    let runBytes = 0;
    const flush = (): void => {
        if (run.length === 0) return;
        if (runBytes < segmentMinimumBytes) {
            for (const statement of run) lines.push(indent + statement.text);
        } else {
            const names = [...new Set(run.flatMap(({ free }) => free))];
            const name = outliner.allocateName();
            const signature = `void ${name}(${parameterList(names)})`;
            outliner.segments.push({
                name,
                prototype: `${signature};`,
                lines: [
                    `${signature} {`,
                    ...run.map((statement) => `    ${statement.text}`),
                    "}",
                ],
            });
            lines.push(`${indent}bblscene::${name}(${names.join(", ")});`);
        }
        run = [];
        runBytes = 0;
    };
    for (const row of rows) {
        if (row.kind === "keep") {
            flush();
            lines.push(indent + row.text);
            continue;
        }
        if (runBytes + row.text.length > segmentMaximumBytes) flush();
        run.push(row);
        runBytes += row.text.length;
    }
    flush();
    return lines;
}

/**
 * Outlines inside the blocks of an `if`/`else` chain, a bare block, a `try`
 * body or a `do { ... } while (false)`: blocks that run at most once, whose
 * scopes see nothing the frame does not name. A loop body stays whole, so no
 * iteration pays a call it did not before; a block whose header can declare a
 * name (a condition declaration, a caught exception) keeps its statements;
 * a statement that breaks out of its block stays in it.
 */
function outlineCompoundBlocks(
    outliner: Outliner,
    statement: CppStatement,
    frame: Frame,
): CppStatement {
    const tokens = statement.tokens;
    const offset = tokens[0]!.start;
    let text = "";
    let copied = 0;
    let headerStart = 0;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (token.kind !== "punctuation") continue;
        if (token.text === "(" || token.text === "[") {
            index = closingIndex(tokens, index, token.text) ?? tokens.length;
            continue;
        }
        if (token.text !== "{") continue;
        const end = closingIndex(tokens, index, "{");
        if (end === undefined) return statement;
        if (
            runsOnceWithoutDeclaring(
                tokens.slice(headerStart, index),
                tokens.slice(end + 1),
            )
        ) {
            const interiorStart = token.end - offset;
            const interiorEnd = tokens[end]!.start - offset;
            const interior = statement.text.slice(interiorStart, interiorEnd);
            if (interior.trim()) {
                const nested = outlineBlock(
                    outliner,
                    interior,
                    new Map(frame),
                    "    ",
                );
                text +=
                    statement.text.slice(copied, interiorStart) +
                    "\n" +
                    nested.join("\n") +
                    "\n";
                copied = interiorEnd;
            }
        }
        headerStart = end + 1;
        index = end;
    }
    if (copied === 0) return statement;
    const [rewritten, ...rest] = splitCppStatements(
        text + statement.text.slice(copied),
    );
    if (!rewritten || rest.length > 0)
        throw new Error("Outlining a compound statement changed its shape.");
    return rewritten;
}

/**
 * Whether the block between `header` (`if (...)`, `else if (...)`, `else`,
 * `try`, `do`, none) and `tail` runs at most once and its header declares
 * nothing: a `do` block only when its tail is `while (false);`.
 */
function runsOnceWithoutDeclaring(
    header: readonly CppToken[],
    tail: readonly CppToken[],
): boolean {
    const head = header[0]?.text;
    if (header.length === 0) return true;
    if (header.length === 1 && (head === "try" || head === "else")) return true;
    if (header.length === 1 && head === "do")
        return (
            tail.map((token) => token.text).join(" ") === "while ( false ) ;"
        );
    const conditionStart =
        head === "if"
            ? 1
            : head === "else" && header[1]?.text === "if"
              ? 2
              : undefined;
    if (conditionStart === undefined || header[conditionStart]?.text !== "(")
        return false;
    // An init-statement or a declared condition can name something; a plain
    // condition cannot. (`if constexpr` has no `(` after its `if`.)
    const condition = header.slice(conditionStart + 1, -1);
    return (
        closingIndex(header, conditionStart, "(") === header.length - 1 &&
        !condition.some((token) => token.text === ";") &&
        cppStatementShape(condition) !== "declaration"
    );
}

/**
 * The registered type of a deduced local. The registry is keyed by name, so
 * a shared cell registered for the name elsewhere is not this local's type
 * unless its own initializer makes or copies a shared pointer; such a local
 * stays unknown and the statements reading it stay in the body.
 */
function registeredDeducedType(
    declaration: { name: string; initializerIndex?: number },
    bindingType: (name: string) => string | undefined,
    statement: CppStatement,
): string | undefined {
    const type = bindingType(declaration.name);
    if (type === undefined || !type.startsWith("std::shared_ptr<")) return type;
    const initializer =
        declaration.initializerIndex === undefined
            ? []
            : statement.tokens.slice(declaration.initializerIndex + 1);
    return initializer.some(
        (token) =>
            token.kind === "identifier" &&
            /^(?:make_gc_shared|make_shared|shared_ptr)$/.test(token.text),
    )
        ? type
        : undefined;
}

/** The object type a declared local names, when it has a spelling. */
function localType(
    declaration: {
        name: string;
        spelledType?: string;
        constant: boolean;
        reference: boolean;
        initializerIndex?: number;
    },
    bindingType: (name: string) => string | undefined,
    frame: ReadonlyMap<string, string | undefined>,
    statement: CppStatement,
): string | undefined {
    // A deduced alias of another local has that local's type, including
    // whether it is const.
    const aliased =
        declaration.spelledType === undefined &&
        declaration.reference &&
        declaration.initializerIndex !== undefined &&
        statement.tokens.length === declaration.initializerIndex + 3 &&
        statement.tokens[declaration.initializerIndex + 1]?.kind ===
            "identifier"
            ? statement.tokens[declaration.initializerIndex + 1]!.text
            : undefined;
    let type =
        declaration.spelledType ??
        (aliased !== undefined && frame.has(aliased)
            ? frame.get(aliased)
            : registeredDeducedType(declaration, bindingType, statement));
    // So does one initialized by a lambda called in place, from its
    // trailing return type.
    if (
        type === undefined &&
        !declaration.reference &&
        declaration.initializerIndex !== undefined
    )
        type = invokedLambdaReturnType(
            statement.tokens.slice(declaration.initializerIndex + 1, -1),
        );
    // A reference parameter spells `T&`: a deduced, reference, array or
    // function type outside template arguments has no such spelling.
    if (
        type === undefined ||
        /\b(?:auto|decltype)\b/.test(type) ||
        /[&[\]()]/.test(withoutTemplateArguments(type))
    )
        return undefined;
    return declaration.constant && !type.startsWith("const ")
        ? `const ${type}`
        : type;
}

/**
 * The trailing return type of `[captures](parameters) -> T { ... }()`, the
 * whole expression; undefined for any other expression.
 */
function invokedLambdaReturnType(
    tokens: readonly CppToken[],
): string | undefined {
    const introducerEnd = closingIndex(tokens, 0, "[");
    if (introducerEnd === undefined || tokens[introducerEnd + 1]?.text !== "(")
        return undefined;
    const parametersEnd = closingIndex(tokens, introducerEnd + 1, "(");
    if (parametersEnd === undefined || tokens[parametersEnd + 1]?.text !== "->")
        return undefined;
    const typeStart = parametersEnd + 2;
    const typeEnd = qualifiedNameEnd(tokens, typeStart);
    if (typeEnd === undefined || tokens[typeEnd]?.text !== "{")
        return undefined;
    const bodyEnd = closingIndex(tokens, typeEnd, "{");
    if (
        bodyEnd === undefined ||
        bodyEnd + 3 !== tokens.length ||
        tokens[bodyEnd + 1]?.text !== "(" ||
        tokens[bodyEnd + 2]?.text !== ")"
    )
        return undefined;
    return spellCppTokens(tokens.slice(typeStart, typeEnd));
}

/** The index of the bracket closing the `opener` at `index`. */
function closingIndex(
    tokens: readonly CppToken[],
    index: number,
    opener: "[" | "(" | "{",
): number | undefined {
    if (tokens[index]?.text !== opener) return undefined;
    let depth = 0;
    for (; index < tokens.length; index++) {
        const text = tokens[index]!.text;
        if (tokens[index]!.kind !== "punctuation") continue;
        if (text === "[" || text === "(" || text === "{") depth++;
        else if (
            (text === "]" || text === ")" || text === "}") &&
            --depth === 0
        )
            return index;
    }
    return undefined;
}

/** A type's spelling with every template argument list removed. */
function withoutTemplateArguments(type: string): string {
    let depth = 0;
    let outer = "";
    for (const character of type) {
        if (character === "<") depth++;
        else if (character === ">") depth--;
        else if (depth === 0) outer += character;
    }
    return outer;
}

/**
 * Moves a large copy-initializer into a function returning the declared
 * type. Copy-initializing the local from that function's result is the same
 * initialization: `return` copy-initializes the result object from the
 * expression, and the prvalue result initializes the local directly.
 */
function outlineInitializer(
    statement: CppStatement,
    type: string,
    initializerIndex: number | undefined,
    freeLocals: (tokens: readonly CppToken[]) => string[] | undefined,
    parameterList: (names: readonly string[]) => string,
    allocateName: () => string,
): { text: string; segment: OutlinedSegment } | undefined {
    if (initializerIndex === undefined) return undefined;
    const tokens = statement.tokens;
    const equals = tokens[initializerIndex]!;
    const semicolon = tokens.at(-1)!;
    const offset = tokens[0]!.start;
    const initializer = statement.text.slice(
        equals.end - offset,
        semicolon.start - offset,
    );
    if (initializer.length < initializerMinimumBytes) return undefined;
    const expression = tokens.slice(initializerIndex + 1, -1);
    if (transfersControlOut(expression)) return undefined;
    const names = freeLocals(expression);
    if (!names) return undefined;
    const name = allocateName();
    const signature = `${type} ${name}(${parameterList(names)})`;
    return {
        text: `${statement.text.slice(0, equals.end - offset)} bblscene::${name}(${names.join(", ")});`,
        segment: {
            name,
            prototype: `${signature};`,
            lines: [`${signature} {`, `    return${initializer};`, "}"],
        },
    };
}
