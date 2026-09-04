/*
 * Gram Flow
 * Static, dependency-free RTDB client. New clips keep their direct media URL in
 * /videos/{id}/src and retain the legacy user/desc/music fields for compatibility.
 */
(function () {
  "use strict";

  const CONFIG = Object.freeze({
    databaseUrl: (window.GRAM_FLOW_RTDB_URL || "https://meow-874ce-default-rtdb.europe-west1.firebasedatabase.app").replace(/\/+$/, ""),
    requestTimeout: 14000,
    maxQueueItems: 40,
    maxHistoryItems: 120,
    maxActivityItems: 100,
    schemaVersion: 2
  });

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const now = () => Date.now();
  const uid = (prefix = "id") => {
    const random = window.crypto && crypto.getRandomValues
      ? Array.from(crypto.getRandomValues(new Uint32Array(2))).map(n => n.toString(36)).join("")
      : Math.random().toString(36).slice(2);
    return `${prefix}_${random}_${now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, "_");
  };

  const STORAGE = Object.freeze({
    device: "gram-flow-device-id",
    profile: "gram-flow-profile",
    preferences: "gram-flow-preferences",
    likes: "gram-flow-liked",
    bookmarks: "gram-flow-bookmarks",
    follows: "gram-flow-follows",
    hidden: "gram-flow-hidden",
    reposts: "gram-flow-reposts",
    history: "gram-flow-history",
    activity: "gram-flow-activity",
    outbox: "gram-flow-outbox",
    reports: "gram-flow-reports",
    welcome: "gram-flow-welcome-v2",
    seenAnnouncements: "gram-flow-announcements"
  });

  function storageGet(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn("[Gram Flow] local storage unavailable", error);
      return false;
    }
  }

  function storageString(key, fallback = "") {
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }

  function setStorageString(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* quota / private mode */ }
  }

  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  function asArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value && typeof value === "object") return Object.values(value).filter(Boolean);
    return [];
  }
  function text(value, fallback = "") {
    if (value === undefined || value === null) return fallback;
    return String(value).trim() || fallback;
  }
  function cleanHandle(value, fallback = "@creator") {
    const result = text(value, fallback).replace(/\s+/g, "");
    return result.startsWith("@") ? result.slice(0, 33) : `@${result.slice(0, 32)}`;
  }
  function escapeHTML(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  function svgIcon(id, className = "") {
    return `<svg${className ? ` class="${className}"` : ""}><use href="#${id}"></use></svg>`;
  }
  function safeUrl(value, allowData = false) {
    const candidate = String(value || "").trim();
    // Media and avatar values must be explicit URLs. Do not silently turn an empty
    // or relative value into the current page URL.
    if (!candidate || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) return "";
    try {
      const parsed = new URL(candidate, location.href);
      if (parsed.protocol === "https:") return parsed.href;
      if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return parsed.href;
      if (allowData && parsed.protocol === "data:" && /^data:image\//i.test(parsed.href)) return parsed.href;
    } catch (_) { /* invalid */ }
    return "";
  }
  function directVideoUrl(value, allowLegacyHttp = false) {
    const safe = safeUrl(value, false);
    if (safe) return safe;
    if (allowLegacyHttp) {
      try {
        const parsed = new URL(String(value || ""));
        if (parsed.protocol === "http:") return parsed.href;
      } catch (_) { /* invalid */ }
    }
    return "";
  }
  function dateMillis(value) {
    if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function formatCompact(value) {
    const number = Math.max(0, Number(value) || 0);
    try { return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: number > 999 ? 1 : 0 }).format(number); }
    catch (_) { return String(number); }
  }
  function formatNumber(value) {
    try { return new Intl.NumberFormat("ru-RU").format(Math.max(0, Number(value) || 0)); }
    catch (_) { return String(Math.max(0, Number(value) || 0)); }
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  }
  function relativeTime(value) {
    const time = dateMillis(value);
    if (!time) return "только что";
    const diff = Math.max(0, now() - time);
    if (diff < 60000) return "только что";
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} д`;
    try { return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(time); }
    catch (_) { return new Date(time).toLocaleDateString("ru-RU"); }
  }
  function initials(value) {
    const words = text(value, "GF").replace(/^@/, "").split(/[\s_.-]+/).filter(Boolean);
    return (words.slice(0, 2).map(word => word[0]).join("") || "GF").toUpperCase();
  }
  function hashNumber(value) {
    let hash = 2166136261;
    const string = String(value || "");
    for (let i = 0; i < string.length; i += 1) {
      hash ^= string.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0);
  }
  function colorPair(value) {
    const hue = hashNumber(value) % 360;
    return {
      hue,
      accent: `hsl(${hue} 76% 61%)`,
      start: `hsl(${hue} 72% 56%)`,
      end: `hsl(${(hue + 73) % 360} 68% 51%)`,
      background: `linear-gradient(135deg, hsl(${hue} 52% 35%), hsl(${(hue + 75) % 360} 56% 19%))`
    };
  }
  function normalizeTag(value) {
    const raw = text(value).trim().replace(/^#/, "").replace(/[^\p{L}\p{N}_-]/gu, "");
    return raw ? `#${raw.slice(0, 42)}` : "";
  }
  function parseTags(value, caption = "") {
    const bag = [];
    const add = item => {
      const normalized = normalizeTag(item);
      if (normalized && !bag.some(tag => tag.toLowerCase() === normalized.toLowerCase())) bag.push(normalized);
    };
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === "string") value.split(/[\s,;]+/).forEach(add);
    else if (value && typeof value === "object") Object.values(value).forEach(add);
    const captionTags = String(caption || "").match(/#[\p{L}\p{N}_-]+/gu) || [];
    captionTags.forEach(add);
    return bag.slice(0, 12);
  }
  function friendlySound(value, author) {
    const sound = text(value);
    if (!sound || /^https?:\/\//i.test(sound)) return `Оригинальный звук · ${cleanHandle(author, "@direct")}`;
    return sound.slice(0, 90);
  }
  function isInputTarget(element) {
    return Boolean(element && element.closest("input, textarea, select, [contenteditable='true']"));
  }

  const DEFAULT_PROFILE = () => ({
    name: "Ваш профиль",
    handle: "@creator",
    bio: "Ваше пространство для смелых коротких историй.",
    avatar: "",
    updatedAt: now()
  });
  const DEFAULT_PREFERENCES = () => ({
    theme: "obsidian",
    reduceMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    compactMode: false,
    autoplay: true,
    muted: true,
    dataSaver: false,
    volume: 0.7,
    fit: "cover"
  });

  const deviceId = storageString(STORAGE.device) || uid("device");
  setStorageString(STORAGE.device, deviceId);

  const state = {
    deviceId,
    root: {},
    clips: [],
    visibleClips: [],
    activeClipId: null,
    activeIndex: 0,
    feedMode: "foryou",
    topic: "all",
    authorFilter: "",
    soundFilter: "",
    feedFilter: { sort: "smart", withSound: false, withTags: false, excludeSeen: false },
    profile: { ...DEFAULT_PROFILE(), ...asObject(storageGet(STORAGE.profile, {})) },
    preferences: { ...DEFAULT_PREFERENCES(), ...asObject(storageGet(STORAGE.preferences, {})) },
    likes: asObject(storageGet(STORAGE.likes, {})),
    bookmarks: asObject(storageGet(STORAGE.bookmarks, {})),
    follows: asObject(storageGet(STORAGE.follows, {})),
    hidden: asObject(storageGet(STORAGE.hidden, {})),
    reposts: asObject(storageGet(STORAGE.reposts, {})),
    history: asArray(storageGet(STORAGE.history, [])),
    activities: asArray(storageGet(STORAGE.activity, [])),
    reports: asArray(storageGet(STORAGE.reports, [])),
    outbox: asArray(storageGet(STORAGE.outbox, [])),
    connection: { status: navigator.onLine ? "connecting" : "offline", lastSync: 0, attempts: 0 },
    renderSignature: "",
    observer: null,
    sourceAborters: new Map(),
    openOverlay: null,
    lastFocused: null,
    composerStep: 1,
    commentClipId: null,
    commentSort: "top",
    replyTo: null,
    shareClipId: null,
    menuClipId: null,
    deepLink: { clip: "", url: "" },
    localClips: [],
    selectedProfileTab: "clips",
    inboxFilter: "all",
    commandSelection: 0,
    commandItems: [],
    tap: { clipId: "", time: 0, timer: 0 },
    viewTimers: new Map(),
    renderedAt: 0
  };

  // Legacy objects were encrypted by the previous page-level codec. The new client
  // only decodes them; all fresh values remain readable JSON in RTDB.
  function decodeLegacy(value) {
    try {
      if (window.LegacyMeowCrypto && typeof window.LegacyMeowCrypto.decrypt === "function") return window.LegacyMeowCrypto.decrypt(value);
    } catch (error) {
      console.warn("[Gram Flow] legacy value could not be decoded", error);
    }
    return value;
  }

  class RtdbClient {
    constructor(baseUrl) {
      this.baseUrl = baseUrl;
      this.eventSources = new Map();
      this.reconnectTimers = new Map();
      this.streamStates = new Map();
      this.streamPaths = [];
      this.closed = false;
      this.handlers = {};
    }

    endpoint(path = "") {
      const cleaned = String(path || "").replace(/^\/+|\/+$/g, "");
      const encoded = cleaned
        ? `/${cleaned.split("/").filter(Boolean).map(segment => encodeURIComponent(segment)).join("/")}`
        : "";
      return `${this.baseUrl}${encoded}.json`;
    }

    async request(method, path, body, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeout || CONFIG.requestTimeout);
      const headers = { ...(options.headers || {}) };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      try {
        const response = await fetch(this.endpoint(path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
          signal: controller.signal
        });
        const raw = await response.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
        if (!response.ok) {
          const error = new Error(`RTDB ${method} ${path || "/"}: HTTP ${response.status}`);
          error.status = response.status;
          error.payload = data;
          throw error;
        }
        return { data: decodeLegacy(data), etag: response.headers.get("etag"), status: response.status };
      } finally {
        clearTimeout(timeout);
      }
    }

    async get(path = "") { return (await this.request("GET", path)).data; }
    async put(path, data) { return (await this.request("PUT", path, data)).data; }
    async patch(path, data) { return (await this.request("PATCH", path, data)).data; }
    async remove(path) { return (await this.request("DELETE", path)).data; }

    async transaction(path, mutate, retries = 4) {
      let lastError = null;
      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          const snapshot = await this.request("GET", path, undefined, { headers: { "X-Firebase-ETag": "true" } });
          const next = mutate(snapshot.data);
          if (next === undefined) return snapshot.data;
          const result = await this.request("PUT", path, next, { headers: { "if-match": snapshot.etag || "*" } });
          return result.data;
        } catch (error) {
          lastError = error;
          if (error.status !== 412 || attempt === retries - 1) throw error;
        }
      }
      throw lastError || new Error("RTDB transaction failed");
    }

    subscribe(handlers, paths = [""]) {
      this.close();
      this.handlers = handlers || {};
      this.closed = false;
      this.streamPaths = Array.from(new Set(paths.map(path => String(path || "").replace(/^\/+|\/+$/g, ""))));
      this.streamPaths.forEach(path => this.openStream(path));
    }

    absoluteEventPath(basePath, eventPath) {
      const base = String(basePath || "").replace(/^\/+|\/+$/g, "");
      const event = String(eventPath || "/").replace(/^\/+|\/+$/g, "");
      if (!base) return event ? `/${event}` : "/";
      return event ? `/${base}/${event}` : `/${base}`;
    }

    emitStatus() {
      const states = Array.from(this.streamStates.values());
      const hasOpen = states.includes("open");
      this.handlers.onStatus && this.handlers.onStatus(hasOpen ? "online" : navigator.onLine ? "reconnecting" : "offline");
    }

    openStream(path) {
      if (this.closed || !("EventSource" in window)) return;
      const key = String(path || "").replace(/^\/+|\/+$/g, "");
      const previous = this.eventSources.get(key);
      if (previous) { try { previous.close(); } catch (_) { /* noop */ } }
      clearTimeout(this.reconnectTimers.get(key));
      try {
        const stream = new EventSource(this.endpoint(key));
        this.eventSources.set(key, stream);
        this.streamStates.set(key, "connecting");
        stream.addEventListener("open", () => {
          if (this.closed || this.eventSources.get(key) !== stream) return;
          state.connection.attempts = 0;
          this.streamStates.set(key, "open");
          this.emitStatus();
        });
        ["put", "patch"].forEach(type => stream.addEventListener(type, event => {
          try {
            const payload = JSON.parse(event.data);
            const decoded = decodeLegacy(payload.data);
            this.handlers.onEvent && this.handlers.onEvent(type, this.absoluteEventPath(key, payload.path), decoded);
          } catch (error) {
            logError("SSE parsing", error);
          }
        }));
        stream.onerror = () => {
          if (this.closed || this.eventSources.get(key) !== stream) return;
          this.streamStates.set(key, "reconnecting");
          this.emitStatus();
          try { stream.close(); } catch (_) { /* noop */ }
          const delay = Math.min(30000, 1100 * Math.pow(1.7, state.connection.attempts++));
          const timer = setTimeout(() => this.openStream(key), delay);
          this.reconnectTimers.set(key, timer);
        };
      } catch (error) {
        this.streamStates.set(key, "reconnecting");
        this.emitStatus();
        logError("SSE startup", error);
      }
    }

    close() {
      this.closed = true;
      this.reconnectTimers.forEach(timer => clearTimeout(timer));
      this.reconnectTimers.clear();
      this.eventSources.forEach(stream => { try { stream.close(); } catch (_) { /* noop */ } });
      this.eventSources.clear();
      this.streamStates.clear();
    }
  }

  const api = new RtdbClient(CONFIG.databaseUrl);

  function logError(scope, error) {
    const message = error && (error.message || String(error));
    console.warn(`[Gram Flow] ${scope}`, error);
    const logs = storageGet("gram-flow-client-log", []);
    logs.unshift({ at: now(), scope, message: text(message, "Unknown error").slice(0, 300) });
    storageSet("gram-flow-client-log", logs.slice(0, 30));
  }

  function announce(message, kind = "info", duration = 3400) {
    const region = $("#toastRegion");
    if (!region) return;
    const toast = document.createElement("div");
    toast.className = `toast${kind === "error" ? " is-error" : kind === "info" ? " is-info" : ""}`;
    toast.innerHTML = `${svgIcon(kind === "error" ? "i-info" : kind === "success" ? "i-check" : "i-sparkles")}<span>${escapeHTML(message)}</span>`;
    region.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 260);
    }, duration);
  }

  function screenReader(message) {
    const target = $("#screenReaderStatus");
    if (!target) return;
    target.textContent = "";
    window.setTimeout(() => { target.textContent = message; }, 25);
  }

  function persist(key) {
    const table = {
      profile: [STORAGE.profile, state.profile], preferences: [STORAGE.preferences, state.preferences], likes: [STORAGE.likes, state.likes],
      bookmarks: [STORAGE.bookmarks, state.bookmarks], follows: [STORAGE.follows, state.follows], hidden: [STORAGE.hidden, state.hidden],
      reposts: [STORAGE.reposts, state.reposts], history: [STORAGE.history, state.history], activity: [STORAGE.activity, state.activities],
      outbox: [STORAGE.outbox, state.outbox], reports: [STORAGE.reports, state.reports]
    };
    if (table[key]) storageSet(table[key][0], table[key][1]);
  }

  function addActivity(type, title, body, options = {}) {
    const activity = {
      id: options.id || uid("activity"),
      type: type || "system",
      title: text(title, "Обновление Gram Flow"),
      body: text(body),
      clipId: options.clipId || "",
      createdAt: options.createdAt || now(),
      read: Boolean(options.read),
      action: options.action || ""
    };
    if (state.activities.some(item => item.id === activity.id)) return activity;
    state.activities.unshift(activity);
    state.activities = state.activities.slice(0, CONFIG.maxActivityItems);
    persist("activity");
    renderActivity();
    updateUnreadIndicators();
    return activity;
  }

  function pushHistory(clipId) {
    if (!clipId) return;
    state.history = state.history.filter(item => item && item.clipId !== clipId);
    state.history.unshift({ clipId, viewedAt: now() });
    state.history = state.history.slice(0, CONFIG.maxHistoryItems);
    persist("history");
  }

  function queueOperation(operation) {
    const item = { id: uid("outbox"), attempts: 0, createdAt: now(), ...operation };
    state.outbox.push(item);
    state.outbox = state.outbox.slice(-CONFIG.maxQueueItems);
    persist("outbox");
    addActivity("system", "Действие ждёт сеть", "Операция сохранена на этом устройстве и будет повторена после подключения.", { id: `queue-${item.id}`, read: false });
    return item;
  }

  async function flushOutbox() {
    if (!navigator.onLine || !state.outbox.length) return;
    const remaining = [];
    for (const item of state.outbox) {
      try {
        if (item.type === "put") await api.put(item.path, item.data);
        else if (item.type === "remove") await api.remove(item.path);
        else if (item.type === "publish") await api.put(`videos/${item.clipId}`, item.data);
        else if (item.type === "comment") await api.put(`comments/${item.clipId}/${item.commentId}`, item.data);
        else if (item.type === "like") await syncLike(item.clipId, item.liked, true);
        else if (item.type === "bookmark") await api.put(`userBookmarks/${state.deviceId}/${item.clipId}`, Boolean(item.saved));
        else if (item.type === "follow") await api.put(`follows/${state.deviceId}/${item.authorId}`, Boolean(item.following));
        else if (item.type === "profile") await api.put(`users/${state.deviceId}`, item.data);
        else continue;
      } catch (error) {
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts < 5) remaining.push(item);
        else logError("Outbox discarded after retries", error);
      }
    }
    state.outbox = remaining;
    persist("outbox");
    if (!remaining.length) announce("Очередь синхронизирована", "success", 2200);
  }

  function applyPreferences() {
    const preference = state.preferences;
    const html = document.documentElement;
    html.dataset.theme = ["obsidian", "dusk", "pearl"].includes(preference.theme) ? preference.theme : "obsidian";
    html.classList.toggle("reduce-motion", Boolean(preference.reduceMotion));
    html.classList.toggle("compact-mode", Boolean(preference.compactMode));
    const color = preference.theme === "pearl" ? "#f3f4f8" : preference.theme === "dusk" ? "#11101a" : "#08090d";
    $("#themeColor").setAttribute("content", color);
    updateSettingsControls();
  }

  function avatarHTML(profile, className = "avatar avatar-gradient") {
    const avatar = safeUrl(profile && profile.avatar, true);
    const pair = colorPair(profile && (profile.handle || profile.name));
    const style = `--avatar-start:${pair.start};--avatar-end:${pair.end};`;
    return `<span class="${className}" style="${style}">${avatar ? `<img src="${escapeHTML(avatar)}" alt="">` : `<span>${escapeHTML(initials(profile && (profile.name || profile.handle)))}</span>`}</span>`;
  }

  function fillAvatar(element, profile, fallback = "GF") {
    if (!element) return;
    const pair = colorPair(profile && (profile.handle || profile.name || fallback));
    element.style.setProperty("--avatar-start", pair.start);
    element.style.setProperty("--avatar-end", pair.end);
    const avatar = safeUrl(profile && profile.avatar, true);
    const label = escapeHTML(initials(profile && (profile.name || profile.handle || fallback)));
    if (element.id === "profileAvatar") {
      element.innerHTML = `${avatar ? `<img src="${escapeHTML(avatar)}" alt="">` : `<span id="profileInitials">${label}</span>`}<span class="avatar-edit">${svgIcon("i-camera")}</span>`;
      return;
    }
    element.innerHTML = avatar ? `<img src="${escapeHTML(avatar)}" alt="">` : `<span>${label}</span>`;
  }

  function updateProfileUI() {
    const p = state.profile;
    $("#accountName").textContent = p.name;
    $("#accountHandle").textContent = cleanHandle(p.handle);
    $("#mobileMenuName").textContent = p.name;
    $("#mobileMenuHandle").textContent = cleanHandle(p.handle);
    $("#profileName").childNodes[0].nodeValue = `${p.name} `;
    $("#profileHandle").textContent = cleanHandle(p.handle);
    $("#profileBio").textContent = p.bio || DEFAULT_PROFILE().bio;
    fillAvatar($("#accountAvatar"), p);
    fillAvatar($("#mobileMenuAvatar"), p);
    fillAvatar($("#profileAvatar"), p);
    fillAvatar($("#commentAvatar"), p);
    const accountInitials = $("#accountInitials");
    const profileInitials = $("#profileInitials");
    if (accountInitials) accountInitials.textContent = initials(p.name);
    if (profileInitials) profileInitials.textContent = initials(p.name);
    updateProfileStats();
  }

  function updateProfileStats() {
    const own = ownClips();
    const saved = state.clips.filter(clip => isSaved(clip.id));
    $("#profileClipsCount").textContent = formatCompact(own.length);
    $("#profileSavedCount").textContent = formatCompact(saved.length);
    $("#profileViewedCount").textContent = formatCompact(state.history.length);
  }

  function remoteRootValue(...paths) {
    for (const path of paths) {
      const value = path.split(".").reduce((current, part) => current && current[part], state.root);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  function normalizeClip(rawValue, key, source = "remote") {
    const raw = asObject(rawValue);
    const sourceUrl = directVideoUrl(raw.src || raw.videoUrl || raw.url || raw.link || raw.mediaUrl || raw.video, true);
    if (!sourceUrl) return null;
    const authorObject = asObject(raw.author);
    const author = cleanHandle(raw.user || raw.username || raw.handle || authorObject.handle || authorObject.username || "@direct", "@direct");
    const authorName = text(raw.authorName || raw.displayName || authorObject.name || author, author);
    const caption = text(raw.desc || raw.caption || raw.description || raw.text || "");
    const sound = friendlySound(raw.music || raw.sound || raw.audioTitle || raw.track, author);
    const createdAt = dateMillis(raw.createdAt || raw.timestamp || raw.publishedAt || raw.date || 0) || now();
    const rootLikes = asObject(state.root.likes)[key];
    const rootViews = asObject(state.root.views)[key];
    const rootBookmarks = asObject(state.root.bookmarks)[key];
    const rootComments = asObject(state.root.comments)[key];
    const rawStats = asObject(raw.stats);
    const tags = parseTags(raw.tags || raw.hashtags, caption);
    const cover = safeUrl(raw.cover || raw.poster || raw.thumbnail || raw.preview, false);
    const captions = safeUrl(raw.captions || raw.captionUrl || raw.subtitles, false);
    const comments = rootComments || raw.comments || {};
    const userLikes = asObject(asObject(state.root.userLikes)[state.deviceId]);
    const userBookmarks = asObject(asObject(state.root.userBookmarks)[state.deviceId]);
    const authorId = text(raw.authorId || raw.ownerId || authorObject.id || "", "");
    return {
      id: String(key),
      raw,
      source,
      src: sourceUrl,
      author,
      authorName,
      authorId,
      avatar: safeUrl(raw.avatar || raw.authorAvatar || authorObject.avatar, true),
      caption,
      sound,
      tags,
      cover,
      captions,
      visibility: text(raw.visibility, "public"),
      commentsEnabled: raw.commentsEnabled !== false,
      loop: raw.loop !== false,
      fit: text(raw.fit, state.preferences.fit),
      createdAt,
      updatedAt: dateMillis(raw.updatedAt || raw.timestamp || createdAt),
      likes: Number(rootLikes !== undefined ? rootLikes : raw.likes !== undefined ? raw.likes : rawStats.likes) || 0,
      views: Number(rootViews !== undefined ? rootViews : raw.views !== undefined ? raw.views : rawStats.views) || 0,
      bookmarks: Number(rootBookmarks !== undefined ? rootBookmarks : raw.bookmarks !== undefined ? raw.bookmarks : rawStats.bookmarks) || 0,
      shares: Number(raw.shares || rawStats.shares) || 0,
      comments: asObject(comments),
      commentCount: Object.keys(asObject(comments)).length,
      liked: userLikes[key] !== undefined ? Boolean(userLikes[key]) : Boolean(state.likes[key]),
      saved: userBookmarks[key] !== undefined ? Boolean(userBookmarks[key]) : Boolean(state.bookmarks[key]),
      reposted: Boolean(state.reposts[key]),
      directHost: (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch (_) { return "direct"; } })()
    };
  }

  function normalizeClips() {
    const videos = state.root.videos;
    const list = [];
    if (Array.isArray(videos)) {
      videos.forEach((value, index) => {
        const clip = normalizeClip(value, value && (value.id || value._key) || `legacy_${index}`);
        if (clip) list.push(clip);
      });
    } else {
      Object.entries(asObject(videos)).forEach(([key, value]) => {
        const clip = normalizeClip(value, key);
        if (clip) list.push(clip);
      });
    }
    const local = state.localClips.map(clip => normalizeClip(clip.raw || clip, clip.id, "local")).filter(Boolean);
    const seen = new Set(list.map(item => item.id));
    local.forEach(item => { if (!seen.has(item.id)) list.push(item); });
    state.clips = list;
  }

  function authorToken(clip) {
    if (clip.authorId) return clip.authorId.replace(/[^A-Za-z0-9_-]/g, "_");
    return `author_${hashNumber(clip.author.toLowerCase()).toString(36)}`;
  }
  function isLiked(id) { return Boolean(state.likes[id]); }
  function isSaved(id) { return Boolean(state.bookmarks[id]); }
  function isFollowing(clip) { return Boolean(state.follows[authorToken(clip)]); }

  function clipScore(clip) {
    const ageHours = Math.max(1, (now() - clip.createdAt) / 3600000);
    const freshness = Math.max(0, 48 - ageHours) * 4;
    const engagement = Math.log10(clip.likes + 1) * 24 + Math.log10(clip.commentCount + 1) * 10 + Math.log10(clip.views + 1) * 5;
    const historyBonus = state.history.some(entry => entry.clipId === clip.id) ? -20 : 11;
    const localBonus = clip.source === "local" ? 15 : 0;
    return freshness + engagement + historyBonus + localBonus;
  }

  function rebuildVisibleClips() {
    let list = state.clips.filter(clip => {
      if (!clip || !clip.src || state.hidden[clip.id]) return false;
      const directMatch = state.deepLink.clip === clip.id || state.deepLink.url === clip.src;
      if (clip.visibility === "unlisted" && !directMatch) return false;
      if (state.feedMode === "following" && !isFollowing(clip)) return false;
      if (state.topic === "saved" && !isSaved(clip.id)) return false;
      if (state.topic === "trending" && clip.likes < 1 && clip.views < 1) return false;
      if (state.topic === "fresh" && now() - clip.createdAt > 1000 * 60 * 60 * 24 * 14) return false;
      if (state.topic === "music" && !clip.sound) return false;
      if (state.topic.startsWith("tag:")) return clip.tags.some(tag => tag.toLowerCase() === state.topic.slice(4).toLowerCase());
      if (state.authorFilter && clip.author.toLowerCase() !== state.authorFilter.toLowerCase()) return false;
      if (state.soundFilter && clip.sound.toLowerCase() !== state.soundFilter.toLowerCase()) return false;
      if (state.feedFilter.withSound && /^Оригинальный звук · @direct$/i.test(clip.sound)) return false;
      if (state.feedFilter.withTags && !clip.tags.length) return false;
      if (state.feedFilter.excludeSeen && state.history.some(entry => entry.clipId === clip.id)) return false;
      return true;
    });
    const sort = state.feedFilter.sort;
    list = list.slice().sort((a, b) => {
      if (sort === "new") return b.createdAt - a.createdAt;
      if (sort === "popular") return (b.likes + b.commentCount * 3 + b.views * .05) - (a.likes + a.commentCount * 3 + a.views * .05);
      return clipScore(b) - clipScore(a);
    });
    state.visibleClips = list;
    if (state.activeClipId && !list.some(clip => clip.id === state.activeClipId)) state.activeClipId = list[0] ? list[0].id : null;
    if (!state.activeClipId && list[0]) state.activeClipId = list[0].id;
    state.activeIndex = Math.max(0, list.findIndex(clip => clip.id === state.activeClipId));
  }

  function applyRemoteProfile() {
    const remote = asObject(asObject(state.root.users)[state.deviceId]);
    if (!Object.keys(remote).length) return;
    const remoteUpdated = dateMillis(remote.updatedAt);
    if (remoteUpdated && remoteUpdated < (state.profile.updatedAt || 0)) return;
    state.profile = {
      ...state.profile,
      name: text(remote.name || remote.displayName, state.profile.name),
      handle: cleanHandle(remote.username || remote.handle, state.profile.handle),
      bio: text(remote.bio || remote.description, state.profile.bio),
      avatar: safeUrl(remote.avatar, true) || state.profile.avatar,
      updatedAt: remoteUpdated || state.profile.updatedAt
    };
    persist("profile");
  }

  function mergeRemotePersonalMaps() {
    const rootUserLikes = asObject(asObject(state.root.userLikes)[state.deviceId]);
    const rootBookmarks = asObject(asObject(state.root.userBookmarks)[state.deviceId]);
    const rootFollows = asObject(asObject(state.root.follows)[state.deviceId]);
    Object.entries(rootUserLikes).forEach(([id, value]) => { if (value) state.likes[id] = true; else delete state.likes[id]; });
    Object.entries(rootBookmarks).forEach(([id, value]) => { if (value) state.bookmarks[id] = true; else delete state.bookmarks[id]; });
    Object.entries(rootFollows).forEach(([id, value]) => { if (value) state.follows[id] = true; else delete state.follows[id]; });
    persist("likes"); persist("bookmarks"); persist("follows");
  }

  function inspectAnnouncement() {
    const announcement = asObject(state.root.announcement);
    if (!announcement.title && !announcement.text) return;
    const id = text(announcement.id, `announcement_${announcement.timestamp || hashNumber(JSON.stringify(announcement))}`);
    const seen = asObject(storageGet(STORAGE.seenAnnouncements, {}));
    if (seen[id]) return;
    seen[id] = now();
    storageSet(STORAGE.seenAnnouncements, seen);
    addActivity("system", text(announcement.title, "Новое объявление"), text(announcement.text, "Откройте Gram Flow, чтобы узнать больше."), { id: `announcement-${id}`, read: false, createdAt: dateMillis(announcement.timestamp) || now() });
    announce(`Новое объявление: ${text(announcement.title, "обновление")}`, "info", 5200);
  }

  function synchronize(source = "snapshot") {
    const previousSignature = state.renderSignature;
    applyRemoteProfile();
    mergeRemotePersonalMaps();
    normalizeClips();
    rebuildVisibleClips();
    renderFeed(previousSignature);
    renderExplore();
    renderProfileContent();
    renderActivity();
    updateProfileUI();
    updateMetrics();
    updateConnectionUI();
    inspectAnnouncement();
    if (state.commentClipId) renderComments();
    if (state.deepLink.clip || state.deepLink.url) {
      const target = state.visibleClips.find(clip => clip.id === state.deepLink.clip || clip.src === state.deepLink.url);
      if (target) {
        state.deepLink = { clip: "", url: "" };
        window.setTimeout(() => activateClip(target.id, { scroll: true, announce: false }), 120);
      }
    }
    if (source === "snapshot") state.connection.lastSync = now();
  }

  function setAtPath(root, path, value) {
    const parts = String(path || "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    if (!parts.length) return value || {};
    let cursor = root;
    parts.slice(0, -1).forEach(part => {
      if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
      cursor = cursor[part];
    });
    const last = parts[parts.length - 1];
    if (value === null) delete cursor[last];
    else cursor[last] = value;
    return root;
  }

  function receiveStreamEvent(type, path, value) {
    if (path === "/" || !path) state.root = value || {};
    else if (type === "patch" && value && typeof value === "object") {
      Object.entries(value).forEach(([key, patchValue]) => { setAtPath(state.root, `${path}/${key}`, patchValue); });
    } else setAtPath(state.root, path, value);
    state.connection.status = "online";
    state.connection.lastSync = now();
    synchronize("stream");
  }

  async function getFreshSnapshot(showToast = false) {
    if (!navigator.onLine) {
      state.connection.status = "offline";
      updateConnectionUI();
      if (showToast) announce("Нет сети. Показываем уже загруженный поток.", "error");
      return false;
    }
    state.connection.status = "syncing";
    updateConnectionUI();
    try {
      // Do not load unrelated legacy branches such as system logs or channel media.
      // These focused reads keep the initial payload proportional to the video product.
      const [videos, likes, views, bookmarks, comments, userLikes, userBookmarks, follows, profile, announcement] = await Promise.all([
        api.get("videos"), api.get("likes"), api.get("views"), api.get("bookmarks"), api.get("comments"),
        api.get(`userLikes/${state.deviceId}`), api.get(`userBookmarks/${state.deviceId}`), api.get(`follows/${state.deviceId}`),
        api.get(`users/${state.deviceId}`), api.get("announcement")
      ]);
      state.root = {
        videos: videos || {}, likes: likes || {}, views: views || {}, bookmarks: bookmarks || {}, comments: comments || {},
        userLikes: { [state.deviceId]: userLikes || {} }, userBookmarks: { [state.deviceId]: userBookmarks || {} },
        follows: { [state.deviceId]: follows || {} }, users: { [state.deviceId]: profile || {} }, announcement: announcement || {}
      };
      state.connection.status = "online";
      state.connection.lastSync = now();
      synchronize("snapshot");
      if (showToast) announce("Поток синхронизирован", "success", 2200);
      return true;
    } catch (error) {
      state.connection.status = "offline";
      updateConnectionUI();
      logError("Initial RTDB snapshot", error);
      if (showToast) announce("Не удалось подключиться к RTDB", "error");
      return false;
    }
  }

  function updateConnectionUI() {
    const { status, lastSync } = state.connection;
    const dot = $("#connectionDot");
    const textNode = $("#connectionText");
    const livePill = $("#livePill");
    const settingsTitle = $("#settingsConnectionTitle");
    const settingsDetail = $("#settingsConnectionDetail");
    dot.classList.toggle("is-online", status === "online");
    dot.classList.toggle("is-offline", status === "offline");
    livePill.classList.toggle("is-offline", status === "offline");
    const label = status === "online" ? "В эфире" : status === "syncing" ? "Синхронизация" : status === "reconnecting" ? "Переподключение" : status === "connecting" ? "Подключение" : "Офлайн";
    textNode.textContent = label;
    $("#syncDescription").textContent = status === "online"
      ? `RTDB синхронизирована${lastSync ? ` · ${relativeTime(lastSync)}` : ""}.`
      : status === "offline" ? "Нет подключения. Локальные действия попадут в очередь." : "Устанавливаем защищённое соединение с RTDB…";
    settingsTitle.textContent = status === "online" ? "Realtime Database подключена" : status === "offline" ? "Офлайн-режим" : "Проверяем подключение";
    settingsDetail.textContent = status === "online" ? `Последняя синхронизация: ${relativeTime(lastSync)}` : "Новые действия сохранятся в локальной очереди";
  }

  function updateMetrics() {
    const allLikes = state.clips.reduce((sum, clip) => sum + (clip.likes || 0), 0);
    $("#metricClips").textContent = formatCompact(state.clips.length);
    $("#metricVisible").textContent = formatCompact(state.visibleClips.length);
    $("#metricLikes").textContent = formatCompact(allLikes);
  }

  function setFeedTab(mode) {
    state.feedMode = mode === "following" ? "following" : "foryou";
    $("#forYouTab").classList.toggle("is-active", state.feedMode === "foryou");
    $("#followingTab").classList.toggle("is-active", state.feedMode === "following");
    $("#forYouTab").setAttribute("aria-selected", String(state.feedMode === "foryou"));
    $("#followingTab").setAttribute("aria-selected", String(state.feedMode === "following"));
    const width = $("#forYouTab").offsetWidth || 92;
    $("#feedTabIndicator").style.transform = state.feedMode === "following" ? `translateX(${width + 2}px)` : "translateX(0)";
    rebuildVisibleClips();
    renderFeed("");
    updateMetrics();
    screenReader(state.feedMode === "following" ? "Открыты подписки" : "Открыта лента для вас");
  }

  function setTopic(topic) {
    state.topic = topic || "all";
    state.authorFilter = "";
    state.soundFilter = "";
    $$(".topic-chip[data-topic]").forEach(button => button.classList.toggle("is-active", button.dataset.topic === state.topic));
    rebuildVisibleClips();
    renderFeed("");
    updateMetrics();
  }

  function renderFeed(previousSignature = "") {
    const feed = $("#feed");
    const clips = state.visibleClips;
    const signature = clips.map(clip => `${clip.id}:${clip.src}`).join("|");
    const currentId = state.activeClipId;
    if (signature === state.renderSignature && signature === previousSignature && feed.querySelector(".clip-card")) {
      updateRenderedCards();
      return;
    }
    stopAllVideos();
    if (state.observer) state.observer.disconnect();
    feed.innerHTML = "";
    state.renderSignature = signature;
    if (!clips.length) {
      const empty = $("#emptyFeedTemplate").content.cloneNode(true);
      feed.appendChild(empty);
      feed.setAttribute("aria-busy", "false");
      updateNowCard(null);
      return;
    }
    const fragment = document.createDocumentFragment();
    clips.forEach((clip, index) => fragment.appendChild(createClipCard(clip, index)));
    feed.appendChild(fragment);
    feed.setAttribute("aria-busy", "false");
    state.activeClipId = clips.some(clip => clip.id === currentId) ? currentId : clips[0].id;
    state.activeIndex = Math.max(0, clips.findIndex(clip => clip.id === state.activeClipId));
    setupFeedObserver();
    window.requestAnimationFrame(() => activateClip(state.activeClipId, { scroll: false, announce: false }));
  }

  function createClipCard(clip, index) {
    const node = $("#clipTemplate").content.firstElementChild.cloneNode(true);
    node.dataset.clipId = clip.id;
    node.dataset.index = String(index);
    node.style.setProperty("--clip-accent", colorPair(clip.id).accent);
    const pair = colorPair(clip.author);
    const shell = $(".clip-media-shell", node);
    shell.classList.toggle("is-cover", clip.fit !== "contain");
    shell.dataset.clipId = clip.id;
    const video = $(".clip-video", node);
    video.dataset.clipId = clip.id;
    video.loop = Boolean(clip.loop);
    video.muted = Boolean(state.preferences.muted);
    video.volume = clamp(Number(state.preferences.volume) || .7, 0, 1);
    video.playsInline = true;
    if (clip.cover) video.poster = clip.cover;
    if (clip.captions) {
      const track = document.createElement("track");
      track.kind = "captions";
      track.label = "Русские субтитры";
      track.srclang = "ru";
      track.src = clip.captions;
      track.default = false;
      video.appendChild(track);
      $(".clip-captions-button", node).hidden = false;
    }
    $(".clip-index", node).textContent = `${String(index + 1).padStart(2, "0")} / ${String(state.visibleClips.length).padStart(2, "0")}`;
    $(".creator-initials", node).textContent = initials(clip.authorName || clip.author);
    const avatarButton = $(".creator-avatar", node);
    avatarButton.style.setProperty("--avatar-start", pair.start);
    avatarButton.style.setProperty("--avatar-end", pair.end);
    if (clip.avatar) avatarButton.innerHTML = `<img src="${escapeHTML(clip.avatar)}" alt="">`;
    $(".clip-author", node).textContent = clip.author;
    const captionNode = $(".clip-caption", node);
    captionNode.textContent = clip.caption || "Без подписи";
    if (clip.caption.length > 150) {
      const more = document.createElement("button");
      more.className = "caption-expand";
      more.type = "button";
      more.dataset.clipAction = "expand-caption";
      more.textContent = "ещё";
      captionNode.after(more);
    }
    const tagRow = $(".clip-tag-row", node);
    clip.tags.slice(0, 4).forEach(tag => {
      const tagButton = document.createElement("button");
      tagButton.className = "clip-tag";
      tagButton.type = "button";
      tagButton.dataset.clipAction = "filter-tag";
      tagButton.dataset.tag = tag;
      tagButton.textContent = tag;
      tagRow.appendChild(tagButton);
    });
    $(".clip-sound", node).textContent = clip.sound;
    const follow = $(".follow-button", node);
    follow.classList.toggle("is-following", isFollowing(clip));
    follow.textContent = isFollowing(clip) ? "Вы подписаны" : "Подписаться";
    $(".like-count", node).textContent = formatCompact(clip.likes);
    $(".comment-count", node).textContent = formatCompact(clip.commentCount);
    $(".bookmark-count", node).textContent = formatCompact(clip.bookmarks);
    $(".like-action", node).classList.toggle("is-liked", isLiked(clip.id));
    $(".bookmark-action", node).classList.toggle("is-saved", isSaved(clip.id));
    updateCardVolumeIcon(node, state.preferences.muted);
    setupVideoEvents(video, clip.id);
    return node;
  }

  function updateRenderedCards() {
    $$(".clip-card", $("#feed")).forEach(card => {
      const clip = clipById(card.dataset.clipId);
      if (!clip) return;
      $(".like-count", card).textContent = formatCompact(clip.likes);
      $(".comment-count", card).textContent = formatCompact(clip.commentCount);
      $(".bookmark-count", card).textContent = formatCompact(clip.bookmarks);
      $(".like-action", card).classList.toggle("is-liked", isLiked(clip.id));
      $(".bookmark-action", card).classList.toggle("is-saved", isSaved(clip.id));
      const follow = $(".follow-button", card);
      follow.classList.toggle("is-following", isFollowing(clip));
      follow.textContent = isFollowing(clip) ? "Вы подписаны" : "Подписаться";
      updateCardVolumeIcon(card, state.preferences.muted);
    });
    updateNowCard(activeClip());
  }

  function setupFeedObserver() {
    const feed = $("#feed");
    if (!("IntersectionObserver" in window)) return;
    state.observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting && entry.intersectionRatio >= .62) {
          activateClip(entry.target.dataset.clipId, { scroll: false, announce: true });
        }
      });
    }, { root: feed, threshold: [.35, .62, .8] });
    $$(".clip-card", feed).forEach(card => state.observer.observe(card));
  }

  function setupVideoEvents(video, clipId) {
    video.addEventListener("loadeddata", () => {
      const shell = video.closest(".clip-media-shell");
      if (shell) shell.classList.add("is-ready");
    });
    video.addEventListener("canplay", () => {
      const shell = video.closest(".clip-media-shell");
      if (shell) shell.classList.add("is-ready");
      if (clipId === state.activeClipId && shouldAutoplay()) playActiveVideo();
    });
    video.addEventListener("play", () => {
      const card = video.closest(".clip-card");
      if (card) card.classList.add("is-playing");
      if (clipId === state.activeClipId) updateNowCard(activeClip());
    });
    video.addEventListener("pause", () => {
      const card = video.closest(".clip-card");
      if (card) card.classList.remove("is-playing");
      if (clipId === state.activeClipId) updateNowCard(activeClip());
    });
    video.addEventListener("timeupdate", () => {
      if (clipId !== state.activeClipId) return;
      updateVideoProgress(video);
      updateNowCard(activeClip());
    });
    video.addEventListener("progress", () => updateBufferProgress(video));
    video.addEventListener("error", () => {
      const shell = video.closest(".clip-media-shell");
      if (!shell) return;
      const holder = $(".video-placeholder", shell);
      holder.innerHTML = `<div class="placeholder-logo">${svgIcon("i-info")}</div><span>Не удалось открыть видео</span>`;
      shell.classList.remove("is-ready");
      if (clipId === state.activeClipId) announce("Источник видео недоступен или блокирует воспроизведение", "error");
    });
    video.addEventListener("ended", () => {
      const clip = clipById(clipId);
      if (!clip || clip.loop) return;
      const next = state.visibleClips[state.activeIndex + 1];
      if (next) activateClip(next.id, { scroll: true, announce: false });
    });
  }

  function updateVideoProgress(video) {
    const card = video.closest(".clip-card");
    if (!card || !Number.isFinite(video.duration)) return;
    const ratio = clamp(video.currentTime / video.duration, 0, 1);
    const played = $(".progress-played", card);
    const thumb = $(".progress-thumb", card);
    const time = $(".time-code", card);
    played.style.width = `${ratio * 100}%`;
    thumb.style.left = `${ratio * 100}%`;
    time.textContent = `${formatDuration(video.currentTime)} / ${formatDuration(video.duration)}`;
    $("#nowProgress").style.width = `${ratio * 100}%`;
  }

  function updateBufferProgress(video) {
    const card = video.closest(".clip-card");
    if (!card || !Number.isFinite(video.duration) || !video.buffered.length) return;
    let end = 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= video.currentTime + .1) end = Math.max(end, video.buffered.end(index));
    }
    $(".progress-buffer", card).style.width = `${clamp(end / video.duration, 0, 1) * 100}%`;
  }

  function cardById(id) {
    return $$(".clip-card", $("#feed")).find(card => card.dataset.clipId === String(id)) || null;
  }
  function clipById(id) { return state.clips.find(clip => clip.id === id) || state.visibleClips.find(clip => clip.id === id) || null; }
  function activeClip() { return clipById(state.activeClipId); }
  function activeVideo() {
    const card = cardById(state.activeClipId);
    return card ? $(".clip-video", card) : null;
  }

  function shouldAutoplay() {
    return state.preferences.autoplay && document.visibilityState === "visible" && state.currentView !== "explore" && state.currentView !== "profile" && state.currentView !== "inbox" && !state.openOverlay;
  }

  function hydrateVideo(clipId) {
    const clip = clipById(clipId);
    const card = cardById(clipId);
    if (!clip || !card) return null;
    const video = $(".clip-video", card);
    if (video.dataset.src === clip.src) return video;
    video.dataset.src = clip.src;
    video.src = clip.src;
    video.load();
    return video;
  }

  function unloadDistantVideos(index) {
    if (state.preferences.dataSaver) return;
    $$(".clip-card", $("#feed")).forEach((card, cardIndex) => {
      if (Math.abs(cardIndex - index) <= 1) return;
      const video = $(".clip-video", card);
      if (video && video.dataset.src) {
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch (_) { /* noop */ }
        delete video.dataset.src;
      }
    });
  }

  function activateClip(clipId, options = {}) {
    const clip = clipById(clipId);
    if (!clip) return;
    const index = state.visibleClips.findIndex(item => item.id === clip.id);
    if (index < 0) return;
    const changed = state.activeClipId !== clip.id;
    state.activeClipId = clip.id;
    state.activeIndex = index;
    stopAllVideos(clip.id);
    const video = hydrateVideo(clip.id);
    if (!state.preferences.dataSaver && state.visibleClips[index + 1]) hydrateVideo(state.visibleClips[index + 1].id);
    unloadDistantVideos(index);
    if (video) {
      video.muted = Boolean(state.preferences.muted);
      video.volume = clamp(Number(state.preferences.volume) || .7, 0, 1);
      if (shouldAutoplay()) video.play().catch(() => { /* browser needs explicit gesture */ });
    }
    const card = cardById(clip.id);
    if (card) {
      $$(".clip-card", $("#feed")).forEach(item => item.classList.toggle("is-active", item === card));
      if (options.scroll) card.scrollIntoView({ behavior: state.preferences.reduceMotion ? "auto" : "smooth", block: "start" });
    }
    updateNowCard(clip);
    updateMediaSession(clip);
    updateDeepLink(clip.id);
    if (changed) {
      pushHistory(clip.id);
      scheduleView(clip.id);
      if (options.announce) screenReader(`Клип ${index + 1} из ${state.visibleClips.length}, автор ${clip.author}`);
    }
  }

  function stopAllVideos(exceptId = "") {
    $$(".clip-video", $("#feed")).forEach(video => {
      if (video.dataset.clipId !== String(exceptId)) {
        try { video.pause(); } catch (_) { /* noop */ }
      }
    });
  }

  function playActiveVideo() {
    const video = activeVideo();
    if (!video) return;
    video.muted = Boolean(state.preferences.muted);
    video.volume = clamp(Number(state.preferences.volume) || .7, 0, 1);
    video.play().catch(() => announce("Нажмите на видео, чтобы начать воспроизведение", "info", 2200));
  }

  function togglePlayback(clipId = state.activeClipId) {
    if (clipId !== state.activeClipId) activateClip(clipId, { scroll: false });
    const video = activeVideo();
    if (!video) return;
    if (video.paused) {
      playActiveVideo();
    } else {
      video.pause();
      const stateIcon = $(".play-state", cardById(state.activeClipId));
      if (stateIcon) {
        stateIcon.classList.remove("is-flashing");
        void stateIcon.offsetWidth;
        stateIcon.classList.add("is-flashing");
      }
    }
  }

  function updateCardVolumeIcon(card, muted) {
    if (!card) return;
    const use = $(".clip-volume-icon use", card);
    if (use) use.setAttribute("href", muted ? "#i-volume-off" : "#i-volume");
  }

  function toggleMute() {
    state.preferences.muted = !state.preferences.muted;
    persist("preferences");
    $$(".clip-video", $("#feed")).forEach(video => { video.muted = state.preferences.muted; });
    updateRenderedCards();
    const nowUse = $("#nowVolumeIcon use");
    if (nowUse) nowUse.setAttribute("href", state.preferences.muted ? "#i-volume-off" : "#i-volume");
    announce(state.preferences.muted ? "Звук выключен" : "Звук включён", "info", 1600);
    updateSettingsControls();
  }

  function updateNowCard(clip) {
    const video = activeVideo();
    const sound = $("#nowSound");
    const creator = $("#nowCreator");
    const art = $("#nowArt");
    const playUse = $("#nowPlayIcon use");
    const volumeUse = $("#nowVolumeIcon use");
    if (!clip) {
      sound.textContent = "Оригинальный звук";
      creator.textContent = "Выберите клип";
      art.style.setProperty("--avatar-start", "var(--accent)");
      art.style.setProperty("--avatar-end", "var(--accent-2)");
      $("#nowProgress").style.width = "0%";
      return;
    }
    const pair = colorPair(clip.sound || clip.id);
    sound.textContent = clip.sound;
    creator.textContent = clip.author;
    art.style.setProperty("--avatar-start", pair.start);
    art.style.setProperty("--avatar-end", pair.end);
    if (playUse) playUse.setAttribute("href", video && !video.paused ? "#i-pause" : "#i-play");
    if (volumeUse) volumeUse.setAttribute("href", state.preferences.muted ? "#i-volume-off" : "#i-volume");
  }

  function updateMediaSession(clip) {
    if (!("mediaSession" in navigator) || !clip) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: clip.caption || "Gram Flow clip", artist: clip.author, album: clip.sound });
      navigator.mediaSession.playbackState = activeVideo() && !activeVideo().paused ? "playing" : "paused";
    } catch (_) { /* media session unavailable */ }
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const bind = (action, callback) => { try { navigator.mediaSession.setActionHandler(action, callback); } catch (_) { /* unsupported */ } };
    bind("play", () => playActiveVideo());
    bind("pause", () => { const video = activeVideo(); if (video) video.pause(); });
    bind("nexttrack", () => navigateClip(1));
    bind("previoustrack", () => navigateClip(-1));
    bind("seekbackward", () => seekActive(-10));
    bind("seekforward", () => seekActive(10));
  }

  function seekActive(seconds) {
    const video = activeVideo();
    if (video && Number.isFinite(video.duration)) video.currentTime = clamp(video.currentTime + seconds, 0, video.duration);
  }

  function navigateClip(delta) {
    if (!state.visibleClips.length) return;
    const nextIndex = clamp(state.activeIndex + delta, 0, state.visibleClips.length - 1);
    activateClip(state.visibleClips[nextIndex].id, { scroll: true, announce: true });
  }

  function scheduleView(clipId) {
    if (!clipId || state.viewTimers.has(clipId)) return;
    const seenKey = `gram-flow-viewed-${state.deviceId}`;
    const sessionViews = asObject(storageGet(seenKey, {}));
    if (sessionViews[clipId]) return;
    const timer = window.setTimeout(async () => {
      state.viewTimers.delete(clipId);
      if (state.activeClipId !== clipId || document.visibilityState !== "visible") return;
      sessionViews[clipId] = now();
      storageSet(seenKey, sessionViews);
      const clip = clipById(clipId);
      if (!clip) return;
      clip.views += 1;
      try {
        const total = await api.transaction(`views/${clipId}`, current => Math.max(0, Number(current) || 0) + 1);
        clip.views = Number(total) || clip.views;
      } catch (error) {
        logError("View metric", error);
      }
    }, 3200);
    state.viewTimers.set(clipId, timer);
  }

  async function syncLike(clipId, liked, silent = false) {
    const clip = clipById(clipId);
    if (!clip) return;
    const desired = Boolean(liked);
    try {
      const likes = await api.transaction(`likes/${clipId}`, current => Math.max(0, (Number(current) || 0) + (desired ? 1 : -1)));
      await api.put(`userLikes/${state.deviceId}/${clipId}`, desired);
      clip.likes = Number(likes) || 0;
      const likesRoot = asObject(state.root.likes);
      likesRoot[clipId] = clip.likes;
      state.root.likes = likesRoot;
      const userRoot = asObject(asObject(state.root.userLikes)[state.deviceId]);
      userRoot[clipId] = desired;
      state.root.userLikes = { ...asObject(state.root.userLikes), [state.deviceId]: userRoot };
      updateRenderedCards();
    } catch (error) {
      if (!silent) {
        queueOperation({ type: "like", clipId, liked: desired });
        announce("Реакция сохранена и ждёт сеть", "info");
      }
      throw error;
    }
  }

  function toggleLike(clipId, burst = false) {
    const clip = clipById(clipId);
    if (!clip) return;
    const desired = !isLiked(clipId);
    if (desired) state.likes[clipId] = true; else delete state.likes[clipId];
    clip.liked = desired;
    clip.likes = Math.max(0, clip.likes + (desired ? 1 : -1));
    persist("likes");
    updateRenderedCards();
    if (burst && desired) {
      const burstNode = $(".heart-burst", cardById(clipId));
      if (burstNode) {
        burstNode.classList.remove("is-bursting");
        void burstNode.offsetWidth;
        burstNode.classList.add("is-bursting");
      }
    }
    syncLike(clipId, desired).catch(error => logError("Like sync", error));
  }

  function toggleBookmark(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    const saved = !isSaved(clipId);
    if (saved) state.bookmarks[clipId] = true; else delete state.bookmarks[clipId];
    clip.saved = saved;
    clip.bookmarks = Math.max(0, clip.bookmarks + (saved ? 1 : -1));
    persist("bookmarks");
    updateRenderedCards();
    updateProfileStats();
    announce(saved ? "Добавлено в сохранённые" : "Убрано из сохранённых", saved ? "success" : "info", 1800);
    const sync = async () => {
      await api.put(`userBookmarks/${state.deviceId}/${clipId}`, saved);
      const count = await api.transaction(`bookmarks/${clipId}`, current => Math.max(0, (Number(current) || 0) + (saved ? 1 : -1)));
      clip.bookmarks = Number(count) || 0;
      updateRenderedCards();
    };
    sync().catch(error => {
      queueOperation({ type: "bookmark", clipId, saved });
      logError("Bookmark sync", error);
    });
  }

  function toggleFollow(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    const id = authorToken(clip);
    const following = !state.follows[id];
    if (following) state.follows[id] = true; else delete state.follows[id];
    persist("follows");
    updateRenderedCards();
    announce(following ? `Вы подписались на ${clip.author}` : `Подписка на ${clip.author} отменена`, "info", 1900);
    api.put(`follows/${state.deviceId}/${id}`, following).catch(error => {
      queueOperation({ type: "follow", authorId: id, following });
      logError("Follow sync", error);
    });
  }

  function toggleRepost(clipId = state.shareClipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    const reposted = !state.reposts[clipId];
    if (reposted) state.reposts[clipId] = { at: now() }; else delete state.reposts[clipId];
    persist("reposts");
    const label = $("#repostLabel");
    if (label) label.textContent = reposted ? "Убрать репост" : "Репостнуть";
    announce(reposted ? "Клип добавлен в ваши репосты" : "Репост убран", "success", 1800);
    api.put(`reposts/${state.deviceId}/${clipId}`, reposted ? { at: now(), clipId } : null).catch(error => logError("Repost sync", error));
  }

  function setNotInterested(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    state.hidden[clipId] = { at: now(), reason: "not-interested" };
    persist("hidden");
    closeOverlay("menuModal");
    rebuildVisibleClips();
    renderFeed("");
    renderExplore();
    announce("Клип скрыт из вашего потока", "success");
  }

  function restoreHidden(clipId) {
    delete state.hidden[clipId];
    persist("hidden");
    rebuildVisibleClips();
    renderFeed("");
  }

  function openComments(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    state.commentClipId = clipId;
    state.replyTo = null;
    renderComments();
    openOverlay("commentsDrawer", "#commentInput");
  }

  function normalizedComments(clip) {
    if (!clip) return [];
    return Object.entries(asObject(clip.comments)).map(([id, raw]) => {
      const comment = asObject(raw);
      return {
        id,
        author: text(comment.author || comment.username || comment.name, "@user"),
        username: cleanHandle(comment.username || "", "@user"),
        avatar: safeUrl(comment.avatar, true),
        text: text(comment.text || comment.message),
        createdAt: dateMillis(comment.timestamp || comment.createdAt) || now(),
        likes: Number(comment.likes) || 0,
        parentId: text(comment.parentId || comment.replyTo, ""),
        authorId: text(comment.authorId || comment.deviceId, "")
      };
    }).filter(comment => comment.text);
  }

  function renderComments() {
    const clip = clipById(state.commentClipId);
    const list = $("#commentsList");
    const context = $("#commentContext");
    if (!clip) { list.innerHTML = ""; return; }
    context.innerHTML = `<span class="context-avatar" style="--context-bg:${colorPair(clip.id).background}">${svgIcon("i-play")}</span><strong>${escapeHTML(clip.caption || clip.author)}</strong><span>· ${escapeHTML(clip.author)}</span>`;
    const comments = normalizedComments(clip);
    const sorted = comments.slice().sort((a, b) => state.commentSort === "recent" ? b.createdAt - a.createdAt : b.likes - a.likes || a.createdAt - b.createdAt);
    $("#commentsTitle").textContent = `${formatNumber(comments.length)} ${pluralComments(comments.length)}`;
    $$(".sort-button").forEach(button => button.classList.toggle("is-active", button.dataset.commentSort === state.commentSort));
    if (!comments.length) {
      list.innerHTML = `<div class="comments-empty">${svgIcon("i-comment")}<p>Пока тихо. Начните разговор первым.</p></div>`;
    } else {
      list.innerHTML = sorted.map(comment => {
        const commentProfile = { name: comment.author, handle: comment.username, avatar: comment.avatar };
        return `<article class="comment-item" data-comment-id="${escapeHTML(comment.id)}"><div>${avatarHTML(commentProfile, "avatar avatar-gradient")}</div><div class="comment-content"><div class="comment-author-row"><strong>${escapeHTML(comment.author)}</strong><time datetime="${new Date(comment.createdAt).toISOString()}">${escapeHTML(relativeTime(comment.createdAt))}</time></div>${comment.parentId ? `<div class="comment-reply-reference">↳ ответ</div>` : ""}<p class="comment-text">${escapeHTML(comment.text)}</p><div class="comment-actions"><button type="button" data-comment-action="reply">Ответить</button><button type="button" class="comment-like" data-comment-action="like">${svgIcon("i-heart")}${comment.likes ? escapeHTML(formatCompact(comment.likes)) : "Нравится"}</button></div></div></article>`;
      }).join("");
    }
    const replyLabel = $("#commentReplyLabel");
    if (state.replyTo) {
      replyLabel.hidden = false;
      replyLabel.textContent = `Ответ ${state.replyTo.author}`;
    } else replyLabel.hidden = true;
  }

  function pluralComments(number) {
    const n = Math.abs(number) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return "комментариев";
    if (n1 > 1 && n1 < 5) return "комментария";
    if (n1 === 1) return "комментарий";
    return "комментариев";
  }

  async function submitComment() {
    const clip = clipById(state.commentClipId);
    const input = $("#commentInput");
    const content = text(input.value);
    if (!clip || !content) return;
    if (!clip.commentsEnabled) { announce("Автор отключил комментарии к этому клипу", "error"); return; }
    const commentId = uid("comment");
    const payload = {
      author: `${state.profile.name} (${cleanHandle(state.profile.handle)})`,
      username: cleanHandle(state.profile.handle),
      avatar: state.profile.avatar || "",
      authorId: state.deviceId,
      text: content.slice(0, 400),
      timestamp: now(),
      createdAt: now(),
      parentId: state.replyTo ? state.replyTo.id : "",
      likes: 0,
      schemaVersion: CONFIG.schemaVersion
    };
    input.value = "";
    state.replyTo = null;
    clip.comments[commentId] = payload;
    clip.commentCount += 1;
    renderComments();
    updateRenderedCards();
    try {
      await api.put(`comments/${clip.id}/${commentId}`, payload);
      announce("Комментарий опубликован", "success", 1600);
    } catch (error) {
      queueOperation({ type: "comment", clipId: clip.id, commentId, data: payload });
      announce("Комментарий будет отправлен при подключении", "info");
      logError("Comment publish", error);
    }
  }

  function likeComment(commentId) {
    const clip = clipById(state.commentClipId);
    if (!clip || !clip.comments[commentId]) return;
    const comment = clip.comments[commentId];
    const localKey = `gram-flow-comment-likes-${state.deviceId}`;
    const map = asObject(storageGet(localKey, {}));
    const liked = !map[`${clip.id}:${commentId}`];
    if (liked) map[`${clip.id}:${commentId}`] = true; else delete map[`${clip.id}:${commentId}`];
    storageSet(localKey, map);
    comment.likes = Math.max(0, (Number(comment.likes) || 0) + (liked ? 1 : -1));
    renderComments();
    api.transaction(`comments/${clip.id}/${commentId}/likes`, current => Math.max(0, (Number(current) || 0) + (liked ? 1 : -1))).then(result => {
      comment.likes = Number(result) || 0;
      renderComments();
    }).catch(error => logError("Comment like", error));
  }

  function renderExplore() {
    const visible = state.clips.filter(clip => !state.hidden[clip.id]);
    const trendMap = new Map();
    visible.forEach(clip => clip.tags.forEach(tag => {
      const current = trendMap.get(tag) || { tag, count: 0, likes: 0 };
      current.count += 1;
      current.likes += clip.likes;
      trendMap.set(tag, current);
    }));
    let trends = Array.from(trendMap.values()).sort((a, b) => b.count - a.count || b.likes - a.likes).slice(0, 3);
    if (!trends.length) trends = ["#прямаяссылка", "#первыйклип", "#gramflow"].map((tag, index) => ({ tag, count: 0, likes: 0, fallback: index }));
    const palettes = ["linear-gradient(135deg,#5846b4,#1c5876)", "linear-gradient(135deg,#b74c72,#622b75)", "linear-gradient(135deg,#138f8c,#24436c)"];
    $("#trendGrid").innerHTML = trends.map((trend, index) => `<button class="trend-card" data-explore-tag="${escapeHTML(trend.tag)}" style="--trend-bg:${palettes[index % palettes.length]}"><small>В ТРЕНДЕ ${index + 1}</small><strong>${escapeHTML(trend.tag)}</strong><span>${svgIcon("i-flame")}${trend.count ? `${formatCompact(trend.count)} ${pluralClips(trend.count)}` : "Ваша тема"}</span></button>`).join("");

    const soundMap = new Map();
    visible.forEach(clip => {
      const key = clip.sound.toLowerCase();
      const value = soundMap.get(key) || { sound: clip.sound, author: clip.author, count: 0, seed: clip.id };
      value.count += 1;
      soundMap.set(key, value);
    });
    const sounds = Array.from(soundMap.values()).sort((a, b) => b.count - a.count).slice(0, 4);
    $("#soundList").innerHTML = sounds.length ? sounds.map(sound => `<button class="sound-list-row" data-explore-sound="${escapeHTML(sound.sound)}"><span class="sound-art" style="--sound-bg:${colorPair(sound.seed).background}">${svgIcon("i-music")}</span><span class="sound-list-copy"><strong>${escapeHTML(sound.sound)}</strong><span>${escapeHTML(sound.author)} · ${formatCompact(sound.count)} ${pluralClips(sound.count)}</span></span>${svgIcon("i-chevron-right")}</button>`).join("") : `<div class="activity-empty">${svgIcon("i-music")}<p>Звуки появятся, когда в RTDB будут клипы.</p></div>`;

    const picks = visible.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
    $("#exploreClipGrid").innerHTML = picks.length ? picks.map(clip => `<button class="mini-clip" data-open-clip="${escapeHTML(clip.id)}" style="--mini-bg:${colorPair(clip.id).background}"><span class="mini-play">${svgIcon("i-play")}</span><span class="mini-copy"><strong>${escapeHTML(clip.author)}</strong><span>${escapeHTML(clip.caption || clip.sound)}</span></span></button>`).join("") : `<div class="activity-empty">${svgIcon("i-sparkles")}<p>Здесь появятся свежие идеи.</p></div>`;
  }

  function pluralClips(value) {
    const number = Math.abs(value) % 100;
    const last = number % 10;
    if (number > 10 && number < 20) return "клипов";
    if (last > 1 && last < 5) return "клипа";
    if (last === 1) return "клип";
    return "клипов";
  }

  function ownClips() {
    return state.clips.filter(clip => clip.authorId === state.deviceId || (!clip.authorId && clip.author.toLowerCase() === cleanHandle(state.profile.handle).toLowerCase()));
  }

  function selectProfileTab(tab) {
    state.selectedProfileTab = ["clips", "saved", "history", "studio"].includes(tab) ? tab : "clips";
    $$(".profile-tab").forEach(button => button.classList.toggle("is-active", button.dataset.profileTab === state.selectedProfileTab));
    renderProfileContent();
  }

  function renderProfileContent() {
    const container = $("#profileContent");
    if (!container) return;
    const tab = state.selectedProfileTab;
    if (tab === "studio") {
      const own = ownClips();
      const ownLikes = own.reduce((sum, clip) => sum + clip.likes, 0);
      const ownViews = own.reduce((sum, clip) => sum + clip.views, 0);
      container.innerHTML = `<section class="studio-panel"><header><div><p class="eyebrow">CREATOR STUDIO</p><h3>Ваше пространство публикаций</h3><p>Прямые ссылки живут в совместимых RTDB-записях.</p></div><button class="button primary-button" data-action="open-composer">${svgIcon("i-plus")}Новый клип</button></header><div class="studio-stats"><div class="studio-stat"><strong>${formatCompact(own.length)}</strong><span>опубликовано</span></div><div class="studio-stat"><strong>${formatCompact(ownLikes)}</strong><span>реакций</span></div><div class="studio-stat"><strong>${formatCompact(ownViews)}</strong><span>просмотров</span></div></div><div class="studio-info">${svgIcon("i-shield")}<span>Для настоящей production-защиты включите Firebase Authentication и RTDB Rules: UI не может заменить серверные права доступа.</span></div></section>`;
      return;
    }
    let clips = [];
    let title = "";
    let detail = "";
    let icon = "i-grid";
    if (tab === "clips") {
      clips = ownClips(); title = "Ваши клипы"; detail = "Опубликуйте первую прямую ссылку и она появится здесь."; icon = "i-grid";
    } else if (tab === "saved") {
      clips = state.clips.filter(clip => isSaved(clip.id)); title = "Сохранённые"; detail = "Нажимайте закладку под клипом, чтобы вернуться к нему позже."; icon = "i-bookmark";
    } else {
      const ids = state.history.map(entry => entry.clipId);
      clips = ids.map(clipById).filter(Boolean); title = "История просмотра"; detail = "Здесь остаются недавно открытые клипы только на этом устройстве."; icon = "i-clock";
    }
    if (!clips.length) {
      container.innerHTML = `<section class="profile-empty">${svgIcon(icon)}<h3>${escapeHTML(title)} пока пусты</h3><p>${escapeHTML(detail)}</p>${tab === "clips" ? `<button class="button primary-button" data-action="open-composer">${svgIcon("i-plus")}Создать клип</button>` : `<button class="button ghost-button" data-action="nav-home">Открыть поток</button>`}</section>`;
      return;
    }
    container.innerHTML = `<div class="profile-grid">${clips.slice(0, 30).map(clip => `<button class="profile-clip" data-open-clip="${escapeHTML(clip.id)}" style="--profile-clip-bg:${colorPair(clip.id).background}">${svgIcon("i-play")}<div><strong>${escapeHTML(clip.author)}</strong><span>${escapeHTML(clip.caption || clip.sound)}</span></div></button>`).join("")}</div>`;
  }

  function renderActivity() {
    const list = $("#activityList");
    if (!list) return;
    const items = state.activities.filter(item => state.inboxFilter === "all" || item.type === state.inboxFilter);
    if (!items.length) {
      list.innerHTML = `<div class="activity-empty">${svgIcon("i-bell")}<p>Пока здесь спокойно. Новые действия и объявления появятся в этом списке.</p></div>`;
      return;
    }
    const icon = type => type === "social" ? "i-heart" : type === "upload" ? "i-link" : type === "warning" ? "i-info" : "i-sparkles";
    const bg = type => type === "social" ? "linear-gradient(135deg,#f04d77,#8755b4)" : type === "upload" ? "linear-gradient(135deg,#4f77dc,#2aa89f)" : "linear-gradient(135deg,var(--accent),var(--accent-2))";
    list.innerHTML = items.map(item => `<button class="activity-item${item.read ? "" : " is-unread"}" data-activity-id="${escapeHTML(item.id)}" style="--activity-bg:${bg(item.type)}"><span class="activity-icon">${svgIcon(icon(item.type))}</span><span class="activity-copy"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.body)}</p></span><time class="activity-time">${escapeHTML(relativeTime(item.createdAt))}</time></button>`).join("");
    updateUnreadIndicators();
  }

  function updateUnreadIndicators() {
    const unread = state.activities.filter(item => !item.read).length;
    [$("#inboxBadge"), $("#mobileInboxBadge")].forEach(node => {
      node.hidden = unread === 0;
      node.textContent = unread > 9 ? "9+" : String(unread);
    });
    $("#notificationDot").hidden = unread === 0;
  }

  function markActivitiesRead() {
    state.activities.forEach(item => { item.read = true; });
    persist("activity");
    renderActivity();
    announce("Все события отмечены прочитанными", "success", 1800);
  }

  function handleActivity(activityId) {
    const item = state.activities.find(activity => activity.id === activityId);
    if (!item) return;
    item.read = true;
    persist("activity");
    updateUnreadIndicators();
    if (item.clipId && clipById(item.clipId)) openClip(item.clipId);
  }

  function navigateView(view) {
    const target = ["home", "explore", "inbox", "profile"].includes(view) ? view : "home";
    state.currentView = target;
    $$(".view").forEach(section => section.classList.toggle("is-active", section.dataset.view === target));
    $$('[data-nav]').forEach(button => button.classList.toggle("is-active", button.dataset.nav === target));
    if (target !== "home") stopAllVideos();
    else if (activeClip()) window.setTimeout(() => activateClip(state.activeClipId, { scroll: false }), 80);
    const labels = { home: "Для вас", explore: "Открыть", inbox: "Активность", profile: "Мой профиль" };
    document.title = `${labels[target]} · Gram Flow`;
    window.history.replaceState({}, "", `${location.pathname}${target === "home" ? "" : `#${target}`}`);
    closeMobileMenu();
    screenReader(`Раздел ${labels[target]}`);
  }

  function openClip(clipId) {
    if (!clipById(clipId)) return;
    navigateView("home");
    if (!state.visibleClips.some(clip => clip.id === clipId)) {
      state.hidden[clipId] && restoreHidden(clipId);
      state.topic = "all"; state.authorFilter = ""; state.soundFilter = ""; state.feedMode = "foryou";
      rebuildVisibleClips(); renderFeed("");
    }
    window.setTimeout(() => activateClip(clipId, { scroll: true, announce: true }), 70);
  }

  function updateDeepLink(clipId) {
    if (!clipId || state.currentView !== "home") return;
    try {
      const url = new URL(location.href);
      url.searchParams.delete("v");
      url.searchParams.set("clip", clipId);
      url.hash = "";
      window.history.replaceState({ clip: clipId }, "", url);
    } catch (_) { /* noop */ }
  }

  function buildClipLink(clipId) {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("clip", clipId);
    return url.href;
  }

  async function copyText(value, message = "Скопировано") {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(textarea);
        textarea.focus(); textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      announce(message, "success", 1700);
      return true;
    } catch (error) {
      logError("Clipboard", error);
      announce("Не удалось скопировать", "error");
      return false;
    }
  }

  function openShare(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    state.shareClipId = clip.id;
    $("#sharePreview").innerHTML = `<span class="share-cover" style="--share-bg:${colorPair(clip.id).background}">${svgIcon("i-play")}</span><div><strong>${escapeHTML(clip.caption || clip.sound)}</strong><span>${escapeHTML(clip.author)} · ${escapeHTML(clip.directHost)}</span></div>`;
    $("#repostLabel").textContent = state.reposts[clip.id] ? "Убрать репост" : "Репостнуть";
    openOverlay("shareModal");
  }

  async function nativeShare() {
    const clip = clipById(state.shareClipId);
    if (!clip) return;
    const shareData = { title: `${clip.author} · Gram Flow`, text: clip.caption || clip.sound, url: buildClipLink(clip.id) };
    try {
      if (navigator.share) await navigator.share(shareData);
      else await copyText(shareData.url, "Ссылка на клип скопирована");
      clip.shares += 1;
      api.transaction(`videos/${clip.id}/shares`, current => Math.max(0, Number(current) || 0) + 1).catch(error => logError("Share metric", error));
    } catch (error) {
      if (error && error.name !== "AbortError") logError("Native share", error);
    }
  }

  function openMenu(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    state.menuClipId = clip.id;
    $("#menuClipContext").innerHTML = `<span class="menu-cover" style="--menu-bg:${colorPair(clip.id).background}">${svgIcon("i-play")}</span><div><strong>${escapeHTML(clip.caption || clip.sound)}</strong><span>${escapeHTML(clip.author)}</span></div>`;
    $("#notInterestedLabel").textContent = state.hidden[clip.id] ? "Вернуть в ленту" : "Не интересно";
    openOverlay("menuModal");
  }

  function openDetails(clipId = state.menuClipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    closeOverlay("menuModal");
    const rows = [
      ["Автор", clip.author], ["Звук", clip.sound], ["Опубликован", relativeTime(clip.createdAt)], ["Формат", "прямая HTTPS-ссылка"], ["Хост", clip.directHost], ["Реакции", formatNumber(clip.likes)], ["Комментарии", formatNumber(clip.commentCount)], ["Видимость", clip.visibility === "unlisted" ? "по прямой ссылке" : "публичная"]
    ];
    $("#clipDetailsList").innerHTML = rows.map(([name, value]) => `<div><dt>${escapeHTML(name)}</dt><dd title="${escapeHTML(value)}">${escapeHTML(value)}</dd></div>`).join("");
    $("#clipDirectLink").textContent = clip.src;
    $("#clipDirectLink").dataset.copyValue = clip.src;
    state.shareClipId = clip.id;
    openOverlay("detailsModal");
  }

  function openReport(clipId = state.menuClipId) {
    state.menuClipId = clipId;
    closeOverlay("menuModal");
    openOverlay("reportModal", "input[name='reportReason']");
  }

  function submitReport() {
    const clip = clipById(state.menuClipId);
    if (!clip) return;
    const reason = $("input[name='reportReason']:checked")?.value || "other";
    const note = text($("#reportNote").value);
    state.reports.unshift({ id: uid("report"), clipId: clip.id, source: clip.src, reason, note, createdAt: now() });
    state.reports = state.reports.slice(0, 40);
    persist("reports");
    closeOverlay("reportModal");
    announce("Жалоба сохранена локально", "success");
    addActivity("system", "Жалоба сохранена", "Подключите защищённый moderation backend, чтобы отправлять жалобы команде.", { id: `report-${state.reports[0].id}`, read: false });
  }

  function openOverlay(id, focusSelector = "") {
    const overlay = $(`#${id}`);
    if (!overlay) return;
    if (state.openOverlay && state.openOverlay !== id) closeOverlay(state.openOverlay, true);
    state.lastFocused = document.activeElement;
    state.openOverlay = id;
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    window.setTimeout(() => {
      const target = focusSelector ? $(focusSelector, overlay) || $(focusSelector) : overlay.querySelector("button, input, textarea, select, [tabindex]:not([tabindex='-1'])");
      if (target) target.focus({ preventScroll: true });
    }, 80);
  }

  function closeOverlay(id = state.openOverlay, suppressFocus = false) {
    const overlay = $(`#${id}`);
    if (!overlay) return;
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    if (state.openOverlay === id) state.openOverlay = null;
    if (!state.openOverlay) document.body.classList.remove("modal-open");
    if (!suppressFocus && state.lastFocused && typeof state.lastFocused.focus === "function") state.lastFocused.focus({ preventScroll: true });
  }

  function closeAllOverlays() {
    $$(".overlay.is-open").forEach(item => { item.classList.remove("is-open"); item.setAttribute("aria-hidden", "true"); });
    state.openOverlay = null;
    document.body.classList.remove("modal-open");
  }

  function openComposer() {
    state.composerStep = 1;
    $("#composerForm").reset();
    $("#clipAuthor").value = cleanHandle(state.profile.handle);
    $("#clipComments").checked = true;
    $("#clipLoop").checked = true;
    $("#clipVisibility").value = "public";
    $("#captionCounter").textContent = "0";
    $("#tagPreview").innerHTML = "";
    $("#urlValidationHint").className = "field-hint";
    $("#urlValidationHint").textContent = "Поддерживаются HTTPS MP4, WebM, MOV и HLS. Ссылка не копируется в базу — хранится как есть.";
    updateComposerStep();
    openOverlay("composerModal", "#clipUrl");
  }

  function validateDirectLink(showStatus = true) {
    const input = $("#clipUrl");
    const hint = $("#urlValidationHint");
    const url = directVideoUrl(input.value.trim());
    if (!url) {
      if (showStatus) {
        hint.className = "field-hint is-error";
        hint.textContent = "Нужна абсолютная HTTPS-ссылка. HTTP разрешён только для localhost в разработке.";
      }
      return "";
    }
    let parsed;
    try { parsed = new URL(url); } catch (_) { return ""; }
    if (parsed.username || parsed.password) {
      hint.className = "field-hint is-error";
      hint.textContent = "Не публикуйте URL с логином или паролем.";
      return "";
    }
    input.value = url;
    if (showStatus) {
      const extension = (parsed.pathname.split(".").pop() || "").toUpperCase();
      hint.className = "field-hint is-valid";
      hint.textContent = `Ссылка корректна · ${parsed.hostname.replace(/^www\./, "")} ${extension ? `· ${extension}` : ""}`;
    }
    $("#composerPreviewHost").textContent = parsed.hostname.replace(/^www\./, "");
    $("#composerPreviewTitle").textContent = "Источник готов к публикации";
    return url;
  }

  async function probeDirectLink() {
    const button = $("#validateUrlButton");
    button.classList.add("is-loading");
    const url = validateDirectLink(true);
    if (!url) { button.classList.remove("is-loading"); return; }
    const hint = $("#urlValidationHint");
    hint.textContent = "Проверяем доступность источника…";
    // HEAD is optional: many media CDNs reject CORS HEAD although <video> works perfectly.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { method: "HEAD", mode: "cors", signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) {
        const contentType = response.headers.get("content-type") || "медиа";
        hint.className = "field-hint is-valid";
        hint.textContent = `Источник отвечает · ${contentType.split(";")[0]}`;
      } else throw new Error(`HTTP ${response.status}`);
    } catch (_) {
      hint.className = "field-hint is-valid";
      hint.textContent = "URL сохранён. CDN не разрешил проверку CORS — нативный плеер попробует открыть видео.";
    } finally { button.classList.remove("is-loading"); }
  }

  function updateComposerTags() {
    const tags = parseTags($("#clipTags").value, $("#clipCaption").value);
    $("#tagPreview").innerHTML = tags.map(tag => `<i>${escapeHTML(tag)}</i>`).join("");
  }

  function updateComposerStep() {
    const step = state.composerStep;
    $$(".composer-step").forEach(section => section.classList.toggle("is-active", Number(section.dataset.composerStep) === step));
    $$(".composer-progress span").forEach(span => {
      const number = Number(span.dataset.step);
      span.classList.toggle("is-active", number === step);
      span.classList.toggle("is-complete", number < step);
    });
    $("#composerBack").hidden = step === 1;
    $("#composerNext").hidden = step === 3;
    $("#composerPublish").hidden = step !== 3;
    if (step === 3) populatePublishSummary();
  }

  function composerNext() {
    if (state.composerStep === 1 && !validateDirectLink(true)) return;
    if (state.composerStep < 3) {
      state.composerStep += 1;
      updateComposerStep();
      if (state.composerStep === 2) $("#clipAuthor").focus();
    }
  }
  function composerBack() { if (state.composerStep > 1) { state.composerStep -= 1; updateComposerStep(); } }

  function composerPayload() {
    const src = validateDirectLink(false);
    const author = cleanHandle($("#clipAuthor").value, cleanHandle(state.profile.handle));
    const caption = text($("#clipCaption").value).slice(0, 500);
    const sound = text($("#clipSound").value, `Оригинальный звук · ${author}`).slice(0, 80);
    const cover = safeUrl($("#clipCover").value, false);
    const captions = safeUrl($("#clipCaptions").value, false);
    const createdAt = now();
    return {
      src,
      // Legacy field aliases are intentionally retained so the old deployed page can read new clips.
      user: author,
      desc: caption,
      music: sound,
      timestamp: createdAt,
      createdAt,
      updatedAt: createdAt,
      author,
      authorName: state.profile.name,
      authorId: state.deviceId,
      avatar: state.profile.avatar || "",
      caption,
      sound,
      tags: parseTags($("#clipTags").value, caption),
      cover,
      captions,
      visibility: $("#clipVisibility").value === "unlisted" ? "unlisted" : "public",
      commentsEnabled: $("#clipComments").checked,
      loop: $("#clipLoop").checked,
      fit: state.preferences.fit,
      likes: 0,
      bookmarks: 0,
      shares: 0,
      views: 0,
      schemaVersion: CONFIG.schemaVersion
    };
  }

  function populatePublishSummary() {
    const data = composerPayload();
    $("#publishSummary").innerHTML = [
      ["Источник", data.src ? new URL(data.src).hostname.replace(/^www\./, "") : "—"],
      ["Автор", data.user], ["Видимость", data.visibility === "unlisted" ? "по ссылке" : "публичный поток"], ["Комментарии", data.commentsEnabled ? "включены" : "выключены"], ["Теги", data.tags.length ? data.tags.join(" ") : "без тегов"]
    ].map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd title="${escapeHTML(value)}">${escapeHTML(value)}</dd></div>`).join("");
  }

  async function publishComposer(event) {
    event.preventDefault();
    if (state.composerStep !== 3) { composerNext(); return; }
    const data = composerPayload();
    if (!data.src) { state.composerStep = 1; updateComposerStep(); announce("Проверьте прямую ссылку", "error"); return; }
    const clipId = uid("clip");
    const button = $("#composerPublish");
    button.disabled = true;
    button.innerHTML = `${svgIcon("i-refresh")}Публикуем…`;
    const optimisticRaw = { ...data, _pending: true };
    state.localClips.unshift({ id: clipId, raw: optimisticRaw });
    normalizeClips(); rebuildVisibleClips();
    try {
      await api.put(`videos/${clipId}`, data);
      state.root.videos = { ...asObject(state.root.videos), [clipId]: data };
      state.localClips = state.localClips.filter(clip => clip.id !== clipId);
      normalizeClips(); rebuildVisibleClips();
      closeOverlay("composerModal");
      state.topic = "all"; state.feedMode = "foryou";
      renderFeed(""); renderExplore(); updateMetrics();
      navigateView("home");
      window.setTimeout(() => activateClip(clipId, { scroll: true, announce: true }), 100);
      addActivity("upload", "Клип опубликован", `${data.user} · ${data.src ? new URL(data.src).hostname : "прямая ссылка"}`, { id: `published-${clipId}`, clipId, read: false });
      announce("Клип опубликован в RTDB", "success");
    } catch (error) {
      queueOperation({ type: "publish", clipId, data });
      closeOverlay("composerModal");
      renderFeed("");
      announce("Клип сохранён в очереди до подключения", "info", 4300);
      logError("Clip publish", error);
    } finally {
      button.disabled = false;
      button.innerHTML = `${svgIcon("i-send")}Опубликовать`;
    }
  }

  function updateSettingsControls() {
    const p = state.preferences;
    const checks = [
      ["#reduceMotionSetting", p.reduceMotion], ["#compactModeSetting", p.compactMode], ["#autoplaySetting", p.autoplay], ["#mutedSetting", p.muted], ["#dataSaverSetting", p.dataSaver]
    ];
    checks.forEach(([selector, value]) => { const element = $(selector); if (element) element.checked = Boolean(value); });
    const volume = $("#volumeSetting");
    if (volume) volume.value = String(p.volume);
    const label = $("#volumeSettingLabel");
    if (label) label.textContent = `${Math.round(p.volume * 100)}%`;
    $$("[data-theme-value]").forEach(button => button.classList.toggle("is-active", button.dataset.themeValue === p.theme));
    $("#settingProfileName").value = state.profile.name;
    $("#settingProfileHandle").value = cleanHandle(state.profile.handle);
    $("#settingProfileBio").value = state.profile.bio || "";
    $("#settingProfileAvatar").value = state.profile.avatar || "";
  }

  function openSettings(section = "appearance") {
    selectSettingsSection(section);
    updateSettingsControls();
    openOverlay("settingsModal");
  }
  function selectSettingsSection(section) {
    const current = ["appearance", "playback", "profile", "data"].includes(section) ? section : "appearance";
    $$(".settings-nav-item").forEach(button => button.classList.toggle("is-active", button.dataset.settingsSection === current));
    $$(".settings-page").forEach(page => page.classList.toggle("is-active", page.dataset.settingsPage === current));
  }

  async function saveProfile(event) {
    event.preventDefault();
    const name = text($("#settingProfileName").value).slice(0, 40);
    const handle = cleanHandle($("#settingProfileHandle").value, state.profile.handle);
    const bio = text($("#settingProfileBio").value).slice(0, 160);
    const avatarInput = $("#settingProfileAvatar").value.trim();
    const avatar = avatarInput ? safeUrl(avatarInput, true) : "";
    if (!name) { announce("Введите отображаемое имя", "error"); return; }
    if (avatarInput && !avatar) { announce("Аватар должен быть HTTPS-ссылкой на изображение", "error"); return; }
    state.profile = { ...state.profile, name, handle, bio, avatar, updatedAt: now() };
    persist("profile"); updateProfileUI(); renderComments();
    const payload = { name, username: handle, handle, bio, avatar, uid: state.deviceId, updatedAt: state.profile.updatedAt, schemaVersion: CONFIG.schemaVersion };
    try {
      await api.put(`users/${state.deviceId}`, payload);
      state.root.users = { ...asObject(state.root.users), [state.deviceId]: payload };
      announce("Профиль сохранён", "success");
    } catch (error) {
      queueOperation({ type: "profile", data: payload });
      announce("Профиль сохранён локально и ждёт сеть", "info");
      logError("Profile save", error);
    }
  }

  function exportLocalData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "Gram Flow",
      deviceId: state.deviceId,
      profile: state.profile,
      preferences: state.preferences,
      bookmarks: state.bookmarks,
      follows: state.follows,
      hidden: state.hidden,
      history: state.history
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gram-flow-local-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    announce("Локальные настройки экспортированы", "success");
  }

  function clearLocalData() {
    showConfirm({
      title: "Очистить локальные данные?",
      text: "Будут удалены история, скрытые клипы, сохранения, очередь и настройки только на этом устройстве. RTDB не изменится.",
      danger: true,
      accept: "Очистить",
      onAccept: () => {
        [STORAGE.likes, STORAGE.bookmarks, STORAGE.follows, STORAGE.hidden, STORAGE.reposts, STORAGE.history, STORAGE.activity, STORAGE.outbox, STORAGE.reports, STORAGE.preferences].forEach(key => { try { localStorage.removeItem(key); } catch (_) { /* noop */ } });
        state.likes = {}; state.bookmarks = {}; state.follows = {}; state.hidden = {}; state.reposts = {}; state.history = []; state.activities = []; state.outbox = []; state.reports = []; state.preferences = DEFAULT_PREFERENCES();
        applyPreferences(); rebuildVisibleClips(); renderFeed(""); renderExplore(); renderProfileContent(); renderActivity(); updateProfileUI();
        announce("Локальные данные очищены", "success");
      }
    });
  }

  function showConfirm(options) {
    state.confirmAction = options.onAccept;
    $("#confirmTitle").textContent = options.title || "Подтвердить действие";
    $("#confirmText").textContent = options.text || "Вы уверены?";
    $("#confirmAccept").textContent = options.accept || "Подтвердить";
    $("#confirmIcon").classList.toggle("is-danger", Boolean(options.danger));
    $("#confirmIcon").innerHTML = svgIcon(options.danger ? "i-trash" : "i-info");
    $("#confirmAccept").classList.toggle("danger-button", Boolean(options.danger));
    $("#confirmAccept").classList.toggle("primary-button", !options.danger);
    openOverlay("confirmModal", "#confirmAccept");
  }

  function executeConfirm() {
    const action = state.confirmAction;
    state.confirmAction = null;
    closeOverlay("confirmModal");
    if (typeof action === "function") action();
  }

  function openCommand() {
    $("#commandInput").value = "";
    state.commandSelection = 0;
    renderCommandResults("");
    openOverlay("commandModal", "#commandInput");
  }

  function quickActions() {
    return [
      { id: "create", type: "action", title: "Создать клип", subtitle: "Добавить прямую ссылку в RTDB", icon: "i-plus", key: "C", run: () => { closeOverlay("commandModal"); openComposer(); } },
      { id: "explore", type: "action", title: "Открыть витрину", subtitle: "Темы, звуки и недавние клипы", icon: "i-compass", key: "E", run: () => { closeOverlay("commandModal"); navigateView("explore"); } },
      { id: "saved", type: "action", title: "Сохранённые клипы", subtitle: "Перейти в сохранённые", icon: "i-bookmark", key: "B", run: () => { closeOverlay("commandModal"); navigateView("profile"); selectProfileTab("saved"); } },
      { id: "settings", type: "action", title: "Настройки", subtitle: "Тема, воспроизведение и профиль", icon: "i-settings", key: "", run: () => { closeOverlay("commandModal"); openSettings(); } }
    ];
  }

  function renderCommandResults(query) {
    const normalized = text(query).toLowerCase();
    let items = quickActions();
    if (normalized) {
      const clipResults = state.clips.filter(clip => [clip.author, clip.caption, clip.sound, clip.tags.join(" ")].join(" ").toLowerCase().includes(normalized)).slice(0, 9).map(clip => ({ id: `clip-${clip.id}`, type: "clip", clip, title: clip.caption || clip.author, subtitle: `${clip.author} · ${clip.sound}`, run: () => { closeOverlay("commandModal"); openClip(clip.id); } }));
      items = [...items.filter(item => `${item.title} ${item.subtitle}`.toLowerCase().includes(normalized)), ...clipResults];
    }
    state.commandItems = items;
    state.commandSelection = clamp(state.commandSelection, 0, Math.max(0, items.length - 1));
    const root = $("#commandResults");
    if (!items.length) {
      root.innerHTML = `<div class="command-empty">Ничего не нашли. Попробуйте автора, фразу из подписи, звук или #тег.</div>`;
      return;
    }
    root.innerHTML = items.map((item, index) => {
      if (item.type === "clip") return `<button class="command-row${index === state.commandSelection ? " is-selected" : ""}" data-command-index="${index}"><span class="command-video-cover" style="--command-bg:${colorPair(item.clip.id).background}">${svgIcon("i-play")}</span><span class="command-row-copy"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.subtitle)}</span></span>${svgIcon("i-chevron-right")}</button>`;
      return `<button class="command-row${index === state.commandSelection ? " is-selected" : ""}" data-command-index="${index}"><span class="command-row-icon">${svgIcon(item.icon)}</span><span class="command-row-copy"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.subtitle)}</span></span>${item.key ? `<kbd>${escapeHTML(item.key)}</kbd>` : svgIcon("i-chevron-right")}</button>`;
    }).join("");
  }

  function executeCommand(index = state.commandSelection) {
    const item = state.commandItems[index];
    if (item && typeof item.run === "function") item.run();
  }

  function openFilter() {
    $("input[name='feedSort'][value='${state.feedFilter.sort}']")?.setAttribute("checked", "checked");
    $$("input[name='feedSort']").forEach(input => { input.checked = input.value === state.feedFilter.sort; });
    $("#filterWithSound").checked = state.feedFilter.withSound;
    $("#filterWithTags").checked = state.feedFilter.withTags;
    $("#filterExcludeSeen").checked = state.feedFilter.excludeSeen;
    openOverlay("filterModal");
  }

  function applyFilter() {
    state.feedFilter = {
      sort: $("input[name='feedSort']:checked")?.value || "smart",
      withSound: $("#filterWithSound").checked,
      withTags: $("#filterWithTags").checked,
      excludeSeen: $("#filterExcludeSeen").checked
    };
    closeOverlay("filterModal"); rebuildVisibleClips(); renderFeed(""); updateMetrics(); announce("Фильтры применены", "success", 1700);
  }

  function resetFilter() {
    state.feedFilter = { sort: "smart", withSound: false, withTags: false, excludeSeen: false };
    openFilter();
  }

  function openShortcuts() {
    if (state.openOverlay === "welcomeModal") closeOverlay("welcomeModal", true);
    openOverlay("shortcutsModal");
  }

  function closeMobileMenu() {
    const sheet = $("#mobileMenuSheet");
    if (sheet) { sheet.classList.remove("is-open"); sheet.setAttribute("aria-hidden", "true"); }
  }
  function toggleMobileMenu() {
    const sheet = $("#mobileMenuSheet");
    const open = !sheet.classList.contains("is-open");
    sheet.classList.toggle("is-open", open);
    sheet.setAttribute("aria-hidden", String(!open));
  }

  function filterByAuthor(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    state.authorFilter = clip.author;
    state.soundFilter = "";
    state.topic = "all";
    rebuildVisibleClips();
    renderFeed("");
    announce(`Клипы автора ${clip.author}`, "info", 2000);
  }
  function filterBySound(clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    state.soundFilter = clip.sound;
    state.authorFilter = "";
    state.topic = "all";
    rebuildVisibleClips(); renderFeed("");
    announce(`Звук: ${clip.sound}`, "info", 2200);
  }
  function filterByTag(tag) {
    state.topic = `tag:${tag}`;
    state.authorFilter = ""; state.soundFilter = "";
    rebuildVisibleClips(); renderFeed("");
    announce(`Тема ${tag}`, "info", 1600);
  }

  function toggleCaptions(clipId) {
    const card = cardById(clipId);
    const video = card && $(".clip-video", card);
    if (!video || !video.textTracks.length) { announce("Для этого клипа нет WebVTT-субтитров", "info"); return; }
    const track = video.textTracks[0];
    track.mode = track.mode === "showing" ? "hidden" : "showing";
    announce(track.mode === "showing" ? "Субтитры включены" : "Субтитры выключены", "info", 1600);
  }

  async function togglePictureInPicture(clipId) {
    const video = clipId === state.activeClipId ? activeVideo() : hydrateVideo(clipId);
    if (!video || !document.pictureInPictureEnabled) { announce("Картинка в картинке не поддерживается браузером", "error"); return; }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (error) { announce("Не удалось открыть мини-плеер", "error"); logError("Picture in Picture", error); }
  }

  async function toggleFullscreen(clipId) {
    const card = cardById(clipId);
    const shell = card && $(".clip-media-shell", card);
    if (!shell) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shell.requestFullscreen) await shell.requestFullscreen();
      else if (shell.webkitRequestFullscreen) shell.webkitRequestFullscreen();
    } catch (error) { logError("Fullscreen", error); announce("Полный экран недоступен", "error"); }
  }

  function seekFromPointer(event, track) {
    const card = track.closest(".clip-card");
    const video = card && $(".clip-video", card);
    if (!video || !Number.isFinite(video.duration)) return;
    const rect = track.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    video.currentTime = ratio * video.duration;
  }

  function handleClipAction(action, card, event) {
    const clipId = card.dataset.clipId;
    switch (action) {
      case "toggle-play": {
        const tap = state.tap;
        const timestamp = performance.now();
        if (tap.clipId === clipId && timestamp - tap.time < 290) {
          clearTimeout(tap.timer); tap.time = 0; toggleLike(clipId, true);
        } else {
          tap.clipId = clipId; tap.time = timestamp;
          clearTimeout(tap.timer);
          tap.timer = window.setTimeout(() => { if (tap.clipId === clipId && tap.time === timestamp) togglePlayback(clipId); }, 295);
        }
        break;
      }
      case "like": toggleLike(clipId); break;
      case "comments": openComments(clipId); break;
      case "bookmark": toggleBookmark(clipId); break;
      case "share": openShare(clipId); break;
      case "follow": toggleFollow(clipId); break;
      case "toggle-mute": toggleMute(); break;
      case "open-menu": openMenu(clipId); break;
      case "filter-author": filterByAuthor(clipId); break;
      case "filter-sound": filterBySound(clipId); break;
      case "filter-tag": filterByTag(event.currentTarget.dataset.tag || event.target.dataset.tag); break;
      case "expand-caption": {
        const caption = $(".clip-caption", card);
        caption.classList.toggle("is-expanded");
        event.target.textContent = caption.classList.contains("is-expanded") ? "свернуть" : "ещё";
        break;
      }
      case "toggle-captions": toggleCaptions(clipId); break;
      case "toggle-pip": togglePictureInPicture(clipId); break;
      case "toggle-fullscreen": toggleFullscreen(clipId); break;
      default: break;
    }
  }

  function initDeepLink() {
    const url = new URL(location.href);
    const clip = text(url.searchParams.get("clip"));
    const videoUrl = directVideoUrl(url.searchParams.get("v"));
    const requestedAction = text(url.searchParams.get("action"));
    if (requestedAction === "create") window.setTimeout(() => openComposer(), 180);
    if (clip) state.deepLink.clip = clip;
    if (videoUrl) {
      state.deepLink.url = videoUrl;
      const ephemeralId = `direct_${hashNumber(videoUrl).toString(36)}`;
      state.localClips.unshift({
        id: ephemeralId,
        raw: { src: videoUrl, user: "@direct", desc: "Открыто по прямой ссылке", music: "Оригинальный звук · @direct", timestamp: now(), visibility: "public", loop: true }
      });
      state.deepLink.clip = ephemeralId;
    }
    const hash = location.hash.replace(/^#/, "");
    if (["explore", "inbox", "profile"].includes(hash)) window.setTimeout(() => navigateView(hash), 50);
  }

  function bindEvents() {
    document.addEventListener("click", event => {
      const nav = event.target.closest("[data-nav]");
      if (nav) { event.preventDefault(); navigateView(nav.dataset.nav); return; }
      const generic = event.target.closest("[data-action]");
      if (generic) {
        const action = generic.dataset.action;
        if (handleGlobalAction(action, generic, event)) return;
      }
      const clipAction = event.target.closest("[data-clip-action]");
      if (clipAction) {
        const card = clipAction.closest(".clip-card");
        if (card) { event.preventDefault(); handleClipAction(clipAction.dataset.clipAction, card, event); }
        return;
      }
      const topic = event.target.closest("[data-topic]");
      if (topic) { setTopic(topic.dataset.topic); return; }
      const open = event.target.closest("[data-open-clip]");
      if (open) { openClip(open.dataset.openClip); return; }
      const trend = event.target.closest("[data-explore-tag]");
      if (trend) { filterByTag(trend.dataset.exploreTag); navigateView("home"); return; }
      const sound = event.target.closest("[data-explore-sound]");
      if (sound) { state.soundFilter = sound.dataset.exploreSound; state.authorFilter = ""; rebuildVisibleClips(); renderFeed(""); navigateView("home"); return; }
      const inbox = event.target.closest("[data-inbox-filter]");
      if (inbox) { state.inboxFilter = inbox.dataset.inboxFilter; $$(".inbox-tab").forEach(button => button.classList.toggle("is-active", button === inbox)); renderActivity(); return; }
      const profileTab = event.target.closest("[data-profile-tab]");
      if (profileTab) { selectProfileTab(profileTab.dataset.profileTab); return; }
      const settingsTab = event.target.closest("[data-settings-section]");
      if (settingsTab) { selectSettingsSection(settingsTab.dataset.settingsSection); return; }
      const theme = event.target.closest("[data-theme-value]");
      if (theme) { state.preferences.theme = theme.dataset.themeValue; persist("preferences"); applyPreferences(); return; }
      const command = event.target.closest("[data-command-index]");
      if (command) { executeCommand(Number(command.dataset.commandIndex)); return; }
      const commentAction = event.target.closest("[data-comment-action]");
      if (commentAction) {
        const item = commentAction.closest("[data-comment-id]");
        const commentId = item && item.dataset.commentId;
        if (commentAction.dataset.commentAction === "reply") {
          const comment = normalizedComments(clipById(state.commentClipId)).find(value => value.id === commentId);
          if (comment) { state.replyTo = comment; renderComments(); $("#commentInput").focus(); }
        } else if (commentAction.dataset.commentAction === "like") likeComment(commentId);
        return;
      }
      const commentSort = event.target.closest("[data-comment-sort]");
      if (commentSort) {
        state.commentSort = commentSort.dataset.commentSort === "recent" ? "recent" : "top";
        renderComments();
        return;
      }
      const emoji = event.target.closest("[data-emoji]");
      if (emoji) {
        const input = $("#commentInput");
        input.value += emoji.dataset.emoji;
        input.focus();
        input.dispatchEvent(new Event("input"));
        return;
      }
      const activity = event.target.closest("[data-activity-id]");
      if (activity) { handleActivity(activity.dataset.activityId); }
    });

    $("#forYouTab").addEventListener("click", () => setFeedTab("foryou"));
    $("#followingTab").addEventListener("click", () => setFeedTab("following"));
    $("#composerForm").addEventListener("submit", publishComposer);
    $("#validateUrlButton").addEventListener("click", probeDirectLink);
    $("#clipCaption").addEventListener("input", event => { $("#captionCounter").textContent = String(event.target.value.length); updateComposerTags(); });
    $("#clipTags").addEventListener("input", updateComposerTags);
    $("#clipUrl").addEventListener("input", () => validateDirectLink(false));
    $("#urlDropZone").addEventListener("dragover", event => { event.preventDefault(); $("#urlDropZone").classList.add("is-dragging"); });
    $("#urlDropZone").addEventListener("dragleave", () => $("#urlDropZone").classList.remove("is-dragging"));
    $("#urlDropZone").addEventListener("drop", event => {
      event.preventDefault(); $("#urlDropZone").classList.remove("is-dragging");
      const url = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (url) { $("#clipUrl").value = url.trim(); validateDirectLink(true); }
    });
    $("#commentForm").addEventListener("submit", event => { event.preventDefault(); submitComment(); });
    $("#commentInput").addEventListener("input", event => {
      event.target.style.height = "auto";
      event.target.style.height = `${Math.min(event.target.scrollHeight, 100)}px`;
    });
    $("#commandInput").addEventListener("input", event => { state.commandSelection = 0; renderCommandResults(event.target.value); });
    $("#profileForm").addEventListener("submit", saveProfile);
    $("#reportForm").addEventListener("submit", event => { event.preventDefault(); submitReport(); });
    ["#reduceMotionSetting", "#compactModeSetting", "#autoplaySetting", "#mutedSetting", "#dataSaverSetting"].forEach(selector => {
      $(selector).addEventListener("change", event => {
        const field = ({ "#reduceMotionSetting": "reduceMotion", "#compactModeSetting": "compactMode", "#autoplaySetting": "autoplay", "#mutedSetting": "muted", "#dataSaverSetting": "dataSaver" })[selector];
        state.preferences[field] = event.target.checked;
        persist("preferences"); applyPreferences(); updateRenderedCards();
      });
    });
    $("#volumeSetting").addEventListener("input", event => {
      state.preferences.volume = Number(event.target.value);
      persist("preferences"); updateSettingsControls();
      $$(".clip-video", $("#feed")).forEach(video => { video.volume = state.preferences.volume; });
    });
    $("#feed").addEventListener("pointerdown", event => {
      const track = event.target.closest(".progress-track");
      if (!track) return;
      event.preventDefault();
      track.setPointerCapture && track.setPointerCapture(event.pointerId);
      seekFromPointer(event, track);
      const move = pointerEvent => seekFromPointer(pointerEvent, track);
      const end = () => { track.removeEventListener("pointermove", move); track.removeEventListener("pointerup", end); track.removeEventListener("pointercancel", end); };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", end);
      track.addEventListener("pointercancel", end);
    });
    $("#feed").addEventListener("dblclick", event => { event.preventDefault(); });
    document.addEventListener("keydown", handleKeyboard);
    window.addEventListener("online", () => { state.connection.status = "connecting"; updateConnectionUI(); getFreshSnapshot(false); flushOutbox(); });
    window.addEventListener("offline", () => { state.connection.status = "offline"; updateConnectionUI(); announce("Вы офлайн. Новые действия попадут в очередь.", "info", 3200); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopAllVideos();
      else if (state.currentView === "home" && !state.openOverlay) playActiveVideo();
    });
    window.addEventListener("popstate", () => {
      const url = new URL(location.href);
      const clip = url.searchParams.get("clip");
      if (clip && clipById(clip)) openClip(clip);
    });
  }

  function handleGlobalAction(action, element, event) {
    switch (action) {
      case "open-composer": openComposer(); return true;
      case "close-composer": closeOverlay("composerModal"); return true;
      case "composer-next": composerNext(); return true;
      case "composer-back": composerBack(); return true;
      case "open-command": openCommand(); return true;
      case "close-command": closeOverlay("commandModal"); return true;
      case "open-settings": openSettings(); return true;
      case "close-settings": closeOverlay("settingsModal"); return true;
      case "open-filter": openFilter(); return true;
      case "close-filter": closeOverlay("filterModal"); return true;
      case "apply-filter": applyFilter(); return true;
      case "reset-filter": resetFilter(); return true;
      case "close-comments": closeOverlay("commentsDrawer"); state.commentClipId = null; return true;
      case "close-share": closeOverlay("shareModal"); return true;
      case "native-share": nativeShare(); return true;
      case "copy-share-link": { const clip = clipById(state.shareClipId); if (clip) copyText(buildClipLink(clip.id), "Ссылка на клип скопирована"); return true; }
      case "copy-media-link": { const clip = clipById(state.shareClipId || state.menuClipId); const explicit = $("#clipDirectLink")?.dataset.copyValue; if (explicit || clip) copyText(explicit || clip.src, "Прямая ссылка скопирована"); return true; }
      case "toggle-repost": toggleRepost(); return true;
      case "close-menu": closeOverlay("menuModal"); return true;
      case "open-clip-details": openDetails(); return true;
      case "toggle-not-interested": if (state.hidden[state.menuClipId]) restoreHidden(state.menuClipId); else setNotInterested(state.menuClipId); return true;
      case "report-clip": openReport(); return true;
      case "close-details": closeOverlay("detailsModal"); return true;
      case "close-report": closeOverlay("reportModal"); return true;
      case "open-shortcuts": openShortcuts(); return true;
      case "close-shortcuts": closeOverlay("shortcutsModal"); return true;
      case "close-welcome": closeOverlay("welcomeModal"); setStorageString(STORAGE.welcome, "seen"); return true;
      case "close-confirm": closeOverlay("confirmModal"); return true;
      case "confirm-accept": executeConfirm(); return true;
      case "toggle-mobile-menu": toggleMobileMenu(); return true;
      case "previous-clip": navigateClip(-1); return true;
      case "next-clip": navigateClip(1); return true;
      case "toggle-play": togglePlayback(); return true;
      case "toggle-mute": toggleMute(); return true;
      case "refresh-feed": getFreshSnapshot(true); return true;
      case "nav-home": navigateView("home"); return true;
      case "mark-notifications-read": markActivitiesRead(); return true;
      case "edit-profile": openSettings("profile"); return true;
      case "share-profile": copyText(`${location.origin}${location.pathname}#profile`, "Ссылка на профиль скопирована"); return true;
      case "copy-device-id": copyText(state.deviceId, "ID устройства скопирован"); return true;
      case "export-local-data": exportLocalData(); return true;
      case "clear-local-data": clearLocalData(); return true;
      case "open-sounds": openCommand(); window.setTimeout(() => { $("#commandInput").value = ""; renderCommandResults("музыка"); }, 90); return true;
      default: return false;
    }
  }

  function handleKeyboard(event) {
    if (event.key === "Escape") {
      if (state.openOverlay) { closeOverlay(state.openOverlay); return; }
      closeMobileMenu(); return;
    }
    if (state.openOverlay === "commandModal") {
      if (event.key === "ArrowDown") { event.preventDefault(); state.commandSelection = clamp(state.commandSelection + 1, 0, state.commandItems.length - 1); renderCommandResults($("#commandInput").value); }
      else if (event.key === "ArrowUp") { event.preventDefault(); state.commandSelection = clamp(state.commandSelection - 1, 0, state.commandItems.length - 1); renderCommandResults($("#commandInput").value); }
      else if (event.key === "Enter") { event.preventDefault(); executeCommand(); }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommand(); return; }
    if (isInputTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "c") { event.preventDefault(); openComposer(); }
    else if (key === "g") { navigateView("home"); }
    else if (key === "e") { navigateView("explore"); }
    else if (key === "i") { navigateView("inbox"); }
    else if (key === "p") { navigateView("profile"); }
    else if (key === "arrowdown" || key === "j" || key === "pagedown") { event.preventDefault(); navigateClip(1); }
    else if (key === "arrowup" || key === "k" || key === "pageup") { event.preventDefault(); navigateClip(-1); }
    else if (key === " " || key === "spacebar") { event.preventDefault(); togglePlayback(); }
    else if (key === "l") { toggleLike(state.activeClipId); }
    else if (key === "b") { toggleBookmark(state.activeClipId); }
    else if (key === "m") { toggleMute(); }
    else if (key === "?") { openShortcuts(); }
  }

  function initializeServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("sw.js").catch(error => logError("Service worker", error));
  }

  function initialize() {
    state.currentView = "home";
    applyPreferences();
    initDeepLink();
    updateProfileUI();
    renderExplore(); renderProfileContent(); renderActivity(); updateUnreadIndicators(); updateConnectionUI();
    bindEvents(); setupMediaSession(); initializeServiceWorker();
    api.subscribe({
      onStatus: status => { state.connection.status = status; updateConnectionUI(); if (status === "online") flushOutbox(); },
      onEvent: receiveStreamEvent
    }, [
      "videos", "likes", "comments", `userLikes/${state.deviceId}`, `userBookmarks/${state.deviceId}`
    ]);
    getFreshSnapshot(false);
    if (state.localClips.length) { normalizeClips(); rebuildVisibleClips(); }
    renderFeed("");
    if (!storageString(STORAGE.welcome)) window.setTimeout(() => openOverlay("welcomeModal"), 700);
    window.setInterval(() => { if (state.connection.status === "online") updateConnectionUI(); }, 60000);
  }

  initialize();
})();
