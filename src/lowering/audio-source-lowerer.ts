import ts from "typescript";
import { sharedPinnedContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunctionParts } from "./pinned-function-lowerer.js";
import {
    absentBinding,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";

/** Source routing disposal over the admitted volume-only sound graph. */
export function lowerAudioSourceDisposal(name: string): Array<{
    prototype: string;
    lines: string[];
}> {
    const context = sharedPinnedContext();
    const node = (cpp: string): PinnedBinding => ({
        cpp,
        type: "opaque",
        absentCpp: `${cpp}.value == 0`,
        absentValue: "null",
    });
    const statement: PinnedNumericScope["statement"] = (
        source,
        numeric,
        indent,
    ) => {
        if (
            !ts.isExpressionStatement(source) ||
            !ts.isBinaryExpression(source.expression)
        )
            return undefined;
        const assignment = source.expression;
        if (
            assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            assignment.right.kind !== ts.SyntaxKind.NullKeyword
        )
            return undefined;
        const target = numeric.binding(assignment.left);
        if (target?.staticallyAbsent && target.absentValue === "null")
            return [];
        if (target?.absentValue === "null")
            return [`${indent}${target.cpp} = {};`];
        return undefined;
    };
    const volumeName = `${name}_graph`;
    const graph = lowerPinnedFunctionParts(
        context,
        "src/audio/sound-sub-graph.ts",
        "disposeSoundSubGraph",
        [
            {
                pinned: "graph",
                cpp: "source",
                kind: "record",
                annotation: "SoundSubGraph",
                cppType: "bbl::AudioSourceHandle",
            },
        ],
        {
            cppName: volumeName,
            returns: "void",
            memberBindings: new Map([
                ...["_spatial", "_stereo", "_analyzer", "_root"].map(
                    (member) =>
                        [`graph.${member}`, absentBinding("null")] as const,
                ),
                ["graph._volume", node("source->volume")],
            ]),
            calls: new Map([
                [
                    "graph._volume.disconnect",
                    () => "bbl::pal::audio_disconnect(source->volume)",
                ],
            ]),
            statement,
        },
    );
    const source = lowerPinnedFunctionParts(
        context,
        "src/audio/sound-source.ts",
        "disposeSoundSource",
        [
            {
                pinned: "source",
                cpp: "source",
                kind: "record",
                annotation: "AudioInputSource",
                cppType: "bbl::AudioSourceHandle",
            },
        ],
        {
            cppName: name,
            returns: "void",
            memberBindings: new Map([
                ["source._node", node("source->input")],
                ["source._graph", { cpp: "source", type: "opaque" }],
                ["MediaStreamAudioSourceNode", absentBinding("undefined")],
            ]),
            methods: new Map([
                [
                    "disconnect",
                    (receiver: string) =>
                        `bbl::pal::audio_disconnect(${receiver})`,
                ],
            ]),
            calls: new Map<string, (args: readonly string[]) => string>([
                [
                    "disposeSoundSubGraph",
                    (args) => `${volumeName}(${args.join(", ")})`,
                ],
                [
                    "source._engine._sounds.delete",
                    (args) =>
                        `static_cast<void>(source->engine.sources.erase(${args.join(", ")}))`,
                ],
            ]),
            statement,
        },
    );
    const engine = context.functionDeclaration(
        "src/audio/audio-engine.ts",
        "disposeAudioEngine",
    );
    // The engine's sets of disposables (`_sounds`, `_buses`), each the
    // native handle's set.
    const sets = new Map([
        ["_sounds", "engine.sources"],
        ["_buses", "engine.buses"],
    ]);
    const setOf = (node: ts.Node): string | undefined =>
        context
            .findNodes(
                node,
                (candidate): candidate is ts.PropertyAccessExpression =>
                    ts.isPropertyAccessExpression(candidate) &&
                    sets.has(candidate.name.text),
            )
            .map((access) => access.name.text)[0];
    const engineStatements = engine.declaration.body!.statements.filter(
        (statement) => setOf(statement) !== undefined,
    );
    for (const statement of engineStatements) {
        if (ts.isForOfStatement(statement))
            context.assertExpressionShape(
                statement.expression,
                `Array.from(engine.${setOf(statement.expression)})`,
                "Audio engine disposal snapshot",
            );
    }
    const engineBody = lowerPinnedBody(engine.file, engineStatements, {
        bindings: new Map(
            [...sets].map(
                ([member, cpp]) =>
                    [
                        `engine.${member}`,
                        { cpp, type: "opaque" as const },
                    ] as const,
            ),
        ),
        calls: new Map<string, (args: readonly string[]) => string>([
            [
                "Array.from",
                (args) =>
                    `bbl::js::array_from_iterable<bbl::AudioEngineSoundHandle>(${args[0]})`,
            ],
            ["sound._dispose", () => "sound->dispose()"],
            ["bus._dispose", () => "bus->dispose()"],
            ...[...sets].map(
                ([member, cpp]) =>
                    [`engine.${member}.clear`, () => `${cpp}.clear()`] as const,
            ),
        ]),
        forOf: (_iterated, element, _binding, syntax) => ({
            range: `bbl::js::array_from_iterable<bbl::AudioEngineSoundHandle>(${sets.get(setOf(syntax.expression)!)!})`,
            bindings: new Map([[element, { cpp: element, type: "opaque" }]]),
        }),
    });
    const engineDeclaration = `void ${name}_engine_sources(bbl::AudioEngineHandle engine)`;
    return [
        ...[graph, source].map((part) => ({
            prototype: `${part.declaration};`,
            lines: [
                `// ${part.provenance}`,
                `${part.declaration} {`,
                part.body,
                "}",
            ],
        })),
        {
            prototype: `${engineDeclaration};`,
            lines: [`${engineDeclaration} {`, engineBody, "}"],
        },
    ];
}
