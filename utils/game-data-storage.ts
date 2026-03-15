import type { IMatch } from "./websocket-helpers";

export enum GameMode {
  BULL_OFF = "Bull-off",
  X01 = "X01",
  CRICKET = "Cricket",
  TACTICS = "Tactics",
  BERMUDA = "Bermuda",
  SHANGHAI = "Shanghai",
  GOTCHA = "Gotcha",
  ATC = "ATC",
  RTW = "RTW",
  RANDOM_CHECKOUT = "Random Checkout",
  COUNT_UP = "CountUp",
  SEGMENT_TRAINING = "Segment Training",
  BOBS_27 = "Bob's 27",
}

export interface IGameData {
  private: boolean;
  gameMode: GameMode;
  match: IMatch | undefined;
}

export const defaultGameData: IGameData = {
  private: false,
  gameMode: GameMode.X01,
  match: undefined,
};

export const AutodartsToolsGameData: WxtStorageItem<IGameData, any> = storage.defineItem(
  "local:game-data",
  {
    defaultValue: defaultGameData,
  },
);
