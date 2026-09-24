import ts from "typescript";
import {
    ClassHierarchy,
    classMemberTable,
    classMethod,
} from "./class-members.js";
import { aliasTarget, declaredSymbol, declarationOrigin } from "./symbols.js";
import { sharedUpstreamStore } from "../upstream-source.js";

/**
 * The pinned bodies behind an engine declaration.
 *
 * A scene reads the engine through the package typings, which declare a
 * function or a class method without its body. The pin's own sources carry
 * the body: the public export a typing names resolves to the module that
 * declares it, and the pinned program's checker follows that module's
 * exports to the function, or to the class and its method. A method a
 * subclass may override is every implementation the pinned hierarchy has.
 */
export interface EngineBodies {
    /** The pinned program's checker and class hierarchy. */
    readonly checker: ts.TypeChecker;
    readonly hierarchy: ClassHierarchy;
    /**
     * The pinned implementations a typing's declaration runs, or undefined
     * when the declaration names no pinned body (an interface member, a
     * type-only export).
     */
    bodies(
        declaration: ts.Declaration,
    ): readonly ts.FunctionLikeDeclaration[] | undefined;
}

let shared: EngineBodies | undefined;

/** The one resolver a process uses: the pinned program is built once. */
export function engineBodies(): EngineBodies {
    shared ??= createEngineBodies();
    return shared;
}

/** Whether a declaration comes from the engine's package typings. */
export function isEngineDeclaration(declaration: ts.Node): boolean {
    return declarationOrigin(declaration) === "babylon";
}

function createEngineBodies(): EngineBodies {
    const store = sharedUpstreamStore();
    const pinned = store.program;
    const checker = pinned.checker;
    const hierarchy = new ClassHierarchy(checker, pinned.program);
    const resolved = new Map<string, readonly ts.Declaration[]>();

    /** The pinned declarations a public export names, through re-exports. */
    const exported = (name: string): readonly ts.Declaration[] => {
        const known = resolved.get(name);
        if (known) return known;
        let found: readonly ts.Declaration[] = [];
        const origin = store.findPublicExport(name);
        if (origin) {
            const file = store.getSourceFile(origin.modulePath);
            const module = declaredSymbol(checker, file);
            const symbol = module
                ? checker
                      .getExportsOfModule(module)
                      .find((entry) => entry.name === origin.importedName)
                : undefined;
            found = symbol
                ? (aliasTarget(checker, symbol).declarations ?? [])
                : [];
        }
        resolved.set(name, found);
        return found;
    };

    return {
        checker,
        hierarchy,
        bodies(declaration) {
            if (ts.isFunctionDeclaration(declaration) && declaration.name) {
                // An overloaded function's implementation is the one
                // declaration with a body.
                for (const candidate of exported(declaration.name.text)) {
                    if (ts.isFunctionDeclaration(candidate) && candidate.body)
                        return [candidate];
                    if (
                        ts.isVariableDeclaration(candidate) &&
                        candidate.initializer &&
                        (ts.isArrowFunction(candidate.initializer) ||
                            ts.isFunctionExpression(candidate.initializer))
                    )
                        return [candidate.initializer];
                }
                return undefined;
            }
            if (
                ts.isMethodDeclaration(declaration) &&
                ts.isClassDeclaration(declaration.parent) &&
                declaration.parent.name &&
                ts.isMemberName(declaration.name)
            ) {
                const owner = exported(declaration.parent.name.text).find(
                    ts.isClassDeclaration,
                );
                if (!owner) return undefined;
                const method = classMethod(
                    classMemberTable(checker, owner),
                    declaration.name.text,
                );
                if (!method?.body) return undefined;
                const implementations = hierarchy.implementations(method) ?? [
                    method,
                ];
                return implementations.every(
                    (implementation): implementation is ts.MethodDeclaration =>
                        implementation?.body !== undefined,
                )
                    ? implementations
                    : undefined;
            }
            return undefined;
        },
    };
}
