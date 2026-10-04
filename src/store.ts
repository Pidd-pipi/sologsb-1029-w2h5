import { reactive, watch } from 'vue';
import { createInitialState, upgradeV1ToV2 } from './data';
import * as ledger from './ledger';
import type { Lesson, PersistedState, PracticeAttempt } from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { schemaVersion?: number; ledger?: unknown };
      if (parsed.schemaVersion === 2 && parsed.ledger) return parsed as PersistedState;
      if (parsed.schemaVersion === 1) return upgradeV1ToV2(parsed);
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());
ledger.recomputeProtection(state);

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });
watch(
  () => [state.activeLessonId, state.progress, state.attempts],
  () => ledger.recomputeProtection(state),
  { deep: true }
);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const incoming = JSON.parse(event.newValue) as PersistedState;
      if (incoming.schemaVersion !== 2 || !incoming.ledger) return;
      Object.assign(state, ledger.mergePersistedState(state, incoming));
    } catch {
      // Ignore malformed payloads from other tabs.
    }
  });
}

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export const requestDownload = (lessonId: string) => ledger.requestDownload(state, lessonId);
export const removeDownload = (lessonId: string) => ledger.removeDownload(state, lessonId);
export const cancelQueueItem = (lessonId: string) => ledger.cancelQueueItem(state, lessonId);
export const mergePending = (lessonId: string) => ledger.mergePending(state, lessonId);
export const touchPackage = (lessonId: string) => ledger.touchPackage(state, lessonId);
export const protectionReasons = (lessonId: string) => ledger.protectionReasons(state, lessonId);
export const usedBytes = () => ledger.usedBytes(state);
export const quotaBytes = () => ledger.quotaBytes(state);

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    attempts: state.attempts,
    progress: state.progress,
    ledger: {
      quota: state.ledger.quota,
      used: ledger.usedBytes(state),
      available: ledger.availableLessons(state),
      queue: state.ledger.queue.map((item) => ({
        lessonId: item.lessonId,
        title: lessonById(item.lessonId)?.title ?? item.lessonId,
        requestedAt: item.requestedAt,
        reason: item.reason
      }))
    }
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
