/* GTA III Web: persistent cache and startup prefetch for streamed game assets.
 *
 * The engine requests TXDs, audio banks and IMG chunks through fetch().
 * Cache Storage keeps successful downloads between visits. A small set of
 * common assets is warmed during Emscripten preRun, before gameplay begins.
 */
(() => {
    "use strict";

    const CACHE_NAME = "gta3-stream-assets-v1";
    const CACHE_LIMIT = 448 * 1024 * 1024;
    const MAX_CACHED_RESPONSE = 32 * 1024 * 1024;
    const AUDIO_PREFETCH_LIMIT = 512 * 1024;

    const nativeFetch = window.fetch.bind(window);
    const imageArchiveParts = new Map();
    const prefetchRequests = new Set();

    let cachePromise;
    let cacheBytes = null;
    let cacheWriteQueue = Promise.resolve();

    function requestUrl(input, init) {
        try {
            const raw = input instanceof Request ? input.url : String(input);
            const url = new URL(raw, document.baseURI);
            const method = init?.method || (input instanceof Request ? input.method : "GET");
            if (method.toUpperCase() !== "GET" || url.origin !== location.origin) return null;

            const path = url.pathname;
            const isLazyAsset = /\/(?:audio|txd)\//i.test(path);
            const isArchiveManifest = /\.parts$/i.test(path);
            const isArchiveChunk = /\.\d{3}$/i.test(path);
            const isLazyManifest = /\/lazy_manifest\.json$/i.test(path);

            return isLazyAsset || isArchiveManifest || isArchiveChunk || isLazyManifest
                ? url.href
                : null;
        } catch {
            return null;
        }
    }

    function getCache() {
        if (!("caches" in window)) return Promise.resolve(null);
        if (!cachePromise) {
            cachePromise = caches.open(CACHE_NAME).catch((error) => {
                console.warn("[stream-cache] Cache Storage unavailable:", error);
                return null;
            });
        }
        return cachePromise;
    }

    function responseSize(response) {
        const value = Number(response.headers.get("content-length"));
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    async function calculateCacheBytes(cache) {
        const keys = await cache.keys();
        let total = 0;
        for (const key of keys) {
            const response = await cache.match(key);
            if (response) total += responseSize(response);
        }
        cacheBytes = total;
        return total;
    }

    async function makeCacheRoom(cache, needed) {
        if (cacheBytes === null) await calculateCacheBytes(cache);
        if (cacheBytes + needed <= CACHE_LIMIT) return;

        // Cache.keys() preserves insertion order. Evict the oldest entries first.
        const keys = await cache.keys();
        for (const key of keys) {
            if (cacheBytes + needed <= CACHE_LIMIT) break;
            const oldResponse = await cache.match(key);
            const oldSize = oldResponse ? responseSize(oldResponse) : 0;
            await cache.delete(key);
            cacheBytes = Math.max(0, cacheBytes - oldSize);
        }
    }

    function persistResponse(url, response) {
        const size = responseSize(response);
        if (!size || size > MAX_CACHED_RESPONSE) return;

        cacheWriteQueue = cacheWriteQueue.then(async () => {
            const cache = await getCache();
            if (!cache) return;

            const previous = await cache.match(url);
            if (previous) {
                cacheBytes = cacheBytes === null
                    ? null
                    : Math.max(0, cacheBytes - responseSize(previous));
                await cache.delete(url);
            }

            await makeCacheRoom(cache, size);
            await cache.put(url, response);
            if (cacheBytes !== null) cacheBytes += size;
        }).catch((error) => {
            // Caching is an optimization only; never fail a game asset request.
            console.warn("[stream-cache] Could not persist asset:", url, error);
        });
    }

    function rememberArchiveManifest(url, response) {
        if (!/\.parts$/i.test(new URL(url).pathname)) return;
        response.clone().json().then((manifest) => {
            const size = Number(manifest?.size);
            const partSize = Number(manifest?.partSize);
            if (size > 0 && partSize > 0) {
                imageArchiveParts.set(url.slice(0, -".parts".length), {
                    count: Math.ceil(size / partSize),
                });
            }
        }).catch(() => {});
    }

    function prefetchNextArchiveChunk(url) {
        const match = url.match(/^(.*)\.(\d{3})(?:[?#].*)?$/);
        if (!match) return;

        const archive = imageArchiveParts.get(match[1]);
        if (!archive) return;

        const nextIndex = Number(match[2]) + 1;
        if (nextIndex >= archive.count) return;

        const nextUrl = match[1] + "." + String(nextIndex).padStart(3, "0");
        if (prefetchRequests.has(nextUrl)) return;

        prefetchRequests.add(nextUrl);
        window.fetch(nextUrl).then((response) => {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.arrayBuffer();
        }).catch((error) => {
            console.warn("[stream-cache] Next archive chunk prefetch failed:", nextUrl, error);
        }).finally(() => {
            prefetchRequests.delete(nextUrl);
        });
    }

    window.fetch = async function gta3CachedFetch(input, init) {
        const url = requestUrl(input, init);
        if (!url) return nativeFetch(input, init);

        const isPrefetch = prefetchRequests.has(url);
        const cache = await getCache();

        if (cache) {
            try {
                const cached = await cache.match(url);
                if (cached) {
                    rememberArchiveManifest(url, cached);
                    if (!isPrefetch) prefetchNextArchiveChunk(url);
                    return cached;
                }
            } catch (error) {
                console.warn("[stream-cache] Cache read failed:", error);
            }
        }

        const response = await nativeFetch(input, init);
        if (response.ok && response.status === 200 && response.type !== "opaque" && cache) {
            const clone = response.clone();
            rememberArchiveManifest(url, clone);
            persistResponse(url, clone);
        }

        if (!isPrefetch) prefetchNextArchiveChunk(url);
        return response;
    };

    async function prefetchCommonAssets() {
        if (!("caches" in window)) return;

        const response = await window.fetch(new URL("lazy_manifest.json", document.baseURI));
        if (!response.ok) throw new Error("lazy_manifest.json returned HTTP " + response.status);

        const manifest = await response.json();
        const urls = [];

        for (const [key, value] of Object.entries(manifest)) {
            if (!Array.isArray(value) || typeof value[0] !== "string") continue;

            const isTexture = key.toLowerCase().startsWith("txd/");
            const isSmallAudio = key.toLowerCase().startsWith("audio/")
                && Number(value[1]) > 0
                && Number(value[1]) <= AUDIO_PREFETCH_LIMIT;

            if (!isTexture && !isSmallAudio) continue;

            const path = value[0];
            const partCount = Number(value[2]) || 0;
            if (partCount > 0) {
                for (let i = 0; i < partCount; i++) {
                    urls.push(path + "." + String(i).padStart(3, "0"));
                }
            } else {
                urls.push(path);
            }
        }

        let next = 0;
        let completed = 0;
        let failed = 0;

        const worker = async () => {
            while (next < urls.length) {
                const path = urls[next++];
                try {
                    const asset = await window.fetch(new URL(path, document.baseURI));
                    if (!asset.ok) throw new Error("HTTP " + asset.status);
                    await asset.arrayBuffer();
                } catch (error) {
                    failed++;
                    console.warn("[stream-cache] Asset prefetch failed:", path, error);
                } finally {
                    completed++;
                    if (typeof Module?.setStatus === "function") {
                        Module.setStatus("Preparing common assets (" + completed + "/" + urls.length + ")...");
                    }
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));
        // Ensure all Cache Storage writes finish before Emscripten starts main().
        await cacheWriteQueue;
        console.info("[stream-cache] Common asset prefetch finished:", {
            total: urls.length,
            failed,
        });
    }

    // Emscripten waits for this run dependency before entering main(). This
    // downloads all TXDs and small sound banks in advance, avoiding network
    // waits for those frequently used assets during gameplay.
    if (typeof Module !== "undefined") {
        Module.preRun = Module.preRun || [];
        Module.preRun.push(function gta3WarmStreamedAssets() {
            if (!("caches" in window)) return;

            Module.addRunDependency("gta3-stream-cache-warmup");
            Module.setStatus("Preparing streamed textures and audio...");
            prefetchCommonAssets().catch((error) => {
                console.warn("[stream-cache] Startup prefetch skipped:", error);
            }).then(() => {
                Module.removeRunDependency("gta3-stream-cache-warmup");
                Module.setStatus("");
            });
        });
    }

    console.info("[stream-cache] Persistent asset cache enabled");
})();
