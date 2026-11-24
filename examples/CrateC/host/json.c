#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct parser {
    const char *p;
    const char *end;
    char *error;
    size_t error_size;
    int failed;
} parser;

static void fail(parser *ps, const char *message) {
    if (ps->failed) return;
    ps->failed = 1;
    if (ps->error && ps->error_size) snprintf(ps->error, ps->error_size, "%s", message);
}

static void skip_ws(parser *ps) {
    while (ps->p < ps->end && (*ps->p == ' ' || *ps->p == '\n' || *ps->p == '\r' || *ps->p == '\t')) ps->p++;
}

static int parse_value(parser *ps, json_value *out);

static void append_utf8(char **buf, size_t *len, size_t *cap, unsigned code) {
    if (*len + 4 >= *cap) {
        *cap = *cap * 2 + 16;
        *buf = (char *)realloc(*buf, *cap);
    }
    if (code < 0x80) {
        (*buf)[(*len)++] = (char)code;
    } else if (code < 0x800) {
        (*buf)[(*len)++] = (char)(0xC0 | (code >> 6));
        (*buf)[(*len)++] = (char)(0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
        (*buf)[(*len)++] = (char)(0xE0 | (code >> 12));
        (*buf)[(*len)++] = (char)(0x80 | ((code >> 6) & 0x3F));
        (*buf)[(*len)++] = (char)(0x80 | (code & 0x3F));
    } else {
        (*buf)[(*len)++] = (char)(0xF0 | (code >> 18));
        (*buf)[(*len)++] = (char)(0x80 | ((code >> 12) & 0x3F));
        (*buf)[(*len)++] = (char)(0x80 | ((code >> 6) & 0x3F));
        (*buf)[(*len)++] = (char)(0x80 | (code & 0x3F));
    }
}

static unsigned hex4(parser *ps) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        if (ps->p >= ps->end) { fail(ps, "truncated \\u escape"); return 0; }
        char c = *ps->p++;
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else { fail(ps, "bad \\u escape"); return 0; }
    }
    return v;
}

static char *parse_string(parser *ps) {
    if (ps->p >= ps->end || *ps->p != '"') { fail(ps, "expected string"); return NULL; }
    ps->p++;
    size_t cap = 16, len = 0;
    char *buf = (char *)malloc(cap);
    while (ps->p < ps->end && *ps->p != '"') {
        char c = *ps->p++;
        if (c == '\\') {
            if (ps->p >= ps->end) break;
            char e = *ps->p++;
            unsigned code;
            switch (e) {
            case 'n': code = '\n'; break;
            case 't': code = '\t'; break;
            case 'r': code = '\r'; break;
            case 'b': code = '\b'; break;
            case 'f': code = '\f'; break;
            case 'u':
                code = hex4(ps);
                if (code >= 0xD800 && code < 0xDC00 && ps->p + 1 < ps->end && ps->p[0] == '\\' && ps->p[1] == 'u') {
                    ps->p += 2;
                    unsigned low = hex4(ps);
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                }
                break;
            default: code = (unsigned char)e; break;
            }
            append_utf8(&buf, &len, &cap, code);
        } else {
            if (len + 1 >= cap) {
                cap *= 2;
                buf = (char *)realloc(buf, cap);
            }
            buf[len++] = c;
        }
    }
    if (ps->p >= ps->end) { fail(ps, "unterminated string"); free(buf); return NULL; }
    ps->p++;
    buf[len] = 0;
    return buf;
}

static int parse_container(parser *ps, json_value *out, int object) {
    char close = object ? '}' : ']';
    ps->p++;
    int cap = 4;
    out->type = object ? JSON_OBJECT : JSON_ARRAY;
    out->items = (json_value *)calloc((size_t)cap, sizeof(json_value));
    out->keys = object ? (char **)calloc((size_t)cap, sizeof(char *)) : NULL;
    out->count = 0;
    skip_ws(ps);
    if (ps->p < ps->end && *ps->p == close) { ps->p++; return 1; }
    for (;;) {
        if (out->count == cap) {
            cap *= 2;
            out->items = (json_value *)realloc(out->items, sizeof(json_value) * (size_t)cap);
            if (object) out->keys = (char **)realloc(out->keys, sizeof(char *) * (size_t)cap);
        }
        skip_ws(ps);
        if (object) {
            char *key = parse_string(ps);
            if (!key) return 0;
            out->keys[out->count] = key;
            skip_ws(ps);
            if (ps->p >= ps->end || *ps->p != ':') { fail(ps, "expected ':'"); out->count++; out->items[out->count - 1].type = JSON_NULL; return 0; }
            ps->p++;
            skip_ws(ps);
        }
        memset(&out->items[out->count], 0, sizeof(json_value));
        int ok = parse_value(ps, &out->items[out->count]);
        out->count++;
        if (!ok) return 0;
        skip_ws(ps);
        if (ps->p < ps->end && *ps->p == ',') { ps->p++; continue; }
        if (ps->p < ps->end && *ps->p == close) { ps->p++; return 1; }
        fail(ps, object ? "expected ',' or '}'" : "expected ',' or ']'");
        return 0;
    }
}

static int parse_value(parser *ps, json_value *out) {
    skip_ws(ps);
    if (ps->p >= ps->end) { fail(ps, "unexpected end"); return 0; }
    char c = *ps->p;
    if (c == '{') return parse_container(ps, out, 1);
    if (c == '[') return parse_container(ps, out, 0);
    if (c == '"') {
        out->type = JSON_STRING;
        out->string = parse_string(ps);
        return out->string != NULL;
    }
    if (c == 't' && ps->end - ps->p >= 4 && memcmp(ps->p, "true", 4) == 0) {
        out->type = JSON_BOOL; out->boolean = 1; ps->p += 4; return 1;
    }
    if (c == 'f' && ps->end - ps->p >= 5 && memcmp(ps->p, "false", 5) == 0) {
        out->type = JSON_BOOL; out->boolean = 0; ps->p += 5; return 1;
    }
    if (c == 'n' && ps->end - ps->p >= 4 && memcmp(ps->p, "null", 4) == 0) {
        out->type = JSON_NULL; ps->p += 4; return 1;
    }
    /* strtod reads exactly what JSON.stringify wrote, correctly rounded,
     * which is what makes a fixture number the same double on both sides. */
    char *endp = NULL;
    double v = strtod(ps->p, &endp);
    if (endp == ps->p) { fail(ps, "unexpected character"); return 0; }
    ps->p = endp;
    out->type = JSON_NUMBER;
    out->number = v;
    return 1;
}

json_value *json_parse(const char *text, size_t length, char *error, size_t error_size) {
    parser ps = { text, text + length, error, error_size, 0 };
    json_value *root = (json_value *)calloc(1, sizeof(json_value));
    if (!parse_value(&ps, root) || ps.failed) {
        json_free(root);
        if (!ps.failed) fail(&ps, "parse failed");
        return NULL;
    }
    return root;
}

static void free_inner(json_value *v) {
    if (v->type == JSON_STRING) free(v->string);
    if (v->type == JSON_ARRAY || v->type == JSON_OBJECT) {
        for (int i = 0; i < v->count; i++) {
            free_inner(&v->items[i]);
            if (v->keys) free(v->keys[i]);
        }
        free(v->items);
        free(v->keys);
    }
}

void json_free(json_value *value) {
    if (!value) return;
    free_inner(value);
    free(value);
}

const json_value *json_get(const json_value *object, const char *key) {
    if (!object || object->type != JSON_OBJECT) return NULL;
    for (int i = 0; i < object->count; i++) {
        if (strcmp(object->keys[i], key) == 0) return &object->items[i];
    }
    return NULL;
}

const char *json_string(const json_value *value, const char *fallback) {
    return value && value->type == JSON_STRING ? value->string : fallback;
}

int json_is_number(const json_value *value) {
    return value && (value->type == JSON_NUMBER || value->type == JSON_BOOL);
}

double json_number(const json_value *value, double fallback) {
    if (!value) return fallback;
    if (value->type == JSON_NUMBER) return value->number;
    if (value->type == JSON_BOOL) return value->boolean ? 1 : 0;
    return fallback;
}

char *json_read_file(const char *path, size_t *length) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = (char *)malloc((size_t)size + 1);
    size_t got = fread(buf, 1, (size_t)size, f);
    fclose(f);
    buf[got] = 0;
    if (length) *length = got;
    return buf;
}
