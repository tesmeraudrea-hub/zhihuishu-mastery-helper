// ==UserScript==
// @name         智慧树掌握度练习助手（逐题排除）
// @namespace    local.zhihuishu.mastery.practice
// @version      1.5.2
// @description  掌握度练习：仅跳过免考和100%掌握度，逐题尝试至全对，显示满分进度，支持按课程导出题库。
// @match        https://studywisdomh5.zhihuishu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // 与页面无关的排除算法；Node 测试直接加载同一个实现。
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const canonical = values => [...values].sort();
  const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  function combinations(tokens, multiple) {
    if (!tokens.length || tokens.length > 12) throw new Error('选项数量不支持（范围 1～12）');
    const sorted = canonical(tokens);
    if (new Set(sorted).size !== sorted.length) throw new Error('选项无法唯一识别');
    if (!multiple) return sorted.map(token => [token]);
    const result = [];
    function collect(start, size, chosen) {
      if (!size) { result.push(chosen); return; }
      for (let i = start; i <= sorted.length - size; i++) collect(i + 1, size - 1, [...chosen, sorted[i]]);
    }
    // 先尝试真正的多选组合，但最终也包含单项，覆盖所有非空集合。
    for (let size = 2; size <= sorted.length; size++) collect(0, size, []);
    collect(0, 1, []);
    return result;
  }
  function questionKey(scope, question) {
    return JSON.stringify([scope, question.type, question.title, canonical(question.options.map(o => o.token))]);
  }
  function binomial(n, k) {
    let value = 1;
    for (let i = 1; i <= k; i++) value = value * (n - i + 1) / i;
    return value;
  }
  function answerModel(records, useCoursePrior = false) {
    const model = {};
    // 此课程导出的 46 道已解五选题：选 2/3/4/5 项分别为 1/28/16/1。
    // 缩为 20 道的先验权重，新增实际答案仍能逐渐改变分布。其他课程不使用。
    if (useCoursePrior) model[5] = { 2: 20 / 46, 3: 560 / 46, 4: 320 / 46, 5: 20 / 46 };
    const seen = new Set();
    for (const [key, record] of Object.entries(records || {})) {
      if (record.type !== '多选题' || !record.correct?.length) continue;
      let parts;
      try { parts = JSON.parse(key); } catch { continue; }
      const options = parts?.[3];
      if (!Array.isArray(options) || options.length < 1 || options.length > 12 || new Set(options).size !== options.length) continue;
      if (new Set(record.correct).size !== record.correct.length || !record.correct.every(token => options.includes(token))) continue;
      // 同一道题在多个知识点出现时只统计一次，避免重复样本放大偏好。
      const identity = JSON.stringify([parts[1], parts[2], canonical(options)]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const counts = model[options.length] ||= {};
      counts[record.correct.length] = (counts[record.correct.length] || 0) + 1;
    }
    return model;
  }
  function rankedCombinations(question, model = {}) {
    const candidates = combinations(question.options.map(o => o.token), question.multiple);
    const n = question.options.length;
    const counts = model[n];
    if (!question.multiple || !counts || Object.values(counts).reduce((sum, count) => sum + count, 0) < 12) return candidates;
    // 同一数量有 C(n,k) 个具体组合；用每个组合的概率排序，而非只看数量占比。
    // 每个组合添加 1/(2^n-1) 平滑权重，罕见答案仍保留在完整枚举中。
    const score = choice => (counts[choice.length] || 0) / binomial(n, choice.length) + 1 / (2 ** n - 1);
    return candidates.map((choice, index) => ({ choice, index, score: score(choice) }))
      .sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.choice);
  }
  function parseMasteryRate(value) {
    const text = normalize(value);
    if (!/^\d+(?:\.\d+)?\s*%?$/.test(text)) throw new Error('掌握度百分比无法识别，请检查知识点弹窗');
    const rate = Number(text.replace('%', '').trim());
    if (rate < 0 || rate > 100) throw new Error('掌握度百分比超出范围');
    return rate;
  }
  function masteryProgress(colors, rates = []) {
    const total = colors.length;
    const exempt = colors.filter(color => color === 'blue').length;
    const eligible = total - exempt;
    let perfect = 0, verified = 0;
    colors.forEach((color, index) => {
      if (color === 'blue') return;
      const rate = rates[index];
      if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100) {
        verified++; if (rate === 100) perfect++;
      }
    });
    return { total, exempt, eligible, perfect, verified, unchecked: eligible - verified,
      remaining: eligible - perfect, percent: eligible ? Math.round(1000 * perfect / eligible) / 10 : total ? 100 : 0 };
  }
  function nextAnswer(record, question, model) {
    const candidates = rankedCombinations(question, model);
    if (record.correct?.length) {
      if (!candidates.some(choice => same(choice, record.correct))) throw new Error('已知答案与当前选项不一致');
      return record.correct;
    }
    const choice = candidates.find(candidate => !(record.wrong || []).some(wrong => same(candidate, wrong)));
    if (!choice) throw new Error('所有组合均被判错，已暂停；请检查题目、批改或其他脚本干扰');
    return choice;
  }
  function remember(record, choice, correct) {
    if (!choice.length) throw new Error('批改题目没有已选答案，不能记录');
    if (correct) {
      record.correct = canonical(choice);
      record.wrong = (record.wrong || []).filter(wrong => !same(wrong, choice));
    } else {
      if (record.correct && same(record.correct, choice)) delete record.correct;
      record.wrong ||= [];
      if (!record.wrong.some(wrong => same(wrong, choice))) record.wrong.push(canonical(choice));
    }
  }
  function masteryURL(currentURL) {
    const current = new URL(currentURL);
    const course = current.searchParams.get('recruitAndCourseId');
    if (!course || !/^https?:$/.test(current.protocol)) throw new Error('无法识别本课程热力图地址');
    const target = new URL('/study/mastery', current.origin);
    target.searchParams.set('recruitAndCourseId', course);
    return target.href;
  }
  function identifyPage(currentURL, markers) {
    // 页面主体优先，避免包装层类名或路由形式变化导致已加载的热力图被拒绝。
    if (markers.analysis) return 'analysis';
    if (markers.exam) return 'exam';
    if (markers.point) return 'point';
    if (markers.mastery) return 'mastery';
    const url = new URL(currentURL);
    const path = url.pathname.replace(/\/+$/, '');
    return ['/examAnalysis', '/exam', '/study/mastery'].includes(path) || path.startsWith('/pointOfMastery/') ? 'loading' : 'unknown';
  }
  function snapshotQuestion(question) {
    return {
      number: question.number, title: question.title, type: question.type, multiple: question.multiple,
      options: question.options.map((option, index) => ({
        token: option.token, content: option.content ?? option.token, letter: option.letter ?? String.fromCharCode(65 + index),
        index: index + 1, inputValue: option.inputValue ?? null, images: (option.images || []).map(image => ({ ...image })),
      })),
    };
  }
  function questionBankFromRecords(records) {
    const bank = { questions: {} };
    for (const [key, record] of Object.entries(records || {})) {
      let parts;
      try { parts = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(parts?.[3])) continue;
      const [knowledgeScope, type, title, tokens] = parts;
      bank.questions[key] = { type: record.type || type, title: record.title || title, scope: knowledgeScope,
        knowledgeTitle: record.knowledgeTitle || '',
        multiple: type === '多选题', latestOptions: record.options || tokens.map(token => ({ token, content: token, images: [] })),
        correctAnswerTokens: record.correct?.length ? canonical(record.correct) : null };
    }
    return bank;
  }
  function formatTextBank(bank) {
    const line = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const contentOf = option => {
      let content = line(option.content ?? option.token);
      if (content === option.token) content = content.replace(/\s+\[ID:[^\]]*\]$/, '');
      const images = (option.images || []).map(image => image.src).filter(Boolean);
      if (images.length && !content.includes('[图片:')) content += ` [图片:${images.join('|')}]`;
      return content;
    };
    const groups = new Map();
    let skipped = 0, duplicates = 0, conflicts = 0, unconfirmed = 0, incomplete = 0;
    const excluded = [];
    const exclude = (key, question, reason) => {
      skipped++;
      if (reason === 'unconfirmed') unconfirmed++; else incomplete++;
      excluded.push({ key, ...question, reason });
    };
    for (const [key, question] of Object.entries(bank.questions || {})) {
      const options = question.latestOptions || [];
      const tokens = question.correctAnswerTokens;
      if (!question.title || !['单选题', '多选题', '判断题'].includes(question.type) || !Array.isArray(options) || !options.length ||
        options.some(option => !option || typeof option.token !== 'string' || !option.token)) {
        exclude(key, question, 'incomplete'); continue;
      }
      if (tokens === null || tokens === undefined || (Array.isArray(tokens) && !tokens.length)) {
        exclude(key, question, 'unconfirmed'); continue;
      }
      if (!Array.isArray(tokens) ||
        (!question.multiple && tokens.length !== 1) || new Set(tokens).size !== tokens.length ||
        new Set(options.map(option => option.token)).size !== options.length || !tokens.every(token => options.some(option => option.token === token))) {
        exclude(key, question, 'incomplete'); continue;
      }
      const contents = options.map(contentOf);
      const answers = options.filter(option => tokens.includes(option.token)).map(contentOf);
      if (contents.some(content => !content)) { exclude(key, question, 'incomplete'); continue; }
      let answer = answers.join(';');
      if (question.type === '判断题') {
        if (/^(对|正确|是|真|true|t|√|✓|1)$/i.test(normalize(answer))) answer = 'true';
        else if (/^(错|错误|不正确|否|假|false|f|×|✗|0)$/i.test(normalize(answer))) answer = 'false';
      }
      const identity = JSON.stringify([question.type, normalize(question.title), canonical(contents)]);
      const signature = question.type === '判断题' ? answer : JSON.stringify(canonical(answers));
      if (groups.has(identity)) {
        const previous = groups.get(identity);
        if (previous.signature !== signature) previous.conflict = true;
        else duplicates++;
        continue;
      }
      groups.set(identity, { type: question.type, title: line(question.title), contents, answer, signature, key, question });
    }
    const blocks = [];
    for (const item of groups.values()) {
      if (item.conflict) { conflicts++; excluded.push({ key: item.key, ...item.question, reason: 'conflict' }); continue; }
      const lines = [`${blocks.length + 1}.【${item.type}】${item.title}`];
      if (item.type !== '判断题') lines.push(...item.contents.map((content, index) => `${String.fromCharCode(65 + index)}.${content}`));
      lines.push(item.answer);
      blocks.push(lines.join('\r\n'));
    }
    return { text: blocks.length ? blocks.join('\r\n\r\n') + '\r\n' : '', exported: blocks.length, skipped, duplicates, conflicts, unconfirmed, incomplete, excluded };
  }
  function formatExcludedBankReport(bank) {
    const reasons = { unconfirmed: '尚未取得本题判对答案', incomplete: '题干、选项或答案匹配数据异常', conflict: '同题已确认答案互相冲突' };
    const blocks = bank.excluded.map((question, index) => {
      const lines = [`${index + 1}.【${question.type || '未知题型'}】${question.title || '题干缺失'}`,
        `未入库原因：${reasons[question.reason]}`, `知识点：${question.knowledgeTitle || question.scope || '未知'}`];
      if (Array.isArray(question.latestOptions)) lines.push(...question.latestOptions.map((option, position) => `${String.fromCharCode(65 + position)}.${option.content ?? option.token ?? '选项内容缺失'}`));
      return lines.join('\r\n');
    });
    return `未入库题目清单\r\n已入库 ${bank.exported} 题；未确认答案 ${bank.unconfirmed} 题；数据异常 ${bank.incomplete} 题；答案冲突 ${bank.conflicts} 组。\r\n以下题目未写入正式题库；这份清单供排查，不要导入搜题软件作为答案。\r\n\r\n${blocks.join('\r\n\r\n')}\r\n`;
  }
  function extractCourseName(label) {
    const match = normalize(label).match(/^课程名称\s*:\s*(.+)$/);
    return match ? match[1].split(/[|｜]/)[0].trim() : '';
  }
  function courseFileName(kind, course, at) {
    const safe = value => String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[.\s]+$/, '').slice(0, 80);
    return `${safe(kind)}-${safe(course.name) || '未识别课程'}-${safe(course.id)}-${safe(at)}`;
  }
  function recordsForCourse(records, courseId) {
    const prefix = courseId + '|';
    const questions = Object.fromEntries(Object.entries(records.questions || {}).filter(([key]) => {
      try { return JSON.parse(key)[0]?.startsWith(prefix); } catch { return false; }
    }));
    const rounds = Object.fromEntries(Object.entries(records.rounds || {}).filter(([key]) => key.startsWith(prefix)));
    return { ...records, questions, rounds, pending: records.pending?.scope?.startsWith(prefix) ? records.pending : null };
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { normalize, same, combinations, questionKey, nextAnswer, remember, masteryURL, identifyPage, binomial, answerModel, rankedCombinations, masteryProgress, parseMasteryRate, snapshotQuestion, questionBankFromRecords, formatTextBank, formatExcludedBankReport, extractCourseName, courseFileName, recordsForCourse };
    return;
  }

  const PREFIX = 'zhs-mastery-practice-v1:';
  const SESSION = PREFIX + 'run';
  const SETTINGS = PREFIX + 'settings';
  const COURSES = PREFIX + 'courses';
  const SELECTORS = {
    cards: '.mastery-content-right .chunk-list .item-box',
    cardName: '.item-box-name',
    popover: '.mastery-box-custom-popover',
    questions: '.exam .exam-item, .exam-preview .exam-item',
    title: '.quest-title .option-name', type: '.quest-type',
    options: 'label.el-radio, label.el-checkbox',
    answerCards: '.exam .answer-card .list .item',
    submit: '.exam .header .submit', retry: '.exam-preview .header .submit',
    pointAnalysis: '.point .line1-count-link',
  };
  let settings = Object.assign({ mode: 'all', delay: 250, maxRounds: 4096 }, GM_getValue(SETTINGS, {}));
  delete settings.includeGreen;
  let db, dbCourse = '', running = false, starting = false, busy = false, generation = 0, releaseLock;
  let runCourse = '', lastRoute = '', routeSince = Date.now(), routeReady = false;
  let status = '待启动', logs = [], activeName = '', selectedCard = '';
  let checks, checksCourse = '';
  let screen, ui, uiStatus, uiLog, uiStart, uiMode, uiDelay, uiProgress, uiProgressBar;
  let uiExportCourse, uiCourseLabel, lastExportPageCourse = '', courseOptionSignature = '';
  let metadataRoute = '', metadataSince = Date.now();
  const courseLogs = {};
  const PRIOR_COURSE = '4e5f5a5944594859454a585958435b4a5b';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const textOf = el => normalize(el?.textContent);
  function visible(el, viewport = false) {
    if (!el?.isConnected) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || node.getAttribute('aria-hidden') === 'true') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!viewport || (r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth));
  }
  const shown = selector => $$(selector).find(el => visible(el));
  function courseId() { return new URL(location.href).searchParams.get('recruitAndCourseId') || ''; }
  function scope() {
    const url = new URL(location.href);
    const knowledge = url.searchParams.get('knowledgeId') || (url.pathname.startsWith('/pointOfMastery/') ? url.pathname.split('/')[4] : '');
    if (!courseId() || !knowledge) throw new Error('无法识别课程或知识点，请从掌握度热力图进入');
    return `${courseId()}|${knowledge}`;
  }
  function page() {
    return identifyPage(location.href, {
      analysis: Boolean($('.exam-preview .exam-item .question-result')),
      exam: Boolean($('.exam .exam-item .quest-title')),
      point: $$('.point .line1-count-total-num').length === 2,
      mastery: Boolean($(SELECTORS.cards)),
    });
  }
  function loadDB(course) {
    if (!course) throw new Error('请打开课程页面');
    if (dbCourse === course && db) return;
    db = GM_getValue(PREFIX + course, { version: 1, questions: {}, rounds: {}, pending: null });
    if (!db || db.version !== 1 || !db.questions || !db.rounds) throw new Error('本地记录格式异常，请导出后清除记录');
    dbCourse = course;
    registerCourse(course, db.course?.id === course ? db.course.name : '');
  }
  function registerCourse(id, name = '') {
    const courses = GM_getValue(COURSES, {});
    const previous = courses[id];
    const next = { id, name: name || previous?.name || '' };
    if (!previous || previous.id !== id || previous.name !== next.name) { courses[id] = next; GM_setValue(COURSES, courses); }
    return next;
  }
  function discoverCourses() {
    if (typeof GM_listValues !== 'function') return;
    for (const key of GM_listValues()) {
      if (!key.startsWith(PREFIX)) continue;
      const id = key.slice(PREFIX.length);
      if (!id || ['settings', 'run', 'courses'].includes(id) || id.startsWith('guess-trace:')) continue;
      const records = GM_getValue(key, null);
      if (records?.version === 1 && records.questions && records.rounds) registerCourse(id, records.course?.id === id ? records.course.name : '');
    }
  }
  function refreshCourses() {
    const id = courseId();
    if (location.href !== metadataRoute) { metadataRoute = location.href; metadataSince = Date.now(); }
    if (id && dbCourse === id) {
      let name = '';
      if (page() === 'mastery' && Date.now() - metadataSince >= 1000) {
        const candidates = $$('body *').filter(el => el.children.length < 4 && el.textContent.length < 180 && visible(el))
          .map(el => textOf(el)).filter(text => extractCourseName(text)).sort((a, b) => a.length - b.length);
        name = candidates.length ? extractCourseName(candidates[0]) : '';
      }
      const course = registerCourse(id, name);
      if (JSON.stringify(db.course) !== JSON.stringify(course)) { db.course = course; save(); }
    }
    const courses = GM_getValue(COURSES, {});
    const current = courses[id] || { id, name: '' };
    uiCourseLabel.textContent = id ? `当前课程：${current.name || '课程名称待识别'}\nID：${id}` : '当前未打开课程';
    const signature = JSON.stringify(courses);
    const pageChanged = id !== lastExportPageCourse;
    if (signature !== courseOptionSignature || pageChanged) {
      const selected = pageChanged ? id : uiExportCourse.value;
      uiExportCourse.replaceChildren();
      for (const course of Object.values(courses)) {
        const option = document.createElement('option'); option.value = course.id;
        option.textContent = `${course.name || '未识别课程'} [${course.id}]${course.id === id ? '（当前）' : ''}`;
        uiExportCourse.append(option);
      }
      if (courses[selected]) uiExportCourse.value = selected;
      lastExportPageCourse = id; courseOptionSignature = signature;
    }
  }
  function exportSource() {
    const id = uiExportCourse.value || courseId();
    if (!id) throw new Error('没有可导出的课程记录');
    // 读取持久化快照，避免另一个标签页更新记录后这里仍导出旧缓存。
    const records = GM_getValue(PREFIX + id, null);
    if (!records?.questions || !records.rounds) throw new Error('所选课程没有有效记录');
    const course = GM_getValue(COURSES, {})[id] || { id, name: '' };
    return { course, records: recordsForCourse(records, id) };
  }
  function save() { GM_setValue(PREFIX + dbCourse, db); }
  function loadMasteryChecks(course) {
    if (checksCourse === course && checks) return checks;
    checksCourse = course;
    try { checks = JSON.parse(sessionStorage.getItem(PREFIX + 'mastery-checks:' + course) || 'null'); } catch { checks = null; }
    if (checks?.version !== 1 || !checks.entries || typeof checks.entries !== 'object') checks = { version: 1, entries: {} };
    return checks;
  }
  function saveMasteryChecks() { sessionStorage.setItem(PREFIX + 'mastery-checks:' + checksCourse, JSON.stringify(checks)); }
  function cardColor(card) { return ['blue', 'green', 'gray', 'origin', 'pink'].find(color => card.classList.contains(color)) || 'unknown'; }
  function checkedRate(card, index) {
    const entry = loadMasteryChecks(courseId()).entries[cardIdentity(card, index)];
    return entry && entry.color === cardColor(card) && typeof entry.rate === 'number' && entry.rate >= 0 && entry.rate <= 100 ? entry.rate : null;
  }
  function recordMasteryRate(key, rate, color) {
    loadMasteryChecks(courseId()).entries[key] = { rate, color };
    saveMasteryChecks();
  }
  function currentModel() { return answerModel(db.questions, dbCourse === PRIOR_COURSE); }
  function refreshProgress() {
    if (!ui || !courseId()) return;
    try {
      loadDB(courseId());
      refreshCourses();
      const cards = $$(SELECTORS.cards);
      if (cards.length) {
        const colors = cards.map(cardColor);
        const snapshot = masteryProgress(colors, cards.map(checkedRate));
        if (JSON.stringify(db.progress) !== JSON.stringify(snapshot)) { db.progress = snapshot; save(); }
      }
      const progress = db.progress?.perfect !== undefined ? db.progress : null;
      uiProgress.textContent = progress ? `满分进度：已确认100% ${progress.perfect}/${progress.eligible}（${progress.percent}%）\n免考 ${progress.exempt} · 剩余 ${progress.remaining} · 尚待核实 ${progress.unchecked}${cards.length ? '' : '\n以上为最近一次热力图核实结果'}` : '满分进度：等待热力图核实掌握度';
      uiProgressBar.max = progress?.eligible || 1;
      uiProgressBar.value = progress?.perfect || 0;
    } catch (error) { uiProgress.textContent = `总进度暂不可用：${error.message}`; }
  }
  function recordFor(question) {
    const key = questionKey(scope(), question);
    const record = db.questions[key] ||= { title: question.title, type: question.type, wrong: [] };
    record.options = snapshotQuestion(question).options;
    record.knowledgeTitle = activeName;
    return { key, record };
  }
  function render() {
    if (!ui) return;
    uiStatus.textContent = `${running ? '运行中' : starting ? '启动中' : '已暂停'} · ${status}${activeName ? '\n' + activeName : ''}`;
    uiStart.textContent = running || starting ? '暂停' : '开始 / 继续';
    uiStart.disabled = false;
    uiMode.disabled = running || starting;
    uiLog.textContent = logs.slice(-12).join('\n');
    uiLog.scrollTop = uiLog.scrollHeight;
  }
  function log(message, course = courseId()) {
    status = message;
    logs.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${message}`);
    if (logs.length > 150) logs.shift();
    const savedLogs = courseLogs[course] ||= [];
    savedLogs.push(logs.at(-1)); if (savedLogs.length > 150) savedLogs.shift();
    console.info('[掌握度练习助手]', message);
    render();
  }
  function stop(reason = '已手动暂停') {
    running = false; starting = false; generation++;
    sessionStorage.removeItem(SESSION);
    if (releaseLock) { releaseLock(); releaseLock = null; }
    log(reason);
  }
  function challenge() {
    return $$('iframe[src*="captcha"], iframe[src*="turing.captcha"], .yidun_popup, .geetest_panel, .tcaptcha-transform, [id*="captcha"][role="dialog"]')
      .find(el => visible(el, true));
  }
  function dialogs() {
    const matches = $$('.el-message-box, .el-dialog, [role="dialog"]').filter(el => visible(el));
    return matches.filter(el => !matches.some(other => other !== el && el.contains(other)));
  }
  function guard(ctx, navigation = false, allowDialog = false) {
    if (!running || ctx.generation !== generation) throw new Error('操作已取消');
    if (courseId() !== runCourse) throw new Error('课程已改变，请重新开始');
    if (!navigation && location.href !== ctx.url) throw new Error('页面已改变，已停止当前操作');
    if (challenge()) throw new Error('出现验证码，请手动完成验证后点击继续');
    if (!allowDialog && dialogs().length) throw new Error('出现弹窗，请手动处理后点击继续');
  }
  async function pause(ms, ctx, navigation = false, allowDialog = false) {
    // 小片段等待，使暂停按钮和验证码检查及时生效。
    const end = Date.now() + ms;
    do {
      guard(ctx, navigation, allowDialog);
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, end - Date.now()))));
    } while (Date.now() < end);
    guard(ctx, navigation, allowDialog);
  }
  async function waitFor(fn, ctx, timeout = 20000, navigation = false, allowDialog = false) {
    const end = Date.now() + timeout;
    do {
      guard(ctx, navigation, allowDialog);
      const result = fn();
      if (result) return result;
      await pause(120, ctx, navigation, allowDialog);
    } while (Date.now() < end);
    throw new Error('等待页面响应超时，已暂停；请检查页面后继续');
  }
  async function click(el, ctx, allowDialog = false) {
    guard(ctx, false, allowDialog);
    if (!el || !visible(el) || el.disabled || el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true') throw new Error('按钮不存在、不可见或不可点击');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await pause(settings.delay, ctx, false, allowDialog);
    guard(ctx, false, allowDialog);
    if (!el.isConnected) throw new Error('页面元素已刷新，请继续重试');
    // 单次原生 click；不要重复派发 click，否则复选框会被勾选后又取消。
    el.click();
  }
  async function navigateClick(el, ctx, expectedPage) {
    await click(el, ctx);
    await waitFor(() => location.href !== ctx.url && expectedPage.includes(page()), ctx, 25000, true);
    await pause(settings.delay, ctx, true);
  }
  async function finishKnowledge(ctx) {
    guard(ctx);
    const target = masteryURL(ctx.url);
    if (selectedCard) recordMasteryRate(selectedCard, 100, 'green');
    save();
    if (settings.mode === 'current') {
      stop('当前知识点已全部答对，返回热力图并停止');
      location.assign(target);
      return;
    }
    // 完整加载热力图，绕过解析页关闭按钮和结果页失效的返回按钮。
    // GM 记录已保存；同一标签页的 sessionStorage 让新页面自动继续。
    sessionStorage.setItem(SESSION, JSON.stringify({ course: runCourse }));
    log(`${activeName} 本轮全部答对，直接跳转热力图继续下一项`);
    location.assign(target);
    // 若浏览器未完成导航，仍按既有超时机制暂停，避免反复发起跳转。
    await waitFor(() => location.href === target && page() === 'mastery', ctx, 25000, true);
  }
  function mediaKey(el) {
    return $$('img', el).map(img => img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('alt') || '').join('|');
  }
  function readQuestion(el, index) {
    const titleEl = $(SELECTORS.title, el);
    const title = textOf(titleEl) + (titleEl && mediaKey(titleEl) ? ` [图片:${mediaKey(titleEl)}]` : '');
    const type = textOf($(SELECTORS.type, el));
    if (!title || !/^(单选题|多选题|判断题)$/.test(type)) throw new Error(`第 ${index + 1} 题题型或题干不支持：${type || '未知'}`);
    const labels = $$(SELECTORS.options, el);
    const base = labels.map(label => textOf($('.preStyle', label)) || textOf(label).replace(/^[A-Z][.、．]\s*/i, ''));
    const options = labels.map((label, i) => {
      const input = $('input', label);
      const content = `${base[i]}${mediaKey(label) ? ' [图片:' + mediaKey(label) + ']' : ''}`;
      const duplicate = base.filter(value => value === base[i]).length > 1;
      const token = content + (duplicate ? ` [ID:${input?.value || ''}]` : '');
      if (!input || !content || (duplicate && !input.value)) throw new Error(`第 ${index + 1} 题选项无法识别`);
      return { label, input, token, letter: String.fromCharCode(65 + i), content: base[i], inputValue: input.value,
        images: $$('img', label).map(img => ({ src: img.getAttribute('src') || img.getAttribute('data-src') || '', alt: img.getAttribute('alt') || '' })) };
    });
    const multiple = type === '多选题';
    if (options.some(o => o.input.type !== (multiple ? 'checkbox' : 'radio'))) throw new Error('题型与选项控件不一致');
    combinations(options.map(o => o.token), multiple);
    const number = Number(textOf($('.option-index', el)).match(/\d+/)?.[0]) || index + 1;
    return { el, title, type, multiple, options, number };
  }
  const selected = q => q.options.filter(o => o.input.checked).map(o => o.token);
  function questions(rootSelector) {
    const roots = $$(rootSelector);
    if (!roots.length) throw new Error('没有识别到题目，请等待加载后继续');
    return roots.map(readQuestion);
  }
  function answerLabel(question, choice) { return question.options.filter(o => choice.includes(o.token)).map(o => o.letter).join(''); }

  async function handleExam(ctx) {
    const quiz = questions('.exam .exam-item');
    const cards = $$(SELECTORS.answerCards);
    if (cards.length !== quiz.length) throw new Error('题目数量与答题卡不一致，暂停等待页面完整加载');
    activeName = textOf($('.exam .nodename'));
    const knowledge = scope();
    if ((db.rounds[knowledge] || 0) >= settings.maxRounds) throw new Error(`此知识点已达到 ${settings.maxRounds} 轮，请检查记录后调整上限`);
    const model = currentModel();
    const plan = quiz.map(q => {
      const { key, record } = recordFor(q);
      return { q, key, choice: nextAnswer(record, q, model), known: Boolean(record.correct?.length) };
    });
    // 填答可以中断；只有所有题目的实际 checked 状态符合计划才会提交。
    for (let index = 0; index < plan.length; index++) {
      const { q, choice, known } = plan[index];
      if (!visible(q.el)) {
        const card = cards.find(card => Number(textOf(card)) === q.number);
        await click(card, ctx);
        await waitFor(() => visible(q.el), ctx);
      }
      log(`第 ${index + 1}/${plan.length} 题：${known ? '沿用正确答案' : '尝试'} ${answerLabel(q, choice)}`);
      for (const option of q.options) {
        const want = choice.includes(option.token);
        if ((q.multiple && option.input.checked !== want) || (!q.multiple && want && !option.input.checked)) {
          if (option.input.disabled) throw new Error('选项不可编辑，请确认当前是答题页');
          await click(option.label, ctx);
          await waitFor(() => option.input.checked === want, ctx, 3000);
        }
      }
      if (!same(selected(q), choice)) throw new Error(`第 ${index + 1} 题选择未生效，可能有其他脚本修改答案`);
    }
    await pause(settings.delay, ctx);
    if (plan.some(({ q, choice }) => !same(selected(q), choice))) throw new Error('提交前答案被改变，请关闭其他自动答题脚本后继续');
    db.pending = { scope: knowledge, title: activeName, entries: plan.map(({ key, choice }) => ({ key, choice })), at: Date.now() };
    save();
    log(`本轮已作答 ${plan.length} 题，准备提交（第 ${(db.rounds[knowledge] || 0) + 1} 轮）`);
    await click($(SELECTORS.submit), ctx);
    const end = Date.now() + 25000;
    const accepted = new WeakSet();
    while (Date.now() < end) {
      guard(ctx, true, true);
      if (location.href !== ctx.url && ['point', 'analysis'].includes(page())) {
        db.rounds[knowledge] = (db.rounds[knowledge] || 0) + 1;
        save();
        await pause(settings.delay, ctx, true);
        return;
      }
      for (const dialog of dialogs()) {
        if (accepted.has(dialog)) continue;
        const message = textOf(dialog);
        if (/未[作答回答]|未完成|漏答|验证码/.test(message)) throw new Error('提交提示有未作答题目或验证，请手动检查');
        if (!/(确认提交|确定.{0,6}提交|是否.{0,6}提交|提交后|交卷|提交.{0,6}[？?])/.test(message)) throw new Error('出现未识别的提交弹窗，请手动处理后继续');
        const confirm = $$('button', dialog).find(button => /^(确定|确认|提交|确认提交|确定提交)$/.test(textOf(button)));
        if (!confirm) throw new Error('未识别提交确认按钮');
        accepted.add(dialog);
        await click(confirm, ctx, true);
      }
      await pause(150, ctx, true, true);
    }
    throw new Error('提交没有返回批改结果；已暂停，避免重复提交');
  }
  async function handleAnalysis(ctx) {
    const quiz = questions('.exam-preview .exam-item');
    activeName = textOf($('.exam-preview .nodename'));
    const outcomes = quiz.map(q => {
      const result = $('.question-result', q.el);
      const message = textOf(result);
      const correct = /回答正确/.test(message) ? true : /回答错误/.test(message) ? false : null;
      if (correct === null) throw new Error('批改尚未完成，或反馈格式改变，请等待后继续');
      const choice = selected(q);
      if (!choice.length || (!q.multiple && choice.length !== 1)) throw new Error('解析页没有有效的已选答案');
      const { key, record } = recordFor(q);
      return { q, key, record, choice, correct, message };
    });
    if (db.pending) {
      if (db.pending.scope !== scope()) throw new Error('批改知识点与待提交记录不同，请返回原知识点继续');
      if (db.pending.entries.length !== outcomes.length || outcomes.some(outcome => {
        const entry = db.pending.entries.find(e => e.key === outcome.key);
        return !entry || !same(entry.choice, outcome.choice);
      })) throw new Error('批改答案与本轮提交记录不一致，请检查其他脚本或是否查看了旧记录');
    }
    outcomes.forEach(({ record, choice, correct }) => remember(record, choice, correct));
    db.pending = null;
    save();
    const count = outcomes.filter(o => o.correct).length;
    log(`已记住批改结果：${count}/${outcomes.length} 正确`);
    if (count === outcomes.length) {
      await finishKnowledge(ctx);
    } else {
      // 先检查是否仍有未试组合，避免枚举耗尽后再打开一轮空答题。
      const model = currentModel();
      outcomes.forEach(({ q, record }) => nextAnswer(record, q, model));
      await navigateClick($(SELECTORS.retry), ctx, ['exam']);
    }
  }
  async function handlePoint(ctx) {
    activeName = textOf($('.point .backup-title'));
    const counts = $$('.point .line1-count-total-num').map(el => Number(textOf(el)));
    if (counts.length !== 2 || !Number.isInteger(counts[0]) || counts[0] <= 0 || !Number.isInteger(counts[1]) || counts[1] < 0 || counts[1] > counts[0]) throw new Error('结果页题数未加载或没有练习题');
    // 本次答卷有待批改记录时，先进入解析保存每题实际答案。
    if (db.pending && db.pending.scope === scope()) {
      await navigateClick($(SELECTORS.pointAnalysis), ctx, ['analysis']);
      return;
    }
    if (counts[1] === counts[0]) {
      await finishKnowledge(ctx);
    } else await navigateClick($(SELECTORS.pointAnalysis), ctx, ['analysis']);
  }
  function cardIdentity(card, index = $$(SELECTORS.cards).indexOf(card)) {
    const section = textOf($('.mastery-name', card.closest('.mastery-content')));
    return JSON.stringify([courseId(), section, textOf($(SELECTORS.cardName, card)), index]);
  }
  function associatedPopover(card) {
    const name = $(SELECTORS.cardName, card);
    const ids = (name?.getAttribute('aria-describedby') || '').split(/\s+/);
    const linked = ids.map(id => document.getElementById(id)).find(el => el?.matches(SELECTORS.popover));
    if (linked) return linked;
    const matches = $$(SELECTORS.popover).filter(el => textOf($('strong.name', el)) === textOf(name));
    return matches.length === 1 ? matches[0] : null;
  }
  async function openPopover(card, ctx) {
    const name = $(SELECTORS.cardName, card);
    if (!name) throw new Error('知识点名称未识别');
    card.scrollIntoView({ block: 'center' });
    await pause(settings.delay, ctx);
    const r = name.getBoundingClientRect();
    for (const type of ['pointerenter', 'mouseenter', 'mouseover', 'mousemove']) {
      guard(ctx);
      const EventClass = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      name.dispatchEvent(new EventClass(type, { bubbles: type !== 'mouseenter' && type !== 'pointerenter', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    }
    return waitFor(() => {
      const popover = associatedPopover(card);
      return popover && visible(popover) && textOf($('strong.name', popover)) === textOf(name) ? popover : null;
    }, ctx, 5000);
  }
  async function handleMastery(ctx) {
    if (settings.mode === 'current') { stop('当前知识点模式：请手动进入一个知识点后继续'); return; }
    const cards = $$(SELECTORS.cards);
    if (!cards.length) throw new Error('热力图知识点尚未加载，请等待后继续');
    let target, targetIndex;
    // 首次运行逐一核实具体百分比；同一次运行的完整页面重载保留核实缓存。
    for (const [index, card] of cards.entries()) {
      const color = cardColor(card);
      if (color === 'blue') continue;
      if (color === 'unknown') throw new Error('热力图出现未知颜色状态');
      let rate = checkedRate(card, index);
      if (rate === null) {
        log(`核实掌握度 ${index + 1}/${cards.length}：${textOf($(SELECTORS.cardName, card))}`);
        const popover = await openPopover(card, ctx);
        rate = parseMasteryRate(textOf($('.text > span', popover)));
        recordMasteryRate(cardIdentity(card, index), rate, color);
      }
      if (rate !== 100 && !target) { target = card; targetIndex = index; }
    }
    if (!target) { refreshProgress(); stop('所有非免考知识点已确认100%掌握度，任务完成'); return; }
    selectedCard = cardIdentity(target, targetIndex);
    activeName = textOf($(SELECTORS.cardName, target));
    log(`进入知识点：${activeName}`);
    const popover = await openPopover(target, ctx);
    const rate = parseMasteryRate(textOf($('.text > span', popover)));
    recordMasteryRate(selectedCard, rate, cardColor(target));
    if (rate === 100) { log(`${activeName} 已100%，跳过`); return; }
    const button = $$('button', popover).find(el => textOf(el) === '提升掌握度');
    await navigateClick(button, ctx, ['exam', 'point', 'analysis']);
  }
  async function step() {
    if (!running || busy) return;
    if (location.href !== lastRoute) { lastRoute = location.href; routeSince = Date.now(); routeReady = false; }
    if (Date.now() - routeSince < 1000) return;
    busy = true;
    const ctx = { generation, url: location.href };
    try {
      guard(ctx);
      const kind = page();
      if (kind === 'unknown' || kind === 'loading') {
        if (Date.now() - routeSince < 25000) return;
        throw new Error('当前页面不是掌握度练习，或加载超时，请返回热力图');
      }
      // 页面首个元素出现不表示接口和全部题目已准备好。
      if (!routeReady) { await pause(1000, ctx); routeReady = true; }
      loadDB(runCourse);
      if (kind === 'exam') await handleExam(ctx);
      else if (kind === 'analysis') await handleAnalysis(ctx);
      else if (kind === 'point') await handlePoint(ctx);
      else await handleMastery(ctx);
    } catch (error) {
      if (ctx.generation === generation && running) stop(error.message || String(error));
    } finally { busy = false; render(); }
  }
  async function start(resume = false) {
    if (running || starting || busy) return;
    const requestedCourse = courseId();
    if (!requestedCourse || page() === 'unknown') { log(`请打开掌握度热力图或知识点练习页面（当前路径：${location.pathname}）`); return; }
    if (!navigator.locks) { log('浏览器不支持运行锁，请使用新版 Edge / Chrome'); return; }
    starting = true;
    const attempt = ++generation;
    log('等待热力图知识点列表或练习题目加载…');
    try {
      const deadline = Date.now() + 30000;
      while (starting && attempt === generation) {
        if (courseId() !== requestedCourse) { stop('课程已改变，请在当前课程重新开始'); return; }
        const kind = page();
        if (kind !== 'loading' && kind !== 'unknown') break;
        if (Date.now() >= deadline) { stop('课程页面加载超时，请确认知识点列表或题目已显示后继续'); return; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!starting || attempt !== generation) return;
      runCourse = requestedCourse;
      await navigator.locks.request(PREFIX + runCourse, { ifAvailable: true }, async lock => {
        if (!starting || attempt !== generation) return;
        if (!lock) { starting = false; log('此课程已有另一个标签页在运行，请先暂停它'); return; }
        const held = new Promise(resolve => { releaseLock = resolve; });
        loadDB(runCourse);
        loadMasteryChecks(runCourse);
        if (resume !== true) { checks = { version: 1, entries: {} }; saveMasteryChecks(); }
        selectedCard = '';
        running = true; starting = false; generation++;
        lastRoute = location.href; routeSince = Date.now(); routeReady = false;
        sessionStorage.setItem(SESSION, JSON.stringify({ course: runCourse }));
        log(page() === 'mastery' ? '已识别热力图，开始处理下一知识点' : '已识别练习页面，逐题尝试并保存批改结果');
        await held;
      });
    } catch (error) { if (attempt === generation || running) stop(`启动失败：${error.message}`); }
  }
  function download(filename, data, mime = 'application/json;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function setupUI() {
    screen = document.createElement('div'); screen.id = 'zhs-mastery-practice-panel';
    screen.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483646;';
    document.body.append(screen);
    ui = screen.attachShadow({ mode: 'open' });
    ui.innerHTML = `<style>
      :host{all:initial;font:13px/1.55 system-ui,"Microsoft YaHei",sans-serif;color:#253047}
      *{box-sizing:border-box}section{width:315px;background:#fff;border:1px solid #d9ddea;border-radius:12px;box-shadow:0 8px 30px #25304730;overflow:hidden}
      header{padding:10px 12px;background:#604ffd;color:white;display:flex;justify-content:space-between;align-items:center;font-weight:700}
      button,select,input{font:inherit}button{cursor:pointer;border:1px solid #d9ddea;background:#f7f8fc;border-radius:6px;padding:6px 9px;color:#253047}button:disabled{opacity:.6;cursor:default}
      header button{color:white;border:0;background:transparent;padding:0 4px}main{padding:12px}p{margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}progress{width:100%;height:9px;accent-color:#00bd85;margin-bottom:8px}#progress{font-size:12px;color:#3b6355}
      label{display:block;margin:8px 0}select{width:100%;padding:5px;border:1px solid #d9ddea;border-radius:5px;background:#fff}input[type=number]{width:80px;padding:3px}
      .actions{display:flex;gap:7px;flex-wrap:wrap}.primary{background:#604ffd;color:white;border-color:#604ffd}pre{font:11px/1.6 monospace;white-space:pre-wrap;max-height:140px;overflow:auto;background:#f5f6fb;padding:8px;border-radius:6px;margin:10px 0 0}small{color:#737c8e}section.mini main{display:none}
    </style><section><header>掌握度练习助手 v1.5.2 <button id="fold">收起</button></header><main>
      <p id="status"></p><p id="progress"></p><progress id="progress-bar" aria-label="可练习知识点满分进度" max="1" value="0"></progress><label><select id="mode"><option value="all">全部知识点：仅跳过免考和100%</option><option value="current">当前知识点：本轮全对后停止</option></select></label>
      <label>操作间隔 <input id="delay" type="number" min="0" max="10000" step="50"> 毫秒</label>
      <small style="display:block;margin:0 0 8px">操作间隔为选项切换、悬浮弹窗和页面更新提供响应时间，如流畅运行可尝试更低值</small>
      <p id="course-label" style="font-size:11px;color:#737c8e"></p><label>导出课程 <select id="export-course" aria-label="导出课程"></select></label>
      <div class="actions"><button class="primary" id="start">开始 / 继续</button><button id="export">导出记录</button><button id="export-bank">导出纯文字题库</button><button id="export-excluded">导出未入库清单</button><button id="clear">清除当前课程记录</button></div>
      <small>单选逐项尝试，多选枚举组合；验证码出现后暂停。</small><pre id="log"></pre>
    </main></section>`;
    uiStatus = $('#status', ui); uiLog = $('#log', ui); uiStart = $('#start', ui);
    uiMode = $('#mode', ui); uiDelay = $('#delay', ui); uiProgress = $('#progress', ui); uiProgressBar = $('#progress-bar', ui);
    uiExportCourse = $('#export-course', ui); uiCourseLabel = $('#course-label', ui);
    uiMode.value = settings.mode; uiDelay.value = settings.delay;
    $('#fold', ui).onclick = event => { const folded = $('section', ui).classList.toggle('mini'); event.target.textContent = folded ? '展开' : '收起'; };
    uiStart.onclick = () => running || starting ? stop() : start();
    const changeSettings = () => {
      const delay = Number(uiDelay.value);
      if (!uiDelay.value.trim() || !Number.isFinite(delay) || delay < 0 || delay > 10000) { uiDelay.value = settings.delay; return; }
      settings = { ...settings, mode: uiMode.value, delay };
      GM_setValue(SETTINGS, settings);
    };
    uiMode.onchange = uiDelay.onchange = changeSettings;
    uiDelay.oninput = () => {
      const delay = Number(uiDelay.value);
      if (uiDelay.value.trim() && Number.isFinite(delay) && delay >= 0 && delay <= 10000) changeSettings();
    };
    $('#export', ui).onclick = () => {
      try {
        const source = exportSource(), at = new Date().toISOString();
        download(courseFileName('智慧树练习记录', source.course, at) + '.json', JSON.stringify({ version: 1, course: source.course, exportedAt: at,
          records: source.records, logs: courseLogs[source.course.id] || [], logScope: 'current_tab_page_session_for_selected_course' }, null, 2));
      } catch (error) { log(error.message); }
    };
    $('#export-bank', ui).onclick = () => {
      try {
        const source = exportSource();
        const bank = formatTextBank(questionBankFromRecords(source.records.questions));
        if (!bank.exported) { log('尚无可导出的确认答案，未解题继续保存在运行记录中'); return; }
        download(courseFileName('智慧树纯文字题库', source.course, new Date().toISOString()) + '.txt', '\uFEFF' + bank.text, 'text/plain;charset=utf-8');
        log(`[${source.course.name || source.course.id}] 已入库并导出 ${bank.exported} 题；另有未确认答案 ${bank.unconfirmed} 题、数据异常 ${bank.incomplete} 题未写入题库，答案冲突 ${bank.conflicts} 组。可点击“导出未入库清单”查看`, source.course.id);
      } catch (error) { log(error.message); }
    };
    $('#export-excluded', ui).onclick = () => {
      try {
        const source = exportSource();
        const bank = formatTextBank(questionBankFromRecords(source.records.questions));
        if (!bank.excluded.length) { log(`[${source.course.name || source.course.id}] 已收集题目均可入库，没有未入库题目`, source.course.id); return; }
        download(courseFileName('智慧树未入库题目', source.course, new Date().toISOString()) + '.txt', '\uFEFF' + formatExcludedBankReport(bank), 'text/plain;charset=utf-8');
        log(`[${source.course.name || source.course.id}] 已导出未入库清单 ${bank.excluded.length} 项，包含题干、选项、知识点和未入库原因`, source.course.id);
      } catch (error) { log(error.message); }
    };
    $('#clear', ui).onclick = () => {
      if (running || starting || busy) { log('请先暂停后清除记录'); return; }
      if (!courseId() || !confirm(`清除当前页面课程 ${GM_getValue(COURSES, {})[courseId()]?.name || courseId()} 的本地答案和尝试记录？网站成绩不会被修改，其他课程记录保留。`)) return;
      dbCourse = courseId(); db = { version: 1, questions: {}, rounds: {}, pending: null };
      loadMasteryChecks(dbCourse); checks = { version: 1, entries: {} }; saveMasteryChecks(); save(); log('本课程本地记录已清除');
    };
    refreshProgress(); render();
  }
  discoverCourses();
  setupUI();
  GM_registerMenuCommand('开始 / 继续掌握度练习', start);
  GM_registerMenuCommand('暂停掌握度练习', () => stop());
  setInterval(step, 350);
  setInterval(refreshProgress, 1000);
  addEventListener('pagehide', () => { if (releaseLock) releaseLock(); });
  try {
    const previous = JSON.parse(sessionStorage.getItem(SESSION) || 'null');
    if (previous?.course === courseId()) start(true);
  } catch { sessionStorage.removeItem(SESSION); }
})();
