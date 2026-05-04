/**
 * 直接调用 SmartThings REST API 获取设备列表（对应 curl 示例）。
 *
 * 参考：
 * ```bash
 * curl -X GET "https://api.smartthings.com/v1/devices" \
 *   -H "Authorization: Bearer $SMARTTHINGS_TOKEN"
 * ```
 *
 * 运行方式：
 *   npx tsx test.ts
 *
 * 依赖：
 * - 在根目录 `.env` 里配置 `SMARTTHINGS_TOKEN=...`
 *   - 兼容：若未设置 SMARTTHINGS_TOKEN，则回退使用 SMARTTHINGS_PAT
 */
import "dotenv/config";
import { loadAppConfig } from "./src/config.js";

const token = process.env.SMARTTHINGS_TOKEN ?? process.env.SMARTTHINGS_PAT;
if (!token) {
  console.error("Missing env var: SMARTTHINGS_TOKEN (or SMARTTHINGS_PAT).");
  process.exit(1);
}
import { exec } from 'child_process';

const command = `curl -X GET "https://api.smartthings.com/v1/devices" -H "Authorization: Bearer ${token}"`;

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error(`执行错误: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`标准错误: ${stderr}`);
  }
  const devices = JSON.parse(stdout);
  console.log('设备列表:', devices);
});