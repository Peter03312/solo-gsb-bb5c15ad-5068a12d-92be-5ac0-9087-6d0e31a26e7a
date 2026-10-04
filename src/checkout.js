// 配重块实物编号领还（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 实物编号按现有质量规格登记，全局唯一；同规格在册（未注销）实物数不得
//     超过当前库存；已领出（未归还）的实物不能注销；库存缩减若低于在册实物
//     数，配重块整表替换整次拒绝；
//   - 领用凭生效预约在其左闭右开时段 [start, end) 内进行；同一预约只可领用
//     一次（同内容重试返回原单、异内容拒绝）；所选实物按规格精确匹配预约
//     冻结占用量，且均未被其他未归还领用占用；
//   - 归还逐件标记完好（intact）或损坏（damaged）；非本单实物及重复归还
//     整次拒绝；损坏件不得再次领用；预约结束后仍可归还；
//   - 查询展示未还件与逾期状态（逾期 = 当前时刻已过预约终点且仍有未还件）；
//   - 预约取消、库存调整及运行状态变化均不改写领还历史；领还冲突不留部分记录。

export const RETURN_CONDITIONS = ['intact', 'damaged'];

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// 实物编号登记请求规整：{ serial, mass }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeItemInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const serial = typeof b.serial === 'string' ? b.serial.trim() : '';
  if (!serial) errors.push('实物编号不能为空');
  else if (serial.length > 100) errors.push('实物编号过长（最多 100 字符）');

  const mass = b.mass;
  if (typeof mass !== 'number' || !Number.isFinite(mass) || mass <= 0) {
    errors.push('mass 必须是有限正数（实物所属质量规格，单位 g）');
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { serial, mass } };
}

// 领用请求规整：{ reservationId, items: [serial, ...] }
// items 为实物编号数组（非空、不重复）。返回 { errors, clean }。
export function normalizeCheckoutInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const reservationId = Number(b.reservationId);
  if (!isInt(reservationId) || reservationId <= 0) {
    errors.push('reservationId 必须是预约编号（正整数）');
  }
  const items = b.items;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('领用实物清单 items 必须是非空数组（元素为实物编号）');
  }
  const serials = [];
  if (Array.isArray(items)) {
    const seen = new Set();
    items.forEach((it, i) => {
      const s = typeof it === 'string' ? it.trim() : '';
      if (!s) {
        errors.push(`第 ${i + 1} 项领用实物：实物编号不能为空（须为字符串）`);
        return;
      }
      if (s.length > 100) {
        errors.push(`第 ${i + 1} 项领用实物：实物编号「${s}」过长（最多 100 字符）`);
        return;
      }
      if (seen.has(s)) {
        errors.push(`实物编号「${s}」在领用清单中重复`);
      }
      seen.add(s);
      serials.push(s);
    });
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { reservationId, serials } };
}

// 归还请求规整：{ items: [{serial, condition}], ... }
// condition 仅能为 intact（完好）/ damaged（损坏）。返回 { errors, clean }。
export function normalizeReturnInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const items = b.items;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('归还清单 items 必须是非空数组（元素为 {serial, condition}）');
  }
  const clean = [];
  if (Array.isArray(items)) {
    const seen = new Set();
    items.forEach((row, i) => {
      const where = `第 ${i + 1} 项归还`;
      if (!row || typeof row !== 'object') {
        errors.push(`${where}格式不正确（须为 {serial, condition} 对象）`);
        return;
      }
      const s = typeof row.serial === 'string' ? row.serial.trim() : '';
      if (!s) {
        errors.push(`${where}：实物编号不能为空`);
        return;
      }
      const cond = row.condition;
      if (!RETURN_CONDITIONS.includes(cond)) {
        errors.push(
          `${where}：实物「${s}」的 condition 必须是 ${RETURN_CONDITIONS.join(' / ')} 之一` +
            '（intact=完好，damaged=损坏）',
        );
        return;
      }
      if (seen.has(s)) {
        errors.push(`实物编号「${s}」在归还清单中重复`);
      }
      seen.add(s);
      clean.push({ serial: s, condition: cond });
    });
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { items: clean } };
}

// 所选实物按规格精确匹配预约冻结占用量：
//   items: [{serial, mass}]（已登记实物及其规格）
//   usage: [{mass, count}]（预约冻结占用量）
// 每个规格的所选件数须与冻结占用量逐一相等，且不得包含占用量之外的规格。
// 返回 { ok, errors }。
export function matchUsage(items, usage) {
  const errors = [];
  const need = new Map();
  for (const u of usage || []) {
    if (u && typeof u.mass === 'number' && u.count > 0) {
      need.set(u.mass, (need.get(u.mass) || 0) + u.count);
    }
  }
  const got = new Map();
  for (const it of items || []) {
    got.set(it.mass, (got.get(it.mass) || 0) + 1);
  }
  for (const [mass, count] of [...got.entries()].sort((a, b) => a[0] - b[0])) {
    if (!need.has(mass)) {
      errors.push(`规格 ${mass} g 的 ${count} 件实物不在预约冻结占用量内（该规格无需领用）`);
    }
  }
  for (const [mass, count] of [...need.entries()].sort((a, b) => a[0] - b[0])) {
    const g = got.get(mass) || 0;
    if (g !== count) {
      errors.push(
        `规格 ${mass} g 按冻结占用量须领用 ${count} 件，本次选择 ${g} 件（须精确匹配）`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

// 领用单汇总：未还件、状态与逾期。
//   items: [{serial, returnedAt}]（领用单内全部实物；returnedAt 为 null 表示未还）
//   reservationEndMs: 冻结的预约终点（毫秒）
//   nowMs: 当前时刻（毫秒）
// 返回 { total, returnedCount, unreturnedCount, unreturned, status, overdue, closedAt }：
//   status: 'open'（仍有未还件）/ 'closed'（全部归还）；
//   overdue: 当前时刻已过预约终点且仍有未还件（恰在终点不算逾期，与运行超时口径一致）；
//   closedAt: 全部归还时刻（最后一件归还时间，ISO），未全部归还为 null。
export function summarizeCheckout(items, reservationEndMs, nowMs) {
  const unreturned = [];
  let returnedCount = 0;
  let lastReturnedMs = null;
  for (const it of items || []) {
    if (it && it.returnedAt) {
      returnedCount += 1;
      const ms = Date.parse(it.returnedAt);
      if (!Number.isNaN(ms) && (lastReturnedMs === null || ms > lastReturnedMs)) {
        lastReturnedMs = ms;
      }
    } else if (it) {
      unreturned.push(it.serial);
    }
  }
  const total = (items || []).length;
  const closed = total > 0 && unreturned.length === 0;
  return {
    total,
    returnedCount,
    unreturnedCount: unreturned.length,
    unreturned,
    status: closed ? 'closed' : 'open',
    overdue: unreturned.length > 0 && nowMs > reservationEndMs,
    closedAt: closed && lastReturnedMs !== null ? new Date(lastReturnedMs).toISOString() : null,
  };
}
