<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { courseForLesson, exportRecords, lessonById, persist, saveAttempt, setDownloaded, state, updateTokenClassification } from './store';
import type { ErrorCategory, Lesson, PracticeAttempt, PracticeView } from './types';
import { compareSentence, scoreAttempt, segmentText } from './utils';

const view = ref<PracticeView>(state.activeLessonId ? 'practice' : 'library');
const online = ref(navigator.onLine);
const toast = ref('');
const resultAttemptId = ref('');
const selectedResultSentence = ref(0);
const segmentStart = ref(0);
const segmentEnd = ref(1);
const teacherAttemptId = ref(state.attempts[0]?.id ?? '');
const teacherDraft = ref(state.attempts[0]?.teacherFeedback ?? '');
let toastTimer = 0;

const activeLesson = computed(() => lessonById(state.activeLessonId));
const activeCourse = computed(() => activeLesson.value ? courseForLesson(activeLesson.value.id) : undefined);
const currentSentence = computed(() => {
  const lesson = activeLesson.value;
  if (!lesson) return undefined;
  return lesson.sentences.find((sentence) => sentence.id === state.activeSentenceId) ?? lesson.sentences[0];
});
const activeProgress = computed(() => activeLesson.value ? state.progress[activeLesson.value.id] : undefined);
const currentAnswer = ref('');
const currentIndex = computed(() => {
  if (!activeLesson.value || !currentSentence.value) return 0;
  return activeLesson.value.sentences.findIndex((item) => item.id === currentSentence.value?.id);
});
const lessonCompletion = computed(() => {
  if (!activeLesson.value || !activeProgress.value) return 0;
  const answered = activeLesson.value.sentences.filter((sentence) => (activeProgress.value?.answers[sentence.id] ?? '').trim()).length;
  return Math.round((answered / activeLesson.value.sentences.length) * 100);
});
const resultAttempt = computed(() => state.attempts.find((attempt) => attempt.id === resultAttemptId.value));
const resultSentence = computed(() => resultAttempt.value?.sentenceAttempts[selectedResultSentence.value]);
const teacherAttempt = computed(() => state.attempts.find((attempt) => attempt.id === teacherAttemptId.value));
const totalWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).length);
const correctedWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).filter((token) => !token.correct && token.category !== 'unclassified').length);

const categoryOptions: Array<{ value: ErrorCategory; label: string }> = [
  { value: 'unclassified', label: '未分类' },
  { value: 'spelling', label: '拼写错误' },
  { value: 'omitted', label: '漏词' },
  { value: 'extra', label: '多词' },
  { value: 'punctuation', label: '标点' },
  { value: 'grammar', label: '语法' }
];

watch(currentSentence, (sentence) => {
  currentAnswer.value = sentence && activeProgress.value ? activeProgress.value.answers[sentence.id] ?? '' : '';
  segmentStart.value = 0;
  segmentEnd.value = sentence ? Math.max(0, segmentText(sentence.text).length - 1) : 0;
}, { immediate: true });

watch(currentAnswer, (value) => {
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: sentence.id, updatedAt: new Date().toISOString() };
  progress.answers[sentence.id] = value;
  progress.activeSentenceId = sentence.id;
  progress.updatedAt = new Date().toISOString();
  state.progress[lesson.id] = progress;
});

watch(activeLesson, (lesson) => {
  if (!lesson) return;
  state.activeLessonId = lesson.id;
  state.activeSentenceId = currentSentence.value?.id ?? lesson.sentences[0].id;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: lesson.sentences[0].id, updatedAt: new Date().toISOString() };
  if (!lesson.sentences.some((sentence) => sentence.id === progress.activeSentenceId)) progress.activeSentenceId = lesson.sentences[0].id;
  state.progress[lesson.id] = progress;
  state.activeSentenceId = progress.activeSentenceId;
  currentAnswer.value = progress.answers[state.activeSentenceId] ?? '';
});

watch(teacherAttemptId, (id) => {
  teacherDraft.value = state.attempts.find((attempt) => attempt.id === id)?.teacherFeedback ?? '';
});

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 2400);
}

function startLesson(lesson: Lesson) {
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: lesson.sentences[0].id, updatedAt: new Date().toISOString() };
  state.progress[lesson.id] = progress;
  state.activeLessonId = lesson.id;
  state.activeSentenceId = progress.activeSentenceId || lesson.sentences[0].id;
  currentAnswer.value = progress.answers[state.activeSentenceId] ?? '';
  view.value = 'practice';
  persist();
}

function goToSentence(index: number) {
  const lesson = activeLesson.value;
  if (!lesson || !lesson.sentences[index]) return;
  const target = lesson.sentences[index];
  state.activeSentenceId = target.id;
  const progress = state.progress[lesson.id];
  if (progress) {
    progress.activeSentenceId = target.id;
    progress.updatedAt = new Date().toISOString();
  }
  currentAnswer.value = progress?.answers[target.id] ?? '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function submitLesson() {
  const lesson = activeLesson.value;
  const course = activeCourse.value;
  if (!lesson || !course) return;
  const progress = state.progress[lesson.id];
  const answeredCount = lesson.sentences.filter((sentence) => (progress?.answers[sentence.id] ?? '').trim()).length;
  if (!answeredCount) {
    notify('请至少输入一句话再提交');
    return;
  }
  if (answeredCount < lesson.sentences.length && !window.confirm(`还有 ${lesson.sentences.length - answeredCount} 句未作答，仍然提交吗？`)) return;
  const sentenceAttempts = lesson.sentences.map((sentence) => {
    const source = sentence.text;
    const answer = progress?.answers[sentence.id] ?? '';
    const tokens = compareSentence(source, answer);
    const correct = tokens.filter((token) => token.correct).length;
    return { sentenceId: sentence.id, source, answer, tokens, score: tokens.length ? Math.round((correct / tokens.length) * 100) : 0 };
  });
  const attempt: PracticeAttempt = {
    id: `attempt-${Date.now()}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseTitle: course.title,
    submittedAt: new Date().toISOString(),
    score: scoreAttempt(sentenceAttempts),
    sentenceAttempts,
    teacherFeedback: ''
  };
  saveAttempt(attempt);
  resultAttemptId.value = attempt.id;
  selectedResultSentence.value = 0;
  syncSegment();
  view.value = 'result';
  persist();
  notify('已提交，逐词结果已生成');
}

function syncSegment() {
  const tokenCount = segmentText(resultSentence.value?.source ?? '').length;
  segmentStart.value = 0;
  segmentEnd.value = Math.max(0, tokenCount - 1);
}

function replay(text: string, rate = 0.82) {
  if (!('speechSynthesis' in window)) {
    notify('当前浏览器不支持语音播放');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

function replaySegment() {
  const tokens = segmentText(resultSentence.value?.source ?? '');
  const start = Math.min(segmentStart.value, segmentEnd.value);
  const end = Math.max(segmentStart.value, segmentEnd.value);
  replay(tokens.slice(start, end + 1).map((token) => token.display).join(' '), 0.72);
}

function selectResultSentence(index: number) {
  selectedResultSentence.value = index;
  syncSegment();
}

function saveClassification(attemptId: string, sentenceId: string, tokenIndex: number, category: ErrorCategory, reason: string) {
  updateTokenClassification(attemptId, sentenceId, tokenIndex, { category, reason });
  persist();
}

function saveTeacherFeedback() {
  const attempt = teacherAttempt.value;
  if (!attempt) return;
  attempt.teacherFeedback = teacherDraft.value.trim();
  persist();
  notify('教师反馈已保存');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
}

function changeFont(delta: number) {
  state.fontScale = Math.min(1.25, Math.max(0.85, Number((state.fontScale + delta).toFixed(2))));
}

function downloadRecords() {
  const blob = new Blob([exportRecords()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `echo-step-records-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify('练习记录已导出');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function onConnectionChange() {
  online.value = navigator.onLine;
  persist();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') persist();
}

onMounted(() => {
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  window.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', persist);
});

onBeforeUnmount(() => {
  window.removeEventListener('online', onConnectionChange);
  window.removeEventListener('offline', onConnectionChange);
  window.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', persist);
  persist();
});
</script>

<template>
  <var-app>
    <div class="app-shell" :data-theme="state.theme" :style="{ '--font-scale': state.fontScale }">
      <div v-if="view === 'library'" class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">E</div>
            <div><h1>EchoStep</h1><p>移动端语言听写</p></div>
          </div>
          <div class="icon-row">
            <button class="icon-button" :aria-label="state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式'" @click="toggleTheme">{{ state.theme === 'light' ? '◐' : '☀' }}</button>
            <button class="icon-button" aria-label="减小字号" @click="changeFont(-0.05)">A−</button>
            <button class="icon-button" aria-label="增大字号" @click="changeFont(0.05)">A＋</button>
          </div>
        </header>

        <section class="hero">
          <h2>今天也把声音变成文字</h2>
          <p>下载课程后可离线作答，答案和当前位置会自动恢复。</p>
          <div class="hero-stats">
            <div class="hero-stat"><strong>{{ state.attempts.length }}</strong><span>练习记录</span></div>
            <div class="hero-stat"><strong>{{ correctedWords }}</strong><span>已分类错误</span></div>
            <div class="hero-stat"><strong>{{ totalWords }}</strong><span>累计词数</span></div>
          </div>
        </section>

        <div class="offline-banner" :class="{ online }">
          <span>{{ online ? '● 在线 · 数据已保存到本机' : '● 离线模式 · 可继续已下载课程' }}</span>
          <span>{{ online ? '本地优先存储' : '恢复网络后继续保存' }}</span>
        </div>

        <div class="section-head">
          <h3>课程库</h3>
          <div class="segmented">
            <button :class="{ active: state.role === 'learner' }" @click="state.role = 'learner'; view = 'library'">学习</button>
            <button :class="{ active: state.role === 'teacher' }" @click="state.role = 'teacher'; view = 'teacher'">教师</button>
          </div>
        </div>

        <article v-for="course in state.courses" :key="course.id" class="course-card">
          <div class="course-title">
            <div><h3>{{ course.title }}</h3><p>{{ course.description }}</p></div>
            <span class="level-badge">{{ course.level }}</span>
          </div>
          <div v-for="lesson in course.lessons" :key="lesson.id" class="lesson-row">
            <div><h4>{{ lesson.title }}</h4><p>{{ lesson.subtitle }} · {{ lesson.sentences.length }} 句 · 约 {{ lesson.estimatedMinutes }} 分钟</p></div>
            <div class="lesson-actions">
              <var-switch :model-value="lesson.downloaded" @update:model-value="setDownloaded(lesson.id, $event as boolean)" />
              <var-button type="primary" size="small" @click="startLesson(lesson)">{{ lesson.downloaded ? '继续' : '开始' }}</var-button>
            </div>
          </div>
        </article>

        <div class="section-head"><h3>最近练习</h3><span>{{ state.attempts.length }} 条记录</span></div>
        <article v-if="state.attempts.length" class="panel">
          <div v-for="attempt in state.attempts.slice(0, 4)" :key="attempt.id" class="history-card">
            <div class="history-top"><strong>{{ attempt.lessonTitle }}</strong><span class="history-score">{{ attempt.score }} 分</span></div>
            <p>{{ formatDate(attempt.submittedAt) }} · {{ attempt.teacherFeedback || '暂无教师反馈' }}</p>
          </div>
          <var-button block type="primary" variant="outline" @click="downloadRecords">导出全部练习记录</var-button>
        </article>
        <div v-else class="empty-state"><strong>还没有练习记录</strong>完成一次听写后，可在这里复核和导出。</div>
      </div>

      <div v-else-if="view === 'practice' && activeLesson" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
            <div><h2>{{ activeLesson.title }}</h2></div>
            <span class="status-chip">{{ online ? '在线' : '离线' }}</span>
          </div>
          <div class="progress-line">
            <div class="sentence-count"><span>第 {{ currentIndex + 1 }} / {{ activeLesson.sentences.length }} 句</span><span>{{ lessonCompletion }}% 已填写</span></div>
            <var-progress :value="lessonCompletion" color="#1769e0" />
          </div>
        </header>

        <section class="audio-card">
          <div class="audio-meta">
            <button class="play-button" aria-label="播放当前句子" @click="replay(currentSentence?.text ?? '')">▶</button>
            <div><strong>听写提示</strong><p>先完整播放，再输入你听到的英文。播放速度已放慢。</p></div>
          </div>
        </section>

        <div class="dictation-label"><strong>输入听到的内容</strong><span>答案在本机自动保存</span></div>
        <textarea v-model="currentAnswer" class="answer-box" :aria-label="`第 ${currentIndex + 1} 句听写答案`" placeholder="Type what you hear..." @keydown.ctrl.enter="submitLesson" @keydown.meta.enter="submitLesson"></textarea>
        <div class="practice-actions">
          <var-button block type="default" variant="outline" @click="replay(currentSentence?.text ?? '')">再听一次</var-button>
          <var-button block type="primary" @click="submitLesson">提交本次听写</var-button>
        </div>

        <div class="sentence-picker" aria-label="句子导航">
          <button v-for="(sentence, index) in activeLesson.sentences" :key="sentence.id" class="sentence-dot" :class="{ active: sentence.id === currentSentence?.id, done: !!activeProgress?.answers[sentence.id] }" :aria-label="`跳到第 ${index + 1} 句`" @click="goToSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="currentSentence" class="panel">
          <div class="detail-head"><div><h3>场景提示</h3><p>{{ currentSentence.translation }}</p></div></div>
          <div class="feedback-card">{{ currentSentence.note }}</div>
        </section>
      </div>

      <div v-else-if="view === 'result' && resultAttempt" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <span class="status-chip">提交于 {{ formatDate(resultAttempt.submittedAt) }}</span>
          <button class="icon-button" @click="downloadRecords">导出</button>
        </header>

        <section class="panel result-score">
          <div class="score-ring" :style="{ '--score': `${resultAttempt.score}%` }"><strong>{{ resultAttempt.score }}</strong></div>
          <h2>{{ resultAttempt.score >= 90 ? '几乎完美' : resultAttempt.score >= 70 ? '继续打磨细节' : '再听一遍会更好' }}</h2>
          <p>{{ resultAttempt.lessonTitle }} · 点击红色词可单独重听，并记录错误原因。</p>
        </section>

        <div class="sentence-picker">
          <button v-for="(attempt, index) in resultAttempt.sentenceAttempts" :key="attempt.sentenceId" class="sentence-dot" :class="{ active: index === selectedResultSentence }" @click="selectResultSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="resultSentence" class="panel token-panel">
          <div class="detail-head">
            <div><h3>第 {{ selectedResultSentence + 1 }} 句逐词结果</h3><p>{{ resultSentence.source }}</p></div>
            <span class="history-score">{{ resultSentence.score }}%</span>
          </div>
          <div class="word-list">
            <button v-for="token in resultSentence.tokens" :key="`${token.index}-${token.expected}-${token.actual}`" class="word-chip" :class="{ wrong: !token.correct }" :title="token.correct ? '点击重听' : `你的答案：${token.actual || '未输入'}`" @click="replay(token.expected || token.actual, 0.7)">
              {{ token.expected || `[+${token.actual}]` }}<small v-if="!token.correct">{{ token.actual || '漏词' }}</small>
            </button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>片段重听</strong><span>选择起止词后播放</span></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center">
              <select v-model.number="segmentStart" aria-label="片段起点"><option v-for="token in segmentText(resultSentence.source)" :key="`s-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <select v-model.number="segmentEnd" aria-label="片段终点"><option v-for="token in segmentText(resultSentence.source)" :key="`e-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <var-button type="primary" size="small" @click="replaySegment">播放片段</var-button>
            </div>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>错误分类与原因</strong><span>会被写入本地记录</span></div>
            <div v-for="token in resultSentence.tokens.filter((item) => !item.correct)" :key="`edit-${token.index}`" class="feedback-card">
              <strong>{{ token.expected || `多出的词：${token.actual}` }}</strong>
              <div style="display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 9px">
                <select :value="token.category" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, ($event.target as HTMLSelectElement).value as ErrorCategory, token.reason)">
                  <option v-for="option in categoryOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input :value="token.reason" placeholder="记录原因，如连读、词尾未听清" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, token.category, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="resultAttempt.teacherFeedback" class="panel"><div class="feedback-card"><strong>教师反馈</strong><p>{{ resultAttempt.teacherFeedback }}</p></div></section>
        <var-button block type="primary" @click="startLesson(activeLesson!)">返回本次课程</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="downloadRecords">导出练习记录</var-button>
      </div>

      <div v-else-if="view === 'teacher'" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <div class="brand"><div class="brand-mark">T</div><div><h1>教师复核</h1><p>查看作答并写入反馈</p></div></div>
        </header>

        <div v-if="state.attempts.length" class="panel">
          <div class="dictation-label"><strong>选择一次作答</strong><span>{{ state.attempts.length }} 条</span></div>
          <var-select v-model="teacherAttemptId" placeholder="选择作答">
            <var-option v-for="attempt in state.attempts" :key="attempt.id" :label="`${attempt.lessonTitle} · ${attempt.score} 分 · ${formatDate(attempt.submittedAt)}`" :value="attempt.id" />
          </var-select>
          <template v-if="teacherAttempt">
            <div class="feedback-card"><strong>{{ teacherAttempt.courseTitle }}</strong><p>{{ teacherAttempt.lessonTitle }} · 总分 {{ teacherAttempt.score }}，完成 {{ teacherAttempt.sentenceAttempts.length }} 句。</p></div>
            <div class="teacher-editor">
              <textarea v-model="teacherDraft" placeholder="给学生一条具体、可执行的反馈..." aria-label="教师反馈"></textarea>
              <var-button block type="primary" style="margin-top: 10px" @click="saveTeacherFeedback">保存反馈</var-button>
            </div>
          </template>
        </div>
        <div v-else class="empty-state"><strong>暂无学生作答</strong>学习端提交听写后，这里会出现练习记录。</div>
      </div>

      <div v-if="toast" style="position: fixed; z-index: 30; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 11px 16px; border-radius: 12px; background: #17233d; color: white; font-size: .78rem; box-shadow: 0 10px 30px rgb(0 0 0 / .2)">{{ toast }}</div>
    </div>
  </var-app>
</template>
