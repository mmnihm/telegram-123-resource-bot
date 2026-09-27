# telegram-123-resource-bot

Telegram 资源取件码机器人：**Telegram → 123 云盘 WebDAV → Supabase → 取件码取回**。

## 已实现

- 📤 用户发送文件后自动上传到 123 云盘 WebDAV
- 🔑 自动生成 6 位唯一取件码
- 🗄️ Supabase 保存取件码、文件名、云盘路径、大小、下载次数、状态
- 📥 用户发送取件码后取回文件
- 🛠 管理员统计、搜索、查看资源、删除资源
- 👤 ADMIN_IDS 支持 Telegram 数字 ID 或 @username

## 文件

- `index.js`：机器人主程序
- `package.json`：Node.js 依赖
- `.env.example`：环境变量模板
- `supabase/schema.sql`：数据库表结构

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

先完成数据库和环境变量配置，再进行真实的 123 云盘上传/取件测试。

> 注意：Telegram Bot API、部署平台和 123 云盘 WebDAV 各自可能存在文件大小、超时或网络限制。大文件支持需要根据实际部署环境继续优化。
