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

async function getOrCreateFolder(db, name) {
  const folderName = cleanFolder(name);

  const { data: existing, error: existingError } = await db
    .from("folders")
    .select("id,name,status")
    .eq("name", folderName)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing;

  const { data, error } = await db
    .from("folders")
    .insert({ name: folderName, status: "active" })
    .select("id,name,status")
    .single();

  if (!error) return data;

  // 多个机器人/扫描任务同时创建同名目录时，唯一索引可能发生竞争；重新读取即可。
  const { data: retry, error: retryError } = await db
    .from("folders")
    .select("id,name,status")
    .eq("name", folderName)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (retryError) throw retryError;
  if (retry) return retry;
  throw error;
}

async function backfillHistoryFolders(db, limit = 5000) {
  const { data, error } = await db
    .from("resources")
    .select("id,file_name,folder_name,folder_id")
    .eq("resource_type", "history")
    .neq("status", "deleted")
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const cache = new Map();

  for (const row of data || []) {
    const next = folderFromFilename(row.file_name);
    const name = cleanFolder(next);
    let folder = cache.get(name);

    if (!folder) {
      folder = await getOrCreateFolder(db, name);
      cache.set(name, folder);
    }

    const updates = {};
    if ((row.folder_name || "未分类") !== name) updates.folder_name = name;
    if (Number(row.folder_id || 0) !== Number(folder.id)) updates.folder_id = folder.id;

    if (Object.keys(updates).length) {
      const { error: updateError } = await db
        .from("resources")
        .update(updates)
        .eq("id", row.id);
      if (updateError) throw updateError;
    }
  }

  return cache.size;
}

async function listHistoryFolders(db, limit = 80) {
  const { data, error } = await db
    .from("folders")
    .select("id,name,sort_order")
    .eq("status", "active")
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function listHistoryFiles(db, folder, limit = 50) {
  const { data, error } = await db
    .from("resources")
    .select("id,folder_id,folder_name,file_name,file_size,relay_chat_id,relay_message_id")
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

  return bot.copyMessage(chatId, relayChatId, relayMessageId);
}

module.exports = {
  folderFromFilename,
  cleanFolder,
  getOrCreateFolder,
  backfillHistoryFolders,
  listHistoryFolders,
  listHistoryFiles,
  searchHistoryFiles,
  getHistoryFile,
  sendHistoryFile
};
