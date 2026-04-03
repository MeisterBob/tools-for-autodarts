import { type IGameData } from "@/utils/game-data-storage";
import { AutodartsToolsGameData } from "@/utils/game-data-storage";

/**
 * Represents a trigger with priority information
 * Lower priority number = higher priority (more important to play)
 */
export interface IGameTrigger {
  trigger: string;
  priority: number;
  category: "match" | "throw" | "total" | "remaining" | "player" | "board" | "ambient" | "other";
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
  COMBINED_THROWS = 40,     // Multiple throws combined (s1_d20_b)
  POINT_TOTAL = 50,         // Total points of turn
  POINT_REMAINING = 55,     // Remaining points
  INDIVIDUAL_THROW = 60,    // Single throw (s1, d20, etc)
  PLAYER_NAME = 70,         // Player name or bot
  AMBIENT = 80,             // Ambient effects (prefix-based)
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
    console.log("Autodarts Tools: Game data processor already initialized");
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    console.log("Autodarts Tools: Game data processor initialization in progress, waiting...");
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
  console.log("Autodarts Tools: Initializing centralized game data processor");

  const initialGameData = await AutodartsToolsGameData.getValue();
  oldGameData = initialGameData;

  gameDataWatcherUnwatch = AutodartsToolsGameData.watch(
    (gameData: IGameData) => {
      console.log("Autodarts Tools: GameDataprocessor: gameData incomming:", gameData);
      processGameData(gameData, oldGameData!, true);
      oldGameData = JSON.parse(JSON.stringify(gameData));
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
    `Autodarts Tools: Registering game data callback for module: ${moduleId} (sort order: ${finalOptions.sortOrder}, overrides: ${Object.keys(finalOptions.priorityOverrides).length})`,
  );
  callbacks.set(moduleId, { callback, options: finalOptions });
}

/**
 * Unregister a callback
 */
export function unregisterGameDataCallback(moduleId: string): void {
  console.log(`Autodarts Tools: Unregistering game data callback for module: ${moduleId}`);
  callbacks.delete(moduleId);
}

/**
 * Core game data processor - derives all triggers and calls registered callbacks
 */
async function processGameData(
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
): Promise<void> {
  if (!gameData.match || !gameData.match.turns?.length) {
    return;
  }

  const editMode: boolean = gameData.match.activated !== undefined && gameData.match.activated >= 0;
  if (editMode) {
    return;
  }

  // Derive all possible triggers from the game state (unsorted)
  const triggers = deriveGameTriggers(gameData, oldGameData);

  console.log("Autodarts Tools: GameDataprocessor: found triggers:", triggers);

  // Call all registered callbacks, applying priority overrides and sorting according to each module's preference
  const callbackPromises = Array.from(callbacks.entries()).map(([_moduleId, { callback, options }]) => {
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
  });

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
  const winnerMatch = gameData.match.winner >= 0;
  const winner = gameData.match.gameWinner >= 0;
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
      triggers.push({
        trigger: `matchshot_${playerNameUnderscore}`,
        priority: TRIGGER_PRIORITIES.MATCHSHOT_VARIANT,
        category: "match",
      });
    }
  } else if (winner) {
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
      triggers.push({
        trigger: `gameshot_${playerNameUnderscore}`,
        priority: TRIGGER_PRIORITIES.GAMESHOT_VARIANT,
        category: "match",
      });
    }
  }

  // Bull-off handling
  if (gameData.match.variant === "Bull-off") {
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
      triggers.push({
        trigger: "ambient_bot",
        priority: TRIGGER_PRIORITIES.AMBIENT,
        category: "ambient",
      });
    } else if (playerName) {
      triggers.push({
        trigger: playerName,
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
      triggers.push({
        trigger: playerNameUnderscore,
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
      triggers.push({
        trigger: `ambient_${playerName}`,
        priority: TRIGGER_PRIORITIES.AMBIENT,
        category: "ambient",
      });
      triggers.push({
        trigger: `ambient_${playerNameUnderscore}`,
        priority: TRIGGER_PRIORITIES.AMBIENT,
        category: "ambient",
      });
    }

    // gameon trigger for start of match
    if (gameData.match.round === 1 && gameData.match.turns[0].throws.length === 0 && gameData.match.player === 0) {
      triggers.push({
        trigger: "gameon",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
      triggers.push({
        trigger: "ambient_gameon",
        priority: TRIGGER_PRIORITIES.AMBIENT,
        category: "ambient",
      });
    } else if (playerChanged) {
      triggers.push({
        trigger: "next_player",
        priority: TRIGGER_PRIORITIES.PLAYER_NAME,
        category: "player",
      });
      triggers.push({
        trigger: "ambient_next_player",
        priority: TRIGGER_PRIORITIES.AMBIENT,
        category: "ambient",
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
        triggers.push({
          trigger: "cricket_miss",
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
        priority: TRIGGER_PRIORITIES.POINT_TOTAL,
        category: "throw",
      });
      triggers.push({
        trigger: `you_require_${currentScore}`,
        priority: TRIGGER_PRIORITIES.POINT_TOTAL,
        category: "throw",
      });
      triggers.push({
        trigger: "you_require",
        priority: TRIGGER_PRIORITIES.POINT_TOTAL,
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

  if (!gameData.match) return triggers;

  switch (gameData.match.variant) {
    case "Cricket": {
      // Cricket-specific triggers
      if (gameData.match.turns[0].throws.length > 0) {
        const latestThrow = gameData.match.turns[0].throws[gameData.match.turns[0].throws.length - 1];
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
          const segmentNumberToScore = gameMode === "Tactics" ? 10 : 15;

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
      }
      break;
    }

    case "ATC": // Around The Clock
    case "RTW": // Round The World
    case "Shanghai":
    case "Bob's 27": {
      let targetField: string | number = 0;

      switch (gameData.match.variant) {
        case "ATC": {
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
        case "RTW": {
          const round = gameData.match.round;
          targetField = gameData.match.state.targets?.[round - 1]?.number || 0;
          break;
        }
        case "Shanghai": {
          const round = gameData.match.round;
          targetField = gameData.match.state.targets?.[round - 1] || 0;
          break;
        }
        case "Bob's 27": {
          targetField = gameData.match.round;
          break;
        }
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
  }

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
