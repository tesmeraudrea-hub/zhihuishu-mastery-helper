// ==UserScript==
// @name         知到智慧树掌握度满分助手
// @author       Watson
// @namespace    local.zhihuishu.mastery.practice
// @version      1.7.0
// @description  仅用于智慧树掌握度练习：自动选择、提交并按批改重答至全对，仅跳过免考和100%；可拖动面板与悬浮球，显示满分进度，按课程学习多选分布，支持TXT题库导入、宽松匹配与导出。
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
  if (typeof module === 'object' && module.exports) {
    module.exports = { normalize, same, combinations, questionKey, nextAnswer, remember, masteryURL, identifyPage, binomial, answerModel, rankedCombinations, masteryProgress, parseMasteryRate, snapshotQuestion, questionBankFromRecords, formatTextBank, formatExcludedBankReport, extractCourseName, courseFileName, recordsForCourse, parseTextBank, parseJSONBank, parseBankFile, mergeImported, importedCandidates, textSimilarity };
    return;
  }

  const PREFIX = 'zhs-mastery-practice-v1:';
  const SESSION = PREFIX + 'run';
  const SETTINGS = PREFIX + 'settings';
  const COURSES = PREFIX + 'courses';
  const UI_SETTINGS = PREFIX + 'ui';
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
  let settings = Object.assign({ mode: 'all', delay: 250, maxRounds: 4096, importMatch: 'loose' }, GM_getValue(SETTINGS, {}));
  if (!['loose', 'strict'].includes(settings.importMatch)) settings.importMatch = 'loose';
  delete settings.includeGreen;
  let db, dbCourse = '', running = false, starting = false, busy = false, generation = 0, releaseLock;
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
      if (JSON.stringify(db.course) !== JSON.stringify(course)) { db.course = course; save(); }
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
        option.textContent = `${course.name || '未识别课程'} [${course.id}]${course.id === id ? '（当前）' : ''}`;
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
    $('#import-summary', ui).textContent = `所选课程导入候选：${records?.imported?.length || 0} 题。导入答案经网站判对后才进入正式题库。`;
  }
  async function previewBankFile(file) {
    if (running || starting || busy || importBusy) { log('请先暂停，待当前操作结束后再导入题库'); return; }
    const id = uiExportCourse.value || courseId();
    if (!id) { log('请先打开课程，再选择导入目标'); return; }
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
      log(`题库预览已准备：可用 ${parsed.items.length} 题，请核对目标课程后确认导入`);
    } catch (error) { log(`读取题库失败：${error.message}`); }
    finally { importBusy = false; render(); }
  }
  async function changeImportedBank(clear = false) {
    if (running || starting || busy || importBusy) { log('请先暂停，待当前操作结束后再修改导入题库'); return; }
    const id = uiExportCourse.value || courseId();
    if (!id || (clear ? importClearCourse !== id : !stagedImport || stagedImport.id !== id)) { log('目标课程已改变，请重新预览或确认目标课程'); return; }
    const course = GM_getValue(COURSES, {})[id] || { id, name: '' };
    const incoming = clear ? [] : stagedImport.parsed.items;
    if (!navigator.locks) { log('浏览器不支持运行锁，请使用新版 Edge / Chrome'); return; }
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
        log(clear ? `[${course.name || id}] 导入候选题库已清除，已确认答案保留` : `[${course.name || id}] 已合并导入：新增 ${merged.added} 题、${merged.addedAnswers} 个候选答案，重复 ${merged.duplicates} 个，冲突 ${merged.conflicts} 组`, id);
      });
    } catch (error) { log(`题库修改失败：${error.message}`); }
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
  function currentModel() { return answerModel(db.questions); }
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
      uiProgress.textContent = progress ? `免考 ${progress.exempt} · 剩余 ${progress.remaining} · 尚待核实 ${progress.unchecked}${cards.length ? '' : '\n最近一次热力图核实结果'}` : '等待热力图核实掌握度';
      $('#completed-count', ui).textContent = progress ? progress.perfect : '—';
      $('#total-count', ui).textContent = progress ? progress.eligible : '—';
      $('#progress-percent', ui).textContent = progress ? `${progress.percent}%` : '—';
      $('#orb-percent', ui).textContent = progress ? `${progress.percent}%` : '掌握度';
      uiOrb.style.setProperty('--orb-progress', `${progress?.percent || 0}%`);
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
    const state = running ? 'running' : starting ? 'starting' : 'paused';
    const stateLabel = running ? '运行中' : starting ? '准备中' : '已暂停';
    uiPanel.dataset.state = uiOrb.dataset.state = state;
    $('#run-state', ui).textContent = stateLabel;
    uiStatus.textContent = `${status}${activeName ? '\n' + activeName : ''}`;
    uiStatus.title = uiStatus.textContent;
    uiOrb.setAttribute('aria-label', `展开掌握度满分助手，${stateLabel}`);
    uiStart.textContent = running || starting ? '暂停' : '开始 / 继续';
    uiStart.disabled = importBusy;
    uiMode.disabled = running || starting;
    for (const id of ['import-bank', 'import-clear', 'import-match']) $('#' + id, ui).disabled = running || starting || importBusy;
    $('#import-confirm', ui).disabled = running || starting || importBusy || !stagedImport?.parsed.items.length;
    $('#import-report', ui).disabled = importBusy || !stagedImport?.parsed.excluded.length;
    $('#import-clear-confirm', ui).disabled = running || starting || importBusy || !importClearCourse;
    uiLog.textContent = logs.slice(-12).join('\n');
    $('#log-count', ui).textContent = logs.length ? `${Math.min(logs.length, 12)} 条` : '暂无记录';
    uiLog.scrollTop = uiLog.scrollHeight;
  }
  function log(message, course = courseId()) {
    status = message;
    logs.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${message}`);
    if (logs.length > 150) logs.shift();
    const savedLogs = courseLogs[course] ||= [];
    savedLogs.push(logs.at(-1)); if (savedLogs.length > 150) savedLogs.shift();
    console.info('[知到智慧树掌握度满分助手]', message);
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
      const preferred = preferredFor(q);
      const choice = nextAnswer(record, q, model, preferred);
      return { q, key, choice, known: Boolean(record.correct?.length), imported: preferred.some(candidate => same(candidate, choice)) };
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
  function saveFloatingState() { GM_setValue(UI_SETTINGS, floatingState); }
  function placeFloatingUI(position) {
    const target = floatingState.collapsed ? uiOrb : uiPanel;
    const rect = target.getBoundingClientRect();
    const key = floatingState.collapsed ? 'orb' : 'panel';
    const point = position || floatingState[key] || { x: 18, y: innerHeight - rect.height - 18 };
    const margin = 12;
    const maxX = Math.max(0, innerWidth - rect.width - margin);
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
      :host{all:initial;display:block;font:13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#24253d}
      *{box-sizing:border-box} [hidden]{display:none!important}button,input,select{font:inherit}button,summary{cursor:pointer}svg{width:20px;height:20px;flex-shrink:0}
      button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #e5e5ef;border-radius:11px;background:#fff;color:#414258;min-height:38px;padding:8px 12px;transition:background .15s,box-shadow .15s,transform .15s}
      button:hover{background:#f3f1ff;border-color:#d4cffb}button:active{transform:translateY(1px)}button:disabled{opacity:.5;cursor:default}
      button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #b7abfa;outline-offset:3px}
      .panel{width:min(380px,calc(100vw - 24px));max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;border:1px solid #ffffffd9;border-radius:22px;background:#fcfcff;box-shadow:0 20px 65px #23234026,0 3px 12px #23234012;overflow:hidden}
      .panel-header{display:flex;align-items:center;gap:11px;padding:16px 18px;background:linear-gradient(120deg,#fff,#f3f0ff);border-bottom:1px solid #ece9f7;cursor:grab;touch-action:none;user-select:none}
      :host([data-dragging="true"]) .panel-header,:host([data-dragging="true"]) #orb{cursor:grabbing}
      .brand-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:13px;background:linear-gradient(145deg,#8874ff,#6050dc);color:#fff;box-shadow:0 4px 12px #6756dd30}
      .brand-mark svg{width:23px;height:23px}.identity{flex:1;min-width:0}.identity h1{font-size:14px;line-height:1.5;margin:0;font-weight:750;letter-spacing:-.2px}
      .identity small{display:flex;gap:8px;align-items:center;color:#8b89a0;font-size:10px;margin-top:2px}.version{color:#7466be}
      #fold{width:32px;min-height:32px;border-radius:10px;padding:0;border:0;background:#ffffffb3;color:#80779e}
      .usage-warning{margin:0;padding:11px 18px;background:#fff5f3;border-bottom:1px solid #f9e4df;color:#a94437;font-size:11px;line-height:1.65;flex-shrink:0}.usage-warning strong{font-weight:700}.usage-warning p{margin:4px 0 0;color:#ad6055}
      main{padding:17px 18px;overflow-y:auto;min-height:0;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#d5d1e8 transparent}
      .progress-card{border:1px solid #e7e3fa;background:linear-gradient(130deg,#f7f4ff,#fcfbff);border-radius:17px;padding:15px;margin-bottom:14px}
      .progress-heading{display:flex;justify-content:space-between;align-items:center;color:#686080;font-size:11px;font-weight:600;letter-spacing:.4px}
      #progress-percent{color:#6c53d9;background:#ece6ff;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700}
      .progress-metric{display:flex;align-items:baseline;gap:7px;margin:7px 0 8px}.progress-metric strong{font-size:36px;line-height:1.2;font-weight:750;letter-spacing:-1.5px;color:#413176}.progress-metric span{color:#736881;font-size:12px}
      progress{display:block;appearance:none;width:100%;height:7px;border:0;border-radius:10px;overflow:hidden;background:#e8e4f4;accent-color:#7963e8}
      progress::-webkit-progress-bar{background:#e8e4f4;border-radius:10px}progress::-webkit-progress-value{background:linear-gradient(90deg,#9480ff,#6c55d8);border-radius:10px;transition:width .3s}progress::-moz-progress-bar{background:#7963e8;border-radius:10px}
      #progress{white-space:pre-wrap;margin:9px 0 0;font-size:10px;line-height:1.6;color:#756b83}
      .status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.status-badge{display:inline-flex;align-items:center;gap:6px;color:#7d7b91;background:#f0eff5;border-radius:20px;padding:3px 9px;font-size:10px;font-weight:600}
      .status-badge:before{content:"";width:5px;height:5px;border-radius:50%;background:#a09bac}.panel[data-state="running"] .status-badge{color:#158563;background:#e8f8f1}.panel[data-state="running"] .status-badge:before{background:#24ac80}.panel[data-state="starting"] .status-badge{color:#7864cd;background:#eee9ff}
      .status-caption{font-size:10px;color:#aaa4b7}#status{margin:0 0 16px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.65;color:#777185;max-height:74px;overflow:auto}
      .field{display:block;margin-bottom:13px}.field-name{display:block;font-size:11px;font-weight:650;color:#5a546c;margin-bottom:6px}
      select{appearance:auto;width:100%;min-height:39px;padding:8px 10px;border:1px solid #e4e1ed;border-radius:10px;background:#fff;color:#514b65;font-size:12px}
      select:disabled{color:#9d95aa;background:#f7f5fa}input[type="number"]{width:98px;min-height:36px;padding:6px 9px;border:1px solid #e3dfed;border-radius:10px;background:#fff;color:#504667;font-size:13px}
      .delay-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.delay-row .field-name{margin:0}.delay-control{display:flex;align-items:center;gap:8px;font-size:11px;color:#9790a4}
      .hint{margin:7px 0 14px;color:#776f86;font-size:10px;line-height:1.65}
      .course-strip{display:flex;gap:8px;align-items:center;margin:0 0 14px;padding:10px 11px;border-radius:11px;background:#f1f1f8;color:#8d87a0;font-size:10px}.course-strip svg{width:15px;height:15px;color:#a69cbe}#course-label{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:#686176;font-size:11px}
      details{border:1px solid #e9e6f1;border-radius:12px;background:#fff;margin-top:9px;overflow:hidden}summary{display:flex;align-items:center;gap:8px;list-style:none;padding:11px 12px;color:#686176;font-size:11px;font-weight:600;user-select:none}summary::-webkit-details-marker{display:none}summary>svg:first-child{width:16px;height:16px;color:#a49bb8}summary .chevron{margin-left:auto;width:15px;height:15px;color:#aaa3b6;transition:transform .15s}details[open] summary .chevron{transform:rotate(180deg)}details[open] summary{border-bottom:1px solid #efecf5}
      .details-body{padding:12px}.details-body .field{margin-bottom:10px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.actions button{font-size:11px;min-height:36px;padding:7px 8px}.actions .bank{background:#f0ecff;border-color:#e4dcff;color:#7560cc}.actions .danger{grid-column:1/-1;color:#be7569;border-color:#f2e4e1;background:#fffafa;font-size:10px}
      #log-count{font-size:10px;font-weight:400;color:#b1aabb;margin-left:2px}pre{font:10px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;margin:0;padding:11px 12px;max-height:144px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#faf9fe;color:#8f849f;min-height:42px}
      .control-bar{padding:12px 18px 14px;border-top:1px solid #eae7f1;background:#fff;flex-shrink:0}.primary{width:100%;min-height:42px;border:0;background:linear-gradient(100deg,#8069f1,#6650d3);box-shadow:0 4px 12px #7963dd26;color:#fff;font-size:13px;font-weight:650}.primary:hover{background:linear-gradient(100deg,#735de6,#5d46c6);border:0}.primary:before{content:"";width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:7px solid currentColor;margin-right:3px}.panel[data-state="running"] .primary:before,.panel[data-state="starting"] .primary:before{width:7px;height:10px;border:0;border-left:2px solid currentColor;border-right:2px solid currentColor}
      .control-hint{display:block;text-align:center;margin-top:7px;font-size:9px;color:#b6afc1}
      #orb{--orb-progress:0%;width:64px;height:64px;min-height:64px;border:0;border-radius:50%;padding:4px;display:grid;place-items:center;background:conic-gradient(#ad9dff var(--orb-progress),#7660df var(--orb-progress));box-shadow:0 8px 26px #6650c946,0 0 0 1px #ffffffb3;cursor:grab;touch-action:none;user-select:none;position:relative;transition:box-shadow .15s,filter .15s}
      #orb:hover{box-shadow:0 10px 32px #6650c967;filter:brightness(1.05)}#orb:active{transform:none}.orb-inner{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;width:56px;height:56px;border-radius:50%;background:linear-gradient(150deg,#8a76f5,#6651d3);color:#fff;border:1px solid #ffffff55;pointer-events:none}.orb-inner svg{width:23px;height:23px}#orb-percent{font-size:9px;font-weight:650;line-height:1.2;color:#f2eeff}.orb-dot{position:absolute;right:0;bottom:1px;width:13px;height:13px;border:3px solid #fff;border-radius:50%;background:#b7afca;pointer-events:none}#orb[data-state="running"] .orb-dot{background:#29b887}#orb[data-state="starting"] .orb-dot{background:#f0b75c}
      @media(prefers-reduced-motion:reduce){*{transition:none!important}}@media(max-height:600px){.usage-warning{font-size:10px;padding:8px 14px}.panel-header{padding:12px 14px}main{padding:12px 14px}.control-bar{padding:10px 14px}.control-hint{display:none}}
    </style>
    <section class="panel" id="assistant-panel" role="region" aria-label="知到智慧树掌握度满分助手 v1.7.0">
      <header class="panel-header" id="drag-handle" title="拖动标题栏移动面板">
        <div class="brand-mark">${bookIcon}</div><div class="identity"><h1>知到智慧树掌握度满分助手</h1><small>掌握每一个知识点 <span class="version">v1.7.0</span></small></div>
        <button id="fold" type="button" aria-label="收起为悬浮球" title="收起为悬浮球">${svg('<path d="M6 12h12"/>')}</button>
      </header>
      <aside class="usage-warning" role="note"><strong>警告：</strong>本脚本仅适用于智慧树掌握度练习 用于有答题次数限制的练习后果自负<p>脚本不会自动识别课程是否限制答题次数，请在启动前自行确认。</p></aside>
      <main>
        <div class="progress-card"><div class="progress-heading"><span>已确认满分</span><span id="progress-percent">—</span></div><div class="progress-metric"><strong id="completed-count">—</strong><span>/ <span id="total-count">—</span> 个可练习知识点</span></div><progress id="progress-bar" aria-label="可练习知识点满分进度" max="1" value="0"></progress><p id="progress"></p></div>
        <div class="status-row"><span class="status-badge" id="run-state">已暂停</span><span class="status-caption">跟随页面实时反馈</span></div><p id="status" role="status" aria-live="polite"></p>
        <label class="field"><span class="field-name">练习范围</span><select id="mode" aria-label="练习范围"><option value="all">全部知识点：仅跳过免考和100%</option><option value="current">当前知识点：本轮全对后停止</option></select></label>
        <label class="delay-row"><span class="field-name">操作间隔</span><span class="delay-control"><input id="delay" aria-label="操作间隔" type="number" min="0" max="10000" step="50"><span>毫秒</span></span></label>
        <p class="hint">操作间隔为选项切换、悬浮弹窗和页面更新提供响应时间，如流畅运行可尝试更低值</p>
        <div class="course-strip">${bookIcon}<p id="course-label"></p></div>
        <details id="export-details"><summary>${svg('<path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/>')}题库与记录<span class="chevron">${downIcon}</span></summary><div class="details-body">
          <label class="field"><span class="field-name">导入 / 导出课程</span><select id="export-course" aria-label="导入 / 导出课程"></select></label>
          <label class="field"><span class="field-name">题库匹配方式</span><select id="import-match" aria-label="题库匹配方式"><option value="loose">宽松匹配（默认）：相似题干与选项</option><option value="strict">严格匹配：题干与全部选项一致</option></select></label>
          <p class="hint" id="import-summary"></p>
          <div class="actions"><button class="bank" id="import-bank">导入 TXT 题库</button><button id="import-clear">清除导入题库</button></div>
          <div id="import-clear-preview" hidden><p class="hint" id="import-clear-text"></p><div class="actions"><button class="danger" id="import-clear-confirm">确认清除导入库</button><button id="import-clear-cancel">取消清除</button></div></div>
          <input id="import-file" type="file" accept=".txt,.json,text/plain,application/json" hidden>
          <p class="hint">以 TXT 为主，也支持本脚本导出的 JSON。宽松模式题干相似度至少80%，选项模糊对应至少85%；无法唯一对应时跳过。请暂停后导入。</p>
          <div id="import-preview" hidden><pre id="import-preview-text"></pre><div class="actions"><button class="bank" id="import-confirm">确认导入</button><button id="import-cancel">取消预览</button><button id="import-report">导出无法识别清单</button></div></div>
          <div class="actions"><button class="bank" id="export-bank">导出纯文字题库</button><button id="export">导出记录</button><button id="export-excluded">导出未入库清单</button><button class="danger" id="clear">清除当前课程记录</button></div>
        </div></details>
        <details id="log-details"><summary>${svg('<path d="M5 5h14M5 12h14M5 19h8"/>')}运行记录<span id="log-count">暂无记录</span><span class="chevron">${downIcon}</span></summary><pre id="log"></pre></details>
      </main>
      <footer class="control-bar"><button class="primary" id="start">开始 / 继续</button><small class="control-hint">拖动标题栏移动 · 收起后继续运行</small></footer>
    </section>
    <button id="orb" type="button" aria-label="展开掌握度满分助手" aria-controls="assistant-panel" aria-expanded="false" title="点击展开，拖动移动。仅用于不限次数的掌握度练习。" hidden><span class="orb-inner">${bookIcon}<span id="orb-percent">掌握度</span></span><span class="orb-dot"></span></button>`;
    uiStatus = $('#status', ui); uiLog = $('#log', ui); uiStart = $('#start', ui);
    uiMode = $('#mode', ui); uiDelay = $('#delay', ui); uiProgress = $('#progress', ui); uiProgressBar = $('#progress-bar', ui);
    uiExportCourse = $('#export-course', ui); uiCourseLabel = $('#course-label', ui);
    uiPanel = $('#assistant-panel', ui); uiOrb = $('#orb', ui);
    uiMode.value = settings.mode; uiDelay.value = settings.delay;
    $('#import-match', ui).value = settings.importMatch;
    setupFloatingUI();
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
    $('#import-match', ui).onchange = () => {
      settings.importMatch = $('#import-match', ui).value;
      candidateCache.clear(); GM_setValue(SETTINGS, settings);
    };
    uiExportCourse.onchange = () => {
      stagedImport = null; $('#import-preview', ui).hidden = true;
      importClearCourse = ''; $('#import-clear-preview', ui).hidden = true;
      refreshImportSummary(); render();
    };
    $('#import-bank', ui).onclick = () => {
      if (running || starting || busy || importBusy) { log('请先暂停后导入题库'); return; }
      $('#import-file', ui).value = ''; $('#import-file', ui).click();
    };
    $('#import-file', ui).onchange = event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) previewBankFile(file);
    };
    $('#import-confirm', ui).onclick = () => changeImportedBank();
    $('#import-clear', ui).onclick = () => {
      if (running || starting || busy || importBusy) { log('请先暂停后清除导入题库'); return; }
      const id = uiExportCourse.value || courseId();
      if (!id) { log('请先选择课程'); return; }
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
      if (running || starting || busy || importBusy) { log('请先暂停后清除记录'); return; }
      if (!courseId() || !confirm(`清除当前页面课程 ${GM_getValue(COURSES, {})[courseId()]?.name || courseId()} 的本地答案和尝试记录？网站成绩不会被修改，其他课程记录保留。`)) return;
      dbCourse = courseId(); db = { version: 1, questions: {}, rounds: {}, pending: null };
      // 清除所有课程记录也删除导入库；避免 save() 的跨页面合并重新带回旧导入项。
      db.imported = []; db.importRevision = (Number(GM_getValue(PREFIX + dbCourse, null)?.importRevision) || 0) + 1;
      GM_setValue(PREFIX + dbCourse, db); candidateCache.clear();
      stagedImport = null; $('#import-preview', ui).hidden = true;
      importClearCourse = ''; $('#import-clear-preview', ui).hidden = true;
      loadMasteryChecks(dbCourse); checks = { version: 1, entries: {} }; saveMasteryChecks(); refreshImportSummary(); log('本课程本地记录与导入题库已清除');
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
