import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");

export interface SkillConfig {
  [key: string]: unknown;
}

/**
 * 读取 Skill 的业务规则配置文件（单一事实来源）
 *
 * @param skillName - skill 名称（如 "prd-thinking"）
 * @param configFile - 配置文件名（默认 "constraints.json"）
 * @returns 配置对象
 */
export function readSkillConfig(skillName: string, configFile = "constraints.json"): SkillConfig {
  const configPath = path.join(SKILLS_DIR, skillName, "references", configFile);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Skill 配置文件不存在: ${configPath}`);
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`解析 Skill 配置失败: ${configPath}, ${error}`);
  }
}

/**
 * 读取 Skill 的 schema.json（用于类型校验）
 */
export function readSkillSchema(skillName: string): Record<string, unknown> {
  const schemaPath = path.join(SKILLS_DIR, skillName, "schema.json");

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Skill schema 不存在: ${schemaPath}`);
  }

  try {
    const content = fs.readFileSync(schemaPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`解析 Skill schema 失败: ${schemaPath}, ${error}`);
  }
}
