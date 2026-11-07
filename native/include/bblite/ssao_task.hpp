#pragma once
// The records a `createSsaoTask` task publishes (`post-process/ssao.ts`),
// reached by generated scene code. The task record itself is
// `SsaoTaskOptions` in runtime.hpp; its frame function is generated.

#include <bblite/js_promise.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl {

inline SsaoTaskOptions& ssao_task_record(Engine& engine, TaskHandle task) {
    FrameTaskRecord& record = handle_at(engine.frame_tasks, task);
    if (record.kind != FrameTaskKind::ssao)
        throw std::runtime_error("The task is not a createSsaoTask task.");
    return record.ssao;
}

/** A record the task owns outright (`task.temporal`). */
template <class Settings> Settings& ssao_installed(Settings& settings) { return settings; }

/** The settings an enabler installed. */
template <class Settings> Settings& ssao_installed(std::optional<Settings>& settings) {
    if (!settings)
        throw std::runtime_error("The SSAO enabler has not installed its settings.");
    return *settings;
}

/** The record a reference names on its task. */
template <auto Member> auto& ssao_record(Engine& engine, SsaoRecordRef<Member> reference) {
    return ssao_installed(ssao_task_record(engine, reference.task).*Member);
}

/**
 * An enabler's settings: installed on the first call and returned on every
 * later one, as the pin's `WeakMap` does.
 */
template <auto Member>
SsaoRecordRef<Member> install_ssao_settings(SsaoTaskOptions& record, TaskHandle task) {
    if (!(record.*Member))
        (record.*Member).emplace();
    return {task};
}

/**
 * `enableSsaoHalfResolution(task)`. The pin's refusals of a disposed task
 * and of a second adapter name states no native task reaches: no task is
 * disposed and no other adapter exists.
 */
inline SsaoHalfResolutionRef enable_ssao_half_resolution(Engine& engine, TaskHandle task) {
    return install_ssao_settings<&SsaoTaskOptions::half>(ssao_task_record(engine, task), task);
}

/** `task.outputTexture`: the AO visibility the task's last pass writes. */
inline RenderTextureRef ssao_output_texture(TaskHandle task) {
    RenderTextureRef reference;
    reference.source = RenderTextureSource::task_output;
    reference.task = task;
    return reference;
}

/** The SSAO task a plugin texture samples through `enablePbrSsao`, if it is one. */
inline std::optional<TaskHandle> ssao_pbr_texture_task(const Engine& engine,
                                                       const MaterialPluginTexture& texture) {
    const auto& source = texture.data.render_source;
    if (!source || source->reference.source != RenderTextureSource::task_output ||
        handle_at(engine.frame_tasks, source->reference.task).kind != FrameTaskKind::ssao)
        return std::nullopt;
    return source->reference.task;
}

/**
 * `enablePbrSsao(scene, task, materials?)` (`post-process/ssao/ssao-pbr.ts`):
 * appends the task's plugin to the selected PBR source materials -- the list
 * given, or the PBR materials the scene's meshes hold at the call -- before
 * the scene registers. Its fragment is generation's; `append` is the
 * signature the material's plugin list grows to, and the texture it samples
 * is the draw's (`pal::ssao_pbr_binding`): the output of the task of the
 * pass's camera that lists the material, a neutral texture otherwise. A
 * material another scene's task already samples keeps that one plugin, as
 * the pin's scoped sampling does: each scene's passes sample its own task,
 * which natively their camera names, so two scenes' tasks of one camera
 * refuse.
 */
template <class Append>
js::Promise<js::PromiseVoid> enable_pbr_ssao(Engine& engine, Scene& scene, TaskHandle task,
                                             std::optional<std::vector<MaterialHandle>> materials,
                                             std::string texture_name, std::string sampler_name,
                                             Append append) {
    try {
        SsaoTaskOptions& record = ssao_task_record(engine, task);
        if (scene.engine != &engine || scene.camera.value != record.camera.value)
            throw std::runtime_error("PBR SSAO must use this scene's engine and active camera.");
        if (scene.disposed)
            throw std::runtime_error("Cannot enable PBR SSAO on a disposed task or scene.");
        if (record.pbr_scene && record.pbr_scene != scene.state.get())
            throw std::runtime_error("A PBR SSAO task cannot be shared between scenes.");
        const auto pbr = [&](MaterialHandle handle) {
            return material_family_name(handle_at(engine.materials, handle)) == "pbr";
        };
        std::vector<MaterialHandle> selected;
        if (materials) {
            selected = std::move(*materials);
        } else {
            for (const MeshHandle mesh : scene.meshes) {
                MaterialHandle material = handle_at(engine.meshes, mesh).material;
                if (material.value >= engine.materials.size())
                    continue;
                // `getMaterialSource`: a view holds its source's plugins.
                if (const MaterialHandle source =
                        handle_at(engine.materials, material).source_material;
                    source.value < engine.materials.size())
                    material = source;
                if (pbr(material))
                    selected.push_back(material);
            }
        }
        const auto enabled = [&](MaterialHandle handle) {
            return std::find(record.pbr_materials.begin(), record.pbr_materials.end(), handle) !=
                   record.pbr_materials.end();
        };
        for (const MaterialHandle handle : selected) {
            if (!pbr(handle))
                throw std::runtime_error("enablePbrSsao accepts only PBR source materials.");
            if (enabled(handle))
                continue;
            if (scene.state->source_built)
                throw std::runtime_error("Enable PBR SSAO on new materials before registerScene.");
            for (const MaterialPluginTexture& texture :
                 handle_at(engine.materials, handle).plugin_textures) {
                const std::optional<TaskHandle> other = ssao_pbr_texture_task(engine, texture);
                if (!other)
                    continue;
                const SsaoTaskOptions& owner = handle_at(engine.frame_tasks, *other).ssao;
                if (owner.pbr_scene == scene.state.get())
                    throw std::runtime_error(
                        "A different SSAO plugin is already attached to this material.");
                if (owner.camera.value == record.camera.value)
                    throw std::runtime_error("PBR SSAO of two scenes drawing with one camera "
                                             "names no scene's task in a pass natively.");
            }
        }
        record.pbr_scene = scene.state.get();
        const auto sampled = [&](MaterialHandle handle) {
            const auto& textures = handle_at(engine.materials, handle).plugin_textures;
            return std::any_of(textures.begin(), textures.end(),
                               [&](const MaterialPluginTexture& texture) {
                                   return ssao_pbr_texture_task(engine, texture).has_value();
                               });
        };
        for (const MaterialHandle handle : selected) {
            if (enabled(handle))
                continue;
            if (!sampled(handle)) {
                set_material_plugin_signature(engine, handle,
                                              append(material_plugin_signature(engine, handle)));
                MaterialPluginTexture texture;
                texture.data.render_source = std::make_shared<RenderTextureData>(RenderTextureData{
                    &engine, engine.lifetime.token(), ssao_output_texture(task), nullptr});
                texture.texture_name = texture_name;
                texture.sampler_name = sampler_name;
                handle_at(engine.materials, handle).plugin_textures.push_back(std::move(texture));
            }
            record.pbr_materials.push_back(handle);
        }
        return js::Promise<js::PromiseVoid>::resolved({});
    } catch (...) {
        return js::Promise<js::PromiseVoid>::rejected(std::current_exception());
    }
}

/**
 * `enableSsaoMotionPruning(task)` (`ssao-motion-pruning.ts`). Which
 * transport the frame encodes is the plan mode the settings select
 * (`plan_ssao_frame`); the pin's refusal of a second temporal GPU extension
 * names a state no native task reaches.
 */
inline SsaoMotionPruningRef enable_ssao_motion_pruning(Engine& engine, TaskHandle task) {
    SsaoTaskOptions& record = ssao_task_record(engine, task);
    if (!record.velocity)
        throw std::runtime_error(
            "SSAO motion pruning requires an object velocity texture in createSsaoTask.");
    return install_ssao_settings<&SsaoTaskOptions::pruning>(record, task);
}

} // namespace bbl
