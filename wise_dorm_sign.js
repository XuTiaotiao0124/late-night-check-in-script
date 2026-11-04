#!/usr/bin/env node
// 华天 wise 晚寝签到（青龙 / Node 版）—— 部署步骤、参数说明、常见问题见 README_晚寝签到部署.md

'use strict';

const https = require('https');

// ============================================================================
// 配置区（要改就改这里；设了同名环境变量会覆盖这里的值）
// ============================================================================
const SETTINGS = {
  SIGN_URL: '',                    // 签到链接
  LAT: 88.888888888888888,         // 纬度
  LNG: 88.888888888888888,         // 经度
  JITTER: 3,                       // 坐标抖动半径（米）
  DRY_RUN: false,                  // 演练模式
  FORCE: false,                    // 强制提交
  RETRY: 3,                        // 失败重试次数
  RETRY_WAIT: 30,                  // 重试间隔（秒）
  EARLY_WAIT: 120,                 // 早到等待（秒）
  QYWX_KEY: '',                    // 企业微信通知
  NOTIFY: true,                    // 推送开关
  NOTIFY_SKIP: false,              // 跳过也推送
  NOTIFY_ALREADY: false,           // 已签到也推送
};
// 账号走环境变量：WQQD_ACCOUNT1 / WQQD_PASSWORD1（多账号接着写 2、3……）
// ============================================================================

// ---- 配置读取：环境变量优先，其次配置区 ----

const env = (name, fallback = '') => String(process.env[name] === undefined ? fallback : process.env[name]).trim();

function pick(...names) {
  for (const name of names) {
    if (!name) continue;
    const value = env(name);
    if (value) return value;
  }
  return '';
}

function cfg(names, localValue) {
  const fromEnv = pick(...names);
  if (fromEnv) return fromEnv;
  if (localValue === undefined || localValue === null) return '';
  return String(localValue);
}

function cfgBool(names, localValue) {
  const fromEnv = pick(...names);
  if (fromEnv) return fromEnv === '1';
  return Boolean(localValue);
}

function cfgNum(names, localValue, fallback, min = 0) {
  const raw = pick(...names) || String(localValue === undefined ? '' : localValue);
  const num = Number(raw);
  if (!Number.isFinite(num) || num < min) return fallback;
  return num;
}

const MAX_ACCOUNTS = 20; // 最多 20 个编号账号

function parseSignUrl(link) {
  if (!link) return null;
  try {
    const u = new URL(link);
    const taskId = u.searchParams.get('taskId') || '';
    if (!taskId) return null;
    return { base: u.origin, taskId };
  } catch (e) {
    return null;
  }
}

// 旧写法 WISE_ACCOUNTS：条目「学号:密码」，& / ; / 换行分隔，可跟 @纬度,经度
function parseAccounts(raw) {
  if (!raw) return [];
  const list = String(raw)
    .split(/[&;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      let body = item;
      let coord = null;
      const at = item.lastIndexOf('@');
      if (at > 0) {
        const tail = item.slice(at + 1);
        if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(tail)) {
          const parts = tail.split(',').map((x) => Number(x.trim()));
          coord = { lat: parts[0], lng: parts[1] };
          body = item.slice(0, at);
        }
      }
      const idx = body.indexOf(':');
      const id = idx < 0 ? body.trim() : body.slice(0, idx).trim();
      const password = idx < 0 ? '' : body.slice(idx + 1).trim();
      return coord ? { id, password, lat: coord.lat, lng: coord.lng } : { id, password };
    })
    .filter((a) => a.id && a.password);

  const seen = new Set();
  return list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

// 编号式账号 WQQD_ACCOUNT1..N / WQQD_PASSWORD1..N（可选 WQQD_LAT1、WQQD_LNG1）
function parseNumberedAccounts() {
  const accounts = [];
  const incomplete = [];
  for (let i = 1; i <= MAX_ACCOUNTS; i += 1) {
    const id = env(`WQQD_ACCOUNT${i}`);
    const password = env(`WQQD_PASSWORD${i}`);
    if (!id && !password) continue;
    if (!id || !password) {
      incomplete.push(i);
      continue;
    }
    const latRaw = env(`WQQD_LAT${i}`);
    const lngRaw = env(`WQQD_LNG${i}`);
    const entry = { id, password };
    if (latRaw && lngRaw && Number.isFinite(Number(latRaw)) && Number.isFinite(Number(lngRaw))) {
      entry.lat = Number(latRaw);
      entry.lng = Number(lngRaw);
    }
    accounts.push(entry);
  }
  return { accounts, incomplete };
}

const SIGN_URL = cfg(['WQQD_SIGN_URL', 'WISE_SIGN_URL'], SETTINGS.SIGN_URL);
const PARSED_URL = parseSignUrl(SIGN_URL);

const DEFAULT_LAT = cfgNum(['WQQD_LAT', 'WISE_LAT'], SETTINGS.LAT, 88.888888888888888);
const DEFAULT_LNG = cfgNum(['WQQD_LNG', 'WISE_LNG'], SETTINGS.LNG, 88.888888888888888);

const NUMBERED = parseNumberedAccounts();
const SINGLE_ACCOUNT = { id: env('WISE_ACCOUNT'), password: env('WISE_PASSWORD') };
const MULTI_ACCOUNTS = parseAccounts(env('WISE_ACCOUNTS'));

// 合并所有来源的账号（编号式 → 旧单账号 → 旧多账号），同一学号只保留第一次
const RAW_ACCOUNTS = (() => {
  const list = [];
  for (const a of NUMBERED.accounts) list.push(a);
  if (SINGLE_ACCOUNT.id && SINGLE_ACCOUNT.password) list.push(SINGLE_ACCOUNT);
  for (const a of MULTI_ACCOUNTS) list.push(a);
  const seen = new Set();
  return list.filter((a) => a.id && a.password && !seen.has(a.id) && (seen.add(a.id), true));
})();

const CONFIG = {
  accounts: RAW_ACCOUNTS.map((a) => ({
    id: a.id,
    password: a.password,
    lat: Number.isFinite(a.lat) ? a.lat : DEFAULT_LAT,
    lng: Number.isFinite(a.lng) ? a.lng : DEFAULT_LNG,
  })),

  // 站点地址与任务 id 都来自签到链接
  taskId: PARSED_URL ? PARSED_URL.taskId : '',
  base: PARSED_URL ? PARSED_URL.base.replace(/\/+$/, '') : '',
  jitter: cfgNum(['WQQD_JITTER', 'WISE_JITTER'], SETTINGS.JITTER, 3),

  dryRun: cfgBool(['WQQD_DRY_RUN', 'WISE_DRY_RUN'], SETTINGS.DRY_RUN),
  force: cfgBool(['WQQD_FORCE', 'WISE_FORCE'], SETTINGS.FORCE),
  retry: Math.max(1, cfgNum(['WQQD_RETRY', 'WISE_RETRY'], SETTINGS.RETRY, 3, 1)),
  retryWait: Math.max(1, cfgNum(['WQQD_RETRY_WAIT', 'WISE_RETRY_WAIT'], SETTINGS.RETRY_WAIT, 30, 1)),
  earlyWait: cfgNum(['WQQD_EARLY_WAIT', 'WISE_EARLY_WAIT'], SETTINGS.EARLY_WAIT, 120, 0),
  nowOverride: pick('WQQD_NOW', 'WISE_NOW') !== '',

  qywxKey: cfg(['WQQD_QYWX_KEY', 'WISE_QYWX_KEY', 'WQQD_QYWXKEY'], SETTINGS.QYWX_KEY),
  notify: cfgBool(['WQQD_NOTIFY', 'WISE_NOTIFY'], SETTINGS.NOTIFY),
  notifySkip: cfgBool(['WQQD_NOTIFY_SKIP', 'WISE_NOTIFY_SKIP'], SETTINGS.NOTIFY_SKIP),
  notifyAlready: cfgBool(['WQQD_NOTIFY_ALREADY', 'WISE_NOTIFY_ALREADY'], SETTINGS.NOTIFY_ALREADY),
  notifyTest: cfgBool(['WQQD_NOTIFY_TEST', 'WISE_NOTIFY_TEST'], false),
};

const CLIENT_ID = 'flysource_wise_app'; // OAuth 客户端 id（官方前端公开常量，非个人数据）
const CLIENT_SECRET = pick('WQQD_CLIENT_SECRET', 'WISE_CLIENT_SECRET') || 'DA788asdUDjnasd_flysource_dsdadDAIUiuwqe'; // OAuth 客户端密钥
const TENANT_ID = '000000'; // 租户 id

const UA = // User-Agent（服务端要求必须带）
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PATH = { // 接口路径
  token: '/api/flySource-auth/oauth/token',
  task: '/api/flySource-yxgl/dormSignTask/getTaskByIdForApp',
  record: '/api/flySource-yxgl/dormSignRecord/getOne',
  sign: '/api/flySource-yxgl/dormSignRecord/stuSign',
};

const SIGNED_STATUS = [0, 1, 2, 4, 5, 6]; // 视为「今天已签到」的 signStatus
const TIMEOUT_MS = 20000; // 请求超时（毫秒）

// ---- 通用工具 ----

const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex'); // md5
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64'); // base64
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // 等待
const p2 = (n) => String(n).padStart(2, '0'); // 补零

function toSec(hms) {
  const parts = String(hms || '00:00:00').split(':').map((x) => Number(x) || 0);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

function nowParts() {
  const override = pick('WQQD_NOW', 'WISE_NOW');
  const now = override ? Number(override) * 1000 : Date.now();
  const d = new Date(now + 8 * 3600 * 1000);
  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
    weekday: WEEK[d.getUTCDay()],
  };
}

function jitterCoords(lat, lng, meters) {
  if (!meters || meters <= 0) return { lat, lng };
  const r = meters * Math.sqrt(Math.random());
  const th = Math.random() * 2 * Math.PI;
  const dLat = (r * Math.cos(th)) / 111320;
  const dLng = (r * Math.sin(th)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: +(lat + dLat).toFixed(6), lng: +(lng + dLng).toFixed(6) };
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return +(2 * R * Math.asin(Math.sqrt(a))).toFixed(1);
}

// ---- HTTP 请求 ----

function makeSign(pathOnly, token) {
  const ts = Date.now();
  return md5(pathOnly + '?sign=' + md5(String(ts) + token)) + '1.' + b64(String(ts));
}

function buildHeaders(pathOnly, token, hasBody) {
  const headers = {
    Authorization: 'Basic ' + b64(CLIENT_ID + ':' + CLIENT_SECRET),
    'Tenant-Id': TENANT_ID,
    Accept: 'application/json',
    'User-Agent': UA,
  };
  if (hasBody) headers['Content-Type'] = 'application/json;charset=UTF-8';
  if (token) {
    headers['FlySource-Auth'] = 'bearer ' + token;
    headers['FlySource-sign'] = makeSign(pathOnly, token);
  }
  return headers;
}

function request(pathWithQuery, { method = 'GET', token, body } = {}) {
  const url = new URL(CONFIG.base + pathWithQuery);
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = buildHeaders(url.pathname, token, payload !== null);
  if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            return reject(new Error(`非 JSON 响应 [HTTP ${res.statusCode}] ${raw.slice(0, 200)}`));
          }
          if (json.code === 401) {
            return reject(new Error('鉴权失败/登录过期：' + (json.msg || raw.slice(0, 200))));
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function postJson(urlString, obj) {
  const url = new URL(urlString);
  const payload = JSON.stringify(obj);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': UA,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`推送返回非 JSON [HTTP ${res.statusCode}] ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('推送超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---- 企业微信推送 ----

function buildQywxUrl(key) {
  if (/^https?:\/\//i.test(key)) return key;
  return 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + encodeURIComponent(key);
}

async function sendQywx(title, lines) {
  if (!CONFIG.notify) {
    console.log('推送已关闭（WQQD_NOTIFY=0）');
    return false;
  }
  if (!CONFIG.qywxKey) {
    console.log('未配置 WQQD_QYWX_KEY，跳过推送');
    return false;
  }

  const content = [`### ${title}`, '', ...lines.map((l) => `> ${l}`)].join('\n').slice(0, 3800); // 企业微信正文上限 4096 字节

  if (CONFIG.notifyTest) {
    console.log('WQQD_NOTIFY_TEST=1，以下为将要推送的内容（未实际发送）：\n' + content);
    return true;
  }

  try {
    const r = await postJson(buildQywxUrl(CONFIG.qywxKey), {
      msgtype: 'markdown',
      markdown: { content },
    });
    if (r && r.errcode === 0) {
      console.log('企业微信推送成功');
      return true;
    }
    console.error('企业微信推送失败：' + JSON.stringify(r).slice(0, 200));
    return false;
  } catch (e) {
    console.error('企业微信推送异常：' + (e && e.message ? e.message : e));
    return false;
  }
}

// ---- 业务逻辑 ----

async function login(account) {
  const q = new URLSearchParams({
    tenantId: TENANT_ID,
    username: account.id,
    password: md5(account.password),
    type: 'account',
    grant_type: 'password',
    scope: 'all',
  });
  const r = await request(PATH.token + '?' + q.toString(), { method: 'POST' });
  if (!r.access_token) throw new Error('登录失败：' + JSON.stringify(r).slice(0, 300));
  return r.access_token;
}

async function getTask(token) {
  const r = await request(`${PATH.task}?taskId=${CONFIG.taskId}`, { token });
  if (!r.success || !r.data) throw new Error('获取任务失败：' + JSON.stringify(r).slice(0, 300));
  return r.data;
}

async function getRecord(token, date, taskType) {
  const r = await request(`${PATH.record}?taskId=${CONFIG.taskId}&signDate=${date}&taskType=${taskType}`, { token });
  return r.data || null;
}

function isSigned(rec) {
  if (!rec || rec.signStatus === undefined || rec.signStatus === null) return false;
  return SIGNED_STATUS.includes(Number(rec.signStatus));
}

async function runOnce(account, waited = false) {
  const { date, time, weekday } = nowParts();
  const who = CONFIG.accounts.length > 1 ? `${account.id} ` : '';
  console.log(`[${date} ${time} ${weekday}] ${who}开始执行`);

  const token = await login(account);
  console.log(`${who}登录成功`);

  const task = await getTask(token);
  const dorm = task.dormitoryRegisterVO || {};
  const roomId = dorm.roomId;
  if (!roomId) throw new Error('任务数据里没有 roomId');

  const roomLabel = [dorm.dormNo, dorm.floorName, dorm.roomNo].filter(Boolean).join('-');
  console.log(
    `${who}任务：${task.taskName} | 时段 ${task.signStartTime}-${task.signEndTime} | ` +
      `宿舍 ${roomLabel} | 允许半径 ${task.locationAccuracy}米`
  );

  const head = [];
  if (CONFIG.accounts.length > 1) head.push(`账号：${account.id}`);
  head.push(`日期：${date} ${time}（${weekday}）`, `宿舍：${roomLabel}`);

  // 任务日期范围
  if (task.taskStartDate && date < task.taskStartDate) {
    console.log(`今天(${date})早于任务开始日(${task.taskStartDate})，跳过`);
    return { outcome: 'skip', reason: 'tooEarlyDate', title: '⏭ 晚寝签到跳过（任务未开始）', lines: head };
  }
  if (task.taskEndDate && date > task.taskEndDate) {
    console.log(`今天(${date})晚于任务结束日(${task.taskEndDate})，跳过`);
    return { outcome: 'skip', reason: 'taskEnded', title: '⏭ 晚寝签到跳过（任务已结束）', lines: head };
  }

  // 今天是否签到日
  if (task.signWeek && !String(task.signWeek).includes(weekday)) {
    console.log(`今天${weekday}不是签到日，跳过`);
    return { outcome: 'skip', reason: 'notSignDay', title: '⏭ 晚寝签到跳过（非签到日）', lines: head };
  }

  // 免签日期
  if (Array.isArray(task.notSignDates) && task.notSignDates.includes(date)) {
    console.log('今天在免签日期列表里，跳过');
    return { outcome: 'skip', reason: 'notSignDate', title: '⏭ 晚寝签到跳过（免签日）', lines: head };
  }

  // 签到时段
  const nowSec = toSec(time);
  const startSec = toSec(task.signStartTime);
  const endSec = toSec(task.signEndTime);

  if (nowSec < startSec) {
    const waitSec = startSec - nowSec;
    if (!CONFIG.nowOverride && !waited && waitSec <= CONFIG.earlyWait) {
      console.log(`${who}比签到开始时间早 ${waitSec} 秒，等待到 ${task.signStartTime} 后再提交…`);
      await sleep(waitSec * 1000 + 2000); // 多等 2 秒，确保跨过整点
      return runOnce(account, true);
    }
    console.log(`${who}还没到签到时间（${task.signStartTime}），跳过`);
    return {
      outcome: 'skip',
      reason: 'tooEarly',
      title: '⏭ 晚寝签到跳过（未到时间）',
      lines: [...head, `签到时段：${task.signStartTime}-${task.signEndTime}`, `当前 ${time}，还差 ${waitSec} 秒`],
    };
  }
  if (nowSec > endSec) {
    console.log(`已过签到结束时间（${task.signEndTime}），跳过`);
    return {
      outcome: 'skip',
      reason: 'tooLate',
      title: '⏭ 晚寝签到跳过（已过时段）',
      lines: [...head, `签到时段：${task.signStartTime}-${task.signEndTime}`],
    };
  }

  // 今天是否已签到
  const rec = await getRecord(token, date, task.taskType);
  if (isSigned(rec) && !CONFIG.force) {
    console.log(`今天已签到（${rec.signTime}，${rec.signStatusName}，距离 ${rec.locationAccuracy}米），跳过`);
    return {
      outcome: 'already',
      reason: 'alreadySigned',
      title: 'ℹ️ 晚寝签到：今天已签到',
      lines: [
        ...head,
        `签到时间：${rec.signTime || '?'}`,
        `状态：${rec.signStatusName || '正常'}`,
        `距离宿舍：${rec.locationAccuracy || '?'} 米`,
      ],
    };
  }

  // 请求体（与前端逐字段一致）
  const pos = jitterCoords(account.lat, account.lng, CONFIG.jitter);
  const accuracy = +(20 + Math.random() * 8).toFixed(1);
  const dormLat = Number(dorm.locationLat);
  const dormLng = Number(dorm.locationLng);
  const dist = Number.isFinite(dormLat) && Number.isFinite(dormLng) ? distanceMeters(pos.lat, pos.lng, dormLat, dormLng) : null;

  const stuPayload = {
    latitude: String(pos.lat),
    longitude: String(pos.lng),
    locationAccuracy: String(accuracy),
    signDate: date,
    taskId: CONFIG.taskId,
    fileId: '',
  };

  const body = {
    signType: 0,
    taskId: CONFIG.taskId,
    signLat: pos.lat,
    signLng: pos.lng,
    locationAccuracy: accuracy,
    stuTaskId: md5(JSON.stringify(stuPayload)),
    scanCode: '',
    scanType: task.scanType || '',
    roomId,
    signKey: String(roomId),
    signCode: md5(new Date().toString()),
  };

  const coordLine = `坐标：${pos.lat}, ${pos.lng}` + (dist === null ? '' : `（距宿舍 ${dist} 米）`);
  console.log(coordLine);

  if (CONFIG.dryRun) {
    console.log('WQQD_DRY_RUN=1，请求体如下，未真正提交：\n' + JSON.stringify(body, null, 2));
    return {
      outcome: 'dryRun',
      reason: 'dryRun',
      title: '🧪 晚寝签到演练（未提交）',
      lines: [...head, coordLine, 'DRY_RUN=1，本次未真正提交'],
    };
  }

  const r = await request(PATH.sign, { method: 'POST', token, body });

  if (/已完成签到/.test(r.msg || '')) {
    console.log('今天已签到（服务端返回：' + r.msg + '），视为成功');
    return {
      outcome: 'already',
      reason: 'alreadySigned',
      title: 'ℹ️ 晚寝签到：今天已签到',
      lines: [...head, `服务端提示：${r.msg}`],
    };
  }
  if (!(r.code === 200 && r.success)) {
    throw new Error('签到失败：' + (r.msg || JSON.stringify(r).slice(0, 300)));
  }
  console.log('✅ 签到成功');

  // 回查确认
  const chk = await getRecord(token, date, task.taskType);
  const lines = [...head, coordLine];
  if (chk) {
    console.log(`回查：${chk.signDate} ${chk.signTime} ${chk.signStatusName}，距离 ${chk.locationAccuracy}米`);
    lines.push(`签到时间：${chk.signTime || '?'}`, `状态：${chk.signStatusName || '正常'}`, `距离宿舍：${chk.locationAccuracy || '?'} 米`);
  } else {
    console.log('⚠️ 回查未查到记录，请手动确认');
    lines.push('⚠️ 回查未查到记录，请手动确认');
  }

  return { outcome: 'success', reason: 'signed', title: '✅ 晚寝签到成功', lines };
}

// ---- 主流程 ----

async function runAccount(account) {
  let lastErr = null;
  for (let i = 1; i <= CONFIG.retry; i++) {
    try {
      const result = await runOnce(account);
      console.log(`${account.id} 结束（${result.reason}）`);
      return { ok: true, result, tries: i };
    } catch (e) {
      lastErr = e;
      console.error(`${account.id} 第 ${i} 次失败：${e && e.message ? e.message : e}`);
      if (i < CONFIG.retry) {
        console.log(`${CONFIG.retryWait}s 后重试…`);
        await sleep(CONFIG.retryWait * 1000);
      }
    }
  }
  return { ok: false, error: lastErr && lastErr.message ? lastErr.message : String(lastErr), tries: CONFIG.retry };
}

async function notifySummary(runs) {
  const failed = runs.filter((r) => !r.ok);
  const signed = runs.filter((r) => r.ok && r.result.outcome === 'success');
  const already = runs.filter((r) => r.ok && r.result.outcome === 'already');
  const skipped = runs.filter((r) => r.ok && r.result.outcome === 'skip');
  const dryRun = runs.filter((r) => r.ok && r.result.outcome === 'dryRun');

  // 单账号：沿用单账号文案
  if (runs.length === 1 && !failed.length) {
    const result = runs[0].result;
    if (result.outcome === 'skip' && !CONFIG.notifySkip) return;
    if (result.outcome === 'already' && !CONFIG.notifyAlready) {
      console.log('「今天已签到」默认不推送（想收到请设 WQQD_NOTIFY_ALREADY=1）');
      return;
    }
    await sendQywx(result.title, result.lines || []);
    return;
  }

  // 只有「已签到/跳过」时才看开关
  if (!failed.length && !signed.length && !dryRun.length) {
    if (already.length && CONFIG.notifyAlready) {
      await sendQywx(
        'ℹ️ 晚寝签到：今天已签到',
        runs.flatMap((r) => [`账号：${r.account.id}`, ...(r.result.lines || []), ''])
      );
    } else if (skipped.length && CONFIG.notifySkip) {
      await sendQywx('⏭ 晚寝签到跳过', runs.flatMap((r) => [`账号：${r.account.id}`, ...(r.result.lines || []), '']));
    } else {
      console.log('「今天已签到 / 跳过」默认不推送（想收到请设 WQQD_NOTIFY_ALREADY=1 / WQQD_NOTIFY_SKIP=1）');
    }
    return;
  }

  // 多账号汇总成一条
  const okCount = runs.length - failed.length;
  let title;
  if (failed.length) {
    title = runs.length === 1 ? '❌ 晚寝签到失败' : `❌ 晚寝签到失败（${failed.length}/${runs.length} 个账号）`;
  } else if (dryRun.length && !signed.length) {
    title = '🧪 晚寝签到演练（未提交）';
  } else if (signed.length) {
    title = `✅ 晚寝签到成功（${signed.length}/${runs.length} 个账号）`;
  } else {
    title = `ℹ️ 晚寝签到：${already.length} 个账号今天已签到`;
  }

  const lines = [`共 ${runs.length} 个账号：成功/已签 ${okCount} 个，失败 ${failed.length} 个`, ''];
  for (const r of runs) {
    const tag = r.ok ? { success: '✅', already: 'ℹ️', skip: '⏭', dryRun: '🧪' }[r.result.outcome] || '•' : '❌';
    lines.push(`${tag} 账号 ${r.account.id}（第 ${r.tries} 次）`);
    if (r.ok) {
      lines.push(...(r.result.lines || []).filter((l) => !l.startsWith('账号：')));
    } else {
      lines.push(`原因：${r.error}`);
    }
    lines.push('');
  }
  await sendQywx(title, lines);
}

async function main() {
  if (!SIGN_URL) {
    const msg =
      '缺少签到链接：请把浏览器地址栏里的签到链接整条填进脚本配置区的 SIGN_URL，' +
      '或设置环境变量 WQQD_SIGN_URL' +;
    console.error('❌ ' + msg);
    await sendQywx('❌ 晚寝签到失败（未配置签到链接）', [msg]);
    process.exitCode = 1;
    return;
  }
  if (!PARSED_URL) {
    const msg =
      `签到链接无法解析出 taskId：${SIGN_URL}\n` +
      '正确格式必须包含 ?taskId=xxxx，' +
    console.error('❌ ' + msg);
    await sendQywx('❌ 晚寝签到失败（签到链接无效）', [msg]);
    process.exitCode = 1;
    return;
  }

  if (!CONFIG.accounts.length) {
    const msg =
      '缺少账号配置：请设置 WQQD_ACCOUNT1 + WQQD_PASSWORD1' +
      '（多账号再加 WQQD_ACCOUNT2 + WQQD_PASSWORD2 ……）；' +
      '也兼容旧的 WISE_ACCOUNT / WISE_PASSWORD / WISE_ACCOUNTS';
    console.error('❌ ' + msg);
    await sendQywx('❌ 晚寝签到失败（配置缺失）', [msg]);
    process.exitCode = 1;
    return;
  }

  if (NUMBERED.incomplete.length) {
    const nums = NUMBERED.incomplete.join(', ');
    console.error(`⚠️ 以下编号的账号配置不完整（账号或密码缺一个），已跳过：第 ${nums} 个`);
  }

  console.log(`任务配置：base=${CONFIG.base} taskId=${CONFIG.taskId}（来自签到链接）`);
  const src = [];
  if (NUMBERED.accounts.length) src.push('WQQD_ACCOUNT1…N');
  if (SINGLE_ACCOUNT.id && SINGLE_ACCOUNT.password) src.push('WISE_ACCOUNT / WISE_PASSWORD');
  if (MULTI_ACCOUNTS.length) src.push('WISE_ACCOUNTS');
  console.log(
    `账号配置：共 ${CONFIG.accounts.length} 个（${CONFIG.accounts.map((a) => a.id).join(', ')}）` +
      `，来自 ${src.join(' + ')}`
  );

  const runs = [];
  for (const account of CONFIG.accounts) {
    const run = await runAccount(account);
    runs.push({ account, ...run });
  }

  await notifySummary(runs);

  const failed = runs.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`❌ 最终失败 ${failed.length} 个账号：${failed.map((r) => r.account.id).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(async (e) => {
  console.error('❌ 未捕获异常：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
