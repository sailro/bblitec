import type ts from "typescript";

/**
 * A stored position demanded a class after one of its instances was built
 * as a compile-time record: the replay shares the class from its first
 * construction, so every instance is the one object a store keeps.
 */
export class SharedClassStorageRequired extends Error {
    constructor(readonly declaration: ts.ClassLikeDeclaration) {
        super(
            "A class instance requires shared object storage from its construction.",
        );
    }
}
