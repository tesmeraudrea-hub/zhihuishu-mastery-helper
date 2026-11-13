// ==UserScript==
// @name         知到智慧树掌握度满分助手
// @author       Watson
// @namespace    local.zhihuishu.mastery.practice
// @version      1.10.0
// @description  智慧树掌握度练习与题库完善：自动作答、按批改纠错，支持满分后复练、TXT题库导入导出、课程独立记录、拖动悬浮球及内置使用帮助。仅用于不限次数的掌握度练习。
// @match        https://studywisdomh5.zhihuishu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @license      MIT
// 警告：本脚本仅适用于智慧树掌握度练习 用于有答题次数限制的练习后果自负
// 提示：脚本不会自动识别课程是否限制答题次数，请在启动前自行确认。
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
  function answerModel(records) {
    const model = {};
    // 只统计本课程已确认答案；默认数量分布在排序时叠加，不写进题库。
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
    if (!question.multiple) return candidates;
    // 原课程46道五选题的正确选项数量分布，仅作为所有课程的弱先验。
    // 折算为20道样本；当前课程每道去重后的正确题计1道，逐渐占据主要权重。
    // 四选题原样本仅5道，其余选项数无可靠统计，仍保留原有冷启动顺序。
    const prior = n === 5 ? { 2: 1, 3: 28, 4: 16, 5: 1 } : {};
    const priorTotal = Object.values(prior).reduce((sum, count) => sum + count, 0);
    const counts = { ...(model[n] || {}) };
    for (const [size, count] of Object.entries(prior)) counts[size] = (counts[size] || 0) + 20 * count / priorTotal;
    if (Object.values(counts).reduce((sum, count) => sum + count, 0) < 12) return candidates;
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
  function nextAnswer(record, question, model, preferred = []) {
    const candidates = rankedCombinations(question, model);
    if (record.correct?.length) {
      if (!candidates.some(choice => same(choice, record.correct))) throw new Error('已知答案与当前选项不一致');
      return record.correct;
    }
    const candidateKeys = new Set(candidates.map(choice => JSON.stringify(canonical(choice))));
    const eligible = preferred.filter(choice => Array.isArray(choice) && candidateKeys.has(JSON.stringify(canonical(choice))));
    const choice = [...eligible, ...candidates].find(candidate => !(record.wrong || []).some(wrong => same(candidate, wrong)));
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
  // 题库完善的进度独立于网站掌握度，持久化在当前课程中。
  function newReview(ignoreAnswers = false, id = `${Date.now()}-${Math.random().toString(36).slice(2)}`) {
    return { id, startedAt: new Date().toISOString(), ignoreAnswers, completed: [], items: {}, trials: {}, rounds: {}, activeCard: '', readyScope: '', finishedAt: null };
  }
  function questionIdentity(question) {
    return JSON.stringify([question.type, question.title, canonical(question.options.map(option => option.token))]);
  }
  function reviewProgress(review, eligible) {
    const completed = new Set(review?.completed || []).size;
    const entries = Object.values(review?.items || {});
    return { completed, eligible, percent: eligible ? Math.round(1000 * Math.min(completed, eligible) / eligible) / 10 : 0,
      added: entries.filter(item => item.correct && !item.hadAnswer).length,
      verified: entries.filter(item => item.correct && item.hadAnswer && !item.changed).length,
      corrected: entries.filter(item => item.correct && item.changed).length,
      unresolved: entries.filter(item => !item.correct).length };
  }
  function trackReview(review, question, record, choice, correct, imported = false) {
    const identity = questionIdentity(question);
    const item = review.items[identity] ||= { hadAnswer: Boolean(record.correct?.length), changed: false, correct: false };
    if (!correct && (imported || record.correct && same(record.correct, choice))) item.changed = true;
    item.correct = correct;
    if (review.ignoreAnswers) remember(review.trials[identity] ||= { wrong: [] }, choice, correct);
  }
  function reconcileFeedback(records, question, choice, correct) {
    // 同课程完全相同的题跨知识点出现时，以新批改修正旧记录；不模糊覆盖题库。
    const identity = questionIdentity(question);
    for (const [key, record] of Object.entries(records)) {
      let parts; try { parts = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(parts) || !Array.isArray(parts[3])) continue;
      if (JSON.stringify(parts.slice(1)) !== identity) continue;
      remember(record, choice, correct);
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
  // 导入题库只保存候选，网站判对后才进入 questions 中的确认答案与分布统计。
  const matchText = value => normalize(value).toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
  function truthToken(value) {
    const text = normalize(value).toLowerCase();
    if (/^(对|正确|是|真|true|t|√|✓|1)$/.test(text)) return 'true';
    if (/^(错|错误|不正确|否|假|false|f|×|✗|0)$/.test(text)) return 'false';
    return null;
  }
  function textSimilarity(a, b) {
    a = matchText(a); b = matchText(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (Math.min(a.length, b.length) < 4) return 0;
    const grams = value => { const counts = new Map(); for (let i = 0; i < value.length - 1; i++) { const pair = value.slice(i, i + 2); counts.set(pair, (counts.get(pair) || 0) + 1); } return counts; };
    const left = grams(a), right = grams(b);
    let overlap = 0;
    for (const [pair, count] of left) overlap += Math.min(count, right.get(pair) || 0);
    return 2 * overlap / (a.length + b.length - 2);
  }
  function importedItem(type, title, options, answers) {
    title = normalize(title);
    if (!['单选题', '多选题', '判断题'].includes(type) || !title) throw new Error('题型或题干缺失');
    options = options.map(normalize);
    if (type === '判断题') {
      options = options.length ? options.map(option => truthToken(option) || option) : ['true', 'false'];
      answers = answers.map(answer => answer.map(option => truthToken(option) || normalize(option)));
    } else answers = answers.map(answer => answer.map(normalize));
    if (!options.length || options.length > 12 || options.some(option => !option) || new Set(options).size !== options.length) throw new Error('选项缺失、重复或超过12项');
    if (!answers.length || answers.some(answer => !answer.length || (type !== '多选题' && answer.length !== 1) || new Set(answer).size !== answer.length || !answer.every(value => options.includes(value)))) throw new Error('答案缺失或不能唯一对应选项');
    const unique = [...new Map(answers.map(answer => [JSON.stringify(canonical(answer)), canonical(answer)])).values()];
    return { type, title, options, answers: unique };
  }
  function parseTextBank(text) {
    const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = []; let block;
    for (const raw of lines) {
      const line = raw.trim();
      const typed = line.match(/^(?:\d{1,6}\s*[.、．)）]\s*)?[【\[(（]\s*(单选题?|多选题?|判断题?)\s*[】\])）]\s*(.*)$/);
      const numbered = !typed && line.match(/^\d{1,6}\s*[.、．]\s*(?!\d)(.+)$/);
      if (typed || numbered) {
        if (blocks.length >= 20000) throw new Error('单次最多识别20000道题，请拆分题库');
        block = { type: typed ? typed[1].replace(/题?$/, '题') : '', lines: [typed ? typed[2] : numbered[1]], number: blocks.length + 1 };
        blocks.push(block);
      } else if (block && line) block.lines.push(line);
    }
    const items = [], excluded = [];
    for (const entry of blocks) {
      try {
        let body = [...entry.lines], answer = '';
        const explicit = body.findIndex(line => /^(?:参考答案|正确答案|答案)\s*[:：]/.test(line));
        if (explicit >= 0) { answer = body[explicit].replace(/^(?:参考答案|正确答案|答案)\s*[:：]\s*/, ''); body = body.slice(0, explicit); }
        const optionPattern = /^([A-La-l])\s*[.、．:：)）]\s*(.*)$/;
        const optionStart = body.findIndex(line => optionPattern.test(line));
        let title, options = [], labels = [];
        if (optionStart >= 0) {
          title = body.slice(0, optionStart).join(' ');
          if (!answer) {
            if (optionPattern.test(body.at(-1))) throw new Error('没有答案行');
            answer = body.pop();
          }
          for (const line of body.slice(optionStart)) {
            const option = line.match(optionPattern);
            if (option) { labels.push(option[1].toUpperCase()); options.push(option[2]); }
            else options[options.length - 1] += ' ' + line;
          }
          if (new Set(labels).size !== labels.length) throw new Error('选项字母重复');
        } else {
          if (!answer) answer = body.pop();
          title = body.join(' ');
        }
        answer = normalize(answer);
        let choice;
        const exact = options.filter(option => normalize(option) === answer);
        if (exact.length === 1) choice = exact;
        else if (labels.length && /^[A-La-l\s,，;；、|]+$/.test(answer)) {
          const letters = answer.toUpperCase().replace(/[\s,，;；、|]/g, '').split('');
          if (!letters.every(letter => labels.includes(letter))) throw new Error('答案字母不在选项中');
          choice = letters.map(letter => options[labels.indexOf(letter)]);
        } else choice = answer.split(/[;；]/).map(normalize);
        // 兼容常见逗号分隔，但仅在每一段都能对应选项时拆分。
        if (choice.length === 1 && !exact.length && /[,，、|]/.test(answer)) {
          const parts = answer.split(/[,，、|]/).map(normalize);
          if (parts.every(part => options.some(option => normalize(option) === part))) choice = parts;
        }
        const type = entry.type || (!options.length && truthToken(answer) ? '判断题' : choice.length > 1 ? '多选题' : '单选题');
        items.push(importedItem(type, title, options, [choice]));
      } catch (error) { excluded.push({ number: entry.number, title: entry.lines[0] || '', reason: error.message }); }
    }
    if (!blocks.length) throw new Error('未识别到题目。请使用“1.【单选题】题干”或“1.题干”开头，每个选项和答案各占一行');
    return { items, excluded, detected: blocks.length };
  }
  function parseJSONBank(text) {
    const data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    const records = data?.records?.questions || data?.questions;
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('JSON不是本脚本导出的记录或题库格式');
    const entries = Object.entries(records);
    if (entries.length > 20000) throw new Error('单次最多识别20000道题，请拆分题库');
    const items = [], excluded = [];
    for (const [key, record] of entries) {
      try {
        if (!record || typeof record !== 'object') throw new Error('题目记录无效');
        let parts; try { parts = JSON.parse(key); } catch { parts = []; }
        const sourceOptions = record.latestOptions || record.options || parts?.[3] || [];
        const options = sourceOptions.map(option => typeof option === 'string' ? { token: option, content: option } : option);
        const tokens = record.correctAnswerTokens || record.correct;
        if (!Array.isArray(tokens) || !tokens.length) throw new Error('没有已确认答案');
        const choice = tokens.map(token => {
          const matches = options.filter(option => option?.token === token);
          if (matches.length !== 1) throw new Error('答案与选项不一致');
          return matches[0].content ?? matches[0].token;
        });
        items.push(importedItem(record.type || parts?.[1], record.title || parts?.[2], options.map(option => option?.content ?? option?.token), [choice]));
      } catch (error) { excluded.push({ number: excluded.length + items.length + 1, title: record?.title || '', reason: error.message }); }
    }
    return { items, excluded, detected: entries.length };
  }
  function parseBankFile(text, filename = '') {
    return /\.json$/i.test(filename) || /^[\s\uFEFF]*\{/.test(text) ? parseJSONBank(text) : parseTextBank(text);
  }
  function mergeImported(existing, incoming) {
    const map = new Map(); let added = 0, duplicates = 0, addedAnswers = 0;
    for (const [batch, items] of [existing || [], incoming].entries()) {
      for (const raw of items) {
        const item = importedItem(raw.type, raw.title, raw.options, raw.answers);
        const key = JSON.stringify([item.type, item.title, canonical(item.options)]);
        if (!map.has(key)) { map.set(key, { ...item, answers: [] }); if (batch === 1) added++; }
        const target = map.get(key);
        for (const answer of item.answers) {
          if (target.answers.some(previous => same(previous, answer))) { if (batch === 1) duplicates++; }
          else { target.answers.push(answer); if (batch === 1) addedAnswers++; }
        }
      }
    }
    if (map.size > 20000) throw new Error('合并后超过20000道题，请分到不同课程或先清除导入题库');
    const items = [...map.values()];
    return { items, added, addedAnswers, duplicates, conflicts: items.filter(item => item.answers.length > 1).length };
  }
  function importedCandidates(items, question, mode = 'loose') {
    const live = question.options.map(option => ({ token: option.token, text: question.type === '判断题' ? truthToken(option.content ?? option.token) || normalize(option.content ?? option.token) : normalize(option.content ?? option.token) }));
    const matches = [];
    for (const item of items || []) {
      if (item.type !== question.type) continue;
      let score;
      if (mode === 'strict') {
        if (normalize(item.title) !== normalize(question.title) || !same(item.options.map(normalize), live.map(option => option.text))) continue;
        score = 2;
      } else {
        if (/\[图片:/.test(item.title + question.title) && normalize(item.title) !== normalize(question.title)) continue;
        score = textSimilarity(item.title, question.title);
        if (score < 0.8) continue;
      }
      for (const answer of item.answers) {
        const mapped = []; let valid = true;
        for (const value of answer) {
          let options = live.filter(option => mode === 'strict' || /\[图片:/.test(value + option.text) ? option.text === normalize(value) : matchText(option.text) === matchText(value));
          if (!options.length && mode !== 'strict' && !/\[图片:/.test(value)) {
            const ranked = live.filter(option => !/\[图片:/.test(option.text)).map(option => ({ option, similarity: textSimilarity(value, option.text) })).sort((a, b) => b.similarity - a.similarity);
            if (ranked[0]?.similarity >= 0.85 && ranked[0].similarity - (ranked[1]?.similarity || 0) >= 0.08) options = [ranked[0].option];
          }
          if (options.length !== 1) { valid = false; break; }
          mapped.push(options[0].token);
        }
        if (valid && new Set(mapped).size === mapped.length && (question.multiple || mapped.length === 1)) matches.push({ choice: canonical(mapped), score });
      }
    }
    return [...new Map(matches.sort((a, b) => b.score - a.score).map(item => [JSON.stringify(item.choice), item.choice])).values()];
  }
  function searchQuestionBank(records, query) {
    const terms = normalize(query).split(' ').map(matchText).filter(Boolean);
    if (!terms.length) return [];
    const phrase = terms.join('');
    const groups = new Map();
    function add(type, title, options, answers, source) {
      if (!title || !options.length || options.some(option => !option)) return;
      const stem = matchText(title), searchable = [stem, ...options.map(matchText)];
      if (!terms.every(term => searchable.some(field => field.includes(term)))) return;
      const key = JSON.stringify([type, normalize(title), canonical(options)]);
      if (!groups.has(key)) groups.set(key, { type, title, options, verified: [], imported: [],
        rank: stem === phrase ? 3 : stem.includes(phrase) ? 2 : terms.every(term => stem.includes(term)) ? 1 : 0 });
      const result = groups.get(key);
      for (const answer of answers) {
        if (!result[source].some(previous => same(previous, answer))) result[source].push(answer);
      }
    }
    const displayText = (type, value) => {
      const label = normalize(value).replace(/\s+\[ID:[^\]]*\]$/, '');
      const truth = type === '判断题' ? truthToken(label) : null;
      return truth === 'true' ? '对' : truth === 'false' ? '错' : label;
    };
    for (const question of Object.values(questionBankFromRecords(records?.questions).questions)) {
      const { type, title, latestOptions, correctAnswerTokens } = question;
      if (!correctAnswerTokens?.length || !Array.isArray(latestOptions)) continue;
      const labels = new Map(latestOptions.filter(Boolean).map(option => {
        const label = displayText(type, option.content ?? option.token);
        const images = (option.images || []).map(image => image.src).filter(Boolean);
        return [option.token, images.length && !label.includes('[图片:') ? `${label} [图片:${images.join('|')}]` : label];
      }));
      if ((type !== '多选题' && correctAnswerTokens.length !== 1) || labels.size !== latestOptions.length || !correctAnswerTokens.every(token => labels.get(token))) continue;
      add(type, title, [...labels.values()], [correctAnswerTokens.map(token => labels.get(token))], 'verified');
    }
    for (const item of records?.imported || []) {
      const label = value => displayText(item.type, value);
      add(item.type, item.title, item.options.map(label), item.answers.map(answer => answer.map(label)), 'imported');
    }
    return [...groups.values()].sort((a, b) => b.rank - a.rank || Number(!!b.verified.length) - Number(!!a.verified.length));
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { normalize, same, combinations, questionKey, nextAnswer, remember, masteryURL, identifyPage, binomial, answerModel, rankedCombinations, masteryProgress, parseMasteryRate, snapshotQuestion, questionBankFromRecords, formatTextBank, formatExcludedBankReport, extractCourseName, courseFileName, recordsForCourse, parseTextBank, parseJSONBank, parseBankFile, mergeImported, importedCandidates, searchQuestionBank, textSimilarity, newReview, questionIdentity, reviewProgress, trackReview, reconcileFeedback };
    return;
  }

  const PREFIX = 'zhs-mastery-practice-v1:';
  const SESSION = PREFIX + 'run';
  const SETTINGS = PREFIX + 'settings';
  const COURSES = PREFIX + 'courses';
  const UI_SETTINGS = PREFIX + 'ui';
  const PROGRESS_REFRESH = PREFIX + 'progress-refresh';
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
  let settings = Object.assign({ mode: 'all', activity: 'practice', ignoreAnswers: false, delay: 100, maxRounds: 4096, importMatch: 'loose' }, GM_getValue(SETTINGS, {}));
  if (!['practice', 'bank'].includes(settings.activity)) settings.activity = 'practice';
  if (!['loose', 'strict'].includes(settings.importMatch)) settings.importMatch = 'loose';
  delete settings.includeGreen;
  let db, dbCourse = '', running = false, starting = false, busy = false, navigating = false, generation = 0, releaseLock;
  let runCourse = '', lastRoute = '', routeSince = Date.now(), routeReady = false;
  let status = '待启动', logs = [], activeName = '', selectedCard = '';
  let checks, checksCourse = '';
  let screen, ui, uiStatus, uiLog, uiStart, uiMode, uiDelay, uiProgress, uiProgressBar;
  let uiExportCourse, uiCourseLabel, lastExportPageCourse = '', courseOptionSignature = '';
  let floatingState, uiPanel, uiOrb, dragSession = null;
  let metadataRoute = '', metadataSince = Date.now();
  const courseLogs = {};
  let stagedImport = null, importBusy = false, importClearCourse = '', candidateSignature = '';
  const candidateCache = new Map();
  let currentTab = 'practice', previousTab = 'practice', bankSummarySignature = '', resetReviewRequested = false;
  let bankSearchLimit = 8, lastBankSearch = {};
  let importedNotice = null;
  let refreshing = false, practiceStatus = '待启动', bankStatus = '';
  const practiceLogs = [], bankLogs = [];
  const improving = () => settings.activity === 'bank';
  const coldReview = () => improving() && db?.review?.ignoreAnswers === true;

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
      if (!id || ['settings', 'run', 'courses', 'ui'].includes(id) || id.startsWith('guess-trace:')) continue;
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
      if (JSON.stringify(db.course) !== JSON.stringify(course)) { db.course = course; if (running) save(); }
    }
    const courses = GM_getValue(COURSES, {});
    const current = courses[id] || { id, name: '' };
    uiCourseLabel.textContent = id ? current.name || '课程名称待识别' : '当前未打开课程';
    uiCourseLabel.title = id ? `${current.name || '课程名称待识别'}\nID：${id}` : '';
    const signature = JSON.stringify(courses);
    const pageChanged = id !== lastExportPageCourse;
    if (signature !== courseOptionSignature || pageChanged) {
      const selected = pageChanged ? id : uiExportCourse.value;
      uiExportCourse.replaceChildren();
      for (const course of Object.values(courses)) {
        const option = document.createElement('option'); option.value = course.id;
        option.textContent = `${course.name || '未命名课程 ' + course.id}${course.id === id ? '（当前课程）' : ''}`;
        option.title = `课程 ID：${course.id}`;
        uiExportCourse.append(option);
      }
      if (courses[selected]) uiExportCourse.value = selected;
      lastExportPageCourse = id; courseOptionSignature = signature;
    }
    refreshImportSummary();
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
  function save() {
    // 暂停的其他页面可能导入题库，避免旧页面的普通进度保存覆盖最新导入项。
    const latest = GM_getValue(PREFIX + dbCourse, null);
    if (latest?.imported) { db.imported = latest.imported; db.importRevision = latest.importRevision; }
    GM_setValue(PREFIX + dbCourse, db);
  }
  function preferredFor(question) {
    if (coldReview()) return [];
    const signature = JSON.stringify([dbCourse, db.importRevision || 0, settings.importMatch]);
    if (candidateSignature !== signature) { candidateSignature = signature; candidateCache.clear(); }
    const key = questionKey(scope(), question);
    if (!candidateCache.has(key)) candidateCache.set(key, importedCandidates(db.imported, question, settings.importMatch));
    return candidateCache.get(key);
  }
  function refreshImportSummary() {
    if (!ui) return;
    const id = uiExportCourse.value || courseId();
    const records = id ? GM_getValue(PREFIX + id, null) : null;
    const imported = records?.imported?.length || 0;
    $('#import-summary', ui).textContent = imported ? `已载入 ${imported} 道参考题。已做对且内容完整的题目，会计入上方可导出数量。` : '有别人分享的 TXT 题库？导入后，脚本会优先尝试其中的答案。';
    const signature = JSON.stringify([id, records?.questions, records?.importRevision]);
    if (signature !== bankSummarySignature) {
      bankSummarySignature = signature;
      const bank = formatTextBank(questionBankFromRecords(records?.questions || {}));
      $('#bank-count', ui).textContent = bank.exported;
      $('#bank-quality', ui).textContent = bank.exported ? '这些题已经在网站上做对，可以导出分享。' : '练习做对的题目会自动存到这里。';
      $('#bank-issues', ui).textContent = `尚未答对 ${bank.unconfirmed} 题 · 内容不完整 ${bank.incomplete} 题 · 答案冲突 ${bank.conflicts} 组`;
      $('#export-bank', ui).disabled = !bank.exported;
    }
    if (currentTab === 'bank') renderBankSearch(records, signature);
  }
  function renderBankSearch(records, signature) {
    const query = normalize($('#bank-search', ui).value);
    if (lastBankSearch.signature !== signature || lastBankSearch.query !== query) {
      lastBankSearch = { signature, query, results: searchQuestionBank(records, query) };
    } else if (lastBankSearch.limit === bankSearchLimit) return;
    lastBankSearch.limit = bankSearchLimit;
    const { results } = lastBankSearch;
    const visible = results.slice(0, bankSearchLimit);
    $('#bank-search-status', ui).textContent = !query ? '' : !results.length ? '所选课程没有匹配的题目。试试更短的关键词。' :
      `找到 ${results.length} 道题${visible.length < results.length ? `，已显示 ${visible.length} 道` : ''}`;
    $('#bank-search-more', ui).hidden = visible.length >= results.length;
    const make = (tag, text, className) => {
      const node = document.createElement(tag);
      node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const list = $('#bank-search-results', ui);
    list.replaceChildren(...visible.map(result => {
      const card = make('li', '', 'bank-search-card');
      card.append(make('span', result.type, 'bank-search-type'), make('h3', result.title));
      const options = make('ul', '', 'bank-search-options');
      options.append(...result.options.map(option => make('li', option)));
      card.append(options);
      const answers = (groups, label, className) => {
        if (!groups.length) return;
        const line = make('p', '', className);
        line.append(make('strong', label + '：'), groups.map(group => group.join('、')).join('；或 '));
        card.append(line);
      };
      answers(result.verified, result.verified.length > 1 ? '已验证记录有冲突' : '已验证答案', 'bank-search-verified');
      answers(result.imported, '导入参考（未验证）', 'bank-search-reference');
      return card;
    }));
  }
  async function previewBankFile(file) {
    if (running || starting || busy || importBusy) { logBank('请先暂停，待当前操作结束后再导入题库'); return; }
    const id = uiExportCourse.value || courseId();
    if (!id) { logBank('请先打开课程，再选择导入目标'); return; }
    stagedImport = null;
    $('#import-preview', ui).hidden = true;
    importBusy = true; render();
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('题库文件超过20 MB，请拆分后导入');
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let text;
      if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
      else {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
      }
      const parsed = parseBankFile(text, file.name);
      if ((uiExportCourse.value || courseId()) !== id) throw new Error('目标课程已改变，请重新选择题库文件');
      const records = GM_getValue(PREFIX + id, { version: 1, questions: {}, rounds: {}, pending: null });
      const merged = mergeImported(records.imported, parsed.items);
      const course = GM_getValue(COURSES, {})[id] || { id, name: '' };
      stagedImport = { id, parsed, filename: file.name };
      $('#import-preview-text', ui).textContent = `目标课程：${course.name || id}\n文件：${file.name}\n识别 ${parsed.detected} 题，可用 ${parsed.items.length} 题，无法识别 ${parsed.excluded.length} 题\n新增 ${merged.added} 题 / ${merged.addedAnswers} 个候选答案，重复答案 ${merged.duplicates} 个，合并后冲突 ${merged.conflicts} 组\n\n` + parsed.items.slice(0, 3).map((item, index) => `${index + 1}.【${item.type}】${item.title}\n候选：${item.answers.map(answer => answer.join(';')).join(' / ')}`).join('\n\n');
      $('#import-preview', ui).hidden = false;
      $('#import-confirm', ui).disabled = !parsed.items.length;
      $('#import-report', ui).disabled = !parsed.excluded.length;
      logBank(`题库预览已准备：可用 ${parsed.items.length} 题，请核对目标课程后确认导入`);
    } catch (error) { logBank(`读取题库失败：${error.message}`); }
    finally { importBusy = false; render(); }
  }
  async function changeImportedBank(clear = false) {
    if (running || starting || busy || importBusy) { logBank('请先暂停，待当前操作结束后再修改导入题库'); return; }
    const id = uiExportCourse.value || courseId();
    if (!id || (clear ? importClearCourse !== id : !stagedImport || stagedImport.id !== id)) { logBank('目标课程已改变，请重新预览或确认目标课程'); return; }
    const course = GM_getValue(COURSES, {})[id] || { id, name: '' };
    const incoming = clear ? [] : stagedImport.parsed.items;
    if (!navigator.locks) { logBank('浏览器不支持运行锁，请使用新版 Edge / Chrome'); return; }
    importBusy = true; render();
    try {
      await navigator.locks.request(PREFIX + id, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('该课程正在其他标签页运行，请先暂停后导入');
        const records = GM_getValue(PREFIX + id, { version: 1, questions: {}, rounds: {}, pending: null });
        if (records.version !== 1 || !records.questions || !records.rounds) throw new Error('课程记录格式异常，请先导出检查');
        const merged = mergeImported(clear ? [] : records.imported, incoming);
        records.imported = merged.items;
        records.importRevision = (Number(records.importRevision) || 0) + 1;
        GM_setValue(PREFIX + id, records);
        if (dbCourse === id) db = records;
        registerCourse(id, course.name);
        candidateCache.clear();
        stagedImport = null; $('#import-preview', ui).hidden = true;
        importClearCourse = ''; $('#import-clear-preview', ui).hidden = true;
        importedNotice = clear ? null : { id, count: incoming.length, added: merged.added };
        logBank(clear ? `[${course.name || id}] 导入候选题库已清除，已确认答案保留` : `[${course.name || id}] 已合并导入：新增 ${merged.added} 题、${merged.addedAnswers} 个候选答案，重复 ${merged.duplicates} 个，冲突 ${merged.conflicts} 组`, id);
      });
    } catch (error) { logBank(`题库修改失败：${error.message}`); }
    finally { importBusy = false; refreshImportSummary(); render(); }
  }
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
  function saveProgressSnapshot(course, progress) {
    // 只更新掌握度，不用旧内存答案覆盖其他页面刚保存的题库或答卷。
    const latest = GM_getValue(PREFIX + course, { version: 1, questions: {}, rounds: {}, pending: null });
    if (latest?.version !== 1 || !latest.questions || !latest.rounds) throw new Error('课程记录格式异常');
    latest.progress = progress;
    GM_setValue(PREFIX + course, latest);
    if (dbCourse === course) db = latest;
  }
  async function clearSelectedCourse() {
    if (running || starting || busy || importBusy) { logBank('请先暂停后清除记录'); return; }
    const id = uiExportCourse.value || courseId();
    if (!id) return;
    const course = GM_getValue(COURSES, {})[id] || { id, name: '' };
    if (!confirm(`清除所选课程“${course.name || id}”的本地答案、尝试记录和导入题库？网站成绩不会被修改，其他课程记录保留。`)) return;
    if (!navigator.locks) { logBank('浏览器不支持运行锁'); return; }
    importBusy = true; render();
    try {
      await navigator.locks.request(PREFIX + id, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('该课程正在其他标签页运行，请先暂停它');
        const latest = GM_getValue(PREFIX + id, null);
        const empty = { version: 1, course, questions: {}, rounds: {}, pending: null, imported: [], importRevision: (Number(latest?.importRevision) || 0) + 1 };
        GM_setValue(PREFIX + id, empty);
        if (dbCourse === id) db = empty;
        if (courseId() === id) { checksCourse = id; checks = { version: 1, entries: {} }; saveMasteryChecks(); }
        candidateCache.clear(); stagedImport = null; importedNotice = null; importClearCourse = '';
        $('#import-preview', ui).hidden = true; $('#import-clear-preview', ui).hidden = true;
        logBank(`[${course.name || id}] 所选课程本地记录与导入题库已清除`, id);
      });
    } catch (error) { logBank(`清除未完成：${error.message}`, id); }
    finally { importBusy = false; refreshImportSummary(); refreshProgress(); render(); }
  }
  async function refreshMasteryProgress(reload = true) {
    if (refreshing) { stop('已取消进度刷新'); return; }
    if (running || starting || busy || importBusy) { log('请先暂停当前任务，再刷新进度', courseId(), 'practice'); return; }
    const id = courseId();
    if (!id) { log('请先打开课程的掌握度页面', id, 'practice'); return; }
    if (!navigator.locks) { log('浏览器不支持运行锁，请使用新版 Edge / Chrome', id, 'practice'); return; }
    refreshing = true; busy = true;
    const ctx = { generation: ++generation, url: location.href, refresh: true, course: id };
    let cards = null;
    log(reload ? '正在重新载入热力图，随后核实最新掌握度…' : '正在刷新进度：只读取掌握度，不会作答或提交', id, 'practice');
    try {
      await navigator.locks.request(PREFIX + id, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('此课程正在其他标签页运行，请先暂停它');
        guard(ctx);
        if (reload) {
          sessionStorage.removeItem(SESSION);
          sessionStorage.setItem(PROGRESS_REFRESH, JSON.stringify({ course: id, at: Date.now() }));
          location.assign(masteryURL(ctx.url));
          return;
        }
        await waitFor(() => page() === 'mastery' && $$(SELECTORS.cards).length, ctx, 25000);
        await pause(1000, ctx);
        cards = $$(SELECTORS.cards);
        try {
          checksCourse = id; checks = { version: 1, entries: {} }; saveMasteryChecks();
          saveProgressSnapshot(id, masteryProgress(cards.map(cardColor)));
          refreshProgress();
          for (const [index, card] of cards.entries()) {
            guard(ctx);
            if (!card.isConnected) throw new Error('知识点列表已更新，请重新刷新进度');
            const color = cardColor(card);
            if (color === 'blue') continue;
            if (color === 'unknown') throw new Error('热力图出现未知颜色状态');
            log(`刷新进度 ${index + 1}/${cards.length}：${textOf($(SELECTORS.cardName, card))}`, id, 'practice');
            const name = $(SELECTORS.cardName, card);
            try {
              const popover = await openPopover(card, ctx);
              await pause(settings.delay, ctx);
              const rate = parseMasteryRate(textOf($('.text > span', popover)));
              if (rate === null) throw new Error('未读到有效掌握度，请稍后重新刷新');
              recordMasteryRate(cardIdentity(card, index), rate, cardColor(card));
            } finally {
              if (name?.isConnected) name.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
            }
            refreshProgress();
          }
          guard(ctx);
          const currentCards = $$(SELECTORS.cards);
          if (currentCards.length !== cards.length || currentCards.some((card, index) => card !== cards[index])) throw new Error('知识点列表已更新，请重新刷新进度');
          const progress = masteryProgress(cards.map(cardColor), cards.map(checkedRate));
          log(`进度已刷新：满分 ${progress.perfect}/${progress.eligible}，未满分 ${progress.remaining}，免考 ${progress.exempt}。任务保持暂停。`, id, 'practice');
        } finally {
          if (courseId() === id && location.href === ctx.url) {
            const currentCards = $$(SELECTORS.cards);
            saveProgressSnapshot(id, masteryProgress(currentCards.map(cardColor), currentCards.map(checkedRate)));
          }
        }
      });
    } catch (error) {
      if (refreshing) log(`进度刷新未完成：${error.message}。未核实项目会保留为待检查。`, id, 'practice');
    } finally {
      refreshing = false; busy = false; refreshProgress(); render();
    }
  }
  function currentModel() {
    if (!coldReview()) return answerModel(db.questions);
    const trials = Object.fromEntries(Object.entries(db.review.trials).map(([identity, record]) => {
      const parts = JSON.parse(identity);
      return [JSON.stringify(['review', ...parts]), { ...record, type: parts[0] }];
    }));
    return answerModel(trials);
  }
  function answerRecord(question, record) {
    return coldReview() ? (db.review.trials[questionIdentity(question)] ||= { wrong: [] }) : record;
  }
  function refreshProgress() {
    if (!ui || !courseId()) return;
    try {
      loadDB(courseId());
      // 暂停页只读取最新快照，不用旧内存记录覆盖其他标签页的运行成果。
      if (!running && !starting && !busy && !importBusy) {
        const latest = GM_getValue(PREFIX + dbCourse, null);
        if (latest?.version === 1 && latest.questions && latest.rounds) db = latest;
      }
      refreshCourses();
      const cards = $$(SELECTORS.cards);
      if (cards.length) {
        const colors = cards.map(cardColor);
        const snapshot = masteryProgress(colors, cards.map(checkedRate));
        if (JSON.stringify(db.progress) !== JSON.stringify(snapshot)) { db.progress = snapshot; if (running) save(); }
      }
      let progress = db.progress?.perfect !== undefined ? db.progress : null;
      $('#progress-title', ui).textContent = '本课程满分进度';
      uiProgress.textContent = progress ? `免考 ${progress.exempt} · 剩余 ${progress.remaining} · 尚待核实 ${progress.unchecked}${cards.length ? '' : '\n最近一次热力图核实结果'}` : '等待热力图核实掌握度';
      // 未核实的知识点不能算成未满分，避免初次打开显示误导性的 0%。
      const unchecked = !progress || progress.unchecked > 0;
      const waiting = unchecked && !progress?.verified;
      $('#completed-count', ui).textContent = progress ? progress.perfect : '—';
      $('#total-count', ui).textContent = progress ? progress.eligible : '—';
      $('#progress-percent', ui).textContent = unchecked ? (progress?.verified ? '核实中' : '待检查') : progress ? `${progress.percent}%` : '待检查';
      $('#progress-empty', ui).hidden = !waiting;
      $('#progress-empty strong', ui).textContent = refreshing || running || starting ? '正在检查进度' : '准备开始';
      $('#progress-numbers', ui).hidden = waiting;
      uiProgressBar.hidden = waiting;
      if (unchecked) uiProgress.textContent = progress?.perfect ? `已确认 ${progress.perfect} 个满分，另有 ${progress.unchecked} 个待检查。` : '开始后检查已有进度，自动跳过免考和满分项。';
      else if (progress) uiProgress.textContent = progress.remaining ? `还有 ${progress.remaining} 个知识点未满分 · 免考 ${progress.exempt} 个` : `可练习的 ${progress.eligible} 个知识点均已满分 · 免考 ${progress.exempt} 个`;
      $('#orb-percent', ui).textContent = running || starting ? '运行中' : '已暂停';
      uiOrb.style.setProperty('--orb-progress', `${progress?.percent || 0}%`);
      uiProgressBar.max = progress?.eligible || 1;
      uiProgressBar.value = progress?.perfect || 0;
      if (typeof render === 'function') render();
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
    const active = running || starting;
    const locked = active || busy || importBusy || refreshing;
    const progress = dbCourse === courseId() ? db?.progress : null;
    const review = dbCourse === courseId() ? db?.review : null;
    const complete = Boolean(progress?.total && progress.unchecked === 0 && progress.remaining === 0);
    const practiceActive = active && !improving(), reviewActive = active && improving();
    const state = running ? 'running' : starting || refreshing ? 'starting' : 'paused';
    const stateLabel = refreshing ? '正在刷新进度' : running ? (improving() ? '正在补充题库' : '正在练习') : starting ? '正在准备' : '已暂停';
    uiPanel.dataset.state = uiOrb.dataset.state = state;
    $('#run-state', ui).textContent = refreshing ? '正在刷新进度' : practiceActive ? stateLabel : complete ? '已满分 · 已暂停' : practiceStatus === '待启动' ? '准备就绪' : '已暂停';
    uiStatus.textContent = reviewActive ? '补充题库正在运行，请在“我的题库”暂停后再开始练习。' : practiceStatus === '待启动' ? (complete ? '本课程已满分。手动作答后，可刷新进度或继续练习。' : courseId() ? '已识别当前课程，可以开始。' : '请先打开课程的掌握度热力图。') : `${activeName && practiceActive ? activeName + '\n' : ''}${practiceStatus}`;
    $('#bank-status', ui).textContent = !uiExportCourse.value || uiExportCourse.value === courseId() ? bankStatus : '';
    uiStatus.title = uiStatus.textContent;
    uiOrb.setAttribute('aria-label', `展开掌握度满分助手，${stateLabel}`);
    $('#orb-percent', ui).textContent = refreshing ? '刷新中' : active ? '运行中' : '已暂停';
    uiStart.textContent = practiceActive ? '暂停练习' : complete || practiceStatus !== '待启动' ? '继续练习' : '开始练习';
    uiStart.disabled = !practiceActive && locked;
    $('.control-bar', ui).hidden = currentTab !== 'practice';
    $('#bank-controls', ui).hidden = currentTab !== 'bank';
    $('#refresh-progress', ui).textContent = refreshing ? '取消刷新' : '刷新进度';
    $('#refresh-progress', ui).disabled = !refreshing && locked;
    $('#refresh-note', ui).textContent = refreshing ? '只读取最新掌握度，刷新结束后保持暂停。' : '刷新会返回并重新载入热力图，核实最新进度，不会答题。';
    uiMode.disabled = locked;
    $('#activity', ui).disabled = locked;
    $('#ignore-answers', ui).disabled = locked || Boolean(review && !review.finishedAt);
    uiMode.value = settings.mode;
    uiMode.options[0].textContent = '全部知识点：仅跳过免考和100%';
    $('#review-reset-confirm', ui).disabled = locked;
    const selectedIsCurrent = Boolean(courseId()) && (!uiExportCourse.value || uiExportCourse.value === courseId());
    const bankRecords = selectedIsCurrent ? db : GM_getValue(PREFIX + uiExportCourse.value, null);
    const bankReview = bankRecords?.review;
    const stats = reviewProgress(bankReview, bankRecords?.progress?.eligible || 0);
    $('#review-title', ui).textContent = bankReview?.finishedAt ? '本轮题库检查已完成' : bankReview ? '继续检查答案、收集新题' : '重新练习，补充题库';
    $('#begin-review', ui).textContent = reviewActive && selectedIsCurrent ? '暂停补充题库' : bankReview?.finishedAt ? '再检查一轮' : bankReview ? '继续补充题库' : '开始补充题库';
    $('#begin-review', ui).disabled = !selectedIsCurrent || (!reviewActive && locked);
    $('#review-progress', ui).hidden = !bankReview;
    $('#review-progress-count', ui).textContent = `${stats.completed} / ${stats.eligible} 个知识点`;
    $('#review-progress-bar', ui).max = stats.eligible || 1;
    $('#review-progress-bar', ui).value = stats.completed;
    $('#review-state', ui).textContent = reviewActive && selectedIsCurrent ? '正在补充题库' : bankReview?.finishedAt ? '本轮已完成' : '已暂停';
    $('#review-stats', ui).hidden = !bankReview;
    for (const key of ['added', 'verified', 'corrected', 'unresolved']) $('#review-' + key, ui).textContent = stats[key];
    $('#review-note', ui).textContent = !bankReview ? '' : bankReview.finishedAt ? '本轮已结束。可导出题库，或开始新一轮继续收集。' : `本轮始于 ${new Date(bankReview.startedAt).toLocaleString('zh-CN')}，暂停或刷新后继续。${bankReview.ignoreAnswers ? '正在忽略运行前已有答案。' : ''}`;
    $('#new-review', ui).hidden = !bankReview || Boolean(bankReview.finishedAt);
    $('#new-review', ui).disabled = locked || !selectedIsCurrent;
    $('#review-course-hint', ui).hidden = selectedIsCurrent && !practiceActive && !refreshing;
    $('#review-course-hint', ui).textContent = !selectedIsCurrent ? '请在网站中打开所选课程，再开始补充题库。' : refreshing ? '请等待进度刷新完成。' : '练习正在运行，暂停练习后才能补充题库。';
    $('#import-success', ui).hidden = !importedNotice || importedNotice.id !== uiExportCourse.value;
    $('#import-success-text', ui).textContent = importedNotice ? `已导入 ${importedNotice.count} 道参考题（新增 ${importedNotice.added} 道）。练习时会优先尝试这些答案。` : '';
    $('#use-imported', ui).disabled = false;
    const known = dbCourse === courseId() && db ? Object.values(db.questions).some(q => q.correct?.length) || db.imported?.length : false;
    $('#practice-bank-hint', ui).textContent = known ? '已保存的答案会自动优先使用，答错后继续尝试。' : '没有题库也能开始，脚本会逐步尝试并记住正确答案。';
    $('#practice-next', ui).textContent = '完成未满分的知识点，自动跳过免考和 100% 掌握度项。';
    $('#help-context', ui).textContent = previousTab === 'bank' ? '导入、导出、补充题库和本轮收集结果，都在“我的题库”中操作。' : '在练习页开始、暂停或刷新进度。没有题库也能用；有题库时会自动使用。';
    $('.control-hint', ui).textContent = refreshing ? '正在刷新进度，完成后可继续练习' : reviewActive ? '请先在“我的题库”暂停补充任务' : practiceActive ? '收起为悬浮球后，练习仍会继续' : '仅在确认答题次数不限后使用';
    for (const id of ['import-bank', 'import-clear', 'import-match']) $('#' + id, ui).disabled = locked;
    $('#import-confirm', ui).disabled = locked || !stagedImport?.parsed.items.length;
    $('#import-report', ui).disabled = importBusy || !stagedImport?.parsed.excluded.length;
    $('#import-clear-confirm', ui).disabled = locked || !importClearCourse;
    uiLog.textContent = practiceLogs.slice(-12).join('\n');
    $('#bank-log', ui).textContent = selectedIsCurrent ? bankLogs.slice(-12).join('\n') : '请打开所选课程，查看本次页面的操作记录。';
    $('#log-count', ui).textContent = practiceLogs.length ? `${Math.min(practiceLogs.length, 12)} 条` : '暂无记录';
    uiLog.scrollTop = uiLog.scrollHeight;
  }
  function log(message, course = courseId(), area = refreshing ? 'practice' : improving() ? 'bank' : 'practice') {
    status = message;
    if (area === 'bank') bankStatus = message;
    else practiceStatus = message;
    logs.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${message}`);
    if (logs.length > 150) logs.shift();
    const areaLogs = area === 'bank' ? bankLogs : practiceLogs;
    areaLogs.push(logs.at(-1)); if (areaLogs.length > 150) areaLogs.shift();
    const savedLogs = courseLogs[course] ||= [];
    savedLogs.push(logs.at(-1)); if (savedLogs.length > 150) savedLogs.shift();
    console.info('[知到智慧树掌握度满分助手]', message);
    render();
  }
  function logBank(message, course = courseId()) { log(message, course, 'bank'); }
  function stop(reason = '已手动暂停') {
    const area = refreshing ? 'practice' : improving() ? 'bank' : 'practice';
    navigating = false;
    running = false; starting = false; refreshing = false; generation++;
    sessionStorage.removeItem(SESSION);
    if (releaseLock) { releaseLock(); releaseLock = null; }
    log(reason, courseId(), area);
  }
  function saveRun() {
    sessionStorage.setItem(SESSION, JSON.stringify({ course: runCourse, activity: settings.activity, mode: settings.mode }));
  }
  function goHome(target) {
    // 完整导航期间旧页面停止调度，不用旧页面超时清除新页面的续跑标记。
    navigating = true;
    const attempt = generation;
    location.assign(target);
    setTimeout(() => {
      if (navigating && running && generation === attempt) log('正在等待热力图载入；若页面仍未变化，请刷新，或暂停后重试');
    }, 25000);
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
    if (!(ctx.refresh ? refreshing : running) || ctx.generation !== generation) throw new Error('操作已取消');
    if (courseId() !== (ctx.refresh ? ctx.course : runCourse)) throw new Error('课程已改变，请重新开始');
    if (!navigation && location.href !== ctx.url) throw new Error('页面已改变，已停止当前操作');
    if (challenge()) throw new Error('页面出现需要手动处理的提示，请检查后点击继续');
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
    if (improving()) {
      const card = db.review.activeCard || selectedCard;
      if (!card) throw new Error('本轮知识点身份缺失，请回到热力图后继续');
      if (!db.review.completed.includes(card)) db.review.completed.push(card);
      db.review.activeCard = ''; db.review.readyScope = '';
    }
    save();
    if (!improving() && settings.mode === 'current') {
      stop('当前知识点已全部答对，返回热力图并停止');
      location.assign(target);
      return;
    }
    // 完整加载热力图，绕过解析页关闭按钮和结果页失效的返回按钮。
    // GM 记录已保存；同一标签页的 sessionStorage 让新页面自动继续。
    saveRun();
    log(`${activeName} 本轮全部答对，直接跳转热力图继续下一项`);
    goHome(target);
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
    const rounds = improving() ? db.review.rounds : db.rounds;
    if ((rounds[knowledge] || 0) >= settings.maxRounds) throw new Error(`此知识点已达到 ${settings.maxRounds} 轮，请检查记录后调整上限`);
    const model = currentModel();
    const plan = quiz.map(q => {
      const { key, record } = recordFor(q);
      const preferred = preferredFor(q);
      const trial = answerRecord(q, record);
      const choice = nextAnswer(trial, q, model, preferred);
      return { q, key, choice, known: Boolean(trial.correct?.length), imported: !trial.correct?.length && preferred.some(candidate => same(candidate, choice)) };
    });
    // 填答可以中断；只有所有题目的实际 checked 状态符合计划才会提交。
    for (let index = 0; index < plan.length; index++) {
      const { q, choice, known, imported } = plan[index];
      if (!visible(q.el)) {
        const card = cards.find(card => Number(textOf(card)) === q.number);
        await click(card, ctx);
        await waitFor(() => visible(q.el), ctx);
      }
      log(`第 ${index + 1}/${plan.length} 题：${known ? '沿用正确答案' : imported ? '尝试题库候选' : '尝试'} ${answerLabel(q, choice)}`);
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
    db.pending = { scope: knowledge, title: activeName, entries: plan.map(({ key, choice, imported }) => ({ key, choice, imported })), at: Date.now(), reviewId: improving() ? db.review.id : null };
    save();
    log(`本轮已作答 ${plan.length} 题，准备提交（第 ${(db.rounds[knowledge] || 0) + 1} 轮）`);
    await click($(SELECTORS.submit), ctx);
    const end = Date.now() + 25000;
    const accepted = new WeakSet();
    while (Date.now() < end) {
      guard(ctx, true, true);
      if (location.href !== ctx.url && ['point', 'analysis'].includes(page())) {
        db.rounds[knowledge] = (db.rounds[knowledge] || 0) + 1;
        if (improving()) db.review.rounds[knowledge] = (db.review.rounds[knowledge] || 0) + 1;
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
    if (improving() && !db.pending) {
      if (db.review.readyScope === scope()) await finishKnowledge(ctx);
      else await navigateClick($(SELECTORS.retry), ctx, ['exam']);
      return;
    }
    if (improving() && db.pending.reviewId !== db.review.id) throw new Error('存在上一轮未处理的答卷，请从热力图开始新一轮');
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
    outcomes.forEach(({ q, key, record, choice, correct }) => {
      if (improving()) trackReview(db.review, q, record, choice, correct, db.pending?.entries.find(entry => entry.key === key)?.imported);
      reconcileFeedback(db.questions, q, choice, correct);
    });
    const count = outcomes.filter(o => o.correct).length;
    if (improving()) db.review.readyScope = count === outcomes.length ? scope() : '';
    db.pending = null;
    save();
    log(`已记住批改结果：${count}/${outcomes.length} 正确`);
    if (count === outcomes.length) {
      await finishKnowledge(ctx);
    } else {
      // 先检查是否仍有未试组合，避免枚举耗尽后再打开一轮空答题。
      const model = currentModel();
      outcomes.forEach(({ q, record }) => nextAnswer(answerRecord(q, record), q, model, preferredFor(q)));
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
    if (counts[1] === counts[0] && (!improving() || db.review.readyScope === scope())) {
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
    if (!improving() && settings.mode === 'current') { stop('当前知识点模式：请手动进入一个知识点后继续'); return; }
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
      const needed = improving() ? !db.review.completed.includes(cardIdentity(card, index)) : rate !== 100;
      if (needed && !target) { target = card; targetIndex = index; }
    }
    if (!target) {
      if (improving()) { db.review.finishedAt = new Date().toISOString(); save(); }
      refreshProgress(); stop(improving() ? '本轮题库检查已完成，可到“我的题库”导出；再检查一轮可继续收集新题' : '所有非免考知识点已确认100%掌握度，任务完成'); return;
    }
    selectedCard = cardIdentity(target, targetIndex);
    activeName = textOf($(SELECTORS.cardName, target));
    log(`进入知识点：${activeName}`);
    const popover = await openPopover(target, ctx);
    const rate = parseMasteryRate(textOf($('.text > span', popover)));
    recordMasteryRate(selectedCard, rate, cardColor(target));
    if (!improving() && rate === 100) { log(`${activeName} 已100%，跳过`); return; }
    if (improving()) { db.review.activeCard = selectedCard; db.review.readyScope = ''; save(); }
    const button = $$('button', popover).find(el => textOf(el) === '提升掌握度');
    await navigateClick(button, ctx, ['exam', 'point', 'analysis']);
  }
  async function step() {
    if (!running || busy || navigating) return;
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
    if (running || starting || busy || importBusy) return;
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
        dbCourse = ''; // 持锁后读取最新课程记录，保留其他标签页暂停期间的更改。
        loadDB(runCourse);
        if (improving()) {
          db.review ||= newReview(settings.ignoreAnswers);
          if (db.review.finishedAt) { starting = false; releaseLock(); log('本轮已完成，请到“我的题库”点击“再检查一轮”'); return; }
          $('#ignore-answers', ui).checked = db.review.ignoreAnswers;
          save();
        }
        loadMasteryChecks(runCourse);
        if (resume !== true) { checks = { version: 1, entries: {} }; saveMasteryChecks(); }
        selectedCard = improving() ? db.review.activeCard : '';
        running = true; starting = false; generation++;
        lastRoute = location.href; routeSince = Date.now(); routeReady = false;
        saveRun();
        if (improving() && !selectedCard && page() !== 'mastery') {
          log('返回热力图，建立本轮知识点列表'); goHome(masteryURL(location.href));
        }
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
  function showTab(tab) {
    if (tab === 'help' && currentTab !== 'help') previousTab = currentTab;
    currentTab = tab;
    for (const name of ['practice', 'bank', 'help']) $('#view-' + name, ui).hidden = name !== tab;
    for (const name of ['practice', 'bank']) {
      const button = $('#tab-' + name, ui);
      button.setAttribute('aria-selected', String(name === tab));
      button.tabIndex = name === tab || tab === 'help' && name === previousTab ? 0 : -1;
    }
    $('#help-toggle', ui).setAttribute('aria-expanded', String(tab === 'help'));
    $('main', ui).scrollTop = 0;
    if (floatingState) { floatingState.tab = tab; floatingState.previousTab = previousTab; saveFloatingState(); }
    if (tab === 'bank') refreshImportSummary();
    render();
  }
  function selectActivity(activity) {
    if (running || starting || busy || importBusy) return false;
    settings.activity = activity;
    $('#activity', ui).value = activity;
    GM_setValue(SETTINGS, settings); candidateCache.clear();
    resetReviewRequested = false; $('#review-reset', ui).hidden = true;
    refreshProgress(); render();
    return true;
  }
  function beginReview() {
    if ((running || starting) && improving()) { stop(); return; }
    if (uiExportCourse.value && uiExportCourse.value !== courseId()) return;
    if (!selectActivity('bank')) return;
    if (db?.review?.finishedAt) {
      resetReviewRequested = courseId(); $('#review-reset', ui).hidden = false;
      $('#review-reset', ui).scrollIntoView({ block: 'nearest' });
      return;
    }
    showTab('bank'); start();
  }
  function beginPractice() {
    if ((running || starting) && !improving()) { stop(); return; }
    if (selectActivity('practice')) start();
  }
  async function resetReview() {
    if (!resetReviewRequested || running || starting || busy || importBusy || !courseId()) return;
    if (resetReviewRequested !== courseId()) { resetReviewRequested = false; $('#review-reset', ui).hidden = true; log('课程已改变，请在当前课程重新确认新一轮'); return; }
    const id = courseId();
    resetReviewRequested = false;
    if (!navigator.locks) { log('浏览器不支持运行锁'); return; }
    importBusy = true; render();
    let ready = false;
    try {
      await navigator.locks.request(PREFIX + id, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('此课程正在其他标签页运行，请先暂停');
        if (id !== courseId()) throw new Error('课程已改变，请重新确认');
        dbCourse = ''; loadDB(id);
        db.review = newReview(settings.ignoreAnswers); db.pending = null; save();
        $('#review-reset', ui).hidden = true; ready = true;
      });
    } catch (error) { log(`新一轮未开始：${error.message}`); }
    finally { importBusy = false; refreshProgress(); render(); }
    if (ready) { selectActivity('bank'); showTab('bank'); start(); }
  }
  function saveFloatingState() { GM_setValue(UI_SETTINGS, floatingState); }
  function placeFloatingUI(position) {
    const viewportWidth = document.documentElement.clientWidth || innerWidth;
    uiPanel.style.maxWidth = Math.max(0, viewportWidth - 24) + 'px';
    const target = floatingState.collapsed ? uiOrb : uiPanel;
    const rect = target.getBoundingClientRect();
    const key = floatingState.collapsed ? 'orb' : 'panel';
    const point = position || floatingState[key] || { x: 18, y: innerHeight - rect.height - 18 };
    const margin = 12;
    const maxX = Math.max(0, viewportWidth - rect.width - margin);
    const maxY = Math.max(0, innerHeight - rect.height - margin);
    const x = Math.min(maxX, Math.max(Math.min(margin, maxX), point.x));
    const y = Math.min(maxY, Math.max(Math.min(margin, maxY), point.y));
    floatingState[key] = { x, y };
    screen.style.left = x + 'px'; screen.style.top = y + 'px';
  }
  function setFloatingCollapsed(collapsed) {
    const rect = (floatingState.collapsed ? uiOrb : uiPanel).getBoundingClientRect();
    floatingState.collapsed = collapsed;
    uiPanel.hidden = collapsed; uiOrb.hidden = !collapsed;
    uiOrb.setAttribute('aria-expanded', String(!collapsed));
    const width = collapsed ? 64 : uiPanel.getBoundingClientRect().width;
    placeFloatingUI({ x: rect.right - width, y: rect.top });
    saveFloatingState();
    (collapsed ? uiOrb : $('#fold', ui)).focus({ preventScroll: true });
  }
  function setupFloatingUI() {
    const saved = GM_getValue(UI_SETTINGS, {}) || {};
    const readPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
    floatingState = { collapsed: saved.collapsed === true, panel: readPoint(saved.panel), orb: readPoint(saved.orb) };
    previousTab = saved.previousTab === 'bank' ? 'bank' : 'practice';
    currentTab = previousTab;
    showTab(['practice', 'bank', 'help'].includes(saved.tab) ? saved.tab : 'practice');
    uiPanel.hidden = floatingState.collapsed; uiOrb.hidden = !floatingState.collapsed;
    uiOrb.setAttribute('aria-expanded', String(!floatingState.collapsed));
    placeFloatingUI();
    let ignoreOrbClick = false;
    $('#fold', ui).onclick = () => setFloatingCollapsed(true);
    uiOrb.onclick = event => {
      if (ignoreOrbClick && event.detail !== 0) { event.preventDefault(); return; }
      setFloatingCollapsed(false);
    };
    for (const handle of [$('#drag-handle', ui), uiOrb]) {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || dragSession || (handle !== uiOrb && event.target.closest('button, input, select, a'))) return;
        const rect = screen.getBoundingClientRect();
        dragSession = { handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, moved: false };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener('pointermove', event => {
        if (!dragSession || dragSession.handle !== handle || dragSession.pointerId !== event.pointerId) return;
        const dx = event.clientX - dragSession.startX, dy = event.clientY - dragSession.startY;
        if (!dragSession.moved && Math.hypot(dx, dy) < 4) return;
        dragSession.moved = true;
        screen.dataset.dragging = 'true';
        placeFloatingUI({ x: dragSession.x + dx, y: dragSession.y + dy });
      });
      const endDrag = event => {
        if (!dragSession || dragSession.handle !== handle || dragSession.pointerId !== event.pointerId) return;
        if (dragSession.moved) {
          if (handle === uiOrb) { ignoreOrbClick = true; setTimeout(() => { ignoreOrbClick = false; }, 0); }
          saveFloatingState();
        }
        dragSession = null; delete screen.dataset.dragging;
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      };
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
      handle.addEventListener('lostpointercapture', endDrag);
    }
    let placementFrame = 0, resizeTimer;
    const schedulePlacement = () => {
      cancelAnimationFrame(placementFrame);
      placementFrame = requestAnimationFrame(() => { if (!dragSession) placeFloatingUI(); });
    };
    addEventListener('resize', () => {
      schedulePlacement();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(saveFloatingState, 200);
    });
    ui.querySelectorAll('details').forEach(details => details.addEventListener('toggle', schedulePlacement));
    if (typeof ResizeObserver === 'function') new ResizeObserver(schedulePlacement).observe(uiPanel);
  }
  function setupUI() {
    screen = document.createElement('div'); screen.id = 'zhs-mastery-practice-panel';
    screen.style.cssText = 'position:fixed;left:18px;top:18px;z-index:2147483646;';
    document.body.append(screen);
    ui = screen.attachShadow({ mode: 'open' });
    const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    const bookIcon = svg('<path d="M12 6v14M3 4h5a4 4 0 0 1 4 3 4 4 0 0 1 4-3h5v14h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>');
    const downIcon = svg('<path d="m7 10 5 5 5-5"/>');
    ui.innerHTML = `<style>
      :host{all:initial;display:block;font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#302b40}
      *{box-sizing:border-box}[hidden]{display:none!important}button,input,select{font:inherit}button,summary{cursor:pointer}svg{width:20px;height:20px;flex-shrink:0}
      button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:9px 13px;border:1px solid #dcd7e9;border-radius:12px;background:#fff;color:#413651;transition:background .15s,box-shadow .15s}
      button:hover{background:#f4f0ff;border-color:#b9a6ea}button:disabled{opacity:.48;cursor:not-allowed}button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #8d71da;outline-offset:3px}
      .panel{width:min(420px,calc(100vw - 24px));height:min(780px,calc(100vh - 24px));height:min(780px,calc(100dvh - 24px));display:flex;flex-direction:column;overflow:hidden;border:1px solid #e8e2f2;border-radius:22px;background:#fff;box-shadow:0 16px 50px #30224326}
      .panel-header{display:flex;gap:10px;align-items:center;padding:15px 16px;border-bottom:1px solid #eee9f5;cursor:grab;touch-action:none;user-select:none;background:#faf8ff}
      :host([data-dragging="true"]) .panel-header,:host([data-dragging="true"]) #orb{cursor:grabbing}.brand-mark{display:grid;place-items:center;flex-shrink:0;width:36px;height:36px;background:#7050d4;color:#fff;border-radius:12px}.brand-mark svg{width:23px;height:23px}
      .identity{flex:1;min-width:0}.identity h1{font-size:14px;font-weight:750;line-height:1.45;margin:0;letter-spacing:-.3px}.identity small{display:flex;flex-wrap:wrap;gap:7px;font-size:11px;color:#74677f;margin-top:4px}.version{color:#74677f}
      #help-toggle,#fold{width:38px;min-height:42px;padding:0;flex-shrink:0;border:0;background:transparent;color:#69518b;font-weight:700;font-size:17px}#help-toggle[aria-expanded="true"]{background:#ece4ff;color:#5837b8}
      .usage-warning{flex-shrink:0;padding:11px 18px;background:#fff6f2;border-bottom:1px solid #f4e4dc;color:#943e2c;font-size:12px;line-height:1.65}.usage-warning p{margin:4px 0 0;color:#8b5245}.usage-warning strong{font-weight:750}
      .tabs{display:flex;gap:8px;padding:10px 18px;border-bottom:1px solid #eee9f5;flex-shrink:0;background:#fff}.tabs button{flex:1;border:0;min-height:40px;color:#70647d;background:transparent;font-weight:600}.tabs button[aria-selected="true"]{background:#efe8ff;color:#5e3dbb}
      main{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:18px;scrollbar-width:thin;scrollbar-color:#d8cee9 transparent}
      .course-strip{display:flex;align-items:center;gap:8px;margin:0 0 12px;color:#79658e}.course-strip svg{width:17px;height:17px}#course-label{font-size:14px;font-weight:600;color:#534563;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .intro{font-size:14px;color:#63576e;margin:0 0 14px;line-height:1.65}.progress-card{padding:17px 18px;background:#f6f2ff;border-radius:16px;margin-bottom:16px}.progress-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:650;color:#584769}#progress-percent{font-size:12px;background:#e9defb;color:#604398;border-radius:14px;padding:2px 9px;white-space:nowrap}
      #progress-empty strong{display:block;font-size:26px;line-height:1.4;font-weight:700;color:#3f2b62;margin:9px 0}.progress-metric{display:flex;align-items:baseline;gap:8px;margin:8px 0 12px}.progress-metric strong{font-size:38px;line-height:1.2;color:#432c6b;letter-spacing:-1px}.progress-metric span{color:#675574;font-size:14px}
      progress{display:block;appearance:none;width:100%;height:7px;border:0;border-radius:8px;overflow:hidden;background:#e6dff0;accent-color:#7955d5}progress::-webkit-progress-bar{background:#e6dff0;border-radius:8px}progress::-webkit-progress-value{background:#7955d5;border-radius:8px}progress::-moz-progress-bar{background:#7955d5;border-radius:8px}#progress{font-size:13px;color:#675574;line-height:1.7;margin:9px 0 0;white-space:pre-wrap}
      #refresh-progress{width:100%;margin-top:12px;min-height:42px;font-size:13px;font-weight:600;background:#fff}#refresh-note{margin:8px 0 0}
      .status-row{display:flex;align-items:center;gap:8px;margin-bottom:7px}.status-badge{font-size:12px;font-weight:650;background:#efedf3;color:#665972;padding:3px 9px;border-radius:20px}.panel[data-state="running"] .status-badge{color:#12674b;background:#e6f5ed}.panel[data-state="starting"] .status-badge{background:#f2ebff;color:#6742b3}#status{font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;max-height:70px;overflow:auto;margin:0 0 13px;color:#55485f}
      .practice-tip{padding:0 0 12px}.practice-tip p{font-size:13px;color:#6b5d77;margin:0;line-height:1.7}.text-button{border:0;background:transparent;color:#6844bb;padding:5px 0;min-height:36px;justify-content:flex-start;text-align:left;font-size:13px}.text-button:hover{background:transparent;color:#452398;text-decoration:underline}
      details{border-top:1px solid #e9e3f0;margin:0;background:#fff}summary{display:flex;align-items:center;gap:8px;list-style:none;min-height:46px;padding:11px 0;color:#574762;font-size:13px;font-weight:650;user-select:none}summary::-webkit-details-marker{display:none}summary .chevron{margin-left:auto;display:flex;align-items:center;color:#80708e}summary .chevron svg{width:16px;height:16px}details[open]>summary .chevron{transform:rotate(180deg)}.details-body{padding:0 0 15px}.field{display:block;margin-bottom:15px}.field-name{display:block;font-size:13px;color:#62526e;font-weight:600;margin-bottom:6px}
      select{width:100%;min-height:42px;padding:9px 11px;border:1px solid #dcd4e6;border-radius:10px;background:#fff;color:#483957;font-size:14px}select:disabled{color:#8e8298;background:#f7f5fa}input[type="number"]{width:94px;min-height:40px;padding:7px 9px;border:1px solid #dcd4e6;border-radius:10px;color:#483957;background:#fff}.delay-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.delay-row .field-name{margin:0}.delay-control{display:flex;align-items:center;gap:7px;font-size:12px;color:#73627f}.hint{font-size:12px;line-height:1.75;color:#756380;margin:9px 0 13px}.hint:empty{display:none}
      .actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}.actions button{font-size:13px;min-height:43px;padding:9px 8px}.bank{background:#f0eaff;border-color:#e2d5fb;color:#5f3daf;font-weight:650}.danger{color:#9d493f!important;background:#fff8f6!important;grid-column:1/-1}.quality-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.quality-grid strong{display:block;font-size:24px;color:#563e79}.quality-grid span{font-size:12px;color:#75637f}#log-count{font-size:12px;font-weight:400;color:#85728f;margin-left:auto}
      pre{font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;border-radius:10px;background:#f8f6fb;color:#695777;max-height:200px;overflow:auto;margin:0 0 12px}
      .control-bar,.bank-control-bar{flex-shrink:0;padding:12px 18px;border-top:1px solid #e9e3f0;background:#fff}.primary{width:100%;min-height:46px;color:#fff;border:0;background:#7050cf;font-size:15px;font-weight:650;box-shadow:0 4px 12px #7050cf20}.primary:hover{background:#5d3aba}.control-hint{display:block;text-align:center;font-size:11px;color:#766382;margin-top:7px}
      .bank-overview{padding:12px;background:#edf7f1;border-radius:15px;color:#28684c}.bank-overview>span{font-size:13px;font-weight:600}.bank-overview>strong{display:block;font-size:30px;line-height:1.2}.bank-overview small{font-size:14px;font-weight:400}.bank-overview p{font-size:13px;color:#4e7663;margin:0}.notice-box{padding:13px;border-radius:12px;background:#f6f1ff;color:#665075;margin:12px 0;font-size:13px;line-height:1.7}.notice-box p{margin:5px 0 9px}.notice-box strong{color:#503568}.notice-box.success{background:#edf8f0}.notice-box.success strong{color:#206444}#view-bank>.hint{margin:8px 0}.review-entry{border-top:1px solid #e9e3f0;margin-top:10px;padding-top:10px}.review-entry h2{font-size:16px;font-weight:700;margin:0 0 7px;color:#3f2e50}.review-entry>p{font-size:13px;color:#72617e;margin:0 0 8px;line-height:1.8}.subtle{width:100%;background:#f3eeff;color:#633eaf;border-color:#ddcff6;font-weight:600}.review-entry details{margin-top:12px}.check-field{display:block;font-size:13px;color:#5f4b70}.check-field input{accent-color:#7050cf;vertical-align:middle;width:16px;height:16px}.check-field small{display:block;font-size:12px;line-height:1.7;color:#756380;margin-top:6px}
      .help-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.help-heading small{font-size:12px;color:#80708d}.help-heading h2{font-size:19px;margin:4px 0;color:#432f56}.help-heading button{font-size:13px}.help-body{font-size:14px;line-height:1.85;color:#665472;padding:0 0 15px}.help-body ol{margin:0;padding-left:21px}.help-body li{margin:8px 0}.help-body p{margin:10px 0}.help-body details{border:1px solid #e7e0ee;padding:0 12px;border-radius:10px;margin:8px 0}.help-body summary{font-size:13px}.help-body details p{font-size:13px}#import-preview{margin:14px 0;padding:12px;border-radius:12px;background:#f6f1ff}
      #orb{--orb-progress:0%;width:64px;height:64px;min-height:64px;border:3px solid #e0d4fb;border-radius:50%;padding:0;background:#7050cf;color:white;box-shadow:0 6px 24px #58409038;cursor:grab;touch-action:none;user-select:none}#orb:hover{background:#5f3db9}.orb-inner{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:2px;pointer-events:none}.orb-inner svg{width:22px;height:22px}#orb-percent{font-size:10px;font-weight:650}.orb-dot{display:none}
      @media(max-width:400px){.panel-header{padding:12px;gap:6px}.brand-mark{display:none}.identity h1{font-size:14px}.identity small{font-size:11px}.usage-warning{padding:10px 14px}main{padding:15px}.tabs{padding:9px 14px}.control-bar{padding:11px 14px}}
      @media(max-height:600px){.panel-header{padding:10px 12px}.identity small{display:none}.usage-warning{padding:8px 14px;font-size:11px}.usage-warning p{display:none}.tabs{padding:6px 14px}.control-hint{display:none}main{padding:12px 14px}}
      @media(prefers-reduced-motion:reduce){*{transition:none!important}}
    </style>
    <style>
      .bank-search{margin-bottom:12px}.bank-search>label{display:block;margin-bottom:6px;font-weight:650;color:#40334c}.bank-search>input{width:100%;box-sizing:border-box;border:1px solid #ddd0ea;border-radius:10px;padding:10px;font:inherit;color:inherit;background:#fff}.bank-search>input:focus-visible{outline:2px solid #7854ca;outline-offset:2px}.bank-search>.hint{margin:6px 0}.bank-search ul{list-style:none;padding:0;margin:0}.bank-search-card{border:1px solid #eee6f4;border-radius:12px;padding:10px 12px;margin:8px 0;overflow-wrap:anywhere}.bank-search-type{font-size:12px;color:#625077}.bank-search-card h3{font-size:14px;margin:3px 0 6px}.bank-search-card p{margin:5px 0 0;font-size:13px}.bank-search-verified{color:#246045}.bank-search-reference{color:#755421}#bank-search-more{margin-top:6px;width:100%}
    </style>
    <style>.bank-search .bank-search-options{list-style:disc;padding-left:20px;margin:0 0 6px;font-size:13px}</style>
    <section class="panel" id="assistant-panel" role="region" aria-label="知到智慧树掌握度满分助手 v1.10.0">
      <header class="panel-header" id="drag-handle" title="拖动标题栏移动面板">
        <div class="brand-mark">${bookIcon}</div><div class="identity"><h1>知到智慧树掌握度满分助手</h1><small>自动练习，逐步积累题库 <span class="version">v1.10.0</span></small></div>
        <button id="help-toggle" type="button" aria-label="使用帮助" aria-controls="view-help" aria-expanded="false" title="使用帮助">?</button>
        <button id="fold" type="button" aria-label="收起为悬浮球" title="收起为悬浮球">${svg('<path d="M6 12h12"/>')}</button>
      </header>
      <aside class="usage-warning" role="note"><strong>警告：</strong>本脚本仅适用于智慧树掌握度练习 用于有答题次数限制的练习后果自负<p>脚本不会自动识别课程是否限制答题次数，请在启动前自行确认。</p></aside>
      <nav class="tabs" role="tablist" aria-label="助手功能"><button id="tab-practice" role="tab" aria-selected="true" aria-controls="view-practice">开始练习</button><button id="tab-bank" role="tab" aria-selected="false" aria-controls="view-bank" tabindex="-1">我的题库</button></nav>
      <main>
        <section id="view-practice" role="tabpanel" aria-labelledby="tab-practice">
        <div class="course-strip">${bookIcon}<p id="course-label"></p></div>
        <select id="activity" aria-label="运行模式" hidden><option value="practice">满分练习</option><option value="bank">题库完善</option></select>
        <p id="practice-next" class="intro">自动完成尚未满分的知识点。</p>
        <div class="progress-card"><div class="progress-heading"><span id="progress-title">本课程满分进度</span><span id="progress-percent">待检查</span></div><div id="progress-empty"><strong>准备开始</strong></div><div class="progress-metric" id="progress-numbers" hidden><strong id="completed-count">—</strong><span>/ <span id="total-count">—</span> 个知识点</span></div><progress id="progress-bar" aria-label="本课程满分进度" max="1" value="0" hidden></progress><p id="progress"></p><button id="refresh-progress">刷新进度</button><p class="hint" id="refresh-note">刷新会返回并重新载入热力图，核实最新进度，不会答题。</p></div>
        <div class="status-row"><span class="status-badge" id="run-state">准备就绪</span></div><p id="status" role="status" aria-live="polite"></p>
        <div class="practice-tip"><p id="practice-bank-hint"></p></div>
        <details id="settings-details"><summary>练习设置<span class="chevron">${downIcon}</span></summary><div class="details-body">
        <label class="field"><span class="field-name">练习范围</span><select id="mode" aria-label="练习范围"><option value="all">全部知识点：仅跳过免考和100%</option><option value="current">当前知识点：本轮全对后停止</option></select></label>
        <label class="delay-row"><span class="field-name">操作间隔</span><span class="delay-control"><input id="delay" aria-label="操作间隔" type="number" min="0" max="10000" step="50"><span>毫秒</span></span></label>
        <p class="hint">操作间隔为选项切换、悬浮弹窗和页面更新提供响应时间，如流畅运行可尝试更低值</p>

        </div></details>
        <details id="log-details"><summary>${svg('<path d="M5 5h14M5 12h14M5 19h8"/>')}运行记录<span id="log-count">暂无记录</span><span class="chevron">${downIcon}</span></summary><pre id="log"></pre></details>
        </section>
        <section id="view-bank" role="tabpanel" aria-labelledby="tab-bank" hidden>
          <label class="field"><span class="field-name">当前查看的题库</span><select id="export-course" aria-label="导入 / 导出课程"></select></label>
          <section class="bank-search" aria-label="搜题">
            <label for="bank-search">搜题</label>
            <input id="bank-search" type="search" maxlength="500" placeholder="输入题干或选项关键词" autocomplete="off" aria-describedby="bank-search-help">
            <p class="hint" id="bank-search-help">方便的搜索功能：让已导入或练习得到的题库发挥更大作用（见面课习题等可能会使用此处原题 在网上找答案前不妨在这里试试）</p>
            <p class="hint" id="bank-search-status" role="status"></p>
            <ul id="bank-search-results"></ul>
            <button type="button" id="bank-search-more" hidden>查看更多题目</button>
          </section>
          <div class="bank-overview"><span>已验证，可导出</span><strong><span id="bank-count">0</span><small> 题</small></strong><p id="bank-quality"></p></div>
          <p class="hint" id="import-summary"></p>
          <div class="actions"><button class="bank" id="import-bank">导入题库</button><button id="export-bank">导出已验证题库</button></div>
          <input id="import-file" type="file" accept=".txt,.json,text/plain,application/json" hidden>
          <p class="hint">推荐 TXT 格式，也支持本脚本的 JSON 记录。</p>
          <div class="notice-box success" id="import-success" hidden><strong>题库已准备好</strong><p id="import-success-text"></p><button id="use-imported">返回练习页</button></div>
          <p class="hint" id="bank-status" role="status" aria-live="polite"></p>
          <div id="import-preview" hidden><pre id="import-preview-text"></pre><div class="actions"><button class="bank" id="import-confirm">确认导入</button><button id="import-cancel">取消预览</button><button id="import-report">导出无法识别清单</button></div></div>
          <section class="review-entry"><h2 id="review-title">重新练习，补充题库</h2><p>已满分的也会重做，用于检查答案、收集新题。全部检查一遍后停止。</p><p class="hint" id="review-course-hint" hidden></p>
          <div class="notice-box" id="review-progress" hidden><strong id="review-state">已暂停</strong><p id="review-progress-count"></p><progress id="review-progress-bar" aria-label="本轮题库补充进度" max="1" value="0"></progress></div>
          <details id="review-stats" hidden><summary>本轮收集结果<span class="chevron">${downIcon}</span></summary><div class="details-body"><div class="quality-grid"><div><strong id="review-added">0</strong><span>新收录</span></div><div><strong id="review-verified">0</strong><span>再次验证正确</span></div><div><strong id="review-corrected">0</strong><span>已纠正</span></div><div><strong id="review-unresolved">0</strong><span>尚未答对</span></div></div><p class="hint" id="review-note"></p></div></details><button class="text-button" id="new-review" hidden>放弃本轮进度，重新开始</button>
          <div class="notice-box" id="review-reset" hidden><strong>重新检查全部知识点？</strong><p>本轮进度和未处理答卷会重置，已存题库与答题记录保留。检查完一遍后自动停止。</p><div class="actions"><button id="review-reset-confirm">确认并开始</button><button id="review-reset-cancel">取消</button></div></div>
          <details><summary>补充题库的高级设置<span class="chevron">${downIcon}</span></summary><div class="details-body"><label class="check-field" id="cold-setting"><input id="ignore-answers" type="checkbox">从头猜题，忽略已有答案<small>用于测试猜题能力，原题库会保留。仅在开始新一轮时生效；正常补充题库无需勾选。</small></label></div></details></section>
          <details><summary>题库匹配设置<span class="chevron">${downIcon}</span></summary><div class="details-body"><label class="field"><span class="field-name">题库匹配方式</span><select id="import-match" aria-label="题库匹配方式"><option value="loose">宽松匹配（默认）：相似题干与选项</option><option value="strict">严格匹配：题干与全部选项一致</option></select></label></div></details>
          <details><summary>题库操作记录<span class="chevron">${downIcon}</span></summary><pre id="bank-log"></pre></details>
          <button class="text-button" id="help-sharing">如何制作和分享题库？</button>
          <details id="export-details"><summary>备份与数据管理<span class="chevron">${downIcon}</span></summary><div class="details-body"><p class="hint" id="bank-issues"></p><div class="actions"><button id="export">备份答题记录 JSON</button><button id="export-excluded">查看未导出原因</button><button id="import-clear">清除导入题库</button><button class="danger" id="clear">清除所选课程记录</button></div>
          <div id="import-clear-preview" hidden><p class="hint" id="import-clear-text"></p><div class="actions"><button class="danger" id="import-clear-confirm">确认清除导入库</button><button id="import-clear-cancel">取消清除</button></div></div>
          <p class="hint">JSON 导入也通过“导入题库”选择文件。本区所有导入、导出与清理操作，都针对上方所选课程。</p></div></details>
        </section>
        <section id="view-help" role="region" aria-label="使用帮助" hidden>
          <div class="help-heading"><div><small>使用指南</small><h2>从练习到分享题库</h2></div><button id="help-back" aria-label="返回原页面">返回</button></div>
          <p class="notice-box" id="help-context"></p>
          <details open><summary>01　第一次使用<span class="chevron">${downIcon}</span></summary><div class="help-body"><ol><li>进入课程的掌握度热力图，确认答题次数不限。</li><li>在“开始练习”页点击底部的“开始练习”。不需要先准备题库，脚本会自动跳过免考和满分项。</li><li>需要时点击“暂停练习”。手动作答后，可点“刷新进度”：脚本会返回并重新载入热力图，逐一核实最新百分比，只更新进度，不会答题。收起成悬浮球仍会运行，拖动标题栏或球可以移动。</li></ol><p>“练习设置”中可调整操作间隔，默认 100 毫秒。如出现选择未生效或页面响应不及时，可以调高间隔。</p></div></details>
          <details><summary>02　使用别人的题库<span class="chevron">${downIcon}</span></summary><div class="help-body"><ol><li>暂停运行，在“我的题库”中选择对应课程。</li><li>点击“导入题库”，选择 TXT 文件，核对课程和题目预览后点击“确认导入”。</li><li>导入成功后点击“返回练习页”，再点击“开始练习”或“继续练习”。已做对的答案优先，导入答案其次，没有可用答案时继续猜题。</li></ol><p>默认宽松匹配：题型一致、题干相似度至少 80%，选项模糊对应至少 85%，且对应唯一。严格匹配要求题干与全部选项内容一致。选项字母和顺序不影响匹配，可在“我的题库 → 题库匹配设置”中切换。</p><p>TXT 兼容本脚本导出的格式，也支持本脚本 JSON 记录。无法识别的条目可导出原因清单；重复导入会合并去重。</p></div></details>
          <details id="help-make"><summary>03　制作与分享题库<span class="chevron">${downIcon}</span></summary><div class="help-body"><ol><li>打开课程热力图，在“我的题库”中找到“重新练习，补充题库”。可以先导入别人分享的题库。</li><li>点击“开始补充题库”。已满分的也会重做，每个知识点全对后继续，全部检查一遍后停止。</li><li>在“我的题库”中查看本轮进度、暂停或继续，并展开“本轮收集结果”查看新收录和纠正的题目。本轮完成后，可在“我的题库”中点击“再检查一轮”。</li><li>在“我的题库”中选择本课程，点击“导出已验证题库”。只有网站判对、内容完整且无冲突的题目才会导出。</li><li>分享 TXT 文件，并注明课程名称、学校或授课教师、导出日期和题目数量。不必分享运行记录。</li></ol><p>分享前检查内容和图片链接是否适合公开，并确认你有权分享。题库仅保存在本机，脚本不会替你上传。</p><p>若自己整理 TXT，可照下面格式写。多选答案用分号分隔，判断题用 true / false：</p><pre>1.【单选题】哪种图形有三条边？
A.圆形
B.三角形
三角形

2.【多选题】哪些数是偶数？
A.2
B.3
C.4
2;4

3.【判断题】三角形有三条边。
true</pre></div></details>
          <details id="help-faq"><summary>04　常见问题<span class="chevron">${downIcon}</span></summary><div class="help-body">
            <details><summary>为什么已经满分还会练习？</summary><p>“补充题库”会重做满分知识点，用于检查答案、收集新题。普通练习只跳过确认 100% 的项；绿色也可能只有 80% 或 90%。</p></details>
            <details><summary>一轮结束，题库就完整了吗？</summary><p>不一定。网站可能随机抽题，一轮只覆盖本次实际出现的题目。可以开始新一轮继续收集，不会无限自动循环。</p></details>
            <details><summary>错误题库会反复选错吗？</summary><p>不会持续沿用同一已判错组合。脚本根据网站批改撤销错误确认，排除错误候选并继续猜题。完全相同题目跨知识点的旧记录也会修正。宽松匹配仍可能增加试错次数。</p></details>
            <details><summary>本轮收集结果里的数字是什么意思？</summary><p><strong>新收录：</strong>之前没有记住这道题的正确答案，这一轮做对了，已存入题库。</p><p><strong>再次验证正确：</strong>题库里原来就有正确答案，这一轮再次作答，网站仍然判对。</p><p><strong>已纠正：</strong>原来保存或导入的答案被判错，脚本重新尝试后找到了正确答案。</p><p><strong>尚未答对：</strong>这一轮已经遇到，但还没有做对的题目。</p><p>这些数字只统计本轮，同一道题反复作答不会重复计数。如果一道新题的导入答案有误，修正后会同时计入“新收录”和“已纠正”。</p></details>
            <details><summary>刷新、更新或清除会影响数据吗？</summary><p>题库和完善轮次保存在当前浏览器的脚本存储中，刷新不清空。运行时同一标签页刷新可续跑，暂停后需手动继续。更新原脚本条目的代码保留数据；删除脚本或扩展数据可能丢失记录，请先导出。面板日志仅保留本页面最近 150 条，显示最近 12 条。</p></details>
            <details><summary>导出为什么比导入少？</summary><p><strong>导入：</strong>把文件里的答案存进来，供脚本答题时尝试。这时还不知道答案是否正确。</p><p><strong>导出：</strong>只分享已经在网站上做对、题目和选项记录完整，而且没有答案冲突的题目。</p><p>例如，导入了 100 道题，这次遇到并做对了 60 道，另外 40 道还没遇到。那么，这批导入题中只有前 60 道可以导出；原来题库中符合条件的其他题目也会一起导出。</p><p>还没遇到的题，可以在“我的题库”中点击“开始补充题库”，继续练习、验证。网站可能随机出题，一轮不一定能遇到所有题。</p><p>已经做过却未导出的题，到“我的题库 → 备份与数据管理 → 查看未导出原因”查看原因，例如答案尚未确认、选项缺失或答案冲突。</p></details>
            <details><summary>“忽略已有答案”会删掉题库吗？</summary><p>不会。它让新一轮从猜题开始，忽略运行前已有确认、排除记录和导入候选，只学习本轮反馈；新结果仍保存。正常完善题库建议不勾选。本轮开始后固定此设置，下一轮才可更改。</p></details>
            <details><summary>脚本卡住或出现异常弹窗怎么办？</summary><p>先暂停，手动处理网站提示并检查是否有其他自动答题脚本干扰。可以调高操作间隔再继续。持续失败时保存版本、页面类型和最后提示；公开截图前遮住个人信息。</p></details>
          </div></details>
        </section>
      </main>
      <footer class="control-bar"><button class="primary" id="start">开始练习</button><small class="control-hint">仅在确认答题次数不限后使用</small></footer>
      <footer class="bank-control-bar" id="bank-controls" hidden><button class="primary" id="begin-review">开始补充题库</button><small class="control-hint">已满分的也会重做，一轮完成后自动停止</small><small class="control-hint">不建议重刷次数过多 不确定是否会触发网站警告</small></footer>
    </section>
    <button id="orb" type="button" aria-label="展开掌握度满分助手" aria-controls="assistant-panel" aria-expanded="false" title="点击展开，拖动移动。仅用于不限次数的掌握度练习。" hidden><span class="orb-inner">${bookIcon}<span id="orb-percent">掌握度</span></span><span class="orb-dot"></span></button>`;
    uiStatus = $('#status', ui); uiLog = $('#log', ui); uiStart = $('#start', ui);
    uiMode = $('#mode', ui); uiDelay = $('#delay', ui); uiProgress = $('#progress', ui); uiProgressBar = $('#progress-bar', ui);
    uiExportCourse = $('#export-course', ui); uiCourseLabel = $('#course-label', ui);
    uiPanel = $('#assistant-panel', ui); uiOrb = $('#orb', ui);
    uiMode.value = settings.mode; uiDelay.value = settings.delay;
    $('#activity', ui).value = settings.activity;
    $('#ignore-answers', ui).checked = settings.ignoreAnswers;
    $('#import-match', ui).value = settings.importMatch;
    setupFloatingUI();
    $('#tab-practice', ui).onclick = () => showTab('practice');
    $('#tab-bank', ui).onclick = () => showTab('bank');
    $('#help-toggle', ui).onclick = () => showTab(currentTab === 'help' ? previousTab : 'help');
    $('#help-back', ui).onclick = () => { showTab(previousTab); $('#help-toggle', ui).focus(); };
    $('#help-sharing', ui).onclick = () => { showTab('help'); $('#help-make', ui).open = true; $('#help-make', ui).scrollIntoView({ block: 'start' }); };
    ui.addEventListener('keydown', event => {
      if (event.key === 'Escape' && currentTab === 'help') { showTab(previousTab); $('#help-toggle', ui).focus(); }
      if (event.target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const name = event.key === 'Home' ? 'practice' : event.key === 'End' ? 'bank' : event.target.id === 'tab-practice' ? 'bank' : 'practice';
        showTab(name); $('#tab-' + name, ui).focus();
      }
    });
    $('#activity', ui).onchange = () => selectActivity($('#activity', ui).value);
    $('#refresh-progress', ui).onclick = () => refreshMasteryProgress();
    $('#begin-review', ui).onclick = beginReview;
    $('#use-imported', ui).onclick = () => {
      showTab('practice');
    };
    $('#ignore-answers', ui).onchange = () => { settings.ignoreAnswers = $('#ignore-answers', ui).checked; GM_setValue(SETTINGS, settings); };
    $('#new-review', ui).onclick = () => {
      if (running || starting || busy || importBusy || uiExportCourse.value !== courseId()) return;
      resetReviewRequested = courseId(); $('#review-reset', ui).hidden = false;
      $('#review-reset', ui).scrollIntoView({ block: 'nearest' });
    };
    $('#review-reset-cancel', ui).onclick = () => { resetReviewRequested = false; $('#review-reset', ui).hidden = true; };
    $('#review-reset-confirm', ui).onclick = resetReview;
    uiStart.onclick = beginPractice;
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
    $('#import-match', ui).onchange = () => {
      settings.importMatch = $('#import-match', ui).value;
      candidateCache.clear(); GM_setValue(SETTINGS, settings);
    };
    uiExportCourse.onchange = () => {
      bankSearchLimit = 8;
      stagedImport = null; $('#import-preview', ui).hidden = true;
      importClearCourse = ''; $('#import-clear-preview', ui).hidden = true;
      refreshImportSummary(); render();
    };
    $('#bank-search', ui).oninput = () => { bankSearchLimit = 8; refreshImportSummary(); };
    $('#bank-search-more', ui).onclick = () => { bankSearchLimit += 8; refreshImportSummary(); };
    $('#import-bank', ui).onclick = () => {
      if (running || starting || busy || importBusy) { logBank('请先暂停后导入题库'); return; }
      $('#import-file', ui).value = ''; $('#import-file', ui).click();
    };
    $('#import-file', ui).onchange = event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) previewBankFile(file);
    };
    $('#import-confirm', ui).onclick = () => changeImportedBank();
    $('#import-clear', ui).onclick = () => {
      if (running || starting || busy || importBusy) { logBank('请先暂停后清除导入题库'); return; }
      const id = uiExportCourse.value || courseId();
      if (!id) { logBank('请先选择课程'); return; }
      importClearCourse = id;
      const course = GM_getValue(COURSES, {})[id] || { id, name: '' };
      $('#import-clear-text', ui).textContent = `确认清除“${course.name || id}”的导入候选？已确认答案和尝试记录保留，其他课程不受影响。`;
      $('#import-clear-preview', ui).hidden = false; render();
    };
    $('#import-clear-confirm', ui).onclick = () => changeImportedBank(true);
    $('#import-clear-cancel', ui).onclick = () => { importClearCourse = ''; $('#import-clear-preview', ui).hidden = true; render(); };
    $('#import-cancel', ui).onclick = () => { stagedImport = null; $('#import-preview', ui).hidden = true; render(); };
    $('#import-report', ui).onclick = () => {
      if (!stagedImport?.parsed.excluded.length) return;
      const text = stagedImport.parsed.excluded.map(item => `${item.number}. ${item.title}\n原因：${item.reason}`).join('\n\n');
      download('题库导入无法识别清单.txt', '\uFEFF' + text, 'text/plain;charset=utf-8');
    };
    $('#export', ui).onclick = () => {
      try {
        const source = exportSource(), at = new Date().toISOString();
        download(courseFileName('智慧树练习记录', source.course, at) + '.json', JSON.stringify({ version: 1, course: source.course, exportedAt: at,
          records: source.records, logs: courseLogs[source.course.id] || [], logScope: 'current_tab_page_session_for_selected_course' }, null, 2));
      } catch (error) { logBank(error.message); }
    };
    $('#export-bank', ui).onclick = () => {
      try {
        const source = exportSource();
        const bank = formatTextBank(questionBankFromRecords(source.records.questions));
        if (!bank.exported) { logBank('尚无可导出的确认答案，未解题继续保存在运行记录中'); return; }
        download(courseFileName('智慧树纯文字题库', source.course, new Date().toISOString()) + '.txt', '\uFEFF' + bank.text, 'text/plain;charset=utf-8');
        logBank(`[${source.course.name || source.course.id}] 已入库并导出 ${bank.exported} 题；另有未确认答案 ${bank.unconfirmed} 题、数据异常 ${bank.incomplete} 题未写入题库，答案冲突 ${bank.conflicts} 组。可点击“导出未入库清单”查看`, source.course.id);
      } catch (error) { logBank(error.message); }
    };
    $('#export-excluded', ui).onclick = () => {
      try {
        const source = exportSource();
        const bank = formatTextBank(questionBankFromRecords(source.records.questions));
        if (!bank.excluded.length) { logBank(`[${source.course.name || source.course.id}] 已收集题目均可入库，没有未入库题目`, source.course.id); return; }
        download(courseFileName('智慧树未入库题目', source.course, new Date().toISOString()) + '.txt', '\uFEFF' + formatExcludedBankReport(bank), 'text/plain;charset=utf-8');
        logBank(`[${source.course.name || source.course.id}] 已导出未入库清单 ${bank.excluded.length} 项，包含题干、选项、知识点和未入库原因`, source.course.id);
      } catch (error) { logBank(error.message); }
    };
    $('#clear', ui).onclick = clearSelectedCourse;
    refreshProgress(); render();
  }
  discoverCourses();
  setupUI();
  GM_registerMenuCommand('开始 / 继续掌握度练习', beginPractice);
  GM_registerMenuCommand('刷新掌握度进度（暂停后）', () => refreshMasteryProgress());
  GM_registerMenuCommand('暂停掌握度练习', () => stop());
  setInterval(step, 350);
  setInterval(refreshProgress, 1000);
  addEventListener('pagehide', () => { if (releaseLock) releaseLock(); });
  try {
    const refreshRequest = JSON.parse(sessionStorage.getItem(PROGRESS_REFRESH) || 'null');
    sessionStorage.removeItem(PROGRESS_REFRESH);
    if (refreshRequest?.course === courseId() && Date.now() - refreshRequest.at < 300000) {
      sessionStorage.removeItem(SESSION);
      refreshMasteryProgress(false);
      return;
    }
    const previous = JSON.parse(sessionStorage.getItem(SESSION) || 'null');
    if (previous?.course === courseId()) {
      if (['practice', 'bank'].includes(previous.activity)) settings.activity = previous.activity;
      if (['all', 'current'].includes(previous.mode)) settings.mode = previous.mode;
      $('#activity', ui).value = settings.activity; uiMode.value = settings.mode;
      refreshProgress(); render(); start(true);
    }
  } catch { sessionStorage.removeItem(SESSION); }
})();
