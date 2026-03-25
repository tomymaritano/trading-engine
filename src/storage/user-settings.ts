import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("user-settings");

/**
 * User Settings — persisted to disk as JSON.
 *
 * Survives engine restarts and works from any PC
 * (settings live on the server, not the browser).
 *
 * The dashboard fetches settings on connect and
 * saves changes via the Control API.
 */

export interface UserSettings {
  // Trading
  tradeSize: number;
  leverage: number;
  mode: "paper" | "live";
  liveExchange: string;
  walletAddress: string;

  // Profiles
  riskProfile: string;
  signalProfile: string;
  activePreset: string;

  // AI
  aiEnabled: boolean;

  // Strategies
  disabledStrategies: string[];

  // UI preferences
  chartTimeframe: number;
  theme: "dark" | "light";
}

const DEFAULT_SETTINGS: UserSettings = {
  tradeSize: 200,
  leverage: 1,
  mode: "paper",
  liveExchange: "none",
  walletAddress: "",
  riskProfile: "moderate",
  signalProfile: "balanced",
  activePreset: "recommended",
  aiEnabled: true,
  disabledStrategies: [],
  chartTimeframe: 5,
  theme: "dark",
};

const SETTINGS_DIR = "data";
const SETTINGS_FILE = join(SETTINGS_DIR, "user-settings.json");

let currentSettings: UserSettings = { ...DEFAULT_SETTINGS };

/** Load settings from disk (called once at startup) */
export function loadUserSettings(): UserSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = readFileSync(SETTINGS_FILE, "utf-8");
      const saved = JSON.parse(raw);
      currentSettings = { ...DEFAULT_SETTINGS, ...saved };
      log.info("User settings loaded from disk");
    } else {
      log.info("No saved settings, using defaults");
    }
  } catch (err) {
    log.warn({ err }, "Failed to load settings, using defaults");
  }
  return currentSettings;
}

/** Get current settings */
export function getUserSettings(): UserSettings {
  return { ...currentSettings };
}

/** Update settings and persist to disk */
export function updateUserSettings(update: Partial<UserSettings>): UserSettings {
  currentSettings = { ...currentSettings, ...update };

  try {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2));
    log.debug("Settings saved to disk");
  } catch (err) {
    log.warn({ err }, "Failed to save settings");
  }

  return currentSettings;
}
