import { useEffect } from "react";
import { create } from "zustand";
import type { ApiFailure } from "../api/client";
import { followThread, type StreamStatus } from "../api/sse";
import type { WireThreadEvent } from "../api/types";
import { applyEvents, emptyLog, type ThreadLog } from "../features/thread/projection";
import { useWorkspace } from "./workspace";

export interface LocalPrompt {
  runId: string;
  text: string;
}

interface ThreadLogState {
  logs: Record<string, ThreadLog>;
  streams: Record<string, { status: StreamStatus; failure: ApiFailure | null }>;
  /** Prompts accepted by the server, until the log carries them itself. */
  prompts: Record<string, LocalPrompt[]>;
  /** Bumped when the log says files may have changed. */
  diffVersion: Record<string, number>;
  ingest(threadId: string, events: WireThreadEvent[]): void;
  setStream(threadId: string, status: StreamStatus, failure?: ApiFailure): void;
  addPrompt(threadId: string, prompt: LocalPrompt): void;
}

const refreshesThread = (event: WireThreadEvent) =>
  event.event.type === "RUN_STARTED" ||
  event.event.type === "RUN_FINISHED" ||
  event.event.type === "RUN_ERROR" ||
  (event.event.type === "ACTIVITY_SNAPSHOT" && event.event.activityType === "approval");

const touchesFiles = (event: WireThreadEvent) =>
  event.event.type === "RUN_FINISHED" ||
  event.event.type === "RUN_ERROR" ||
  (event.event.type === "ACTIVITY_SNAPSHOT" && event.event.activityType === "diff");

export const useThreadLogs = create<ThreadLogState>((set, get) => ({
  logs: {},
  streams: {},
  prompts: {},
  diffVersion: {},
  ingest(threadId, events) {
    const log = get().logs[threadId] ?? emptyLog;
    const next = applyEvents(threadId, log, events);
    if (next === log) return;
    const previousSeq = log.lastSeq;
    const fresh = events.filter((event) => event.seq > previousSeq);
    set((state) => ({
      logs: { ...state.logs, [threadId]: next },
      diffVersion: fresh.some(touchesFiles)
        ? { ...state.diffVersion, [threadId]: (state.diffVersion[threadId] ?? 0) + 1 }
        : state.diffVersion,
    }));
    if (fresh.some(refreshesThread)) {
      const workspace = useWorkspace.getState();
      void workspace.refreshThread(threadId);
      void workspace.refreshApprovals();
    }
  },
  setStream(threadId, status, failure) {
    set((state) => ({
      streams: { ...state.streams, [threadId]: { status, failure: failure ?? null } },
    }));
  },
  addPrompt(threadId, prompt) {
    set((state) => ({
      prompts: {
        ...state.prompts,
        [threadId]: [...(state.prompts[threadId] ?? []), prompt],
      },
    }));
  },
}));

/** Keeps the visible thread following its log. The held log resumes by seq. */
export function useThreadStream(threadId: string): void {
  useEffect(
    () =>
      followThread(threadId, {
        lastSeq: () => useThreadLogs.getState().logs[threadId]?.lastSeq ?? 0,
        onEvents: (events) => useThreadLogs.getState().ingest(threadId, events),
        onStatus: (status, failure) => useThreadLogs.getState().setStream(threadId, status, failure),
      }),
    [threadId],
  );
}
