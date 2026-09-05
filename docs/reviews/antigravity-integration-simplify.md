# Antigravity Racer integration cleanup

This is the earlier, deliberately focused validation record. The user's later
overnight request authorizes the full suite and sweep; the subsequent review
and the disposition of these deferrals are recorded in
[the overnight review](antigravity-ui-fidelity-simplify.md).

Reviewed the complete branch against `origin/main`, including the tracked
working-tree diff and untracked integration files, on 2026-09-04. The committed
range was empty; the integration was in the working tree. Reuse,
simplification, and efficiency were independent agent reviews; the primary
agent reviewed altitude alongside them because the host permits three child
agents. All four reviews finished before cleanup edits began.

The upstream Antigravity Racer TypeScript graph is evidence, not a cleanup
target. Its 22 files remain unchanged. The existing `racer` is not modified.

## Applied findings

- Removed the unused asset-root reachability scan and its cached answer from
  compiler data-type plumbing.
- Centralized synchronous-native return-type normalization, preserving the
  recursive-callback path's narrower Promise treatment.
- Kept shadow-generator light identity on the internal generator record and
  omitted it from the public manifest, removing a parallel metadata map.
- Computed effective GPU instancing once for CLI shader composition and build
  options.
- Derived trimmed SDL feature suffixes, paths, and provenance from one ordered
  feature list, preserving existing variant names.
- Shared canonical typed-array validation between storage-buffer creation and
  updates, and reused the canonical non-U8 typed-array predicate.
- Reused predeclared shader-program normalization while preserving defensive
  copies and the call site's intentionally empty defaults/storage declarations.
- Shared binary Vec3 component generation between value and `ToRef` intrinsics.
- Centralized default sampler declarations for program normalization, shader
  preludes, and shader IR.
- Centralized scene-set restart policy across both backend frame boundaries.
  SDL still submits its already-acquired empty command buffer locally before
  restart; Dawn has no acquired frame resource at that boundary.
- Shared the diagnostic UI replay mouse identity between emission and filtering.
- Removed temporary surface tracing and corrected mechanically renamed prose.
- Reused the existing HTML replacement helper for entity normalization.
- Indexed static markup descendants by owner instead of repeatedly scanning all
  retained UI elements during binding, updates, reachability, and clearing.
- Made CSM receiver registries lazy and shared, with weak identity-based
  disposers. Removal releases captured state when dispatch is idle and safely
  compacts after active dispatch.
- Made mirrored-mesh watchers capture scene state weakly, using a lightweight
  wrapper after locking, so the scene does not retain itself through its watcher.

## Deferred findings and what unblocks them

These are not claims that the code is optimal. Each needs evidence or an
ownership/scheduling contract that this cleanup does not yet have.

1. **Look-direction quaternion lowering** (`native/include/bblite/runtime.hpp`):
   the candidate pinned helper uses `hypot_js`, whereas the current path uses
   `std::hypot`. Reuse therefore changes arithmetic, not just structure.
   Unblock with a focused numerical comparison, including degenerate inputs,
   and camera parity captures establishing the intended output.
2. **Capture-frame compensation** (`src/scene-registry.ts`): replacing
   `nativeFrameOffset` requires measured alignment of the source callback and
   GPU upload/capture boundaries. Unblock with paired frame traces and captures
   before changing renderer timing.
3. **General canvas pane layout** (`native/src/pal_gpu_shared.hpp`): equal
   horizontal panes currently cover the reached two-player layout. Arbitrary
   canvas bounds need a shared retained-layout-to-render-surface contract and
   resize coverage. Unblock with that geometry contract and targeted layout
   fixtures, preserving the now-working split screen.
4. **Gamepad snapshot caching** (`native/src/pal_sdl.cpp`): removing repeated
   arrays/handles needs explicit snapshot identity and disconnect/reconnect
   lifetime rules. Unblock with those rules and retained-snapshot/hotplug tests;
   mutating old snapshots in place is not an equivalent cleanup.
5. **Frame callback snapshot replacement** (`native/src/pal_gpu_shared.hpp`):
   snapshots currently preserve mutable closure identity and self-disposal.
   Unblock a tombstoned-list replacement with a mutation-during-dispatch matrix
   covering insertion, removal, nested dispatch, and scene disposal.
6. **SDL storage publication batching** (`native/src/pal_sdl_gpu.cpp`): moving
   the early upload or CSM callbacks changes when shared buffers become visible
   to scene graphs. Unblock with resource-order traces and a validated upload
   schedule for multi-scene/custom-shadow consumers.
7. **Dawn thin-pick bind-group caching** (`native/src/pal_dawn_picking.hpp`): a
   cache must invalidate when instance storage or pick uniform buffers are
   replaced. Unblock with a resource-generation/ownership key and replacement
   coverage, not a cache keyed only by mesh identity.

## Validation scope

The user explicitly prohibited full suites and scene sweeps, and requested
non-intrusive checks plus a genuine non-ASAN Release. Validation is therefore
limited to named compiler/backend regressions, a tiny native callback fixture,
one demo's generation/build, and brief hidden in-process input replays. No
desktop mouse, keyboard, or focus automation is used. This is not a full-branch
regression certification.

Results after cleanup:

- TypeScript build and 19 focused tests passed, including the native CSM
  disposal/capture-release fixture.
- Antigravity Racer generation and its single-job Release build passed.
  The build uses `/O2 /Ob2 /DNDEBUG` and has no ASAN flags or dependency.
- The user's 2-player -> main menu -> 1-player -> main menu -> Attract -> main
  menu sequence exited successfully on both SDL_GPU and Dawn; final captures
  show the main menu. Evidence is in
  `native/build-antigravity-racer-release/simplify-mode-sequence-{sdl,dawn}.png`
  and their corresponding logs.
- Editor entry rendered successfully on SDL_GPU; this is an entry/UI smoke
  check, not complete editor interaction coverage. Evidence is
  `native/build-antigravity-racer-release/simplify-editor-sdl.png`.
- All 22 source-file hashes match the upstream copies. `git diff --check`
  passed; no existing `racer` source was changed.
