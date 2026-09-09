import { EmissionSet } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { isPinnedType, pinnedHandleKind } from "./data-types.js";
import { isAssignmentExpression, isUpdateExpression } from "./syntax.js";

interface Context
    extends Pick<LoweringServices,
        | "checker"
        | "symbols"
        | "unwrap"
        | "knownValueWithoutEvaluation"
        | "isDefaultLibraryIdentifier"
        | "noteNodeGeometryMutation"
    > {}

const transforms = new EmissionSet(["position", "rotation", "rotationQuaternion", "scaling", "parent", "_localMatrix"]);

/** Observe writer ownership without compiling or evaluating a speculative receiver. */
export function checkNodeGeometryMutation(context: Context, expression: ts.Expression): void {
    const unprovenMesh = (expression: ts.Expression): boolean => {
        const value = context.knownValueWithoutEvaluation(expression);
        if (value) {
            if (value.kind === "asset-root" || value.kind === "scene-node") return true;
            if (value.kind === "mesh") return value.sceneMeshIndex === undefined && value.sceneMeshProfileIndex === undefined;
            if (value.kind === "transform-node") return false;
        }
        const kind = pinnedHandleKind(context.checker.getNonNullableType(context.checker.getTypeAtLocation(expression)));
        return kind === "mesh" || kind === "scene-node";
    };
    const importedVector = (expression: ts.Expression): boolean => {
        const node = context.unwrap(expression);
        const value = context.knownValueWithoutEvaluation(node);
        if (value?.cameraVector) return false;
        if (value?.sceneNodeVector) {
            const owner = value.sceneNodeVector.owner;
            return owner.kind === "scene-node" || (owner.kind === "mesh" && owner.sceneMeshIndex === undefined && owner.sceneMeshProfileIndex === undefined);
        }
        if (ts.isPropertyAccessExpression(node) && transforms.has(node.name.text)) return unprovenMesh(node.expression);
        // Once an observable vector loses its source owner in a typed
        // aggregate, mutation cannot prove that it addresses a local mesh.
        return !value && isPinnedType(context.checker.getTypeAtLocation(node), ["ObservableVec3", "ObservableQuaternion"]);
    };
    const node = context.unwrap(expression);
    const assignment = isAssignmentExpression(node);
    const increment = isUpdateExpression(node);
    const target = assignment ? node.left : increment ? node.operand : ts.isDeleteExpression(node) ? node.expression : undefined;
    if (target) {
        const left = context.unwrap(target);
        if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
            const name = ts.isPropertyAccessExpression(left) ? left.name.text :
                ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : undefined;
            if (importedVector(left.expression) || (name !== undefined && transforms.has(name) && unprovenMesh(left.expression))) {
                context.noteNodeGeometryMutation(node);
            }
        }
    }
    if (!ts.isCallExpression(node)) return;
    const callee = context.unwrap(node.expression);
    if (ts.isIdentifier(callee) && ["cloneTransformNode", "setParent"].includes(context.symbols.importedName(callee) ?? "") &&
        node.arguments[0] && unprovenMesh(node.arguments[0])) context.noteNodeGeometryMutation(node);
    if (!ts.isPropertyAccessExpression(callee)) return;
    if (callee.name.text === "set" && importedVector(callee.expression)) context.noteNodeGeometryMutation(node);
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && context.isDefaultLibraryIdentifier(callee.expression) &&
        ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(callee.name.text) && node.arguments[0] &&
        (unprovenMesh(node.arguments[0]) || importedVector(node.arguments[0]))) context.noteNodeGeometryMutation(node);
}
