const API_URL = "http://wxykt.tiangong.edu.cn/charge/feeitem/getThirdData";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, now: formatUtc8(new Date()) });
    }

    if (url.pathname === "/query") {
      if (!checkApiKey(request, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      const forceNotify = url.searchParams.get("notify") === "1";
      const waitForResult = url.searchParams.get("wait") === "1";
      const explicitAsync = url.searchParams.get("async") === "1";
      const targets = getQueryTargets(env);
      const intervalSeconds = getTargetIntervalSeconds(env);
      const shouldAutoAsync = explicitAsync || (!waitForResult && targets.length > 1 && intervalSeconds > 0);

      const options = {
        source: "manual",
        forceNotify,
        background: shouldAutoAsync,
      };

      if (shouldAutoAsync) {
        ctx.waitUntil(runQueryAndMaybeNotify(env, options));
        return json(
          {
            ok: true,
            accepted: true,
            mode: targets.length > 1 ? "batch" : "single",
            targetCount: targets.length,
            intervalSeconds,
            message: "Query job started in background. Use /query?wait=1 to wait for full result.",
          },
          202
        );
      }

      const result = await runQueryAndMaybeNotify(env, options);
      return json(result, result.ok ? 200 : 500);
    }

    if (url.pathname === "/debug/env") {
      if (!checkApiKey(request, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      const inspect = inspectTargets(env);
      return json({
        ok: true,
        now: formatUtc8(new Date()),
        targetCount: inspect.targets.length,
        targetIds: inspect.targets.map((target) => target.id),
        targetsParseError: inspect.error,
        effectiveMode: inspect.targets.length > 1 ? "batch" : "single",
        notifyMode: env.NOTIFY_MODE || "always",
        hasSynjonesToken: Boolean(env.SYNJONES_AUTH_TOKEN),
        hasRequestCookie: Boolean(env.REQUEST_COOKIE),
        hasNapcatApi: Boolean(env.NAPCAT_API_URL),
        hasDingTalkWebhook: Boolean(env.DINGTALK_WEBHOOK),
        hasWecomWebhook: Boolean(env.WECOM_WEBHOOK),
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    const result = await runQueryAndMaybeNotify(env, {
      source: "cron",
      forceNotify: false,
    });

    if (!result.ok) {
      console.error("Scheduled query failed", result.error);
    }
  },
};

function checkApiKey(request, env) {
  if (!env.API_KEY) return true;
  const key = request.headers.get("x-api-key");
  return key && key === env.API_KEY;
}

async function runQueryAndMaybeNotify(env, options) {
  const queriedAt = formatUtc8(new Date());

  try {
    const targets = getQueryTargets(env);
    const intervalSeconds = getTargetIntervalSeconds(env);
    const appliedIntervalSeconds = options.background ? 0 : intervalSeconds;
    const items = [];
    const notifyResult = [];

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const item = await queryOneTarget(env, target, options);

      if (item.ok && item.decision?.notify) {
        const message = buildMessage(item.query, options.source, queriedAt, item.decision.reason);
        const channelResult = await sendNotifications(env, message);
        item.notifyResult = channelResult;
        notifyResult.push({
          targetId: item.target?.id || `target_${index + 1}`,
          type: "success",
          channels: channelResult,
        });
      } else if (!item.ok && shouldNotifyOnError(env, options)) {
        const message = buildErrorMessage(item.target, item.error, options.source, queriedAt);
        const channelResult = await sendNotifications(env, message);
        item.notifyResult = channelResult;
        notifyResult.push({
          targetId: item.target?.id || `target_${index + 1}`,
          type: "error",
          channels: channelResult,
        });
      } else {
        item.notifyResult = null;
      }

      items.push(item);

      if (index < targets.length - 1 && appliedIntervalSeconds > 0) {
        await sleep(appliedIntervalSeconds * 1000);
      }
    }

    const okItems = items.filter((item) => item.ok);
    const notifyItems = items.filter((item) => Array.isArray(item.notifyResult) && item.notifyResult.length > 0);
    const hasError = items.some((item) => !item.ok);

    return {
      ok: okItems.length > 0,
      queriedAt,
      source: options.source,
      mode: items.length > 1 ? "batch" : "single",
      intervalSeconds,
      appliedIntervalSeconds,
      decision: {
        notify: notifyItems.length > 0,
        reason: notifyItems.length > 0 ? "has_target_to_notify" : "no_target_to_notify",
      },
      notifyResult: notifyResult.length > 0 ? notifyResult : null,
      query: items.length > 1 ? undefined : okItems[0]?.query ?? null,
      queries: items,
      summary: {
        total: items.length,
        success: okItems.length,
        failed: items.length - okItems.length,
        notified: notifyItems.length,
        hasError,
      },
    };
  } catch (error) {
    return {
      ok: false,
      queriedAt,
      source: options.source,
      error: String(error?.message || error),
    };
  }
}

async function queryOneTarget(env, target, options) {
  try {
    const query = await queryElectricity(env, target);
    const decision = await shouldNotify(env, query, options, target.id);
    return {
      target,
      ok: true,
      query,
      decision,
    };
  } catch (error) {
    return {
      target,
      ok: false,
      error: String(error?.message || error),
      decision: {
        notify: false,
        reason: "query_failed",
      },
    };
  }
}

function formatUtc8(date) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} UTC+8`;
}

function getQueryTargets(env) {
  return inspectTargets(env).targets;
}

function inspectTargets(env) {
  const raw = env.TARGETS_JSON;
  if (!raw) {
    return {
      targets: [{ id: "default" }],
      error: null,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        targets: [{ id: "default" }],
        error: "TARGETS_JSON is empty or not an array",
      };
    }

    const targets = parsed
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const building = item.building ?? null;
        const room = item.room ?? null;
        return {
          id: String(item.id || `target_${index + 1}`),
          name: item.name ? String(item.name) : null,
          feeitemid: item.feeitemid ?? null,
          type: item.type ?? null,
          level: item.level ?? null,
          campus: item.campus ?? null,
          building,
          floor: item.floor ?? null,
          room,
          balancePath: item.balancePath ?? null,
        };
      });

    return {
      targets: targets.length > 0 ? targets : [{ id: "default" }],
      error: targets.length > 0 ? null : "TARGETS_JSON has no valid object item",
    };
  } catch (error) {
    const message = String(error?.message || error);
    console.error("TARGETS_JSON parse failed", message);
    return {
      targets: [{ id: "default" }],
      error: message,
    };
  }
}

async function queryElectricity(env, target = {}) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/plain, */*",
    Authorization: env.AUTHORIZATION || "Basic Y2hhcmdlOmNoYXJnZV9zZWNyZXQ=",
    Referer: env.REFERER || "http://wxykt.tiangong.edu.cn/charge-app/",
    Origin: env.ORIGIN || "http://wxykt.tiangong.edu.cn",
    "Accept-Language": env.ACCEPT_LANGUAGE || "zh-CN,zh;q=0.9",
    "User-Agent": env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.101 Safari/537.36",
  };

  if (env.SYNJONES_AUTH_TOKEN) {
    headers["synjones-auth"] = `bearer ${env.SYNJONES_AUTH_TOKEN}`;
  }

  if (env.REQUEST_COOKIE) {
    headers.Cookie = env.REQUEST_COOKIE;
  }

  const body = new URLSearchParams({
    feeitemid: String(target.feeitemid ?? env.FEEITEM_ID ?? "428"),
    type: String(target.type ?? env.FEE_TYPE ?? "IEC"),
    level: String(target.level ?? env.FEE_LEVEL ?? "4"),
    campus: String(target.campus ?? env.CAMPUS ?? "天津工业大学&天津工业大学"),
    building: String(target.building ?? env.BUILDING ?? "20161008184448464922&西苑7号楼"),
    floor: String(target.floor ?? env.FLOOR ?? "6&6层"),
    room: String(target.room ?? env.ROOM ?? "20161009111811624619&1栋609"),
  });

  const resp = await fetch(env.ELEC_API_URL || API_URL, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  const text = await resp.text();
  let payload = null;

  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(`Query failed with status ${resp.status}: ${text.slice(0, 500)}`);
  }

  const businessCode = parseMaybeNumber(payload?.code);
  const businessMsg = typeof payload?.msg === "string" ? payload.msg : "";
  const showInfo = payload?.map?.showData?.信息;

  if (businessCode !== null && businessCode !== 200) {
    throw new Error(`Business failed with code ${businessCode}: ${businessMsg || "unknown"}`);
  }

  if (typeof showInfo === "string") {
    const unavailablePatterns = ["暂时无法", "稍后再试", "网络或设备问题", "未知异常", "联系管理员"];
    if (unavailablePatterns.some((keyword) => showInfo.includes(keyword))) {
      throw new Error(`Meter unavailable: ${showInfo}`);
    }
  }

  const balance = extractBalance(payload, target.balancePath || env.BALANCE_PATH);

  return {
    status: resp.status,
    balance,
    payload,
  };
}

function extractBalance(payload, balancePath) {
  if (!payload || typeof payload !== "object") return null;

  if (balancePath) {
    const value = getByPath(payload, balancePath);
    const parsed = parseMaybeNumber(value);
    if (parsed !== null) return parsed;
  }

  const labelValue = findBalanceFromLabelValue(payload);
  if (labelValue !== null) return labelValue;

  const textValue = findBalanceFromText(payload);
  if (textValue !== null) return textValue;

  const candidates = [
    "balance",
    "remain",
    "remainBalance",
    "remainMoney",
    "surplus",
    "left",
    "leftAmount",
    "amount",
    "electricity",
    "剩余",
    "余额",
    "电量",
  ];

  return findNumberByKey(payload, candidates);
}

function findBalanceFromText(node) {
  if (typeof node === "string") {
    return extractNumberFromInfoText(node);
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const got = findBalanceFromText(item);
      if (got !== null) return got;
    }
    return null;
  }

  if (!node || typeof node !== "object") return null;

  for (const value of Object.values(node)) {
    const got = findBalanceFromText(value);
    if (got !== null) return got;
  }

  return null;
}

function extractNumberFromInfoText(text) {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/，/g, ",").replace(/：/g, ":");

  const patterns = [
    /(?:剩余购电量|剩余电量|当前电量|余额|剩余)\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i,
    /(-?\d+(?:\.\d+)?)\s*度/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1] != null) {
      const num = Number(match[1]);
      if (Number.isFinite(num)) return num;
    }
  }

  return null;
}

function findBalanceFromLabelValue(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const got = findBalanceFromLabelValue(item);
      if (got !== null) return got;
    }
    return null;
  }

  if (!node || typeof node !== "object") return null;

  const name = node.name || node.label || node.title || node.key;
  const value = node.value ?? node.val ?? node.amount ?? node.num;
  if (typeof name === "string") {
    const lowered = name.toLowerCase();
    if (
      lowered.includes("剩余") ||
      lowered.includes("余额") ||
      lowered.includes("电量") ||
      lowered.includes("remain") ||
      lowered.includes("balance") ||
      lowered.includes("electricity")
    ) {
      const parsed = parseMaybeNumber(value);
      if (parsed !== null) return parsed;
    }
  }

  for (const key of Object.keys(node)) {
    const got = findBalanceFromLabelValue(node[key]);
    if (got !== null) return got;
  }

  return null;
}

function findNumberByKey(node, candidates) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const got = findNumberByKey(item, candidates);
      if (got !== null) return got;
    }
    return null;
  }

  if (!node || typeof node !== "object") return null;

  for (const [key, value] of Object.entries(node)) {
    const lowered = key.toLowerCase();
    if (candidates.some((k) => lowered.includes(String(k).toLowerCase()))) {
      const parsed = parseMaybeNumber(value);
      if (parsed !== null) return parsed;
    }

    const deep = findNumberByKey(value, candidates);
    if (deep !== null) return deep;
  }

  return null;
}

function parseMaybeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/[^\d.-]/g, "");
    if (!normalized) return null;
    const num = Number(normalized);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function getTargetIntervalSeconds(env) {
  const raw = parseMaybeNumber(env.TARGET_QUERY_INTERVAL_SECONDS);
  if (raw === null) return 60;
  const seconds = Math.floor(raw);
  if (seconds < 0) return 0;
  return Math.min(seconds, 3600);
}

function shouldNotifyOnError(env, options) {
  if (options.forceNotify) return true;
  const value = String(env.NOTIFY_ON_ERROR ?? "true").toLowerCase().trim();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getByPath(obj, path) {
  const parts = path.split(".").filter(Boolean);
  let current = obj;

  for (const part of parts) {
    if (current == null) return null;
    if (/^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      current = current[part];
    }
  }

  return current;
}

async function shouldNotify(env, queryResult, options, stateSuffix = "default") {
  const mode = (env.NOTIFY_MODE || "always").toLowerCase();
  const threshold = parseMaybeNumber(env.LOW_BALANCE_THRESHOLD);
  const currentBalance = queryResult.balance;

  if (options.forceNotify) {
    return { notify: true, reason: "force_notify" };
  }

  if (mode === "never") {
    return { notify: false, reason: "mode_never" };
  }

  if (mode === "low_balance") {
    if (typeof currentBalance !== "number" || !Number.isFinite(currentBalance)) {
      return { notify: false, reason: "balance_unknown" };
    }

    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      return { notify: false, reason: "threshold_missing" };
    }

    return {
      notify: currentBalance <= threshold,
      reason: currentBalance <= threshold ? "low_balance" : "balance_ok",
    };
  }

  if (mode === "change") {
    const canStore = !!env.STATE_KV;
    if (!canStore) {
      return { notify: true, reason: "change_mode_without_kv_fallback_always" };
    }

    if (typeof currentBalance !== "number" || !Number.isFinite(currentBalance)) {
      return { notify: false, reason: "balance_unknown" };
    }

    const baseKey = env.STATE_KEY || "last_balance";
    const key = `${baseKey}:${stateSuffix}`;
    const prevRaw = await env.STATE_KV.get(key);
    const prev = parseMaybeNumber(prevRaw);
    await env.STATE_KV.put(key, String(currentBalance));

    if (prev === null) {
      return { notify: true, reason: "first_change_snapshot" };
    }

    return {
      notify: prev !== currentBalance,
      reason: prev !== currentBalance ? "balance_changed" : "balance_unchanged",
      prevBalance: prev,
      currentBalance,
    };
  }

  return { notify: true, reason: "mode_always" };
}

function buildMessage(queryResult, source, queriedAt, reason) {
  const buildingName = queryResult?.payload?.map?.data?.buildingName || "未知楼栋";
  const roomName = queryResult?.payload?.map?.data?.roomName || "未知房间";
  const title = `${buildingName}${roomName}电费查询结果`;
  const balanceText =
    typeof queryResult.balance === "number" && Number.isFinite(queryResult.balance)
      ? `${queryResult.balance}度`
      : "未识别";

  return [
    `${title}`,
    `来源: ${source}`,
    `时间: ${queriedAt}`,
    `剩余电量: ${balanceText}`,
    `触发原因: ${reason}`,
  ].join("\n");
}

function buildErrorMessage(target, error, source, queriedAt) {
  const title = `${getTargetDisplayName(target)}电费查询失败`;
  return [
    `${title}`,
    `来源: ${source}`,
    `时间: ${queriedAt}`,
    `错误: ${error || "unknown_error"}`,
  ].join("\n");
}

function getTargetDisplayName(target) {
  if (target?.name) return String(target.name);
  const buildingName = extractLabelPart(target?.building);
  const roomName = extractLabelPart(target?.room);
  if (buildingName || roomName) return `${buildingName || "未知楼栋"}${roomName || "未知房间"}`;
  if (target?.id) return String(target.id);
  return "未知目标";
}

function extractLabelPart(value) {
  if (typeof value !== "string" || !value) return null;
  const parts = value.split("&");
  return parts.length > 1 ? parts.slice(1).join("&") : value;
}

async function sendNotifications(env, text) {
  const results = [];

  if (env.DINGTALK_WEBHOOK) {
    results.push(await sendDingTalk(env, text));
  }

  if (env.WECOM_WEBHOOK) {
    results.push(await sendWeCom(env, text));
  }

  if (env.NAPCAT_API_URL) {
    results.push(await sendNapcat(env, text));
  }

  return results;
}

async function sendDingTalk(env, text) {
  let webhook = env.DINGTALK_WEBHOOK;

  if (env.DINGTALK_SECRET) {
    const timestamp = Date.now();
    const sign = await dingSign(timestamp, env.DINGTALK_SECRET);
    const sep = webhook.includes("?") ? "&" : "?";
    webhook = `${webhook}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  }

  const resp = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content: text },
    }),
  });

  const body = await safeRead(resp);
  return {
    channel: "dingtalk",
    ok: resp.ok,
    status: resp.status,
    body,
  };
}

async function dingSign(timestamp, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const message = encoder.encode(`${timestamp}\n${secret}`);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, message);
  return arrayBufferToBase64(signature);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sendWeCom(env, text) {
  const resp = await fetch(env.WECOM_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content: text },
    }),
  });

  const body = await safeRead(resp);
  return {
    channel: "wecom",
    ok: resp.ok,
    status: resp.status,
    body,
  };
}

async function sendNapcat(env, text) {
  const targetType = (env.NAPCAT_TARGET_TYPE || "group").toLowerCase();
  const rawApi = env.NAPCAT_API_URL;
  const api = rawApi.match(/\/send_(group|private)_msg$/)
    ? rawApi
    : `${rawApi.replace(/\/$/, "")}/${targetType === "private" ? "send_private_msg" : "send_group_msg"}`;

  const payload = {
    message: text,
  };

  if (targetType === "private") {
    payload.user_id = Number(env.NAPCAT_USER_ID || "0");
  } else {
    payload.group_id = Number(env.NAPCAT_GROUP_ID || "0");
  }

  const headers = { "Content-Type": "application/json" };
  if (env.NAPCAT_TOKEN) {
    headers.Authorization = `Bearer ${env.NAPCAT_TOKEN}`;
  }

  const resp = await fetch(api, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const body = await safeRead(resp);
  return {
    channel: "napcat",
    ok: resp.ok,
    status: resp.status,
    body,
  };
}

async function safeRead(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
