import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import {
  refreshSmartThingsTokens,
  updateEnvTokens,
  updateCliConfigToken,
  refreshAndSaveTokens,
} from "./smartthings-auth.js";

vi.mock("fs");
vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("smartthings-auth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("refreshSmartThingsTokens", () => {
    it("returns tokens on successful refresh", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      });

      const result = await refreshSmartThingsTokens("old-refresh", "client-id");

      expect(result.access_token).toBe("new-access");
      expect(result.refresh_token).toBe("new-refresh");
      expect(result.expires_in).toBe(3600);

      const [url, options] = (global.fetch as any).mock.calls[0];
      expect(url).toBe("https://cn-auth2.samsungosp.com.cn/auth/oauth2/token");
      expect(options.method).toBe("POST");
      expect(options.body).toContain("refresh_token=old-refresh");
      expect(options.body).toContain("client_id=client-id");
      expect(options.body).toContain("grant_type=refresh_token");
    });

    it("throws on HTTP error", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "invalid_grant",
      });

      await expect(
        refreshSmartThingsTokens("bad-token", "client-id")
      ).rejects.toThrow("Token refresh failed: 401 Unauthorized - invalid_grant");
    });
  });

  describe("updateEnvTokens", () => {
    it("updates existing tokens in .env", () => {
      const originalEnv =
        "OPENAI_KEY=sk-test\nSMARTTHINGS_ACCESS_TOKEN=old-access\nSMARTTHINGS_REFRESH_TOKEN=old-refresh\nPORT=3000\n";
      vi.mocked(fs.readFileSync).mockReturnValue(originalEnv);

      updateEnvTokens("new-access", "new-refresh");

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenContent = writeCall[1] as string;
      expect(writtenContent).toContain("SMARTTHINGS_ACCESS_TOKEN=new-access");
      expect(writtenContent).toContain("SMARTTHINGS_REFRESH_TOKEN=new-refresh");
      expect(writtenContent).toContain("OPENAI_KEY=sk-test");
      expect(writtenContent).not.toContain("old-access");
      expect(writtenContent).not.toContain("old-refresh");
    });

    it("adds tokens if not present", () => {
      vi.mocked(fs.readFileSync).mockReturnValue("OPENAI_KEY=sk-test\n");

      updateEnvTokens("new-access", "new-refresh");

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenContent = writeCall[1] as string;
      expect(writtenContent).toContain("SMARTTHINGS_ACCESS_TOKEN=new-access");
      expect(writtenContent).toContain("SMARTTHINGS_REFRESH_TOKEN=new-refresh");
    });

    it("removes legacy SMARTTHINGS_PAT", () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        "SMARTTHINGS_PAT=legacy\nSMARTTHINGS_ACCESS_TOKEN=old\n"
      );

      updateEnvTokens("new-access", "new-refresh");

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenContent = writeCall[1] as string;
      expect(writtenContent).not.toContain("SMARTTHINGS_PAT");
    });

    it("creates .env if not exists", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      updateEnvTokens("new-access", "new-refresh");

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenContent = writeCall[1] as string;
      expect(writtenContent).toContain("SMARTTHINGS_ACCESS_TOKEN=new-access");
      expect(writtenContent).toContain("SMARTTHINGS_REFRESH_TOKEN=new-refresh");
    });
  });

  describe("updateCliConfigToken", () => {
    it("replaces token in CLI config YAML", () => {
      const yamlContent = `default:
  token: old-token
client:
  token: old-token
other: value
`;
      vi.mocked(fs.readFileSync).mockReturnValue(yamlContent);
      process.env.SMARTTHINGS_CLI_CONFIG_PATH = "/tmp/cli-config.yaml";

      updateCliConfigToken("new-token");

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const writtenContent = writeCall[1] as string;
      expect(writtenContent).toContain("token: new-token");
      expect((writtenContent.match(/token: new-token/g) || []).length).toBe(2);
      expect(writtenContent).not.toContain("old-token");
    });

    it("throws when CLI config not found", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });
      process.env.SMARTTHINGS_CLI_CONFIG_PATH = "/nonexistent/config.yaml";

      expect(() => updateCliConfigToken("new-token")).toThrow(
        "SmartThings CLI config not found"
      );
    });
  });

  describe("refreshAndSaveTokens", () => {
    it("full flow: fetch → update env → update CLI → update process.env", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      });
      vi.mocked(fs.readFileSync).mockReturnValue("");
      process.env.SMARTTHINGS_CLI_CONFIG_PATH = "/tmp/cli-config.yaml";
      process.env.SMARTTHINGS_PAT = "legacy-pat";

      const result = await refreshAndSaveTokens("old-refresh", "client-id");

      expect(result.access_token).toBe("new-access");
      expect(process.env.SMARTTHINGS_ACCESS_TOKEN).toBe("new-access");
      expect(process.env.SMARTTHINGS_REFRESH_TOKEN).toBe("new-refresh");
      expect(process.env.SMARTTHINGS_PAT).toBeUndefined();

      // Verify env file was written
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });
});
