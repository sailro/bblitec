import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    cppFunction,
    cppSection,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("Android TLS verification publishes failure on rejection and exceptions, never stale success", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const source = readFileSync("native/src/pal_android_tls.hpp", "utf8");
    runGeneratedProgram(
        tools,
        "android-tls-result-check",
        `#include <cassert>
#include <stdexcept>
struct X509_STORE_CTX { int error = 0; };
constexpr int X509_V_OK = 0;
constexpr int X509_V_ERR_APPLICATION_VERIFICATION = 50;
void X509_STORE_CTX_set_error(X509_STORE_CTX* store, int error) { store->error = error; }
${cppSection(source, "template <typename Verify>", "inline const char* android_tls_auth_type")}
int main() {
    X509_STORE_CTX store;
    assert(android_tls_verify_result(&store, [] { return true; }) == 1);
    assert(store.error == X509_V_OK);
    assert(android_tls_verify_result(&store, [] { return false; }) == 0);
    assert(store.error == X509_V_ERR_APPLICATION_VERIFICATION);
    store.error = X509_V_OK;
    assert(android_tls_verify_result(&store, []() -> bool { throw std::runtime_error("JNI failed"); }) == 0);
    assert(store.error == X509_V_ERR_APPLICATION_VERIFICATION);
    assert(android_tls_verify_result(&store, [&] { store.error = X509_V_OK; return false; }) == 0);
    assert(store.error == X509_V_ERR_APPLICATION_VERIFICATION);
    assert(android_tls_verify_result(&store, [&]() -> bool { store.error = X509_V_OK; throw 1; }) == 0);
    assert(store.error == X509_V_ERR_APPLICATION_VERIFICATION);
    bool called = false;
    assert(android_tls_verify_result(nullptr, [&] { called = true; return true; }) == 0);
    assert(!called);
}
`,
        { expectedOutput: "" },
    );
});

test("Android TLS JNI allocation failures stop before another JNI operation and release references", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const source = readFileSync("native/src/pal_android_tls.hpp", "utf8");
    runGeneratedProgram(
        tools,
        "android-tls-jni-check",
        `#include <cassert>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>
using jobject = void*;
using jclass = void*;
using jbyte = signed char;
using jsize = int;
struct SSL {};
struct X509 {};
struct X509_STORE_CTX {};
SSL ssl;
X509 leaf;
int SSL_get_ex_data_X509_STORE_CTX_idx() { return 0; }
void* X509_STORE_CTX_get_ex_data(X509_STORE_CTX*, int) { return &ssl; }
const char* android_tls_auth_type(SSL*) { return "RSA"; }
X509* X509_STORE_CTX_get0_cert(X509_STORE_CTX*) { return &leaf; }
const int* X509_STORE_CTX_get0_untrusted(X509_STORE_CTX*) { return nullptr; }
int sk_X509_num(const int*) { return 0; }
X509* sk_X509_value(const int*, int) { return &leaf; }
int X509_cmp(X509*, X509*) { return 0; }
int i2d_X509(X509*, unsigned char**) { return 1; }
struct JNIEnv {
    bool pending = false;
    std::string fault;
    int strings = 0;
    int popped = 0;
    int verified = 0;
    void check() { assert(!pending); }
    bool ExceptionCheck() { return pending; }
    void ExceptionClear() { pending = false; }
    int PushLocalFrame(int) { check(); return 0; }
    void PopLocalFrame(jobject) { check(); ++popped; }
    jobject object() { return this; }
    jobject allocation(std::string_view name) {
        check();
        if (fault == name) { pending = true; return nullptr; }
        return object();
    }
    jclass GetObjectClass(jobject) { return allocation("class"); }
    void* GetMethodID(jclass, const char*, const char*) { return allocation("method"); }
    jclass FindClass(const char*) { return allocation("bytes-class"); }
    jobject NewObjectArray(jsize, jclass, jobject) { return allocation("array"); }
    jobject NewByteArray(jsize) { return allocation("bytes"); }
    void SetByteArrayRegion(jobject, int, int, const jbyte*) { check(); }
    void SetObjectArrayElement(jobject, int, jobject) { check(); }
    void DeleteLocalRef(jobject) {}
    jobject NewStringUTF(const char*) {
        ++strings;
        return allocation(strings == 1 ? "authentication" : "hostname");
    }
    void CallVoidMethod(jobject, void*, jobject, jobject, jobject) {
        check(); ++verified;
        if (fault == "verification") pending = true;
    }
} environment;
void* SDL_GetAndroidJNIEnv() { return &environment; }
void* SDL_GetAndroidActivity() { return environment.object(); }
${cppFunction(source, "inline bool android_tls_check_chain(")}
int main() {
    X509_STORE_CTX store;
    for (const auto* fault : {"class", "method", "bytes-class", "array", "bytes",
                              "authentication", "hostname", "verification"}) {
        environment = {};
        environment.fault = fault;
        assert(!android_tls_check_chain(&store, "example.test"));
        assert(!environment.pending && environment.popped == 1);
        if (environment.fault == "authentication") assert(environment.strings == 1);
    }
    environment = {};
    environment.pending = true;
    assert(!android_tls_check_chain(&store, "example.test"));
    assert(!environment.pending && environment.popped == 0);
    environment = {};
    assert(android_tls_check_chain(&store, "example.test"));
    assert(environment.strings == 2 && environment.verified == 1 && environment.popped == 1);
}
`,
        { expectedOutput: "" },
    );
});

test("Android trust stays platform-owned and connection-bound, with curl hostname checks retained", () => {
    const native = readFileSync("native/src/pal_android_tls.hpp", "utf8");
    const java = readFileSync(
        "native/android/app/src/main/java/org/bblite/prototype/AndroidTlsTrust.java",
        "utf8",
    );
    assert.match(native, /CURLOPT_SSL_VERIFYPEER, 1L/);
    assert.match(native, /CURLOPT_SSL_VERIFYHOST, 2L/);
    assert.match(native, /SSL_CTX_set_verify\(ssl_context, SSL_VERIFY_PEER/);
    assert.match(native, /SSL_CTX_get_ex_new_index/);
    assert.match(native, /SSL_get_servername/);
    assert.match(native, /CURLINFO_EFFECTIVE_URL/);
    assert.match(native, /CURLOPT_SSL_SESSIONID_CACHE, 0L/);
    assert.doesNotMatch(native, /CURLOPT_FORBID_REUSE/);
    assert.match(java, /factory\.init\(\(KeyStore\) null\)/);
    assert.match(java, /checkServerTrusted\(chain, authType, hostname\)/);
    assert.doesNotMatch(java, /AndroidCAStore|setDefault|setProperty/);
});

test("Android TLS authenticates the pending TLS 1.2 cipher before change-cipher-spec", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const source = readFileSync("native/src/pal_android_tls.hpp", "utf8");
    runGeneratedProgram(
        tools,
        "android-tls-auth-check",
        `#include <cassert>
#include <cstring>
constexpr int TLS1_3_VERSION = 0x0304;
enum { NID_auth_rsa, NID_auth_ecdsa, NID_kx_rsa, NID_kx_dhe, NID_kx_ecdhe };
struct SSL_CIPHER { int auth; int exchange; };
struct SSL { int version; const SSL_CIPHER* pending; const SSL_CIPHER* current; };
int SSL_version(const SSL* ssl) { return ssl->version; }
const SSL_CIPHER* SSL_get_pending_cipher(const SSL* ssl) { return ssl->pending; }
const SSL_CIPHER* SSL_get_current_cipher(const SSL* ssl) { return ssl->current; }
int SSL_CIPHER_get_auth_nid(const SSL_CIPHER* cipher) { return cipher->auth; }
int SSL_CIPHER_get_kx_nid(const SSL_CIPHER* cipher) { return cipher->exchange; }
${cppFunction(source, "inline const char* android_tls_auth_type(")}
int main() {
    const SSL_CIPHER rsa{NID_auth_rsa, NID_kx_ecdhe};
    SSL ssl{0x0303, &rsa, nullptr};
    assert(std::strcmp(android_tls_auth_type(&ssl), "ECDHE_RSA") == 0);
    ssl.pending = nullptr; ssl.current = &rsa;
    assert(std::strcmp(android_tls_auth_type(&ssl), "ECDHE_RSA") == 0);
    ssl.current = nullptr;
    assert(android_tls_auth_type(&ssl) == nullptr);
    ssl.version = TLS1_3_VERSION;
    assert(std::strcmp(android_tls_auth_type(&ssl), "UNKNOWN") == 0);
}
`,
        { expectedOutput: "" },
    );
});
