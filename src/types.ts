export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';
export type PackageStatus = 'downloaded' | 'evicted';
export type ProtectionReason = 'active' | 'draft' | 'submitted' | 'pendingMerge';
export type DownloadOutcome = 'already' | 'downloaded' | 'updated' | 'queued';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface OfflinePackage {
  lessonId: string;
  version: number;
  size: number;
  lastUsedAt: string;
  downloadedAt: string;
  protected: boolean;
  pendingMerge: boolean;
  status: PackageStatus;
}

export interface DownloadQueueItem {
  lessonId: string;
  requestedAt: string;
  reason: 'download' | 'update';
}

export interface CapacityLedger {
  quota: number;
  packages: Record<string, OfflinePackage>;
  queue: DownloadQueueItem[];
}

export interface PersistedState {
  schemaVersion: 2;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
  ledger: CapacityLedger;
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
