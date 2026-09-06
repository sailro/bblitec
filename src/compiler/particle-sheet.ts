import ts from "typescript";
import { doubleLiteral } from "../cpp-literals.js";
import type { AssignmentContext } from "./assignments.js";
import type { Value } from "./types.js";
import { compileStaticNumber } from "./option-helpers.js";
import { frozenParticleBuffer, requireParticleBakeWritable } from "./particle-buffer.js";

/** The manually supplied sheet is native shared storage, independent of the baked graph. */
export function emitFrozenParticleSheetAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    target: Value,
): void {
    const owner = { set: target.nodeParticleSetIndex!, system: target.nodeParticleSystemIndex! };
    requireParticleBakeWritable(context, owner, expression);
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        context.fail(expression.operatorToken, "A frozen particle sprite sheet takes a plain assignment.");
    }
    const object = context.unwrap(expression.right);
    if (!ts.isObjectLiteralExpression(object)) {
        context.fail(object, "A frozen particle sprite sheet is supplied as an object literal; replacing fields through a sheet-object alias is not lowered.");
    }
    const fields = new Map<string, ts.Expression>();
    for (const property of object.properties) {
        if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
            ts.isComputedPropertyName(property.name)) {
            context.fail(property, "A frozen particle sprite sheet requires named, non-computed fields.");
        }
        const name = context.propertyName(property.name);
        if (!name || !["cellWidth", "cellHeight", "cellIndex", "update"].includes(name)) {
            context.fail(property, "A frozen particle sprite sheet carries cellWidth, cellHeight, cellIndex and a no-op update callback.");
        }
        if (fields.has(name)) {
            context.fail(property, `A frozen particle sprite sheet cannot repeat field '${name}'.`);
        }
        fields.set(name, ts.isPropertyAssignment(property) ? property.initializer : property.name);
    }
    const field = (name: string): ts.Expression => {
        const value = fields.get(name);
        if (!value) context.fail(object, `A frozen particle sprite sheet requires '${name}'.`);
        return value;
    };
    const width = compileStaticNumber(context, field("cellWidth"), "Sprite-sheet cell width");
    const height = compileStaticNumber(context, field("cellHeight"), "Sprite-sheet cell height");
    const update = context.unwrap(field("update"));
    if ((!ts.isArrowFunction(update) && !ts.isFunctionExpression(update)) ||
        update.parameters.some((parameter) => parameter.initializer || !ts.isIdentifier(parameter.name)) ||
        update.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
        (ts.isFunctionExpression(update) && update.asteriskToken)) {
        context.fail(update, "A frozen particle sprite sheet requires a no-op update callback.");
    }
    const body = update.body;
    const result = ts.isBlock(body)
        ? body.statements.length === 0 ? undefined
          : body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!)
            ? body.statements[0]!.expression : null
        : body;
    if (result === null || (result !== undefined &&
        (!ts.isIdentifier(result) || result.text !== "undefined" || context.lookupOptional(result)))) {
        context.fail(update, "A frozen particle sprite sheet requires a no-op update callback.");
    }
    const indices = context.compileValue(field("cellIndex"));
    if (indices.dataType?.kind !== "u16array") {
        context.fail(field("cellIndex"), "Particle sprite-sheet cellIndex requires shared Uint16Array storage.");
    }
    const request = frozenParticleBuffer(context, owner);
    if (request.sheet) {
        context.fail(expression, "Replacing a frozen particle sprite-sheet object is not lowered; its shared cellIndex elements remain writable.");
    }
    request.sheet = true;
    context.emit(`bbl::upstream::set_frozen_node_particle_sheet(${owner.set}, ${owner.system}, ${doubleLiteral(width)}, ${doubleLiteral(height)}, ${indices.cpp});`);
}
