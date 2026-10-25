import ts from "typescript";
import { sharedPinnedContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    collectionBinding,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/**
 * `disposeAudioEngine`'s disposal of the sounds, sources and buses the engine
 * holds, from the pin's own statements over the native handle's sets.
 */
export function lowerEngineSoundsDisposal(name: string): Array<{
    prototype: string;
    lines: string[];
}> {
    const context = sharedPinnedContext();
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
            [...sets].flatMap(([member, cpp]): [string, PinnedBinding][] => [
                [`engine.${member}`, { cpp, type: "opaque" }],
                // The disposal loop walks a snapshot of the set.
                [
                    `Array.from(engine.${member})`,
                    collectionBinding(
                        `bbl::js::array_from_iterable<bbl::AudioEngineSoundHandle>(${cpp})`,
                    ),
                ],
            ]),
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
    });
    const engineDeclaration = `void ${name}(bbl::AudioEngineHandle engine)`;
    return [
        {
            prototype: `${engineDeclaration};`,
            lines: [`${engineDeclaration} {`, engineBody, "}"],
        },
    ];
}
