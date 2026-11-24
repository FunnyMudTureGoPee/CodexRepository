/**
 * Model Picker — browser half of the `@local/dsh-model-picker` bundle.
 *
 * Replaces the composer's `conversation.input.model` seat with a THREE-LEVEL
 * classified picker instead of one flat provider-grouped list:
 *
 *   渠道 channel  →  厂商族 family  →  型号 model  →  推理档位 effort
 *
 * The stock picker shows ~300 rows on a wb-cli profile because every model is
 * mirrored as `model:minimal` … `model:max` twins. Here the twins are folded
 * away: the model list holds base models only (≈50), the effort twins of the
 * selected model become the last level, and channels/families are real
 * drill-down panes so the list stays short at every step.
 *
 * Data + submission use the same two session RPCs the stock selector uses
 * (`session.models` / `session.selectModel`), so a selection made here is the
 * one the /model popup and the host report; the host stays the single fact
 * source. Pure classification lives in `classify.mjs` (see its own tests).
 *
 * Layout of this file:
 *   1. constants + dictionaries
 *   2. module state + RPC plumbing (load / select, latest-wins)
 *   3. stylesheet (theme tokens only)
 *   4. presentational components (one per pane)
 *   5. module export: slot registration
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-model-picker',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React;

    // ------------------------------------------------------------------------
    // 0. Pure classification (inlined — a client bundle MUST be self-contained)
    //
    // `require` here reaches only the module table: platform seed words such as
    // `react` and graph rows registered by other packages. A sibling file is
    // NOT a table word, so `require('./classify.mjs')` throws
    // "missed the module table" and takes the whole client boot down with it.
    // The block between the markers is pure (no React, no DOM, no module
    // state) and test/classify.test.mjs extracts and evaluates exactly this
    // slice, so the tests still exercise the shipped code.
    // ------------------------------------------------------------------------

    // >>> mp-pure-helpers

    /** Canonical effort levels, weakest → strongest. Hosts may expose a subset. */
    const EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

    /**
     * Tokens that may legally follow `<id>:` in a catalog row. `none` is real
     * (glm-5.3-flash*, kimi-k2.8-preview) but is not a canonical level, so it is
     * accepted for SUFFIX PARSING only — EFFORT_LEVELS stays the 6 levels.
     */
    const TYPED_EFFORTS = Object.freeze(['none', ...EFFORT_LEVELS]);

    const EFFORT_SET = new Set(TYPED_EFFORTS);

    /** kind → bilingual label for the UI chip / group header. */
    const KIND_LABELS = Object.freeze({
      pro: Object.freeze({ zh: '专业 Pro', en: 'Pro' }),
      flash: Object.freeze({ zh: '快速 Flash', en: 'Flash' }),
      turbo: Object.freeze({ zh: '极速 Turbo', en: 'Turbo' }),
      code: Object.freeze({ zh: '代码 Code', en: 'Code' }),
      vision: Object.freeze({ zh: '多模态 Vision', en: 'Vision' }),
      thinking: Object.freeze({ zh: '推理 Thinking', en: 'Thinking' }),
      preview: Object.freeze({ zh: '预览 Preview', en: 'Preview' }),
      standard: Object.freeze({ zh: '标准 Standard', en: 'Standard' }),
    });

    /** Render order of the kinds inside a family (most specific first). */
    const KIND_RANK = Object.freeze({
      pro: 10,
      flash: 20,
      turbo: 30,
      code: 40,
      vision: 50,
      thinking: 60,
      preview: 70,
      standard: 80,
    });

    /** Family descriptors keyed by family id. `order` drives the family sort. */
    const FAMILIES = Object.freeze({
      deepseek: Object.freeze({ id: 'deepseek', label: 'DeepSeek', order: 10 }),
      glm: Object.freeze({ id: 'glm', label: 'GLM', order: 20 }),
      kimi: Object.freeze({ id: 'kimi', label: 'Kimi', order: 30 }),
      minimax: Object.freeze({ id: 'minimax', label: 'MiniMax', order: 40 }),
      hunyuan: Object.freeze({ id: 'hunyuan', label: '混元 Hunyuan', order: 50 }),
      claude: Object.freeze({ id: 'claude', label: 'Claude', order: 60 }),
      other: Object.freeze({ id: 'other', label: '其他 Other', order: 900 }),
    });

    /** Models whose vanilla id does not advertise their documented purpose. */
    const KIND_OVERRIDES = Object.freeze({ 'kimi-k2.7': 'code' });

    /**
     * Split an effort-suffixed model id into base id and effort token.
     * Only the LAST `:` segment counts, and only for a known token.
     * @param {string} modelId
     * @returns {{ base: string, effort: string | undefined }}
     */
    function splitEffort(modelId) {
      if (typeof modelId !== 'string' || modelId.length === 0) {
        return { base: typeof modelId === 'string' ? modelId : '', effort: undefined };
      }
      const at = modelId.lastIndexOf(':');
      if (at <= 0 || at === modelId.length - 1) return { base: modelId, effort: undefined };
      const suffix = modelId.slice(at + 1).toLowerCase();
      if (!EFFORT_SET.has(suffix)) return { base: modelId, effort: undefined };
      return { base: modelId.slice(0, at), effort: suffix };
    }

    /**
     * Classify a model into its vendor family by the PREFIX of the base id.
     * @param {string} modelId
     * @param {string} [modelName]
     * @returns {{ id: string, label: string, order: number }}
     */
    function familyOf(modelId, modelName) {
      const base = splitEffort(modelId).base.toLowerCase();

      if (base.startsWith('deepseek-')) return { ...FAMILIES.deepseek };
      if (base.startsWith('glm-')) return { ...FAMILIES.glm };
      if (base.startsWith('kimi-')) return { ...FAMILIES.kimi };
      if (base.startsWith('minimax-')) return { ...FAMILIES.minimax };
      if (base.startsWith('hunyuan-')) return { ...FAMILIES.hunyuan };
      // hy + digit, or hy-<slug>: hy3, hy3-x, hy3-preview, hy4-preview-x.
      if (/^hy\d/.test(base) || /^hy-[a-z0-9]/.test(base)) return { ...FAMILIES.hunyuan };
      if (base.startsWith('claude-')) return { ...FAMILIES.claude };

      // Only the display name identifies some hosts' Claude rows.
      if (typeof modelName === 'string' && modelName.toLowerCase().includes('claude')) {
        return { ...FAMILIES.claude };
      }
      return { ...FAMILIES.other };
    }

    /**
     * Classify a model by capability on the lower-cased BASE id (first match wins).
     * @param {string} baseId
     * @returns {'pro'|'flash'|'turbo'|'code'|'vision'|'thinking'|'preview'|'standard'}
     */
    function modelKind(baseId) {
      const id = typeof baseId === 'string' ? baseId.toLowerCase() : '';
      if (!id) return 'standard';

      if (KIND_OVERRIDES[id]) return KIND_OVERRIDES[id];
      if (id.includes('flash')) return 'flash';
      if (id.includes('turbo')) return 'turbo';
      if (id.includes('vision')) return 'vision';
      // Trailing vision marker: `glm-4.6v`, `glm-5v-turbo` (turbo already won
      // above), and a bare `-v` segment. Kept as explicit shapes so words like
      // `vibe-model` do not masquerade as vision models.
      if (/\dv$/.test(id) || /-\d[\d.]*v([-_.]|$)/.test(id) || /(^|[-_.])v$/.test(id)) return 'vision';
      if (/(^|[-_.])pro($|[-_.])/.test(id)) return 'pro';
      if (id.includes('code')) return 'code';
      if (/(^|[-_.])thinking($|[-_.])/.test(id) || /(^|[-_.])r1($|[-_.])/.test(id)) return 'thinking';
      if (id.includes('preview')) return 'preview';
      return 'standard';
    }

    /** Strip a trailing ` [<effort>]` decoration so a folded entry keeps a clean name. */
    function stripEffortSuffix(name, effort) {
      if (typeof name !== 'string') return '';
      const trimmed = name.trim();
      if (!effort) return trimmed;
      const re = new RegExp(`\\s*[\\[(]\\s*${effort}\\s*[\\])]\\s*$`, 'i');
      const stripped = trimmed.replace(re, '').trim();
      return stripped.length > 0 ? stripped : trimmed;
    }

    /** Ascending effort order; unknown tokens sort last, alphabetically. */
    function compareEffort(a, b) {
      const ia = EFFORT_LEVELS.indexOf(a);
      const ib = EFFORT_LEVELS.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return String(a).localeCompare(String(b));
    }

    /** Locale-independent, deterministic compare for ids. */
    function compareIds(a, b) {
      const sa = String(a);
      const sb = String(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }

    /** Associate one provider group's flat list into family → model buckets. */
    function bucketGroup(group) {
      const rawModels = Array.isArray(group && group.models) ? group.models : [];
      /** baseId → { bare?, twins: Map<effort, model> } */
      const buckets = new Map();

      for (const model of rawModels) {
        if (!model || typeof model.id !== 'string') continue;
        const { base, effort } = splitEffort(model.id);
        let bucket = buckets.get(base);
        if (!bucket) {
          bucket = { bare: undefined, twins: new Map() };
          buckets.set(base, bucket);
        }
        if (effort === undefined) {
          if (!bucket.bare) bucket.bare = model;
        } else if (!bucket.twins.has(effort)) {
          bucket.twins.set(effort, model);
        }
      }

      const families = new Map();

      for (const [baseId, bucket] of buckets) {
        const bare = bucket.bare;
        const twinModels = [...bucket.twins.values()];
        const representative = bare || twinModels[0];
        if (!representative) continue;

        const family = familyOf(baseId, representative.name);
        const kind = modelKind(baseId);

        let familyBucket = families.get(family.id);
        if (!familyBucket) {
          familyBucket = { info: family, models: [] };
          families.set(family.id, familyBucket);
        }

        const efforts = buildEfforts(bare, bucket, baseId);
        const name = bare
          ? (typeof bare.name === 'string' && bare.name.length > 0 ? bare.name : baseId)
          : stripEffortSuffix(representative.name, splitEffort(representative.id).effort) || baseId;

        const entry = {
          baseId,
          modelId: bare ? bare.id : representative.id,
          name,
          kind,
          efforts,
        };
        if (typeof representative.description === 'string') entry.description = representative.description;
        if (bare && bare.reasoning && bare.reasoning.defaultEffort) entry.defaultEffort = bare.reasoning.defaultEffort;

        familyBucket.models.push(entry);
      }

      return families;
    }

    /** Build the effort ladder for one base model (host order, then twins, then []). */
    function buildEfforts(bare, bucket, baseId) {
      const baseModelId = bare ? bare.id : baseId;
      const out = [];
      const seen = new Set();

      const describe = (twin) => {
        if (twin && typeof twin.description === 'string') return twin.description;
        if (bare && typeof bare.description === 'string') return bare.description;
        return undefined;
      };

      const declared = bare && bare.reasoning && Array.isArray(bare.reasoning.efforts)
        ? bare.reasoning.efforts
        : null;

      if (declared) {
        for (const eff of declared) {
          const rawId = typeof eff === 'string' ? eff : (eff && eff.id);
          if (typeof rawId !== 'string' || rawId.length === 0) continue;
          const effort = rawId.toLowerCase();
          if (seen.has(effort)) continue;
          seen.add(effort);
          const twin = bucket.twins.get(effort);
          const effEntry = {
            effort,
            modelId: twin ? twin.id : baseModelId,
            name: eff && typeof eff.name === 'string' && eff.name.length > 0 ? eff.name : rawId,
          };
          const description = describe(twin);
          if (description !== undefined) effEntry.description = description;
          out.push(effEntry);
        }
        return out;
      }

      const present = [...bucket.twins.entries()].sort((a, b) => compareEffort(a[0], b[0]));
      for (const [effort, twin] of present) {
        if (seen.has(effort)) continue;
        seen.add(effort);
        const effEntry = {
          effort,
          modelId: twin.id,
          name: effort.charAt(0).toUpperCase() + effort.slice(1),
        };
        const description = describe(twin);
        if (description !== undefined) effEntry.description = description;
        out.push(effEntry);
      }
      return out;
    }

    /**
     * Build the full renderable tree from the provider directory.
     * @param {Array<{ id: string, name?: string, models?: Array<object> }>} groups
     * @returns {Array<object>}
     */
    function classifyChannels(groups) {
      const list = Array.isArray(groups) ? groups : [];
      const channels = [];

      for (const group of list) {
        if (!group || typeof group !== 'object') continue;

        const familyMap = bucketGroup(group);
        const families = [...familyMap.values()]
          .sort((a, b) => {
            if (a.info.order !== b.info.order) return a.info.order - b.info.order;
            return compareIds(a.info.label, b.info.label);
          })
          .map(({ info, models }) => {
            models.sort((a, b) => {
              const ra = KIND_RANK[a.kind] || 999;
              const rb = KIND_RANK[b.kind] || 999;
              if (ra !== rb) return ra - rb;
              return compareIds(a.baseId, b.baseId);
            });
            return { id: info.id, label: info.label, order: info.order, models };
          });

        const count = families.reduce((n, f) => n + f.models.length, 0);
        const id = typeof group.id === 'string' && group.id.length > 0 ? group.id : `channel-${channels.length}`;
        const label = typeof group.name === 'string' && group.name.length > 0
          ? group.name
          : (typeof group.id === 'string' && group.id.length > 0 ? group.id : id);

        channels.push({ id, label, families, count });
      }

      return channels;
    }

    /**
     * Does a model entry match a free-text query? Empty query matches all.
     * @param {object|null|undefined} entry
     * @param {string|null|undefined} query
     * @returns {boolean}
     */
    function matchesQuery(entry, query) {
      if (!entry || typeof entry !== 'object') return false;
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (needle.length === 0) return true;

      const haystacks = [entry.baseId, entry.name, entry.kind];
      for (const value of haystacks) {
        if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
      }
      return false;
    }

    // <<< mp-pure-helpers

    // ------------------------------------------------------------------------
    // 1. Constants and dictionaries
    // ------------------------------------------------------------------------

    /** Locale namespace owned by this plugin. */
    const NS = 'modelPicker';

    /** How long the trigger may stay stale before a background refresh. */
    const REFRESH_MS = 60_000;

    /** How long a seat stuck in the unavailable state keeps retrying. */
    const REVIVE_WINDOW_MS = 20_000;

    /** English copy (key source of truth). */
    const EN = {
      'trigger.fallback': 'Select model',
      'trigger.selectAria': 'Select model',
      'trigger.aria': 'Select model, current {model}',
      'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
      'menu.aria': 'Model and reasoning effort',
      'crumb.channel': 'Channel',
      'crumb.family': 'Type',
      'crumb.model': 'Model',
      'crumb.effort': 'Effort',
      'pane.channels': 'Channel',
      'pane.families': 'Model type',
      'pane.models': 'Model',
      'pane.efforts': 'Reasoning effort',
      'channel.summary': '{families} types · {models} models',
      'family.summary': '{n} models',
      'model.current': 'current',
      'effort.providerDefault': 'Provider default',
      'effort.current': 'current',
      'back': 'Back',
      'search.placeholder': 'Filter models…',
      'search.clear': 'Clear filter',
      'status.loading': 'Loading models…',
      'status.unavailable': 'Model directory is not ready yet — click Retry, or wait a moment.',
      'error.selectFailed': 'The host rejected that model selection.',
      'error.selectFailedWhy': 'Could not switch model: {message}',
      'status.unavailableWhy': 'Model directory unavailable: {message}',
      'empty.models': 'No models in this channel',
      'empty.efforts': 'This model has no reasoning levels',
      'empty.search': 'No model matches the filter',
      'error.action': 'Could not load models: {message}',
      'warning.groupLoad': '{name} failed to load: {message}',
      'retry': 'Retry',
      'action.reload': 'Reload',
      'menu.close': 'Close',
    };

    /** Simplified Chinese copy. */
    const ZH = {
      'trigger.fallback': '选择模型',
      'trigger.selectAria': '选择模型',
      'trigger.aria': '选择模型，当前 {model}',
      'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
      'menu.aria': '模型与推理等级',
      'crumb.channel': '渠道',
      'crumb.family': '类型',
      'crumb.model': '模型',
      'crumb.effort': '档位',
      'pane.channels': '渠道',
      'pane.families': '模型类型',
      'pane.models': '模型',
      'pane.efforts': '推理档位',
      'channel.summary': '{families} 类 · {models} 个模型',
      'family.summary': '{n} 个模型',
      'model.current': '当前',
      'effort.providerDefault': '渠道默认',
      'effort.current': '当前',
      'back': '返回',
      'search.placeholder': '筛选模型…',
      'search.clear': '清除筛选',
      'status.loading': '正在加载模型…',
      'status.unavailable': '模型目录尚未就绪——点「重试」，或稍等片刻。',
      'error.selectFailed': '主机拒绝了这次模型选择。',
      'error.selectFailedWhy': '切换模型失败：{message}',
      'status.unavailableWhy': '模型目录不可用：{message}',
      'empty.models': '该渠道下没有模型',
      'empty.efforts': '该模型没有可调推理档位',
      'empty.search': '没有匹配的模型',
      'error.action': '加载模型失败：{message}',
      'warning.groupLoad': '{name} 加载失败：{message}',
      'retry': '重试',
      'action.reload': '重新加载',
      'menu.close': '关闭',
    };

    // ------------------------------------------------------------------------
    // 2. Module state + RPC plumbing
    // ------------------------------------------------------------------------

    /** Process-wide view state shared by the trigger and its menu. */
    const runtime = {
      /** Latest directory snapshot (host-authoritative). */
      state: {
        current: null,
        routable: null,
        groups: [],
        failures: [],
        status: 'idle',
        error: null,
      },
      listeners: new Set(),
      /**
       * Seats in the "unavailable" state (no transport resolved yet) hold no
       * live store subscription, so nothing would ever re-render them. They
       * register here instead, and {@link notifyRevive} pokes them when the
       * world may have changed (connection re-established, host restarted).
       */
      reviveListeners: new Set(),
      /** Latest load wins; an older response never overwrites a newer one. */
      generation: 0,
      loadedAt: 0,
      /** The client Context captured in apply, used to RESOLVE the connection lazily. */
      ctx: undefined,
      /** Bound translate for the current locale. */
      t: (key) => key,
      /** Bound locale resolve for kind labels. */
      lang: 'en',
      /** Last error thrown by `directoryFor`, kept for the diagnostic sink. */
      directoryError: null,
      /** Last error thrown by a select attempt, surfaced in the menu. */
      lastSelectError: null,
    };

    /**
     * Report one SUBMIT attempt to the Host sink.
     *
     * Selection failures happen long after mount, so the per-seat render report
     * never sees them. Each attempt reports under its own signature so the Host
     * keeps the outcome of every distinct failure.
     * @param {object} selection the provider/model/effort triple attempted.
     * @param {string|null} error the failure text, or null when accepted.
     */
    function reportSubmit(selection, error) {
      postDiagnostics({
        signature: 'submit|' + (error === null ? 'ok' : error),
        at: new Date().toISOString(),
        kind: 'submit',
        selection: selection === undefined ? null : selection,
        error,
        directoryTransport: runtime.lastTransport,
      });
    }

    /**
     * Read a service off the client Context.
     *
     * The CANONICAL access is the property accessor (`ctx.connection`,
     * `ctx.modelDirectories`) — that is what the framework's own plugins use,
     * and cordis installs those accessors for every service a plugin injects.
     * `ctx.get(name)` is only a fallback: on this client context it does not
     * always yield the service value itself, which is exactly how this seat
     * ended up holding an object that had no `.api` and no `.directoryFor`.
     *
     * Property access THROWS when the name is not injected, so every read is
     * guarded; a missing service simply reads as undefined.
     * @param {object} ctx the client Context captured in apply.
     * @param {string} name the service name.
     * @returns {object|undefined} the service value, when available.
     */
    function readService(ctx, name) {
      if (ctx === undefined || ctx === null) return undefined;
      try {
        const direct = ctx[name];
        if (direct !== undefined && direct !== null) return direct;
      } catch (error) {
        // Not injected on this ctx: fall through to get().
      }
      if (typeof ctx.get !== 'function') return undefined;
      try {
        const viaGet = ctx.get(name);
        return viaGet === undefined ? undefined : viaGet;
      } catch (error) {
        return undefined;
      }
    }

    /**
     * Resolve the session RPC face from the client context, at CALL time.
     *
     * Resolving eagerly in `apply` proved unreliable: the registrar can run
     * before the connection handle's `api` is materialized, which left a dead
     * (invisible) seat that had already shadowed the stock one. Reading it per
     * render keyed on the live context removes that ordering dependency.
     * @param {object} ctx the client Context captured in apply.
     * @returns {object|undefined} `api.sessions`-bearing face, when available.
     */
    function resolveApi(ctx) {
      const connection = readService(ctx, 'connection');
      if (connection === undefined || connection === null) return undefined;
      const api = connection.api;
      return api === undefined || api === null ? undefined : api;
    }

    /**
     * Resolve the shared per-session model directory service
     * (`ctx.modelDirectories`, owned by @deepseek-ai/dsh-client-ui-model-selection).
     *
     * This is the PREFERRED data source: it is the exact service the stock
     * selector uses, so it is present whenever the stock seat is, it owns
     * connection-reset handling, and it already exposes the very snapshot shape
     * this picker renders (`current / routable / groups / failures / status /
     * error`). Depending on it removes this plugin's own dependency on reaching
     * `connection.api` at the right moment — the failure that left the seat grey.
     * @param {object} ctx the client Context captured in apply.
     * @param {string|undefined} sessionId the owning session.
     * @returns {object|undefined} the ModelDirectory, when resolvable.
     */
    function resolveDirectory(ctx, sessionId) {
      if (sessionId === undefined) return undefined;
      const service = readService(ctx, 'modelDirectories');
      if (service === undefined || service === null || typeof service.directoryFor !== 'function') return undefined;
      try {
        return service.directoryFor(sessionId);
      } catch (error) {
        runtime.directoryError = errorMessage(error);
        return undefined;
      }
    }

    /** A frozen empty snapshot, so the fallback store identity never churns. */
    const EMPTY_STATE = Object.freeze({
      current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
    });

    /**
     * Signatures already reported on this page. A page renders ONE SEAT PER
     * SESSION, and they can disagree (one session resolves its directory, the
     * next does not). Reporting a single "first" seat is what made an earlier
     * diagnostic look healthy while the visible seat was grey, so each distinct
     * seat signature reports once and the Host keeps them all.
     */
    const diagPosted = new Set();

    /**
     * Report what one seat observed through the Host sink
     * (`/dsh-model-picker/api/diag`). This seat shadows the stock selector, so
     * an unhealthy state is otherwise invisible: the browser console is not
     * reachable from the Host.
     * @param {object} facts what the render actually observed.
     */
    function postDiagnostics(facts) {
      const signature = String(facts.signature);
      if (diagPosted.has(signature)) return;
      if (diagPosted.size >= 10) return;
      diagPosted.add(signature);
      try {
        void fetch('/dsh-model-picker/api/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-model-picker': '1' },
          credentials: 'same-origin',
          body: JSON.stringify(facts),
        }).catch(() => { /* the sink is best-effort */ });
      } catch (error) {
        // fetch itself unavailable: nothing more this plugin can do.
      }
    }

    /**
     * Build the diagnostic facts for one render. Pure inspection, no mutation.
     * Distinguishes the property accessor from `ctx.get`, because conflating the
     * two is what hid the real cause across several rounds.
     * @param {object} props the seat props.
     * @param {object} ctx the captured client Context.
     * @param {object|undefined} directory the resolved directory, if any.
     * @returns {object} a JSON-safe report.
     */
    function diagnosticsOf(props, ctx, directory, unavailable) {
      const safe = (fn) => {
        try {
          const value = fn();
          return value === undefined ? 'undefined' : (value === null ? 'null' : typeof value);
        } catch (error) {
          return 'throw: ' + (error && error.message ? error.message : String(error));
        }
      };
      const propRead = (name) => safe(() => (ctx === undefined || ctx === null ? undefined : ctx[name]));      const keysOf = (value) => {
        if (value === undefined || value === null || typeof value !== 'object') return [];
        try {
          return Object.keys(value).slice(0, 24);
        } catch (error) {
          return ['keys-threw'];
        }
      };
      const connectionProp = ctx === undefined || ctx === null ? undefined : (() => {
        try {
          return ctx.connection;
        } catch (error) {
          return undefined;
        }
      })();
      // What the resolved directory actually offers, and what its store holds at
      // this instant — the seat is only useful if load()/select()/store exist and
      // the snapshot carries groups.
      const snapshotReport = (() => {
        if (directory === undefined || directory === null) return null;
        let store;
        try {
          store = directory.store;
        } catch (error) {
          return { store: 'throw: ' + errorMessage(error) };
        }
        if (store === undefined || store === null) return { store: 'undefined' };
        try {
          const snapshot = store.getSnapshot();
          return {
            status: snapshot === undefined ? 'undefined' : snapshot.status,
            groups: snapshot !== undefined && Array.isArray(snapshot.groups) ? snapshot.groups.length : 'n/a',
            current: snapshot !== undefined && snapshot.current ? 'present' : 'null',
            error: snapshot === undefined ? 'undefined' : snapshot.error,
            keys: snapshot === undefined ? [] : Object.keys(snapshot),
          };
        } catch (error) {
          return { store: 'snapshot threw: ' + errorMessage(error) };
        }
      })();
      return {
        at: new Date().toISOString(),
        hasCtx: ctx !== undefined && ctx !== null,
        ctxGetIsFn: typeof (ctx && ctx.get) === 'function',
        // Property accessor (canonical) vs get() — they can differ.
        propConnection: propRead('connection'),
        propConnectionApi: safe(() => (connectionProp === undefined || connectionProp === null ? undefined : connectionProp.api)),
        connectionKeys: keysOf(connectionProp),
        getConnection: safe(() => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)),
        getConnectionKeys: keysOf((() => {
          try {
            return typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
          } catch (error) {
            return undefined;
          }
        })()),
        propModelDirectories: propRead('modelDirectories'),
        getModelDirectories: safe(() => (typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined)),
        directory: directory === undefined ? 'undefined' : 'present',
        directoryError: runtime.directoryError,
        directoryKeys: keysOf(directory),
        directoryLoad: typeof (directory && directory.load),
        directorySelect: typeof (directory && directory.select),
        snapshot: snapshotReport,
        unavailable,
        // Per-seat identity: a page renders one seat per session, and the Host
        // keeps one report per distinct signature.
        signature: `${String(props && props.sessionId)}|${String(unavailable)}|${String(props && props.locked === true)}`,
        sessionIdShort: String(props && props.sessionId).slice(0, 10),
        locked: props && props.locked === true,
        propKeys: props !== null && props !== undefined && typeof props === 'object' ? Object.keys(props) : [],
        propApiIsFn: typeof (props && props.api) === 'function',
        propApiResult: props && typeof props.api === 'function' ? safe(() => props.api()) : 'n/a',
        propSessionId: props && props.sessionId === undefined ? 'undefined' : 'present',
        tIsFn: typeof runtime.t === 'function',
        boot: typeof window !== 'undefined' && window.__DSH_BOOT__ !== undefined,
      };
    }

    /** Publish a partial patch to every mounted consumer. */
    function publish(patch) {
      runtime.state = Object.assign({}, runtime.state, patch);
      for (const listener of runtime.listeners) listener();
    }

    /**
     * Wake every seat that is currently stuck in the unavailable state so it
     * re-resolves its transport. A seat in that state subscribed to nothing, so
     * without this poke it would stay grey forever even after the connection
     * came up — which is exactly what happened after a restart or on a brand-new
     * session (its directory scope does not exist for the first few frames).
     */
    function notifyRevive() {
      for (const listener of runtime.reviveListeners) listener();
    }

    /**
     * Read the session model directory.
     * @param {object} api the connection api face (`api.sessions`).
     * @param {string} sessionId the owning session.
     * @returns {Promise<void>} resolves when the store carries the answer.
     */
    async function loadDirectory(api, sessionId) {
      const generation = ++runtime.generation;
      publish({ status: 'loading', error: null });
      let response;
      try {
        response = await api.sessions.models({ sessionId });
      } catch (error) {
        if (generation !== runtime.generation) return;
        publish({ status: 'error', error: errorMessage(error), errorKey: 'network-error' });
        return;
      }
      if (generation !== runtime.generation) return;
      const result = response === null || response === undefined ? null : response.result;
      if (result === null || result === undefined || result.ok !== true) {
        const failure = result !== null && result !== undefined && result.ok === false ? result.error : null;
        const code = failure !== null && typeof failure.code === 'string' ? failure.code : 'model-directory-failed';
        const message = failure !== null && typeof failure.message === 'string' ? failure.message : errorMessage(response);
        publish({ status: 'error', error: code + ': ' + message, errorKey: code });
        return;
      }
      runtime.loadedAt = Date.now();
      const value = result.value;
      publish({
        current: value.current === undefined ? null : value.current,
        routable: value.routable === undefined ? null : value.routable,
        groups: Array.isArray(value.groups) ? value.groups : [],
        failures: Array.isArray(value.failures) ? value.failures : [],
        status: 'ready',
        error: null,
        errorKey: null,
      });
    }

    /**
     * Submit one complete selection. The returned boolean is whether the host
     * accepted it; the store carries the resulting current either way.
     * @param {object} api the connection api face.
     * @param {string} sessionId the owning session.
     * @param {{provider: string, model: string, reasoningEffort?: string}} selection target.
     * @returns {Promise<boolean>} acceptance.
     */
    async function selectProvider(api, sessionId, selection) {
      publish({ status: 'selecting', error: null });
      let response;
      try {
        response = await api.sessions.selectModel({
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        });
      } catch (error) {
        publish({ status: 'error', error: errorMessage(error) });
        return false;
      }
      const result = response === null || response === undefined ? null : response.result;
      if (result === null || result === undefined || result.ok !== true) {
        const failure = result !== null && result !== undefined && result.ok === false ? result.error : null;
        const code = failure !== null && typeof failure.code === 'string' ? failure.code : 'select-model-failed';
        const message = failure !== null && typeof failure.message === 'string' ? failure.message : errorMessage(response);
        publish({ status: 'error', error: code + ': ' + message });
        return false;
      }
      publish({
        current: result.value.selected,
        routable: true,
        status: 'ready',
        error: null,
      });
      return true;
    }

    /** Best-effort human text for an unknown thrown/returned failure. */
    function errorMessage(error) {
      if (error === null || error === undefined) return 'unknown error';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message !== '') return error.message;
      try {
        return JSON.stringify(error);
      } catch (nested) {
        return String(error);
      }
    }

    // ------------------------------------------------------------------------
    // 3. Stylesheet
    // ------------------------------------------------------------------------

    /** Theme-token-only stylesheet (no palette literals, no global selectors). */
    const CSS = [
      '.mp-root{position:relative;min-width:0}',
      // Trigger: same chip geometry as the stock model seat.
      '.mp-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:220px;max-width:min(360px,45cqw);height:28px;padding:0 4px 0 8px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer}',
      '.mp-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mp-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.mp-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.mp-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mp-trigger-effort{flex:0 0 auto;color:var(--dsw-alias-label-caption)}',
      '.mp-chevron{flex:0 0 auto;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}',
      '.mp-chevron-open{transform:rotate(180deg)}',
      // Menu card: same material as the stock seat menu.
      '.mp-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:20;display:flex;flex-direction:column;width:max-content;min-width:min(280px,calc(100vw - 32px));max-width:min(460px,calc(100vw - 32px));max-height:min(420px,calc(100vh - 96px));overflow:hidden;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      // Breadcrumb: 渠道 / 类型 / 模型 / 档位 with the current path in primary.
      '.mp-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:4px 6px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px}',
      '.mp-crumb{padding:2px 5px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.mp-crumb:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mp-crumb:disabled{color:var(--dsw-alias-label-primary);font-weight:600;cursor:default}',
      '.mp-crumb-sep{color:var(--dsw-alias-label-caption);font-size:12px}',
      '.mp-pane-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px 3px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:500}',
      '.mp-back{padding:0;border:none;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.mp-rows{min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px}',
      '.mp-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:auto;min-width:100%;min-height:36px;padding:6px 8px;border:none;border-radius:10px;outline:none;background:transparent;color:inherit;text-align:left;cursor:pointer}',
      '.mp-row:hover:not(:disabled),.mp-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mp-row:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.mp-row-copy{display:flex;flex:1;flex-direction:column;min-width:0}',
      '.mp-row-title{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '.mp-row-name{overflow:hidden;color:inherit;font-size:14px;line-height:20px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}',
      '.mp-row-desc{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}',
      '.mp-row-count{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
      '.mp-check{display:grid;place-items:center;flex:0 0 18px;color:var(--dsw-alias-label-primary)}',
      '.mp-arrow{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
      // Kind badge (pro / flash / vision …) and the per-kind group heading.
      '.mp-kind{flex:0 0 auto;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}',
      '.mp-kind-head{position:sticky;top:0;z-index:1;padding:5px 8px 3px;margin-top:2px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:500}',
      '.mp-kind-head:first-child{margin-top:0}',
      '.mp-search{display:flex;align-items:center;gap:6px;padding:0 8px 6px}',
      '.mp-search input{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
      '.mp-search input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mp-search input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.mp-status,.mp-empty{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
      '.mp-error,.mp-warning{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.mp-warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}',
      '.mp-retry{flex:0 0 auto;padding:0;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}',
      // Runtime RPC responses carry an rpcId envelope; surface it readably
      // instead of a bare "[object Object]" when the host is unreachable.
      '.mp-error-detail{max-width:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
    ].join('');

    /** Mount the stylesheet exactly once for the module lifetime. */
    function Stylesheet() {
      return h('style', { 'data-model-picker': '' }, CSS);
    }

    // ------------------------------------------------------------------------
    // 4. Presentational components
    // ------------------------------------------------------------------------

    /** Trailing check mark for the selected row. */
    function Check({ on }) {
      return h('span', { className: 'mp-check' }, on ? h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
        h('path', {
          d: 'M6.2 11.4 2.8 8l1.4-1.4 2 2 5-5L12.6 5z',
          fill: 'currentColor',
        }),
      ) : null);
    }

    /** Right-pointing chevron for a drill-down row. */
    function Arrow() {
      return h('span', { className: 'mp-arrow', 'aria-hidden': 'true' }, h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14 },
        h('path', { d: 'M6 3.5 10.5 8 6 12.5l-1-1L8.5 8 5 4.5z', fill: 'currentColor' }),
      ));
    }

    /** Down-pointing chevron for the trigger. */
    function Chevron({ open }) {
      return h(
        'svg',
        { className: open ? 'mp-chevron mp-chevron-open' : 'mp-chevron', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
        h('path', { d: 'M4 6h8l-4 4z', fill: 'currentColor' }),
      );
    }

    /** One breadcrumb segment; the deepest segment is inert. */
    function Crumb({ label, onClick }) {
      return h('button', {
        type: 'button',
        className: 'mp-crumb',
        disabled: onClick === undefined,
        onClick,
      }, label);
    }

    /**
     * Level 1 — channels. One row per provider group, with its type count and
     * model count so the user can choose a route before choosing a model.
     */
    function ChannelPane({ channels, onPick, t }) {
      return h('div', { className: 'mp-rows', role: 'group', 'aria-label': t('pane.channels') }, channels.map(channel => h(
        'button',
        {
          key: channel.id,
          type: 'button',
          role: 'menuitem',
          className: 'mp-row',
          onClick: () => { onPick(channel) },
        },
        h('span', { className: 'mp-row-copy' },
          h('span', { className: 'mp-row-title' }, h('span', { className: 'mp-row-name' }, channel.label)),
          h('span', { className: 'mp-row-desc' }, t('channel.summary', {
            families: String(channel.families.length),
            models: String(channel.count),
          }))),
        h(Arrow),
      )));
    }

    /** Level 2 — model families (厂商族) inside one channel. */
    function FamilyPane({ channel, onPick, t }) {
      return h('div', { className: 'mp-rows', role: 'group', 'aria-label': t('pane.families') }, channel.families.map(family => h(
        'button',
        {
          key: family.id,
          type: 'button',
          role: 'menuitem',
          className: 'mp-row',
          onClick: () => { onPick(family) },
        },
        h('span', { className: 'mp-row-copy' },
          h('span', { className: 'mp-row-title' }, h('span', { className: 'mp-row-name' }, family.label))),
        h('span', { className: 'mp-row-count' }, t('family.summary', { n: String(family.models.length) })),
        h(Arrow),
      )));
    }

    /**
     * A row of `kind` buckets: models are grouped by capability inside a family
     * (Pro / Flash / Vision …) so a 12-model family still reads as a short menu.
     * Kind groups are not clickable — only models are.
     */
    function ModelPane({ models, currentBaseId, onPick, t, kindLabel }) {
      const groups = [];
      for (const entry of models) {
        const last = groups[groups.length - 1];
        if (last !== undefined && last.kind === entry.kind) last.models.push(entry);
        else groups.push({ kind: entry.kind, models: [entry] });
      }
      return h('div', { className: 'mp-rows', role: 'group', 'aria-label': t('pane.models') }, groups.flatMap(group => [
        h('div', { key: 'kind:' + group.kind, className: 'mp-kind-head' }, kindLabel(group.kind)),
        ...group.models.map(entry => {
          const selected = entry.baseId === currentBaseId;
          return h(
            'button',
            {
              key: entry.baseId,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected,
              className: 'mp-row',
              title: entry.description === undefined ? entry.name : entry.description,
              onClick: () => { onPick(entry) },
            },
            h('span', { className: 'mp-row-copy' },
              h('span', { className: 'mp-row-title' }, h('span', { className: 'mp-row-name' }, entry.name))),
            entry.efforts.length === 0
              ? null
              : h('span', { className: 'mp-row-count' }, entry.efforts.length + '×'),
            selected ? h('span', { className: 'mp-row-count' }, t('model.current')) : null,
            h(Check, { on: selected }),
          );
        }),
      ]));
    }

    /** Level 4 — reasoning efforts of the chosen model, plus the provider default. */
    function EffortPane({ entry, current, onPick, t }) {
      // Only the host's CURRENT route can mark a rung: while the user browses a
      // different model, nothing here is selected yet, so the pane shows the
      // uncollapsed ladder plus the "provider default" escape.
      const isCurrent = current !== null && current.provider !== undefined
        && splitEffort(current.model).base === entry.baseId;
      const currentEffort = isCurrent ? current.reasoningEffort : undefined;
      const effective = currentEffort ?? entry.defaultEffort;
      const rows = [];
      if (entry.defaultEffort === undefined || !isCurrent) {
        rows.push(h(
          'button',
          {
            key: 'provider-default',
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': true,
            className: 'mp-row',
            onClick: () => { onPick(undefined) },
          },
          h('span', { className: 'mp-row-copy' }, h('span', { className: 'mp-row-title' }, h('span', { className: 'mp-row-name' }, t('effort.providerDefault')))),
          h(Check, { on: !isCurrent }),
        ));
      }
      for (const effort of entry.efforts) {
        rows.push(h(
          'button',
          {
            key: 'effort:' + String(effort.effort),
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': isCurrent && effective === effort.effort,
            className: 'mp-row',
            onClick: () => { onPick(effort.effort) },
          },
          h('span', { className: 'mp-row-copy' }, h('span', { className: 'mp-row-title' },
            h('span', { className: 'mp-row-name' }, effort.name),
            isCurrent && effective === effort.effort ? h('span', { className: 'mp-kind' }, t('effort.current')) : null)),
          h(Check, { on: isCurrent && effective === effort.effort }),
        ));
      }
      return h('div', { className: 'mp-rows', role: 'group', 'aria-label': t('pane.efforts') }, rows);
    }

    /**
     * The catalog's display name for the exact selected id, before the family
     * tree can name it. Used only for the pre-load trigger label.
     * @param {Array<object>} groups raw provider groups.
     * @param {object|null} current the host-reported selection.
     * @returns {string|undefined} display name when the catalog knows the id.
     */
    function findCatalogName(groups, current) {
      if (current === null) return undefined;
      for (const group of groups) {
        if (group.id !== current.provider) continue;
        const models = Array.isArray(group.models) ? group.models : [];
        for (const model of models) {
          if (model.id === current.model) return model.name;
        }
      }
      return undefined;
    }

    /** Look up a base-model entry by provider + model id anywhere in the tree. */
    function findEntry(channels, provider, modelId) {
      const { base } = splitEffort(modelId);
      for (const channel of channels) {
        if (channel.id !== provider) continue;
        for (const family of channel.families) {
          for (const entry of family.models) {
            if (entry.baseId === base) return { channel, family, entry };
          }
        }
      }
      return null;
    }

    // ------------------------------------------------------------------------
    // 5. The seat
    // ------------------------------------------------------------------------

    /**
     * Root occupant of `conversation.input.model`.
     *
     * Props arrive from three shares, in this order of authority:
     *   - the framework's session standard kit (`sessionId`, hooks),
     *   - this entry's registered inject face (`api` resolver), and
     *   - the owner share (`locked`).
     *
     * @param {object} props merged seat props.
     * @returns {object} the trigger and, while open, the classified menu.
     */
    function ModelPicker(props) {
      const locked = props !== null && props !== undefined && props.locked === true;
      // `sessionId` comes from the framework kit; the inject face repeats it so
      // neither share alone can strand the seat without one.
      const sessionId = props !== null && props !== undefined && props.sessionId !== undefined
        ? props.sessionId
        : undefined;
      // The RPC face is resolved at RENDER time (see resolveApi): an eager
      // capture in apply can win the race against the connection handle and
      // leave a permanently dead seat.
      const api = props !== null && props !== undefined && typeof props.api === 'function'
        ? props.api()
        : resolveApi(runtime.ctx);
      const t = runtime.t;
      const kindLabel = useCallback((kind) => {
        const labels = KIND_LABELS[kind];
        if (labels === undefined) return kind;
        return runtime.lang === 'zh' ? labels.zh : labels.en;
      }, []);

      // Preferred source: the shared per-session directory service the stock
      // selector uses. It exposes the very snapshot shape rendered below.
      const directory = resolveDirectory(runtime.ctx, sessionId);
      // Availability is decided per RENDER: either transport is enough, and a
      // session is always required (the slot is strict-session scoped).
      const unavailable = sessionId === undefined || (directory === undefined && api === undefined);

      const subscribe = useCallback((listener) => {
        runtime.listeners.add(listener);
        return () => { runtime.listeners.delete(listener) };
      }, []);
      const getSnapshot = useCallback(() => runtime.state, []);
      // Both stores are subscribed unconditionally (hook order stays stable);
      // the directory wins whenever it resolved.
      const runtimeState = useSyncExternalStore(subscribe, getSnapshot);
      const directoryState = useSyncExternalStore(
        useCallback((listener) => (directory === undefined
          ? () => {}
          : directory.store.subscribe(listener)), [directory]),
        useCallback(() => (directory === undefined ? EMPTY_STATE : directory.store.getSnapshot()), [directory]),
      );
      const state = directory === undefined ? runtimeState : directoryState;
      runtime.lastTransport = directory === undefined ? 'rpc' : 'directory';

      const [open, setOpen] = useState(false);
      /** 'channels' → 'families' → 'models' → 'efforts' */
      const [pane, setPane] = useState('channels');
      const [channelId, setChannelId] = useState(null);
      const [familyId, setFamilyId] = useState(null);
      const [query, setQuery] = useState('');
      /** The model whose effort rungs the last level shows (picked, not current). */
      const [pendingEntry, setPendingEntry] = useState(null);
      /** Last rejected selection, displayed inside the menu. */
      const [selectError, setSelectError] = useState(null);
      /** Re-render pump used only while unavailable (see the revival effect). */
      const [, setReviveTick] = useState(0);
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
      const id = useId();

      const channels = useMemo(() => classifyChannels(state.groups), [state.groups]);
      const current = state.current;
      const currentBase = current === null ? null : splitEffort(current.model).base;
      const currentRoute = current === null ? null : findEntry(channels, current.provider, current.model);
      const channel = channelId === null ? null : channels.find(entry => entry.id === channelId) ?? null;
      const family = channel === null || familyId === null
        ? null
        : channel.families.find(entry => entry.id === familyId) ?? null;

      /**
       * Load the directory once per session. Keyed on the session alone — NOT on
       * the store status — so a failed load cannot loop: the error surface is the
       * menu's own Retry. A stale directory (older than REFRESH_MS) is refreshed
       * whenever the seat re-binds to a session.
       */
      useEffect(() => {
        if (sessionId === undefined) return;
        if (runtime.loadedAt !== 0 && Date.now() - runtime.loadedAt < REFRESH_MS) return;
        void loadOnce();
      }, [sessionId, directory === undefined ? 'none' : 'directory', api === undefined ? 'none' : 'api']);

      /** Close on outside click. */
      useEffect(() => {
        if (!open) return undefined;
        // Guard the global: the seat can mount where no document exists yet
        // (embedded hosts, prerender shells), where the menu still works.
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const closeOutside = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return;
          setOpen(false);
        };
        document.addEventListener('mousedown', closeOutside);
        return () => { document.removeEventListener('mousedown', closeOutside) };
      }, [open]);

      /**
       * Revival pump: while this seat cannot resolve a transport or a session,
       * it holds no live store subscription, so nothing would ever re-render it.
       * A brand-new session has no directory scope for the first frames, and
       * right after a Host restart the connection is not up yet — both must be
       * retried rather than latched. Polls fast for {@link REVIVE_WINDOW_MS},
       * then falls back to a slow heartbeat so an eventual reconnect still
       * lands without churning renders forever.
       */
      useEffect(() => {
        if (!unavailable) return undefined;
        // Guard the timer globals for embedded/prerender hosts that lack them.
        if (typeof setInterval !== 'function' || typeof clearInterval !== 'function') return undefined;
        const nudge = () => { setReviveTick(tick => tick + 1) };
        runtime.reviveListeners.add(nudge);
        let interval = setInterval(nudge, 250);
        const slowDown = typeof setTimeout === 'function'
          ? setTimeout(() => {
            clearInterval(interval);
            interval = setInterval(nudge, 3000);
          }, REVIVE_WINDOW_MS)
          : undefined;
        return () => {
          clearInterval(interval);
          if (slowDown !== undefined && typeof clearTimeout === 'function') clearTimeout(slowDown);
          runtime.reviveListeners.delete(nudge);
        };
      }, [unavailable]);

      // Report what THIS seat resolved, once per distinct seat signature. A page
      // renders one seat per session and they can disagree, so a single
      // once-per-page report could look healthy while the visible seat was grey.
      postDiagnostics(diagnosticsOf(props, runtime.ctx, directory, unavailable));

      // This seat SHADOWS the stock one, so rendering nothing leaves the
      // composer with no model control at all. When no transport resolved yet,
      // keep a REAL (clickable) chip that explains itself instead of a grey dead
      // button: the menu names the reason and offers a retry. A seat the user
      // cannot even interrogate is the worst possible failure mode here.
      if (unavailable) {
        const reason = runtime.directoryError === null || runtime.directoryError === undefined
          ? t('status.unavailable')
          : t('status.unavailableWhy', { message: String(runtime.directoryError) });
        return h(
          'div',
          { className: 'mp-root', ref: rootRef },
          h(Stylesheet),
          h('button', {
            type: 'button',
            className: 'mp-trigger',
            'aria-label': t('trigger.selectAria'),
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            title: reason,
            disabled: locked,
            onClick: () => { setOpen(!open) },
          },
            h('span', { className: 'mp-trigger-label' }, t('trigger.fallback')),
            h(Chevron, { open })),
          open && h(
            'div',
            { className: 'mp-menu', role: 'menu', 'aria-label': t('menu.aria') },
            h('div', { className: 'mp-status' }, reason),
            h('div', { className: 'mp-status' },
              h('button', {
                type: 'button',
                className: 'mp-retry',
                onClick: () => {
                  runtime.directoryError = null;
                  notifyRevive();
                  setReviveTick(tick => tick + 1);
                  if (typeof setTimeout === 'function') setTimeout(() => { setReviveTick(tick => tick + 1) }, 300);
                },
              }, t('retry'))),
          ),
        );
      }

      /**
       * Run one directory load through whichever transport resolved: the shared
       * `modelDirectories` service (preferred) or this plugin's own RPC call.
       * Declared as a function (not a `const` arrow) so the mount effect above
       * can reference it without a temporal-dead-zone trap.
       * @returns {Promise<void>} resolves after the store settles.
       */
      async function loadOnce() {
        if (directory !== undefined) {
          runtime.loadedAt = Date.now();
          try {
            await directory.load();
          } catch (error) {
            // The directory service surfaces failures on its own store; the seat
            // renders them through the shared snapshot.
          }
          return;
        }
        if (api === undefined || sessionId === undefined) return;
        await loadDirectory(api, sessionId);
      }

      /**
       * Submit one selection through whichever transport resolved.
       * @param {object} selection provider/model/effort triple.
       * @returns {Promise<boolean>} whether the host accepted it.
       */
      async function submitSelection(selection) {
        if (directory !== undefined) {
          try {
            await directory.select(selection);
            runtime.lastSelectError = null;
            return true;
          } catch (error) {
            runtime.lastSelectError = errorMessage(error);
            return false;
          }
        }
        if (api === undefined || sessionId === undefined) {
          runtime.lastSelectError = 'no transport resolved';
          return false;
        }
        return selectProvider(api, sessionId, selection);
      }

      /**
       * Open at the most useful level: straight into the current model's
       * family when the route is known, otherwise the channel list.
       */
      const show = () => {
        if (currentRoute === null) {
          setPane('channels');
          setChannelId(null);
          setFamilyId(null);
        } else {
          setPane('models');
          setChannelId(currentRoute.channel.id);
          setFamilyId(currentRoute.family.id);
        }
        setQuery('');
        setPendingEntry(null);
        setOpen(true);
        void loadOnce();
      };

      const close = (restoreFocus) => {
        setOpen(false);
        setPane('channels');
        setQuery('');
        setPendingEntry(null);
        if (restoreFocus === true && triggerRef.current !== null) {
          const trigger = triggerRef.current;
          queueMicrotask(() => { trigger.focus() });
        }
      };

      /** Choose a base model: enter its effort level, or submit the default. */
      const chooseModel = (entry) => {
        if (entry.efforts.length === 0) {
          void submit(entry.modelId, undefined);
          return;
        }
        // Pin the picked model: the effort level and the eventual submission
        // both read THIS entry, not the host's still-unmoved current selection.
        setPendingEntry(entry);
        setPane('efforts');
      };

      /**
       * Submit one provider/model/effort triple through the resolved transport.
       * A rejected selection MUST be visible: silently returning leaves the menu
       * looking inert ("cannot switch models") with no explanation, and the
       * failure text is also the only way to diagnose it off-machine.
       */
      const submit = async (modelId, reasoningEffort) => {
        const route = channel === null ? null : channel.id;
        if (route === null) {
          setSelectError('no channel resolved');
          return;
        }
        const selection = {
          provider: route,
          model: modelId,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
        };
        setSelectError(null);
        const accepted = await submitSelection(selection);
        if (accepted) {
          reportSubmit(selection, null);
          close(true);
          return;
        }
        const message = runtime.lastSelectError === null || runtime.lastSelectError === undefined
          ? t('error.selectFailed')
          : t('error.selectFailedWhy', { message: String(runtime.lastSelectError) });
        setSelectError(message);
        reportSubmit(selection, runtime.lastSelectError);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          if (pane === 'efforts') { setPane('models'); return }
          if (pane === 'models' && family !== null) { setPane('families'); return }
          if (pane === 'families') { setPane('channels'); return }
          close(true);
        }
      };

      const busy = state.status === 'selecting';
      // Before the directory resolves there is no family to name the model, so
      // fall back to the catalog's own display name for the exact id — never a
      // raw provider id, which is what the stock seat showed.
      const rawLabel = current === null ? t('trigger.fallback') : findCatalogName(state.groups, current) ?? current.model;
      const modelLabel = currentRoute === null
        ? (current === null ? t('trigger.fallback') : rawLabel)
        : currentRoute.entry.name;
      const effortValue = current === null ? undefined : current.reasoningEffort;
      const effortLabel = effortValue === undefined
        ? undefined
        : (currentRoute === null
          ? effortValue
          : currentRoute.entry.efforts.find(effort => effort.effort === effortValue)?.name ?? effortValue);
      const triggerAria = currentRoute === null
        ? (current === null ? t('trigger.selectAria') : t('trigger.aria', { model: modelLabel }))
        : effortLabel === undefined
          ? t('trigger.aria', { model: modelLabel })
          : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel });

      const crumbs = [];
      crumbs.push(h(Crumb, {
        key: 'channel',
        label: channel === null ? t('crumb.channel') : channel.label,
        onClick: pane === 'channels' ? undefined : () => {
          setPane('channels');
          setChannelId(null);
          setFamilyId(null);
          setQuery('');
        },
      }));
      if (channel !== null && pane !== 'channels') {
        crumbs.push(h('span', { key: 'sep-1', className: 'mp-crumb-sep', 'aria-hidden': 'true' }, '/'));
        crumbs.push(h(Crumb, {
          key: 'family',
          label: family === null ? t('crumb.family') : family.label,
          onClick: pane === 'families' || family === null ? undefined : () => {
            setPane('families');
            setFamilyId(null);
            setQuery('');
          },
        }));
      }
      if (family !== null && (pane === 'models' || pane === 'efforts')) {
        crumbs.push(h('span', { key: 'sep-2', className: 'mp-crumb-sep', 'aria-hidden': 'true' }, '/'));
        crumbs.push(h(Crumb, {
          key: 'model',
          label: t('crumb.model'),
          onClick: pane === 'models' ? undefined : () => { setPane('models') },
        }));
      }
      if (pane === 'efforts') {
        crumbs.push(h('span', { key: 'sep-3', className: 'mp-crumb-sep', 'aria-hidden': 'true' }, '/'));
        crumbs.push(h(Crumb, { key: 'effort', label: t('crumb.effort') }));
      }

      const filtered = family === null || query === ''
        ? (family === null ? [] : family.models)
        : family.models.filter(entry => matchesQuery(entry, query));

      let body;
      if (pane === 'channels') {
        body = channels.length === 0
          ? h('div', { className: 'mp-empty' }, t('empty.models'))
          : h(ChannelPane, {
            channels,
            t,
            onPick: (picked) => {
              setChannelId(picked.id);
              setPane('families');
            },
          });
      } else if (pane === 'families') {
        body = h(FamilyPane, {
          channel,
          t,
          onPick: (picked) => {
            setFamilyId(picked.id);
            setPane('models');
          },
        });
      } else if (pane === 'models') {
        body = [
          h('div', { key: 'search', className: 'mp-search' }, h('input', {
            type: 'text',
            value: query,
            placeholder: t('search.placeholder'),
            'aria-label': t('search.placeholder'),
            onChange: (event) => { setQuery(event.target.value) },
          })),
          filtered.length === 0
            ? h('div', { key: 'empty', className: 'mp-empty' }, query === '' ? t('empty.models') : t('empty.search'))
            : h(ModelPane, {
              key: 'list',
              models: filtered,
              currentBaseId: currentBase,
              t,
              kindLabel,
              onPick: chooseModel,
            }),
        ];
      } else {
        // The effort pane belongs to the model EXPLICITLY picked on the model
        // level — never to the host's current selection, which does not move
        // while the menu is open. Falling back to `current` here is what once
        // made "pick Flash, then high" submit the previously-current Pro twin.
        const entry = pendingEntry
          ?? (family.models.find(candidate => candidate.baseId === currentBase) ?? family.models[0]);
        body = entry === undefined
          ? h('div', { className: 'mp-empty' }, t('empty.efforts'))
          : h(EffortPane, {
            entry,
            current,
            t,
            onPick: (effort) => {
              const rung = entry.efforts.find(candidate => candidate.effort === effort);
              // A rung whose modelId IS the catalog twin (`model:high`) already
              // encodes the effort in the model id — that row carries no
              // `reasoning` metadata, so sending `reasoningEffort` alongside it
              // asks the host to apply an effort the model does not declare.
              // Only rungs that fall back to the BASE id need the effort field.
              const rungModelId = rung === undefined ? entry.modelId : rung.modelId;
              const effortBelongsInField = rungModelId === entry.baseId;
              void submit(rungModelId, effortBelongsInField ? effort : undefined);
            },
          });
      }

      return h(
        'div',
        { ref: rootRef, className: 'mp-root', onKeyDown },
        h(Stylesheet),
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'mp-trigger',
          'aria-label': triggerAria,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? id + '-menu' : undefined,
          title: effortLabel === undefined ? modelLabel : modelLabel + ' · ' + effortLabel,
          disabled: locked,
          onClick: () => { if (open) close(false); else show() },
        },
          h('span', { className: 'mp-trigger-label' }, modelLabel),
          effortLabel === undefined ? null : h('span', { className: 'mp-trigger-effort' }, effortLabel),
          h(Chevron, { open })),
        open && h(
          'div',
          {
            id: id + '-menu',
            className: 'mp-menu',
            role: 'menu',
            'aria-label': t('menu.aria'),
            'aria-busy': state.status === 'loading' || busy,
          },
          h('div', { className: 'mp-crumbs' }, crumbs),
          // A rejected selection is the one failure the user just caused and
          // must see immediately, above any ambient load status.
          selectError !== null && h('div', { className: 'mp-error', role: 'alert' },
            h('span', { className: 'mp-error-detail' }, selectError)),
          state.status === 'loading' && h('div', { className: 'mp-status' }, t('status.loading')),
          state.error !== null && h('div', { className: 'mp-error' },
            h('span', { className: 'mp-error-detail' }, t('error.action', { message: state.error })),
            h('button', { type: 'button', className: 'mp-retry', onClick: () => { void loadOnce() } }, t('retry'))),
          state.failures.map(failure => h('div', { className: 'mp-warning', key: failure.id },
            h('span', null, t('warning.groupLoad', { name: failure.name, message: failure.message })),
            h('button', { type: 'button', className: 'mp-retry', onClick: () => { void loadOnce() } }, t('retry')))),
          body,
        ),
      );
    }

    // ------------------------------------------------------------------------
    // 6. Module export
    // ------------------------------------------------------------------------

    /**
     * Register the composer seat.
     *
     * Two boot-safety rules learned the hard way — violating either took the
     * whole Web client down, not just this plugin:
     *
     * 1. `conversation.input.model` is a SINGLE slot. The stock
     *    `@deepseek-ai/dsh-client-ui-model-selection` occupies it at the
     *    default priority 0, and a second registration at the SAME priority
     *    throws "already has a registration". Slot occupancy only clashes at
     *    an exact priority, so registering LOWER (lowest renders) shadows it
     *    cleanly and is reversible by simply removing this plugin.
     * 2. `apply` never throws outward. A plugin failure must degrade to "no
     *    custom seat" (the stock one keeps rendering), never to a blank page.
     *
     * @param {object} ctx browser plugin context.
     */
    function apply(ctx) {
      try {
        runtime.ctx = ctx;
        runtime.t = ctx.locale.bind(NS);
        runtime.lang = typeof ctx.locale.current === 'function' ? ctx.locale.current() : runtime.lang;
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'model-picker: dict-en');
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'model-picker: dict-zh');
        ctx.effect(() => () => {
          runtime.listeners.clear();
          runtime.reviveListeners.clear();
        }, 'model-picker: state');
        // A re-established connection is exactly when an unavailable seat can
        // become usable again: poke them all instead of waiting for the timer.
        if (typeof ctx.on === 'function') {
          ctx.effect(() => ctx.on('connection/reset', notifyRevive), 'model-picker: connection revive');
        }
        // Install the seat once the transports are injectable. `modelDirectories`
        // and `remote.session` are required because the directory methods are
        // TRACED to this context: calling directoryFor() without them throws
        // "cannot get property ... without inject".
        ctx.inject(['connection', 'modelDirectories', 'remote.commands', 'remote.session', 'slots'], (scope) => {
          try {
            scope.slots.inject('conversation.input.model', () => scope.slots.register({
              name: 'conversation.input.model',
              locale: NS,
              // Shadow the stock seat instead of colliding with it at priority 0.
              priority: -1,
              // The inject face is invoked per session with that session's id;
              // `api` is a RESOLVER so a handle arriving later still works.
              inject: (sessionId) => ({
                sessionId,
                api: () => resolveApi(scope),
              }),
            }, ModelPicker));
          } catch (error) {
            // The stock selector keeps the seat; this plugin just stays idle.
            if (ctx.logger && typeof ctx.logger.warn === 'function') {
              ctx.logger.warn('model-picker: seat registration failed', error);
            }
          }
        });
      } catch (error) {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn('model-picker: apply failed', error);
        }
      }
    }

    return {
      // `modelDirectories` is the preferred transport and must be injectable for
      // its property accessor to exist on this ctx. It ships with the stock
      // selector, so it is present whenever the seat it replaces is.
      //
      // `remote.session` is NOT optional: cordis traces a service method call to
      // the CALLER's context, and ModelDirectoryResolver.directoryFor() reaches
      // `remote.session` through the session runtime. Without this inject the
      // call throws "cannot get property \"remote.session\" without inject" —
      // which is exactly why every seat rendered as unavailable.
      inject: ['connection', 'locale', 'modelDirectories', 'remote.commands', 'remote.session', 'slots'],
      apply,
    };
  },
});
