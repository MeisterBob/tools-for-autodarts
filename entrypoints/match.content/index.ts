import "~/assets/tailwind.css";
import { createApp } from "vue";

import { colorChange, onRemove as colorChangeOnRemove } from "./color-change";
import Takeout from "./Takeout.vue";
import { nextPlayerOnTakeOutStuck, nextPlayerOnTakeOutStuckOnRemove } from "./next-player-on-take-out-stuck";
import { automaticNextLeg, automaticNextLegOnRemove } from "./automatic-next-leg";
import { smallerScores } from "./smaller-scores";
import { hideMenuInMatch, hideMenuInMatchOnRemove } from "./hide-menu-in-match";
import { automaticFullscreen, automaticFullscreenOnRemove } from "./automatic-fullscreen";
import { largerPlayerMatchData } from "./larger-player-match-data";
import { largerLegsSets } from "./larger-legs-sets";
import { largerPlayerNames } from "./larger-player-names";
import { winnerAnimation, winnerAnimationOnRemove } from "./winner-animation";
import { soundFx, soundFxOnRemove } from "./sound-fx";
import { wledFx, wledFxOnRemove } from "./wled";
import { caller, callerOnRemove } from "./caller";
import Zoom from "./Zoom.vue";
import Animations from "./Animations.vue";
import StreamingMode from "./StreamingMode.vue";
import QuickCorrection from "./QuickCorrection.vue";
import InstantReplay from "./InstantReplay.vue";
import Gotcha from "./Gotcha.vue";
import { discordStream, discordStreamOnRemove } from "./discord-stream";
import { enhancedScoringDisplay, enhancedScoringDisplayOnRemove } from "./enhanced-scoring-display";

import { waitForElement, waitForElementWithTextContent } from "@/utils";
import {
  AutodartsToolsConfig,
  AutodartsToolsUrlStatus,
} from "@/utils/storage";
import { fetchWithAuth, isSafari, isiOS } from "@/utils/helpers";
import { processWebSocketMessage } from "@/utils/websocket-helpers";
import { AutodartsToolsGameData } from "@/utils/game-data-storage";
import { initGameDataProcessor } from "@/composables/useGameDataProcessor";

let matchInitialized = false;
let activeMatchObserver: MutationObserver | null;
let gameDataWatcher: any;

const tools = {
  streamingMode: null as any,
  takeout: null as any,
  animations: null as any,
  zoom: null as any,
  quickCorrection: null as any,
  enhancedScoringDisplay: null as any,
  instantReplay: null as any,
  gotcha: null as any,
};

/** Configuration for feature initializers */
interface FeatureInitializer {
  configPath: string; // dot-notation path to config property (e.g., "animations.enabled")
  init: (ctx: any, url: string) => Promise<void>;
  toolName?: string; // name of property in tools object to store result
  onRemove?: () => void; // cleanup function
}

/** Define all feature initializers in order */
const featureInitializers: FeatureInitializer[] = [
  // Sounds, Animation and WLED
  {
    configPath: "animations.enabled",
    init: (ctx) => initAnimations(ctx),
    toolName: "animations",
  },
  {
    configPath: "caller.enabled",
    init: (ctx, url) => initScript(caller, url),
    onRemove: callerOnRemove,
  },
  {
    configPath: "soundFx.enabled",
    init: (ctx, url) => initScript(soundFx, url),
    onRemove: soundFxOnRemove,
  },
  {
    configPath: "wledFx.enabled",
    init: (ctx, url) => initScript(wledFx, url),
    onRemove: wledFxOnRemove,
  },
  // Matches
  {
    configPath: "hideMenuInMatch.enabled",
    init: (ctx, url) => initScript(hideMenuInMatch, url),
    onRemove: hideMenuInMatchOnRemove,
  },
  {
    configPath: "automaticFullscreen.enabled",
    init: (ctx, url) => initScript(automaticFullscreen, url),
    onRemove: automaticFullscreenOnRemove,
  },
  {
    configPath: "streamingMode.enabled",
    init: (ctx) => initStreamingMode(ctx),
    toolName: "streamingMode",
  },
  {
    configPath: "colors.enabled",
    init: (ctx, url) => initScript(colorChange, url),
    onRemove: colorChangeOnRemove,
  },
  {
    configPath: "takeout.enabled",
    init: (ctx) => initTakeout(ctx),
    toolName: "takeout",
  },
  {
    configPath: "nextPlayerOnTakeOutStuck.enabled",
    init: (ctx, url) => initScript(nextPlayerOnTakeOutStuck, url),
    onRemove: nextPlayerOnTakeOutStuckOnRemove,
  },
  {
    configPath: "automaticNextLeg.enabled",
    init: (ctx, url) => initScript(automaticNextLeg, url),
    onRemove: automaticNextLegOnRemove,
  },
  {
    configPath: "smallerScores.enabled",
    init: (ctx, url) => initScript(smallerScores, url),
  },
  {
    configPath: "largerLegsSets.enabled",
    init: (ctx, url) => initScript(largerLegsSets, url),
  },
  {
    configPath: "largerPlayerMatchData.enabled",
    init: (ctx, url) => initScript(largerPlayerMatchData, url),
  },
  {
    configPath: "largerPlayerNames.enabled",
    init: (ctx, url) => initScript(largerPlayerNames, url),
  },
  {
    configPath: "winnerAnimation.enabled",
    init: (ctx, url) => initScript(winnerAnimation, url),
    onRemove: winnerAnimationOnRemove,
  },
  {
    configPath: "zoom.enabled",
    init: (ctx) => initZoom(ctx),
    toolName: "zoom",
  },
  {
    configPath: "quickCorrection.enabled",
    init: (ctx) => initQuickCorrection(ctx),
    toolName: "quickCorrection",
  },
  {
    configPath: "instantReplay.enabled",
    init: (ctx) => initInstantReplay(ctx),
    toolName: "instantReplay",
  },
  {
    configPath: "gotcha.enabled",
    init: (ctx) => initGotcha(ctx),
    toolName: "gotcha",
  },
  {
    configPath: "enhancedScoringDisplay.enabled",
    init: (ctx, url) => initScript(enhancedScoringDisplay, url),
    onRemove: enhancedScoringDisplayOnRemove,
  },
];

/**
 * Get nested config value using dot notation
 * @param obj Config object
 * @param path Dot-notation path (e.g., "animations.enabled")
 */
function getConfigValue(obj: any, path: string): any {
  return path.split(".").reduce((current, prop) => current?.[prop], obj);
}

export default defineContentScript({
  matches: ["*://play.autodarts.io/*"],
  cssInjectionMode: "ui",
  async main(ctx: any) {
    AutodartsToolsUrlStatus.watch(async (url: string) => {
      if (!url && (isiOS() || isSafari())) url = window.location.href;

      if (/\/(matches|boards)\/([0-9a-f-]+)/.test(url) && !url.includes("history")) {
        await waitForElement("#root > div > div:nth-of-type(2)");

        // Extract lobby ID from URL and fetch lobby data
        let matchId = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
        if (matchId) {
          try {
            console.log("Autodarts Tools: Fetching match data with cookie authentication...");

            if (url.includes("boards")) {
              const apiUrl = `https://api.autodarts.io/bs/v0/boards/${matchId}`;
              const response = await fetchWithAuth(apiUrl);

              if (response.ok) {
                matchId = (await response.json()).matchId;
              }
            }

            console.log("Autodarts Tools: Match ID:", matchId);

            const apiUrl = `https://api.autodarts.io/gs/v0/matches/${matchId}/state`;
            const response = await fetchWithAuth(apiUrl);

            console.log("Autodarts Tools: Response status:", response.status);

            if (response.ok) {
              const matchData = await response.json();
              console.log("Autodarts Tools: Match Data:", matchData);
              await processWebSocketMessage("autodarts.matches", matchData);
            } else {
              console.error("Autodarts Tools: Failed to fetch match data", response.status, response.statusText);
            }
          } catch (error) {
            console.error("Autodarts Tools: Error fetching match data:", error);
          }
        }

        const activeMatch = window.location.href.includes("boards") ? !(await waitForElementWithTextContent("h2", ["Board has no active match", "Board hat kein aktives Spiel", "Bord heeft geen actieve wedstrijd"], 1000).catch(() => undefined)) : true;

        if (activeMatch) {
          console.log("Autodarts Tools: Match found, initializing match");
          initMatch(ctx, url, matchId).catch(console.error);

          if (!gameDataWatcher) {
            gameDataWatcher = AutodartsToolsGameData.watch(async (value, oldValue) => {
              if (oldValue?.match?.variant === "Bull-off" && value?.match?.variant !== "Bull-off") {
                // Get current URL and matchId instead of using closure values
                const currentUrl = window.location.href;
                const currentMatchId = value?.match?.id || currentUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
                clearMatch(true);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return initMatch(ctx, currentUrl, currentMatchId);
              }
            });
          }
        } else {
          console.log("Autodarts Tools: No Active Match found, waiting for match to start");
        }

        // Disconnect existing observer before creating a new one
        activeMatchObserver?.disconnect();
        activeMatchObserver = startActiveMatchObserver(ctx);
      } else {
        clearMatch();
      }
    });
  },
});

async function initMatch(ctx, url: string, matchId?: string) {
  if (matchInitialized) return;
  matchInitialized = true;

  console.log("Autodarts Tools: Initializing match");

  const config = await AutodartsToolsConfig.getValue();
  await initGameDataProcessor();

  // Initialize all features based on configuration
  for (const feature of featureInitializers) {
    if (getConfigValue(config, feature.configPath)) {
      try {
        const result = await feature.init(ctx, url);
        if (feature.toolName && result) {
          tools[feature.toolName] = result;
        }
      } catch (error) {
        console.error(`Autodarts Tools: Error initializing ${feature.configPath}:`, error);
      }
    }
  }

  // Special case: discord stream (requires additional check)
  if (matchId && config.discord.autoStartAfterTimer?.stream) {
    if (config.discord.autoStartAfterTimer?.matchId === matchId || config.discord.autoStartAfterTimer?.matchId?.includes(matchId)) {
      await initScript(discordStream, url).catch(console.error);
    }
  }
}

function clearMatch(fromBullOff: boolean = false) {
  console.log("Autodarts Tools: Clearing match");

  // Always disconnect the observer when clearing
  activeMatchObserver?.disconnect();
  activeMatchObserver = null;

  // Clean up gameDataWatcher
  if (gameDataWatcher) {
    gameDataWatcher();
    gameDataWatcher = null;
  }

  // Remove tool UI elements
  tools.streamingMode?.remove();
  tools.takeout?.remove();
  tools.animations?.remove();
  tools.zoom?.remove();
  tools.gotcha?.forEach((e) => e.remove());
  tools.quickCorrection?.remove();
  tools.instantReplay?.remove();

  // Call onRemove handlers for all features
  for (const feature of featureInitializers) {
    if (feature.onRemove) {
      try {
        feature.onRemove();
      } catch (error) {
        console.error(`Autodarts Tools: Error in cleanup for ${feature.configPath}:`, error);
      }
    }
  }

  // Special cleanup for features that need conditional removal
  if (!fromBullOff) hideMenuInMatchOnRemove();
  if (!fromBullOff) automaticFullscreenOnRemove();
  discordStreamOnRemove();

  matchInitialized = false;
}

async function initScript(fn: any, url: string) {
  if (window.location.href !== url) return;
  await fn();
}

function startActiveMatchObserver(ctx) {
  const targetNode = document.querySelector("#root > div > div:nth-of-type(2)");
  const observer = new MutationObserver(async () => {
    const url = window.location.href;
    // Check for match/board URL pattern and exclude history pages
    if (!(/\/(matches|boards)\/([0-9a-f-]+)/.test(url)) || url.includes("history")) return;

    // Check if the "Board has no active match" element no longer exists
    const activeMatch = window.location.href.includes("boards") ? !(await waitForElementWithTextContent("h2", ["Board has no active match", "Board hat kein aktives Spiel", "Bord heeft geen actieve wedstrijd"], 1000).catch(() => undefined)) : true;

    if (!activeMatch) {
      console.log("Autodarts Tools Observer: No Active Match found, waiting for match to start");
      if (matchInitialized) {
        matchInitialized = false;
        clearMatch();
      }
    } else {
      const url = await AutodartsToolsUrlStatus.getValue();
      let matchId = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];

      if (url.includes("boards")) {
        const apiUrl = `https://api.autodarts.io/bs/v0/boards/${matchId}`;
        const response = await fetchWithAuth(apiUrl);

        if (response.ok) {
          matchId = (await response.json()).matchId;
        }
      }

      console.log("Autodarts Tools Observer: Match ID:", matchId);

      if (!matchInitialized && matchId) {
        console.log("Autodarts Tools Observer: Match found, initializing match because activeMatch is true");
        initMatch(ctx, url, matchId).catch(console.error);
      }
    }
  });

  // Add null check before observing
  if (targetNode) {
    observer.observe(targetNode, {
      childList: true,
      subtree: true,
    });
  }

  return observer;
}

async function initTakeout(ctx) {
  tools.takeout = await createShadowRootUi(ctx, {
    name: "autodarts-tools-takeout",
    position: "inline",
    anchor: "#root > div > div:nth-of-type(2)",
    onMount: (container) => {
      console.log("Autodarts Tools: Takeout initialized");
      const takeout = createApp(Takeout);
      takeout.mount(container);
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        container.classList.add("dark");
      }
      return takeout;
    },
    onRemove: (takeout) => {
      takeout?.unmount();
    },
  });
  tools.takeout.mount();
}

async function initStreamingMode(ctx) {
  await waitForElement("#ad-ext-player-display");
  tools.streamingMode = await createShadowRootUi(ctx, {
    name: "autodarts-tools-streaming-mode",
    position: "inline",
    anchor: "#root",
    onMount: (container: any) => {
      console.log("Autodarts Tools: Streaming Mode initialized");
      const app = createApp(StreamingMode);
      app.mount(container);
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        container.classList.add("dark");
      }
      return app;
    },
    onRemove: (app: any) => {
      app?.unmount();
      console.log("Autodarts Tools: Streaming Mode removed");
    },
  });

  tools.streamingMode.mount();
}

async function initAnimations(ctx) {
  await waitForElement("#root > div > div:nth-of-type(2)");
  tools.animations = await createShadowRootUi(ctx, {
    name: "autodarts-tools-animations",
    position: "inline",
    anchor: "#root > div > div:nth-of-type(2)",
    onMount: (container: any) => {
      console.log("Autodarts Tools: Animations initialized");
      const app = createApp(Animations);
      app.mount(container);
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        container.classList.add("dark");
      }
      return app;
    },
    onRemove: (app: any) => {
      app?.unmount();
      console.log("Autodarts Tools: Animations removed");
    },
  });

  tools.animations.mount();
}

async function initZoom(ctx) {
  await waitForElement("#root > div > div:nth-of-type(2)");
  const config = await AutodartsToolsConfig.getValue();

  const selector = (config.zoom.position === "bottom-right" || config.zoom.position === "bottom-left") ? "#root > div > div:nth-of-type(2)" : "#root > div > div:nth-of-type(1)";

  tools.zoom = await createShadowRootUi(ctx, {
    name: "autodarts-tools-zoom",
    position: "inline",
    anchor: selector,
    onMount: (container: any) => {
      console.log("Autodarts Tools: Zoom initialized");
      const app = createApp(Zoom);
      app.mount(container);
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        container.classList.add("dark");
      }
      return app;
    },
    onRemove: (app: any) => {
      app?.unmount();
      console.log("Autodarts Tools: Zoom removed");
    },
  });

  tools.zoom.mount();
}

async function initGotcha(ctx) {
  const selector = "div.ad-ext-player";
  await waitForElement(selector);
  const elements = document.querySelectorAll(selector);
  const shadowRootPromises = Array.from(elements).map(async (e, index) => {
    if (!e.id) {
      e.id = `ad-ext-player-${index}`;
    }
    return await createShadowRootUi(
      ctx,
      {
        name: "autodarts-tools-gotcha",
        position: "inline",
        anchor: `#${e.id} > div:first-of-type > p:first-of-type`,
        append: 'after',
        onMount: (container: any) => {
          console.log("Autodarts Tools: Gotcha: initialized");
          const app = createApp(Gotcha, { playerIndex: index });
          app.mount(container);
          if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
            container.classList.add("dark");
          }
          return app;
        },
        onRemove: (app: any) => {
          app?.unmount();
          console.log("Autodarts Tools: Gotcha: removed");
        },
      }
    );
  });
  tools.gotcha = await Promise.all(shadowRootPromises);
  tools.gotcha.forEach((e) => e.mount());
}

async function initQuickCorrection(ctx) {
  await waitForElement("#root > div > div:nth-of-type(2)");
  tools.quickCorrection = await createShadowRootUi(ctx, {
    name: "autodarts-tools-quick-correction",
    position: "inline",
    anchor: "#root > div > div:nth-of-type(2)",
    onMount: (container: any) => {
      console.log("Autodarts Tools: Quick Correction initialized");
      const app = createApp(QuickCorrection);
      app.mount(container);
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        container.classList.add("dark");
      }
      return app;
    },
    onRemove: (app: any) => {
      app?.unmount();
      console.log("Autodarts Tools: Quick Correction removed");
    },
  });

  tools.quickCorrection.mount();
}

async function initInstantReplay(ctx) {
  await waitForElement("#root > div > div:nth-of-type(2)");
  tools.instantReplay = await createShadowRootUi(ctx, {
    name: "autodarts-tools-instant-replay",
    position: "inline",
    anchor: "#root > div > div:nth-of-type(2)",
    onMount: (container: any) => {
      console.log("Autodarts Tools: Instant Replay initialized");
      const app = createApp(InstantReplay);
      app.mount(container);
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        container.classList.add("dark");
      }
      return app;
    },
    onRemove: (app: any) => {
      app?.unmount();
      console.log("Autodarts Tools: Instant Replay removed");
    },
  });

  tools.instantReplay.mount();
}
