/**
 * read-aloud 回归测试（五项修复）。
 *
 * 修复 1（流式游标）：Turn 生成中只返回最新 step 的文本，文本被整体替换时
 *   游标必须归零，否则新 step 开头被整段跳过。
 * 修复 2（重启不重读）：开关状态持久化在 localStorage，已读记录也必须持久化。
 * 修复 3（空首帧）：页面刚打开时 snapshot 为空，此时不能把会话标记为「已 arm」，
 *   否则随后到达的历史会被当作新消息朗读。
 * 修复 4（步骤切换丢尾）：当前 step 未读完的残留会在文本被替换时永久丢失。
 * 修复 5（无标点步骤）：整段没有句末标点时游标始终为 0，修复 4 的条件会漏掉。
 *
 * 全部从 client.js 抽取真实实现运行，localStorage 用内存替身。
 */

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 测试与 client.js 同属插件目录，用相对位置定位，仓库可整体移动。 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
const source = fs.readFileSync(SRC, 'utf8');

/** 从源码抽取 `const NAME = ...` 的函数源码（配对花括号）。 */
function extract(src, name) {
  const marker = `const ${name} = `;
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`client.js 中找不到 ${name}`);
  const start = at + marker.length;
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/** 抽取 function 声明形式（loadReadHistory / saveReadHistory 等）。 */
function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`client.js 中找不到 function ${name}`);
  const braceStart = src.indexOf('{', at);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

/** 内存 localStorage。 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

const CLOSURE = [
  'orderedTurns', 'turnContent', 'turnReply', 'armSession', 'ensureArmed',
  'streamCursorFor', 'takeSpeakable', 'handleAuto', 'markRead', 'setAuto', 'drainAuto',
];

const FUNCS = [
  'loadReadHistory', 'saveReadHistory', 'loadAutoMap', 'saveAutoMap',
  /* The real markdown→speech conversion: the tests used to stub it out as
     (s) => s, which hid every defect that lives in the conversion itself
     (a table was silently dropped, so its content was never read). */
  'tablesToSpeech', 'toSpeechText',
];

/**
 * 建沙箱。storage 可传入以模拟「重启后重新加载」（同一份 localStorage）。
 */
function buildSandbox(storage = makeStorage(), prefsMode = 'final') {
  const pushed = [];
  /* Lets a test stand in for player.speak: return false to mean "could not start". */
  const hook = { readItem: null };
  const ctx = {
    pushed,
    hook,
    AUTO_SEP: '\u0001',
    window: { localStorage: storage },
    autoStore: {
      getSnapshot: () => ({ map: ctx.readAuto }),
      set: (next) => { ctx.readAuto = next.map },
    },
    readAuto: {},
    autoEnabled: () => ctx.readAuto,
    stopAuto: () => {},
    player: { store: { getSnapshot: () => ({ playing: false, messageId: null }) } },
    isAutoId: (id) => typeof id === 'string' && id.includes('\u0001'),
    prefs: { getSnapshot: () => ({ mode: ctx.mode || prefsMode, voice: '', rate: 1 }) },
    enqueueAuto: (id, text) => pushed.push({ id, text }),
    /* toSpeechText now comes from client.js (see FUNCS) so the tests exercise
       the real markdown→speech conversion. */
  };
  vm.createContext(ctx);
  const fnSrc = FUNCS.map((n) => extractFunction(source, n)).join('\n');
  const body = `${fnSrc}
const READ_KEY = 'dsh-read-aloud:read';
const AUTO_KEY = 'dsh-read-aloud:auto';
const READ_HISTORY_LIMIT = 40;
const readTurns = new Set();
const readHistory = loadReadHistory();
for (const [sessionId, ids] of readHistory) { for (const id of ids) readTurns.add(sessionId + '|' + id); }
const armedSessions = new Set();
const streamCursors = new Map();
const turnModes = new Map();
/* Real queue + a readItem the tests drive through hook.readItem, so drainAuto's
   skip-on-failure behaviour can be exercised without a browser. */
const autoQueue = [];
const readItem = (id, text) => (
  typeof hook.readItem === 'function' ? hook.readItem(id, text) : false
);
${CLOSURE.map((n) => `const ${n} = ${extract(source, n)};`).join('\n')}
({ ${CLOSURE.join(',')}, readTurns, readHistory, armedSessions, autoQueue,
   loadReadHistory, saveReadHistory, tablesToSpeech, toSpeechText });`;
  const api = vm.runInContext(body, ctx);
  return { ctx, api, pushed, storage };
}

// --- snapshot 构造 ---------------------------------------------------------

function closedTurn(id, text) {
  const data = new Map();
  data.set('turn-tail', {
    closing: { blocks: [{ kind: 'text', text }], finalNode: { messageId: 'm' + id } },
  });
  return { data, steps: [] };
}

function openTurn(id, text) {
  const stepData = new Map();
  stepData.set('assistant-step', { blocks: [{ kind: 'text', text }], status: 'running' });
  return { data: new Map(), steps: [{ data: stepData }] };
}

function snapshotOf(turns) {
  const entries = turns.map((t, i) => [i + 1, t]);
  return { timeline: { turns: { entries: () => entries[Symbol.iterator]() } } };
}

const EMPTY_SNAP = { timeline: { turns: { entries: () => [][Symbol.iterator]() } } };
const SID = 'session-A';

const cases = [];
const check = (name, fn) => cases.push({ name, fn });

// ===========================================================================
// 空首帧（修复 3）
// ===========================================================================
for (const mode of ['final', 'stream']) {
  for (const [label, first] of [['null', null], ['空 timeline', EMPTY_SNAP]]) {
    check(`空首帧(${label}) -> 历史到达 [${mode}]`, () => {
      const { ctx, api, pushed } = buildSandbox(makeStorage(), mode);
      ctx.readAuto[SID] = true;
      api.handleAuto(SID, first);
      api.handleAuto(SID, snapshotOf([closedTurn(1, '上次已回复的内容。')]));
      assert.strictEqual(pushed.length, 0, `朗读了历史: ${JSON.stringify(pushed)}`);
    });
  }
}

check('多帧空 snapshot 后历史才到达', () => {
  const { ctx, api, pushed } = buildSandbox();
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, null);
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([closedTurn(1, '上次已回复的内容。')]));
  assert.strictEqual(pushed.length, 0, `朗读了历史: ${JSON.stringify(pushed)}`);
});

// ===========================================================================
// 重启后不重读（修复 2）
// ===========================================================================
check('重启后：已读记录从 localStorage 恢复，不重读', () => {
  const storage = makeStorage();
  {
    const { ctx, api } = buildSandbox(storage);
    ctx.readAuto[SID] = true;
    api.handleAuto(SID, snapshotOf([closedTurn(1, '第一条回复。')]));
    api.handleAuto(SID, snapshotOf([closedTurn(1, '第一条回复。'), closedTurn(2, '第二条回复。')]));
    assert.ok(api.readTurns.has(SID + '|2'), '第二条应已标记为已读');
  }
  {
    const { ctx, api, pushed } = buildSandbox(storage);
    ctx.readAuto[SID] = true;
    api.handleAuto(SID, snapshotOf([closedTurn(1, '第一条回复。'), closedTurn(2, '第二条回复。')]));
    assert.strictEqual(pushed.length, 0, `重启后重读了: ${JSON.stringify(pushed)}`);
  }
});

check('重启后：新回复仍能正常朗读', () => {
  const storage = makeStorage();
  {
    const { ctx, api } = buildSandbox(storage);
    ctx.readAuto[SID] = true;
    api.handleAuto(SID, snapshotOf([closedTurn(1, '旧回复。')]));
  }
  {
    const { ctx, api, pushed } = buildSandbox(storage);
    ctx.readAuto[SID] = true;
    api.handleAuto(SID, snapshotOf([closedTurn(1, '旧回复。')]));
    assert.strictEqual(pushed.length, 0, '旧回复不应重读');
    api.handleAuto(SID, snapshotOf([closedTurn(1, '旧回复。'), closedTurn(2, '重启后的新回复。')]));
    assert.strictEqual(pushed.length, 1, '新回复没有被朗读');
    assert.ok(pushed[0].text.includes('重启后的新回复'), `内容不对: ${pushed[0].text}`);
  }
});

check('重启后：历史含多条也不重读', () => {
  const storage = makeStorage();
  {
    const { ctx, api } = buildSandbox(storage);
    ctx.readAuto[SID] = true;
    api.handleAuto(SID, snapshotOf([closedTurn(1, '一。')]));
    api.handleAuto(SID, snapshotOf([closedTurn(1, '一。'), closedTurn(2, '二。')]));
    api.handleAuto(SID, snapshotOf([closedTurn(1, '一。'), closedTurn(2, '二。'), closedTurn(3, '三。')]));
  }
  {
    const { ctx, api, pushed } = buildSandbox(storage);
    ctx.readAuto[SID] = true;
    api.handleAuto(SID, EMPTY_SNAP);
    api.handleAuto(SID, snapshotOf([closedTurn(1, '一。'), closedTurn(2, '二。'), closedTurn(3, '三。')]));
    assert.strictEqual(pushed.length, 0, `重读了: ${JSON.stringify(pushed)}`);
  }
});

// ===========================================================================
// 正在生成的 Turn 仍要朗读
// ===========================================================================
check('首帧即含正在生成的 Turn [stream]', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, snapshotOf([closedTurn(1, '旧回复。'), openTurn(2, '正在生成的新回复。')]));
  assert.strictEqual(pushed.length, 1, '正在生成的 Turn 被跳过了');
  assert.ok(pushed[0].text.includes('正在生成的新回复'), `内容不对: ${pushed[0].text}`);
});

check('空首帧后才开始生成的新 Turn 要朗读', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([openTurn(1, '新会话的第一条回复。')]));
  assert.strictEqual(pushed.length, 1, '新 Turn 没有朗读');
  assert.ok(pushed[0].text.includes('新会话的第一条回复'), `内容不对: ${pushed[0].text}`);
});

// ===========================================================================
// 流式游标（修复 1）
// ===========================================================================
check('takeSpeakable 只读完整句子', () => {
  const { api } = buildSandbox();
  const r = api.takeSpeakable('已经完整的句子。还没写完的半句', 0, false);
  assert.strictEqual(r.speak, '已经完整的句子。');
  assert.strictEqual(r.next, 8);
});

check('无标点不朗读', () => {
  const { api } = buildSandbox();
  const r = api.takeSpeakable('没有标点的内容', 0, false);
  assert.strictEqual(r.speak, '');
  assert.strictEqual(r.next, 0);
});

check('streamCursorFor 同源延续 / 换源归零', () => {
  const { api } = buildSandbox();
  assert.strictEqual(
    api.streamCursorFor({ cursor: 8, text: '已经完整的句子。' }, '已经完整的句子。后面又多了字。'), 8);
  assert.strictEqual(
    api.streamCursorFor({ cursor: 13, text: '第一段说明文字已经读完了。' }, '第二段新的内容在这里。'), 0);
  assert.strictEqual(api.streamCursorFor(undefined, '任意内容。'), 0);
});

check('多步骤回复每段都读到', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([openTurn(1, '第一段说明文字已经读完了。')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '第二段新的内容在这里。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.ok(heard.includes('第一段说明文字已经读完了。'), `漏读第一段: ${heard}`);
  assert.ok(heard.includes('第二段新的内容在这里。'), `漏读第二段: ${heard}`);
});

check('同步骤增量不重复朗读', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([openTurn(1, '第一步已经写到这里。')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '第一步已经写到这里。继续')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '第一步已经写到这里。继续并结束。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.strictEqual(heard.split('第一步已经写到这里。').length - 1, 1, `重复朗读: ${heard}`);
  assert.ok(heard.includes('继续并结束。'), `增量未读到: ${heard}`);
});

// ===========================================================================
// 修复 4：步骤切换时未读完的尾部被丢弃
// ===========================================================================
check('步骤切换：上一步未完成的尾部要补读', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  // 上一步只读完了第一个句子，句号后的短句没有句末标点，因此尚未朗读
  api.handleAuto(SID, snapshotOf([openTurn(1, '只读了前半句。后半句没有句号')]));
  // 步骤切换：文本被整体替换，尾部若不补读就永远丢失
  api.handleAuto(SID, snapshotOf([openTurn(1, '新步骤的完整内容。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.ok(heard.includes('只读了前半句。'), `漏读前半句: ${heard}`);
  assert.ok(heard.includes('后半句没有句号'), `尾部被丢弃（本次缺陷）: ${heard}`);
  assert.ok(heard.includes('新步骤的完整内容。'), `漏读新步骤: ${heard}`);
});

check('步骤切换：补读的尾部只读一次', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([openTurn(1, '前半句。未完成的尾巴')]));
  // 同一个新步骤文本连续到达多帧
  api.handleAuto(SID, snapshotOf([openTurn(1, '新步骤内容。')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '新步骤内容。')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '新步骤内容。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.strictEqual(heard.split('未完成的尾巴').length - 1, 1, `尾部重复朗读: ${heard}`);
});

check('步骤切换：新步骤文本更长时同样补读尾部', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([openTurn(1, '第一句。尾巴甲')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '第二步骤的主要部分显然比之前那一段长得多。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.ok(heard.includes('尾巴甲'), `尾部被丢弃: ${heard}`);
  assert.ok(heard.includes('第二步骤的主要部分'), `漏读新步骤: ${heard}`);
});

check('Turn 结束：尾部随整段一并朗读，不重复', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([openTurn(1, '一句话。结尾没有标点的部分')]));
  // 同一个 Turn 收尾，closing 给出完整最终文本
  api.handleAuto(SID, snapshotOf([closedTurn(1, '一句话。结尾没有标点的部分')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.strictEqual(heard.split('结尾没有标点的部分').length - 1, 1, `尾部重复: ${heard}`);
});

// ===========================================================================
// 修复 5：步骤文本从未出现句末标点时，游标始终为 0，整段被丢弃
// ===========================================================================
check('步骤切换：上一步完全没有句末标点时整段要补读', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  // 该步骤文本不含任何句末标点，takeSpeakable 从不放行，游标一直是 0
  api.handleAuto(SID, snapshotOf([openTurn(1, '_msg.txt 被误提交了，移除并修正提交规则：')]));
  // 步骤切换，文本整体替换；游标 0 让「上一次游标 > 0」的补读条件失效
  api.handleAuto(SID, snapshotOf([openTurn(1, '移除并修正提交规则后，命令成功执行。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.ok(heard.includes('被误提交了'), `整段被丢弃（本次缺陷）: ${heard}`);
  assert.ok(heard.includes('移除并修正提交规则后'), `漏读新步骤: ${heard}`);
});

check('步骤切换：无标点片段补读只读一次', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([openTurn(1, '没有句号的片段')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '新步骤内容。')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '新步骤内容。')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '新步骤内容。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.strictEqual(heard.split('没有句号的片段').length - 1, 1, `片段重复朗读: ${heard}`);
});

check('同一步骤无标点时文本增长，不应提前补读', () => {
  const { ctx, api, pushed } = buildSandbox(makeStorage(), 'stream');
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  // 同一步骤递增，前缀一致，不应触发补读
  api.handleAuto(SID, snapshotOf([openTurn(1, '正在写')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '正在写一句话')]));
  api.handleAuto(SID, snapshotOf([openTurn(1, '正在写一句话。')]));
  const heard = pushed.map((p) => p.text).join('');
  assert.strictEqual(heard, '正在写一句话。', `增量重复或提前补读: ${JSON.stringify(heard)}`);
});

// ===========================================================================
// 修复 6：队列中无法开始播放的条目不应阻断后续条目
// ===========================================================================
check('队列首条无法开始播放时，后续条目仍要朗读', () => {
  const { ctx, api } = buildSandbox();
  ctx.readAuto[SID] = true;
  const started = [];
  /* speak() 返回 false：文本清洗后为空，或没有可用引擎。 */
  ctx.hook.readItem = (id, text) => {
    if (text === '空内容') return false;
    started.push(text);
    return true;
  };
  api.autoQueue.push({ id: SID + '\u0001' + '1', text: '空内容' });
  api.autoQueue.push({ id: SID + '\u0001' + '1', text: '后面的内容要朗读。' });
  api.drainAuto();
  assert.deepStrictEqual(started, ['后面的内容要朗读。'],
    `无法播放的条目阻断了队列：${JSON.stringify(started)}`);
});

check('队列全部无法播放时 drainAuto 逐条尝试并清空', () => {
  const { ctx, api } = buildSandbox();
  ctx.readAuto[SID] = true;
  let calls = 0;
  ctx.hook.readItem = () => { calls += 1; return false; };
  api.autoQueue.push({ id: SID + '\u0001' + '1', text: 'a' });
  api.autoQueue.push({ id: SID + '\u0001' + '2', text: 'b' });
  api.drainAuto();
  assert.strictEqual(calls, 2, '应逐条尝试而非停在第一条');
  assert.strictEqual(api.autoQueue.length, 0, '队列应被清空');
});

check('播放中时 drainAuto 不出队', () => {
  const { ctx, api } = buildSandbox();
  ctx.readAuto[SID] = true;
  ctx.hook.readItem = () => true;
  ctx.player.store.getSnapshot = () => ({ playing: true, messageId: 'x' });
  api.autoQueue.push({ id: SID + '\u0001' + '1', text: '待播' });
  api.drainAuto();
  assert.strictEqual(api.autoQueue.length, 1, '播放中不应出队');
});

check('队列中属于已关闭会话的条目被跳过', () => {
  const { ctx, api } = buildSandbox();
  ctx.readAuto[SID] = true;
  const started = [];
  ctx.hook.readItem = (id, text) => { started.push(text); return true; };
  api.autoQueue.push({ id: 'other-session\u0001' + '1', text: '别的会话' });
  api.autoQueue.push({ id: SID + '\u0001' + '1', text: '本会话' });
  api.drainAuto();
  assert.deepStrictEqual(started, ['本会话'], `关闭会话的条目未被跳过：${JSON.stringify(started)}`);
});

// ===========================================================================
// 修复 7：表格内容被整段丢弃
// ===========================================================================
check('toSpeechText 保留表格单元格内容', () => {
  const { api } = buildSandbox();
  const md = ['结果如下：', '', '| 版本 | 状态 |', '|---|---|', '| 1.5.4 | 基线 |', '| 1.5.9 | 已修复 |', '', '表格后的话。'].join('\n');
  const speech = api.toSpeechText(md);
  for (const cell of ['版本', '状态', '1.5.4', '基线', '1.5.9', '已修复', '表格后的话']) {
    assert.ok(speech.includes(cell), `表格内容丢失「${cell}」: ${JSON.stringify(speech)}`);
  }
  /* 分隔行只有横线与冒号，不该被念出来。 */
  assert.ok(!speech.includes('---'), `分隔行被朗读: ${JSON.stringify(speech)}`);
});

check('回复以表格结尾时表格仍被朗读', () => {
  const { api, pushed, ctx } = buildSandbox();
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  const reply = ['修复情况：', '', '| 项 | 内容 |', '|---|---|', '| 队列 | 单句失败不再终止整段 |'].join('\n');
  api.handleAuto(SID, snapshotOf([openTurn(1, reply)]));
  api.handleAuto(SID, snapshotOf([closedTurn(1, reply)]));
  const heard = pushed.map((p) => p.text).join('');
  assert.ok(heard.includes('单句失败不再终止整段'),
    `以表格结尾的内容未朗读: ${JSON.stringify(heard)}`);
});

check('表格中的拉丁词不被丢弃', () => {
  const { api } = buildSandbox();
  const md = ['| 依赖 | 版本 |', '|---|---|', '| nacos-client | 2.5.5 |'].join('\n');
  const speech = api.toSpeechText(md);
  for (const cell of ['依赖', 'nacos-client', '2.5.5']) {
    assert.ok(speech.includes(cell), `丢失「${cell}」: ${JSON.stringify(speech)}`);
  }
});

// ===========================================================================
// 修复 8：回复最后一句不朗读
// ===========================================================================
check('回复最后一句（含拉丁缩写）被朗读', () => {
  const { api, pushed, ctx } = buildSandbox();
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  /* 先出现一个正在生成的 Turn，使它不被 ensureArmed 当作历史。 */
  const last = '需要我帮你把 nacos-client 升到 2.5.5，并先跑一遍依赖冲突检查吗？';
  api.handleAuto(SID, snapshotOf([openTurn(1, '先看依赖关系。\n\n' + last)]));
  api.handleAuto(SID, snapshotOf([closedTurn(1, '先看依赖关系。\n\n' + last)]));
  const heard = pushed.map((p) => p.text).join('');
  assert.ok(heard.includes('依赖冲突检查吗'), `最后一句未朗读: ${JSON.stringify(heard)}`);
});

check('回复以表格结尾且表格含最后一句', () => {
  const { api, pushed, ctx } = buildSandbox();
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  const reply = ['检查完毕。', '', '| 结论 |', '|---|', '| 可以升级 |'].join('\n');
  api.handleAuto(SID, snapshotOf([openTurn(1, reply)]));
  api.handleAuto(SID, snapshotOf([closedTurn(1, reply)]));
  const heard = pushed.map((p) => p.text).join('');
  assert.ok(heard.includes('可以升级'), `表格结尾的最后一句未朗读: ${JSON.stringify(heard)}`);
});

// ===========================================================================
// 其他边界
// ===========================================================================
check('开关关闭时完全不动', () => {
  const { api, pushed } = buildSandbox();
  api.handleAuto(SID, snapshotOf([closedTurn(1, '任意内容。')]));
  assert.strictEqual(pushed.length, 0);
});

check('sessionId 为 undefined 时安全返回', () => {
  const { api, pushed } = buildSandbox();
  api.handleAuto(undefined, snapshotOf([closedTurn(1, '任意内容。')]));
  assert.strictEqual(pushed.length, 0);
});

check('用户点开开关：屏幕历史不朗读', () => {
  const { ctx, api, pushed } = buildSandbox();
  const snap = snapshotOf([closedTurn(1, '屏幕上已有的回复。')]);
  api.setAuto(SID, true, snap);
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, snap);
  assert.strictEqual(pushed.length, 0, '点开开关后读了历史');
});

check('开关在空快照上点开，历史随后到达也不重读', () => {
  const { ctx, api, pushed } = buildSandbox();
  api.setAuto(SID, true, EMPTY_SNAP);
  ctx.readAuto[SID] = true;
  api.handleAuto(SID, EMPTY_SNAP);
  api.handleAuto(SID, snapshotOf([closedTurn(1, '屏幕上已有的回复。')]));
  assert.strictEqual(pushed.length, 0, `重读了历史: ${JSON.stringify(pushed)}`);
});

check('已读持久化数据结构可被重新加载', () => {
  const storage = makeStorage();
  const { api } = buildSandbox(storage);
  api.markRead(SID, 7);
  const reloaded = api.loadReadHistory();
  assert.ok(reloaded.get(SID)?.has(7), `持久化失败: ${JSON.stringify(storage._dump())}`);
});

check('持久化条数受限，不会无限增长', () => {
  const storage = makeStorage();
  const { api } = buildSandbox(storage);
  for (let i = 1; i <= 100; i += 1) api.markRead(SID, i);
  const reloaded = api.loadReadHistory();
  assert.ok(reloaded.get(SID).size <= 40, `体积未受限: ${reloaded.get(SID).size}`);
  assert.ok(reloaded.get(SID).has(100), '最新记录应保留');
});

// --- 运行 ------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exitCode = 1;
