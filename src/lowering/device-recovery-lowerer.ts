import { stringLiteral } from "../cpp-literals.js";
/**
 * `device-lost-recovery.ts`'s coordinator, lowered from the pin.
 *
 * The registration list, arming, the lost handler (its armed-device and
 * forced-loss gates, the snapshot of registrations and each `_onLost`), the
 * success continuation (disarm, re-arm, each `_onRecovered`), the failure
 * continuation (each `_onRecoveryFailed`, no re-arm), the scene strategy's
 * registration, the handle's `disable`, `markNextDeviceLossForRecovery`,
 * `forceWebGpuDeviceLossForTesting` and the run's
 * `assertEveryActiveContextKindIsRecoverable` are the pinned bodies
 * translated.
 *
 * The platform around them is the PAL's, and each boundary is named by the
 * statement it replaces:
 *
 *  - The device. A device is identified by its generation; `destroy()` asks
 *    the PAL to tear the device down at the frame boundary, and the PAL's
 *    frame loop is what delivers the loss to the armed handler
 *    (`device.lost.then`) through `begin_device_recovery`.
 *  - The rebuild. `runDeviceLostRecovery` is the PAL recreating its device
 *    and replaying the generated uploads over retained CPU owners; it settles
 *    through `complete_device_recovery` or `fail_device_recovery`.
 *  - Capture. Native texture owners retain their upload inputs. Data-mesh
 *    capture derives the scene strategy's active count from registrations
 *    and retains the pin's optional CPU aliases at factory time.
 */
import ts from "typescript";
import {
    type LoweredSource,
    type LoweringContext,
    propertyName,
    unwrapExpression,
} from "./context.js";
import { assertDeviceRecoveryContracts } from "./device-recovery-contract.js";
import { lowerRetainedMeshRecovery } from "./mesh-recovery.js";
import {
    lowerPinnedFunctionParts,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import {
    absentBinding,
    type PinnedBinding,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    shaderUniformRecoveryPublication,
    shaderUniformRecoveryReset,
} from "./shader-uniforms.js";
import { soleBindingName } from "../compiler/syntax.js";

const recoveryModule = "src/engine/device-lost-recovery.ts";
const testingModule = "src/engine/device-lost-recovery-testing.ts";
const sceneModule = "src/engine/device-lost-scene-recovery.ts";
const runModule = "src/engine/device-lost-recovery-run.ts";

const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });

/**
 * The coordinator state's members, on the native record `cpp` names. The
 * pin's device is its generation, and an unarmed state names generation 0,
 * which no device ever has.
 */
function stateMembers(pinned: string, cpp: string): [string, PinnedBinding][] {
    return [
        [pinned, { cpp, type: "opaque" }],
        [
            `${pinned}._registrations`,
            { cpp: `${cpp}.registrations`, type: "opaque" },
        ],
        [
            `${pinned}._registrations.length`,
            scalar(`static_cast<double>(${cpp}.registrations.size())`),
        ],
        [`${pinned}._forceNextLoss`, { cpp: `${cpp}.requested`, type: "bool" }],
        [`${pinned}._recovering`, { cpp: `${cpp}.recovering`, type: "bool" }],
        [
            `${pinned}._armedDevice`,
            {
                cpp: `${cpp}.armed_device`,
                type: "scalar",
                absentCpp: `${cpp}.armed_device == 0.0`,
            },
        ],
    ];
}

/** A registration's three callbacks, each called only where one is set. */
function registrationCalls(
    name: string,
): [string, (args: readonly string[]) => string][] {
    return [
        [
            `${name}._onLost`,
            () => `(${name}->on_lost ? ${name}->on_lost() : void())`,
        ],
        [
            `${name}._onRecovered`,
            () => `(${name}->on_recovered ? ${name}->on_recovered() : void())`,
        ],
        [
            `${name}._onRecoveryFailed`,
            (args) =>
                `(${name}->on_failed ? ${name}->on_failed(${args[0]}) : void())`,
        ],
    ];
}

/** `registrations.indexOf(x)` and `registrations.splice(i, 1)`, `push(x)`. */
const listMethods: NonNullable<PinnedNumericScope["methods"]> = new Map([
    ["push", (receiver, args) => `${receiver}.push_back(${args.join(", ")})`],
    [
        "indexOf",
        (receiver, args) => `bbl::js::array_index_of(${receiver}, ${args[0]})`,
    ],
    [
        "splice",
        (receiver, args) => {
            if (args.length !== 2 || args[1] !== "1.0") {
                throw new Error(
                    "Pinned recovery splices exactly one registration.",
                );
            }
            return `${receiver}.erase(${receiver}.begin() + static_cast<std::ptrdiff_t>(${args[0]}))`;
        },
    ],
]);

/**
 * `if (!registrations.some((current) => current._kind === registration._kind))
 * registration._enable?.(engine)` (or `_disable`): the capture hook the first
 * registration of a kind retains and the last releases. Native texture owners
 * retain their sources, and mesh capture reads the registrations directly,
 * so the scene strategy needs no separate counter hook.
 */
function captureHook(
    context: LoweringContext,
    statement: ts.Statement,
    hook: "_enable" | "_disable",
): boolean {
    if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
    const body = ts.isBlock(statement.thenStatement)
        ? statement.thenStatement.statements
        : [statement.thenStatement];
    return (
        context.expressionMatchesShape(
            statement.expression,
            "!registrations.some((current) => current._kind === registration._kind)",
        ) &&
        body.length === 1 &&
        ts.isExpressionStatement(body[0]!) &&
        context.expressionMatchesShape(
            body[0].expression,
            `registration.${hook}?.(engine)`,
        )
    );
}

/** The `.then(...)` call an expression statement makes, unwrapping `void`. */
function thenCall(statement: ts.Statement): ts.CallExpression | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    let expression = unwrapExpression(statement.expression);
    if (ts.isVoidExpression(expression))
        expression = unwrapExpression(expression.expression);
    return ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "then"
        ? expression
        : undefined;
}

/** An arrow's block body, or a refusal naming what was expected. */
function arrowBody(
    context: LoweringContext,
    node: ts.Expression | undefined,
    what: string,
): { parameters: readonly string[]; statements: readonly ts.Statement[] } {
    const arrow = node ? context.unwrapExpression(node) : undefined;
    if (!arrow || !ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body)) {
        return context.contractError(
            node ?? arrow ?? context.sourceFile(recoveryModule),
            `Expected ${what} to be a block arrow.`,
        );
    }
    return {
        parameters: arrow.parameters.map((parameter) =>
            soleBindingName(parameter.name),
        ),
        statements: arrow.body.statements,
    };
}

/** `arm`'s three closures: the lost handler and the run's two continuations. */
function armClosures(context: LoweringContext): {
    lost: readonly ts.Statement[];
    recovered: readonly ts.Statement[];
    failed: readonly ts.Statement[];
    failedParameter: string;
} {
    const { declaration } = context.functionDeclaration(recoveryModule, "arm");
    const listen = declaration
        .body!.statements.map(thenCall)
        .find(
            (call) =>
                call !== undefined &&
                context.expressionMatchesShape(
                    call.expression,
                    "device.lost.then",
                ),
        );
    const lost = arrowBody(
        context,
        listen?.arguments[0],
        "the device-lost handler",
    );
    const run = lost.statements
        .map(thenCall)
        .find((call) => call !== undefined);
    if (!run || run.arguments.length !== 2) {
        return context.contractError(
            declaration,
            "Expected the lost handler to settle the recovery run with a success and a failure continuation.",
        );
    }
    const recovered = arrowBody(
        context,
        run.arguments[0],
        "the recovery success continuation",
    );
    const failed = arrowBody(
        context,
        run.arguments[1],
        "the recovery failure continuation",
    );
    if (lost.parameters.join() !== "info" || failed.parameters.length !== 1) {
        return context.contractError(
            declaration,
            "Expected the lost handler to take `info` and the failure continuation its error.",
        );
    }
    return {
        lost: lost.statements,
        recovered: recovered.statements,
        failed: failed.statements,
        failedParameter: failed.parameters[0]!,
    };
}

/** The scope the coordinator's bodies share. */
function coordinatorScope(
    context: LoweringContext,
    extra: {
        bindings?: readonly [string, PinnedBinding][];
        calls?: readonly [string, (args: readonly string[]) => string][];
        statement?: NonNullable<PinnedNumericScope["statement"]>;
    } = {},
): {
    memberBindings: Map<string, PinnedBinding>;
    calls: Map<string, (args: readonly string[]) => string>;
    methods: NonNullable<PinnedNumericScope["methods"]>;
    statement: NonNullable<PinnedNumericScope["statement"]>;
} {
    const statement: NonNullable<PinnedNumericScope["statement"]> = (
        node,
        lowerer,
        indent,
    ) => {
        // The PAL delivers the loss to the armed handler; the listener
        // itself is the frame loop's.
        const run = thenCall(node);
        if (
            run &&
            context.expressionMatchesShape(run.expression, "device.lost.then")
        ) {
            return [];
        }
        // `runDeviceLostRecovery`, dynamically imported and settled by the
        // two continuations: the PAL's rebuild, which settles through
        // `complete_device_recovery` or `fail_device_recovery`.
        if (
            run &&
            context.hasNode(
                run.expression,
                (expression) =>
                    ts.isCallExpression(expression) &&
                    context.expressionMatchesShape(
                        expression,
                        'import("./device-lost-recovery-run.js")',
                    ),
            )
        ) {
            return [];
        }
        return extra.statement?.(node, lowerer, indent);
    };
    return {
        memberBindings: new Map<string, PinnedBinding>([
            ["engine", { cpp: "engine", type: "opaque" }],
            // A device is its generation.
            [
                "engine._device",
                scalar("static_cast<double>(engine.device_generation)"),
            ],
            ...(extra.bindings ?? []),
        ]),
        calls: new Map([
            [
                "arm",
                (args: readonly string[]) =>
                    `arm_device_recovery(${args.join(", ")})`,
            ],
            ...(extra.calls ?? []),
        ]),
        methods: listMethods,
        statement,
    };
}

/** `arm(engine, state)`: which device's loss the handler recovers. */
function armCpp(context: LoweringContext): string {
    const parts = lowerPinnedFunctionParts(
        context,
        recoveryModule,
        "arm",
        [
            {
                pinned: "engine",
                kind: "record",
                cpp: "engine",
                cppType: "Engine",
                annotation: "EngineContext",
                mutableRecord: true,
                binding: { cpp: "engine", type: "opaque" },
            },
            {
                pinned: "state",
                kind: "record",
                cpp: "state",
                cppType: "Engine::DeviceRecoveryState",
                annotation: "DeviceLostRecoveryState",
                mutableRecord: true,
                binding: { cpp: "state", type: "opaque" },
            },
        ],
        {
            cppName: "arm_device_recovery",
            returns: "void",
            ...coordinatorScope(context, {
                bindings: stateMembers("state", "state"),
            }),
        },
    );
    return `// ${parts.provenance}\n${parts.declaration} {\n${parts.body}\n}`;
}

/**
 * The lost handler, the success continuation and the failure continuation,
 * as the three native entry points the PAL's frame loop reaches. The snapshot
 * the handler takes (`[...state._registrations]`) is `state.in_flight`, which
 * the continuations read in its place.
 */
function continuationsCpp(context: LoweringContext): string {
    const file = context.sourceFile(recoveryModule);
    const { lost, recovered, failed, failedParameter } = armClosures(context);
    const inFlight: [string, PinnedBinding] = [
        "registrations",
        { cpp: "state.in_flight", type: "opaque" },
    ];
    // `const registrations = [...state._registrations]`: the snapshot the
    // two continuations close over, which is why it lives on the record.
    const snapshot: NonNullable<PinnedNumericScope["statement"]> = (
        node,
        lowerer,
        indent,
    ) => {
        const [entry] = ts.isVariableStatement(node)
            ? node.declarationList.declarations
            : [];
        if (
            !entry ||
            !ts.isIdentifier(entry.name) ||
            entry.name.text !== "registrations"
        ) {
            return undefined;
        }
        context.assertStatementShapes(
            entry,
            [node],
            "const registrations = [...state._registrations];",
            "Recovery registration snapshot",
        );
        lowerer.bindPorts([["registrations", inFlight[1]]], entry);
        return [`${indent}state.in_flight = state.registrations;`];
    };
    const forOf: NonNullable<PinnedNumericScope["forOf"]> = (
        iterated,
        element,
        list,
    ) =>
        iterated === "registrations" && list
            ? {
                  range: list.cpp,
                  bindings: new Map([
                      [element, { cpp: element, type: "opaque" }],
                  ]),
              }
            : undefined;
    const body = (
        statements: readonly ts.Statement[],
        bindings: readonly [string, PinnedBinding][],
    ): string => {
        const { memberBindings, ...scope } = coordinatorScope(context, {
            bindings: [...stateMembers("state", "state"), ...bindings],
            calls: registrationCalls("registration"),
            statement: snapshot,
        });
        return lowerPinnedBody(file, statements, {
            ...scope,
            bindings: memberBindings,
            forOf,
        });
    };
    // `device` is the device the handler was armed for: the one being lost.
    // A loss the PAL delivers is always the `destroy()` a forced loss asked
    // for, so its reason is "destroyed".
    const lostBody = body(lost, [
        ["device", scalar("static_cast<double>(engine.device_generation)")],
        [
            'info.reason === "destroyed"',
            { cpp: "true", type: "bool", staticBoolean: true },
        ],
        ["info", absentBinding()],
    ]);
    return `// ${context.provenance(recoveryModule, "arm", "its device-lost handler")}
void device_lost(Engine& engine, Engine::DeviceRecoveryState& state) {
${lostBody}
}

// ${context.provenance(recoveryModule, "arm", "the recovery run's success continuation")}
void device_recovered(Engine& engine, Engine::DeviceRecoveryState& state) {
${body(recovered, [inFlight])}
}

// ${context.provenance(recoveryModule, "arm", "the recovery run's failure continuation")}
void device_recovery_failed([[maybe_unused]] Engine& engine, Engine::DeviceRecoveryState& state, const std::string& ${failedParameter}) {
${body(failed, [inFlight, [failedParameter, { cpp: failedParameter, type: "opaque" }]])}
}`;
}

/**
 * `_enableDeviceLostRecovery` and the handle's `disable`: the registration
 * joins the list and arms, and the handle removes it once.
 */
function registrationCpp(context: LoweringContext): string {
    const file = context.sourceFile(recoveryModule);
    const { declaration } = context.functionDeclaration(
        recoveryModule,
        "_enableDeviceLostRecovery",
    );
    const statement: NonNullable<PinnedNumericScope["statement"]> = (
        node,
        lowerer,
        indent,
    ) => {
        if (
            captureHook(context, node, "_enable") ||
            captureHook(context, node, "_disable")
        ) {
            return [];
        }
        // `const state = getState(engine)`: the coordinator record, created
        // on first use.
        const [local] = ts.isVariableStatement(node)
            ? node.declarationList.declarations
            : [];
        if (
            local &&
            ts.isIdentifier(local.name) &&
            local.name.text === "state"
        ) {
            context.assertStatementShapes(
                node,
                [node],
                "const state = getState(engine);",
                "Recovery coordinator state",
            );
            lowerer.bindPorts(stateMembers("state", "state"), node);
            return [
                `${indent}Engine::DeviceRecoveryState& state = recovery_state(engine);`,
            ];
        }
        // The first registration records the device's features for the
        // replacement request; the PAL recreates its own device with the
        // features it was built for.
        if (
            ts.isIfStatement(node) &&
            context.expressionMatchesShape(
                node.expression,
                "registrations.length === 0",
            )
        ) {
            context.assertStatementShapes(
                node,
                [node],
                "if (registrations.length === 0) { state._requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[]; }",
                "Recovery device features",
            );
            return [];
        }
        // `let disabled = false`: the handle's own flag, on its record.
        if (
            local &&
            ts.isIdentifier(local.name) &&
            local.name.text === "disabled"
        ) {
            context.assertStatementShapes(
                node,
                [node],
                "let disabled = false;",
                "Recovery handle enabled state",
            );
            lowerer.bindPorts(
                [
                    [
                        "disabled",
                        {
                            cpp: "registration->disabled",
                            type: "bool",
                        },
                    ],
                ],
                local,
            );
            return [
                `${indent}registration->engine = &engine;`,
                `${indent}registration->disabled = false;`,
            ];
        }
        return undefined;
    };
    const engine: PinnedFunctionParameter = {
        pinned: "engine",
        kind: "record",
        cpp: "engine",
        cppType: "Engine",
        annotation: "EngineContext",
        mutableRecord: true,
        binding: { cpp: "engine", type: "opaque" },
    };
    const enable = lowerPinnedFunctionParts(
        context,
        recoveryModule,
        "_enableDeviceLostRecovery",
        [
            engine,
            {
                pinned: "registration",
                kind: "record",
                cpp: "registration",
                cppType: "std::shared_ptr<DeviceRecoveryRegistration>",
                annotation: "DeviceLostRecoveryRegistration",
                binding: { cpp: "registration", type: "opaque" },
            },
        ],
        {
            cppName: "enable_device_lost_recovery",
            returns: {
                type: "std::shared_ptr<DeviceRecoveryRegistration>",
                value: (_lowerer, expression) => {
                    const handle = expression
                        ? context.unwrapExpression(expression)
                        : undefined;
                    if (
                        !handle ||
                        !ts.isObjectLiteralExpression(handle) ||
                        handle.properties
                            .map((property) =>
                                property.name
                                    ? propertyName(property.name)
                                    : undefined,
                            )
                            .join() !== "disable"
                    ) {
                        return context.contractError(
                            expression ?? declaration,
                            "Expected _enableDeviceLostRecovery to return a handle whose one member is disable.",
                        );
                    }
                    return "registration";
                },
            },
            ...coordinatorScope(context, { statement }),
        },
    );
    // The handle's `disable()`, over the registration it closes on.
    const handle = context.findNodes(
        declaration,
        (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) &&
            propertyName(node.name) === "disable",
    )[0];
    if (!handle?.body) {
        return context.contractError(
            declaration,
            "Expected the recovery handle's disable().",
        );
    }
    const { memberBindings, ...disableScope } = coordinatorScope(context, {
        bindings: [
            ["disabled", { cpp: "registration->disabled", type: "bool" }],
            [
                "registrations",
                {
                    cpp: "recovery_state(*registration->engine).registrations",
                    type: "opaque",
                },
            ],
            ["registration", { cpp: "registration", type: "opaque" }],
        ],
        statement,
    });
    const disable = lowerPinnedBody(file, handle.body.statements, {
        ...disableScope,
        bindings: memberBindings,
    });
    return `// ${enable.provenance}
${enable.declaration} {
${enable.body}
}

// ${context.provenance(recoveryModule, "_enableDeviceLostRecovery", "the handle's disable")}
void disable_device_recovery(const std::shared_ptr<DeviceRecoveryRegistration>& registration) {
${disable}
}`;
}

/**
 * `enableDeviceLostSceneRecovery`: the scene strategy's registration. Its
 * callbacks are the options the compiler writes onto the record once the
 * scene's own functions are declared; its kind is the one native recovery
 * rebuilds.
 */
function sceneRecoveryCpp(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        sceneModule,
        "enableDeviceLostSceneRecovery",
    );
    const [statement] = declaration.body!.statements;
    const call =
        statement && ts.isReturnStatement(statement) && statement.expression
            ? context.unwrapExpression(statement.expression)
            : undefined;
    const literal =
        call &&
        ts.isCallExpression(call) &&
        context.expressionMatchesShape(
            call.expression,
            "_enableDeviceLostRecovery",
        )
            ? call.arguments[1]
            : undefined;
    const members =
        literal && ts.isObjectLiteralExpression(literal)
            ? new Map(
                  literal.properties.map((property) => [
                      property.name ? (propertyName(property.name) ?? "") : "",
                      property,
                  ]),
              )
            : undefined;
    const kind = members?.get("_kind");
    // The compiler writes each option callback onto the member of the same
    // name, and supplies none the scene did not pass.
    const callbacks = ["onLost", "onRecovered", "onRecoveryFailed"].every(
        (option) => {
            const member = members?.get(`_${option}`);
            return (
                member !== undefined &&
                ts.isPropertyAssignment(member) &&
                context.expressionMatchesShape(
                    member.initializer,
                    `options.${option}`,
                )
            );
        },
    );
    const options = declaration.parameters[1];
    if (
        !callbacks ||
        !options ||
        !ts.isIdentifier(options.name) ||
        options.name.text !== "options" ||
        !options.initializer ||
        !context.expressionMatchesShape(options.initializer, "{}") ||
        declaration.body!.statements.length !== 1 ||
        !members ||
        !kind ||
        !ts.isPropertyAssignment(kind) ||
        !ts.isStringLiteral(kind.initializer) ||
        kind.initializer.text !== "scene" ||
        [...members.keys()].join() !==
            "_kind,_recoverOrder,_enable,_disable,_recover,_onLost,_onRecovered,_onRecoveryFailed"
    ) {
        return context.contractError(
            declaration,
            "Expected enableDeviceLostSceneRecovery to register the scene strategy: its kind, order, " +
                "capture hooks, rebuild and the three option callbacks.",
        );
    }
    return `// ${context.provenance(sceneModule, "enableDeviceLostSceneRecovery")}
std::shared_ptr<DeviceRecoveryRegistration> enable_device_lost_scene_recovery(Engine& engine) {
    if (engine.device_recovery && engine.device_recovery->disposed)
        throw std::runtime_error("Cannot register recovery on a disposed engine.");
    auto registration = std::make_shared<DeviceRecoveryRegistration>();
    registration->kind = ${stringLiteral(kind.initializer.text)};
    return enable_device_lost_recovery(engine, registration);
}`;
}

/** The pin's recoverability check reads the registered contexts' own kinds. */
function contextKindAssertionCpp(context: LoweringContext): string {
    const assertion = lowerPinnedFunctionParts(
        context,
        runModule,
        "assertEveryActiveContextKindIsRecoverable",
        [
            {
                pinned: "engine",
                kind: "record",
                cpp: "engine",
                cppType: "Engine",
                annotation: "EngineContext",
                binding: { cpp: "engine", type: "opaque" },
            },
            {
                pinned: "handlers",
                kind: "record",
                cpp: "handlers",
                cppType:
                    "std::vector<std::shared_ptr<DeviceRecoveryRegistration>>",
                annotation:
                    "ReadonlyMap<string, DeviceLostRecoveryRegistration>",
                binding: { cpp: "handlers", type: "opaque" },
            },
        ],
        {
            cppName: "assert_every_active_context_kind_is_recoverable",
            returns: "void",
            forOf: (iterated, element) => {
                if (iterated === "engine.surfaces") {
                    return {
                        range: "std::views::single(&engine)",
                        bindings: new Map([
                            [element, { cpp: element, type: "opaque" }],
                        ]),
                    };
                }
                if (iterated.endsWith("._renderingContexts")) {
                    return {
                        range: `${iterated.slice(0, -"._renderingContexts".length)}->rendering_contexts`,
                        bindings: new Map([
                            [
                                `${element}._kind`,
                                { cpp: `${element}.kind`, type: "string" },
                            ],
                        ]),
                    };
                }
                return undefined;
            },
            methods: new Map([
                [
                    "has",
                    (receiver: string, args: readonly string[]) =>
                        `std::ranges::any_of(${receiver}, [&](const auto& registration) { return registration->kind == ${args[0]}; })`,
                ],
            ]),
        },
    );
    return `// ${assertion.provenance}
static ${assertion.declaration} {
${assertion.body}
}`;
}

/** `markNextDeviceLossForRecovery` and `forceWebGpuDeviceLossForTesting`. */
function forcedLossCpp(context: LoweringContext): string {
    const mark = lowerPinnedFunctionParts(
        context,
        recoveryModule,
        "markNextDeviceLossForRecovery",
        [
            {
                pinned: "engine",
                kind: "record",
                cpp: "engine",
                cppType: "Engine",
                annotation: "EngineContext",
                mutableRecord: true,
                binding: { cpp: "engine", type: "opaque" },
            },
        ],
        {
            cppName: "mark_next_device_loss_for_recovery",
            returns: {
                type: "bool",
                value: (lowerer, expression) =>
                    expression
                        ? lowerer.expression(expression)
                        : context.contractError(
                              context.functionDeclaration(
                                  recoveryModule,
                                  "markNextDeviceLossForRecovery",
                              ).declaration,
                              "Expected markNextDeviceLossForRecovery to return its answer.",
                          ),
            },
            ...coordinatorScope(context, {
                bindings: [
                    // `engine._deviceLostRecovery`, absent until the first
                    // registration creates it: `state?._registrations.length`
                    // is then undefined, which the pin's `!!` reads as zero.
                    ...stateMembers(
                        "engine._deviceLostRecovery",
                        "(*engine.device_recovery)",
                    ),
                    [
                        "state?._registrations.length",
                        scalar(
                            "(engine.device_recovery ? static_cast<double>(engine.device_recovery->registrations.size()) : 0.0)",
                        ),
                    ],
                ],
            }),
        },
    );
    const force = lowerPinnedFunctionParts(
        context,
        testingModule,
        "forceWebGpuDeviceLossForTesting",
        [
            {
                pinned: "engine",
                kind: "record",
                cpp: "engine",
                cppType: "Engine",
                annotation: "EngineContext",
                mutableRecord: true,
                binding: { cpp: "engine", type: "opaque" },
            },
        ],
        {
            cppName: "force_web_gpu_device_loss_for_testing",
            returns: "void",
            ...coordinatorScope(context, {
                calls: [
                    [
                        "markNextDeviceLossForRecovery",
                        (args: readonly string[]) =>
                            `mark_next_device_loss_for_recovery(${args.join(", ")})`,
                    ],
                ],
                // `engine._device.destroy()`: the PAL tears the device down
                // at the frame boundary and delivers the loss.
                statement: (node, _lowerer, indent) =>
                    ts.isExpressionStatement(node) &&
                    context.expressionMatchesShape(
                        node.expression,
                        "engine._device.destroy()",
                    )
                        ? [`${indent}engine.renderer_restart_requested = true;`]
                        : undefined,
            }),
            callShapes: new Map([
                ["markNextDeviceLossForRecovery", "bool" as const],
            ]),
        },
    );
    return `// ${mark.provenance}
${mark.declaration} {
${mark.body}
}

// ${force.provenance}
${force.declaration} {
${force.body}
}`;
}

/**
 * storage-buffer-recovery.ts `rebuildCpuStorageBuffers` over the native
 * storage records. A shadowed allocation is CPU-authoritative, so the one the
 * native storage device kept already holds what the pin rebuilds from its
 * shadow; a GPU-role allocation has no shadow and loses its handle, which
 * every update, binding and readback then refuses as the pin does.
 */
function storageRecoveryCpp(context: LoweringContext): string {
    const module = "src/resource/storage-buffer-recovery.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "rebuildCpuStorageBuffers",
    );
    const loop = declaration.body!.statements[0];
    if (
        declaration.body!.statements.length !== 1 ||
        !loop ||
        !ts.isForOfStatement(loop)
    )
        return context.contractError(
            declaration,
            "Expected one pass over the registered storage buffers.",
        );
    context.assertExpressionShape(
        loop.expression,
        "engine._storageBuffers ?? []",
        "Registered storage buffers",
    );
    const body = lowerPinnedBody(
        file,
        ts.isBlock(loop.statement)
            ? loop.statement.statements
            : [loop.statement],
        {
            bindings: new Map([
                ["buffer._destroyed", { cpp: "record.disposed", type: "bool" }],
                ["buffer._data", { cpp: "record.has_shadow", type: "bool" }],
            ]),
            calls: new Map(),
            statement(node, lowerer, indent) {
                if (
                    ts.isExpressionStatement(node) &&
                    ts.isBinaryExpression(node.expression) &&
                    context.expressionMatchesShape(
                        node.expression.left,
                        "buffer._buffer",
                    )
                ) {
                    const allocation = node.expression.right;
                    context.assertExpressionShape(
                        allocation,
                        "buffer._data ? createMappedBuffer(engine, buffer._data, BU.STORAGE, buffer._label) : null",
                        "Storage recovery allocation",
                    );
                    // The shadowed arm's re-upload is the native rebuild of
                    // every retained allocation; the other loses its handle.
                    const shadowed = lowerer.expression(
                        (allocation as ts.ConditionalExpression).condition,
                    );
                    return [
                        `${indent}if (!(${shadowed}) && record.gpu) record.gpu->allocation.reset();`,
                    ];
                }
                return undefined;
            },
        },
        "        ",
    );
    return `// ${context.provenance(module, "rebuildCpuStorageBuffers")}
static void rebuild_cpu_storage_buffers(Engine& engine) {
    for (auto& record : engine.storage_buffers) {
        if (!record.registered) continue;
${body}
    }
}`;
}

export function lowerDeviceRecovery(
    context: LoweringContext,
    thinBindings = false,
): LoweredSource {
    assertDeviceRecoveryContracts(context);
    return {
        modulePath: recoveryModule,
        symbolName:
            "_enableDeviceLostRecovery,arm,markNextDeviceLossForRecovery,forceWebGpuDeviceLossForTesting,enableDeviceLostSceneRecovery",
        header: "",
        source: `
// ${context.provenance(recoveryModule, "_enableDeviceLostRecovery, arm")}
// Native device recreation replays generated upload/composition products over retained CPU owners.
#include <bblite/runtime.hpp>
#include <bblite/pal.hpp>
#include <bblite/js_data.hpp>
#include <bblite/mesh_cpu_streams.hpp>
#include <bblite/mesh_vertex_packing.hpp>
#include <algorithm>
#include <iostream>
#include <ranges>
#include <string>
#include <vector>

namespace bbl {
static Engine::DeviceRecoveryState& recovery_state(Engine& engine) {
    if (!engine.device_recovery) engine.device_recovery = std::make_shared<Engine::DeviceRecoveryState>();
    return *engine.device_recovery;
}
${armCpp(context)}

${continuationsCpp(context)}

${registrationCpp(context)}

${sceneRecoveryCpp(context)}

${storageRecoveryCpp(context)}

${forcedLossCpp(context)}

${contextKindAssertionCpp(context)}

${lowerRetainedMeshRecovery(context)}

void force_device_loss(Engine& engine) {
    // A disposed engine rebuilds nothing, and one recovery at a time runs
    // natively: both refuse before the pin's own gate.
    if (engine.device_recovery && engine.device_recovery->disposed)
        throw std::runtime_error("Device recovery cannot run on a disposed engine.");
    if (engine.device_recovery && (engine.device_recovery->requested || engine.device_recovery->recovering))
        throw std::runtime_error("A device-loss recovery is already in flight.");
    force_web_gpu_device_loss_for_testing(engine);
}
void begin_device_recovery(Engine& engine) {
    auto& state = recovery_state(engine);
    device_lost(engine, state);
    // A loss the armed handler declined leaves the pin's device lost; the
    // native run does not carry on over it.
    if (!state.recovering) {
        state.requested = false;
        throw std::runtime_error("The GPU device was lost with no armed recovery to rebuild it.");
    }
    ${thinBindings ? "assert_thin_instance_device_recovery_supported(engine);" : ""}
    // runDeviceLostRecovery: the PAL recreates its device over retained owners.
    state.resources_ready = false;
    const bool was_running = !engine.stopped;
    engine.stopped = true;
    assert_every_active_context_kind_is_recoverable(engine, state.in_flight);
    state.environments.clear(); state.shadows.clear(); state.renderable_counts.clear(); state.fallback = {};
    ++engine.device_generation;
    rebuild_cpu_storage_buffers(engine);
    ${shaderUniformRecoveryReset(context)}
    recover_retained_meshes(engine);
    ${shaderUniformRecoveryPublication(context, thinBindings)}
    engine.stopped = !was_running;
}
void complete_device_recovery(Engine& engine) {
    if (!engine.device_recovery) return;
    auto& state = *engine.device_recovery;
    if (!state.recovering || !state.resources_ready) return;
    if (pal::environment_variable("BBLITE_RUNTIME_TRACE") == "1") {
        std::cerr << "[bblite trace] recovery generation=" << engine.device_generation << " draws=" << engine.draw_call_count << '\\n';
    }
    device_recovered(engine, state);
    state.in_flight.clear();
}
void fail_device_recovery(Engine& engine, const std::string& error) {
    auto& state = recovery_state(engine);
    state.requested = false;
    state.resources_ready = false;
    engine.stopped = true;
    device_recovery_failed(engine, state, error);
    state.in_flight.clear();
}
void add_gpu_error_listener(GpuDeviceIdentity device, std::function<void(const std::string&)> listener) {
    if (!device.engine) throw std::runtime_error("Invalid GPU device identity.");
    recovery_state(*device.engine).error_listeners[device.generation].push_back(std::move(listener));
}
void report_gpu_error(Engine& engine, const std::string& error) {
    if (!engine.device_recovery) return;
    const auto found = engine.device_recovery->error_listeners.find(engine.device_generation);
    if (found == engine.device_recovery->error_listeners.end()) return;
    const auto listeners = found->second;
    for (const auto& listener : listeners) listener(error);
}
EnvironmentIdentity environment_identity(const Scene& scene) {
    return {scene.engine, scene.state, scene.state->environment_identity};
}
GpuTextureIdentity environment_texture_identity(const EnvironmentIdentity& environment) {
    if (!environment.engine || !environment.engine->device_recovery) throw std::runtime_error("Environment GPU resource has not been published.");
    return environment.engine->device_recovery->environments.at(environment.scene.get());
}
GpuTextureIdentity fallback_texture_identity(const Engine& engine) {
    if (!engine.device_recovery || !engine.device_recovery->fallback.object) throw std::runtime_error("PBR fallback GPU resource has not been published.");
    return engine.device_recovery->fallback;
}
GpuTextureIdentity shadow_texture_identity(const Engine& engine, ShadowGeneratorHandle shadow) {
    if (!engine.device_recovery) throw std::runtime_error("Shadow GPU resource has not been published.");
    return engine.device_recovery->shadows.at(shadow.value);
}
std::size_t scene_renderable_count(const Scene& scene) {
    if (!scene.engine || !scene.engine->device_recovery) throw std::runtime_error("Scene renderables have not been published.");
    return scene.engine->device_recovery->renderable_counts.at(scene.state.get());
}
void set_global_callback(Engine& engine, std::string key, std::function<void()> callback) {
    recovery_state(engine).globals[std::move(key)] = std::move(callback);
}
} // namespace bbl
`,
    };
}
