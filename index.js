"use strict";
require("dotenv").config();
const fs=require("node:fs"), path=require("node:path"), http=require("node:http");
const TelegramBot=require("node-telegram-bot-api");
const Database=require("better-sqlite3");
const TOKEN=String(process.env.BOT_TOKEN||"").trim();

const PORT=Number(process.env.PORT||10000);
const DB_FILE=path.resolve(process.env.DATABASE_FILE||"./data/store.db");
const USERNAME=String(process.env.BOT_USERNAME||"").replace(/^@/,"").trim();
if(!TOKEN) throw Error("缺少环境变量：BOT_TOKEN");
fs.mkdirSync(path.dirname(DB_FILE),{recursive:true});
const db=new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);"+
"CREATE TABLE IF NOT EXISTS batches(code TEXT PRIMARY KEY,owner_id TEXT NOT NULL,file_count INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));"+
"CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL,channel_message_id INTEGER NOT NULL,file_name TEXT NOT NULL DEFAULT 'Telegram 文件',file_size INTEGER NOT NULL DEFAULT 0,media_type TEXT NOT NULL DEFAULT 'file',FOREIGN KEY(code) REFERENCES batches(code));"+
"CREATE INDEX IF NOT EXISTS idx_files_code ON files(code);");
const bot=new TelegramBot(TOKEN,{polling:true});
const pending=new Map(), waiting=new Set(), customCodeWaiting=new Set(), customCodes=new Map(), uploadQueues=new Map(), finalizing=new Set(), binding=new Set();
const getChannel=()=>String(db.prepare("SELECT value FROM settings WHERE key=?").get("storage_channel_id")?.value||"").trim();
const setChannel=id=>db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("storage_channel_id",String(id));
const adminKb={keyboard:[[{text:"📡 绑定/更换存储频道"}],[{text:"🧩 自定义取件码"},{text:"📦 完成保存并生成取件码"}],[{text:"🛠 管理中心"},{text:"📊 存储统计"}],[{text:"🔑 查询取件码"},{text:"📖 使用说明"}]],resize_keyboard:true};
const userKb={keyboard:[[{text:"🔑 查询取件码"},{text:"📖 使用说明"}]],resize_keyboard:true};
const getAdminId=()=>String(db.prepare("SELECT value FROM settings WHERE key=?").get("admin_id")?.value||"").trim();
const isAdmin=m=>m?.from?.id!=null&&getAdminId()===String(m.from.id);
function claimFirstAdmin(m){
 if(!m?.from?.id||m.from.is_bot||m.chat?.type!=="private")return false;
 const result=db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('admin_id',?)").run(String(m.from.id));
 return result.changes===1;
}
const kb=m=>isAdmin(m)?adminKb:userKb;
const {normalizePickupCode,isValidPickupCode,isValidCustomCode,generatePickupCode}=require("./pickup-code");
const validCode=isValidPickupCode;
function newCode(){return generatePickupCode(db);}
function mediaInfo(m){
 if(m.document)return{name:m.document.file_name||"文件",size:+(m.document.file_size||0),type:"document"};
 if(m.video)return{name:m.video.file_name||"视频",size:+(m.video.file_size||0),type:"video"};
 if(m.animation)return{name:m.animation.file_name||"动画",size:+(m.animation.file_size||0),type:"animation"};
 if(m.audio)return{name:m.audio.file_name||m.audio.title||"音频",size:+(m.audio.file_size||0),type:"audio"};
 if(m.voice)return{name:"语音",size:+(m.voice.file_size||0),type:"voice"};
 if(m.video_note)return{name:"视频留言",size:+(m.video_note.file_size||0),type:"video_note"};
 if(m.sticker)return{name:"贴纸",size:+(m.sticker.file_size||0),type:"sticker"};
 if(m.photo?.length){const p=m.photo[m.photo.length-1];return{name:"图片",size:+(p.file_size||0),type:"photo"};}
 return null;
}
function bytes(v){v=Number(v||0);if(v>=1073741824)return(v/1073741824).toFixed(2)+" GB";if(v>=1048576)return(v/1048576).toFixed(2)+" MB";if(v>=1024)return(v/1024).toFixed(1)+" KB";return v?v+" B":"未知";}
function welcome(m){return isAdmin(m)
?"🛠 取件码机器人管理中心\n\n📡 首次启动用户已自动设为管理员。\n📤 直接把文件、图片或视频发给我。\n📦 全部发送完成后点击「完成保存并生成取件码」。\n🔑 默认生成 6 位数字码，也可先设置自定义取件码。\n\n存储：Telegram 私密频道 + SQLite 索引。\n无需 Supabase、123 网盘或 WebDAV。"
:"👋 欢迎使用取件码机器人\n\n点击「🔑 查询取件码」，发送 6 位数字或自定义取件码，机器人会发送对应批次的全部文件。";}
async function start(m,c){await bot.sendMessage(m.chat.id,welcome(m),{reply_markup:kb(m)});if(c&&validCode(c))await deliver(m.chat.id,normalizePickupCode(c));}
async function saveFile(m){
 if(!isAdmin(m)||m.chat.type!=="private")return false;
 const info=mediaInfo(m);if(!info)return false;
 const uid=String(m.from.id);
 const previous=uploadQueues.get(uid)||Promise.resolve();
 const task=previous.catch(()=>{}).then(async()=>{
  try{
   const channel=getChannel();
   if(!channel)throw Error("尚未绑定存储频道，请先点击「📡 绑定/更换存储频道」");
   const copied=await bot.copyMessage(channel,m.chat.id,m.message_id);
   if(!pending.has(uid))pending.set(uid,[]);
   pending.get(uid).push({mid:Number(copied.message_id),name:String(info.name).slice(0,250),size:info.size,type:info.type});
   await bot.sendMessage(m.chat.id,"✅ 已保存到私密频道\n\n📦 本批已接收："+pending.get(uid).length+" 个文件\n📄 当前文件："+info.name+"\n\n全部发送完后点击「📦 完成保存并生成取件码」。",{reply_markup:adminKb});
  }catch(e){
   console.error("STORE ERROR",e.message);
   await bot.sendMessage(m.chat.id,"❌ 保存失败。请确认机器人已加入私密频道并有发布消息权限。\n"+String(e.message||"").slice(0,220));
  }
 });
 uploadQueues.set(uid,task);
 try{await task;}finally{if(uploadQueues.get(uid)===task)uploadQueues.delete(uid);}
 return true;
}
async function finish(m){
 const uid=String(m.from.id);
 if(finalizing.has(uid))return bot.sendMessage(m.chat.id,"⏳ 正在生成取件码，请稍候。");
 finalizing.add(uid);
 try{
  const queue=uploadQueues.get(uid);
  if(queue)await queue.catch(()=>{});
  const items=pending.get(uid)||[];
  if(!items.length)return bot.sendMessage(m.chat.id,"📭 当前没有待生成取件码的文件。",{reply_markup:adminKb});
  const custom=customCodes.get(uid);
  const code=custom||newCode();
  if(!isValidPickupCode(code))return bot.sendMessage(m.chat.id,"⚠️ 自定义取件码格式无效，请重新设置。",{reply_markup:adminKb});
  if(db.prepare("SELECT 1 FROM batches WHERE code=?").get(code))return bot.sendMessage(m.chat.id,"⚠️ 这个取件码已经存在，请换一个自定义取件码。",{reply_markup:adminKb});
  const tx=db.transaction(()=>{
   db.prepare("INSERT INTO batches(code,owner_id,file_count) VALUES(?,?,?)").run(code,uid,items.length);
   const ins=db.prepare("INSERT INTO files(code,channel_message_id,file_name,file_size,media_type) VALUES(?,?,?,?,?)");
   for(const x of items)ins.run(code,x.mid,x.name,x.size,x.type);
  });
  tx();pending.delete(uid);customCodes.delete(uid);
  const link=USERNAME?"\n\n取件链接：https://t.me/"+USERNAME+"?start="+encodeURIComponent(code):"";
  await bot.sendMessage(m.chat.id,"🎉 本批资源保存完成\n\n🔑 取件码："+code+"\n📦 文件数量："+items.length+"\n📏 合计大小："+bytes(items.reduce((n,x)=>n+x.size,0))+link+"\n\n复制取件码发给取件人即可。",{reply_markup:adminKb});
 }finally{finalizing.delete(uid);}
}
async function deliver(chatId,raw){
 const code=normalizePickupCode(raw);
 if(!validCode(code))return bot.sendMessage(chatId,"⚠️ 取件码格式不正确。请发送 6 位数字码或管理员设置的自定义码。",{reply_markup:userKb});
 const channel=getChannel();
 if(!channel)return bot.sendMessage(chatId,"⚠️ 管理员尚未绑定存储频道，请稍后再试。",{reply_markup:userKb});
 const batch=db.prepare("SELECT code FROM batches WHERE code=?").get(code);
 if(!batch)return bot.sendMessage(chatId,"❌ 没有找到这个取件码，请检查是否输入正确。",{reply_markup:userKb});
 const files=db.prepare("SELECT channel_message_id FROM files WHERE code=? ORDER BY id").all(code);
 if(!files.length)return bot.sendMessage(chatId,"⚠️ 该取件码没有可用文件，请联系管理员。");
 await bot.sendMessage(chatId,"📦 找到 "+files.length+" 个文件，正在发送，请稍候……");
 try{
  for(let i=0;i<files.length;i+=100){
   const chunk=files.slice(i,i+100);
   const sent=await bot.copyMessages(chatId,channel,chunk.map(x=>Number(x.channel_message_id)));
   if(!Array.isArray(sent)||sent.length!==chunk.length)throw Error("部分文件没有成功发送");
  }
  await bot.sendMessage(chatId,"✅ 取件完成\n\n🔑 取件码："+code+"\n📦 文件数量："+files.length,{reply_markup:userKb});
 }catch(e){console.error("DELIVERY ERROR",e.message);await bot.sendMessage(chatId,"❌ 发送文件失败，请稍后重试或联系管理员。\n"+String(e.message||"").slice(0,180));}
}
function stats(){
 const batches=db.prepare("SELECT COUNT(*) n FROM batches").get().n;
 const files=db.prepare("SELECT COUNT(*) n FROM files").get().n;
 const size=db.prepare("SELECT COALESCE(SUM(file_size),0) n FROM files").get().n;
 return "🛠 管理中心\n\n📦 取件批次："+batches+"\n📄 文件记录："+files+"\n💾 登记大小："+bytes(size)+"\n\n直接发送文件保存，发送完成后点击「完成保存并生成取件码」。";
}
async function handleChannelBinding(m){
 const uid=String(m.from?.id||"");
 if(!binding.has(uid))return false;
 if(m.text?.trim()==="取消"){binding.delete(uid);await bot.sendMessage(m.chat.id,"已取消频道绑定。",{reply_markup:adminKb});return true;}
 const origin=m.forward_from_chat||m.forward_origin?.chat;
 if(!origin||!origin.id||origin.type!=="channel"){await bot.sendMessage(m.chat.id,"⚠️ 请转发一条来自目标私人频道的原始消息。文字、图片或视频消息都可以；发送「取消」退出。",{reply_markup:adminKb});return true;}
 try{
  const me=await bot.getMe();
  const member=await bot.getChatMember(origin.id,me.id);
  if(!["administrator","creator"].includes(member.status)){await bot.sendMessage(m.chat.id,"❌ 机器人还不是该频道管理员。请先把机器人添加到频道并设为管理员，再重新转发一条频道消息。",{reply_markup:adminKb});return true;}
  setChannel(origin.id);binding.delete(uid);
  await bot.sendMessage(m.chat.id,"✅ 存储频道绑定成功！\\n\\n频道："+(origin.title||"私人频道")+"\\n频道 ID："+origin.id+"\\n\\n现在可以直接把文件发给机器人了。",{reply_markup:adminKb});
 }catch(e){await bot.sendMessage(m.chat.id,"❌ 无法验证频道权限："+String(e.message||"").slice(0,180)+"\\n请确认机器人已加入频道并设为管理员。",{reply_markup:adminKb});}
 return true;
}
async function handleText(m){
 const t=m.text.trim(),admin=isAdmin(m);
 const sm=t.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{4,32}))?$/i);if(sm)return start(m,sm[1]);
 if(/^\/(?:help|usage)(?:@\w+)?$/i.test(t)||t==="📖 使用说明")return bot.sendMessage(m.chat.id,"📖 使用说明\n\n管理员：直接发送文件，可先点击「🧩 自定义本批取件码」设置取件码；完成后点击「📦 完成保存并生成取件码」。默认自动生成 6 位数字码。\n用户：点击「🔑 查询取件码」，再发送取件码。\n文件保存在 Telegram 私密频道，取件码索引保存在 SQLite。",{reply_markup:kb(m)});
 if(t==="🧩 自定义取件码"){if(!admin)return bot.sendMessage(m.chat.id,"⛔ 此功能仅限管理员。");customCodeWaiting.add(String(m.from.id));return bot.sendMessage(m.chat.id,"🧩 请发送你想使用的取件码：4–32 位，只能包含英文字母、数字、下划线和连字符。\n例如：MOVIE_2026\n发送「取消」可放弃设置。",{reply_markup:adminKb});}
 if(customCodeWaiting.has(String(m.from.id))){if(t==="取消"){customCodeWaiting.delete(String(m.from.id));return bot.sendMessage(m.chat.id,"已取消自定义取件码。",{reply_markup:adminKb});}const custom=normalizePickupCode(t);if(!isValidCustomCode(custom))return bot.sendMessage(m.chat.id,"⚠️ 格式不正确。请输入 4–32 位英文、数字、下划线或连字符。");if(db.prepare("SELECT 1 FROM batches WHERE code=?").get(custom))return bot.sendMessage(m.chat.id,"⚠️ 这个取件码已经使用，请换一个。");customCodes.set(String(m.from.id),custom);customCodeWaiting.delete(String(m.from.id));return bot.sendMessage(m.chat.id,"✅ 本批自定义取件码已设置为："+custom+"\n继续发送文件，完成后点击「📦 完成保存并生成取件码」。",{reply_markup:adminKb});}
 if(/^\/(?:admin|stats)(?:@\w+)?$/i.test(t)||t==="🛠 管理中心"||t==="📊 存储统计"){if(!admin)return bot.sendMessage(m.chat.id,"⛔ 此功能仅限管理员。");return bot.sendMessage(m.chat.id,stats()+"\n\n📡 存储频道："+(getChannel()||"尚未绑定"),{reply_markup:adminKb});}
 if(/^\/done(?:@\w+)?$/i.test(t)||t==="📦 完成保存并生成取件码"||t==="完成保存并生成取件码"){if(!admin)return bot.sendMessage(m.chat.id,"⛔ 此功能仅限管理员。");return finish(m);}
 const dm=t.match(/^\/delete(?:@\w+)?\s+([A-Za-z0-9_-]{4,32})$/i);
 if(dm){if(!admin)return bot.sendMessage(m.chat.id,"⛔ 此功能仅限管理员。");db.prepare("DELETE FROM files WHERE code=?").run(normalizePickupCode(dm[1]));const r=db.prepare("DELETE FROM batches WHERE code=?").run(normalizePickupCode(dm[1]));return bot.sendMessage(m.chat.id,r.changes?"🗑 已删除取件码索引；私密频道原文件未删除。":"❌ 没有找到该取件码。",{reply_markup:adminKb});}
 if(t==="📡 绑定/更换存储频道"){if(!admin)return bot.sendMessage(m.chat.id,"⛔ 此功能仅限管理员。");binding.add(String(m.from.id));return bot.sendMessage(m.chat.id,"📡 频道绑定步骤\n\n1. 把机器人添加到目标私人频道并设为管理员，允许发布消息。\n2. 回到频道，选择一条频道消息并转发给我。\n3. 我会自动识别频道并检查机器人权限。\n\n发送「取消」可退出绑定。",{reply_markup:adminKb});}
 if(binding.has(String(m.from.id))){if(t==="取消"){binding.delete(String(m.from.id));return bot.sendMessage(m.chat.id,"已取消频道绑定。",{reply_markup:adminKb});}const origin=m.forward_from_chat||m.forward_origin?.chat;if(origin&&origin.id&&origin.type==="channel"){try{const me=await bot.getMe();const member=await bot.getChatMember(origin.id,me.id);if(!["administrator","creator"].includes(member.status))return bot.sendMessage(m.chat.id,"❌ 机器人还不是该频道管理员。请先把机器人添加到频道并设为管理员，再重新转发一条频道消息。",{reply_markup:adminKb});setChannel(origin.id);binding.delete(String(m.from.id));return bot.sendMessage(m.chat.id,"✅ 存储频道绑定成功！\\n\\n频道："+(origin.title||"私人频道")+"\\n频道 ID："+origin.id+"\\n\\n现在可以直接把文件发给机器人了。",{reply_markup:adminKb});}catch(e){return bot.sendMessage(m.chat.id,"❌ 无法验证频道权限："+String(e.message||"").slice(0,180)+"\\n请确认机器人已加入频道并设为管理员。",{reply_markup:adminKb});}}return bot.sendMessage(m.chat.id,"⚠️ 请转发一条来自目标频道的原始消息，不要复制粘贴文字。",{reply_markup:adminKb});}
 if(t==="🔑 查询取件码"){waiting.add(String(m.from.id));return bot.sendMessage(m.chat.id,"🔑 请发送 6 位数字取件码或自定义取件码。发送「取消」可退出。");}
 if(waiting.has(String(m.from.id))){if(t==="取消"){waiting.delete(String(m.from.id));return bot.sendMessage(m.chat.id,"已取消查询。",{reply_markup:kb(m)});}if(validCode(t)){waiting.delete(String(m.from.id));return deliver(m.chat.id,normalizePickupCode(t));}return bot.sendMessage(m.chat.id,"⚠️ 取件码格式不正确，请重新输入，或发送「取消」。");}
 if(validCode(t))return deliver(m.chat.id,normalizePickupCode(t));
 if(admin)return bot.sendMessage(m.chat.id,"📤 请直接发送文件、图片或视频；发送完后点击「📦 完成保存并生成取件码」。",{reply_markup:adminKb});
 return bot.sendMessage(m.chat.id,"请点击「🔑 查询取件码」，再发送 6 位数字。",{reply_markup:userKb});
}
bot.on("message",async m=>{try{if(m.chat.type!=="private")return;if(!getAdminId()&&/^\/start(?:@\w+)?(?:\s|$)/i.test(m.text||""))claimFirstAdmin(m);if(await handleChannelBinding(m))return;if(m.text)return await handleText(m);if(await saveFile(m))return;}catch(e){console.error("HANDLER ERROR",e.stack||e.message||e);try{await bot.sendMessage(m.chat.id,"⚠️ 操作失败，请稍后重试。");}catch(_){}}});
bot.on("polling_error",e=>console.error("TELEGRAM POLLING ERROR",e?.message||e));
const server=http.createServer((req,res)=>{if(req.url==="/health"||req.url==="/ready"){res.writeHead(200,{"content-type":"application/json; charset=utf-8"});return res.end(JSON.stringify({ok:true,service:"telegram-pickup-bot"}));}res.writeHead(404);res.end("Not found");});
server.listen(PORT,"0.0.0.0",()=>console.log("Pickup bot ready; port="+PORT+"; channel="+(getChannel()||"not-bound")+"; db="+DB_FILE));
async function shutdown(){try{await bot.stopPolling();}catch(_){}try{db.close();}catch(_){}server.close(()=>process.exit(0));}
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
