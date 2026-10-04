export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';

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
  /** 容量账本的镜像：是否已在本机落地离线包，真实状态以 ledger 为准 */
  downloaded: boolean;
  sentences: Sentence[];
}

/** 离线包生命周期阶段 */
export type PackagePhase = 'queued' | 'downloading' | 'ready' | 'updating' | 'removing' | 'failed';

/** 受保护原因：当前课节 / 未提交草稿 / 已提交记录 / 教师反馈 */
export type ProtectedReason = 'active' | 'draft' | 'submitted' | 'feedback';

export interface OfflinePackage {
  lessonId: string;
  /** 课节内容版本（内容哈希），更新成功后才会切换 */
  version: string;
  /** 已落地版本占用的字节数 */
  sizeBytes: number;
  phase: PackagePhase;
  /** queued/downloading 时本次预占的字节；updating 时为新版包大小 */
  pendingSizeBytes: number;
  lastUsedAt: string;
  enqueuedAt: string;
  /** 认领本次写入的标签页，防止两个标签页重复下载同一份额度 */
  claim?: string;
  failReason?: string;
}

/** 标签页作答会话（含心跳），用于跨标签页判定“作答中”保护 */
export interface CapacitySession {
  tabId: string;
  lessonId: string;
  at: string;
}

export interface CapacityLedger {
  budgetBytes: number;
  /** downloading/updating 已预占但尚未落地的字节 */
  reservedBytes: number;
  packages: Record<string, OfflinePackage>;
  /** FIFO 下载/更新队列，存课节 id */
  queue: string[];
  sessions: CapacitySession[];
  /** 删除墓碑：lessonId -> 删除时间，供多标签页合并时识别“已移除” */
  tombstones: Record<string, string>;
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
  capacity: CapacityLedger;
}

export interface OfflineLedgerExport {
  budgetBytes: number;
  usedBytes: number;
  reservedBytes: number;
  queued: Array<{ lessonId: string; sizeBytes: number }>;
  packages: Array<{
    lessonId: string;
    lessonTitle: string;
    version: string;
    sizeBytes: number;
    phase: PackagePhase;
    protected: boolean;
    protectedReasons: ProtectedReason[];
    lastUsedAt: string;
    cached: boolean;
  }>;
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
