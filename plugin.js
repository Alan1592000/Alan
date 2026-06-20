"use strict";
const TRACE_PREFIX = "[FlacHiTrace]";
const DEFAULT_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const DEFAULT_BASE_URL = "https://flac.music.hi.cn";
const DEFAULT_SEARCH_PATH = "/getSearchMusic.php";
const DEFAULT_MEDIA_PATH = "/getMusicUrl.php";
const DEFAULT_LYRIC_PATH = "/getLyric.php";
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_DOWNLOAD_DIR = "/music";
class HttpTraceError extends Error {
    constructor(message, options) {
        super(message);
        this.name = "HttpTraceError";
        this.status = options.status;
        this.url = options.url;
        this.responseText = options.responseText;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function safeSerialize(value) {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, function (_key, currentValue) {
            if (currentValue instanceof Error) {
                return {
                    name: currentValue.name,
                    message: currentValue.message,
                    stack: currentValue.stack
                };
            }
            if (typeof currentValue === "undefined") {
                return "[undefined]";
            }
            if (typeof currentValue === "function") {
                return `[function ${currentValue.name || "anonymous"}]`;
            }
            if (isRecord(currentValue) || Array.isArray(currentValue)) {
                if (seen.has(currentValue)) {
                    return "[circular]";
                }
                seen.add(currentValue);
            }
            return currentValue;
        }, 2);
    }
    catch (error) {
        return `[unserializable: ${error.message}]`;
    }
}
function trace(step, payload) {
    if (typeof payload === "undefined") {
        console.log(`${TRACE_PREFIX} ${step}`);
        return;
    }
    console.log(`${TRACE_PREFIX} ${step} ${safeSerialize(payload)}`);
}
function traceError(step, error, extra) {
    console.error(`${TRACE_PREFIX} ${step} ${safeSerialize({
        error,
        extra
    })}`);
}
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "");
}
function normalizePath(pathValue) {
    if (!pathValue) {
        return "/";
    }
    return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}
function getUserVariablesSafe() {
    try {
        const variables = env && typeof env.getUserVariables === "function" ? env.getUserVariables() : {};
        const normalized = {};
        Object.keys(variables || {}).forEach(function (key) {
            const value = variables[key];
            if (typeof value === "string") {
                normalized[key] = value.trim();
            }
        });
        trace("USER_VARIABLES", normalized);
        return normalized;
    }
    catch (error) {
        traceError("USER_VARIABLES_FAILED", error);
        return {};
    }
}
function getRuntimeConfig() {
    const variables = getUserVariablesSafe();
    const config = {
        baseUrl: normalizeBaseUrl(variables.baseUrl || DEFAULT_BASE_URL),
        searchPath: normalizePath(variables.searchPath || DEFAULT_SEARCH_PATH),
        mediaPath: normalizePath(variables.mediaPath || DEFAULT_MEDIA_PATH),
        lyricPath: normalizePath(variables.lyricPath || DEFAULT_LYRIC_PATH),
        cookie: variables.cookie || "",
        pageSize: DEFAULT_PAGE_SIZE,
        downloadDir: DEFAULT_DOWNLOAD_DIR
    };
    trace("RUNTIME_CONFIG", config);
    return config;
}
function buildUrl(baseUrl, pathValue, params) {
    const url = new URL(normalizePath(pathValue), `${normalizeBaseUrl(baseUrl)}/`);
    if (params) {
        Object.keys(params).forEach(function (key) {
            const value = params[key];
            if (typeof value !== "undefined" && value !== null && `${value}`.length > 0) {
                url.searchParams.set(key, String(value));
            }
        });
    }
    return url.toString();
}
function formEncode(params) {
    const searchParams = new URLSearchParams();
    Object.keys(params).forEach(function (key) {
        const value = params[key];
        if (typeof value !== "undefined" && value !== null && `${value}`.length > 0) {
            searchParams.set(key, String(value));
        }
    });
    return searchParams.toString();
}
function buildRequestHeaders(config, contentType) {
    const headers = {
        Accept: "application/json, text/plain, */*",
        Origin: config.baseUrl,
        Referer: `${config.baseUrl}/`,
        "User-Agent": DEFAULT_BROWSER_UA,
        "X-Requested-With": "XMLHttpRequest"
    };
    if (contentType) {
        headers["Content-Type"] = contentType;
    }
    if (config.cookie) {
        headers.Cookie = config.cookie;
    }
    return headers;
}
function buildPlaybackHeaders(config) {
    const headers = {
        Accept: "*/*",
        Origin: config.baseUrl,
        Referer: `${config.baseUrl}/`
    };
    if (config.cookie) {
        headers.Cookie = config.cookie;
    }
    return headers;
}
function shouldRetryWithoutUserAgent(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes("user-agent") || message.includes("forbidden") || message.includes("unsafe header");
}
function collectResponseHeaders(headers) {
    const result = {};
    headers.forEach(function (value, key) {
        result[key] = value;
    });
    return result;
}
async function fetchWithTrace(candidate) {
    trace("HTTP_REQUEST", candidate);
    async function runOnce(withUserAgent) {
        const headers = { ...candidate.headers };
        if (!withUserAgent) {
            delete headers["User-Agent"];
        }
        const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
        const timer = controller &&
            typeof setTimeout !== "undefined"
            ? setTimeout(function () {
                controller.abort();
            }, 15000)
            : undefined;
        try {
            const response = await fetch(candidate.url, {
                method: candidate.method,
                headers,
                body: candidate.body,
                signal: controller ? controller.signal : undefined
            });
            const text = await response.text();
            trace("HTTP_RESPONSE", {
                label: candidate.label,
                url: candidate.url,
                status: response.status,
                headers: collectResponseHeaders(response.headers),
                bodyText: text
            });
            if (!response.ok) {
                throw new HttpTraceError(`HTTP ${response.status} for ${candidate.url}`, {
                    status: response.status,
                    url: candidate.url,
                    responseText: text
                });
            }
            return {
                status: response.status,
                text
            };
        }
        finally {
            if (typeof timer !== "undefined") {
                clearTimeout(timer);
            }
        }
    }
    try {
        return await runOnce(true);
    }
    catch (error) {
        if (!shouldRetryWithoutUserAgent(error)) {
            throw error;
        }
        trace("HTTP_RETRY_WITHOUT_UA", {
            label: candidate.label,
            url: candidate.url
        });
        return runOnce(false);
    }
}
function parseJsonWithTrace(text, label) {
    trace("JSON_PARSE_INPUT", {
        label,
        text
    });
    try {
        const parsed = JSON.parse(text);
        trace("JSON_PARSE_OUTPUT", {
            label,
            json: parsed
        });
        return parsed;
    }
    catch (error) {
        traceError("JSON_PARSE_FAILED", error, {
            label,
            text
        });
        throw error;
    }
}
function firstArray(value) {
    if (Array.isArray(value)) {
        return value.filter(isRecord);
    }
    return [];
}
function toAnyRecord(value) {
    return isRecord(value) ? value : {};
}
function pickFirstString(...values) {
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (isNonEmptyString(value)) {
            return value.trim();
        }
        if (typeof value === "number" && Number.isFinite(value)) {
            return String(value);
        }
    }
    return "";
}
function joinArtistNames(value) {
    if (Array.isArray(value)) {
        const names = value
            .map(function (item) {
            if (isRecord(item)) {
                return pickFirstString(item.name, item.artistName, item.nickname);
            }
            if (isNonEmptyString(item)) {
                return item.trim();
            }
            return "";
        })
            .filter(Boolean);
        return names.join("/");
    }
    if (isRecord(value)) {
        return pickFirstString(value.name, value.artistName);
    }
    return pickFirstString(value);
}
function normalizeDuration(value) {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0) {
        return undefined;
    }
    if (numberValue > 1000) {
        return Math.round(numberValue / 1000);
    }
    return Math.round(numberValue);
}
function normalizeSearchPayload(raw) {
    const record = toAnyRecord(raw);
    const nestedData = toAnyRecord(record.data);
    const nestedResult = toAnyRecord(record.result);
    const songs = firstArray(record.songs) ||
        firstArray(nestedData.songs) ||
        firstArray(nestedResult.songs) ||
        firstArray(record.data) ||
        firstArray(record.list);
    const total = Number(record.total) ||
        Number(record.count) ||
        Number(record.songCount) ||
        Number(nestedData.total) ||
        Number(nestedResult.songCount) ||
        songs.length;
    return {
        songs,
        total: Number.isFinite(total) ? total : songs.length
    };
}
function mapSearchSong(item, config) {
    const albumRecord = toAnyRecord(item.al || item.album || item.albumInfo);
    const mapped = {
        id: pickFirstString(item.id, item.songId, item.song_id),
        title: pickFirstString(item.name, item.title),
        artist: pickFirstString(item.artists, item.artist, joinArtistNames(item.ar), joinArtistNames(item.artistsList), joinArtistNames(item.artistsInfo)),
        album: pickFirstString(item.album, albumRecord.name, item.albumName),
        artwork: pickFirstString(item.picUrl, item.cover, item.artwork, albumRecord.picUrl, albumRecord.cover),
        duration: normalizeDuration(item.duration || item.dt || item.length),
        sourceId: pickFirstString(item.id, item.songId, item.song_id),
        downloadDirHint: config.downloadDir,
        preferredQuality: "lossless"
    };
    trace("FIELD_MAPPING_COMPARE", {
        raw: item,
        mapped
    });
    return mapped;
}
function buildSearchCandidates(query, page, config) {
    const offset = Math.max(0, (page - 1) * config.pageSize);
    const commonPayload = {
        keywords: query,
        search: query,
        s: query,
        q: query,
        limit: config.pageSize,
        offset,
        page
    };
    const jsonPayload = JSON.stringify({
        keywords: query,
        limit: config.pageSize,
        offset,
        page
    });
    return [
        {
            label: "search-get-keywords",
            method: "GET",
            url: buildUrl(config.baseUrl, config.searchPath, {
                keywords: query,
                limit: config.pageSize,
                offset
            }),
            headers: buildRequestHeaders(config)
        },
        {
            label: "search-get-search",
            method: "GET",
            url: buildUrl(config.baseUrl, config.searchPath, {
                search: query,
                limit: config.pageSize,
                offset
            }),
            headers: buildRequestHeaders(config)
        },
        {
            label: "search-get-s",
            method: "GET",
            url: buildUrl(config.baseUrl, config.searchPath, {
                s: query,
                limit: config.pageSize,
                offset
            }),
            headers: buildRequestHeaders(config)
        },
        {
            label: "search-post-form",
            method: "POST",
            url: buildUrl(config.baseUrl, config.searchPath),
            headers: buildRequestHeaders(config, "application/x-www-form-urlencoded; charset=UTF-8"),
            body: formEncode(commonPayload)
        },
        {
            label: "search-post-json",
            method: "POST",
            url: buildUrl(config.baseUrl, config.searchPath),
            headers: buildRequestHeaders(config, "application/json; charset=UTF-8"),
            body: jsonPayload
        }
    ];
}
async function searchMusic(query, page, config) {
    const candidates = buildSearchCandidates(query, page, config);
    let firstSuccess = null;
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
            const response = await fetchWithTrace(candidate);
            const raw = parseJsonWithTrace(response.text, candidate.label);
            const normalized = normalizeSearchPayload(raw);
            const mapped = normalized.songs.map(function (item) {
                return mapSearchSong(item, config);
            });
            const result = {
                isEnd: normalized.total > 0 ? page * config.pageSize >= normalized.total : mapped.length < config.pageSize,
                data: mapped
            };
            trace("SEARCH_RESULT", {
                candidate: candidate.label,
                query,
                page,
                total: normalized.total,
                count: mapped.length,
                result
            });
            if (!firstSuccess) {
                firstSuccess = result;
            }
            if (mapped.length > 0) {
                return result;
            }
        }
        catch (error) {
            lastError = error;
            traceError("SEARCH_CANDIDATE_FAILED", error, {
                candidate
            });
        }
    }
    if (firstSuccess) {
        return firstSuccess;
    }
    throw lastError instanceof Error ? lastError : new Error("搜索接口全部失败");
}
function buildQualityCandidates(requestedQuality) {
    const normalized = pickFirstString(requestedQuality).toLowerCase();
    const mapped = normalized === "flac" || normalized === "lossless" || normalized === "super"
        ? "lossless"
        : normalized === "flac24bit" || normalized === "hires"
            ? "hires"
            : normalized === "jymaster" || normalized === "master"
                ? "jymaster"
                : normalized === "high" || normalized === "320k" || normalized === "exhigh"
                    ? "exhigh"
                    : normalized === "low" || normalized === "128k" || normalized === "standard" || normalized === "192k"
                        ? "standard"
                        : "";
    const order = [mapped, "lossless", "jymaster", "hires", "exhigh", "standard"].filter(Boolean);
    return Array.from(new Set(order));
}
function extractMusicId(musicItem) {
    const musicId = pickFirstString(musicItem.sourceId, musicItem.serverId, musicItem.id);
    if (!musicId) {
        throw new Error("musicItem 中缺少可用的 id/sourceId");
    }
    return musicId;
}
function buildMediaCandidates(musicItem, quality, config) {
    const musicId = extractMusicId(musicItem);
    const qualityList = buildQualityCandidates(quality);
    const candidates = [];
    qualityList.forEach(function (currentQuality) {
        candidates.push({
            label: `media-get-id-quality-${currentQuality}`,
            method: "GET",
            url: buildUrl(config.baseUrl, config.mediaPath, {
                id: musicId,
                quality: currentQuality
            }),
            headers: buildRequestHeaders(config)
        });
        candidates.push({
            label: `media-get-id-level-${currentQuality}`,
            method: "GET",
            url: buildUrl(config.baseUrl, config.mediaPath, {
                id: musicId,
                level: currentQuality
            }),
            headers: buildRequestHeaders(config)
        });
        candidates.push({
            label: `media-get-ids-level-${currentQuality}`,
            method: "GET",
            url: buildUrl(config.baseUrl, config.mediaPath, {
                ids: musicId,
                level: currentQuality
            }),
            headers: buildRequestHeaders(config)
        });
        candidates.push({
            label: `media-post-form-${currentQuality}`,
            method: "POST",
            url: buildUrl(config.baseUrl, config.mediaPath),
            headers: buildRequestHeaders(config, "application/x-www-form-urlencoded; charset=UTF-8"),
            body: formEncode({
                id: musicId,
                level: currentQuality,
                quality: currentQuality
            })
        });
        candidates.push({
            label: `media-post-json-${currentQuality}`,
            method: "POST",
            url: buildUrl(config.baseUrl, config.mediaPath),
            headers: buildRequestHeaders(config, "application/json; charset=UTF-8"),
            body: JSON.stringify({
                id: musicId,
                level: currentQuality,
                quality: currentQuality
            })
        });
    });
    return candidates;
}
function normalizeMediaPayload(raw) {
    const record = toAnyRecord(raw);
    const nestedData = record.data;
    const list = firstArray(raw).length
        ? firstArray(raw)
        : firstArray(nestedData).length
            ? firstArray(nestedData)
            : firstArray(toAnyRecord(record.result).data);
    const item = list[0] || toAnyRecord(nestedData) || record;
    return {
        url: pickFirstString(item.url, item.playUrl, item.musicUrl),
        level: pickFirstString(item.level, item.quality),
        br: Number(item.br || item.bitrate),
        size: Number(item.size || item.fileSize),
        md5: pickFirstString(item.md5)
    };
}
async function probeMediaUrl(url, config) {
    const headers = buildPlaybackHeaders(config);
    trace("MEDIA_PROBE_REQUEST", {
        url,
        headers
    });
    try {
        const response = await fetch(url, {
            method: "HEAD",
            headers
        });
        trace("MEDIA_PROBE_RESPONSE", {
            url,
            status: response.status,
            headers: collectResponseHeaders(response.headers)
        });
        if (response.status === 403 || response.status === 404) {
            throw new HttpTraceError(`音频直链探测失败: ${response.status}`, {
                status: response.status,
                url
            });
        }
    }
    catch (error) {
        if (error instanceof HttpTraceError) {
            throw error;
        }
        traceError("MEDIA_PROBE_SKIPPED", error, {
            url
        });
    }
}
async function resolveMediaSource(musicItem, quality, config) {
    const candidates = buildMediaCandidates(musicItem, quality, config);
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
            const response = await fetchWithTrace(candidate);
            const raw = parseJsonWithTrace(response.text, candidate.label);
            const normalized = normalizeMediaPayload(raw);
            trace("MEDIA_PAYLOAD_NORMALIZED", {
                candidate: candidate.label,
                normalized
            });
            if (!normalized.url) {
                continue;
            }
            const directUrl = normalized.url.replace(/^http:\/\//i, "https://");
            await probeMediaUrl(directUrl, config);
            const result = {
                url: directUrl,
                headers: buildPlaybackHeaders(config),
                userAgent: DEFAULT_BROWSER_UA,
                quality: normalized.level
            };
            trace("MEDIA_SOURCE_RESULT", {
                candidate: candidate.label,
                result
            });
            return result;
        }
        catch (error) {
            lastError = error;
            traceError("MEDIA_SOURCE_CANDIDATE_FAILED", error, {
                candidate,
                requestedQuality: quality,
                musicItem
            });
            if (error instanceof HttpTraceError && (error.status === 403 || error.status === 404)) {
                continue;
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error("未获取到可用音频地址");
}
function buildLyricCandidates(musicItem, config) {
    const musicId = extractMusicId(musicItem);
    return [
        {
            label: "lyric-get-id",
            method: "GET",
            url: buildUrl(config.baseUrl, config.lyricPath, {
                id: musicId
            }),
            headers: buildRequestHeaders(config)
        },
        {
            label: "lyric-get-songId",
            method: "GET",
            url: buildUrl(config.baseUrl, config.lyricPath, {
                songId: musicId
            }),
            headers: buildRequestHeaders(config)
        },
        {
            label: "lyric-post-form",
            method: "POST",
            url: buildUrl(config.baseUrl, config.lyricPath),
            headers: buildRequestHeaders(config, "application/x-www-form-urlencoded; charset=UTF-8"),
            body: formEncode({
                id: musicId
            })
        },
        {
            label: "lyric-post-json",
            method: "POST",
            url: buildUrl(config.baseUrl, config.lyricPath),
            headers: buildRequestHeaders(config, "application/json; charset=UTF-8"),
            body: JSON.stringify({
                id: musicId
            })
        }
    ];
}
function normalizeLyricSource(raw) {
    const record = toAnyRecord(raw);
    const nestedData = toAnyRecord(record.data);
    const lrcRecord = toAnyRecord(record.lrc || nestedData.lrc);
    const translatedRecord = toAnyRecord(record.tlyric || nestedData.tlyric);
    const rawLrc = pickFirstString(record.rawLrc, nestedData.rawLrc, lrcRecord.lyric, nestedData.lrc);
    const translated = pickFirstString(translatedRecord.lyric, nestedData.tlyric);
    const lrc = rawLrc || translated;
    return {
        lrc,
        rawLrc
    };
}
async function resolveLyric(musicItem, config) {
    const candidates = buildLyricCandidates(musicItem, config);
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
            const response = await fetchWithTrace(candidate);
            const raw = parseJsonWithTrace(response.text, candidate.label);
            const normalized = normalizeLyricSource(raw);
            trace("LYRIC_RESULT", {
                candidate: candidate.label,
                normalized
            });
            if (normalized.rawLrc || normalized.lrc) {
                return normalized;
            }
        }
        catch (error) {
            lastError = error;
            traceError("LYRIC_CANDIDATE_FAILED", error, {
                candidate,
                musicItem
            });
        }
    }
    if (lastError) {
        traceError("LYRIC_ALL_FAILED", lastError, {
            musicItem
        });
    }
    return null;
}
const plugin = {
    platform: "极空间 FLAC 音源",
    author: "OpenAI",
    version: "1.0.0",
    cacheControl: "no-store",
    primaryKey: ["id"],
    supportedSearchType: ["music"],
    userVariables: [
        { key: "baseUrl", title: "基础地址" },
        { key: "cookie", title: "站点Cookie" },
        { key: "searchPath", title: "搜索接口路径" },
        { key: "mediaPath", title: "音源接口路径" },
        { key: "lyricPath", title: "歌词接口路径" }
    ],
    hints: {
        importMusicItem: [
            "服务端下载目录固定使用 /music，请确保极空间容器挂载目录也为 /music。",
            "若 flac.music.hi.cn 启用了防护页，可在插件变量中填写站点 Cookie 后再重试。"
        ],
        importMusicSheet: [
            "当前插件聚焦 search、getMediaSource、getLyric，暂未实现歌单导入。"
        ]
    },
    async search(query, page, type) {
        trace("SEARCH_ENTER", {
            query,
            page,
            type
        });
        const config = getRuntimeConfig();
        if (type !== "music") {
            trace("SEARCH_UNSUPPORTED_TYPE", { type });
            return {
                isEnd: true,
                data: []
            };
        }
        try {
            const result = await searchMusic(query, page, config);
            trace("SEARCH_EXIT", result);
            return result;
        }
        catch (error) {
            traceError("SEARCH_FATAL", error, {
                query,
                page,
                type
            });
            throw error;
        }
    },
    async getMediaSource(musicItem, quality) {
        trace("GET_MEDIA_SOURCE_ENTER", {
            musicItem,
            quality
        });
        const config = getRuntimeConfig();
        try {
            const result = await resolveMediaSource(musicItem, quality, config);
            trace("GET_MEDIA_SOURCE_EXIT", result);
            return result;
        }
        catch (error) {
            traceError("GET_MEDIA_SOURCE_FATAL", error, {
                musicItem,
                quality
            });
            throw error;
        }
    },
    async getLyric(musicItem) {
        trace("GET_LYRIC_ENTER", {
            musicItem
        });
        const config = getRuntimeConfig();
        try {
            const result = await resolveLyric(musicItem, config);
            trace("GET_LYRIC_EXIT", result);
            return result;
        }
        catch (error) {
            traceError("GET_LYRIC_FATAL", error, {
                musicItem
            });
            throw error;
        }
    }
};
module.exports = plugin;
