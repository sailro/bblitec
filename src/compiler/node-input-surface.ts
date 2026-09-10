import type { LoweringServices } from "./lowering-services.js";
/** Public node inputs retain their source slot; graphs alone are deduplicated. */
/** Public node inputs retain their source slot; graphs alone are deduplicated. */
import ts from "typescript";
import { isPinnedType, pinnedHandleKind, type DataType } from "./data-types.js";
import { isAssignmentExpression, isUpdateExpression } from "./syntax.js";
import type { Value } from "./types.js";

const textureType: DataType = { kind: "optional", inner: { kind: "handle", handle: "texture" } };

interface NodeInputContext
    extends Pick<LoweringServices,
        | "checker"
        | "unwrap"
        | "compileValue"
        | "lookupOptional"
        | "allocateTemporaryCppName"
        | "emit"
        | "dataLowerer"
        | "fail"
        | "reachFeature"
        | "reachJsData"
        | "assertNodeInputMutable"
        | "noteNodeInputAdmissionFailure"
        | "isDefaultLibraryIdentifier"
    > {}

export function readNodeInputProperty(context: NodeInputContext, owner: Value, name: string, site: ts.Node): Value | undefined {
    if (owner.kind === "material" && name === "inputs") {
        context.reachFeature("material:node-inputs", site);
        context.reachJsData();
        return { kind: "data", cpp: `bbl::node_material_inputs(${owner.engineCpp}, ${owner.cpp})`,
            dataType: { kind: "map", key: { kind: "string" }, value: { kind: "handle", handle: "node-input" } }, freshData: true };
    }
    if (owner.kind !== "node-input") return undefined;
    context.reachFeature("material:node-inputs", site);
    context.reachJsData();
    if (name === "texture") return { kind: "data", cpp: `bbl::node_input_texture(${owner.cpp})`, dataType: textureType, freshData: true };
    if (name === "type") return { kind: "string", cpp: `bbl::node_input_type(${owner.cpp})`, dataType: { kind: "string" }, freshData: true };
    context.fail(site, `Node input '${name}' requires live numeric uniform storage that is not represented; only texture2d handles are supported.`);
}

function isInput(context: NodeInputContext, expression: ts.Expression): boolean {
    const node = context.unwrap(expression);
    if (ts.isIdentifier(node) && context.lookupOptional(node)?.kind === "node-input") return true;
    return pinnedHandleKind(context.checker.getNonNullableType(context.checker.getTypeAtLocation(node))) === "node-input";
}

function isInputMap(context: NodeInputContext, expression: ts.Expression): boolean {
    const type = context.checker.getTypeAtLocation(context.unwrap(expression)).getStringIndexType();
    return type !== undefined && pinnedHandleKind(context.checker.getNonNullableType(type)) === "node-input";
}

export function compileNodeInputMutation(context: NodeInputContext, expression: ts.Expression): Value | undefined {
    const node = context.unwrap(expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" &&
        context.isDefaultLibraryIdentifier(node.expression.expression) &&
        ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(node.expression.name.text) &&
        node.arguments[0]) {
        const target = node.arguments[0];
        const type = context.checker.getTypeAtLocation(target);
        if (isPinnedType(type, ["Texture2D"])) {
            context.noteNodeInputAdmissionFailure(node, "Node input bindings do not represent reflective texture producer mutation.");
        }
        if (isInput(context, target) || isInputMap(context, target) || isPinnedType(type, ["NodeMaterial"])) {
            context.fail(node, "Reflective node input mutation is not represented.");
        }
    }
    const assignment = isAssignmentExpression(node) ? node : undefined;
    const increment = isUpdateExpression(node) ? node : undefined;
    const target = assignment?.left ?? increment?.operand ?? (ts.isDeleteExpression(node) ? node.expression : undefined);
    if (!target) return undefined;
    const left = context.unwrap(target);
    if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return undefined;
    if (isInputMap(context, left.expression)) context.fail(left, "Node input map replacement is not represented; retain and assign the texture2d handle instead.");
    if (!isInput(context, left.expression)) return undefined;
    if (!assignment || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(left) || left.name.text !== "texture") {
        context.fail(left, "Node inputs support direct texture assignment only; numeric uniforms and computed mutation are not represented.");
    }
    context.assertNodeInputMutable(node);
    context.reachFeature("material:node-inputs", node);
    context.reachJsData();
    const owner = context.allocateTemporaryCppName("node_input");
    context.emit({ kind: "declaration", type: "const bbl::NodeInputHandle", name: owner, initializer: context.dataLowerer.compileForSink(left.expression, { kind: "handle", handle: "node-input" }) });
    const texture = context.dataLowerer.compileForSink(assignment.right, textureType);
    return { kind: "data", cpp: `bbl::set_node_input_texture(${owner}, ${texture})`, dataType: textureType, freshData: true };
}
