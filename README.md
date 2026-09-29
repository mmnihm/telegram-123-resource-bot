# telegram-123-resource-bot

Telegram 资源取件码机器人：**Telegram → 123 云盘 WebDAV → Supabase → 取件码取回**。

## 已实现

- 📤 用户发送文件后自动上传到 123 云盘 WebDAV
- 🔑 自动生成 6 位唯一取件码
- 🗄️ Supabase 保存取件码、文件名、云盘路径、大小、下载次数、状态
- 📥 用户发送取件码后取回文件
- 🛠 管理员统计、搜索、查看资源、删除资源
- 👤 ADMIN_IDS 支持 Telegram 数字 ID 或 @username
- 🔍 MTProto 扫描 Telegram 频道/群历史消息
- 📂 根据文件名特征自动建立历史资源文件夹
- 🔎 用户端资源目录、关键词搜索、内联按钮
- 📄 点击搜索结果直接从 Telegram 原仓库复制原文件，不下载到服务器

## 文件

- `index.js`：机器人主程序
- `package.json`：Node.js 依赖
- `.env.example`：环境变量模板
- `supabase/schema.sql`：数据库表结构
- `history-library.js`：历史资源文件夹、搜索和原文件取件模块

## Supabase

在 Supabase SQL Editor 执行 `supabase/schema.sql`。

## 环境变量

```text
BOT_TOKEN=
ADMIN_IDS=

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

DAV_URL=
DAV_USERNAME=
DAV_PASSWORD=
DAV_ROOT=/telegram-resource-bot

# MTProto 历史资源扫描（用户账号，不是机器人 Token）
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=
```

## 管理命令

```
/admin
/search 关键词
/resource 取件码
/delete 取件码
```

## 启动

```bash
npm install
npm start
```

## 下一步

先在 Supabase SQL Editor 执行最新版 `supabase/schema.sql`，再配置 MTProto 三项变量并点击「🛠 管理中心 → 🔍 扫描历史资源」。

历史资源扫描只保存消息 ID、文件名、文件夹等索引，不下载历史文件；用户点击资源后，机器人通过 Telegram `copyMessage` 从原仓库直接复制给用户。

> 注意：Telegram Bot API、部署平台和 123 云盘 WebDAV 各自可能存在文件大小、超时或网络限制。大文件支持需要根据实际部署环境继续优化。
