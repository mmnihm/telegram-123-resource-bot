require("dotenv").config();

require("dotenv").config();

// Render Web Service 需要一个 HTTP 端口保持服务健康。
// Telegram Bot 仍然使用 polling，不影响原有机器人逻辑。
const http = require("http");
const PORT = Number(process.env.PORT || 10000);
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("OK");
});
healthServer.listen(PORT, "0.0.0.0", () => {
  console.log("Health server listening on port " + PORT);
});

const TelegramBot = require("node-telegram-bot-api");