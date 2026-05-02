import { type IGameData, GameMode } from "@/utils/game-data-storage";
import { AutodartsToolsGameData } from "@/utils/game-data-storage";

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
 * Each trigger has a priority level (lower number = higher priority, plays first):
 * - 10: Matchshot variant (player-specific)
 * - 11: Matchshot
 * - 20: Gameshot variant
 * - 21: Gameshot
 * - 30: Busted
 * - 40: Combined throws (e.g., s1_d20_b)
 * - 50: Point total (e.g., 50)
 * - 55: Remaining points
 * - 60: Individual throw (e.g., s20, d10)
 * - 70: Player name / bot
 * - 80: Board events
 * - 90: Fallback/other
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
 * // Register with default priority (ascending - highest priority first)
 * useGameDataProcessor("my-module", handleTriggers);
 *
 * // Or customize priority order and override specific trigger priorities
 * useGameDataProcessor("my-module", handleTriggers, {
 *   sortOrder: "desc",  // "asc" (default) or "desc"
 *   priorityOverrides: {
 *     "matchshot": 5,  // Play matchshot before gameshot
 *     "s20": 35        // Play s20 before busted
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
 * Lower priority number = higher priority (more important to play)
 */
export interface IGameTrigger {
  trigger: string;
  priority: number;
  category: "match" | "throw" | "total" | "remaining" | "player" | "board" | "other";
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
  /** Sort order: "asc" (lower priority first) or "desc" (higher priority first) */
  sortOrder?: TriggerSortOrder;
  /** Override priority values for specific triggers. Keys are trigger names or TRIGGER_PRIORITIES enum values */
  priorityOverrides?: Record<string | number, number>;
}

/** Priority levels (lower = higher priority) */
export enum TRIGGER_PRIORITIES {
  MATCHSHOT_VARIANT = 10,   // Player-specific matchshot (matchshot_playername)
  MATCHSHOT = 11,           // Match won
  GAMESHOT_VARIANT = 20,    // Player-specific gameshot (gameshot_playername)
  GAMESHOT = 21,            // Game won
  BUSTED = 30,              // Turn busted
  PLAYER_NAME = 40,         // Player name or bot
  COMBINED_THROWS = 50,     // Multiple throws combined (s1_d20_b)
  POINT_TOTAL = 60,         // Total points of turn
  POINT_REMAINING = 70,     // Remaining points
  INDIVIDUAL_THROW = 80,    // Single throw (s1, d20, etc)
  BOARD_EVENT = 90,         // Board events
  OTHER = 100,              // Fallback triggers
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
    console.log("Autodarts Tools: GameDataprocessor: already initialized");
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    console.log("Autodarts Tools: GameDataprocessor: initialization in progress, waiting...");
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
  console.log("Autodarts Tools: GameDataprocessor: Initializing");

  const initialGameData = await AutodartsToolsGameData.getValue();
  oldGameData = initialGameData;

  gameDataWatcherUnwatch = AutodartsToolsGameData.watch(
    (gameData: IGameData) => {
      console.log("Autodarts Tools: GameDataprocessor: gameData incomming:", gameData);
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
    sortOrder: options.sortOrder ?? "asc",
    priorityOverrides: options.priorityOverrides ?? {},
  };
  console.log(
    `Autodarts Tools: GameDataprocessor: Registering game data callback for module: ${moduleId} (sort order: ${finalOptions.sortOrder}, overrides: ${Object.keys(finalOptions.priorityOverrides).length})`,
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
  console.log(`Autodarts Tools: GameDataprocessor: Unregistering game data callback for module: ${moduleId}`);
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
  console.log("Autodarts Tools: GameDataprocessor: found triggers:", triggers_list);

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

  if (winnerMatch) {
    triggers.push({
      trigger: "matchshot",
      priority: TRIGGER_PRIORITIES.MATCHSHOT,
      category: "match",
    });
    if (playerName) {
      triggers.push({
        trigger: `matchshot_${playerName}`,
        priority: TRIGGER_PRIORITIES.MATCHSHOT_VARIANT,
        category: "match",
      });
      if (playerNameUnderscore !== playerName) {
        triggers.push({
          trigger: `matchshot_${playerNameUnderscore}`,
          priority: TRIGGER_PRIORITIES.MATCHSHOT_VARIANT,
          category: "match",
        });
      }
    }
  }
  if (winner) {
    triggers.push({
      trigger: "gameshot",
      priority: TRIGGER_PRIORITIES.GAMESHOT,
      category: "match",
    });
    if (playerName) {
      triggers.push({
        trigger: `gameshot_${playerName}`,
        priority: TRIGGER_PRIORITIES.GAMESHOT_VARIANT,
        category: "match",
      });
      if (playerNameUnderscore !== playerName) {
        triggers.push({
          trigger: `gameshot_${playerNameUnderscore}`,
          priority: TRIGGER_PRIORITIES.GAMESHOT_VARIANT,
          category: "match",
        });
      }
    }
  }

  // Bull-off handling
  if (gameData.match.variant === GameMode.BULL_OFF) {
    const currentPlayer = gameData.match.players?.[gameData.match.player];
    const playerName = currentPlayer?.name?.toLowerCase() || "";
    const playerNameUnderscore = playerName.replace(/\s+/g, "_");
    const isBot = !!currentPlayer?.cpuPPR;

    if (isBot) {
      triggers.push({
        trigger: "bulloff_bot",
        priority: TRIGGER_PRIORITIES.OTHER,
        category: "other",
      });
    } else {
      triggers.push({
        trigger: `bulloff_${playerName}`,
        priority: TRIGGER_PRIORITIES.OTHER,
        category: "other",
      });
    }
    if (playerName != playerNameUnderscore) {
      triggers.push({
        trigger: `bulloff_${playerNameUnderscore}`,
        priority: TRIGGER_PRIORITIES.OTHER,
        category: "other",
      });
    }
    triggers.push({
      trigger: "bulloff",
      priority: TRIGGER_PRIORITIES.OTHER,
      category: "other",
    });
    return triggers;
  }

  // Player change detection
  const playerChanged =
    oldGameData?.match?.player !== undefined &&
    gameData.match.player !== undefined &&
    oldGameData.match.player !== gameData.match.player;

  const isFirstThrow = gameData.match.turns[0].throws.length === 0;
  if (isFirstThrow || playerChanged) {
    const currentPlayer = gameData.match.players?.[gameData.match.player];
    const playerName = currentPlayer?.name?.toLowerCase() || "";
    const playerNameUnderscore = playerName.replace(/\s+/g, "_");
    const isBot = !!currentPlayer?.cpuPPR;

    if (isBot) {
      triggers.push({
        trigger: "bot",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
      triggers.push({
        trigger: "bot_throw",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
    } else if (playerName) {
      triggers.push({
        trigger: playerName,
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
      if (playerName != playerNameUnderscore) {
        triggers.push({
          trigger: playerNameUnderscore,
          priority: TRIGGER_PRIORITIES.PLAYER_NAME,
          category: "player",
        });
      }
      triggers.push({
        trigger: `player_${gameData.match.player + 1}`,
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
    }

    // gameon trigger for start of match
    console.log("Autodarts Tools: GameDataProcessor:", playerChanged, gameData.match.round, gameData.match.player);
    if (gameData.match.round === 1 && gameData.match.player === 0) {
      triggers.push({
        trigger: "gameon",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
    } else if (playerChanged) {
      triggers.push({
        trigger: "next_player",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
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
          category: "throw",
        });
      }

      if (isLastThrow && !busted) {
        // Combined throws (most specific, e.g., "s1_d20_b")
        triggers.push({
          trigger: combinedThrows,
          priority: TRIGGER_PRIORITIES.COMBINED_THROWS,
          category: "throw",
        });

        // Point total
        triggers.push({
          trigger: points.toString(),
          priority: TRIGGER_PRIORITIES.POINT_TOTAL,
          category: "total",
        });
      }

      // Score (for caller checkout guide)
      if (isFirstThrow && score > 0) {
        triggers.push({
          trigger: `${score}`,
          priority: TRIGGER_PRIORITIES.POINT_REMAINING,
          category: "remaining",
        });
      }

      // Individual throw
      triggers.push({
        trigger: normalizedThrowName,
        priority: TRIGGER_PRIORITIES.INDIVIDUAL_THROW,
        category: "throw",
      });

      // Miss detection
      if (normalizedThrowName.toLowerCase().startsWith("m")) {
        triggers.push({
          trigger: "outside",
          priority: TRIGGER_PRIORITIES.INDIVIDUAL_THROW,
          category: "throw",
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
        category: "throw",
      });
      triggers.push({
        trigger: `you_require_${currentScore}`,
        priority: TRIGGER_PRIORITIES.POINT_REMAINING,
        category: "throw",
      });
      triggers.push({
        trigger: "you_require",
        priority: TRIGGER_PRIORITIES.POINT_REMAINING,
        category: "throw",
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

  console.log("Autodarts Tools: GameDataprocessor:", gameData);
  switch (gameData.match.variant) {
    case GameMode.CRICKET:
    case GameMode.TACTICS: {
      console.log("Autodarts Tools: GameDataprocessor: deriveVariantSpecificTriggers: Cricket");
      // Cricket-specific triggers
      const latestThrow = gameData.match.turns[0].throws[gameData.match.turns[0].throws.length - 1];
      console.log("Autodarts Tools: GameDataprocessor:", latestThrow);
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
              priority: TRIGGER_PRIORITIES.OTHER,
              category: "throw",
            });
          }
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
          category: "other",
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
          category: "throw",
        });
      }
    }
  }

  console.log("Autodarts Tools: GameDataprocessor: deriveVariantSpecificTriggers: Triggers:", triggers);

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
