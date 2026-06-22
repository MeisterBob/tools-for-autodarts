import { type IGameData, GameMode } from "@/utils/game-data-storage";
import { AutodartsToolsGameData } from "@/utils/game-data-storage";
const log = createLogger("GameDataProcessor", { debug: false })

/**
 * # GameDataProcessor Documentation
 *
 * ## Overview
 * The GameDataProcessor is a centralized event system that monitors game state changes and derives
 * "triggers" (named events) from game data. Multiple modules can subscribe to these triggers to react
 * to game events (e.g., animations, sounds, WLED effects).
 *
 * ## How It Works
 *
 * ### Initialization Phase
 * 1. Call `initGameDataProcessor()` once during extension startup (typically in a content script or background)
 * 2. This watches the IndexedDB game data store and detects changes
 * 3. When game data changes, triggers are automatically derived and dispatched to all registered callbacks
 *
 * ### Trigger Derivation
 * When game data updates, the processor analyzes the current and previous game state to derive triggers:
 * - **Match events**: matchshot, gameshot, bulloff
 * - **Player events**: player names, bot detection, gameon, next_player
 * - **Throw events**: individual throws (s20, d10), combined throws (s1_d20_b), busted, outside
 * - **Score events**: total points (50), remaining points (yr_170), checkouts
 * - **Variant-specific**: Cricket misses, ATC targets, RTW fields, Shanghai, Bob's 27
 *
 * ### Priority System
 * Each trigger has a priority level (higher number = higher priority, plays first):
 * - 100: Matchshot variant (player-specific)
 * - 99:  Matchshot
 * - 90:  Gameshot variant
 * - 89:  Gameshot
 * - 80:  Busted
 * - 70:  Player name / bot
 * - 60:  Combined throws (e.g., s1_d20_b)
 * - 50:  Point total (e.g., 50)
 * - 40:  Remaining points
 * - 30:  Individual throw (e.g., s20, d10)
 * - 25:  Throw
 * - 20:  Board events
 * - 10:  Fallback/other
 *
 * ## How to Use
 *
 * ### For Vue Components
 * Use the `useGameDataProcessor()` composable hook in `<script setup>`:
 *
 * ```typescript
 * import { useGameDataProcessor, type GameDataCallback } from "@/composables/useGameDataProcessor";
 *
 * const handleTriggers: GameDataCallback = (triggers, gameData, oldGameData, fromWebSocket) => {
 *   console.log("Received triggers:", triggers);
 *   // React to triggers here
 * };
 *
 * // Register with default priority (descending - highest priority first)
 * useGameDataProcessor("my-module", handleTriggers);
 *
 * // Or customize priority order and override specific trigger priorities
 * useGameDataProcessor("my-module", handleTriggers, {
 *   sortOrder: "asc",  // "desc" (default) or "asc"
 *   priorityOverrides: {
 *     "matchshot": 95,  // Play matchshot before gameshot
 *     "s20": 75         // Play s20 before busted
 *   }
 * });
 * ```
 *
 * Automatically unregisters on component unmount.
 *
 * ### For Non-Vue Modules
 * Call the functions directly:
 *
 * ```typescript
 * import {
 *   initGameDataProcessor,
 *   registerGameDataCallback,
 *   unregisterGameDataCallback,
 *   type GameDataCallback
 * } from "@/composables/useGameDataProcessor";
 *
 * // Initialize once
 * await initGameDataProcessor();
 *
 * // Register callback
 * const callback: GameDataCallback = (triggers, gameData, oldGameData, fromWebSocket) => {
 *   triggers.forEach(trigger => {
 *     console.log(`Trigger: ${trigger.trigger} (priority: ${trigger.priority})`);
 *   });
 * };
 * registerGameDataCallback("my-module", callback);
 *
 * // Cleanup when done
 * unregisterGameDataCallback("my-module");
 * cleanupGameDataProcessor();
 * ```
 *
 * ## Callback Parameters
 * The callback receives:
 * - **triggers**: Array of `IGameTrigger` objects sorted by priority (highest priority first by default)
 * - **gameData**: Current game state
 * - **oldGameData**: Previous game state (for detecting changes)
 * - **fromWebSocket**: Boolean indicating if update came from WebSocket (live) or storage sync
 *
 * ## Trigger Categories
 * Triggers are organized into categories for filtering:
 * - `match`: matchshot, gameshot, bulloff
 * - `throw`: individual throws, combined throws, busted
 * - `total`: total points of a turn
 * - `remaining`: remaining points in a leg
 * - `player`: player names, bot detection, turn transitions
 * - `board`: external board events
 * - `other`: miscellaneous triggers
 */

/**
 * Represents a trigger with priority information
 * Higher priority number = higher priority (more important to play)
 */
export interface IGameTrigger {
  trigger: string;
  priority: number;
  category: TRIGGER_CATEGORIES;
}

/**
 * Callback signature for modules that want to receive triggers
 * @param triggers - Array of triggers sorted by priority (descending - highest priority first)
 * @param gameData - Current game data
 * @param oldGameData - Previous game data
 * @param fromWebSocket - Whether update came from WebSocket
 */
export type GameDataCallback = (
  triggers: IGameTrigger[],
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean,
) => void | Promise<void>;

let oldTriggers: IGameTrigger[] = [];

/** Sort order for trigger priority */
export type TriggerSortOrder = "asc" | "desc";

/** Options for registering a callback with priority customization */
export interface CallbackOptions {
  /** Sort order: "desc" (higher priority first, default) or "asc" (lower priority first) */
  sortOrder?: TriggerSortOrder;
  /** Override priority values for specific triggers. Keys are trigger names or TRIGGER_PRIORITIES enum values */
  priorityOverrides?: Record<string | number, number>;
}

/** Priority categories */
export enum TRIGGER_CATEGORIES {
  MATCH = "match",
  THROW = "throw",
  TOTAL = "total",
  REMAINING = "remaining",
  PLAYER = "player",
  BOARD = "board",
  OTHER = "other"
};

/** Priority levels (higher = higher priority) */
export enum TRIGGER_PRIORITIES {
  OTHER = 10,               // Fallback triggers
  BOARD_EVENT = 20,         // Board events
  THROW = 25,               // throw
  INDIVIDUAL_THROW = 30,    // Single throw (s1, d20, etc)
  POINT_REMAINING = 40,     // Remaining points
  POINT_TOTAL = 50,         // Total points of turn
  COMBINED_THROWS = 60,     // Multiple throws combined (s1_d20_b)
  PLAYER_NAME = 70,         // Player name or bot
  BUSTED = 80,              // Turn busted
  GAMESHOT = 89,            // Game won
  GAMESHOT_VARIANT = 90,    // Player-specific gameshot (gameshot_playername)
  MATCHSHOT = 99,           // Match won
  MATCHSHOT_VARIANT = 100,  // Player-specific matchshot (matchshot_playername)
}

let gameDataWatcherUnwatch: (() => void) | null = null;
let oldGameData: IGameData | null = null;
let initializationPromise: Promise<void> | null = null;

/** Metadata for stored callbacks with their sort preferences and priority customization */
interface RegisteredCallback {
  callback: GameDataCallback;
  options: Required<CallbackOptions>;
}

const callbacks: Map<string, RegisteredCallback> = new Map();

/**
 * Initialize the centralized game data processor
 * Should be called once during extension initialization
 * Uses a Promise lock to prevent race conditions when multiple modules initialize concurrently
 */
export async function initGameDataProcessor(): Promise<void> {
  // If already initialized, return immediately
  if (gameDataWatcherUnwatch) {
    log.info("already initialized");
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    log.info("initialization in progress, waiting...");
    return initializationPromise;
  }

  // Create initialization promise for other callers to await
  initializationPromise = performInitialization();
  return initializationPromise;
}

/**
 * Actual initialization logic
 */
async function performInitialization(): Promise<void> {
  log.info("Initializing");

  const initialGameData = await AutodartsToolsGameData.getValue();
  oldGameData = initialGameData;

  gameDataWatcherUnwatch = AutodartsToolsGameData.watch(
    (gameData: IGameData) => {
      log.info("gameData incomming:", gameData);
      processGameData(gameData, oldGameData!, true);
      oldGameData = gameData;
    },
  );
}

/**
 * Cleanup the game data processor
 */
export function cleanupGameDataProcessor(): void {
  if (gameDataWatcherUnwatch) {
    gameDataWatcherUnwatch();
    gameDataWatcherUnwatch = null;
  }
  initializationPromise = null;
  callbacks.clear();
  oldGameData = null;
}

/**
 * Register a callback to receive game data triggers
 * @param moduleId - Unique identifier for the module (e.g., "animations", "caller", "wled")
 * @param callback - Function to call with triggers
 * @param options - Configuration options including sort order and priority overrides
 */
export function registerGameDataCallback(
  moduleId: string,
  callback: GameDataCallback,
  options: CallbackOptions = {},
): void {
  const finalOptions: Required<CallbackOptions> = {
    sortOrder: options.sortOrder ?? "desc",
    priorityOverrides: options.priorityOverrides ?? {},
  };
  log.info(
    `Registering game data callback for module: ${moduleId} (sort order: ${finalOptions.sortOrder}, overrides: ${Object.keys(finalOptions.priorityOverrides).length})`,
  );
  callbacks.set(moduleId, { callback, options: finalOptions });

  if (oldTriggers.length > 0) {
    runCallback(callback, oldTriggers, finalOptions, oldGameData!, oldGameData!, false);
  }
}

/**
 * Unregister a callback
 */
export function unregisterGameDataCallback(moduleId: string): void {
  log.info(`Unregistering game data callback for module: ${moduleId}`);
  callbacks.delete(moduleId);
}

async function runCallback(
  callback: GameDataCallback,
  triggers: IGameTrigger[],
  options: Required<CallbackOptions>,
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean
): Promise<void> {
  if (!triggers.length || !gameData.match) return;

  // Apply priority overrides to triggers for this module
  const customizedTriggers = triggers.map(trigger => {
    const override = options.priorityOverrides[trigger.trigger] ?? options.priorityOverrides[trigger.priority];
    return override !== undefined ? { ...trigger, priority: override } : trigger;
  });

  // Sort by (potentially customized) priority
  const sortedTriggers = [...customizedTriggers].sort((a, b) =>
    options.sortOrder === "asc" ? a.priority - b.priority : b.priority - a.priority,
  );
  return Promise.resolve(callback(sortedTriggers, gameData, oldGameData, fromWebSocket));
}

/**
 * Core game data processor - derives all triggers and calls registered callbacks
 */
async function processGameData(
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
): Promise<void> {
  if (!gameData.match || !gameData.match.turns?.length)
    return;

  const editMode: boolean = gameData.match.activated !== undefined && gameData.match.activated >= 0;
  if (editMode) {
    return;
  }

  // Derive all possible triggers from the game state (unsorted)
  const triggers = deriveGameTriggers(gameData, oldGameData);

  let triggers_list: string = "";
  triggers.forEach((trigger) => {
    triggers_list += `\n${trigger.category.padStart(10)} | ${String(trigger.priority).padStart(3)} | ${trigger.trigger}`;
  });
  log.info("found triggers:", triggers_list);

  // Call all registered callbacks, applying priority overrides and sorting according to each module's preference
  const callbackPromises = Array.from(callbacks.entries()).map(([_moduleId, { callback, options }]) => {
    return runCallback(callback, triggers, options, gameData, oldGameData, fromWebSocket);
  });

  oldTriggers = triggers;

  await Promise.all(callbackPromises);
}

/**
 * Derive all possible triggers from the game state
 * Returns triggers sorted by category and with appropriate priority levels
 */
function deriveGameTriggers(gameData: IGameData, oldGameData: IGameData): IGameTrigger[] {
  const triggers: IGameTrigger[] = [];

  if (!gameData.match) return triggers;

  // Winner detection - HIGHEST PRIORITY
  const winnerMatch = gameData.match.winner >= 0 && gameData.gameMode !== GameMode.BULL_OFF;
  const winner = gameData.match.gameWinner >= 0 && gameData.gameMode !== GameMode.BULL_OFF;
  const currentPlayer = gameData.match.players?.[gameData.match.player];
  const playerName = currentPlayer?.name?.toLowerCase() || "";
  const playerNameUnderscore = playerName.replace(/\s+/g, "_");
  const isBot = !!currentPlayer?.cpuPPR;

  if (winnerMatch) {
    triggers.push({
      trigger: "matchshot",
      priority: TRIGGER_PRIORITIES.MATCHSHOT,
      category: TRIGGER_CATEGORIES.MATCH,
    });
    if (playerName) {
      triggers.push({
        trigger: `matchshot_${playerName}`,
        priority: TRIGGER_PRIORITIES.MATCHSHOT_VARIANT,
        category: TRIGGER_CATEGORIES.MATCH,
      });
      if (playerNameUnderscore !== playerName) {
        triggers.push({
          trigger: `matchshot_${playerNameUnderscore}`,
          priority: TRIGGER_PRIORITIES.MATCHSHOT_VARIANT,
          category: TRIGGER_CATEGORIES.MATCH,
        });
      }
    }
  }
  if (winner) {
    triggers.push({
      trigger: "gameshot",
      priority: TRIGGER_PRIORITIES.GAMESHOT,
      category: TRIGGER_CATEGORIES.MATCH,
    });
    if (playerName) {
      triggers.push({
        trigger: `gameshot_${playerName}`,
        priority: TRIGGER_PRIORITIES.GAMESHOT_VARIANT,
        category: TRIGGER_CATEGORIES.MATCH,
      });
      if (playerNameUnderscore !== playerName) {
        triggers.push({
          trigger: `gameshot_${playerNameUnderscore}`,
          priority: TRIGGER_PRIORITIES.GAMESHOT_VARIANT,
          category: TRIGGER_CATEGORIES.MATCH,
        });
      }
    }
  }

  // Bull-off handling
  if (gameData.match.variant === GameMode.BULL_OFF) {
    if (isBot) {
      triggers.push({
        trigger: "bulloff_bot",
        priority: TRIGGER_PRIORITIES.OTHER,
        category: TRIGGER_CATEGORIES.OTHER,
      });
    } else {
      triggers.push({
        trigger: `bulloff_${playerName}`,
        priority: TRIGGER_PRIORITIES.OTHER,
        category: TRIGGER_CATEGORIES.OTHER,
      });
    }
    if (playerName != playerNameUnderscore) {
      triggers.push({
        trigger: `bulloff_${playerNameUnderscore}`,
        priority: TRIGGER_PRIORITIES.OTHER,
        category: TRIGGER_CATEGORIES.OTHER,
      });
    }
    triggers.push({
      trigger: "bulloff",
      priority: TRIGGER_PRIORITIES.OTHER,
      category: TRIGGER_CATEGORIES.OTHER,
    });
    return triggers;
  }

  // Player change detection
  const playerChanged =
    oldGameData?.match?.player !== undefined &&
    gameData.match.player !== undefined &&
    oldGameData.match.player !== gameData.match.player;

  const isFirstThrow = gameData.match.turns[0].throws.length === 0;
  if (isFirstThrow || playerChanged || (winnerMatch || winner)) {
    if (isBot) {
      triggers.push({
        trigger: "bot",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: TRIGGER_CATEGORIES.PLAYER,
      });
      triggers.push({
        trigger: "bot_throw",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: TRIGGER_CATEGORIES.PLAYER,
      });
    } else if (playerName) {
      triggers.push({
        trigger: playerName,
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: TRIGGER_CATEGORIES.PLAYER,
      });
      if (playerName != playerNameUnderscore) {
        triggers.push({
          trigger: playerNameUnderscore,
          priority: TRIGGER_PRIORITIES.PLAYER_NAME,
          category: TRIGGER_CATEGORIES.PLAYER,
        });
      }
      triggers.push({
        trigger: `player_${gameData.match.player + 1}`,
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: TRIGGER_CATEGORIES.PLAYER,
      });
    }

    // gameon trigger for start of match
    if (gameData.match.round === 1 && gameData.match.player === 0) {
      triggers.push({
        trigger: "gameon",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: TRIGGER_CATEGORIES.PLAYER,
      });
    } else if (playerChanged) {
      triggers.push({
        trigger: "next_player",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: TRIGGER_CATEGORIES.PLAYER,
      });
    }
  }

  // Throw-based triggers (only if there are throws)
  if (gameData.match.turns[0].throws.length > 0) {
    const currentThrow = gameData.match.turns[0].throws[gameData.match.turns[0].throws.length - 1];
    if (currentThrow) {
      const throwName = currentThrow.segment.name.toLowerCase();
      const throwBed = currentThrow.segment.bed;
      const isFirstThrow = gameData.match.turns[0].throws.length == 0;
      const isLastThrow = gameData.match.turns[0].throws.length >= 3;
      const busted = gameData.match.turns[0].busted;
      const points = gameData.match.turns[0].points;
      const score = gameData.match.turns[0].score;
      const combinedThrows = gameData.match.turns[0].throws
        .map(t => t.segment.name.toLowerCase())
        .join("_");

      // Handle "25" to "s25" conversion
      let normalizedThrowName = throwName;
      if (throwName === "25" && throwBed.startsWith("Single")) {
        normalizedThrowName = "s25";
      }

      if (busted) {
        triggers.push({
          trigger: "busted",
          priority: TRIGGER_PRIORITIES.BUSTED,
          category: TRIGGER_CATEGORIES.THROW,
        });
      }

      if (isLastThrow && !busted) {
        // Combined throws (most specific, e.g., "s1_s20_s5")
        triggers.push({
          trigger: combinedThrows,
          priority: TRIGGER_PRIORITIES.COMBINED_THROWS,
          category: TRIGGER_CATEGORIES.THROW,
        });

        // Point total
        const addPoints: boolean = (![GameMode.CRICKET, GameMode.TACTICS].includes(gameData.gameMode) || points > 0);
        if (addPoints) {
          triggers.push({
            trigger: points.toString(),
            priority: TRIGGER_PRIORITIES.POINT_TOTAL,
            category: TRIGGER_CATEGORIES.TOTAL,
          });
        }
      }

      // Score (for caller checkout guide)
      if (isFirstThrow && score > 0) {
        triggers.push({
          trigger: `${score}`,
          priority: TRIGGER_PRIORITIES.POINT_REMAINING,
          category: TRIGGER_CATEGORIES.REMAINING,
        });
      }

      // Individual throw
      triggers.push({
        trigger: normalizedThrowName,
        priority: TRIGGER_PRIORITIES.INDIVIDUAL_THROW,
        category: TRIGGER_CATEGORIES.THROW,
      });

      // Miss detection
      if (normalizedThrowName.toLowerCase().startsWith("m")) {
        triggers.push({
          trigger: "outside",
          priority: TRIGGER_PRIORITIES.INDIVIDUAL_THROW,
          category: TRIGGER_CATEGORIES.THROW,
        });
      }
    }
  }

  // Variant-specific processing (Cricket, ATC, RTW, Shanghai, Bob's 27)
  const variantTriggers = deriveVariantSpecificTriggers(gameData, oldGameData);
  triggers.push(...variantTriggers);

  // Checkout guide triggers (for Caller)
  if (gameData.match.state?.checkoutGuide?.length && gameData.match.turns[0].throws.length === 0) {
    const currentPlayerIndex = gameData.match.player;
    const currentScore = gameData.match.gameScores[currentPlayerIndex];

    if (currentScore > 0) {
      // Specific checkout triggers
      triggers.push({
        trigger: `yr_${currentScore}`,
        priority: TRIGGER_PRIORITIES.POINT_REMAINING,
        category: TRIGGER_CATEGORIES.THROW,
      });
      triggers.push({
        trigger: `you_require_${currentScore}`,
        priority: TRIGGER_PRIORITIES.POINT_REMAINING,
        category: TRIGGER_CATEGORIES.THROW,
      });
      triggers.push({
        trigger: "you_require",
        priority: TRIGGER_PRIORITIES.POINT_REMAINING,
        category: TRIGGER_CATEGORIES.THROW,
      });
    }
  }

  return triggers;
}

/**
 * Derive variant-specific triggers (Cricket, ATC, RTW, Shanghai, Bob's 27)
 */
function deriveVariantSpecificTriggers(gameData: IGameData, oldGameData: IGameData): IGameTrigger[] {
  const triggers: IGameTrigger[] = [];

  if (!gameData.match)
    return triggers;

  log.info(gameData);
  switch (gameData.match.variant) {
    case GameMode.CRICKET:
    case GameMode.TACTICS: {
      log.info("deriveVariantSpecificTriggers: Cricket");
      // Cricket-specific triggers
      const latestThrow = gameData.match.turns[0].throws[gameData.match.turns[0].throws.length - 1];
      log.info(latestThrow);
      if (latestThrow) {
        const segmentName = latestThrow.segment.name.toLowerCase();
        let segmentNumber = 0;

        if (segmentName === "bull" || segmentName === "25") {
          segmentNumber = 25;
        } else if (segmentName.includes("miss") || segmentName.includes("outside")) {
          segmentNumber = 0;
        } else {
          const match = segmentName.match(/[sdt](\d+)/i);
          if (match && match[1]) {
            segmentNumber = Number.parseInt(match[1], 10);
          }
        }

        const gameMode = gameData.match.settings?.gameMode;
        const segmentNumberToScore = gameMode === GameMode.TACTICS ? 10 : 15;

        if (segmentNumber >= segmentNumberToScore) {
          // Check if segment is already closed
          const stateIndex = latestThrow.segment.number === 50 ? 25 : latestThrow.segment.number;
          const segmentValues = oldGameData?.match?.state?.segments?.[stateIndex] || [];
          const allPlayersClosed = segmentValues.length > 0 && segmentValues.every(value => value >= 3);

          if (allPlayersClosed) {
            triggers.push({
              trigger: "cricket_miss",
              priority: TRIGGER_PRIORITIES.INDIVIDUAL_THROW,
              category: TRIGGER_CATEGORIES.THROW,
            });
          } else {
            triggers.push({
              trigger: "cricket_hit",
              priority: TRIGGER_PRIORITIES.INDIVIDUAL_THROW,
              category: TRIGGER_CATEGORIES.THROW,
            });
          }
        } else if (segmentNumber > 0) {
          triggers.push({
            trigger: "cricket_miss",
            priority: TRIGGER_PRIORITIES.INDIVIDUAL_THROW,
            category: TRIGGER_CATEGORIES.THROW,
          });
        }
      }
      break;
    }

    case GameMode.ATC: // Around The Clock
    case GameMode.RTW: // Round The World
    case GameMode.SHANGHAI:
    case GameMode.BOBS_27: {
      let targetField: string | number = 0;

      switch (gameData.match.variant) {
        case GameMode.ATC: {
          const player = gameData.match.player;
          targetField =
            gameData.match.state.targets?.[player]?.[gameData.match.state.currentTargets?.[player]]?.number || 0;
          if (
            targetField === 25 &&
            gameData.match.settings &&
            ["Double", "Triple"].some(v => v === gameData.match!.settings.mode)
          ) {
            targetField = "bull";
          }
          break;
        }
        case GameMode.RTW: {
          const round = gameData.match.round;
          targetField = gameData.match.state.targets?.[round - 1]?.number || 0;
          break;
        }
        case GameMode.SHANGHAI: {
          const round = gameData.match.round;
          targetField = gameData.match.state.targets?.[round - 1] || 0;
          break;
        }
        case GameMode.BOBS_27:
          targetField = gameData.match.round;
          break;
      }

      if (targetField) {
        triggers.push({
          trigger: `target${targetField}`,
          priority: TRIGGER_PRIORITIES.POINT_TOTAL,
          category: TRIGGER_CATEGORIES.OTHER,
        });
      }
      break;
    }

    case GameMode.GOTCHA: {
      const currentScores = gameData.match.gameScores;
      const previousScores = oldGameData?.match?.gameScores;
      if (previousScores && previousScores.length === currentScores.length
        && currentScores[gameData.match.player] > 0
        && currentScores.some((score, i) => score === 0 && previousScores[i] > 0)) {
        triggers.push({
          trigger: `gotcha`,
          priority: TRIGGER_PRIORITIES.BUSTED,
          category: TRIGGER_CATEGORIES.THROW,
        });
      }
    }
  }

  log.info("deriveVariantSpecificTriggers: Triggers:", triggers);

  return triggers;
}

/**
 * Vue composable hook to register a game data processor callback
 * ONLY use this from Vue components in `<script setup>` context
 * For non-Vue modules, call registerGameDataCallback and unregisterGameDataCallback directly
 * @param moduleId - Unique identifier for the module
 * @param callback - Function to receive triggers
 * @param options - Configuration options including sort order and priority overrides
 */
export function useGameDataProcessor(
  moduleId: string,
  callback: GameDataCallback,
  options?: CallbackOptions,
): void {
  onMounted(() => {
    registerGameDataCallback(moduleId, callback, options);
  });

  onUnmounted(() => {
    unregisterGameDataCallback(moduleId);
  });
}
