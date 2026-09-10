import type { NativeDeclaration } from "./native-declarations.js";

interface Declaration {
    part: number;
    line: number;
    type: string;
    initializer: string;
    indent: string;
    dependencies: readonly string[];
}

/** Retain only locals whose storage is referenced by a later deferred part. */
export function persistContinuationLocals(
    parts: readonly { lines: string[]; sequence: number }[],
    nativeDeclarations: ReadonlyMap<string, NativeDeclaration>,
    uses: ReadonlyMap<string, ReadonlySet<number>>,
    locals: ReadonlyMap<string, number>,
    indentation: number,
    storage: string,
): boolean {
    const declarations = new Map<string, Declaration>();
    for (const [partIndex, part] of parts.entries()) {
        for (const [lineIndex, line] of part.lines.entries()) {
            if (line.length - line.trimStart().length !== indentation) continue;
            const declaration = nativeDeclarations.get(line.trimStart());
            if (!declaration || declaration.type.startsWith("static ")) continue;
            declarations.set(declaration.name, {
                part: partIndex, line: lineIndex, type: declaration.type,
                initializer: declaration.initialization === "default" ? `${declaration.type}{}` :
                    declaration.initialization === "direct" ? `${declaration.type}{${declaration.initializer}}` : declaration.initializer,
                indent: " ".repeat(indentation),
                dependencies: declaration.dependencies ?? [],
            });
        }
    }
    const retained = new Set<string>();
    for (const [name, sequence] of locals) {
        if (!declarations.has(name) && [...uses.get(name) ?? []].some(use => use > sequence)) {
            throw new Error(`Missing native declaration metadata for continuation local '${name}'.`);
        }
    }
    const retain = (name: string): void => {
        const declaration = declarations.get(name);
        if (!declaration || retained.has(name)) return;
        retained.add(name);
        // A reference initializer may borrow another continuation local.
        for (const dependency of declaration.dependencies) retain(dependency);
    };
    for (const [name, declaration] of declarations) {
        if ([...uses.get(name) ?? []].some(sequence => sequence > parts[declaration.part]!.sequence)) retain(name);
    }
    for (const name of retained) {
        const declaration = declarations.get(name)!;
        const { part, line, type, initializer, indent } = declaration;
        const resultType = type === "auto" || type === "const auto" ? "" :
            type.includes("auto") ? " -> decltype(auto)" : ` -> ${type}`;
        const result = type.endsWith("&") ? `(${initializer})` : initializer;
        parts[part]!.lines[line] = `${indent}auto& ${name} = ${storage}->retain([&]()${resultType} { return ${result}; });`;
    }
    return retained.size > 0;
}
