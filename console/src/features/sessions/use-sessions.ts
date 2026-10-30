import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Mood,
  SessionDetail,
  SessionFilter,
  SessionSummary,
} from '@/types';
import { api, applyMoodToSessions } from '@/lib/api';
import {
  demoMoods,
  demoSessionSummaries,
  getDemoSessionDetail,
} from '@/lib/demo-data';
import { sleep } from '@/lib/utils';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { useMediaQuery } from '@/hooks/use-media-query';

type Phase = 'loading' | 'ready' | 'error';

export function useSessions() {
  const { mode } = useConsoleMode();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [listPhase, setListPhase] = useState<Phase>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailPhase, setDetailPhase] = useState<Phase>('loading');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionFilter>('all');
  const requestId = useRef(0);
  const detailRequest = useRef(0);
  const autoSelected = useRef(false);

  const loadSessions = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      const current = ++requestId.current;
      if (!options.quiet) setListPhase('loading');
      else setRefreshing(true);
      try {
        let next: SessionSummary[];
        if (mode === 'demo') {
          await sleep(220);
          next = applyMoodToSessions(demoSessionSummaries, demoMoods);
        } else {
          const [sessions, moods] = await Promise.all([api.sessions(80), api.moods()]);
          next = applyMoodToSessions(sessions, moods);
        }
        if (current !== requestId.current) return;
        setSummaries(next);
        setListPhase('ready');
        setListError(null);
      } catch (error) {
        if (current !== requestId.current) return;
        setListPhase('error');
        setListError(error instanceof Error ? error.message : '会话列表加载失败');
      } finally {
        if (current === requestId.current) setRefreshing(false);
      }
    },
    [mode],
  );

  useEffect(() => {
    autoSelected.current = false;
    setSelectedId(null);
    setDetail(null);
    void loadSessions();
  }, [mode, loadSessions]);

  useEffect(() => {
    if (listPhase !== 'ready' || autoSelected.current) return;
    if (!isDesktop) return;
    autoSelected.current = true;
    const candidate =
      summaries.find((session) => session.status === 'running') ?? summaries[0];
    if (candidate) setSelectedId(candidate.id);
  }, [isDesktop, listPhase, summaries]);

  const loadDetail = useCallback(
    async (id: string, options: { quiet?: boolean } = {}) => {
      const current = ++detailRequest.current;
      if (!options.quiet) {
        setDetailPhase('loading');
        setDetailError(null);
        setDetail(null);
      }
      try {
        let next: SessionDetail | null;
        if (mode === 'demo') {
          if (!options.quiet) await sleep(180);
          next = getDemoSessionDetail(id);
          if (next) {
            next = { ...next, mood: demoMoods[next.chatKey] ?? next.mood ?? null };
          }
        } else {
          next = await api.sessionDetail(id);
          try {
            const mood = await api.mood(next.chatKey);
            next = { ...next, mood };
          } catch {
            // 情绪接口失败不阻塞会话详情展示。
          }
        }
        if (current !== detailRequest.current) return;
        if (!next) throw new Error('会话不存在或已被清理');
        setDetail(next);
        setDetailPhase('ready');
      } catch (error) {
        if (current !== detailRequest.current) return;
        setDetailPhase('error');
        setDetailError(error instanceof Error ? error.message : '会话详情加载失败');
      }
    },
    [mode],
  );

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailPhase('loading');
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (mode !== 'live') return;
    const listTimer = window.setInterval(() => void loadSessions({ quiet: true }), 4_000);
    return () => window.clearInterval(listTimer);
  }, [mode, loadSessions]);

  useEffect(() => {
    if (mode !== 'live' || !selectedId || detail?.status !== 'running') return;
    const detailTimer = window.setInterval(
      () => void loadDetail(selectedId, { quiet: true }),
      1_500,
    );
    return () => window.clearInterval(detailTimer);
  }, [mode, selectedId, detail?.status, loadDetail]);

  const resetMood = useCallback(async () => {
    if (!selectedId) return false;
    const current = summaries.find((session) => session.id === selectedId);
    if (!current) return false;
    setResetting(true);
    try {
      let mood: Mood | null;
      if (mode === 'demo') {
        await sleep(260);
        mood = {
          score: 50,
          label: '平静',
          lastInteractionAt: Date.now(),
          lastUpdatedAt: Date.now(),
          decayStage: 0,
        };
      } else {
        mood = await api.resetMood(current.chatKey);
      }
      if (!mood) throw new Error('情绪接口未返回状态');
      setSummaries((items) =>
        items.map((item) =>
          item.chatKey === current.chatKey ? { ...item, mood } : item,
        ),
      );
      setDetail((value) => (value ? { ...value, mood } : value));
      return true;
    } catch {
      return false;
    } finally {
      setResetting(false);
    }
  }, [mode, selectedId, summaries]);

  const counts = useMemo(() => {
    const base: Record<SessionFilter, number> = {
      all: summaries.length,
      running: 0,
      done: 0,
      noreply: 0,
      error: 0,
      aborted: 0,
    };
    for (const session of summaries) base[session.status] += 1;
    return base;
  }, [summaries]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return summaries.filter((session) => {
      if (filter !== 'all' && session.status !== filter) return false;
      if (!keyword) return true;
      return (
        session.chatName.toLowerCase().includes(keyword) ||
        session.chatKey.toLowerCase().includes(keyword) ||
        session.triggerSummary.toLowerCase().includes(keyword) ||
        session.model.toLowerCase().includes(keyword)
      );
    });
  }, [filter, query, summaries]);

  const selectedSummary =
    summaries.find((session) => session.id === selectedId) ??
    (detail ? detail : null);

  return {
    mode,
    isDesktop,
    summaries,
    filtered,
    counts,
    listPhase,
    listError,
    refreshing,
    query,
    setQuery,
    filter,
    setFilter,
    selectedId,
    setSelectedId,
    selectedSummary,
    detail,
    detailPhase,
    detailError,
    resetting,
    reload: loadSessions,
    retryDetail: () => (selectedId ? loadDetail(selectedId) : Promise.resolve()),
    resetMood,
  };
}
