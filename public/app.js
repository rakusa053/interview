// ===== 定番の質問 =====
const PRESET_QUESTIONS = {
  common: [
    "まずは簡単に自己紹介をお願いします。",
    "当社（この職種）を志望した理由を教えてください。",
    "あなたの強みと、それを発揮したエピソードを教えてください。",
    "あなたの弱みは何ですか？また、それをどう克服しようとしていますか？",
    "これまでで一番困難だった経験と、それをどう乗り越えたかを教えてください。",
    "チームで何かに取り組んだ経験と、その中でのあなたの役割を教えてください。",
    "入社後（入学後）に挑戦したいことは何ですか？",
    "最後に、何か質問はありますか？",
  ],
  "新卒採用": ["学生時代に最も力を入れたこと（ガクチカ）を教えてください。"],
  "中途採用（転職）": [
    "これまでの職務経歴と主な実績を教えてください。",
    "転職を考えた理由を教えてください。",
  ],
  "アルバイト・パート": ["週に何日、どの時間帯に勤務できますか？"],
  "インターン": ["このインターンで何を学びたいですか？"],
  "大学・高校入試": ["本校（本学）を志望した理由を教えてください。", "高校（中学）生活で頑張ったことは何ですか？"],
};

function presetQuestions(type, count) {
  const extra = PRESET_QUESTIONS[type] ?? [];
  const [intro, ...rest] = PRESET_QUESTIONS.common;
  const closing = rest.pop();
  const middle = [...extra, ...rest];
  const picked = middle.slice(0, Math.max(0, count - 2));
  return [intro, ...picked, closing].slice(0, count);
}

// ===== 状態 =====
const state = {
  setup: null,
  maxFollowups: 2,
  mode: "both", // both: 表示＋読み上げ / voice: 音声のみ / text: 表示のみ
  voiceURI: "",
  rate: 1,
  autoRecord: false,
  questions: [],
  qIndex: 0,
  turns: [], // 完了した全てのやりとり { question, answer, durationSec, isFollowup, mainIndex, audioUrl }
  thread: [], // 現在の質問（＋深堀）のやりとり
  followupsUsed: 0,
  currentQuestion: "",
  currentIsFollowup: false,
};

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const screens = { setup: $("screen-setup"), interview: $("screen-interview"), result: $("screen-result") };
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle("active", k === name);
  window.scrollTo({ top: 0 });
}
function overlay(text) {
  $("overlay").classList.toggle("hidden", !text);
  if (text) $("overlay-text").textContent = text;
}
function setStatus(text) {
  $("status").textContent = text ?? "";
  $("status").classList.toggle("hidden", !text);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `サーバーエラー (${res.status})`);
  return data;
}

// ===== 音声読み上げ =====
const canSpeak = "speechSynthesis" in window;
let speakToken = 0;

function japaneseVoices() {
  return canSpeak ? speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-").startsWith("ja")) : [];
}

function populateVoices() {
  const select = $("voice");
  const current = select.value;
  select.length = 1; // 「ブラウザの標準」だけ残す
  for (const v of japaneseVoices()) {
    const opt = new Option(`${v.name}${v.localService ? "" : "（オンライン）"}`, v.voiceURI);
    select.add(opt);
  }
  select.value = current;
}

// 読み上げが最後まで終わったら true、途中で止められたら false で解決する
function speak(text, { voiceURI = state.voiceURI, rate = state.rate } = {}) {
  if (!canSpeak || !text) return Promise.resolve(false);
  const token = ++speakToken;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = rate;
  const voice = japaneseVoices().find((v) => v.voiceURI === voiceURI);
  if (voice) u.voice = voice;
  $("speaking").classList.remove("hidden");
  return new Promise((resolve) => {
    const done = (completed) => {
      if (token === speakToken) $("speaking").classList.add("hidden");
      resolve(completed && token === speakToken);
    };
    u.onend = () => done(true);
    u.onerror = () => done(false);
    speak.current = u; // Chrome で GC されると onend が呼ばれないことがあるので参照を保持
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  speakToken++;
  if (canSpeak) speechSynthesis.cancel();
  $("speaking").classList.add("hidden");
}

// 現在の質問を読み上げ、設定に応じて自動で録音を始める
async function speakQuestion(prefix = "") {
  const finished = await speak(prefix ? `${prefix} ${state.currentQuestion}` : state.currentQuestion);
  if (finished && state.autoRecord && !rec.recording && screens.interview.classList.contains("active")) {
    startRecording();
  }
}

// ===== 録音 + 文字起こし =====
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = {
  mediaRecorder: null,
  stream: null,
  chunks: [],
  recognition: null,
  recording: false,
  baseText: "", // 録音開始前にテキスト欄にあった内容
  finalText: "", // 今回の録音で確定した文字起こし
  startedAt: 0,
  elapsedSec: 0, // この回答の合計録音時間
  timerId: null,
  audioUrl: null,
};

function checkSupport() {
  const msgs = [];
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    msgs.push("このブラウザは録音に対応していません。");
  }
  if (!canSpeak) {
    msgs.push("このブラウザは音声の読み上げに対応していないため、質問は画面表示のみになります。");
  }
  if (!SpeechRecognition) {
    msgs.push("このブラウザは音声の自動文字起こしに対応していません（Chrome / Edge 推奨）。回答欄に手入力することもできます。");
  }
  if (msgs.length) {
    $("support-warning").textContent = msgs.join(" ");
    $("support-warning").classList.remove("hidden");
  }
}

function renderTranscript(interim = "") {
  const sep = rec.baseText && (rec.finalText || interim) ? "\n" : "";
  $("answer").value = rec.baseText + sep + rec.finalText + interim;
}

function startRecognition() {
  if (!SpeechRecognition) return;
  const r = new SpeechRecognition();
  r.lang = "ja-JP";
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) rec.finalText += res[0].transcript + "。";
      else interim += res[0].transcript;
    }
    renderTranscript(interim);
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed") setStatus("マイクの使用が許可されていません。");
  };
  // Chrome は無音が続くと認識を自動終了するので、録音中なら再開する
  r.onend = () => {
    if (rec.recording) {
      try { r.start(); } catch { /* 既に開始済み */ }
    }
  };
  r.start();
  rec.recognition = r;
}

async function startRecording() {
  setStatus("");
  stopSpeaking();
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus("マイクにアクセスできませんでした。ブラウザのマイク許可を確認してください。");
    return;
  }
  rec.chunks = [];
  rec.mediaRecorder = new MediaRecorder(rec.stream);
  rec.mediaRecorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.mediaRecorder.onstop = () => {
    const blob = new Blob(rec.chunks, { type: rec.mediaRecorder.mimeType });
    if (rec.audioUrl) URL.revokeObjectURL(rec.audioUrl);
    rec.audioUrl = URL.createObjectURL(blob);
    $("playback").src = rec.audioUrl;
    $("playback").classList.remove("hidden");
    rec.stream.getTracks().forEach((t) => t.stop());
  };
  rec.mediaRecorder.start();

  rec.baseText = $("answer").value.trim();
  rec.finalText = "";
  rec.recording = true;
  rec.startedAt = Date.now();
  startRecognition();

  $("btn-record").classList.add("recording");
  $("record-text").textContent = "録音停止";
  $("answer").readOnly = true;
  $("btn-submit").disabled = true;
  rec.timerId = setInterval(updateTimer, 250);
}

function stopRecording() {
  if (!rec.recording) return;
  rec.recording = false;
  rec.elapsedSec += (Date.now() - rec.startedAt) / 1000;
  clearInterval(rec.timerId);
  updateTimer();
  rec.recognition?.stop();
  rec.recognition = null;
  rec.mediaRecorder?.stop();

  $("btn-record").classList.remove("recording");
  $("record-text").textContent = "続けて録音";
  $("answer").readOnly = false;
  $("btn-submit").disabled = false;
}

function updateTimer() {
  const sec = rec.elapsedSec + (rec.recording ? (Date.now() - rec.startedAt) / 1000 : 0);
  const s = Math.floor(sec);
  $("timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function resetRecorder() {
  if (rec.recording) stopRecording();
  rec.elapsedSec = 0;
  rec.baseText = "";
  rec.finalText = "";
  rec.audioUrl = null; // URL は記録用に保持するので revoke しない
  $("answer").value = "";
  $("playback").removeAttribute("src");
  $("playback").classList.add("hidden");
  $("record-text").textContent = "録音開始";
  updateTimer();
}

// ===== 面接の進行 =====
function showQuestion(text, isFollowup, reaction = "") {
  state.currentQuestion = text;
  state.currentIsFollowup = isFollowup;
  resetRecorder();
  setStatus("");

  const total = state.questions.length;
  $("q-label").textContent = isFollowup ? `深堀質問（質問 ${state.qIndex + 1}）` : `質問 ${state.qIndex + 1} / ${total}`;
  $("q-label").classList.toggle("followup", isFollowup);
  $("question").textContent = text;
  const voiceOnly = state.mode === "voice";
  $("question").classList.toggle("hidden", voiceOnly);
  $("listen-hint").classList.toggle("hidden", !voiceOnly);
  $("btn-reveal").classList.toggle("hidden", !voiceOnly);
  $("btn-speak").classList.toggle("hidden", !canSpeak);
  $("reaction").textContent = reaction;
  $("reaction").classList.toggle("hidden", !reaction);
  $("progress-bar").style.width = `${(state.qIndex / total) * 100}%`;
  $("progress-label").textContent = `${state.qIndex + 1} 問目 / 全 ${total} 問`;
  if (state.mode !== "text") speakQuestion(reaction);
}

async function startInterview() {
  state.setup = {
    interviewType: $("interviewType").value,
    role: $("role").value.trim(),
    notes: $("notes").value.trim(),
  };
  const count = Number($("count").value);
  state.maxFollowups = Number($("maxFollowups").value);
  state.mode = document.querySelector('input[name="qmode"]:checked').value;
  state.voiceURI = $("voice").value;
  state.rate = Number($("rate").value);
  state.autoRecord = $("autoRecord").checked;
  state.turns = [];
  state.thread = [];
  state.qIndex = 0;
  state.followupsUsed = 0;

  const source = document.querySelector('input[name="qsource"]:checked').value;
  if (source === "ai") {
    overlay("質問を作成しています…");
    try {
      const { questions } = await api("/api/questions", { setup: state.setup, count });
      state.questions = questions;
    } catch (e) {
      alert(`${e.message}\n定番の質問で開始します。`);
      state.questions = presetQuestions(state.setup.interviewType, count);
    } finally {
      overlay(null);
    }
  } else {
    state.questions = presetQuestions(state.setup.interviewType, count);
  }

  show("interview");
  showQuestion(state.questions[0], false);
}

async function submitAnswer() {
  stopSpeaking();
  if (rec.recording) stopRecording();
  const answer = $("answer").value.trim();
  if (!answer && !confirm("回答が空です。このまま次へ進みますか？")) return;

  const turn = {
    question: state.currentQuestion,
    answer,
    durationSec: Math.round(rec.elapsedSec),
    isFollowup: state.currentIsFollowup,
    mainIndex: state.qIndex,
    audioUrl: rec.audioUrl,
  };
  state.thread.push(turn);

  const followupsLeft = state.maxFollowups - state.followupsUsed;
  if (followupsLeft > 0 && answer) {
    overlay("面接官が考えています…");
    try {
      const res = await api("/api/followup", {
        setup: state.setup,
        history: state.turns.map(toApiTurn),
        current: state.thread.map(toApiTurn),
        followupsLeft,
      });
      if (res.needs_followup && res.followup_question) {
        state.followupsUsed++;
        showQuestion(res.followup_question, true, res.brief_comment);
        return;
      }
      nextQuestion(res.brief_comment);
    } catch (e) {
      // 送信失敗時はこの回答を取り消して再送できるようにする
      state.thread.pop();
      setStatus(e.message);
    } finally {
      overlay(null);
    }
    return;
  }
  nextQuestion();
}

function nextQuestion(reaction = "") {
  state.turns.push(...state.thread);
  state.thread = [];
  state.followupsUsed = 0;
  state.qIndex++;
  if (state.qIndex >= state.questions.length) {
    finishInterview();
  } else {
    showQuestion(state.questions[state.qIndex], false, reaction);
  }
}

function toApiTurn(t) {
  return { question: t.question, answer: t.answer, durationSec: t.durationSec, isFollowup: t.isFollowup };
}

async function finishInterview() {
  $("progress-bar").style.width = "100%";
  stopSpeaking();
  overlay("面接全体を評価しています…（30秒〜1分ほどかかります）");
  try {
    const evaluation = await api("/api/evaluate", { setup: state.setup, turns: state.turns.map(toApiTurn) });
    renderResult(evaluation);
    show("result");
  } catch (e) {
    show("interview");
    setStatus(`${e.message}（もう一度「この回答で送信」を押すと評価を再試行します）`);
    // 再試行用: 最後の質問の状態に戻す
    state.qIndex = state.questions.length - 1;
    const last = state.turns.filter((t) => t.mainIndex === state.qIndex);
    state.turns = state.turns.filter((t) => t.mainIndex !== state.qIndex);
    state.thread = last.slice(0, -1);
    const lastTurn = last.at(-1);
    state.followupsUsed = state.maxFollowups; // 再試行時は深堀せずに評価へ
    state.currentQuestion = lastTurn.question;
    state.currentIsFollowup = lastTurn.isFollowup;
    $("answer").value = lastTurn.answer;
    rec.elapsedSec = lastTurn.durationSec;
    rec.audioUrl = lastTurn.audioUrl;
  } finally {
    overlay(null);
  }
}

// ===== 結果表示 =====
function renderResult(ev) {
  const criteria = ev.criteria
    .map(
      (c) => `
      <div class="criterion">
        <div class="criterion-head"><span>${esc(c.name)}</span><span>${esc(c.score)} / 5</span></div>
        <div class="bar"><div style="width:${Math.max(0, Math.min(5, Number(c.score))) * 20}%"></div></div>
        <p>${esc(c.comment)}</p>
      </div>`,
    )
    .join("");

  const perQuestion = ev.per_question
    .map((pq, i) => {
      const exchanges = state.turns
        .filter((t) => t.mainIndex === i)
        .map(
          (t) => `
          <div class="qa">
            <div class="q">${t.isFollowup ? "深堀: " : "Q: "}${esc(t.question)}</div>
            <div>A: ${esc(t.answer) || "（無回答）"} <span class="muted">（${t.durationSec}秒）</span></div>
            ${t.audioUrl ? `<audio controls src="${t.audioUrl}"></audio>` : ""}
          </div>`,
        )
        .join("");
      return `
      <details ${i === 0 ? "open" : ""}>
        <summary>${esc(pq.question)}（${esc(pq.score)} / 5）</summary>
        ${exchanges}
        <p>${esc(pq.feedback)}</p>
        <p><strong>より良い回答例</strong></p>
        <div class="example">${esc(pq.better_answer_example)}</div>
      </details>`;
    })
    .join("");

  const list = (items, cls = "") => `<ul class="list ${cls}">${items.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;

  $("result").innerHTML = `
    <div class="card">
      <h2>総合評価</h2>
      <div class="score-head">
        <div class="grade">${esc(ev.grade)}</div>
        <div class="score-num">${esc(ev.overall_score)}<small> / 100</small></div>
      </div>
      <p>${esc(ev.summary)}</p>
    </div>
    <div class="card"><h2>項目別評価</h2>${criteria}</div>
    <div class="card"><h2>良かった点</h2>${list(ev.strengths, "good")}</div>
    <div class="card"><h2>改善点</h2>${list(ev.improvements)}</div>
    <div class="card"><h2>質問ごとのフィードバック</h2>${perQuestion}</div>
    <div class="card"><h2>次回の練習で意識すること</h2>${list(ev.next_steps)}</div>
  `;
  state.lastEvaluation = ev;
}

function downloadTranscript() {
  const ev = state.lastEvaluation;
  const lines = [
    `面接練習の記録 ${new Date().toLocaleString("ja-JP")}`,
    `種類: ${state.setup.interviewType} / 志望: ${state.setup.role || "-"}`,
    "",
    ...state.turns.flatMap((t) => [`${t.isFollowup ? "【深堀】" : "【質問】"}${t.question}`, `【回答】(${t.durationSec}秒) ${t.answer}`, ""]),
  ];
  if (ev) {
    lines.push(`■ 総合: ${ev.overall_score}/100 (${ev.grade})`, ev.summary, "");
    lines.push("■ 項目別", ...ev.criteria.map((c) => `- ${c.name}: ${c.score}/5 ${c.comment}`), "");
    lines.push("■ 良かった点", ...ev.strengths.map((s) => `- ${s}`), "");
    lines.push("■ 改善点", ...ev.improvements.map((s) => `- ${s}`), "");
    lines.push("■ 質問ごと", ...ev.per_question.flatMap((p) => [`- ${p.question} (${p.score}/5)`, `  ${p.feedback}`, `  回答例: ${p.better_answer_example}`]), "");
    lines.push("■ 次回意識すること", ...ev.next_steps.map((s) => `- ${s}`));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `interview-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===== イベント =====
$("btn-start").addEventListener("click", startInterview);
$("btn-record").addEventListener("click", () => (rec.recording ? stopRecording() : startRecording()));
$("btn-retry").addEventListener("click", resetRecorder);
$("btn-submit").addEventListener("click", submitAnswer);
$("btn-speak").addEventListener("click", () => {
  if (rec.recording) stopRecording();
  speakQuestion();
});
$("btn-reveal").addEventListener("click", () => {
  $("question").classList.remove("hidden");
  $("listen-hint").classList.add("hidden");
  $("btn-reveal").classList.add("hidden");
});
$("btn-voice-test").addEventListener("click", () =>
  speak("それでは面接を始めます。まずは簡単に自己紹介をお願いします。", {
    voiceURI: $("voice").value,
    rate: Number($("rate").value),
  }),
);
for (const radio of document.querySelectorAll('input[name="qmode"]')) {
  radio.addEventListener("change", updateVoiceSettings);
}
function updateVoiceSettings() {
  const mode = document.querySelector('input[name="qmode"]:checked').value;
  $("voice-settings").classList.toggle("hidden", mode === "text");
}
if (canSpeak) {
  populateVoices();
  speechSynthesis.addEventListener("voiceschanged", populateVoices);
} else {
  // 読み上げ非対応のブラウザでは音声モードを選べないようにする
  for (const radio of document.querySelectorAll('input[name="qmode"]')) {
    if (radio.value !== "text") radio.disabled = true;
  }
  document.querySelector('input[name="qmode"][value="text"]').checked = true;
  updateVoiceSettings();
}
$("btn-download").addEventListener("click", downloadTranscript);
$("btn-restart").addEventListener("click", () => {
  stopSpeaking();
  show("setup");
});
checkSupport();
