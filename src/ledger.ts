import { persist, state } from './store';
import type {
  CapacityLedger,
  CapacitySession,
  Lesson,
  OfflineLedgerExport,
  OfflinePackage,
  PackagePhase,
  ProtectedReason
} from './types';

/**
 * 容量账本（capacity ledger）
 *
 * 每个离线包一条账目：内容版本、占用字节、生命周期阶段、最后使用时间与排队位次；
 * 下载/更新先预占额度，落地失败回滚到原包；剩余容量不足时先进 FIFO 队列，
 * 仍装不下才按 LRU 淘汰“非受保护”的包。当前课节、未提交草稿、已提交记录、
 * 教师反馈以及其他标签页的作答会话始终受保护。
 */

export const STORAGE_BUDGET_BYTES = 560 * 1024; // 模拟手机端给离线课节预留的容量
const AUDIO_BYTES_PER_TOKEN = 6000; // 压缩音频的估算大小
const PACKAGE_OVERHEAD_BYTES = 12 * 1024;
const SESSION_FRESH_MS = 20_000;
const STAGE_DELAY_MS = 650;

/** 只有听写句的拉丁单词需要语音；中文译文/提示不计音频词数 */
const spokenTokenCount = (text: string): number => (text.match(/[\p{L}]+/gu) ?? []).filter((token) => /[a-zA-Z]/.test(token)).length;

const PHASE_RANK: Record<PackagePhase, number> = {
  ready: 5,
  downloading: 4,
  updating: 3,
  queued: 2,
  removing: 1,
  failed: 0
};

export const tabId = `tab-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;

/** 故障演练：下一次包写入（下载/更新）失败，用于演示“失败回到原包” */
let failNextWrite = false;
export function setFailNextWrite(value: boolean) {
  failNextWrite = value;
}

/** SW 缓存已核验的账目的瞬态标记（不落盘）：`lessonId:version` */
const cacheVerified = new Set<string>();

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).length;

function nowISO(): string {
  return new Date().toISOString();
}

/** FNV-1a 32 位内容哈希，作为离线包版本号 */
export function lessonVersion(lesson: Pick<Lesson, 'id' | 'title' | 'subtitle' | 'sentences'>): string {
  const stable = JSON.stringify({
    id: lesson.id,
    title: lesson.title,
    subtitle: lesson.subtitle,
    sentences: lesson.sentences.map((s) => [s.id, s.text, s.translation, s.note])
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < stable.length; i += 1) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 估算课节离线包大小：句文/译文/提示的文本 + 听写句音频 */
export function estimatePackageBytes(lesson: Lesson): number {
  const textBytes = lesson.sentences.reduce((sum, sentence) => sum + utf8Bytes(JSON.stringify(sentence)), 0);
  const audioBytes = lesson.sentences.reduce((sum, sentence) => sum + spokenTokenCount(sentence.text) * AUDIO_BYTES_PER_TOKEN, 0);
  return PACKAGE_OVERHEAD_BYTES + textBytes + audioBytes;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------------------------------------------------------------------------
// 账目初始化与迁移
// ---------------------------------------------------------------------------

export function createPackage(lesson: Lesson, phase: PackagePhase, lastUsedAt = nowISO()): OfflinePackage {
  const size = phase === 'ready' ? estimatePackageBytes(lesson) : 0;
  return {
    lessonId: lesson.id,
    version: lessonVersion(lesson),
    sizeBytes: size,
    phase,
    pendingSizeBytes: phase === 'ready' ? 0 : estimatePackageBytes(lesson),
    lastUsedAt,
    enqueuedAt: phase === 'queued' ? lastUsedAt : ''
  };
}

export function createInitialCapacity(courses: { lessons: Lesson[] }[]): CapacityLedger {
  const packages: Record<string, OfflinePackage> = {};
  for (const course of courses) {
    for (const lesson of course.lessons) {
      if (lesson.downloaded) {
        const entry = createPackage(lesson, 'ready');
        // 初始演示数据：airport-01 在 9 月已使用过
        entry.lastUsedAt = '2026-09-24T10:20:00.000Z';
        cacheVerified.add(`${lesson.id}:${entry.version}`);
        packages[lesson.id] = entry;
      }
    }
  }
  return {
    budgetBytes: STORAGE_BUDGET_BYTES,
    reservedBytes: 0,
    packages,
    queue: [],
    sessions: [],
    tombstones: {}
  };
}

/** 旧缓存（v1 的 downloaded 布尔标记 / 无账目）升级补齐账本 */
export function upgradeCapacity(raw: Partial<CapacityLedger> | undefined, courses: { lessons: Lesson[] }[]): CapacityLedger {
  const ledger = createInitialCapacity(courses);
  if (!raw) return ledger;
  ledger.budgetBytes = raw.budgetBytes || STORAGE_BUDGET_BYTES;
  ledger.reservedBytes = raw.reservedBytes || 0;
  ledger.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  ledger.queue = Array.isArray(raw.queue) ? raw.queue : [];
  ledger.tombstones = raw.tombstones ?? {};
  const known = new Set(courses.flatMap((course) => course.lessons.map((lesson) => lesson.id)));
  for (const [id, incoming] of Object.entries(raw.packages ?? {})) {
    if (!known.has(id)) continue; // 课节已移除的孤儿账目，不补回
    const lesson = courses.flatMap((course) => course.lessons).find((item) => item.id === id)!;
    const version = incoming.version || lessonVersion(lesson);
    const sizeBytes = incoming.sizeBytes || estimatePackageBytes(lesson);
    ledger.packages[id] = {
      lessonId: id,
      version,
      sizeBytes,
      phase: incoming.phase === 'ready' ? 'ready' : 'queued',
      pendingSizeBytes: incoming.phase === 'ready' ? 0 : incoming.pendingSizeBytes || estimatePackageBytes(lesson),
      lastUsedAt: incoming.lastUsedAt || nowISO(),
      enqueuedAt: incoming.enqueuedAt || (incoming.phase === 'queued' ? nowISO() : ''),
      claim: incoming.claim,
      failReason: incoming.failReason
    };
  }
  // 队列里引用了已不存在/已落地课节的脏数据清掉
  ledger.queue = ledger.queue.filter((id) => known.has(id) && ledger.packages[id]?.phase === 'queued');
  ledger.reservedBytes = recomputeReserved(ledger);
  return ledger;
}

// ---------------------------------------------------------------------------
// 容量计算与保护
// ---------------------------------------------------------------------------

export function readyBytes(ledger: CapacityLedger = state.capacity): number {
  return Object.values(ledger.packages)
    .filter((entry) => entry.phase === 'ready')
    .reduce((sum, entry) => sum + entry.sizeBytes, 0);
}

export function usedWithReserved(ledger: CapacityLedger = state.capacity): number {
  return readyBytes(ledger) + ledger.reservedBytes;
}

function recomputeReserved(ledger: CapacityLedger): number {
  return Object.values(ledger.packages)
    .filter((entry) => entry.phase === 'downloading' || entry.phase === 'updating')
    .reduce((sum, entry) => sum + entry.pendingSizeBytes, 0);
}

function hasDraft(lessonId: string): boolean {
  const progress = state.progress[lessonId];
  return !!progress && Object.values(progress.answers).some((answer) => answer.trim().length > 0);
}

export function protectedReasons(lessonId: string, at = Date.now()): ProtectedReason[] {
  const reasons: ProtectedReason[] = [];
  if (state.capacity.sessions.some((session) => session.lessonId === lessonId && at - Date.parse(session.at) <= SESSION_FRESH_MS)) {
    reasons.push('active');
  }
  if (hasDraft(lessonId)) reasons.push('draft');
  const lessonAttempts = state.attempts.filter((attempt) => attempt.lessonId === lessonId);
  if (lessonAttempts.length) reasons.push('submitted');
  if (lessonAttempts.some((attempt) => attempt.teacherFeedback.trim())) reasons.push('feedback');
  return reasons;
}

export function isProtected(lessonId: string): boolean {
  return protectedReasons(lessonId).length > 0;
}

// ---------------------------------------------------------------------------
// Service Worker 缓存通道
// ---------------------------------------------------------------------------

interface CacheReply {
  ok: boolean;
  entries?: Array<{ lessonId: string; version: string }>;
  unavailable?: boolean;
}

function postCache(message: unknown): Promise<CacheReply> {
  if (!navigator.serviceWorker?.controller) {
    return Promise.resolve({ ok: true, unavailable: true });
  }
  const controller = navigator.serviceWorker.controller;
  let settled = false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, unavailable: true });
    }, 900);
    channel.port1.onmessage = (event: MessageEvent<CacheReply>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(event.data);
    };
    try {
      controller.postMessage(message, [channel.port2]);
    } catch {
      settled = true;
      window.clearTimeout(timer);
      resolve({ ok: false, unavailable: true });
    }
  });
}

async function cachePut(lesson: Lesson, version: string): Promise<boolean> {
  const reply = await postCache({ type: 'put', lesson: { id: lesson.id, version, payload: JSON.stringify(lesson) } });
  if (reply.unavailable) return true; // 无 SW 环境（测试/不支持）视为本地落地成功
  if (reply.ok) cacheVerified.add(`${lesson.id}:${version}`);
  return reply.ok;
}

async function cacheDelete(lessonId: string): Promise<boolean> {
  const reply = await postCache({ type: 'delete', lessonId });
  for (const key of [...cacheVerified]) {
    if (key.startsWith(`${lessonId}:`)) cacheVerified.delete(key);
  }
  return reply.ok || !!reply.unavailable;
}

/** 与 SW 实际缓存对账：补齐旧缓存账目、清掉账本里有但缓存已丢的“伪可用”状态 */
export async function reconcileCache(): Promise<string[]> {
  const missing: string[] = [];
  if (!navigator.serviceWorker?.controller) {
    for (const entry of Object.values(state.capacity.packages)) {
      if (entry.phase === 'ready') cacheVerified.add(`${entry.lessonId}:${entry.version}`);
    }
    return missing;
  }
  const reply = await postCache({ type: 'lessons' });
  const cached = new Map((reply.entries ?? []).map((item) => [item.lessonId, item.version]));
  for (const entry of Object.values(state.capacity.packages)) {
    if (entry.phase !== 'ready') continue;
    if (cached.get(entry.lessonId) === entry.version) {
      cacheVerified.add(`${entry.lessonId}:${entry.version}`);
    } else {
      cacheVerified.delete(`${entry.lessonId}:${entry.version}`);
      missing.push(entry.lessonId);
    }
  }
  return missing;
}

export function isCached(lessonId: string): boolean {
  const entry = state.capacity.packages[lessonId];
  return !!entry && entry.phase === 'ready' && cacheVerified.has(`${lessonId}:${entry.version}`);
}

export function offlineAvailable(lessonId: string): boolean {
  return state.capacity.packages[lessonId]?.phase === 'ready';
}

// ---------------------------------------------------------------------------
// 模拟包写入（真实项目里是网络下载 / 写文件系统）
// ---------------------------------------------------------------------------

function stage(): Promise<void> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (failNextWrite) {
        failNextWrite = false;
        reject(new Error('write-failed'));
      } else {
        resolve();
      }
    }, STAGE_DELAY_MS);
  });
}

// ---------------------------------------------------------------------------
// 作答会话心跳：跨标签页标记“正在作答”
// ---------------------------------------------------------------------------

let heartbeatTimer = 0;

export function touchSession(lessonId: string) {
  const at = nowISO();
  const existing = state.capacity.sessions.find((session) => session.tabId === tabId);
  if (existing) {
    existing.lessonId = lessonId;
    existing.at = at;
  } else {
    state.capacity.sessions.push({ tabId, lessonId, at });
  }
  pruneSessions();
  persist();
}

export function endSession() {
  state.capacity.sessions = state.capacity.sessions.filter((session) => session.tabId !== tabId);
  persist();
}

function pruneSessions() {
  const at = Date.now();
  state.capacity.sessions = state.capacity.sessions.filter(
    (session) => at - Date.parse(session.at) <= SESSION_FRESH_MS
  );
}

export function startHeartbeat(lessonId: () => string) {
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    pruneSessions();
    const id = lessonId();
    if (id) touchSession(id);
  }, 8000);
}

export function stopHeartbeat() {
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
}

// ---------------------------------------------------------------------------
// 镜像 downloaded 标记（UI 与旧代码兼容），真实状态以账本为准
// ---------------------------------------------------------------------------

export function mirrorDownloadFlags() {
  for (const course of state.courses) {
    for (const lesson of course.lessons) {
      lesson.downloaded = state.capacity.packages[lesson.id]?.phase === 'ready';
    }
  }
}

export function touchUsage(lessonId: string) {
  const entry = state.capacity.packages[lessonId];
  if (entry && entry.phase === 'ready') entry.lastUsedAt = nowISO();
}

function markTombstone(lessonId: string) {
  state.capacity.tombstones[lessonId] = nowISO();
}

function clearTombstone(lessonId: string) {
  delete state.capacity.tombstones[lessonId];
}

// ---------------------------------------------------------------------------
// LRU 淘汰
// ---------------------------------------------------------------------------

/** 淘汰最久未用且不受保护的已落地包，直到腾出 needBytes；返回被淘汰课节与释放字节 */
function evictLRU(needBytes: number): { lessons: Lesson[]; freed: number } {
  const lessons: Lesson[] = [];
  let freed = 0;
  const candidates = Object.values(state.capacity.packages)
    .filter((entry) => entry.phase === 'ready' && protectedReasons(entry.lessonId).length === 0)
    .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt));
  for (const entry of candidates) {
    if (freed >= needBytes) break;
    const lesson = state.courses.flatMap((course) => course.lessons).find((item) => item.id === entry.lessonId);
    delete state.capacity.packages[entry.lessonId];
    markTombstone(entry.lessonId);
    freed += entry.sizeBytes;
    if (lesson) lessons.push(lesson);
    void cacheDelete(entry.lessonId); // 缓存清理失败不阻塞账本决策
  }
  if (lessons.length) mirrorDownloadFlags();
  return { lessons, freed };
}

// ---------------------------------------------------------------------------
// 下载队列（FIFO）
// ---------------------------------------------------------------------------

let pumping = false;

async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (state.capacity.queue.length) {
      const lessonId = state.capacity.queue[0];
      const entry = state.capacity.packages[lessonId];
      const lesson = state.courses.flatMap((course) => course.lessons).find((item) => item.id === lessonId);
      if (!entry || entry.phase !== 'queued' || !lesson) {
        state.capacity.queue.shift();
        continue;
      }

      const need = entry.pendingSizeBytes;
      const needFree = usedWithReserved() + need - state.capacity.budgetBytes;
      if (needFree > 0) {
        evictLRU(needFree);
        if (usedWithReserved() + need > state.capacity.budgetBytes) {
          // 受保护内容占满额度，队头装不下，后面更装不下（FIFO），暂停排队
          break;
        }
      }

      // 认领：同一课节只能被一个标签页下载，重复下载不重复占额度
      state.capacity.queue.shift();
      entry.phase = 'downloading';
      entry.claim = tabId;
      entry.failReason = undefined;
      state.capacity.reservedBytes = recomputeReserved(state.capacity);
      mirrorDownloadFlags();
      persist();

      try {
        await stage();
        const putOk = await cachePut(lesson, entry.version);
        if (!putOk) throw new Error('cache-put-failed');
        entry.phase = 'ready';
        entry.sizeBytes = need;
        entry.pendingSizeBytes = 0;
        entry.lastUsedAt = nowISO();
        entry.claim = undefined;
        state.capacity.reservedBytes = recomputeReserved(state.capacity);
        mirrorDownloadFlags();
        persist();
      } catch {
        // 落地失败：释放预占额度，账目回到“未下载”，不占任何容量
        entry.phase = 'failed';
        entry.claim = undefined;
        entry.failReason = '包写入失败，请重试';
        state.capacity.reservedBytes = recomputeReserved(state.capacity);
        mirrorDownloadFlags();
        persist();
        break;
      }
    }
  } finally {
    pumping = false;
  }
}

export interface RequestResult {
  status: 'ready' | 'queued' | 'duplicate' | 'too-large' | 'failed';
  evictedTitles: string[];
  message: string;
}

/** 请求下载离线包；容量不足先排队，装不下再淘汰 LRU */
export async function requestDownload(lessonId: string): Promise<RequestResult> {
  const lesson = state.courses.flatMap((course) => course.lessons).find((item) => item.id === lessonId);
  if (!lesson) return { status: 'failed', evictedTitles: [], message: '课节不存在' };

  const existing = state.capacity.packages[lessonId];
  if (existing) {
    if (existing.phase === 'ready') return { status: 'duplicate', evictedTitles: [], message: '该课节已下载，不会重复占用额度' };
    if (existing.phase === 'queued' || existing.phase === 'downloading') {
      return { status: 'duplicate', evictedTitles: [], message: '该课节已在下载队列中' };
    }
    if (existing.phase === 'updating' || existing.phase === 'removing') {
      return { status: 'duplicate', evictedTitles: [], message: '课节正在更新或移除，请稍候' };
    }
    // failed：允许重试
    delete state.capacity.packages[lessonId];
  }

  const size = estimatePackageBytes(lesson);
  if (size > state.capacity.budgetBytes) {
    return { status: 'too-large', evictedTitles: [], message: '课节包超过离线容量上限，无法下载' };
  }

  const before = usedWithReserved();
  let evictedTitles: string[] = [];
  if (before + size > state.capacity.budgetBytes) {
    const needFree = before + size - state.capacity.budgetBytes;
    evictedTitles = evictLRU(needFree).lessons.map((item) => item.title);
  }

  const entry = createPackage(lesson, 'queued');
  entry.pendingSizeBytes = size;
  entry.enqueuedAt = nowISO();
  state.capacity.packages[lessonId] = entry;
  clearTombstone(lessonId);
  state.capacity.queue.push(lessonId);
  persist();
  await pumpQueue();

  const after = state.capacity.packages[lessonId];
  if (after?.phase === 'ready') {
    return {
      status: 'ready',
      evictedTitles,
      message: evictedTitles.length ? `已下载；容量不足，已自动移除最久未用的《${evictedTitles.join('》《')}》` : '离线包已下载'
    };
  }
  if (after?.phase === 'failed') {
    return { status: 'failed', evictedTitles, message: after.failReason || '下载失败，预占额度已释放' };
  }
  return { status: 'queued', evictedTitles, message: '剩余容量不足，已加入下载队列，腾出空间后自动继续' };
}

/** 手动移除（允许移除受保护包，但会保留进度与记录）；排队中则直接取消 */
export async function requestRemoval(lessonId: string): Promise<string> {
  const entry = state.capacity.packages[lessonId];
  if (!entry) return '该课节未下载';
  if (entry.phase === 'downloading' || entry.phase === 'updating') return '课节正在写入，暂不能移除';

  if (entry.phase === 'queued' || entry.phase === 'failed') {
    state.capacity.queue = state.capacity.queue.filter((id) => id !== lessonId);
    delete state.capacity.packages[lessonId];
    markTombstone(lessonId);
    mirrorDownloadFlags();
    persist();
    void pumpQueue();
    return '已取消下载';
  }

  // ready：先进入 removing 阶段（移除不占额度，只做账目锁定），完成后再删
  entry.phase = 'removing';
  entry.claim = tabId;
  mirrorDownloadFlags();
  persist();
  await stage().catch(() => undefined);
  await cacheDelete(lessonId);
  delete state.capacity.packages[lessonId];
  markTombstone(lessonId);
  mirrorDownloadFlags();
  persist();
  void pumpQueue(); // 腾出空间后接队列
  return '离线包已移除，作答进度与记录仍保留';
}

// ---------------------------------------------------------------------------
// 课节更新：预占新版空间，失败回到原包
// ---------------------------------------------------------------------------

const REVISION_MARKER = '（内容已修订）';

function cloneLesson(lesson: Lesson): Lesson {
  return structuredClone(lesson);
}

function reviseLesson(lesson: Lesson): Lesson {
  const revised = cloneLesson(lesson);
  const last = revised.sentences[revised.sentences.length - 1];
  if (last.note.includes(REVISION_MARKER)) {
    last.note = last.note.replace(REVISION_MARKER, '');
  } else {
    last.note = `${last.note}${REVISION_MARKER}`;
  }
  return revised;
}

export interface UpdateResult {
  status: 'updated' | 'rolled-back' | 'busy' | 'not-downloaded';
  message: string;
}

export async function refreshLesson(lessonId: string): Promise<UpdateResult> {
  const course = state.courses.find((item) => item.lessons.some((lesson) => lesson.id === lessonId));
  const lesson = course?.lessons.find((item) => item.id === lessonId);
  const entry = state.capacity.packages[lessonId];
  if (!lesson || !course) return { status: 'not-downloaded', message: '课节不存在' };
  if (!entry || entry.phase !== 'ready') return { status: 'not-downloaded', message: '请先下载课节再更新' };

  const revised = reviseLesson(lesson);
  const newVersion = lessonVersion(revised);
  const newSize = estimatePackageBytes(revised);
  if (newVersion === entry.version) {
    // reviseLesson 会在两个修订版之间来回；理论上不会相同，兜底保护
    return { status: 'busy', message: '已是最新版本' };
  }

  // 1) 预占新版空间（旧包保留，故按 旧已占 + 新版 计算），不够先淘汰 LRU
  if (usedWithReserved() + newSize > state.capacity.budgetBytes) {
    evictLRU(usedWithReserved() + newSize - state.capacity.budgetBytes);
  }
  if (usedWithReserved() + newSize > state.capacity.budgetBytes) {
    // 装不下：不修改任何内容与账目，原包继续可用
    return { status: 'rolled-back', message: '剩余容量不足，更新已取消，原离线包保留' };
  }

  // 2) 进入更新阶段并预占额度
  entry.phase = 'updating';
  entry.pendingSizeBytes = newSize;
  entry.claim = tabId;
  state.capacity.reservedBytes = recomputeReserved(state.capacity);
  persist();

  // 3) 拉取/写入新包（此时 state 里仍是旧内容，旧缓存也还在）
  let writeOk = true;
  try {
    await stage();
    writeOk = await cachePut(revised, newVersion);
  } catch {
    writeOk = false;
  }

  if (!writeOk) {
    // 失败回滚到原包：恢复预占、恢复旧版本账目
    entry.phase = 'ready';
    entry.pendingSizeBytes = 0;
    entry.claim = undefined;
    state.capacity.reservedBytes = recomputeReserved(state.capacity);
    persist();
    return { status: 'rolled-back', message: '更新失败，已回滚到原离线包，进度不变' };
  }

  // 4) 提交：替换课节内容（句子 id 不变，原进度自动接回），切换账目版本
  const index = course.lessons.findIndex((item) => item.id === lessonId);
  course.lessons[index] = revised;
  entry.version = newVersion;
  entry.sizeBytes = newSize;
  entry.pendingSizeBytes = 0;
  entry.phase = 'ready';
  entry.lastUsedAt = nowISO();
  entry.claim = undefined;
  state.capacity.reservedBytes = recomputeReserved(state.capacity);
  mirrorDownloadFlags();
  persist();
  void pumpQueue();
  return { status: 'updated', message: '课节已更新到最新版本，原作答进度已接回' };
}

// ---------------------------------------------------------------------------
// 跨标签页账本合并
// ---------------------------------------------------------------------------

function entryTouchedAt(entry: OfflinePackage): number {
  const candidates = [entry.lastUsedAt, entry.enqueuedAt].filter(Boolean).map((value) => Date.parse(value));
  return candidates.length ? Math.max(...candidates) : 0;
}

export function mergeIncomingCapacity(incoming: CapacityLedger) {
  const local = state.capacity;

  // 墓碑合并：取更新的删除时间
  for (const [id, at] of Object.entries(incoming.tombstones ?? {})) {
    if (!local.tombstones[id] || Date.parse(at) > Date.parse(local.tombstones[id])) {
      local.tombstones[id] = at;
    }
  }

  // 会话：按 tabId 合并取最新
  const sessions = new Map<string, CapacitySession>();
  for (const session of [...local.sessions, ...incoming.sessions]) {
    const known = sessions.get(session.tabId);
    if (!known || Date.parse(session.at) > Date.parse(known.at)) sessions.set(session.tabId, session);
  }
  local.sessions = [...sessions.values()];

  // 包账目：同一课节取阶段更靠后的；阶段相同取时间戳更新的；墓碑更新则直接删除
  for (const [id, theirs] of Object.entries(incoming.packages)) {
    const tombAt = local.tombstones[id];
    const theirsTouched = entryTouchedAt(theirs);
    if (tombAt && theirsTouched <= Date.parse(tombAt)) {
      delete local.packages[id];
      continue;
    }
    const ours = local.packages[id];
    if (!ours) {
      local.packages[id] = theirs;
      continue;
    }
    const oursTouched = entryTouchedAt(ours);
    const pickTheirs =
      PHASE_RANK[theirs.phase] > PHASE_RANK[ours.phase] ||
      (PHASE_RANK[theirs.phase] === PHASE_RANK[ours.phase] && theirsTouched > oursTouched);
    if (pickTheirs) local.packages[id] = theirs;
  }
  // 他页已删、本页还有旧条目
  for (const [id, at] of Object.entries(local.tombstones)) {
    const ours = local.packages[id];
    if (ours && entryTouchedAt(ours) <= Date.parse(at)) {
      delete local.packages[id];
    }
  }

  // 队列：去重后保持 FIFO（他页在前，本页新增在后）
  const seen = new Set<string>();
  local.queue = [...incoming.queue, ...local.queue].filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  local.reservedBytes = recomputeReserved(local);
  mirrorDownloadFlags();
  // 他页可能腾出了空间，本页尝试接队列
  void pumpQueue();
}

/** 合并他页的进度/记录（按课节取最新、记录按 id 去重） */
export function mergeIncomingProgressAndAttempts(incoming: Pick<typeof state, 'attempts' | 'progress' | 'theme' | 'fontScale' | 'role'>) {
  for (const theirs of incoming.attempts) {
    if (!state.attempts.some((ours) => ours.id === theirs.id)) state.attempts.push(theirs);
  }
  for (const [lessonId, theirProgress] of Object.entries(incoming.progress)) {
    const ours = state.progress[lessonId];
    if (!ours || Date.parse(theirProgress.updatedAt) > Date.parse(ours.updatedAt)) {
      state.progress[lessonId] = theirProgress;
    }
  }
  state.theme = incoming.theme;
  state.fontScale = incoming.fontScale;
  state.role = incoming.role;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function ledgerExport(): OfflineLedgerExport {
  return {
    budgetBytes: state.capacity.budgetBytes,
    usedBytes: readyBytes(),
    reservedBytes: state.capacity.reservedBytes,
    queued: state.capacity.queue.map((id) => ({
      lessonId: id,
      sizeBytes: state.capacity.packages[id]?.pendingSizeBytes ?? 0
    })),
    packages: Object.values(state.capacity.packages).map((entry) => {
      const lesson = state.courses.flatMap((course) => course.lessons).find((item) => item.id === entry.lessonId);
      return {
        lessonId: entry.lessonId,
        lessonTitle: lesson?.title ?? entry.lessonId,
        version: entry.version,
        sizeBytes: entry.phase === 'ready' ? entry.sizeBytes : entry.pendingSizeBytes,
        phase: entry.phase,
        protected: protectedReasons(entry.lessonId).length > 0,
        protectedReasons: protectedReasons(entry.lessonId),
        lastUsedAt: entry.lastUsedAt,
        cached: isCached(entry.lessonId)
      };
    })
  };
}
