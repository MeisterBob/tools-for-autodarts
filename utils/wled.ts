import { setEffectByTrigger } from "@/entrypoints/match.content/wled";
import { type IGameData, GameMode } from "@/utils/game-data-storage";
import { type IConfig } from "@/utils/storage";

const gameHandlers: { [key in GameMode]: CallableFunction } = {
  [GameMode.ATC]: processAtcRtwShanghaiData,
  [GameMode.BERMUDA]: processX01Data,
  [GameMode.BOBS_27]: processAtcRtwShanghaiData,
  [GameMode.BULL_OFF]: processBullOffData,
  [GameMode.COUNT_UP]: processX01Data,
  [GameMode.CRICKET]: processCricketData,
  [GameMode.GOTCHA]: processX01Data,
  [GameMode.RANDOM_CHECKOUT]: processX01Data,
  [GameMode.RTW]: processAtcRtwShanghaiData,
  [GameMode.SEGMENT_TRAINING]: processX01Data,
  [GameMode.SHANGHAI]: processAtcRtwShanghaiData,
  [GameMode.TACTICS]: processCricketData,
  [GameMode.X01]: processX01Data,
};

function triggerPresentWithName(triggerPresentCB: (trigger: string) => boolean, trigger: string, name: string) {
  const nameLower = name.toLowerCase();
  const nameWithUnderscores = nameLower.replace(/\s+/g, "_");
  const candidates = [`${trigger}_${nameLower}`, `${trigger}_${nameWithUnderscores}`, trigger];
  for (const candidate of candidates) {
    if (triggerPresentCB(candidate))
      return candidate;
  }
  return null;
}

/** Entry point for WLED trigger resolution. Checks match/game winners first,
 *  then delegates to the appropriate game-mode handler. Falls back to the X01
 *  processor when the mode-specific handler returns no trigger. */
export async function gameDataProcessor(
  config: IConfig,
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
  triggerPresentCB: (trigger: string) => boolean
): Promise<string | null> {
  if (!gameData.match) return null;

  let trigger: string | null = null;

  const winner: boolean = gameData.match.gameWinner >= 0;
  const winnerMatch: boolean = gameData.match.winner >= 0;
  const currentPlayer = gameData.match.players?.[gameData.match.player];
  const playerName = currentPlayer?.name;

  if (winnerMatch)
    trigger = triggerPresentWithName(triggerPresentCB, "matchshot", playerName);
  if (winner)
    trigger = triggerPresentWithName(triggerPresentCB, "gameshot", playerName);

  const variant = gameData.match!.variant;
  if (variant in gameHandlers)
    return await gameHandlers[variant](config, gameData, oldGameData, fromWebSocket, triggerPresentCB);

  console.log('Autodarts Tools: WLED: unhandled game variant', variant, 'using X01 processor');
  return await gameHandlers[GameMode.X01](config, gameData, oldGameData, fromWebSocket, triggerPresentCB);
}

/** Always returns "bulloff" trigger — no per-throw logic needed. */
async function processBullOffData(
  config: IConfig,
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
  triggerPresentCB: (trigger: string) => boolean
): Promise<string | null> {
  const currentPlayer = gameData.match!.players?.[gameData.match!.player];
  const playerName = currentPlayer?.name;

  return triggerPresentWithName(triggerPresentCB, 'bulloff', playerName);
}

/** Resolves a WLED trigger for X01-style games (also used as fallback for other modes).
 *  Priority: matchshot > gameshot > busted > combined three-dart key > round points > single throw name. */
async function processX01Data(
  config: IConfig,
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
  triggerPresentCB: (trigger: string) => boolean
): Promise<string | null> {
  if (!gameData.match) return null;

  const currentThrow = gameData.match.turns[0].throws[gameData.match.turns[0].throws.length - 1];
  if (!currentThrow) return null;

  const isLastThrow: boolean = gameData.match.turns[0].throws.length >= 3;
  let throwName: string = currentThrow.segment.name.toLowerCase();
  const winner: boolean = gameData.match.gameWinner >= 0;
  const winnerMatch: boolean = gameData.match.winner >= 0;
  const busted: boolean = gameData.match.turns[0].busted;
  const points: string = gameData.match.turns[0].points.toString();
  const combinedThrows: string = gameData.match.turns[0].throws
    .map((t) => t.segment.name.toLowerCase())
    .join("_");

  if (throwName === "25" && currentThrow.segment.bed.startsWith("Single")) throwName = "s25";

  if (winnerMatch && triggerPresentCB("matchshot+" + throwName)) return "matchshot+" + throwName;
  if (winner && triggerPresentCB("gameshot+" + throwName)) return "gameshot+" + throwName;
  if (busted && triggerPresentCB("busted")) return "busted";
  if (isLastThrow && triggerPresentCB(combinedThrows)) return combinedThrows;
  if (!busted && isLastThrow && triggerPresentCB(points)) return points;
  if (triggerPresentCB(throwName)) return throwName;

  return null;
}

/** Resolves the current target field for sequential-target modes (ATC, RTW, Shanghai, Bob's 27)
 *  and returns a "target<N>" trigger. For ATC in Double/Triple mode the bull target becomes "targetbull". */
async function processAtcRtwShanghaiData(
  config: IConfig,
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
  triggerPresentCB: (trigger: string) => boolean
): Promise<string | null> {
  const winner: boolean = gameData.match!.gameWinner >= 0
  const winnerMatch: boolean = gameData.match!.winner >= 0
  if (winnerMatch && triggerPresentCB('matchshot')) return 'matchshot';
  if (winner && triggerPresentCB('gameshot')) return 'gameshot';

  const player: number = gameData.match!.player
  const round: number | string = gameData.match!.round
  var targetField: string | number = 0
  switch (gameData.match!.variant) {
    case GameMode.ATC:
      targetField = gameData.match!.state.targets[player][gameData.match!.state.currentTargets[player]].number;
      if (targetField === 25 && ['Double', 'Triple'].some((v) => v === gameData.match!.settings.mode)) {
        targetField = 'bull';
      }
      break;
    case GameMode.RTW:
      targetField = gameData.match!.state.targets[round - 1].number;
      break;
    case GameMode.SHANGHAI:
      targetField = gameData.match!.state.targets[round - 1];
      break;
    case GameMode.BOBS_27:
      targetField = round;
      break;
  }

  const trigger = `target${targetField}`
  console.log(`Autodarts Tools: WLED: current target ${targetField}`)
  if (triggerPresentCB(trigger)) return trigger
  return null
}

/** Handles Cricket / Tactics games. Fires per-dart effects, builds a segment-state URL
 *  (encoding each field as closed "c", open "o", or hit count), and POSTs it non-blocking
 *  with a 2-second timeout. */
async function processCricketData(
  config: IConfig,
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
  triggerPresentCB: (trigger: string) => boolean
): Promise<string | null> {
  if (!gameData.match) return null;
  if (!config.wledFx.cricketPrefix) return null;

  const winner: boolean = gameData.match.gameWinner >= 0;
  const winnerMatch: boolean = gameData.match.winner >= 0;
  if (winnerMatch && triggerPresentCB("matchshot")) return "matchshot";
  if (winner && triggerPresentCB("gameshot")) return "gameshot";

  for (const dart of ['first', 'second', 'third']) {
    if (triggerPresentCB(`cricket_${dart}_dart`)) {
      setEffectByTrigger(`cricket_${dart}_dart`, true);
    }
  }

  const state: [number[]] = gameData.match.state.segments;
  const player: number = gameData.match.player;
  let url: string = `${config.wledFx.cricketPrefix}/${gameData.match.variant.toLowerCase()}`;
  Object.entries(state)
    .map(([field, value]) => {
      let state: string = `${value[player]}`;
      if (value.every(v => v >= 3)) state = "c"
      else if (value[player] >= 3) state = "o"
      url += `/${state}`;
    });

  console.log("Autodarts Tools: WLED:", url);
  fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => { });

  return 'cricket_gameon';
}
