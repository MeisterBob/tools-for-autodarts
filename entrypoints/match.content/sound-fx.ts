import { AutodartsToolsConfig, type IConfig, type ISound, type ISoundTTS } from "@/utils/storage";
import { getSoundFxFromIndexedDB, isIndexedDBAvailable } from "@/utils/helpers";
import {
  registerGameDataCallback,
  unregisterGameDataCallback,
  handleBoardEvent,
  findMatchingItem,
  type IGameTrigger,
} from "@/composables/useGameDataProcessor";
import type { IGameData } from "@/utils/game-data-storage";
import { TRIGGER_CATEGORIES } from "@/composables/useGameDataProcessor";
import { createLogger } from "@/utils/logger";
const log = createLogger("Sound FX")

let gameDataProcessorUnwatch: (() => void) | null = null;
let lobbyDataWatcherUnwatch: any;
let boardDataWatcherUnwatch: any;
let tournamentReadyObserver: MutationObserver | null = null;
let config: IConfig;
// Cached id of the local user (decoded from the auth token), used to tell own throws from opponent throws
let localUserId: string | null = null;

// Audio player for Safari compatibility
let audioPlayer: HTMLAudioElement | null = null;
let audioPlayer2: HTMLAudioElement | null = null;
// Queue for sounds to be played
const soundQueue: { url?: string; base64?: string; name?: string; soundId?: string; tts?: ISoundTTS }[] = [];
const soundQueue2: { url?: string; base64?: string; name?: string; soundId?: string; tts?: ISoundTTS }[] = [];
// Flag to track if we're currently playing a sound
let isPlaying = false;
let isPlaying2 = false;
// Flag to track if audio has been unlocked
let audioUnlocked = false;
let audioUnlocked2 = false;
// Cooldown tracking for gameshot/matchshot sounds (to prevent multiple triggers from AI referee)
let lastGameshotTimestamp: number = 0;
const GAMESHOT_COOLDOWN_MS = 10000; // 10 seconds cooldown
// Flag to track if we've shown the interaction notification
let interactionNotificationShown = false;
// Reference to notification element
let notificationElement: HTMLElement | null = null;
// Reference to the style element for notification
let notificationStyleElement: HTMLStyleElement | null = null;

// Audio element pool for Safari compatibility
const AUDIO_POOL_SIZE = 3;
const audioPool: HTMLAudioElement[] = [];
const audioPool2: HTMLAudioElement[] = [];
let currentAudioIndex = 0;
let currentAudioIndex2 = 0;
// Tracking URLs that need to be revoked
const blobUrlsToRevoke: string[] = [];

function _is_enabled(config: IConfig, gameMode: GameMode): boolean {
  if (config.soundFx.enabled && config.soundFx.enabledGameModes.includes(gameMode))
    return true;
  return false;
}

export async function soundFx() {
  log.info();

  try {
    config = await AutodartsToolsConfig.getValue();
    log.info("Config loaded", config?.soundFx?.sounds?.length || 0, "sounds available");

    // Initialize audio player for Safari compatibility
    initAudioPlayer();

    // Register with centralized game data processor (only once)
    if (!gameDataProcessorUnwatch) {
      registerGameDataCallback("sound-fx", async (triggers: IGameTrigger[], gameData: IGameData) => {
        if (!_is_enabled(config, gameData.gameMode)) return;
        await processGameDataFromTriggers(triggers, gameData);
      });
      gameDataProcessorUnwatch = () => unregisterGameDataCallback("sound-fx");
    }

    if (!lobbyDataWatcherUnwatch) {
      lobbyDataWatcherUnwatch = AutodartsToolsLobbyData.watch(async (_lobbyData: ILobbies | undefined, _oldLobbyData: ILobbies | undefined) => {
        if (!_lobbyData || !_oldLobbyData || !config?.soundFx?.enabled) return;

        if ((_lobbyData.players?.length ?? 0) > (_oldLobbyData.players?.length ?? 0) && (_lobbyData.players?.length ?? 0) > 1) {
          const currentURL = window.location.href;
          if (!currentURL.includes("lobbies")) return;
          playSound("lobby_in", 2);
        }

        if ((_lobbyData.players?.length ?? 0) < (_oldLobbyData.players?.length ?? 0) && (_lobbyData.players?.length ?? 0) > 0) {
          const currentURL = window.location.href;
          if (!currentURL.includes("lobbies")) return;
          playSound("lobby_out", 2);
        }
      });
    }

    if (!boardDataWatcherUnwatch) {
      boardDataWatcherUnwatch = AutodartsToolsBoardData.watch((boardData: IBoard) => {
        if (config?.soundFx?.enabled)
          handleBoardEvent(boardData, playSound);
      });
    }

    if (!tournamentReadyObserver) {
      tournamentReadyObserver = new MutationObserver((mutations) => {
        if (!config?.soundFx?.enabled) return;

        // Check if "Time to ready up" text appears in the DOM
        const bodyText = document.body.textContent || document.body.innerText;
        if (bodyText.includes("Time to ready up") || bodyText.includes("Zeit zum bereitmachen") || bodyText.includes("Tijd om je klaar te maken")) {
          log.info("Found 'Time to ready up' text, playing tournament ready sound");
          playSound("tournament_ready");

          // Disconnect the observer after playing the sound once
          if (tournamentReadyObserver) {
            tournamentReadyObserver.disconnect();
            tournamentReadyObserver = null;
          }
        }
      });

      // Start observing the body for text changes
      tournamentReadyObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  } catch (error) {
    log.error("soundFx initialization error", error);
  }
}

export function soundFxOnRemove() {
  log.info("on remove");

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

  if (tournamentReadyObserver) {
    tournamentReadyObserver.disconnect();
    tournamentReadyObserver = null;
  }

  // Reset gameshot cooldown timestamp
  lastGameshotTimestamp = 0;

  // Cancel any ongoing TTS
  if (window.speechSynthesis) {
    speechSynthesis.cancel();
  }

  // Clean up audio players
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.removeEventListener("ended", () => playNextSound(1));
    audioPlayer = null;
  }

  if (audioPlayer2) {
    audioPlayer2.pause();
    audioPlayer2.removeEventListener("ended", () => playNextSound(2));
    audioPlayer2 = null;
  }

  // Clean up audio pools
  audioPool.forEach((audio) => {
    audio.pause();
    audio.src = "";
    audio.remove();
  });
  audioPool.length = 0;

  audioPool2.forEach((audio) => {
    audio.pause();
    audio.src = "";
    audio.remove();
  });
  audioPool2.length = 0;

  // Revoke any blob URLs
  blobUrlsToRevoke.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch (e) {
      log.error("Error revoking URL", e);
    }
  });
  blobUrlsToRevoke.length = 0;

  // Remove notification elements if they exist
  removeInteractionNotification();
}

/**
 * Initialize the audio player with Safari compatibility in mind
 */
function initAudioPlayer(): void {
  if (!audioPlayer) {
    audioPlayer = new Audio();

    // Add ended event listener to play the next sound in queue
    audioPlayer.addEventListener("ended", () => playNextSound(1));

    // Handle errors
    audioPlayer.addEventListener("error", (e) => {
      log.error("Audio playback error", e);
      // Move to next sound on error
      playNextSound(1);
    });

    // Initialize audio pool
    for (let i = 0; i < AUDIO_POOL_SIZE; i++) {
      const audio = new Audio();
      audio.addEventListener("ended", () => {
        log.info("Pool audio ended");
        playNextSound(1);
      });
      audio.addEventListener("error", (error) => {
        log.error("Pool audio error", error);
        document.addEventListener("click", unlockAudio, { once: true });
        document.addEventListener("touchstart", unlockAudio, { once: true });
        document.addEventListener("keydown", unlockAudio, { once: true });
        playNextSound(1);
      });
      audioPool.push(audio);
    }

    // Initialize second audio player
    audioPlayer2 = new Audio();

    // Add ended event listener to play the next sound in second queue
    audioPlayer2.addEventListener("ended", () => playNextSound(2));

    // Handle errors for second player
    audioPlayer2.addEventListener("error", (e) => {
      log.error("Audio playback error (channel 2)", e);
      // Move to next sound on error
      playNextSound(2);
    });

    // Initialize second audio pool
    for (let i = 0; i < AUDIO_POOL_SIZE; i++) {
      const audio = new Audio();
      audio.addEventListener("ended", () => {
        log.info("Pool audio ended (channel 2)");
        playNextSound(2);
      });
      audio.addEventListener("error", (error) => {
        log.error("Pool audio error (channel 2)", error);
        document.addEventListener("click", unlockAudio, { once: true });
        document.addEventListener("touchstart", unlockAudio, { once: true });
        document.addEventListener("keydown", unlockAudio, { once: true });
        playNextSound(2);
      });
      audioPool2.push(audio);
    }

    // Unlock audio on first user interaction (required for Safari/iOS)
    document.addEventListener("click", unlockAudio, { once: true });
    document.addEventListener("touchstart", unlockAudio, { once: true });
    document.addEventListener("keydown", unlockAudio, { once: true });
  }
}

/**
 * Unlock audio playback on user interaction (required for Safari/iOS)
 */
function unlockAudio(): void {
  if ((audioUnlocked && audioUnlocked2) || (!audioPlayer && !audioPlayer2)) return;

  log.info("Attempting to unlock audio");

  const silentAudio = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

  // Unlock first audio player
  if (audioPlayer && !audioUnlocked) {
    audioPlayer.src = silentAudio;
    audioPlayer.volume = 0.01;

    // Also unlock all audio pool elements
    audioPool.forEach((audio, i) => {
      audio.src = silentAudio;
      audio.volume = 1;
      // Don't play them all, just load them
      if (i === 0) {
        audio.play().catch(e => log.error("Error unlocking pool audio", e));
      }
    });

    audioPlayer.play()
      .then(() => {
        log.info("Audio unlocked successfully");
        audioUnlocked = true;
        hideInteractionNotification();

        // If we have sounds in the queue, start playing them
        if (soundQueue.length > 0 && !isPlaying) {
          playNextSound(1);
        }
      })
      .catch((error) => {
        log.error("Failed to unlock audio", error);
      });
  }

  // Unlock second audio player
  if (audioPlayer2 && !audioUnlocked2) {
    audioPlayer2.src = silentAudio;
    audioPlayer2.volume = 0.01;

    // Also unlock all audio pool elements for channel 2
    audioPool2.forEach((audio, i) => {
      audio.src = silentAudio;
      audio.volume = 1;
      // Don't play them all, just load them
      if (i === 0) {
        audio.play().catch(e => log.error("Error unlocking pool audio (channel 2)", e));
      }
    });

    audioPlayer2.play()
      .then(() => {
        log.info("Audio channel 2 unlocked successfully");
        audioUnlocked2 = true;
        hideInteractionNotification();

        // If we have sounds in the second queue, start playing them
        if (soundQueue2.length > 0 && !isPlaying2) {
          playNextSound(2);
        }
      })
      .catch((error) => {
        log.error("Failed to unlock audio channel 2", error);
      });
  }
}

/**
 * Shows a notification to inform the user they need to interact with the page
 */
function showInteractionNotification(): void {
  // Return if notification is already shown or if another notification with the same class already exists
  if (interactionNotificationShown || document.querySelector(".adt-notification")) return;

  interactionNotificationShown = true;

  // Add style for notification if not already added
  if (!document.querySelector("style[data-adt-notification-style]")) {
    notificationStyleElement = document.createElement("style");
    notificationStyleElement.setAttribute("data-adt-notification-style", "");
    notificationStyleElement.textContent = `
      .adt-notification {
        position: fixed;
        bottom: 16px;
        right: 32px;
        z-index: 50;
        max-width: 28rem;
        border-radius: 6px;
        padding: 16px;
        box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
        backdrop-filter: blur(4px);
        background-color: rgba(0, 0, 0, 0.4);
        color: white;
      }
      .adt-notification::after {
        content: '';
        position: absolute;
        inset: 0;
        background-color: rgba(220, 38, 38, 0.3);
        border-radius: 6px;
        pointer-events: none;
      }
      .adt-notification-content {
        display: flex;
      }
      .adt-notification-icon {
        margin-right: 8px;
        flex-shrink: 0;
        font-size: 1.25rem;
      }
      .adt-notification-message {
        margin-right: 16px;
        flex-grow: 1;
      }
      .adt-notification-close {
        flex-shrink: 0;
        font-size: 1.25rem;
        opacity: 0.7;
        background: none;
        border: none;
        color: white;
        cursor: pointer;
      }
      .adt-notification-close:hover {
        opacity: 1;
      }
      
      /* Animation classes */
      @keyframes adt-notification-enter {
        from {
          transform: translateY(32px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
      .adt-notification {
        animation: adt-notification-enter 300ms ease-out forwards;
      }
    `;
    document.head.appendChild(notificationStyleElement);
  } else {
    // If the style element exists but we don't have a reference to it, get a reference
    notificationStyleElement = document.querySelector("style[data-adt-notification-style]");
  }

  // Create notification element if it doesn't exist
  if (!notificationElement) {
    notificationElement = document.createElement("div");
    notificationElement.className = "adt-notification";
    notificationElement.setAttribute("data-adt-notification-source", "sound-fx");
    notificationElement.innerHTML = `
      <div class="adt-notification-content">
        <div class="adt-notification-message">
          Please interact with the page (click, tap, or press a key) to enable audio for sound effects.
        </div>
        <button class="adt-notification-close">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><!-- Icon from Pixelarticons by Gerrit Halfmann - https://github.com/halfmage/pixelarticons/blob/master/LICENSE --><path fill="currentColor" d="M5 5h2v2H5zm4 4H7V7h2zm2 2H9V9h2zm2 0h-2v2H9v2H7v2H5v2h2v-2h2v-2h2v-2h2v2h2v2h2v2h2v-2h-2v-2h-2v-2h-2zm2-2v2h-2V9zm2-2v2h-2V7zm0 0V5h2v2z"/></svg>
        </button>
      </div>
    `;

    // Add click listener to close button
    const closeButton = notificationElement.querySelector(".adt-notification-close");
    if (closeButton) {
      closeButton.addEventListener("click", hideInteractionNotification);
    }

    // Add the notification to the DOM
    document.body.appendChild(notificationElement);
  } else {
    notificationElement.style.display = "block";
  }
}

/**
 * Hides the interaction notification
 */
function hideInteractionNotification(): void {
  if (notificationElement) {
    notificationElement.remove();
    notificationElement = null;
  }
  interactionNotificationShown = false;
}

/**
 * Completely removes notification elements from the DOM
 */
function removeInteractionNotification(): void {
  // Only remove the notification if it belongs to this feature
  if (notificationElement && notificationElement.getAttribute("data-adt-notification-source") === "sound-fx") {
    notificationElement.remove();
    notificationElement = null;

    // Only remove the style element if no other notifications are present
    if (notificationStyleElement && !document.querySelector(".adt-notification")) {
      notificationStyleElement.remove();
      notificationStyleElement = null;
    }
  }

  interactionNotificationShown = false;
}

/**
 * Process game triggers to play sound effects based on events
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
  log.info("processing triggers", triggers_list);

  // Handle gameshot/matchshot cooldown
  const hasGameshot = triggers.some(t => t.trigger === "gameshot" || t.trigger === "matchshot");
  if (hasGameshot) {
    const now = Date.now();
    if (now - lastGameshotTimestamp < GAMESHOT_COOLDOWN_MS) {
      log.info("Skipping gameshot/matchshot sound due to cooldown");
      return;
    }
    lastGameshotTimestamp = now;
  }

  const sound = findMatchingItem(config.soundFx.sounds, triggers);
  if (sound) {
    log.info("playing", sound);
    playSound(sound[0].item);
  } else {
    log.info("no sound found");
  }
}

/**
 * Play a sound based on a trigger string (for event triggers) or a pre-matched ISound
 * (for game data triggers). Adds the sound to a queue to be played sequentially.
 */
function playSound(triggerOrSound: string | ISound, soundChannel: number = 1): boolean {
  if (!config?.soundFx?.sounds || !config.soundFx.sounds.length) {
    log.info("No sounds configured");
    return false;
  }

  let soundToPlay: ISound | false;
  if (typeof triggerOrSound === "string") {
    soundToPlay = findMatchingItem(config.soundFx.sounds, [{ trigger: triggerOrSound, priority: 0, category: TRIGGER_CATEGORIES.OTHER }])[0];
    if (!soundToPlay) {
      log.info(`No sound found for trigger "${triggerOrSound}" (channel ${soundChannel})`);
      return false;
    }
  } else {
    soundToPlay = triggerOrSound;
  }

  log.info(`Found matching sound "${soundToPlay.name}" (channel ${soundChannel})`);

  // Check if there's a soundId that we need to load from IndexedDB
  if (soundToPlay.soundId && isIndexedDBAvailable()) {
    log.info(`Loading sound from IndexedDB ${soundToPlay.soundId} (channel ${soundChannel})`);

    // Get the sound from IndexedDB and play it
    getSoundFxFromIndexedDB(soundToPlay.soundId)
      .then((base64) => {
        if (base64) {
          log.info(`Successfully loaded sound from IndexedDB (channel ${soundChannel})`);
          // Add to queue
          if (soundChannel === 2) {
            soundQueue2.push({
              url: soundToPlay.url,
              base64,
              name: soundToPlay.name,
            });

            // Start playing if not already playing
            if (!isPlaying2) {
              playNextSound(2);
            }
          } else {
            soundQueue.push({
              url: soundToPlay.url,
              base64,
              name: soundToPlay.name,
            });

            // Start playing if not already playing
            if (!isPlaying) {
              playNextSound(1);
            }
          }
        } else {
          log.error("Failed to load sound from IndexedDB");
          // Fall back to URL if available
          if (soundToPlay.url) {
            if (soundChannel === 2) {
              soundQueue2.push({
                url: soundToPlay.url,
                base64: undefined,
                name: soundToPlay.name,
              });

              // Start playing if not already playing
              if (!isPlaying2) {
                playNextSound(2);
              }
            } else {
              soundQueue.push({
                url: soundToPlay.url,
                base64: undefined,
                name: soundToPlay.name,
              });

              // Start playing if not already playing
              if (!isPlaying) {
                playNextSound(1);
              }
            }
          }
        }
      })
      .catch((error) => {
        log.error("Error loading sound from IndexedDB", error);
        // Fall back to URL if available
        if (soundToPlay.url) {
          if (soundChannel === 2) {
            soundQueue2.push({
              url: soundToPlay.url,
              base64: undefined,
              name: soundToPlay.name,
            });

            // Start playing if not already playing
            if (!isPlaying2) {
              playNextSound(2);
            }
          } else {
            soundQueue.push({
              url: soundToPlay.url,
              base64: undefined,
              name: soundToPlay.name,
            });

            // Start playing if not already playing
            if (!isPlaying) {
              playNextSound(1);
            }
          }
        }
      });
  } else {
    // Use URL, base64, or TTS directly from the sound object
    // Add to queue
    if (soundToPlay.url || soundToPlay.base64 || soundToPlay.tts) {
      if (soundChannel === 2) {
        soundQueue2.push({
          url: soundToPlay.url,
          base64: soundToPlay.base64,
          name: soundToPlay.name,
          tts: soundToPlay.tts,
        });

        // Start playing if not already playing
        if (!isPlaying2) {
          playNextSound(2);
        }
      } else {
        soundQueue.push({
          url: soundToPlay.url,
          base64: soundToPlay.base64,
          name: soundToPlay.name,
          tts: soundToPlay.tts,
        });

        // Start playing if not already playing
        if (!isPlaying) {
          playNextSound(1);
        }
      }
    }
  }

  return true;
}

/**
 * Play the next sound in the queue
 */
/**
 * Play a TTS sound using the Web Speech API
 */
function playTTSSound(tts: ISoundTTS, channel: number): void {
  if (!window.speechSynthesis) {
    log.error("speechSynthesis not available");
    playNextSound(channel);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(tts.text);
  const voices = speechSynthesis.getVoices();

  // Try exact voice match by URI
  let voice = voices.find(v => v.voiceURI === tts.voiceURI);
  // Fallback: match by language
  if (!voice && tts.lang) {
    voice = voices.find(v => v.lang === tts.lang);
  }
  if (voice) utterance.voice = voice;

  utterance.rate = tts.rate;
  utterance.pitch = tts.pitch;

  // Safety timeout for iOS (10 seconds)
  const safetyTimeout = setTimeout(() => {
    log.warn("TTS safety timeout reached");
    speechSynthesis.cancel();
    playNextSound(channel);
  }, 10000);

  utterance.onend = () => {
    clearTimeout(safetyTimeout);
    log.info("TTS playback ended");
    playNextSound(channel);
  };
  utterance.onerror = (e) => {
    clearTimeout(safetyTimeout);
    log.error("TTS playback error", e);
    playNextSound(channel);
  };

  speechSynthesis.speak(utterance);
}

function playNextSound(channel: number = 1): void {
  if (channel === 2) {
    log.info("playNextSound called for channel 2, queue length:", soundQueue2.length);

    if (soundQueue2.length === 0) {
      log.info("Sound queue for channel 2 is empty");
      isPlaying2 = false;
      return;
    }

    isPlaying2 = true;
    const nextSound = soundQueue2.shift();

    log.info("Next sound to play on channel 2:", nextSound?.name);

    if (!nextSound) {
      log.error("nextSound for channel 2 is unexpectedly empty even though queue had items");
      isPlaying2 = false;
      return;
    }

    if (!nextSound.url && !nextSound.base64 && !nextSound.soundId && !nextSound.tts) {
      log.error("Sound for channel 2 has neither URL, base64 data, soundId, nor TTS");
      // Move to next sound
      playNextSound(2);
      return;
    }

    // Handle TTS sounds on channel 2
    if (nextSound.tts) {
      playTTSSound(nextSound.tts, 2);
      return;
    }

    log.info("Playing sound on channel 2");

    try {
      // Get the next audio element from the pool
      const audioElement = audioPool2[currentAudioIndex2];

      // Make sure the audio element exists
      if (!audioElement) {
        log.error("Audio element not found in pool for channel 2");
        isPlaying2 = false;
        return;
      }

      // Update index for next use
      currentAudioIndex2 = (currentAudioIndex2 + 1) % AUDIO_POOL_SIZE;

      // Stop any current playback
      audioElement.pause();

      // Play based on available source (URL, IndexedDB, or base64)
      playWithAvailableSource(nextSound, audioElement, 2);
    } catch (error) {
      log.error("Exception while setting up audio for channel 2", error);
      // Move to next sound on error
      playNextSound(2);
    }
  } else {
    log.info("playNextSound called for channel 1, queue length:", soundQueue.length);

    if (soundQueue.length === 0) {
      log.info("Sound queue for channel 1 is empty");
      isPlaying = false;
      return;
    }

    isPlaying = true;
    const nextSound = soundQueue.shift();

    log.info("Next sound to play on channel 1:", nextSound?.name);

    if (!nextSound) {
      log.error("nextSound for channel 1 is unexpectedly empty even though queue had items");
      isPlaying = false;
      return;
    }

    if (!nextSound.url && !nextSound.base64 && !nextSound.soundId && !nextSound.tts) {
      log.error("Sound for channel 1 has neither URL, base64 data, soundId, nor TTS");
      // Move to next sound
      playNextSound(1);
      return;
    }

    // Handle TTS sounds on channel 1
    if (nextSound.tts) {
      playTTSSound(nextSound.tts, 1);
      return;
    }

    log.info("Playing sound on channel 1");

    try {
      // Get the next audio element from the pool
      const audioElement = audioPool[currentAudioIndex];

      // Make sure the audio element exists
      if (!audioElement) {
        log.error("Audio element not found in pool for channel 1");
        isPlaying = false;
        return;
      }

      // Update index for next use
      currentAudioIndex = (currentAudioIndex + 1) % AUDIO_POOL_SIZE;

      // Stop any current playback
      audioElement.pause();

      // Play based on available source (URL, IndexedDB, or base64)
      playWithAvailableSource(nextSound, audioElement, 1);
    } catch (error) {
      log.error("Exception while setting up audio for channel 1", error);
      // Move to next sound on error
      playNextSound(1);
    }
  }
}

// Helper function to play sound based on available source
function playWithAvailableSource(
  nextSound: { url?: string; base64?: string; name?: string; soundId?: string },
  audioElement: HTMLAudioElement,
  channel: number,
): void {
  // Try URL first, then soundId (from IndexedDB), then base64
  if (nextSound.url) {
    log.info(`Using URL source (channel ${channel})`);

    // Set the source to the URL
    audioElement.src = nextSound.url;

    // Play the sound
    audioElement.play()
      .then(() => {
        log.info(`URL sound playing successfully (channel ${channel})`);
      })
      .catch((error) => {
        log.error(`Error playing URL sound(channel ${channel})`, error);

        // Check if the error is due to user interaction requirement
        if (
          error.toString().includes("failed because the user didn't interact with the document first") // chrome
          || error.toString().includes("The play method is not allowed by the user agent") // firefox
          || error.toString().includes("The request is not allowed by the user agent") // safari
        ) {
          showInteractionNotification();
          unlockAudio(); // Try to unlock audio again
        }

        // If URL fails and we have soundId or base64, try that as fallback
        if (nextSound.soundId && isIndexedDBAvailable()) {
          log.info(`Falling back to soundId after URL failure (channel ${channel})`);
          // Get the sound from IndexedDB and play it
          getSoundFxFromIndexedDB(nextSound.soundId)
            .then((base64) => {
              if (base64) {
                log.info(`Successfully loaded sound from IndexedDB (channel ${channel})`);
                playBase64Sound(base64, channel);
              } else {
                log.error(`Failed to load sound from IndexedDB(channel ${channel})`);
                // Try base64 if available as final fallback
                if (nextSound.base64) {
                  playBase64Sound(nextSound.base64, channel);
                } else {
                  // Move to next sound
                  playNextSound(channel);
                }
              }
            })
            .catch((error) => {
              log.error(`Error loading sound from IndexedDB(channel ${channel})`, error);
              // Try base64 if available as final fallback
              if (nextSound.base64) {
                playBase64Sound(nextSound.base64, channel);
              } else {
                // Move to next sound
                playNextSound(channel);
              }
            });
        } else if (nextSound.base64) {
          log.info(`Falling back to base64 after URL failure (channel ${channel})`);
          playBase64Sound(nextSound.base64, channel);
        } else {
          // Move to next sound
          playNextSound(channel);
        }
      });
  } else if (nextSound.soundId && isIndexedDBAvailable()) {
    log.info(`Using soundId source (channel ${channel})`);
    // Get the sound from IndexedDB and play it
    getSoundFxFromIndexedDB(nextSound.soundId)
      .then((base64) => {
        if (base64) {
          log.info(`Successfully loaded sound from IndexedDB (channel ${channel})`);
          playBase64Sound(base64, channel);
        } else {
          log.error(`Failed to load sound from IndexedDB(channel ${channel})`);
          // Fall back to base64 if available
          if (nextSound.base64) {
            playBase64Sound(nextSound.base64, channel);
          } else {
            // Move to next sound
            playNextSound(channel);
          }
        }
      })
      .catch((error) => {
        log.error(`Error loading sound from IndexedDB(channel ${channel})`, error);
        // Fall back to base64 if available
        if (nextSound.base64) {
          playBase64Sound(nextSound.base64, channel);
        } else {
          // Move to next sound
          playNextSound(channel);
        }
      });
  } else if (nextSound.base64) { // If no URL or soundId, try base64
    playBase64Sound(nextSound.base64, channel);
  } else {
    log.error(`Sound has neither URL, soundId, nor base64 data(channel ${channel})`);
    // Move to next sound
    playNextSound(channel);
  }
}

/**
 * Play a sound from base64 data
 */
function playBase64Sound(base64Data: string, channel: number = 1): void {
  log.info(`Using base64 source (channel ${channel})`);

  try {
    // Create a blob URL from the base64 data
    const audioUrl = createAudioBlobUrl(base64Data);

    if (!audioUrl) {
      log.error(`Failed to create audio blob URL(channel ${channel})`);
      playNextSound(channel);
      return;
    }

    // Add URL to tracking array for later revocation
    blobUrlsToRevoke.push(audioUrl);

    // Get the next audio element from the pool
    const audioElement = channel === 2 ? audioPool2[currentAudioIndex2] : audioPool[currentAudioIndex];

    // Make sure the audio element exists
    if (!audioElement) {
      log.error(`Audio element not found in pool for base64(channel ${channel})`);
      URL.revokeObjectURL(audioUrl);
      const index = blobUrlsToRevoke.indexOf(audioUrl);
      if (index > -1) {
        blobUrlsToRevoke.splice(index, 1);
      }
      playNextSound(channel);
      return;
    }

    // Update index for next use
    if (channel === 2) {
      currentAudioIndex2 = (currentAudioIndex2 + 1) % AUDIO_POOL_SIZE;
    } else {
      currentAudioIndex = (currentAudioIndex + 1) % AUDIO_POOL_SIZE;
    }

    // Stop any current playback
    audioElement.pause();

    // Set the source to the blob URL
    audioElement.src = audioUrl;

    // Play the sound
    audioElement.play()
      .then(() => {
        log.info(`Base64 sound playing successfully (channel ${channel})`);
      })
      .catch((error) => {
        log.error(`Base64 sound playback failed(channel ${channel})`, error);

        // Check if error is due to user interaction requirement
        if (
          error.toString().includes("failed because the user didn't interact with the document first") // chrome
          || error.toString().includes("The play method is not allowed by the user agent") // firefox
          || error.toString().includes("The request is not allowed by the user agent") // safari
        ) {
          showInteractionNotification();
          unlockAudio(); // Try to unlock audio again
        }

        URL.revokeObjectURL(audioUrl);
        const index = blobUrlsToRevoke.indexOf(audioUrl);
        if (index > -1) {
          blobUrlsToRevoke.splice(index, 1);
        }
        playNextSound(channel);
      });
  } catch (error) {
    log.error(`Error processing base64 data(channel ${channel})`, error);
    playNextSound(channel);
  }
}

/**
 * Create a blob URL from base64 data
 * Returns null if the conversion fails
 */
function createAudioBlobUrl(base64Data: string): string | null {
  try {
    // First, extract the actual base64 data if it's a data URL
    let rawBase64 = base64Data;

    // If it's a data URL (starts with data:), extract just the base64 part
    if (base64Data.startsWith("data:")) {
      const commaIndex = base64Data.indexOf(",");
      if (commaIndex !== -1) {
        rawBase64 = base64Data.substring(commaIndex + 1);
      } else {
        log.error("Invalid data URL format");
        return null;
      }
    }

    // Clean the base64 string - remove whitespace, newlines, etc.
    rawBase64 = rawBase64.replace(/[\s\r\n]+/g, "");

    // Handle potential padding issues
    // Base64 strings should have a length that is a multiple of 4
    while (rawBase64.length % 4 !== 0) {
      rawBase64 += "=";
    }

    // Remove any characters that aren't valid in base64
    rawBase64 = rawBase64.replace(/[^A-Za-z0-9+/=]/g, "");

    // Decode base64 to binary
    let binaryString: string;
    try {
      binaryString = window.atob(rawBase64);
    } catch (e) {
      log.error("Base64 decoding failed", e);

      // Log a sample of the problematic string to help with debugging
      log.error("Problem with base64 string:",
        rawBase64.length > 50 ? `${rawBase64.substring(0, 50)}...` : rawBase64);

      return null;
    }

    // Create a typed array from the binary string
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Create a blob and object URL
    // Try to determine the MIME type from the data URL if available
    let mimeType = "audio/mpeg"; // Default MIME type
    if (base64Data.startsWith("data:")) {
      const mimeMatch = base64Data.match(/^data:([^;]+);/);
      if (mimeMatch && mimeMatch[1]) {
        mimeType = mimeMatch[1];
      }
    }

    const blob = new Blob([bytes], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch (error) {
    log.error("Failed to create blob URL", error);
    return null;
  }
}

// Clean up blob URLs periodically to prevent memory leaks
setInterval(() => {
  if (blobUrlsToRevoke.length > 20) {
    log.info("Cleaning up blob URLs", blobUrlsToRevoke.length);
    // Keep the 5 most recent URLs (they might still be in use)
    const urlsToKeep = blobUrlsToRevoke.slice(-5);
    const urlsToRemove = blobUrlsToRevoke.slice(0, -5);

    urlsToRemove.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        log.error("Error revoking URL", e);
      }
    });

    blobUrlsToRevoke.length = 0;
    blobUrlsToRevoke.push(...urlsToKeep);
  }
}, 60000); // Check every minute

/**
 * Stops all currently playing sounds and clears the sound queue
 */
function stopAllSounds(): void {
  log.info("Stopping all sounds due to edit mode");

  // Clear the sound queues
  soundQueue.length = 0;
  soundQueue2.length = 0;

  // Stop the main audio players if they exist
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
  }

  if (audioPlayer2) {
    audioPlayer2.pause();
    audioPlayer2.currentTime = 0;
  }

  // Stop all audio elements in the pools
  audioPool.forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });

  audioPool2.forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });

  // Reset playing flags
  isPlaying = false;
  isPlaying2 = false;
}

// Helper function to check if a sound trigger is already in queue
function isSoundInQueue(trigger: string): boolean {
  // Find all sounds that match the trigger from config
  const matchingSounds = config.soundFx.sounds?.filter(sound =>
    sound.enabled && sound.triggers && sound.triggers.includes(trigger),
  ) || [];

  // Check if any of the matching sounds are in the queue
  return soundQueue.some(queuedSound =>
    matchingSounds.some(matchingSound =>
      queuedSound.url === matchingSound.url
      && queuedSound.base64 === matchingSound.base64
      && queuedSound.soundId === matchingSound.soundId,
    ),
  );
}
