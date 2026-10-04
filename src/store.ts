import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import { createInitialCapacity, ledgerExport, mergeIncomingCapacity, mergeIncomingProgressAndAttempts, upgradeCapacity } from './ledger';
import type { CapacityLedger, Lesson, PersistedState, PracticeAttempt } from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

function migrate(parsed: Partial<PersistedState>): PersistedState {
  // v1 -> v2：旧缓存只有 downloaded 布尔标记，这里补齐容量账目
  const capacity: CapacityLedger = parsed.capacity
    ? upgradeCapacity(parsed.capacity, parsed.courses ?? [])
    : createInitialCapacity(parsed.courses ?? []);
  mirrorDownloadFlagsOn(capacity, parsed);
  return {
    schemaVersion: 2,
    courses: parsed.courses ?? createInitialState().courses,
    attempts: parsed.attempts ?? [],
    progress: parsed.progress ?? {},
    activeLessonId: parsed.activeLessonId ?? '',
    activeSentenceId: parsed.activeSentenceId ?? '',
    theme: parsed.theme ?? 'light',
    fontScale: parsed.fontScale ?? 1,
    role: parsed.role ?? 'learner',
    capacity
  };
}

function mirrorDownloadFlagsOn(capacity: CapacityLedger, parsed: Partial<PersistedState>) {
  for (const course of parsed.courses ?? []) {
    for (const lesson of course.lessons) {
      lesson.downloaded = capacity.packages[lesson.id]?.phase === 'ready';
    }
  }
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Omit<PersistedState, 'schemaVersion'>> & { schemaVersion?: number };
      if (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) {
        return migrate(parsed as Partial<PersistedState>);
      }
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return migrate(createInitialState());
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

// 其它标签页同时下载/作答时，按账本合并而不是用本页快照整体覆盖
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    const incoming = JSON.parse(event.newValue) as Partial<PersistedState>;
    if (!incoming.capacity) return;
    mergeIncomingProgressAndAttempts({
      attempts: incoming.attempts ?? [],
      progress: incoming.progress ?? {},
      theme: incoming.theme ?? 'light',
      fontScale: incoming.fontScale ?? 1,
      role: incoming.role ?? 'learner'
    });
    if (incoming.courses) {
      // 课节内容更新（版本切换）以他页为准；未变更的不覆盖
      for (const incomingCourse of incoming.courses) {
        const localCourse = state.courses.find((course) => course.id === incomingCourse.id);
        if (!localCourse) {
          state.courses.push(incomingCourse);
          continue;
        }
        for (const incomingLesson of incomingCourse.lessons) {
          const localLesson = localCourse.lessons.find((lesson) => lesson.id === incomingLesson.id);
          if (!localLesson) localCourse.lessons.push(incomingLesson);
        }
      }
    }
    mergeIncomingCapacity(incoming.capacity);
  } catch {
    // Ignore malformed snapshots from other tabs.
  }
});

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

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
    offline: ledgerExport()
  }, null, 2);
}

export function resetDemo() {
  const fresh = migrate(createInitialState());
  Object.assign(state, fresh);
}
