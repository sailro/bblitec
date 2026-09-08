import ts from "typescript";
import type { LoweringContext } from "./context.js";

/** Inventory the factory and every input callback whose native representation is restated. */
export function assertRotationPointerContract(context: LoweringContext, factory: ts.FunctionDeclaration): ts.ArrowFunction & { body: ts.Block } {
    const statements = [...factory.body!.statements];
    const key = (statement: ts.Statement): string => {
        if (ts.isVariableStatement(statement)) return `var ${statement.declarationList.declarations.map(item => ts.isIdentifier(item.name) ? item.name.text : "binding").join(",")}`;
        if (ts.isIfStatement(statement)) return "if";
        if (ts.isReturnStatement(statement)) return "return";
        if (ts.isExpressionStatement(statement)) {
            const expression = statement.expression;
            if (ts.isCallExpression(expression)) return `call ${context.propertyPath(expression.expression)?.join(".")}`;
            if (ts.isBinaryExpression(expression)) {
                const left = expression.left;
                return `write ${ts.isElementAccessExpression(left) ? `${context.propertyPath(left.expression)?.join(".")}[]` : context.propertyPath(left)?.join(".")}`;
            }
        }
        return "unsupported";
    };
    context.assertStatementInventory(factory, statements, "createPlaneRotationGizmo", "factory state, geometry and registration retain order", [
        "var color", "var tessellation", "var thickness", "var utilityScene", "var materials", "var root",
        "write root.material", "write root.visible", "call addToScene", "var q", "call root.rotationQuaternion.set", "call root.scaling.set",
        "var ring", "write ring.material", "call ring.rotation.set", "write ring.parent", "call addToScene",
        "var collider", "write collider.material", "call collider.rotation.set", "write collider.visible", "write collider.parent", "call addToScene",
        "var rotationColor", "var rotationDisplayMaterial", "var rotationDisplayPlane", "write rotationDisplayPlane.material",
        "call rotationDisplayPlane.rotation.set", "write rotationDisplayPlane.visible", "write rotationDisplayPlane.pickable", "write rotationDisplayPlane.parent", "call addToScene",
        "var drag", "write drag._colliders", "var onRotationChanged", "var planeNormal", "var initialNormal",
        "write planeNormal.x", "write planeNormal.y", "write planeNormal.z", "var localNormal", "var lastDragPoint", "var cumulativeAngle", "var anglesUniform", "var gizmo",
        "call drag.onDragStart.add", "call drag.onDragEnd.add", "call drag.onHoverStart.add", "call drag.onHoverEnd.add", "call drag.onDrag.add",
        "var canvas", "if", "write gizmo._disposeFollow", "return",
    ], key);
    const index = (name: string): number => statements.findIndex(statement => key(statement) === `var ${name}`);
    const slice = (from: string, to: string): ts.Statement[] => statements.slice(index(from), index(to));
    context.assertStatementShapes(factory, slice("drag", "canvas").slice(0, 13), `
        const drag = createPointerDrag({
            dragPlaneNormal: { x: options.planeNormal.x, y: options.planeNormal.y, z: options.planeNormal.z },
            moveAttached: false, getPlanePoint: () => ({ x: root.position.x, y: root.position.y, z: root.position.z })
        });
        drag._colliders = [ring, collider];
        const onRotationChanged = new GizmoObservable<[number, number, number, number]>();
        const planeNormal: Vec3 = { x: 0, y: 0, z: 0 };
        const initialNormal = normalizeVec3Obj(options.planeNormal);
        planeNormal.x = initialNormal.x; planeNormal.y = initialNormal.y; planeNormal.z = initialNormal.z;
        const localNormal: Vec3 = { x: initialNormal.x, y: initialNormal.y, z: initialNormal.z };
        let lastDragPoint: Vec3 | null = null;
        let cumulativeAngle = 0;
        const anglesUniform: [number, number, number] = [0, 0, 1];
        const gizmo: PlaneRotationGizmo = {
            root, drag, onRotationChanged, attachedNode: null, useLocalCoordinates: false, materials,
            rotationDisplayMaterial, _visibleMeshes: [ring], _meshes: [root, ring, collider, rotationDisplayPlane],
            _disposePointer: () => undefined, _disposeFollow: () => undefined
        };
    `, "rotation pointer initial state and collider/anchor ownership");
    context.assertStatementShapes(factory, statements.slice(index("canvas"), index("canvas") + 2), `
        const canvas = engine.canvas;
        if ("setAttribute" in canvas) { gizmo._disposePointer = registerPointerDrag(layer, canvas, drag); }
    `, "rotation host canvas registration");
    const registrations = context.findNodes(factory, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && context.propertyPath(node.expression)?.join(".").startsWith("drag.on") === true);
    const callback = (name: string): ts.ArrowFunction => {
        const found = registrations.filter(node => context.propertyPath(node.expression)?.join(".") === `drag.${name}.add`);
        const candidate = found[0]?.arguments[0];
        if (found.length !== 1 || found[0]!.arguments.length !== 1 || !candidate || !ts.isArrowFunction(candidate)) {
            context.contractError(factory, `Expected exactly one rotation ${name} callback.`);
        }
        return candidate;
    };
    const callbackBody = (name: string, expected: string): void => {
        const arrow = callback(name);
        if (!ts.isBlock(arrow.body)) context.contractError(arrow, `Expected ${name} block.`);
        context.assertStatementShapes(arrow, arrow.body.statements, expected, `rotation ${name} state and explicit visual adaptation`);
    };
    callbackBody("onDragStart", `
        lastDragPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };
        cumulativeAngle = 0;
        setMeshesMaterial([ring], materials.hover);
        const planeWorld = rotationDisplayPlane.worldMatrix;
        const invPlane = mat4Invert(planeWorld);
        if (invPlane) {
            const px = event.dragPlanePoint.x, py = event.dragPlanePoint.y, pz = event.dragPlanePoint.z;
            const lx = invPlane[0] * px + invPlane[4] * py + invPlane[8] * pz + invPlane[12];
            const ly = invPlane[1] * px + invPlane[5] * py + invPlane[9] * pz + invPlane[13];
            anglesUniform[0] = Math.atan2(ly, lx) + Math.PI;
        } else { anglesUniform[0] = 0; }
        anglesUniform[1] = 0; anglesUniform[2] = 1;
        setShaderUniform(rotationDisplayMaterial, "angles", anglesUniform);
        rotationDisplayPlane.visible = true;
    `);
    callbackBody("onDragEnd", `lastDragPoint = null; setMeshesMaterial([ring], materials.colored); rotationDisplayPlane.visible = false;`);
    const hover = callback("onHoverStart");
    if (ts.isBlock(hover.body)) context.contractError(hover, "Expected hover material expression.");
    context.assertExpressionShape(hover.body, "setMeshesMaterial([ring], materials.hover)", "rotation hover material");
    callbackBody("onHoverEnd", `if (!drag.dragging) { setMeshesMaterial([ring], materials.colored); }`);
    const drag = callback("onDrag");
    if (!ts.isBlock(drag.body) || drag.parameters.length !== 1 || !ts.isIdentifier(drag.parameters[0]!.name) || drag.parameters[0]!.name.text !== "event") {
        context.contractError(drag, "Expected the rotation drag event parameter and block.");
    }
    context.assertStatementInventory(drag, drag.body.statements, "rotation onDrag", "all arithmetic translates and other statements are explicit native seams", [
        "var node", "if", "var wm", "var nx,ny,nz", "var a", "var b", "var angle", "if",
        "var dq", "var localDq", "var rq", "var out", "call rq.set", "call onRotationChanged.notify",
        "write lastDragPoint", "write cumulativeAngle", "write anglesUniform[]", "call setShaderUniform",
    ], key);
    context.assertStatementShapes(drag, drag.body.statements.slice(0, 3), `
        const node = gizmo.attachedNode; if (!node || !lastDragPoint) { return; } const wm = node.worldMatrix;
    `, "rotation drag node/active-point guard and world center");
    context.assertStatementShapes(drag, drag.body.statements.slice(10, 11), "const rq = node.rotationQuaternion;", "rotation quaternion target");
    context.assertStatementShapes(drag, drag.body.statements.slice(13), `
        onRotationChanged.notify(out);
        lastDragPoint = { x: event.dragPlanePoint.x, y: event.dragPlanePoint.y, z: event.dragPlanePoint.z };
        cumulativeAngle += angle; anglesUniform[1] = cumulativeAngle;
        setShaderUniform(rotationDisplayMaterial, "angles", anglesUniform);
    `, "rotation drag point retention and unsupported observable/sector tail");
    const createDrag = context.functionDeclaration("src/gizmo/pointer-drag.ts", "createPointerDrag").declaration;
    context.assertStatementShapes(createDrag, createDrag.body!.statements, `return {
        options: { moveAttached: false, ...options }, enabled: true, _colliders: [],
        onDragStart: new GizmoObservable<PointerDragStartEvent>(), onDrag: new GizmoObservable<PointerDragMoveEvent>(),
        onDragEnd: new GizmoObservable<PointerDragEndEvent>(), onHoverStart: new GizmoObservable<void>(), onHoverEnd: new GizmoObservable<void>(),
        dragging: false, hovering: false
    };`, "pointer drag defaults");
    for (const [name, expected] of [
        ["attachPlaneRotationGizmoToNode", "gizmo.attachedNode = node; gizmo.drag.enabled = node !== null;"],
        ["disposePlaneRotationGizmo", `
            gizmo._disposePointer(); gizmo._disposeFollow(); gizmo.onRotationChanged.clear();
            gizmo.drag.onDrag.clear(); gizmo.drag.onDragStart.clear(); gizmo.drag.onDragEnd.clear();
            for (const m of gizmo._meshes) { removeFromScene(layer.scene, m); }
            gizmo._meshes.length = 0;
        `],
    ]) {
        const declaration = context.functionDeclaration("src/gizmo/plane-rotation-gizmo.ts", name!).declaration;
        context.assertStatementShapes(declaration, declaration.body!.statements, expected!, name!);
    }
    context.assertStatementShapes(factory, statements.slice(-2), `
        gizmo._disposeFollow = attachFollowTarget(utilityScene, root, () => gizmo.attachedNode, 1 / 3, (_target, wm) => {
            if (gizmo.useLocalCoordinates) {
                const worldNormal = transformDirectionByWorld(wm, localNormal);
                planeNormal.x = worldNormal.x; planeNormal.y = worldNormal.y; planeNormal.z = worldNormal.z;
                const n = drag.options.dragPlaneNormal;
                if (n) { n.x = worldNormal.x; n.y = worldNormal.y; n.z = worldNormal.z; }
                const q = lookAtQuat(worldNormal); root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            } else if (planeNormal.x !== localNormal.x || planeNormal.y !== localNormal.y || planeNormal.z !== localNormal.z) {
                planeNormal.x = localNormal.x; planeNormal.y = localNormal.y; planeNormal.z = localNormal.z;
                const n = drag.options.dragPlaneNormal;
                if (n) { n.x = localNormal.x; n.y = localNormal.y; n.z = localNormal.z; }
                const q = lookAtQuat(localNormal); root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            }
        });
        return gizmo;
    `, "rotation local-coordinate plane updates and follow lifetime");
    return drag as ts.ArrowFunction & { body: ts.Block };
}
