import type { DownloadOutcome, Lesson, OfflinePackage, PersistedState, ProtectionReason } from './types';

export const DEFAULT_QUOTA_BYTES = 400_000;
const PACKAGE_BASE_BYTES = 80_000;
const PACKAGE_PER_SENTENCE_BYTES = 30_000;

export function packageSize(lesson: Lesson): number {
  return PACKAGE_BASE_BYTES + lesson.sentences.length * PACKAGE_PER_SENTENCE_BYTES;
}

export function lessonVersion(lesson: Lesson): number {
  const content = [
    lesson.title,
    lesson.subtitle,
    ...lesson.sentences.flatMap((sentence) => [sentence.text, sentence.translation, sentence.note])
  ].join('|');
  return hashString(content);
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

export function buildPackage(state: PersistedState, lesson: Lesson): OfflinePackage {
  const progress = state.progress[lesson.id];
  const attempts = state.attempts.filter((attempt) => attempt.lessonId === lesson.id);
  const lastUsedAt = [progress?.updatedAt, ...attempts.map((attempt) => attempt.submittedAt)]
    .filter((value): value is string => !!value)
    .sort()
    .pop() ?? '2026-09-24T10:20:00.000Z';
  return {
    lessonId: lesson.id,
    version: lessonVersion(lesson),
    size: packageSize(lesson),
    lastUsedAt,
    downloadedAt: lastUsedAt,
    protected: false,
    pendingMerge: false,
    status: 'downloaded'
  };
}

export function computeProtected(state: PersistedState, lessonId: string): boolean {
  if (state.activeLessonId === lessonId) return true;
  const progress = state.progress[lessonId];
  if (progress && Object.values(progress.answers).some((answer) => answer?.trim())) return true;
  if (state.attempts.some((attempt) => attempt.lessonId === lessonId)) return true;
  if (state.ledger.packages[lessonId]?.pendingMerge) return true;
  return false;
}

export function recomputeProtection(state: PersistedState): void {
  for (const pkg of Object.values(state.ledger.packages)) {
    pkg.protected = computeProtected(state, pkg.lessonId);
  }
}

export function protectionReasons(state: PersistedState, lessonId: string): ProtectionReason[] {
  const reasons: ProtectionReason[] = [];
  if (state.activeLessonId === lessonId) reasons.push('active');
  const progress = state.progress[lessonId];
  if (progress && Object.values(progress.answers).some((answer) => answer?.trim())) reasons.push('draft');
  if (state.attempts.some((attempt) => attempt.lessonId === lessonId)) reasons.push('submitted');
  if (state.ledger.packages[lessonId]?.pendingMerge) reasons.push('pendingMerge');
  return reasons;
}

export const usedBytes = (state: PersistedState): number =>
  Object.values(state.ledger.packages)
    .filter((pkg) => pkg.status === 'downloaded')
    .reduce((sum, pkg) => sum + pkg.size, 0);

export const quotaBytes = (state: PersistedState): number => state.ledger.quota;

export const availableBytes = (state: PersistedState): number =>
  Math.max(0, state.ledger.quota - usedBytes(state));

function lessonById(state: PersistedState, lessonId: string): Lesson | undefined {
  return state.courses.flatMap((course) => course.lessons).find((lesson) => lesson.id === lessonId);
}

function removeFromQueue(state: PersistedState, lessonId: string): void {
  state.ledger.queue = state.ledger.queue.filter((item) => item.lessonId !== lessonId);
}

function syncDownloadedFlags(state: PersistedState): void {
  for (const lesson of state.courses.flatMap((course) => course.lessons)) {
    const pkg = state.ledger.packages[lesson.id];
    lesson.downloaded = !!pkg && pkg.status === 'downloaded';
  }
}

function evictionPlan(state: PersistedState, needed: number, excludeLessonId: string): string[] {
  const candidates = Object.values(state.ledger.packages)
    .filter((pkg) => pkg.status === 'downloaded' && pkg.lessonId !== excludeLessonId && !computeProtected(state, pkg.lessonId))
    .sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
  const plan: string[] = [];
  let freed = 0;
  for (const pkg of candidates) {
    if (freed >= needed) break;
    plan.push(pkg.lessonId);
    freed += pkg.size;
  }
  return freed >= needed ? plan : [];
}

function detectPendingMerge(state: PersistedState, lesson: Lesson): boolean {
  const progress = state.progress[lesson.id];
  if (!progress) return false;
  const hasDraft = Object.values(progress.answers).some((answer) => answer?.trim());
  if (!hasDraft) return false;
  const validIds = new Set(lesson.sentences.map((sentence) => sentence.id));
  const orphaned = Object.keys(progress.answers).filter((id) => !validIds.has(id)).length;
  return orphaned > 0 || !validIds.has(progress.activeSentenceId);
}

function tryInstall(state: PersistedState, lessonId: string): boolean {
  const lesson = lessonById(state, lessonId);
  if (!lesson) return false;
  const pkg = state.ledger.packages[lessonId];
  const newSize = packageSize(lesson);
  const isUpdate = pkg?.status === 'downloaded';
  const need = isUpdate ? Math.max(0, newSize - pkg.size) : newSize;
  if (usedBytes(state) + need > state.ledger.quota) {
    const plan = evictionPlan(state, need, lessonId);
    if (plan.length === 0) return false;
    for (const id of plan) state.ledger.packages[id].status = 'evicted';
  }
  const now = new Date().toISOString();
  if (pkg) {
    pkg.version = lessonVersion(lesson);
    pkg.size = newSize;
    pkg.status = 'downloaded';
    pkg.lastUsedAt = now;
    pkg.pendingMerge = detectPendingMerge(state, lesson);
  } else {
    state.ledger.packages[lessonId] = {
      lessonId,
      version: lessonVersion(lesson),
      size: newSize,
      lastUsedAt: now,
      downloadedAt: now,
      protected: false,
      pendingMerge: false,
      status: 'downloaded'
    };
  }
  removeFromQueue(state, lessonId);
  syncDownloadedFlags(state);
  recomputeProtection(state);
  return true;
}

function processQueue(state: PersistedState): void {
  for (const item of [...state.ledger.queue]) {
    if (!tryInstall(state, item.lessonId)) break;
  }
}

export function requestDownload(state: PersistedState, lessonId: string): DownloadOutcome {
  const lesson = lessonById(state, lessonId);
  if (!lesson) return 'queued';
  const pkg = state.ledger.packages[lessonId];
  const isUpdate = pkg?.status === 'downloaded';
  if (isUpdate && pkg.version === lessonVersion(lesson)) {
    touchPackage(state, lessonId);
    return 'already';
  }
  if (!state.ledger.queue.some((item) => item.lessonId === lessonId)) {
    state.ledger.queue.push({
      lessonId,
      requestedAt: new Date().toISOString(),
      reason: isUpdate ? 'update' : 'download'
    });
  }
  if (tryInstall(state, lessonId)) {
    processQueue(state);
    return isUpdate ? 'updated' : 'downloaded';
  }
  return 'queued';
}

export function removeDownload(state: PersistedState, lessonId: string): void {
  const pkg = state.ledger.packages[lessonId];
  if (!pkg) return;
  pkg.status = 'evicted';
  pkg.pendingMerge = false;
  removeFromQueue(state, lessonId);
  syncDownloadedFlags(state);
  recomputeProtection(state);
  processQueue(state);
}

export function cancelQueueItem(state: PersistedState, lessonId: string): void {
  removeFromQueue(state, lessonId);
}

export function touchPackage(state: PersistedState, lessonId: string): void {
  const pkg = state.ledger.packages[lessonId];
  if (!pkg) return;
  pkg.lastUsedAt = new Date().toISOString();
  recomputeProtection(state);
}

export function mergePending(state: PersistedState, lessonId: string): number {
  const pkg = state.ledger.packages[lessonId];
  if (!pkg?.pendingMerge) return 0;
  const lesson = lessonById(state, lessonId);
  if (!lesson) return 0;
  const progress = state.progress[lessonId];
  let orphaned = 0;
  if (progress) {
    const validIds = new Set(lesson.sentences.map((sentence) => sentence.id));
    for (const id of Object.keys(progress.answers)) {
      if (!validIds.has(id)) {
        delete progress.answers[id];
        orphaned += 1;
      }
    }
    if (!validIds.has(progress.activeSentenceId)) {
      progress.activeSentenceId = lesson.sentences[0]?.id ?? '';
    }
    progress.updatedAt = new Date().toISOString();
  }
  pkg.pendingMerge = false;
  pkg.version = lessonVersion(lesson);
  recomputeProtection(state);
  return orphaned;
}

export interface AvailableLesson {
  lessonId: string;
  title: string;
  courseTitle: string;
  size: number;
  version: number;
  lastUsedAt: string;
  protected: boolean;
  pendingMerge: boolean;
}

export function availableLessons(state: PersistedState): AvailableLesson[] {
  return Object.values(state.ledger.packages)
    .filter((pkg) => pkg.status === 'downloaded')
    .map((pkg) => {
      const lesson = lessonById(state, pkg.lessonId);
      return {
        lessonId: pkg.lessonId,
        title: lesson?.title ?? pkg.lessonId,
        courseTitle: state.courses.find((course) => course.lessons.some((item) => item.id === pkg.lessonId))?.title ?? '',
        size: pkg.size,
        version: pkg.version,
        lastUsedAt: pkg.lastUsedAt,
        protected: pkg.protected,
        pendingMerge: pkg.pendingMerge
      };
    });
}

export function mergePersistedState(base: PersistedState, incoming: PersistedState): PersistedState {
  const packages: Record<string, OfflinePackage> = { ...base.ledger.packages };
  for (const [id, incomingPkg] of Object.entries(incoming.ledger.packages)) {
    const current = packages[id];
    if (!current) {
      packages[id] = { ...incomingPkg };
    } else {
      const downloaded = current.status === 'downloaded' || incomingPkg.status === 'downloaded';
      const newerVersion = incomingPkg.version > current.version ? incomingPkg : current;
      packages[id] = {
        ...current,
        status: downloaded ? 'downloaded' : incomingPkg.status,
        version: Math.max(current.version, incomingPkg.version),
        size: newerVersion.size,
        lastUsedAt: current.lastUsedAt > incomingPkg.lastUsedAt ? current.lastUsedAt : incomingPkg.lastUsedAt,
        protected: current.protected || incomingPkg.protected,
        pendingMerge: current.pendingMerge || incomingPkg.pendingMerge
      };
    }
  }
  const queue = [...base.ledger.queue];
  for (const item of incoming.ledger.queue) {
    if (!queue.some((queued) => queued.lessonId === item.lessonId)) queue.push(item);
  }
  const progress = { ...base.progress };
  for (const [id, incomingProgress] of Object.entries(incoming.progress)) {
    const current = progress[id];
    if (!current || new Date(incomingProgress.updatedAt).getTime() > new Date(current.updatedAt).getTime()) {
      progress[id] = { ...incomingProgress, answers: { ...incomingProgress.answers } };
    }
  }
  const attemptIds = new Set(base.attempts.map((attempt) => attempt.id));
  const attempts = [...base.attempts];
  for (const attempt of incoming.attempts) {
    if (!attemptIds.has(attempt.id)) attempts.push(attempt);
  }
  return {
    ...base,
    attempts,
    progress,
    ledger: { ...base.ledger, packages, queue }
  };
}
