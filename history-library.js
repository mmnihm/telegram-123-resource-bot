function folderFromFilename(fileName) {
  const raw = String(fileName || "").trim();
  if (!raw) return "未分类";

  const slash = raw.replace(/\\/g, "/");
  if (slash.includes("/")) {
    const first = slash.split("/").filter(Boolean)[0];
    if (first) return cleanFolder(first);
  }

  const base = raw.replace(/\.[^.]+$/, "").trim();
  const patterns = [
    /^【([^】]+)】/,
    /^\[([^\]]+)\]/,
    /^\(([^)]+)\)/,
    /^（([^）]+)）/
  ];
  for (const re of patterns) {
    const m = base.match(re);
    if (m?.[1]) return cleanFolder(m[1]);
  }

  const parts = base.split(/\s+[-–—｜|]\s+|__+/).map(x => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].length >= 2 && parts[0].length <= 60) {
    return cleanFolder(parts[0]);
  }

  return "未分类";
}

function cleanFolder(value) {
  return String(value || "未分类")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "未分类";
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, m => "\\" + m);
}

async function listHistoryFolders(db, limit = 80) {
  const { data, error } = await db
    .from("resources")
    .select("folder_name")
    .eq("resource_type", "history")
    .neq("status", "deleted")
    .order("folder_name", { ascending: true })
    .limit(5000);
  if (error) throw error;

  const seen = new Set();
  const folders = [];
  for (const row of data || []) {
    const name = row.folder_name || "未分类";
    if (seen.has(name)) continue;
    seen.add(name);
    folders.push(name);
    if (folders.length >= limit) break;
  }
  return folders;
}

async function listHistoryFiles(db, folder, limit = 50) {
  const { data, error } = await db
    .from("resources")
    .select("id,folder_name,file_name,file_size,relay_chat_id,relay_message_id")
    .eq("resource_type", "history")
    .eq("folder_name", folder)
    .neq("status", "deleted")
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function searchHistoryFiles(db, query, limit = 30) {
  const q = escapeLike(query.trim());
  if (!q) return [];
  const { data, error } = await db
    .from("resources")
    .select("id,folder_name,file_name,file_size,relay_chat_id,relay_message_id")
    .eq("resource_type", "history")
    .neq("status", "deleted")
    .or("file_name.ilike.%" + q + "%,folder_name.ilike.%" + q + "%")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getHistoryFile(db, id) {
  const { data, error } = await db
    .from("resources")
    .select("*")
    .eq("id", Number(id))
    .eq("resource_type", "history")
    .neq("status", "deleted")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function sendHistoryFile(bot, chatId, resource) {
  const relayChatId = String(resource?.relay_chat_id || "");
  const relayMessageId = Number(resource?.relay_message_id || 0);
  if (!relayChatId || !relayMessageId) {
    throw new Error("历史资源缺少 Telegram 原消息记录");
  }

  const response = await bot._request("copyMessage", {
    form: {
      chat_id: chatId,
      from_chat_id: relayChatId,
      message_id: relayMessageId
    }
  });

  if (!response?.ok) {
    throw new Error(response?.description || "Telegram 原文件发送失败");
  }
  return response.result;
}

module.exports = {
  folderFromFilename,
  listHistoryFolders,
  listHistoryFiles,
  searchHistoryFiles,
  getHistoryFile,
  sendHistoryFile
};
