// SDLActivity enters the generated program through SDL_main on its native thread.
#include <android/log.h>
#include <jni.h>
#include <SDL3/SDL.h>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <streambuf>
#include <string>
#include <type_traits>

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
}

namespace {
class AndroidLog final : public std::streambuf {
    std::string line_;
    std::mutex mutex_;
    std::streamsize xsputn(const char* text, std::streamsize length) override {
        const std::lock_guard lock(mutex_);
        for (std::streamsize index = 0; index < length; ++index) {
            if (text[index] == '\n') write_line();
            else line_ += text[index];
        }
        return length;
    }
    int overflow(int character) override {
        if (character == traits_type::eof()) return traits_type::not_eof(character);
        const std::lock_guard lock(mutex_);
        if (character == '\n') write_line();
        else line_ += static_cast<char>(character);
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

template<class Entry>
int run_entry(Entry entry, int argc, char** argv) {
    if constexpr (std::is_invocable_r_v<int, Entry, int, char**>) return entry(argc, argv);
    else return entry();
}
}

extern "C" __attribute__((visibility("default"))) int SDL_main(int argc, char** argv) {
    AndroidLog log;
    auto* output = std::cout.rdbuf(&log);
    auto* errors = std::cerr.rdbuf(&log);
    const int result = run_entry(bblite_generated_main, argc, argv);
    std::cout.rdbuf(output);
    std::cerr.rdbuf(errors);
    const char* run_id = std::getenv("BBLITE_RUN_ID");
    __android_log_print(ANDROID_LOG_INFO, "bblite", "Native exit: %d run=%s", result, run_id ? run_id : "interactive");
    return result;
}
