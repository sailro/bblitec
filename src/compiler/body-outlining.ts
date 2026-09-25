import { cppIdentifiers } from "./cpp-identifiers.js";
import {
    nativeDeclarationFacts,
    type NativeDeclaration,
} from "./native-declarations.js";
import {
    nativeStatementCode,
    renderNativeEmission,
    type NativeEmission,
    type NativeLocal,
} from "./native-statements.js";

export const outlinedBodyMinimumBytes = 24 * 1024;
const segmentMaximumBytes = 16 * 1024;
const segmentMinimumBytes = 256;
const initializerMinimumBytes = 1024;

export interface OutlinedSegment {
    readonly name: string;
    readonly prototype: string;
    readonly lines: readonly string[];
    readonly source: string;
}

type Statement =
    | NativeEmission
    | {
          readonly kind: "compound";
          readonly clauses: readonly {
              readonly header: NativeEmission;
              readonly body: readonly Statement[];
          }[];
          readonly close: NativeEmission;
      };

/** Fold explicit scope events. An incomplete fragment keeps its original placement. */
function statements(
    events: readonly NativeEmission[],
): readonly Statement[] | undefined {
    const root: Statement[] = [];
    const stack: {
        clauses: { header: NativeEmission; body: Statement[] }[];
        parent: Statement[];
    }[] = [];
    let body = root;
    for (const event of events) {
        switch (event.statement.kind) {
            case "open": {
                const clause = { header: event, body: [] };
                stack.push({ clauses: [clause], parent: body });
                body = clause.body;
                break;
            }
            case "branch": {
                const scope = stack.at(-1);
                if (!scope) return undefined;
                const clause = { header: event, body: [] };
                scope.clauses.push(clause);
                body = clause.body;
                break;
            }
            case "close": {
                const scope = stack.pop();
                if (!scope) return undefined;
                body = scope.parent;
                body.push({
                    kind: "compound",
                    clauses: scope.clauses,
                    close: event,
                });
                break;
            }
            default:
                body.push(event);
        }
    }
    return stack.length ? undefined : root;
}

function emissions(statement: Statement): readonly NativeEmission[] {
    return "kind" in statement
        ? [
              ...statement.clauses.flatMap((clause) => [
                  clause.header,
                  ...clause.body.flatMap(emissions),
              ]),
              statement.close,
          ]
        : [statement];
}

/** Outward transfers are facts of lowered control flow, independent of C++ spelling. */
function transfers(
    statement: Statement,
    loop = false,
    breaks = false,
): boolean {
    if ("kind" in statement) {
        const header = statement.clauses[0]!.header.statement;
        const iteration = header.kind === "open" && header.iteration === true;
        return statement.clauses.some((clause) =>
            clause.body.some((child) =>
                transfers(
                    child,
                    loop || iteration,
                    breaks ||
                        iteration ||
                        (header.kind === "open" && header.breaks === true),
                ),
            ),
        );
    }
    const node = statement.statement;
    if (node.kind === "verbatim") return true;
    if (node.kind !== "control") return false;
    switch (node.transfer) {
        case "break":
            return !breaks;
        case "continue":
            return !loop;
        case "throw":
            return false;
        default:
            return true;
    }
}

type Frame = Map<string, string | undefined>;

/** Outline the statements supplied by emission; C++ text supplies only identifier reads. */
export function outlineEmittedBody(options: {
    readonly body: readonly NativeEmission[];
    readonly parameters: readonly NativeLocal[];
    readonly bindingType: (name: string) => string | undefined;
    readonly allocateName: () => string;
    readonly source: string;
    readonly callNamespace?: string;
}): {
    readonly body: readonly NativeEmission[];
    readonly segments: readonly OutlinedSegment[];
    readonly rewrittenDeclarations: readonly NativeDeclaration[];
} {
    const unchanged = {
        body: options.body,
        segments: [],
        rewrittenDeclarations: [],
    };
    if (
        options.body.reduce(
            (bytes, event) =>
                bytes + nativeStatementCode(event.statement).length,
            0,
        ) < outlinedBodyMinimumBytes
    )
        return unchanged;
    const tree = statements(options.body);
    if (!tree) return unchanged;
    const segments: OutlinedSegment[] = [];
    const rewrittenDeclarations: NativeDeclaration[] = [];
    const outline = (
        body: readonly Statement[],
        frame: Frame,
    ): NativeEmission[] => {
        const result: NativeEmission[] = [];
        let complete = true;
        let run: {
            events: readonly NativeEmission[];
            free: readonly string[];
        }[] = [];
        let bytes = 0;
        const freeLocals = (code: string): readonly string[] | undefined => {
            const names: string[] = [];
            for (const name of cppIdentifiers(code, { unqualified: true })) {
                if (!frame.has(name)) continue;
                if (frame.get(name) === undefined) return undefined;
                names.push(name);
            }
            return names;
        };
        const createSegment = (
            names: readonly string[],
            lines: readonly string[],
            source: string,
            type = "void",
            types: ReadonlyMap<string, string | undefined> = frame,
        ): string => {
            const name = options.allocateName();
            const parameters = names
                .map((name) => `[[maybe_unused]] ${types.get(name)!}& ${name}`)
                .join(", ");
            const signature = `${type} ${name}(${parameters})`;
            segments.push({
                name,
                source,
                prototype: `${signature};`,
                lines: [`${signature} {`, ...lines, "}"],
            });
            const scope = options.callNamespace ?? "bblscene";
            return `${scope ? `${scope}::` : ""}${name}(${names.join(", ")})`;
        };
        const flush = (): void => {
            if (!run.length) return;
            const events = run.flatMap((row) => row.events);
            if (bytes < segmentMinimumBytes) result.push(...events);
            else {
                const free = [...new Set(run.flatMap((row) => row.free))];
                const call = createSegment(
                    free,
                    events.map(renderNativeEmission),
                    events[0]!.source ?? options.source,
                );
                result.push({
                    indent: events[0]!.indent,
                    statement: { kind: "expression", code: `${call};` },
                });
            }
            run = [];
            bytes = 0;
        };
        for (const statement of body) {
            let events = emissions(statement);
            if (
                !("kind" in statement) &&
                statement.statement.kind === "region"
            ) {
                flush();
                const region = statement.statement;
                const types = new Map(
                    region.captures.map(({ name, type }) => [name, type]),
                );
                const names = [
                    ...cppIdentifiers(region.code, { unqualified: true }),
                ].filter((name) => types.has(name));
                if (
                    region.code.length < segmentMinimumBytes ||
                    names.some((name) => types.get(name) === undefined)
                ) {
                    result.push(statement);
                } else {
                    const call = createSegment(
                        names,
                        [renderNativeEmission(statement)],
                        statement.source ?? options.source,
                        "void",
                        types,
                    );
                    result.push({
                        indent: statement.indent,
                        statement: { kind: "expression", code: `${call};` },
                    });
                }
                continue;
            }
            if (
                !("kind" in statement) &&
                statement.statement.kind === "declaration"
            ) {
                flush();
                const declaration = statement.statement;
                const facts = nativeDeclarationFacts(declaration);
                const known =
                    facts.type ??
                    (facts.reference && frame.has(declaration.initializer)
                        ? frame.get(declaration.initializer)
                        : options.bindingType(declaration.name));
                const type =
                    known !== undefined &&
                    facts.constant &&
                    !known.startsWith("const ")
                        ? `const ${known}`
                        : known;
                const free =
                    complete &&
                    type !== undefined &&
                    !facts.reference &&
                    !facts.constantInitializer &&
                    declaration.initialization === undefined &&
                    declaration.initializer.length >= initializerMinimumBytes
                        ? freeLocals(declaration.initializer)
                        : undefined;
                if (free) {
                    const initializer = createSegment(
                        free,
                        [`    return ${declaration.initializer};`],
                        statement.source ?? options.source,
                        type!.replace(/^const /, ""),
                    );
                    const rewritten = { ...declaration, initializer };
                    rewrittenDeclarations.push(rewritten);
                    events = [
                        {
                            ...statement,
                            statement: rewritten,
                        },
                    ];
                }
                result.push(...events);
                frame.set(declaration.name, type);
                continue;
            }
            if ("kind" in statement && complete) {
                const header = statement.clauses[0]!.header.statement;
                if (
                    header.kind === "open" &&
                    !header.iteration &&
                    events.reduce(
                        (n, event) =>
                            n + nativeStatementCode(event.statement).length,
                        0,
                    ) > segmentMaximumBytes
                ) {
                    events = [
                        ...statement.clauses.flatMap((clause) => {
                            const node = clause.header.statement;
                            if (
                                (node.kind !== "open" &&
                                    node.kind !== "branch") ||
                                node.outlineInterior === false
                            )
                                return [
                                    clause.header,
                                    ...clause.body.flatMap(emissions),
                                ];
                            const nested = new Map(frame);
                            for (const local of node.locals ?? [])
                                nested.set(local.name, local.type);
                            return [
                                clause.header,
                                ...outline(clause.body, nested),
                            ];
                        }),
                        statement.close,
                    ];
                }
            }
            const movable =
                "kind" in statement ||
                statement.statement.kind === "expression";
            const text =
                complete && movable && !transfers(statement)
                    ? events.map(renderNativeEmission).join("\n")
                    : undefined;
            const free = text === undefined ? undefined : freeLocals(text);
            if (!free) {
                flush();
                result.push(...events);
                if (
                    !("kind" in statement) &&
                    statement.statement.kind === "verbatim" &&
                    statement.statement.code.trim()
                )
                    complete = false;
                continue;
            }
            if (bytes + text!.length > segmentMaximumBytes) flush();
            run.push({ events, free });
            bytes += text!.length;
        }
        flush();
        return result;
    };
    const body = outline(
        tree,
        new Map(options.parameters.map((local) => [local.name, local.type])),
    );
    return { body, segments, rewrittenDeclarations };
}
