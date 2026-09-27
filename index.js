require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const {
  BOT_TOKEN,
  ADMIN_IDS = "",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DAV_URL = "",
  DAV_USERNAME = "",
  DAV_PASSWORD = "",
  DAV_ROOT = "/telegram-resource-bot",
  BOT_NAME = "资源取件机器人"
} = process.env;

function required(name, value) {
  if (!value) throw new Error("缺少环境变量: " + name);
}

required("BOT_TOKEN", BOT_TOKEN);
required("SUPABASE_URL", SUPABASE_URL);
required("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);

const admins = new Set(
  ADMIN_IDS.split(",").map(x => x.trim()).filter(Boolean)
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
let BOT_USERNAME = "";
const pendingUploads = new Map();

function pendingKey(msg) { return String(msg.chat?.id || msg.from?.id || ""); }
function getPending(key) { if (!pendingUploads.has(key)) pendingUploads.set(key, []); return pendingUploads.get(key); }
function clearPending(key) { pendingUploads.delete(key); }

function isAdmin(msg) {
  const id = String(msg.from?.id || "");
  const username = String(msg.from?.username || "");
  return admins.has(id) || (username && admins.has("@" + username));
}

function menu(isAdminUser = false) {
  const rows = [
    [{ text: "📤 上传资源" }],
    [{ text: "✅ 完成上传" }],
    [{ text: "📖 使用说明" }]
  ];
  if (isAdminUser) rows.push([{ text: "🛠 管理中心" }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const c = code();
    const { data, error } = await db.from("resources").select("id").eq("code", c).limit(1);
    if (error) throw error;
    if (!data?.length) return c;
  }
  throw new Error("无法生成唯一取件码");
}

function davConfigured() {
  return Boolean(DAV_URL && DAV_USERNAME && DAV_PASSWORD);
}

function requireDav() {
  if (!davConfigured()) {
    throw new Error("123云盘 WebDAV 尚未配置，请填写 DAV_URL、DAV_USERNAME、DAV_PASSWORD");
  }
}

function davUrl(path) {
  requireDav();
  const base = DAV_URL.replace(/\/$/, "");
  return base + "/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function ensureDavRoot() {
  if (!davConfigured()) {
    console.log("WebDAV 未配置：机器人可以启动，但上传/下载暂不可用。");
    return;
  }

  try {
    const root = DAV_ROOT.replace(/\\/g, "/").replace(/\/$/, "");
    await axios.request({
      method: "MKCOL",
      url: davUrl(root),
      auth: { username: DAV_USERNAME, password: DAV_PASSWORD },
      validateStatus: s => s < 500
    });
    console.log("WebDAV root check: OK");
  } catch (e) {
    console.error("WebDAV root check failed:", e?.response?.status || e.message);
  }
}

function safeName(name) {
  return String(name || "resource.bin")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 180);
}

async function uploadToDav(fileUrl, cloudPath, size) {
  requireDav();
  const response = await axios.get(fileUrl, { responseType: "stream", timeout: 120000 });
  const headers = {};
  if (size) headers["Content-Length"] = String(size);
  else if (response.headers["content-length"]) headers["Content-Length"] = response.headers["content-length"];

  await axios.put(davUrl(cloudPath), response.data, {
    auth: { username: DAV_USERNAME, password: DAV_PASSWORD },
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0,
    validateStatus: s => s >= 200 && s < 300
  });
}

async function deleteFromDav(cloudPath) {
  requireDav();
  await axios.delete(davUrl(cloudPath), {
    auth: { username: DAV_USERNAME, password: DAV_PASSWORD },
    validateStatus: s => (s >= 200 && s < 300) || s === 404
  });
}

async function getFileInfo(msg) {
  if (msg.document) return {
    fileId: msg.document.file_id,
    fileName: msg.document.file_name || "resource.bin",
    size: msg.document.file_size || 0
  };
  if (msg.video) return {
    fileId: msg.video.file_id,
    fileName: msg.video.file_name || ("video_" + msg.video.file_unique_id + ".mp4"),
    size: msg.video.file_size || 0
  };
  if (msg.audio) return {
    fileId: msg.audio.file_id,
    fileName: msg.audio.file_name || ((msg.audio.title || "audio") + ".mp3"),
    size: msg.audio.file_size || 0
  };
  if (msg.photo?.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { fileId: p.file_id, fileName: "photo_" + p.file_unique_id + ".jpg", size: p.file_size || 0 };
  }
  return null;
}

async function uploadPendingResource(msg) {
  requireDav();
  const info = await getFileInfo(msg);
  if (!info) return null;
  const name = safeName(info.fileName);
  const root = DAV_ROOT.replace(/\\/g, "/").replace(/\/$/, "");
  const stamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const cloudPath = root + "/pending/" + stamp + "_" + random + "_" + name;
  const fileUrl = await bot.getFileLink(info.fileId);
  await uploadToDav(fileUrl, cloudPath, info.size);
  return { ...info, fileName: name, cloudPath };
}

async function finalizePendingUploads(msg) {
  const key = pendingKey(msg);
  const items = pendingUploads.get(key) || [];
  if (!items.length) return null;
  const c = await uniqueCode();
  const rows = items.map((item, index) => ({
    code: c,
    sort_order: index + 1,
    file_name: item.fileName,
    cloud_path: item.cloudPath,
    file_size: item.size || 0,
    uploader_id: msg.from?.id || null
  }));
  const { data, error } = await db.from("resources").insert(rows).select("*");
  if (error) {
    for (const item of items) { try { await deleteFromDav(item.cloudPath); } catch (_) {} }
    throw error;
  }
  clearPending(key);
  return { code: c, items: data || rows };
}

async function findResources(c) {
  const { data, error } = await db.from("resources")
    .select("*").eq("code", c.toUpperCase()).eq("status", "active").order("sort_order", { ascending: true }).order("id", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function findResource(c) {
  const items = await findResources(c);
  return items[0] || null;
}

async function sendResource(chatId, resource) {
  requireDav();
  const response = await axios.get(davUrl(resource.cloud_path), {
    auth: { username: DAV_USERNAME, password: DAV_PASSWORD },
    responseType: "stream",
    timeout: 120000
  });
  await bot.sendDocument(chatId, response.data, {
    caption: "📦 资源取件成功\n\n" +
      "📄 " + resource.file_name + "\n" +
      "🔑 取件码　" + resource.code + "\n\n" +
      "感谢使用。"
  }, {
    filename: resource.file_name,
    contentType: response.headers["content-type"] || "application/octet-stream"
  });
}

async function sendResourceBatch(chatId, resources) {
  for (const resource of resources) {
    await sendResource(chatId, resource);
    await db.from("resources").update({ downloads: (resource.downloads || 0) + 1 }).eq("id", resource.id);
  }
}

async function checkDav() {
  if (!davConfigured()) {
    return { ok: false, status: "未配置", detail: "请填写 DAV_URL、DAV_USERNAME、DAV_PASSWORD" };
  }

  try {
    const root = DAV_ROOT.replace(/\\/g, "/").replace(/\/$/, "");
    const res = await axios.request({
      method: "PROPFIND",
      url: davUrl(root),
      auth: { username: DAV_USERNAME, password: DAV_PASSWORD },
      headers: { Depth: "0" },
      timeout: 15000,
      validateStatus: () => true
    });

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: "已连接", detail: "WebDAV 正常" };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: "认证失败", detail: "账号或密码不正确" };
    }
    if (res.status === 404) {
      return { ok: false, status: "路径不存在", detail: "DAV_ROOT 不存在或路径错误" };
    }
    if (res.status >= 500) {
      return { ok: false, status: "服务异常", detail: "WebDAV 返回 HTTP " + res.status };
    }
    return { ok: false, status: "连接异常", detail: "WebDAV 返回 HTTP " + res.status };
  } catch (e) {
    return {
      ok: false,
      status: "连接失败",
      detail: e?.message?.slice(0, 120) || "网络连接失败"
    };
  }
}

async function checkSupabase() {
  try {
    const { count, error } = await db
      .from("resources")
      .select("*", { count: "exact", head: true });

    if (error) throw error;
    return { ok: true, status: "正常", count: count || 0 };
  } catch (e) {
    return {
      ok: false,
      status: "异常",
      detail: e?.message?.slice(0, 120) || "数据库连接失败"
    };
  }
}

async function buildAdminPanel() {
  const [dav, supa] = await Promise.all([checkDav(), checkSupabase()]);

  let downloads = 0;
  if (supa.ok) {
    const { data, error } = await db
      .from("resources")
      .select("downloads")
      .eq("status", "active");
    if (!error) {
      downloads = (data || []).reduce((n, x) => n + Number(x.downloads || 0), 0);
    }
  }

  const davIcon = dav.ok ? "🟢" : (dav.status === "未配置" ? "⚪" : "🔴");
  const dbIcon = supa.ok ? "🟢" : "🔴";

  return {
    text:
      "🛠 管理中心\n\n" +
      "☁️ 云盘状态\n" +
      davIcon + " 123 云盘　" + dav.status + "\n" +
      "📁 仓库目录　" + DAV_ROOT + "\n" +
      (dav.detail && !dav.ok ? "💡 " + dav.detail + "\n" : "") +
      "\n" +
      "🗄️ 数据库状态\n" +
      dbIcon + " Supabase　" + supa.status + "\n" +
      (supa.ok ? "📦 有效资源　" + supa.count + "\n" : "💡 请检查数据库配置\n") +
      "📥 总下载　　" + downloads + "\n\n" +
      "⚡ 用户操作\n" +
      "发送 6 位取件码，即可一次取回该批次全部资源。\n\n" +
      "⚙️ 管理命令\n" +
      "/search　搜索资源\n" +
      "/resource　查看资源\n" +
      "/delete　删除资源",
    keyboard: {
      inline_keyboard: [
        [
          { text: "☁️ 检测云盘", callback_data: "admin_check_dav" },
          { text: "🗄️ 检测数据库", callback_data: "admin_check_db" }
        ],
        [
          { text: "🔄 刷新管理中心", callback_data: "admin_refresh" }
        ]
      ]
    }
  };
}

async function adminStats(chatId) {
  const panel = await buildAdminPanel();
  await bot.sendMessage(chatId, panel.text, {
    reply_markup: panel.keyboard
  });
}

bot.on("callback_query", async query => {
  try {
    const msg = query.message;
    if (!msg || !isAdmin({ from: query.from })) {
      return bot.answerCallbackQuery(query.id, {
        text: "⛔ 暂无管理权限\n\n该功能仅限管理员使用。",
        show_alert: true
      });
    }

    if (query.data === "admin_check_dav") {
      const dav = await checkDav();
      await bot.answerCallbackQuery(query.id, { text: dav.status });
      return bot.sendMessage(
        msg.chat.id,
        "☁️ 云盘检测结果\n\n" +
        (dav.ok ? "🟢 连接正常" : "🔴 " + dav.status) + "\n" +
        "📁 仓库目录　" + DAV_ROOT + "\n" +
        "💡 " + dav.detail
      );
    }

    if (query.data === "admin_check_db") {
      const supa = await checkSupabase();
      await bot.answerCallbackQuery(query.id, { text: supa.status });
      return bot.sendMessage(
        msg.chat.id,
        "🗄️ 数据库检测结果\n\n" +
        (supa.ok ? "🟢 数据库正常" : "🔴 连接异常") + "\n" +
        (supa.ok ? "📦 资源数量　" + supa.count : "💡 请检查 Supabase 配置")
      );
    }

    if (query.data === "admin_refresh") {
      const panel = await buildAdminPanel();
      await bot.answerCallbackQuery(query.id, { text: "已刷新" });
      return bot.editMessageText(panel.text, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: panel.keyboard
      });
    }

    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.error("CALLBACK ERROR:", e);
    try {
      await bot.answerCallbackQuery(query.id, { text: "操作失败，请稍后重试" });
    } catch (_) {}
  }
});

bot.onText(/^\/start$/, async msg => {
  await bot.sendMessage(msg.chat.id,
    "👋 欢迎使用 " + BOT_NAME + "\n\n" +
    "📤 上传资源\n" +
    "可连续发送多个文件，全部发送完成后点击「✅ 完成上传」。\n\n" +
    "🔑 获取资源\n" +
    "一个取件码对应一整批文件，发送取件码即可全部取回。\n\n" +
    "💡 无需输入命令，发送文件或取件码即可。",
    menu(isAdmin(msg))
  );
});

bot.onText(/^\/admin$/, async msg => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "⛔ 无管理员权限");
  try {
    await adminStats(msg.chat.id);
  } catch (e) {
    console.error("ADMIN ERROR:", e);
    await bot.sendMessage(msg.chat.id, "⚠️ 管理中心暂时无法加载\n\n请检查 Supabase 数据库配置后重试。");
  }
});

bot.onText(/^\/resource\s+([A-Za-z0-9]+)$/i, async (msg, m) => {
  if (!isAdmin(msg)) return;
  try {
    const items = await findResources(m[1]);
    if (!items.length) return bot.sendMessage(msg.chat.id, "🔎 没有找到这条资源\n\n请检查取件码是否正确。");
    const totalSize = items.reduce((n, r) => n + Number(r.file_size || 0), 0);
    await bot.sendMessage(msg.chat.id,
      "📦 批次资源详情\n\n" +
      "🔑 取件码　" + items[0].code + "\n" +
      "📦 文件数量　" + items.length + "\n" +
      "📏 总大小　　" + totalSize + "\n" +
      "📥 总下载　　" + items.reduce((n, r) => n + Number(r.downloads || 0), 0) + "\n" +
      "📌 当前状态　" + items[0].status + "\n" +
      "🕒 创建时间　" + items[0].created_at + "\n\n" +
      items.map((x, i) => (i + 1) + ". " + x.file_name).join("\n")
    );
  } catch (e) {
    console.error("RESOURCE ERROR:", e);
    await bot.sendMessage(msg.chat.id, "❌ 查询失败，请检查 Supabase 配置。");
  }
});

bot.onText(/^\/search\s+(.+)$/i, async (msg, m) => {
  if (!isAdmin(msg)) return;
  try {
    const q = m[1].trim();
    const { data, error } = await db.from("resources")
      .select("code,file_name,file_size,downloads,status")
      .or("code.ilike.%" + q + "%,file_name.ilike.%" + q + "%")
      .order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    if (!data?.length) return bot.sendMessage(msg.chat.id, "🔎 暂无相关资源\n\n换个关键词试试。");
    await bot.sendMessage(msg.chat.id,
      "🔎 搜索结果\n\n" +
      "关键词：" + q + "\n" +
      "共找到 " + data.length + " 条资源\n\n" +
      data.map((r, i) =>
        "「" + r.code + "」\n" +
        "📄 " + r.file_name + "\n" +
        "📥 下载 " + r.downloads + " 次"
      ).join("\n\n")
    );
  } catch (e) {
    console.error("SEARCH ERROR:", e);
    await bot.sendMessage(msg.chat.id, "❌ 搜索失败，请检查 Supabase 配置。");
  }
});

bot.onText(/^\/delete\s+([A-Za-z0-9]+)$/i, async (msg, m) => {
  if (!isAdmin(msg)) return;
  try {
    const items = await findResources(m[1]);
    if (!items.length) return bot.sendMessage(msg.chat.id, "❌ 未找到资源");
    for (const r of items) { try { await deleteFromDav(r.cloud_path); } catch (_) {} }
    await db.from("resources").update({ status: "deleted" }).eq("code", items[0].code);
    await bot.sendMessage(msg.chat.id, "🗑 资源批次已删除\n\n🔑 取件码　" + items[0].code + "\n📦 文件数量　" + items.length);
  } catch (e) {
    console.error("DELETE ERROR:", e);
    await bot.sendMessage(msg.chat.id, "❌ 删除失败，请检查配置。");
  }
});

bot.on("message", async msg => {
  if (msg.text?.startsWith("/")) return;

  try {
    if (msg.text === "📖 使用说明") {
      return bot.sendMessage(msg.chat.id,
        "📖 使用说明\n\n" +
        "📤 存入资源\n" +
        "连续发送多个文件，全部发送完成后点击「✅ 完成上传」。\n\n" +
        "🔑 获取资源\n" +
        "一个取件码对应整批文件，发送取件码即可全部取回。\n\n" +
        "💡 全程无需输入命令，直接发送即可。"
      );
    }

    if (msg.text === "🛠 管理中心") {
      if (isAdmin(msg)) return adminStats(msg.chat.id);
      return bot.sendMessage(msg.chat.id, "⛔ 无管理员权限");
    }

    if (msg.text === "📤 上传资源") {
      return bot.sendMessage(
        msg.chat.id,
        "📤 请连续发送文件\n\n" +
        "文件会自动加入当前批次。\n" +
        "全部发送完成后，点击「✅ 完成上传」，机器人会立即生成一个取件码。"
      );
    }

    if (msg.text === "✅ 完成上传") {
      const pending = getPending(pendingKey(msg));
      if (!pending.length) {
        return bot.sendMessage(
          msg.chat.id,
          "📭 当前没有待完成的上传。\n\n请先发送文件。"
        );
      }

      const batch = await finalizePendingUploads(msg);
      return bot.sendMessage(
        msg.chat.id,
        "✅ 批次上传完成\n\n" +
        "📦 文件数量　" + batch.items.length + " 个\n" +
        "🔑 取件码　　" + batch.code + "\n\n" +
        "这一批文件共用一个取件码。\n" +
        "发送取件码即可取回全部文件。" +
        (BOT_USERNAME ? "\n\n📲 机器人：@" + BOT_USERNAME : "")
      );
    }

    const info = await getFileInfo(msg);
    if (info) {
      if (!davConfigured()) {
        return bot.sendMessage(msg.chat.id,
          "⚠️ 存储服务尚未配置完成\n\n当前无法保存资源，请联系管理员检查 123 云盘 WebDAV 配置。"
        );
      }
      await bot.sendMessage(msg.chat.id, "⏳ 正在保存文件…\n\n📄 " + info.fileName + "\n请稍候。");
      const item = await uploadPendingResource(msg);
      const list = getPending(pendingKey(msg));
      list.push(item);
      return;
    }

    if (msg.text) {
      const match = msg.text.match(/(?<![A-Za-z0-9])[A-HJ-NP-Z2-9]{6}(?![A-Za-z0-9])/i);
      if (match) {
        const items = await findResources(match[0]);
        if (!items.length) {
          return bot.sendMessage(msg.chat.id, "❌ 未找到对应资源\n\n请检查取件码是否正确。");
        }
        await bot.sendMessage(
          msg.chat.id,
          "📦 正在发送资源…\n\n共 " + items.length + " 个文件，请稍候。"
        );
        try {
          await sendResourceBatch(msg.chat.id, items);
        } catch (e) {
          console.error("SEND RESOURCE ERROR:", e);
          return bot.sendMessage(
            msg.chat.id,
            "❌ 资源发送失败\n\n请联系管理员检查云盘连接。"
          );
        }
        return;
      }
    }
  } catch (e) {
    console.error("MESSAGE ERROR:", e);
    await bot.sendMessage(
      msg.chat.id,
      "❌ 操作失败，请稍后重试。"
    );
  }
});

bot.getMe()
  .then(me => {
    BOT_USERNAME = me.username || "";
    console.log("Bot started: @" + (BOT_USERNAME || "unknown"));
    return ensureDavRoot();
  })
  .catch(err => {
    console.error("Bot startup check failed:", err);
  });

process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", err => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
