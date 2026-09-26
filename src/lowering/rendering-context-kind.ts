import type { LoweringContext } from "./context.js";
import { stringLiteral } from "../cpp-literals.js";
import ts from "typescript";

/** The discriminator on the context constructed by the pinned module. */
export function renderingContextKind(
    context: LoweringContext,
    module: string,
): string {
    const file = context.sourceFile(module);
    const initializer = context.namedPropertyInitializer(file, "_kind");
    if (!initializer)
        return context.contractError(
            file,
            `Expected ${module} to give its rendering context a _kind.`,
        );
    return stringLiteral(
        ts.isIdentifier(initializer)
            ? context.pinnedString(module, initializer.text)
            : context.stringValue(initializer, file),
    );
}
