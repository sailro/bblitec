#pragma once
// The owners of the textures task kinds publish (`RenderTextureSource::task_output`)
// on one backend: the texture a task published, and what a material plugin
// sampling it binds in a pass with the version a held binding of it stays
// valid under -- the pin's dynamic PBR bindings (`enableDynamicPbrBindings`:
// `_prepareDraw` decides what a pass binds, `_bindingVersion` when a held
// binding is stale). A kind registers its owner once, at static
// initialization; a PAL resolves every such source through the owner of its
// task's kind, so a kind that publishes textures needs no PAL arm of its own.

#include <bblite/runtime.hpp>

#include <array>
#include <optional>
#include <stdexcept>
#include <utility>

namespace bbl::pal {

template <class Owner> class TaskOutputOwners {
public:
    /** Registers a kind's owner; false when the table is full or the kind has one. */
    static bool add(FrameTaskKind kind, Owner owner) noexcept {
        for (auto& [registered, slot] : slots()) {
            if (slot && registered == kind)
                return false;
            if (!slot) {
                registered = kind;
                slot = owner;
                return true;
            }
        }
        return false;
    }

    /** The owner of a task's kind, refusing a kind that registered none. */
    static const Owner& of(const Engine& engine, TaskHandle task) {
        const FrameTaskKind kind = handle_at(engine.frame_tasks, task).kind;
        for (const auto& [registered, slot] : slots())
            if (slot && registered == kind)
                return *slot;
        throw std::runtime_error("A task publishes a texture its kind registered no owner for.");
    }

private:
    static std::array<std::pair<FrameTaskKind, std::optional<Owner>>, 4>& slots() noexcept {
        static std::array<std::pair<FrameTaskKind, std::optional<Owner>>, 4> registered{};
        return registered;
    }
};

} // namespace bbl::pal
