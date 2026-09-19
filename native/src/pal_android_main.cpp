// SDLActivity enters the generated program through SDL_main on its native thread.
#include <android/log.h>
#include <jni.h>
#include <SDL3/SDL.h>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <mutex>
#include <streambuf>
#include <string>
#include "pal_generated_entry.hpp"
#include "pal_gpu_backend.hpp"

#define main bblite_generated_main
#include BBLITE_ANDROID_ENTRY
#undef main

namespace bbl::js {
std::string android_time_zone() {
    auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    const jclass type = env->FindClass("java/util/TimeZone");
    const auto get_default = env->GetStaticMethodID(type, "getDefault", "()Ljava/util/TimeZone;");
    const jobject zone = env->CallStaticObjectMethod(type, get_default);
    const auto get_id = env->GetMethodID(type, "getID", "()Ljava/lang/String;");
    const auto id = static_cast<jstring>(env->CallObjectMethod(zone, get_id));
    const char* text = env->GetStringUTFChars(id, nullptr);
    const std::string result(text);
    env->ReleaseStringUTFChars(id, text);
    env->DeleteLocalRef(id);
    env->DeleteLocalRef(zone);
    env->DeleteLocalRef(type);
    return result;
}
} // namespace bbl::js

namespace {
class AndroidLog final : public std::streambuf {
    std::string line_;
    std::mutex mutex_;
    std::streamsize xsputn(const char* text, std::streamsize length) override {
        const std::lock_guard lock(mutex_);
        for (std::streamsize index = 0; index < length; ++index) {
            if (text[index] == '\n')
                write_line();
            else
                line_ += text[index];
        }
        return length;
    }
    int overflow(int character) override {
        if (character == traits_type::eof())
            return traits_type::not_eof(character);
        const std::lock_guard lock(mutex_);
        if (character == '\n')
            write_line();
        else
            line_ += static_cast<char>(character);
        return character;
    }
    // cerr is unit-buffered: flushing each insertion would split trace records.
    int sync() override { return 0; }
    void write_line() {
        if (!line_.empty()) {
            __android_log_write(ANDROID_LOG_INFO, "bblite", line_.c_str());
            line_.clear();
        }
    }

public:
    ~AndroidLog() override { write_line(); }
};

} // namespace

extern "C" __attribute__((visibility("default"))) int SDL_main(int argc, char** argv) {
    AndroidLog log;
    auto* output = std::cout.rdbuf(&log);
    auto* errors = std::cerr.rdbuf(&log);
    const char* run_id = std::getenv("BBLITE_RUN_ID");
    int result = 1;
    try {
        const bool dawn = bbl::pal::use_dawn_backend();
        __android_log_print(ANDROID_LOG_INFO, "bblite", "GPU backend: %s run=%s",
                            dawn ? "dawn" : "sdl_gpu", run_id ? run_id : "interactive");
        result = bbl::pal::run_generated_entry(bblite_generated_main, argc, argv);
    } catch (const std::exception& error) {
        std::cerr << "Babylon Lite native error: " << error.what() << '\n';
    }
    std::cout.rdbuf(output);
    std::cerr.rdbuf(errors);
    __android_log_print(ANDROID_LOG_INFO, "bblite", "Native exit: %d run=%s", result,
                        run_id ? run_id : "interactive");
    return result;
}
