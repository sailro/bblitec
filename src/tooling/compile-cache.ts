/**
 * Node's on-disk compile cache, for this process and every Node child it
 * starts. The cli and scene-command entry points import this module first:
 * code Node compiles after the call is cached -- the CommonJS TypeScript
 * compiler, every dynamic import, lazily compiled functions -- while the
 * entry's own ESM graph is compiled before any module runs. The directory
 * goes into NODE_COMPILE_CACHE, so a child (each generation's cli run)
 * enables the cache before it loads its graph. NODE_DISABLE_COMPILE_CACHE
 * turns it off; a cache that cannot be enabled only costs the compile.
 */
import { constants, enableCompileCache } from "node:module";

const { status, directory } = enableCompileCache();
if (
    directory !== undefined &&
    (status === constants.compileCacheStatus.ENABLED ||
        status === constants.compileCacheStatus.ALREADY_ENABLED)
)
    process.env.NODE_COMPILE_CACHE ??= directory;
