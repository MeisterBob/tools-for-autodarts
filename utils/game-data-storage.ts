import type { IMatch } from "./websocket-helpers";

export enum GameMode {
  ATC = "ATC",
  BERMUDA = "Bermuda",
  BOBS_27 = "Bob's 27",
  BULL_OFF = "Bull-off",
  COUNT_UP = "CountUp",
  CRICKET = "Cricket",
  GOTCHA = "Gotcha",
  RANDOM_CHECKOUT = "Random Checkout",
  RTW = "RTW",
  SEGMENT_TRAINING = "Segment Training",
  SHANGHAI = "Shanghai",
  TACTICS = "Tactics",
  X01 = "X01",
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
