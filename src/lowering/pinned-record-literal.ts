import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import type { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";

export interface PinnedRecordSchema {
    cpp: string;
    fields: Readonly<
        Record<
            string,
            {
                cpp: string;
                record?: PinnedRecordSchema;
                convert?: (value: string) => string;
            }
        >
    >;
    /** Transport a source spread into a represented native base or extension. */
    spread?: (
        expression: ts.Expression,
        lowerer: PinnedNumericLowerer,
    ) => string;
}

/** A flat source-to-native field mapping for the shared record emitter. */
export function pinnedRecordSchema(
    cpp: string,
    fields: Readonly<Record<string, string>>,
): PinnedRecordSchema {
    return {
        cpp,
        fields: Object.fromEntries(
            Object.entries(fields).map(([name, cpp]) => [name, { cpp }]),
        ),
    };
}

/** Object construction with named native fields and source-ordered spreads. */
export function pinnedRecordLiteral(
    context: LoweringContext,
    lowerer: PinnedNumericLowerer,
    expression: ts.Expression,
    schema: PinnedRecordSchema,
): string {
    const statements: string[] = [];
    const append = (input: ts.Expression): void => {
        const node = unwrapExpression(input);
        if (ts.isConditionalExpression(node)) {
            statements.push(`if (${lowerer.expression(node.condition)}) {`);
            append(node.whenTrue);
            statements.push("} else {");
            append(node.whenFalse);
            statements.push("}");
            return;
        }
        if (!ts.isObjectLiteralExpression(node)) {
            if (statements.length)
                return context.contractError(
                    node,
                    "A native record copy must precede field assignments.",
                );
            statements.push(`record = ${lowerer.expression(node)};`);
            return;
        }
        for (const property of node.properties) {
            if (ts.isSpreadAssignment(property)) {
                if (schema.spread)
                    statements.push(
                        schema.spread(property.expression, lowerer),
                    );
                else append(property.expression);
                continue;
            }
            if (
                !ts.isPropertyAssignment(property) &&
                !ts.isShorthandPropertyAssignment(property)
            )
                return context.contractError(
                    property,
                    "Unrepresented native record property.",
                );
            const name = context.propertyName(property.name),
                field = name ? schema.fields[name] : undefined;
            if (!field)
                return context.contractError(
                    property,
                    `Unrepresented ${schema.cpp} field ${name}.`,
                );
            const value = ts.isShorthandPropertyAssignment(property)
                ? property.name
                : property.initializer;
            const lowered = field.record
                ? pinnedRecordLiteral(context, lowerer, value, field.record)
                : lowerer.expression(value);
            statements.push(
                `record.${field.cpp} = ${field.convert ? field.convert(lowered) : lowered};`,
            );
        }
    };
    append(expression);
    return `([&]() { ${schema.cpp} record{}; ${statements.join(" ")} return record; })()`;
}
