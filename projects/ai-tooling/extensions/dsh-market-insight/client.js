/**
 * Market Insight — browser half of the `@local/dsh-market-insight` bundle.
 *
 * The Plugins page declares the `plugins.tab` slot; this module contributes one
 * extra tab, "Insight", that reads the Host pipeline over plain HTTP
 * (`/dsh-market-insight/api/...`) and renders stars, downloads and fork
 * families. Only `react` is required: every other dependency (primitives,
 * icons, stores) belongs to the Host shell and is deliberately not imported.
 *
 * Layout of this file:
 *   1. constants + locale dictionaries (CONTRACT §5.4)
 *   2. pure helpers (no React, no DOM — exercised by test/client-helpers.test.mjs)
 *   3. HTTP controller (snapshot store, abort/sequence race protection)
 *   4. stylesheet (theme tokens only — CONTRACT §5.3)
 *   5. presentational components
 *   6. module export: slot tab registration
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-market-insight',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useSyncExternalStore } = React;

    // ------------------------------------------------------------------------
    // 1. Constants and dictionaries
    // ------------------------------------------------------------------------

    /** Locale namespace owned by this plugin. */
    const NS = 'marketInsight';
    /** Host HTTP prefix (CONTRACT §4). */
    const API_BASE = '/dsh-market-insight/api';
    /** Page size used by the Host (`limit` 1..100, default 50). */
    const PAGE_SIZE = 50;
    /** Search keystroke debounce. */
    const SEARCH_DEBOUNCE_MS = 250;
    /** While the Host pipeline reports `loading`, re-check it at this pace. */
    const STATUS_POLL_MS = 2000;
    /** Give up polling after this many attempts; the retry button stays. */
    const STATUS_POLL_LIMIT = 20;
    /** `POST /refresh` answers before the rebuild runs: poll status this often… */
    const REFRESH_POLL_MS = 500;
    /** …and give up after this many attempts (60s). */
    const REFRESH_POLL_LIMIT = 120;
    /** Sort keys accepted by `GET /search` (CONTRACT §4.2), in menu order. */
    const SORT_OPTIONS = ['stars', 'downloads', 'added', 'name', 'index'];

    /** English copy, key-frozen by CONTRACT §5.4 (key source of truth). */
    const EN = {
      'tab.title': 'Insight',
      'header.title': 'Plugin Insight',
      'header.subtitle': 'Stars, downloads and fork families from the market catalog',
      'search.placeholder': 'Search plugins, authors, keywords…',
      'sort.label': 'Sort',
      'sort.stars': 'Most starred',
      'sort.downloads': 'Most downloaded',
      'sort.added': 'Recently added',
      'sort.name': 'Name',
      'sort.index': 'Market order',
      'group.label': 'Merge fork families',
      'group.hint': 'Group plugins from the same fork tree or repository into one row',
      'refresh': 'Refresh',
      'category.all': 'All',
      'stats': '{plugins} plugins · {families} families · {repositories} repositories',
      'stats.updated': 'Catalog {updated} · Fork data {forks}',
      'install': 'Install',
      'installed': 'Installed',
      'update': 'Update available',
      'provided': 'Provided by DSH',
      'loading': 'Loading…',
      'loadMore': 'Show more',
      'retry': 'Retry',
      'error.load': 'Could not load insights',
      'empty.noSource': 'No plugin market index configured. Open Discover to add one.',
      'empty.noMatch': 'No plugins match the current filters',
      'family.count': '{n} related',
      'family.total': '★ {stars} · ⤓ {downloads} total',
      'relation.upstream': 'Upstream',
      'relation.fork': 'Fork',
      'relation.same-repo': 'Same repo',
      'detail.back': 'Back to list',
      'detail.forkTree': 'Fork tree',
      'detail.standalone': 'No known fork family; this plugin stands alone',
      'detail.added': 'Added {date}',
      'detail.versionsCount': '{n} versions on the market',
      'detail.repo': 'Repository',
      'detail.npm': 'npm',
      'detail.installHint': 'Installs through the Plugins dialog',
      'detail.notCompatible': 'This version is not compatible with the running DSH',
      'detail.downloads': 'Downloads (30d)',
      'stars.unknown': 'Stars unknown',
      'detail.externalRoot': 'Upstream repository (not in market)',
    };

    /** Simplified Chinese copy, key-frozen by CONTRACT §5.4. */
    const ZH = {
      'tab.title': '洞察',
      'header.title': '插件洞察',
      'header.subtitle': '市场目录中的星标、下载量与 fork 家族',
      'search.placeholder': '搜索插件、作者、关键词…',
      'sort.label': '排序',
      'sort.stars': '星标最多',
      'sort.downloads': '下载最多',
      'sort.added': '最新收录',
      'sort.name': '名称',
      'sort.index': '市场顺序',
      'group.label': '合并 fork 家族',
      'group.hint': '把同一 fork 树或同一仓库的插件合并为一条',
      'refresh': '刷新',
      'category.all': '全部',
      'stats': '{plugins} 个插件 · {families} 个家族 · {repositories} 个仓库',
      'stats.updated': '目录 {updated} · Fork 数据 {forks}',
      'install': '安装',
      'installed': '已安装',
      'update': '可更新',
      'provided': 'DSH 内置',
      'loading': '加载中…',
      'loadMore': '加载更多',
      'retry': '重试',
      'error.load': '无法加载洞察数据',
      'empty.noSource': '尚未配置插件市场索引。请到 Discover 添加。',
      'empty.noMatch': '没有匹配当前筛选条件的插件',
      'family.count': '同源 {n}',
      'family.total': '★ {stars} · ⤓ {downloads} 合计',
      'relation.upstream': '上游',
      'relation.fork': 'fork',
      'relation.same-repo': '同仓库',
      'detail.back': '返回列表',
      'detail.forkTree': 'Fork 树',
      'detail.standalone': '没有已知 fork 家族，独立插件',
      'detail.added': '收录于 {date}',
      'detail.versionsCount': '市场共 {n} 个版本',
      'detail.repo': '仓库',
      'detail.npm': 'npm',
      'detail.installHint': '通过插件安装对话框安装',
      'detail.notCompatible': '该版本与当前 DSH 不兼容',
      'detail.downloads': '下载量（30 天）',
      'stars.unknown': '星标未知',
      'detail.externalRoot': '上游仓库（未收录）',
    };

    // >>> mi-pure-helpers
    // ------------------------------------------------------------------------
    // 2. Pure helpers
    //
    // Everything between the two markers is free of React, DOM and module
    // state so `test/client-helpers.test.mjs` can evaluate it in isolation.
    // ------------------------------------------------------------------------

    /** Relation ids that have a dictionary label (CONTRACT §3.2 v2). */
    const RELATION_KEYS = {
      'upstream': 'relation.upstream',
      'fork': 'relation.fork',
      'same-repo': 'relation.same-repo',
    };

    /** Family relation counters, in display order (two frozen keys, zeros included). */
    const FAMILY_RELATION_KEYS = ['fork', 'same-repo'];

    /**
     * Format a non-negative count the way the Plugins page shows numbers:
     * below a thousand verbatim, thousands as `1.2k`, millions as `1.2M`.
     * @param {unknown} value raw count.
     * @returns {string|null} compact text, or null when the count is unknown.
     */
    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
      const rounded = Math.round(value);
      if (rounded >= 999950) return trimFixed(rounded / 1000000) + 'M';
      if (rounded >= 1000) return trimFixed(rounded / 1000) + 'k';
      return String(rounded);
    }

    /** One-decimal ratio without a trailing `.0`. */
    function trimFixed(ratio) {
      const fixed = ratio >= 100 ? String(Math.round(ratio)) : ratio.toFixed(1);
      return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
    }

    /**
     * Format a count for a template placeholder, falling back to an em dash.
     * @param {unknown} value raw count.
     * @returns {string} compact text or `—`.
     */
    function formatTotalValue(value) {
      const text = formatCount(value);
      return text === null ? '—' : text;
    }

    /**
     * Keep the date part of an ISO timestamp or `YYYY-MM-DD` string.
     * @param {unknown} value raw date.
     * @returns {string|null} `YYYY-MM-DD`, or null when unparsable.
     */
    function formatDate(value) {
      if (typeof value !== 'string') return null;
      const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
      return match === null ? null : match[1];
    }

    /**
     * Only http(s) links are offered, so market data cannot smuggle in a
     * `javascript:` URL through a rendered href.
     * @param {unknown} value candidate URL.
     * @returns {boolean} whether the URL is safe to link.
     */
    function isSafeHttpUrl(value) {
      if (typeof value !== 'string' || value === '') return false;
      return /^https?:\/\//i.test(value);
    }

    /** Whether one `/search` item is a fork family (CONTRACT §3.2). */
    function isFamilyItem(item) {
      return item !== null && typeof item === 'object' && Array.isArray(item.entries);
    }

    /**
     * The dictionary key for a lineage relation, when one exists.
     * @param {unknown} relation relation id from `EntrySummary.lineage`.
     * @returns {string|null} `relation.*` key or null.
     */
    function relationLabelKey(relation) {
      if (typeof relation !== 'string') return null;
      return Object.prototype.hasOwnProperty.call(RELATION_KEYS, relation) ? RELATION_KEYS[relation] : null;
    }

    /**
     * The relation an entry carries. `GET /entry` mirrors it on the entry
     * itself (`entry.relation`) while `GET /search` keeps it in the lineage
     * object (CONTRACT §3.2 / §4.3); both are read.
     * @param {object|null} entry entry summary.
     * @returns {string|null} relation id or null.
     */
    function entryRelation(entry) {
      if (entry === null || typeof entry !== 'object') return null;
      if (typeof entry.relation === 'string' && entry.relation !== '') return entry.relation;
      const lineage = entry.lineage;
      if (lineage !== null && typeof lineage === 'object' && typeof lineage.relation === 'string' && lineage.relation !== '') return lineage.relation;
      return null;
    }

    /** Order two entries for display: more stars first, then package name. */
    function compareEntries(a, b) {
      const left = typeof a.stars === 'number' ? a.stars : -1;
      const right = typeof b.stars === 'number' ? b.stars : -1;
      if (left !== right) return right - left;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }

    /**
     * Turn a flat `entries` list into a forest using `lineage.parentName`.
     * Unknown parents become roots, self-parent links and cycles are dropped,
     * and sibling order is stable (CONTRACT §3.2 orders entries the same way).
     * @param {Array<object>} entries family entries; each may carry lineage.
     * @returns {Array<{entry: object, children: Array<object>}>} root nodes.
     */
    function buildFamilyTree(entries) {
      const list = Array.isArray(entries) ? entries.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string') : [];
      const byName = new Map();
      for (const entry of list) {
        if (!byName.has(entry.name)) byName.set(entry.name, entry);
      }
      const parents = new Map();
      for (const entry of list) {
        const parent = entry.lineage !== null && typeof entry.lineage === 'object' ? entry.lineage.parentName : null;
        if (typeof parent === 'string' && parent !== entry.name && byName.has(parent)) parents.set(entry.name, parent);
      }
      // Drop parent links that would close a cycle: a tree must terminate.
      for (const name of Array.from(parents.keys())) {
        const seen = new Set([name]);
        let cursor = parents.get(name);
        while (cursor !== undefined) {
          if (seen.has(cursor)) {
            parents.delete(name);
            break;
          }
          seen.add(cursor);
          cursor = parents.get(cursor);
        }
      }
      const childrenOf = new Map();
      const roots = [];
      for (const entry of byName.values()) {
        const parent = parents.get(entry.name);
        if (parent === undefined) {
          roots.push(entry);
          continue;
        }
        const children = childrenOf.get(parent);
        if (children === undefined) childrenOf.set(parent, [entry]);
        else children.push(entry);
      }
      roots.sort(compareEntries);
      for (const children of childrenOf.values()) children.sort(compareEntries);
      const build = (entry) => {
        const children = childrenOf.get(entry.name) ?? [];
        return { entry, children: children.map(build) };
      };
      return roots.map(build);
    }

    /**
     * The `FamilyItem.relations` counters (CONTRACT §3.2 v2): always the two
     * frozen keys, never negative. Payloads without the object fall back to
     * counting relations from the family entries (root excluded).
     * @param {object|null} familyItem family row from `GET /search`.
     * @returns {{fork: number, 'same-repo': number}} counts.
     */
    function summarizeFamilyRelations(familyItem) {
      const counts = { 'fork': 0, 'same-repo': 0 };
      if (familyItem === null || typeof familyItem !== 'object') return counts;
      const relations = familyItem.relations;
      if (relations !== null && typeof relations === 'object') {
        for (const relation of FAMILY_RELATION_KEYS) {
          const value = relations[relation];
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) counts[relation] = Math.round(value);
        }
        return counts;
      }
      if (!Array.isArray(familyItem.entries)) return counts;
      const rootName = familyItem.root !== null && typeof familyItem.root === 'object' && typeof familyItem.root.name === 'string' ? familyItem.root.name : null;
      for (const entry of familyItem.entries) {
        if (entry === null || typeof entry !== 'object') continue;
        if (rootName !== null && entry.name === rootName) continue;
        const relation = entryRelation(entry);
        if (relation !== null && Object.prototype.hasOwnProperty.call(counts, relation)) counts[relation] += 1;
      }
      return counts;
    }

    /**
     * The relation badges a family card shows: only counters above zero, in the
     * frozen order `fork / same-repo`.
     * @param {object|null} familyItem family row from `GET /search`.
     * @returns {Array<{relation: string, key: string, count: number}>} badges to render.
     */
    function familyRelationBadges(familyItem) {
      const counts = summarizeFamilyRelations(familyItem);
      const badges = [];
      for (const relation of FAMILY_RELATION_KEYS) {
        if (counts[relation] > 0) badges.push({ relation, key: RELATION_KEYS[relation], count: counts[relation] });
      }
      return badges;
    }

    /**
     * The title to show for an entry in the active language.
     * @param {object|null} entry entry summary.
     * @param {(text: unknown) => string|null} resolve locale text resolver.
     * @returns {string} localized title, or the package name as a fallback.
     */
    function entryDisplayTitle(entry, resolve) {
      if (entry === null || typeof entry !== 'object') return '';
      let title = null;
      if (typeof resolve === 'function') {
        try {
          title = resolve(entry.title);
        } catch (error) {
          title = null;
        }
      }
      if (typeof title === 'string' && title !== '') return title;
      return typeof entry.name === 'string' ? entry.name : '';
    }

    /**
     * The localized title of a category id.
     * @param {Array<{id: string, title: unknown}>} categories declared categories.
     * @param {string|null} id selected category id.
     * @param {(text: unknown) => string|null} resolve locale text resolver.
     * @returns {string} localized title, or the raw id.
     */
    function categoryTitle(categories, id, resolve) {
      if (typeof id !== 'string' || id === '') return '';
      if (Array.isArray(categories)) {
        for (const category of categories) {
          if (category !== null && typeof category === 'object' && category.id === id) {
            let title = null;
            try {
              title = typeof resolve === 'function' ? resolve(category.title) : null;
            } catch (error) {
              title = null;
            }
            if (typeof title === 'string' && title !== '') return title;
          }
        }
      }
      return id;
    }

    /**
     * Which install affordance an entry offers (CONTRACT §5.2.4).
     * @param {object|null} entry entry summary.
     * @returns {'provided'|'open'|'blocked'|'install'|'none'} action kind.
     */
    function installAction(entry) {
      if (entry === null || typeof entry !== 'object') return 'none';
      if (entry.installation === 'provided') return 'provided';
      if (entry.installation === 'installed') return 'open';
      if (entry.install === null || typeof entry.install !== 'object' || typeof entry.install.spec !== 'string') return 'none';
      if (entry.compatible !== true) return 'blocked';
      return 'install';
    }

    /**
     * Build the payload the Plugins page `install` owner action expects.
     * @param {object|null} entry entry summary.
     * @param {string} title localized title shown by the install dialog.
     * @returns {{spec: string, registry?: string, title: string, version?: string}|null}
     *   install payload, or null when the entry has no install spec.
     */
    function installPayload(entry, title) {
      if (entry === null || typeof entry !== 'object' || entry.install === null || typeof entry.install !== 'object') return null;
      const spec = entry.install.spec;
      if (typeof spec !== 'string' || spec === '') return null;
      const payload = { spec, title: typeof title === 'string' ? title : '' };
      if (typeof entry.install.registry === 'string' && entry.install.registry !== '') payload.registry = entry.install.registry;
      const version = typeof entry.install.version === 'string' ? entry.install.version : entry.version;
      if (typeof version === 'string' && version !== '') payload.version = version;
      return payload;
    }

    /**
     * Build the `/search` request path from the client query state.
     * @param {{q?: string, category?: string|null, sort?: string, group?: boolean}} query query state.
     * @param {number} offset zero-based result offset.
     * @param {number} limit page size.
     * @returns {string} absolute-path URL for `GET /search`.
     */
    function buildSearchPath(query, offset, limit) {
      const source = query !== null && typeof query === 'object' ? query : {};
      const params = [];
      const text = typeof source.q === 'string' ? source.q.trim() : '';
      if (text !== '') params.push('q=' + encodeURIComponent(text));
      if (typeof source.category === 'string' && source.category !== '') {
        params.push('category=' + encodeURIComponent(source.category));
      }
      const sort = typeof source.sort === 'string' && source.sort !== '' ? source.sort : 'stars';
      params.push('sort=' + encodeURIComponent(sort));
      params.push('group=' + (source.group === false ? '0' : '1'));
      const start = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
      const size = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
      params.push('offset=' + String(start));
      params.push('limit=' + String(size));
      return '/search?' + params.join('&');
    }

    /**
     * Read the counters the status line and toolbar show.
     * @param {object|null} status `GET /status` value.
     * @returns {{plugins: number|null, families: number|null, repositories: number|null,
     *   updated: string|null, forks: number|null, state: string|null}} counters.
     */
    function summarizeStatus(status) {
      const value = status !== null && typeof status === 'object' ? status : {};
      const totals = value.totals !== null && typeof value.totals === 'object' ? value.totals : {};
      const forks = value.forks !== null && typeof value.forks === 'object' ? value.forks : {};
      const catalog = value.catalog !== null && typeof value.catalog === 'object' ? value.catalog : {};
      const count = (candidate) => (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? Math.round(candidate) : null);
      return {
        state: typeof value.state === 'string' ? value.state : null,
        plugins: count(totals.plugins),
        families: count(totals.families),
        repositories: count(forks.repositories),
        updated: formatDate(catalog.updated),
        forks: count(forks.forks),
      };
    }

    /**
     * A locale text resolver: strings pass through, `{en, zh, ...}` text maps
     * go through the locale service's fallback chain, and anything unusual
     * degrades to the English value instead of throwing into render.
     * @param {{resolveText?: (text: object) => string|null}} locale locale service.
     * @returns {(text: unknown) => string|null} resolver.
     */
    function createTextResolver(locale) {
      return (text) => {
        if (text === null || text === undefined) return null;
        if (typeof text === 'string') return text;
        if (typeof text !== 'object') return null;
        if (locale !== null && typeof locale === 'object' && typeof locale.resolveText === 'function') {
          try {
            const resolved = locale.resolveText(text);
            if (typeof resolved === 'string' && resolved !== '') return resolved;
          } catch (error) {
            // Fall through to the English value below.
          }
        }
        if (typeof text.en === 'string' && text.en !== '') return text.en;
        return null;
      };
    }

    /**
     * A human-readable message from a thrown value or `{code, message}` error.
     * @param {unknown} error thrown value.
     * @returns {string|null} message text, or null when empty.
     */
    function errorMessage(error) {
      if (error !== null && typeof error === 'object') {
        if (typeof error.message === 'string' && error.message !== '') return error.message;
        if (typeof error.code === 'string' && error.code !== '') return error.code;
      }
      if (typeof error === 'string' && error !== '') return error;
      return null;
    }

    /**
     * A finite number or the given fallback.
     * @param {unknown} value raw value.
     * @param {number} fallback value to use when unparsable.
     * @returns {number} parsed number or fallback.
     */
    function numberOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }
    // <<< mi-pure-helpers

    // ------------------------------------------------------------------------
    // 3. Runtime wiring and HTTP controller
    // ------------------------------------------------------------------------

    /**
     * Shared runtime handles. `apply` fills them before the slot can render;
     * components are defined in this factory scope and read them on render.
     */
    const runtime = {
      /** @type {InsightController|null} */
      controller: null,
      /** @type {((key: string, params?: object) => string)|null} */
      t: null,
      /** @type {((text: unknown) => string|null)|null} */
      resolveText: null,
    };

    /** An error carrying the Host's `{code, message}` failure shape. */
    class ApiError extends Error {
      constructor(code, message) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
      }
    }

    /**
     * Wait `ms` milliseconds, resolving early when `signal` aborts so a
     * disposal never leaves a timer behind.
     * @param {number} ms delay.
     * @param {AbortSignal|undefined} signal abort fence.
     * @returns {Promise<void>} settles on timeout or abort.
     */
    function delay(ms, signal) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal !== undefined) signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        if (signal !== undefined) {
          if (signal.aborted) finish();
          else signal.addEventListener('abort', finish);
        }
      });
    }

    /**
     * Read one Host API response. The Host envelope is
     * `{ok: true, value}` / `{ok: false, error: {code, message}}` (CONTRACT §4).
     * @param {string} path absolute path such as `/status`.
     * @param {{method?: string, signal?: AbortSignal}} [options] request options.
     * @returns {Promise<any>} the `value` of a successful response.
     */
    async function requestJson(path, options) {
      const settings = options === undefined ? {} : options;
      let method = 'GET';
      if (typeof settings.method === 'string' && settings.method !== '') method = settings.method;
      const headers = method === 'POST' ? { 'x-market-insight': '1' } : undefined;
      let response;
      try {
        response = await fetch(API_BASE + path, {
          method,
          headers,
          signal: settings.signal,
          credentials: 'same-origin',
        });
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.name === 'AbortError') throw error;
        throw new ApiError('network-error', errorMessage(error) ?? 'network error');
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        if (response.ok) throw new ApiError('invalid-response', 'Response is not JSON');
      }
      if (!response.ok || payload === null || typeof payload !== 'object' || payload.ok !== true) {
        const failure = payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object' ? payload.error : null;
        const code = failure !== null && typeof failure.code === 'string' ? failure.code : 'http-' + String(response.status);
        const message = failure !== null && typeof failure.message === 'string' ? failure.message : 'HTTP ' + String(response.status);
        throw new ApiError(code, message);
      }
      return payload.value;
    }

    /**
     * Client-side state for the Insight tab: one immutable snapshot per change,
     * published through `useSyncExternalStore`. Every remote read owns an
     * AbortController plus a sequence number, so a superseded response can
     * never overwrite a newer one.
     */
    class InsightController {
      constructor() {
        this.state = createInitialState();
        this.listeners = new Set();
        this.sequence = { status: 0, search: 0, more: 0, detail: 0, refresh: 0 };
        this.pending = { status: null, search: null, more: null, detail: null, refresh: null };
        this.statusPollTimer = null;
        this.statusPollCount = 0;
        this.started = false;
        this.disposed = false;
        /** Stable subscription pair for `useSyncExternalStore`. */
        this.subscribe = (listener) => {
          this.listeners.add(listener);
          return () => {
            this.listeners.delete(listener);
          };
        };
        /** Stable snapshot getter for `useSyncExternalStore`. */
        this.getSnapshot = () => this.state;
      }

      /** Publish a partial state patch. */
      patch(partial) {
        if (this.disposed) return;
        this.state = Object.assign({}, this.state, partial);
        for (const listener of this.listeners) listener();
      }

      /** Start the first load once the tab is actually mounted. */
      ensureLoaded() {
        if (this.started || this.disposed) return;
        this.started = true;
        this.loadStatus();
      }

      /** Stop everything on unmount. */
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.clearStatusPoll();
        for (const kind of Object.keys(this.pending)) this.cancelRead(kind);
        this.listeners.clear();
      }

      // -- read plumbing -----------------------------------------------------

      /** Invalidate a read and abort its request. */
      cancelRead(kind) {
        const previous = this.pending[kind];
        if (previous !== null) {
          this.pending[kind] = null;
          try {
            previous.abort();
          } catch (error) {
            // Already settled; nothing to abort.
          }
        }
        this.sequence[kind] += 1;
      }

      /** Begin a read: cancel the previous one of the same kind and bump its fence. */
      beginRead(kind) {
        this.cancelRead(kind);
        const controller = new AbortController();
        this.pending[kind] = controller;
        return { kind, sequence: this.sequence[kind], controller, signal: controller.signal };
      }

      /** Whether a read is still the newest one of its kind. */
      isCurrent(read) {
        return !this.disposed && this.sequence[read.kind] === read.sequence;
      }

      /** Release the request slot once settled. */
      finishRead(read) {
        if (this.pending[read.kind] === read.controller) this.pending[read.kind] = null;
      }

      // -- status ------------------------------------------------------------

      /** Read the Host pipeline state and follow it until it is ready. */
      async loadStatus() {
        const read = this.beginRead('status');
        this.patch({ statusState: 'loading', statusError: null });
        try {
          const status = await requestJson('/status', { signal: read.signal });
          if (!this.isCurrent(read)) return;
          this.statusPollCount = 0;
          this.patch({ status, statusState: 'ready', statusError: null });
          if (status === null || status.state === 'loading') {
            this.scheduleStatusPoll();
            return;
          }
          if (status.state === 'empty') return;
          if (status.state === 'error') {
            this.patch({ listState: 'error', listError: errorMessage(status.error) });
            return;
          }
          this.loadFirstPage();
        } catch (error) {
          if (!this.isCurrent(read)) return;
          this.patch({ statusState: 'error', statusError: errorMessage(error) });
        } finally {
          this.finishRead(read);
        }
      }

      /** Re-check a still-loading pipeline a bounded number of times. */
      scheduleStatusPoll() {
        this.clearStatusPoll();
        if (this.disposed || this.statusPollCount >= STATUS_POLL_LIMIT) return;
        this.statusPollCount += 1;
        this.statusPollTimer = setTimeout(() => {
          this.statusPollTimer = null;
          if (this.disposed) return;
          const status = this.state.status;
          if (status !== null && status.state === 'loading') this.loadStatus();
        }, STATUS_POLL_MS);
      }

      /** Stop the pipeline poll timer. */
      clearStatusPoll() {
        if (this.statusPollTimer !== null) {
          clearTimeout(this.statusPollTimer);
          this.statusPollTimer = null;
        }
      }

      /** Retry the status read (error block and refresh path). */
      retryStatus() {
        this.statusPollCount = 0;
        this.loadStatus();
      }

      // -- listing -----------------------------------------------------------

      /** Replace the shown results with the first page of the current query. */
      loadFirstPage() {
        this.cancelRead('more');
        this.patch({ moreState: 'idle', moreError: null });
        this.loadSearch();
      }

      /** Fetch the first page of `state.query`. */
      async loadSearch() {
        const read = this.beginRead('search');
        this.patch({ listState: 'loading', listError: null });
        try {
          const value = await requestJson(buildSearchPath(this.state.query, 0, PAGE_SIZE), { signal: read.signal });
          if (!this.isCurrent(read)) return;
          this.patch({
            items: Array.isArray(value.items) ? value.items : [],
            total: numberOr(value.total, 0),
            matched: numberOr(value.matched, 0),
            categories: Array.isArray(value.categories) ? value.categories : [],
            nextOffset: value.nextOffset === null || value.nextOffset === undefined ? null : value.nextOffset,
            generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : null,
            listState: 'ready',
            listError: null,
          });
        } catch (error) {
          if (!this.isCurrent(read)) return;
          this.patch({ listState: 'error', listError: errorMessage(error) });
        } finally {
          this.finishRead(read);
        }
      }

      /** Fetch the page after the shown results. */
      async loadMore() {
        const detail = this.state;
        if (detail.listState !== 'ready' || detail.moreState === 'loading' || detail.nextOffset === null) return;
        const read = this.beginRead('more');
        this.patch({ moreState: 'loading', moreError: null });
        try {
          const value = await requestJson(buildSearchPath(detail.query, detail.nextOffset, PAGE_SIZE), { signal: read.signal });
          if (!this.isCurrent(read)) return;
          this.patch({
            items: this.state.items.concat(Array.isArray(value.items) ? value.items : []),
            total: numberOr(value.total, this.state.total),
            matched: numberOr(value.matched, this.state.matched),
            categories: Array.isArray(value.categories) ? value.categories : this.state.categories,
            nextOffset: value.nextOffset === null || value.nextOffset === undefined ? null : value.nextOffset,
            generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : this.state.generatedAt,
            moreState: 'idle',
            moreError: null,
          });
        } catch (error) {
          if (!this.isCurrent(read)) return;
          this.patch({ moreState: 'error', moreError: errorMessage(error) });
        } finally {
          this.finishRead(read);
        }
      }

      /** Swap the whole query (text, category, sort, grouping) and reload. */
      setQuery(partial) {
        if (this.disposed) return;
        const current = this.state.query;
        const next = {
          q: typeof partial.q === 'string' ? partial.q : current.q,
          category: Object.prototype.hasOwnProperty.call(partial, 'category') ? partial.category : current.category,
          sort: typeof partial.sort === 'string' ? partial.sort : current.sort,
          group: typeof partial.group === 'boolean' ? partial.group : current.group,
        };
        if (typeof next.q !== 'string') next.q = '';
        if (next.category !== null && typeof next.category !== 'string') next.category = null;
        if (SORT_OPTIONS.indexOf(next.sort) === -1) next.sort = 'stars';
        if (current.q === next.q && current.category === next.category && current.sort === next.sort && current.group === next.group) return;
        this.patch({ query: next });
        this.loadFirstPage();
      }

      /** Retry the failed listing read. */
      retrySearch() {
        this.loadSearch();
      }

      /** Expand or collapse one fork family row. */
      toggleFamily(familyId) {
        if (typeof familyId !== 'string' || familyId === '') return;
        const expanded = new Map(this.state.expandedFamilies);
        if (expanded.get(familyId) === true) expanded.delete(familyId);
        else expanded.set(familyId, true);
        this.patch({ expandedFamilies: expanded });
      }

      // -- detail ------------------------------------------------------------

      /** Open one plugin detail view (list state is kept behind it). */
      openDetail(name) {
        if (typeof name !== 'string' || name === '') return;
        const open = this.state.detail;
        if (open !== null && open.name === name && open.status !== 'error') return;
        this.loadDetail(name);
      }

      /** Fetch `GET /entry` for one package name. */
      async loadDetail(name) {
        const read = this.beginRead('detail');
        this.patch({ detail: { name, status: 'loading', entry: null, family: null, versions: null, error: null } });
        try {
          const value = await requestJson('/entry?name=' + encodeURIComponent(name), { signal: read.signal });
          if (!this.isCurrent(read)) return;
          this.patch({
            detail: {
              name,
              status: 'ready',
              entry: value.entry === undefined ? null : value.entry,
              family: value.family === undefined ? null : value.family,
              versions: Array.isArray(value.versions) ? value.versions : [],
              error: null,
            },
          });
        } catch (error) {
          if (!this.isCurrent(read)) return;
          this.patch({ detail: { name, status: 'error', entry: null, family: null, versions: null, error: errorMessage(error) } });
        } finally {
          this.finishRead(read);
        }
      }

      /** Retry the failed detail read. */
      retryDetail() {
        const detail = this.state.detail;
        if (detail !== null) this.loadDetail(detail.name);
      }

      /** Close the detail view; the list, filters and expansions stay. */
      closeDetail() {
        this.cancelRead('detail');
        this.patch({ detail: null });
      }

      // -- refresh -----------------------------------------------------------

      /**
       * Rebuild the Host pipeline, then reload status and results.
       *
       * `POST /refresh` starts the rebuild and answers before it finished, so
       * the client polls `/status` until the Host clears `refreshing`; only
       * then does a reload see the new data.
       */
      async refresh() {
        if (this.disposed || this.state.refreshing) return;
        const read = this.beginRead('refresh');
        this.patch({ refreshing: true, refreshError: null });
        try {
          await requestJson('/refresh', { method: 'POST', signal: read.signal });
          if (!this.isCurrent(read)) return;
          await this.waitForRefresh(read);
          if (!this.isCurrent(read)) return;
          this.patch({ refreshing: false });
          this.loadStatus();
        } catch (error) {
          if (!this.isCurrent(read)) return;
          this.patch({ refreshing: false, refreshError: errorMessage(error) });
        } finally {
          this.finishRead(read);
        }
      }

      /**
       * Poll `/status` until the Host finished the started rebuild.
       * @param {object} read the refresh read fence.
       * @returns {Promise<boolean>} whether the rebuild settled before the limit.
       */
      async waitForRefresh(read) {
        for (let attempt = 0; attempt < REFRESH_POLL_LIMIT; attempt += 1) {
          await delay(REFRESH_POLL_MS, read.signal);
          if (!this.isCurrent(read)) return false;
          const status = await requestJson('/status', { signal: read.signal });
          if (!this.isCurrent(read)) return false;
          // Surface progress while the toolbar spinner stays on.
          this.patch({ status, statusState: 'ready', statusError: null });
          if (status === null || status.refreshing !== true) return true;
        }
        return false;
      }
    }

    /** The untouched client state. */
    function createInitialState() {
      return {
        // Host pipeline status (`GET /status`).
        status: null,
        statusState: 'idle',
        statusError: null,
        // Current listing (CONTRACT §4.2).
        query: { q: '', category: null, sort: 'stars', group: true },
        items: [],
        total: 0,
        matched: 0,
        categories: [],
        nextOffset: null,
        generatedAt: null,
        listState: 'idle',
        listError: null,
        moreState: 'idle',
        moreError: null,
        // Open detail (`GET /entry`).
        detail: null,
        // Family expansion: familyId -> true.
        expandedFamilies: new Map(),
        // Refresh action.
        refreshing: false,
        refreshError: null,
      };
    }

    // ------------------------------------------------------------------------
    // 4. Stylesheet — only CONTRACT §5.3 theme tokens, so light/dark follow.
    // ------------------------------------------------------------------------

    const CSS = [
      '.mi-root{display:flex;flex-direction:column;gap:12px;padding:4px 0 32px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.mi-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mi-toolbar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 16px;padding:10px 0 12px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mi-heading{display:flex;flex:1 1 240px;flex-direction:column;gap:2px;min-width:0}',
      '.mi-title{margin:0;font-size:16px;font-weight:600;line-height:24px}',
      '.mi-subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mi-heading-meta{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.mi-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.mi-search{position:relative;display:inline-flex;align-items:center}',
      '.mi-input{width:230px;height:32px;padding:0 28px 0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
      '.mi-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.mi-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mi-clear{position:absolute;right:5px;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}',
      '.mi-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.mi-select{height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;outline:none}',
      '.mi-select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mi-switch{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
      '.mi-switch:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mi-switch[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.mi-switch-track{position:relative;flex:none;width:28px;height:16px;border-radius:8px;background:var(--dsw-alias-state-idle-primary);transition:background .15s ease}',
      '.mi-switch[aria-checked="true"] .mi-switch-track{background:var(--dsw-alias-brand-primary)}',
      '.mi-switch-thumb{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}',
      '.mi-switch[aria-checked="true"] .mi-switch-thumb{transform:translateX(12px)}',
      '.mi-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:20px;padding:0 7px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.mi-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:1px solid transparent;border-radius:8px;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer}',
      '.mi-button:disabled{opacity:.55;cursor:not-allowed}',
      '.mi-button-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.mi-button-primary:hover:not(:disabled){opacity:.9}',
      '.mi-button-secondary{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      '.mi-button-secondary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.mi-button-muted{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.mi-button-lg{height:34px;padding:0 16px;font-size:13px}',
      '.mi-button-sm{height:24px;padding:0 10px;font-size:11px}',
      '.mi-button:focus-visible,.mi-select:focus-visible,.mi-input:focus-visible,.mi-pill:focus-visible,.mi-switch:focus-visible,.mi-card-title:focus-visible,.mi-tree-title:focus-visible,.mi-back:focus-visible,.mi-clear:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.mi-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:mi-rotate .8s linear infinite}',
      '@keyframes mi-rotate{to{transform:rotate(360deg)}}',
      '.mi-pills{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}',
      '.mi-pill{flex:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;cursor:pointer}',
      '.mi-pill:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mi-pill[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '.mi-status-line{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mi-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
      '.mi-card{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.mi-card:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mi-avatar{display:inline-flex;flex:none;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-size:15px;font-weight:600;text-transform:uppercase}',
      '.mi-card-main{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}',
      '.mi-card-title-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}',
      '.mi-card-title{padding:0;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:600;line-height:20px;text-align:left;overflow-wrap:anywhere;cursor:pointer}',
      '.mi-card-title:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.mi-card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mi-relations{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}',
      '.mi-card-actions{display:flex;flex:none;align-items:center;gap:6px;padding-top:2px}',
      '.mi-meta{display:inline-flex;align-items:center;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
      '.mi-star{color:var(--dsw-alias-state-warn-primary)}',
      '.mi-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;white-space:nowrap}',
      '.mi-chip-brand{color:var(--dsw-alias-brand-primary)}',
      '.mi-chip-success{color:var(--dsw-alias-state-success-primary)}',
      '.mi-chip-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mi-chip-error{color:var(--dsw-alias-state-error-primary)}',
      '.mi-repo-link{display:inline-flex;align-items:center;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;text-decoration:none}',
      '.mi-repo-link:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.mi-family{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.mi-family>.mi-card{border:0;border-radius:0;background:transparent}',
      '.mi-family>.mi-card:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mi-family-toggle{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;padding:0;border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.mi-family-toggle:hover{text-decoration:underline}',
      '.mi-family-arrow{font-size:10px;line-height:1}',
      '.mi-family-total{display:flex;flex-wrap:wrap;gap:4px 12px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mi-tree{display:flex;flex-direction:column;gap:2px;padding:2px 12px 8px}',
      '.mi-tree-detail{padding:8px 0 0}',
      '.mi-tree-children{display:flex;flex-direction:column;gap:2px;margin-left:16px;padding-left:12px;border-left:1px solid var(--dsw-alias-border-l1)}',
      '.mi-tree-row{position:relative;display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;min-width:0;cursor:pointer}',
      '.mi-tree-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mi-tree-children>.mi-tree-node>.mi-tree-row::before{content:"";position:absolute;left:-13px;top:50%;width:12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.mi-tree-title{padding:0;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;overflow-wrap:anywhere;cursor:pointer}',
      '.mi-tree-title:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.mi-tree-title-static{color:var(--dsw-alias-label-primary);font-size:13px;overflow-wrap:anywhere}',
      '.mi-tree-stars{flex:none}',
      '.mi-tree-action{margin-left:auto;flex:none}',
      '.mi-node-current{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}',
      '.mi-external-root{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px}',
      '.mi-external-hint{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.mi-skeleton-card{cursor:default}',
      '.mi-skeleton{background:var(--dsw-alias-bg-layer-2);border-radius:6px;animation:mi-pulse 1.4s ease-in-out infinite}',
      '.mi-skeleton-icon{width:36px;height:36px;border-radius:50%;flex:none}',
      '.mi-skeleton-line{height:12px;border-radius:6px}',
      '.mi-skeleton-title{width:45%;height:14px}',
      '.mi-skeleton-meta{width:65%}',
      '.mi-skeleton-actions{width:64px;height:28px;flex:none}',
      '@keyframes mi-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
      '.mi-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 16px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;text-align:center;color:var(--dsw-alias-label-secondary)}',
      '.mi-empty-title{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}',
      '.mi-empty-hint{margin:0;font-size:12px;line-height:18px}',
      '.mi-error{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}',
      '.mi-error-detail{max-width:100%;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}',
      '.mi-more{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:4px 0}',
      '.mi-detail{display:flex;flex-direction:column;gap:14px}',
      '.mi-back{align-self:flex-start;padding:0;border:0;background:none;color:var(--dsw-alias-brand-primary);font-size:13px;cursor:pointer}',
      '.mi-back:hover{text-decoration:underline}',
      '.mi-detail-head{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.mi-detail-title{margin:0;font-size:20px;font-weight:600;line-height:28px;overflow-wrap:anywhere}',
      '.mi-detail-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mi-links{display:flex;flex-wrap:wrap;align-items:center;gap:12px}',
      '.mi-description{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.mi-detail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}',
      '.mi-detail-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mi-warning{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}',
      '.mi-section{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.mi-section-title{margin:0;font-size:13px;font-weight:600;line-height:20px}',
      '.mi-facts{display:flex;flex-direction:column;gap:6px}',
      '.mi-fact{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;line-height:18px}',
      '.mi-fact-label{flex:none;min-width:78px;color:var(--dsw-alias-label-secondary)}',
      '.mi-fact-value{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.mi-fact-value a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.mi-fact-value a:hover{text-decoration:underline}',
      '.mi-fact-link{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.mi-fact-link:hover{text-decoration:underline}',
    ].join('\n');

    // ------------------------------------------------------------------------
    // 5. Presentational components
    // ------------------------------------------------------------------------

    /** Inject the tab stylesheet through React (no imperative DOM writes). */
    function Stylesheet() {
      return h('style', { 'data-market-insight': '' }, CSS);
    }

    /** Circular fallback avatar: the first letter of the localized title. */
    function Avatar({ entry, resolve }) {
      const title = entryDisplayTitle(entry, resolve);
      const letter = title === '' ? '?' : Array.from(title)[0].toUpperCase();
      return h('span', { className: 'mi-avatar', 'aria-hidden': 'true' }, letter);
    }

    /** A neutral pill; `tone` picks one of the allowed state colors. */
    function Chip({ children, tone, title }) {
      let className = 'mi-chip';
      if (tone === 'brand') className += ' mi-chip-brand';
      else if (tone === 'success') className += ' mi-chip-success';
      else if (tone === 'warn') className += ' mi-chip-warn';
      else if (tone === 'error') className += ' mi-chip-error';
      return h('span', { className, title }, children);
    }

    /** Installation state as a badge (list cards). */
    function InstallationChip({ entry, t }) {
      if (entry.installation === 'installed') return h(Chip, { tone: 'success' }, t('installed'));
      if (entry.installation === 'update-available') return h(Chip, { tone: 'warn' }, t('update'));
      if (entry.installation === 'provided') return h(Chip, { tone: 'muted' }, t('provided'));
      if (entry.installation === 'different-version') return h(Chip, { tone: 'muted' }, t('installed'));
      return null;
    }

    /** Star count badge; unknown data is a muted caption, never a zero. */
    function StarBadge({ entry, t, className }) {
      if (entry.stars === null || entry.stars === undefined) {
        return h('span', { className: 'mi-meta' }, t('stars.unknown'));
      }
      const count = formatCount(entry.stars);
      if (count === null) return h('span', { className: 'mi-meta' }, t('stars.unknown'));
      return h('span', { className: className === undefined ? 'mi-meta mi-star' : className }, '★ ' + count);
    }

    /** Download count badge; omitted entirely when the catalog has no data. */
    function DownloadBadge({ entry }) {
      if (entry.downloads === null || entry.downloads === undefined) return null;
      const count = formatCount(entry.downloads);
      if (count === null) return null;
      return h('span', { className: 'mi-meta' }, '⤓ ' + count);
    }

    /** One external link that only renders for safe http(s) URLs. */
    function ExternalLink({ url, children, className, label }) {
      if (!isSafeHttpUrl(url)) return null;
      const title = typeof label === 'string' && label !== '' ? label : undefined;
      return h(
        'a',
        {
          className: className === undefined ? 'mi-repo-link' : className,
          href: url,
          target: '_blank',
          rel: 'noreferrer noopener',
          title,
          'aria-label': title,
        },
        children,
      );
    }

    /** Category / version / stars / downloads / repo line shared by the cards. */
    function MetaRow({ entry, t, resolve, categories }) {
      const category = categoryTitle(categories, entry.category, resolve);
      const repoUrl = entry.repo !== null && typeof entry.repo === 'object' ? entry.repo.url : null;
      const npmUrl = typeof entry.npm === 'string' && entry.npm !== '' ? 'https://www.npmjs.com/package/' + entry.npm : null;
      return h(
        'div',
        { className: 'mi-card-meta' },
        category === '' ? null : h(Chip, { tone: 'brand' }, category),
        typeof entry.version === 'string' && entry.version !== '' ? h(Chip, null, 'v' + entry.version) : null,
        h(StarBadge, { entry, t }),
        h(DownloadBadge, { entry }),
        h(ExternalLink, { url: repoUrl, label: t('detail.repo') }, '↗'),
        h(ExternalLink, { url: npmUrl, label: t('detail.npm') }, t('detail.npm')),
      );
    }

    /** Install affordance driven by CONTRACT §5.2.4 and the owner props. */
    function InstallControl({ entry, t, resolve, install, openPackage, large }) {
      const action = installAction(entry);
      const sizeClass = large === true ? ' mi-button-lg' : '';
      if (action === 'provided') {
        return h('button', { type: 'button', className: 'mi-button mi-button-muted' + sizeClass, disabled: true }, t('provided'));
      }
      if (action === 'open') {
        const open = () => {
          if (typeof openPackage === 'function') openPackage(entry.name);
        };
        return h('button', { type: 'button', className: 'mi-button mi-button-secondary' + sizeClass, onClick: open }, t('installed'));
      }
      if (action === 'blocked') {
        return h('button', { type: 'button', className: 'mi-button mi-button-secondary' + sizeClass, disabled: true }, t('install'));
      }
      if (action !== 'install' || typeof install !== 'function') return null;
      const payload = installPayload(entry, entryDisplayTitle(entry, resolve));
      if (payload === null) return null;
      const run = () => install(payload);
      return h('button', { type: 'button', className: 'mi-button mi-button-primary' + sizeClass, onClick: run }, t('install'));
    }

    /** Relation badge used inside fork trees. */
    function RelationChip({ relation, t, fallbackKey }) {
      const key = relationLabelKey(relation) ?? (typeof fallbackKey === 'string' ? fallbackKey : null);
      if (key === null) return null;
      return h(Chip, { tone: 'muted' }, t(key));
    }

    /** One flat plugin card (group=0 rows and lone family roots). */
    function EntryCard({ entry, t, resolve, categories, install, openPackage, openDetail }) {
      const open = () => openDetail(entry.name);
      return h(
        'li',
        { className: 'mi-card' },
        h(Avatar, { entry, resolve }),
        h(
          'div',
          { className: 'mi-card-main' },
          h(
            'div',
            { className: 'mi-card-title-row' },
            h('button', { type: 'button', className: 'mi-card-title', onClick: open }, entryDisplayTitle(entry, resolve)),
            h(InstallationChip, { entry, t }),
          ),
          h(MetaRow, { entry, t, resolve, categories }),
        ),
        h('div', { className: 'mi-card-actions' }, h(InstallControl, { entry, t, resolve, install, openPackage })),
      );
    }

    /**
     * Recursively render one fork-tree node and its descendants.
     * @returns {object} React element.
     */
    function renderTreeNode(node, depth, context) {
      const entry = node.entry;
      const current = entry.name === context.currentName;
      const rowClass = 'mi-tree-row' + (depth > 0 ? ' mi-tree-row-child' : '') + (current ? ' mi-node-current' : '');
      const open = () => context.openDetail(entry.name);
      return h(
        'div',
        { key: entry.name, className: 'mi-tree-node' },
        h(
          'div',
          { className: rowClass, onClick: open },
          h(RelationChip, { relation: entryRelation(entry), t: context.t, fallbackKey: depth === 0 ? 'relation.upstream' : null }),
          h('button', { type: 'button', className: 'mi-tree-title', onClick: open }, entryDisplayTitle(entry, context.resolve)),
          h(StarBadge, { entry, t: context.t, className: 'mi-meta mi-star mi-tree-stars' }),
          h(
            'span',
            { className: 'mi-tree-action', onClick: (event) => event.stopPropagation() },
            h(InstallControl, { entry, t: context.t, resolve: context.resolve, install: context.install, openPackage: context.openPackage }),
          ),
        ),
        node.children.length === 0
          ? null
          : h('div', { className: 'mi-tree-children' }, node.children.map((child) => renderTreeNode(child, depth + 1, context))),
      );
    }

    /**
     * A grouped fork-family card: root row plus, when expanded, the indented
     * fork tree and the family totals.
     */
    function FamilyCard({ item, t, resolve, categories, expanded, onToggle, install, openPackage, openDetail }) {
      const root = item.root;
      const entries = Array.isArray(item.entries) ? item.entries : [root];
      const forest = buildFamilyTree(entries);
      let rootNode = null;
      for (const node of forest) {
        if (node.entry.name === root.name) {
          rootNode = node;
          break;
        }
      }
      if (rootNode === null && forest.length > 0) rootNode = forest[0];
      const extraRoots = forest.filter((node) => node !== rootNode);
      const hasMembers = entries.length > 1;
      const relationBadges = familyRelationBadges(item);
      const context = { t, resolve, install, openPackage, openDetail, currentName: null };
      const openRoot = () => openDetail(root.name);
      return h(
        'li',
        { className: 'mi-family' },
        h(
          'div',
          { className: 'mi-card' },
          h(Avatar, { entry: root, resolve }),
          h(
            'div',
            { className: 'mi-card-main' },
            h(
              'div',
              { className: 'mi-card-title-row' },
              h('button', { type: 'button', className: 'mi-card-title', onClick: openRoot }, entryDisplayTitle(root, resolve)),
              h(InstallationChip, { entry: root, t }),
              item.externalRoot !== null && item.externalRoot !== undefined ? h(Chip, { tone: 'brand' }, t('relation.upstream')) : null,
            ),
            h(MetaRow, { entry: root, t, resolve, categories }),
            relationBadges.length === 0
              ? null
              : h(
                  'div',
                  { className: 'mi-relations' },
                  relationBadges.map((badge) => h(Chip, { key: badge.relation, tone: 'muted' }, t(badge.key) + ' ' + String(badge.count))),
                ),
            hasMembers
              ? h(
                  'button',
                  { type: 'button', className: 'mi-family-toggle', 'aria-expanded': expanded === true, onClick: onToggle },
                  h('span', { className: 'mi-family-arrow', 'aria-hidden': 'true' }, expanded === true ? '▾' : '▸'),
                  t('family.count', { n: String(entries.length) }),
                )
              : null,
          ),
          h('div', { className: 'mi-card-actions' }, h(InstallControl, { entry: root, t, resolve, install, openPackage })),
        ),
        expanded === true && rootNode !== null
          ? h('div', { className: 'mi-tree' }, rootNode.children.map((child) => renderTreeNode(child, 1, context)))
          : null,
        expanded === true && extraRoots.length > 0
          ? h('div', { className: 'mi-tree' }, extraRoots.map((node) => renderTreeNode(node, 1, context)))
          : null,
        hasMembers || (item.externalRoot !== null && item.externalRoot !== undefined)
          ? h(
              'div',
              { className: 'mi-family-total' },
              item.externalRoot !== null && item.externalRoot !== undefined
                ? h('span', { className: 'mi-meta' }, t('relation.upstream') + ': ' + item.externalRoot.fullName)
                : null,
              h('span', { className: 'mi-meta' }, t('family.total', { stars: formatTotalValue(item.totalStars), downloads: formatTotalValue(item.totalDownloads) })),
            )
          : null,
      );
    }

    /** The fork tree block of the detail view. */
    function ForkTree({ family, entryName, t, resolve, install, openPackage, openDetail }) {
      if (family === null || typeof family !== 'object') {
        return h('p', { className: 'mi-muted' }, t('detail.standalone'));
      }
      const entries = Array.isArray(family.entries) ? family.entries : [];
      const externalRoot = family.externalRoot !== null && family.externalRoot !== undefined ? family.externalRoot : null;
      if (externalRoot === null && entries.length <= 1) {
        return h('p', { className: 'mi-muted' }, t('detail.standalone'));
      }
      const forest = buildFamilyTree(entries);
      const context = { t, resolve, install, openPackage, openDetail, currentName: entryName };
      return h(
        'div',
        { className: 'mi-tree mi-tree-detail' },
        externalRoot === null
          ? null
          : h(
              'div',
              { className: 'mi-external-root' },
              h(Chip, { tone: 'muted' }, t('relation.upstream')),
              h('span', { className: 'mi-tree-title-static' }, externalRoot.fullName),
              h(ExternalLink, { url: externalRoot.url, label: t('detail.repo') }, '↗ ' + t('detail.repo')),
              h('span', { className: 'mi-external-hint' }, t('detail.externalRoot')),
            ),
        forest.map((node) => renderTreeNode(node, 0, context)),
      );
    }

    /** Placeholder rows shown while the first page (or the status) loads. */
    function SkeletonList({ t, rows }) {
      const count = typeof rows === 'number' && rows > 0 ? rows : 5;
      const items = [];
      for (let index = 0; index < count; index += 1) {
        items.push(
          h(
            'li',
            { key: index, className: 'mi-card mi-skeleton-card', 'aria-hidden': 'true' },
            h('span', { className: 'mi-skeleton mi-skeleton-icon' }),
            h(
              'div',
              { className: 'mi-card-main' },
              h('span', { className: 'mi-skeleton mi-skeleton-line mi-skeleton-title' }),
              h('span', { className: 'mi-skeleton mi-skeleton-line mi-skeleton-meta' }),
            ),
            h('span', { className: 'mi-skeleton mi-skeleton-actions' }),
          ),
        );
      }
      return h('ul', { className: 'mi-list', role: 'status', 'aria-busy': 'true', 'aria-label': t('loading') }, items);
    }

    /** Error row with the Retry action. */
    function ErrorBlock({ t, message, onRetry }) {
      return h(
        'div',
        { className: 'mi-error', role: 'alert' },
        h('span', null, t('error.load')),
        typeof message === 'string' && message !== '' ? h('span', { className: 'mi-error-detail' }, message) : null,
        typeof onRetry === 'function' ? h('button', { type: 'button', className: 'mi-button mi-button-secondary mi-button-sm', onClick: onRetry }, t('retry')) : null,
      );
    }

    /** Empty state: no market source configured, or no match for filters. */
    function EmptyPanel({ title, hint }) {
      return h(
        'div',
        { className: 'mi-empty', role: 'status' },
        h('p', { className: 'mi-empty-title' }, title),
        typeof hint === 'string' && hint !== '' ? h('p', { className: 'mi-empty-hint' }, hint) : null,
      );
    }

    /** The sticky toolbar: heading, search, sort, grouping switch and refresh. */
    function Toolbar({ t, resolve, snapshot, searchText, onSearchChange, onClear, onSortChange, onGroupToggle, onRefresh }) {
      const status = snapshot.status;
      const summary = summarizeStatus(status);
      const sourceTitle = status !== null && status.source !== null && status.source !== undefined ? resolve(status.source.title) : null;
      const metaParts = [];
      if (typeof sourceTitle === 'string' && sourceTitle !== '') metaParts.push(sourceTitle);
      if (summary.updated !== null) {
        metaParts.push(t('stats.updated', { updated: summary.updated, forks: summary.forks === null ? '—' : String(summary.forks) }));
      }
      const busy = snapshot.refreshing === true;
      const refresh = () => {
        if (!busy) onRefresh();
      };
      return h(
        'div',
        { className: 'mi-toolbar' },
        h(
          'div',
          { className: 'mi-heading' },
          h('h2', { className: 'mi-title' }, t('header.title')),
          h('p', { className: 'mi-subtitle' }, t('header.subtitle')),
          metaParts.length === 0 ? null : h('p', { className: 'mi-heading-meta' }, metaParts.join(' · ')),
        ),
        h(
          'div',
          { className: 'mi-controls' },
          h(
            'div',
            { className: 'mi-search' },
            h('input', {
              className: 'mi-input',
              type: 'search',
              value: searchText,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.placeholder'),
              autoComplete: 'off',
              onChange: (event) => onSearchChange(event.target.value),
            }),
            searchText === ''
              ? null
              : h('button', { type: 'button', className: 'mi-clear', 'aria-label': t('search.placeholder'), onClick: onClear }, '×'),
          ),
          h(
            'select',
            { className: 'mi-select', value: snapshot.query.sort, 'aria-label': t('sort.label'), onChange: (event) => onSortChange(event.target.value) },
            SORT_OPTIONS.map((sort) => h('option', { key: sort, value: sort }, t('sort.' + sort))),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mi-switch',
              role: 'switch',
              'aria-checked': snapshot.query.group === true,
              title: t('group.hint'),
              onClick: onGroupToggle,
            },
            h('span', { className: 'mi-switch-track', 'aria-hidden': 'true' }, h('span', { className: 'mi-switch-thumb' })),
            h('span', null, t('group.label')),
          ),
          snapshot.query.group === true && snapshot.listState === 'ready' && snapshot.total > 0
            ? h('span', { className: 'mi-count', 'aria-live': 'polite' }, String(snapshot.total))
            : null,
          h(
            'button',
            { type: 'button', className: 'mi-button mi-button-secondary', disabled: busy, onClick: refresh },
            busy ? h('span', { className: 'mi-spin', 'aria-hidden': 'true' }) : null,
            t('refresh'),
          ),
        ),
        snapshot.refreshError === null ? null : h(ErrorBlock, { t, message: snapshot.refreshError, onRetry: onRefresh }),
      );
    }

    /** Statistics line under the toolbar (CONTRACT §5.2.3). */
    function StatusLine({ t, snapshot }) {
      if (snapshot.statusState !== 'ready' || snapshot.status === null) return null;
      if (snapshot.status.state === 'empty' || snapshot.status.state === 'error') return null;
      const summary = summarizeStatus(snapshot.status);
      const stat = (value) => (value === null ? '—' : String(value));
      return h('div', { className: 'mi-status-line' }, h('span', null, t('stats', {
        plugins: stat(summary.plugins),
        families: stat(summary.families),
        repositories: stat(summary.repositories),
      })));
    }

    /** Horizontally scrollable category filter pills. */
    function CategoryPills({ t, resolve, categories, active, onSelect }) {
      if (!Array.isArray(categories) || categories.length === 0) return null;
      return h(
        'div',
        { className: 'mi-pills' },
        h(
          'button',
          { type: 'button', className: 'mi-pill', 'aria-pressed': active === null, onClick: () => onSelect(null) },
          t('category.all'),
        ),
        categories.map((category) =>
          h(
            'button',
            { key: category.id, type: 'button', className: 'mi-pill', 'aria-pressed': active === category.id, onClick: () => onSelect(category.id) },
            categoryTitle(categories, category.id, resolve),
          ),
        ),
      );
    }

    /** The list body: loading skeleton, empty states, error row or results. */
    function ResultsBody({ t, resolve, snapshot, install, openPackage, openDetail, onToggleFamily, onRetryStatus, onRetrySearch }) {
      if (snapshot.statusState === 'idle' || snapshot.statusState === 'loading') return h(SkeletonList, { t });
      if (snapshot.statusState === 'error') return h(ErrorBlock, { t, message: snapshot.statusError, onRetry: onRetryStatus });
      const status = snapshot.status;
      if (status === null) return h(SkeletonList, { t });
      if (status.state === 'empty') return h(EmptyPanel, { title: t('empty.noSource') });
      if (status.state === 'error') {
        const message = status.error !== null && status.error !== undefined ? errorMessage(status.error) : snapshot.statusError;
        return h(ErrorBlock, { t, message, onRetry: onRetryStatus });
      }
      if (status.state === 'loading') return h(SkeletonList, { t });
      if (snapshot.listState === 'error') return h(ErrorBlock, { t, message: snapshot.listError, onRetry: onRetrySearch });
      if (snapshot.listState === 'loading' && snapshot.items.length === 0) return h(SkeletonList, { t });
      if (snapshot.items.length === 0) return h(EmptyPanel, { title: t('empty.noMatch') });
      const busy = snapshot.listState === 'loading';
      return h(
        'ul',
        { className: 'mi-list', 'aria-busy': busy === true ? 'true' : 'false' },
        snapshot.items.map((item) => {
          if (isFamilyItem(item)) {
            const familyId = typeof item.id === 'string' ? item.id : item.root.name;
            return h(FamilyCard, {
              key: familyId,
              item,
              t,
              resolve,
              categories: snapshot.categories,
              expanded: snapshot.expandedFamilies.get(familyId) === true,
              onToggle: () => onToggleFamily(familyId),
              install,
              openPackage,
              openDetail,
            });
          }
          return h(EntryCard, {
            key: item.name,
            entry: item,
            t,
            resolve,
            categories: snapshot.categories,
            install,
            openPackage,
            openDetail,
          });
        }),
      );
    }

    /** "Show more" row, including an inline retry for a failed next page. */
    function LoadMoreBar({ t, snapshot, onMore }) {
      if (snapshot.listState !== 'ready') return null;
      const hasMore = snapshot.nextOffset !== null;
      const failed = snapshot.moreState === 'error';
      if (!hasMore && !failed) return null;
      return h(
        'div',
        { className: 'mi-more' },
        failed ? h(ErrorBlock, { t, message: snapshot.moreError, onRetry: onMore }) : null,
        hasMore
          ? h(
              'button',
              { type: 'button', className: 'mi-button mi-button-secondary', disabled: snapshot.moreState === 'loading', onClick: onMore },
              snapshot.moreState === 'loading' ? h('span', { className: 'mi-spin', 'aria-hidden': 'true' }) : null,
              t('loadMore'),
            )
          : null,
      );
    }

    /** Complete detail view (CONTRACT §5.2.6). */
    function DetailView({ detail, t, resolve, categories, controller, install, openPackage }) {
      const back = () => controller.closeDetail();
      const backRow = h('button', { type: 'button', className: 'mi-back', onClick: back }, '← ' + t('detail.back'));
      if (detail.status === 'error') {
        return h('div', { className: 'mi-detail' }, backRow, h(ErrorBlock, { t, message: detail.error, onRetry: () => controller.retryDetail() }));
      }
      if (detail.status !== 'ready' || detail.entry === null) {
        return h('div', { className: 'mi-detail' }, backRow, h(SkeletonList, { t, rows: 4 }));
      }
      const entry = detail.entry;
      const family = detail.family;
      const versions = Array.isArray(detail.versions) ? detail.versions : [];
      const title = entryDisplayTitle(entry, resolve);
      const description = resolve(entry.description);
      const repository = entry.repository !== null && entry.repository !== undefined && typeof entry.repository === 'object' ? entry.repository : null;
      const repo = entry.repo !== null && entry.repo !== undefined && typeof entry.repo === 'object' ? entry.repo : null;
      const repoUrlCandidate = repo !== null && typeof repo.url === 'string' ? repo.url : repository !== null && typeof repository.url === 'string' ? repository.url : null;
      const repoUrl = isSafeHttpUrl(repoUrlCandidate) ? repoUrlCandidate : null;
      const directory = repository !== null && typeof repository.directory === 'string' && repository.directory !== '' ? repository.directory : null;
      const npmUrl = typeof entry.npm === 'string' && entry.npm !== '' ? 'https://www.npmjs.com/package/' + entry.npm : null;
      const added = formatDate(entry.added);
      const openDetail = (name) => controller.openDetail(name);
      const action = installAction(entry);
      const incompatible = action === 'blocked';
      return h(
        'div',
        { className: 'mi-detail' },
        backRow,
        h(
          'header',
          { className: 'mi-detail-head' },
          h('h2', { className: 'mi-detail-title' }, title),
          h(
            'div',
            { className: 'mi-detail-meta' },
            h(StarBadge, { entry, t }),
            h(DownloadBadge, { entry }),
            typeof entry.category === 'string' && entry.category !== '' ? h(Chip, { tone: 'brand' }, categoryTitle(categories, entry.category, resolve)) : null,
            typeof entry.version === 'string' && entry.version !== '' ? h(Chip, null, 'v' + entry.version) : null,
            h(InstallationChip, { entry, t }),
            added === null ? null : h('span', { className: 'mi-meta' }, t('detail.added', { date: added })),
          ),
          h(
            'div',
            { className: 'mi-links' },
            h(ExternalLink, { url: repoUrl, label: t('detail.repo') }, '↗ ' + t('detail.repo')),
            h(ExternalLink, { url: npmUrl, label: t('detail.npm') }, '↗ ' + t('detail.npm')),
          ),
        ),
        typeof description === 'string' && description !== '' ? h('p', { className: 'mi-description' }, description) : null,
        h(
          'div',
          { className: 'mi-detail-actions' },
          h(InstallControl, { entry, t, resolve, install, openPackage, large: true }),
          incompatible ? h('p', { className: 'mi-warning' }, t('detail.notCompatible')) : null,
        ),
        h('p', { className: 'mi-detail-hint' }, t('detail.installHint')),
        h(
          'section',
          { className: 'mi-section' },
          h('h3', { className: 'mi-section-title' }, t('detail.forkTree')),
          h(ForkTree, { family, entryName: entry.name, t, resolve, install, openPackage, openDetail }),
        ),
        h(
          'section',
          { className: 'mi-section' },
          h(
            'div',
            { className: 'mi-facts' },
            h(
              'div',
              { className: 'mi-fact' },
              h('span', { className: 'mi-fact-label' }, t('detail.npm')),
              h(
                'span',
                { className: 'mi-fact-value' },
                npmUrl === null ? '—' : h(ExternalLink, { url: npmUrl, className: 'mi-fact-link', label: t('detail.npm') }, entry.npm),
              ),
            ),
            h(
              'div',
              { className: 'mi-fact' },
              h('span', { className: 'mi-fact-label' }, t('detail.repo')),
              h(
                'span',
                { className: 'mi-fact-value' },
                repoUrl !== null && repoUrl !== '' ? [
                  h(ExternalLink, { key: 'url', url: repoUrl, className: 'mi-fact-link' }, repoUrl),
                  directory === null || directory === '' ? null : h('span', { key: 'dir', className: 'mi-meta' }, ' · ' + directory),
                ] : '—',
              ),
            ),
            h(
              'div',
              { className: 'mi-fact' },
              h('span', { className: 'mi-fact-label' }, t('detail.downloads')),
              h('span', { className: 'mi-fact-value' }, formatTotalValue(entry.downloads)),
            ),
          ),
          h('p', { className: 'mi-muted' }, t('detail.versionsCount', { n: String(versions.length) })),
        ),
      );
    }

    /** Root occupant of the `plugins.tab` slot. */
    function InsightTab(rawProps) {
      const props = rawProps === null || rawProps === undefined ? {} : rawProps;
      const controller = runtime.controller;
      const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
      const t = typeof props.t === 'function' ? props.t : runtime.t;
      const resolve = runtime.resolveText;
      const [searchText, setSearchText] = useState(() => snapshot.query.q);

      useEffect(() => {
        controller.ensureLoaded();
      }, [controller]);

      useEffect(() => {
        if (searchText === snapshot.query.q) return undefined;
        const timer = setTimeout(() => {
          controller.setQuery({ q: searchText });
        }, SEARCH_DEBOUNCE_MS);
        return () => {
          clearTimeout(timer);
        };
      }, [controller, searchText, snapshot.query.q]);

      const install = typeof props.install === 'function' ? props.install : null;
      const openPackage = typeof props.openPackage === 'function' ? props.openPackage : null;
      const openDetail = (name) => controller.openDetail(name);

      let body;
      if (snapshot.detail !== null) {
        body = h(DetailView, {
          detail: snapshot.detail,
          t,
          resolve,
          categories: snapshot.categories,
          controller,
          install,
          openPackage,
        });
      } else {
        body = [
          h(StatusLine, { key: 'status', t, snapshot }),
          h(CategoryPills, {
            key: 'pills',
            t,
            resolve,
            categories: snapshot.categories,
            active: snapshot.query.category,
            onSelect: (category) => controller.setQuery({ category }),
          }),
          h(ResultsBody, {
            key: 'results',
            t,
            resolve,
            snapshot,
            install,
            openPackage,
            openDetail,
            onToggleFamily: (familyId) => controller.toggleFamily(familyId),
            onRetryStatus: () => controller.retryStatus(),
            onRetrySearch: () => controller.retrySearch(),
          }),
          h(LoadMoreBar, {
            key: 'more',
            t,
            snapshot,
            onMore: () => controller.loadMore(),
          }),
        ];
      }

      return h(
        'div',
        { className: 'mi-root', 'data-plugin-tab': 'insight' },
        h(Stylesheet),
        snapshot.detail === null
          ? h(Toolbar, {
              t,
              resolve,
              snapshot,
              searchText,
              onSearchChange: setSearchText,
              onClear: () => {
                setSearchText('');
                controller.setQuery({ q: '' });
              },
              onSortChange: (sort) => controller.setQuery({ sort }),
              onGroupToggle: () => controller.setQuery({ group: snapshot.query.group !== true }),
              onRefresh: () => controller.refresh(),
            })
          : null,
        body,
      );
    }

    // ------------------------------------------------------------------------
    // 6. Module export
    // ------------------------------------------------------------------------

    /**
     * Register the Insight tab and keep it alive for the module lifetime.
     * @param {object} ctx browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      runtime.t = t;
      runtime.resolveText = createTextResolver(ctx.locale);
      runtime.controller = new InsightController();
      ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'market-insight: dict-en');
      ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'market-insight: dict-zh');
      ctx.effect(() => () => runtime.controller.dispose(), 'market-insight: controller');
      ctx.slots.inject('plugins.tab', () => ctx.slots.register({
        name: 'plugins.tab',
        id: 'insight',
        order: 20,
        label: () => t('tab.title'),
        locale: NS,
      }, InsightTab));
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
