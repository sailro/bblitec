import ts from "typescript";
import { passSuffix, type ComposedComposite } from "../pinned-post-process.js";
import { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";

const MODULE = "src/post-process/taa.ts";
const FACTORY = "createTaaPostProcessTask";
const stateFields = [
    ["factor", "factor"],
    ["disableOnCameraMove", "disable_on_camera_move"],
    ["_firstUpdate", "first_update"],
    ["_lastCamVer", "last_camera_version"],
    ["_haltonIndex", "halton_index"],
] as const;

/**
 * The pinned lifecycle over task-owned scalar state. Device operations stay
 * synchronous callbacks, preserving the stores before/after a failed upload,
 * pass or jitter write. Callbacks are borrowed for this invocation only.
 */
export class TaaPostProcessLowerer {
    constructor(private readonly context: LoweringContext, private readonly composite: ComposedComposite) {
        if (composite.intrinsic !== FACTORY) throw new Error("TAA lifecycle requires the pinned TAA composite.");
    }

    private bindings(): Map<string, PinnedBinding> {
        return new Map<string, PinnedBinding>([
            ...stateFields.map(([pinned, native]): [string, PinnedBinding] => [
                `task.${pinned}`, { cpp: `state.${native}`,
                    type: pinned === "disableOnCameraMove" || pinned === "_firstUpdate" ? "bool" : "scalar" },
            ]),
            ["task", { cpp: "state", type: "opaque" }],
            ["task._factor", { cpp: "blend_factor", type: "scalar" }],
        ]);
    }

    private method(name: string) {
        return this.context.propertyFunction(MODULE, FACTORY, name, { unique: true });
    }

    /** Child names come from the facade's own retained references. */
    private children(): { name: string; index: number }[] {
        const { declaration } = this.context.functionDeclaration(MODULE, FACTORY);
        const task = this.context.objectInitializer(declaration, "task");
        return [["_blend", "-blend"], ["_present", "-present"], ["_historyUpdate", "-history-update"]].map(([property, suffix]) => {
            const child = this.context.propertyInitializer(task, property!);
            if (!ts.isIdentifier(child)) this.context.contractError(child, "Expected a retained TAA child task.");
            const index = this.composite.passes.findIndex((pass) => passSuffix(pass.name) === suffix);
            if (index < 0) this.context.contractError(child, `TAA child '${property}' was not observed.`);
            return { name: child.text, index };
        });
    }

    private initialize(): string {
        const { file, declaration } = this.context.functionDeclaration(MODULE, FACTORY);
        const task = this.context.objectInitializer(declaration, "task");
        const lowerer = new PinnedNumericLowerer(file, { bindings: new Map([
            ["config.factor", { cpp: "factor", type: "scalar" }],
            ["config.disableOnCameraMove", { cpp: "disable_on_camera_move", type: "bool" }],
        ]), calls: new Map() });
        return `inline TaaPostProcessState create_taa_post_process_state(double factor, bool disable_on_camera_move) {
    return TaaPostProcessState{${stateFields.map(([field]) =>
        lowerer.expression(this.context.propertyInitializer(task, field))).join(", ")}};
}`;
    }

    private record(): string {
        const { file, declaration } = this.method("record");
        const children = this.children();
        // This resource prefix belongs to the PAL. Assert it as a whole so
        // an inserted operation cannot disappear behind the callback seam.
        const prefix = declaration.body.statements.slice(0, 6);
        const prefixFile = ts.createSourceFile(`${file.fileName}-record-resources`,
            `const record_resources = () => {${prefix.map((statement) => statement.getText(file)).join("\n")}};`,
            ts.ScriptTarget.Latest, true);
        const shape = this.context.variableInitializer(prefixFile, "record_resources");
        if (!this.context.expressionMatchesShape(shape, `() => {
            const { width: w, height: h } = resolveSourceSize(task.sourceTexture);
            ensurePersistentTarget(history, engine, w, h);
            ensurePersistentTarget(temp, engine, w, h);
            ${children.map((child) => `${child.name}.record();`).join("\n")}
        }`)) {
            this.context.contractError(declaration, "TAA record resource prefix changed; its PAL callback must be re-read.");
        }
        const lowerer = new PinnedNumericLowerer(file, { bindings: this.bindings(), calls: new Map() });
        const body = declaration.body.statements.slice(prefix.length)
            .flatMap((statement) => lowerer.statement(statement, "    ")).join("\n");
        return `template<class RecordResources>
void record_taa_post_process(TaaPostProcessState& state, RecordResources&& record_resources) {
    record_resources();
${body}
}`;
    }

    private execute(): string {
        const { file, declaration } = this.method("execute");
        const children = this.children();
        const bindings = this.bindings();
        bindings.set("task._sourceRenderTask.scene.camera", {
            cpp: "camera", type: "opaque", absentCpp: "camera == nullptr",
        });
        const calls = new Map<string, (args: readonly string[]) => string>([
            ["_cameraChangeKey", (args) => `camera_key(${args.join(", ")})`],
            [`${children[0]!.name}.updateUniforms`, (args) => {
                if (args.length !== 0) this.context.contractError(declaration, "TAA blend upload gained arguments.");
                return `upload_uniforms(${children[0]!.index}u)`;
            }],
            ["advanceJitter", (args) => `advance_jitter(${args.join(", ")})`],
        ]);
        const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
            bindings, calls, booleanOr: true, booleanAnd: true,
            returnValue: (expression) => expression ? lowerer.expression(expression)
                : this.context.contractError(declaration, "TAA execute must return its draw count."),
        });
        for (const child of children) {
            const call = `${child.name}.execute?.()`;
            const sites = this.context.findNodes(declaration, (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
                this.context.expressionMatchesShape(node.left, call));
            if (sites.length !== 1) this.context.contractError(declaration, `Expected one optional '${call}' result.`);
            // The callback can represent an absent execute method. Its
            // fallback is lowered from the source, not supplied by native.
            bindings.set(sites[0]!.getText(file), { cpp: `([&]() { const auto draws = execute_pass(${child.index}u); return draws ? *draws : ${lowerer.expression(sites[0]!.right)}; }())`, type: "scalar" });
        }
        const body = declaration.body.statements.flatMap((statement) => lowerer.statement(statement, "    ")).join("\n");
        return `template<class Camera, class CameraKey, class UploadUniforms, class ExecutePass, class AdvanceJitter>
double execute_taa_post_process(TaaPostProcessState& state, double& blend_factor,
    Camera* camera, CameraKey&& camera_key, UploadUniforms&& upload_uniforms,
    ExecutePass&& execute_pass, AdvanceJitter&& advance_jitter) {
${body}
}`;
    }

    private leafDrawCount(): string {
        const module = "src/frame-graph/post-process-task.ts";
        const { file, declaration } = this.context.propertyFunction(module, "createPostProcessTask", "execute", { unique: true });
        const last = declaration.body.statements.at(-1);
        if (!last || !ts.isReturnStatement(last) || !last.expression) this.context.contractError(declaration, "Post-process leaf needs a draw count.");
        const count = this.context.numericValue(last.expression, file);
        const parsed = ts.createSourceFile("post-process-leaf.ts", `const body = () => ${declaration.body.getText(file)}`, ts.ScriptTarget.Latest, true);
        this.context.assertExpressionShape(this.context.variableInitializer(parsed, "body"), `() => {
            applyColorAttachmentState(task._colorAttachment, task.outputTexture, task.clear);
            const pass = engine._currentEncoder!.beginRenderPass(task._renderPassDescriptor);
            applyViewport(pass, task.viewport, task.outputTexture);
            pass.setPipeline(task._pipeline!);
            pass.setBindGroup(0, task._bindGroup!);
            pass.draw(3);
            pass.end();
            return ${count};
        }`, "Deferred post-process leaf device operations");
        return `inline constexpr double post_process_leaf_draw_count() { return ${this.context.doubleLiteral(count)}; }`;
    }

    public header(): string {
        return `// ${this.context.provenance(MODULE, FACTORY, "record and execute")}
namespace bbl::upstream {
${this.leafDrawCount()}
${this.initialize()}

${this.record()}

${this.execute()}
} // namespace bbl::upstream
`;
    }
}
