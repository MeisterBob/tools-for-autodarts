import { type IGameData } from "@/utils/game-data-storage";

export async function gameDataProcessor(
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
  triggerPresentCB: (trigger: string) => boolean
): Promise<string | null> {
  let trigger: string | null = null;
  console.log("processor");

  switch (gameData.match!.variant) {
    case "X01":
      trigger = await processX01Data(gameData, oldGameData, fromWebSocket, triggerPresentCB);
      break;
    case "cricket":
      trigger = await processCricketData(gameData, oldGameData, fromWebSocket, triggerPresentCB);
      break;
    default:
      console.log(
        `Autodarts Tools: WLED: unhandled game variant ${gameData?.match?.variant} using X01 processor`
      );
      trigger = await processX01Data(gameData, oldGameData, fromWebSocket, triggerPresentCB);
      break;
  }

  return trigger;
}

async function processX01Data(
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
  if (winnerMatch && triggerPresentCB("matchshot")) return "matchshot";
  if (winner && triggerPresentCB("gameshot+" + throwName)) return "gameshot+" + throwName;
  if (winner && triggerPresentCB("gameshot")) return "gameshot";
  if (busted && triggerPresentCB("busted")) return "busted";
  if (isLastThrow && triggerPresentCB(combinedThrows)) return combinedThrows;
  if (isLastThrow && triggerPresentCB(points)) return points;
  if (triggerPresentCB(throwName)) return throwName;

  return null;
}

async function processCricketData(
  gameData: IGameData,
  oldGameData: IGameData,
  fromWebSocket: boolean = false,
  triggerPresentCB: (trigger: string) => boolean
): Promise<string | null> {
  return null;
}
