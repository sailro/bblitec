/** Header framing shared by generated pinned translations. Includes retain order. */
export function pinnedHeader(
    includes: readonly string[],
    body: string,
    options: { namespace?: string; compactPragma?: true } = {},
): string {
    const namespace = options.namespace ?? "bbl::upstream";
    const directives = includes.map(include => include ? `#include ${include}` : "").join("\n");
    return `#pragma once${options.compactPragma ? "\n" : "\n\n"}${directives}\n\nnamespace ${namespace} {\n${body}\n} // namespace ${namespace}\n`;
}
