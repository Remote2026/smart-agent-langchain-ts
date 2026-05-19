import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("smartthings-auth.ts");

const TOKEN_URL = "https://cn-auth2.samsungosp.com.cn/auth/oauth2/token";
const ENV_PATH = path.resolve(process.cwd(), ".env");

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** Expand leading ~ to os.homedir() */
function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === "~") {
    return os.homedir();
  }
  return p;
}

/**
 * Call Samsung OAuth2 endpoint to refresh tokens.
 * Returns new access_token and refresh_token.
 */
export async function refreshSmartThingsTokens(
  refreshToken: string,
  clientId: string
): Promise<TokenResponse> {
  const data = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: data.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  const result = (await response.json()) as TokenResponse;
  log.info("refreshSmartThingsTokens", "Tokens refreshed successfully");
  return result;
}

/**
 * Update .env file with new SmartThings tokens.
 * Replaces SMARTTHINGS_ACCESS_TOKEN and SMARTTHINGS_REFRESH_TOKEN values.
 * Removes SMARTTHINGS_PAT if present.
 */
export function updateEnvTokens(
  accessToken: string,
  refreshToken: string
): void {
  let envContent = "";
  try {
    envContent = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    log.warn("updateEnvTokens", ".env not found, will create new one");
  }

  const lines = envContent.split("\n");
  const newLines: string[] = [];
  let hasAccessToken = false;
  let hasRefreshToken = false;

  for (const line of lines) {
    if (line.startsWith("SMARTTHINGS_PAT=")) {
      continue;
    }
    if (line.startsWith("SMARTTHINGS_ACCESS_TOKEN=")) {
      newLines.push(`SMARTTHINGS_ACCESS_TOKEN=${accessToken}`);
      hasAccessToken = true;
      continue;
    }
    if (line.startsWith("SMARTTHINGS_REFRESH_TOKEN=")) {
      newLines.push(`SMARTTHINGS_REFRESH_TOKEN=${refreshToken}`);
      hasRefreshToken = true;
      continue;
    }
    newLines.push(line);
  }

  if (!hasAccessToken) {
    newLines.push(`SMARTTHINGS_ACCESS_TOKEN=${accessToken}`);
  }
  if (!hasRefreshToken) {
    newLines.push(`SMARTTHINGS_REFRESH_TOKEN=${refreshToken}`);
  }

  fs.writeFileSync(ENV_PATH, newLines.join("\n") + "\n", "utf-8");
  log.info("updateEnvTokens", ".env updated with new tokens");
}

/**
 * Update SmartThings CLI config file with new access token.
 * Replaces token values under both 'default' and 'client' sections.
 */
export function updateCliConfigToken(accessToken: string): void {
  const cliConfigPath = expandHome(
    process.env.SMARTTHINGS_CLI_CONFIG_PATH ?? "~/.config/@smartthings/cli/config.yaml"
  );
  let configContent = "";
  try {
    configContent = fs.readFileSync(cliConfigPath, "utf-8");
  } catch {
    throw new Error(`SmartThings CLI config not found at ${cliConfigPath}`);
  }

  const updatedContent = configContent.replace(
    /^(\s+token:)\s*.+$/gm,
    `$1 ${accessToken}`
  );

  fs.writeFileSync(cliConfigPath, updatedContent, "utf-8");
  log.info("updateCliConfigToken", "CLI config updated with new token");
}

/**
 * Full token refresh flow:
 * 1. Call OAuth2 endpoint to get new tokens
 * 2. Update .env file
 * 3. Update CLI config file
 */
export async function refreshAndSaveTokens(
  refreshToken: string,
  clientId: string
): Promise<TokenResponse> {
  const tokens = await refreshSmartThingsTokens(refreshToken, clientId);
  updateEnvTokens(tokens.access_token, tokens.refresh_token);
  updateCliConfigToken(tokens.access_token);

  process.env.SMARTTHINGS_ACCESS_TOKEN = tokens.access_token;
  process.env.SMARTTHINGS_REFRESH_TOKEN = tokens.refresh_token;
  delete process.env.SMARTTHINGS_PAT;

  return tokens;
}
