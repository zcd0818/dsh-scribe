/**
 * Settings page for the memory plugin.
 *
 * Renders inside the host's `settings.section` slot as one page in Settings.
 * Everything the page shows comes from the plugin's own local route
 * (`/dsh-scribe/api/...`); the page owns no state that matters — the profile
 * patch, the store, and the migration journal are the sources of truth.
 *
 * Style follows the host: only `--dsw-alias-*` tokens, no literal colors, no
 * import of Harness Client packages (a throwing import would blank the slot).
 */
window.__ModuleLoader__.load({
  id: 'dsh-scribe',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const API = '/dsh-scribe/api'

    /** Blank form state derived from the effective config. */
    function initialDraft(effective) {
      const providers = effective.providers || {}
      const local = providers.local || {}
      const bailian = providers.bailian || {}
      const hybrid = providers.hybrid || {}
      const retrieval = effective.retrieval || {}
      const summarization = effective.summarization || {}
      const retention = effective.retention || {}
      const embedding = effective.embedding || {}
      return {
        defaultProvider: effective.defaultProvider || 'local',
        autoInject: effective.autoInject !== false,
        autoSave: effective.autoSave !== false,
        injectLimit: effective.injectLimit || 5,
        injectMaxChars: effective.injectMaxChars || 1200,
        localPath: local.path || '~/.dsh/memory',
        localEngine: local.engine || 'file',
        localUrl: local.url || '',
        bailianWorkspaceId: bailian.workspaceId || '',
        bailianRegion: bailian.region || 'cn-beijing',
        bailianUserId: bailian.userId || 'dsh',
        bailianLibraryId: bailian.memoryLibraryId || '',
        bailianPlanVersion: bailian.planVersion || 'pro',
        bailianEndpoint: bailian.endpoint || '',
        bailianApiKey: '',
        useHybrid: Boolean(providers.hybrid),
        hybridPrimary: hybrid.primary || 'bailian',
        hybridMirror: hybrid.mirror || 'local',
        retrievalMode: retrieval.mode || 'hybrid',
        minScore: retrieval.minScore ?? 0.18,
        llmRerank: retrieval.llmRerank !== false,
        shortTurns: summarization.shortTurns ?? 10,
        maxMemories: retention.maxMemories ?? 5000,
        embeddingEndpoint: embedding.endpoint || '',
        embeddingModel: embedding.model || 'text-embedding-v3',
        embeddingApiKey: '',
      }
    }

    const CSS = `
.dsh-mem { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 1040px;
  margin: 0 auto; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.55;
  font-variant-numeric: tabular-nums; }
.dsh-mem-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dsh-mem-title { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: .01em; }
.dsh-mem-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; margin: 4px 0 0; }
.dsh-mem-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-mem-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 8px 8px 0 0; cursor: pointer;
  box-shadow: inset 0 -2px 0 transparent; transition: color .12s ease, box-shadow .12s ease; }
.dsh-mem-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-mem-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); }
.dsh-mem-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.dsh-mem-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 20px; }
.dsh-mem-card h3 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.dsh-mem-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.65; margin: 0; }
.dsh-mem-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 18px; }
.dsh-mem-toggles { display: flex; flex-wrap: wrap; gap: 10px 28px; }
.dsh-mem-subhead { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .01em; }
/* Card actions that belong to the title (refresh) sit beside it; a control at
   the far right of a wide header reads as unrelated to the card. */
.dsh-mem-titlegroup { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dsh-mem-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-mem-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-mem-label { color: var(--dsw-alias-label-secondary); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.dsh-mem-input, .dsh-mem-select { font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  height: 30px; padding: 0 10px; min-width: 0; box-sizing: border-box; }
.dsh-mem-select { padding-right: 6px; }
.dsh-mem-input:focus-visible, .dsh-mem-select:focus-visible, .dsh-mem-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
/* Label inline with its controls: a control sitting inside a stacked label
   would centre the sibling button against the label's height, not the input. */
.dsh-mem-fieldrow { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 14px; align-items: center; }
.dsh-mem-fieldrow-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-mem-fieldrow-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.dsh-mem-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 2px 0; }
.dsh-mem-btn { font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 8px; height: 28px;
  padding: 0 12px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; white-space: nowrap; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-mem-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-mem-btn:disabled { opacity: .5; cursor: default; }
.dsh-mem-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-bg-base); font-weight: 600; }
.dsh-mem-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-mem-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsh-mem-btn-quiet { background: transparent; }
.dsh-mem-rows { display: flex; flex-direction: column; }
/* Both the header and the rows take their tracks from this one class, so the
   two can never drift apart. Minimums stay small enough for the settings modal. */
/* Each row is its own grid, so every track must be independent of content:
   an auto track would size to the header's short label in one grid and to the
   buttons in the next, shifting every column after it. The final track is a
   fixed width for that reason. Middle columns are centred so the header sits
   over its content. */
.dsh-mem-rowgrid { display: grid; grid-template-columns: minmax(140px, 1.6fr) minmax(92px, .9fr)
  minmax(96px, .9fr) 208px; gap: 12px; align-items: center; }
.dsh-mem-rowgrid-mig { display: grid; grid-template-columns: minmax(120px, .9fr) minmax(140px, 1fr)
  minmax(120px, .9fr) 104px; gap: 12px; align-items: center; }
.dsh-mem-rowhead { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; padding-bottom: 6px; }
.dsh-mem-rowhead > span:nth-child(2), .dsh-mem-rowhead > span:nth-child(3) { text-align: center; }
.dsh-mem-rowhead > span:last-child { text-align: right; }
.dsh-mem-rowline > .dsh-mem-rowline-cell { text-align: center; }
.dsh-mem-rowline { padding: 11px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-mem-rowline:first-child { border-top: 0; padding-top: 0; }
.dsh-mem-rowline:last-child { padding-bottom: 0; }
.dsh-mem-rowline-main { min-width: 0; }
.dsh-mem-rowline-title { font-weight: 500; overflow-wrap: anywhere; }
.dsh-mem-rowline-sub { color: var(--dsw-alias-label-tertiary); font-size: 11.5px; margin-top: 2px; overflow-wrap: anywhere; }
.dsh-mem-rowline-cell { min-width: 0; }
.dsh-mem-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 10px; }
.dsh-mem-pill-muted { color: var(--dsw-alias-label-tertiary); background: transparent; border-style: dashed; }
.dsh-mem-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.dsh-mem-kv { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 9px 18px; margin: 0; align-items: baseline; }
.dsh-mem-kv dt { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-mem-kv dd { margin: 0; overflow-wrap: anywhere; font-size: 12.5px; }
.dsh-mem-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.dsh-mem-note { border-radius: 10px; padding: 9px 12px; font-size: 12px; line-height: 1.6;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.dsh-mem-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsh-mem-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.dsh-mem-note[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dsh-mem-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  background: var(--dsw-alias-markdown-code-block); border-radius: 6px; padding: 1px 6px; }
.dsh-mem-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; }
.dsh-mem-bar > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .2s ease; }
.dsh-mem-file { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dsh-mem-sample { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin: 0; padding-left: 18px; }
.dsh-mem-check { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
.dsh-mem-check input { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.dsh-mem-select-narrow { max-width: 320px; }
.dsh-mem-drop { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
  border: 1.5px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 22px 18px 20px;
  background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: border-color .14s ease, background .14s ease; }
.dsh-mem-drop:hover, .dsh-mem-drop[data-active="true"] { border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover); }
.dsh-mem-drop-icon { width: 26px; height: 26px; color: var(--dsw-alias-label-secondary); }
.dsh-mem-drop[data-active="true"] .dsh-mem-drop-icon { color: var(--dsw-alias-brand-primary); }
.dsh-mem-drop-title { font-size: 13px; font-weight: 500; }
.dsh-mem-drop-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); line-height: 1.6; max-width: 60ch; }
.dsh-mem-chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: 640px; }
.dsh-mem-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); }
.dsh-mem-chips-more { color: var(--dsw-alias-label-tertiary); }
.dsh-mem-drop-active { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
`

    /** Panel id shared by the sidebar row and its keyed `main` page. */
    const PANEL_ID = 'dsh-scribe'

    /**
     * Sidebar contribution state.
     *
     * The row and its page are registered through `slots.inject`, which fires
     * only once the shell declares the seat — so the shell owns the row box,
     * the label, the active highlight and the panel switch. The user can turn
     * the row off from Settings without a reload: the same module owns both
     * registrations, so the toggle mounts/unmounts them in place.
     */
    const panel = { mounted: false, disposers: [] }
    let clientCtx

    function mountPanel() {
      if (panel.mounted || clientCtx === undefined) return
      const slots = clientCtx.slots
      if (slots === undefined) return
      panel.mounted = true
      try {
        panel.disposers.push(
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: () => '记忆与知识库' }, MemoryPanelIcon),
          ),
        )
        panel.disposers.push(
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, MemoryMainPanel)),
        )
      } catch (error) {
        panel.mounted = false
        console.error('[dsh-scribe] sidebar registration failed', error)
      }
    }

    function unmountPanel() {
      for (const dispose of panel.disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* a shell-owned seat may already be gone */
        }
      }
      panel.mounted = false
    }

    /** The sidebar row glyph: the shell owns geometry, this draws the mark. */
    function MemoryPanelIcon({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3 3.2h6.2a2.3 2.3 0 0 1 2.3 2.3v7.3H5.3A2.3 2.3 0 0 1 3 10.5z' }),
        h('path', { d: 'M5.4 6.1h4.4M5.4 8.4h4.4' }),
        h('path', { d: 'M12.4 5.2v7.6' }),
      )
    }

    /** The keyed `main` page: the same sections, rendered as a first-class page. */
    function MemoryMainPanel(props) {
      return h(
        'div',
        { style: { padding: '16px 20px 28px', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } },
        h(MemorySettingsPage, { ...props, ui: panelApi }),
      )
    }

    const panelApi = {
      get on() {
        return panel.mounted
      },
      async set(enabled) {
        if (enabled) mountPanel()
        else unmountPanel()
        try {
          await request('/config', { method: 'POST', body: { patch: { ui: { sidebar: enabled } } } })
        } catch (error) {
          console.error('[dsh-scribe] saving sidebar preference failed', error)
        }
      },
    }

    /** fetch helper: same-origin JSON with a readable error. */
    async function request(path, options) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: options && options.body ? { 'content-type': 'application/json' } : undefined,
        ...options,
        body: options && options.body ? JSON.stringify(options.body) : undefined,
      })
      const text = await response.text()
      let payload
      try {
        payload = text.length === 0 ? {} : JSON.parse(text)
      } catch {
        throw new Error(`接口返回不是 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    const tone = (kind) =>
      kind === 'ok' ? 'var(--dsw-alias-state-success-primary)'
        : kind === 'error' ? 'var(--dsw-alias-state-error-primary)'
        : kind === 'warn' ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-state-idle-primary)'

    function Note({ kind = 'info', children }) {
      const dataTone = kind === 'ok' || kind === 'error' || kind === 'warn' ? kind : undefined
      return h('div', { className: 'dsh-mem-note', ...(dataTone ? { 'data-tone': dataTone } : {}), role: kind === 'error' ? 'alert' : 'status' }, children)
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { className: 'dsh-mem-field' },
        h('span', { className: 'dsh-mem-label' }, label),
        children,
        hint ? h('span', { className: 'dsh-mem-hint' }, hint) : null,
      )
    }

    function Toggle({ label, checked, onChange }) {
      return h(
        'label',
        { className: 'dsh-mem-check' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(checked),
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'dsh-mem-label', style: { color: 'var(--dsw-alias-label-primary)' } }, label),
      )
    }

    function Overview({ data, onRefresh, busy, ui }) {
      const status = data.status || {}
      const rows = [
        ['后端', `${status.provider}（${status.type}）`],
        ['记忆条数', String(status.count ?? 0)],
        ['时间范围', status.oldest ? `${status.oldest} 至 ${status.newest}` : '—'],
        ['嵌入', status.embedding === 'enabled' ? '语义检索' : '词法检索'],
        ['自动注入', status.autoInject ? '开启' : '关闭'],
        ['数据目录', data.dataDir || '—'],
        ['配置来源', data.config?.source === 'profile-patch' ? 'profile patch' : '默认值'],
      ]
      return h(
        'div',
        { className: 'dsh-mem', style: { gap: '14px' } },
        h(
          'div',
          { className: 'dsh-mem-card' },
          h(
            'div',
            { className: 'dsh-mem-card-head' },
            h(
              'div',
              { className: 'dsh-mem-titlegroup' },
              h('h3', null, '运行状态'),
              h('button', { className: 'dsh-mem-btn dsh-mem-btn-quiet', onClick: onRefresh, disabled: busy }, busy ? '刷新中…' : '刷新'),
            ),
            h(
              'span',
              { className: 'dsh-mem-status' },
              '可用性',
              h('span', { className: 'dsh-mem-dot', style: { background: status.health ? tone('ok') : tone('error') } }),
              status.health ? '正常' : '不可达',
            ),
          ),
          h(
            'dl',
            { className: 'dsh-mem-kv' },
            rows.map(([key, value]) => h('div', { key, style: { display: 'contents' } }, h('dt', null, key), h('dd', null, value))),
          ),
        ),
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '界面入口'),
          h(
            'label',
            { className: 'dsh-mem-check' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(ui && ui.on),
              onChange: (event) => ui && ui.set(event.target.checked),
            }),
            h('span', null, '在主页左侧菜单栏显示「记忆与知识库」'),
          ),
          h(
            'p',
            { className: 'dsh-mem-hint' },
            '开启后以独立页面出现在左侧菜单栏；关闭仅隐藏入口。修改立即生效，无需重启。',
          ),
        ),
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '数据边界'),
          h(
            'p',
            { className: 'dsh-mem-hint' },
            '此页编辑本机 profile 的配置，保存后插件即时重载。记忆的落点由所选后端决定：',
            h('span', { className: 'dsh-mem-code' }, 'local'),
            ' 仅写本机文件，不产生任何网络请求。',
          ),
          h(
            'p',
            { className: 'dsh-mem-hint' },
            '需要跨设备共享时，在「记忆」页配置后端。切换后端不会搬运既有数据；迁移需在「数据迁移」中显式确认。',
          ),
        ),
      )
    }

    /**
     * Memory settings, grouped by concern:
     * storage → local implementation → cloud implementation → retrieval → summary/retention.
     *
     * The old single "cloud & retrieval" tab mixed three decisions (where data
     * lives, how credentials are set, how recall behaves); splitting them by
     * concern is what makes the page scannable instead of a wall of fields.
     */
    function MemoryTab({ data, onSaved }) {
      const effective = (data.config && data.config.effective) || {}
      const providers = effective.providers || {}
      const [draft, setDraft] = useState(() => initialDraft(effective))
      const [status, setStatus] = useState(undefined)
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(undefined)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(undefined)

      useEffect(() => {
        setDraft(initialDraft(effective))
      }, [effective.defaultProvider, effective.providers && Object.keys(effective.providers).join(','), effective.retrieval && effective.retrieval.mode])

      const patch = useCallback(() => {
        const out = {
          defaultProvider: draft.defaultProvider,
          autoInject: draft.autoInject,
          autoSave: draft.autoSave,
          injectLimit: Number(draft.injectLimit),
          injectMaxChars: Number(draft.injectMaxChars),
          providers: {},
          retrieval: { mode: draft.retrievalMode, llmRerank: draft.llmRerank, minScore: Number(draft.minScore) },
          summarization: { shortTurns: Number(draft.shortTurns) },
          retention: { maxMemories: Number(draft.maxMemories) },
        }
        const local = { path: draft.localPath }
        if (draft.localEngine === 'chromadb') {
          local.engine = 'chromadb'
          if (draft.localUrl) local.url = draft.localUrl
        } else local.engine = 'file'
        out.providers.local = local

        const bailian = {
          workspaceId: draft.bailianWorkspaceId,
          region: draft.bailianRegion,
          userId: draft.bailianUserId,
          memoryLibraryId: draft.bailianLibraryId,
          planVersion: draft.bailianPlanVersion,
          ...(draft.bailianEndpoint ? { endpoint: draft.bailianEndpoint } : {}),
        }
        // An empty key field means "keep what is stored".
        if (draft.bailianApiKey) bailian.apiKey = draft.bailianApiKey
        out.providers.bailian = bailian

        if (draft.defaultProvider === 'hybrid' || draft.useHybrid) {
          out.providers.hybrid = { type: 'hybrid', primary: draft.hybridPrimary, mirror: draft.hybridMirror }
        }
        if (draft.embeddingEndpoint) {
          out.embedding = { endpoint: draft.embeddingEndpoint, model: draft.embeddingModel }
          if (draft.embeddingApiKey) out.embedding.apiKey = draft.embeddingApiKey
        }
        return out
      }, [draft])

      const save = async () => {
        setSaving(true)
        setError(undefined)
        try {
          await request('/config', { method: 'POST', body: { patch: patch() } })
          setStatus({ kind: 'ok', text: '已保存，插件正在重新挂载；稍后状态会刷新。' })
          setTimeout(() => onSaved && onSaved(), 900)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setSaving(false)
        }
      }

      const test = async () => {
        setTesting(true)
        setTestResult(undefined)
        try {
          const result = await request('/test', { method: 'POST', body: { provider: draft.defaultProvider } })
          setTestResult(result)
        } catch (problem) {
          setTestResult({ ok: false, error: problem.message })
        } finally {
          setTesting(false)
        }
      }

      const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }))
      const setBool = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }))

      const providerIds = ['local', 'bailian', 'hybrid']

      return h(
        'div',
        { className: 'dsh-mem' },
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '记忆后端'),
          h('p', { className: 'dsh-mem-hint' }, '决定新记忆写入何处。切换后端不会搬运既有数据；迁移在「数据迁移」中显式确认。'),
          h(
            'div',
            { className: 'dsh-mem-fieldrow' },
            h('span', { className: 'dsh-mem-fieldrow-label' }, '写入位置'),
            h(
              'div',
              { className: 'dsh-mem-fieldrow-controls' },
              h(
                'select',
                { className: 'dsh-mem-select dsh-mem-select-narrow', value: draft.defaultProvider, onChange: set('defaultProvider'), 'aria-label': '写入位置' },
                providerIds.map((id) => h('option', { key: id, value: id }, `${id}${providers[id] ? `（${providers[id].type}）` : ''}`)),
              ),
            ),
          ),
          h('div', { className: 'dsh-mem-divider' }),
          h(
            'div',
            { className: 'dsh-mem-toggles' },
            h(Toggle, { label: '会话开始注入记忆', checked: draft.autoInject, onChange: setBool('autoInject') }),
            h(Toggle, { label: '会话结束写入记忆', checked: draft.autoSave, onChange: setBool('autoSave') }),
          ),
          h(
            'div',
            { className: 'dsh-mem-grid' },
            h(Field, { label: '注入条数', hint: '单次注入的记忆条数上限。' }, h('input', { className: 'dsh-mem-input', type: 'number', min: 1, max: 20, value: draft.injectLimit, onChange: set('injectLimit') })),
            h(Field, { label: '注入字符', hint: '注入段落的总字符上限。' }, h('input', { className: 'dsh-mem-input', type: 'number', min: 200, max: 8000, value: draft.injectMaxChars, onChange: set('injectMaxChars') })),
          ),
        ),
        draft.defaultProvider === 'local' || draft.defaultProvider === 'hybrid'
          ? h(
              'div',
              { className: 'dsh-mem-card' },
              h('h3', null, '本机存储'),
              h(
                'div',
                { className: 'dsh-mem-grid' },
                h(Field, { label: '数据目录' }, h('input', { className: 'dsh-mem-input', value: draft.localPath, onChange: set('localPath'), spellCheck: false })),
                h(
                  Field,
                  { label: '引擎', hint: 'chromadb 需自备服务端与依赖；file 为默认实现，零依赖。' },
                  h(
                    'select',
                    { className: 'dsh-mem-select', value: draft.localEngine, onChange: set('localEngine') },
                    h('option', { value: 'file' }, 'file（零依赖）'),
                    h('option', { value: 'chromadb' }, 'chromadb（自建服务）'),
                  ),
                ),
                draft.localEngine === 'chromadb'
                  ? h(Field, { label: 'Chroma 服务地址' }, h('input', { className: 'dsh-mem-input', value: draft.localUrl, onChange: set('localUrl'), placeholder: 'http://localhost:8000' }))
                  : null,
              ),
            )
          : null,
        draft.defaultProvider === 'bailian' || draft.defaultProvider === 'hybrid'
          ? h(
              'div',
              { className: 'dsh-mem-card' },
              h('h3', null, '阿里云百炼记忆库'),
              h(
                'p',
                { className: 'dsh-mem-hint' },
                '业务空间 ID 与控制台 API Host 一致，形如 llm-xxxxxxxxxxxx。API Key 仅写入、不回显；留空表示保持当前值。',
              ),
              h(
                'div',
                { className: 'dsh-mem-grid' },
                h(Field, { label: '业务空间 ID' }, h('input', { className: 'dsh-mem-input', value: draft.bailianWorkspaceId, onChange: set('bailianWorkspaceId'), spellCheck: false, placeholder: 'llm-xxxxxxxxxxxx' })),
                h(
                  Field,
                  { label: 'API Key' + (providers.bailian && providers.bailian.hasApiKey ? '（已保存）' : '') },
                  h('input', {
                    className: 'dsh-mem-input',
                    type: 'password',
                    value: draft.bailianApiKey,
                    onChange: set('bailianApiKey'),
                    placeholder: providers.bailian && providers.bailian.hasApiKey ? '••••••••（留空保持不变）' : 'sk-...',
                    autoComplete: 'off',
                  }),
                ),
                h(Field, { label: '记忆隔离键', hint: '百炼用于隔离记忆的键，非账号 ID。' }, h('input', { className: 'dsh-mem-input', value: draft.bailianUserId, onChange: set('bailianUserId') })),
                h(Field, { label: '记忆库 ID', hint: '留空使用默认记忆库。' }, h('input', { className: 'dsh-mem-input', value: draft.bailianLibraryId, onChange: set('bailianLibraryId'), spellCheck: false })),
                h(Field, { label: '地域' }, h('input', { className: 'dsh-mem-input', value: draft.bailianRegion, onChange: set('bailianRegion') })),
                h(
                  Field,
                  { label: '计费计划', hint: 'pro 支持相似度阈值过滤。' },
                  h('select', { className: 'dsh-mem-select', value: draft.bailianPlanVersion, onChange: set('bailianPlanVersion') },
                    h('option', { value: 'pro' }, 'pro'),
                    h('option', { value: 'lite' }, 'lite'),
                  ),
                ),
                draft.defaultProvider === 'hybrid'
                  ? h(Field, { label: 'hybrid 主后端' }, h('select', { className: 'dsh-mem-select', value: draft.hybridPrimary, onChange: set('hybridPrimary') }, ['bailian', 'local'].map((id) => h('option', { key: id, value: id }, id))))
                  : null,
                draft.defaultProvider === 'hybrid'
                  ? h(Field, { label: 'hybrid 镜像' }, h('select', { className: 'dsh-mem-select', value: draft.hybridMirror, onChange: set('hybridMirror') }, h('option', { value: 'local' }, 'local')))
                  : null,
              ),
            )
          : null,
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '检索'),
          h('p', { className: 'dsh-mem-hint' }, '决定记忆如何被召回。未配置嵌入端点时按词法打分；重排只在候选多于目标条数时发生。'),
          h(
            'div',
            { className: 'dsh-mem-toggles' },
            h(Toggle, { label: '以会话模型重排候选', checked: draft.llmRerank, onChange: setBool('llmRerank') }),
          ),
          h('div', { className: 'dsh-mem-divider' }),
          h('div', { className: 'dsh-mem-subhead' }, '检索策略'),
          h(
            'div',
            { className: 'dsh-mem-grid' },
            h(
              Field,
              { label: '检索模式', hint: '未配置嵌入端点时，hybrid 等价于 lexical。' },
              h('select', { className: 'dsh-mem-select', value: draft.retrievalMode, onChange: set('retrievalMode') },
                ['hybrid', 'lexical', 'recent', 'vector'].map((id) => h('option', { key: id, value: id }, id)),
              ),
            ),
            h(Field, { label: '相似度阈值' }, h('input', { className: 'dsh-mem-input', type: 'number', step: '0.01', min: 0, max: 1, value: draft.minScore, onChange: set('minScore') })),
          ),
          h('div', { className: 'dsh-mem-divider' }),
          h('div', { className: 'dsh-mem-subhead' }, '语义嵌入（可选）'),
          h(
            'div',
            { className: 'dsh-mem-grid' },
            h(Field, { label: '嵌入端点', hint: 'OpenAI 兼容的 /v1/embeddings 地址；配置后启用语义检索。' }, h('input', { className: 'dsh-mem-input', value: draft.embeddingEndpoint, onChange: set('embeddingEndpoint'), placeholder: 'https://api.example.com/v1', spellCheck: false })),
            h(Field, { label: '嵌入模型' }, h('input', { className: 'dsh-mem-input', value: draft.embeddingModel, onChange: set('embeddingModel'), spellCheck: false })),
            h(Field, { label: '嵌入 API Key' }, h('input', { className: 'dsh-mem-input', type: 'password', value: draft.embeddingApiKey, onChange: set('embeddingApiKey'), placeholder: '留空保持不变', autoComplete: 'off' })),
          ),
        ),
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '会话摘要与留存'),
          h(
            'div',
            { className: 'dsh-mem-grid' },
            h(Field, { label: '摘要阈值（用户轮数）', hint: '不超过该轮数保留对话尾段，超过则交由会话模型总结。' }, h('input', { className: 'dsh-mem-input', type: 'number', min: 1, max: 100, value: draft.shortTurns, onChange: set('shortTurns') })),
            h(Field, { label: '记忆留存上限', hint: '超出后按时间淘汰最旧的记录。' }, h('input', { className: 'dsh-mem-input', type: 'number', min: 100, max: 100000, value: draft.maxMemories, onChange: set('maxMemories') })),
          ),
        ),
        h(
          'div',
          { className: 'dsh-mem-actions', style: { justifyContent: 'flex-start' } },
          h('button', { className: 'dsh-mem-btn dsh-mem-btn-primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存配置'),
          h('button', { className: 'dsh-mem-btn', onClick: test, disabled: testing }, testing ? '测试中…' : '测试当前后端'),
        ),
        status ? h(Note, { kind: 'ok' }, status.text) : null,
        error ? h(Note, { kind: 'error' }, error) : null,
        testResult
          ? h(
              Note,
              { kind: testResult.ok ? 'ok' : 'error' },
              testResult.ok
                ? `后端 ${testResult.provider}（${testResult.type}）可达${typeof testResult.count === 'number' ? `，当前 ${testResult.count} 条记忆` : ''}。`
                : `后端 ${testResult.provider || ''} 不可达：${testResult.error || '未知错误'}`,
            )
          : null,
      )
    }

    function MigrationTab({ data, onChanged }) {
      const providers = (data.providers || []).map((entry) => entry.id)
      const [target, setTarget] = useState(providers.find((id) => id !== data.status.provider) || 'bailian')
      const [plan, setPlan] = useState(undefined)
      const [progress, setProgress] = useState(undefined)
      const [result, setResult] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const timer = useRef(undefined)

      useEffect(() => () => clearInterval(timer.current), [])

      const makePlan = async () => {
        setError(undefined)
        setResult(undefined)
        setPlan(undefined)
        setBusy(true)
        try {
          const next = await request('/plan', { method: 'POST', body: { to: target } })
          if (next.empty) setError(`源后端没有记忆，无需迁移。`)
          else setPlan(next)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }

      const run = async () => {
        setBusy(true)
        setError(undefined)
        setProgress({ done: 0, total: plan.source.count })
        timer.current = setInterval(async () => {
          try {
            const state = await request('/progress')
            if (state.active) setProgress({ done: state.done, total: state.total || plan.source.count })
          } catch {
            /* progress is advisory; a failed poll must not fail the run */
          }
        }, 400)
        try {
          const payload = await request('/run', { method: 'POST', body: { token: plan.token } })
          setResult(payload.record)
          setPlan(undefined)
          onChanged && onChanged()
        } catch (problem) {
          setError(problem.message)
        } finally {
          clearInterval(timer.current)
          timer.current = undefined
          setProgress(undefined)
          setBusy(false)
        }
      }

      const rollback = async (id) => {
        setBusy(true)
        setError(undefined)
        try {
          const payload = await request('/rollback', { method: 'POST', body: { id } })
          if (payload.ok) setResult({ status: 'rolled-back', successCount: payload.removed, failedCount: payload.declined, durationMs: 0, id })
          onChanged && onChanged()
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(false)
        }
      }

      const records = data.migrations || []

      return h(
        'div',
        { className: 'dsh-mem', style: { gap: '14px' } },
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '迁移到另一个后端'),
          h(
            'p',
            { className: 'dsh-mem-hint' },
            '当前后端：',
            h('span', { className: 'dsh-mem-code' }, data.status.provider),
            '。迁移只向目标端追加记录，源端保持不变；执行前需在此确认，完成后可回滚。',
          ),
          h(
            'div',
            { className: 'dsh-mem-fieldrow' },
            h('span', { className: 'dsh-mem-fieldrow-label' }, '目标后端'),
            h(
              'div',
              { className: 'dsh-mem-fieldrow-controls' },
              h(
                'select',
                {
                  className: 'dsh-mem-select dsh-mem-select-narrow',
                  value: target,
                  onChange: (event) => setTarget(event.target.value),
                  'aria-label': '目标后端',
                },
                providers.filter((id) => id !== data.status.provider).map((id) => h('option', { key: id, value: id }, id)),
              ),
              h(
                'button',
                { className: 'dsh-mem-btn', onClick: makePlan, disabled: busy || plan !== undefined },
                busy && !plan ? '生成中…' : '生成迁移计划',
              ),
            ),
          ),
          plan
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                h(Note, { kind: 'warn' }, '以下是迁移计划，尚未写入任何数据。确认两端数量后执行。'),
                h(
                  'dl',
                  { className: 'dsh-mem-kv' },
                  h('dt', null, '源'),
                  h('dd', null, `${plan.source.count} 条 · ${plan.source.bytesLabel}${plan.source.oldest ? ` · ${plan.source.oldest} 至 ${plan.source.newest}` : ''}`),
                  h('dt', null, '目标'),
                  h('dd', null, `现有 ${plan.target.count} 条`),
                ),
                plan.source.sample && plan.source.sample.length > 0
                  ? h('ul', { className: 'dsh-mem-sample' }, plan.source.sample.map((line, index) => h('li', { key: index }, line)))
                  : null,
                h(
                  'div',
                  { className: 'dsh-mem-actions', style: { justifyContent: 'flex-start' } },
                  h('button', { className: 'dsh-mem-btn dsh-mem-btn-primary', onClick: run, disabled: busy }, busy ? '迁移中…' : `确认迁移 ${plan.source.count} 条到 ${plan.to}`),
                  h('button', { className: 'dsh-mem-btn', onClick: () => setPlan(undefined), disabled: busy }, '取消'),
                ),
              )
            : null,
          progress
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { className: 'dsh-mem-bar' }, h('span', { style: { width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 8}%` } })),
                h('p', { className: 'dsh-mem-hint' }, `正在迁移 ${progress.done}/${progress.total || '…'}`),
              )
            : null,
          result
            ? h(
                Note,
                { kind: result.status === 'complete' ? 'ok' : 'warn' },
                `迁移 ${result.status}：成功 ${result.successCount} 条，失败 ${result.failedCount} 条，耗时 ${(result.durationMs / 1000).toFixed(1)} 秒。迁移 id ${result.id}，可在下表撤销。`,
              )
            : null,
          error ? h(Note, { kind: 'error' }, error) : null,
        ),
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '迁移记录'),
          h(MigrationRecords, {
            records,
            busy,
            onRollback: (id) => {
              if (window.confirm(`撤销迁移 ${id}？只会删除这次迁移写入目标端的新增记录。`)) rollback(id)
            },
          }),
        ),
      )
    }

    /**
     * Every indexed scope in one grid: registered workspaces first, the shared
     * global folder last. The header and the rows share the same class, so the
     * columns cannot drift apart.
     */
    function KbScopeRows({ state, busy, onReindex, onChooseFolder, onResetFolder }) {
      const workspaces = state.workspaces || []
      const globalInfo = state.global || {}
      const rows = workspaces.map((workspace) => ({
        key: workspace.path,
        title: workspace.title || workspace.path,
        sub: `${workspace.root}${workspace.overridden ? '　· 自定义目录' : ''}`,
        info: workspace,
        scope: 'workspace',
        target: workspace.path,
        overridden: Boolean(workspace.overridden),
      }))
      rows.push({
        key: '__global__',
        title: '全局知识库',
        sub: globalInfo.root || '—',
        info: globalInfo,
        scope: 'global',
        target: undefined,
        overridden: Boolean(state.globalRootConfigured),
      })
      if (workspaces.length === 0) {
        rows.unshift() // keep the global row even when no workspace is registered
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dsh-mem-rowgrid dsh-mem-rowhead' },
          h('span', null, '范围 / 目录'),
          h('span', null, '状态'),
          h('span', null, '最近更新'),
          h('span', { style: { textAlign: 'right' } }, '操作'),
        ),
        h(
          'div',
          { className: 'dsh-mem-rows' },
          rows.map((row) =>
            h(
              'div',
              { className: 'dsh-mem-rowgrid dsh-mem-rowline', key: row.key },
              h(
                'div',
                { className: 'dsh-mem-rowline-main' },
                h('div', { className: 'dsh-mem-rowline-title' }, row.title),
                h('div', { className: 'dsh-mem-rowline-sub' }, row.sub),
              ),
              h('div', { className: 'dsh-mem-rowline-cell' }, h('span', { className: kbPillClass(row.info) }, kbStatusText(row.info))),
              h('div', { className: 'dsh-mem-rowline-cell', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, kbFormatTime(row.info.generatedAt)),
              h(
                'div',
                { className: 'dsh-mem-actions' },
                h('button', { className: 'dsh-mem-btn dsh-mem-btn-quiet', disabled: busy !== undefined, onClick: () => onReindex(row.scope, row.target, row.target || 'global') }, busy === (row.target || 'global') ? '索引中…' : '重建'),
                h('button', { className: 'dsh-mem-btn dsh-mem-btn-quiet', disabled: busy !== undefined, onClick: () => onChooseFolder(row.scope, row.target) }, '更换目录'),
                row.overridden
                  ? h('button', { className: 'dsh-mem-btn dsh-mem-btn-quiet', disabled: busy !== undefined, onClick: () => onResetFolder(row.scope, row.target) }, '默认')
                  : null,
              ),
            ),
          ),
        ),
      )
    }

    /** Migration journal rendered on the same four-column grid. */
    function MigrationRecords({ records, busy, onRollback }) {
      if (!records || records.length === 0) {
        return h('p', { className: 'dsh-mem-hint' }, '暂无迁移记录。执行迁移后可在此撤销。')
      }
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dsh-mem-rowgrid-mig dsh-mem-rowhead' },
          h('span', null, '时间'),
          h('span', null, '方向'),
          h('span', null, '结果'),
          h('span', { style: { textAlign: 'right' } }, '操作'),
        ),
        h(
          'div',
          { className: 'dsh-mem-rows' },
          records.map((record) =>
            h(
              'div',
              { className: 'dsh-mem-rowgrid-mig dsh-mem-rowline', key: record.id },
              h('div', { className: 'dsh-mem-rowline-cell', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } }, String(record.timestamp || '').slice(0, 16).replace('T', ' ')),
              h('div', { className: 'dsh-mem-rowline-cell' }, `${record.from} → ${record.to}`),
              h('div', { className: 'dsh-mem-rowline-cell' }, h('span', { className: 'dsh-mem-pill' }, `${record.status} · ${record.successCount}/${record.totalCount}`)),
              h(
                'div',
                { className: 'dsh-mem-actions' },
                record.status === 'rolled-back'
                  ? h('span', { className: 'dsh-mem-hint' }, '已回滚')
                  : h('button', { className: 'dsh-mem-btn dsh-mem-btn-quiet dsh-mem-btn-danger', disabled: busy, onClick: () => onRollback(record.id) }, '撤销'),
              ),
            ),
          ),
        ),
      )
    }

    const kbFormatTime = (value) => (value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) : '—')
    const kbStatusText = (info) => {
      if (!info || info.exists === false) return '目录不存在'
      if (!info.files) return '暂无文档'
      return `${info.files} 个文件 / ${info.chunks} 块`
    }
    const kbPillClass = (info) => (info && info.exists === false ? 'dsh-mem-pill dsh-mem-pill-muted' : 'dsh-mem-pill')

    function KbTab() {
      const [state, setState] = useState(undefined)
      const [busy, setBusy] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const [target, setTarget] = useState('global')
      const [picked, setPicked] = useState(undefined)
      const [uploading, setUploading] = useState(false)
      const [dragging, setDragging] = useState(false)

      const load = useCallback(async () => {
        try {
          setState(await request('/kb/state'))
          setError(undefined)
        } catch (problem) {
          setError(problem.message)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const reindex = async (scope, path, key) => {
        setBusy(key)
        setNotice(undefined)
        setError(undefined)
        try {
          const result = await request('/kb/reindex', { method: 'POST', body: { scope, ...(path ? { path } : {}) } })
          setNotice(
            Object.entries(result.scopes || {})
              .map(([name, info]) => `${name === 'global' ? '全局' : '工作区'}：${info.files} 文件 / ${info.chunks} 块（${info.durationMs}ms）`)
              .join('　'),
          )
          await load()
        } catch (problem) {
          setError(problem.message)
        } finally {
          setBusy(undefined)
        }
      }

      const chooseFolder = async (scope, path) => {
        setNotice(undefined)
        setError(undefined)
        let folder
        try {
          folder = await clientCtx?.uiWorkspace?.pickDirectory?.()
        } catch (problem) {
          setError(problem.message)
          return
        }
        if (folder === null || folder === undefined) folder = window.prompt('知识库目录的绝对路径（留空取消）', '')
        if (!folder) return
        try {
          await request('/kb/folder', { method: 'POST', body: { scope, ...(path ? { cwd: path } : {}), folder } })
          setNotice(`已切换目录：${folder}`)
          await reindex(scope === 'global' ? 'global' : 'workspace', path, path || 'global')
        } catch (problem) {
          setError(problem.message)
        }
      }

      const resetFolder = async (scope, path) => {
        try {
          await request('/kb/folder', { method: 'POST', body: { scope, ...(path ? { cwd: path } : {}), folder: '<default>' } })
          setNotice('已恢复默认目录')
          await load()
        } catch (problem) {
          setError(problem.message)
        }
      }

      const uploadFiles = async (fileList) => {
        const files = Array.from(fileList || [])
        if (files.length === 0) return
        setUploading(true)
        setError(undefined)
        setNotice(undefined)
        const done = []
        try {
          for (const file of files) {
            const base64 = await readFileAsBase64(file)
            const result = await request('/kb/upload', {
              method: 'POST',
              body: {
                scope: target === 'global' ? 'global' : 'workspace',
                name: file.name,
                dataBase64: base64,
                ...(target === 'global' ? {} : { cwd: target }),
              },
            })
            done.push(`${result.path}${result.indexed ? '' : '（已保存，扩展名不在索引范围）'}`)
          }
          setNotice(`已上传：${done.join('、')}`)
          setPicked(undefined)
          await load()
        } catch (problem) {
          setError(problem.message)
        } finally {
          setUploading(false)
        }
      }


      if (state === undefined) {
        return h(Note, { kind: error ? 'error' : 'info' }, error || '正在读取知识库索引…')
      }
      if (state.enabled === false) {
        return h(Note, { kind: 'warn' }, '知识库已在配置中关闭（knowledgeBase.enabled: false）。')
      }

      const workspaces = state.workspaces || []
      const globalInfo = state.global || {}
      const targets = [{ value: 'global', label: '全局知识库' }].concat(
        workspaces.map((workspace) => ({ value: workspace.path, label: `${workspace.title || workspace.path}` })),
      )
      const headStyle = {
        display: 'grid',
        gridTemplateColumns: 'minmax(190px, 1.6fr) minmax(110px, .9fr) minmax(120px, .9fr) auto',
        gap: '14px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11.5px',
      }

      return h(
        'div',
        { className: 'dsh-mem' },
        h(
          'div',
          { className: 'dsh-mem-card' },
          h(
            'div',
            { className: 'dsh-mem-card-head' },
            h('h3', null, '索引状态'),
            h(
              'div',
              { className: 'dsh-mem-actions' },
              h('button', { className: 'dsh-mem-btn dsh-mem-btn-primary', disabled: busy === 'all', onClick: () => reindex(undefined, undefined, 'all') }, busy === 'all' ? '重建中…' : '全部重建'),
              h('button', { className: 'dsh-mem-btn dsh-mem-btn-quiet', onClick: load, disabled: busy !== undefined }, '刷新'),
            ),
          ),
          h(
            'p',
            { className: 'dsh-mem-hint' },
            '知识库只读索引你维护的文档，用于回答时回溯原文并标注 ',
            h('span', { className: 'dsh-mem-code' }, 'kb/路径.md#L行号'),
            '。每个范围独立索引，同一查询下工作区命中优先于全局；索引按 TTL 自动重建（当前 ',
            String(state.refreshSeconds || 0),
            ' 秒），也可随时手动重建。',
          ),
          notice ? h(Note, { kind: 'ok' }, notice) : null,
          error ? h(Note, { kind: 'error' }, error) : null,
          h(KbScopeRows, {
            state,
            busy,
            onReindex: reindex,
            onChooseFolder: chooseFolder,
            onResetFolder: resetFolder,
          }),
        ),
        h(
          'div',
          { className: 'dsh-mem-card' },
          h(
            'div',
            { className: 'dsh-mem-card-head' },
            h('h3', null, '上传文件'),
            h(
              'select',
              {
                className: 'dsh-mem-select dsh-mem-select-narrow',
                value: target,
                onChange: (event) => setTarget(event.target.value),
                disabled: uploading,
                'aria-label': '上传目标',
              },
              targets.map((entry) => h('option', { key: entry.value, value: entry.value }, entry.label)),
            ),
          ),
          h('input', {
            id: 'dsh-mem-upload',
            className: 'dsh-mem-file',
            type: 'file',
            multiple: true,
            disabled: uploading,
            onChange: (event) => {
              const input = event.target
              setPicked(Array.from(input.files || []).map((file) => file.name))
              void uploadFiles(input.files).finally(() => {
                input.value = ''
              })
            },
          }),
          h(
            'label',
            {
              htmlFor: 'dsh-mem-upload',
              className: 'dsh-mem-drop',
              'data-active': dragging ? 'true' : 'false',
              onDragOver: (event) => {
                event.preventDefault()
                setDragging(true)
              },
              onDragLeave: () => setDragging(false),
              onDrop: (event) => {
                event.preventDefault()
                setDragging(false)
                void uploadFiles(event.dataTransfer && event.dataTransfer.files)
              },
            },
            h(
              'svg',
              {
                className: 'dsh-mem-drop-icon',
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '1.4',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': 'true',
              },
              h('path', { d: 'M12 16V4' }),
              h('path', { d: 'M7.5 8.5 12 4l4.5 4.5' }),
              h('path', { d: 'M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15' }),
            ),
            h('span', { className: 'dsh-mem-drop-title' }, uploading ? '正在写入…' : dragging ? '松开即可上传' : '拖文件到这里，或点击选择'),
            h(
              'span',
              { className: 'dsh-mem-drop-hint' },
              '文本与代码直接索引；Word、Excel、PowerPoint 自动抽取正文（内置解析，不依赖外部工具）；PDF 需可选依赖 pdfjs-dist。单文件上限 16MB。',
            ),
            h(
              'span',
              { className: 'dsh-mem-chips' },
              (state.include || [])
                .slice(0, 10)
                .map((glob) => h('span', { className: 'dsh-mem-chip', key: glob }, String(glob).replace('**/*', ''))),
              (state.include || []).length > 10
                ? h('span', { className: 'dsh-mem-chips-more', key: 'more' }, `+${state.include.length - 10}`)
                : null,
            ),
            picked && picked.length > 0 ? h('span', { className: 'dsh-mem-drop-active' }, picked.join('、')) : null,
          ),
        ),
        h(
          'div',
          { className: 'dsh-mem-card' },
          h('h3', null, '使用方式'),
          h('p', { className: 'dsh-mem-hint' }, '会话开始时注入目录摘要，优先读取 INDEX.md；模型以 kb_search 检索、kb_read 读取原文行号，并以 kb/路径.md#L行号 标注来源。'),
          h('p', { className: 'dsh-mem-hint' }, '索引为派生数据，存放于 ~/.dsh/memory/kb/indexes/，可随时重建，不会改动原文档。'),
          h(
            'p',
            { className: 'dsh-mem-hint' },
            '正文抽取：',
            h('span', { className: 'dsh-mem-code' }, 'Word / Excel / PowerPoint'),
            ' 内置；',
            h('span', { className: 'dsh-mem-code' }, 'PDF'),
            ' ',
            state.extract && state.extract.capabilities && state.extract.capabilities.pdf !== 'optional'
              ? '已启用（pdfjs-dist）'
              : '未安装 pdfjs-dist，会被跳过并提示原因',
            '。',
          ),
        ),
      )
    }

    /** Read a browser File as base64 (the data-URL payload only). */
    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
        reader.onload = () => {
          const result = String(reader.result || '')
          resolve(result.slice(result.indexOf(',') + 1))
        }
        reader.readAsDataURL(file)
      })
    }

    function MemorySettingsPage(props) {
      const [tab, setTab] = useState('overview')
      const [data, setData] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [loading, setLoading] = useState(true)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const payload = await request('/state')
          setData(payload)
          setError(payload.lastError || undefined)
        } catch (problem) {
          setError(problem.message)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const tabs = useMemo(
        () => [
          ['overview', '概览'],
          ['memory', '记忆'],
          ['knowledge', '知识库'],
          ['migration', '数据迁移'],
        ],
        [],
      )

      return h(
        'div',
        { className: 'dsh-mem' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsh-mem-head' },
          h(
            'div',
            null,
            h('h2', { className: 'dsh-mem-title' }, '记忆与知识库'),
            h('p', { className: 'dsh-mem-sub' }, '跨会话记忆与本地知识库。数据仅存本机；云端同步按需开启；迁移需你确认。'),
          ),
          h('button', { className: 'dsh-mem-btn dsh-mem-btn-quiet', onClick: load, disabled: loading }, loading ? '读取中…' : '重新读取'),
        ),
        h(
          'div',
          { className: 'dsh-mem-tabs', role: 'tablist' },
          tabs.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                role: 'tab',
                className: 'dsh-mem-tab',
                'aria-selected': tab === id ? 'true' : 'false',
                onClick: () => setTab(id),
              },
              label,
            ),
          ),
        ),
        error && tab !== 'migration' ? h(Note, { kind: 'error' }, error) : null,
        data === undefined
          ? h(Note, { kind: 'info' }, loading ? '正在读取记忆状态…' : '无法读取状态。插件可能尚未挂载完成，点「重新读取」再试。')
          : tab === 'overview'
            ? h(Overview, { data, busy: loading, onRefresh: load, ui: props.ui || panelApi })
            : tab === 'memory'
              ? h(MemoryTab, { data, onSaved: load })
              : tab === 'knowledge'
                ? h(KbTab, {})
                : h(MigrationTab, { data, onChanged: load }),
      )
    }

    return {
      inject: ['slots'],
      // Exposed for the render smoke test only; the loader ignores extra keys.
      __test__: {
        Overview,
        MemoryTab,
        KbTab,
        MigrationTab,
        MemorySettingsPage,
        KbScopeRows,
        MigrationRecords,
        initialDraft,
        request,
      },
      apply(ctx) {
        clientCtx = ctx
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-scribe',
                order: 22,
                label: '记忆与知识库',
              },
              MemorySettingsPage,
            ),
          )
        } catch (error) {
          console.error('[dsh-scribe] settings section registration failed', error)
          throw error
        }
        // The row is opt-out: show it unless the stored preference says no.
        request('/state')
          .then((state) => {
            if (state?.config?.effective?.ui?.sidebar !== false) mountPanel()
          })
          .catch(() => {
            // A missing route is not a reason to hide the entry.
            mountPanel()
          })
      },
    }
  },
})
