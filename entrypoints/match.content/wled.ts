import type { ILobbies } from "@/utils/websocket-helpers";

import type { IGameData } from "@/utils/game-data-storage";
import { AutodartsToolsLobbyData } from "@/utils/lobby-data-storage";
import { AutodartsToolsBoardData, type IBoard } from "@/utils/board-data-storage";
import { AutodartsToolsTournamentData, type ITournament } from "@/utils/tournament-data-storage";
import { AutodartsToolsConfig, type IConfig, type IWled } from "@/utils/storage";
import {
  registerGameDataCallback,
  unregisterGameDataCallback,
  handleBoardEvent,
  findMatchingItem,
  TRIGGER_CATEGORIES,
  type IGameTrigger,
} from "@/composables/useGameDataProcessor";
import { WledType } from "#imports";
import { createLogger } from "@/utils/logger";
const log = createLogger("WLED")

let gameDataProcessorUnwatch: (() => void) | null = null;
let lobbyDataWatcherUnwatch: any;
let boardDataWatcherUnwatch: any;
let tournamentDataWatcherUnwatch: any;
let config: IConfig;
let currentBoardId: string;

function eventTrigger(trigger: string) {
  if (findMatchingItem(config.wledFx.effects ?? [], [{ trigger, priority: 0, category: TRIGGER_CATEGORIES.OTHER }]) &&
    (
      config!.wledFx.boardIds.length === 0 ||
      (
        config!.wledFx.boardIds.length > 0 &&
        config!.wledFx.boardIds.includes(currentBoardId)
      )
    )
  )
    setEffectByTrigger(trigger);
}

function _is_enabled(config: IConfig, gameMode: GameMode): boolean {
  if (config.wledFx.enabled && config.wledFx.enabledGameModes.includes(gameMode))
    return true;
  return false;
}

export async function wledFx() {
  try {
    config = await AutodartsToolsConfig.getValue();
    log.info(`Config loaded, ${config.wledFx?.effects?.length || 0} effects available`);

    // Register with centralized game data processor (only once)
    if (!gameDataProcessorUnwatch) {
      registerGameDataCallback("wled", async (triggers: IGameTrigger[], gameData: IGameData) => {
        if (!_is_enabled(config, gameData.gameMode)) return;
        await processGameDataFromTriggers(triggers, gameData);
      });
      gameDataProcessorUnwatch = () => unregisterGameDataCallback("wled");
    }

    if (!lobbyDataWatcherUnwatch) {
      lobbyDataWatcherUnwatch = AutodartsToolsLobbyData.watch(
        async (_lobbyData: ILobbies | undefined, _oldLobbyData: ILobbies | undefined) => {
          if (!_lobbyData || !_oldLobbyData || !config.wledFx?.enabled) return;
          const currentURL = window.location.href;
          if (!currentURL.includes("lobbies")) return;

          if (
            (_lobbyData.players?.length ?? 0) > (_oldLobbyData.players?.length ?? 0)
            && (_lobbyData.players?.length ?? 0) > 1
          ) {
            setEffectByTrigger("lobby_in");
          }

          if (
            (_lobbyData.players?.length ?? 0) < (_oldLobbyData.players?.length ?? 0)
            && (_lobbyData.players?.length ?? 0) > 0
          ) {
            setEffectByTrigger("lobby_out");
          }
        },
      );
    }

    if (!boardDataWatcherUnwatch) {
      boardDataWatcherUnwatch = AutodartsToolsBoardData.watch((boardData: IBoard) => {
        handleBoardEvent(boardData, eventTrigger);
      });
    }

    if (!tournamentDataWatcherUnwatch) {
      tournamentDataWatcherUnwatch = AutodartsToolsTournamentData.watch(
        async (tournamentData: ITournament | undefined, oldTournamentData: ITournament | undefined) => {
          if (!tournamentData || !config.wledFx?.enabled) return;

          // Check if tournament event is "start" and trigger the tournament_ready effect
          if (tournamentData.event === "start") {
            log.info("Tournament start event detected, triggering tournament_ready effect");
            setEffectByTrigger("tournament_ready");
          }
        },
      );
    }
  } catch (error) {
    log.error("wledFx initialization error", error);
  }
}

export function wledFxOnRemove() {
  log.info("wledFx on remove");

  if (gameDataProcessorUnwatch) {
    gameDataProcessorUnwatch();
    gameDataProcessorUnwatch = null;
  }

  if (lobbyDataWatcherUnwatch) {
    lobbyDataWatcherUnwatch();
    lobbyDataWatcherUnwatch = null;
  }

  if (boardDataWatcherUnwatch) {
    boardDataWatcherUnwatch();
    boardDataWatcherUnwatch = null;
  }

  if (tournamentDataWatcherUnwatch) {
    tournamentDataWatcherUnwatch();
    tournamentDataWatcherUnwatch = null;
  }

  setEffectByTrigger("idle");
}

/**
 * Process game triggers to set WLED effects
 * This is called by the centralized game data processor with derived triggers
 */
async function processGameDataFromTriggers(
  triggers: IGameTrigger[],
  gameData: IGameData,
): Promise<void> {
  if (!gameData.match || !gameData.match.turns?.length) return;

  let triggers_list: string = "";
  triggers.forEach((trigger) => {
    triggers_list += `\n${trigger.category.padStart(10)} | ${String(trigger.priority).padStart(3)} | ${trigger.trigger}`;
  });
  log.debug("processing triggers", triggers_list)

  currentBoardId = gameData.match.players?.[gameData.match.player].boardId;

  // For WLED, we only want to play the highest priority trigger
  // since LED effects can typically only show one at a time
  if (triggers.length === 0) {
    // Fallback to gameon if no triggers
    setEffectByTrigger("gameon");
    return;
  }

  // Check board filtering if configured
  if (
    config.wledFx.boardIds.length > 0 &&
    findMatchingItem(config.wledFx.effects ?? [], [{ trigger: "other", priority: 0, category: TRIGGER_CATEGORIES.OTHER }]) &&
    !config.wledFx.boardIds.includes(currentBoardId)
  ) {
    setEffectByTrigger("other");
    return;
  }

  // Find the highest-priority effect whose trigger conditions are all met
  const matchedEffect = findMatchingItem(config.wledFx.effects ?? [], triggers);
  if (matchedEffect) {
    log.info(`Playing effect "${matchedEffect[0].item.name}"`);
    await setEffect(matchedEffect[0].item);
    return;
  }

  // no effect was available, fall back to gameon
  setEffectByTrigger("gameon");
}


/**
 * Set an effect based on the trigger
 */
export async function setEffectByTrigger(trigger: string, wait: boolean = false): Promise<void> {
  if (!config) {
    config = await AutodartsToolsConfig.getValue();
    if (!config.wledFx.effects.length) {
      log.info("No effects configured");
      return;
    }
  }

  // Find all effects that match the trigger
  const matchingEffects = config.wledFx.effects.filter(
    effect => effect.enabled && effect.triggers && effect.triggers.includes(trigger),
  );

  const points = Number(trigger);
  if (!matchingEffects.length && !Number.isNaN(points)) {
    const range_triggers = config.wledFx.effects.filter(
      effect =>
        effect.enabled && effect?.triggers.some(trigger => trigger.match(triggerPatterns.ranges)),
    );
    for (let i = 0; i < range_triggers.length; i++) {
      const element = range_triggers[i];
      for (let j = 0; j < element.triggers.length; j++) {
        const parts = element.triggers[j].match(triggerPatterns.ranges);
        if (!parts) continue;
        const min = Number(parts[1]);
        const max = Number(parts[2]);
        if (min <= points && points <= max) {
          matchingEffects.push(element);
          break;
        }
      }
    }
  }

  if (!matchingEffects.length) {
    log.info(`No effect found for trigger "${trigger}"`);
    return;
  }

  // If multiple effects match the trigger, pick a random one
  const randomIndex = Math.floor(Math.random() * matchingEffects.length);
  const nextEffect = matchingEffects[randomIndex];

  log.info(`Found matching effect ${nextEffect.name}`);
  await setEffect(nextEffect, wait);
}

let currentEffect: IWled;
export async function setEffect(effect: IWled, wait: boolean = false) {
  if (!config)
    config = await AutodartsToolsConfig.getValue();

  if (config.wledFx.onlyOnce && effect === currentEffect) {
    log.info("didn't fetch", effect.url, "because the effect is already active");
    return;
  }
  if (!effect.url) {
    log.info("effect", effect.name, "doesn't have an url");
    return;
  }
  currentEffect = effect;
  log.info("fetching", effect.url);

  const controller = new AbortController();
  const data: RequestInit = {
    mode: "no-cors",
    method: effect.type === WledType.URL ? "GET" : "POST",
    signal: controller.signal,
    cache: "no-cache" as RequestCache,
    credentials: "omit" as RequestCredentials,
    ...(effect.type === WledType.API && {
      headers: { 'Content-Type': 'application/json' },
      body: effect.json_api
    }),
  };
  let url = effect.url;
  if (effect.type === WledType.PRESET) {
    url = (effect.url.startsWith('http') ? '' : 'http://')
      + effect.url
      + (effect.url.endsWith('/') ? '' : '/')
      + 'win/PL=' + effect.preset;
  }
  if (wait) {
    try {
      // Use setTimeout to ensure the fetch doesn't block or interfere with page state
      // This makes it truly fire-and-forget
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      await fetch(url, data);
      clearTimeout(timeoutId);
    } catch (e) {
      const error = e as Error;
      if (error.name !== "AbortError") {
        log.info("Request failed (non-critical)", error);
      }
    }
  } else {
    setTimeout(() => {
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      fetch(url, data)
        .then(() => {
          clearTimeout(timeoutId);
          // Success - no need to do anything with no-cors response
        })
        .catch((e) => {
          const error = e as Error;
          clearTimeout(timeoutId);
          // Silently ignore errors to prevent interfering with game state
          if (error.name !== "AbortError") {
            log.info("Request failed (non-critical)", error);
          }
        });
    }, 0);
  }
}
