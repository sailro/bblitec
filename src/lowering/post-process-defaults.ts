/**
 * The pin's post-process parameter defaults, read where each effect's
 * factory states them.
 *
 * `post-process-effects.ts` names each scalar an effect's `writeUniforms`
 * reads; the value a slot starts from is the pin's, folded here once per
 * process. A config option's default is its `config.<option> ?? <default>`
 * (or the module's own coercer, `clampThreshold(config.threshold, 0.05)`),
 * a task-owned slot's is the `task` record's initializer, and a slot the
 * pass refreshes from its source (`runtime`) starts from the `params`
 * record's initializer. A slot the pin gives no such default refuses.
 */
import ts from "typescript";
import {
    slotOption,
    type PostProcessEffect,
    type PostProcessParamSlot,
} from "../post-process-effects.js";
import { sharedUpstreamStore } from "../upstream-source.js";
import { LoweringContext } from "./context.js";

/** A default as the pin states it: a number, or a flag's keyword. */
type PostProcessDefault = number | boolean;

/** Where an effect row's factory body is: its module and declaring function. */
type EffectSite = Pick<
    PostProcessEffect,
    "intrinsic" | "module" | "declaredIn"
>;

/** A slot as the table names it, before its default is read. */
type SlotSite = Pick<PostProcessParamSlot, "path" | "owner" | "runtime">;

let shared: LoweringContext | undefined;

const derived = new Map<string, PostProcessDefault>();

/**
 * The `config.<option>` defaults one factory body states: every
 * `config.<option> ?? <default>`, then every call of one of the module's
 * OWN two-argument helpers whose first argument is `config.<option>` --
 * SMAA runs three settings through `clampThreshold` and its siblings, whose
 * second argument is the value used when the caller supplied nothing
 * usable. The callee has to be the module's own: on arity alone this would
 * equally read `Math.max(config.threshold, 0)` as a default.
 */
function configDefaults(
    context: LoweringContext,
    file: ts.SourceFile,
    declaration: ts.FunctionDeclaration,
): ReadonlyMap<string, ts.Expression> {
    const fallbacks = new Map<string, ts.Expression>();
    for (const node of context.findNodes(
        declaration,
        (candidate): candidate is ts.BinaryExpression =>
            ts.isBinaryExpression(candidate) &&
            candidate.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken,
    )) {
        const path = context.propertyPath(node.left);
        if (path?.[0] === "config" && path.length === 2) {
            fallbacks.set(path[1]!, context.unwrapExpression(node.right));
        }
    }
    const moduleHelpers = new Set(
        file.statements
            .filter(ts.isFunctionDeclaration)
            .map((fn) => fn.name?.text)
            .filter((name): name is string => name !== undefined),
    );
    for (const node of context.findNodes(
        declaration,
        (candidate): candidate is ts.CallExpression =>
            ts.isCallExpression(candidate) &&
            candidate.arguments.length === 2 &&
            ts.isIdentifier(candidate.expression) &&
            moduleHelpers.has(candidate.expression.text),
    )) {
        const path = context.propertyPath(node.arguments[0]!);
        if (
            path?.[0] === "config" &&
            path.length === 2 &&
            !fallbacks.has(path[1]!)
        ) {
            fallbacks.set(
                path[1]!,
                context.unwrapExpression(node.arguments[1]!),
            );
        }
    }
    return fallbacks;
}

/** The expression the pin starts one slot from. */
function defaultSite(
    context: LoweringContext,
    effect: EffectSite,
    slot: SlotSite,
): { expression: ts.Expression; file: ts.SourceFile } {
    const { file, declaration } = context.functionDeclaration(
        effect.module,
        effect.declaredIn ?? effect.intrinsic,
    );
    if (slot.owner === "task" || slot.runtime) {
        return {
            expression: context.propertyInitializer(
                context.objectInitializer(
                    declaration,
                    slot.owner === "task" ? "task" : "params",
                ),
                slot.path,
            ),
            file,
        };
    }
    const { option, component } = slotOption(slot);
    const found = configDefaults(context, file, declaration).get(option);
    if (!found) {
        context.contractError(
            declaration,
            `Expected ${effect.intrinsic} to default '${option}'.`,
        );
    }
    if (!component) return { expression: found, file };
    // A vector option defaults as a whole object, so the component
    // fallback is read out of that object rather than off the option.
    if (!ts.isObjectLiteralExpression(found)) {
        context.contractError(
            found,
            `Expected ${effect.intrinsic} to default '${option}' with an object literal.`,
        );
    }
    return {
        expression: context.propertyInitializer(found, component),
        file,
    };
}

/**
 * The pin's default for one slot of one effect row: a flag as the keyword
 * the pin writes, anything else folded to a number.
 */
export function pinnedPostProcessDefault(
    effect: EffectSite,
    slot: SlotSite,
): PostProcessDefault {
    const key = [
        effect.module,
        effect.declaredIn ?? effect.intrinsic,
        slot.owner ?? "",
        slot.path,
    ].join("#");
    const cached = derived.get(key);
    if (cached !== undefined) return cached;
    const reader = (shared ??= new LoweringContext(sharedUpstreamStore()));
    const { expression, file } = defaultSite(reader, effect, slot);
    const unwrapped = reader.unwrapExpression(expression);
    const value =
        unwrapped.kind === ts.SyntaxKind.TrueKeyword
            ? true
            : unwrapped.kind === ts.SyntaxKind.FalseKeyword
              ? false
              : reader.numericValue(unwrapped, file);
    derived.set(key, value);
    return value;
}
