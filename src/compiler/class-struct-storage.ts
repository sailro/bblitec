import type ts from "typescript";

/**
 * A class instance built as a compile-time record before anything stored one,
 * then stored: the compile replays with the class's native struct minted
 * before its first construction, so the stored object is that instance.
 */
export class ClassStructRequired extends Error {
    constructor(readonly declaration: ts.ClassLikeDeclaration) {
        super("A class must be a native struct from its first construction.");
    }
}
