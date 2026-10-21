"use strict";

const byId = (id) => document.getElementById(id);
const state = { files: [], imageFiles: [], analysis: null, questions: [], answers: [], currentQuestion: 0, timerId: null, remainingSeconds: 0, examName: "" };
const LETTERS = ["A", "B", "C", "D"];
const STOP_WORDS = new Set(("a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other ought our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours").split(" "));
const WORD_RE = /[a-zA-Z][a-zA-Z'-]*/g;

function setDateLabel() {
  const now = new Date();
  byId("todayLabel").textContent = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("show"), 3000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function wordCount(text) {
  return (text.match(WORD_RE) || []).length;
}

function updateNotesCount() {
  byId("notesCount").textContent = `${wordCount(byId("notesText").value)} words`;
}

function renderFiles() {
  byId("fileList").innerHTML = state.files.map((file, index) => `<span class="file-chip" title="${escapeHtml(file.name)}"><span>${escapeHtml(file.name)}</span><button type="button" data-remove-file="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button></span>`).join("");
}

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  let rejected = 0;
  let oversized = 0;
  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    if (/\.(pdf|doc|docx|rtf|odt)$/.test(lowerName) || file.type === "application/pdf" || file.type.includes("wordprocessingml")) {
      rejected++;
      continue;
    }
    const isText = /\.(txt|md|markdown)$/.test(lowerName) || file.type.startsWith("text/");
    const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(lowerName);
    if (!isText && !isImage) {
      rejected++;
      continue;
    }
    if (file.size > 15 * 1024 * 1024) {
      oversized++;
      continue;
    }
    if (state.files.some((existing) => existing.name === file.name && existing.size === file.size)) continue;
    state.files.push(file);
    if (isImage) state.imageFiles.push(file);
  }
  renderFiles();
  if (rejected) showToast(`${rejected} unsupported file${rejected === 1 ? "" : "s"} skipped. Paste PDF or Word text instead.`);
  else if (oversized) showToast(`${oversized} file${oversized === 1 ? "" : "s"} skipped (15 MB limit each).`);
  else if (files.length) showToast("Files added to your notes.");
}

async function collectNotes() {
  const textParts = [byId("notesText").value.trim()];
  const images = [];
  for (const file of state.files) {
    if (file.type.startsWith("text/") || /\.(txt|md|markdown)$/i.test(file.name)) {
      textParts.push(await file.text());
    } else if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
      images.push(file);
    }
  }
  return { text: textParts.filter(Boolean).join("\n\n").trim(), images };
}

function getSentences(text) {
  const normalized = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    const heading = line.replace(/^#{1,6}\s*/, "").replace(/[:\s]+$/, "").trim();
    if (heading && heading.length < 70 && (line.startsWith("#") || /:$/.test(line) || (heading.split(/\s+/).length < 8 && !/[.!?]$/.test(line)))) {
      candidates.push({ text: heading, heading: true });
      continue;
    }
    for (const fragment of line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
      const sentence = fragment.replace(/^[\s•\-*]+/, "").replace(/^\d+[\.)]\s*/, "").trim();
      if (sentence.length >= 20) candidates.push({ text: sentence, heading: false });
      else if (sentence.length >= 8) candidates.push({ text: sentence, heading: false });
    }
  }
  return candidates;
}

function tokenize(text) {
  return (text.match(WORD_RE) || []).map((word) => word.toLowerCase().replace(/'s$/, "")).filter((word) => word.length > 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
}

function titleCase(text) {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function getCandidates(text) {
  return tokenize(text).filter((word, index, words) => words.indexOf(word) === index);
}

function makeTopicName(sentence, vocabulary) {
  const tokens = tokenize(sentence);
  const known = tokens.find((word) => vocabulary.has(word));
  if (known) return titleCase(known);
  const fallback = tokens.find(Boolean);
  return fallback ? titleCase(fallback) : "Core concepts";
}

function extractTopics(sentences, hoursPerDay, days) {
  const content = sentences.filter((item) => !item.heading);
  const vocabulary = new Set(tokenize(content.map((item) => item.text).join(" ")));
  if (!content.length) throw new Error("Add a few complete sentences to your notes so your study guide can be based on real material.");
  const grouped = new Map();
  for (const item of content) {
    const key = makeTopicName(item.text, vocabulary);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item.text);
  }
  const groups = Array.from(grouped.entries()).map(([name, points]) => ({ name, points: Array.from(new Set(points)) }));
  if (groups.length < 2 && content.length > 3) {
    const half = Math.ceil(content.length / 2);
    groups.splice(0, groups.length,
      { name: makeTopicName(content[0].text, vocabulary), points: content.slice(0, half).map((item) => item.text) },
      { name: makeTopicName(content[half].text, vocabulary), points: content.slice(half).map((item) => item.text) });
  }
  groups.sort((a, b) => b.points.length - a.points.length || a.name.localeCompare(b.name));
  const maxTopics = Math.min(8, groups.length);
  const selected = groups.slice(0, maxTopics);
  const totalSentences = selected.reduce((sum, group) => sum + group.points.length, 0) || 1;
  const totalHours = Math.max(days, Math.min(days * hoursPerDay, Math.round(days * hoursPerDay * 0.62 * 2) / 2));
  const topicHours = selected.map((group) => Math.max(0.5, Math.round((totalHours * group.points.length / totalSentences) * 2) / 2));
  const order = selected.map((_, index) => index);
  for (let index = 0; index < selected.length; index++) {
    selected[index].importance = index < Math.max(1, Math.ceil(selected.length / 3)) ? "High" : index < Math.ceil(selected.length * 2 / 3) ? "Medium" : "Low";
    selected[index].hours = topicHours[index];
    selected[index].keyPoints = selected[index].points.slice(0, 3);
  }
  return selected;
}

function makePlan(topics, days, hoursPerDay) {
  const plan = [];
  const studyDays = Math.max(0, days - 1);
  const weightTotal = topics.reduce((sum, topic) => sum + (topic.importance === "High" ? 3 : topic.importance === "Medium" ? 2 : 1), 0) || 1;
  for (let day = 1; day <= studyDays; day++) {
    const topic = topics[(day - 1) % Math.max(1, topics.length)];
    const focus = topic ? topic.name : "Core concepts";
    const tasks = [`Review your notes on ${focus} and explain the main ideas in your own words.`];
    if (day > 1 && day % 2 === 0) tasks.push(`Spend 15 minutes recalling ${topics[(day - 2) % topics.length].name} without looking at your notes.`);
    if (day === studyDays && studyDays > 1) tasks.push("Finish with a short recall check on the topics you found hardest.");
    const plannedHours = Math.min(hoursPerDay, Math.max(0.5, Math.round(hoursPerDay * (topics.length > days ? 0.75 : 0.8) * 2) / 2));
    plan.push({ day, focus, tasks, hours: plannedHours });
  }
  if (days >= 1) {
    plan.push({ day: days, focus: "Revision + full mock test", tasks: ["Review key points across all topics using active recall.", "Take a full timed mock test, then review every answer you missed.", "Keep your final revision light and take breaks."], hours: Math.min(hoursPerDay, Math.max(1, Math.round(hoursPerDay * 0.85 * 2) / 2)) });
  }
  if (plan.length !== days) throw new Error("Could not create a complete day-by-day plan. Please check your study settings.");
  return plan;
}

function createLocalAnalysis(text, examName, days, hoursPerDay) {
  const sentences = getSentences(text);
  const headings = sentences.filter((item) => item.heading).map((item) => item.text);
  const contentSentences = sentences.filter((item) => !item.heading);
  const topics = extractTopics(sentences, hoursPerDay, days);
  const summaryParts = contentSentences.slice(0, 4).map((item) => item.text);
  const summary = `These notes for ${examName} cover ${topics.map((topic) => topic.name).join(", ")}. ${summaryParts.slice(0, 2).join(" ")}`.trim();
  return { summary, topics, plan: makePlan(topics, days, hoursPerDay), _headings: headings };
}

function normalizeAnalysis(data, days, hoursPerDay) {
  if (!data || typeof data.summary !== "string" || !Array.isArray(data.topics) || !Array.isArray(data.plan)) throw new Error("The AI returned an unexpected format. Please try again.");
  if (data.plan.length !== days) throw new Error(`The AI returned ${data.plan.length} plan days instead of ${days}. Please try again.`);
  const topics = data.topics.slice(0, 12).map((topic) => ({
    name: String(topic.name || "Topic").slice(0, 100),
    importance: ["High", "Medium", "Low"].includes(topic.importance) ? topic.importance : "Medium",
    hours: Math.min(hoursPerDay * days, Math.max(0, Number(topic.hours) || 0)),
    keyPoints: Array.isArray(topic.keyPoints) ? topic.keyPoints.slice(0, 5).map((point) => String(point).slice(0, 300)) : []
  }));
  const plan = data.plan.map((entry, index) => ({
    day: index + 1,
    focus: String(entry.focus || "Review").slice(0, 160),
    tasks: Array.isArray(entry.tasks) ? entry.tasks.slice(0, 6).map((task) => String(task).slice(0, 300)) : [],
    hours: Math.min(hoursPerDay, Math.max(0, Number(entry.hours) || 0))
  }));
  if (!topics.length) throw new Error("No study topics were identified. Try adding more detailed notes.");
  return { summary: data.summary.slice(0, 2000), topics, plan };
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function requestOpenAI(apiKey, messages, jsonMode = true) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, ...(jsonMode ? { response_format: { type: "json_object" } } : {}), temperature: 0.4 })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.error && body.error.message ? body.error.message : `OpenAI request failed (${response.status}).`;
    throw new Error(message);
  }
  const data = await response.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("The AI returned an empty response.");
  try { return JSON.parse(content); } catch { throw new Error("The AI response was not valid JSON. Please try again."); }
}

async function createAIAnalysis(notes, examName, days, hoursPerDay, apiKey) {
  const prompt = `Analyze these student notes for the exam/subject "${examName}". Return JSON only with exactly this shape: {"summary":"3-5 sentence overview","topics":[{"name":"","importance":"High|Medium|Low","hours":0,"keyPoints":[""]}],"plan":[{"day":1,"focus":"","tasks":[""],"hours":0}]}. Make exactly ${days} plan entries, days numbered 1 through ${days}. Never exceed ${hoursPerDay} study hours on any day. Prioritize difficult/high-importance topics early, use spaced revision, and reserve the last day for revision plus a full mock test. Use only concepts actually present in the supplied notes.`;
  const content = [{ type: "text", text: `${prompt}\n\nNOTES:\n${notes.text || "(No pasted text; analyze the attached photos.)"}` }];
  for (const image of notes.images) content.push({ type: "image_url", image_url: { url: await fileAsDataUrl(image), detail: "high" } });
  const data = await requestOpenAI(apiKey, [{ role: "user", content }]);
  return normalizeAnalysis(data, days, hoursPerDay);
}

function topicForSentence(sentence, topics) {
  const words = new Set(tokenize(sentence));
  let best = topics[0];
  let score = 0;
  for (const topic of topics) {
    const topicWords = tokenize(topic.name);
    const current = topicWords.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
    if (current > score) { best = topic; score = current; }
  }
  return best ? best.name : "Core concepts";
}

function generateLocalQuestions(text, topics, requestedCount) {
  const sentences = getSentences(text).filter((item) => !item.heading && item.text.length >= 24);
  const allTokens = tokenize(text);
  const frequency = new Map();
  for (const word of allTokens) frequency.set(word, (frequency.get(word) || 0) + 1);
  const vocabulary = Array.from(frequency.keys()).filter((word) => word.length >= 4);
  const questions = [];
  const seen = new Set();
  for (const item of sentences) {
    const tokens = tokenize(item.text);
    const targets = tokens.filter((word, index) => word.length >= 4 && tokens.indexOf(word) === index).sort((a, b) => (frequency.get(b) || 0) - (frequency.get(a) || 0));
    for (const target of targets.slice(0, 3)) {
      const normalizedSentence = item.text.replace(new RegExp(`\\b${target}\\b`, "i"), "_____");
      if (seen.has(normalizedSentence.toLowerCase())) continue;
      const distractors = vocabulary.filter((word) => word !== target && Math.abs(word.length - target.length) <= 9);
      const sorted = distractors.sort((a, b) => Math.abs(a.length - target.length) - Math.abs(b.length - target.length));
      if (sorted.length < 3) continue;
      const options = [target, ...sorted.slice(0, 3)].sort(() => Math.random() - 0.5);
      seen.add(normalizedSentence.toLowerCase());
      questions.push({ q: `According to your notes, complete the statement: “${normalizedSentence}”`, options, answer: options.indexOf(target), explanation: `Your notes state: “${item.text}”`, topic: topicForSentence(item.text, topics) });
      if (questions.length === requestedCount) return questions;
    }
  }
  return questions;
}

async function createAIQuestions(notesText, analysis, requestedCount, apiKey, images = []) {
  const prompt = `Create exactly ${requestedCount} distinct four-option multiple-choice questions for a student, using only facts in these notes. Weight questions toward High-importance topics (${analysis.topics.filter((topic) => topic.importance === "High").map((topic) => topic.name).join(", ") || "none specified"}). Mix recall and application. Distractors should be plausible but clearly wrong according to the notes. Randomize correct answer positions. Return JSON only: {"questions":[{"q":"","options":["","","",""],"answer":0,"explanation":"","topic":""}]}. "answer" is the zero-based index of the correct option.`;
  const content = [{ type: "text", text: `${prompt}\n\nNOTES:\n${notesText || "(Use the attached photos.)"}` }];
  for (const image of images) content.push({ type: "image_url", image_url: { url: await fileAsDataUrl(image), detail: "high" } });
  const data = await requestOpenAI(apiKey, [{ role: "user", content }]);
  if (!data || !Array.isArray(data.questions) || data.questions.length !== requestedCount) throw new Error(`The AI did not return exactly ${requestedCount} questions. Please try again.`);
  const questions = data.questions.map((question) => {
    if (!Array.isArray(question.options) || question.options.length !== 4 || !Number.isInteger(question.answer) || question.answer < 0 || question.answer > 3) throw new Error("The AI returned a question with invalid answer options. Please try again.");
    return { q: String(question.q), options: question.options.map(String), answer: question.answer, explanation: String(question.explanation || ""), topic: String(question.topic || "Your notes") };
  });
  return questions;
}

function getSetupValues() {
  const examName = byId("examName").value.trim();
  const days = Number(byId("daysInput").value);
  const hoursPerDay = Number(byId("hoursInput").value);
  const count = Number(byId("questionCount").value);
  if (!examName) throw new Error("Add an exam or subject name to get started.");
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Days until your exam must be a whole number from 1 to 30.");
  if (!Number.isInteger(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 14) throw new Error("Study hours per day must be a whole number from 1 to 14.");
  if (![10, 15, 20].includes(count)) throw new Error("Choose 10, 15, or 20 practice questions.");
  return { examName, days, hoursPerDay, count };
}

function showError(message) {
  const error = byId("setupError");
  error.textContent = message;
  error.hidden = false;
}

function renderResults() {
  const { analysis, examName } = state;
  byId("resultsTitle").textContent = examName;
  byId("resultsSubtitle").textContent = `${analysis.topics.length} topics · a ${analysis.plan.length}-day plan, made around you.`;
  byId("breadcrumbCurrent").textContent = examName;
  const totalHours = analysis.plan.reduce((sum, item) => sum + item.hours, 0);
  byId("resultsStats").innerHTML = [
    statCard("calendar", "YOUR TIMELINE", `${analysis.plan.length} days`),
    statCard("book", "TOPICS TO KNOW", `${analysis.topics.length} topics`),
    statCard("clock", "STUDY TIME", `${totalHours} hours planned`)
  ].join("");
  byId("summaryPanel").innerHTML = `<section class="summary-card"><h2 class="section-heading">${icon("spark")}Your overview</h2><p>${escapeHtml(analysis.summary)}</p></section><h2 class="section-heading">${icon("book")}Your topics</h2><div class="topic-list">${analysis.topics.map((topic) => `<article class="topic-card"><div class="topic-topline"><h3>${escapeHtml(topic.name)}</h3><span class="importance ${topic.importance.toLowerCase()}">${escapeHtml(topic.importance)} importance</span><span class="topic-hours">${escapeHtml(topic.hours)} hrs</span></div><ul class="keypoints">${topic.keyPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul></article>`).join("")}</div>`;
  byId("planPanel").innerHTML = `<div class="plan-list">${analysis.plan.map((day) => `<article class="day-card"><div class="day-label"><strong>DAY ${day.day}</strong><small>${day.day === analysis.plan.length ? "Exam eve" : ""}</small></div><div class="day-content"><h3>${escapeHtml(day.focus)}</h3><ul>${day.tasks.map((task) => `<li>${escapeHtml(task)}</li>`).join("")}</ul><div class="day-hours">${escapeHtml(day.hours)} hours · take short breaks between study blocks</div></div></article>`).join("")}</div>`;
  byId("testPanel").innerHTML = `<div class="test-intro-card"><div><h3>A little practice goes a long way.</h3><p>Your questions are based only on the notes you provided. Take your time, trust what you know, and review the explanations when you’re done.</p><div class="test-mode-note"><span>✳</span>${state.engine === "local" ? "Questions are prepared from your notes on this device." : "AI questions are based on your notes."}</div></div><div class="test-settings"><label for="minutesPerQuestion">TIME LIMIT</label><div class="test-time-control"><input id="minutesPerQuestion" type="number" min="1" max="10" step="0.1" value="1.2"><span>minutes per question</span></div><button class="start-test-button" id="generateTestButton" type="button">${icon("play")}Generate and start test</button></div></div>`;
  byId("generateTestButton").addEventListener("click", startTest);
  selectTab("summary");
}

function icon(name) {
  const icons = {
    spark: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2 1.4 5.1L16 9l-4.6 1.9L10 16l-1.4-5.1L4 9l4.6-1.9L10 2ZM16.5 13l.7 2.1 1.8.9-1.8.8-.7 2.2-.7-2.2-1.8-.8 1.8-.9.7-2.1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    book: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 4.5A1.5 1.5 0 0 1 5 3h11v13H5a1.5 1.5 0 0 1-1.5-1.5v-10ZM3.5 14.5A1.5 1.5 0 0 1 5 13h11M7 6h5M7 9h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    calendar: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4.5" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 2.5v4M13.5 2.5v4M3 8h14m-10 3h2m3 0h1m-6 3h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    clock: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 4.5 9 5.5-9 5.5v-11Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  };
  return icons[name];
}

function statCard(iconName, label, value) {
  return `<div class="stat-card"><span class="stat-icon">${icon(iconName)}</span><span><small>${label}</small><strong>${escapeHtml(value)}</strong></span></div>`;
}

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  ["summary", "plan", "test"].forEach((tabName) => { byId(`${tabName}Panel`).hidden = tabName !== name; });
}

async function buildStudyPlan() {
  const button = byId("buildPlanButton");
  byId("setupError").hidden = true;
  try {
    const { examName, days, hoursPerDay } = getSetupValues();
    const notes = await collectNotes();
    if (!notes.text && !notes.images.length) throw new Error("Add your notes as text or upload at least one photo before building your plan.");
    const useAI = document.querySelector('input[name="engine"]:checked').value === "ai";
    const apiKey = byId("apiKey").value.trim();
    if (useAI && !apiKey) throw new Error("Enter your OpenAI API key to use AI-powered analysis.");
    if (!useAI && !notes.text) throw new Error("On-device mode can read text notes. To use note photos, switch to AI-powered mode.");
    button.disabled = true;
    button.innerHTML = `<span class="loading-dots">${useAI ? "Reading your notes" : "Building your plan"}</span>`;
    state.examName = examName;
    state.notesText = notes.text;
    state.images = notes.images;
    state.engine = useAI ? "ai" : "local";
    const analysis = useAI
      ? await createAIAnalysis(notes, examName, days, hoursPerDay, apiKey)
      : createLocalAnalysis(notes.text, examName, days, hoursPerDay);
    state.analysis = analysis;
    renderResults();
    byId("setupScreen").hidden = true;
    byId("resultsScreen").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    showError(error.message || "Something went wrong while creating your study plan.");
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>Build my study plan</span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
}

async function startTest() {
  const button = byId("generateTestButton");
  const count = Number(byId("questionCount").value);
  const minutesPerQuestion = Number(byId("minutesPerQuestion").value);
  if (!Number.isFinite(minutesPerQuestion) || minutesPerQuestion < 1 || minutesPerQuestion > 10) {
    showToast("Choose a time limit between 1 and 10 minutes per question.");
    return;
  }
  button.disabled = true;
  button.innerHTML = '<span class="loading-dots">Preparing your questions</span>';
  try {
    if (state.engine === "ai") {
      state.questions = await createAIQuestions(state.notesText, state.analysis, count, byId("apiKey").value.trim(), state.images);
    } else {
      state.questions = generateLocalQuestions(state.notesText, state.analysis.topics, count);
      if (state.questions.length < count) throw new Error(`Your notes support ${state.questions.length} distinct practice questions, not ${count}. Add more detailed notes or choose a smaller test.`);
    }
    state.answers = Array(state.questions.length).fill(null);
    state.currentQuestion = 0;
    state.remainingSeconds = Math.round(minutesPerQuestion * count * 60);
    renderQuestion();
    state.timerId = setInterval(tickTimer, 1000);
  } catch (error) {
    showToast(error.message || "Could not prepare your questions.");
    button.disabled = false;
    button.innerHTML = `${icon("play")}Generate and start test`;
  }
}

function tickTimer() {
  state.remainingSeconds--;
  const timer = byId("timerValue");
  if (timer) {
    timer.textContent = formatTime(state.remainingSeconds);
    timer.parentElement.classList.toggle("low-time", state.remainingSeconds <= 60);
  }
  if (state.remainingSeconds <= 0) submitTest(true);
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, seconds);
  return `${Math.floor(safeSeconds / 60).toString().padStart(2, "0")}:${(safeSeconds % 60).toString().padStart(2, "0")}`;
}

function renderQuestion() {
  const index = state.currentQuestion;
  const question = state.questions[index];
  const progress = ((index + 1) / state.questions.length) * 100;
  byId("testPanel").innerHTML = `<div class="test-screen"><div class="test-progress-row"><span>QUESTION ${index + 1} OF ${state.questions.length}</span><span class="timer"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span id="timerValue">${formatTime(state.remainingSeconds)}</span></span></div><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><div class="question-topic">${escapeHtml(question.topic)}</div><h2 class="question-title">${escapeHtml(question.q)}</h2><div class="answer-list">${question.options.map((option, optionIndex) => `<button type="button" class="answer-option ${state.answers[index] === optionIndex ? "selected" : ""}" data-answer="${optionIndex}"><span class="answer-letter">${LETTERS[optionIndex]}</span><span>${escapeHtml(option)}</span></button>`).join("")}</div><div class="test-nav"><button type="button" id="previousQuestion" ${index === 0 ? "disabled" : ""}>← Previous</button><span></span>${index === state.questions.length - 1 ? '<button type="button" class="submit-test" id="submitTest">Submit test</button>' : '<button type="button" id="nextQuestion">Next question →</button>'}</div></div>`;
  byId("testPanel").querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
    state.answers[index] = Number(button.dataset.answer);
    renderQuestion();
  }));
  const previous = byId("previousQuestion");
  if (previous) previous.addEventListener("click", () => { if (state.currentQuestion > 0) { state.currentQuestion--; renderQuestion(); } });
  const next = byId("nextQuestion");
  if (next) next.addEventListener("click", () => { if (state.currentQuestion < state.questions.length - 1) { state.currentQuestion++; renderQuestion(); } });
  const submit = byId("submitTest");
  if (submit) submit.addEventListener("click", () => submitTest(false));
}

function submitTest(autoSubmitted) {
  clearInterval(state.timerId);
  state.timerId = null;
  const score = state.questions.reduce((sum, question, index) => sum + (state.answers[index] === question.answer ? 1 : 0), 0);
  const percentage = Math.round(score / state.questions.length * 100);
  const title = percentage >= 80 ? "Beautiful work!" : percentage >= 50 ? "You’re building momentum." : "A great place to start.";
  const status = autoSubmitted ? "Time’s up — your test was submitted automatically." : "Your practice test is complete.";
  byId("testPanel").innerHTML = `<div class="test-screen"><div class="test-results"><div class="score-circle"><strong>${score}/${state.questions.length}</strong><small>${percentage}% correct</small></div><h2>${title}</h2><p>${status} Review the explanations below to strengthen what you know.</p></div><div class="review-list">${state.questions.map((question, index) => { const correct = state.answers[index] === question.answer; return `<article class="review-item ${correct ? "correct" : "incorrect"}"><h3>${index + 1}. ${escapeHtml(question.q)}</h3><p>${escapeHtml(question.explanation)}</p>${!correct ? `<p class="review-answer">Correct answer: ${LETTERS[question.answer]}. ${escapeHtml(question.options[question.answer])}</p>` : ""}</article>`; }).join("")}</div><div class="review-actions"><button type="button" class="secondary-button" id="retakeTest">Try again</button><button type="button" class="secondary-button" id="returnToTests">Back to sample test</button></div></div>`;
  byId("retakeTest").addEventListener("click", () => {
    state.answers = Array(state.questions.length).fill(null);
    state.currentQuestion = 0;
    state.remainingSeconds = Math.round(Math.max(60, Number(byId("minutesPerQuestion").value || 1.2) * state.questions.length * 60));
    renderQuestion();
    state.timerId = setInterval(tickTimer, 1000);
  });
  byId("returnToTests").addEventListener("click", () => {
    clearInterval(state.timerId);
    state.timerId = null;
    renderResults();
    selectTab("test");
  });
}

function startOver() {
  if (state.timerId) clearInterval(state.timerId);
  state.files = [];
  state.imageFiles = [];
  state.analysis = null;
  state.questions = [];
  state.answers = [];
  state.currentQuestion = 0;
  state.timerId = null;
  byId("notesText").value = "";
  byId("examName").value = "";
  byId("fileInput").value = "";
  byId("apiKey").value = "";
  byId("fileList").innerHTML = "";
  byId("setupError").hidden = true;
  byId("breadcrumbCurrent").textContent = "New study plan";
  updateNotesCount();
  byId("resultsScreen").hidden = true;
  byId("setupScreen").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

byId("notesText").addEventListener("input", updateNotesCount);
byId("fileInput").addEventListener("change", (event) => { addFiles(event.target.files); event.target.value = ""; });
byId("fileList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-file]");
  if (!button) return;
  state.files.splice(Number(button.dataset.removeFile), 1);
  state.imageFiles = state.files.filter((file) => file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name));
  renderFiles();
});
const uploadZone = byId("uploadZone");
uploadZone.addEventListener("dragover", (event) => { event.preventDefault(); uploadZone.classList.add("dragging"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("dragging"));
uploadZone.addEventListener("drop", (event) => { event.preventDefault(); uploadZone.classList.remove("dragging"); addFiles(event.dataTransfer.files); });
document.querySelectorAll(".stepper").forEach((button) => button.addEventListener("click", () => {
  const input = byId(button.dataset.target);
  input.value = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + Number(button.dataset.delta)));
}));
document.querySelectorAll('input[name="engine"]').forEach((input) => input.addEventListener("change", () => {
  byId("apiKeyWrap").hidden = input.value !== "ai" || !input.checked;
}));
byId("buildPlanButton").addEventListener("click", buildStudyPlan);
byId("startOverButton").addEventListener("click", startOver);
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => selectTab(tab.dataset.tab)));
setDateLabel();
