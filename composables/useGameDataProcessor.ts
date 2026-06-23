import { type IGameData, GameMode } from "@/utils/game-data-storage";
import { AutodartsToolsGameData } from "@/utils/game-data-storage";
import { triggerPatterns } from "@/utils/helpers";
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
 * - 100:  Matchshot
 * - 90:  Gameshot
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
  trigger: string | string[];
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
  OTHER = 10,                  // Fallback triggers
  BOARD_EVENT = 20,            // Board events
  THROW = 25,                  // throw
  INDIVIDUAL_THROW = 30,       // Single throw (s1, d20, etc)
  POINT_REMAINING_COMMON = 39, // generalized Remaining points
  POINT_REMAINING = 40,        // Remaining points
  POINT_TOTAL = 50,            // Total points of turn
  COMBINED_THROWS = 60,        // Multiple throws combined (s1_d20_b)
  PLAYER_NAME_COMMON = 69,     // generalized Player name
  PLAYER_NAME = 70,            // Player name or bot
  BUSTED = 80,                 // Turn busted
  GAMESHOT = 90,               // Game won
  MATCHSHOT = 100,             // Match won
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
    const triggerKey = Array.isArray(trigger.trigger) ? trigger.trigger.join('+') : trigger.trigger;
    const override = options.priorityOverrides[triggerKey] ?? options.priorityOverrides[trigger.priority];
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
    const triggerLabel = Array.isArray(trigger.trigger) ? `[${trigger.trigger.join(',')}]` : trigger.trigger;
    triggers_list += `\n${trigger.category.padStart(10)} | ${String(trigger.priority).padStart(3)} | ${triggerLabel}`;
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

  // Player / Bot
  if (playerName) {
    triggers.push({
      trigger: playerName,
      priority: TRIGGER_PRIORITIES.PLAYER_NAME,
      category: TRIGGER_CATEGORIES.PLAYER,
    });
    if (playerNameUnderscore !== playerName) {
      triggers.push({
        trigger: playerNameUnderscore,
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: TRIGGER_CATEGORIES.PLAYER,
      });
    }
  }
  if (isBot) {
    triggers.push({
      trigger: "bot",
      priority: TRIGGER_PRIORITIES.OTHER,
      category: TRIGGER_CATEGORIES.OTHER,
    });
  }
  triggers.push({
    trigger: `player_${gameData.match.player + 1}`,
    priority: TRIGGER_PRIORITIES.PLAYER_NAME_COMMON,
    category: TRIGGER_CATEGORIES.PLAYER,
  });

  // Winner
  if (winnerMatch) {
    triggers.push({
      trigger: "matchshot",
      priority: TRIGGER_PRIORITIES.MATCHSHOT,
      category: TRIGGER_CATEGORIES.MATCH,
    });
  }
  if (winner) {
    triggers.push({
      trigger: "gameshot",
      priority: TRIGGER_PRIORITIES.GAMESHOT,
      category: TRIGGER_CATEGORIES.MATCH,
    });
  }

  // Bull-off handling
  if (gameData.match.variant === GameMode.BULL_OFF) {
    triggers.push({
      trigger: "bulloff",
      priority: TRIGGER_PRIORITIES.OTHER,
      category: TRIGGER_CATEGORIES.OTHER,
    });
    return triggers;
  }

  // Game start or Player changed
  const isFirstThrow = gameData.match.turns[0].throws.length === 0;
  if (isFirstThrow && gameData.match.round === 1 && gameData.match.player === 0) {
    log.info("first throw -> gameon");
    triggers.push({
      trigger: "gameon",
      priority: TRIGGER_PRIORITIES.PLAYER_NAME,
      category: TRIGGER_CATEGORIES.PLAYER,
    });

  }
  const playerChanged =
    oldGameData?.match?.player !== undefined &&
    gameData.match.player !== undefined &&
    oldGameData.match.player !== gameData.match.player;
  if (playerChanged) {
    log.info("player changed -> next_player");
    triggers.push({
      trigger: "next_player",
      priority: TRIGGER_PRIORITIES.PLAYER_NAME_COMMON,
      category: TRIGGER_CATEGORIES.PLAYER,
    });
  }

  // Throw-based triggers
  if (gameData.match.turns[0].throws.length > 0) {
    const currentThrow = gameData.match.turns[0].throws[gameData.match.turns[0].throws.length - 1];
    if (currentThrow) {
      const throwName = currentThrow.segment.name.toLowerCase();
      const throwBed = currentThrow.segment.bed;
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

      triggers.push({
        trigger: `throw${gameData.match.turns[0].throws.length}`,
        priority: TRIGGER_PRIORITIES.THROW,
        category: TRIGGER_CATEGORIES.THROW,
      });

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
        trigger: ["you_require", `${currentScore}`],
        priority: TRIGGER_PRIORITIES.POINT_REMAINING_COMMON,
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

export function handleBoardEvent(boardData: IBoard, handler: (trigger: string) => void): void {
  const boardEvent: string | undefined = boardData.event;
  const boardStatus: string | undefined = boardData.status;

  if ((boardEvent === "Starting" && (boardStatus === "" || boardStatus === "Starting")) ||
    (boardEvent === "start" && boardStatus === ""))
    handler("board_starting");
  else if (boardEvent === "Started" && boardStatus === "Throw")
    handler("board_started");
  else if (boardEvent === "Stopping" && boardStatus === "Stopping")
    handler("board_stopping");
  else if (boardEvent === "Stopped" && boardStatus === "Stopped")
    handler("board_stopped");
  else if (boardEvent === "Disconnected" && (boardStatus === "Offline" || boardStatus === ""))
    handler("board_stopped");
  else if (boardEvent === "Manual reset" && boardStatus === "Throw")
    handler("manual_reset_done");
  else if (boardEvent === "Throw detected" && boardStatus === "Throw")
    handler("throw");
  else if (boardEvent === "Throw detected" && boardStatus === "Takeout")
    handler("last_throw");
  else if (boardEvent === "Takeout started" && boardStatus === "Takeout in progress")
    handler("takeout");
  else if (boardEvent === "Takeout finished" && boardStatus === "Throw")
    handler("takeout_finished");
  else if (boardEvent === "Calibration started")
    handler("calibration_started");
  else if (boardEvent === "Calibration finished")
    handler("calibration_finished");
  else
    log.info(`Board: event '${boardEvent}' with status '${boardStatus}' was unhandled`);
}

/**
 * Find the best matching item from a list based on active game triggers.
 * An item matches when ALL '+'-separated parts of at least one of its trigger strings
 * are present in the active triggers. The score is the sum of the priorities of the
 * matched parts; compound triggers naturally outscore single-trigger items.
 * Among tied scores, one is chosen at random.
 */
export function findMatchingItem<T extends { enabled: boolean; triggers: string[] }>(
  items: T[],
  triggers: IGameTrigger[],
  selectPlayerName: boolean = false
): Array<{ item: T; score: number; matchedTrigger: string | string[]; category: TRIGGER_CATEGORIES }> | false {
  const triggerNames = new Set<string>();
  const priorityMap = new Map<string, number>();
  const categoryMap = new Map<string, TRIGGER_CATEGORIES>();
  const arrayTriggers: Array<{ parts: string[]; priority: number; category: TRIGGER_CATEGORIES }> = [];

  for (const t of triggers) {
    if (Array.isArray(t.trigger)) {
      for (const name of t.trigger) triggerNames.add(name);
      arrayTriggers.push({ parts: t.trigger, priority: t.priority, category: t.category });
    } else {
      triggerNames.add(t.trigger);
      priorityMap.set(t.trigger, t.priority);
      categoryMap.set(t.trigger, t.category);
    }
  }

  log.info("triggerNames", triggerNames);

  function triggerIncludes(name: string): boolean {
    return triggers.some(t => Array.isArray(t.trigger) ? t.trigger.includes(name) : t.trigger === name);
  }

  // always allow player_name trigger on round start and player change
  if (triggerIncludes('next_player') || triggerIncludes('gameon'))
    selectPlayerName = true;
  const playerNameTriggerNames = selectPlayerName ? null : new Set(
    triggers
      .filter(t => t.category === TRIGGER_CATEGORIES.PLAYER &&
        (t.priority === TRIGGER_PRIORITIES.PLAYER_NAME || t.priority === TRIGGER_PRIORITIES.PLAYER_NAME_COMMON))
      .flatMap(t => Array.isArray(t.trigger) ? t.trigger : [t.trigger]),
  );

  function matchScore(effectTrigger: string): number {
    const rangeParts = effectTrigger.match(triggerPatterns.ranges);
    if (rangeParts) {
      const min = Number(rangeParts[1]);
      const max = Number(rangeParts[2]);
      for (const [name, priority] of priorityMap) {
        const points = Number(name);
        if (!Number.isNaN(points) && min <= points && points <= max) return priority;
      }
      return -Infinity;
    }

    const parts = effectTrigger.split('+');
    if (!parts.every(p => triggerNames.has(p))) return -Infinity;
    if (playerNameTriggerNames && parts.length === 1 && playerNameTriggerNames.has(parts[0])) return -Infinity;

    // Check if a compound array trigger covers all parts — use its priority per part
    for (const at of arrayTriggers) {
      if (parts.length === at.parts.length && parts.every(p => at.parts.includes(p)))
        return at.priority * parts.length;
    }

    return parts.reduce((sum, p) => sum + (priorityMap.get(p) ?? 0), 0);
  }

  function matchCategory(parts: string[]): TRIGGER_CATEGORIES {
    for (const at of arrayTriggers) {
      if (parts.length === at.parts.length && parts.every(p => at.parts.includes(p)))
        return at.category;
    }
    let best = TRIGGER_CATEGORIES.OTHER;
    let bestPriority = -Infinity;
    for (const p of parts) {
      const priority = priorityMap.get(p) ?? -Infinity;
      if (priority > bestPriority) { bestPriority = priority; best = categoryMap.get(p) ?? TRIGGER_CATEGORIES.OTHER; }
    }
    return best;
  }

  const candidates: Array<{ item: T; score: number; matchedTrigger: string | string[]; category: TRIGGER_CATEGORIES }> = [];
  for (const item of items) {
    if (!item.enabled) continue;
    let bestScore = -Infinity;
    let bestTrigger: string | string[] = "";
    let bestCategory = TRIGGER_CATEGORIES.OTHER;
    for (const t of item.triggers) {
      const s = matchScore(t);
      if (s > bestScore) {
        bestScore = s;
        const parts = t.split('+');
        bestTrigger = parts.length > 1 ? parts : t;
        bestCategory = matchCategory(Array.isArray(bestTrigger) ? bestTrigger : [bestTrigger]);
      }
    }
    if (bestScore > -Infinity) candidates.push({ item, score: bestScore, matchedTrigger: bestTrigger, category: bestCategory });
  }

  if (!candidates.length) return false;

  candidates.sort((a, b) => b.score - a.score);

  // Group by matched trigger, keeping only the top score per trigger, then pick one randomly
  const triggerGroups = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = Array.isArray(c.matchedTrigger) ? c.matchedTrigger.join('+') : c.matchedTrigger;
    if (!triggerGroups.has(key)) {
      triggerGroups.set(key, [c]);
    } else {
      const group = triggerGroups.get(key)!;
      if (c.score === group[0].score) group.push(c);
    }
  }

  const filtered = Array.from(triggerGroups.values())
    .map(group => group[Math.floor(Math.random() * group.length)]);
  filtered.sort((a, b) => b.score - a.score);
  return filtered;
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
