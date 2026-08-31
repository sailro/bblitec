import ts from "typescript";
import {
    laneComponents,
    propertyAnimationLanes,
} from "../compiler/property-animation.js";
import { LoweredSource, LoweringContext } from "./context.js";

export class AnimationLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * The `write_track_value` arms for one record, generated from the lane
     * table: the whole-lane store the pin performs through the value's own
     * `set`, and one arm per component for a lane wide enough to have them.
     */
    private propertyWriterArms(
        record: "mesh" | "camera",
        indent: string,
    ): string {
        const lines: string[] = [];
        for (const lane of propertyAnimationLanes.values()) {
            if (lane.target !== record) continue;
            const target = `${record}.${lane.field}`;
            const components = laneComponents(lane);
            const whole = components.length === 0
                ? `${target} = value[0];`
                : `${target} = ${lane.vector}{${
                      components
                          .map((_unused, index) => `value[${index}]`)
                          .join(", ")
                  }};`;
            lines.push(`case PropertyAnimationPath::${lane.native}:`);
            // A lane with no component paths takes the store directly: the
            // resolver can never name one, so a switch over them would be a
            // branch with nothing to select.
            if (components.length === 0) {
                lines.push(`    ${whole}`);
            } else {
                lines.push(
                    "    switch (component) {",
                    "        case PropertyAnimationComponent::whole_lane:",
                    `            ${whole}`,
                    "            break;",
                    ...components.flatMap((component) => [
                        `        case PropertyAnimationComponent::${component}:`,
                        `            ${target}.${component} = value[0];`,
                        "            break;",
                    ]),
                    "        default:",
                    "            throw std::runtime_error(",
                    '                "Property animation path names no such component.");',
                    "    }",
                );
            }
            if (lane.selects) {
                lines.push(`    ${record}.${lane.selects} = true;`);
            }
            lines.push("    break;");
        }
        return lines.map((line) => `${indent}${line}`).join("\n");
    }

    /**
     * The glTF animation-group operations, lowered from the pin's own
     * function bodies. Each pinned operation is a sequence of
     * `group.<field> = <literal>` writes (src/animation/animation-group.ts),
     * and each field maps onto the writer the generated loader publishes for
     * it — isPlaying to set_clip_playing, _stopped to set_clip_stopped,
     * currentTime to set_clip_time — so the emitted body IS the pin's
     * statement list, and a pin that grows an operation a new write refuses
     * generation instead of keeping a stale transcription. goToFrame keeps
     * the pin's frame-rate conversion and applies exactly the selected clip's
     * pose through the owning asset runtime.
     */
    public lowerGroupOperations(
        options: {
            /** The scene reached `setAnimationAdditive`. */
            additive?: boolean;
            /** The scene writes `group.currentTime` directly. */
            groupTime?: boolean;
            /** The scene writes `group.speedRatio` directly. */
            groupSpeed?: boolean;
            /** The scene assigns `group.mask`. */
            groupMask?: boolean;
        } = {},
    ): LoweredSource {
        const {
            additive = false,
            groupTime = false,
            groupSpeed = false,
            groupMask = false,
        } = options;
        const groupModule = "src/animation/animation-group.ts";
        const writers: Record<string, (value: string) => string> = {
            isPlaying: (value) =>
                `    if (asset.set_clip_playing) {
` +
                `        asset.set_clip_playing(record.clip, ${value});
` +
                `    }`,
            _stopped: (value) =>
                `    if (asset.set_clip_stopped) {
` +
                `        asset.set_clip_stopped(record.clip, ${value});
` +
                `    }`,
            currentTime: (value) =>
                `    if (asset.set_clip_time) {
` +
                `        asset.set_clip_time(record.clip, ${value}f);
` +
                `    }`,
        };
        const operation = (pinnedName: string, nativeName: string): string => {
            const { file, declaration } = this.context.functionDeclaration(
                groupModule,
                pinnedName,
            );
            if (!declaration.body) {
                this.context.contractError(
                    declaration,
                    `Expected ${pinnedName} to have a body.`,
                );
            }
            const writes: string[] = [];
            for (const statement of declaration.body.statements) {
                if (
                    !ts.isExpressionStatement(statement) ||
                    !ts.isBinaryExpression(statement.expression) ||
                    statement.expression.operatorToken.kind !==
                        ts.SyntaxKind.EqualsToken ||
                    !ts.isPropertyAccessExpression(
                        statement.expression.left,
                    )
                ) {
                    this.context.contractError(
                        statement,
                        `Expected ${pinnedName} to be a sequence of group field writes.`,
                    );
                }
                const field = statement.expression.left.name.text;
                const writer = writers[field];
                if (!writer) {
                    this.context.contractError(
                        statement,
                        `${pinnedName} writes '${field}', which has no native clip writer.`,
                    );
                }
                const right = statement.expression.right;
                const value =
                    right.kind === ts.SyntaxKind.TrueKeyword
                        ? "true"
                        : right.kind === ts.SyntaxKind.FalseKeyword
                          ? "false"
                          : ts.isNumericLiteral(right)
                            ? this.context.doubleLiteral(
                                  this.context.numericValue(right, file),
                              )
                            : undefined;
                if (value === undefined) {
                    this.context.contractError(
                        right,
                        `Expected a literal in ${pinnedName}.`,
                    );
                }
                writes.push(writer(value));
            }
            return (
                `void ${nativeName}(Engine& engine, AnimationGroupHandle group) {
` +
                `    const AnimationGroupRecord& record =
` +
                `        group_record(engine, group);
` +
                `    AssetRecord& asset = group_asset(engine, record);
` +
                writes.join("\n") +
                `
}`
            );
        };
        // The pin has no setter for loopAnimation -- it is a public field
        // on the group -- so the emitted writer is the field write, taking
        // the same route to the clip the operations above take. Its
        // default and the weight's are the group factory's own literals,
        // and the generated records carry those values, so both are read
        // from the pin rather than restated.
        const { file: groupFile, declaration: createGroups } =
            this.context.functionDeclaration(
                groupModule,
                "createAnimationGroups",
            );
        const groupLiteral = this.context.findNodes(
            createGroups,
            (node): node is ts.ObjectLiteralExpression =>
                ts.isObjectLiteralExpression(node) &&
                node.properties.some(
                    (property) =>
                        ts.isPropertyAssignment(property) &&
                        this.context.propertyName(
                            property.name,
                        ) === "loopAnimation",
                ),
        )[0];
        if (!groupLiteral) {
            this.context.contractError(
                createGroups,
                "Expected the glTF group literal.",
            );
        }
        const groupDefault = (name: string): string => {
            const initializer =
                this.context.propertyInitializer(
                    groupLiteral,
                    name,
                );
            if (
                initializer.kind === ts.SyntaxKind.TrueKeyword
            ) {
                return "true";
            }
            if (ts.isNumericLiteral(initializer)) {
                return this.context.doubleLiteral(
                    this.context.numericValue(
                        initializer,
                        groupFile,
                    ),
                );
            }
            return this.context.contractError(
                initializer,
                `Expected a literal default for '${name}'.`,
            );
        };
        // The generated clip record and the engine's group record carry
        // these defaults as their own initializers, so what is checked
        // here is that the pin still agrees with them.
        for (const [name, expected] of [
            ["loopAnimation", "true"],
            ["weight", "1.0"],
            ["speedRatio", "1.0"],
        ] as const) {
            const actual = groupDefault(name);
            if (actual !== expected) {
                this.context.contractError(
                    groupLiteral,
                    `A glTF animation group now starts with ${name} ` +
                        `${actual}; the native clip and group records ` +
                        `default it to ${expected}.`,
                );
            }
        }
        const { declaration: goToFrame } =
            this.context.functionDeclaration(
                groupModule,
                "goToFrame",
            );
        const seekAssignments = this.context
            .findNodes(
                goToFrame,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken,
            )
            .filter(
                (expression) =>
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "group.currentTime" &&
                    this.context.expressionMatchesShape(
                        expression.right,
                        "frame / (group.frameRate || DEFAULT_FRAME_RATE)",
                    ),
            );
        if (seekAssignments.length !== 1) {
            this.context.contractError(
                goToFrame,
                "Expected one glTF frame-to-time seek conversion.",
            );
        }
        this.context.assertExpressionShape(
            seekAssignments[0]!.right,
            "frame / (group.frameRate || DEFAULT_FRAME_RATE)",
            "glTF animation seek conversion",
        );
        const seekGuards = this.context.findNodes(
            goToFrame,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node),
        );
        if (seekGuards.length !== 2) {
            this.context.contractError(
                goToFrame,
                "Expected the controller and stopped-group goToFrame guards.",
            );
        }
        this.context.assertExpressionShape(
            seekGuards[1]!.expression,
            "engine || !group._stopped || !group._gltfMixer",
            "glTF stopped-group seek guard",
        );
        const defaultFrameRateDeclaration =
            this.context.findNodes(
                groupFile,
                (node): node is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === "DEFAULT_FRAME_RATE",
            )[0];
        if (!defaultFrameRateDeclaration?.initializer) {
            this.context.contractError(
                goToFrame,
                "Expected DEFAULT_FRAME_RATE for glTF seeking.",
            );
        }
        const defaultFrameRate = this.context.numericValue(
            defaultFrameRateDeclaration.initializer,
            groupFile,
        );
        const loopWriter =
            `void set_animation_loop(
    Engine& engine,
    AnimationGroupHandle group,
    bool loop) {
    const AnimationGroupRecord& record =
        group_record(engine, group);
    AssetRecord& asset = group_asset(engine, record);
    if (asset.set_clip_loop) {
        asset.set_clip_loop(record.clip, loop);
    }
}`;
        const seekWriter =
            `void go_to_frame(
    Engine& engine,
    AnimationGroupHandle group,
    float frame,
    bool with_engine) {
    const AnimationGroupRecord& record =
        group_record(engine, group);
    AssetRecord& asset = group_asset(engine, record);
    if (asset.set_clip_time) {
        asset.set_clip_time(
            record.clip,
            frame / ${this.context.floatLiteral(defaultFrameRate)});
    }
    if (asset.set_clip_playing) {
        asset.set_clip_playing(record.clip, false);
    }
    if (asset.apply_clip_pose) {
        asset.apply_clip_pose(record.clip, with_engine);
    }
}`;
        // `group.currentTime` is a public mutable field upstream, so the
        // direct write is the whole operation — the same writer route the
        // operations above and `loopAnimation` take. Whoever drives the
        // group applies the pose on its next tick, exactly as upstream.
        const timeWriter =
            `void set_animation_current_time(
    Engine& engine,
    AnimationGroupHandle group,
    float time) {
    const AnimationGroupRecord& record =
        group_record(engine, group);
    AssetRecord& asset = group_asset(engine, record);
    if (asset.set_clip_time) {
        asset.set_clip_time(record.clip, time);
    }
}`;
        // `syncControllerFromGroup` is the whole of what a speed ratio
        // does upstream: it pushes the group's field onto the controller,
        // whose tick advances `time += (deltaMs / 1000) * speedRatio`. The
        // generated clip advance scales its own delta by the stored ratio,
        // so what has to hold is that the pin still routes the field that
        // way -- asserted, because there is no arithmetic here to lower.
        if (groupSpeed) {
            const { declaration: sync } =
                this.context.functionDeclaration(
                    groupModule,
                    "syncControllerFromGroup",
                );
            const speedAssignments = this.context
                .findNodes(
                    sync,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken,
                )
                .filter(
                    (expression) =>
                        this.context
                            .propertyPath(expression.left)
                            ?.join(".") === "ctrl.speedRatio",
                );
            if (speedAssignments.length !== 1) {
                this.context.contractError(
                    sync,
                    "Expected one controller speed-ratio sync.",
                );
            }
            this.context.assertExpressionShape(
                speedAssignments[0]!.right,
                "group.speedRatio",
                "glTF group speed ratio",
            );
        }
        const speedWriter =
            `void set_animation_speed_ratio(
    Engine& engine,
    AnimationGroupHandle group,
    float speed_ratio) {
    const AnimationGroupRecord& record =
        group_record(engine, group);
    AssetRecord& asset = group_asset(engine, record);
    if (asset.set_clip_speed_ratio) {
        asset.set_clip_speed_ratio(record.clip, speed_ratio);
    }
}`;
        const operations = [
            operation("playAnimation", "play_animation"),
            operation("pauseAnimation", "pause_animation"),
            operation("stopAnimation", "stop_animation"),
            loopWriter,
            seekWriter,
            ...(groupTime ? [timeWriter] : []),
            ...(groupSpeed ? [speedWriter] : []),
            ...(groupMask ? [this.lowerSetAnimationMask()] : []),
            ...(additive
                ? [
                      this.lowerSetAnimationAdditive(
                          defaultFrameRate,
                      ),
                  ]
                : []),
        ].join("\n\n");
        return {
            modulePath: groupModule,
            symbolName:
                "playAnimation,pauseAnimation,stopAnimation,loopAnimation,goToFrame",
            header: "",
            source: `// ${this.context.provenance(
                groupModule,
                "playAnimation,pauseAnimation,stopAnimation,goToFrame",
            )}
#include <bblite/runtime.hpp>
${additive ? "\n#include <cmath>" : ""}
#include <stdexcept>

namespace bbl {
namespace {

const AnimationGroupRecord& group_record(
    Engine& engine,
    AnimationGroupHandle group) {
    if (group.value >= engine.animation_groups.size()) {
        throw std::runtime_error("Invalid animation group handle.");
    }
    return engine.animation_groups[group.value];
}

AssetRecord& group_asset(
    Engine& engine,
    const AnimationGroupRecord& record) {
    if (record.asset >= engine.assets.size()) {
        throw std::runtime_error("Invalid asset handle.");
    }
    return engine.assets[record.asset];
}

}  // namespace

${operations}

} // namespace bbl
`,
        };
    }

    /**
     * `setAnimationAdditive` (src/animation/weighted-gltf-mixer.ts),
     * lowered against its own body: the reference-time resolution, the
     * finite/non-negative guard, the `group._additive` store, and the
     * owner enable.
     *
     * The entry compiler resolves the OPTIONS at generation — the
     * mutual exclusion and the sign/finiteness refuse there exactly
     * where the pin throws — so what reaches this function is the
     * reference already selected: a time, or a frame the emitted
     * conversion divides by the pinned frame rate. That rate is anchored
     * twice: the setter's own `|| 60` arm must state the same number as
     * `DEFAULT_FRAME_RATE`, and the pinned glTF animation parse must
     * still build clips without a `frameRate` of their own — which is
     * what makes the group's rate the default for every glTF group, and
     * the emitted divisor exact rather than assumed.
     *
     * The additive mark itself takes the same writer route as every
     * other group field (`asset.set_clip_additive`), and the owner
     * enable is `getAnimationGroupOwner` + `enableAnimationBlending` as
     * the pin composes them: the manager `addAnimationGroups` attached,
     * when there is one, gains the glTF mixer as its category handler.
     */
    private lowerSetAnimationAdditive(
        defaultFrameRate: number,
    ): string {
        const mixerModule =
            "src/animation/weighted-gltf-mixer.ts";
        const { file, declaration: setAdditive } =
            this.context.functionDeclaration(
                mixerModule,
                "setAnimationAdditive",
            );
        // The pin refuses the option pair; the entry compiler refuses the
        // same pair at generation, so the throw is asserted rather than
        // emitted.
        this.expectOneShape(
            setAdditive,
            "options?.referenceFrame !== undefined && options.referenceTime !== undefined",
            "additive option exclusion",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                setAdditive,
                "referenceTime",
            ),
            "options?.referenceTime ?? (options?.referenceFrame ?? 0) / (group.frameRate || 60)",
            "Additive reference-time resolution",
        );
        this.expectOneShape(
            setAdditive,
            "!Number.isFinite(referenceTime) || referenceTime < 0",
            "additive reference guard",
        );
        // The store the writer mirrors: `group._additive = { referenceTime }`.
        const stores = this.context
            .findNodes(
                setAdditive,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    this.context
                        .propertyPath(node.left)
                        ?.join(".") === "group._additive",
            );
        if (stores.length !== 1) {
            this.context.contractError(
                setAdditive,
                "Expected the additive store on the group.",
            );
        }
        for (const owner of [
            "getAnimationGroupOwner",
            "enableAnimationBlending",
        ]) {
            if (!this.context.hasCall(setAdditive, owner)) {
                this.context.contractError(
                    setAdditive,
                    `Expected setAnimationAdditive to reach ${owner}.`,
                );
            }
        }
        // The setter's own fallback rate, which must agree with the
        // group factory's DEFAULT_FRAME_RATE for the emitted divisor to
        // stand for both.
        const divisions = this.context
            .findNodes(
                setAdditive,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.SlashToken &&
                    ts.isBinaryExpression(
                        this.context.unwrapExpression(
                            node.right,
                        ),
                    ),
            );
        if (divisions.length !== 1) {
            this.context.contractError(
                setAdditive,
                "Expected the additive frame-to-time conversion.",
            );
        }
        const fallback = this.context.unwrapExpression(
            divisions[0]!.right,
        ) as ts.BinaryExpression;
        const setterRate = this.context.numericValue(
            fallback.right,
            file,
        );
        if (setterRate !== defaultFrameRate) {
            this.context.contractError(
                fallback.right,
                `setAnimationAdditive falls back to ${setterRate} fps where the group factory defaults to ${defaultFrameRate}; the emitted conversion cannot stand for both.`,
            );
        }
        // A glTF clip carries no frameRate of its own, so the group's
        // rate IS the default and the emitted divisor is exact.
        const animationFile = this.context.sourceFile(
            "src/loader-gltf/gltf-animation.ts",
        );
        const clipPushes = this.context.findNodes(
            animationFile,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                node.expression.name.text === "push" &&
                ts.isIdentifier(
                    node.expression.expression,
                ) &&
                node.expression.expression.text === "clips" &&
                node.arguments.length === 1 &&
                ts.isObjectLiteralExpression(
                    this.context.unwrapExpression(
                        node.arguments[0]!,
                    ),
                ),
        );
        if (clipPushes.length !== 1) {
            this.context.contractError(
                animationFile,
                "Expected the one glTF clip construction.",
            );
        }
        const clipLiteral = this.context.unwrapExpression(
            clipPushes[0]!.arguments[0]!,
        ) as ts.ObjectLiteralExpression;
        const carriesFrameRate = clipLiteral.properties.some(
            (property) =>
                (ts.isPropertyAssignment(property) ||
                    ts.isShorthandPropertyAssignment(
                        property,
                    )) &&
                this.context.propertyName(property.name) ===
                    "frameRate",
        );
        if (carriesFrameRate) {
            this.context.contractError(
                clipLiteral,
                "glTF clips now carry their own frameRate; the additive frame conversion must read it instead of the default.",
            );
        }
        return (
            `/**
 * ${this.context.provenance(
     mixerModule,
     "setAnimationAdditive",
 )}
 */
void set_animation_additive(
    Engine& engine,
    AnimationGroupHandle group,
    float reference_time) {
    // The pinned guard; the entry compiler has already refused a
    // non-static or negative reference, so this is the runtime mirror.
    if (
        !std::isfinite(reference_time) ||
        reference_time < 0.0f) {
        throw std::runtime_error(
            "Additive animation reference time must be a finite "
            "non-negative number.");
    }
    const AnimationGroupRecord& record =
        group_record(engine, group);
    AssetRecord& asset = group_asset(engine, record);
    if (asset.set_clip_additive) {
        asset.set_clip_additive(record.clip, reference_time);
    }
    // getAnimationGroupOwner + enableAnimationBlending: the manager
    // addAnimationGroups attached, when there is one, gains the glTF
    // mixer as its category handler. setAnimationTaskCategoryHandler
    // keeps ONE handler per manager, so this replaces rather than
    // composes.
    for (
        const PropertyAnimationManager& manager :
        engine.animation_managers) {
        if (!manager) continue;
        bool owns = false;
        for (
            const AnimationGroupHandle attached :
            manager->gltf_groups) {
            if (attached.value == group.value) {
                owns = true;
                break;
            }
        }
        if (!owns) continue;
        manager->category_handler =
            AnimationCategoryHandler::gltf_mixer;
        break;
    }
}

void set_animation_additive_from_frame(
    Engine& engine,
    AnimationGroupHandle group,
    float reference_frame) {
    // (options?.referenceFrame ?? 0) / (group.frameRate || 60): a glTF
    // clip carries no frame rate, so the divisor is the pinned default.
    set_animation_additive(
        engine,
        group,
        reference_frame / ${this.context.floatLiteral(defaultFrameRate)});
}`
        );
    }

    /**
     * `group.mask = createAnimationGroupMask(names, mode)`: the names the
     * factory copied, resolved against the asset's own node names.
     *
     * The membership rule is the pin's own
     * `animationGroupMaskRetainsTarget` -- a listed name is retained in
     * Include mode and dropped in Exclude mode, and a disabled mask retains
     * everything -- asserted here rather than restated loosely, because it is
     * the one place the two modes are told apart. What the runtime stores is
     * the pin's own `resolveAnimationMask` output: a skip flag per node, so
     * the controller's per-channel test is one lookup. `disabled` is folded
     * to its factory default of false, which no reached scene writes -- so the
     * disabled arm is asserted to return exactly that default's answer.
     */
    private lowerSetAnimationMask(): string {
        const maskModule = "src/animation/animation-group-mask.ts";
        const { file, declaration: retains } =
            this.context.functionDeclaration(
                maskModule,
                "animationGroupMaskRetainsTarget",
            );
        const returns = this.context.findNodes(
            retains,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node),
        );
        if (returns.length !== 2 || !returns[1]?.expression) {
            this.context.contractError(
                retains,
                "Expected the disabled guard and the membership return.",
            );
        }
        // A disabled mask retains every name, which is what makes folding
        // `disabled` to false safe: the folded-away arm is a no-op.
        if (
            returns[0]?.expression?.kind !== ts.SyntaxKind.TrueKeyword
        ) {
            this.context.contractError(
                returns[0] ?? retains,
                "Expected a disabled mask to retain every target.",
            );
        }
        this.context.assertExpressionShape(
            returns[1]!.expression!,
            "(mask.names.indexOf(name) !== -1) === " +
                "(mask.mode === AnimationGroupMaskMode.Include)",
            "animation group mask membership",
        );
        // The enum's two members, from its own declaration: Include is what
        // the membership test compares against, and a third member would
        // make the boolean this port carries insufficient.
        const modes = this.context.findNodes(
            file,
            (node): node is ts.EnumDeclaration =>
                ts.isEnumDeclaration(node) &&
                node.name.text === "AnimationGroupMaskMode",
        )[0];
        const members = modes
            ? modes.members.map((member) =>
                  this.context.propertyName(member.name),
              )
            : [];
        if (
            members.length !== 2 ||
            members[0] !== "Include" ||
            members[1] !== "Exclude"
        ) {
            this.context.contractError(
                modes ?? retains,
                "Expected AnimationGroupMaskMode to declare Include and " +
                    "Exclude alone.",
            );
        }
        return `void set_animation_mask(
    Engine& engine,
    AnimationGroupHandle group,
    const std::vector<std::string>& names,
    bool include) {
    const AnimationGroupRecord& record =
        group_record(engine, group);
    AssetRecord& asset = group_asset(engine, record);
    if (asset.set_clip_mask) {
        asset.set_clip_mask(record.clip, names, include);
    }
}`;
    }

    /**
     * Exactly one expression under `declaration` has this shape.
     *
     * The fingerprint a shape comparison uses carries the operator, so
     * naming the shape is the whole predicate — and the count is the
     * contract: a pinned body that grows a second copy of a rule, or
     * loses the one it had, fails generation here.
     */
    private expectOneShape(
        declaration: ts.Node,
        expected: string,
        label: string,
    ): void {
        const matches = this.context
            .findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter((expression) =>
                this.context.expressionMatchesShape(
                    expression,
                    expected,
                ),
            );
        if (matches.length !== 1) {
            this.context.contractError(
                declaration,
                `Expected one ${label}.`,
            );
        }
    }

    /**
     * The pin's optional weighted property mixer
     * (src/animation/weighted-pointer-mixer.ts), reached only through
     * `enablePropertyAnimationBlending`. Without it two groups writing one
     * property devolve into last-write-wins, which is exactly what the
     * mixer exists to stop: it buckets the tracks by the (target,
     * property) pair each binding resolved, samples every contributing
     * group at its own time, and writes one weighted sum per bucket.
     *
     * Everything load-bearing is asserted against the pinned bodies here:
     * which groups make a bucket contested, the early-out that hands the
     * tick back to the ordinary per-group path, the weighted-sum term, the
     * quaternion hemisphere rule and its final normalize, and the mixer's
     * own time advance — which is a second copy of the playback
     * arithmetic upstream, forking from the controller's on the loop
     * branch, so it is asserted separately rather than assumed identical.
     */
    private lowerWeightedPointerMixer(msPerSecond: number): string {
        const mixerModule =
            "src/animation/weighted-pointer-mixer.ts";
        const weightModule = "src/animation/animation-weight.ts";
        const { declaration: setWeight } =
            this.context.functionDeclaration(
                weightModule,
                "setAnimationWeight",
            );
        this.context.assertExpressionShape(
            this.context.findNodes(
                setWeight,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.BarBarToken &&
                    ts.isBinaryExpression(node.right),
            )[0] ??
                this.context.contractError(
                    setWeight,
                    "Expected the animation weight range guard.",
                ),
            "!Number.isFinite(weight) || weight < 0 || weight > 1",
            "Animation weight range guard",
        );
        const weightWrites = this.context
            .findNodes(
                setWeight,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken,
            )
            .filter(
                (expression) =>
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "group.weight",
            );
        if (weightWrites.length !== 1) {
            this.context.contractError(
                setWeight,
                "Expected setAnimationWeight to write the group weight.",
            );
        }
        // The opt-in itself: registering the category handler is what
        // makes the manager blend instead of ticking each group, so the
        // native flag stands for that registration.
        const { declaration: enableBlending } =
            this.context.functionDeclaration(
                mixerModule,
                "enablePropertyAnimationBlending",
            );
        this.context.assertExpressionShape(
            this.context.callExpression(
                enableBlending,
                "setAnimationTaskCategoryHandler",
            ),
            "setAnimationTaskCategoryHandler(manager, ANIMATION_GROUP_TASK_CATEGORY, updateWeightedPointerAnimations)",
            "Property animation blending opt-in",
        );
        const { declaration: mixer } =
            this.context.functionDeclaration(
                mixerModule,
                "updateWeightedPointerAnimations",
            );
        // A group at full weight never marks a bucket contested, so a
        // scene that enables blending without weighting anything keeps
        // the ordinary per-group writes.
        this.expectOneShape(
            mixer,
            "group._stopped || group.weight === 1 || !mixer",
            "contested-bucket skip",
        );
        this.expectOneShape(
            mixer,
            "contestedCount === 0",
            "uncontested early-out",
        );
        this.expectOneShape(mixer, "weight === 0", "zero-weight skip");
        this.expectOneShape(
            mixer,
            "bucket.quaternion && bucket.arity === 4",
            "blended quaternion normalize guard",
        );
        const { declaration: accumulate } =
            this.context.functionDeclaration(
                mixerModule,
                "accumulateWeightedTrack",
            );
        this.context.assertExpressionShape(
            this.context
                .findNodes(
                    accumulate,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken,
                )
                .filter((expression) =>
                    ts.isElementAccessExpression(
                        expression.left,
                    ),
                )[0] ??
                this.context.contractError(
                    accumulate,
                    "Expected the weighted accumulation write.",
                ),
            "bucket.values[i] = bucket.values[i] + sample[i] * weight * sign",
            "Weighted animation accumulation",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                accumulate,
                "sign",
            ),
            "1",
            "Weighted animation default sign",
        );
        this.context.assertExpressionShape(
            this.context
                .findNodes(
                    accumulate,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isIdentifier(node.left) &&
                        node.left.text === "sign",
                )[0] ??
                this.context.contractError(
                    accumulate,
                    "Expected the quaternion hemisphere sign rule.",
                ),
            "sign = dot < 0 ? -1 : 1",
            "Weighted animation hemisphere sign",
        );
        const { declaration: normalize } =
            this.context.functionDeclaration(
                mixerModule,
                "normalizeQuaternion",
            );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                normalize,
                "lenSq",
            ),
            "x * x + y * y + z * z + w * w",
            "Blended quaternion length",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(normalize, "inv"),
            "1 / Math.sqrt(lenSq)",
            "Blended quaternion normalize",
        );
        // The mixer's own advance. It forks from the controller's tick on
        // the loop branch — that one wraps only while playing, this one
        // wraps whenever the group loops — so both are pinned rather than
        // one being derived from the other.
        const { declaration: advance } =
            this.context.functionDeclaration(
                mixerModule,
                "advancePropertyGroupTime",
            );
        this.context.assertExpressionShape(
            this.context
                .findNodes(
                    advance,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.PlusEqualsToken &&
                        this.context
                            .propertyPath(node.left)
                            ?.join(".") ===
                            "group.currentTime" &&
                        ts.isBinaryExpression(
                            this.context.unwrapExpression(
                                node.right,
                            ),
                        ),
                )[0]?.right ??
                this.context.contractError(
                    advance,
                    "Expected the mixer playback advance.",
                ),
            `(deltaMs / ${msPerSecond}) * group.speedRatio`,
            "Mixer playback advance",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                advance,
                "fromTime",
            ),
            "Math.max(0, Math.min(mixer[MIX_FROM], mixer[MIX_DURATION]))",
            "Mixer play-range start",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(advance, "toTime"),
            "mixer[MIX_TO] > fromTime ? Math.min(mixer[MIX_TO], mixer[MIX_DURATION]) : mixer[MIX_DURATION]",
            "Mixer play-range end",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                advance,
                "duration",
            ),
            "Math.max(0, toTime - fromTime)",
            "Mixer play-range duration",
        );
        this.expectOneShape(
            advance,
            "group.currentTime = fromTime + ((group.currentTime - fromTime) % duration)",
            "mixer loop wrap",
        );
        this.expectOneShape(
            advance,
            "group.currentTime += duration",
            "mixer wrap correction",
        );
        this.expectOneShape(
            advance,
            "group.currentTime = Math.min(Math.max(group.currentTime, fromTime), toTime)",
            "mixer play-range clamp",
        );
        return `
/**
 * ${this.context.provenance(
     mixerModule,
     "updateWeightedPointerAnimations",
 )}
 *
 * The bucket key is the pin's (target object, property name) pair: a
 * lowered track resolves that pair from its target, its lane and the
 * component of it the path named -- "position" resolves to the mesh and
 * the name "position", while "position.x" resolves to the position vector
 * and the name "x" --
 * so the triple names the same bucket the pin's binding would. The pin
 * also carries the track's writer and rotation flag onto the bucket it
 * finds; the writer is the same generated one here, and the flag follows
 * from the same triple.
 */
PropertyAnimationBucket& track_bucket(
    std::vector<PropertyAnimationBucket>& buckets,
    PropertyAnimationTarget target,
    const PropertyAnimationTrack& track) {
    for (PropertyAnimationBucket& candidate : buckets) {
        if (
            candidate.target.kind == target.kind &&
            candidate.target.index == target.index &&
            candidate.property == track.path &&
            candidate.component == track.component) {
            return candidate;
        }
    }
    PropertyAnimationBucket bucket;
    bucket.target = target;
    bucket.property = track.path;
    bucket.component = track.component;
    bucket.quaternion = track.quaternion;
    buckets.push_back(bucket);
    return buckets.back();
}

// The sum runs in double and rounds once at the float store, which is
// where the pinned Float32Array bucket rounds it.
void accumulate_weighted_track(
    PropertyAnimationBucket& bucket,
    const std::array<float, 4>& sample,
    float weight) {
    bucket.active = true;
    double sign = 1.0;
    const std::size_t arity =
        track_stride(bucket.property, bucket.component);
    if (bucket.quaternion && arity == 4) {
        if (!bucket.has_reference) {
            bucket.reference = sample;
            bucket.has_reference = true;
        } else {
            const double dot =
                static_cast<double>(bucket.reference[0]) * sample[0] +
                static_cast<double>(bucket.reference[1]) * sample[1] +
                static_cast<double>(bucket.reference[2]) * sample[2] +
                static_cast<double>(bucket.reference[3]) * sample[3];
            sign = dot < 0.0 ? -1.0 : 1.0;
        }
    }
    for (std::size_t index = 0; index < arity; ++index) {
        bucket.values[index] = static_cast<float>(
            static_cast<double>(bucket.values[index]) +
            static_cast<double>(sample[index]) *
                static_cast<double>(weight) * sign);
    }
}

void normalize_blended_quaternion(
    std::array<float, 4>& values) {
    const double length_squared =
        static_cast<double>(values[0]) * values[0] +
        static_cast<double>(values[1]) * values[1] +
        static_cast<double>(values[2]) * values[2] +
        static_cast<double>(values[3]) * values[3];
    if (length_squared > 0.0) {
        const double inverse = 1.0 / std::sqrt(length_squared);
        for (float& component : values) {
            component = static_cast<float>(component * inverse);
        }
    }
}

float advance_property_group_time(
    const PropertyAnimationGroup& group,
    float delta_ms) {
    if (group->playing) {
        group->current_time +=
            delta_ms * ${this.context.floatLiteral(1 / msPerSecond)} *
            group->speed_ratio;
    }
    const float from_time = std::max(
        0.0f,
        std::min(group->from_time, group->clip.duration));
    const float to_time = group->to_time > from_time
        ? std::min(group->to_time, group->clip.duration)
        : group->clip.duration;
    const float duration = std::max(0.0f, to_time - from_time);
    if (duration <= 0.0f) return from_time;
    if (group->loop) {
        group->current_time =
            from_time +
            std::fmod(group->current_time - from_time, duration);
        if (group->current_time < from_time) {
            group->current_time += duration;
        }
    } else {
        group->current_time = std::min(
            std::max(group->current_time, from_time),
            to_time);
    }
    return group->current_time;
}

/**
 * Returns whether the mixer handled this tick, which is the pin's
 * category-handler contract: true means the manager skips the
 * animation-group tasks it would otherwise have ticked.
 *
 * Every group a property manager owns carries a mixer upstream, and a
 * stopped one cannot be reached -- stopAnimation is lowered for glTF
 * groups alone — so the pinned skip reduces to the weight test.
 */
bool update_weighted_property_animations(
    Engine& engine,
    PropertyAnimationManagerRecord& manager,
    float delta_ms) {
    for (PropertyAnimationBucket& bucket : manager.buckets) {
        bucket.contested = false;
        bucket.active = false;
        bucket.has_reference = false;
        bucket.values.fill(0.0f);
    }
    bool contested = false;
    for (const PropertyAnimationGroup& group : manager.groups) {
        if (!group || group->weight == 1.0f) continue;
        for (const PropertyAnimationTrack& track :
             group->clip.tracks) {
            track_bucket(
                manager.buckets,
                group->target,
                track).contested = true;
            contested = true;
        }
    }
    if (!contested) return false;
    for (const PropertyAnimationGroup& group : manager.groups) {
        if (!group) continue;
        const float time =
            advance_property_group_time(group, delta_ms);
        const float weight = group->weight;
        if (weight == 0.0f) continue;
        for (const PropertyAnimationTrack& track :
             group->clip.tracks) {
            const std::array<float, 4> sample =
                evaluate_track(track, time);
            PropertyAnimationBucket& bucket = track_bucket(
                manager.buckets,
                group->target,
                track);
            if (!bucket.contested) {
                write_track_value(
                    engine,
                    group->target,
                    track.path,
                    track.component,
                    sample);
                continue;
            }
            accumulate_weighted_track(bucket, sample, weight);
        }
    }
    for (PropertyAnimationBucket& bucket : manager.buckets) {
        if (!bucket.active) continue;
        if (
            bucket.quaternion &&
            track_stride(bucket.property, bucket.component) == 4) {
            normalize_blended_quaternion(bucket.values);
        }
        write_track_value(
            engine,
            bucket.target,
            bucket.property,
            bucket.component,
            bucket.values);
    }
    return true;
}
`;
    }

    /**
     * The manager as an owner of glTF groups
     * (src/animation/animation-group-task.ts): `addAnimationGroups`
     * attaches each group so the manager ticks it, and
     * `updateAnimationManager` advances everything it owns. Reached by a
     * scene that drives a loaded file's clips itself instead of letting
     * `addToScene` register them with the scene.
     *
     * A group's clip state lives in its asset's own runtime, so the
     * manager hands that runtime the clips it owns and their weights;
     * `animation_tick_clips` advances exactly those, the way upstream
     * ticks each attached group through its own controller. The clips a
     * manager does not own keep the pose they last wrote, which is what
     * a group nothing ticks does upstream.
     */
    private lowerManagedGroups(): string {
        const taskModule =
            "src/animation/animation-group-task.ts";
        const managerModule =
            "src/animation/animation-manager.ts";
        const { declaration: addGroups } =
            this.context.functionDeclaration(
                taskModule,
                "addAnimationGroups",
            );
        if (!this.context.hasCall(addGroups, "addAnimationGroup")) {
            this.context.contractError(
                addGroups,
                "Expected addAnimationGroups to attach each group.",
            );
        }
        const { declaration: addGroup } =
            this.context.functionDeclaration(
                taskModule,
                "addAnimationGroup",
            );
        // Attaching twice is the pin's own no-op, and attaching to a
        // second manager is its own error; both travel into the emitted
        // attach so a scene reaching either behaves the way it would
        // upstream.
        this.expectOneShape(
            addGroup,
            "owner === manager",
            "animation group attach check",
        );
        const { declaration: update } =
            this.context.functionDeclaration(
                managerModule,
                "updateAnimationManager",
            );
        // The step guard: a non-finite or negative delta advances nothing.
        this.expectOneShape(
            update,
            "!Number.isFinite(step) || step < 0",
            "animation manager step guard",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(update, "step"),
            "manager.fixedDeltaMs > 0 ? manager.fixedDeltaMs : deltaMs",
            "Animation manager fixed step",
        );
        return `
void add_animation_groups(
    PropertyAnimationManager manager,
    Engine& engine,
    const std::vector<AnimationGroupHandle>& groups) {
    PropertyAnimationManagerRecord& owner =
        bind_manager_engine(manager, engine);
    for (const AnimationGroupHandle group : groups) {
        if (group.value >= engine.animation_groups.size()) {
            throw std::runtime_error(
                "Invalid animation group handle.");
        }
        // Attaching a group twice is the pin's own no-op.
        const auto found = std::find_if(
            owner.gltf_groups.begin(),
            owner.gltf_groups.end(),
            [group](const AnimationGroupHandle candidate) {
                return candidate.value == group.value;
            });
        if (found != owner.gltf_groups.end()) continue;
        owner.gltf_groups.push_back(group);
    }
}

void update_animation_manager(
    PropertyAnimationManager manager,
    Engine& engine,
    float delta_ms) {
    PropertyAnimationManagerRecord& owner =
        bind_manager_engine(manager, engine);
    if (!std::isfinite(delta_ms) || delta_ms < 0.0f) return;
    tick_manager(engine, owner, delta_ms);
}

void seek_animation_manager(
    PropertyAnimationManager manager,
    Engine& engine,
    float time) {
    seek_manager_groups(
        engine,
        bind_manager_engine(manager, engine),
        time);
}

void set_animation_weight(
    Engine& engine,
    AnimationGroupHandle group,
    float weight) {
    if (group.value >= engine.animation_groups.size()) {
        throw std::runtime_error(
            "Invalid animation group handle.");
    }
    engine.animation_groups[group.value].weight =
        checked_animation_weight(weight);
}

void enable_animation_blending(
    PropertyAnimationManager manager) {
    // setAnimationTaskCategoryHandler keeps ONE handler per manager, so
    // the second opt-in replaces the first rather than composing.
    require_manager(manager).category_handler =
        AnimationCategoryHandler::gltf_mixer;
}
`;
    }

    public lowerPropertyAnimation(
        options: {
            /** The scene reached `enablePropertyAnimationBlending`. */
            blending?: boolean;
            /** The scene reached the mixer-neutral weight-fade scheduler. */
            weightFades?: boolean;
            /** The scene drives a loaded file's clips from a manager. */
            managedGroups?: boolean;
        } = {},
    ): LoweredSource {
        const {
            blending = false,
            weightFades = false,
            managedGroups = false,
        } = options;
        const propertyModule = "src/animation/property-animation.ts";
        const managerModule = "src/animation/animation-manager.ts";
        const groupModule = "src/animation/animation-group.ts";
        const fadeModule = "src/animation/animation-weight-fade.ts";
        const evaluateModule = "src/animation/evaluate.ts";
        this.context.functionDeclaration(
            propertyModule,
            "createPropertyAnimationClip",
        );
        this.context.functionDeclaration(
            propertyModule,
            "createPropertyAnimationGroup",
        );
        this.context.functionDeclaration(
            managerModule,
            "createAnimationManager",
        );
        this.context.functionDeclaration(
            managerModule,
            "startAnimationManager",
        );
        if (weightFades) {
            const { declaration: crossFade } =
                this.context.functionDeclaration(
                    fadeModule,
                    "crossFadeAnimationGroups",
                );
            this.context.expectShapeCount(
                crossFade,
                "validateWeight(options.toWeight ?? 1)",
                "cross-fade destination-weight validation",
            );
            this.context.expectShapeCount(
                crossFade,
                "fadeAnimationWeight(manager, fromGroup, { to: 0, durationMs: options.durationMs })",
                "cross-fade source job",
            );
            this.context.expectShapeCount(
                crossFade,
                "fadeAnimationWeight(manager, toGroup, { to: toWeight, durationMs: options.durationMs })",
                "cross-fade destination job",
            );

            const { declaration: scheduleFade } =
                this.context.functionDeclaration(
                    fadeModule,
                    "fadeAnimationWeight",
                );
            this.expectOneShape(
                scheduleFade,
                "!(options.durationMs > 0) || !Number.isFinite(options.durationMs)",
                "weight-fade duration guard",
            );
            this.context.expectShapeCount(
                scheduleFade,
                "fades[i].group === group",
                "same-group fade replacement",
            );
            if (
                !this.context.hasCall(
                    scheduleFade,
                    "installWeightFadeHook",
                )
            ) {
                this.context.contractError(
                    scheduleFade,
                    "Expected a scheduled fade to install the stable pre-update hook.",
                );
            }

            const { declaration: installFadeHook } =
                this.context.functionDeclaration(
                    fadeModule,
                    "installWeightFadeHook",
                );
            this.expectOneShape(
                installFadeHook,
                "manager._preUpdate === runManagerWeightFades",
                "idempotent weight-fade hook guard",
            );
            this.context.expectShapeCount(
                installFadeHook,
                "(priorPreUpdateByManager ??= new WeakMap()).set(manager, manager._preUpdate)",
                "prior pre-update hook preservation",
            );
            this.expectOneShape(
                installFadeHook,
                "manager._preUpdate = runManagerWeightFades",
                "stable weight-fade hook installation",
            );

            const { declaration: runFades } =
                this.context.functionDeclaration(
                    fadeModule,
                    "runManagerWeightFades",
                );
            const priorHookRuns = this.context.findNodes(
                runFades,
                (node): node is ts.Expression =>
                    ts.isExpression(node) &&
                    this.context.expressionMatchesShape(
                        node,
                        "priorPreUpdateByManager?.get(manager)?.(manager, deltaMs)",
                    ),
            );
            const fadeUpdates = this.context.findNodes(
                runFades,
                (node): node is ts.Expression =>
                    ts.isExpression(node) &&
                    this.context.expressionMatchesShape(
                        node,
                        "updateFades(fades, deltaMs)",
                    ),
            );
            if (
                priorHookRuns.length !== 1 ||
                fadeUpdates.length !== 1 ||
                priorHookRuns[0]!.getStart() >=
                    fadeUpdates[0]!.getStart()
            ) {
                this.context.contractError(
                    runFades,
                    "Expected the preserved pre-update hook to run once before weight fades.",
                );
            }

            const { declaration: updateFades } =
                this.context.functionDeclaration(
                    fadeModule,
                    "updateFades",
                );
            this.expectOneShape(
                updateFades,
                "fade.elapsedMs = Math.min(fade.durationMs, fade.elapsedMs + Math.max(0, deltaMs))",
                "clamped weight-fade advance",
            );
            this.expectOneShape(
                updateFades,
                "fade.group.weight = fade.from + (fade.to - fade.from) * t",
                "weight-fade interpolation",
            );
            this.expectOneShape(
                updateFades,
                "fade.elapsedMs >= fade.durationMs",
                "completed weight-fade guard",
            );
        }
        const { declaration: evaluateSampler } =
            this.context.functionDeclaration(
                evaluateModule,
                "evaluateSampler",
            );
        if (
            !this.context.hasNode(
                evaluateSampler,
                (node) =>
                    ts.isIdentifier(node) &&
                    node.text === "INTERP_STEP",
            )
        ) {
            this.context.contractError(
                evaluateSampler,
                "Expected STEP interpolation handling.",
            );
        }
        if (
            !this.context.hasCall(
                evaluateSampler,
                "quatSlerp",
            )
        ) {
            this.context.contractError(
                evaluateSampler,
                "Expected quaternion slerp interpolation.",
            );
        }
        // The STEP tie-break, paired with the emitted `evaluate_track`
        // STEP branch (`time >= track.keys[right].time ? right : left`):
        // a query landing exactly on a key time takes the LATER key's
        // value, so the `>=` comparison direction is pinned rather than
        // trusted. The shape is asserted whole because every part of it
        // is structural — there is no tunable constant to flow.
        const stepSources = this.context
            .findNodes(
                evaluateSampler,
                (node): node is ts.VariableDeclaration =>
                    ts.isVariableDeclaration(node),
            )
            .filter(
                (candidate) =>
                    ts.isIdentifier(candidate.name) &&
                    candidate.name.text === "srcOff" &&
                    candidate.initializer !== undefined &&
                    ts.isBinaryExpression(
                        this.context.unwrapExpression(
                            candidate.initializer,
                        ),
                    ),
            );
        if (stepSources.length !== 1) {
            this.context.contractError(
                evaluateSampler,
                "Expected one STEP source-offset computation.",
            );
        }
        this.context.assertExpressionShape(
            stepSources[0]!.initializer!,
            "(t >= t1 ? idx + 1 : idx) * stride",
            "STEP tie-break",
        );
        // The near-parallel slerp threshold feeds the emitted
        // `slerp_quaternion` guard (`if (dot > ...)`) directly, so a pin
        // retune changes the generated literal — a deliberate byte-gate
        // signal — instead of passing behind a presence check. The
        // structural filter (a `dot > <literal>` comparison) also pins
        // the comparison direction. The `std::clamp(dot, -1.0f, 1.0f)`
        // ahead of the emitted acos has no pinned counterpart: it is our
        // defensive guard, unreachable while dot <= this threshold.
        const { file: evaluateFile, declaration: quatSlerp } =
            this.context.functionDeclaration(
                evaluateModule,
                "quatSlerp",
            );
        const parallelThresholds = this.context
            .findNodes(
                quatSlerp,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.GreaterThanToken &&
                    ts.isIdentifier(expression.left) &&
                    expression.left.text === "dot" &&
                    ts.isNumericLiteral(expression.right),
            );
        if (parallelThresholds.length !== 1) {
            this.context.contractError(
                quatSlerp,
                "Expected one near-parallel slerp threshold.",
            );
        }
        const slerpParallelThreshold =
            this.context.numericValue(
                parallelThresholds[0]!.right,
                evaluateFile,
            );
        // The playback tick the emitted `tick_group` transcribes lives on
        // the controller `createPointerAnimationGroup` builds. Everything
        // load-bearing in it is pinned here: the ms-per-second divisor
        // flows into the emitted advance (as its reciprocal — the
        // existing emitted form multiplies), and the loop-wrap
        // arithmetic, its negative-wrap correction, and the play-range
        // clamp are shape-asserted against the exact emitted lines.
        const { file: propertyFile, declaration: pointerGroup } =
            this.context.functionDeclaration(
                propertyModule,
                "createPointerAnimationGroup",
            );
        const tickExpressions = this.context.findNodes(
            pointerGroup,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node),
        );
        const timeAssignment = (
            operator: ts.SyntaxKind,
            select: (right: ts.Expression) => boolean,
            label: string,
        ): ts.BinaryExpression => {
            const matches = tickExpressions.filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        operator &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "ctrl.time" &&
                    select(
                        this.context.unwrapExpression(
                            expression.right,
                        ),
                    ),
            );
            if (matches.length !== 1) {
                this.context.contractError(
                    pointerGroup,
                    `Expected one ${label}.`,
                );
            }
            return matches[0]!;
        };
        // Advance: `ctrl.time += (deltaMs / 1000) * ctrl.speedRatio`.
        // Structural checks rather than a full shape assert, so the
        // divisor is free to flow into the emission.
        const advance = timeAssignment(
            ts.SyntaxKind.PlusEqualsToken,
            (right) => ts.isBinaryExpression(right),
            "playback advance",
        );
        const advanceProduct = this.context.unwrapExpression(
            advance.right,
        );
        if (
            !ts.isBinaryExpression(advanceProduct) ||
            advanceProduct.operatorToken.kind !==
                ts.SyntaxKind.AsteriskToken ||
            this.context
                .propertyPath(advanceProduct.right)
                ?.join(".") !== "ctrl.speedRatio"
        ) {
            this.context.contractError(
                advance,
                "Expected the playback advance to scale by the speed ratio.",
            );
        }
        const advanceRate = this.context.unwrapExpression(
            advanceProduct.left,
        );
        if (
            !ts.isBinaryExpression(advanceRate) ||
            advanceRate.operatorToken.kind !==
                ts.SyntaxKind.SlashToken ||
            !ts.isIdentifier(advanceRate.left) ||
            advanceRate.left.text !== "deltaMs"
        ) {
            this.context.contractError(
                advance,
                "Expected the playback advance to divide the frame delta.",
            );
        }
        const msPerSecond = this.context.numericValue(
            advanceRate.right,
            propertyFile,
        );
        // The loop wrap and its negative-wrap correction, paired with the
        // emitted `if (group->loop)` branch (`std::fmod` mirrors the
        // pinned `%`, whose result carries the dividend's sign — the
        // reason the correction exists).
        const loopWrap = timeAssignment(
            ts.SyntaxKind.EqualsToken,
            (right) => ts.isBinaryExpression(right),
            "loop wrap",
        );
        this.context.assertExpressionShape(
            loopWrap.right,
            "fromTime + ((ctrl.time - fromTime) % duration)",
            "Animation loop wrap",
        );
        const wrapCorrection = timeAssignment(
            ts.SyntaxKind.PlusEqualsToken,
            (right) => ts.isIdentifier(right),
            "wrap correction",
        );
        this.context.assertExpressionShape(
            wrapCorrection,
            "ctrl.time += duration",
            "Animation wrap correction",
        );
        const wrapGuards = tickExpressions.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.LessThanToken &&
                this.context
                    .propertyPath(expression.left)
                    ?.join(".") === "ctrl.time",
        );
        if (wrapGuards.length !== 1) {
            this.context.contractError(
                pointerGroup,
                "Expected one wrap-correction guard.",
            );
        }
        this.context.assertExpressionShape(
            wrapGuards[0]!,
            "ctrl.time < fromTime",
            "Animation wrap-correction guard",
        );
        // The play-range clamp, paired with the emitted non-loop branch's
        // `std::clamp(current_time, from_time, to_time)` (max against the
        // lower bound, min against the upper) and reused by the emitted
        // seeker in `start_animation_manager`.
        const rangeClamp = timeAssignment(
            ts.SyntaxKind.EqualsToken,
            (right) => ts.isCallExpression(right),
            "play-range clamp",
        );
        this.context.assertExpressionShape(
            rangeClamp.right,
            "Math.min(Math.max(ctrl.time, fromTime), toTime)",
            "Animation play-range clamp",
        );
        // The degenerate-range guard, paired with the emitted
        // `if (duration <= 0.0f) return;`. The pinned Math.max(0, ...)
        // never changes the guarded comparison's outcome, so the
        // emission carries the bare difference.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                pointerGroup,
                "duration",
            ),
            "Math.max(0, toTime - fromTime)",
            "Animation tick duration",
        );
        const durationGuards = tickExpressions.filter(
            (expression) =>
                expression.operatorToken.kind ===
                    ts.SyntaxKind.LessThanEqualsToken &&
                ts.isIdentifier(expression.left) &&
                expression.left.text === "duration",
        );
        if (durationGuards.length !== 1) {
            this.context.contractError(
                pointerGroup,
                "Expected one degenerate-range guard.",
            );
        }
        this.context.assertExpressionShape(
            durationGuards[0]!,
            "duration <= 0",
            "Animation degenerate-range guard",
        );
        // The seek conversion, paired with the emitted `go_to_frame`
        // (`frame / group->clip.frame_rate`). The pinned
        // `|| DEFAULT_FRAME_RATE` fallback is dead in the generated
        // runtime: `create_property_animation_clip` throws on
        // non-positive frame rates, so the clip's rate is always usable.
        const { declaration: goToFrame } =
            this.context.functionDeclaration(
                groupModule,
                "goToFrame",
            );
        const { declaration: pauseAnimation } =
            this.context.functionDeclaration(
                groupModule,
                "pauseAnimation",
            );
        this.expectOneShape(
            pauseAnimation,
            "group.isPlaying = false",
            "property animation pause write",
        );
        const seekAssignments = this.context
            .findNodes(
                goToFrame,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node),
            )
            .filter(
                (expression) =>
                    expression.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    this.context
                        .propertyPath(expression.left)
                        ?.join(".") === "group.currentTime" &&
                    ts.isBinaryExpression(
                        this.context.unwrapExpression(
                            expression.right,
                        ),
                    ),
            );
        if (seekAssignments.length !== 1) {
            this.context.contractError(
                goToFrame,
                "Expected one frame-to-time seek conversion.",
            );
        }
        this.context.assertExpressionShape(
            seekAssignments[0]!.right,
            "frame / (group.frameRate || DEFAULT_FRAME_RATE)",
            "Animation seek conversion",
        );

        // A bucket is as wide as the pin's stride for its path: the lane's
        // own width where the path names the lane, and one where it names
        // a component of it. Both come out of the same lane table the clip
        // lowerer resolves paths and validates keys against.
        const trackArity = blending
            ? `
constexpr std::size_t track_stride(
    PropertyAnimationPath path,
    PropertyAnimationComponent component) {
    if (component != PropertyAnimationComponent::whole_lane) return 1;
    switch (path) {
${[...propertyAnimationLanes.values()]
    .map(
        (lane) =>
            `        case PropertyAnimationPath::${lane.native}:\n` +
            `            return ${lane.components};`,
    )
    .join("\n")}
    }
    return 0;
}
`
            : "";
        const mixerSource = blending
            ? this.lowerWeightedPointerMixer(msPerSecond)
            : "";
        const weightEntryPoints = blending
            ? `
void set_animation_weight(
    PropertyAnimationGroup group,
    float weight) {
    if (!group) {
        throw std::runtime_error(
            "Property animation group is null.");
    }
    group->weight = checked_animation_weight(weight);
}

void enable_property_animation_blending(
    PropertyAnimationManager manager) {
    require_manager(manager).category_handler =
        AnimationCategoryHandler::property_mixer;
}
`
            : "";
        // The fade updater occupies the pin's one stable pre-update slot.
        // Installation compares the stored function target, preserves a
        // prior callback separately, and never wraps an already-installed
        // updater, so repeated scheduling cannot grow a wrapper chain.
        const weightFadeSource = weightFades
            ? `
bool same_animation_weight_fade_target(
    const AnimationWeightFadeTarget& left,
    const AnimationWeightFadeTarget& right) {
    if (left.kind != right.kind) return false;
    if (left.kind == AnimationWeightFadeTargetKind::property) {
        return left.property_group == right.property_group;
    }
    return left.gltf_group.value == right.gltf_group.value;
}

float& animation_weight_fade_target_weight(
    Engine& engine,
    const AnimationWeightFadeTarget& target) {
    if (target.kind == AnimationWeightFadeTargetKind::property) {
        if (!target.property_group) {
            throw std::runtime_error(
                "Property animation group is null.");
        }
        return target.property_group->weight;
    }
    if (target.gltf_group.value >= engine.animation_groups.size()) {
        throw std::runtime_error(
            "Invalid animation group handle.");
    }
    return engine.animation_groups[target.gltf_group.value].weight;
}

void update_animation_weight_fades(
    Engine& engine,
    PropertyAnimationManagerRecord& manager,
    float delta_ms) {
    for (
        std::size_t index = manager.weight_fades.size();
        index > 0;
        --index) {
        const std::size_t fade_index = index - 1;
        PropertyAnimationWeightFade& fade =
            manager.weight_fades[fade_index];
        fade.elapsed_ms = std::min(
            fade.duration_ms,
            fade.elapsed_ms + std::max(0.0f, delta_ms));
        const float amount =
            fade.elapsed_ms / fade.duration_ms;
        animation_weight_fade_target_weight(engine, fade.target) =
            fade.from + (fade.to - fade.from) * amount;
        if (fade.elapsed_ms >= fade.duration_ms) {
            manager.weight_fades.erase(
                manager.weight_fades.begin() +
                static_cast<std::ptrdiff_t>(fade_index));
        }
    }
}

void run_manager_weight_fades(
    Engine& engine,
    PropertyAnimationManagerRecord& manager,
    float delta_ms) {
    if (manager.prior_weight_fade_pre_update) {
        manager.prior_weight_fade_pre_update(
            engine, manager, delta_ms);
    }
    update_animation_weight_fades(engine, manager, delta_ms);
}

void install_weight_fade_hook(
    PropertyAnimationManagerRecord& manager) {
    using PreUpdateFunction = void (*)(
        Engine&, PropertyAnimationManagerRecord&, float);
    const PreUpdateFunction* installed =
        manager.pre_update.target<PreUpdateFunction>();
    if (installed && *installed == &run_manager_weight_fades) {
        return;
    }
    if (manager.pre_update) {
        manager.prior_weight_fade_pre_update =
            std::move(manager.pre_update);
    }
    manager.pre_update = &run_manager_weight_fades;
}

void schedule_animation_weight_fade(
    Engine& engine,
    PropertyAnimationManager manager,
    AnimationWeightFadeTarget target,
    float to,
    float duration_ms) {
    const float checked_to = checked_animation_weight(to);
    const float from = checked_animation_weight(
        animation_weight_fade_target_weight(engine, target));
    if (!std::isfinite(duration_ms) || !(duration_ms > 0.0f)) {
        throw std::runtime_error(
            "Animation weight fade duration must be a finite "
            "positive number, got " +
            std::to_string(duration_ms));
    }
    PropertyAnimationManagerRecord& owner =
        bind_manager_engine(manager, engine);
    for (
        std::size_t index = owner.weight_fades.size();
        index > 0;
        --index) {
        const std::size_t fade_index = index - 1;
        if (same_animation_weight_fade_target(
                owner.weight_fades[fade_index].target,
                target)) {
            owner.weight_fades.erase(
                owner.weight_fades.begin() +
                static_cast<std::ptrdiff_t>(fade_index));
        }
    }
    owner.weight_fades.push_back(
        PropertyAnimationWeightFade{
            std::move(target),
            from,
            checked_to,
            duration_ms,
            0.0f});
    install_weight_fade_hook(owner);
}
`
            : "";
        const weightFadeEntryPoints = weightFades
            ? `
void cross_fade_animation_groups(
    PropertyAnimationManager manager,
    Engine& engine,
    AnimationWeightFadeTarget from_group,
    AnimationWeightFadeTarget to_group,
    float duration_ms,
    float to_weight) {
    // Validate the destination before either source weight is touched,
    // matching crossFadeAnimationGroups' ordering in the pin.
    const float checked_to = checked_animation_weight(to_weight);
    schedule_animation_weight_fade(
        engine, manager, std::move(from_group), 0.0f, duration_ms);
    schedule_animation_weight_fade(
        engine, manager, std::move(to_group), checked_to, duration_ms);
}
`
            : "";
        // The pin's category handler returns whether it drove the
        // animation-group tasks this tick; when it did, the manager skips
        // exactly those tasks, which here is every group it owns.
        const blendingTick = blending
            ? `
    if (
        manager.category_handler ==
            AnimationCategoryHandler::property_mixer &&
        update_weighted_property_animations(
            engine, manager, delta_ms)) {
        return;
    }`
            : "";
        // `_preUpdate` runs before the category handler in the pin. The
        // queue is mixer-neutral: this phase is emitted independently of
        // either blend opt-in and only changes group weights.
        const weightFadeTick = weightFades
            ? `
    if (manager.pre_update) {
        manager.pre_update(engine, manager, delta_ms);
    }`
            : "";
        const managerEntryPoints = managedGroups
            ? this.lowerManagedGroups()
            : "";
        // The pinned weight range is reached by either mixer/fade path.
        // Manager validation and engine binding are unconditional because
        // even a plain property group associates its manager with a target.
        const weightValidationHelper =
            blending || weightFades || managedGroups
                ? `float checked_animation_weight(float weight) {
    if (
        !std::isfinite(weight) ||
        weight < 0.0f ||
        weight > 1.0f) {
        throw std::runtime_error(
            "Animation weight must be a finite number between 0 "
            "and 1, got " +
            std::to_string(weight));
    }
    return weight;
}

`
                : "";
        const weightHelpers = `${weightValidationHelper}

PropertyAnimationManagerRecord& require_manager(
    const PropertyAnimationManager& manager) {
    if (!manager) {
        throw std::runtime_error(
            "Property animation manager is null.");
    }
    return *manager;
}

PropertyAnimationManagerRecord& bind_manager_engine(
    const PropertyAnimationManager& manager,
    Engine& engine) {
    PropertyAnimationManagerRecord& owner =
        require_manager(manager);
    if (owner.engine && owner.engine != &engine) {
        throw std::runtime_error(
            "Animation manager and group/scene belong to different engines.");
    }
    if (!owner.engine) {
        owner.engine = &engine;
        engine.animation_managers.push_back(manager);
    }
    return owner;
}

`;
        // A glTF group's clip advances inside its asset's own runtime, so
        // the manager ticks each distinct asset it holds groups from,
        // once per frame.
        const managedGroupTick = managedGroups
            ? `
    std::vector<std::uint32_t> ticked_assets;
    for (const AnimationGroupHandle group : manager.gltf_groups) {
        if (group.value >= engine.animation_groups.size()) continue;
        const std::uint32_t asset =
            engine.animation_groups[group.value].asset;
        if (asset >= engine.assets.size()) continue;
        if (
            std::find(
                ticked_assets.begin(),
                ticked_assets.end(),
                asset) != ticked_assets.end()) {
            continue;
        }
        ticked_assets.push_back(asset);
        // The clips this manager owns, at the weights it holds. Reusing
        // the manager's own scratch keeps the capacity across frames.
        manager.blend_scratch.clear();
        for (const AnimationGroupHandle attached :
             manager.gltf_groups) {
            if (
                attached.value >= engine.animation_groups.size()) {
                continue;
            }
            const AnimationGroupRecord& entry =
                engine.animation_groups[attached.value];
            if (entry.asset != asset) continue;
            manager.blend_scratch.push_back(
                BlendedClip{entry.clip, entry.weight});
        }
        AssetRecord& record = engine.assets[asset];
        // The manager's own weighted pass first, exactly where the pin
        // runs its category handler: when it drives the tick, the clips
        // it holds are not advanced a second time.
        if (
            manager.category_handler ==
                AnimationCategoryHandler::gltf_mixer &&
            record.animation_blend &&
            record.animation_blend(
                manager.blend_scratch,
                delta_ms)) {
            continue;
        }
        if (record.animation_tick_clips) {
            record.animation_tick_clips(
                manager.blend_scratch,
                delta_ms);
        }
    }`
            : "";

        return {
            modulePath: propertyModule,
            symbolName:
                "createAnimationManager,createPropertyAnimationClip,createPropertyAnimationGroup,startAnimationManager,goToFrame" +
                (weightFades
                    ? ",crossFadeAnimationGroups"
                    : ""),
            header: "",
            source: `// ${this.context.provenance(
                propertyModule,
                "property animation manager, clips, groups, interpolation, and seeking",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <utility>

namespace bbl {
namespace {

std::array<float, 4> normalized_quaternion(
    std::array<float, 4> value) {
    const float length = std::sqrt(
        value[0] * value[0] +
        value[1] * value[1] +
        value[2] * value[2] +
        value[3] * value[3]);
    if (length <= 0.0f) {
        return {0.0f, 0.0f, 0.0f, 1.0f};
    }
    for (float& component : value) component /= length;
    return value;
}

std::array<float, 4> slerp_quaternion(
    std::array<float, 4> left,
    std::array<float, 4> right,
    float amount) {
    float dot =
        left[0] * right[0] +
        left[1] * right[1] +
        left[2] * right[2] +
        left[3] * right[3];
    if (dot < 0.0f) {
        for (float& component : right) component = -component;
        dot = -dot;
    }
    if (dot > ${this.context.floatLiteral(slerpParallelThreshold)}) {
        std::array<float, 4> result{};
        for (std::size_t index = 0; index < result.size(); ++index) {
            result[index] =
                left[index] +
                (right[index] - left[index]) * amount;
        }
        return normalized_quaternion(result);
    }
    dot = std::clamp(dot, -1.0f, 1.0f);
    const float theta = std::acos(dot);
    const float sin_theta = std::sin(theta);
    const float left_weight =
        std::sin((1.0f - amount) * theta) / sin_theta;
    const float right_weight =
        std::sin(amount * theta) / sin_theta;
    std::array<float, 4> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        result[index] =
            left[index] * left_weight +
            right[index] * right_weight;
    }
    return result;
}

std::array<float, 4> evaluate_track(
    const PropertyAnimationTrack& track,
    float time) {
    if (track.keys.empty()) {
        throw std::runtime_error(
            "Property animation track has no keys.");
    }
    if (
        track.keys.size() == 1 ||
        time <= track.keys.front().time) {
        return track.keys.front().value;
    }
    if (time >= track.keys.back().time) {
        return track.keys.back().value;
    }
    std::size_t right = 1;
    while (
        right < track.keys.size() &&
        track.keys[right].time < time) {
        ++right;
    }
    const std::size_t left = right - 1;
    if (
        track.interpolation ==
        PropertyAnimationInterpolation::step) {
        return time >= track.keys[right].time
            ? track.keys[right].value
            : track.keys[left].value;
    }
    const float span =
        track.keys[right].time -
        track.keys[left].time;
    const float amount =
        span > 0.0f
            ? (time - track.keys[left].time) / span
            : 0.0f;
    // evaluateSampler slerps on the track's own rotation flag, which the
    // clip derived from its path -- so a path naming one component of a
    // quaternion lerps that number, as it does upstream.
    if (track.quaternion) {
        return slerp_quaternion(
            track.keys[left].value,
            track.keys[right].value,
            amount);
    }
    std::array<float, 4> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        result[index] =
            track.keys[left].value[index] +
            (
                track.keys[right].value[index] -
                track.keys[left].value[index]) *
                amount;
    }
    return result;
}

${weightHelpers}/**
 * The pinned binding's writer: one lane, on the object the clip was bound
 * to, whole or by the component the path named. A mesh transform also
 * marks the mesh, which is what the pinned setters do through their own
 * observable vectors.
 */
void write_track_value(
    Engine& engine,
    PropertyAnimationTarget target,
    PropertyAnimationPath path,
    PropertyAnimationComponent component,
    const std::array<float, 4>& value) {
    if (target.kind == PropertyAnimationTargetKind::camera) {
        if (target.index >= engine.cameras.size()) {
            throw std::runtime_error(
                "Property animation group has an invalid camera target.");
        }
        CameraRecord& camera = engine.cameras[target.index];
        switch (path) {
${this.propertyWriterArms("camera", "            ")}
            default:
                throw std::runtime_error(
                    "Property animation path does not belong to a camera.");
        }
        return;
    }
    if (target.index >= engine.meshes.size()) {
        throw std::runtime_error(
            "Property animation group has an invalid mesh target.");
    }
    MeshRecord& mesh = engine.meshes[target.index];
    switch (path) {
${this.propertyWriterArms("mesh", "        ")}
        default:
            throw std::runtime_error(
                "Property animation path does not belong to a mesh.");
    }
    mark_mesh_runtime_transform(engine, MeshHandle{target.index});
}
${trackArity}
void apply_group(
    Engine& engine,
    const PropertyAnimationGroup& group) {
    if (!group) {
        throw std::runtime_error(
            "Property animation group is null.");
    }
    for (const PropertyAnimationTrack& track :
         group->clip.tracks) {
        write_track_value(
            engine,
            group->target,
            track.path,
            track.component,
            evaluate_track(track, group->current_time));
    }
}

void tick_group(
    Engine& engine,
    const PropertyAnimationGroup& group,
    float delta_ms) {
    if (!group || !group->playing) return;
    group->current_time +=
        delta_ms * ${this.context.floatLiteral(1 / msPerSecond)} * group->speed_ratio;
    const float duration =
        group->to_time - group->from_time;
    if (duration <= 0.0f) return;
    if (group->loop) {
        group->current_time =
            group->from_time +
            std::fmod(
                group->current_time - group->from_time,
                duration);
        if (group->current_time < group->from_time) {
            group->current_time += duration;
        }
    } else {
        group->current_time = std::clamp(
            group->current_time,
            group->from_time,
            group->to_time);
    }
    apply_group(engine, group);
}
${mixerSource}${weightFadeSource}
/**
 * One manager tick: upstream's updateAnimationManager, whose category
 * handler drives the animation-group tasks when it is installed and
 * whose remaining tasks each advance themselves.
 */
void tick_manager(
    Engine& engine,
    PropertyAnimationManagerRecord& manager,
    float delta_ms) {${weightFadeTick}${blendingTick}
    for (const PropertyAnimationGroup& group : manager.groups) {
        tick_group(engine, group, delta_ms);
    }${managedGroupTick}
}

/**
 * The measured seek, applied to what this manager owns: each property
 * group is placed at the requested time and paused, which is the pose
 * the reference harness produces with goToFrame plus pauseAnimation. A
 * glTF group is seeked through its own asset, whose seeker the scene
 * already carries.
 */
void seek_manager_groups(
    Engine& engine,
    PropertyAnimationManagerRecord& manager,
    float time) {
    for (const PropertyAnimationGroup& group : manager.groups) {
        if (!group) continue;
        group->current_time = std::clamp(
            time,
            group->from_time,
            group->to_time);
        group->playing = false;
        apply_group(engine, group);
    }
}

} // namespace

PropertyAnimationManager create_animation_manager() {
    return std::make_shared<PropertyAnimationManagerRecord>();
}

PropertyAnimationManager create_animation_manager(
    Engine& engine) {
    auto manager =
        std::make_shared<PropertyAnimationManagerRecord>();
    bind_manager_engine(manager, engine);
    return manager;
}
${managerEntryPoints}${weightEntryPoints}${weightFadeEntryPoints}

PropertyAnimationClip create_property_animation_clip(
    std::string name,
    std::vector<PropertyAnimationTrack> tracks,
    float frame_rate) {
    if (tracks.empty()) {
        throw std::runtime_error(
            "createPropertyAnimationClip requires at least one track.");
    }
    if (!(frame_rate > 0.0f)) {
        throw std::runtime_error(
            "Property animation frame rate must be positive.");
    }
    PropertyAnimationClip clip;
    clip.name = std::move(name);
    clip.tracks = std::move(tracks);
    clip.frame_rate = frame_rate;
    for (const PropertyAnimationTrack& track : clip.tracks) {
        if (track.keys.empty()) {
            throw std::runtime_error(
                "Property animation track requires at least one key.");
        }
        clip.duration = std::max(
            clip.duration,
            track.keys.back().time);
    }
    return clip;
}

PropertyAnimationGroup create_property_animation_group(
    PropertyAnimationManager manager,
    Engine& engine,
    PropertyAnimationTarget target,
    PropertyAnimationClip clip,
    PropertyAnimationGroupOptions options) {
    PropertyAnimationManagerRecord& owner =
        bind_manager_engine(manager, engine);
    if (!(options.to_time > options.from_time)) {
        throw std::runtime_error(
            "Animation play range must have toTime greater than fromTime.");
    }
    auto group =
        std::make_shared<PropertyAnimationGroupRecord>();
    group->target = target;
    group->clip = std::move(clip);
    group->from_time = options.from_time;
    group->to_time = options.to_time;
    group->current_time = options.from_time;
    group->speed_ratio = options.speed_ratio;
    group->loop = options.loop;
    owner.groups.push_back(group);
    return group;
}

void start_animation_manager(
    PropertyAnimationManager manager,
    Scene& scene) {
    if (!scene.engine) {
        throw std::runtime_error(
            "Animation manager requires a scene engine.");
    }
    Engine* engine = scene.engine;
    PropertyAnimationManagerRecord& owner =
        bind_manager_engine(manager, *engine);
    if (owner.started) return;
    owner.started = true;
    scene.before_render.push_back(
        [manager, engine](float delta_ms) {
            tick_manager(*engine, *manager, delta_ms);
        });
    scene.animation_seekers.push_back(
        [manager, engine](float time) {
            seek_manager_groups(*engine, *manager, time);
        });
}

void pause_animation(PropertyAnimationGroup group) {
    if (!group) {
        throw std::runtime_error(
            "Property animation group is null.");
    }
    group->playing = false;
}

void go_to_frame(
    PropertyAnimationGroup group,
    Engine& engine,
    float frame) {
    if (!group) {
        throw std::runtime_error(
            "Property animation group is null.");
    }
    group->current_time =
        frame / group->clip.frame_rate;
    group->playing = false;
    apply_group(engine, group);
}

} // namespace bbl
`,
        };
    }
}
