/**
 * The C++ spelling of an engine record reached through a handle: every
 * emitter that reads or writes `engine.<records>` by a handle spells it
 * here, so no generated unit indexes a record table with `handle.value`.
 * `bbl::handle_at` (native/include/bblite/checked_handles.hpp) refuses a
 * mesh handle whose retired mesh's slot a later mesh took, where the index
 * would silently reach that later mesh.
 *
 * `records` is the C++ expression naming the record table
 * (`engine.meshes`), `handle` the one naming the handle (`mesh`, not
 * `mesh.value`).
 */
export function recordAt(records: string, handle: string): string {
    return `bbl::handle_at(${records}, ${handle})`;
}

/**
 * The record a handle names as a pointer, null where `recordAt` would
 * refuse: `bbl::handle_find`, for a lookup whose absent record is an
 * expected state (an unset camera) rather than a broken handle.
 */
export function recordFind(records: string, handle: string): string {
    return `bbl::handle_find(${records}, ${handle})`;
}
