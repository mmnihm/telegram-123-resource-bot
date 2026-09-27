require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const {
  BOT_TOKEN,
  ADMIN_IDS = "",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DAV_URL,
  DAV_USERNAME,
  DAV_PASSWORD,
  DAV_ROOT = "/telegram-resource-bot",
  BOT_NAME = "资源取件机器人"
} = process.env;

function required(name, value) {
  if (!value) throw new Error("缺少环境变量: " + name);
}
["BOT_TOKEN","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","DAV_URL","DAV_USERNAME","DAV_PASSWORD"]
  .forEach(k => required(k, process.env[k]));

const admins = new Set(
  ADMIN_IDS.split(",").map(x => x.trim()).filter(Boolean)
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function isAdmin(msg) {
  const id = String(msg.from?.id || "");
  const username = String(msg.from?.username || "");
  return admins.has(id) || (username && admins.has("@" + username));
}

function menu(isAdminUser = false) {
  const rows = [
    [{ text: "📤 上传资源" }, { text: "🔑 输入取件码" }],
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
    const { data } = await db.from("resources").select("id").eq("code", c).maybeSingle();
    if (!data) return c;
  }
  throw new Error("无法生成唯一取件码");
}

function davUrl(path) {
  const base = DAV_URL.replace(/\\/$/, "");
  return base + "/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function ensureDavRoot() {
  try {
    await axios.request({
      method: "MKCOL",
      url: davUrl(DAV_ROOT),
      auth: { username: DAV_USERNAME, password: DAV_PASSWORD },
      validateStatus: s => s < 500
    });
  } catch (_) {}
}

function safeName(name) {
  return String(name || "resource.bin")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 180);
}

async function uploadToDav(fileUrl, cloudPath, size) {
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
    fileName: (msg.video.file_name || ("video_" + msg.video.file_unique_id + ".mp4")),
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

async function saveResource(msg) {
  const info = await getFileInfo(msg);
  if (!info) return null;

  const c = await uniqueCode();
  const name = safeName(info.fileName);
  const cloudPath = DAV_ROOT.replace(/\\/g, "/").replace(/\\/$/, "") + "/" + c + "_" + name;
  const fileUrl = await bot.getFileLink(info.fileId);

  await uploadToDav(fileUrl, cloudPath, info.size);

  const { error } = await db.from("resources").insert({
    code: c,
    file_name: name,
    cloud_path: cloudPath,
    file_size: info.size,
    uploader_id: msg.from?.id || null
  });
  if (error) {
    try { await deleteFromDav(cloudPath); } catch (_) {}
    throw error;
  }
  return { ...info, code: c, cloudPath };
}

async function findResource(c) {
  const { data, error } = await db.from("resources")
    .select("*").eq("code", c.toUpperCase()).eq("status", "active").maybeSingle();
  if (error) throw error;
  return data;
}

async function sendResource(chatId, resource) {
  const response = await axios.get(davUrl(resource.cloud_path), {
    auth: { username: DAV_USERNAME, password: DAV_PASSWORD },
    responseType: "stream",
    timeout: 120000
  });

  await bot.sendDocument(chatId, response.data, {
    caption: "🔑 取件码：" + resource.code + "\n📄 " + resource.file_name
  }, {
    filename: resource.file_name,
    contentType: response.headers["content-type"] || "application/octet-stream"
  });

  await db.from("resources").update({ downloads: (resource.downloads || 0) + 1 }).eq("id", resource.id);
}

async function adminStats(chatId) {
  const { count, error } = await db.from("resources")
    .select("*", { count: "exact", head: true }).eq("status", "active");
  if (error) throw error;
  const { data } = await db.from("resources")
    .select("downloads").eq("status", "active");
  const downloads = (data || []).reduce((n, x) => n + Number(x.downloads || 0), 0);
  await bot.sendMessage(chatId,
    "🛠 管理中心\n\n" +
    "📦 有效资源：" + (count || 0) + "\n" +
    "📥 总下载：" + downloads + "\n\n" +
    "可用命令：\n" +
    "/search 关键词\n" +
    "/delete 取件码\n" +
    "/resource 取件码"
  );
}

bot.onText(/^\/start$/, async msg => {
  await bot.sendMessage(msg.chat.id,
    "👋 欢迎使用 " + BOT_NAME + "\n\n" +
    "📤 直接发送文件，机器人会保存到 123 云盘并生成取件码。\n" +
    "🔑 发送取件码即可取回资源。",
    menu(isAdmin(msg))
  );
});

bot.onText(/^\/admin$/, async msg => {
  if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, "⛔ 无管理员权限");
  await adminStats(msg.chat.id);
});

bot.onText(/^\/resource\\s+([A-Za-z0-9]+)$/i, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const r = await findResource(m[1]);
  if (!r) return bot.sendMessage(msg.chat.id, "❌ 未找到资源");
  await bot.sendMessage(msg.chat.id,
    "📦 资源详情\n\n" +
    "🔑 取件码：" + r.code + "\n" +
    "📄 文件：" + r.file_name + "\n" +
    "📏 大小：" + r.file_size + "\n" +
    "📥 下载：" + r.downloads + "\n" +
    "📌 状态：" + r.status + "\n" +
    "🕒 创建：" + r.created_at
  );
});

bot.onText(/^\/search\\s+(.+)$/i, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const q = m[1].trim();
  const { data, error } = await db.from("resources")
    .select("code,file_name,file_size,downloads,status")
    .or("code.ilike.%" + q + "%,file_name.ilike.%" + q + "%")
    .order("created_at", { ascending: false }).limit(20);
  if (error) return bot.sendMessage(msg.chat.id, "❌ 搜索失败");
  if (!data?.length) return bot.sendMessage(msg.chat.id, "🔎 没有找到资源");
  await bot.sendMessage(msg.chat.id,
    "🔎 搜索：" + q + "\n\n" +
    data.map((r,i) => (i+1) + ". " + r.code + " · " + r.file_name + " · 下载 " + r.downloads).join("\n")
  );
});

bot.onText(/^\/delete\\s+([A-Za-z0-9]+)$/i, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const r = await findResource(m[1]);
  if (!r) return bot.sendMessage(msg.chat.id, "❌ 未找到资源");
  try { await deleteFromDav(r.cloud_path); } catch (_) {}
  await db.from("resources").update({ status: "deleted" }).eq("id", r.id);
  await bot.sendMessage(msg.chat.id, "🗑 已删除：" + r.code);
});

bot.on("message", async msg => {
  if (msg.text?.startsWith("/")) return;
  if (msg.text === "📖 使用说明") {
    return bot.sendMessage(msg.chat.id,
      "📖 使用方法\n\n" +
      "1️⃣ 发送文件 → 自动保存到 123 云盘\n" +
      "2️⃣ 获取 6 位取件码\n" +
      "3️⃣ 把取件码发送给机器人 → 自动取回文件"
    );
  }
  if (msg.text === "🛠 管理中心") {
    if (isAdmin(msg)) return adminStats(msg.chat.id);
    return bot.sendMessage(msg.chat.id, "⛔ 无管理员权限");
  }
  if (msg.text === "🔑 输入取件码") {
    return bot.sendMessage(msg.chat.id, "请输入 6 位取件码，例如：K8F3X9");
  }
  if (msg.text === "📤 上传资源") {
    return bot.sendMessage(msg.chat.id, "📤 请直接发送文件给我。");
  }

  const info = await getFileInfo(msg);
  if (info) {
    await bot.sendMessage(msg.chat.id, "⏳ 正在保存资源，请稍候...");
    try {
      const r = await saveResource(msg);
      return bot.sendMessage(msg.chat.id,
        "✅ 保存成功\n\n" +
        "📄 " + r.fileName + "\n" +
        "🔑 取件码：" + r.code + "\n\n" +
        "把这个取件码发送给机器人即可取回。"
      );
    } catch (e) {
      console.error("UPLOAD ERROR:", e?.response?.data || e);
      return bot.sendMessage(msg.chat.id, "❌ 保存失败，请检查 123 云盘 WebDAV 和机器人配置。");
    }
  }

  if (msg.text && /^[A-Za-z0-9]{6}$/.test(msg.text.trim())) {
    try {
      const r = await findResource(msg.text.trim());
      if (!r) return bot.sendMessage(msg.chat.id, "❌ 取件码不存在或资源已失效。");
      await bot.sendMessage(msg.chat.id, "⏳ 正在取回：" + r.file_name);
      await sendResource(msg.chat.id, r);
    } catch (e) {
      console.error("DOWNLOAD ERROR:", e?.response?.data || e);
      await bot.sendMessage(msg.chat.id, "❌ 取回失败，请稍后再试。");
    }
  }
});

ensureDavRoot()
  .then(() => bot.getMe())
  .then(me => console.log("Bot started:", me.username))
  .catch(err => {
    console.error("Startup check failed:", err.message);
    process.exit(1);
  });
