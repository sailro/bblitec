import ts from "typescript";

export type EngineOwnerStorageDeclaration =
    | ts.ParameterDeclaration
    | ts.PropertySignature
    | ts.PropertyDeclaration
    | ts.PropertyAssignment
    | ts.ShorthandPropertyAssignment;

export function isEngineOwnerStorageDeclaration(
    declaration: ts.Declaration,
): declaration is EngineOwnerStorageDeclaration {
    return (
        ts.isParameter(declaration) ||
        ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration) ||
        ts.isShorthandPropertyAssignment(declaration)
    );
}

/** A stored resource must carry the engine that gives it identity. */
export class EngineOwnerStorageRequired extends Error {
    constructor(readonly declaration: EngineOwnerStorageDeclaration) {
        super("Resource storage must retain its engine owner.");
    }
}
