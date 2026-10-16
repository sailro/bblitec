/** Shared thin GPU owners require one frame submission and a represented device lifetime. */
export function thinInstanceOwnershipFailure(
    features: ReadonlySet<string>,
    options: { reached?: string; geometryOutputTasks?: number } = {},
): string | undefined {
    const has = (feature: string): boolean =>
        feature === options.reached || features.has(feature);
    if (!has("mesh:thin-instances")) return undefined;
    if (has("compute:frame-graph"))
        return "Thin-instance GPU pools cannot share a compute frame graph: its native split submissions do not preserve the source's shared indirect-argument write ordering.";
    if ((options.geometryOutputTasks ?? 0) > 0)
        return "Thin-instance GPU pools do not represent geometry-output task buffer ownership and update gates.";
    return undefined;
}
