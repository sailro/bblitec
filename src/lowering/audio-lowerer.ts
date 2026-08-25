// The audio engine's output graph: the drift gate on a fold.
//
// `src/compiler/intrinsics/audio.ts` emits the two gains the pinned
// `createAudioEngineAsync` builds -- `mainBus -> mainOut ->
// ctx.destination` -- as native calls at the reaching call site, because
// the shape is the contract and the shape is three lines long. This
// module is the other half of that bargain, and the half without which
// the fold would be a re-derivation: every rule the emitted graph
// restates is asserted here against the pinned declaration that states
// it, so an upstream change to the graph fails generation naming the
// declaration to follow, rather than compiling into a scene that sounds
// subtly wrong.
//
// It is the same shape `NavigationLowerer` gives `recastConfigDefaults`
// and `PhysicsLowerer` gives the four frame phases: emit nothing, and
// refuse the moment the thing being folded moves.
//
// The one statement the fold does NOT emit is asserted hardest.
// `createAudioEngineAsync` runs `setMainOutVolume(engine._mainOut,
// engine._volume)` between the two constructions; with no options,
// `_volume` is the `?? 1` default and the ramp is a 1-to-1 curve, so the
// emitted graph is equal to the pin's. That equality is a fact about the
// default, not about the statement -- so the default is what gets
// checked. A pin that changes it fails here.

import ts from "typescript";

import type { LoweringContext } from "./context.js";

const AUDIO_ENGINE_MODULE = "src/audio/audio-engine.ts";
const AUDIO_BUS_MODULE = "src/audio/bus.ts";

export class AudioLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * Asserts the folded engine graph against the pin. Emits nothing:
     * what it produces is the right to emit the fold at all.
     */
    public assertEngineGraphContract(): void {
        this.assertMainOut();
        this.assertMainBus();
        this.assertEngineComposition();
    }

    /**
     * `createMainOut`: a GainNode into `ctx.destination`. The emitted
     * `audio_create_gain` + `audio_connect(main_out, audio_destination)`
     * pair is exactly these two statements.
     */
    private assertMainOut(): void {
        const { declaration } = this.context.functionDeclaration(
            AUDIO_BUS_MODULE,
            "createMainOut",
        );
        this.assertStatement(
            declaration,
            "new GainNode(ctx)",
            "createMainOut's output node",
        );
        this.assertStatement(
            declaration,
            "gain.connect(ctx.destination)",
            "createMainOut's destination edge",
        );
    }

    /**
     * `createMainBus`: a second GainNode into the main out's gain, whose
     * `_in` and `_out` are that same node -- which is why a sound source
     * connects into one handle rather than a pair.
     */
    private assertMainBus(): void {
        const { declaration } = this.context.functionDeclaration(
            AUDIO_BUS_MODULE,
            "createMainBus",
        );
        this.assertStatement(
            declaration,
            "new GainNode(ctx)",
            "createMainBus's bus node",
        );
        this.assertStatement(
            declaration,
            "volume.connect(mainOut._gain)",
            "createMainBus's edge into the main out",
        );
        const returned = this.context.returnObject(declaration);
        for (const property of ["_in", "_out"] as const) {
            const initializer = this.context.propertyInitializer(
                returned,
                property,
            );
            this.context.assertExpressionShape(
                initializer,
                "volume",
                `createMainBus's ${property}`,
            );
        }
    }

    /**
     * `createAudioEngineAsync`'s own output-graph block: the two
     * constructions in order, and the master-volume default that makes
     * the third statement inert.
     */
    private assertEngineComposition(): void {
        const { declaration } = this.context.functionDeclaration(
            AUDIO_ENGINE_MODULE,
            "createAudioEngineAsync",
        );
        this.assertStatement(
            declaration,
            "engine._mainOut = createMainOut(ctx, engine)",
            "the engine's main output construction",
        );
        this.assertStatement(
            declaration,
            'engine._mainBus = createMainBus("default", ctx, engine, engine._mainOut)',
            "the engine's main bus construction",
        );

        // The statement the fold omits, and the reason it may.
        this.assertStatement(
            declaration,
            "setMainOutVolume(engine._mainOut, engine._volume)",
            "the engine's master-volume application",
        );
        const volume = this.findAssignedInitializer(declaration, "_volume");
        this.context.assertExpressionShape(
            volume,
            "options.volume ?? 1",
            "the engine's default master volume",
        );
    }

    /** Asserts the declaration contains a statement of this exact shape. */
    private assertStatement(
        declaration: ts.Node,
        expectedSource: string,
        label: string,
    ): void {
        const found = this.context.findNodes(
            declaration,
            (node): node is ts.Expression =>
                ts.isExpression(node) &&
                this.context.expressionMatchesShape(node, expectedSource),
        );
        if (found.length === 0) {
            this.context.contractError(
                declaration,
                `${label} changed: '${expectedSource}' is no longer in ` +
                    "the pinned declaration. The generated engine graph in " +
                    "src/compiler/intrinsics/audio.ts folds these statements, " +
                    "so it has to move with them.",
            );
        }
    }

    /** The initializer of an object property assigned inside a declaration. */
    private findAssignedInitializer(
        declaration: ts.Node,
        property: string,
    ): ts.Expression {
        const found = this.context.findNodes(
            declaration,
            (node): node is ts.PropertyAssignment =>
                ts.isPropertyAssignment(node) &&
                this.context.propertyName(node.name) === property,
        );
        const first = found[0];
        if (!first) {
            this.context.contractError(
                declaration,
                `The pinned audio engine no longer initializes '${property}'.`,
            );
        }
        return first.initializer;
    }
}
