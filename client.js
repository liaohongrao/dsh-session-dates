/* dsh-session-dates — Client half.
 *
 * Replaces the `sidebar.workspaces` seat with a session browser that keeps the
 * workspace sections but groups every workspace's sessions by calendar day and
 * labels each group with the explicit date.
 *
 * Written as a dynamic Client module: React comes through `require('react')`
 * and no JSX transform is available, so elements are built with h().
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-dates',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    /* ------------------------------------------------------------------ *
     * plugin context + slot-store helpers
     * ------------------------------------------------------------------ */

    let PLUGIN_CTX = null;

    /** Child-inject hook source the shipped session menu items expect. */
    const menuOpenStateFactory = (_standard, state) => () => state;

    const DAY_MS = 24 * 60 * 60 * 1000;
    const EMPTY_SESSIONS = { phase: 'idle', ids: [], byId: {} };
    const EMPTY_WORKSPACES = { phase: 'idle', items: [], archivedSessionIds: [], pinnedSessionIds: [] };

    const KEY_COLLAPSED = 'dsh.sessionDates.collapsed';
    const KEY_ARCHIVED = 'dsh.sessionDates.showArchived';

    function readStorage(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : raw;
      } catch (_error) {
        return fallback;
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (_error) {
        /* storage may be unavailable; grouping simply does not persist */
      }
    }

    function readJson(key, fallback) {
      const raw = readStorage(key, null);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw) ?? fallback;
      } catch (_error) {
        return fallback;
      }
    }

    /* ------------------------------------------------------------------ *
     * date helpers
     * ------------------------------------------------------------------ */

    const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    function pad2(value) {
      return value < 10 ? `0${value}` : String(value);
    }

    function startOfDay(ts) {
      const date = new Date(ts);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    }

    function dayKey(ts) {
      const date = new Date(ts);
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function dateLabel(ts) {
      const date = new Date(ts);
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
    }

    function relativeLabel(ts) {
      const today = startOfDay(Date.now());
      const day = startOfDay(ts);
      const diff = Math.round((today - day) / DAY_MS);
      if (diff === 0) return '今天';
      if (diff === 1) return '昨天';
      if (diff === 2) return '前天';
      if (diff > 2 && diff < 7) return `${diff} 天前`;
      if (diff < 30) return `${Math.floor(diff / 7)} 周前`;
      if (diff < 365) return `${Math.floor(diff / 30)} 个月前`;
      return `${Math.floor(diff / 365)} 年前`;
    }

    function clockLabel(ts) {
      const date = new Date(ts);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    const TIME_KEYS = [
      'updatedAt',
      'lastActivityAt',
      'lastActiveAt',
      'lastActivity',
      'lastUsedAt',
      'lastMessageAt',
      'modifiedAt',
      'activityAt',
      'createdAt',
      'created',
      'timestamp',
    ];

    function toTs(value) {
      if (value === null || value === undefined) return null;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return value < 1e11 ? value * 1000 : value; // tolerate seconds-based epochs
      }
      if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
      }
      if (value instanceof Date) {
        const parsed = value.getTime();
        return Number.isNaN(parsed) ? null : parsed;
      }
      return null;
    }

    /** Find the session's recency timestamp without depending on one field name. */
    function pickTime(row) {
      if (!row || typeof row !== 'object') return null;
      for (const key of TIME_KEYS) {
        const parsed = toTs(row[key]);
        if (parsed !== null) return parsed;
      }
      for (const key of Object.keys(row)) {
        if (!/(at|time)$/i.test(key)) continue;
        const parsed = toTs(row[key]);
        if (parsed !== null) return parsed;
      }
      return null;
    }

    function makeDay(from, to) {
      return { from, to };
    }

    /** Parse a typed date query ("2026-10-28", "10-28", "10月28日", "今天", "本周"…). */
    function parseDateQuery(text) {
      const raw = String(text || '').trim();
      if (!raw) return null;
      const now = new Date();

      let match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(raw);
      if (match) {
        const ts = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
        return Number.isNaN(ts) ? null : makeDay(ts, ts + DAY_MS);
      }

      match = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(raw);
      if (match) {
        const ts = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2])).getTime();
        return Number.isNaN(ts) ? null : makeDay(ts, ts + DAY_MS);
      }

      const today = startOfDay(now.getTime());
      if (raw === '今天' || raw === 'today') return makeDay(today, today + DAY_MS);
      if (raw === '昨天' || raw === 'yesterday') return makeDay(today - DAY_MS, today);
      if (raw === '前天') return makeDay(today - 2 * DAY_MS, today - DAY_MS);
      if (raw === '本周' || raw === '这周') {
        const monday = today - ((now.getDay() + 6) % 7) * DAY_MS;
        return makeDay(monday, monday + 7 * DAY_MS);
      }
      if (raw === '上周') {
        const monday = today - ((now.getDay() + 6) % 7) * DAY_MS;
        return makeDay(monday - 7 * DAY_MS, monday);
      }
      return null;
    }

    function basename(path) {
      if (!path) return '';
      const parts = String(path).split(/[\\/]+/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    }

    /* ------------------------------------------------------------------ *
     * model
     * ------------------------------------------------------------------ */

    function statusOf(statuses, id) {
      if (!statuses || !id) return null;
      const direct = statuses[id];
      if (direct !== undefined) return direct;
      const nested = statuses.byId || statuses.sessions || statuses.map;
      if (nested && nested[id] !== undefined) return nested[id];
      return null;
    }

    function matchesState(value, needles) {
      if (typeof value !== 'string') return false;
      const lower = value.toLowerCase();
      for (const needle of needles) if (lower.indexOf(needle) !== -1) return true;
      return false;
    }

    function firstTrue(sources, keys) {
      for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const key of keys) if (source[key] === true) return true;
      }
      return false;
    }

    function firstCount(sources, keys) {
      for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const key of keys) {
          const value = source[key];
          if (typeof value === 'number' && value > 0) return value;
          if (Array.isArray(value) && value.length > 0) return value.length;
        }
      }
      return 0;
    }

    /**
     * The live state of one session row, read from the host's session-status
     * projection. The projection is internal, so every lookup is defensive:
     * an unknown shape degrades to `idle` instead of throwing.
     */
    function deriveRunState(row, status) {
      const sources = [];
      if (typeof status === 'string') {
        if (matchesState(status, ['run', 'working', 'busy', 'stream', 'generat'])) return { state: 'running', subagents: 0 };
        if (matchesState(status, ['await', 'pending', 'interaction', 'question', 'input', 'permission'])) return { state: 'waiting', subagents: 0 };
        if (matchesState(status, ['complet', 'unread', 'done', 'success', 'finish'])) return { state: 'done', subagents: 0 };
      } else if (status && typeof status === 'object') {
        sources.push(status);
      }
      if (row && typeof row === 'object') sources.push(row);
      if (!sources.length) return { state: 'idle', subagents: 0 };

      const subagents = firstCount(sources, ['runningSubagentCount', 'subagentCount', 'runningSubagents']);
      if (firstTrue(sources, ['running', 'isRunning', 'busy', 'streaming', 'generating', 'working']) || subagents > 0) {
        return { state: 'running', subagents };
      }
      if (firstTrue(sources, ['pendingInteraction', 'awaitingInput', 'waitingForUser', 'awaitingUser', 'needsInput'])) {
        return { state: 'waiting', subagents: 0 };
      }
      if (firstTrue(sources, ['completed', 'unreadCompletion', 'hasUnreadCompletion', 'unread'])) {
        return { state: 'done', subagents: 0 };
      }
      for (const source of sources) {
        const raw = source.state !== undefined ? source.state : source.status;
        if (typeof raw !== 'string') continue;
        if (matchesState(raw, ['run', 'working', 'busy', 'stream', 'generat'])) return { state: 'running', subagents: 0 };
        if (matchesState(raw, ['await', 'pending', 'interaction', 'question', 'input', 'permission'])) return { state: 'waiting', subagents: 0 };
        if (matchesState(raw, ['complet', 'unread', 'done', 'success', 'finish'])) return { state: 'done', subagents: 0 };
        return { state: 'idle', subagents: 0 };
      }
      return { state: 'idle', subagents: 0 };
    }

    function dotTitle(item) {
      if (item.state === 'running') {
        return item.subagents > 0 ? `正在运行（${item.subagents} 个子代理）` : '正在运行';
      }
      if (item.state === 'waiting') return '等待你的输入';
      if (item.state === 'done') return '有新结果未读';
      return item.current ? '当前在主视图打开' : '空闲';
    }

    function makeRow(sessionId, row, pinned, statuses) {
      const state = deriveRunState(row, statusOf(statuses, sessionId));
      return {
        id: sessionId,
        row,
        ts: pickTime(row),
        pinned: pinned.has(sessionId) || row.pinned === true,
        state: state.state,
        subagents: state.subagents,
        current: !!(row && row.retainedBy && row.retainedBy.mainView > 0),
      };
    }

    function buildRowsOfWorkspace(workspace, byId, pinned, statuses) {
      const rows = [];
      const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
      for (const sessionId of sessionIds) {
        const row = byId[sessionId];
        if (!row) continue;
        rows.push(makeRow(sessionId, row, pinned, statuses));
      }
      return rows;
    }

    function buildBuckets(rows, options) {
      const { showArchived, archived, query, dateRange } = options;
      const needle = query ? query.toLowerCase() : '';
      const buckets = new Map();

      for (const item of rows) {
        if (!showArchived && archived.has(item.id)) continue;
        if (dateRange) {
          if (item.ts === null || item.ts < dateRange.from || item.ts >= dateRange.to) continue;
        } else if (needle) {
          const title = String((item.row && item.row.title) || '').toLowerCase();
          const fallback = item.row && item.row.blank ? '未命名会话' : '';
          if (!title.includes(needle) && !fallback.toLowerCase().includes(needle)) continue;
        }
        const key = item.ts === null ? 'unknown' : dayKey(item.ts);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { key, ts: item.ts === null ? null : startOfDay(item.ts), rows: [] };
          buckets.set(key, bucket);
        }
        bucket.rows.push(item);
      }

      const list = Array.from(buckets.values());
      list.sort((left, right) => {
        if (left.key === 'unknown') return 1;
        if (right.key === 'unknown') return -1;
        return right.ts - left.ts;
      });
      for (const bucket of list) {
        bucket.rows.sort((left, right) => {
          if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
          const leftTs = left.ts === null ? 0 : left.ts;
          const rightTs = right.ts === null ? 0 : right.ts;
          if (leftTs !== rightTs) return rightTs - leftTs;
          return 0;
        });
        bucket.label = bucket.key === 'unknown' ? '日期未知' : dateLabel(bucket.ts);
        bucket.relative = bucket.key === 'unknown' ? '' : relativeLabel(bucket.ts);
        bucket.dayNumber = bucket.key === 'unknown' ? 0 : bucket.ts;
      }
      return list;
    }

    function buildSections(items, ids, byId, pinned, archived, options) {
      const accounted = new Set();
      const sections = [];

      for (const workspace of items) {
        const rows = buildRowsOfWorkspace(workspace, byId, pinned, options.statuses);
        for (const workspaceSessionId of workspace.sessionIds || []) accounted.add(workspaceSessionId);
        const buckets = buildBuckets(rows, { ...options, archived });
        sections.push({
          key: String(workspace.workspaceId || ''),
          workspaceId: workspace.workspaceId || null,
          title: (workspace.title && String(workspace.title).trim()) || basename(workspace.path) || '未命名工作区',
          path: workspace.path || '',
          count: buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0),
          buckets,
        });
      }

      const ungroupedRows = [];
      for (const sessionId of ids) {
        if (accounted.has(sessionId)) continue;
        const row = byId[sessionId];
        if (!row) continue;
        accounted.add(sessionId);
        ungroupedRows.push(makeRow(sessionId, row, pinned, options.statuses));
      }
      if (ungroupedRows.length) {
        const buckets = buildBuckets(ungroupedRows, { ...options, archived });
        sections.push({
          key: '__ungrouped__',
          workspaceId: null,
          title: '未归类',
          path: '',
          count: buckets.reduce((sum, bucket) => sum + bucket.rows.length, 0),
          buckets,
        });
      }
      return sections;
    }

    /* ------------------------------------------------------------------ *
     * error boundary so one broken child slot never takes the panel down
     * ------------------------------------------------------------------ */

    class Guard extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        // Visible only in the browser console: a child slot failed to mount.
        console.error('[dsh-session-dates] child slot failed:', error);
      }

      render() {
        if (this.state.failed) return this.props.fallback === undefined ? null : this.props.fallback;
        return this.props.children;
      }
    }

    function guarded(node, key) {
      return h(Guard, { key }, node);
    }

    /* ------------------------------------------------------------------ *
     * view
     * ------------------------------------------------------------------ */

    function SessionRow(props) {
      const { item, isArchived, onOpen, onMenu } = props;
      const title = (item.row && item.row.title) || (item.row && item.row.blank ? '未命名会话' : '新会话');
      const stamp = item.ts === null ? '' : clockLabel(item.ts);
      return h(
        'div',
        {
          className: `sd-row${isArchived ? ' sd-row--archived' : ''}`,
          role: 'button',
          tabIndex: 0,
          title: `${title}${item.ts === null ? '' : `\n${dateLabel(item.ts)} ${clockLabel(item.ts)}`}`,
          onClick: () => onOpen(item),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen(item);
            }
          },
        },
        h('span', {
          className: 'sd-dot',
          'data-state': item.state || 'idle',
          'data-current': item.current ? '1' : '0',
          role: 'img',
          'aria-label': dotTitle(item),
        }),
        item.subagents > 0
          ? h('span', { className: 'sd-subagents', title: `${item.subagents} 个子代理运行中` }, String(item.subagents))
          : null,
        h('span', { className: 'sd-row-title' }, title),
        item.pinned ? h('span', { className: 'sd-flag', title: '已置顶' }, '置顶') : null,
        isArchived ? h('span', { className: 'sd-flag sd-flag--archived', title: '已归档' }, '归档') : null,
        h('span', { className: 'sd-row-time' }, stamp),
        h(
          'button',
          {
            type: 'button',
            className: 'sd-row-more',
            title: '会话操作',
            onClick: (event) => {
              event.stopPropagation();
              event.preventDefault();
              onMenu(item, event.currentTarget);
            },
          },
          '⋯',
        ),
      );
    }

    function BrowserInner(props) {
      const { wide, expandSidebar, renderSlot } = props;

      const sessionsSnap = typeof props.useSessions === 'function' ? props.useSessions((snapshot) => snapshot) || EMPTY_SESSIONS : EMPTY_SESSIONS;
      const workspaceSnap = typeof props.useWorkspaces === 'function' ? props.useWorkspaces((snapshot) => snapshot) || EMPTY_WORKSPACES : EMPTY_WORKSPACES;
      const statuses = typeof props.useSessionStatus === 'function' ? props.useSessionStatus((snapshot) => snapshot) : null;

      const [query, setQuery] = useState('');
      const [showArchived, setShowArchived] = useState(() => readStorage(KEY_ARCHIVED, '0') === '1');
      const [collapsed, setCollapsed] = useState(() => readJson(KEY_COLLAPSED, {}) || {});
      const [menu, setMenu] = useState(null);
      const menuRef = useRef(null);

      const byId = (sessionsSnap && sessionsSnap.byId) || {};
      const ids = useMemo(() => {
        if (Array.isArray(sessionsSnap && sessionsSnap.ids)) return sessionsSnap.ids;
        return Object.keys(byId);
      }, [sessionsSnap, byId]);
      const items = (workspaceSnap && workspaceSnap.items) || [];
      const pinned = useMemo(() => new Set((workspaceSnap && workspaceSnap.pinnedSessionIds) || []), [workspaceSnap]);
      const archived = useMemo(() => new Set((workspaceSnap && workspaceSnap.archivedSessionIds) || []), [workspaceSnap]);

      const dateRange = useMemo(() => parseDateQuery(query), [query]);
      const sections = useMemo(
        () => buildSections(items, ids, byId, pinned, archived, { showArchived, query, dateRange, statuses }),
        [items, ids, byId, pinned, archived, showArchived, query, dateRange, statuses],
      );

      const totalVisible = sections.reduce((sum, section) => sum + section.count, 0);

      const service = useCallback((name) => {
        if (!PLUGIN_CTX) return undefined;
        try {
          return PLUGIN_CTX.get(name);
        } catch (_error) {
          return undefined;
        }
      }, []);

      const openSession = useCallback(
        (item) => {
          const api = service('uiWorkspace');
          if (!api) return;
          try {
            if (archived.has(item.id)) api.unarchiveSession(item.id);
            api.openSession(item.id);
          } catch (error) {
            console.error('[dsh-session-dates] open session failed:', error);
          }
        },
        [archived, service],
      );

      const startSession = useCallback(
        (workspaceId) => {
          const api = service('uiWorkspace');
          if (!api) return;
          try {
            api.startSession(workspaceId || undefined);
          } catch (error) {
            console.error('[dsh-session-dates] start session failed:', error);
          }
        },
        [service],
      );

      const toggleSection = useCallback((key) => {
        setCollapsed((current) => {
          const next = { ...current };
          if (next[key]) delete next[key];
          else next[key] = true;
          writeStorage(KEY_COLLAPSED, JSON.stringify(next));
          return next;
        });
      }, []);

      const toggleArchived = useCallback(() => {
        setShowArchived((current) => {
          const next = !current;
          writeStorage(KEY_ARCHIVED, next ? '1' : '0');
          return next;
        });
      }, []);

      const copyText = useCallback((text) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
          }
        } catch (error) {
          console.error('[dsh-session-dates] copy failed:', error);
        }
      }, []);

      const openMenu = useCallback((item, anchor) => {
        const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        setMenu({
          kind: 'session',
          item,
          x: rect ? rect.left : 40,
          y: rect ? rect.bottom + 4 : 80,
        });
      }, []);

      const openWorkspaceMenu = useCallback((section, anchor) => {
        const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        setMenu({
          kind: 'workspace',
          section,
          x: rect ? rect.left : 40,
          y: rect ? rect.bottom + 4 : 80,
        });
      }, []);

      useEffect(() => {
        if (!menu) return undefined;
        const onPointerDown = (event) => {
          if (menuRef.current && menuRef.current.contains(event.target)) return;
          setMenu(null);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenu(null);
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [menu]);

      const archiveOne = useCallback(
        (item) => {
          const api = service('uiWorkspace');
          if (!api) return;
          try {
            if (archived.has(item.id)) api.unarchiveSession(item.id);
            else api.archiveSession(item.id, {});
          } catch (error) {
            console.error('[dsh-session-dates] archive failed:', error);
          }
          setMenu(null);
        },
        [archived, service],
      );

      const renameWorkspace = useCallback(
        (section) => {
          const api = service('workspaces');
          if (!api) return;
          const next = window.prompt('重命名工作区', section.title);
          if (next === null) return;
          const title = next.trim();
          if (!title || title === section.title) return;
          try {
            const result = api.rename(section.workspaceId, title);
            if (result && typeof result.catch === 'function') result.catch((error) => console.error('[dsh-session-dates] rename failed:', error));
          } catch (error) {
            console.error('[dsh-session-dates] rename failed:', error);
          }
        },
        [service],
      );

      const deleteWorkspace = useCallback(
        (section) => {
          const api = service('workspaces');
          if (!api) return;
          if (!window.confirm(`删除工作区「${section.title}」？此操作不会删除已保存的会话记录，但会将其移出侧边栏。`)) return;
          try {
            const result = api.delete(section.workspaceId);
            if (result && typeof result.catch === 'function') result.catch((error) => console.error('[dsh-session-dates] delete failed:', error));
          } catch (error) {
            console.error('[dsh-session-dates] delete failed:', error);
          }
        },
        [service],
      );

      const renderMenu = () => {
        if (!menu) return null;
        const style = {
          left: Math.min(menu.x, Math.max(12, window.innerWidth - 240)),
          top: Math.min(menu.y, Math.max(12, window.innerHeight - 240)),
        };
        const children = [];
        if (menu.kind === 'session') {
          const item = menu.item;
          children.push(
            h(
              'button',
              { key: 'open', type: 'button', className: 'sd-menu-item', onClick: () => { setMenu(null); openSession(item); } },
              '打开',
            ),
            h(
              'button',
              { key: 'copy', type: 'button', className: 'sd-menu-item', onClick: () => { copyText(item.id); setMenu(null); } },
              '复制会话 ID',
            ),
            h(
              'button',
              { key: 'archive', type: 'button', className: 'sd-menu-item', onClick: () => archiveOne(item) },
              archived.has(item.id) ? '取消归档' : '归档',
            ),
          );
          if (typeof renderSlot === 'function') {
            children.push(
              guarded(
                h(
                  'div',
                  { className: 'sd-menu-slot', key: 'menu-slot' },
                  renderSlot('sidebar.workspaces.session.menu.item', {
                    sessionId: item.id,
                    displayTitle: (item.row && item.row.title) || '',
                  }),
                ),
                'menu-slot',
              ),
            );
          }
        } else {
          const section = menu.section;
          if (section.workspaceId) {
            children.push(
              h(
                'button',
                { key: 'new', type: 'button', className: 'sd-menu-item', onClick: () => { setMenu(null); startSession(section.workspaceId); } },
                '在此工作区新建会话',
              ),
              h(
                'button',
                { key: 'rename', type: 'button', className: 'sd-menu-item', onClick: () => { setMenu(null); renameWorkspace(section); } },
                '重命名工作区',
              ),
              h(
                'button',
                { key: 'delete', type: 'button', className: 'sd-menu-item sd-menu-item--danger', onClick: () => { setMenu(null); deleteWorkspace(section); } },
                '删除工作区',
              ),
            );
          }
        }
        return h(
          'div',
          { className: 'sd-menu', ref: menuRef, style, role: 'menu' },
          children,
        );
      };

      const header = h(
        'div',
        { className: 'sd-header' },
        h(
          'div',
          { className: 'sd-header-text' },
          h('span', { className: 'sd-header-title' }, '会话'),
          h('span', { className: 'sd-header-count' }, `${totalVisible} 个 · 按日期`),
        ),
        h(
          'div',
          { className: 'sd-header-actions' },
          h('button', { type: 'button', className: 'sd-icon-btn', title: '新建会话', onClick: () => startSession(null) }, '＋'),
          h(
            'button',
            {
              type: 'button',
              className: `sd-icon-btn${showArchived ? ' is-on' : ''}`,
              title: showArchived ? '隐藏已归档会话' : '显示已归档会话',
              onClick: toggleArchived,
            },
            '档',
          ),
          h('button', { type: 'button', className: 'sd-icon-btn', title: '添加工作区', onClick: addWorkspace }, '＋工作区'),
          wide ? null : h('button', { type: 'button', className: 'sd-icon-btn', title: '展开侧边栏', onClick: expandSidebar }, '»'),
        ),
      );

      function addWorkspace() {
        const uiWorkspaceApi = service('uiWorkspace');
        const workspacesApi = service('workspaces');
        if (!uiWorkspaceApi || !workspacesApi) return;
        Promise.resolve()
          .then(async () => {
            const directory = await uiWorkspaceApi.pickDirectory();
            if (!directory) return;
            await workspacesApi.create({ path: directory });
          })
          .catch((error) => console.error('[dsh-session-dates] add workspace failed:', error));
      }

      const search = h(
        'div',
        { className: 'sd-search' },
        h('input', {
          type: 'search',
          className: 'sd-search-input',
          value: query,
          placeholder: '搜索会话，或输入日期如 2026-10-28',
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') setQuery('');
          },
        }),
        dateRange
          ? h(
              'div',
              { className: 'sd-search-mode' },
              `按日期筛选：${dateLabel(dateRange.from)}`,
              h('button', { type: 'button', className: 'sd-search-clear', onClick: () => setQuery('') }, '清除'),
            )
          : null,
      );

      const body = [];

      for (const section of sections) {
        const isCollapsed = section.key !== '__ungrouped__' && collapsed[section.key] === true;
        body.push(
          h(
            'section',
            { className: 'sd-section', key: section.key },
            h(
              'div',
              {
                className: 'sd-section-head',
                role: 'button',
                tabIndex: 0,
                title: section.path || section.title,
                onClick: () => {
                  if (section.key === '__ungrouped__') return;
                  toggleSection(section.key);
                },
                onKeyDown: (event) => {
                  if (section.key === '__ungrouped__') return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleSection(section.key);
                  }
                },
              },
              h('span', { className: 'sd-caret' }, isCollapsed ? '▸' : '▾'),
              h('span', { className: 'sd-section-title' }, section.title),
              h('span', { className: 'sd-section-count' }, String(section.count)),
              h(
                'span',
                { className: 'sd-section-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'sd-icon-btn sd-icon-btn--sm',
                    title: '在此工作区新建会话',
                    onClick: (event) => {
                      event.stopPropagation();
                      startSession(section.workspaceId);
                    },
                  },
                  '＋',
                ),
                section.workspaceId
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'sd-icon-btn sd-icon-btn--sm',
                        title: '工作区菜单',
                        onClick: (event) => {
                          event.stopPropagation();
                          openWorkspaceMenu(section, event.currentTarget);
                        },
                      },
                      '⋯',
                    )
                  : null,
              ),
            ),
            isCollapsed
              ? null
              : h(
                  'div',
                  { className: 'sd-section-body' },
                  section.buckets.length === 0
                    ? h('div', { className: 'sd-empty' }, query ? '没有匹配的会话' : '暂无会话')
                    : section.buckets.map((bucket) =>
                        h(
                          'div',
                          { className: 'sd-bucket', key: bucket.key },
                          h(
                            'div',
                            { className: 'sd-date', title: `${bucket.label} · ${bucket.rows.length} 个会话` },
                            h('span', { className: 'sd-date-label' }, bucket.label),
                            bucket.relative ? h('span', { className: 'sd-date-rel' }, bucket.relative) : null,
                            h('span', { className: 'sd-date-count' }, `${bucket.rows.length}`),
                          ),
                          bucket.rows.map((item) =>
                            h(SessionRow, {
                              key: item.id,
                              item,
                              isArchived: archived.has(item.id),
                              onOpen: openSession,
                              onMenu: openMenu,
                            }),
                          ),
                        ),
                      ),
                ),
          ),
        );
      }

      if (sections.length === 0) {
        body.push(h('div', { className: 'sd-empty sd-empty--page', key: 'page-empty' }, query ? '没有匹配的会话' : '还没有工作区'));
      }

      return h(
        'div',
        { className: `sd-root${wide ? ' sd-root--wide' : ''}` },
        header,
        search,
        h('div', { className: 'sd-scroll' }, body),
        renderMenu(),
      );
    }

    /** Public entry: one guard so a render failure degrades to a message, not a blank seat. */
    function Browser(props) {
      return h(
        Guard,
        {
          fallback: h(
            'div',
            { className: 'sd-root sd-fallback' },
            '会话按日期分组暂时不可用（dsh-session-dates）。可在插件管理中停用该插件恢复原侧边栏。',
          ),
        },
        h(BrowserInner, props),
      );
    }

    /* ------------------------------------------------------------------ *
     * styles
     * ------------------------------------------------------------------ */

    const CSS = `
.sd-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  padding-inline: var(--dsh-sidebar-inline-padding, 8px);
  box-sizing: border-box;
}
.sd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 4px 6px;
  min-height: 28px;
}
.sd-header-text { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.sd-header-title { font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.sd-header-count { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sd-header-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.sd-icon-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 5px;
  font-size: 12px;
  line-height: 18px;
  min-height: 22px;
  max-width: 64px;
  overflow: hidden;
  white-space: nowrap;
}
.sd-icon-btn--sm { font-size: 12px; padding: 1px 4px; min-height: 18px; }
.sd-icon-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sd-icon-btn.is-on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); }
.sd-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.sd-search { padding: 0 2px 6px; }
.sd-search-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px;
  padding: 4px 7px;
  font-size: 12px;
  line-height: 18px;
  outline: none;
}
.sd-search-input::placeholder { color: var(--dsw-alias-label-secondary); }
.sd-search-input:focus { border-color: var(--dsw-alias-brand-primary); }
.sd-search-mode {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--dsw-alias-brand-primary);
}
.sd-search-clear {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 0 2px;
}
.sd-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: 12px; }
.sd-section { margin-top: 2px; }
.sd-section-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.sd-section-head:hover { background: var(--dsw-alias-bg-layer-1); }
.sd-section-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.sd-caret { font-size: 9px; color: var(--dsw-alias-label-secondary); width: 10px; flex: none; text-align: center; }
.sd-section-title {
  font-size: 12px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
}
.sd-section-count { font-size: 11px; color: var(--dsw-alias-label-secondary); flex: none; }
.sd-section-actions { display: none; align-items: center; gap: 0; flex: none; }
.sd-section-head:hover .sd-section-actions { display: flex; }
.sd-section-head:hover .sd-section-count { display: none; }
.sd-section-body { padding-left: 6px; }
.sd-bucket { margin: 2px 0 6px; }
.sd-date {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 4px 3px;
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));
}
.sd-date-label { font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.sd-date-rel { font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .85; }
.sd-date-count { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .7; }
.sd-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  min-height: 24px;
  box-sizing: border-box;
}
.sd-row:hover { background: var(--dsw-alias-bg-layer-2); }
.sd-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.sd-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
  flex: none;
  opacity: .45;
  box-sizing: border-box;
}
.sd-dot[data-state="running"] {
  background: var(--dsw-alias-brand-primary);
  opacity: 1;
  animation: sd-pulse 1.25s ease-in-out infinite;
}
.sd-dot[data-state="waiting"] { background: var(--dsw-alias-state-warn-primary, #d9a11f); opacity: 1; }
.sd-dot[data-state="done"] { background: var(--dsw-alias-state-success-primary); opacity: 1; }
.sd-dot[data-current="1"][data-state="idle"] { opacity: .85; }
@keyframes sd-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(.6); opacity: .55; }
}
@media (prefers-reduced-motion: reduce) {
  .sd-dot[data-state="running"] { animation: none; }
}
.sd-subagents {
  flex: none;
  min-width: 13px;
  height: 13px;
  line-height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  font-size: 9px;
  text-align: center;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-variant-numeric: tabular-nums;
}
.sd-row-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.sd-row--archived .sd-row-title { color: var(--dsw-alias-label-secondary); }
.sd-flag {
  flex: none;
  font-size: 9px;
  line-height: 15px;
  padding: 0 4px;
  border-radius: 4px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
}
.sd-flag--archived { opacity: .8; }
.sd-row-time { flex: none; font-size: 10px; color: var(--dsw-alias-label-secondary); opacity: .7; font-variant-numeric: tabular-nums; }
.sd-row-more {
  appearance: none; border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 16px;
  padding: 0 2px; border-radius: 4px; visibility: hidden; flex: none;
}
.sd-row:hover .sd-row-more { visibility: visible; }
.sd-row-more:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.sd-empty { padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sd-empty--page { padding: 16px 8px; text-align: center; }
.sd-menu {
  position: fixed;
  z-index: 2147483000;
  min-width: 190px;
  max-width: 260px;
  padding: 4px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sd-menu-item {
  appearance: none;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  padding: 5px 8px;
  border-radius: 6px;
  width: 100%;
}
.sd-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
.sd-menu-item--danger { color: var(--dsw-alias-state-error-primary); }
.sd-menu-slot { display: contents; }
.sd-menu-slot > * { border-radius: 6px; }
.sd-fallback { padding: 12px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
`;

    function injectStyles() {
      if (typeof document === 'undefined') return;
      const marker = 'data-dsh-session-dates';
      if (document.querySelector(`style[${marker}]`)) return;
      const style = document.createElement('style');
      style.setAttribute(marker, '');
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ *
     * plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        PLUGIN_CTX = ctx;
        injectStyles();

        ctx.slots.inject('sidebar.workspaces', () => {
          const shortcuts = (() => {
            try {
              return ctx.get('shortcuts');
            } catch (_error) {
              return undefined;
            }
          })();

          return ctx.slots.register(
            {
              name: 'sidebar.workspaces',
              priority: 100,
              children: {
                'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
                'sidebar.workspaces.session.menu.item': {
                  kind: 'list',
                  scope: 'root',
                  inject: {
                    hooks: {
                      menuOpenState: menuOpenStateFactory,
                      shortcuts: shortcuts && shortcuts.catalog ? shortcuts.catalog : () => undefined,
                    },
                  },
                },
                'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' },
                'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
              },
            },
            Browser,
          );
        });
      },
    };
  },
});
