#!/usr/bin/env node
/**
 * SmartThings设备状态轮询脚本
 * 通过SmartThings CLI定期轮询设备状态，仅当contact值变化时输出
 */

import { execSync } from "child_process";
import process from "node:process";

// 类型定义
interface Device {
    deviceId?: string;
    name?: string;
    label?: string;
    type?: string;
}

interface StatusData {
    [key: string]: {
        value: unknown;
        unit?: string;
    };
}

interface ComponentStatus {
    [capability: string]: StatusData;
}

interface DeviceStatus {
    components?: {
        [componentId: string]: ComponentStatus;
    };
}

interface PollerOptions {
    interval: number;
    listOnly: boolean;
}

/**
 * 执行SmartThings CLI命令并返回JSON结果
 */
function runSmartthingsCommand(args: string[]): Record<string, unknown> | unknown[] | null {
    try {
        const cmd = `smartthings ${args.join(" ")}`;
        const result = execSync(cmd, {
            encoding: "utf-8",
            timeout: 60000,
            stdio: ["pipe", "pipe", "pipe"],
        });

        const output = result.trim();
        if (!output) {
            return null;
        }

        return JSON.parse(output);
    } catch (error) {
        const execError = error as { status?: number; stderr?: string; message?: string };

        if (execError.status === 127 || execError.message?.includes("not found")) {
            console.log("未找到smartthings命令，请确保已安装SmartThings CLI");
            console.log("   安装指南: https://github.com/SmartThingsCommunity/smartthings-cli");
            return null;
        }

        console.log(`命令执行失败: smartthings ${args.join(" ")}`);
        if (execError.stderr?.trim()) {
            console.log(`   错误信息: ${execError.stderr.trim()}`);
        }
        return null;
    }
}

/**
 * 获取当前账户的所有设备列表
 */
function getDevices(): Device[] | null {
    const result = runSmartthingsCommand(["devices", "-j"]);
    if (result === null) {
        return null;
    }

    if (Array.isArray(result)) {
        return result as Device[];
    } else if (typeof result === "object" && result !== null) {
        if ("items" in result) {
            return result.items as Device[];
        }
        return [result as Device];
    }

    return null;
}

/**
 * 获取指定设备的状态
 */
function getDeviceStatus(deviceId: string): DeviceStatus | null {
    const result = runSmartthingsCommand(["devices:status", deviceId, "-j"]);
    return result as DeviceStatus | null;
}

/**
 * 从设备状态中提取main组件的contact值
 * @returns contact值，没有则返回undefined
 */
function extractMainContact(status: DeviceStatus | null): string | null | undefined {
    if (!status?.components) {
        return undefined;
    }

    const mainStatus = status.components["main"];
    if (!mainStatus) {
        return undefined;
    }

    for (const capability of Object.keys(mainStatus)) {
        const attrs = mainStatus[capability];
        if (typeof attrs === "object" && attrs !== null) {
            const contactData = attrs["contact"];
            if (typeof contactData === "object" && contactData !== null && "value" in contactData) {
                const value = (contactData as { value: unknown }).value;
                if (value !== null && value !== undefined) {
                    return String(value);
                }
                return null;
            }
        }
    }
    return undefined;
}

/**
 * 主轮询循环
 */
async function pollLoop(options: PollerOptions): Promise<void> {
    const { interval } = options;

    console.log("=".repeat(60));
    console.log("SmartThings 设备状态监控");
    console.log("=".repeat(60));
    console.log(`轮询间隔: ${interval}秒`);
    console.log("仅输出 contact 值变化");
    console.log("按 Ctrl+C 停止");
    console.log("=".repeat(60));

    // 获取设备列表
    console.log("\n正在获取设备列表...");
    const devices = getDevices();

    if (devices === null) {
        console.log("无法获取设备列表，请检查SmartThings CLI是否正确配置");
        process.exit(1);
    }

    if (devices.length === 0) {
        console.log("当前账户没有发现任何设备");
        process.exit(0);
    }

    console.log(`发现 ${devices.length} 个设备:`);
    devices.forEach((device, index) => {
        const name = device.label || device.name || "未知";
        const deviceId = device.deviceId || "";
        console.log(`   ${index + 1}. ${name} (ID: ${deviceId.substring(0, 8)}...)`);
    });

    // 存储上一次的main组件contact值: Map<deviceId, contactValue>
    const previousContacts = new Map<string, string | null | undefined>();
    let pollCount = 0;
    let isFirstPoll = true;

    console.log("\n" + "=".repeat(60));
    console.log("开始监控 main 组件 contact 变化...");
    console.log("=".repeat(60));

    // 注册退出处理
    process.on("SIGINT", () => {
        console.log("\n\n轮询已停止");
        console.log(`总共执行了 ${pollCount} 次轮询`);
        process.exit(0);
    });

    // 轮询循环
    while (true) {
        try {
            pollCount++;
            const timestamp = new Date().toLocaleString("zh-CN", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });

            console.log(`\n[${timestamp}] 第 ${pollCount} 次轮询`);
            console.log("-".repeat(40));

            for (const device of devices) {
                const deviceId = device.deviceId;
                if (!deviceId) {
                    continue;
                }

                const status = getDeviceStatus(deviceId);
                const currentContact = extractMainContact(status);

                if (currentContact === undefined) {
                    continue;
                }

                const deviceName = device.name || "未知设备";
                const deviceLabel = device.label || deviceName;
                const prevContact = previousContacts.get(deviceId);

                // 检测变化
                if (!isFirstPoll && prevContact !== undefined && prevContact !== currentContact) {
                    console.log(`device name: ${deviceLabel} (${deviceName})`);
                    console.log(`device id: ${deviceId}`);
                    console.log(`contact status: ${prevContact} -> ${currentContact} *** CHANGED ***`);
                    console.log("-".repeat(40));
                    ///发送信息到Openclaw
                    ///占位 - 这里可以添加发送到Openclaw的代码，例如调用API或执行其他操作
                } else {
                    console.log(`device name: ${deviceLabel} (${deviceName})`);
                    console.log(`device id: ${deviceId}`);
                    console.log(`contact status: ${currentContact}`);
                    console.log("-".repeat(40));
                }

                previousContacts.set(deviceId, currentContact);
            }

            if (isFirstPoll) {
                isFirstPoll = false;
            }

            // 等待下次轮询
            await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        } catch (error) {
            console.log(`\n轮询过程中发生错误: ${error}`);
            await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        }
    }
}

/**
 * 解析命令行参数
 */
function parseArgs(): PollerOptions {
    const args = process.argv.slice(2);
    const options: PollerOptions = {
        interval: 15,
        listOnly: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-i" || arg === "--interval") {
            const value = args[++i];
            if (value) {
                options.interval = parseInt(value, 10);
            }
        } else if (arg === "--list-only") {
            options.listOnly = true;
        } else if (arg === "-h" || arg === "--help") {
            console.log("SmartThings设备状态监控脚本");
            console.log("");
            console.log("用法: npx ts-node 1.ts [选项]");
            console.log("");
            console.log("选项:");
            console.log("  -i, --interval <秒>  轮询间隔（默认15秒）");
            console.log("  --list-only          仅列出设备，不进行轮询");
            console.log("  -h, --help           显示帮助信息");
            process.exit(0);
        }
    }

    return options;
}

/**
 * 主函数
 */
async function main(): Promise<void> {
    const options = parseArgs();

    if (options.listOnly) {
        console.log("正在获取设备列表...");
        const devices = getDevices();
        if (devices && devices.length > 0) {
            console.log(`\n发现 ${devices.length} 个设备:`);
            devices.forEach((device, index) => {
                const name = device.label || device.name || "未知";
                const deviceId = device.deviceId || "";
                const deviceType = device.type || "未知类型";
                console.log(`  ${index + 1}. ${name}`);
                console.log(`     类型: ${deviceType}`);
                console.log(`     ID: ${deviceId}`);
            });
        } else {
            console.log("未发现任何设备或获取失败");
        }
        return;
    }

    await pollLoop(options);
}

// 运行主函数
main().catch((error) => {
    console.error("程序异常退出:", error);
    process.exit(1);
});
