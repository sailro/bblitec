import { LoweringContext } from "../src/lowering/context.js";
import { pinnedErrorCodeOf } from "../src/lowering/pinned-error.js";

let context: LoweringContext | undefined;

/**
 * The message the pin's `ThrowLiteError` throws undecoded, `#<code>`, for
 * the table entry spelling `message` (`${a0}` placeholders kept). A message
 * several codes share names the pinned function that throws it.
 */
export function pinnedError(
    message: string,
    owner?: { module: string; name: string },
): string {
    context ??= new LoweringContext();
    const declaration =
        owner &&
        context.functionDeclaration(owner.module, owner.name).declaration;
    return `#${pinnedErrorCodeOf(context, message, declaration)}`;
}
